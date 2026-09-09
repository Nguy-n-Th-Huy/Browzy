// Stable extension identity.
//
// Chrome derives an extension's ID purely from the public key it is signed
// with: SHA-256 the SPKI-DER public-key bytes, keep the first 128 bits (16
// bytes), then map every nibble (0-15) onto the letters a-p. This module is
// the single place that implements that algorithm, so the installer (bash and
// PowerShell) and any diagnostics never re-derive it by hand — they shell out
// to this file (see the CLI at the bottom) or import it from other Node code.
//
// Keeping the algorithm in one Node module also means the private signing
// material never needs to touch install.sh/install.ps1 at all: those scripts
// only ever see the PUBLIC key already sitting in extension/manifest.json.

import fs from "node:fs";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";

// Chrome's mapping from a 4-bit nibble to its extension-ID letter.
const NIBBLE_TO_LETTER = "abcdefghijklmnop";

// A valid derived/expected extension ID: exactly 32 lowercase a-p characters.
const EXTENSION_ID_RE = /^[a-p]{32}$/;

// Loose base64 shape check up front so obviously-corrupt input (stray
// whitespace aside) fails with a clear message instead of Node's base64
// decoder silently dropping invalid characters and hashing the wrong bytes.
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * Decode a manifest `key` (base64 SPKI-DER public key) into its raw DER
 * bytes, validating both the base64 encoding and that the bytes actually
 * parse as an SPKI public key. This is what distinguishes "corrupt key"
 * from every other install failure.
 *
 * @param {string} base64Key
 * @returns {Buffer} the DER-encoded SubjectPublicKeyInfo bytes
 */
export function decodePublicKeyDer(base64Key) {
  if (typeof base64Key !== "string") {
    throw new Error("manifest key must be a string");
  }
  const trimmed = base64Key.trim().replace(/\s+/g, "");
  if (!trimmed) {
    throw new Error("manifest key is empty");
  }
  if (!BASE64_RE.test(trimmed)) {
    throw new Error("manifest key is not valid base64 (unexpected characters)");
  }

  let der;
  try {
    der = Buffer.from(trimmed, "base64");
  } catch (err) {
    throw new Error(`manifest key failed to base64-decode: ${err.message}`);
  }
  if (der.length === 0) {
    throw new Error("manifest key decoded to zero bytes");
  }
  // Round-trip: Node's base64 decoder ignores some malformed input rather
  // than throwing. Re-encoding and comparing (padding-insensitive) catches
  // that silent truncation/corruption instead of hashing garbage bytes.
  const roundTrip = der.toString("base64").replace(/=+$/, "");
  const original = trimmed.replace(/=+$/, "");
  if (roundTrip !== original) {
    throw new Error("manifest key is corrupt (base64 does not round-trip)");
  }

  // Confirm the bytes actually are an SPKI-encoded public key. This is the
  // same structural check Chrome itself performs, and it is what catches a
  // key that is well-formed base64 but not a real public key.
  try {
    crypto.createPublicKey({ key: der, format: "der", type: "spki" });
  } catch (err) {
    throw new Error(`manifest key is not a valid SPKI public key: ${err.message}`);
  }
  return der;
}

/**
 * Derive the Chromium extension ID for a base64 manifest `key`.
 *
 * @param {string} base64Key
 * @returns {string} 32-character extension ID (letters a-p)
 */
export function deriveExtensionId(base64Key) {
  const der = decodePublicKeyDer(base64Key);
  const hash = crypto.createHash("sha256").update(der).digest();
  const first16 = hash.subarray(0, 16); // first 128 bits
  let id = "";
  for (const byte of first16) {
    id += NIBBLE_TO_LETTER[byte >> 4];
    id += NIBBLE_TO_LETTER[byte & 0x0f];
  }
  return id;
}

/**
 * @param {unknown} id
 * @returns {boolean} true iff `id` has the shape of a Chromium extension ID.
 */
export function isValidExtensionId(id) {
  return typeof id === "string" && EXTENSION_ID_RE.test(id);
}

/**
 * Compare a derived ID against an expected/browser-reported ID, returning a
 * structured result rather than throwing, so callers (installer diagnostics,
 * tests) can distinguish "corrupt key", "malformed expected id", and
 * "legitimate mismatch" from each other.
 *
 * @param {string} base64Key
 * @param {string} expectedId
 * @param {{label?: string}} [opts]
 */
export function verifyExtensionId(base64Key, expectedId, opts = {}) {
  const label = opts.label || "the reported id";
  let derived;
  try {
    derived = deriveExtensionId(base64Key);
  } catch (err) {
    return { ok: false, derived: null, expected: expectedId, reason: `manifest key invalid: ${err.message}` };
  }
  const expected = String(expectedId ?? "").trim().toLowerCase();
  if (!isValidExtensionId(expected)) {
    return {
      ok: false,
      derived,
      expected,
      reason: `${label} ("${expectedId}") is not a well-formed 32-character extension id`
    };
  }
  if (derived !== expected) {
    return {
      ok: false,
      derived,
      expected,
      reason: `id mismatch: the manifest key derives to ${derived}, but ${label} is ${expected}`
    };
  }
  return { ok: true, derived, expected };
}

/**
 * Read `key` out of an extension manifest.json, with diagnostics that
 * distinguish "file missing", "not JSON", and "no key field" — the installer
 * needs to tell those apart rather than reporting one generic failure.
 *
 * @param {string} manifestPath
 * @returns {string} the base64 manifest key
 */
export function loadManifestKey(manifestPath) {
  let raw;
  try {
    raw = fs.readFileSync(manifestPath, "utf-8");
  } catch (err) {
    if (err.code === "ENOENT") {
      throw new Error(`manifest not found at ${manifestPath}`);
    }
    throw new Error(`could not read manifest at ${manifestPath}: ${err.message}`);
  }
  // Strip a leading UTF-8 BOM. Windows tools (PowerShell `Set-Content
  // -Encoding utf8`, Notepad, etc.) commonly save UTF-8 text WITH a BOM;
  // Node decodes it as a literal U+FEFF character rather than stripping it,
  // which makes JSON.parse fail on an otherwise perfectly valid manifest.
  if (raw.charCodeAt(0) === 0xfeff) {
    raw = raw.slice(1);
  }
  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch (err) {
    throw new Error(`manifest at ${manifestPath} is not valid JSON: ${err.message}`);
  }
  if (!manifest || typeof manifest.key !== "string" || !manifest.key.trim()) {
    throw new Error(
      `manifest at ${manifestPath} has no "key" field — this build cannot get a stable extension id ` +
        `until a persistent public key is added (see host/agent/generate-key.js)`
    );
  }
  return manifest.key;
}

/**
 * Convenience: read a manifest.json and derive its extension ID in one call.
 *
 * @param {string} manifestPath
 * @returns {string}
 */
export function deriveIdFromManifest(manifestPath) {
  return deriveExtensionId(loadManifestKey(manifestPath));
}

// --- CLI -------------------------------------------------------------------
//
// install.sh / install.ps1 shell out to this file instead of re-implementing
// SHA-256 + base64 extension-ID derivation in shell/PowerShell:
//
//   node host/agent/identity.js derive <manifest.json>
//   node host/agent/identity.js verify <manifest.json> <expected-id>
//
// `derive` prints only the bare ID to stdout on success (nothing else — safe
// to capture directly into a shell variable) and exits 0; on failure it
// prints a diagnostic to stderr and exits 1. `verify` exits 0 on match, 1 on
// mismatch/invalid input, printing the structured reason to stderr.

function runCli(argv) {
  const [cmd, manifestPath, expectedId] = argv;
  try {
    if (cmd === "derive") {
      if (!manifestPath) throw new Error("usage: identity.js derive <manifest.json>");
      process.stdout.write(deriveIdFromManifest(manifestPath) + "\n");
      return 0;
    }
    if (cmd === "verify") {
      if (!manifestPath || !expectedId) {
        throw new Error("usage: identity.js verify <manifest.json> <expected-id>");
      }
      const key = loadManifestKey(manifestPath);
      const result = verifyExtensionId(key, expectedId, { label: "the browser-reported id" });
      if (!result.ok) {
        process.stderr.write(result.reason + "\n");
        return 1;
      }
      process.stdout.write(result.derived + "\n");
      return 0;
    }
    throw new Error(`usage: identity.js <derive|verify> <manifest.json> [expected-id]`);
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    return 1;
  }
}

// Only run the CLI when this file is executed directly (not when imported by
// the test suite or other host code). pathToFileURL normalizes platform path
// separators/drive letters, so this is reliable on both POSIX and Windows.
const isMain = (() => {
  try {
    return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
})();

if (isMain) {
  process.exit(runCli(process.argv.slice(2)));
}
