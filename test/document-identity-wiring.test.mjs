// Wiring tests for the document-identity primitive against the SHIPPED
// extension/background.js (design.md decision 6 / tasks.md 1.2-1.3) — the
// pure DocumentBindingTracker logic itself is covered by
// test/document-identity.test.mjs; this file proves background.js actually
// USES it correctly: the onUpdated listener's fixed same-URL-reload guard
// (gate-1.1 G0c), the lazy content-script handshake (ensureDocumentBinding),
// and navigate()'s correlated-navigation call sites (tasks.md 1.3),
// extracted the same brace-matching way test/action-events-emission.test.mjs
// and test/navigate-url-scheme.test.mjs already do — not a paraphrase.

import fs from "node:fs";
import * as documentIdentity from "../extension/events/document-identity.js";
import { extractFunction, extractMethod, BACKGROUND } from "./_extract.mjs";

let fail = 0;
const ok = (c, m) => { console.log((c ? "  PASS " : "  FAIL ") + m); if (!c) fail++; };

const bgSrc = fs.readFileSync(BACKGROUND, "utf8");

/** Local brace-matching class extractor (mirrors _extract.mjs's own
 * algorithm) — kept local rather than added to the shared test helper,
 * since only this file needs a class (not just a function/method). */
function extractClass(name, src = bgSrc) {
  const i = src.indexOf(`class ${name}`);
  if (i === -1) throw new Error(`class ${name} not found`);
  let depth = 0;
  let start = src.indexOf("{", i);
  for (let k = start; k < src.length; k++) {
    if (src[k] === "{") depth++;
    else if (src[k] === "}") {
      depth--;
      if (depth === 0) return src.slice(i, k + 1);
    }
  }
  throw new Error(`unbalanced braces for class ${name}`);
}

// =============================================================================
// 1. onUpdated listener: the shipped source drives BOTH actionDocTracker AND
//    documentBindings from the FIXED guard (changeInfo.url OR status ===
//    "loading"), and the OLD bare `if (changeInfo.url) actionDocTracker.
//    bump(tabId);` guard (gate-1.1's exact G0c finding) is gone.
// =============================================================================
console.log("== onUpdated listener: same-URL reload fix (gate-1.1 G0c) ==");
{
  const navIdx = bgSrc.indexOf('// URL change in a tab (address bar, link, redirect, SPA history) → navigate.');
  ok(navIdx !== -1, "the URL-change onUpdated listener block is present in the shipped source");
  const blockEnd = bgSrc.indexOf("\n});", navIdx) + 4;
  const block = bgSrc.slice(navIdx, blockEnd);

  ok(!/if \(changeInfo\.url\) actionDocTracker\.bump\(tabId\);/.test(block),
     "the OLD url-only bump guard (gate-1.1's exact G0c finding) is no longer present verbatim");
  ok(/changeInfo\.status === "loading"/.test(block), "the listener now also checks changeInfo.status === \"loading\" (catches a same-URL reload, which never sets changeInfo.url)");
  ok(/actionDocTracker\.bump\(tabId\)/.test(block), "actionDocTracker is still bumped from the fixed guard");
  ok(/documentBindings\.onNavigationSignal\(tabId/.test(block), "documentBindings.onNavigationSignal is driven from the same fixed guard");
}

// =============================================================================
// 2. Cleanup: chrome.tabs.onRemoved clears BOTH trackers, so no state lingers
//    for a recycled tabId.
// =============================================================================
console.log("\n== tab close cleanup clears documentBindings too ==");
{
  const removedIdx = bgSrc.indexOf("// Clean up when tab is closed");
  ok(removedIdx !== -1, "the cleanup onRemoved listener is present");
  const blockEnd = bgSrc.indexOf("\n});", removedIdx) + 4;
  const block = bgSrc.slice(removedIdx, blockEnd);
  ok(/actionDocTracker\.clear\(tabId\)/.test(block), "actionDocTracker.clear(tabId) still runs on tab close");
  ok(/documentBindings\.clear\(tabId\)/.test(block), "documentBindings.clear(tabId) also runs on tab close");
}

// =============================================================================
// 3. navigate(): beginAuthorizedNavigation is called BEFORE every privileged
//    chrome.tabs.goBack/goForward/update call — textual ordering, same
//    "start precedes execution" style check action-events-emission.test.mjs
//    §4 already uses for handleToolRequest().
// =============================================================================
console.log("\n== navigate(): correlated-navigation call sites (tasks.md 1.3) ==");
{
  const navigateSrc = extractMethod("navigate");
  const beginIdx = navigateSrc.indexOf("documentBindings.beginAuthorizedNavigation(");
  const backIdx = navigateSrc.indexOf("chrome.tabs.goBack(tabId)");
  const forwardIdx = navigateSrc.indexOf("chrome.tabs.goForward(tabId)");
  const updateIdx = navigateSrc.indexOf("chrome.tabs.update(tabId, { url: targetUrl })");
  ok(beginIdx !== -1 && backIdx !== -1 && forwardIdx !== -1 && updateIdx !== -1, "all four call sites present in the shipped navigate()");
  ok(beginIdx < backIdx && beginIdx < forwardIdx && beginIdx < updateIdx,
     "beginAuthorizedNavigation() is called BEFORE every privileged navigation call — the correlation exists before the browser-visible signal can fire");
  ok(/typeof documentBindings !== "undefined"/.test(navigateSrc), "guarded the same way tabs_create_mcp guards currentToolMeta — safe when compiled standalone (test/navigate-url-scheme.test.mjs)");
  ok(/typeof ensureDocumentBinding !== "undefined"/.test(navigateSrc), "the post-load handshake call is guarded the same way");
}

// =============================================================================
// 4. ensureDocumentBinding(): the lazy handshake, compiled against the REAL
//    sendContentMessage/injectContentScript/ContentScriptUnavailableError
//    and a REAL DocumentBindingTracker — no fakes for the module under test.
// =============================================================================
console.log("\n== ensureDocumentBinding(): lazy handshake against real shipped helpers ==");

function buildHarness({ sendMessageImpl, executeScriptImpl } = {}) {
  const documentBindings = new documentIdentity.DocumentBindingTracker();
  const dbgCalls = [];
  const chrome = {
    tabs: { sendMessage: sendMessageImpl },
    scripting: { executeScript: executeScriptImpl || (async () => {}) }
  };
  const dbg = (...a) => dbgCalls.push(a);
  const src = [
    extractClass("ContentScriptUnavailableError"),
    extractFunction("injectContentScript"),
    extractFunction("sendContentMessage"),
    extractFunction("ensureDocumentBinding")
  ].join("\n\n");
  const fn = new Function(
    "chrome", "dbg", "documentBindings",
    `${src}\nreturn { ensureDocumentBinding, sendContentMessage, ContentScriptUnavailableError };`
  );
  return { ...fn(chrome, dbg, documentBindings), documentBindings, dbgCalls };
}

{
  // Content script answers immediately with a real docNonce.
  const { ensureDocumentBinding, documentBindings } = buildHarness({
    sendMessageImpl: async (tabId, message) => {
      ok(message.type === "getDocumentIdentity", "ensureDocumentBinding sends the real getDocumentIdentity message type");
      return { result: { url: "https://a.example/", title: "A", documentEpoch: 0, docNonce: "content-nonce-1", readyState: "complete" } };
    }
  });
  const binding = await ensureDocumentBinding(42);
  ok(binding && binding.confirmed === true && binding.docNonce === "content-nonce-1", "a successful handshake confirms a real binding carrying the content script's own nonce");
  ok(documentBindings.requireBinding(42).ok === true, "the tracker now reports this tab as usable identity");
}

{
  // Restricted page: sendMessage rejects every time (no listener at all),
  // and re-injection ALSO fails (chrome refuses scripting on chrome://) —
  // the correct fail-closed outcome, not an exception ensureDocumentBinding
  // lets escape.
  const { ensureDocumentBinding, documentBindings } = buildHarness({
    sendMessageImpl: async () => { throw new Error("Could not establish connection. Receiving end does not exist."); },
    executeScriptImpl: async () => { throw new Error("Cannot access a chrome:// URL"); }
  });
  const binding = await ensureDocumentBinding(43);
  ok(binding === null, "a restricted/unreachable page returns null — never a fabricated tabId+url binding");
  ok(documentBindings.requireBinding(43).ok === false, "the tracker still fails closed for this tab");
}

{
  // Content script unreachable the FIRST time, but re-injection recovers it
  // (matches sendContentMessage's own re-injection contract).
  let attempt = 0;
  const { ensureDocumentBinding } = buildHarness({
    sendMessageImpl: async () => {
      attempt += 1;
      if (attempt === 1) throw new Error("no receiver");
      return { result: { url: "https://b.example/", documentEpoch: 0, docNonce: "content-nonce-2" } };
    }
  });
  const binding = await ensureDocumentBinding(44);
  ok(binding && binding.confirmed === true && binding.docNonce === "content-nonce-2", "a transient failure recovers via sendContentMessage's own re-injection, then confirms normally");
  ok(attempt === 2, "exactly one retry happened (the real sendContentMessage re-injection contract)");
}

{
  // Already confirmed for the current generation: no message sent at all.
  const documentBindings = new documentIdentity.DocumentBindingTracker();
  documentBindings.onNavigationSignal(45, { url: "https://c.example/" });
  documentBindings.confirmHandshake(45, { url: "https://c.example/", docNonce: "already-confirmed" });
  let sendCalls = 0;
  const chrome = { tabs: { sendMessage: async () => { sendCalls += 1; return { result: {} }; } }, scripting: { executeScript: async () => {} } };
  const src = [
    extractClass("ContentScriptUnavailableError"),
    extractFunction("injectContentScript"),
    extractFunction("sendContentMessage"),
    extractFunction("ensureDocumentBinding")
  ].join("\n\n");
  const fn = new Function("chrome", "dbg", "documentBindings", `${src}\nreturn { ensureDocumentBinding };`);
  const { ensureDocumentBinding } = fn(chrome, () => {}, documentBindings);
  const binding = await ensureDocumentBinding(45);
  ok(sendCalls === 0, "an already-confirmed binding is returned WITHOUT re-messaging the content script (lazy, not eager)");
  ok(binding.docNonce === "already-confirmed", "the existing confirmed binding is returned as-is");
}

console.log(fail === 0 ? "\nALL DOCUMENT IDENTITY WIRING TESTS PASSED" : `\n${fail} FAILED`);
process.exit(fail ? 1 : 0);
