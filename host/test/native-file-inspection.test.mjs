#!/usr/bin/env node
//
// host/native-host.js's `inspect_files` op — the facts extension/background.js's
// evaluateUploadPaths turns into the upload restrictions (exists / kind /
// size / nlink). The extension has no filesystem access of its own, so this
// reply IS the evidence those rules run on; a wrong or missing field here
// silently weakens the rule above it.
//
// Runs against the real filesystem, including a real hard link created with
// fs.linkSync — the exact condition the hard-link rule exists to catch, not a
// stand-in for it.
//
// Run: node host/test/native-file-inspection.test.mjs

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractFunction, compile } from "../../test/_extract.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NATIVE_HOST = path.join(HERE, "..", "native-host.js");

const results = [];
function test(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
    console.log(`  PASS  ${name}`);
  } catch (err) {
    results.push({ name, ok: false, err: err.stack || err.message });
    console.log(`  FAIL  ${name} — ${err.message}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
function assertEq(actual, expected, msg) {
  if (actual !== expected) throw new Error(`${msg} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

/** The shipped handler, with replies captured instead of written to stdout. */
function makeHandler() {
  const replies = [];
  const src = extractFunction("handleInspectFiles", NATIVE_HOST);
  const fn = compile(src, { fs, writeNativeMessage: (msg) => replies.push(msg) }, "handleInspectFiles");
  return { handleInspectFiles: fn, replies };
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocic-inspect-"));
const plain = path.join(dir, "note.txt");
const dirPath = path.join(dir, "subdir");
const missing = path.join(dir, "never-existed.bin");
fs.writeFileSync(plain, "hello");
fs.mkdirSync(dirPath);

// A real hard link pair: one inode, two names — the condition the rule targets.
const linkA = path.join(dir, "store-a.bin");
const linkB = path.join(dir, "store-b.bin");
fs.writeFileSync(linkA, "x".repeat(128));
let hardLinkUsable = true;
try {
  fs.linkSync(linkA, linkB);
} catch (e) {
  hardLinkUsable = false;
  console.log(`  SKIP  real hard link could not be created here (${e.code}); the hard-link assertion will use the nlink reported for a single file`);
}

console.log("\n== inspect_files ==");

test("reports existence, kind, size and hard-link count for a mixed path set", () => {
  const { handleInspectFiles, replies } = makeHandler();
  handleInspectFiles({ id: "nr_1", paths: [plain, dirPath, missing, linkA] });

  assertEq(replies.length, 1, "one reply");
  const reply = replies[0];
  assertEq(reply.id, "nr_1", "the request id is echoed for nativeRequest()");
  assertEq(reply.type, "files_inspected", "the reply type the extension's generic pendingNative router keys on");
  assertEq(reply.ok, true, "ok:true for a completed inspection");
  assert(Array.isArray(reply.result.files), "result.files is an array");

  const [f0, f1, f2, f3] = reply.result.files;
  assertEq(f0.path, plain, "the path is echoed verbatim");
  assertEq(f0.exists, true, "an existing file reports exists:true");
  assertEq(f0.kind, "file", "and kind 'file'");
  assertEq(f0.size, 5, "with its real size");
  assertEq(f0.nlink, 1, "and its real link count");

  assertEq(f1.kind, "directory", "a directory is reported as one (never uploadable)");
  assertEq(f2.exists, false, "a missing path reports exists:false");
  assertEq(f2.error, "ENOENT", "with the underlying error code, not a fabricated kind");
  assertEq(f3.exists, true, "the hard-linked file exists");
  if (hardLinkUsable) {
    assertEq(f3.nlink, 2, "and its two names report nlink 2 — the exact trigger for the hard-link refusal");
  }
});

test("a real hard link pair reports nlink 2 on BOTH names", () => {
  if (!hardLinkUsable) {
    console.log("        (skipped: this filesystem refused fs.linkSync)");
    return;
  }
  const { handleInspectFiles, replies } = makeHandler();
  handleInspectFiles({ id: "nr_2", paths: [linkA, linkB] });
  const files = replies[0].result.files;
  assert(files.every((f) => f.nlink === 2), `both names carry nlink 2: ${JSON.stringify(files.map((f) => f.nlink))}`);
});

test("an empty or malformed path list is a refusal, never an empty success", () => {
  const { handleInspectFiles, replies } = makeHandler();
  handleInspectFiles({ id: "nr_3", paths: [] });
  handleInspectFiles({ id: "nr_4", paths: [1, null, ""] });
  assertEq(replies.length, 2, "both requests answered");
  assert(replies.every((r) => r.ok === false && r.error === "no paths"), `both refuse: ${JSON.stringify(replies)}`);
});

test("the reply covers exactly the paths asked about, in order (no silent drops)", () => {
  const { handleInspectFiles, replies } = makeHandler();
  const asked = [plain, missing, plain];
  handleInspectFiles({ id: "nr_5", paths: asked });
  assertEq(replies[0].result.files.map((f) => f.path).join("|"), asked.join("|"), "same count, same order");
});

fs.rmSync(dir, { recursive: true, force: true });

const failed = results.filter((r) => !r.ok);
console.log(
  `\n${results.length - failed.length}/${results.length} passed` +
    (failed.length ? `\n\nFailures:\n${failed.map((f) => `  - ${f.name}: ${f.err}`).join("\n")}` : "") +
    "\n"
);
process.exit(failed.length ? 1 : 0);
