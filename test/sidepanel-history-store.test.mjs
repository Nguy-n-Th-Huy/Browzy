#!/usr/bin/env node
// history-store.js: local conversation index (new/list/reopen/delete),
// against an in-memory fake of chrome.storage.local's {get,set} contract.
//
// Run: node test/sidepanel-history-store.test.mjs

import { HistoryStore } from "../extension/sidepanel/history-store.js";

let fail = 0;
function ok(cond, msg) {
  console.log((cond ? "  PASS " : "  FAIL ") + msg);
  if (!cond) fail++;
}

function fakeChromeStorage() {
  const data = {};
  return {
    async get(key) {
      return key in data ? { [key]: data[key] } : {};
    },
    async set(obj) {
      Object.assign(data, obj);
    },
    _dump: () => data
  };
}

async function main() {
  console.log("== new/list ==");
  {
    const storage = fakeChromeStorage();
    const store = new HistoryStore({ storage });
    ok((await store.list()).length === 0, "empty store lists nothing");

    await store.upsert({ conversationId: "c1", title: "Đọc bài viết A", hostname: "vnexpress.net" });
    await new Promise((r) => setTimeout(r, 2));
    await store.upsert({ conversationId: "c2", title: "Đọc bài viết B", hostname: "dev.to" });

    const list = await store.list();
    ok(list.length === 2, "both conversations are listed");
    ok(list[0].conversationId === "c2", "most-recently-updated is first");
  }

  console.log("== upsert is idempotent by conversationId (no duplicate rows) ==");
  {
    const store = new HistoryStore({ storage: fakeChromeStorage() });
    await store.upsert({ conversationId: "c1", title: "v1" });
    await store.upsert({ conversationId: "c1", title: "v2", updatedAt: Date.now() + 1000 });
    const list = await store.list();
    ok(list.length === 1, "same conversationId never creates a second row");
    ok(list[0].title === "v2", "the later upsert's fields win");
  }

  console.log("== prompt echo cache (host does not persist prompt text, see conversation-model.js) ==");
  {
    const store = new HistoryStore({ storage: fakeChromeStorage() });
    await store.upsert({ conversationId: "c1", title: "hi" });
    await store.recordPrompt("c1", "run_1", "đọc bài viết này");
    await store.recordPrompt("c1", "run_2", "tóm tắt tiếp");
    const prompts = await store.promptsFor("c1");
    ok(prompts instanceof Map, "promptsFor returns a Map");
    ok(prompts.get("run_1") === "đọc bài viết này" && prompts.get("run_2") === "tóm tắt tiếp", "both runs' prompts are recoverable");
    ok((await store.promptsFor("unknown")).size === 0, "an unknown conversation returns an empty map, not a throw");
  }

  console.log("== explicit local deletion ==");
  {
    const store = new HistoryStore({ storage: fakeChromeStorage() });
    await store.upsert({ conversationId: "c1", title: "a" });
    await store.upsert({ conversationId: "c2", title: "b" });
    await store.removeLocal("c1");
    const list = await store.list();
    ok(list.length === 1 && list[0].conversationId === "c2", "deleted conversation no longer appears in the list");
    // Deleting again (already gone) must not throw.
    let threw = false;
    try {
      await store.removeLocal("c1");
    } catch {
      threw = true;
    }
    ok(!threw, "deleting an already-removed conversation is a safe no-op");
  }

  console.log("== a storage failure degrades to an empty list rather than throwing ==");
  {
    const brokenStorage = {
      async get() {
        throw new Error("storage unavailable");
      },
      async set() {
        throw new Error("storage unavailable");
      }
    };
    const store = new HistoryStore({ storage: brokenStorage });
    let threw = false;
    let list = null;
    try {
      list = await store.list();
      await store.upsert({ conversationId: "c1", title: "x" });
    } catch {
      threw = true;
    }
    ok(!threw && Array.isArray(list) && list.length === 0, "a broken storage backend never crashes the panel");
  }

  console.log("== last-active conversation identity (restore-last-active-conversation) ==");
  {
    const store = new HistoryStore({ storage: fakeChromeStorage() });
    ok((await store.getLastActive()) === null, "a fresh store has no remembered last-active id");

    await store.setLastActive("c1");
    ok((await store.getLastActive()) === "c1", "set/get round-trips the last-active id");

    await store.setLastActive(null);
    ok((await store.getLastActive()) === null, "setLastActive(null) forgets the remembered id");
  }

  console.log("== last-active storage failures never propagate (a broken chrome.storage.local must not block opening the panel) ==");
  {
    const brokenStorage = {
      async get() {
        throw new Error("storage unavailable");
      },
      async set() {
        throw new Error("storage unavailable");
      }
    };
    const store = new HistoryStore({ storage: brokenStorage });
    let threw = false;
    let id = "not-yet-read";
    try {
      id = await store.getLastActive();
      await store.setLastActive("c1");
    } catch {
      threw = true;
    }
    ok(!threw && id === null, "getLastActive() on a broken storage backend resolves to null, never a throw");
  }

  console.log(fail === 0 ? "\nALL SIDEPANEL HISTORY-STORE TESTS PASSED" : `\n${fail} FAILED`);
  process.exit(fail ? 1 : 0);
}

main();
