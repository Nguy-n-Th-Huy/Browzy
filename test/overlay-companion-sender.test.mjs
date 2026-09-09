// Tests for the extension/background.js -> companion action-event sender —
// the extension-side half of task 5.10 that reports/05-timeline-host-
// evidence.md (Batch 3a, host-side) named as the one remaining gap: nothing
// on the extension side sent `action_event`/chunked `action_artifact`
// messages yet, even though host/agent/companion.js's `_handleActionEvent`/
// `_handleChunkEnvelope` were already built and tested against a real wire.
//
// This proves the SENDER half: batching by conversationId, the exact wire
// shape host/agent/protocol.js declares (mirrored by hand — a browser
// module graph cannot import a Node-side host file, the same constraint
// extension/sidepanel/protocol-client.js's own header already documents),
// screenshot bytes chunked through the same chunk_begin/chunk_part/chunk_end
// transport, safe degradation with no companion connected, and that nothing
// here can alter real dispatch timing. Same extraction technique as the
// rest of this batch's tests (test/_extract.mjs).

import { extractFunction, compile } from "./_extract.mjs";

let fail = 0;
const ok = (c, m) => { console.log((c ? "  PASS " : "  FAIL ") + m); if (!c) fail++; };

const AGENT_PROTOCOL_VERSION = 1;

// =============================================================================
// 1. queueActionEventForCompanion: filters out conversationId-less events
//    (legacy/external-MCP — no SDK conversation to store against), batches
//    by conversationId, arms the flush timer, and never does I/O itself
//    (no `await` anywhere in its own body — proven textually, since that is
//    what guarantees it can never delay the real dispatch that produced the
//    event it is queuing).
// =============================================================================
console.log("== queueActionEventForCompanion: filters, batches, arms the flush, never awaits ==");
{
  const src = extractFunction("queueActionEventForCompanion");
  ok(!/\bawait\b/.test(src), "the function's own body contains no `await` at all — queuing is synchronous, so it can never add delay to the real dispatch that produced the event (design.md 5c's \"never slow a real action\" invariant, extended to this sender)");

  const pendingActionEventsByConversation = new Map();
  const scheduleCalls = [];
  const artifactCalls = [];
  const queueActionEventForCompanion = compile(
    src,
    {
      pendingActionEventsByConversation,
      scheduleActionEventFlush: () => scheduleCalls.push(1),
      actionEvents: { EVENT_KINDS: { COMPLETE: "complete" } },
      sendActionArtifactToCompanion: (conversationId, artifactId) => artifactCalls.push({ conversationId, artifactId })
    },
    "queueActionEventForCompanion"
  );

  queueActionEventForCompanion({ kind: "start", conversationId: null, runId: null, tabId: 1, action: { type: "click" } });
  ok(pendingActionEventsByConversation.size === 0, "an event with no conversationId (legacy/external-MCP) is never queued — no SDK conversation exists to store a timeline against");

  const e1 = { kind: "start", conversationId: "conv_1", runId: "run_1", tabId: 1, action: { type: "click" } };
  queueActionEventForCompanion(e1);
  ok(pendingActionEventsByConversation.get("conv_1")[0] === e1, "queued the EXACT event object — never a copy, never re-derived");
  ok(scheduleCalls.length === 1, "the flush timer is armed");

  const e2 = { kind: "progress", conversationId: "conv_1", runId: "run_1", tabId: 1, action: { type: "click" }, pointer: { points: [{ x: 1, y: 1, phase: "move" }] } };
  queueActionEventForCompanion(e2);
  ok(pendingActionEventsByConversation.get("conv_1").length === 2, "a second event for the SAME conversation is appended to the SAME pending batch, not sent separately");

  const complete = { kind: "complete", conversationId: "conv_1", runId: "run_1", tabId: 1, action: { type: "capture" }, capture: { artifactId: "screenshot_123" } };
  queueActionEventForCompanion(complete);
  ok(artifactCalls.length === 1 && artifactCalls[0].conversationId === "conv_1" && artifactCalls[0].artifactId === "screenshot_123",
     "a `complete` event carrying a capture artifactId ALSO triggers the artifact sender, with the real conversationId/artifactId — never a guess");

  const completeNoCapture = { kind: "complete", conversationId: "conv_1", runId: "run_1", tabId: 1, action: { type: "click" }, capture: null };
  queueActionEventForCompanion(completeNoCapture);
  ok(artifactCalls.length === 1, "a `complete` with no capture never triggers the artifact sender");
}

// =============================================================================
// 2. Throttling proof: many events queued before the flush timer fires are
//    coalesced into ONE flush per conversation, and the flush timer itself
//    is armed exactly once per idle period — mirroring the SAME coalescing
//    proof pattern used for the overlay's own render scheduler
//    (test/overlay-pointer.test.mjs) and action-events.js's PointBatcher.
// =============================================================================
console.log("\n== scheduleActionEventFlush: coalesces a burst into ONE armed timer ==");
{
  const scheduledTimeouts = [];
  let actionEventFlushTimer = null;
  const holder = { actionEventFlushTimer: null };
  const fakeSetTimeout = (fn) => { scheduledTimeouts.push(fn); return "timer-handle"; };
  const flushCalls = [];
  const src = [
    "let actionEventFlushTimer = null;",
    extractFunction("scheduleActionEventFlush")
  ].join("\n");
  const scheduleActionEventFlush = compile(
    src,
    { ACTION_EVENT_FLUSH_MS: 200, setTimeout: fakeSetTimeout, flushActionEventsToCompanion: () => flushCalls.push(1) },
    "scheduleActionEventFlush"
  );
  scheduleActionEventFlush();
  scheduleActionEventFlush();
  scheduleActionEventFlush();
  ok(scheduledTimeouts.length === 1, "three rapid calls arm exactly one timer — a burst of events never floods native messaging with one flush per event");
  scheduledTimeouts[0](); // fire it
  ok(flushCalls.length === 1, "firing the timer flushes exactly once");
}

// =============================================================================
// 3. flushActionEventsToCompanion: one action_event message per
//    conversationId group, exact wire shape, degrades to nothing with no
//    companion connected — and the pending buffer is cleared either way so
//    a dead companion cannot cause unbounded memory growth.
// =============================================================================
console.log("\n== flushActionEventsToCompanion: exact wire shape, safe degradation ==");
{
  function run(nativePort) {
    const pendingActionEventsByConversation = new Map();
    const e1 = { kind: "start", conversationId: "conv_1", seq: 1 };
    const e2 = { kind: "complete", conversationId: "conv_1", seq: 2 };
    const e3 = { kind: "start", conversationId: "conv_2", seq: 1 };
    pendingActionEventsByConversation.set("conv_1", [e1, e2]);
    pendingActionEventsByConversation.set("conv_2", [e3]);
    const flush = compile(
      extractFunction("flushActionEventsToCompanion"),
      { pendingActionEventsByConversation, nativePort, AGENT_PROTOCOL_VERSION },
      "flushActionEventsToCompanion"
    );
    flush();
    return { pendingActionEventsByConversation, e1, e2, e3 };
  }

  {
    const posted = [];
    const { pendingActionEventsByConversation } = run({ postMessage: (m) => posted.push(m) });
    ok(pendingActionEventsByConversation.size === 0, "the pending buffer is cleared after a successful flush");
    ok(posted.length === 2, "one action_event message PER conversationId group (2 conversations -> 2 messages), not one giant message and not one per event");
    const c1 = posted.find((p) => p.envelope.conversationId === "conv_1");
    const c2 = posted.find((p) => p.envelope.conversationId === "conv_2");
    ok(c1.type === "agent_msg" && c1.envelope.v === AGENT_PROTOCOL_VERSION && c1.envelope.type === "action_event", "wire shape: {type:\"agent_msg\", envelope:{v, type:\"action_event\", conversationId, events, ts}} — exactly host/agent/protocol.js's ACTION_EVENT contract");
    ok(Array.isArray(c1.envelope.events) && c1.envelope.events.length === 2 && c1.envelope.events[0].seq === 1 && c1.envelope.events[1].seq === 2,
       "conv_1's own batch carries BOTH its events, in the order they were queued");
    ok(c2.envelope.events.length === 1, "conv_2's batch carries only its own event — never mixed with conv_1's");
  }

  {
    const posted = [];
    const { pendingActionEventsByConversation } = run(null); // no companion connected
    ok(posted.length === 0, "no companion connected -> nothing sent");
    ok(pendingActionEventsByConversation.size === 0, "...but the pending buffer is STILL cleared (dropped, not retried forever) — degrades safely, matches design.md 5c's \"never slow a real action\" by never letting a dead companion accumulate unbounded memory either");
  }

  {
    // Empty buffer: a flush that fires after everything already went out
    // (e.g. a duplicate timer) must be a total no-op, not an empty message.
    const pendingActionEventsByConversation = new Map();
    const posted = [];
    const flush = compile(
      extractFunction("flushActionEventsToCompanion"),
      { pendingActionEventsByConversation, nativePort: { postMessage: (m) => posted.push(m) }, AGENT_PROTOCOL_VERSION },
      "flushActionEventsToCompanion"
    );
    flush();
    ok(posted.length === 0, "flushing an already-empty buffer sends nothing");
  }
}

// =============================================================================
// 4. chunkBytesForWire + base64<->bytes round trip: the exact chunk_begin/
//    chunk_part*/chunk_end shape host/agent/broker/chunked-transport.js's
//    chunkBuffer() produces and host/agent/companion.js's
//    _handleChunkEnvelope already ingests. Proves BOTH the single-chunk case
//    (every real screenshot today, capped well under the threshold) and the
//    multi-chunk case (mirroring the host's own "900,000 byte buffer" test).
// =============================================================================
console.log("\n== chunkBytesForWire: real chunk_begin/chunk_part/chunk_end shape, byte-exact reassembly ==");
{
  function reassemble(chunked) {
    // A tiny local reassembler mirroring ChunkReassembler's OWN validation
    // rules closely enough to prove correctness end-to-end without
    // importing a host/** Node file into this browser-side test (the same
    // module-graph boundary extension/background.js itself respects).
    if (chunked.begin.total !== chunked.parts.length) throw new Error("total/parts mismatch");
    const bufs = new Array(chunked.begin.total);
    for (const part of chunked.parts) {
      if (part.chunkId !== chunked.begin.chunkId) throw new Error("chunkId mismatch");
      const bin = atob(part.dataB64);
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      if (arr.length !== part.size) throw new Error("size mismatch");
      bufs[part.index] = arr;
    }
    if (bufs.some((b) => !b)) throw new Error("missing part");
    const total = bufs.reduce((n, b) => n + b.length, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const b of bufs) { out.set(b, off); off += b.length; }
    if (out.length !== chunked.begin.totalBytes) throw new Error("totalBytes mismatch");
    return out;
  }

  const chunkBytesForWire = compile(
    [extractFunction("uint8ArrayToBase64"), extractFunction("chunkBytesForWire")].join("\n\n"),
    { ACTION_ARTIFACT_MAX_CHUNK_BYTES: 700000, ACTION_ARTIFACT_CHUNK_TTL_MS: 60000 },
    "chunkBytesForWire"
  );

  // Small buffer: exactly the shape of every real screenshot today
  // (background.js's own takeScreenshot() caps base64 length well under this
  // module's chunk threshold).
  const small = new Uint8Array(1000);
  for (let i = 0; i < small.length; i++) small[i] = i % 256;
  const chunkedSmall = chunkBytesForWire(small, { kind: "action_artifact", conversationId: "conv_1", artifactId: "screenshot_1", mimeType: "image/jpeg" });
  ok(chunkedSmall.begin.total === 1 && chunkedSmall.parts.length === 1, "a small (typical screenshot-sized) buffer produces exactly one chunk");
  ok(chunkedSmall.begin.type === "chunk_begin" && chunkedSmall.parts[0].type === "chunk_part" && chunkedSmall.end.type === "chunk_end",
     "wire type literals match host/agent/protocol.js's CHUNK_BEGIN/CHUNK_PART/CHUNK_END exactly");
  ok(chunkedSmall.begin.kind === "action_artifact" && chunkedSmall.begin.conversationId === "conv_1" && chunkedSmall.begin.artifactId === "screenshot_1" && chunkedSmall.begin.mimeType === "image/jpeg",
     "meta (kind/conversationId/artifactId/mimeType) is spread onto chunk_begin, exactly what _handleChunkEnvelope reads to route the completed sequence");
  ok(chunkedSmall.parts[0].kind === "action_artifact" && chunkedSmall.parts[0].conversationId === "conv_1",
     "...and onto every chunk_part too (chunkBuffer()'s own documented contract), not just chunk_begin");
  ok(chunkedSmall.end.kind === undefined, "meta is NOT spread onto chunk_end — matches chunkBuffer()'s own shape exactly (end only carries type/chunkId/total/expiresAt)");
  const roundTripSmall = reassemble(chunkedSmall);
  ok(roundTripSmall.length === small.length && roundTripSmall.every((b, i) => b === small[i]), "small buffer reassembles to the EXACT original bytes");

  // Large buffer: mirror the host's own tested 900,000-byte case to prove
  // real multi-chunk splitting/reassembly, not just the trivial 1-chunk path.
  const large = new Uint8Array(900000);
  for (let i = 0; i < large.length; i++) large[i] = (i * 7) % 256;
  const chunkedLarge = chunkBytesForWire(large, { kind: "action_artifact", conversationId: "conv_2", artifactId: "screenshot_2", mimeType: "image/jpeg" });
  ok(chunkedLarge.begin.total === 2 && chunkedLarge.parts.length === 2, `a 900,000-byte buffer splits into 2 chunks under the 700,000-byte-per-chunk cap (got ${chunkedLarge.begin.total})`);
  ok(chunkedLarge.parts[0].size === 700000 && chunkedLarge.parts[1].size === 200000, "chunk sizes are exactly [700000, 200000], matching chunkBuffer()'s own slicing math");
  const roundTripLarge = reassemble(chunkedLarge);
  ok(roundTripLarge.length === large.length && roundTripLarge.every((b, i) => b === large[i]), "large buffer reassembles to the EXACT original bytes, byte-for-byte, across chunk boundaries");
}

// =============================================================================
// 5. sendActionArtifactToCompanion: sends ONLY real bytes already in
//    screenshotStore — never re-captures, never substitutes, and degrades
//    safely (no companion, no stored bytes) without throwing.
// =============================================================================
console.log("\n== sendActionArtifactToCompanion: only ever sends REAL already-captured bytes ==");
{
  function build({ nativePort, screenshotStore }) {
    return compile(
      extractFunction("sendActionArtifactToCompanion"),
      {
        nativePort,
        screenshotStore,
        AGENT_PROTOCOL_VERSION,
        base64ToUint8Array: compile(extractFunction("base64ToUint8Array"), {}, "base64ToUint8Array"),
        chunkBytesForWire: compile(
          [extractFunction("uint8ArrayToBase64"), extractFunction("chunkBytesForWire")].join("\n\n"),
          { ACTION_ARTIFACT_MAX_CHUNK_BYTES: 700000, ACTION_ARTIFACT_CHUNK_TTL_MS: 60000 },
          "chunkBytesForWire"
        )
      },
      "sendActionArtifactToCompanion"
    );
  }

  {
    const posted = [];
    const screenshotStore = new Map([["screenshot_1", btoa("hello-bytes")]]);
    const send = build({ nativePort: { postMessage: (m) => posted.push(m) }, screenshotStore });
    send("conv_1", "screenshot_1");
    ok(posted.length === 3, "one begin + one part + one end for a small artifact — 3 separate native messages");
    ok(posted.every((p) => p.type === "agent_msg" && p.envelope.v === AGENT_PROTOCOL_VERSION), "every part wrapped as its own agent_msg envelope");
    ok(posted[0].envelope.type === "chunk_begin" && posted[1].envelope.type === "chunk_part" && posted[2].envelope.type === "chunk_end",
       "sent in the correct begin -> part -> end order");
    ok(posted[0].envelope.artifactId === "screenshot_1" && posted[0].envelope.conversationId === "conv_1", "carries the REAL requested artifactId/conversationId, not a placeholder");
    const decoded = atob(posted[1].envelope.dataB64);
    ok(decoded === "hello-bytes", "the bytes sent are EXACTLY what was in screenshotStore for this artifactId — never re-captured, never substituted");
  }

  {
    const posted = [];
    const send = build({ nativePort: { postMessage: (m) => posted.push(m) }, screenshotStore: new Map() });
    send("conv_1", "screenshot_missing");
    ok(posted.length === 0, "an artifactId no longer in screenshotStore (evicted from the bounded 10-entry cache) sends nothing — never a substitute image");
  }

  {
    const posted = [];
    const screenshotStore = new Map([["screenshot_1", btoa("bytes")]]);
    const send = build({ nativePort: null, screenshotStore });
    send("conv_1", "screenshot_1");
    ok(posted.length === 0, "no companion connected -> nothing sent, no throw");
  }
}

console.log(fail === 0 ? "\nALL OVERLAY COMPANION SENDER TESTS PASSED" : `\n${fail} FAILED`);
process.exit(fail ? 1 : 0);
