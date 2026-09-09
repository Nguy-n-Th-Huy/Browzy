#!/usr/bin/env node
// recordings-model.js: pure row formatting + the message shapes sent to
// background.js for status/toggle/attach. Does not touch a real IndexedDB
// or chrome.runtime (both are injected/avoided).
//
// Run: node test/sidepanel-recordings-model.test.mjs

import { summarizeRecording, formatDuration, RecordingsClient } from "../extension/sidepanel/recordings-model.js";

let fail = 0;
function ok(cond, msg) {
  console.log((cond ? "  PASS " : "  FAIL ") + msg);
  if (!cond) fail++;
}

console.log("== formatDuration ==");
{
  ok(formatDuration(5000) === "5 giây", "sub-minute duration");
  ok(formatDuration(252000) === "4 phút 12 giây", "minutes + seconds duration");
  ok(formatDuration(0) === "0 giây", "zero duration does not throw or go negative");
}

console.log("== summarizeRecording: honest about narration failure, never silently drops it ==");
{
  const ok1 = summarizeRecording({
    recording_id: "rec_1",
    started_at: 1000,
    ended_at: 253000,
    url0: "https://vnexpress.net/kinh-te",
    audio: { size: 4096 },
    trace: { cognitive: [{ text: "đầu tiên" }, { text: "thứ hai" }], transcript_status: "ok" }
  });
  ok(ok1.hostname === "vnexpress.net", "hostname parsed from url0");
  ok(ok1.hasAudio === true && ok1.hasNarrationIssue === false, "healthy recording reports no narration issue");
  ok(ok1.durationLabel === "4 phút 12 giây", "duration label matches formatDuration");

  const broken = summarizeRecording({
    recording_id: "rec_2",
    started_at: 0,
    ended_at: 10000,
    url0: "not a url",
    audio: null,
    trace: { transcript_status: "openai_error: rate limited" }
  });
  ok(broken.hostname === null, "an unparseable URL degrades to null hostname, not a throw");
  ok(broken.hasAudio === false, "no audio blob reports hasAudio false");
  ok(broken.hasNarrationIssue === true, "a non-ok transcript status is surfaced as a narration issue, never hidden");
}

async function main() {
  console.log("== RecordingsClient message shapes ==");
  {
    const sent = [];
    const client = new RecordingsClient({
      sendMessage: async (msg) => {
        sent.push(msg);
        if (msg.__ocic === "panel_recorder_status") return { active: true, busy: false, recordingId: "rec_x" };
        return { ok: true };
      }
    });

    const status = await client.status();
    ok(sent[0].__ocic === "panel_recorder_status", "status() sends the documented status message");
    ok(status.active === true, "status() returns the injected response");

    await client.toggle();
    ok(sent[1].__ocic === "panel_toggle_recording", "toggle() sends the documented toggle message");

    await client.attach({ recordingId: "rec_1", path: "/x/rec_1", title: "rec_1 — làm gì đó", transcriptStatus: "ok" });
    const attachMsg = sent[2];
    ok(
      attachMsg.__ocic === "panel_reattach_recording" &&
        attachMsg.recording_id === "rec_1" &&
        attachMsg.path === "/x/rec_1" &&
        attachMsg.transcript_status === "ok",
      "attach() re-sends the exact recording_complete-shaped fields background.js's notifyClaude() already uses"
    );
  }

  console.log("== a sendMessage failure degrades status() to a safe unavailable result ==");
  {
    const client2 = new RecordingsClient({
      sendMessage: async () => {
        throw new Error("no receiving end");
      }
    });
    const s = await client2.status();
    ok(s.active === false && s.unavailable === true, "an unreachable background script reports unavailable, not a throw");
  }

  console.log(fail === 0 ? "\nALL SIDEPANEL RECORDINGS-MODEL TESTS PASSED" : `\n${fail} FAILED`);
  process.exit(fail ? 1 : 0);
}

main();
