#!/usr/bin/env node
//
// The upload tool's three documented restrictions, enforced at the tool's
// only executor instead of merely stated in its description:
//   1. every path must be a real file that exists on this machine,
//   2. no file may carry more than one hard link,
//   3. the combined size stays under the 10 MB ceiling.
//
// Both pieces under test are the SHIPPED ones, extracted from
// extension/background.js: evaluateUploadPaths (the rule evaluation) and
// file_upload (the handler that calls it before anything reaches CDP).
//
// Run: node test/file-upload-restrictions.test.mjs

import { extractFunction, extractMethod, compile } from "./_extract.mjs";

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
  if (actual !== expected) throw new Error(`${msg} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const MB = 1024 * 1024;

/**
 * Build the shipped file_upload handler with a scripted native host.
 * `respond` decides what the host's inspect_files op answers with (or throws).
 */
function makeHarness(respond) {
  const calls = { native: [], content: [], cdp: [], attached: 0, domain: 0 };

  const src = [
    extractFunction("evaluateUploadPaths"),
    `const H = { ${extractMethod("file_upload")} };`
  ].join("\n\n");

  const W = compile(
    src,
    {
      UPLOAD_MAX_TOTAL_BYTES: 10 * MB,
      record: calls,
      nativeRequest: async (msg) => {
        calls.native.push(msg);
        return respond(msg);
      },
      isInGroup: async () => true,
      ensureAttached: async () => {
        calls.attached++;
      },
      ensureDomain: async () => {
        calls.domain++;
      },
      sendContentMessage: async (tabId, msg) => {
        calls.content.push(msg);
        if (msg.type === "markElementForUpload") return { ok: true, isFileInput: true, tag: "input" };
        return { ok: true };
      },
      cdp: async (tabId, method, params) => {
        calls.cdp.push({ method, params });
        if (method === "DOM.getDocument") return { root: { nodeId: 1 } };
        if (method === "DOM.querySelector") return { nodeId: 42 };
        return {};
      }
    },
    "{ H, record }"
  );

  return { file_upload: W.H.file_upload, calls: W.record };
}

const okFile = (path, extra = {}) => ({ path, exists: true, kind: "file", size: 1024, nlink: 1, ...extra });

console.log("\n== refusals: nothing reaches the page ==");

await test("a hard-linked file is refused, and nothing is marked or dispatched", async () => {
  const h = makeHarness(() => ({ files: [okFile("/store/pkg/index.js", { nlink: 2 })] }));
  const res = await h.file_upload({ tabId: 7, paths: ["/store/pkg/index.js"], ref: "ref_1" });
  const text = res.content[0].text;

  assert(/hard link/.test(text), `refusal explains the hard-link rule: ${text}`);
  assert(text.includes("/store/pkg/index.js"), "and names the file");
  assertEq(h.calls.content.length, 0, "no content-script message was sent");
  assertEq(h.calls.cdp.length, 0, "no CDP dispatch happened");
  assertEq(h.calls.attached, 0, "the tab was never even attached to");
});

await test("a combined size over 10 MB is refused", async () => {
  const h = makeHarness(() => ({ files: [okFile("/a.bin", { size: 6 * MB }), okFile("/b.bin", { size: 6 * MB })] }));
  const res = await h.file_upload({ tabId: 7, paths: ["/a.bin", "/b.bin"], ref: "ref_1" });
  const text = res.content[0].text;

  assert(/Refusing to upload 12 MB/.test(text), `refusal states the measured total: ${text}`);
  assert(/ceiling is 10 MB/.test(text), `and the ceiling: ${text}`);
  assertEq(h.calls.cdp.length, 0, "nothing was dispatched");
});

await test("exactly 10 MB is allowed (the ceiling is inclusive)", async () => {
  const h = makeHarness(() => ({ files: [okFile("/big.bin", { size: 10 * MB })] }));
  const res = await h.file_upload({ tabId: 7, paths: ["/big.bin"], ref: "ref_1" });
  assert(!/Refusing/.test(res.content[0].text), `no refusal at exactly the ceiling: ${res.content[0].text}`);
  assertEq(h.calls.cdp.filter((c) => c.method === "DOM.setFileInputFiles").length, 1, "and it was dispatched");
});

await test("a missing path is refused", async () => {
  const h = makeHarness(() => ({ files: [{ path: "/nope.txt", exists: false, error: "ENOENT" }] }));
  const res = await h.file_upload({ tabId: 7, paths: ["/nope.txt"], ref: "ref_1" });
  assert(/No such file: \/nope\.txt/.test(res.content[0].text), `refusal names the missing path: ${res.content[0].text}`);
  assertEq(h.calls.cdp.length, 0, "nothing was dispatched");
});

await test("a directory is refused", async () => {
  const h = makeHarness(() => ({ files: [{ path: "/some/dir", exists: true, kind: "directory", size: 4096, nlink: 1 }] }));
  const res = await h.file_upload({ tabId: 7, paths: ["/some/dir"], ref: "ref_1" });
  assert(/Only regular files/.test(res.content[0].text) && /directory/.test(res.content[0].text), `refusal says why: ${res.content[0].text}`);
  assertEq(h.calls.cdp.length, 0, "nothing was dispatched");
});

await test("a host that cannot answer fails CLOSED — nothing is uploaded", async () => {
  const h = makeHarness(() => {
    throw new Error("Native request timed out");
  });
  const res = await h.file_upload({ tabId: 7, paths: ["/a.txt"], ref: "ref_1" });
  assert(/Could not check the file before uploading/.test(res.content[0].text), `refusal is explicit: ${res.content[0].text}`);
  assertEq(h.calls.content.length, 0, "no mark/unmark cycle ran");
  assertEq(h.calls.cdp.length, 0, "and no CDP dispatch");
});

await test("a host answer that does not cover every path fails closed rather than partially uploading", async () => {
  const h = makeHarness(() => ({ files: [okFile("/a.txt")] }));
  const res = await h.file_upload({ tabId: 7, paths: ["/a.txt", "/b.txt"], ref: "ref_1" });
  assert(/returned no usable file information/.test(res.content[0].text), `refusal is explicit: ${res.content[0].text}`);
  assertEq(h.calls.cdp.length, 0, "nothing was dispatched");
});

console.log("\n== passing files upload exactly as before ==");

await test("clean files reach DOM.setFileInputFiles with the real paths", async () => {
  const paths = ["/docs/report.pdf", "/docs/data.csv"];
  const h = makeHarness(() => ({ files: paths.map((p) => okFile(p, { size: 2048 })) }));
  const res = await h.file_upload({ tabId: 7, paths, ref: "ref_9" });
  const text = res.content[0].text;

  const setCall = h.calls.cdp.find((c) => c.method === "DOM.setFileInputFiles");
  assert(setCall, "setFileInputFiles was dispatched");
  assertEq(setCall.params.files.join(","), paths.join(","), "with the caller's own paths, unchanged");
  assertEq(setCall.params.nodeId, 42, "against the node the marked element resolved to");
  assert(/Attached 2 files to the file input \(ref=ref_9\)/.test(text), `result reports the attach: ${text}`);
  assertEq(h.calls.native.length, 1, "exactly one inspect_files round trip");
  assertEq(h.calls.native[0].type, "inspect_files", "through the documented op");
  assert(h.calls.content.some((m) => m.type === "markElementForUpload"), "the ref was marked");
  assert(h.calls.content.some((m) => m.type === "unmarkElementForUpload"), "and unmarked afterwards");
});

const failed = results.filter((r) => !r.ok);
console.log(
  `\n${results.length - failed.length}/${results.length} passed` +
    (failed.length ? `\n\nFailures:\n${failed.map((f) => `  - ${f.name}: ${f.err}`).join("\n")}` : "") +
    "\n"
);
process.exit(failed.length ? 1 : 0);
