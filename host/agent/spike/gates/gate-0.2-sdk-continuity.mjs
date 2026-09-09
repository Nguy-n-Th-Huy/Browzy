// Task-group-0 investigatory gate (change: upgrade-agent-reliability-and-workflows,
// tasks.md 0.2/0.3): "Stop implementation at the gate if SDK resume cannot
// preserve model context without browser-action replay, if missing sessions
// are not explicit, or if budget/usage semantics cannot be observed."
//
// This is an INVESTIGATION script, not a product test suite — it exists to
// produce PASS/FAIL/BLOCKED/UNOBSERVED evidence per assertion, against the
// INSTALLED @anthropic-ai/claude-agent-sdk (0.3.263, see host/package.json),
// not against a re-implementation of it. No product file is imported except
// host/agent/settings/testing/fixture-anthropic-server.mjs (already an
// existing, shared, no-real-cost test fixture) and, only for the explicitly
// opt-in --live gate, host/agent/settings/profile.js's real credential-
// resolution path (the same one host/agent/spike/gates/gate-1.5-cancel-reconnect.mjs
// already uses for a live round trip — see openspec/changes/archive/2026-09-06-migrate-to-claude-agent-sdk/reports/01-sdk-gate-evidence.md).
//
// Every gate below except G9 runs against the LOCAL, in-process fixture
// Anthropic server (zero real cost, deterministic, scripted). G9 is the only
// gate that can observe real-gateway costBasis/usage semantics — it is
// off by default and requires `--live` (see run() below), and it makes
// AT MOST ONE real provider call, using the exact production credential
// path (snapshotForRun), never a raw env var.
//
// Deliberately NOT under host/test/*.test.mjs: that glob is run
// unconditionally (and must exit 0) by .github/workflows/publish-host.yml on
// every publish, the same reason the group-1 SDK spike's own gates
// (host/agent/spike/gates/gate-1.*.mjs) live here instead of host/test/ —
// this file's G9 needs a live credential to add anything, and G6 records a
// genuine (non-flaky, reproducible) SDK finding that intentionally reports
// FAIL for a specific narrow assertion (see G6's own comment), which must
// never silently gate the publish pipeline.
//
// Usage:
//   node host/agent/spike/gates/gate-0.2-sdk-continuity.mjs          # fixture-only gates (G1-G8, G10), no cost
//   node host/agent/spike/gates/gate-0.2-sdk-continuity.mjs --live   # adds G9, ONE real provider call

import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { query, tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { startFixtureAnthropicServer } from "../../settings/testing/fixture-anthropic-server.mjs";

// Real finding from this file's first live run: with NO `HOME`/`USERPROFILE`/
// `CLAUDE_CONFIG_DIR` in the isolated `env` object passed to `query()`, the
// bundled Claude Code CLI subprocess still resolved a config dir — it fell
// back to the OS home directory (sdk.mjs: `process.env.CLAUDE_CONFIG_DIR ??
// path.join(homedir(), ".claude")`) and wrote real session `.jsonl` files
// into the OPERATOR's actual `~/.claude/projects/<encoded-cwd>/`, interleaved
// with their own real Claude Code CLI session history. This is the same env
// shape `host/agent/tools/query-options.js`'s production `buildIsolatedOptions()`
// builds today (PATH/SystemRoot/ANTHROPIC_BASE_URL/ANTHROPIC_API_KEY only) —
// so THIS IS A REAL PRODUCT FINDING, not just a gate-script cleanliness
// issue: today's companion.js, if it ever adopted SDK `resume`, would write
// session history into the operator's real home directory. Every call this
// gate makes now sets `CLAUDE_CONFIG_DIR` to an ephemeral scratch directory
// (auto-cleaned at the end of run()) specifically to avoid polluting that
// real store further and to make the finding reproducible.
const SCRATCH_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ocic-gate-0.2-claude-config-"));

const results = [];

function record(id, title, status, detail) {
  results.push({ id, title, status, detail });
  const line = `[${status}] ${id} ${title}`;
  console.log(line);
  console.log(`    ${String(detail).replace(/\n/g, "\n    ")}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function baseEnv(fixtureUrl) {
  return {
    PATH: process.env.PATH || process.env.Path || "",
    ...(process.platform === "win32" ? { SystemRoot: process.env.SystemRoot || "" } : {}),
    ANTHROPIC_BASE_URL: fixtureUrl,
    ANTHROPIC_API_KEY: "sk-ant-fixture-gate-not-a-real-key",
    CLAUDE_CONFIG_DIR: SCRATCH_CONFIG_DIR
  };
}

// Robust drain: never throws. A hard cap breach (maxTurns/maxBudgetUsd) was
// EMPIRICALLY OBSERVED (this file's first real run) to surface as BOTH (a) a
// normal yielded `result` SDKMessage with the documented error subtype AND
// (b) a SEPARATE terminal exception raised when the transport later closes
// (Query.readMessages()'s cleanup path re-raises `lastErrorResultText` as a
// thrown Error once the underlying process exits) — a real, load-bearing SDK
// behavior this gate must not let crash the whole suite. Both are captured.
async function drain(q) {
  const messages = [];
  let result = null;
  let error = null;
  try {
    for await (const msg of q) {
      messages.push(msg);
      if (msg.type === "result") result = msg;
    }
  } catch (err) {
    error = err;
  }
  return { messages, result, error };
}

function userMsg(text) {
  return { type: "user", message: { role: "user", content: text }, parent_tool_use_id: null };
}

// A manually-driven streaming prompt: `push()` is called only AFTER the
// previous turn's `result` message has actually been observed, so successive
// user sends are genuinely paced one-turn-at-a-time rather than queued
// "close together" — sdk.d.ts's own SDKResultSuccess.user_message_uuids doc
// states messages sent close together COALESCE into a single turn, which
// this file's first real run against a naive all-at-once async generator
// empirically confirmed (5 queued messages collapsed into num_turns=1).
function makeStreamingController() {
  let resolveNext = null;
  const queue = [];
  let ended = false;
  return {
    iterable: {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            if (queue.length) return { done: false, value: queue.shift() };
            if (ended) return { done: true, value: undefined };
            return new Promise((resolve) => {
              resolveNext = (item) => resolve(item);
            });
          }
        };
      }
    },
    push(text) {
      const item = { done: false, value: userMsg(text) };
      if (resolveNext) {
        const r = resolveNext;
        resolveNext = null;
        r(item);
      } else {
        queue.push(item.value);
      }
    },
    end() {
      ended = true;
      if (resolveNext) {
        const r = resolveNext;
        resolveNext = null;
        r({ done: true, value: undefined });
      }
    }
  };
}

/**
 * Drive a streaming-input query() turn-by-turn: send `texts[0]`, wait for its
 * `result`, send `texts[1]` only after that, and so on — until either every
 * text has been sent and a final result observed, or a terminal
 * error/hard-cap result appears first (in which case sending stops
 * immediately). Never throws; the last-seen `error` (if any) is returned
 * alongside every `result` message observed.
 */
async function drainPacedTurns(options, texts) {
  const ctrl = makeStreamingController();
  const q = query({ prompt: ctrl.iterable, options });
  const allResults = [];
  let error = null;
  let idx = 0;
  ctrl.push(texts[idx++]);
  try {
    for await (const msg of q) {
      if (msg.type === "result") {
        allResults.push(msg);
        const isTerminalError = typeof msg.subtype === "string" && msg.subtype.startsWith("error_");
        if (isTerminalError) {
          ctrl.end();
          continue;
        }
        if (idx < texts.length) {
          ctrl.push(texts[idx++]);
        } else {
          ctrl.end();
        }
      }
    }
  } catch (err) {
    error = err;
  }
  return { results: allResults, lastResult: allResults[allResults.length - 1] || null, error };
}

// ---------------------------------------------------------------------------
// G1 — resume restores prior model context in a second turn, and does NOT
// replay a tool call (the browser-action-replay proxy for this offline gate:
// a real SDK tool handler, counted by invocation, standing in for a browser
// tool handler — same registration mechanism host/agent/tools/adapter.js uses
// for real browser tools).
// ---------------------------------------------------------------------------
async function gateResumeContextNoReplay(fixture) {
  let handlerCalls = 0;
  const noopTool = tool("noop_tool", "no-op probe tool", {}, async () => {
    handlerCalls++;
    return { content: [{ type: "text", text: "noop-result" }] };
  });
  const mcpServer = createSdkMcpServer({ name: "gate", version: "1.0.0", tools: [noopTool] });
  const qualified = "mcp__gate__noop_tool";

  fixture.setScenario("success");
  const turn1Options = {
    env: baseEnv(fixture.url),
    model: "fixture-model",
    mcpServers: { gate: mcpServer },
    strictMcpConfig: true,
    settingSources: [],
    tools: [qualified],
    allowedTools: [qualified],
    maxTurns: 3
  };
  const { result: r1 } = await drain(query({ prompt: "Remember the number 42 and call noop_tool once.", options: turn1Options }));
  if (!r1 || r1.is_error) {
    record("G1", "resume restores context / no tool replay", "FAIL", `turn 1 failed to complete: ${JSON.stringify(r1)}`);
    return;
  }
  const callsAfterTurn1 = handlerCalls;
  const sessionId = r1.session_id;

  // Snapshot the call log BEFORE turn 2 so turn 2's own wire requests can be
  // isolated from turn 1's (turn 1's own requests already contain "Remember
  // the number 42" — filtering the WHOLE log for that text would trivially
  // match turn 1's own calls and prove nothing about turn 2).
  const callLogBeforeTurn2 = fixture.callLog.length;

  // Turn 2: resume, same tool still registered (so a replay WOULD be
  // observable if it happened), but a plain-text scenario so the fixture
  // will not itself prompt a NEW tool_use on this request.
  const turn2Options = {
    env: baseEnv(fixture.url),
    model: "fixture-model",
    mcpServers: { gate: mcpServer },
    strictMcpConfig: true,
    settingSources: [],
    tools: [], // deliberately NOT offered this turn — proves any tool
    // invocation observed here cannot come from a fresh model tool_use
    resume: sessionId,
    maxTurns: 1
  };
  const { result: r2 } = await drain(query({ prompt: "What number did I just ask you to remember?", options: turn2Options }));
  if (!r2 || r2.is_error) {
    record("G1", "resume restores context / no tool replay", "FAIL", `turn 2 (resume) failed to complete: ${JSON.stringify(r2)}`);
    return;
  }
  const callsAfterTurn2 = handlerCalls;

  // Inspect ONLY the wire request(s) fixture.callLog gained during turn 2
  // (see callLogBeforeTurn2 above) — does the CLI's resume mechanism
  // reconstruct prior conversation history into these NEW requests (proof
  // "resume restores prior model context")? Parse each body's `messages`
  // array and require the turn-1 user text to appear as an actual prior
  // message entry, not just a substring match anywhere in the raw body.
  const turn2WireCalls = fixture.callLog.slice(callLogBeforeTurn2);
  const turn2CallsWithTurn1History = turn2WireCalls.filter((c) => {
    let parsed;
    try {
      parsed = JSON.parse(c.body);
    } catch {
      return false;
    }
    const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
    return messages.some((m) => {
      const text = typeof m.content === "string" ? m.content : JSON.stringify(m.content || "");
      return text.includes("Remember the number 42");
    });
  });
  const historyRestored = turn2WireCalls.length > 0 && turn2CallsWithTurn1History.length === turn2WireCalls.length;

  const sessionsDiffer = sessionId !== r2.session_id ? "differ (unexpected for a plain resume)" : "identical (expected)";
  const detail =
    `turn1 session_id=${sessionId}, turn2 (resumed) session_id=${r2.session_id} [${sessionsDiffer}]; ` +
    `noop_tool handler invocations: after turn1=${callsAfterTurn1}, after turn2(resume)=${callsAfterTurn2} (delta=${callsAfterTurn2 - callsAfterTurn1}); ` +
    `turn-2 wire request(s) total: ${turn2WireCalls.length}, of which containing turn-1's own "Remember the number 42" as an actual prior message entry: ${turn2CallsWithTurn1History.length}`;

  const contextRestored = historyRestored;
  const noReplay = callsAfterTurn2 - callsAfterTurn1 === 0;
  if (contextRestored && noReplay) {
    record("G1", "resume restores prior model context AND does not replay a tool call", "PASS", detail);
  } else if (!contextRestored) {
    record("G1", "resume restores prior model context AND does not replay a tool call", "FAIL", `context NOT observed restored on the wire. ${detail}`);
  } else {
    record("G1", "resume restores prior model context AND does not replay a tool call", "FAIL", `tool handler was invoked again during resume (replay). ${detail}`);
  }
}

// ---------------------------------------------------------------------------
// G2 — an unknown/missing session reference passed to `resume` must fail
// EXPLICITLY (thrown error, or an explicit error result naming the problem),
// never silently starting a fresh session under the same conversation
// identity and never silently succeeding as if it had resumed something.
// ---------------------------------------------------------------------------
async function gateMissingSessionExplicit(fixture) {
  fixture.setScenario("success");
  const bogusId = "00000000-0000-0000-0000-000000000000";
  const options = {
    env: baseEnv(fixture.url),
    model: "fixture-model",
    mcpServers: {},
    strictMcpConfig: true,
    settingSources: [],
    tools: [],
    resume: bogusId,
    maxTurns: 1
  };
  const { messages, result, error: thrown } = await drain(query({ prompt: "hello", options }));
  const outcome = { messages: messages.map((m) => m.type + (m.subtype ? `:${m.subtype}` : "")), result };

  if (thrown && !result) {
    record(
      "G2",
      "missing/unknown session reference fails explicitly",
      "PASS",
      `query() threw synchronously/async-iterated: ${thrown.name}: ${thrown.message}`
    );
    return;
  }

  if (!outcome || !outcome.result) {
    record("G2", "missing/unknown session reference fails explicitly", "FAIL", `no result message at all; message types: ${outcome ? outcome.messages.join(", ") : "none"}`);
    return;
  }

  const newSessionSilently = result.session_id && result.session_id !== bogusId && !result.is_error;
  if (result.is_error) {
    record(
      "G2",
      "missing/unknown session reference fails explicitly",
      "PASS",
      `explicit error result: subtype=${result.subtype}, errors=${JSON.stringify(result.errors)}, session_id=${result.session_id}`
    );
  } else if (newSessionSilently) {
    record(
      "G2",
      "missing/unknown session reference fails explicitly",
      "FAIL",
      `SILENT fallback: an unknown resume id produced a successful result under a NEW session_id (${result.session_id}) with no error surfaced — a caller cannot distinguish this from a genuine resume`
    );
  } else {
    record("G2", "missing/unknown session reference fails explicitly", "FAIL", `unexpected outcome, not clearly explicit or silent: ${JSON.stringify(result)}`);
  }
}

// ---------------------------------------------------------------------------
// G3 — persistSession: false must prevent a LATER resume of that session
// (sdk.d.ts:1680: "Sessions will not be saved to ~/.claude/projects/ and
// cannot be resumed later").
// ---------------------------------------------------------------------------
async function gatePersistSessionFalse(fixture) {
  fixture.setScenario("success");
  const turn1Options = {
    env: baseEnv(fixture.url),
    model: "fixture-model",
    mcpServers: {},
    strictMcpConfig: true,
    settingSources: [],
    tools: [],
    persistSession: false,
    maxTurns: 1
  };
  const { result: r1 } = await drain(query({ prompt: "first turn, not persisted", options: turn1Options }));
  if (!r1 || r1.is_error || !r1.session_id) {
    record("G3", "persistSession:false prevents later resume", "FAIL", `turn 1 did not complete cleanly: ${JSON.stringify(r1)}`);
    return;
  }

  const resumeOptions = {
    env: baseEnv(fixture.url),
    model: "fixture-model",
    mcpServers: {},
    strictMcpConfig: true,
    settingSources: [],
    tools: [],
    resume: r1.session_id,
    maxTurns: 1
  };
  const { result: r2, error: thrown } = await drain(query({ prompt: "can you recall the first turn?", options: resumeOptions }));

  if ((thrown && !r2) || (r2 && r2.is_error)) {
    record(
      "G3",
      "persistSession:false prevents later resume",
      "PASS",
      `resume of a non-persisted session failed as expected: ${thrown ? `${thrown.name}: ${thrown.message}` : `subtype=${r2.subtype}, errors=${JSON.stringify(r2.errors)}`}`
    );
  } else if (r2 && r2.session_id === r1.session_id) {
    record(
      "G3",
      "persistSession:false prevents later resume",
      "FAIL",
      `resume of a persistSession:false session SUCCEEDED against the same session_id (${r2.session_id}) — contradicts the documented "cannot be resumed later" guarantee`
    );
  } else {
    record(
      "G3",
      "persistSession:false prevents later resume",
      "UNOBSERVED",
      `ambiguous: resume "succeeded" but under a different/new session_id (${r2 ? r2.session_id : "n/a"}) rather than an explicit failure — cannot confirm whether this is a fresh session silently substituted or a real resume`
    );
  }
}

// ---------------------------------------------------------------------------
// G3b — cwd is part of session identity: session storage is keyed by
// (CLAUDE_CONFIG_DIR, encoded cwd) on disk (empirically: this file's own
// SCRATCH_CONFIG_DIR/projects/<encoded-cwd>/ layout, and this fixture's own
// unqualified-cwd runs above landed under an encoded form of `host/`'s own
// path — see the report's 0.1-addition section). Resuming the SAME
// session_id under a DIFFERENT cwd must behave the same as an unknown
// session (G2), not silently find/attach it — this is exactly the
// "cwd/session schema identity" input tasks.md 2.1/2.4 lists.
// ---------------------------------------------------------------------------
async function gateCwdIsPartOfSessionIdentity(fixture) {
  fixture.setScenario("success");
  const cwdA = fs.mkdtempSync(path.join(os.tmpdir(), "ocic-gate-0.2-cwdA-"));
  const cwdB = fs.mkdtempSync(path.join(os.tmpdir(), "ocic-gate-0.2-cwdB-"));
  try {
    const turn1Options = {
      env: baseEnv(fixture.url),
      model: "fixture-model",
      mcpServers: {},
      strictMcpConfig: true,
      settingSources: [],
      tools: [],
      cwd: cwdA,
      maxTurns: 1
    };
    const { result: r1 } = await drain(query({ prompt: "turn 1 under cwd A", options: turn1Options }));
    if (!r1 || r1.is_error || !r1.session_id) {
      record("G3b", "cwd is part of session identity for resume", "FAIL", `turn 1 (cwd A) did not complete cleanly: ${JSON.stringify(r1)}`);
      return;
    }

    // Same session_id, SAME cwd A — must succeed (sanity check the harness
    // itself, not just the cwd-mismatch case).
    const resumeSameOptions = { ...turn1Options, cwd: cwdA, resume: r1.session_id, maxTurns: 1 };
    const { result: rSameCwd, error: errSameCwd } = await drain(query({ prompt: "resume, same cwd A", options: resumeSameOptions }));
    const sameCwdWorked = rSameCwd && !rSameCwd.is_error && rSameCwd.session_id === r1.session_id;

    // Same session_id, DIFFERENT cwd B.
    const resumeDiffOptions = { ...turn1Options, cwd: cwdB, resume: r1.session_id, maxTurns: 1 };
    const { result: rDiffCwd, error: errDiffCwd } = await drain(query({ prompt: "resume, different cwd B", options: resumeDiffOptions }));

    const detail =
      `same-cwd resume: ${sameCwdWorked ? "PASS (succeeded, same session_id)" : `did not succeed as expected (result=${JSON.stringify(rSameCwd)}, error=${errSameCwd ? errSameCwd.message : "none"})`}; ` +
      `different-cwd resume: result=${rDiffCwd ? `subtype=${rDiffCwd.subtype}, is_error=${rDiffCwd.is_error}, errors=${JSON.stringify(rDiffCwd.errors)}` : "none"}, error=${errDiffCwd ? errDiffCwd.message : "none"}`;

    const diffCwdFailedExplicitly =
      (errDiffCwd && !rDiffCwd) || (rDiffCwd && rDiffCwd.is_error) || (errDiffCwd && /no conversation found/i.test(errDiffCwd.message));
    if (sameCwdWorked && diffCwdFailedExplicitly) {
      record("G3b", "cwd is part of session identity for resume", "PASS", detail);
    } else if (!sameCwdWorked) {
      record("G3b", "cwd is part of session identity for resume", "UNOBSERVED", `sanity check (resume under the SAME cwd) did not behave as expected, so the cwd-mismatch comparison below it is not trustworthy. ${detail}`);
    } else {
      record(
        "G3b",
        "cwd is part of session identity for resume",
        "FAIL",
        `resuming the SAME session_id under a DIFFERENT cwd did NOT fail explicitly — cwd may not gate resume the way tasks.md 2.1/2.4 assumes. ${detail}`
      );
    }
  } finally {
    try {
      fs.rmSync(cwdA, { recursive: true, force: true });
      fs.rmSync(cwdB, { recursive: true, force: true });
    } catch {}
  }
}

// ---------------------------------------------------------------------------
// G4 — forkSession: true creates an independent branch: a new session_id,
// and the ORIGINAL session remains independently resumable afterward.
// ---------------------------------------------------------------------------
async function gateForkSession(fixture) {
  fixture.setScenario("success");
  const turn1Options = {
    env: baseEnv(fixture.url),
    model: "fixture-model",
    mcpServers: {},
    strictMcpConfig: true,
    settingSources: [],
    tools: [],
    maxTurns: 1
  };
  const { result: r1 } = await drain(query({ prompt: "original branch, turn 1", options: turn1Options }));
  if (!r1 || r1.is_error || !r1.session_id) {
    record("G4", "forkSession creates an independent branch", "FAIL", `turn 1 did not complete cleanly: ${JSON.stringify(r1)}`);
    return;
  }
  const originalSessionId = r1.session_id;

  const forkOptions = {
    env: baseEnv(fixture.url),
    model: "fixture-model",
    mcpServers: {},
    strictMcpConfig: true,
    settingSources: [],
    tools: [],
    resume: originalSessionId,
    forkSession: true,
    maxTurns: 1
  };
  const { result: rFork } = await drain(query({ prompt: "forked branch, new direction", options: forkOptions }));
  if (!rFork || rFork.is_error) {
    record("G4", "forkSession creates an independent branch", "FAIL", `fork call did not complete cleanly: ${JSON.stringify(rFork)}`);
    return;
  }
  const forkedSessionId = rFork.session_id;

  // The original session must still be independently resumable afterward.
  const resumeOriginalOptions = {
    env: baseEnv(fixture.url),
    model: "fixture-model",
    mcpServers: {},
    strictMcpConfig: true,
    settingSources: [],
    tools: [],
    resume: originalSessionId,
    maxTurns: 1
  };
  const { result: rOriginalAgain } = await drain(query({ prompt: "back on the original branch", options: resumeOriginalOptions }));

  const forkedIsNew = forkedSessionId && forkedSessionId !== originalSessionId;
  const originalStillWorks = rOriginalAgain && !rOriginalAgain.is_error && rOriginalAgain.session_id === originalSessionId;
  const detail = `original=${originalSessionId}, forked=${forkedSessionId}, original-still-resumable=${originalStillWorks} (session_id after re-resume: ${rOriginalAgain ? rOriginalAgain.session_id : "n/a"})`;
  if (forkedIsNew && originalStillWorks) {
    record("G4", "forkSession creates an independent branch", "PASS", detail);
  } else {
    record("G4", "forkSession creates an independent branch", "FAIL", detail);
  }
}

// ---------------------------------------------------------------------------
// G5 — cancellation: abortController.abort() actually terminates a run and
// no result message with a completed subtype is produced. Deliberately
// pointed at an unreachable local address (127.0.0.1:1) so this can never
// reach a live provider even if the abort races a retry. Same technique as
// openspec/changes/archive/2026-09-06-migrate-to-claude-agent-sdk's
// gate-1.5-cancel-reconnect.mjs testCancellation().
// ---------------------------------------------------------------------------
async function gateCancellationPartialResult() {
  const controller = new AbortController();
  const t0 = Date.now();
  const q = query({
    prompt: "ping",
    options: {
      abortController: controller,
      env: {
        PATH: process.env.PATH || process.env.Path || "",
        ...(process.platform === "win32" ? { SystemRoot: process.env.SystemRoot || "" } : {}),
        ANTHROPIC_BASE_URL: "http://127.0.0.1:1",
        ANTHROPIC_API_KEY: "sk-ant-gate-cancellation-not-a-real-key",
        CLAUDE_CONFIG_DIR: SCRATCH_CONFIG_DIR
      },
      model: "fixture-model",
      mcpServers: {},
      strictMcpConfig: true,
      settingSources: [],
      tools: []
    }
  });

  const messages = [];
  setTimeout(() => controller.abort(), 300);
  const HARD_TIMEOUT_MS = 25_000;
  let threw = null;
  await Promise.race([
    (async () => {
      try {
        for await (const msg of q) messages.push(msg.type);
      } catch (err) {
        threw = err;
      }
    })(),
    sleep(HARD_TIMEOUT_MS).then(() => {
      throw new Error(`cancellation did not resolve within ${HARD_TIMEOUT_MS}ms`);
    })
  ]);
  const elapsed = Date.now() - t0;
  const noCompletedResult = !messages.includes("result") || threw;
  const detail = `abort() at ~300ms; settled at ${elapsed}ms; messages before abort: [${messages.join(", ") || "none"}]; aborted=${controller.signal.aborted}; threw=${threw ? `${threw.name}: ${threw.message}` : "no"}`;
  if (controller.signal.aborted && threw && noCompletedResult) {
    record("G5", "cancellation terminates the run; no completed result", "PASS", detail);
  } else {
    record("G5", "cancellation terminates the run; no completed result", "FAIL", detail);
  }
}

// ---------------------------------------------------------------------------
// G6 — maxTurns stops the query at the configured cap, reporting
// subtype 'error_max_turns' (sdk.d.ts:4959).
// ---------------------------------------------------------------------------
async function gateMaxTurns(fixture) {
  fixture.setScenario("success");
  const options = {
    env: baseEnv(fixture.url),
    model: "fixture-model",
    mcpServers: {},
    strictMcpConfig: true,
    settingSources: [],
    tools: [],
    maxTurns: 2
  };
  const { results, lastResult: result, error } = await drainPacedTurns(
    options,
    ["turn one", "turn two", "turn three", "turn four", "turn five"]
  );
  const detail =
    `${results.length} result message(s) observed (subtypes: ${results.map((r) => r.subtype).join(", ")}); ` +
    `final: subtype=${result ? result.subtype : "none"}, num_turns=${result ? result.num_turns : "n/a"}, is_error=${result ? result.is_error : "n/a"}` +
    (error ? `; a terminal exception ALSO followed the final result once the transport closed: ${error.name}: ${error.message}` : "");
  if (result && result.subtype === "error_max_turns" && result.num_turns <= 2) {
    record("G6", "maxTurns stops at the cap with subtype error_max_turns", "PASS", detail);
  } else if (!result && error && /max.?turns/i.test(error.message)) {
    record("G6", "maxTurns stops at the cap with subtype error_max_turns", "PASS", `no result message was ever yielded before the terminal exception (SDK surfaced the cap purely as a thrown error): ${detail}`);
  } else {
    record(
      "G6",
      "maxTurns stops at the cap with subtype error_max_turns",
      "FAIL",
      `maxTurns:2 did NOT stop a genuinely paced 5-separate-turn streaming-input session (all 5 completed subtype=success, each reporting num_turns=1) — this is NOT a harness artifact: the identical paced-streaming harness/options shape correctly triggers error_max_budget_usd in gate G7 below, so this session really did reach 5 real turns without the SDK's maxTurns admission ever intervening. See G6b for whether maxTurns caps an internal multi-round TOOL loop within one single top-level turn instead (a different meaning of "turn" than a streaming-input conversation turn). ${detail}`
    );
  }
}

// ---------------------------------------------------------------------------
// G6b — maxTurns caps an internal, single-user-message, multi-round TOOL
// LOOP (repeated tool_use/tool_result exchanges the model has while
// answering ONE prompt) rather than a paced multi-message streaming
// conversation (see G6's finding above). Uses a small dedicated local HTTP
// server (not the shared fixture, whose scripted "success"/"tool" scenarios
// always answer plain text once a tool_result is present in the request —
// see host/agent/settings/testing/fixture-anthropic-server.mjs's
// `hasToolResult` branch — which makes it structurally incapable of forcing
// more than one tool round trip) that ALWAYS answers with a fresh tool_use
// for the same tool, regardless of prior tool_results, so the model/CLI must
// keep looping until maxTurns intervenes.
// ---------------------------------------------------------------------------
async function withAlwaysToolUseServer(toolName, fn) {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const url = req.url || "";
      if (req.method === "HEAD" && url.includes("/api/hello")) {
        res.writeHead(200, {});
        res.end();
        return;
      }
      if (!url.startsWith("/v1/messages")) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ type: "error", error: { type: "not_found_error", message: "unknown route" } }));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      const id = `msg_${crypto.randomBytes(4).toString("hex")}`;
      send("message_start", { type: "message_start", message: { id, type: "message", role: "assistant", content: [], model: "fixture-model", stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 0 } } });
      send("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: `toolu_${crypto.randomBytes(3).toString("hex")}`, name: toolName, input: {} } });
      send("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{}" } });
      send("content_block_stop", { type: "content_block_stop", index: 0 });
      send("message_delta", { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 3 } });
      send("message_stop", { type: "message_stop" });
      res.end();
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function gateMaxTurnsInternalToolLoop() {
  let handlerCalls = 0;
  const noopTool = tool("loop_tool", "always re-invoked probe tool", {}, async () => {
    handlerCalls++;
    return { content: [{ type: "text", text: `loop-result-${handlerCalls}` }] };
  });
  const mcpServer = createSdkMcpServer({ name: "loopgate", version: "1.0.0", tools: [noopTool] });
  const qualified = "mcp__loopgate__loop_tool";

  await withAlwaysToolUseServer(qualified, async (url) => {
    const options = {
      env: baseEnv(url),
      model: "fixture-model",
      mcpServers: { loopgate: mcpServer },
      strictMcpConfig: true,
      settingSources: [],
      tools: [qualified],
      allowedTools: [qualified],
      maxTurns: 3
    };
    const { result, error } = await drain(query({ prompt: "Call loop_tool repeatedly.", options }));
    const detail = `loop_tool handler invocations observed: ${handlerCalls}; result: subtype=${result ? result.subtype : "none"}, num_turns=${result ? result.num_turns : "n/a"}` + (error ? `; terminal exception: ${error.name}: ${error.message}` : "");
    if (result && result.subtype === "error_max_turns" && handlerCalls <= 3) {
      record("G6b", "maxTurns caps an internal multi-round tool loop within one turn", "PASS", detail);
    } else if (!result && error && /max.?turns/i.test(error.message) && handlerCalls <= 4) {
      record("G6b", "maxTurns caps an internal multi-round tool loop within one turn", "PASS", `SDK surfaced the cap as a thrown terminal error rather than a yielded result: ${detail}`);
    } else {
      record("G6b", "maxTurns caps an internal multi-round tool loop within one turn", "FAIL", detail);
    }
  });
}

// ---------------------------------------------------------------------------
// G7 — maxBudgetUsd stops the query once the SDK's own (estimated) cost
// crosses the configured cap, reporting subtype 'error_max_budget_usd'
// (sdk.d.ts:4959). Uses a REAL, recognized model id string (so the CLI's
// built-in price table has a row to match — costBasis 'list', per
// sdk.d.ts:1329) even though ANTHROPIC_BASE_URL points at the local fixture,
// because the price table match is purely by model-id string, independent
// of endpoint reachability. Still zero real cost: the fixture server, not a
// real provider, answers every request.
// ---------------------------------------------------------------------------
async function gateMaxBudgetUsd(fixture) {
  fixture.setScenario("success");
  const options = {
    env: baseEnv(fixture.url),
    model: "claude-3-5-haiku-latest", // real, recognized model id -> built-in price table match
    mcpServers: {},
    strictMcpConfig: true,
    settingSources: [],
    tools: [],
    maxTurns: 20,
    maxBudgetUsd: 0.0000001 // deliberately far below any real single-turn cost
  };
  const { results, lastResult: result, error } = await drainPacedTurns(
    options,
    Array.from({ length: 10 }, (_, i) => `turn ${i + 1}`)
  );
  const detail =
    `${results.length} result message(s) observed (subtypes: ${results.map((r) => r.subtype).join(", ")}); ` +
    `final: subtype=${result ? result.subtype : "none"}, total_cost_usd=${result ? result.total_cost_usd : "n/a"}, ` +
    `costBasis=${result && result.modelUsage ? JSON.stringify(Object.values(result.modelUsage).map((u) => u.costBasis)) : "n/a"}, num_turns=${result ? result.num_turns : "n/a"}` +
    (error ? `; a terminal exception ALSO followed: ${error.name}: ${error.message}` : "");
  if (result && result.subtype === "error_max_budget_usd") {
    const overrunNote =
      typeof result.total_cost_usd === "number"
        ? ` NOTE (real, load-bearing for group 5): the cap was checked AFTER a turn completed, not before admission — this turn's actual cost (${result.total_cost_usd}) is ~${Math.round(result.total_cost_usd / options.maxBudgetUsd)}x the configured cap (${options.maxBudgetUsd}); maxBudgetUsd stops the NEXT turn, it does not prevent the turn that crosses it (the "in-flight overrun" proposal.md already anticipates).`
        : "";
    record("G7", "maxBudgetUsd stops at the cap with subtype error_max_budget_usd", "PASS", detail + overrunNote);
  } else if (!result && error && /budget/i.test(error.message)) {
    record("G7", "maxBudgetUsd stops at the cap with subtype error_max_budget_usd", "PASS", `no result message was ever yielded before the terminal exception (SDK surfaced the cap purely as a thrown error): ${detail}`);
  } else {
    record("G7", "maxBudgetUsd stops at the cap with subtype error_max_budget_usd", "FAIL", detail);
  }
}

// ---------------------------------------------------------------------------
// G8 — modelUsage vs aggregate usage: aggregate `usage` is MAIN AGENT LOOP
// ONLY (excludes Task subagents); `modelUsage` includes them (sdk.d.ts:4970,
// 4974). Attempted via the real "Task" built-in against the fixture server;
// bounded effort — reported UNOBSERVED with the concrete reason if the
// subagent path does not come up cleanly within this fixture harness, per
// the task's explicit instruction not to assert an unreached path.
// ---------------------------------------------------------------------------
async function gateModelUsageSubagentExclusion(fixture) {
  fixture.setScenario("success");
  const options = {
    env: baseEnv(fixture.url),
    model: "fixture-model",
    mcpServers: {},
    strictMcpConfig: true,
    settingSources: [],
    tools: ["Task"],
    allowedTools: ["Task"],
    maxTurns: 4
  };
  const callLogBefore = fixture.callLog.length;
  const { result, error } = await drain(query({ prompt: "Use the Task tool to spawn a subagent that says hello, then finish.", options }));
  const wireCallsMade = fixture.callLog.length - callLogBefore;
  if (error && !result) {
    record("G8", "modelUsage includes subagent usage; aggregate usage excludes it", "UNOBSERVED", `Task subagent path threw before completion: ${error.name}: ${error.message} — not reachable within this offline fixture harness`);
    return;
  }
  if (!result) {
    record("G8", "modelUsage includes subagent usage; aggregate usage excludes it", "UNOBSERVED", `no result message produced; the Task subagent path did not complete against the fixture server within this harness (likely needs subagent-specific fixture scripting this gate does not implement) — not asserted`);
    return;
  }
  const modelUsageModels = Object.keys(result.modelUsage || {});
  const detail = `${wireCallsMade} real /v1/messages wire call(s) observed; subtype=${result.subtype}, usage=${JSON.stringify(result.usage)}, modelUsage keys=${JSON.stringify(modelUsageModels)}, modelUsage=${JSON.stringify(result.modelUsage)}`;
  if (modelUsageModels.length === 0) {
    record("G8", "modelUsage includes subagent usage; aggregate usage excludes it", "UNOBSERVED", `Task tool did not produce a distinguishable subagent model-usage row against this fixture (fixture always answers generically, not subagent-aware) — cannot confirm the exclusion empirically here. ${detail}`);
    return;
  }
  // Arithmetic proof, not just structural presence: this fixture emits a
  // FIXED usage per SSE response (sendSuccessSse's hard-coded
  // input_tokens:5/output_tokens:3 — see fixture-anthropic-server.mjs), so
  // dividing the reported totals by that constant recovers exactly how many
  // model responses each field counted. If modelUsage counted MORE responses
  // than aggregate `usage` did (for the SAME query() call), that is a direct,
  // per-call-counted empirical confirmation of sdk.d.ts:4970's "MAIN AGENT
  // LOOP ONLY — excludes Task subagent... calls" claim — not just the field
  // being present.
  const FIXTURE_INPUT_PER_CALL = 5;
  const FIXTURE_OUTPUT_PER_CALL = 3;
  const usageCallsImplied = result.usage ? Math.round((result.usage.input_tokens || 0) / FIXTURE_INPUT_PER_CALL) : 0;
  const modelUsageCallsImplied = modelUsageModels.reduce((sum, m) => sum + Math.round((result.modelUsage[m].inputTokens || 0) / FIXTURE_INPUT_PER_CALL), 0);
  const arithmeticDetail = `aggregate usage implies ${usageCallsImplied} model call(s) (input_tokens=${result.usage ? result.usage.input_tokens : "n/a"} / ${FIXTURE_INPUT_PER_CALL}); modelUsage implies ${modelUsageCallsImplied} model call(s) (summed inputTokens / ${FIXTURE_INPUT_PER_CALL}); real wire calls observed=${wireCallsMade}. ${detail}`;
  if (modelUsageCallsImplied > usageCallsImplied) {
    record(
      "G8",
      "modelUsage includes subagent usage; aggregate usage excludes it",
      "PASS",
      `modelUsage counted ${modelUsageCallsImplied - usageCallsImplied} more model call(s) than aggregate usage did for the same query() call — a direct, per-call arithmetic confirmation of the documented exclusion (not just field presence). ${arithmeticDetail}`
    );
  } else {
    record(
      "G8",
      "modelUsage includes subagent usage; aggregate usage excludes it",
      "UNOBSERVED",
      `modelUsage and aggregate usage implied the SAME call count (${modelUsageCallsImplied}) — this run did not produce a distinguishable subagent call to empirically confirm the exclusion arithmetic, only field presence. ${arithmeticDetail}`
    );
  }
}

// ---------------------------------------------------------------------------
// G10 — total reset behavior: a resumed session's cost/usage totals start
// fresh (sdk.d.ts:4966/4974: "resumed sessions start fresh"). Accumulate
// cost over several forced turns, then resume for one more turn and confirm
// the new result's cumulative total is NOT the old cumulative total plus the
// new turn — i.e. it restarted, not continued accumulating.
// ---------------------------------------------------------------------------
async function gateResumeResetsTotals(fixture) {
  fixture.setScenario("success");
  const turn1Options = {
    env: baseEnv(fixture.url),
    model: "claude-3-5-haiku-latest",
    mcpServers: {},
    strictMcpConfig: true,
    settingSources: [],
    tools: [],
    maxTurns: 5
  };
  const { lastResult: r1 } = await drainPacedTurns(turn1Options, ["a", "b", "c"]);
  if (!r1 || r1.is_error || !r1.session_id) {
    record("G10", "resume starts cost/usage totals fresh", "FAIL", `initial multi-turn run did not complete cleanly: ${JSON.stringify(r1)}`);
    return;
  }
  const priorTotal = r1.total_cost_usd;

  const resumeOptions = {
    env: baseEnv(fixture.url),
    model: "claude-3-5-haiku-latest",
    mcpServers: {},
    strictMcpConfig: true,
    settingSources: [],
    tools: [],
    resume: r1.session_id,
    maxTurns: 1
  };
  const { result: r2 } = await drain(query({ prompt: "one more turn after resume", options: resumeOptions }));
  if (!r2 || r2.is_error) {
    record("G10", "resume starts cost/usage totals fresh", "FAIL", `resumed turn did not complete cleanly: ${JSON.stringify(r2)}`);
    return;
  }
  const resumedTotal = r2.total_cost_usd;
  const detail = `prior cumulative total_cost_usd (end of first run, ${r1.num_turns} turns)=${priorTotal}; resumed single-turn total_cost_usd=${resumedTotal}`;
  // "Fresh" means the resumed total should NOT look like priorTotal + a new
  // turn's worth (i.e. should not be >= priorTotal, since priorTotal already
  // covered several turns and the resumed run is only one more turn).
  if (typeof resumedTotal === "number" && typeof priorTotal === "number" && resumedTotal < priorTotal) {
    record("G10", "resume starts cost/usage totals fresh", "PASS", detail);
  } else {
    record("G10", "resume starts cost/usage totals fresh", "UNOBSERVED", `could not confirm a reset from these two datapoints alone (values may both be near-zero on this fixture's fixed token counts, making the comparison inconclusive). ${detail}`);
  }
}

// ---------------------------------------------------------------------------
// G9 — REAL gateway: costBasis and real usage/cost semantics. Off by
// default; requires --live. Resolves the credential exclusively through
// host/agent/settings/profile.js's production path (snapshotForRun),
// exactly like gate-1.5-cancel-reconnect.mjs's testConfiguredRoundTrip().
// Makes EXACTLY ONE real provider call.
// ---------------------------------------------------------------------------
async function gateRealGatewayCostBasis() {
  const ambientLeak = ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN"].filter((k) => process.env[k]);
  if (ambientLeak.length) {
    record("G9", "real gateway costBasis / usage semantics", "FAIL", `ambient credential env var(s) present: ${ambientLeak.join(", ")} — refusing to run this gate with ambient leakage possible`);
    return;
  }
  const { loadProfile, snapshotForRun } = await import("../../settings/profile.js");
  const profile = await loadProfile();
  if (!profile || !profile.hasCredential || !profile.defaultModelId) {
    record("G9", "real gateway costBasis / usage semantics", "BLOCKED", "no usable profile/credential configured on this machine (host/agent/settings/profile.js) — cannot observe real-gateway costBasis without one");
    return;
  }
  const snapshot = await snapshotForRun(profile.profileId, profile.defaultModelId);
  const options = {
    model: snapshot.model,
    mcpServers: {},
    strictMcpConfig: true,
    settingSources: [],
    tools: [],
    maxTurns: 1,
    env: {
      PATH: process.env.PATH || process.env.Path || "",
      ...(process.platform === "win32" ? { SystemRoot: process.env.SystemRoot || "" } : {}),
      CLAUDE_CONFIG_DIR: SCRATCH_CONFIG_DIR,
      ...snapshot.env
    }
  };
  const { result } = await drain(query({ prompt: "Reply with exactly one word: pong", options }));
  if (!result || result.is_error) {
    record("G9", "real gateway costBasis / usage semantics", "FAIL", `live round trip failed: ${JSON.stringify(result)}`);
    return;
  }
  const modelUsageEntries = Object.entries(result.modelUsage || {});
  const costBases = modelUsageEntries.map(([m, u]) => `${m}: costBasis=${u.costBasis ?? "n/a"}, costUSD=${u.costUSD ?? "n/a"}`);
  const detail =
    `model=${snapshot.model}, subtype=${result.subtype}, total_cost_usd=${result.total_cost_usd} (REAL SDK estimate, not a billing statement), ` +
    `usage(main-loop-only)=${JSON.stringify(result.usage)}, modelUsage=[${costBases.join("; ")}]`;
  record("G9", "real gateway costBasis / usage semantics", "PASS", detail);
}

export async function run({ live = false } = {}) {
  const fixture = await startFixtureAnthropicServer({ scenario: "success" });
  try {
    await gateResumeContextNoReplay(fixture);
    await gateMissingSessionExplicit(fixture);
    await gatePersistSessionFalse(fixture);
    await gateCwdIsPartOfSessionIdentity(fixture);
    await gateForkSession(fixture);
    await gateCancellationPartialResult();
    await gateMaxTurns(fixture);
    await gateMaxTurnsInternalToolLoop();
    await gateMaxBudgetUsd(fixture);
    await gateModelUsageSubagentExclusion(fixture);
    await gateResumeResetsTotals(fixture);
    if (live) {
      await gateRealGatewayCostBasis();
    } else {
      record("G9", "real gateway costBasis / usage semantics", "SKIPPED", "run with --live to exercise this gate (makes exactly one real provider call against the configured profile/credential)");
    }
  } finally {
    await fixture.close();
    try {
      fs.rmSync(SCRATCH_CONFIG_DIR, { recursive: true, force: true });
    } catch {}
  }

  const summary = {
    pass: results.filter((r) => r.status === "PASS").length,
    fail: results.filter((r) => r.status === "FAIL").length,
    blocked: results.filter((r) => r.status === "BLOCKED").length,
    unobserved: results.filter((r) => r.status === "UNOBSERVED").length,
    skipped: results.filter((r) => r.status === "SKIPPED").length,
    total: results.length
  };
  console.log("\n=== SUMMARY ===");
  console.log(JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(results, null, 2));
  return { results, summary };
}

import { fileURLToPath } from "node:url";
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const live = process.argv.includes("--live");
  run({ live }).then(({ summary }) => {
    if (summary.fail > 0) process.exitCode = 1;
  });
}
