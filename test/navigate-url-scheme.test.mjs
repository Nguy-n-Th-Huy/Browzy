// Regression test for the navigate tool's URL scheme normalization.
//
// Bug (reproduced live in Brave): navigate("chrome-extension://<id>/sidepanel/
// sidepanel.html") produced "Navigated to https://chrome-extension//<id>/
// sidepanel/sidepanel.html" and the tab actually loaded that corrupted URL,
// which Chrome resolves to DNS_PROBE_POSSIBLE. Root cause: the normalization
// only recognized http(s) (plus a few literal chrome/brave/about prefixes)
// and blindly prepended "https://" to everything else, mangling any other
// scheme (chrome-extension:, file:, data:, blob:, view-source:, ...).
//
// This exercises the SHIPPED hasUrlScheme() helper and navigate() handler
// out of extension/background.js (via test/_extract.mjs's brace-matching
// extractor), not a paraphrase of the logic.

import fs from "node:fs";
import { extractFunction, extractMethod, BACKGROUND } from "./_extract.mjs";

let fail = 0;
const ok = (c, m) => { console.log((c ? "  PASS " : "  FAIL ") + m); if (!c) fail++; };

// --- hasUrlScheme() table -----------------------------------------------
const hasUrlSchemeSrc = extractFunction("hasUrlScheme");
// hasUrlScheme() closes over KNOWN_NON_SLASH_SCHEMES; pull that too.
const bgSrc = fs.readFileSync(BACKGROUND, "utf8");
const knownSetMatch = bgSrc.match(/const KNOWN_NON_SLASH_SCHEMES = new Set\(\[[^\]]*\]\);/);
if (!knownSetMatch) throw new Error("KNOWN_NON_SLASH_SCHEMES declaration not found in background.js");
const hasUrlScheme = new Function(`${knownSetMatch[0]}\n${hasUrlSchemeSrc}\nreturn hasUrlScheme;`)();

console.log("== hasUrlScheme(): pass-through schemes (must return true) ==");
const schemedInputs = [
  ["chrome-extension://ihljfjgoakmoemkdondoaadegpmibimh/sidepanel/sidepanel.html", "chrome-extension:// (the live bug report's exact input)"],
  ["file:///C:/Users/test/page.html", "file:///"],
  ["file://localhost/etc/hosts", "file:// with an authority"],
  ["about:blank", "about:blank"],
  ["data:text/html,hello", "data:"],
  ["blob:https://example.com/9b1e0e0d-uuid", "blob:"],
  ["view-source:https://example.com", "view-source:"],
  ["http://example.com", "http://"],
  ["https://example.com", "https://"],
  ["chrome://extensions", "chrome:// (authority form, no longer needs a literal special-case)"],
  ["brave://settings", "brave:// (authority form, no longer needs a literal special-case)"],
];
for (const [input, label] of schemedInputs) {
  ok(hasUrlScheme(input) === true, `${label} -> hasUrlScheme("${input}") === true`);
}

console.log("== hasUrlScheme(): scheme-less inputs (must return false, so https:// still gets prepended) ==");
const schemelessInputs = [
  ["example.com/path", "bare host/path"],
  ["example.com", "bare host"],
  ["example.com:8080/path", "host:port/path — syntactically ambiguous with a scheme, must still default to https://"],
  ["localhost:3000", "host:port, no dot"],
  ["www.example.com", "bare host with subdomain"],
];
for (const [input, label] of schemelessInputs) {
  ok(hasUrlScheme(input) === false, `${label} -> hasUrlScheme("${input}") === false`);
}

// --- navigate() end-to-end: normalized URL actually passed to chrome.tabs.update
console.log("== navigate(): exact URL chrome.tabs.update() is called with ==");

const navigateSrc = extractMethod("navigate");

function makeNavigateHarness() {
  const updateCalls = [];
  const chrome = {
    tabs: {
      update: async (tabId, opts) => { updateCalls.push({ tabId, ...opts }); return {}; },
      goBack: async () => {},
      goForward: async () => {},
      get: async (tabId) => ({ id: tabId, url: updateCalls.length ? updateCalls[updateCalls.length - 1].url : "about:blank", status: "complete" }),
      query: async () => [],
      onUpdated: { addListener: () => {}, removeListener: () => {} },
    },
  };
  const isInGroup = async () => true;
  const tabGroupId = 1;
  const fn = new Function(
    "chrome", "isInGroup", "tabGroupId", "hasUrlScheme",
    `const H = { ${navigateSrc} };\nreturn H.navigate;`
  );
  const navigate = fn(chrome, isInGroup, tabGroupId, hasUrlScheme);
  return { navigate, updateCalls };
}

{
  const { navigate, updateCalls } = makeNavigateHarness();
  await navigate({ url: "chrome-extension://ihljfjgoakmoemkdondoaadegpmibimh/sidepanel/sidepanel.html", tabId: 100 });
  const called = updateCalls[0];
  ok(called.url === "chrome-extension://ihljfjgoakmoemkdondoaadegpmibimh/sidepanel/sidepanel.html",
    `the exact live-bug input is passed through untouched, got: "${called.url}"`);
  ok(called.url !== "https://chrome-extension//ihljfjgoakmoemkdondoaadegpmibimh/sidepanel/sidepanel.html",
    "must NOT be rewritten into the corrupted form Chrome DNS-fails on");
}

{
  const { navigate, updateCalls } = makeNavigateHarness();
  await navigate({ url: "example.com:8080/path", tabId: 100 });
  ok(updateCalls[0].url === "https://example.com:8080/path", `host:port/path still gets https:// prepended, got: "${updateCalls[0].url}"`);
}

{
  const { navigate, updateCalls } = makeNavigateHarness();
  await navigate({ url: "example.com/path", tabId: 100 });
  ok(updateCalls[0].url === "https://example.com/path", `bare host/path still gets https:// prepended, got: "${updateCalls[0].url}"`);
}

{
  const { navigate, updateCalls } = makeNavigateHarness();
  await navigate({ url: "file:///C:/Users/test/page.html", tabId: 100 });
  ok(updateCalls[0].url === "file:///C:/Users/test/page.html", `file:/// passes through untouched, got: "${updateCalls[0].url}"`);
}

{
  const { navigate, updateCalls } = makeNavigateHarness();
  await navigate({ url: "about:blank", tabId: 100 });
  ok(updateCalls[0].url === "about:blank", `about:blank passes through untouched, got: "${updateCalls[0].url}"`);
}

{
  const { navigate, updateCalls } = makeNavigateHarness();
  await navigate({ url: "data:text/html,hello", tabId: 100 });
  ok(updateCalls[0].url === "data:text/html,hello", `data: passes through untouched, got: "${updateCalls[0].url}"`);
}

{
  const { navigate, updateCalls } = makeNavigateHarness();
  await navigate({ url: "view-source:https://example.com", tabId: 100 });
  ok(updateCalls[0].url === "view-source:https://example.com", `view-source: passes through untouched, got: "${updateCalls[0].url}"`);
}

console.log("== navigate(): back/forward unchanged ==");
{
  const backCalls = [];
  const chrome = {
    tabs: {
      goBack: async (tabId) => { backCalls.push(["back", tabId]); },
      goForward: async (tabId) => { backCalls.push(["forward", tabId]); },
      update: async () => { throw new Error("update() must NOT be called for back/forward"); },
      get: async (tabId) => ({ id: tabId, url: "https://example.com", status: "complete" }),
      query: async () => [],
      onUpdated: { addListener: () => {}, removeListener: () => {} },
    },
  };
  const isInGroup = async () => true;
  const tabGroupId = 1;
  const fn = new Function(
    "chrome", "isInGroup", "tabGroupId", "hasUrlScheme",
    `const H = { ${navigateSrc} };\nreturn H.navigate;`
  );
  const navigate = fn(chrome, isInGroup, tabGroupId, hasUrlScheme);
  await navigate({ url: "back", tabId: 100 });
  await navigate({ url: "forward", tabId: 100 });
  ok(backCalls.length === 2 && backCalls[0][0] === "back" && backCalls[0][1] === 100, "back calls chrome.tabs.goBack(tabId)");
  ok(backCalls[1][0] === "forward" && backCalls[1][1] === 100, "forward calls chrome.tabs.goForward(tabId)");
}

console.log(fail === 0 ? "\nALL NAVIGATE URL-SCHEME TESTS PASSED" : `\n${fail} FAILED`);
process.exit(fail ? 1 : 0);
