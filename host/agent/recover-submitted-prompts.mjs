#!/usr/bin/env node
// Recovery for conversations recorded BEFORE `message_submitted` existed.
//
// WHY THIS IS NEEDED. Until host/agent/session/manager.js started appending
// `message_submitted` (see that append's comment), the durable transcript held
// every answer and no question. Reopening such a conversation replayed the
// answer and fell back to the placeholder bubble
// ("[Nội dung tin nhắn trước đó không có sẵn]") because the only other copy of
// the question was a bounded LOCAL preview cache that is empty for anything
// older than the current profile's recent sends.
//
// The question is not always gone, though: the SDK keeps its own session
// transcript per conversation under
// `<conversation>/claude-config/projects/<slug>/<sessionId>.jsonl`, and its
// `type: "user"` entries are the operator's actual turns. This tool reads them
// back and re-appends each real turn to the conversation's own event log as a
// `message_submitted` event — the exact shape SessionManager.startRun() now
// writes — so the panel replays a complete transcript with no panel-side
// changes and no second code path.
//
// WHAT IT REFUSES TO DO:
//   * It never writes to a conversation that already has `message_submitted`
//     events (idempotent: run it twice, the second run reports `already-ok`).
//   * It never touches a conversation with an ACTIVE RUN (`activeRunId` set):
//     appending events behind a live allocator is not worth the risk.
//   * It never invents text. A turn it cannot recover leaves the conversation
//     exactly as it was — a placeholder is honest, a guess is not.
//   * It never recovers tool results, system reminders, skill-dispatch shims
//     or subagent sidechains: those are not things the operator typed.
//   * It never rewrites or deletes an existing event. Appends only.
//
// WHAT IT CANNOT DO: recover a conversation whose SDK transcript is already
// gone. The SDK prunes its own session files, and a conversation created by a
// fixture (a fake SDK that never wrote a real session) has none to begin with.
// For those, the placeholder stays — the honest answer, and the reason the
// lasting fix is the appends SessionManager.startRun() now performs.
//
// Usage:
//   node host/agent/recover-submitted-prompts.mjs            # dry run, reports only
//   node host/agent/recover-submitted-prompts.mjs --apply    # writes the events
//   node host/agent/recover-submitted-prompts.mjs --apply --only conv_abc,conv_def
//   (or, from host/: npm run recover-prompts -- --apply)
//
// OCIC_AGENT_HOME is honoured (paths.js), so this can be rehearsed against a
// scratch store before it is pointed at a real one.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { conversationsDir, conversationEventsFile, conversationMetaFile } from "./storage/paths.js";

const APPLY = process.argv.includes("--apply");
const onlyArg = process.argv.indexOf("--only");
const ONLY = onlyArg !== -1 && process.argv[onlyArg + 1] ? new Set(process.argv[onlyArg + 1].split(",").map((s) => s.trim())) : null;

/** Operator turns that are really the model's own plumbing, not the user. */
function isRecoverablePending(entry) {
  if (!entry || entry.type !== "user") return false;
  if (entry.isSidechain === true) return false; // a subagent's own turn
  if (entry.isMeta === true) return false;
  const content = entry.message && entry.message.content;
  if (typeof content === "string") {
    // A short, string-shaped `content` is how the SDK records its OWN injected
    // turns (`<task-notification>`, the empty-answer nudge). It must go through
    // the same synthetic filter as the array shape — returning `true` here
    // merely because the string is non-empty is what let a subagent completion
    // notice through on the first pass of this tool.
    const text = content.trim();
    return !!text && !isSyntheticTurn(text);
  }
  if (!Array.isArray(content)) return false;
  // A tool result also arrives as `type: "user"`; so do SDK-injected skill
  // bodies. Neither is something the operator typed.
  if (content.some((block) => block && block.type === "tool_result")) return false;
  const text = content
    .filter((block) => block && block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n")
    .trim();
  return !!text && !isSyntheticTurn(text);
}

/**
 * Text the SDK or a tool injects as if it were a user turn. Recovering these
 * would put words in the operator's mouth on the transcript — the panel would
 * render them as a bubble they never typed — so they are refused here exactly
 * like a tool result is. Everything in this list was observed in the real
 * transcripts on this machine.
 */
function isSyntheticTurn(text) {
  // A leading zero-width mark (seen on a real `<task-notification>` turn) would
  // otherwise defeat every marker check below.
  const probe = text.replace(/^[\u200B-\u200D\uFEFF]+/, "");
  if (/^\[Your previous response had no visible output/.test(probe)) return true; // the empty-answer nudge
  if (/^\[Request interrupted by user/.test(probe)) return true; // the SDK's own interrupt marker
  if (/^<task-notification>/.test(probe)) return true; // a subagent's completion notice
  if (/^<command-name>/.test(probe)) return true; // a slash command's expansion
  if (/^<local-command/.test(probe)) return true;
  if (/^<system-reminder>/.test(probe)) return true;
  if (/^Use the "ocic-session-skills:/.test(probe)) return true; // the skill-dispatch shim
  return false;
}

function userTextOf(entry) {
  const content = entry.message && entry.message.content;
  if (typeof content === "string") return content.trim();
  return content
    .filter((block) => block && block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

/** Every main-chain operator turn in this conversation's SDK transcript(s),
 * oldest first, each with the epoch ms the SDK recorded. */
function readSdkUserTurns(conversationId) {
  const projectsDir = path.join(conversationsDir(), conversationId, "claude-config", "projects");
  let files = [];
  try {
    for (const slug of fs.readdirSync(projectsDir)) {
      const dir = path.join(projectsDir, slug);
      if (!fs.statSync(dir).isDirectory()) continue;
      for (const name of fs.readdirSync(dir)) {
        if (name.endsWith(".jsonl")) files.push(path.join(dir, name));
      }
    }
  } catch {
    return [];
  }
  const turns = [];
  for (const file of files) {
    let text = "";
    try {
      text = fs.readFileSync(file, "utf-8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let entry;
      try {
        entry = JSON.parse(trimmed);
      } catch {
        continue; // torn tail
      }
      if (!isRecoverablePending(entry)) continue;
      const ts = Date.parse(entry.timestamp || "");
      if (!Number.isFinite(ts)) continue;
      turns.push({ ts, text: userTextOf(entry), uuid: entry.uuid || null });
    }
  }
  // Two files can (rarely) hold the same turn; identity is the uuid when the
  // SDK gave one, otherwise the exact bytes plus the instant.
  const seen = new Set();
  return turns
    .sort((a, b) => a.ts - b.ts)
    .filter((turn) => {
      const key = turn.uuid || `${turn.ts}\u0000${turn.text}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function readEvents(conversationId) {
  let text = "";
  try {
    text = fs.readFileSync(conversationEventsFile(conversationId), "utf-8");
  } catch {
    return [];
  }
  const events = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed));
    } catch {
      // torn tail — skip
    }
  }
  return events;
}

/**
 * Bind each recovered turn to the run it was the question for.
 *
 * Pairing cannot be done on `run_created` instants alone. A run's created
 * instant trails the operator's own message by whatever the submission cost,
 * and it PRECEDES the answer by everything the run did — so a second question
 * asked after the first run finished falls between run 1's created instant and
 * run 2's, and picking "the newest run created before the turn" hands that
 * question to the run that already answered the previous one. (Observed on the
 * first pass of this tool; the regression test pins it.)
 *
 * So a run is its WINDOW: from the instant its `run_created` was recorded to
 * the instant it reached a terminal event (`run_done` / `run_stopped` /
 * `run_interrupted_by_restart`). A turn inside a window is that run's question
 * — the first window that contains it, so a turn asked while run N was still
 * streaming stays with run N rather than jumping to a run that had not been
 * created yet. A turn in no window at all (older than every run, or asked
 * during a run whose terminal is outside this bounded log) is attached to the
 * earliest run when it precedes them all, and skipped when there are no runs:
 * the panel binds a user item to a runId, so a runId-less entry would be
 * invented structure rather than recovered fact.
 */
function pairTurnsWithRuns(turns, events) {
  const runs = events
    .filter((e) => e && e.type === "run_created" && typeof e.ts === "number" && typeof e.runId === "string")
    .sort((a, b) => a.ts - b.ts);
  if (!runs.length) return [];

  const TERMINAL = new Set(["run_done", "run_stopped", "run_interrupted_by_restart", "run_error"]);
  const windows = runs.map((run) => {
    const terminal = events.find((e) => e && e.runId === run.runId && TERMINAL.has(e.type) && typeof e.ts === "number" && e.ts >= run.ts);
    return { runId: run.runId, start: run.ts, end: terminal ? terminal.ts : Infinity };
  });

  const paired = [];
  for (const turn of turns) {
    const containing = windows.find((w) => turn.ts >= w.start && turn.ts <= w.end);
    // No containing window: the turn is either older than every recorded run
    // (log trimmed) or newer than all of them (a run whose terminal this log
    // does not hold). Both mean "the run that was created closest to it".
    const pick = containing || nearestWindow(windows, turn.ts);
    if (pick) paired.push({ ...turn, runId: pick.runId });
  }
  return paired;
}

/** The window whose start is closest to the turn — the previous run, normally,
 * and the first run for a turn that predates them all. */
function nearestWindow(windows, ts) {
  let pick = windows[0];
  let best = Math.abs(windows[0].start - ts);
  for (const window of windows) {
    const distance = Math.abs(window.start - ts);
    if (distance < best) {
      best = distance;
      pick = window;
    }
  }
  return pick;
}

function recoverOne(conversationId, { apply }) {
  const meta = (() => {
    try {
      return JSON.parse(fs.readFileSync(conversationMetaFile(conversationId), "utf-8"));
    } catch {
      return null;
    }
  })();
  if (!meta) return { conversationId, status: "no-meta" };
  if (meta.activeRunId) return { conversationId, status: "active-run" };

  const events = readEvents(conversationId);
  if (events.some((e) => e.type === "message_submitted")) return { conversationId, status: "already-ok" };

  const turns = readSdkUserTurns(conversationId);
  if (!turns.length) return { conversationId, status: "nothing-to-recover" };

  const paired = pairTurnsWithRuns(turns, events);
  if (!paired.length) return { conversationId, status: "no-run-to-bind" };

  if (apply) {
    let nextSeq = events.reduce((max, e) => (typeof e.seq === "number" && e.seq > max ? e.seq : max), 0);
    const lines = paired.map((turn) => {
      nextSeq += 1;
      return JSON.stringify({
        seq: nextSeq,
        ts: turn.ts,
        type: "message_submitted",
        runId: turn.runId,
        submission: { text: turn.text, attachments: [] },
        // provenance — this event was NOT written by startRun() at run time
        recoveredFrom: "sdk-session-transcript"
      });
    });
    fs.appendFileSync(conversationEventsFile(conversationId), lines.join("\n") + "\n");
  }
  return { conversationId, status: apply ? "recovered" : "would-recover", turns: paired };
}

/**
 * Recover every conversation that can be recovered.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.apply] - false (default) reports what it would do and
 *   writes nothing.
 * @param {Iterable<string>} [opts.only] - restrict to these conversation ids.
 * @param {string} [opts.home] - an explicit `OCIC_AGENT_HOME`. Read at call
 *   time (not at import time) because storage/paths.js resolves the root on
 *   every call, and a caller — the regression test, a rehearsal against a
 *   scratch store — has to be able to point this at its own tree.
 * @returns {Array<{conversationId: string, status: string, turns?: Array<object>}>}
 */
export function recoverPrompts({ apply = false, only = null, home = null } = {}) {
  const previousHome = process.env.OCIC_AGENT_HOME;
  if (home) process.env.OCIC_AGENT_HOME = home;
  try {
    const wanted = only ? new Set(only) : null;
    const ids = fs
      .readdirSync(conversationsDir(), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .filter((id) => !wanted || wanted.has(id))
      .sort();
    return ids.map((id) => recoverOne(id, { apply }));
  } finally {
    if (home) {
      if (previousHome === undefined) delete process.env.OCIC_AGENT_HOME;
      else process.env.OCIC_AGENT_HOME = previousHome;
    }
  }
}

/** Tally + examples, shared by the CLI and the test. */
export function summarize(results) {
  const tally = new Map();
  for (const result of results) tally.set(result.status, (tally.get(result.status) || 0) + 1);
  return [...tally].sort((a, b) => b[1] - a[1]);
}

// ---- CLI ------------------------------------------------------------------
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const results = recoverPrompts({ apply: APPLY, only: ONLY });
  console.log(`${APPLY ? "APPLY" : "DRY RUN"} over ${results.length} conversations`);
  for (const [status, count] of summarize(results)) console.log(`  ${status}: ${count}`);
  const examples = results.filter((r) => r.turns).slice(0, 8);
  if (examples.length) {
    console.log("\nExamples:");
    for (const example of examples) {
      console.log(`  ${example.conversationId}`);
      for (const turn of example.turns) {
        console.log(`    [${new Date(turn.ts).toLocaleString("vi-VN")}] runId=${turn.runId} :: ${JSON.stringify(turn.text.slice(0, 80))}`);
      }
    }
  }
}
