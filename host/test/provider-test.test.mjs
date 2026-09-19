#!/usr/bin/env node
// Regression cover for host/agent/provider-test.mjs — the `browzy provider-test`
// diagnostic.
//
// THE DEFECT THIS PINS. The Settings page shows one short line per failure
// (extension/settings/errors-ui.js), and every transport-shaped failure comes
// out as "Lỗi mạng / TLS — Kiểm tra Base URL, chứng chỉ TLS và kết nối mạng."
// A gateway that answers HTTP 503 for an unrecognized model id produces exactly
// that, so an operator with a perfectly good URL and key is sent chasing TLS.
// Verified against the live gateway used to develop this: an unknown model id
// returned 503 and was classified NETWORK_ERROR (capability-test.js's own
// header documents that shape), while the SAME endpoint, key and a valid model
// passed text+tool+vision.
//
// So the two properties worth a test are: (1) the verdict names the real cause
// for every shape of failure the capability test can produce, and (2) the
// report it prints is safe to paste — the credential is scrubbed.
//
// Run: node host/test/provider-test.test.mjs

import { _verdictForTests as verdict } from "../agent/provider-test.mjs";
import { redactSecretsDeep } from "../agent/secrets/redact.js";

let fail = 0;
function ok(cond, msg) {
  console.log((cond ? "  PASS " : "  FAIL ") + msg);
  if (!cond) fail++;
}

const reachOk = { name: "reachability", ok: true, status: 200 };
const listOk = { name: "model-list", ok: true, status: 200, modelCount: 3, models: ["a", "b", "c"] };
const list401 = { name: "model-list", ok: false, status: 401 };
const cap = (errors, status = "fail") => [{ name: "capability:m", ok: status === "pass", status, capabilities: { text: status }, errors }];

console.log("\nprovider-test: naming the real cause\n");

ok(
  verdict({ reachability: { ok: false, error: { message: "getaddrinfo ENOTFOUND" } }, modelList: null, capabilities: null }).cause ===
    "network_or_tls",
  "a base URL that cannot be reached at all is reported as network/TLS — the one case that wording is right about"
);

ok(
  verdict({ reachability: reachOk, modelList: list401, capabilities: null }).cause === "credential_rejected",
  "an endpoint that answers 401 is reported as a REJECTED KEY, not as a network fault"
);

ok(
  verdict({ reachability: reachOk, modelList: listOk, capabilities: cap({ text: { code: "AUTH_ERROR" } }) }).cause === "credential_rejected",
  "an AUTH_ERROR from the capability request is also a rejected key"
);

ok(
  verdict({ reachability: reachOk, modelList: listOk, capabilities: cap({ text: { code: "MODEL_UNAVAILABLE_ERROR" } }) }).cause ===
    "model_unavailable",
  "a 404/model_not_found names the model id as the cause"
);

// The reported case. This is the shape a real gateway produced for an unknown
// model, and the whole reason the command exists.
{
  const v = verdict({
    reachability: reachOk,
    modelList: listOk,
    capabilities: cap({ text: { code: "NETWORK_ERROR", message: "provider server error (HTTP 503)" } })
  });
  ok(v.cause === "endpoint_5xx_or_transport", "a 503 from the provider is NOT reported as a TLS problem");
  ok(/503|5xx/.test(v.detail), "...and the detail says so, instead of blaming the certificate");
  ok(/model id/i.test(v.next), "...and the next step points at the model list, the fix that actually works");
}

ok(
  verdict({ reachability: reachOk, modelList: listOk, capabilities: cap({ text: { code: "PROTOCOL_ERROR" } }) }).cause ===
    "not_anthropic_compatible",
  "a non-Anthropic endpoint is named as a protocol mismatch"
);

ok(
  verdict({ reachability: reachOk, modelList: listOk, capabilities: cap({}, "pass").map((c) => ({ ...c, ok: true })) }).cause === "ok",
  "everything passing is reported as ok"
);

ok(
  verdict({ reachability: reachOk, modelList: null, capabilities: null }).cause === "unknown",
  "no facts at all is reported as unknown — never a guess"
);

console.log("\nprovider-test: the report is safe to paste\n");
{
  const secret = "sk-live-abcdef0123456789";
  const report = {
    profile: { baseUrl: "https://gw.example", apiKeyHint: null },
    checks: [
      { name: "model-list", bodyPreview: `{"error":"invalid key ${secret}"}` },
      { name: "credential", secrets: { apiKey: secret } },
      { name: "nested", deep: [{ note: `header x-api-key: ${secret} was rejected` }] }
    ]
  };
  const safe = JSON.stringify(redactSecretsDeep(report, [secret]));
  ok(!safe.includes(secret), "the credential value never survives into the report");
  ok(safe.includes("[REDACTED]"), "...it is replaced by an explicit mask rather than dropped silently");
}

console.log(fail === 0 ? "\nALL PROVIDER-TEST TESTS PASSED" : `\n${fail} FAILED`);
process.exit(fail ? 1 : 0);
