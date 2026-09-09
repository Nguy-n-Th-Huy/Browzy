// Task 4.5 headline assertion #1: "no secret in storage, logs, exports or
// command lines" — the settings-page half of it (host-side storage/logs/
// command-line handling is already proven for real in
// host/test/secrets-redaction.test.mjs and reports/04-settings-evidence.md;
// this file proves the EXTENSION SIDE never persists, logs, or exports the
// raw key either).
//
// Run: node test/settings-ui-secrets.test.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SettingsController } from "../extension/settings/settings-controller.js";
import { createScriptedCompanion } from "./settings-ui-scripted-companion.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SETTINGS_DIR = path.join(__dirname, "..", "extension", "settings");

let fail = 0;
const ok = (c, m) => {
  console.log((c ? "  PASS " : "  FAIL ") + m);
  if (!c) fail++;
};

const SENTINEL = `sk-ant-SENTINEL-${Date.now()}-${Math.random().toString(36).slice(2)}`;

console.log("== static source grep: extension/settings/** never touches chrome.storage or localStorage ==");
{
  const files = fs.readdirSync(SETTINGS_DIR).filter((f) => f.endsWith(".js"));
  ok(files.length > 0, "settings source files found to scan");
  for (const file of files) {
    const text = fs.readFileSync(path.join(SETTINGS_DIR, file), "utf-8");
    ok(!/chrome\.storage/.test(text), `${file}: no chrome.storage.* reference (spec: never extension sync/local storage)`);
    ok(!/localStorage\.(set|get)Item/.test(text), `${file}: no localStorage persistence`);
    ok(!/indexedDB/.test(text), `${file}: no IndexedDB persistence`);
  }
}

console.log("== static source grep: no console logging call anywhere in the settings source (nothing to accidentally leak into) ==");
{
  const files = fs.readdirSync(SETTINGS_DIR).filter((f) => f.endsWith(".js"));
  for (const file of files) {
    const text = fs.readFileSync(path.join(SETTINGS_DIR, file), "utf-8");
    ok(!/console\.(log|debug|info|warn|error)\s*\(/.test(text), `${file}: no console.* call present at all`);
  }
}

console.log("== runtime: a real save+test+remove flow never exposes the sentinel key in any state snapshot ==");
{
  const companion = createScriptedCompanion(null);
  const c = new SettingsController(companion.client);
  const snapshots = [];
  c.onChange = (s) => snapshots.push(s);

  await c.init();
  c.addModel({ id: "m1", label: "M1" });
  // Unlike a controlled input, there is no per-keystroke controller call to
  // make here at all — settings-app.js reads the DOM value exactly once, at
  // Save time. That absence IS the guarantee this test proves: the only
  // controller entry point that ever sees the raw value is save()'s argument.
  await c.save(SENTINEL);
  await c.testConnection();
  await c.removeCredential();

  const serializedAll = snapshots.map((s) => JSON.stringify(s)).join("\n");
  ok(!serializedAll.includes(SENTINEL), "the full sentinel value never appears in ANY emitted state snapshot, at any point in the flow");
  ok(!serializedAll.includes(SENTINEL.slice(0, 10)), "no partial prefix of the sentinel leaks into a snapshot either");
}

console.log("== runtime: exportProfile() output never contains the sentinel ==");
{
  const companion = createScriptedCompanion(null);
  const c = new SettingsController(companion.client);
  await c.init();
  c.addModel({ id: "m1", label: "M1" });
  await c.save(SENTINEL);
  const exported = await c.exportProfile();
  ok(!JSON.stringify(exported).includes(SENTINEL), "exportProfile() output has no trace of the sentinel key");
}

console.log("== runtime: console output during the whole flow never contains the sentinel ==");
{
  const originalLog = console.log;
  const originalError = console.error;
  const originalWarn = console.warn;
  const captured = [];
  console.log = (...args) => captured.push(args.join(" "));
  console.error = (...args) => captured.push(args.join(" "));
  console.warn = (...args) => captured.push(args.join(" "));
  try {
    const companion = createScriptedCompanion(null);
    const c = new SettingsController(companion.client);
    await c.init();
    c.addModel({ id: "m1", label: "M1" });
    await c.save(SENTINEL);
    await c.removeCredential();
  } finally {
    console.log = originalLog;
    console.error = originalError;
    console.warn = originalWarn;
  }
  ok(!captured.join("\n").includes(SENTINEL), "nothing logged to console during the flow contains the sentinel key");
}

console.log("== private retry field is genuinely private: not enumerable via getState(), not own-JSON-serializable ==");
{
  const { ProviderErrorLike } = await import("../extension/settings/settings-client.js");
  const companion = createScriptedCompanion(null);
  companion.scripts.setCredential = () => { throw new ProviderErrorLike("SECURE_STORAGE_UNAVAILABLE", "unavailable"); };
  const c = new SettingsController(companion.client);
  await c.init();
  c.addModel({ id: "m1", label: "M1" });
  await c.save(SENTINEL); // triggers the SECURE_STORAGE_UNAVAILABLE path, which retains the secret in the private field
  ok(!JSON.stringify(c.getState()).includes(SENTINEL), "getState() excludes the pending-retry secret even while an offer is outstanding");
  ok(!JSON.stringify(c).includes(SENTINEL), "JSON.stringify(controller) itself (own enumerable props) never includes the retained secret");
  ok(!("pendingKeyInput" in c.getState()), "state carries no pendingKeyInput field at all -- nothing to leak by construction");
}

console.log(fail === 0 ? "\nALL SETTINGS-UI SECRET-ISOLATION TESTS PASSED" : `\n${fail} FAILED`);
process.exit(fail ? 1 : 0);
