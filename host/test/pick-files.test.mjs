#!/usr/bin/env node
//
// host/pick-files.js — the native file dialog behind the operator's upload
// grants. It is the ONLY source of upload paths in the product (a page's
// <input type=file> yields bytes, never a path), so both halves are pinned
// here: the per-platform command builders/parsers (pure) and runPickFiles'
// behaviour against a fake spawn — paths, cancel, a missing picker binary,
// and the timeout that keeps a walked-away dialog from hanging forever.
//
// Run: node host/test/pick-files.test.mjs

import { buildPickFilesCommand, parsePickFilesOutput, runPickFiles } from "../pick-files.js";

const results = [];
async function test(name, fn) {
  try {
    await fn();
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
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${msg} — expected ${b}, got ${a}`);
}

console.log("\n== command builders ==");

await test("win32 opens a multiselect OpenFileDialog through PowerShell, prompt-safe", () => {
  const { command, args } = buildPickFilesCommand("win32", { prompt: "It's a test" });
  assertEq(command, "powershell.exe", "powershell is the dialog host");
  assert(args.includes("-NoProfile"), "no profile output can corrupt the JSON stream");
  assert(args.includes("-STA"), "System.Windows.Forms needs a single-threaded apartment");
  const script = args[args.length - 1];
  assert(/System\.Windows\.Forms\.OpenFileDialog/.test(script), "uses the real WinForms dialog");
  assert(/\$d\.Multiselect = \$true/.test(script), "multi-select is on");
  assert(script.includes("'It''s a test'"), `a quote in the prompt is PowerShell-escaped: ${script}`);
  assert(/ConvertTo-Json/.test(script), "output is JSON so paths with spaces/newlines survive");
});

await test("darwin uses osascript's own chooser and prints POSIX paths", () => {
  const { command, args } = buildPickFilesCommand("darwin", { prompt: 'Say "hi"' });
  assertEq(command, "osascript", "osascript is the dialog host");
  const joined = args.join("\n");
  assert(/choose file with prompt/.test(joined), "uses the native chooser");
  assert(/multiple selections allowed/.test(joined), "multi-select is on");
  assert(/POSIX path/.test(joined), "returns POSIX paths, not HFS paths");
  assert(joined.includes('\\"hi\\"'), `a quote in the prompt is AppleScript-escaped: ${joined}`);
});

await test("linux tries zenity, then kdialog, through a POSIX shell", () => {
  const { command, args } = buildPickFilesCommand("linux");
  assertEq(command, "sh", "plain sh so the branch also works where bash is absent");
  assertEq(args[0], "-c", "one shell command string");
  const script = args[1];
  assert(/zenity --file-selection --multiple/.test(script), "zenity is the first choice");
  assert(/kdialog --getopenfilename --multiple --separate-output/.test(script), "kdialog is the fallback");
  assert(/zenity[\s\S]*\|\|[\s\S]*kdialog/.test(script), "kdialog only runs when zenity is missing or cancels silently");
});

console.log("\n== output parsing ==");

await test("win32: an array of paths is a selection; a bare string is a single-selection", () => {
  assertEq(parsePickFilesOutput("win32", { code: 0, stdout: '["C:\\\\a b.txt","D:\\\\c.pdf"]' }).paths, [
    "C:\\a b.txt",
    "D:\\c.pdf"
  ], "array form");
  assertEq(parsePickFilesOutput("win32", { code: 0, stdout: '"C:\\\\only.txt"' }).paths, ["C:\\only.txt"], "single-selection form");
});

await test("win32: '[]', empty output, and garbage all read as a cancel — never as paths", () => {
  for (const stdout of ["[]", "", "   ", "not json at all", "null"]) {
    const out = parsePickFilesOutput("win32", { code: 0, stdout });
    assert(out.cancelled === true && out.paths.length === 0, `stdout ${JSON.stringify(stdout)} must be a cancel`);
  }
});

await test("darwin/linux: a non-zero exit is a cancel; otherwise one path per line", () => {
  assert(parsePickFilesOutput("darwin", { code: 1, stdout: "" }).cancelled === true, "osascript's cancel exit code");
  const multi = parsePickFilesOutput("linux", { code: 0, stdout: "/home/me/a.txt\n/home/me/b.txt\n" });
  assertEq(multi.paths, ["/home/me/a.txt", "/home/me/b.txt"], "line-separated paths");
  const bars = parsePickFilesOutput("linux", { code: 0, stdout: "/home/me/a.txt|/home/me/b.txt" });
  assertEq(bars.paths, ["/home/me/a.txt", "/home/me/b.txt"], "a bar separator (some zenity builds) also parses");
});

console.log("\n== runPickFiles (fake spawn) ==");

function fakeChild({ stdout = "", stderr = "", code = 0, neverClose = false, errorEvent = null } = {}) {
  const listeners = { error: [], close: [] };
  const child = {
    killed: false,
    stdout: { on: (_ev, fn) => fn(stdout) },
    stderr: { on: (_ev, fn) => fn(stderr) },
    on: (ev, fn) => {
      (listeners[ev] = listeners[ev] || []).push(fn);
    },
    kill: () => {
      child.killed = true;
    },
    _emit: (ev, arg) => (listeners[ev] || []).forEach((fn) => fn(arg))
  };
  setImmediate(() => {
    if (errorEvent) child._emit("error", errorEvent);
    else if (!neverClose) child._emit("close", code);
  });
  return child;
}

await test("a selection resolves with its paths; a cancel resolves as cancelled (not an error)", async () => {
  const picked = await runPickFiles({
    platform: "win32",
    spawn: () => fakeChild({ stdout: '["C:\\\\Users\\\\me\\\\report.pdf"]' })
  });
  assertEq(picked, { cancelled: false, paths: ["C:\\Users\\me\\report.pdf"] }, "the picked path comes back");

  const cancelled = await runPickFiles({ platform: "darwin", spawn: () => fakeChild({ code: 1, stderr: "User canceled." }) });
  assertEq(cancelled, { cancelled: true, paths: [] }, "a cancel is a normal outcome");
});

await test("a picker that cannot start rejects (never silently 'cancelled')", async () => {
  let rejected = null;
  try {
    await runPickFiles({ platform: "linux", spawn: () => fakeChild({ errorEvent: new Error("spawn ENOENT") }) });
  } catch (e) {
    rejected = e;
  }
  assert(rejected && /ENOENT/.test(rejected.message), `a missing picker binary must be an error, got ${rejected && rejected.message}`);
});

await test("a dialog nobody closes is killed and rejects at the deadline", async () => {
  let rejected = null;
  const child = fakeChild({ neverClose: true });
  try {
    await runPickFiles({ platform: "win32", spawn: () => child, timeoutMs: 30 });
  } catch (e) {
    rejected = e;
  }
  assert(rejected && /timed out/.test(rejected.message), `expected a timeout rejection, got ${rejected && rejected.message}`);
  assert(child.killed === true, "and the dialog process was actually killed, not left running");
});

const failed = results.filter((r) => !r.ok);
console.log(
  `\n${results.length - failed.length}/${results.length} passed` +
    (failed.length ? `\n\nFailures:\n${failed.map((f) => `  - ${f.name}: ${f.err}`).join("\n")}` : "") +
    "\n"
);
process.exit(failed.length ? 1 : 0);
