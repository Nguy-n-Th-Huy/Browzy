#!/usr/bin/env node
//
// The redirect-safe HTTP client shared by discovery and the capability-test
// preflight (host/agent/settings/http-client.js), exercised against the real
// in-process fixture server's real HTTP redirect responses (not mocked
// fetch) — a same-origin redirect is followed, a cross-origin redirect is
// rejected before the credential ever reaches it.
//
// Run: node host/test/settings-http-client.test.mjs

import { authenticatedFetch } from "../agent/settings/http-client.js";
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

console.log("\nRedirect-safe HTTP client (real fixture server, real HTTP redirects)\n");

await check("follows a same-origin redirect and returns the target's response", async () => {
  const fixture = await startFixtureAnthropicServer({ scenario: "redirect-same-origin" });
  try {
    const response = await authenticatedFetch(fixture.url, "/v1/messages", { apiKey: "sk-fixture", method: "POST", body: {} });
    // The fixture's redirect target ("/v1/messages-target") isn't a route it
    // recognizes, so it 404s — proving the redirect really was followed
    // (a rejected-before-following redirect would instead throw
    // REDIRECT_REJECTED, and an unfollowed one would return the bare 302).
    assert(response.status === 404, `expected the same-origin target to be reached (404), got ${response.status}`);
  } finally {
    await fixture.close();
  }
});

await check("rejects a cross-origin redirect before the credential reaches the target origin", async () => {
  const fixture = await startFixtureAnthropicServer({ scenario: "redirect-cross-origin", redirectTargetOrigin: "http://127.0.0.1:1" });
  try {
    let code = null;
    let detail = null;
    try {
      await authenticatedFetch(fixture.url, "/v1/messages", { apiKey: "sk-should-never-be-sent-cross-origin", method: "POST", body: {} });
    } catch (err) {
      code = err.code;
      detail = err.detail;
    }
    assert(code === "REDIRECT_REJECTED", `expected REDIRECT_REJECTED, got ${code}`);
    assert(detail && detail.to === "http://127.0.0.1:1", JSON.stringify(detail));
  } finally {
    await fixture.close();
  }
});

await check("never sends Authorization: Bearer — only x-api-key (header-semantics requirement)", async () => {
  const fixture = await startFixtureAnthropicServer({ scenario: "success" });
  try {
    let seenHeaders = null;
    const fetchImpl = async (url, init) => {
      seenHeaders = init.headers;
      return fetch(url, init);
    };
    await authenticatedFetch(fixture.url, "/v1/messages", { apiKey: "sk-fixture", method: "POST", body: {}, fetchImpl });
    assert(seenHeaders["x-api-key"] === "sk-fixture", JSON.stringify(seenHeaders));
    assert(!("authorization" in seenHeaders) && !("Authorization" in seenHeaders), "must never send an Authorization header");
  } finally {
    await fixture.close();
  }
});

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed\n`);
if (failed.length > 0) process.exitCode = 1;
