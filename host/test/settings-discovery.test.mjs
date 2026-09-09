#!/usr/bin/env node
//
// Paginated model discovery (host/agent/settings/discovery.js), exercised
// against the in-process fixture Anthropic-API-shaped server — real HTTP,
// real pagination, real error-status mapping, no live provider.
//
// Run: node host/test/settings-discovery.test.mjs

import { discoverModels } from "../agent/settings/discovery.js";
import { startFixtureAnthropicServer } from "../agent/settings/testing/fixture-anthropic-server.mjs";

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  PASS  ${name}`);
  } catch (err) {
    results.push({ name, ok: false, err: err.message });
    console.log(`  FAIL  ${name} — ${err.message}\n${err.stack}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

console.log("\nPaginated model discovery (real fixture HTTP server)\n");

await check("discovers models across two pages, following has_more/after_id", async () => {
  const fixture = await startFixtureAnthropicServer({ scenario: "success" });
  try {
    const result = await discoverModels({ baseUrl: fixture.url, apiKey: "sk-fixture" });
    assert(result.supported === true, JSON.stringify(result));
    const ids = result.models.map((m) => m.id).sort();
    assert(ids.join(",") === "fixture-model-a,fixture-model-b", ids.join(","));
    assert(result.models.find((m) => m.id === "fixture-model-a").label === "Fixture Model A");
  } finally {
    await fixture.close();
  }
});

await check("a 404 model-listing route is reported as unsupported, not an error", async () => {
  const fixture = await startFixtureAnthropicServer({ scenario: "models-404" });
  try {
    const result = await discoverModels({ baseUrl: fixture.url, apiKey: "sk-fixture" });
    assert(result.supported === false, JSON.stringify(result));
    assert(/404/.test(result.reason), result.reason);
  } finally {
    await fixture.close();
  }
});

await check("a 401 on the models route is a real AUTH_ERROR, not silently reported as unsupported", async () => {
  const fixture = await startFixtureAnthropicServer({ scenario: "models-401" });
  try {
    let code = null;
    try {
      await discoverModels({ baseUrl: fixture.url, apiKey: "sk-bad" });
    } catch (err) {
      code = err.code;
    }
    assert(code === "AUTH_ERROR", `expected AUTH_ERROR, got ${code}`);
  } finally {
    await fixture.close();
  }
});

await check("a non-Anthropic-shaped 200 response is a PROTOCOL_ERROR, not a false empty-list pass", async () => {
  const fixture = await startFixtureAnthropicServer({ scenario: "success" });
  try {
    // Point discovery at a route that returns plain 200 JSON with no "data"
    // array — simulate a gateway that 200s everything.
    const originalUrl = fixture.url;
    fixture.setScenario("protocol-openai-models"); // not modeled by the fixture's /v1/models handler -> falls through to default two-page success
    // Use a fetchImpl override to redirect straight at a route that returns
    // a non-Anthropic JSON shape for /v1/models specifically.
    const fetchImpl = async (url, init) => {
      if (String(url).includes("/v1/models")) {
        return new Response(JSON.stringify({ id: "chatcmpl-x", object: "chat.completion" }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      return fetch(url, init);
    };
    let code = null;
    try {
      await discoverModels({ baseUrl: originalUrl, apiKey: "sk-fixture", fetchImpl });
    } catch (err) {
      code = err.code;
    }
    assert(code === "PROTOCOL_ERROR", `expected PROTOCOL_ERROR, got ${code}`);
  } finally {
    await fixture.close();
  }
});

await check("a cross-origin redirect during discovery is rejected, never followed with the credential", async () => {
  const fixture = await startFixtureAnthropicServer({ scenario: "success" });
  const evilOrigin = "http://127.0.0.1:1"; // never actually contacted — rejection must happen before any request there
  try {
    const fetchImpl = async (url, init) => {
      if (String(url).includes("/v1/models") && !String(url).includes("already-redirected")) {
        return new Response(null, { status: 302, headers: { location: `${evilOrigin}/v1/models` } });
      }
      throw new Error("must never actually be fetched — the redirect must be rejected before this point");
    };
    let code = null;
    try {
      await discoverModels({ baseUrl: fixture.url, apiKey: "sk-fixture", fetchImpl });
    } catch (err) {
      code = err.code;
    }
    assert(code === "REDIRECT_REJECTED", `expected REDIRECT_REJECTED, got ${code}`);
  } finally {
    await fixture.close();
  }
});

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed\n`);
if (failed.length > 0) process.exitCode = 1;
