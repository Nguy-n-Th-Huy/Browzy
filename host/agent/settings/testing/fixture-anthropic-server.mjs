// An in-process, local-only fixture HTTP server that speaks just enough of
// the Anthropic Messages API (SSE streaming) to exercise this module's real,
// production code paths — discovery pagination, error-code mapping, redirect
// rejection, protocol-mismatch detection, and the capability test's
// text/tool/vision sub-tests — without ever touching a real, billed
// provider.
//
// The exact wire shape here (HEAD /api/hello, POST /v1/messages?beta=true
// SSE event framing, GET /v1/models pagination) was captured empirically by
// pointing the real `@anthropic-ai/claude-agent-sdk` `query()` at a local
// probe server and recording what it actually sent — see
// reports/04-settings-evidence.md for the captured traces this fixture is
// built from.
//
// Every scenario here is deterministic and scripted; nothing in this file
// talks to a real model or a real network endpoint.

import http from "node:http";
import https from "node:https";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const TOOL_RESULT_MARKER = '"tool_result"';
const IMAGE_MARKER = '"type":"image"';

function sseSend(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

// `toolUseInput` is an ADDITIVE, opt-in parameter (see startFixtureAnthropicServer's
// `scriptToolUseInput` option below): every existing caller of
// sendSuccessSse() omits it, so it defaults to `{}` and the emitted
// `partial_json` stays the byte-identical `"{}"` this fixture has always
// sent — no existing consumer's behavior changes.
function sendSuccessSse(res, { text, toolUseName, toolUseInput = {} } = {}) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  const id = `msg_${crypto.randomBytes(4).toString("hex")}`;
  sseSend(res, "message_start", {
    type: "message_start",
    message: { id, type: "message", role: "assistant", content: [], model: "fixture-model", stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 0 } }
  });
  if (toolUseName) {
    const inputJson = JSON.stringify(toolUseInput || {});
    sseSend(res, "content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_fixture", name: toolUseName, input: {} } });
    sseSend(res, "content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: inputJson } });
    sseSend(res, "content_block_stop", { type: "content_block_stop", index: 0 });
    sseSend(res, "message_delta", { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 3 } });
  } else {
    sseSend(res, "content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
    sseSend(res, "content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: text || "ok" } });
    sseSend(res, "content_block_stop", { type: "content_block_stop", index: 0 });
    sseSend(res, "message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } });
  }
  sseSend(res, "message_stop", { type: "message_stop" });
  res.end();
}

function sendJsonError(res, status, type, message, extraHeaders = {}) {
  res.writeHead(status, { "content-type": "application/json", ...extraHeaders });
  res.end(JSON.stringify({ type: "error", error: { type, message } }));
}

/**
 * @param {import("node:http").IncomingMessage} req
 * @param {import("node:http").ServerResponse} res
 * @param {{ scenario: string, port: number, redirectTargetOrigin?: string, callLog: any[] }} ctx
 */
function handleRequest(req, res, ctx) {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const url = req.url || "";

    if (req.method === "HEAD" && url.includes("/api/hello")) {
      if (ctx.scenario === "hang-startup") return; // never respond — exercises the startup budget
      res.writeHead(200, {});
      res.end();
      return;
    }

    if (url.startsWith("/v1/models")) {
      handleModelsRequest(req, res, ctx, url);
      return;
    }

    if (!url.startsWith("/v1/messages")) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "not_found_error", message: "unknown route" } }));
      return;
    }

    ctx.callLog.push({ url, body });
    const hasToolResult = body.includes(TOOL_RESULT_MARKER);
    const hasImage = body.includes(IMAGE_MARKER);
    let parsedTools = [];
    try {
      parsedTools = JSON.parse(body).tools || [];
    } catch {}

    switch (ctx.scenario) {
      case "hang":
        return; // never respond — exercises the provider-test deadline / TIMEOUT_ERROR
      case "401":
        return sendJsonError(res, 401, "authentication_error", "invalid x-api-key");
      case "403":
        return sendJsonError(res, 403, "permission_error", "forbidden");
      case "404-model":
        return sendJsonError(res, 404, "not_found_error", "model: fixture-missing-model not found");
      case "429":
        return sendJsonError(res, 429, "rate_limit_error", "rate limited", { "retry-after": "1" });
      case "500":
        return sendJsonError(res, 500, "api_error", "internal error");
      case "protocol-openai":
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: "chatcmpl-fixture", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }] }));
        return;
      case "redirect-same-origin":
        res.writeHead(302, { Location: `http://127.0.0.1:${ctx.port}/v1/redirected-target` });
        res.end();
        return;
      case "redirect-cross-origin":
        res.writeHead(302, { Location: `${ctx.redirectTargetOrigin}/v1/messages` });
        res.end();
        return;
      case "vision-blind":
        // A text-only gateway that accepts an image block on the wire, drops
        // it, and answers from the prompt text alone. Everything below the
        // HTTP layer looks healthy: 200, well-formed SSE, a completed turn.
        // Only the content of the reply gives it away.
        if (hasToolResult) return sendSuccessSse(res, { text: "tool result acknowledged" });
        if (hasImage) return sendSuccessSse(res, { text: "I cannot make out any colour or shape." });
        if (parsedTools.length > 0) {
          const chosen = pickScriptedToolUse(ctx, parsedTools, body);
          return sendSuccessSse(res, { toolUseName: chosen.name, toolUseInput: chosen.input });
        }
        return sendSuccessSse(res, { text: "hello from the fixture" });
      case "success":
      case "tool":
      case "vision":
      default: {
        if (hasToolResult) return sendSuccessSse(res, { text: "tool result acknowledged" });
        if (hasImage) return sendSuccessSse(res, { text: "I see a small red circle" });
        if (parsedTools.length > 0) {
          const chosen = pickScriptedToolUse(ctx, parsedTools, body);
          return sendSuccessSse(res, { toolUseName: chosen.name, toolUseInput: chosen.input });
        }
        return sendSuccessSse(res, { text: "hello from the fixture" });
      }
    }
  });
}

// ADDITIVE, opt-in only (see startFixtureAnthropicServer's `scriptToolUseInput`
// option): when a caller does not pass one, `ctx.toolUseInputProvider` is
// undefined and this returns `{}` — byte-identical to this fixture's
// always-`{}` tool_use input, unchanged for every existing consumer. Wraps
// the caller's provider in a try/catch so a provider bug degrades to `{}`
// rather than crashing the fixture's response path.
function scriptedToolUseInput(ctx, parsedTools, body) {
  if (typeof ctx.toolUseInputProvider !== "function") return {};
  try {
    return ctx.toolUseInputProvider(parsedTools, body) || {};
  } catch {
    return {};
  }
}

// ADDITIVE, opt-in only (see startFixtureAnthropicServer's `scriptToolUse`
// option): the fixture's long-standing default behavior — emit a tool_use
// for `parsedTools[0]` (the FIRST tool named in the request's `tools`
// array, whatever the real CLI's wire order happens to be) — is preserved
// exactly when no `scriptToolUse` picker is supplied. A picker lets a
// caller target a SPECIFIC named tool (e.g. "Skill") instead of whichever
// happens to sort first, which matters because the real CLI's wire-level
// tool ordering/naming does not necessarily match the `tools` option array
// a caller passed to query() (observed empirically: `"Task"` in `options.tools`
// surfaced on the wire as a tool literally named `"Agent"`, sorted before
// `"Skill"`). Falls back to `scriptedToolUseInput()` for the input in either
// path, so `scriptToolUseInput` alone (picking the input for whatever tool
// sorts first) keeps working unchanged for any existing/future caller that
// does not need to target a specific tool name.
function pickScriptedToolUse(ctx, parsedTools, body) {
  if (typeof ctx.toolUsePicker === "function") {
    try {
      const picked = ctx.toolUsePicker(parsedTools, body);
      if (picked && typeof picked.name === "string") {
        return { name: picked.name, input: picked.input || {} };
      }
    } catch {
      // falls through to the default below
    }
  }
  return { name: parsedTools[0].name, input: scriptedToolUseInput(ctx, parsedTools, body) };
}

/**
 * A minimal, paginated GET /v1/models — two fixture models split across two
 * pages, exercising the discovery loop's `has_more`/`after_id` handling for
 * real.
 */
function handleModelsRequest(req, res, ctx, url) {
  if (ctx.scenario === "models-404") {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ type: "error", error: { type: "not_found_error", message: "not implemented" } }));
    return;
  }
  if (ctx.scenario === "models-401") {
    return sendJsonError(res, 401, "authentication_error", "invalid x-api-key");
  }
  const parsed = new URL(url, "http://placeholder");
  const afterId = parsed.searchParams.get("after_id");
  const pages = [
    { data: [{ id: "fixture-model-a", display_name: "Fixture Model A" }], has_more: true, last_id: "fixture-model-a" },
    { data: [{ id: "fixture-model-b", display_name: "Fixture Model B" }], has_more: false, last_id: "fixture-model-b" }
  ];
  const page = afterId ? pages[1] : pages[0];
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(page));
}

/**
 * Start the fixture server.
 * @param {{ scenario?: string, tls?: { selfSigned: true } | { hostnameMismatch: true }, redirectTargetOrigin?: string, scriptToolUseInput?: (parsedTools: any[], rawBody: string) => object, scriptToolUse?: (parsedTools: any[], rawBody: string) => ({ name: string, input?: object } | null) }} [opts]
 *   Both are ADDITIVE and opt-in — omitting them (every pre-existing
 *   consumer of this fixture) preserves today's behavior byte-for-byte.
 *   `scriptToolUseInput` is invoked with the request's parsed `tools` array
 *   and raw body when a scenario would emit a tool_use for the first tool
 *   named in that array (the existing "hasToolResult ? text : hasImage ?
 *   text : parsedTools.length > 0 ? tool_use" branching, unchanged), and its
 *   return value becomes that tool_use's `input` instead of the fixture's
 *   long-standing default `{}`. `scriptToolUse` is a stronger, ADDITIVE
 *   override of the SAME decision point that also picks WHICH tool gets the
 *   tool_use (not just its input) — needed because the real CLI's wire-level
 *   tool ordering/naming does not necessarily match a caller's `query()`
 *   `tools` option order (empirically observed: `"Task"` surfaces on the
 *   wire as a tool literally named `"Agent"`, sorted ahead of `"Skill"`).
 *   Return `{ name, input? }` naming a tool present in `parsedTools` to pick
 *   it specifically, or `null`/anything else to fall back to
 *   `scriptToolUseInput`'s default (first-tool) behavior.
 * @returns {Promise<{ url: string, port: number, close: () => Promise<void>, setScenario: (s: string) => void, callLog: any[] }>}
 */
export async function startFixtureAnthropicServer(opts = {}) {
  const ctx = {
    scenario: opts.scenario || "success",
    redirectTargetOrigin: opts.redirectTargetOrigin,
    callLog: [],
    port: 0,
    toolUseInputProvider: typeof opts.scriptToolUseInput === "function" ? opts.scriptToolUseInput : undefined,
    toolUsePicker: typeof opts.scriptToolUse === "function" ? opts.scriptToolUse : undefined
  };

  let server;
  let protocol = "http";
  if (opts.tls) {
    protocol = "https";
    const cert = generateSelfSignedCert(opts.tls.hostnameMismatch ? "definitely-not-localhost.invalid" : "127.0.0.1");
    server = https.createServer({ key: cert.key, cert: cert.cert }, (req, res) => handleRequest(req, res, ctx));
  } else {
    server = http.createServer((req, res) => handleRequest(req, res, ctx));
  }

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  ctx.port = port;

  return {
    url: `${protocol}://127.0.0.1:${port}`,
    port,
    callLog: ctx.callLog,
    setScenario: (s) => {
      ctx.scenario = s;
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
    server
  };
}

/**
 * @returns {boolean} whether the `openssl` CLI is on PATH — the TLS-failure
 *   fixture scenarios need it to mint a throwaway self-signed certificate.
 *   Node's `crypto` module has no X.509 certificate-generation API of its
 *   own. When unavailable, callers record that specific scenario as BLOCKED
 *   (see reports/04-settings-evidence.md) rather than skipping it silently.
 */
export function isOpensslAvailable() {
  try {
    execFileSync("openssl", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Generate a throwaway self-signed cert for the TLS-failure test scenarios. */
function generateSelfSignedCert(commonName) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocic-fixture-cert-"));
  const keyPath = path.join(dir, "key.pem");
  const certPath = path.join(dir, "cert.pem");
  try {
    execFileSync("openssl", [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes",
      "-keyout", keyPath, "-out", certPath,
      "-days", "1", "-subj", `/CN=${commonName}`
    ]);
    return { key: fs.readFileSync(keyPath, "utf-8"), cert: fs.readFileSync(certPath, "utf-8") };
  } finally {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
}
