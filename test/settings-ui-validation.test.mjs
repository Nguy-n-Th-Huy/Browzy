// Task 4.5: field-level validation for extension/settings/ (design.md
// decision 4 / specs/agent-settings/spec.md "Invalid or partial profile").
// Plain Node, no framework — same convention as test/handlers.test.mjs.
//
// Run: node test/settings-ui-validation.test.mjs
import { validateBaseUrl, validateModelsList, DEFAULT_BASE_URL } from "../extension/settings/settings-validation.js";

let fail = 0;
const ok = (c, m) => {
  console.log((c ? "  PASS " : "  FAIL ") + m);
  if (!c) fail++;
};

console.log("== Base URL: accepted forms (mirrors host/agent/settings/url.js) ==");
ok(validateBaseUrl("https://api.anthropic.com").ok, "documented default accepted");
ok(validateBaseUrl(DEFAULT_BASE_URL).normalized === "https://api.anthropic.com", "default constant matches host default");
ok(validateBaseUrl("https://gateway.example.com/proxy").normalized === "https://gateway.example.com/proxy", "gateway prefix preserved");
ok(validateBaseUrl("https://api.anthropic.com/").normalized === "https://api.anthropic.com", "trailing slash stripped");
ok(validateBaseUrl("https://gateway.example.com/v1").normalized === "https://gateway.example.com", "terminal /v1 stripped, not doubled");
ok(validateBaseUrl("https://gateway.example.com/proxy/v1").normalized === "https://gateway.example.com/proxy", "prefix kept, /v1 stripped");
ok(validateBaseUrl("https://gateway.example.com/proxy/v1/").normalized === "https://gateway.example.com/proxy", "trailing slash + /v1 both stripped");
ok(validateBaseUrl("https://gateway.example.com/v10/foo").normalized === "https://gateway.example.com/v10/foo", "v10 is not a terminal /v1 segment");
ok(validateBaseUrl("https://gateway.example.com:8443/proxy").normalized === "https://gateway.example.com:8443/proxy", "port preserved");
ok(validateBaseUrl("http://localhost:8080").isLoopbackHttp === true, "localhost HTTP accepted as loopback");
ok(validateBaseUrl("http://127.0.0.1:8080/v1").ok && validateBaseUrl("http://127.0.0.1:8080/v1").normalized === "http://127.0.0.1:8080", "127.0.0.1 loopback + /v1 stripped");
ok(validateBaseUrl("http://[::1]:9000").isLoopbackHttp === true, "IPv6 loopback accepted");

console.log("== Base URL: rejected forms ==");
ok(!validateBaseUrl("https://user@gateway.example.com").ok, "userinfo (user@) rejected");
ok(!validateBaseUrl("https://user:pass@gateway.example.com").ok, "userinfo (user:pass@) rejected");
ok(!validateBaseUrl("https://api.anthropic.com/?foo=bar").ok, "query string rejected");
ok(!validateBaseUrl("https://api.anthropic.com/#section").ok, "fragment rejected");
ok(!validateBaseUrl("http://gateway.example.com").ok, "plain HTTP to non-loopback host rejected");
ok(!validateBaseUrl("ftp://gateway.example.com").ok, "unsupported scheme rejected");
ok(!validateBaseUrl("").ok, "empty string rejected");
ok(!validateBaseUrl("not a url at all").ok, "not-a-URL rejected");
ok(!validateBaseUrl("   ").ok, "whitespace-only rejected");
ok(!validateBaseUrl(null).ok, "null rejected without throwing");
ok(!validateBaseUrl(undefined).ok, "undefined rejected without throwing");

console.log("== Model list: valid ==");
{
  const r = validateModelsList([], null);
  ok(r.ok && r.models.length === 0 && r.defaultModelId === null, "empty list + no default is valid (never a guessed model)");
}
{
  const r = validateModelsList([{ id: "claude-sonnet-5", label: "Sonnet" }], "claude-sonnet-5");
  ok(r.ok && r.models.length === 1 && r.defaultModelId === "claude-sonnet-5", "single model with matching default accepted");
}
{
  const r = validateModelsList([{ id: "  spaced-id  ", label: "  spaced label  " }], "spaced-id");
  ok(r.ok && r.models[0].id === "spaced-id" && r.models[0].label === "spaced label", "ids/labels are trimmed");
}
{
  // Opaque, mixed-vendor IDs must be accepted verbatim -- never filtered or
  // "corrected" (this task's brief: a real gateway's /v1/models returned
  // gpt-5.6-sol / grok-4.6 / qwen3.6 alongside claude-* entries).
  const mixed = [
    { id: "claude-haiku-4-5", label: "Claude Haiku" },
    { id: "gpt-5.6-sol", label: "GPT 5.6 Sol" },
    { id: "grok-4.6", label: "Grok 4.6" },
    { id: "qwen3.6", label: "Qwen 3.6" }
  ];
  const r = validateModelsList(mixed, "grok-4.6");
  ok(r.ok && r.models.length === 4 && r.models.map((m) => m.id).join(",") === mixed.map((m) => m.id).join(","), "mixed-vendor opaque IDs accepted verbatim, order preserved");
}

console.log("== Model list: invalid ==");
ok(!validateModelsList([{ id: "a", label: "A" }, { id: "a", label: "A dup" }], "a").ok, "duplicate ID rejected");
ok(!validateModelsList([{ id: "a", label: "A" }], "b").ok, "default not referencing a list entry rejected");
ok(!validateModelsList([{ id: "a", label: "A" }], "").ok, "empty default with nonempty list rejected");
ok(!validateModelsList([{ id: "a", label: "A" }], null).ok, "null default with nonempty list rejected");
ok(!validateModelsList([{ id: "", label: "A" }], "a").ok, "empty ID rejected");
ok(!validateModelsList([{ id: "a", label: "" }], "a").ok, "empty label rejected");
ok(!validateModelsList([], "a").ok, "nonempty default with empty list rejected");
ok(!validateModelsList("not-an-array", "a").ok, "non-array models rejected without throwing");
ok(!validateModelsList([null], "a").ok, "null entry in models array rejected without throwing");
ok(!validateModelsList([{ id: 5, label: "A" }], "a").ok, "non-string id rejected without throwing");

console.log(fail === 0 ? "\nALL SETTINGS-UI VALIDATION TESTS PASSED" : `\n${fail} FAILED`);
process.exit(fail ? 1 : 0);
