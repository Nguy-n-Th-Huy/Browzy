#!/usr/bin/env node
// Unit tests for host/agent/policy/mode-store.js: local permission-mode
// persistence through the project's existing atomic-write helper.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readLocalMode, writeLocalMode } from "../agent/policy/mode-store.js";

let fail = 0;
const ok = (c, m) => { console.log((c ? "  PASS " : "  FAIL ") + m); if (!c) fail++; };

const root = fs.mkdtempSync(path.join(os.tmpdir(), "browzy-mode-store-test-"));

console.log("== default ==");
{
  ok(readLocalMode(root) === "auto", "an unconfigured install reads back the default mode (auto)");
}

console.log("== write and read back ==");
{
  const written = writeLocalMode("manual", root);
  ok(written === "manual", "writeLocalMode returns the normalized mode it wrote");
  ok(readLocalMode(root) === "manual", "the written mode reads back");

  writeLocalMode("skip", root);
  ok(readLocalMode(root) === "skip", "a second write overwrites the first (single global setting)");
}

console.log("== atomic write ==");
{
  const file = path.join(root, "permissions", "mode.json");
  ok(fs.existsSync(file), "the mode file exists on disk at the documented path");
  const raw = fs.readFileSync(file, "utf8");
  const parsed = JSON.parse(raw);
  ok(parsed.mode === "skip", "the on-disk document is a plain {mode} object, matching a direct read");
  // No leftover temp file after a successful write (write-temp-then-rename).
  const leftovers = fs.readdirSync(path.dirname(file)).filter((n) => n.endsWith(".tmp"));
  ok(leftovers.length === 0, "no leftover .tmp sibling remains after a successful write");
}

console.log("== invalid input never brick the runtime ==");
{
  writeLocalMode("not-a-real-mode", root);
  ok(readLocalMode(root) === "auto", "writing an invalid mode normalizes to the default rather than persisting garbage");

  const file = path.join(root, "permissions", "mode.json");
  fs.writeFileSync(file, "not json{{{");
  ok(readLocalMode(root) === "auto", "a corrupt local file reads back as the default, never throws");

  fs.writeFileSync(file, JSON.stringify({ mode: "totally-invalid" }));
  ok(readLocalMode(root) === "auto", "a well-formed file with an out-of-range mode value reads back as the default");

  fs.writeFileSync(file, JSON.stringify(["not", "an", "object"]));
  ok(readLocalMode(root) === "auto", "a non-object JSON document reads back as the default");
}

console.log("== managed values are never written here ==");
{
  // This module has no notion of "managed" at all — sanity-check its
  // written shape never grows a second key a caller could mistake for one.
  writeLocalMode("manual", root);
  const parsed = JSON.parse(fs.readFileSync(path.join(root, "permissions", "mode.json"), "utf8"));
  ok(Object.keys(parsed).length === 1 && "mode" in parsed, "the persisted document carries only the local mode, nothing else");
}

fs.rmSync(root, { recursive: true, force: true });
console.log(fail === 0 ? "\nALL MODE STORE TESTS PASSED" : `\n${fail} FAILED`);
process.exit(fail ? 1 : 0);
