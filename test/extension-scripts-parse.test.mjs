#!/usr/bin/env node
//
// Every classic script the extension actually ships must PARSE.
//
// Why this exists: the rest of this suite tests content-script code through
// test/_extract.mjs, which pulls individual functions out of a file by
// brace-matching and compiles each one with `new Function`. That technique
// never parses the file as a whole, so a syntax error anywhere outside an
// extracted function is completely invisible to it.
//
// That is not hypothetical. `extension/overlay/element-picker.js` shipped
// with `aria-*/role` inside a block comment: the `*/` closed the comment
// early, the rest of the line became code, and the file could not be parsed
// at all — so `chrome.scripting.executeScript` failed on every page and the
// feature was dead everywhere. Its own three test files (roughly 900 lines)
// were green throughout, because every function they extracted was itself
// fine. Only loading the extension in a real browser surfaced it, as a
// generic "could not activate" message with the real cause swallowed by a
// bare catch.
//
// A parse check is the cheapest possible guard against that entire class,
// and it belongs in the automated suite rather than in a human's manual
// pass.
//
// The file list is DERIVED, never hand-maintained: manifest.json's declared
// content scripts and service worker, plus every `*_SCRIPT_FILES` array
// background.js injects with `chrome.scripting.executeScript`. A new
// injected script is therefore covered the moment it is added, with no edit
// here.
//
// Run: node test/extension-scripts-parse.test.mjs

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import vm from "node:vm";
import { spawnSync } from "node:child_process";
import { ROOT } from "./_extract.mjs";

const EXT = path.join(ROOT, "extension");

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

console.log("\nEvery shipped classic extension script parses\n");

/** Relative paths declared in manifest.json: content scripts + service worker.
 *  Content scripts are always classic scripts; the service worker is a module
 *  when the manifest says `"type": "module"`, and the two parse under
 *  different grammars — an `import` statement is a syntax error in one and
 *  required in the other, so the distinction is read from the manifest rather
 *  than guessed. */
function manifestScripts() {
  const manifest = JSON.parse(fs.readFileSync(path.join(EXT, "manifest.json"), "utf8"));
  const out = [];
  for (const entry of manifest.content_scripts || []) {
    for (const js of entry.js || []) out.push({ rel: js, module: false });
  }
  const bg = manifest.background || {};
  if (bg.service_worker) out.push({ rel: bg.service_worker, module: bg.type === "module" });
  return out;
}

/** Parse a module without running it: `node --check` on a copy carrying the
 *  .mjs extension, which forces the ESM grammar regardless of any
 *  package.json. `vm.Script` cannot do this — it only knows classic scripts,
 *  and `vm.SourceTextModule` needs a runtime flag this suite must not
 *  require. Nothing is executed either way. */
function assertParsesAsModule(source, rel) {
  const tmp = path.join(os.tmpdir(), `browzy-parse-${process.pid}-${path.basename(rel)}.mjs`);
  fs.writeFileSync(tmp, source, "utf8");
  try {
    const res = spawnSync(process.execPath, ["--check", tmp], { encoding: "utf8" });
    if (res.status !== 0) throw new Error((res.stderr || "").trim().split("\n").slice(0, 4).join("\n"));
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

/** Relative paths in background.js's `*_SCRIPT_FILES` injection arrays, so a
 *  newly injected script needs no edit here to be covered. */
function injectedScripts() {
  const src = fs.readFileSync(path.join(EXT, "background.js"), "utf8");
  const out = [];
  // Two shapes reach executeScript in this file, and both must be covered:
  // a named `*_SCRIPT_FILES` constant, and a `files: [...]` array written
  // inline at the call site (webmcp/relay-isolated.js is injected that way).
  // Missing either would leave a shipped script unparsed and this guard
  // quietly incomplete — the exact failure it exists to prevent.
  const arrayPatterns = [/const\s+\w*SCRIPT_FILES\s*=\s*\[([^\]]*)\]/g, /files\s*:\s*\[([^\]]*)\]/g];
  for (const arrayPattern of arrayPatterns) {
    let m;
    while ((m = arrayPattern.exec(src)) !== null) {
      const literal = /"([^"]+)"|'([^']+)'/g;
      let s;
      // Injected with chrome.scripting.executeScript, which only ever runs a
      // classic script — a module there is a load error, not a parse choice.
      while ((s = literal.exec(m[1])) !== null) {
        const rel = s[1] || s[2];
        if (rel.endsWith(".js")) out.push({ rel, module: false });
      }
    }
  }
  return out;
}

const declared = manifestScripts();
const injected = injectedScripts();
const byRel = new Map();
for (const entry of [...declared, ...injected]) {
  // A file reachable both ways is the stricter of the two: if anything
  // injects it as a classic script, it must parse as one.
  const prev = byRel.get(entry.rel);
  byRel.set(entry.rel, { rel: entry.rel, module: prev ? prev.module && entry.module : entry.module });
}
const all = [...byRel.values()].sort((a, b) => a.rel.localeCompare(b.rel));

test("the file list is derived from real sources, not empty", () => {
  assert(declared.length > 0, "manifest.json declared no content script or service worker — the deriver is broken");
  assert(injected.length > 0, "found no *_SCRIPT_FILES injection array in background.js — the deriver is broken");
  assert(
    injected.some((e) => e.rel === "overlay/element-picker.js"),
    `the picker must be among the injected scripts this guard covers; got: ${injected.map((e) => e.rel).join(", ")}`
  );
});

for (const entry of all) {
  test(`parses: ${entry.rel}${entry.module ? " (module)" : ""}`, () => {
    const abs = path.join(EXT, entry.rel);
    assert(fs.existsSync(abs), `declared/injected script does not exist on disk: ${entry.rel}`);
    const source = fs.readFileSync(abs, "utf8");
    if (entry.module) {
      assertParsesAsModule(source, entry.rel);
      return;
    }
    // Parse only — `new vm.Script` compiles without running, so no chrome.*
    // access, no DOM access and no side effect can happen here.
    new vm.Script(source, { filename: entry.rel });
  });
}

const failed = results.filter((r) => !r.ok);
console.log(
  `\n${results.length - failed.length}/${results.length} passed` +
    (failed.length ? `\n\nFailures:\n${failed.map((f) => `  - ${f.name}: ${f.err}`).join("\n")}` : "") +
    "\n"
);
process.exit(failed.length ? 1 : 0);
