#!/usr/bin/env node
//
// Atomic, crash-safe JSON file storage (host/agent/settings/atomic-store.js).
//
// The core claim under test: a process that dies between "temp file
// written" and "rename onto the real path" must leave the LAST GOOD file
// completely intact — never truncated, never partially overwritten.
//
// Run: node host/test/settings-atomic-store.test.mjs

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeJsonAtomic, readJsonAtomic, cleanupStaleTempFiles } from "../agent/settings/atomic-store.js";

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

function scratchDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ocic-atomic-store-test-"));
}

console.log("\nAtomic profile storage\n");

check("writes and reads back a JSON value", () => {
  const dir = scratchDir();
  const file = path.join(dir, "profile.json");
  writeJsonAtomic(file, { a: 1, b: [1, 2, 3] });
  const read = readJsonAtomic(file);
  assert(read.a === 1 && read.b.length === 3);
});

check("readJsonAtomic returns null for a file that does not exist yet", () => {
  const dir = scratchDir();
  const file = path.join(dir, "does-not-exist.json");
  assert(readJsonAtomic(file) === null);
});

check("a simulated crash after the temp write, before rename, leaves the last good file fully intact", () => {
  const dir = scratchDir();
  const file = path.join(dir, "profile.json");

  writeJsonAtomic(file, { revision: 1, note: "last good" });
  assert(readJsonAtomic(file).revision === 1);

  let crashed = false;
  try {
    writeJsonAtomic(file, { revision: 2, note: "should never be committed" }, { crashAfterWrite: true });
  } catch {
    crashed = true;
  }
  assert(crashed, "expected the simulated crash to throw");

  // The file on disk must be byte-for-byte the last good write — not
  // truncated, not partially the new content, not missing.
  const afterCrash = readJsonAtomic(file);
  assert(afterCrash.revision === 1, `expected the pre-crash revision to survive, got ${JSON.stringify(afterCrash)}`);
  assert(afterCrash.note === "last good");
});

check("a leftover temp file from a simulated crash never gets read as the real profile", () => {
  const dir = scratchDir();
  const file = path.join(dir, "profile.json");
  writeJsonAtomic(file, { revision: 1 });

  try {
    writeJsonAtomic(file, { revision: 2 }, { crashAfterWrite: true });
  } catch {}

  // A stray .profile.json.<pid>.<rand>.tmp now sits next to profile.json.
  const entries = fs.readdirSync(dir);
  const tempFiles = entries.filter((e) => e.includes(".tmp"));
  assert(tempFiles.length === 1, `expected exactly one leftover temp file, found ${tempFiles.length}: ${entries.join(",")}`);

  // Reading the real path must still return the last good committed value.
  assert(readJsonAtomic(file).revision === 1);
});

check("cleanupStaleTempFiles removes leftover temp files without touching the committed file", () => {
  const dir = scratchDir();
  const file = path.join(dir, "profile.json");
  writeJsonAtomic(file, { revision: 1 });
  try {
    writeJsonAtomic(file, { revision: 2 }, { crashAfterWrite: true });
  } catch {}

  assert(fs.readdirSync(dir).some((e) => e.includes(".tmp")), "expected a leftover temp file before cleanup");
  cleanupStaleTempFiles(file);
  assert(!fs.readdirSync(dir).some((e) => e.includes(".tmp")), "expected the temp file to be removed");
  assert(readJsonAtomic(file).revision === 1, "the committed file must be untouched by cleanup");
});

check("a real successful write replaces the previous content completely (no merge/partial overwrite)", () => {
  const dir = scratchDir();
  const file = path.join(dir, "profile.json");
  writeJsonAtomic(file, { a: 1, big: "x".repeat(5000) });
  writeJsonAtomic(file, { b: 2 }); // much smaller — would leave trailing garbage if not truly atomic-replace
  const read = readJsonAtomic(file);
  assert(read.a === undefined, "old field must not survive a full replace");
  assert(read.b === 2);
});

check("readJsonAtomic throws on a genuinely corrupt COMMITTED file (not a temp-file artifact)", () => {
  const dir = scratchDir();
  const file = path.join(dir, "profile.json");
  fs.writeFileSync(file, "{ this is not valid json");
  let threw = false;
  try {
    readJsonAtomic(file);
  } catch {
    threw = true;
  }
  assert(threw, "a corrupt committed file must be surfaced, not silently ignored");
});

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed\n`);
if (failed.length > 0) process.exitCode = 1;
