#!/usr/bin/env node
// Task 5.6 (design.md 5b) — live extraction, staleness, and SPA document
// identity — against the REAL, SHIPPED source, extracted the same
// brace-matching way test/handlers.test.mjs and
// test/registry-borrowed-tab-scope.test.mjs already do (never a paraphrase).
//
// Covers:
//   - extension/background.js: get_page_text/read_page report an explicit
//     stale-context result for a closed tab (never retry on a different
//     tab), and an explicit restricted-page result for a browser-internal
//     URL, both BEFORE ever attempting real extraction; get_page_text's
//     enriched output (capture timestamp + completeness/truncation status).
//   - extension/content.js: SPA route changes (pushState/replaceState/
//     popstate) bump document identity and invalidate every outstanding
//     element ref; a same-URL pushState/replaceState call does not.
//   - host/agent/tools/mapping.js: the SDK-facing description for
//     get_page_text/read_page carries the live-extraction note, without
//     mutating the shared host/tool-definitions.js registry.
//
// Run: node test/registry-borrowed-tab-live-extraction.test.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractFunction, extractMethod, ROOT, BACKGROUND } from "./_extract.mjs";
import { sdkFacingDescription } from "../host/agent/tools/mapping.js";
import { TOOLS } from "../host/tool-definitions.js";

const CONTENT = path.join(ROOT, "extension", "content.js");

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  PASS  ${name}`);
  } catch (err) {
    results.push({ name, ok: false, err: err.message });
    console.log(`  FAIL  ${name} — ${err.stack || err.message}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

/** Grab a top-level `const NAME = <expr>;` literal (regex, in this case) out
 * of a source file by text search + balanced-paren/bracket-free single
 * statement scan up to the terminating `;` — narrow, but exactly what a
 * regex-literal constant needs, and reads the SHIPPED value rather than
 * hand-copying it (which would silently drift out of sync). */
function extractConstExpr(name, file) {
  const src = fs.readFileSync(file, "utf8");
  const marker = `const ${name} =`;
  const i = src.indexOf(marker);
  if (i === -1) throw new Error(`const ${name} not found in ${file}`);
  const end = src.indexOf(";", i);
  if (end === -1) throw new Error(`unterminated const ${name} in ${file}`);
  const exprSrc = src.slice(i + marker.length, end).trim();
  // eslint-disable-next-line no-new-func
  return new Function(`return (${exprSrc});`)();
}

// --- background.js: stale-context / restricted-page checks ----------------

function buildBackgroundHarness({ tabs = new Map(), contentResponses = new Map(), throwOnSendMessage = new Set() } = {}) {
  const calls = [];
  const RESTRICTED_URL_PATTERN = extractConstExpr("RESTRICTED_URL_PATTERN", BACKGROUND);
  const src = [
    extractFunction("checkTabReadableForExtraction"),
    extractFunction("sendContentMessage"),
    `const H_read_page = { ${extractMethod("read_page")} };`,
    `const H_get_page_text = { ${extractMethod("get_page_text")} };`
  ].join("\n\n");

  const chrome = {
    tabs: {
      get: async (id) => {
        calls.push({ name: "tabs.get", arg: id });
        const t = tabs.get(id);
        if (!t) throw new Error("no such tab");
        return t;
      },
      sendMessage: async (id, msg) => {
        calls.push({ name: "tabs.sendMessage", arg: { id, msg } });
        if (throwOnSendMessage.has(id)) throw new Error("Could not establish connection");
        return contentResponses.get(id) ?? null;
      }
    },
    scripting: {
      executeScript: async (opts) => {
        calls.push({ name: "scripting.executeScript", arg: opts });
      }
    }
  };

  // isInGroup: this suite is about live-extraction/staleness, not scope —
  // group/scope enforcement itself is already covered exhaustively by
  // test/registry-borrowed-tab-scope.test.mjs and test/registry-sdk-mapping.
  // test.mjs. Always-authorized here so those two are exercised in
  // isolation.
  const isInGroup = async () => true;
  // ensureAttached/cdp: read_page's viewport-append path — best-effort and
  // wrapped in its own try/catch in the shipped source, so failing here is
  // realistic and harmless to what this suite actually asserts.
  const ensureAttached = async () => {
    throw new Error("no real debugger in this harness");
  };
  const cdp = async () => null;

  const mk = new Function(
    "chrome",
    "isInGroup",
    "ensureAttached",
    "cdp",
    "RESTRICTED_URL_PATTERN",
    `${src}\nreturn { H_read_page, H_get_page_text };`
  );
  const H = mk(chrome, isInGroup, ensureAttached, cdp, RESTRICTED_URL_PATTERN);
  return { H, calls };
}

console.log("\nStale-context: a closed tab yields an explicit result, never a retry on a different tab\n");

await test("get_page_text on a closed tab reports stale-context, never attempts extraction", async () => {
  const { H, calls } = buildBackgroundHarness({ tabs: new Map() }); // tab 5 does not exist
  const result = await H.H_get_page_text.get_page_text({ tabId: 5 });
  assert(/Stale context/.test(result.content[0].text), `must explicitly say stale-context, got: ${result.content[0].text}`);
  assert(/5/.test(result.content[0].text), "must name the exact tab");
  assert(!calls.some((c) => c.name === "tabs.sendMessage"), "must never attempt content-script extraction against a closed tab");
});

await test("read_page on a closed tab reports stale-context, never attempts extraction", async () => {
  const { H, calls } = buildBackgroundHarness({ tabs: new Map() });
  const result = await H.H_read_page.read_page({ tabId: 5 });
  assert(/Stale context/.test(result.content[0].text), `must explicitly say stale-context, got: ${result.content[0].text}`);
  assert(!calls.some((c) => c.name === "tabs.sendMessage"), "must never attempt content-script extraction against a closed tab");
});

console.log("\nRestricted pages: a browser-internal URL is identified without ever reading it\n");

await test("get_page_text on a chrome:// tab reports restricted, never attempts extraction", async () => {
  const { H, calls } = buildBackgroundHarness({ tabs: new Map([[9, { id: 9, url: "chrome://extensions" }]]) });
  const result = await H.H_get_page_text.get_page_text({ tabId: 9 });
  assert(/Restricted page/.test(result.content[0].text), `must explicitly say restricted, got: ${result.content[0].text}`);
  assert(!calls.some((c) => c.name === "tabs.sendMessage"), "must never attempt content-script extraction against a restricted page");
});

await test("get_page_text on an ordinary https:// tab proceeds to real extraction", async () => {
  const { H, calls } = buildBackgroundHarness({
    tabs: new Map([[9, { id: 9, url: "https://example.com/a" }]]),
    contentResponses: new Map([[9, { result: JSON.stringify({ title: "T", url: "https://example.com/a", sourceTag: "article", text: "hello", truncated: false, capturedAt: "2026-09-06T00:00:00.000Z", documentEpoch: 0 }) }]])
  });
  const result = await H.H_get_page_text.get_page_text({ tabId: 9 });
  assert(calls.some((c) => c.name === "tabs.sendMessage"), "an ordinary page must reach real content-script extraction");
  assert(/Title: T/.test(result.content[0].text), `must return the real extracted title, got: ${result.content[0].text}`);
});

console.log("\nget_page_text reports capture timestamp and completeness/truncation status (design.md 5b)\n");

await test("a complete (non-truncated) capture reports 'Complete: yes' and the real capture timestamp", async () => {
  const { H } = buildBackgroundHarness({
    tabs: new Map([[1, { id: 1, url: "https://example.com/a" }]]),
    contentResponses: new Map([[1, { result: JSON.stringify({ title: "Article", url: "https://example.com/a", sourceTag: "article", text: "short body", truncated: false, capturedAt: "2026-09-06T12:00:00.000Z", documentEpoch: 0 }) }]])
  });
  const result = await H.H_get_page_text.get_page_text({ tabId: 1 });
  const text = result.content[0].text;
  assert(text.includes("Captured: 2026-09-06T12:00:00.000Z"), `must surface the real capture timestamp, got: ${text}`);
  assert(text.includes("Complete: yes"), `must report a complete capture as complete, got: ${text}`);
});

await test("a truncated capture reports 'Complete: no' — never silently presented as a complete reading", async () => {
  const { H } = buildBackgroundHarness({
    tabs: new Map([[1, { id: 1, url: "https://example.com/a" }]]),
    contentResponses: new Map([[1, { result: JSON.stringify({ title: "Long Article", url: "https://example.com/a", sourceTag: "article", text: "x".repeat(100000), truncated: true, capturedAt: "2026-09-06T12:00:00.000Z", documentEpoch: 0 }) }]])
  });
  const result = await H.H_get_page_text.get_page_text({ tabId: 1 });
  assert(result.content[0].text.includes("Complete: no"), "a truncated extraction must never be reported as complete");
});

console.log("\nSPA / document-identity tracking (extension/content.js) — real source, extracted\n");

function buildContentHarness() {
  const location = { href: "https://spa.example/a" };
  const history = {
    pushState(state, title, url) {
      if (url) location.href = String(url);
    },
    replaceState(state, title, url) {
      if (url) location.href = String(url);
    }
  };
  const listeners = {};
  const window_ = {
    addEventListener: (type, fn) => {
      (listeners[type] ||= []).push(fn);
    }
  };
  const elementMap = { ref_1: {}, ref_2: {} };

  const src = [
    "let documentEpoch = 0;",
    "let lastKnownUrl = location.href;",
    extractFunction("bumpDocumentEpoch", CONTENT),
    extractFunction("installSpaTracking", CONTENT),
    extractFunction("getPageText", CONTENT)
  ].join("\n\n");

  const factory = new Function(
    "elementMap",
    "history",
    "location",
    "window",
    "document",
    `${src}\ninstallSpaTracking();\nreturn { getPageText, getEpoch: () => documentEpoch };`
  );

  function fakeDocument({ title, bodyText }) {
    return {
      title,
      // No article/main/etc. match -> falls back to document.body. Plural
      // because getPageText ranks EVERY match of every selector by text length
      // rather than taking the first one it finds.
      querySelectorAll: () => [],
      body: {
        tagName: "BODY",
        cloneNode: () => ({ querySelectorAll: () => [], textContent: bodyText })
      }
    };
  }

  return { location, history, window_, listeners, elementMap, factory, fakeDocument };
}

await test("a pushState route change to a DIFFERENT url bumps document epoch and invalidates outstanding element refs", () => {
  const { location, history, window_, elementMap, factory, fakeDocument } = buildContentHarness();
  const H = factory(elementMap, history, location, window_, fakeDocument({ title: "A", bodyText: "a" }));
  assert(H.getEpoch() === 0, "starts at epoch 0");
  assert(Object.keys(elementMap).length === 2, "sanity: refs exist before the route change");
  history.pushState(null, "", "https://spa.example/b");
  assert(location.href === "https://spa.example/b", "pushState's own navigation behavior must still work (wrapping is additive)");
  assert(H.getEpoch() === 1, "a real route change must bump document epoch");
  assert(Object.keys(elementMap).length === 0, "every outstanding element ref must be invalidated on route change");
});

await test("pushState to the SAME url does not bump epoch", () => {
  const { location, history, window_, elementMap, factory, fakeDocument } = buildContentHarness();
  const H = factory(elementMap, history, location, window_, fakeDocument({ title: "A", bodyText: "a" }));
  history.pushState(null, "", location.href);
  assert(H.getEpoch() === 0, "no actual url change must not bump epoch");
  assert(Object.keys(elementMap).length === 2, "refs survive a no-op pushState");
});

await test("a popstate event reflecting a real url change bumps document epoch", () => {
  const { location, listeners, elementMap, factory, fakeDocument, history, window_ } = buildContentHarness();
  const H = factory(elementMap, history, location, window_, fakeDocument({ title: "A", bodyText: "a" }));
  location.href = "https://spa.example/back"; // the browser already navigated by the time popstate fires
  listeners.popstate.forEach((fn) => fn());
  assert(H.getEpoch() === 1, "popstate with a real url change must bump document epoch");
});

await test("getPageText() reports capturedAt/truncated/documentEpoch — additive fields alongside the existing title/url/sourceTag/text shape", () => {
  const { location, history, window_, elementMap, factory, fakeDocument } = buildContentHarness();
  const shortDoc = fakeDocument({ title: "Short", bodyText: "hello world" });
  const H = factory(elementMap, history, location, window_, shortDoc);
  const data = JSON.parse(H.getPageText());
  assert(data.title === "Short" && data.url === location.href, "existing fields must be unchanged");
  assert(data.truncated === false, "a short body must not be marked truncated");
  assert(typeof data.capturedAt === "string" && !Number.isNaN(Date.parse(data.capturedAt)), "capturedAt must be a real, parseable timestamp");
  assert(data.documentEpoch === 0, "documentEpoch reflects the current document identity");

  history.pushState(null, "", "https://spa.example/next");
  const data2 = JSON.parse(H.getPageText());
  assert(data2.documentEpoch === 1, "a later capture after a route change reports the NEW document epoch, tying the capture to its document identity");
});

await test("getPageText() marks a long body as truncated at exactly 30000 characters", () => {
  const { location, history, window_, elementMap, factory, fakeDocument } = buildContentHarness();
  const longDoc = fakeDocument({ title: "Long", bodyText: "x".repeat(50000) });
  const H = factory(elementMap, history, location, window_, longDoc);
  const data = JSON.parse(H.getPageText());
  assert(data.truncated === true, "a body over the cap must be marked truncated");
  assert(data.text.length === 30000, "the returned text must actually be capped at the documented limit");
});

console.log("\nSDK-facing description carries the live-extraction note (host/agent/tools/mapping.js), registry untouched\n");

await test("sdkFacingDescription() appends the live-extraction note to get_page_text and read_page only", () => {
  const getPageTextTool = TOOLS.find((t) => t.name === "get_page_text");
  const readPageTool = TOOLS.find((t) => t.name === "read_page");
  const navigateTool = TOOLS.find((t) => t.name === "navigate");
  assert(/capture timestamp/.test(sdkFacingDescription(getPageTextTool)), "get_page_text's SDK-facing description must mention capture timestamp");
  assert(/stale-context or restricted-page result means the page was NOT actually read/.test(sdkFacingDescription(readPageTool)), "read_page's SDK-facing description must warn that a stale/restricted result is not a real reading");
  assert(!/capture timestamp/.test(sdkFacingDescription(navigateTool)), "an unrelated tool's description must be untouched");
  assert(!/capture timestamp/.test(navigateTool.description) && !/capture timestamp/.test(getPageTextTool.description), "the SHARED host/tool-definitions.js registry itself must never be mutated");
});

const failed = results.filter((r) => !r.ok);
console.log(failed.length === 0 ? `\n${results.length}/${results.length} passed` : `\n${results.length - failed.length}/${results.length} passed, ${failed.length} FAILED`);
process.exit(failed.length ? 1 : 0);
