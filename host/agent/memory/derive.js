// Deriving a task memory from a completed run
// (openspec/changes/add-task-memory design.md decision 1; spec "A task memory
// is derived only from a completed run's recorded evidence" and "Memory
// record shape and secret screening").
//
// The host derives; the model never writes. The input is the run's own
// recorded trail — the transcript's assistant `tool_use` blocks, or Jev's
// `jev_step` records — read through EXACTLY the functions workflow
// materialization already uses (runTrailWindow / extractRunToolCalls /
// extractRunTargetIdentities / screenTrailArgs / freezeStableTargets). There
// is one trail reader and one secret screen in this codebase, and task memory
// is a second consumer of both, never a second implementation.
//
// What makes a memory different from a workflow draft:
//
//   - A draft must be COMPLETE to be useful (a replay cannot guess); a memory
//     only has to be HONEST. A step that cannot be kept safely is recorded in
//     place as `{ omitted: true, reason }` — the sequence keeps its shape and
//     tells the model a step happened there — instead of refusing the whole
//     memory.
//   - A draft may keep literal typed values the operator reviews; a memory is
//     never reviewed, so typed text (form_input `value`, a `type` action's
//     `text`) and page-script source are dropped unconditionally and the step
//     says so (`valueOmitted` / `scriptOmitted`).
//   - Only a run that really succeeded derives anything. `run_done` alone is
//     not enough: SessionManager.finishRun() marks every finished run done,
//     so a run that hit `run_error` also ends with `run_done`. A window that
//     carries `run_error`, `run_stopped`, a Jev `jev_end` that did not end
//     `done`, or a workflow drift outcome derives nothing.
//
// Run OUTPUTS never reach a memory — no tool result, no page text, no
// extracted field, no assistant reply. The one exception is the one
// materialization already makes: the run's recorded STARTING PAGE URL.

import { hostOfUrl, normalizeHost } from "../skills/workflows-match.js";
import {
  TRAIL_EXCLUDED_TOOL_REFS,
  TRAIL_USER_FILE_TOOL_REFS,
  extractRunTargetIdentities,
  extractRunToolCalls,
  freezeStableTargets,
  looksSecretBearing,
  recordedStartUrl,
  runTrailWindow,
  screenTrailArgs
} from "../skills/workflows-materialize.js";
import { summarizeIntent, tokenizeIntent } from "./intent.js";
import { MAX_STEPS, MEMORY_STATES, TASK_MEMORY_SCHEMA_VERSION, newMemoryId } from "./store.js";

/** Bumped when what derivation reads or keeps changes. */
export const DERIVE_VERSION = 1;

/** Tools that say how the run was conducted, not how the task was done: the
 *  workflow exclusions, plus the conversation-level tools whose effect a
 *  later run cannot reuse (asking the operator a question, the memory tool
 *  itself, a heal proposal). */
export const MEMORY_EXCLUDED_TOOL_REFS = Object.freeze([
  ...TRAIL_EXCLUDED_TOOL_REFS,
  "ask_user",
  "task_memory",
  "propose_workflow_heal"
]);

// A control whose name reads like a credential field is not kept as an
// identity: its label is fine to show, but a memory is never reviewed, so the
// conservative rule is not to carry it at all.
const CREDENTIAL_LABEL_PATTERN = /(password|passwd|mật\s*khẩu|otp|one[-\s]?time|cvv|cvc|\bpin\b|mã\s*xác\s*(thực|nhận)|secret|token|api\s*key)/i;

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Did this run end in a clean, successful completion?
 *
 * @returns {{ ok: true, startedAt: number|null, endedAt: number|null } | { ok: false, reason: string }}
 */
export function runSucceeded({ conversationEvents, runId }) {
  const events = Array.isArray(conversationEvents) ? conversationEvents : [];
  const window = runTrailWindow({ conversationEvents: events, runId });
  if (!window.ok) return window;
  let startedAt = null;
  let endedAt = null;
  let sawDone = false;
  for (const event of events) {
    if (!event || event.runId !== runId || typeof event.seq !== "number") continue;
    if (event.seq < window.startSeq) continue;
    if (event.type === "run_created" && startedAt === null && Number.isFinite(event.ts)) startedAt = event.ts;
    if (event.seq > window.endSeq) continue;
    if (event.type === "run_error") return { ok: false, reason: "run_error" };
    if (event.type === "run_stopped") return { ok: false, reason: "run_stopped" };
    if (event.type === "jev_end" && event.outcome !== "done") return { ok: false, reason: `jev_${event.outcome || "ended"}` };
    if (event.type === "workflow_drift" || (event.type === "workflow_proof" && event.outcome === "drift")) {
      return { ok: false, reason: "drift" };
    }
    if (event.type === "run_done") {
      sawDone = true;
      if (Number.isFinite(event.ts)) endedAt = event.ts;
    }
  }
  if (!sawDone) return { ok: false, reason: "run_not_completed" };
  return { ok: true, startedAt, endedAt };
}

/** The element identity a step's frozen args carry, unless it reads like a
 *  credential field. */
function stepTarget(args) {
  const target = isPlainObject(args) && isPlainObject(args.target) ? args.target : null;
  if (!target || typeof target.name !== "string" || !target.name.trim()) return null;
  const name = target.name.replace(/\s+/g, " ").trim().slice(0, 200);
  if (CREDENTIAL_LABEL_PATTERN.test(name) || looksSecretBearing(name)) return null;
  return { ...(typeof target.role === "string" && target.role ? { role: target.role.slice(0, 40) } : {}), name };
}

/** Drop typed values and script source; say that the step had them. */
function stripOperatorValues(tool, args) {
  const out = { ...args };
  const flags = {};
  if (tool === "form_input" && "value" in out) {
    delete out.value;
    flags.valueOmitted = true;
  }
  if (tool === "computer" && out.action === "type" && "text" in out) {
    delete out.text;
    flags.valueOmitted = true;
  }
  if (tool === "javascript_tool" && "text" in out) {
    delete out.text;
    flags.scriptOmitted = true;
  }
  // A frozen identity lives in `step.target`; the args keep the rest.
  delete out.target;
  return { args: out, flags };
}

/**
 * Derive one task memory from a completed run.
 *
 * @param {object} input
 * @param {Array} input.conversationEvents - TranscriptStore.allEvents()
 * @param {string} input.conversationId
 * @param {string} input.runId
 * @param {string} input.request - the operator's own text for this turn
 * @param {string|null} [input.boundHost] - the run's bound page host at start
 * @param {string|null} [input.metaHostname] - the conversation's recorded host
 * @param {{ rawPromptCaching?: boolean }} [input.privacy]
 * @param {() => number} [input.now]
 * @returns {{ ok: true, memory: object } | { ok: false, reason: string }}
 */
export function deriveTaskMemory({
  conversationEvents,
  conversationId,
  runId,
  request,
  boundHost = null,
  metaHostname = null,
  privacy = {},
  now = Date.now
} = {}) {
  // The privacy control pauses writing entirely: a memory without its intent
  // could only be recalled by site, which would be guessing.
  if (privacy && privacy.rawPromptCaching === false) return { ok: false, reason: "privacy_paused" };

  const success = runSucceeded({ conversationEvents, runId });
  if (!success.ok) return { ok: false, reason: success.reason };

  const extracted = extractRunToolCalls({ conversationEvents, runId });
  if (!extracted.ok) return { ok: false, reason: extracted.reason };
  // The sanitized action timeline names tools but never their arguments: a
  // memory built from it would say nothing a run could use.
  if (extracted.source === "action_timeline") return { ok: false, reason: "no_resolved_trail" };

  const identities = extractRunTargetIdentities({ conversationEvents, runId });
  const startUrl =
    extracted.source === "jev_steps"
      ? extracted.startUrl || null
      : recordedStartUrl({ conversationEvents, runId, calls: extracted.calls });
  const startHost = startUrl ? hostOfUrl(startUrl) : null;
  const host =
    normalizeHost(boundHost || "") ||
    startHost ||
    extracted.calls.map((call) => (typeof call.input?.url === "string" ? hostOfUrl(call.input.url) : null)).find(Boolean) ||
    normalizeHost(metaHostname || "");
  if (!host) return { ok: false, reason: "no_site" };

  const steps = [];
  let currentHost = startHost || host;
  for (const call of extracted.calls) {
    if (MEMORY_EXCLUDED_TOOL_REFS.includes(call.name)) continue;
    const index = steps.length + 1;
    const action = typeof call.input?.action === "string" ? call.input.action.slice(0, 40) : undefined;
    const base = { index, tool: call.name, ...(action ? { action } : {}), host: currentHost };
    const omit = (reason) => steps.push({ ...base, omitted: true, reason: String(reason).slice(0, 300) });

    if (!/^[a-z][a-z0-9_]{0,63}$/.test(call.name)) {
      steps.push({ ...base, tool: "unknown_tool", omitted: true, reason: "the recorded tool name is not a registry tool" });
      continue;
    }
    if (TRAIL_USER_FILE_TOOL_REFS.includes(call.name)) {
      omit("the step used a file the operator picked for that run");
      continue;
    }
    if (call.issues?.length) {
      omit(call.issues.join("; "));
      continue;
    }
    if (!call.argsResolved) {
      omit("the recorded arguments could not be resolved from the transcript");
      continue;
    }
    const screened = screenTrailArgs(call.input);
    if (!screened.ok) {
      omit(screened.reasons.join("; "));
      continue;
    }
    const frozen = freezeStableTargets(screened.args, call.source === "jev_steps" ? call.identities : identities);
    const target = stepTarget(frozen.args);
    const { args, flags } = stripOperatorValues(call.name, frozen.args);
    if (call.name === "navigate" && typeof args.url === "string") {
      currentHost = hostOfUrl(args.url) || currentHost;
      base.host = currentHost;
    }
    steps.push({ ...base, args, ...(target ? { target } : {}), ...flags });
  }

  if (!steps.length) return { ok: false, reason: "no_actions" };
  if (steps.length > MAX_STEPS) return { ok: false, reason: "too_many_steps" };

  const completedAt = success.endedAt ?? now();
  const memory = {
    schemaVersion: TASK_MEMORY_SCHEMA_VERSION,
    id: newMemoryId(completedAt),
    host,
    intent: { text: summarizeIntent(request), tokens: tokenizeIntent(request) },
    startUrl: startUrl && startUrl.length <= 2048 ? startUrl : null,
    steps,
    outcome: {
      status: "completed",
      actionCount: steps.filter((step) => !step.omitted).length,
      durationMs:
        Number.isFinite(success.startedAt) && Number.isFinite(success.endedAt) && success.endedAt >= success.startedAt
          ? Math.round(success.endedAt - success.startedAt)
          : null
    },
    provenance: { conversationId, runId, completedAt, deriveVersion: DERIVE_VERSION },
    stats: { useCount: 0, lastUsedAt: null, lastConfirmedAt: completedAt, state: MEMORY_STATES.FRESH }
  };
  return { ok: true, memory };
}
