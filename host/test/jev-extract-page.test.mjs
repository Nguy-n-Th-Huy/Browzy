#!/usr/bin/env node
//
// jev-extract-page-tool: the `extract_page` SDK tool's gating, caller-only
// field schema, null-vs-failure semantics, and honest failure reporting.
//
// Three layers, all against REAL production code:
//   - host/agent/settings/profile.js's `resolveJevExtractPageConfig` — the
//     gate (jev-tools-reuse-primary-provider design.md decision 2): the
//     SAME saved Jev transport key `resolveJevBrowserSubgoalConfig` requires
//     — the two tools are offered together — plus a supplied `textModel`
//     (the run's own primary provider, never a second, separately
//     configured one). Driven against a real scratch profile store
//     (OCIC_AGENT_CONFIG_DIR), the same isolation host/test/jev-browser-
//     subgoal.test.mjs uses.
//   - host/agent/tools/extract-page.js's `createExtractPageTool` /
//     `validateExtractFields` — the tool handler's request validation, the
//     caller-only field schema, and honest failure reporting. Driven with a
//     fake `toolFactory` and a fake `requestPageExtractImpl` standing in for
//     the real text-model call.
//   - host/agent/jev/text-helper.js's `parseExtraction`/`requestPageExtract`
//     — the null-vs-failure semantics (missing evidence, type mismatch,
//     page-injected extra keys, structurally invalid answers) and the
//     transport-failure path, driven against a local HTTP stub server (the
//     same style host/test/jev-capability.test.mjs uses) so no live provider
//     is ever contacted.
//
// Run: node --test host/test/jev-extract-page.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";

import * as profile from "../agent/settings/profile.js";
import { memoryClearAll } from "../agent/secrets/memory-store.js";
import {
  createExtractPageTool,
  validateExtractFields,
  EXTRACT_PAGE_TOOL_NAME
} from "../agent/tools/extract-page.js";
import { requestPageExtract, parseExtraction } from "../agent/jev/text-helper.js";

const TEST_PROFILE_ID = "ocic-test-extract-page";
const TEXT_MODEL_BASE_URL = "https://text-model.example/v1";
const TEXT_MODEL_ID = "fixture-text-model";
// The run's own primary provider/model — what `primaryTextModelFromSnapshot`
// would derive from a real anthropic/chatgpt snapshot.
const PRIMARY_TEXT_MODEL = { kind: "anthropic", baseUrl: "https://api.anthropic.com", model: "claude-x", apiKey: "sk-ant-primary-test-only" };

function useScratchConfigDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocic-extract-page-test-"));
  process.env.OCIC_AGENT_CONFIG_DIR = dir;
  memoryClearAll();
  profile._clearCredentialRevokedListenersForTests();
  return dir;
}

/**
 * An `anthropic` profile carrying a saved Jev transport key, built the SAME
 * way the settings surface would. `textModelApiKey` is accepted only so a
 * test can prove a legacy stored value is never read by this gate — it is
 * NOT part of the contract this resolver checks.
 */
async function profileWithJev({
  typesafeApiKey = "ts-test-only-key",
  textModelApiKey = null
} = {}) {
  useScratchConfigDir();
  await profile.saveProfile({
    profileId: TEST_PROFILE_ID,
    baseUrl: "https://api.anthropic.com",
    models: [{ id: "claude-x", label: "Claude X" }],
    defaultModelId: "claude-x"
  });
  await profile.setTypesafeConfig(TEST_PROFILE_ID, { typesafeSource: "typesafe" });
  await profile.setTypesafeCredentials(TEST_PROFILE_ID, {
    ...(typesafeApiKey !== null ? { typesafeApiKey } : {}),
    ...(textModelApiKey !== null ? { textModelApiKey } : {}),
    memoryOnly: true
  });
  return TEST_PROFILE_ID;
}

// --- resolveJevExtractPageConfig (the gate) ---------------------------------

test("a saved transport key resolves the config with the supplied primary model as textModel", async () => {
  await profileWithJev();
  const config = await profile.resolveJevExtractPageConfig(TEST_PROFILE_ID, { textModel: PRIMARY_TEXT_MODEL });
  assert(config, "expected a resolved config");
  assert.deepEqual(config.textModel, PRIMARY_TEXT_MODEL);
});

test("a missing transport key resolves null even with a textModel supplied", async () => {
  await profileWithJev({ typesafeApiKey: null });
  const config = await profile.resolveJevExtractPageConfig(TEST_PROFILE_ID, { textModel: PRIMARY_TEXT_MODEL });
  assert.equal(config, null);
});

test("a missing textModel resolves null even though the transport key is saved", async () => {
  await profileWithJev();
  const config = await profile.resolveJevExtractPageConfig(TEST_PROFILE_ID, {});
  assert.equal(config, null);
});

test("legacy text-model fields with no transport key never satisfy the gate — they are not read by this resolver", async () => {
  await profileWithJev({ typesafeApiKey: null, textModelApiKey: "tm-legacy-key-should-be-ignored" });
  const config = await profile.resolveJevExtractPageConfig(TEST_PROFILE_ID, { textModel: PRIMARY_TEXT_MODEL });
  assert.equal(config, null, "a legacy text-model key must never substitute for the Jev transport key");
});

test("an unrelated profileId resolves null", async () => {
  await profileWithJev();
  const config = await profile.resolveJevExtractPageConfig("some-other-profile", { textModel: PRIMARY_TEXT_MODEL });
  assert.equal(config, null);
});

// --- validateExtractFields (the caller-only field schema) -------------------

test("a valid flat field list passes", () => {
  const result = validateExtractFields([
    { name: "price", type: "number" },
    { name: "inStock", type: "boolean", description: "whether the item can be purchased" }
  ]);
  assert.equal(result.ok, true);
});

test("fields must be a non-empty array", () => {
  assert.equal(validateExtractFields(undefined).ok, false);
  assert.equal(validateExtractFields([]).ok, false);
  assert.equal(validateExtractFields("price").ok, false);
});

test("over the field-count bound is refused", () => {
  const fields = Array.from({ length: 21 }, (_, i) => ({ name: `f${i}`, type: "string" }));
  const result = validateExtractFields(fields);
  assert.equal(result.ok, false);
  assert.match(result.error, /20/);
});

test("a bad field name is refused", () => {
  for (const name of ["1field", "field-name", "field name", "", "_field", "a".repeat(65)]) {
    const result = validateExtractFields([{ name, type: "string" }]);
    assert.equal(result.ok, false, `expected "${name}" to be refused`);
  }
});

test("a duplicate field name is refused", () => {
  const result = validateExtractFields([{ name: "price", type: "number" }, { name: "price", type: "string" }]);
  assert.equal(result.ok, false);
});

test("an unsupported type is refused", () => {
  const result = validateExtractFields([{ name: "x", type: "date" }]);
  assert.equal(result.ok, false);
});

test("an object field without properties is refused", () => {
  const result = validateExtractFields([{ name: "address", type: "object" }]);
  assert.equal(result.ok, false);
  assert.match(result.error, /properties/);
});

test("an array field without items is refused", () => {
  const result = validateExtractFields([{ name: "tags", type: "array" }]);
  assert.equal(result.ok, false);
  assert.match(result.error, /items/);
});

test("a valid nested object/array schema within the nesting bound passes", () => {
  const result = validateExtractFields([
    {
      name: "product",
      type: "object",
      properties: [
        { name: "name", type: "string" },
        { name: "tags", type: "array", items: { type: "string" } }
      ]
    }
  ]);
  assert.equal(result.ok, true);
});

test("nesting beyond the bound is refused", () => {
  // field(object, depth1) -> properties(depth2, object) -> properties(depth3, object) refused
  const result = validateExtractFields([
    {
      name: "a",
      type: "object",
      properties: [
        {
          name: "b",
          type: "object",
          properties: [{ name: "c", type: "object", properties: [{ name: "d", type: "string" }] }]
        }
      ]
    }
  ]);
  assert.equal(result.ok, false);
  assert.match(result.error, /nesting/);
});

test("a field carrying properties on a non-object type is refused", () => {
  const result = validateExtractFields([{ name: "x", type: "string", properties: [{ name: "y", type: "string" }] }]);
  assert.equal(result.ok, false);
});

test("a field carrying items on a non-array type is refused", () => {
  const result = validateExtractFields([{ name: "x", type: "string", items: { type: "string" } }]);
  assert.equal(result.ok, false);
});

test("an unrecognized key on a field is refused", () => {
  const result = validateExtractFields([{ name: "x", type: "string", pageHint: "trust me" }]);
  assert.equal(result.ok, false);
});

test("a description over the bound is refused", () => {
  const result = validateExtractFields([{ name: "x", type: "string", description: "a".repeat(201) }]);
  assert.equal(result.ok, false);
});

// --- createExtractPageTool (the tool handler) -------------------------------

function fakeToolFactory(name, description, shape, handler) {
  return { name, description, shape, handler };
}

function buildTool({
  jevConfig,
  tabId = 7,
  requestPageExtractImpl,
  snapshotResult = { result: { content: [{ type: "text", text: JSON.stringify({ url: "https://example.com", elements: [] }) }] } }
} = {}) {
  return createExtractPageTool({
    run: { id: "run-1", state: "running", leaseHeldByThisRun: () => true, tabScope: "any", describeRequestForWire: () => ({}) },
    toolBridge: { call: async () => snapshotResult },
    coerceArgs: (a) => a,
    jevConfig: jevConfig ?? {
      textModel: { kind: "openai", baseUrl: TEXT_MODEL_BASE_URL, model: TEXT_MODEL_ID, apiKey: "tm-secret-should-never-leak" }
    },
    resolveTabId: () => tabId,
    toolFactory: fakeToolFactory,
    requestPageExtractImpl
  });
}

test("extract_page registers under its documented name", async () => {
  const tool = await buildTool({ requestPageExtractImpl: async () => ({ fields: {} }) });
  assert.equal(tool.name, EXTRACT_PAGE_TOOL_NAME);
  assert.equal(EXTRACT_PAGE_TOOL_NAME, "extract_page");
});

test("an empty, missing, or non-string instruction is rejected before any model call", async () => {
  let started = 0;
  const tool = await buildTool({ requestPageExtractImpl: async () => { started++; return { fields: {} }; } });
  for (const instruction of [undefined, "", "   ", 42, null]) {
    const result = await tool.handler({ instruction, fields: [{ name: "x", type: "string" }] });
    assert.equal(result.isError, true);
    assert(/non-empty/.test(result.content[0].text));
  }
  assert.equal(started, 0, "no model call may happen for an invalid instruction");
});

test("an invalid fields schema is rejected before any model call", async () => {
  let started = 0;
  const tool = await buildTool({ requestPageExtractImpl: async () => { started++; return { fields: {} }; } });
  const result = await tool.handler({ instruction: "find the price", fields: [{ name: "bad name", type: "string" }] });
  assert.equal(result.isError, true);
  assert(/fields/.test(result.content[0].text));
  assert.equal(started, 0, "no model call may happen for an invalid fields schema");
});

test("no bound tab is rejected before any model call or observation", async () => {
  let observed = 0;
  const tool = await buildTool({
    tabId: null,
    requestPageExtractImpl: async () => { observed++; return { fields: {} }; }
  });
  const result = await tool.handler({ instruction: "find the price", fields: [{ name: "price", type: "number" }] });
  assert.equal(result.isError, true);
  assert(/bound page tab/.test(result.content[0].text));
  assert.equal(observed, 0);
});

test("a successful extraction returns ok:true with exactly the model's fields, no approval needed", async () => {
  let captured = null;
  const tool = await buildTool({
    requestPageExtractImpl: async (opts) => {
      captured = opts;
      return { fields: { price: 19.99, inStock: null }, latencyMs: 12, usage: {} };
    }
  });
  const result = await tool.handler({
    instruction: "find the price and stock status",
    fields: [{ name: "price", type: "number" }, { name: "inStock", type: "boolean" }]
  });
  assert.equal(result.isError, false);
  const payload = JSON.parse(result.content[0].text);
  assert.equal(payload.ok, true);
  assert.deepEqual(payload.fields, { price: 19.99, inStock: null });
  assert.equal(captured.instruction, "find the price and stock status");
  assert.equal(captured.page.url, "https://example.com");
});

test("an unavailable page observation is a bounded failure, never a model call", async () => {
  let started = 0;
  const tool = await buildTool({
    snapshotResult: { result: { content: [{ type: "text", text: JSON.stringify({ available: false }) }] } },
    requestPageExtractImpl: async () => { started++; return { fields: {} }; }
  });
  const result = await tool.handler({ instruction: "find the price", fields: [{ name: "price", type: "number" }] });
  assert.equal(result.isError, true);
  const payload = JSON.parse(result.content[0].text);
  assert.equal(payload.ok, false);
  assert.equal(started, 0);
});

test("a text-model transport/provider failure returns a bounded named failure and never leaks the configured key", async () => {
  const tool = await buildTool({
    requestPageExtractImpl: async () => {
      const err = new Error("the text model answered without a string message content; no fields were extracted.");
      err.code = "INVALID_RESPONSE";
      throw err;
    }
  });
  const result = await tool.handler({ instruction: "find the price", fields: [{ name: "price", type: "number" }] });
  assert.equal(result.isError, true);
  const payload = JSON.parse(result.content[0].text);
  assert.equal(payload.ok, false);
  assert(!result.content[0].text.includes("tm-secret-should-never-leak"));
});

test("a runtime exception is caught and mapped to a bounded failure — the tool call never throws", async () => {
  const tool = await buildTool({ requestPageExtractImpl: async () => { throw new Error("boom"); } });
  const result = await tool.handler({ instruction: "find the price", fields: [{ name: "price", type: "number" }] });
  assert.equal(result.isError, true);
  const payload = JSON.parse(result.content[0].text);
  assert.equal(payload.ok, false);
});

// --- parseExtraction / requestPageExtract (null-vs-failure semantics) ------

test("missing evidence for a requested field is null, not a failure", () => {
  const fields = [{ name: "price", type: "number" }, { name: "sku", type: "string" }];
  const result = parseExtraction({ price: 19.99 }, fields);
  assert.equal(result.ok, true);
  assert.deepEqual(result.fields, { price: 19.99, sku: null });
});

test("a type mismatch becomes null, not a failure", () => {
  const fields = [{ name: "price", type: "number" }];
  const result = parseExtraction({ price: "nineteen dollars" }, fields);
  assert.equal(result.ok, true);
  assert.equal(result.fields.price, null);
});

test("a page-injected extra key beyond the caller's own fields is silently dropped, never added", () => {
  const fields = [{ name: "price", type: "number" }];
  const result = parseExtraction({ price: 19.99, adminOverride: true, injectedField: "malicious" }, fields);
  assert.equal(result.ok, true);
  assert.deepEqual(Object.keys(result.fields), ["price"]);
});

test("an invalid url value becomes null", () => {
  const fields = [{ name: "link", type: "url" }];
  assert.equal(parseExtraction({ link: "not a url" }, fields).fields.link, null);
  assert.equal(parseExtraction({ link: "javascript:alert(1)" }, fields).fields.link, null);
  assert.equal(parseExtraction({ link: "https://example.com/item" }, fields).fields.link, "https://example.com/item");
});

test("nested object/array fields are coerced recursively, missing/mismatched leaves become null", () => {
  const fields = [
    {
      name: "product",
      type: "object",
      properties: [
        { name: "name", type: "string" },
        { name: "rating", type: "number" }
      ]
    },
    { name: "tags", type: "array", items: { type: "string" } }
  ];
  const result = parseExtraction({ product: { name: "Widget", rating: "five stars" }, tags: ["a", 2, "c"] }, fields);
  assert.equal(result.ok, true);
  assert.deepEqual(result.fields.product, { name: "Widget", rating: null });
  assert.deepEqual(result.fields.tags, ["a", null, "c"]);
});

test("a structurally invalid model answer (not an object) is a bounded named failure", () => {
  const fields = [{ name: "price", type: "number" }];
  for (const value of [null, "a string", 42, ["array"]]) {
    const result = parseExtraction(value, fields);
    assert.equal(result.ok, false);
    assert.equal(result.code, "INVALID_RESPONSE");
  }
});

// --- requestPageExtract transport (local HTTP stub, no live provider) ------

async function startStub(handler) {
  const state = { bodies: [] };
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      try {
        state.bodies.push(JSON.parse(raw));
      } catch {
        state.bodies.push(null);
      }
      handler(req, res, state);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    state,
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); })
  };
}

function sendJson(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json", Connection: "close" });
  res.end(typeof payload === "string" ? payload : JSON.stringify(payload));
}

const TEXT_KEY = "tm-super-secret-key-should-never-leak";

test("a successful text-model call returns exactly the caller's fields", async () => {
  const stub = await startStub((req, res) => {
    sendJson(res, 200, { choices: [{ message: { content: JSON.stringify({ price: 19.99, sku: null }) } }], usage: {} });
  });
  try {
    const result = await requestPageExtract({
      textModel: { kind: "openai", baseUrl: stub.url, model: "fixture-model", apiKey: TEXT_KEY },
      instruction: "find the price and sku",
      fields: [{ name: "price", type: "number" }, { name: "sku", type: "string" }],
      page: { url: "https://example.com", title: "Example", text: "Price: $19.99" }
    });
    assert.deepEqual(result.fields, { price: 19.99, sku: null });
  } finally {
    await stub.close();
  }
});

test("a malformed model answer fails closed after the one feedback retry, never fabricating a result", async () => {
  const stub = await startStub((req, res) => {
    sendJson(res, 200, { choices: [{ message: { content: "not json at all" } }], usage: {} });
  });
  try {
    await assert.rejects(
      () =>
        requestPageExtract({
          textModel: { kind: "openai", baseUrl: stub.url, model: "fixture-model", apiKey: TEXT_KEY },
          instruction: "find the price",
          fields: [{ name: "price", type: "number" }],
          page: { url: "https://example.com", title: "Example", text: "" },
          sleep: async () => {}
        }),
      (err) => {
        assert.equal(err.name, "JevError");
        assert.equal(err.code, "INVALID_RESPONSE");
        assert(!err.message.includes(TEXT_KEY), "the failure must never leak the configured key");
        return true;
      }
    );
    // Exactly two attempts: the initial call plus the one feedback retry.
    assert.equal(stub.state.bodies.length, 2);
  } finally {
    await stub.close();
  }
});

test("a transport failure (nothing listening) is a bounded named failure, no secret leak", async () => {
  const server = http.createServer(() => {});
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  await assert.rejects(
    () =>
      requestPageExtract({
        textModel: { kind: "openai", baseUrl: `http://127.0.0.1:${port}`, model: "fixture-model", apiKey: TEXT_KEY },
        instruction: "find the price",
        fields: [{ name: "price", type: "number" }],
        page: { url: "https://example.com", title: "Example", text: "" },
        timeoutMs: 500,
        sleep: async () => {}
      }),
    (err) => {
      assert.equal(err.name, "JevError");
      assert(!err.message.includes(TEXT_KEY));
      return true;
    }
  );
});
