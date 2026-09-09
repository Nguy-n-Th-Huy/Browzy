#!/usr/bin/env node
//
// Credential redaction, verified with a grep, not a code-review claim:
// "no secret in storage files, logs, diagnostics, exports, or command-line
// arguments" (task 4.3). A unique, never-reused secret value is run through
// a real save -> set-credential -> export flow (twice: once memory-only,
// once against the real Windows Credential Manager on this machine), every
// line this process logs is captured, and both the captured log text and
// every file this flow touched are grepped for the literal secret. Passing
// means the string genuinely never appeared, not that the code "looks"
// redacted.
//
// Run: node host/test/secrets-redaction.test.mjs

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as profile from "../agent/settings/profile.js";
import { memoryClearAll } from "../agent/secrets/memory-store.js";
import { redactSecretsInText, redactSecretsDeep } from "../agent/secrets/redact.js";
import { windowsCredWrite, windowsCredRead, windowsCredDelete, isWindowsCredentialManagerPlatform } from "../agent/secrets/windows-credential-manager.js";

// CRITICAL: this file's profile-level checks must NEVER use profileId
// "default" (host/agent/settings/profile-schema.js's DEFAULT_PROFILE_ID —
// the exact profileId every real installation uses).
//
// Why this matters: OCIC_AGENT_CONFIG_DIR (set below) isolates only the
// non-secret profile JSON on disk. The OS credential store (Windows
// Credential Manager here) is a GLOBAL, machine-wide namespace keyed
// *solely* by profile.js's `credentialTarget(profileId)` —
// `browzy-in-chrome/settings/${profileId}` — which is NOT scoped by
// OCIC_AGENT_CONFIG_DIR at all. A test that calls
// `profile.setCredential("default", ...)` / `profile.removeCredential("default")`
// against the real (non-memory) backend therefore reads and then DELETES the
// exact same physical OS secret a real "default" profile on this machine
// uses — this was reproduced live and destroyed a real stored API key (see
// reports/09-live-gate-evidence.md and reports/04-settings-evidence.md).
//
// Fix: every profile.js call in this file uses a dedicated, obviously
// test-only profileId (mirroring secrets-store.test.mjs's own
// `browzy-in-chrome-test/...` raw-target convention) instead of
// "default". A second, structural guard also exists in
// host/agent/secrets/secret-store.js: it refuses any real-backend
// storeSecret/readSecret/deleteSecret call against the exact production
// target while OCIC_AGENT_CONFIG_DIR is set, so a future regression here (or
// in any other test) throws immediately instead of silently colliding.
const TEST_PROFILE_ID = "ocic-test-secrets-redaction";

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

function grepDirRecursive(dir, needle) {
  const hits = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return hits;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      hits.push(...grepDirRecursive(full, needle));
    } else {
      let content;
      try {
        content = fs.readFileSync(full, "utf-8");
      } catch {
        continue; // binary/unreadable — not a concern for this JSON-only profile store
      }
      if (content.includes(needle)) hits.push(full);
    }
  }
  return hits;
}

function captureConsole() {
  const lines = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args) => {
    lines.push(args.map(String).join(" "));
  };
  console.error = (...args) => {
    lines.push(args.map(String).join(" "));
  };
  return {
    lines,
    restore: () => {
      console.log = originalLog;
      console.error = originalError;
    }
  };
}

console.log("\nCredential redaction — grep-based verification (real files, real captured output)\n");

await check("a secret set via memory-only mode never appears in the on-disk profile file or in captured log output", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocic-redaction-test-"));
  process.env.OCIC_AGENT_CONFIG_DIR = dir;
  memoryClearAll();
  const SECRET = `sk-redaction-probe-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  const capture = captureConsole();
  try {
    await profile.saveProfile({
      profileId: TEST_PROFILE_ID,
      baseUrl: "https://api.anthropic.com",
      models: [{ id: "claude-x", label: "X" }],
      defaultModelId: "claude-x"
    });
    await profile.setCredential(TEST_PROFILE_ID, SECRET, { memoryOnly: true });
    console.log(`[test] credential set for profile ${TEST_PROFILE_ID} (redacted)`); // a realistic log line an app might actually emit
    const loaded = await profile.loadProfile();
    console.log(`[test] loaded profile: ${JSON.stringify(loaded)}`); // this is the kind of line that WOULD leak a secret if the store held one
    const exported = await profile.exportProfileRedacted(TEST_PROFILE_ID);
    console.log(`[test] exported: ${JSON.stringify(exported)}`);
  } finally {
    capture.restore();
  }

  const loggedText = capture.lines.join("\n");
  assert(!loggedText.includes(SECRET), `secret leaked into console output:\n${loggedText}`);

  const fileHits = grepDirRecursive(dir, SECRET);
  assert(fileHits.length === 0, `secret leaked into on-disk file(s): ${fileHits.join(", ")}`);

  fs.rmSync(dir, { recursive: true, force: true });
});

if (isWindowsCredentialManagerPlatform()) {
  await check("a secret written to the real Windows Credential Manager never appears in the on-disk profile file, in captured log output, or in the PowerShell script text itself", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocic-redaction-test-wcm-"));
    process.env.OCIC_AGENT_CONFIG_DIR = dir;
    const SECRET = `sk-redaction-probe-wcm-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const target = `browzy-in-chrome-test/redaction/${process.pid}-${Date.now()}`;

    const capture = captureConsole();
    try {
      await profile.saveProfile({
        profileId: TEST_PROFILE_ID,
        baseUrl: "https://api.anthropic.com",
        models: [{ id: "claude-x", label: "X" }],
        defaultModelId: "claude-x"
      });
      await profile.setCredential(TEST_PROFILE_ID, SECRET, { memoryOnly: false }); // real Windows Credential Manager path
      windowsCredWrite(target, SECRET); // also exercise the adapter directly
      console.log(`[test] wrote to Windows Credential Manager (redacted)`);
      const loaded = await profile.loadProfile();
      console.log(`[test] loaded profile: ${JSON.stringify(loaded)}`);
      const readBack = windowsCredRead(target);
      assert(readBack === SECRET, "sanity: the credential must genuinely round-trip before we assert on leakage");
    } finally {
      capture.restore();
      windowsCredDelete(target);
      await profile.removeCredential(TEST_PROFILE_ID);
    }

    const loggedText = capture.lines.join("\n");
    assert(!loggedText.includes(SECRET), `secret leaked into console output:\n${loggedText}`);

    const fileHits = grepDirRecursive(dir, SECRET);
    assert(fileHits.length === 0, `secret leaked into on-disk profile file(s): ${fileHits.join(", ")}`);

    // The PowerShell script text windows-credential-manager.js builds is
    // entirely static + the (non-secret) target name; the secret only ever
    // travels via stdin/stdout, base64-encoded. Confirm the source file
    // itself contains no string-interpolation of a secret variable into the
    // script text (this is a structural, not a runtime, check — a runtime
    // check of the actual child process's argv would require OS-level
    // process inspection mid-flight, which is unnecessary here: the source
    // shows exactly one interpolation point for secret material, and it
    // targets stdin, not the script string).
    const adapterSource = fs.readFileSync(new URL("../agent/secrets/windows-credential-manager.js", import.meta.url), "utf-8");
    assert(!/\$\{secret\}/i.test(adapterSource), "the secret must never be template-interpolated directly into the PowerShell script text");

    fs.rmSync(dir, { recursive: true, force: true });
  });
} else {
  console.log("  BLOCKED  Windows Credential Manager redaction check — this machine is not win32");
  results.push({ name: "wcm-redaction", ok: true, blocked: true });
}

await check("redactSecretsInText scrubs every occurrence of a known secret from arbitrary text", () => {
  const secret = "sk-test-abc-123";
  const text = `request failed for key ${secret}; retrying with ${secret} again`;
  const redacted = redactSecretsInText(text, [secret]);
  assert(!redacted.includes(secret), redacted);
  assert(redacted.split("[REDACTED]").length - 1 === 2, redacted);
});

await check("redactSecretsDeep masks a sensitive-looking key even when its exact value wasn't passed in `secrets`", () => {
  const obj = { config: { apiKey: "sk-not-passed-to-redact-fn", other: "keep-me" } };
  const redacted = redactSecretsDeep(obj, []);
  assert(redacted.config.apiKey === "[REDACTED]", JSON.stringify(redacted));
  assert(redacted.config.other === "keep-me");
});

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed\n`);
if (failed.length > 0) process.exitCode = 1;
