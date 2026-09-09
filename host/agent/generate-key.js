// One-time RSA keypair generation for the persistent extension identity
// (spec: openspec/changes/migrate-to-claude-agent-sdk/specs/stable-extension-installation/spec.md,
// "Persistent extension identity").
//
// The project ships ONE public key across releases so the derived extension
// ID never changes on reload/restart/relocation. This script generates that
// keypair once: the private key never leaves disk (already gitignored as
// extension.pem, matching the existing `.gitignore` convention for signing
// material) and only the base64 SPKI public key goes into
// extension/manifest.json's "key" field.
//
// Usage:
//   node host/agent/generate-key.js                  print the public key + derived id
//   node host/agent/generate-key.js --write-manifest  also write extension/manifest.json's "key"
//   node host/agent/generate-key.js --force           regenerate even if a private key already exists
//                                                      (this CHANGES the extension id — only pass this
//                                                      deliberately, e.g. rotating a compromised key)
//
// Idempotent by default: rerunning without --force reuses the existing
// extension.pem and simply reprints its public key/id instead of minting a
// new (and therefore ID-breaking) keypair.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

import { deriveExtensionId } from "./identity.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");
const DEFAULT_PRIVATE_KEY_PATH = path.join(REPO_ROOT, "extension.pem");
const DEFAULT_MANIFEST_PATH = path.join(REPO_ROOT, "extension", "manifest.json");

/**
 * Generate (or reuse) the persistent RSA keypair and return its base64 SPKI
 * public key plus derived extension id.
 *
 * @param {{privateKeyPath?: string, force?: boolean}} [opts]
 */
export function ensureExtensionKey(opts = {}) {
  const privateKeyPath = opts.privateKeyPath || DEFAULT_PRIVATE_KEY_PATH;
  const force = Boolean(opts.force);

  let privateKeyPem;
  let generated = false;
  if (!force && fs.existsSync(privateKeyPath)) {
    privateKeyPem = fs.readFileSync(privateKeyPath, "utf-8");
  } else {
    const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" }
    });
    privateKeyPem = privateKey;
    fs.writeFileSync(privateKeyPath, privateKey, { mode: 0o600 });
    generated = true;
    // publicKey is unused beyond generation confirmation; the public key
    // used everywhere else below is re-derived from the private key so
    // ensureExtensionKey has one source of truth on both the fresh-generate
    // and reuse-existing-file paths.
    void publicKey;
  }

  const keyObject = crypto.createPrivateKey(privateKeyPem);
  const publicKeyDer = crypto.createPublicKey(keyObject).export({ type: "spki", format: "der" });
  const base64Key = publicKeyDer.toString("base64");
  const extensionId = deriveExtensionId(base64Key);

  return { privateKeyPath, base64Key, extensionId, generated };
}

/**
 * Write the public key into an extension manifest.json's "key" field,
 * leaving every other field untouched.
 *
 * @param {string} manifestPath
 * @param {string} base64Key
 */
export function writeManifestKey(manifestPath, base64Key) {
  const raw = fs.readFileSync(manifestPath, "utf-8");
  const manifest = JSON.parse(raw);
  manifest.key = base64Key;
  // Re-serialize with 2-space indent + trailing newline, matching the
  // existing manifest.json formatting.
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
}

function runCli(argv) {
  const force = argv.includes("--force");
  const writeManifest = argv.includes("--write-manifest");

  const { privateKeyPath, base64Key, extensionId, generated } = ensureExtensionKey({ force });

  console.log(generated ? `Generated new private key: ${privateKeyPath}` : `Reused existing private key: ${privateKeyPath}`);
  console.log(`(private key is gitignored — never commit it)`);
  console.log("");
  console.log("Public key (extension/manifest.json \"key\"):");
  console.log(base64Key);
  console.log("");
  console.log(`Derived extension id: ${extensionId}`);

  if (writeManifest) {
    writeManifestKey(DEFAULT_MANIFEST_PATH, base64Key);
    console.log("");
    console.log(`Wrote key into ${DEFAULT_MANIFEST_PATH}`);
  }
}

const isMain = (() => {
  try {
    return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
})();

if (isMain) {
  runCli(process.argv.slice(2));
}
