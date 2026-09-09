#!/usr/bin/env node
// Task 5.5/5.6 (design.md section 5b) — active-page binding.
//
// Covers, against fakes only (no real browser needed — see this task's own
// environment constraint):
//   - context-binding.js: current-page-reference detection (including the
//     exact Vietnamese acceptance fixture) and the structured trusted-
//     metadata object built for a bound context (a live-extraction
//     `mustRead` flag that only escalates when the message actually
//     references the page) — a PLAIN DATA object, never text merged into
//     the user's own words.
//   - page-context.js: revision bumps, the restricted-URL classification,
//     and captureForSend()'s atomic Send-time re-validation — including the
//     race this exists for: the displayed chip disagreeing with the live,
//     authoritative tab state (a dropped chrome.tabs event / a reawoken
//     service worker), and a tab closing between display and Send.
//   - panel-controller.js: the wire `prompt` field carries ONLY the user's
//     own literal text (unchanged from what the transcript/history-store
//     prompt cache show), while the bound context travels on a SEPARATE
//     `context` field passed to `protocol.start()` — proving the two never
//     merge (design.md section 5: "User messages and page/tool content
//     remain distinctly typed").
//
// Run: node test/sidepanel-context-binding.test.mjs

import { PageContextTracker, isRestrictedUrl } from "../extension/sidepanel/page-context.js";
import { referencesCurrentPage, buildContextMetadata } from "../extension/sidepanel/context-binding.js";
import { PanelController } from "../extension/sidepanel/panel-controller.js";

let fail = 0;
function ok(cond, msg) {
  console.log((cond ? "  PASS " : "  FAIL ") + msg);
  if (!cond) fail++;
}

function fakeTabsApi(initialTabs) {
  const tabs = new Map(initialTabs.map((t) => [t.id, t]));
  const activatedListeners = [];
  const updatedListeners = [];
  return {
    async query({ active, windowId }) {
      return [...tabs.values()].filter((t) => t.active && (windowId == null || t.windowId === windowId));
    },
    async get(id) {
      const t = tabs.get(id);
      if (!t) throw new Error("no such tab");
      return { ...t };
    },
    onActivated: { addListener: (fn) => activatedListeners.push(fn) },
    onUpdated: { addListener: (fn) => updatedListeners.push(fn) },
    async _activate(tabId, windowId) {
      for (const t of tabs.values()) t.active = t.id === tabId;
      await Promise.all(activatedListeners.map((fn) => fn({ tabId, windowId })));
    },
    // Mutates the underlying tab WITHOUT firing any listener — simulates a
    // dropped chrome.tabs event or a service worker that was asleep when the
    // real event fired, so the tracker's cached `_current` goes stale while
    // the "browser" (this fake) has already moved on.
    _mutateSilently(tabId, patch) {
      const t = tabs.get(tabId);
      Object.assign(t, patch);
    },
    _removeSilently(tabId) {
      tabs.delete(tabId);
    }
  };
}

async function main() {
  console.log("== referencesCurrentPage(): the exact Vietnamese acceptance fixture, and negatives ==");
  {
    ok(referencesCurrentPage("đọc bài viết này và phân tích"), "the acceptance fixture phrase must be detected");
    ok(referencesCurrentPage("Tóm tắt bài viết trên trang này giúp mình."), "the empty-state suggestion phrasing must be detected");
    ok(referencesCurrentPage("summarize this article for me"), "English 'this article' must be detected");
    ok(!referencesCurrentPage("what is the capital of France?"), "an unrelated question must NOT be detected as a page reference");
    ok(!referencesCurrentPage(""), "empty text is not a page reference");
  }

  console.log("\n== buildContextMetadata(): no context -> null (nothing to attach on any channel) ==");
  {
    const out = buildContextMetadata({ text: "hello", context: null });
    ok(out === null, "no bound context must produce no metadata object at all");
  }

  console.log("\n== buildContextMetadata(): a bound context is ALWAYS returned as a plain structured object, distinct from the user's text ==");
  {
    const context = { tabId: 42, url: "https://vnexpress.net/a", title: "Kinh tế quý III", hostname: "vnexpress.net", revision: 3 };
    const text = "hôm nay thời tiết thế nào?";
    const meta = buildContextMetadata({ text, context, boundAt: 1000 });
    ok(meta && typeof meta === "object", "a bound context must produce a metadata object");
    ok(meta.tabId === 42, "the exact bound tabId must appear in the metadata object");
    ok(meta.url === "https://vnexpress.net/a", "the exact bound URL must appear");
    ok(meta.boundAt === 1000, "the exact bind timestamp must be carried, unrendered (host renders it to text)");
    ok(!Object.values(meta).some((v) => v === text), "the metadata object must never itself contain the user's literal text — it is a distinct channel");
    ok(meta.mustRead === false, "an unrelated message must produce the non-imperative (mustRead:false) metadata");
  }

  console.log("\n== buildContextMetadata(): a current-page-referencing message escalates mustRead (the fixture path) ==");
  {
    const context = { tabId: 7, url: "https://example.com/article", title: "Article", hostname: "example.com", revision: 1 };
    const meta = buildContextMetadata({ text: "đọc bài viết này và phân tích", context });
    ok(meta.mustRead === true, "the current-article request must set mustRead so the host renders an imperative live-extraction instruction");
    ok(meta.tabId === 7, "the metadata must name the exact bound tabId");
  }

  console.log("\n== buildContextMetadata(): restricted context is flagged in the metadata, without ever reading the page ==");
  {
    const context = { tabId: 9, url: "chrome://settings", title: "Settings", hostname: null, restricted: true, revision: 1 };
    const meta = buildContextMetadata({ text: "đọc trang này", context });
    ok(meta.restricted === true, "a restricted page must be flagged in the metadata object, not silently sent for extraction");
  }

  console.log("\n== isRestrictedUrl(): browser-internal/store pages are classified from the URL string alone ==");
  {
    ok(isRestrictedUrl("chrome://extensions"), "chrome:// is restricted");
    ok(isRestrictedUrl("chrome-extension://abc/options.html"), "chrome-extension:// is restricted");
    ok(isRestrictedUrl("https://chromewebstore.google.com/detail/x"), "the web store is restricted");
    ok(!isRestrictedUrl("https://vnexpress.net/a"), "an ordinary https page is not restricted");
  }

  console.log("\n== PageContextTracker: revision increments on real changes, not on repeats ==");
  {
    const tabsApi = fakeTabsApi([{ id: 1, windowId: 10, active: true, url: "https://a.example/", title: "A" }]);
    const tracker = new PageContextTracker({ windowId: 10, tabsApi });
    await tracker.start();
    const r0 = tracker.snapshot().revision;
    await tabsApi._activate(1, 10); // re-activating the SAME tab: no real change
    ok(tracker.snapshot().revision === r0, "re-activating the same tab must not bump revision");
    tabsApi._mutateSilently(1, { url: "https://a.example/2", title: "A2" });
    await tabsApi._activate(1, 10); // fires onActivated -> _loadTab -> _setFromTab against the new (already-mutated) data
    ok(tracker.snapshot().revision === r0 + 1, "an actual target change must bump revision exactly once");
  }

  console.log("\n== PageContextTracker.captureForSend(): a tab activation in a DIFFERENT window is never mistaken for this panel's authoritative target (two-window race) ==");
  {
    const tabsApi = fakeTabsApi([
      { id: 1, windowId: 10, active: true, url: "https://a.example/", title: "A" }, // this panel's own window
      { id: 2, windowId: 20, active: true, url: "https://other-window.example/", title: "Other window's tab" }
    ]);
    const tracker = new PageContextTracker({ windowId: 10, tabsApi });
    await tracker.start();
    // Simulate the OTHER window's own tab activity happening concurrently —
    // it must never leak into this panel's window-scoped captureForSend().
    tabsApi._mutateSilently(2, { url: "https://other-window.example/2" });
    const { changed, context } = await tracker.captureForSend();
    ok(changed === false, "unrelated activity in a different window must never register as this panel's context changing");
    ok(context.hostname === "a.example" && context.tabId === 1, "captureForSend's live re-query stays scoped to this panel's own window, exactly like the initial bind");
  }

  console.log("\n== PageContextTracker.captureForSend(): the same document re-titling itself (unread counter, clock, late favicon) must NOT block the send ==");
  {
    const tabsApi = fakeTabsApi([{ id: 1, windowId: 10, active: true, url: "https://mail.example/inbox", title: "Inbox" }]);
    const tracker = new PageContextTracker({ windowId: 10, tabsApi });
    await tracker.start();
    // Same tab, same URL - only the page's own display metadata moved.
    tabsApi._mutateSilently(1, { title: "(3) Inbox", favIconUrl: "https://mail.example/favicon.ico" });

    const { changed, context } = await tracker.captureForSend();
    ok(changed === false, "a title/favicon change on the same tab+URL is not a retarget and must never reject the send");
    ok(context.tabId === 1 && context.url === "https://mail.example/inbox", "the bound target is still the same document");
    ok(context.title === "(3) Inbox", "the chip still picks up the refreshed display metadata");
  }

  console.log("\n== PageContextTracker.captureForSend(): UI and live browser state AGREE -> safe to bind, nothing refreshed ==");
  {
    const tabsApi = fakeTabsApi([{ id: 1, windowId: 10, active: true, url: "https://a.example/", title: "A" }]);
    const tracker = new PageContextTracker({ windowId: 10, tabsApi });
    await tracker.start();
    const { changed, context } = await tracker.captureForSend();
    ok(changed === false, "when nothing moved between display and Send, captureForSend must report unchanged");
    ok(context.tabId === 1 && context.url === "https://a.example/", "the returned context is the exact bound target");
  }

  console.log("\n== PageContextTracker.captureForSend(): a dropped tab-switch event before Send is caught, chip refreshed, NOT silently bound to the old target ==");
  {
    const tabsApi = fakeTabsApi([
      { id: 1, windowId: 10, active: true, url: "https://a.example/", title: "Article A" },
      { id: 2, windowId: 10, active: false, url: "https://b.example/", title: "Article B" }
    ]);
    const tracker = new PageContextTracker({ windowId: 10, tabsApi });
    await tracker.start();
    ok(tracker.snapshot().hostname === "a.example", "starts bound to A, as displayed");

    // The user actually switched to B, but simulate the tab-activated event
    // never reaching this tracker (service worker asleep / event dropped) —
    // the chip is STILL showing A even though the browser has moved to B.
    tabsApi._mutateSilently(1, { active: false });
    tabsApi._mutateSilently(2, { active: true });

    const before = tracker.snapshot();
    const { changed, context } = await tracker.captureForSend();
    ok(changed === true, "captureForSend must detect the UI/live disagreement");
    ok(context.hostname === "b.example", "the corrected, authoritative target is B, not the stale displayed A");
    ok(tracker.snapshot().hostname === "b.example", "the chip itself must already show the corrected target after captureForSend");
    ok(before.hostname === "a.example", "sanity: the snapshot taken before capture really was the stale one (A)");
  }

  console.log("\n== PageContextTracker.captureForSend(): the bound tab closes before Send -> explicit no-context, never silently retargeted to another active tab ==");
  {
    const tabsApi = fakeTabsApi([
      { id: 1, windowId: 10, active: true, url: "https://a.example/", title: "A" },
      { id: 2, windowId: 10, active: false, url: "https://b.example/", title: "B" }
    ]);
    const tracker = new PageContextTracker({ windowId: 10, tabsApi });
    await tracker.start();
    tracker.pinCurrent();
    tabsApi._removeSilently(1);
    tabsApi._mutateSilently(2, { active: true }); // some OTHER tab is now active in the window

    const { changed, context } = await tracker.captureForSend();
    ok(changed === true, "a closed bound tab must be reported as changed");
    ok(context === null, "closing the bound tab must degrade to NO context, never silently pick up whatever tab is now active");
    ok(tracker.isPinned() === false, "the pin is released along with the closed tab");
  }

  console.log("\n== PageContextTracker: pin/remove — remove is always available, re-add restores from the active tab ==");
  {
    const tabsApi = fakeTabsApi([{ id: 1, windowId: 10, active: true, url: "https://a.example/", title: "A" }]);
    const tracker = new PageContextTracker({ windowId: 10, tabsApi });
    await tracker.start();
    tracker.clear();
    ok(tracker.snapshot() === null, "clear() removes context");
    ok(tracker.wasExplicitlyRemoved() === true, "an explicit clear() is distinguishable from context never having loaded");
    tracker.unpin(); // the "add context back" affordance's action
    await Promise.resolve();
    // unpin() kicks off an async refresh; wait for it to settle.
    await new Promise((r) => setTimeout(r, 0));
    ok(tracker.snapshot() && tracker.snapshot().tabId === 1, "re-adding context restores it from the active tab");
    ok(tracker.wasExplicitlyRemoved() === false, "once context is restored, it is no longer in the 'explicitly removed' state");
  }

  console.log("\n== PanelController.sendMessage(): the wire `prompt` is ONLY the user's literal text; the bound context travels on a SEPARATE `context` field ==");
  {
    const sent = [];
    const protocolClient = {
      onEnvelope: () => {},
      onHandshakeChange: () => {},
      onDisconnect: () => {},
      connect: () => {},
      handshakeState: () => "ok",
      start: (msg) => sent.push(msg)
    };
    const historyStore = { upsert: async () => {}, recordPrompt: async () => {} };
    const profileCache = { read: async () => null, onChange: () => {} };
    const panel = new PanelController({ protocolClient, historyStore, profileCache });
    await panel.init();
    panel.currentConversationId = "conv_1";
    panel.models.set("conv_1", new (await import("../extension/sidepanel/conversation-model.js")).ConversationModel("conv_1"));

    const context = { tabId: 42, url: "https://vnexpress.net/a", title: "Bài viết", hostname: "vnexpress.net", revision: 1 };
    await panel.sendMessage("đọc bài viết này và phân tích", { tabScope: [42], pageContext: context });

    ok(sent.length === 1, "exactly one start() call was made");
    ok(sent[0].tabScope[0] === 42, "tabScope is bound to the exact bound tabId, not 'any'");
    ok(sent[0].prompt === "đọc bài viết này và phân tích", "the wire `prompt` is EXACTLY the user's literal text — no metadata block prepended or appended");
    ok(sent[0].context && sent[0].context.tabId === 42, "the bound-context metadata travels on the separate `context` field");
    ok(sent[0].context.mustRead === true, "the context metadata escalates mustRead for this fixture text");
    ok(!sent[0].prompt.includes("tab_id") && !/<bound_page_context/.test(sent[0].prompt), "the prompt string itself never contains any bound-context markup");

    const model = panel.models.get("conv_1");
    const userItem = model.items.find((i) => i.kind === "user");
    ok(userItem.text === "đọc bài viết này và phân tích", "the DISPLAYED transcript item is the user's exact literal text, identical to the wire prompt");
  }

  console.log("\n== PanelController.sendMessage(): two consecutive sends to different bound tabs never cross-contaminate ==");
  {
    const sent = [];
    const protocolClient = {
      onEnvelope: () => {},
      onHandshakeChange: () => {},
      onDisconnect: () => {},
      connect: () => {},
      handshakeState: () => "ok",
      start: (msg) => sent.push(msg)
    };
    const historyStore = { upsert: async () => {}, recordPrompt: async () => {} };
    const profileCache = { read: async () => null, onChange: () => {} };
    const panel = new PanelController({ protocolClient, historyStore, profileCache });
    await panel.init();
    panel.currentConversationId = "conv_1";
    const { ConversationModel } = await import("../extension/sidepanel/conversation-model.js");
    panel.models.set("conv_1", new ConversationModel("conv_1"));

    await panel.sendMessage("đọc bài này", { tabScope: [1], pageContext: { tabId: 1, url: "https://a.example/", title: "A", hostname: "a.example", revision: 1 } });
    await panel.sendMessage("đọc bài này", { tabScope: [2], pageContext: { tabId: 2, url: "https://b.example/", title: "B", hostname: "b.example", revision: 1 } });

    ok(sent.length === 2, "two sends produced two start() calls");
    ok(sent[0].prompt === "đọc bài này" && sent[1].prompt === "đọc bài này", "both prompts are the identical literal user text — the page identity never lives in `prompt`");
    ok(sent[0].context.url === "https://a.example/" && sent[0].context.tabId === 1, "first run's context is bound only to A");
    ok(sent[1].context.url === "https://b.example/" && sent[1].context.tabId === 2, "second run's context is bound only to B — a later tab switch never leaks into an earlier or unrelated run's context");
  }

  console.log(fail === 0 ? "\nALL SIDEPANEL CONTEXT-BINDING TESTS PASSED" : `\n${fail} FAILED`);
  process.exit(fail ? 1 : 0);
}

main();
