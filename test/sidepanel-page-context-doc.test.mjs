#!/usr/bin/env node
// tasks.md 7.1-7.3 (upgrade-agent-reliability-and-workflows, decision 6):
// page-context UI, queued leases, pin/unpin, permissions, and send-time
// capture extended with the minimum document identity — revalidated at send,
// with original source identity preserved and refreshed / incomplete /
// replacement / unavailable results distinguished.
//
// Live browser QA (7.4: 320/400/480 widths, light/dark, real reload/routing)
// is explicitly out of scope here and stays unchecked in tasks.md.
//
// Run: node test/sidepanel-page-context-doc.test.mjs

import { PageContextTracker } from "../extension/sidepanel/page-context.js";
import { buildContextMetadata } from "../extension/sidepanel/context-binding.js";

let fail = 0;
function ok(cond, msg) {
  console.log((cond ? "  PASS " : "  FAIL ") + msg);
  if (!cond) fail++;
}

function fakeTabsApi(initialTabs) {
  const tabs = new Map(initialTabs.map((t) => [t.id, t]));
  let activatedListeners = [];
  let updatedListeners = [];
  return {
    async query({ active, windowId }) {
      return [...tabs.values()].filter((t) => t.active && (windowId == null || t.windowId === windowId));
    },
    async get(id) {
      const t = tabs.get(id);
      if (!t) throw new Error("no such tab");
      return t;
    },
    onActivated: { addListener: (fn) => activatedListeners.push(fn) },
    onUpdated: { addListener: (fn) => updatedListeners.push(fn) },
    async _activate(tabId, windowId) {
      for (const t of tabs.values()) t.active = t.id === tabId;
      await Promise.all(activatedListeners.map((fn) => fn({ tabId, windowId })));
    },
    async _update(tabId, patch) {
      const t = tabs.get(tabId);
      Object.assign(t, patch);
      await Promise.all(updatedListeners.map((fn) => fn(tabId, patch, t)));
    },
    _remove(tabId) {
      tabs.delete(tabId);
    }
  };
}

// Fake minimum-document-identity channel: mirrors
// extension/events/document-identity.js's getBinding() shape
// ({confirmed, generation, docNonce} | null), fully scripted per test.
function fakeDocIdentity(bindings = {}) {
  return {
    _bindings: { ...bindings },
    getBinding(tabId) {
      return this._bindings[tabId] || null;
    },
    _set(tabId, binding) {
      if (binding === null) delete this._bindings[tabId];
      else this._bindings[tabId] = binding;
    }
  };
}

const TAB = { id: 1, windowId: 10, active: true, url: "https://news.example/article", title: "Article", favIconUrl: null };

// == 7.1: snapshot carries the minimum document identity =======================
console.log("== 7.1 snapshot carries minimum document identity ==");
{
  const tabsApi = fakeTabsApi([{ ...TAB }]);
  const doc = fakeDocIdentity({ 1: { confirmed: true, generation: 3, docNonce: "nonce-1" } });
  const tracker = new PageContextTracker({ windowId: 10, tabsApi, docIdentity: doc });
  await tracker.start();
  const snap = tracker.snapshot();
  ok(snap.doc && snap.doc.confirmed === true && snap.doc.generation === 3 && snap.doc.docNonce === "nonce-1", "snapshot carries the confirmed generation + docNonce");
  const meta = buildContextMetadata({ text: "summarize this article", context: snap });
  ok(meta.docGeneration === 3 && meta.docConfirmed === true && meta.docNonce === "nonce-1" && meta.mustRead === true, "context metadata preserves the original source identity (doc fields ride along)");
}
{
  // No doc channel at all: legacy behavior, honestly reported.
  const tabsApi = fakeTabsApi([{ ...TAB }]);
  const tracker = new PageContextTracker({ windowId: 10, tabsApi });
  await tracker.start();
  const snap = tracker.snapshot();
  ok(snap && snap.doc === null, "without a doc channel the snapshot reports doc:null rather than fabricating identity");
  const meta = buildContextMetadata({ text: "hi", context: snap });
  ok(meta.docGeneration === null && meta.docConfirmed === false && meta.docNonce === null, "metadata marks the doc channel unavailable so the host fails its own guards closed");
}
{
  // Unconfirmed binding (mid-navigation, restricted page): nonce withheld.
  const tabsApi = fakeTabsApi([{ ...TAB }]);
  const doc = fakeDocIdentity({ 1: { confirmed: false, generation: 4, docNonce: null } });
  const tracker = new PageContextTracker({ windowId: 10, tabsApi, docIdentity: doc });
  await tracker.start();
  const meta = buildContextMetadata({ text: "hi", context: tracker.snapshot() });
  ok(meta.docConfirmed === false && meta.docNonce === null && meta.docGeneration === 4, "an unconfirmed binding exposes its generation but never a nonce");
}

// == 7.2: revalidate at send ====================================================
console.log("\n== 7.2 send-time revalidation ==");
{
  // Same-URL reload between display and Send: new docNonce, same URL.
  const tabsApi = fakeTabsApi([{ ...TAB }]);
  const doc = fakeDocIdentity({ 1: { confirmed: true, generation: 3, docNonce: "nonce-before" } });
  const tracker = new PageContextTracker({ windowId: 10, tabsApi, docIdentity: doc });
  await tracker.start();
  doc._set(1, { confirmed: true, generation: 4, docNonce: "nonce-after" }); // reload completed + re-handshaken
  const { changed, context } = await tracker.captureForSend();
  ok(changed === true, "a same-URL reload (new docNonce, identical URL) blocks the send — the run binds the fresh document, never the replaced one");
  ok(context.doc.docNonce === "nonce-after", "the refreshed context carries the NEW document identity");
}
{
  // SPA route change: same docNonce, bumped generation — still a new revision.
  const tabsApi = fakeTabsApi([{ ...TAB }]);
  const doc = fakeDocIdentity({ 1: { confirmed: true, generation: 3, docNonce: "nonce-spa" } });
  const tracker = new PageContextTracker({ windowId: 10, tabsApi, docIdentity: doc });
  await tracker.start();
  await tabsApi._update(1, { url: "https://news.example/article#comments" });
  doc._set(1, { confirmed: true, generation: 4, docNonce: "nonce-spa" });
  const { changed } = await tracker.captureForSend();
  ok(changed === true, "an SPA route revision requires revalidation even though the document itself is the same");
}
{
  // Steady state: nothing changed, send proceeds with the exact identity.
  const tabsApi = fakeTabsApi([{ ...TAB }]);
  const doc = fakeDocIdentity({ 1: { confirmed: true, generation: 3, docNonce: "nonce-steady" } });
  const tracker = new PageContextTracker({ windowId: 10, tabsApi, docIdentity: doc });
  await tracker.start();
  const { changed, context } = await tracker.captureForSend();
  ok(changed === false && context.doc.docNonce === "nonce-steady", "an unchanged document passes the gate with its exact identity bound");
}

// == 7.3: queue/pin/close/stale-permission/correlated-nav =======================
console.log("\n== 7.3 queued, pinned, closed, stale, correlated ==");
{
  // Queued-run binding: a pinned context survives tab switches with identity.
  const tabsApi = fakeTabsApi([
    { ...TAB },
    { id: 2, windowId: 10, active: false, url: "https://other.example/", title: "Other" }
  ]);
  const doc = fakeDocIdentity({ 1: { confirmed: true, generation: 1, docNonce: "pinned-doc" } });
  const tracker = new PageContextTracker({ windowId: 10, tabsApi, docIdentity: doc });
  await tracker.start();
  tracker.pinCurrent();
  await tabsApi._activate(2, 10); // user switches tabs while the run is queued
  const snap = tracker.snapshot();
  ok(snap.tabId === 1 && snap.pinned === true && snap.doc.docNonce === "pinned-doc", "a pinned (queued-run) binding ignores tab switches and keeps its document identity");
  const { changed } = await tracker.captureForSend();
  ok(changed === false, "the queued run's send still binds the pinned document");
}
{
  // Pin change: unpin follows the new active tab with ITS document.
  const tabsApi = fakeTabsApi([
    { ...TAB },
    { id: 2, windowId: 10, active: false, url: "https://other.example/", title: "Other" }
  ]);
  const doc = fakeDocIdentity({
    1: { confirmed: true, generation: 1, docNonce: "doc-1" },
    2: { confirmed: true, generation: 1, docNonce: "doc-2" }
  });
  const tracker = new PageContextTracker({ windowId: 10, tabsApi, docIdentity: doc });
  await tracker.start();
  tracker.pinCurrent();
  tracker.unpin();
  await tabsApi._activate(2, 10);
  const snap = tracker.snapshot();
  ok(snap.tabId === 2 && snap.doc.docNonce === "doc-2", "after unpin the tracker follows the new tab with its own document identity, not the old pin's");
}
{
  // Closed pinned tab: no silent fallback to any replacement.
  const tabsApi = fakeTabsApi([{ ...TAB }]);
  const doc = fakeDocIdentity({ 1: { confirmed: true, generation: 1, docNonce: "doomed" } });
  const tracker = new PageContextTracker({ windowId: 10, tabsApi, docIdentity: doc });
  await tracker.start();
  tracker.pinCurrent();
  tabsApi._remove(1);
  doc._set(1, null);
  const { changed, context } = await tracker.captureForSend();
  ok(changed === true && context === null, "a closed tab yields no context at all — never a silently selected replacement tab");
}
{
  // Stale permission analogue: the page becomes restricted (handshake can
  // never confirm it) — capture reports the change, metadata stays honest.
  const tabsApi = fakeTabsApi([{ ...TAB, url: "https://news.example/article" }]);
  const doc = fakeDocIdentity({ 1: { confirmed: true, generation: 2, docNonce: "was-fine" } });
  const tracker = new PageContextTracker({ windowId: 10, tabsApi, docIdentity: doc });
  await tracker.start();
  await tabsApi._update(1, { url: "chrome://extensions/" });
  doc._set(1, null); // content script has no presence here — never confirmed
  const { changed, context } = await tracker.captureForSend();
  ok(changed === true && context.restricted === true, "navigating to a restricted page refreshes the chip and requires a second Send");
  const meta = buildContextMetadata({ text: "read this", context });
  ok(meta.docConfirmed === false && meta.restricted === true, "the bound metadata says restricted + unconfirmed — the host must refuse reads, not trust tabId+url");
}
{
  // Correlated navigation: the authorized destination commits, then the
  // handshake confirms it under a NEW nonce — the next send binds the new
  // document cleanly (no stale approval/nonce for the old one survives,
  // because capture compares full doc identity).
  const tabsApi = fakeTabsApi([{ ...TAB }]);
  const doc = fakeDocIdentity({ 1: { confirmed: true, generation: 1, docNonce: "old-doc" } });
  const tracker = new PageContextTracker({ windowId: 10, tabsApi, docIdentity: doc });
  await tracker.start();
  const before = tracker.snapshot();
  await tabsApi._update(1, { url: "https://news.example/next" });
  doc._set(1, { confirmed: true, generation: 2, docNonce: "new-doc" });
  const mid = await tracker.captureForSend();
  ok(mid.changed === true, "the committed navigation invalidates the old binding first (old refs/nonces go stale)");
  const again = await tracker.captureForSend();
  ok(again.changed === false && again.context.doc.docNonce === "new-doc" && again.context.url === "https://news.example/next", "after revalidation the new document binds cleanly for subsequent reads");
  void before;
}

console.log(fail === 0 ? "\nALL PAGE-CONTEXT DOCUMENT TESTS PASSED" : `\n${fail} FAILED`);
process.exit(fail ? 1 : 0);
