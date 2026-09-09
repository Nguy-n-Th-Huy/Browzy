#!/usr/bin/env node
// page-context.js: active-tab tracking, pin/unpin, against a fake
// chrome.tabs-shaped API. No real browser involved.
//
// Run: node test/sidepanel-page-context.test.mjs

import { PageContextTracker } from "../extension/sidepanel/page-context.js";

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
    // test helpers — awaited so callers observe the tracker's async tab
    // fetch (chrome.tabs.get) having already settled before asserting.
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

async function main() {
  console.log("== opening the panel selects the active tab by default (no picker) ==");
  {
    const tabsApi = fakeTabsApi([
      { id: 1, windowId: 10, active: true, url: "https://vnexpress.net/kinh-te", title: "Kinh tế Việt Nam quý III", favIconUrl: "https://vnexpress.net/f.ico" },
      { id: 2, windowId: 10, active: false, url: "https://example.com", title: "Example" }
    ]);
    const tracker = new PageContextTracker({ windowId: 10, tabsApi });
    await tracker.start();
    const snap = tracker.snapshot();
    ok(snap && snap.tabId === 1 && snap.hostname === "vnexpress.net", "the active tab is selected automatically");
    ok(snap.pinned === false, "context starts unpinned");
  }

  console.log("== unpinned context follows the active tab (tab switch before Send) ==");
  {
    const tabsApi = fakeTabsApi([
      { id: 1, windowId: 10, active: true, url: "https://a.example/", title: "A" },
      { id: 2, windowId: 10, active: false, url: "https://b.example/", title: "B" }
    ]);
    const tracker = new PageContextTracker({ windowId: 10, tabsApi });
    await tracker.start();
    ok(tracker.snapshot().hostname === "a.example", "starts on A");
    await tabsApi._activate(2, 10);
    ok(tracker.snapshot().hostname === "b.example", "switching to B updates the chip");
  }

  console.log("== pin freezes context; a tab switch elsewhere is ignored until unpin ==");
  {
    const tabsApi = fakeTabsApi([
      { id: 1, windowId: 10, active: true, url: "https://a.example/", title: "A" },
      { id: 2, windowId: 10, active: false, url: "https://b.example/", title: "B" }
    ]);
    const tracker = new PageContextTracker({ windowId: 10, tabsApi });
    await tracker.start();
    tracker.pinCurrent();
    ok(tracker.isPinned() === true && tracker.snapshot().pinned === true, "pinCurrent() marks the current tab pinned");
    await tabsApi._activate(2, 10);
    ok(tracker.snapshot().hostname === "a.example", "a tab switch while pinned does not change the pinned context");
    tracker.unpin();
    ok(tracker.isPinned() === false, "unpin() clears the pin");
  }

  console.log("== a tab switch in a DIFFERENT window is ignored ==");
  {
    const tabsApi = fakeTabsApi([{ id: 1, windowId: 10, active: true, url: "https://a.example/", title: "A" }]);
    const tracker = new PageContextTracker({ windowId: 10, tabsApi });
    await tracker.start();
    await tabsApi._activate(99, 20); // unrelated window
    ok(tracker.snapshot().hostname === "a.example", "activity in another window never retargets this panel's context");
  }

  console.log("== a pinned tab that closes degrades to no context, not a stale one ==");
  {
    const tabsApi = fakeTabsApi([{ id: 1, windowId: 10, active: true, url: "https://a.example/", title: "A" }]);
    const tracker = new PageContextTracker({ windowId: 10, tabsApi });
    await tracker.start();
    tracker.pinCurrent();
    tabsApi._remove(1);
    await tracker._loadTab(1);
    ok(tracker.snapshot() === null, "a closed pinned tab clears to no context rather than showing stale data");
    ok(tracker.isPinned() === false, "the pin itself is released too");
  }

  console.log(fail === 0 ? "\nALL SIDEPANEL PAGE-CONTEXT TESTS PASSED" : `\n${fail} FAILED`);
  process.exit(fail ? 1 : 0);
}

main();
