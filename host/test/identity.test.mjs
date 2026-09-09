#!/usr/bin/env node
//
// Tests for host/agent/identity.js — the Chromium extension-ID derivation
// (SHA-256 of the SPKI-DER public key, first 128 bits, nibbles mapped a-p)
// and its validation helpers.
//
// The primary "known vector" below is NOT self-referential: the expected id
// was computed independently with `openssl` + `tr`, outside this codebase's
// own crypto code, against the actual key committed in extension/manifest.json:
//
//   openssl rsa -in extension.pem -pubout -outform DER -out pub.der
//   openssl dgst -sha256 -binary pub.der | xxd -p -c 256   # sha256 hex
//   <first 32 hex chars> | tr '0123456789abcdef' 'abcdefghijklmnop'
//
// That produced `ihljfjgoakmoemkdondoaadegpmibimh`, matching identity.js's
// own output — see openspec/changes/migrate-to-claude-agent-sdk/reports/
// 02-packaging-evidence.md for the full transcript of that independent check.
//
// Run: node host/test/identity.test.mjs

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  decodePublicKeyDer,
  deriveExtensionId,
  isValidExtensionId,
  verifyExtensionId,
  loadManifestKey,
  deriveIdFromManifest
} from "../agent/identity.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");
const REAL_MANIFEST_PATH = path.join(REPO_ROOT, "extension", "manifest.json");
const IDENTITY_CLI = path.join(HERE, "..", "agent", "identity.js");

// Independently verified against the real committed key — see file header.
const KNOWN_VECTOR_ID = "ihljfjgoakmoemkdondoaadegpmibimh";

const results = [];
function test(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
    console.log(`  PASS  ${name}`);
  } catch (err) {
    results.push({ name, ok: false, err: err.message });
    console.log(`  FAIL  ${name}  — ${err.stack || err.message}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
function assertThrows(fn, msgPattern, label) {
  try {
    fn();
  } catch (err) {
    if (msgPattern && !msgPattern.test(err.message)) {
      throw new Error(`${label}: threw, but message "${err.message}" did not match ${msgPattern}`);
    }
    return;
  }
  throw new Error(`${label}: expected to throw, did not`);
}

// Generate a throwaway RSA keypair, returning its base64 SPKI public key.
function freshKey() {
  const { publicKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" }
  });
  const der = crypto.createPublicKey(publicKey).export({ type: "spki", format: "der" });
  return der.toString("base64");
}

console.log("\nExtension identity derivation\n");

test("known vector: the real manifest key derives to the independently-computed id", () => {
  const realKey = loadManifestKey(REAL_MANIFEST_PATH);
  const id = deriveExtensionId(realKey);
  assert(
    id === KNOWN_VECTOR_ID,
    `expected ${KNOWN_VECTOR_ID}, got ${id} — extension/manifest.json's "key" changed since the known vector was computed`
  );
});

test("deriveIdFromManifest matches deriveExtensionId(loadManifestKey(...))", () => {
  assert(deriveIdFromManifest(REAL_MANIFEST_PATH) === KNOWN_VECTOR_ID, "deriveIdFromManifest mismatch");
});

test("derivation is deterministic across repeated calls", () => {
  const key = freshKey();
  const a = deriveExtensionId(key);
  const b = deriveExtensionId(key);
  const c = deriveExtensionId(key);
  assert(a === b && b === c, "same key produced different ids across calls");
  assert(isValidExtensionId(a), `derived id "${a}" is not a well-formed extension id`);
});

test("different keys derive to different ids", () => {
  const idA = deriveExtensionId(freshKey());
  const idB = deriveExtensionId(freshKey());
  assert(idA !== idB, "two distinct freshly-generated keys collided (statistically impossible unless the code is broken)");
});

test("isValidExtensionId accepts only 32 lowercase a-p characters", () => {
  assert(isValidExtensionId("a".repeat(32)), "32 a's should be valid");
  assert(isValidExtensionId("p".repeat(32)), "32 p's should be valid");
  assert(!isValidExtensionId("a".repeat(31)), "31 chars should be invalid (too short)");
  assert(!isValidExtensionId("a".repeat(33)), "33 chars should be invalid (too long)");
  assert(!isValidExtensionId("q".repeat(32)), "'q' is outside a-p and should be invalid");
  assert(!isValidExtensionId("A".repeat(32)), "uppercase should be invalid");
  assert(!isValidExtensionId(""), "empty string should be invalid");
  assert(!isValidExtensionId(null), "null should be invalid");
  assert(!isValidExtensionId(undefined), "undefined should be invalid");
});

test("verifyExtensionId succeeds when derived and expected match (case-insensitive, trimmed)", () => {
  const key = loadManifestKey(REAL_MANIFEST_PATH);
  const r1 = verifyExtensionId(key, KNOWN_VECTOR_ID);
  assert(r1.ok, `expected match: ${r1.reason}`);
  const r2 = verifyExtensionId(key, `  ${KNOWN_VECTOR_ID.toUpperCase()}  `);
  assert(r2.ok, `expected match after trim/lowercase normalization: ${r2.reason}`);
});

test("verifyExtensionId reports a mismatch distinctly from an invalid expected id", () => {
  const key = loadManifestKey(REAL_MANIFEST_PATH);
  const mismatch = verifyExtensionId(key, "a".repeat(32));
  assert(!mismatch.ok, "expected mismatch to fail");
  assert(/id mismatch/.test(mismatch.reason), `expected an "id mismatch" reason, got: ${mismatch.reason}`);

  const malformed = verifyExtensionId(key, "not-an-extension-id");
  assert(!malformed.ok, "expected malformed expected-id to fail");
  assert(/not a well-formed/.test(malformed.reason), `expected a "not a well-formed" reason, got: ${malformed.reason}`);
});

test("corrupt key: empty string is rejected", () => {
  assertThrows(() => decodePublicKeyDer(""), /empty/, "empty key");
});

test("corrupt key: invalid base64 characters are rejected", () => {
  assertThrows(() => decodePublicKeyDer("not*valid*base64!!"), /not valid base64/, "invalid charset");
});

test("corrupt key: base64 that is not a real SPKI public key is rejected", () => {
  const garbage = Buffer.from("this is definitely not a der-encoded public key, just random bytes padded out").toString("base64");
  assertThrows(() => decodePublicKeyDer(garbage), /not a valid SPKI public key/, "structurally invalid key");
});

test("corrupt key: truncated real key is rejected, not silently re-hashed", () => {
  const key = loadManifestKey(REAL_MANIFEST_PATH);
  const truncated = key.slice(0, key.length - 40);
  assertThrows(() => decodePublicKeyDer(truncated), null, "truncated key");
  // And critically: whatever error it throws, it must NOT silently produce a
  // 32-character id as if nothing were wrong.
  let derivedSomething = false;
  try {
    deriveExtensionId(truncated);
    derivedSomething = true;
  } catch {
    /* expected */
  }
  assert(!derivedSomething, "a truncated/corrupt key must not silently derive an id");
});

test("loadManifestKey distinguishes a missing manifest file", () => {
  assertThrows(
    () => loadManifestKey(path.join(os.tmpdir(), "does-not-exist-ocic", "manifest.json")),
    /not found/,
    "missing manifest file"
  );
});

test("loadManifestKey tolerates a UTF-8 BOM (Windows editors/PowerShell commonly add one)", () => {
  const p = fs.mkdtempSync(path.join(os.tmpdir(), "ocic-identity-"));
  const manifestPath = path.join(p, "manifest.json");
  const key = freshKey();
  const bom = "﻿";
  fs.writeFileSync(manifestPath, bom + JSON.stringify({ manifest_version: 3, name: "x", key }));
  try {
    assert(loadManifestKey(manifestPath) === key, "BOM-prefixed manifest should still yield the correct key");
    assert(deriveIdFromManifest(manifestPath) === deriveExtensionId(key), "id derived from a BOM-prefixed manifest should match");
  } finally {
    fs.rmSync(p, { recursive: true, force: true });
  }
});

test("loadManifestKey distinguishes invalid JSON", () => {
  const p = fs.mkdtempSync(path.join(os.tmpdir(), "ocic-identity-"));
  const manifestPath = path.join(p, "manifest.json");
  fs.writeFileSync(manifestPath, "{ not json");
  try {
    assertThrows(() => loadManifestKey(manifestPath), /not valid JSON/, "invalid JSON manifest");
  } finally {
    fs.rmSync(p, { recursive: true, force: true });
  }
});

test("loadManifestKey distinguishes a manifest with no key field", () => {
  const p = fs.mkdtempSync(path.join(os.tmpdir(), "ocic-identity-"));
  const manifestPath = path.join(p, "manifest.json");
  fs.writeFileSync(manifestPath, JSON.stringify({ manifest_version: 3, name: "x" }));
  try {
    assertThrows(() => loadManifestKey(manifestPath), /no "key" field/, "manifest missing key");
  } finally {
    fs.rmSync(p, { recursive: true, force: true });
  }
});

test("paths with spaces and unicode: manifest can live under such a directory", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocic identity 目录 "));
  const manifestPath = path.join(dir, "manifest.json");
  const key = freshKey();
  try {
    fs.writeFileSync(manifestPath, JSON.stringify({ manifest_version: 3, name: "x", key }));
    const id = deriveIdFromManifest(manifestPath);
    assert(isValidExtensionId(id), `expected a valid id, got ${id}`);
    assert(id === deriveExtensionId(key), "id from spaced/unicode path manifest did not match direct derivation");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- CLI ---------------------------------------------------------------

function runCli(args) {
  const res = spawnSync(process.execPath, [IDENTITY_CLI, ...args], { encoding: "utf-8" });
  return { status: res.status, stdout: res.stdout.trim(), stderr: res.stderr.trim() };
}

test("CLI derive: prints only the bare id and exits 0", () => {
  const { status, stdout, stderr } = runCli(["derive", REAL_MANIFEST_PATH]);
  assert(status === 0, `expected exit 0, got ${status}, stderr: ${stderr}`);
  assert(stdout === KNOWN_VECTOR_ID, `expected stdout to be exactly the id, got "${stdout}"`);
});

test("CLI verify: exits 0 on a matching id", () => {
  const { status, stderr } = runCli(["verify", REAL_MANIFEST_PATH, KNOWN_VECTOR_ID]);
  assert(status === 0, `expected exit 0, got ${status}, stderr: ${stderr}`);
});

test("CLI verify: exits 1 with an 'id mismatch' diagnostic on a wrong id", () => {
  const { status, stderr } = runCli(["verify", REAL_MANIFEST_PATH, "a".repeat(32)]);
  assert(status === 1, `expected exit 1, got ${status}`);
  assert(/id mismatch/.test(stderr), `expected an "id mismatch" diagnostic, got: ${stderr}`);
});

test("CLI derive: exits 1 with a 'not found' diagnostic for a missing manifest", () => {
  const { status, stderr } = runCli(["derive", path.join(os.tmpdir(), "no-such-ocic-manifest.json")]);
  assert(status === 1, `expected exit 1, got ${status}`);
  assert(/not found/.test(stderr), `expected a "not found" diagnostic, got: ${stderr}`);
});

// ---------------------------------------------------------------------------

const failed = results.filter((r) => !r.ok);
console.log(
  `\n${results.length - failed.length}/${results.length} passed` +
    (failed.length ? `\n\nFailures:\n${failed.map((f) => `  - ${f.name}: ${f.err}`).join("\n")}` : "") +
    "\n"
);
process.exit(failed.length ? 1 : 0);
