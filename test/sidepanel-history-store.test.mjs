#!/usr/bin/env node
// history-store.js: the local conversation CACHE (a versioned mirror of the
// host's authoritative summaries) plus the panel's prompt echo cache, its
// coalesced persistence, retention/privacy policy and per-tab remembered
// conversation ids. Exercised against an in-memory fake of chrome.storage's
// {get, set, remove} contract, with a write counter so the
// coalescing/no-whole-list-rewrite claims are actually measurable.
//
// Run: node test/sidepanel-history-store.test.mjs

import { HistoryStore, HISTORY_ENTRY_KEY_PREFIX, HISTORY_POLICY_KEY, EVICTION_OUTCOME } from "../extension/sidepanel/history-store.js";
import { HistoryPrivacyControls, retentionSummaryText } from "../extension/sidepanel/history-privacy.js";
import { createDocument } from "./_fake-dom.mjs";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let fail = 0;
function ok(cond, msg) {
  console.log((cond ? "  PASS " : "  FAIL ") + msg);
  if (!cond) fail++;
}

async function waitUntil(fn, { timeoutMs = 1000, intervalMs = 5 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

/**
 * In-memory chrome.storage.local/session fake. Supports the null/array/batch
 * shapes chrome.storage really has, and counts writes/removals + records the
 * key sets each write carried, so "persisted at most once per interval" and
 * "never rewrites the whole index" are observable facts rather than
 * intentions.
 */
function fakeChromeStorage(seed = {}) {
  const data = { ...seed };
  const writes = [];
  const removals = [];
  return {
    writes,
    removals,
    async get(key) {
      if (key == null) return { ...data };
      if (Array.isArray(key)) {
        const out = {};
        for (const k of key) if (k in data) out[k] = data[k];
        return out;
      }
      return key in data ? { [key]: data[key] } : {};
    },
    async set(obj) {
      writes.push(Object.keys(obj));
      Object.assign(data, obj);
    },
    async remove(keys) {
      const list = Array.isArray(keys) ? keys : [keys];
      removals.push(list);
      for (const k of list) delete data[k];
    },
    _dump: () => data
  };
}

const entryKeysWritten = (storage) => storage.writes.flat().filter((k) => k.startsWith(HISTORY_ENTRY_KEY_PREFIX));

async function main() {
  console.log("== new/list: most-recently-active first, pinned above the rest ==");
  {
    const store = new HistoryStore({ storage: fakeChromeStorage() });
    ok((await store.list()).length === 0, "empty store lists nothing");

    await store.upsert({ conversationId: "c1", title: "Đọc bài viết A", hostname: "vnexpress.net", updatedAt: 1000 });
    await store.upsert({ conversationId: "c2", title: "Đọc bài viết B", hostname: "dev.to", updatedAt: 2000 });

    const list = await store.list();
    ok(list.length === 2, "both conversations are listed");
    ok(list[0].conversationId === "c2", "most-recently-updated is first");

    await store.upsert({ conversationId: "c1", pinned: true });
    ok((await store.list())[0].conversationId === "c1", "a pinned conversation is listed above newer unpinned ones");
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

  console.log("== per-conversation keys: a write never rewrites the whole index, and streaming is coalesced ==");
  {
    const storage = fakeChromeStorage();
    const store = new HistoryStore({ storage, flushDelayMs: 40 });
    await store.upsert({ conversationId: "c1", title: "a" });
    await store.upsert({ conversationId: "c2", title: "b" });
    storage.writes.length = 0;

    // 50 streaming updates for c1 within one debounce window.
    for (let i = 0; i < 50; i++) {
      await store.upsert({ conversationId: "c1", title: `a${i}` });
    }
    ok(storage.writes.length === 0, "nothing is written before the debounce window elapses (no write per token batch)");
    await new Promise((r) => setTimeout(r, 80));
    ok(storage.writes.length === 1, `exactly one coalesced write landed for the window (got ${storage.writes.length})`);
    const keys = storage.writes[0];
    ok(keys.length === 1 && keys[0] === `${HISTORY_ENTRY_KEY_PREFIX}c1`, "that write carried ONLY the dirty conversation's own key — no whole-index rewrite");
    ok(storage._dump()[`${HISTORY_ENTRY_KEY_PREFIX}c1`].title === "a49", "the last value wins inside the window");
    ok(storage._dump()[`${HISTORY_ENTRY_KEY_PREFIX}c2`].title === "b", "the untouched conversation's stored row is unchanged");
  }

  console.log("== lifecycle flushes: a brand-new conversation and a delete are durable immediately ==");
  {
    const storage = fakeChromeStorage();
    const store = new HistoryStore({ storage, flushDelayMs: 5000 });
    await store.upsert({ conversationId: "c1", title: "a" });
    ok(entryKeysWritten(storage).length === 1, "creating the first record of a conversation writes it right away, not after 5s");
    storage.writes.length = 0;
    await store.remove("c1");
    ok(storage.removals.flat().includes(`${HISTORY_ENTRY_KEY_PREFIX}c1`), "deleting the local row removes its storage key immediately");
    ok((await store.list()).length === 0, "and it is gone from the in-memory list too");
    // Deleting again (already gone) must not throw.
    let threw = false;
    try {
      await store.remove("c1");
    } catch {
      threw = true;
    }
    ok(!threw, "deleting an already-removed conversation is a safe no-op");
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

  console.log("== prompt preview cap: one stored preview can never grow unbounded ==");
  {
    const store = new HistoryStore({ storage: fakeChromeStorage(), policy: { maxPromptPreviewChars: 20 } });
    await store.upsert({ conversationId: "c1" });
    await store.recordPrompt("c1", "r1", "x".repeat(5000));
    const prompts = await store.promptsFor("c1");
    ok(prompts.get("r1").length === 20, `the stored preview is capped at the configured 20 chars (got ${prompts.get("r1").length})`);
  }

  console.log("== privacy toggle: caching disabled stores metadata and a preview-free entry ==");
  {
    const store = new HistoryStore({ storage: fakeChromeStorage(), policy: { rawPromptCaching: false } });
    await store.upsert({ conversationId: "c1", title: "việc quan trọng" });
    await store.recordPrompt("c1", "r1", "nội dung riêng tư");
    const entry = await store.get("c1");
    ok(entry.title === "việc quan trọng", "the metadata is still stored (the conversation still lists)");
    ok(Object.keys(entry.prompts).length === 0, "no prompt text is stored at all");
    ok(entry.previewSuppressed === true, "the entry says explicitly that previews are suppressed, rather than looking merely empty");

    // Turning the switch OFF must also remove previews cached earlier —
    // otherwise the switch would not mean what it says.
    const store2 = new HistoryStore({ storage: fakeChromeStorage() });
    await store2.upsert({ conversationId: "c1" });
    await store2.recordPrompt("c1", "r1", "đã lưu trước đó");
    ok((await store2.promptsFor("c1")).size === 1, "sanity: the preview was cached while caching was on");
    await store2.setRawPromptCachingEnabled(false);
    ok((await store2.promptsFor("c1")).size === 0, "disabling raw prompt caching drops the previews it had already cached");
  }

  console.log("== effectivePolicy: a control sees the PERSISTED policy, not the pre-load defaults ==");
  {
    const storage = fakeChromeStorage({
      [HISTORY_POLICY_KEY]: { rawPromptCaching: false, maxConversations: 7, schemaVersion: 2, updatedAt: 1 }
    });
    const store = new HistoryStore({ storage });
    ok(store.policy().rawPromptCaching === true, "policy() alone answers from the defaults until the store has loaded (which is why effectivePolicy() exists)");
    const policy = await store.effectivePolicy();
    ok(policy.rawPromptCaching === false && policy.maxConversations === 7, "effectivePolicy() returns the persisted record after the first load");
  }

  console.log("== privacy switch (history screen): pressing it reaches the store, and dropping previews is real ==");
  {
    const storage = fakeChromeStorage();
    const store = new HistoryStore({ storage });
    const doc = createDocument();
    const toggle = doc.createElement("input");
    const outcome = doc.createElement("p");
    const controls = new HistoryPrivacyControls({ store, toggle, outcome });
    await controls.sync();
    ok(toggle.checked === false, "with the default policy the switch is off — caching is ON, and the control says so by being off");

    await store.upsert({ conversationId: "c1", title: "việc riêng tư" });
    await store.recordPrompt("c1", "r1", "nội dung tôi đã hỏi");
    ok((await store.promptsFor("c1")).size === 1, "sanity: the prompt is cached while caching is on");

    // The operator presses the switch: one DOM event, nothing else.
    toggle.checked = true;
    toggle.dispatchEvent({ type: "change" });
    await waitUntil(() => store.policy().rawPromptCaching === false);
    ok(store.policy().rawPromptCaching === false, "the switch disabled raw-prompt caching in the store");
    ok((await store.promptsFor("c1")).size === 0, "…and the previews it had already cached are dropped, not merely stopped");
    ok((await store.get("c1")).previewSuppressed === true, "the conversation still lists, marked preview-suppressed");
    ok(storage._dump()[HISTORY_POLICY_KEY].rawPromptCaching === false, "the choice is persisted, so it survives a panel restart");

    await store.recordPrompt("c1", "r2", "nội dung mới");
    ok((await store.promptsFor("c1")).size === 0, "a later run is not cached either");

    toggle.checked = false;
    toggle.dispatchEvent({ type: "change" });
    await waitUntil(() => store.policy().rawPromptCaching === true);
    await store.recordPrompt("c1", "r3", "bật lại rồi");
    ok((await store.promptsFor("c1")).get("r3") === "bật lại rồi", "switching it back resumes caching");

    // A panel restart: a fresh store over the same storage, and the switch
    // must show the persisted choice rather than the default.
    await store.setRawPromptCachingEnabled(false);
    const reopenedStore = new HistoryStore({ storage });
    const reopenedToggle = createDocument().createElement("input");
    const reopened = new HistoryPrivacyControls({ store: reopenedStore, toggle: reopenedToggle });
    await reopened.sync();
    ok(reopenedToggle.checked === true, "after a restart the switch reads the persisted policy (caching disabled => switch on)");
    controls.destroy();
    reopened.destroy();
  }

  console.log("== retention: count limit archives the oldest eligible entry (prompts dropped, row kept) ==");
  {
    const storage = fakeChromeStorage();
    // A fixed `now` keeps the TTL branch out of the way and makes "oldest"
    // unambiguous (realistic timestamps: a policy test must not accidentally
    // exercise a different policy branch).
    const now = 1_700_000_000_000;
    const store = new HistoryStore({ storage, now: () => now, policy: { maxConversations: 2, archiveOnEvict: true } });
    await store.upsert({ conversationId: "old", title: "cũ", updatedAt: now - 3000 });
    await store.recordPrompt("old", "r1", "nội dung dài ".repeat(50));
    await store.upsert({ conversationId: "mid", title: "giữa", updatedAt: now - 2000 });
    await store.upsert({ conversationId: "new", title: "mới", updatedAt: now - 1000 });

    const list = await store.list();
    ok(list.length === 3, "every row survives (archived, not deleted)");
    const oldest = list.find((c) => c.conversationId === "old");
    ok(oldest.archived === true && oldest.evicted === true, "the oldest eligible entry was the one evicted");
    ok(Object.keys(oldest.prompts).length === 0, "its cached preview bytes are what got reclaimed");
    ok(!list.find((c) => c.conversationId === "new").archived, "the newest entry is untouched");
    const report = store.evictionReport();
    ok(report.length === 1 && report[0].conversationId === "old" && report[0].outcome === "archived", "the eviction is reported so the user can see the outcome");
  }

  console.log("== retention: remove-on-evict and the TTL policy ==");
  {
    const now = () => 1_700_000_000_000;
    const store = new HistoryStore({
      storage: fakeChromeStorage(),
      now,
      policy: { maxConversations: 1, archiveOnEvict: false, ttlDays: 0 }
    });
    await store.upsert({ conversationId: "old", updatedAt: now() - 2000 });
    await store.upsert({ conversationId: "new", updatedAt: now() - 1000 });
    const list = await store.list();
    ok(list.length === 1 && list[0].conversationId === "new", "remove-on-evict actually drops the oldest row");

    const ttlStore = new HistoryStore({
      storage: fakeChromeStorage(),
      now,
      policy: { maxConversations: 100, archiveOnEvict: false, ttlDays: 30 }
    });
    const day = 24 * 60 * 60 * 1000;
    await ttlStore.upsert({ conversationId: "stale", updatedAt: now() - 40 * day });
    await ttlStore.upsert({ conversationId: "fresh", updatedAt: now() - 1 * day });
    const ttlList = await ttlStore.list();
    ok(ttlList.length === 1 && ttlList[0].conversationId === "fresh", "an entry untouched for longer than the TTL is evicted; a fresh one is not");
  }

  console.log("== retention outcome (history screen): what retention did is visible, and honest about where the conversations are ==");
  {
    ok(retentionSummaryText([]) === "", "nothing evicted renders as nothing — the line stays hidden rather than announcing a non-event");
    const summary = retentionSummaryText([
      { conversationId: "a", outcome: EVICTION_OUTCOME.ARCHIVED },
      { conversationId: "b", outcome: EVICTION_OUTCOME.ARCHIVED },
      { conversationId: "c", outcome: EVICTION_OUTCOME.REMOVED }
    ]);
    ok(/lưu trữ 2 và xóa 1/.test(summary), `the summary counts each outcome (${summary})`);
    ok(/companion/.test(summary), "…and says the conversations themselves are still on the companion, so it cannot read as data loss");
    ok(/lưu trữ 1/.test(retentionSummaryText([{ conversationId: "a", outcome: EVICTION_OUTCOME.ARCHIVED }])), "an archive-only outcome says so");
    ok(/xóa 1/.test(retentionSummaryText([{ conversationId: "a", outcome: EVICTION_OUTCOME.REMOVED }])), "a remove-only outcome says so");

    const now = () => 1_700_000_000_000;
    const store = new HistoryStore({
      storage: fakeChromeStorage(),
      now,
      policy: { maxConversations: 2, archiveOnEvict: true, ttlDays: 0 }
    });
    const doc = createDocument();
    const outcome = doc.createElement("p");
    const controls = new HistoryPrivacyControls({ store, outcome });
    await store.upsert({ conversationId: "old", title: "cũ", updatedAt: now() - 3000 });
    await store.upsert({ conversationId: "mid", title: "giữa", updatedAt: now() - 2000 });
    await controls.sync();
    ok(outcome.hidden === true && outcome.textContent === "", "with nothing evicted yet the line stays hidden");

    // A third conversation crosses the count limit. The store's own
    // notification — no reopen, no manual refresh — is what makes the line
    // appear, so the outcome cannot go missing while the screen is open.
    await store.upsert({ conversationId: "new", title: "mới", updatedAt: now() - 1000 });
    ok(store.evictionReport().length === 1 && store.evictionReport()[0].outcome === EVICTION_OUTCOME.ARCHIVED, "sanity: retention archived the oldest eligible conversation");
    ok(outcome.hidden === false && /lưu trữ 1/.test(outcome.textContent), `the outcome line shows up as soon as retention acts (${outcome.textContent})`);
    ok((await store.list()).length === 3, "…over a list that still shows every conversation (archived, not deleted)");

    // A policy that removes instead of archiving must say THAT, not "archived".
    const removingStore = new HistoryStore({
      storage: fakeChromeStorage(),
      now,
      policy: { maxConversations: 0, archiveOnEvict: false, ttlDays: 0 }
    });
    const removingOutcome = createDocument().createElement("p");
    const removing = new HistoryPrivacyControls({ store: removingStore, outcome: removingOutcome });
    await removingStore.upsert({ conversationId: "gone", updatedAt: now() - 1000 });
    await removing.sync();
    ok(/xóa 1/.test(removingOutcome.textContent), `a remove-on-evict policy reports a removal (${removingOutcome.textContent})`);
    controls.destroy();
    removing.destroy();
  }

  console.log("== reachability: the shipped panel offers these controls (the store-only gap, closed) ==");
  {
    // The store half is proven above; this is the claim that an operator can
    // actually REACH it. sidepanel.js has no importable surface (it touches
    // document/chrome.* at module scope), so the wiring contract is asserted
    // the way test/composer-enhance-prompt.test.mjs asserts the composer's:
    // the markup carries the control, and the panel binds that exact id.
    const html = fs.readFileSync(path.join(ROOT, "extension", "sidepanel", "sidepanel.html"), "utf8");
    const panelJs = fs.readFileSync(path.join(ROOT, "extension", "sidepanel", "sidepanel.js"), "utf8");
    ok(/<input[^>]*id="history-privacy-toggle"[^>]*aria-label="[^"]+"/.test(html), "the history screen's switch exists and carries an accessible name");
    ok(/id="history-retention-outcome"[^>]*role="status"/.test(html), "the retention outcome line exists as a status region — the user can see the outcome");
    ok(
      /historyPrivacyToggle:\s*\$\("history-privacy-toggle"\)/.test(panelJs) &&
        /historyRetentionOutcome:\s*\$\("history-retention-outcome"\)/.test(panelJs),
      "both ids are registered in the panel's element map, so the markup and the wiring cannot drift apart"
    );
    ok(/new HistoryPrivacyControls\(\{[^}]*store:\s*historyStore/.test(panelJs), "the panel binds them to the real HistoryStore — not to a second, decorative copy of the policy");
    ok(/await historyPrivacy\.sync\(\)/.test(panelJs), "and syncs them on every history refresh, so a policy changed in another panel is reflected here too");
  }

  console.log("== reconcile: host summaries win, orphans are marked stale (never listed as reopenable) ==");
  {
    const store = new HistoryStore({ storage: fakeChromeStorage() });
    await store.upsert({ conversationId: "host-1", title: "tên cũ" });
    await store.recordPrompt("host-1", "r1", "câu hỏi cũ");
    await store.upsert({ conversationId: "orphan", title: "chỉ có cục bộ" });

    const result = await store.reconcile([
      { conversationId: "host-1", title: "tên từ máy chủ", hostname: "example.com", pinned: true, archived: false, revision: 3, updatedAt: 5000, interrupted: false }
    ]);
    const list = await store.list();
    const hostEntry = list.find((c) => c.conversationId === "host-1");
    ok(hostEntry.title === "tên từ máy chủ" && hostEntry.hostname === "example.com", "the host's title/hostname replace the local guess");
    ok(hostEntry.pinned === true && hostEntry.revision === 3, "host pin state and revision are mirrored");
    ok(hostEntry.stale === false, "a conversation the host reports is not stale");
    ok((await store.promptsFor("host-1")).get("r1") === "câu hỏi cũ", "the local-only prompt echo survives a reconcile (the host never persists it)");
    const orphan = list.find((c) => c.conversationId === "orphan");
    ok(orphan && orphan.stale === true, "a local entry the host does not report is marked stale, never presented as reopenable");
    ok(result.orphans.includes("orphan") && result.reconciled === 1, "the reconcile reports what it reconciled and what it orphaned");
    // Marked orphans keep their last-known previews (the host record is
    // exactly what is unavailable for them) — see the method docstring.
    ok(orphan.prompts !== undefined, "the orphan keeps the last-known local preview rather than silently emptying");
  }

  console.log("== reconcile: orphanPolicy 'remove' drops them instead ==");
  {
    const store = new HistoryStore({ storage: fakeChromeStorage(), policy: { orphanPolicy: "remove" } });
    await store.upsert({ conversationId: "orphan" });
    const result = await store.reconcile([]);
    ok(result.removed.includes("orphan") && (await store.list()).length === 0, "the orphan row is removed, not merely marked");
  }

  console.log("== hasData: 'this conversation holds nothing' is cached as a fact, and never invented ==");
  {
    const storage = fakeChromeStorage();
    const store = new HistoryStore({ storage });
    await store.reconcile([
      { conversationId: "used", updatedAt: 3000, hasData: true },
      { conversationId: "empty", updatedAt: 2000, hasData: false },
      // An older companion's summary: it has never heard of the field.
      { conversationId: "old-host", updatedAt: 1000 }
    ]);
    const list = await store.list();
    ok(list.find((e) => e.conversationId === "used").hasData === true, "a summary that carries hasData:true is cached as true");
    ok(list.find((e) => e.conversationId === "empty").hasData === false, "a summary that carries hasData:false is cached as false (its row will not render)");
    ok(list.find((e) => e.conversationId === "old-host").hasData === null, "a summary WITHOUT the field leaves the value unknown (null) — an old companion must never hide anything");

    // The panel's own model is the other source of this fact.
    await store.upsert({ conversationId: "local", hasData: false });
    ok((await store.get("local")).hasData === false, "upsert() records a model with no items as known-empty");
    await store.upsert({ conversationId: "local", title: "vẫn rỗng" });
    ok((await store.get("local")).hasData === false, "a later upsert that says nothing about data keeps what the entry knew");
    await store.upsert({ conversationId: "local", hasData: true });
    ok((await store.get("local")).hasData === true, "the first question's upsert flips it to true");
    await store.upsert({ conversationId: "local", title: "câu hỏi đầu tiên" });
    ok((await store.get("local")).hasData === true, "…which the next silent upsert does not undo");

    // A reconcile against an older companion must not reset a value this
    // panel already knows: silence is not "empty".
    await store.reconcile([{ conversationId: "used", updatedAt: 4000 }, { conversationId: "empty", updatedAt: 4000 }]);
    ok((await store.get("used")).hasData === true && (await store.get("empty")).hasData === false, "a field-less summary keeps each entry's previous judgement instead of erasing it");

    // An orphan keeps its own value too — it is the STALE badge, not this
    // field, that tells the operator the host no longer has the record.
    await store.upsert({ conversationId: "orphan", hasData: true });
    await store.reconcile([]);
    const orphan = await store.get("orphan");
    ok(orphan.stale === true && orphan.hasData === true, "an orphan keeps the data judgement it had (reconcile marks it stale, nothing else)");

    // (f) A reload: a fresh store over the same storage serialized the way
    // chrome.storage really does (JSON), so "hidden stays hidden" is proven
    // across a real boundary rather than through a shared object reference.
    const reloaded = new HistoryStore({ storage: fakeChromeStorage(JSON.parse(JSON.stringify(storage._dump()))) });
    const afterReload = await reloaded.list();
    ok(afterReload.find((e) => e.conversationId === "empty").hasData === false, "a known-empty entry is still known-empty after a store reload");
    ok(afterReload.find((e) => e.conversationId === "used").hasData === true, "…and one with data still has data");
    ok(afterReload.find((e) => e.conversationId === "old-host").hasData === null, "…and unknown stays unknown across the reload too");
  }

  console.log("== migration: a v1 single-key index is read once, rewritten per-conversation, then dropped ==");
  {
    const storage = fakeChromeStorage({
      ocic_conversation_history_v1: [
        { conversationId: "legacy-1", title: "cũ 1", hostname: "a.com", createdAt: 10, updatedAt: Date.now() - 86400000, prompts: { r1: "câu hỏi" } },
        { conversationId: "legacy-2", title: "cũ 2", createdAt: 11, updatedAt: Date.now() - 3600000, deletedLocally: true }
      ]
    });
    const store = new HistoryStore({ storage });
    const list = await store.list();
    ok(list.length === 2, "both legacy conversations are readable through the new store");
    const migrated = list.find((c) => c.conversationId === "legacy-1");
    ok(migrated.title === "cũ 1" && migrated.hostname === "a.com" && migrated.createdAt === 10, "legacy fields survive the migration intact");
    ok((await store.promptsFor("legacy-1")).get("r1") === "câu hỏi", "the legacy prompt echo survives");
    ok(list.find((c) => c.conversationId === "legacy-2").deletedLocally === true, "the legacy deletedLocally flag is preserved");
    ok(storage._dump()["ocic_conversation_history_v1"] === undefined, "the legacy key is removed after migration");
    ok(storage._dump()[`${HISTORY_ENTRY_KEY_PREFIX}legacy-1`] !== undefined, "each migrated conversation now has its OWN versioned key");
    ok(storage._dump()[HISTORY_POLICY_KEY].migratedFromV1 === true, "the migration is recorded so it cannot run twice");
    ok(store.migrationState().migrated === true && store.migrationState().fromVersion === 1, "the store reports that it migrated a v1 index");

    // A second store over the same storage must NOT re-migrate (the marker is
    // the guard; the legacy key is gone anyway).
    const second = new HistoryStore({ storage });
    ok((await second.list()).length === 2, "a fresh store reads the migrated entries from their v2 keys");
    ok(second.migrationState().migrated === false, "and does not consider itself a migrator");
  }

  console.log("== quota / write failure: the change is kept and retried, never silently dropped ==");
  {
    let failWrites = true;
    const backing = fakeChromeStorage();
    const storage = {
      async get(key) {
        return backing.get(key);
      },
      async set(obj) {
        if (failWrites) throw new Error("QUOTA_BYTES quota exceeded");
        return backing.set(obj);
      },
      async remove(keys) {
        return backing.remove(keys);
      }
    };
    const store = new HistoryStore({ storage, flushDelayMs: 10 });
    await store.upsert({ conversationId: "c1", title: "quan trọng" });
    await new Promise((r) => setTimeout(r, 30));
    ok((await store.list()).length === 1, "a failed write never loses the in-memory row");
    failWrites = false;
    await store.flushNow();
    ok(backing._dump()[`${HISTORY_ENTRY_KEY_PREFIX}c1`] !== undefined, "the next successful flush persists what the failed one could not");
  }

  console.log("== restart: a new store over the same storage sees the flushed cache ==");
  {
    const storage = fakeChromeStorage();
    const first = new HistoryStore({ storage });
    await first.upsert({ conversationId: "c1", title: "trước khi khởi động lại" });
    await first.recordPrompt("c1", "r1", "câu hỏi");
    await first.flushNow();

    const second = new HistoryStore({ storage });
    const list = await second.list();
    ok(list.length === 1 && list[0].title === "trước khi khởi động lại", "the flushed conversation survives a store restart");
    ok((await second.promptsFor("c1")).get("r1") === "câu hỏi", "the flushed prompt echo survives too");
  }

  console.log("== cross-panel convergence: a concurrent panel's write is adopted, a pending local write is never clobbered ==");
  {
    const storage = fakeChromeStorage();
    const listeners = [];
    const previousChrome = globalThis.chrome;
    globalThis.chrome = { storage: { onChanged: { addListener: (fn) => listeners.push(fn) } } };
    try {
      const store = new HistoryStore({ storage, flushDelayMs: 1000 });
      await store.upsert({ conversationId: "remote", title: "cũ" });
      await store.upsert({ conversationId: "local", title: "cục bộ" });
      // A second update to an EXISTING row rides the debounce window, so the
      // key is genuinely pending (dirty) when the remote write arrives.
      await store.upsert({ conversationId: "local", title: "cục bộ mới" });
      ok(listeners.length === 1, "the store subscribed to chrome.storage.onChanged so another panel's writes are seen without a re-read");

      listeners[0](
        { [`${HISTORY_ENTRY_KEY_PREFIX}local`]: { newValue: { conversationId: "local", title: "từ tab khác", updatedAt: 9999 } } },
        "local"
      );
      ok((await store.get("local")).title === "cục bộ mới", "a remote write to a key we have pending locally is ignored (no lost local update)");
      await store.flushNow();
      ok(storage._dump()[`${HISTORY_ENTRY_KEY_PREFIX}local`].title === "cục bộ mới", "and it is what gets persisted");

      // A key this panel is not editing is adopted immediately.
      listeners[0](
        { [`${HISTORY_ENTRY_KEY_PREFIX}remote`]: { newValue: { conversationId: "remote", title: "mới từ tab khác", updatedAt: 10000 } } },
        "local"
      );
      ok((await store.get("remote")).title === "mới từ tab khác", "a remote write to a key we are not editing is adopted");
      listeners[0]({ [`${HISTORY_ENTRY_KEY_PREFIX}remote`]: { newValue: undefined } }, "local");
      ok((await store.get("remote")) === null, "a remote DELETE is adopted too (the row disappears)");
      listeners[0]({ [`${HISTORY_ENTRY_KEY_PREFIX}remote`]: { newValue: { conversationId: "remote" } } }, "session");
      ok((await store.get("remote")) === null, "a change from a different storage area (session) is ignored entirely");
    } finally {
      if (previousChrome === undefined) delete globalThis.chrome;
      else globalThis.chrome = previousChrome;
    }
  }

  console.log("== a storage failure degrades to an empty list rather than throwing ==");
  {
    const brokenStorage = {
      async get() {
        throw new Error("storage unavailable");
      },
      async set() {
        throw new Error("storage unavailable");
      },
      async remove() {
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
    ok(!threw && Array.isArray(list) && list.length === 0, "an unreadable storage backend never crashes the panel");
  }

  console.log("== last-active conversation identity is scoped per panel (scope-conversation-restore-per-tab) ==");
  {
    // Last-active lives in a SEPARATE session-lifetime store from the
    // conversation cache, so it is injected via its own `sessionStorage`
    // dependency rather than the `storage` used for list()/upsert() above.
    const store = new HistoryStore({ storage: fakeChromeStorage(), sessionStorage: fakeChromeStorage() });
    ok((await store.getLastActive("scope-a")) === null, "a fresh store has no remembered last-active id for a scope it has never seen");

    await store.setLastActive("scope-a", "c1");
    ok((await store.getLastActive("scope-a")) === "c1", "set/get round-trips the last-active id for that scope");

    ok((await store.getLastActive("scope-b")) === null, "a different, never-written scope still reads null — one scope's write never leaks into another's");

    await store.setLastActive("scope-b", "c2");
    ok((await store.getLastActive("scope-a")) === "c1" && (await store.getLastActive("scope-b")) === "c2", "two scopes round-trip independently under the same storage");

    await store.setLastActive("scope-a", null);
    ok((await store.getLastActive("scope-a")) === null, "setLastActive(scope, null) forgets the remembered id for that scope");
    ok((await store.getLastActive("scope-b")) === "c2", "clearing one scope leaves the other scope's entry intact");
  }

  console.log("== stale last-active keys are swept on tab removal (tasks.md 2.3) ==");
  {
    const sessionStorage = fakeChromeStorage();
    const store = new HistoryStore({ storage: fakeChromeStorage(), sessionStorage });
    await store.setLastActive("1", "c1");
    await store.setLastActive("2", "c2");
    await store.setLastActive("3", "c3");

    await store.forgetLastActive("2");
    ok((await store.getLastActive("2")) === null, "forgetLastActive drops exactly that scope's key");
    ok((await store.getLastActive("1")) === "c1" && (await store.getLastActive("3")) === "c3", "the other scopes' keys are untouched");

    const pruned = await store.pruneLastActive(["1", "3", "99"]);
    ok(pruned.length === 0, "pruning with every live scope present removes nothing");
    const pruned2 = await store.pruneLastActive(["1"]);
    ok(pruned2.includes("3") && !pruned2.includes("1"), "a scope whose tab is gone is pruned; a live one is kept");
    ok((await store.getLastActive("3")) === null, "the pruned scope really reads null afterwards");
    ok((await store.pruneLastActive([])).length === 0, "an EMPTY live-scope list is treated as 'cannot tell', never as 'sweep everything'");
    ok((await store.getLastActive("1")) === "c1", "so the surviving scope's key is still there");
  }

  console.log("== an unidentifiable scope never touches storage (spec \"No identifiable scope\") ==");
  {
    const store = new HistoryStore({ storage: fakeChromeStorage(), sessionStorage: fakeChromeStorage() });
    ok((await store.getLastActive(null)) === null, "a null scope reads null without needing any prior write");
    ok((await store.getLastActive(undefined)) === null, "an undefined scope reads null the same way");
    let threw = false;
    try {
      await store.setLastActive(null, "c1");
      await store.forgetLastActive(null);
    } catch {
      threw = true;
    }
    ok(!threw, "setLastActive/forgetLastActive with a null scope are safe no-ops, never throws");
    ok((await store.getLastActive("scope-a")) === null, "the no-op write for a null scope never lands under some other scope");
  }

  console.log("== last-active storage failures never propagate (a broken chrome.storage.session must not block opening the panel) ==");
  {
    const brokenStorage = {
      async get() {
        throw new Error("storage unavailable");
      },
      async set() {
        throw new Error("storage unavailable");
      },
      async remove() {
        throw new Error("storage unavailable");
      }
    };
    const store = new HistoryStore({ storage: fakeChromeStorage(), sessionStorage: brokenStorage });
    let threw = false;
    let id = "not-yet-read";
    let pruned = null;
    try {
      id = await store.getLastActive("scope-a");
      await store.setLastActive("scope-a", "c1");
      await store.forgetLastActive("scope-a");
      pruned = await store.pruneLastActive(["scope-a"]);
    } catch {
      threw = true;
    }
    ok(!threw && id === null, "getLastActive() on a broken session storage backend resolves to null, never a throw");
    ok(Array.isArray(pruned) && pruned.length === 0, "a prune against an unreadable backend is a no-op, not a throw");
  }

  console.log("== last-active degrades to in-memory when chrome.storage.session is entirely absent ==");
  {
    // Neither `storage` nor `sessionStorage` is injected, and this test runs
    // under plain `node` (no `chrome` global) — the constructor's own
    // `hasChromeSessionStorage()` fallback must produce a working, isolated
    // in-memory store rather than throwing at construction or on first use.
    const store = new HistoryStore();
    ok((await store.getLastActive("scope-a")) === null, "no chrome.storage.session present still resolves to null rather than throwing");
    await store.setLastActive("scope-a", "c1");
    ok((await store.getLastActive("scope-a")) === "c1", "the in-memory fallback still round-trips within the life of this store instance");
  }

  console.log(fail === 0 ? "\nALL SIDEPANEL HISTORY-STORE TESTS PASSED" : `\n${fail} FAILED`);
  process.exit(fail ? 1 : 0);
}

main();
