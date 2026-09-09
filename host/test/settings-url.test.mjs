#!/usr/bin/env node
//
// Base URL normalization/validation (host/agent/settings/url.js).
//
// Run: node host/test/settings-url.test.mjs

import { normalizeBaseUrl, tryNormalizeBaseUrl, DEFAULT_BASE_URL } from "../agent/settings/url.js";

const results = [];
function check(name, fn) {
  try {
    fn();
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

console.log("\nBase URL normalization/validation — accept/reject table\n");

// --- accept cases ---

check("accepts the documented default", () => {
  const { normalized } = normalizeBaseUrl(DEFAULT_BASE_URL);
  assert(normalized === "https://api.anthropic.com", normalized);
});

check("accepts a gateway prefix path", () => {
  const { normalized } = normalizeBaseUrl("https://gateway.example.com/proxy");
  assert(normalized === "https://gateway.example.com/proxy", normalized);
});

check("strips a trailing slash", () => {
  const { normalized } = normalizeBaseUrl("https://api.anthropic.com/");
  assert(normalized === "https://api.anthropic.com", normalized);
});

check("strips a terminal /v1 (bare)", () => {
  const { normalized } = normalizeBaseUrl("https://gateway.example.com/v1");
  assert(normalized === "https://gateway.example.com", normalized);
});

check("strips a terminal /v1 (after a gateway prefix) — never doubles /v1/v1", () => {
  const { normalized } = normalizeBaseUrl("https://gateway.example.com/proxy/v1");
  assert(normalized === "https://gateway.example.com/proxy", normalized);
  assert(!normalized.includes("/v1"), `should not retain /v1: ${normalized}`);
});

check("strips a terminal /v1/ (trailing slash AND /v1 together)", () => {
  const { normalized } = normalizeBaseUrl("https://gateway.example.com/proxy/v1/");
  assert(normalized === "https://gateway.example.com/proxy", normalized);
});

check("preserves a non-terminal 'v1' inside a path segment (not a real /v1 suffix)", () => {
  const { normalized } = normalizeBaseUrl("https://gateway.example.com/v10/foo");
  assert(normalized === "https://gateway.example.com/v10/foo", normalized);
});

check("preserves an explicit port", () => {
  const { normalized } = normalizeBaseUrl("https://gateway.example.com:8443/proxy");
  assert(normalized === "https://gateway.example.com:8443/proxy", normalized);
});

check("allows plain HTTP to localhost (explicit loopback dev endpoint)", () => {
  const { normalized, isLoopbackHttp } = normalizeBaseUrl("http://localhost:8080");
  assert(normalized === "http://localhost:8080", normalized);
  assert(isLoopbackHttp === true, "expected isLoopbackHttp");
});

check("allows plain HTTP to 127.0.0.1", () => {
  const { isLoopbackHttp } = normalizeBaseUrl("http://127.0.0.1:8080/v1");
  assert(isLoopbackHttp === true);
});

check("allows plain HTTP to [::1]", () => {
  const { isLoopbackHttp } = normalizeBaseUrl("http://[::1]:9000");
  assert(isLoopbackHttp === true);
});

check("trims surrounding whitespace before parsing", () => {
  const { normalized } = normalizeBaseUrl("   https://api.anthropic.com   ");
  assert(normalized === "https://api.anthropic.com", normalized);
});

// --- reject cases ---

function expectReject(name, input, messagePattern) {
  check(name, () => {
    let threw = false;
    try {
      normalizeBaseUrl(input);
    } catch (err) {
      threw = true;
      if (messagePattern) assert(messagePattern.test(err.message), `unexpected message: ${err.message}`);
      assert(err.code === "INVALID_BASE_URL", `expected code INVALID_BASE_URL, got ${err.code}`);
    }
    assert(threw, `expected normalizeBaseUrl(${JSON.stringify(input)}) to throw`);
  });
}

expectReject("rejects userinfo (username)", "https://user@gateway.example.com", /userinfo/);
expectReject("rejects userinfo (username:password)", "https://user:pass@gateway.example.com", /userinfo/);
expectReject("rejects a query string", "https://api.anthropic.com/?foo=bar", /query/);
expectReject("rejects a fragment", "https://api.anthropic.com/#section", /fragment/);
expectReject("rejects plain HTTP to a public host", "http://gateway.example.com", /HTTPS/);
expectReject("rejects an unsupported scheme", "ftp://gateway.example.com", /HTTPS|scheme/);
expectReject("rejects an empty string", "", /required/);
expectReject("rejects a non-URL string", "not a url at all", /valid absolute URL/);
expectReject("rejects a non-string input", null, /required/);

check("tryNormalizeBaseUrl returns a structured, non-throwing result on failure", () => {
  const result = tryNormalizeBaseUrl("http://public.example.com");
  assert(result.ok === false, "expected ok:false");
  assert(typeof result.error === "string" && result.error.length > 0, "expected an error string");
});

check("tryNormalizeBaseUrl returns a structured, non-throwing result on success", () => {
  const result = tryNormalizeBaseUrl("https://api.anthropic.com");
  assert(result.ok === true, "expected ok:true");
  assert(result.normalized === "https://api.anthropic.com", result.normalized);
});

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed\n`);
if (failed.length > 0) {
  process.exitCode = 1;
}
