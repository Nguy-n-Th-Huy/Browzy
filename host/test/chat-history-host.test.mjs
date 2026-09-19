#!/usr/bin/env node
// Host half of openspec/changes/optimize-chat-history:
//   1.1 authoritative summaries + presentation metadata (revision/title/
//       hostname/pinned/archived/updated)
//   1.3 delete / delete-all with idempotency, and failures that never report
//       success
//   3.1 batched meta.json writes that still preserve durable event sequences
//       across a restart (no duplicate seq, ever)
//   3.2 sequence-window transcript loading / lazy older pages
//
// Everything here runs against the REAL TranscriptStore / SessionManager /
// CompanionCore. Only the SDK query() generator and the settings profile are
// fakes (no live API key or browser in this environment), exactly as
// host/test/agent-companion-core.test.mjs and test/sidepanel-fake-companion
// .test.mjs already do.
//
// Run: node host/test/chat-history-host.test.mjs

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { CompanionCore } from "../agent/companion.js";
import { TranscriptStore } from "../agent/storage/transcript-store.js";
import { BrowserLease } from "../agent/broker/browser-lease.js";
import { ApprovalRegistry } from "../agent/policy/approvals.js";
import { SessionManager } from "../agent/session/manager.js";
import { ToolBridge } from "../agent/broker/tool-bridge.js";
import { AGENT_MESSAGE_TYPES, makeEnvelope } from "../agent/protocol.js";
import { conversationEventsFile, conversationMetaFile } from "../agent/storage/paths.js";

const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ocic-chat-history-host-"));
process.env.OCIC_AGENT_HOME = scratchRoot;

let fail = 0;
function ok(cond, msg) {
  console.log((cond ? "  PASS " : "  FAIL ") + msg);
  if (!cond) fail++;
}

function fakeProfileProvider() {
  return {
    async snapshotForRun() {
      return {
        profileId: "default",
        baseUrl: "https://example.invalid",
        modelId: "fake-model",
        credential: "fake-key",
        skills: null
      };
    }
  };
}

function fakeSdk() {
  return {
    async *query() {
      yield { type: "result", subtype: "success", result: "ok" };
    }
  };
}

/** A real CompanionCore over the shared scratch OCIC_AGENT_HOME. */
function buildCore() {
  const store = new TranscriptStore();
  const lease = new BrowserLease();
  const approvals = new ApprovalRegistry();
  const sessionManager = new SessionManager({ store, lease, approvals });
  const toolBridge = new ToolBridge({
    init: async () => {},
    callTool: async () => ({ content: [{ type: "text", text: "fake" }] }),
    shutdown: () => {}
  });
  return new CompanionCore({
    toolBridge,
    sessionManager,
    lease,
    coerceArgs: (a) => a,
    sdk: fakeSdk(),
    profileProvider: fakeProfileProvider()
  });
}

async function handshake(core) {
  return core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.HELLO, { installationId: "i", connectionId: "c" }));
}

async function main() {
  console.log("== 1.1 presentation metadata: written once, revisioned, readable through the summary list ==");
  {
    const core = buildCore();
    await handshake(core);
    const created = await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.NEW, { meta: {} }));
    const conversationId = created.conversationId;

    const first = await core.handleEnvelope(
      makeEnvelope(AGENT_MESSAGE_TYPES.UPDATE_CONVERSATION, { conversationId, title: "Tóm tắt bài báo", hostname: "vnexpress.net" })
    );
    ok(first.ok === true && first.revision === 1, "the first metadata write is accepted with revision 1");

    const withRevision = await core.handleEnvelope(
      makeEnvelope(AGENT_MESSAGE_TYPES.UPDATE_CONVERSATION, { conversationId, title: "Tên mới", ifRevision: 1 })
    );
    ok(withRevision.ok === true && withRevision.revision === 2, "an ifRevision guard matching the current revision is accepted and bumps it");

    const conflict = await core.handleEnvelope(
      makeEnvelope(AGENT_MESSAGE_TYPES.UPDATE_CONVERSATION, { conversationId, title: "Tên cũ hơn", ifRevision: 1 })
    );
    ok(conflict.ok === false && conflict.reason === "revision_conflict" && conflict.revision === 2, "a stale ifRevision is REJECTED with the current revision, never silently applied");

    const pinned = await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.UPDATE_CONVERSATION, { conversationId, pinned: true }));
    ok(pinned.ok === true, "pin is settable on its own");

    const listed = await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.LIST_CONVERSATIONS, {}));
    const summary = listed.conversations.find((c) => c.conversationId === conversationId);
    ok(!!summary, "the conversation appears in the authoritative list");
    ok(summary.title === "Tên mới" && summary.hostname === "vnexpress.net", "...carrying the host's own title/hostname");
    ok(summary.pinned === true && summary.archived === false && summary.revision === pinned.revision, "...plus pinned/archived and the revision");
    ok(typeof summary.updatedAt === "number" && typeof summary.createdAt === "number", "...and the timestamps the panel renders");
    ok(listed.total >= 1 && typeof listed.hasMore === "boolean", "the list reply carries total/hasMore so a capped reply is distinguishable from a complete one");

    // Validation at the wire boundary: junk is rejected, not stored.
    const badTitle = await core.handleEnvelope(
      makeEnvelope(AGENT_MESSAGE_TYPES.UPDATE_CONVERSATION, { conversationId, title: "x".repeat(5000) })
    );
    ok(badTitle.ok === false && badTitle.reason === "conversation_title_too_long", "an over-long title is rejected at the wire boundary");
    const badPin = await core.handleEnvelope(
      makeEnvelope(AGENT_MESSAGE_TYPES.UPDATE_CONVERSATION, { conversationId, pinned: "yes" })
    );
    ok(badPin.ok === false && badPin.reason === "malformed_conversation_pinned", "a non-boolean pin is rejected rather than coerced");
    const unknown = await core.handleEnvelope(
      makeEnvelope(AGENT_MESSAGE_TYPES.UPDATE_CONVERSATION, { conversationId: "conv_missing", title: "x" })
    );
    ok(unknown.ok === false && unknown.reason === "unknown_conversation", "a metadata write for an unknown conversation fails honestly");
  }

  console.log("== 3.1 batched meta writes still preserve the durable event sequence across a restart ==");
  {
    const store = new TranscriptStore({ metaFlushDelayMs: 100000 }); // never auto-flush: prove the batching
    const id = "conv_batching";
    store.createConversation(id);
    const before = JSON.parse(fs.readFileSync(conversationMetaFile(id), "utf-8"));

    const stored = [];
    for (let i = 0; i < 5; i++) stored.push(store.appendEvent(id, { type: "stream_message", i }).seq);
    const after = JSON.parse(fs.readFileSync(conversationMetaFile(id), "utf-8"));
    ok(stored.join(",") === "1,2,3,4,5", "sequence numbers are allocated monotonically in-process");
    ok(after.lastSeq === before.lastSeq, `meta.json was NOT rewritten per event (lastSeq still ${after.lastSeq} after 5 appends)`);
    ok(fs.readFileSync(conversationEventsFile(id), "utf-8").split("\n").filter(Boolean).length === 5, "every event is still durable in the append-only log");

    // A lifecycle write (a run terminal does exactly this) flushes the cursor.
    store.updateMeta(id, { activeRunId: null });
    ok(JSON.parse(fs.readFileSync(conversationMetaFile(id), "utf-8")).lastSeq === 5, "an explicit metadata write flushes the true lastSeq");

    // Simulate a crash BEFORE any flush: a fresh process over the same files
    // must allocate seq 6, never a duplicate.
    const id2 = "conv_crash";
    store.createConversation(id2);
    store.appendEvent(id2, { type: "run_created", runId: "r1" });
    store.appendEvent(id2, { type: "run_started", runId: "r1" });
    const preCrashMeta = JSON.parse(fs.readFileSync(conversationMetaFile(id2), "utf-8"));
    ok(preCrashMeta.lastSeq === 0, "the crash scenario really left meta.json's cursor behind the log");

    const restarted = new TranscriptStore();
    const seq = restarted.appendEvent(id2, { type: "stream_message", text: "after restart" }).seq;
    ok(seq === 3, `the restarted store allocated seq 3 from the LOG, not from the stale meta cursor (got ${seq})`);
    const seqs = restarted
      .eventsAfter(id2, 0)
      .map((e) => e.seq)
      .filter((s) => s === seq);
    ok(seqs.length === 1, "no two events share a sequence number");
    const allSeqs = restarted.eventsAfter(id2, 0).map((e) => e.seq);
    ok(new Set(allSeqs).size === allSeqs.length, "the whole log is duplicate-free after the restart");

    // And a metadata write (recoverAfterRestart's own updateMeta) must not
    // poison the allocator with the stale on-disk cursor either.
    const store3 = new TranscriptStore();
    const id3 = "conv_meta_poison";
    store3.createConversation(id3);
    store3.appendEvent(id3, { type: "run_created", runId: "r1" });
    store3.appendEvent(id3, { type: "run_started", runId: "r1" });
    store3.appendEvent(id3, { type: "stream_message", text: "x" });
    store3.updateMeta(id3, { activeRunId: null, interrupted: true });
    ok(JSON.parse(fs.readFileSync(conversationMetaFile(id3), "utf-8")).lastSeq === 3, "a metadata write reconciles the cursor from the log before persisting");
  }

  console.log("== hasData: summaries say whether a conversation holds ANY data, without hiding the empty ones ==");
  {
    const core = buildCore();
    await handshake(core);
    const listAll = async () =>
      (await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.LIST_CONVERSATIONS, {}))).conversations;

    const emptyId = (await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.NEW, { meta: {} }))).conversationId;
    let summary = (await listAll()).find((c) => c.conversationId === emptyId);
    ok(!!summary && summary.hasData === false, "a freshly created conversation reports hasData:false");
    ok((await listAll()).every((c) => typeof c.hasData === "boolean"), "...and every summary carries the field as a boolean");

    // The FIRST event lands in the log while meta.json's cursor is still
    // deferred (task 3.1) — exactly the window in which a disk-only answer
    // would wrongly call this conversation empty and hide a real run.
    const store = core.sessionManager.store;
    store.flushAllMeta();
    store.appendEvent(emptyId, { type: "run_created", runId: "run_has_data" });
    ok(JSON.parse(fs.readFileSync(conversationMetaFile(emptyId), "utf-8")).lastSeq === 0, "the appended event has NOT been flushed to meta.json (the deferred window is real)");
    summary = (await listAll()).find((c) => c.conversationId === emptyId);
    ok(summary && summary.hasData === true, "an appendEvent flips hasData to true through the LIVE allocator, before any meta write");

    // The same answer must survive a restart: the LOG, not the unflushed
    // cursor, is the authority on what a conversation holds.
    const restarted = new TranscriptStore({ metaFlushDelayMs: 100000 });
    const restartedMeta = restarted.listConversations().find((m) => m.conversationId === emptyId);
    ok(restartedMeta && restartedMeta.hasData === true, "a store that never saw the append still reports hasData:true, reading the log");

    // A conversation with NO data is still LISTED and still reported — the
    // host never filters its own list, or a page of empty conversations would
    // push real ones out of the panel's paging window.
    const listedWithEmpty = await listAll();
    ok(listedWithEmpty.some((c) => c.conversationId === emptyId), "an empty conversation stays in the list");
    const freshEmpty = (await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.NEW, { meta: {} }))).conversationId;
    const capped = await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.LIST_CONVERSATIONS, { limit: 1 }));
    ok(capped.conversations.length === 1 && capped.conversations[0].conversationId === freshEmpty, "a capped page returns the newest conversation even when it is empty");
    ok(capped.conversations[0].hasData === false && capped.total > capped.conversations.length, "...graded honestly, with total/hasMore still describing the whole directory");

    // Deleting an empty conversation still works — it is hidden from the
    // panel's LIST, never from the host's own operations.
    const deleted = await core.handleEnvelope(
      makeEnvelope(AGENT_MESSAGE_TYPES.DELETE_CONVERSATION, { conversationId: freshEmpty, idempotencyKey: "empty-del" })
    );
    ok(deleted.deleted === true && deleted.onDiskRemoved === true, "an empty conversation deletes exactly like any other");
  }

  console.log("== 3.2 sequence-window transcript loading: bounded pages, no gap, no duplicate ==");
  {
    const store = new TranscriptStore({ maxSnapshotEvents: 5 });
    const id = "conv_window";
    store.createConversation(id);
    for (let i = 0; i < 12; i++) store.appendEvent(id, { type: "stream_message", i });

    const head = store.snapshot(id, 0);
    ok(head.events.length === 5, "a cold snapshot returns exactly the bounded newest page");
    ok(head.events.map((e) => e.seq).join(",") === "8,9,10,11,12", "...the NEWEST five, in order");
    ok(head.hasOlder === true && head.firstSeq === 8, "...and says it is a window (hasOlder/firstSeq), not the whole transcript");
    ok(head.lastSeq === 12, "the cursor it reports is the log's true last sequence");

    const page2 = store.transcriptWindow(id, { beforeSeq: head.firstSeq, limit: 5 });
    ok(page2.events.map((e) => e.seq).join(",") === "3,4,5,6,7", "the next older page is the adjacent range (3..7)");
    ok(page2.hasOlder === true, "more history remains below it");
    const page3 = store.transcriptWindow(id, { beforeSeq: page2.firstSeq, limit: 5 });
    ok(page3.events.map((e) => e.seq).join(",") === "1,2", "the final page is the remainder and is short");
    ok(page3.hasOlder === false, "with no older events left, hasOlder is honest");

    const concatenated = [...page3.events, ...page2.events, ...head.events].map((e) => e.seq);
    ok(concatenated.join(",") === "1,2,3,4,5,6,7,8,9,10,11,12", "the pages concatenate to exactly the full log — replay correctness is preserved");
    ok(new Set(concatenated).size === concatenated.length, "no page overlaps another (no duplicate events)");
  }

  console.log("== the operator's own message is part of the durable transcript (so an old conversation reopens complete) ==");
  {
    const core = buildCore();
    await handshake(core);
    const created = await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.NEW, { meta: {} }));
    const conversationId = created.conversationId;

    const prompt = "vì sao hội thoại cũ mở ra lại không thấy câu hỏi?";
    const started = await core.handleEnvelope(
      makeEnvelope(AGENT_MESSAGE_TYPES.START, {
        conversationId,
        prompt,
        profileId: "default",
        modelId: "fake-model",
        tabScope: "any",
        mode: "queue",
        idempotencyKey: "send-1",
        context: { hostname: "vinades.org", tabId: 42 }
      })
    );
    ok(started.type === AGENT_MESSAGE_TYPES.START && !!started.runId, "the send is accepted with a run id");

    const stored = core.sessionManager.store.allEvents(conversationId);
    const submitted = stored.find((e) => e.type === "message_submitted");
    ok(!!submitted, "the transcript records a message_submitted event");
    ok(submitted && submitted.runId === started.runId, "...bound to the run that answers it, not to the conversation in general");
    ok(submitted && submitted.submission && submitted.submission.text === prompt, "...carrying the operator's own text verbatim");
    ok(
      stored.findIndex((e) => e.type === "run_created") < stored.findIndex((e) => e.type === "message_submitted"),
      "...appended AFTER run_created, so a replay has the run id before the message that belongs to it"
    );

    const replayed = core.sessionManager.snapshotSince(conversationId, 0).events;
    const inSnapshot = replayed.find((e) => e.type === "message_submitted");
    ok(inSnapshot && inSnapshot.submission.text === prompt, "a resume/snapshot replay therefore carries the question, not just the answer");

    // The page context captured at submission stays OUT of the durable user
    // bubble: it is trusted metadata the run was launched with, and the panel
    // renders it as a chip from its own state, never as prose the operator
    // "said".
    ok(inSnapshot && !("context" in inSnapshot.submission), "...without smuggling the bound page context into the user's words");

    // A retry of the same send (same idempotency key) must not append a second
    // copy: one message, one durable record.
    await core.handleEnvelope(
      makeEnvelope(AGENT_MESSAGE_TYPES.START, {
        conversationId,
        prompt,
        profileId: "default",
        modelId: "fake-model",
        tabScope: "any",
        mode: "queue",
        idempotencyKey: "send-1",
        context: { hostname: "vinades.org", tabId: 42 }
      })
    );
    const after = core.sessionManager.store.allEvents(conversationId).filter((e) => e.type === "message_submitted");
    ok(after.length === 1, "a duplicate delivery of the same send resolves to the existing record instead of a second bubble");
  }

  console.log("== deletion: confirmed, tombstoned, idempotent — and a missing conversation never reports success ==");
  {
    const core = buildCore();
    await handshake(core);
    const created = await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.NEW, { meta: {} }));
    const conversationId = created.conversationId;
    core.sessionManager.store.appendEvent(conversationId, { type: "stream_message", text: "nội dung" });

    const deleted = await core.handleEnvelope(
      makeEnvelope(AGENT_MESSAGE_TYPES.DELETE_CONVERSATION, { conversationId, idempotencyKey: "key-1" })
    );
    ok(deleted.deleted === true && deleted.onDiskRemoved === true, "a confirmed delete reports deleted:true AND that the bytes are gone");
    ok(!fs.existsSync(path.dirname(conversationEventsFile(conversationId))), "the host data really is removed");
    const listed = await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.LIST_CONVERSATIONS, {}));
    ok(!listed.conversations.some((c) => c.conversationId === conversationId), "and it is gone from the authoritative list");

    // Retrying the SAME idempotency key replays the original success rather
    // than degrading into a failure.
    const retried = await core.handleEnvelope(
      makeEnvelope(AGENT_MESSAGE_TYPES.DELETE_CONVERSATION, { conversationId, idempotencyKey: "key-1" })
    );
    ok(retried.deleted === true, "a retry with the same idempotency key replays the success");

    // A different key on an already-tombstoned conversation is still the
    // desired end state: idempotent success, flagged as such.
    const again = await core.handleEnvelope(
      makeEnvelope(AGENT_MESSAGE_TYPES.DELETE_CONVERSATION, { conversationId, idempotencyKey: "key-2" })
    );
    ok(again.deleted === true && again.alreadyDeleted === true, "a second delete of an already-deleted conversation is an idempotent success");

    // A conversation this host NEVER had must not be reported as deleted.
    const never = await core.handleEnvelope(
      makeEnvelope(AGENT_MESSAGE_TYPES.DELETE_CONVERSATION, { conversationId: "conv_never_existed", idempotencyKey: "key-3" })
    );
    ok(never.deleted !== true && never.reason === "unknown_conversation", "deleting a conversation the host never had FAILS — it is never reported as a successful removal");
  }

  console.log("== 1.3 delete-all: full sweep succeeds, a partial sweep reports failure ==");
  {
    const core = buildCore();
    await handshake(core);
    const a = (await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.NEW, { meta: {} }))).conversationId;
    const b = (await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.NEW, { meta: {} }))).conversationId;
    core.sessionManager.store.appendEvent(a, { type: "stream_message", text: "a" });
    core.sessionManager.store.appendEvent(b, { type: "stream_message", text: "b" });

    const before = (await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.LIST_CONVERSATIONS, {}))).total;
    const swept = await core.handleEnvelope(
      makeEnvelope(AGENT_MESSAGE_TYPES.DELETE_ALL_CONVERSATIONS, { idempotencyKey: "all-1" })
    );
    ok(before >= 2, "sanity: the shared scratch home holds at least this block's two conversations");
    ok(swept.deleted === true && swept.count === before && swept.failed.length === 0, `delete-all removes every conversation and reports the count (got ${swept.count} of ${before})`);
    ok(!fs.existsSync(path.dirname(conversationEventsFile(a))) && !fs.existsSync(path.dirname(conversationEventsFile(b))), "both directories are gone");

    const replay = await core.handleEnvelope(
      makeEnvelope(AGENT_MESSAGE_TYPES.DELETE_ALL_CONVERSATIONS, { idempotencyKey: "all-1" })
    );
    ok(replay.deleted === true && replay.count === swept.count, "the same idempotency key replays the sweep result");

    const empty = await core.handleEnvelope(
      makeEnvelope(AGENT_MESSAGE_TYPES.DELETE_ALL_CONVERSATIONS, { idempotencyKey: "all-2" })
    );
    ok(empty.deleted === true && empty.count === 0, "deleting everything when nothing exists is a success (the end state holds)");

    // Partial failure: a conversation whose removal genuinely fails (the
    // "still-open SDK subprocess handle" case this store's own comment
    // documents) must make the sweep report failure, never `deleted:true`.
    const c = (await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.NEW, { meta: {} }))).conversationId;
    const store = core.sessionManager.store;
    const originalDelete = store.deleteConversation.bind(store);
    store.deleteConversation = (id) => (id === c ? { removed: false } : originalDelete(id));
    const partial = await core.handleEnvelope(
      makeEnvelope(AGENT_MESSAGE_TYPES.DELETE_ALL_CONVERSATIONS, { idempotencyKey: "all-3" })
    );
    store.deleteConversation = originalDelete;
    ok(partial.deleted === false && partial.reason === "partial_failure", "a partial sweep reports deleted:false, never success");
    ok(partial.failed.some((f) => f.conversationId === c), "...naming the conversation that was not removed");
    fs.rmSync(path.dirname(conversationEventsFile(c)), { recursive: true, force: true });
  }

  console.log("== 1.3 delete for an invalid idempotency key fails closed ==");
  {
    const core = buildCore();
    await handshake(core);
    const bad = await core.handleEnvelope(
      makeEnvelope(AGENT_MESSAGE_TYPES.DELETE_ALL_CONVERSATIONS, { idempotencyKey: "x".repeat(500) })
    );
    ok(bad.type === AGENT_MESSAGE_TYPES.ERROR && bad.reason === "malformed_idempotency_key", "an over-long idempotency key is rejected rather than truncated into a collision");
  }

  console.log("== protocol: the new message types are catalogue-known and gated behind hello ==");
  {
    const core = buildCore();
    const notHandshaked = await core.handleEnvelope(
      makeEnvelope(AGENT_MESSAGE_TYPES.DELETE_ALL_CONVERSATIONS, { idempotencyKey: "k" })
    );
    ok(notHandshaked.type === AGENT_MESSAGE_TYPES.VERSION_MISMATCH, "delete-all before hello fails closed like every other session message");
    const windowNoHello = await core.handleEnvelope(
      makeEnvelope(AGENT_MESSAGE_TYPES.TRANSCRIPT_WINDOW_REQUEST, { conversationId: "conv_x" })
    );
    ok(windowNoHello.type === AGENT_MESSAGE_TYPES.VERSION_MISMATCH, "transcript windowing before hello fails closed too");
  }

  console.log("== 3.2 the transcript window request answers through the real companion ==");
  {
    const core = buildCore();
    await handshake(core);
    const created = await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.NEW, { meta: {} }));
    const conversationId = created.conversationId;
    for (let i = 0; i < 8; i++) core.sessionManager.store.appendEvent(conversationId, { type: "stream_message", i });

    const reply = await core.handleEnvelope(
      makeEnvelope(AGENT_MESSAGE_TYPES.TRANSCRIPT_WINDOW_REQUEST, { conversationId, beforeSeq: 6, limit: 3 })
    );
    ok(reply.type === AGENT_MESSAGE_TYPES.TRANSCRIPT_WINDOW, "the reply reuses the documented message type");
    ok(reply.events.map((e) => e.seq).join(",") === "3,4,5", "it returns the requested range below beforeSeq");
    ok(reply.hasOlder === true, "and reports that older events remain");

    const unknown = await core.handleEnvelope(
      makeEnvelope(AGENT_MESSAGE_TYPES.TRANSCRIPT_WINDOW_REQUEST, { conversationId: "conv_missing" })
    );
    ok(unknown.type === AGENT_MESSAGE_TYPES.ERROR && unknown.reason === "unknown_conversation", "an unknown conversation fails honestly rather than returning an empty page");
  }

  fs.rmSync(scratchRoot, { recursive: true, force: true });
  console.log(fail === 0 ? "\nALL CHAT-HISTORY HOST TESTS PASSED" : `\n${fail} FAILED`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
