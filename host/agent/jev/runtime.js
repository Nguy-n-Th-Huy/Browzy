// Jev selects complete actions and independent completion/progress judgments
// from fresh observations. The LLM prepares bounded content initially and on
// replan, verifies completion, and writes the report. Host gates, document and
// field identity checks, and execution bounds remain authoritative.

import { RUN_STATES } from "../session/run.js";
import { runHostSideChecks, firstTextOf } from "../tools/dispatch-checks.js";
import { buildActionSpace, buildDecisionRequest, observationSignature, OPERATIONS } from "./questions.js";
import { requestDecision, JevError } from "./client.js";
import { fetchSource, SourceFetchError } from "./source-fetch.js";
import { observationEvidence, screenshotArtifact } from "./evidence.js";
import {
  requestActionPlan,
  requestCompletionCheck,
  requestFinalReport,
  MAX_OBSERVATION_TEXT_CHARS,
  MAX_CONSULTED_SOURCES
} from "./text-helper.js";

export const PAGE_SNAPSHOT_TOOL = "page_snapshot";

// The action confidence floor (spec `typesafe-jev-provider`, "Single-request decision
// protocol with strict validation"): when is a validated answer still not a
// decision?
//
// Two values, because the SHAPE of the distribution says more than any
// absolute number can. Over a head of two hundred candidates a winner at 0.15
// against a field at 0.003 each is a confident pick, and an absolute floor on
// that probability would throw it away — so there is deliberately no such
// floor here.
//
//   - CONFIDENCE: the provider's own confidence for the answered head, when
//     the wire reported one (the direct source carries it on the answer, the
//     Vercel gateway in its provider metadata, and a wire that reports none
//     leaves it absent — never invented). Below this, the answer is a guess.
//   - MARGIN: how far the chosen candidate's probability stands above the
//     runner-up's. This rule applies on EVERY source, including one that
//     reports no confidence at all: two candidates within a hair of each
//     other name no winner, whatever the confidence claims.
//
// Both are set to reject only a genuinely near-uniform or near-tied answer,
// because an abstention is not free: three of them in a row end the run
// through the no-progress guard. An abstained step takes the path a step with
// no compatible candidate already takes — recorded skipped, counted once
// toward that guard, the loop continuing — so nothing new had to be invented
// for it, and the next decision sees the skip in its recent actions.
const SELECTION_CONFIDENCE_FLOOR = 0.25;
const SELECTION_PROBABILITY_MARGIN = 0.05;

/**
 * The runner-up's probability in one answered head, or 0 when the head offered
 * a single candidate (nothing to be confused with).
 */
function runnerUpProbability(probabilities, chosenKey) {
  if (!probabilities || typeof probabilities !== "object") return 0;
  let best = 0;
  for (const [key, value] of Object.entries(probabilities)) {
    if (key === chosenKey) continue;
    const p = Number(value);
    if (Number.isFinite(p) && p > best) best = p;
  }
  return best;
}

/**
 * Whether a validated complete-action choice is confident enough to use.
 * Pure, so the runtime and its tests read the same rule.
 */
function selectionResolves(decision) {
  const confidence = typeof decision?.confidence === "number" ? decision.confidence : null;
  const chosen = typeof decision?.actionProbability === "number" ? decision.actionProbability : 0;
  const runnerUp = runnerUpProbability(decision?.probabilities, decision?.actionKey);
  if (confidence !== null && confidence < SELECTION_CONFIDENCE_FLOOR) return { ok: false, runnerUp };
  if (chosen - runnerUp < SELECTION_PROBABILITY_MARGIN) return { ok: false, runnerUp };
  return { ok: true, runnerUp };
}

// The capture's own tool/action (design.md §1): the existing read-only
// `computer` screenshot action — never a new tool, never annotated (the
// reference labels are Jev's numbering space, and a decision model reading
// "ref_12" off a picture risks a wrong mental model of the offered table), and
// never `save_to_disk` (this feature writes no image to disk). The image comes
// back as an `{type:"image", data, mimeType}` content item, the shape the
// capture path has always answered.
const SCREENSHOT_TOOL = "computer";
const SCREENSHOT_ACTION = "screenshot";

// Design.md §6's bounds, matching the reference's MAX_STEPS (60) and its
// 2x decision budget (MAX_STEPS * 2).
export const MAX_ACTIONS = 60;
export const MAX_DECISIONS = 120;

// The panel keeps its 200-character URL digest. Workflow materialization
// needs the complete address, including the end of a long search query.
// Match workflows-materialize.js's capture bound; an over-bound address is
// explicitly unavailable, never stored as a plausible navigation prefix.
export const MAX_REPLAY_URL_CHARS = 8192;

// Design.md §6's no-progress rule: three consecutive executed actions whose
// observation signature did not change. The reference exempts WAIT from the
// streak; this port does not, because the spec's rule ("three consecutive
// executed actions whose page identity and element state did not change") has
// no exemption and Browzy's WAIT is a fixed 1s pause — three fruitless waits is
// a stuck run, not patience.
export const NO_PROGRESS_LIMIT = 3;

// The scroll brake (see the loop): a run of SCROLL_* decisions that keeps
// offering the SAME element table — nothing new entering the observation —
// is a dead end even though the viewport moved, because the controls the
// loop is hunting for are either already offered or not on this page at all.
// Set higher than NO_PROGRESS_LIMIT because a long list legitimately needs
// several scrolls before the next row of controls appears. Observed live: a
// run scrolled 20+ times on a page whose filter form had never been
// identified, each scroll counting as "change" and resetting the old guard.
export const SCROLL_STREAK_LIMIT = 6;

// The scroll-only streak (design.md §3): consecutive EXECUTED steps whose
// operation is SCROLL_UP or SCROLL_DOWN — either direction, and regardless of
// what the element table did. The brake above watches the table; this guard
// watches the run's own behaviour, because the live failure that motivated it
// changed the table on every scroll (so the brake never fired) and alternated
// directions (so nothing else counted), letting 21 fruitless scrolls burn the
// decision budget. Any other executed step resets the streak, and a recovery
// that followed one of its trips makes the next executed scroll terminal.
export const SCROLL_ONLY_STREAK_LIMIT = 8;

// The run-context bounds (openspec/changes/add-jev-run-context design.md §3,
// §4, §5). Every one of them is exported so a test can assert the production
// numbers and override them through `runTypesafeRun`'s `limits` parameter
// without driving real cycles.
//
//   - a revision happens after this many executed actions since the last one
//     (the plan is not a revision and does not count toward the cap below);
//   - the whole memory is replaced at most MAX_MEMORY_UPDATES times per run;
//   - a `DONE` claim the completion check rejects is recorded at most
//     MAX_VERIFICATION_REJECTIONS times, after which the run ends blocked as
//     `completion_unverified` rather than claiming what the check disputes;
//   - at most MAX_RECOVERIES stall consultations may reset the guards, after
//     which a stalled run ends blocked with the reason its guard detected.
export const MEMORY_UPDATE_EVERY_ACTIONS = 5;
export const MAX_MEMORY_UPDATES = 8;
export const MAX_VERIFICATION_REJECTIONS = 3;
export const MAX_RECOVERIES = 2;
export const MAX_REPLANS_WITHOUT_PROGRESS = 3;

export const WAIT_ACTION_SECONDS = 1;
export const SCROLL_ACTION_TICKS = 3;

/**
 * Every reason this module can record — the terminal `jev_end` reasons by
 * outcome, plus the `jev_step` reasons recorded when a cycle dispatched
 * nothing (or could not). Exported for the one cross-check that keeps the
 * panel honest: its Vietnamese label table (extension/sidepanel/
 * tool-labels.js's `JEV_REASON_LABELS_VI`) is asserted to cover EXACTLY this
 * set by test/sidepanel-conversation-model.test.mjs — a reason that shipped
 * without copy would render as a raw English token, and a label with no
 * producer is dead copy.
 *
 * The companion's own pre-loop/around-loop failures
 * (`unsupported_in_typesafe_mode`, `observation_failed` for a run with no
 * bound tab, `jev_runtime_failed`) are run_error reasons the panel renders
 * through its generic error note, not through this table.
 */
export const JEV_REASON_VOCABULARY = Object.freeze({
  blocked: Object.freeze([
    "model_blocked",
    // The run stopped because only the OPERATOR can resolve what stands in
    // the way — a login, a choice the goal does not decide, a value the run
    // must not invent. Distinct from `model_blocked`, which is "no supported
    // operation makes progress": one is a question, the other is a dead end,
    // and a panel that renders them identically teaches the operator to
    // ignore both.
    "needs_operator",
    "no_progress",
    "step_budget",
    "decision_budget",
    "action_denied",
    "missing_value",
    "completion_unverified",
    "replan_limit"
  ]),
  stopped: Object.freeze(["stopped"]),
  error: Object.freeze(["observation_failed", "provider_error", "invalid_decision", "text_model_error", "tool_result_unknown", "navigation_failed", "preparation_failed"]),
  step: Object.freeze([
    "done",
    "target_unresolved",
    "model_blocked",
    "needs_operator",
    "step_budget",
    "stopped",
    "missing_value",
    "text_model_error",
    "unsupported_operation",
    "action_denied",
    "result_unknown",
    "navigation_failed",
    "repeated_no_change",
    "completion_rejected",
    "replan",
    "stale_observation",
    "completion_unverified"
  ])
});

// The reference's history `kind` vocabulary, used for the `recent_actions`
// rows the next request carries.
const KIND_BY_OPERATION = Object.freeze({
  [OPERATIONS.CLICK]: "click",
  [OPERATIONS.HOVER]: "hover",
  [OPERATIONS.TYPE_TEXT]: "fill",
  [OPERATIONS.SELECT]: "select",
  [OPERATIONS.NAVIGATE]: "navigate",
  [OPERATIONS.SCROLL_UP]: "scroll",
  [OPERATIONS.SCROLL_DOWN]: "scroll",
  [OPERATIONS.WAIT]: "wait"
});

// The normalized arguments one `jev_step` records. Deliberately hand-built
// rather than `normalizeApprovalArgs` (mapping.js): that function is the
// APPROVAL binding shape, and its generic branch drops `form_input`'s ref and
// value entirely, which is what the step record must show instead.
//
// A generated TYPE_TEXT value is NEVER included: the durable transcript row
// renders this summary verbatim, so the event records which field received a
// value (`textField`) and no value itself. A SELECT's option value is page
// data, not user input, and is what makes that step legible.
function summarizeArgs(tool, args, { omitValue = false } = {}) {
  if (tool === "computer") {
    const summary = { action: args.action, tabId: args.tabId };
    if (args.ref !== undefined) summary.ref = args.ref;
    if (args.coordinate !== undefined) summary.coordinate = args.coordinate;
    if (args.scroll_direction !== undefined) summary.scroll_direction = args.scroll_direction;
    if (args.scroll_amount !== undefined) summary.scroll_amount = args.scroll_amount;
    if (args.duration !== undefined) summary.duration = args.duration;
    if (args.text !== undefined) summary.text = args.text;
    return summary;
  }
  if (tool === "form_input") {
    return omitValue ? { ref: args.ref, tabId: args.tabId } : { ref: args.ref, value: args.value, tabId: args.tabId };
  }
  return { ...args };
}

function observedPageUrl(value) {
  const url = typeof value === "string" ? value : "";
  const replayUrlTruncated = url.length > MAX_REPLAY_URL_CHARS;
  return {
    url: url.slice(0, 200),
    replayUrl: url && !replayUrlTruncated ? url : null,
    replayUrlTruncated
  };
}

// Only browser-owned empty starting surfaces can bootstrap without a DOM.
// Settings, extension pages, stores and arbitrary about: pages never qualify.
const BLANK_START_URL_PATTERN = /^(?:about:blank|(?:chrome|edge|brave):\/\/(?:newtab|new-tab-page)\/?)$/i;

function unavailableSnapshot(value, tabId) {
  if (!value || value.v !== 1 || value.available !== false || value.tabId !== tabId) return null;
  if (value.reason === "stale_context" && value.url === null) return { reason: value.reason, tabId, url: null };
  if (value.reason === "restricted_page" && typeof value.url === "string" && value.url.length > 0) {
    return { reason: value.reason, tabId, url: value.url };
  }
  return null;
}

// Compatibility with the exact refusal older extensions shipped. A random
// non-JSON response, another tab's refusal or an edited prefix cannot enable
// navigation. This is tab metadata, never fabricated page content.
function legacyUnavailableSnapshot(text, tabId) {
  const restricted = text.match(/^Restricted page: tab (\d+) \(([^\r\n]+)\) is a browser-internal or store page that cannot be read by content scripts\. Identify this limitation to the user rather than guessing its content or opening a different tab\.$/);
  if (restricted && Number(restricted[1]) === tabId) return { reason: "restricted_page", tabId, url: restricted[2] };
  const stale = `Stale context: tab ${tabId} is no longer open. The page bound to this run is gone — do not retry against a different or newly active tab; report this to the user and ask them to reopen the page or bind a new one.`;
  return text === stale ? { reason: "stale_context", tabId, url: null } : null;
}

const BOOTSTRAP_FAILURE_TEXT = Object.freeze({
  action_denied: "Yêu cầu mở trang chưa được cho phép nên mình chưa đọc được trang web để bắt đầu. Bạn hãy kiểm tra quyền thao tác rồi thử lại.",
  navigation_failed: "Mình chưa xác nhận được việc mở trang web để bắt đầu yêu cầu. Bạn hãy kiểm tra tab đang mở rồi thử lại.",
  tool_result_unknown: "Đã gửi yêu cầu mở trang nhưng mất phản hồi nên mình chưa xác nhận được kết quả. Mình đã dừng và không gửi lại thao tác.",
  invalid_decision: "Mô hình chưa đưa ra thao tác mở trang hợp lệ nên mình đã dừng trước khi thao tác. Bạn có thể mở trang cần dùng rồi gửi lại yêu cầu.",
  text_model_error: "Mô hình chưa quyết định được cách bắt đầu yêu cầu nên mình chưa mở hay đọc trang web. Bạn hãy thử lại hoặc mở trang cần dùng trước.",
  missing_value: "Mô hình chưa cung cấp địa chỉ trang web cần mở. Bạn hãy mở trang cần dùng hoặc bổ sung địa chỉ rồi thử lại.",
  step_budget: "Lượt chạy đã chạm giới hạn thao tác trước khi mở được trang web. Bạn hãy bắt đầu lượt mới để tiếp tục.",
  decision_budget: "Lượt chạy đã chạm giới hạn quyết định khi bắt đầu. Bạn hãy bắt đầu lượt mới để tiếp tục."
});

/**
 * @param {object} opts
 * @param {import("../session/run.js").Run} opts.run - a started (running) run;
 *   lifecycle stays the companion's (`markDone`/`stop` are never called here)
 * @param {import("../broker/tool-bridge.js").ToolBridge} opts.toolBridge
 * @param {(args: object) => object} opts.coerceArgs - the same argument
 *   coercion the SDK tool handlers apply
 * @param {(toolName: string, args: object) => Promise<{behavior: string, message?: string}>} opts.canUseTool
 *   - the approval gate, called with the LEGACY tool name (can-use-tool.js
 *   accepts both call shapes)
 * @param {{ source?: "typesafe"|"vercel"|"openrouter", conversation?: Array<object>, endpoint: string, apiKey: string, model: string, goal: string, tabId: number,
 *   sendScreenshots?: boolean,
 *   textModel: { baseUrl: string, model: string, apiKey: string } }} opts.provider
 *   - `sendScreenshots` is the profile's screenshot toggle, already resolved
 *     by the companion: `true` captures the bound tab for each preparation
 *     and completion consultation. Routine Jev decisions stay text-only.
 *     Anything else — the toggle off, or a
 *     caller that never resolved it — makes every request text-only
 *     (openspec/changes/add-jev-run-screenshots design.md §4)
 * @param {() => number} [opts.now]
 * @param {(ms: number) => Promise<void>} [opts.sleep] - backoff for the client
 * @param {{ maxActions?: number, maxDecisions?: number, memoryUpdateEveryActions?: number,
 *   maxMemoryUpdates?: number, maxVerificationRejections?: number, maxRecoveries?: number,
 *   scrollOnlyStreak?: number }} [opts.limits] -
 *   production never passes this; tests use it to exercise the bounds and the
 *   memory/completion/recovery paths without driving real cycles
 * @returns {Promise<{ outcome: "done"|"blocked"|"stopped"|"error", reason: string|null, steps: number,
 *   doneVerified?: boolean, error?: { code: string, message: string }, summaryError?: string }>}
 */
export async function runTypesafeRun({
  run,
  toolBridge,
  coerceArgs,
  canUseTool,
  provider,
  now = Date.now,
  // The source reader, injectable for the same reason `now` and `sleep` are:
  // a test drives the loop's WIRING against a local document server, while the
  // guards that decide what may be read at all are proven in the fetch
  // client's own suite. Production always gets the guarded client — including
  // its refusal of loopback, which is why a test cannot simply point this at
  // its own server.
  fetchSourceImpl = fetchSource,
  sleep,
  limits = {}
}) {
  if (!run) throw new TypeError("runTypesafeRun requires a run");
  if (!toolBridge || typeof toolBridge.call !== "function") throw new TypeError("runTypesafeRun requires a toolBridge");
  if (typeof coerceArgs !== "function") throw new TypeError("runTypesafeRun requires a coerceArgs function");
  if (typeof canUseTool !== "function") throw new TypeError("runTypesafeRun requires a canUseTool function");
  if (!provider || typeof provider !== "object") throw new TypeError("runTypesafeRun requires a provider");

  const maxReplansWithoutProgress = Number.isFinite(limits.maxReplansWithoutProgress) ? Math.max(1, limits.maxReplansWithoutProgress) : MAX_REPLANS_WITHOUT_PROGRESS;
  const maxActions = Number.isFinite(limits.maxActions) ? Number(limits.maxActions) : MAX_ACTIONS;
  const maxDecisions = Number.isFinite(limits.maxDecisions) ? Number(limits.maxDecisions) : MAX_DECISIONS;
  const memoryUpdateEveryActions = Number.isFinite(limits.memoryUpdateEveryActions) ? Number(limits.memoryUpdateEveryActions) : MEMORY_UPDATE_EVERY_ACTIONS;
  const maxMemoryUpdates = Number.isFinite(limits.maxMemoryUpdates) ? Number(limits.maxMemoryUpdates) : MAX_MEMORY_UPDATES;
  const maxVerificationRejections = Number.isFinite(limits.maxVerificationRejections) ? Number(limits.maxVerificationRejections) : MAX_VERIFICATION_REJECTIONS;
  const maxRecoveries = Number.isFinite(limits.maxRecoveries) ? Number(limits.maxRecoveries) : MAX_RECOVERIES;
  const scrollOnlyStreakLimit = Number.isFinite(limits.scrollOnlyStreak) ? Number(limits.scrollOnlyStreak) : SCROLL_ONLY_STREAK_LIMIT;
  const tabId = provider.tabId;
  // The screenshot toggle (design.md §4): the companion resolves the profile's
  // default and hands the runtime a boolean; ONLY an explicit `true` enables
  // captures, so an unresolved/absent flag makes every request text-only.
  const screenshotsEnabled = provider.sendScreenshots === true;
  const history = [];
  let executed = 0;
  let decisionsMade = 0;
  // Declared here, not at their first use further down, because `finish()`
  // below closes over them and the loop's earliest failure paths call it
  // before the first observation ever runs. `snapshot === null` is exactly
  // "this run has nothing to report".
  let snapshot = null;
  let pageAvailability = null;
  let signature = null;
  let memory = null;
  // Content-script isNew is a read watermark. Preserve that observed evidence
  // through host preflight/settle reads until one actual decision consumes it.
  let pendingNewDocument = null;
  const pendingNewRefs = new Set();
  // What the run has looked at, for the answer to look back over. One record
  // per DISTINCT observation: a page observed again without changing — a menu
  // opening and closing, a stall re-reading the same screen — contributes
  // nothing new, or the budget would fill with copies of one page. Trimming
  // (oldest first) and the byte budget live in text-helper's projection; this
  // side only decides what counts as a distinct look at the page.
  const observations = [];
  const observationKeys = new Set();
  const recordObservation = (snap) => {
    if (!snap) return;
    const url = typeof snap.url === "string" ? snap.url : "";
    const title = typeof snap.title === "string" ? snap.title : "";
    const text = String(snap.text ?? "").slice(0, MAX_OBSERVATION_TEXT_CHARS);
    if (!text && !url) return;
    const links = observedLinks(snap);
    const key = JSON.stringify([url, text, links]);
    if (observationKeys.has(key)) return;
    observationKeys.add(key);
    observations.push({ url, title, text, links });
  };

  // Sources read beyond the page this run drives (spec: "A run may consult
  // sources beyond the page it drives"). Consulted ONCE, at the analysis
  // phase, never inside the cycle: a fetch between two steps would put a
  // network round trip in a loop whose per-step cost is the reason this engine
  // exists, and a loop that can read will read instead of act.
  //
  // Every URL here was named by the decision model from the page it was
  // reading or from the goal. A URL found inside a fetched document is not
  // consulted on that basis — one hop per named source, never a chain a
  // hostile page could walk the run down.
  const consultSources = provider.consultSources !== false;
  const consultNamedSources = async (urls) => {
    const named = (Array.isArray(urls) ? urls : []).slice(0, MAX_CONSULTED_SOURCES);
    const read = [];
    for (const url of named) {
      if (!isRunning()) break;
      try {
        const source = await fetchSourceImpl({ url });
        read.push({ url: source.url, title: source.title, text: source.text });
      } catch (err) {
        // A source that cannot be read is named as unread, never dropped in
        // silence and never a reason to fail the run: the answer says what it
        // could not consult.
        const reason = err instanceof SourceFetchError ? `${err.code}: ${err.message}` : err?.message ?? String(err);
        read.push({ url: String(url), title: "", unreadReason: reason });
      }
    }
    return read;
  };

  // What was consulted, for the answer to attribute and for `finish()` to
  // hand to the report. Empty on every run that consulted nothing.
  let consultedSources = [];

  // Exactly one answer per run: the completion check's own report already is
  // one when a DONE was confirmed, and the final report never duplicates it.
  let resultEmitted = false;
  const emitResult = (text, latencyMs) => {
    if (!text || resultEmitted) return;
    resultEmitted = true;
    run.emit({ type: "jev_result", text, latencyMs });
  };

  const isRunning = () => run.state === RUN_STATES.RUNNING;
  const emitStep = (step) => run.emit({ type: "jev_step", dispatched: false, ...step });
  let previousPhase = null;
  let phaseStep = 1;
  const emitPhase = (phase) => {
    const step = phaseStep;
    const key = `${phase}:${step}`;
    if (isRunning() && key !== previousPhase) { run.emit({ type: "jev_phase", phase, step }); previousPhase = key; }
  };
  const finishUnavailable = (unavailable) => {
    if (!isRunning()) return finish({ outcome: "stopped", reason: "stopped" });
    emitResult(unavailable.reason === "stale_context"
      ? "Tab của lượt chạy này đã đóng nên mình chưa đọc được trang. Bạn hãy mở lại trang cần dùng rồi gửi lại yêu cầu."
      : "Trang hiện tại là trang nội bộ hoặc cửa hàng tiện ích của trình duyệt nên mình không đọc được nội dung. Bạn hãy mở trang web cần dùng trong tab này rồi gửi lại yêu cầu.", 0);
    return finish({ outcome: "blocked", reason: "needs_operator" });
  };
  // Only a verified completion can end done. Failed checks end blocked and
  // disclose their failure without claiming successful completion.
  const finish = async ({ outcome, reason, error, summaryError, doneVerified, completionCheck = null }) => {
    if (!isRunning()) { outcome = "stopped"; reason = "stopped"; error = undefined; }
    // Startup can fail before there is page evidence to give a report model.
    // Explain only the known terminal state; never invent a page or ask the
    // failing decision service again. Stop discards pending explanations.
    if (isRunning() && pageAvailability && snapshot === null && !resultEmitted && outcome !== "done") {
      emitResult(BOOTSTRAP_FAILURE_TEXT[reason] || "Mình chưa đọc được trang web để thực hiện yêu cầu nên đã dừng. Bạn hãy kiểm tra tab đang mở rồi thử lại.", 0);
    }
    // The answer the run owes the operator (spec "Every run answers the
    // operator"). Made HERE — after the outcome and reason are decided, before
    // the terminal record — so the report is told what happened instead of
    // inferring it from a page.
    //
    // Three runs make no call:
    //   - one that already answered (a confirmed DONE's check wrote the
    //     report against the same view of the page its verdict used);
    //   - one that never observed, which has nothing to report;
    //   - one whose terminal failure IS that the decision model could not be
    //     reached, because asking that same model again turns one provider
    //     failure into two.
    let reportError = null;
    const canReport = !resultEmitted && snapshot !== null && !["text_model_error", "preparation_failed"].includes(reason);
    if (canReport) {
      try {
        emitPhase("reporting");
        const report = await requestFinalReport({
          textModel: provider.textModel,
          goal: provider.goal,
          outcome,
          reason: reason ?? null,
          memory,
          page: pageOf(snapshot),
          observations,
          sources: consultedSources,
          // The provider's own search rides this one call, and only where the
          // capability test proved this configuration can run it. It follows
          // the consultation toggle: an operator who turned off reading beyond
          // the driven page turned off searching beyond it too.
          search: consultSources && provider.searchSources === true,
          history,
          conversation: provider.conversation,
          completionCheck,
          now,
          sleep
        });
        if (isRunning() || outcome === "stopped") emitResult(report.report, report.latencyMs);
      } catch (err) {
        // Advisory by contract: the outcome and the reason are already
        // decided and nothing here may change them. The failure is disclosed
        // on the terminal record; operator-needed failures also get a generic
        // clarification fallback that invents no missing details.
        reportError = err?.message ?? String(err);
        if (isRunning() && outcome === "done" && completionCheck?.report) {
          emitResult(completionCheck.report, completionCheck.latencyMs);
        }
        if (isRunning() && reason === "needs_operator") {
          emitResult("Lượt chạy cần bạn hỗ trợ, nhưng mình chưa tạo được câu hỏi làm rõ đáng tin cậy. Bạn có thể xem trang hiện tại và cho biết cách tiếp tục không?", 0);
        }
      }
    }
    if (!isRunning()) { outcome = "stopped"; reason = "stopped"; error = undefined; }
    const verified = outcome === "done" ? doneVerified === true : null;
    const disclosedError = [summaryError, reportError].filter(Boolean).join("; ") || undefined;
    run.emit({
      type: "jev_end",
      outcome,
      reason: reason ?? null,
      ...(reason === "needs_operator" ? { needsOperator: true } : {}),
      steps: executed,
      doneIsDecided: outcome === "done",
      ...(outcome === "done" ? { doneVerified: verified } : {}),
      ...(disclosedError ? { summaryError: disclosedError } : {}),
      // Whether this run produced an answer at all, so a turn without one
      // shows a disclosed absence rather than reading as a blank reply.
      hasResult: resultEmitted
    });
    const result = { outcome, reason: reason ?? null, steps: executed };
    if (reason === "needs_operator") result.needsOperator = true;
    if (outcome === "done") result.doneVerified = verified;
    if (error) result.error = error;
    if (disclosedError) result.summaryError = disclosedError;
    result.hasResult = resultEmitted;
    return result;
  };

  // The settle after typing (spec `typesafe-jev-provider`, "Structured
  // observation through `page_snapshot`"): a suggestion list renders
  // asynchronously, and the loop used to observe the instant the keystrokes
  // landed — so the decision after a TYPE_TEXT saw a page without the
  // suggestions and legitimately typed again. This waits for them, bounded,
  // and returns the moment they appear.
  //
  // "They appeared" is the observation's own newly-appeared marking, not a
  // second notion of change: the same per-document watermark `find` and the
  // accessibility tree use. Clicks also need a bounded settle: a successful
  // dispatch can precede navigation or an asynchronous result render.
  const TYPING_SETTLE_PROBES = 3;
  const TYPING_SETTLE_DELAY_MS = 200;
  const CLICK_SETTLE_PROBES = 5;
  const CLICK_SETTLE_DELAY_MS = 200;

  function revealedNewElements(snapshot) {
    return (Array.isArray(snapshot?.elements) ? snapshot.elements : []).some((el) => el?.isNew === true);
  }

  async function observeAfterDispatch(operation, signatureBefore) {
    const documentBefore = snapshot?.docNonce;
    let result = await observe();
    if (![OPERATIONS.TYPE_TEXT, OPERATIONS.CLICK].includes(operation)) return result;
    const probes = operation === OPERATIONS.CLICK ? CLICK_SETTLE_PROBES : TYPING_SETTLE_PROBES;
    const delay = operation === OPERATIONS.CLICK ? CLICK_SETTLE_DELAY_MS : TYPING_SETTLE_DELAY_MS;
    let previousSignature = result.ok ? observationSignature(result.snapshot) : null;
    let previousDocument = result.ok ? result.snapshot.docNonce : null;
    let stableReads = 0;
    for (let probe = 0; probe < probes; probe++) {
      // Typing retains its early exit when suggestions or a changed view
      // appear. Click responses need the stability check below instead.
      if (!result.ok || !isRunning()) break;
      if (operation === OPERATIONS.TYPE_TEXT && (revealedNewElements(result.snapshot) || observationSignature(result.snapshot) !== signatureBefore)) break;
      // A single transient banner/toast change is not a settled click result.
      // Wait for two equal subsequent reads or the bounded probe deadline.
      if (operation === OPERATIONS.CLICK && stableReads >= 2 &&
          (result.snapshot.docNonce !== documentBefore || previousSignature !== signatureBefore)) break;
      // `sleep` is injectable for the tests that drive this loop; the client
      // defaults it the same way for its backoff.
      emitPhase("waiting");
      await (sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))))(delay);
      if (!isRunning()) break;
      result = await observe();
      if (result.ok) {
        const currentSignature = observationSignature(result.snapshot);
        stableReads = currentSignature === previousSignature && result.snapshot.docNonce === previousDocument ? stableReads + 1 : 0;
        previousSignature = currentSignature;
        previousDocument = result.snapshot.docNonce;
      }
    }
    return result;
  }

  // The observation is a read-only dispatch, and it passes the SAME host-side
  // checks every other dispatch does (design.md §7; spec "Guarded execution
  // through the existing dispatch discipline" / "Decision-engine independence
  // of execution guarantees"): a stopped run, a released lease, or a tab
  // outside the run's scope refuses the snapshot exactly as it would refuse
  // the identical `page_snapshot` call from the LLM engine's handler, and a
  // refusal never reaches the bridge.
  async function observe() {
    emitPhase("observing");
    const args = coerceArgs({ tabId });
    const check = runHostSideChecks({ run, legacyToolName: PAGE_SNAPSHOT_TOOL, args, sendClassTool: false });
    if (!check.ok) {
      return { ok: false, message: firstTextOf(check.result) || `the host-side checks refused ${PAGE_SNAPSHOT_TOOL}` };
    }
    let call;
    try {
      call = await toolBridge.call(PAGE_SNAPSHOT_TOOL, args, run.describeRequestForWire());
    } catch (err) {
      return { ok: false, message: `page_snapshot failed: ${err?.message ?? String(err)}` };
    }
    if (call && call.resultUnknown) {
      return { ok: false, message: "page_snapshot's response was lost before it reached the host" };
    }
    const text = firstTextOf(call?.result);
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      const unavailable = legacyUnavailableSnapshot(text, tabId);
      if (unavailable) return { ok: false, unavailable, message: "the bound page is unavailable for reading" };
      return { ok: false, message: `page_snapshot did not answer a JSON snapshot: ${text.slice(0, 200)}` };
    }
    if (parsed?.available === false) {
      const unavailable = unavailableSnapshot(parsed, tabId);
      return unavailable
        ? { ok: false, unavailable, message: "the bound page is unavailable for reading" }
        : { ok: false, message: "page_snapshot answered an invalid or mismatched unavailable-page record" };
    }
    if (call?.result?.isError === true) return { ok: false, message: "page_snapshot returned a tool error" };
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.elements) || typeof parsed.url !== "string") {
      return { ok: false, message: "page_snapshot answered a shape without `url` and `elements`" };
    }
    const doc = typeof parsed.docNonce === "string" && parsed.docNonce ? parsed.docNonce : null;
    if (doc !== pendingNewDocument || doc === null) pendingNewRefs.clear();
    pendingNewDocument = doc;
    if (doc) for (const element of parsed.elements) {
      if (element?.isNew === true && typeof element.ref === "string") pendingNewRefs.add(element.ref);
    }
    return { ok: true, snapshot: parsed };
  }

  // The page capture (openspec/changes/add-jev-run-screenshots design.md §1):
  // One read-only `computer` capture for each planning or completion
  // consultation, taken after its observation. Routine Jev calls never
  // receive images; later consultations capture fresh visual evidence.
  //
  // It passes the SAME host-side checks the observation passes — run state,
  // lease, tab scope — and never the approval gate: a capture changes nothing
  // on the page, so there is nothing to approve. It never writes to disk and
  // never annotates, and it is a pure READ on the bridge, which is also why a
  // lost response is NOT recorded as result-unknown (the observation's own
  // precedent: nothing about the page or the run can be in doubt).
  //
  // Advisory by contract: a refused check, a capture error, a lost response,
  // or a result without a usable image item yields NO image for that cycle.
  // The caller proceeds text-only, nothing else about the run changes, and the
  // next cycle captures again. Nothing is retried inside a cycle.
  let captureFailure = null;
  async function capturePage() {
    captureFailure = "capture_failed";
    const args = coerceArgs({ action: SCREENSHOT_ACTION, tabId, annotate: false });
    const check = runHostSideChecks({ run, legacyToolName: SCREENSHOT_TOOL, args, sendClassTool: false });
    if (!check.ok) { captureFailure = "scope_or_run_unavailable"; return null; }
    let call;
    try {
      call = await toolBridge.call(SCREENSHOT_TOOL, args, run.describeRequestForWire());
    } catch {
      return null;
    }
    if (!call || call.resultUnknown) { captureFailure = "capture_result_unknown"; return null; }
    // The image content item (design.md §1): `data` + `mimeType`, both
    // nonempty strings. Anything else — a text-only refusal, a shape this
    // version does not know — is "no capture", never a malformed request.
    const content = Array.isArray(call.result?.content) ? call.result.content : [];
    if (content.some((block) => block?.type === "text" && /this capture came back essentially blank/.test(block.text))) {
      captureFailure = "blank_capture";
      return null;
    }
    const item = content.find((block) => block && block.type === "image");
    const data = item && typeof item.data === "string" ? item.data : "";
    const mimeType = item && typeof item.mimeType === "string" ? item.mimeType : "";
    if (!data || !mimeType) return null;
    captureFailure = null;
    return { data, mimeType, artifactId: screenshotArtifact(content) };
  }

  async function captureStepEvidence(snap, target, operation) {
    const evidence = observationEvidence(snap, target, now(), { status: "disabled" });
    if (!screenshotsEnabled) return { evidence, fresh: true };
    if (!snap) { evidence.screenshot = { status: "unavailable", reason: "page_unavailable" }; return { evidence, fresh: true }; }
    const image = await capturePage();
    evidence.screenshot = image?.artifactId
      ? { status: "available", artifactId: image.artifactId, mimeType: image.mimeType }
      : { status: "unavailable", reason: image ? "artifact_reference_missing" : captureFailure };
    if (!isRunning()) return { evidence, fresh: false };
    const current = await observe();
    const targetState = (page) => {
      const row = target?.docNonce && target.docNonce === page?.docNonce && page?.elements?.find((entry) => entry.ref === target.ref);
      return row ? JSON.stringify({ ...row, isNew: undefined }) : null;
    };
    // Two separate invariants, not one. What the picture may claim: whether
    // the whole observation it depicts still matches the live page. A page
    // that rotates an ad, lazy-loads a widget or refreshes a counter during
    // the roughly two seconds this capture takes fails this check on almost
    // any real site, so it governs the screenshot's own status only.
    const depictsObservation = current.ok && current.snapshot.docNonce === snap?.docNonce &&
      observationSignature(current.snapshot) === observationSignature(snap) && targetState(current.snapshot) === targetState(snap);
    if (!depictsObservation) evidence.screenshot = { status: "unavailable", reason: "stale_capture" };
    // What authorizes the mutation: the re-read succeeded, the document is
    // the same, and the selected target's own identity and state are
    // unchanged. Movement elsewhere on the page no longer vetoes a targeted
    // dispatch, because the target's own row is what a targeted action
    // depends on. A targetless operation (WAIT, SCROLL_*) has no target row
    // at all — target state is null on both sides regardless — so without
    // the whole-page term this authorization would be a same-document check
    // and nothing else. It keeps the observationSignature comparison here,
    // exactly as this re-read always enforced, so a page that changes during
    // the capture still refuses a targetless dispatch.
    const targetless = operation === OPERATIONS.WAIT || operation === OPERATIONS.SCROLL_UP || operation === OPERATIONS.SCROLL_DOWN;
    const fresh = current.ok && current.snapshot.docNonce === snap?.docNonce &&
      (!targetless || observationSignature(current.snapshot) === observationSignature(snap)) &&
      targetState(current.snapshot) === targetState(snap);
    // A navigation's destination never depended on the picture: a capture
    // that no longer matches the observation is a worse picture, not a
    // reason to abandon a dispatch whose correctness the page cannot
    // affect. Every other operation still treats an unfresh capture as a
    // refusal.
    if (!fresh && operation === OPERATIONS.NAVIGATE) return { evidence, fresh: true };
    return { evidence, fresh };
  }

  // The gate + dispatch path (design.md §6's `gates` then `dispatch`). Both
  // refusals return without ever reaching the bridge, which is the invariant
  // the shared module exists to hold.
  async function dispatch(legacyToolName, args, candidate) {
    const before = snapshot;
    const coerced = coerceArgs({ ...args });
    let verdict;
    try {
      verdict = await canUseTool(legacyToolName, coerced);
    } catch (err) {
      // The message may echo whatever the gate itself threw; deniedReason
      // never does — it is a fixed classification of WHICH refusal this was.
      return { ok: false, denied: true, deniedReason: "approval_gate_error", message: `the approval gate failed: ${err?.message ?? String(err)}` };
    }
    if (!verdict || verdict.behavior !== "allow") {
      return { ok: false, denied: true, deniedReason: "approval_gate_refused", message: verdict?.message || `the approval gate refused ${legacyToolName}` };
    }
    if (!isRunning()) return { ok: false, stopped: true };
    if (before) {
      const current = await observe();
      if (!isRunning()) return { ok: false, stopped: true };
      if (!current.ok) return { ok: false, stale: true, staleReason: "reread_failed", message: current.message };
      snapshot = current.snapshot;
      recordObservation(snapshot);
      eligiblePreparation();
      const oldTarget = candidate.target;
      const field = oldTarget ? snapshot.elements.find((el) => el.ref === oldTarget.ref) : null;
      const identityFields = ["ref", "role", "label", "tag", "type", "value", "editable", "readonly", "disabled", "checked", "selected", "expanded", "options", "submit"];
      const sameTarget = !oldTarget || (field && identityFields.every((key) => {
        // SELECT stores the option payload in target.value, while currentValue
        // is the observed field value.
        const expected = key === "value" ? oldTarget.currentValue : oldTarget[key];
        return JSON.stringify(key === "value" ? String(field[key] ?? "") : field[key]) ===
          JSON.stringify(key === "value" ? String(expected ?? "") : expected);
      }));
      const validPrepared = !candidate.preparedId || [...prepared.textValues, ...prepared.navigation]
        .some((record) => record.id === candidate.preparedId && !record.consumed);
      // A prepared navigation carries no observed target: its destination is
      // bound to the plan revision that prepared it, not to anything on the
      // page, so document identity, URL and observation-signature equality —
      // the guarantees a targeted operation's honesty depends on — protect a
      // target that does not exist here. The complete precondition for a
      // page-independent action is the single-use guarantee every prepared
      // record already gets (validPrepared) and that the destination still
      // differs from the page being dispatched against, the same "already
      // there" case the candidate builder excludes when offering the action.
      // Each branch below is the same OR'd precondition as before, split so
      // the return can name which single condition tripped; the union of
      // conditions, and therefore what counts as stale, is unchanged.
      if (candidate.operation === OPERATIONS.NAVIGATE) {
        if (!validPrepared) return { ok: false, stale: true, staleReason: "prepared_record_invalid" };
        // Same comparison the candidate builder itself used to offer this
        // action (questions.js's `buildDecisionRequest`): the destination's
        // normalized form against the page actually being dispatched against.
        if (new URL(candidate.url).href === snapshot.url) return { ok: false, stale: true, staleReason: "url_changed" };
      } else if (oldTarget) {
        if (typeof before.docNonce !== "string" || !before.docNonce || typeof snapshot.docNonce !== "string" || !snapshot.docNonce ||
            before.docNonce !== snapshot.docNonce) return { ok: false, stale: true, staleReason: "document_changed" };
        if (before.url !== snapshot.url) return { ok: false, stale: true, staleReason: "url_changed" };
        // Checked before target identity: a binding an eligibility sweep just
        // invalidated (the field's value now matches what was prepared, or
        // the field stopped qualifying) always changes the same identity
        // fields target-change detects, so the more specific cause is
        // reported first.
        if (!validPrepared) return { ok: false, stale: true, staleReason: "prepared_record_invalid" };
        if (!sameTarget) return { ok: false, stale: true, staleReason: "target_changed" };
      } else {
        if (before.docNonce !== snapshot.docNonce) return { ok: false, stale: true, staleReason: "document_changed" };
        if (before.url !== snapshot.url) return { ok: false, stale: true, staleReason: "url_changed" };
        if (!validPrepared) return { ok: false, stale: true, staleReason: "prepared_record_invalid" };
        if (observationSignature(before) !== observationSignature(snapshot)) return { ok: false, stale: true, staleReason: "signature_changed" };
      }
      signature = observationSignature(snapshot);
    }
    const beforeEvidence = await captureStepEvidence(snapshot, candidate.target, candidate.operation);
    if (!beforeEvidence.fresh) return { ok: false, stale: true, staleReason: "stale_capture" };
    if (!isRunning()) return { ok: false, stopped: true };
    const finalCheck = runHostSideChecks({ run, legacyToolName, args: coerced, sendClassTool: legacyToolName === "computer" });
    if (!finalCheck.ok) return { ok: false, denied: true, deniedReason: "host_side_checks_refused", message: firstTextOf(finalCheck.result) || "the host-side checks refused dispatch after capture" };
    // Consume before crossing the bridge: an unknown result cannot be retried.
    if (candidate.preparedId) {
      const record = [...prepared.textValues, ...prepared.navigation].find((item) => item.id === candidate.preparedId);
      if (record) record.consumed = true;
    }
    const meta = run.describeRequestForWire();
    emitPhase(coerced.action === "wait" ? "waiting" : "executing");
    let call;
    try {
      call = await toolBridge.call(legacyToolName, coerced, meta);
    } catch (err) {
      // A rejection after dispatch does not prove navigation did not happen.
      // Record uncertainty through the same path as a lost bridge response.
      run.recordResultUnknown(legacyToolName, coerced, meta);
      return { ok: false, dispatched: true, beforeEvidence: beforeEvidence.evidence, unknown: true, message: `${legacyToolName}'s response could not be confirmed` };
    }
    const { result, resultUnknown } = call;
    if (resultUnknown) {
      run.recordResultUnknown(legacyToolName, coerced, meta);
      return { ok: false, dispatched: true, beforeEvidence: beforeEvidence.evidence, unknown: true, message: `${legacyToolName}'s response was lost` };
    }
    if (legacyToolName === "navigate" && (result?.isError === true || /^\s*(?:error\b|invalid url:|tab \d+ is not in the mcp group\.)/i.test(firstTextOf(result)))) {
      return { ok: false, dispatched: true, beforeEvidence: beforeEvidence.evidence, failed: true, message: "navigate returned an error; the destination was not confirmed" };
    }
    const toolText = firstTextOf(result);
    const actionFailed = result?.isError === true || /^\s*(?:error\b|failed\b|unable\b)/i.test(toolText);
    // Tool errors can include the supplied field value or page-controlled
    // prose. Persist only bounded host-authored error categories, not echoes
    // of private input. A known failed attempt can recover after observation;
    // it must not be recorded as a successful operation.
    const actionError = actionFailed
      ? /obstruct|intercept|occlud|covered by/i.test(toolText)
        ? { code: "TARGET_OBSTRUCTED", message: "The target was obstructed; the requested interaction did not complete." }
        : { code: "TOOL_ERROR", message: "The browser tool reported that the requested operation failed." }
      : null;
    return { ok: true, dispatched: true, beforeEvidence: beforeEvidence.evidence, result, actionFailed, actionError };
  }

  // A run with no bound page tab has nothing to observe: a non-integer tabId
  // is reported as an observation failure BEFORE anything touches the bridge,
  // rather than handing `page_snapshot` a malformed target whose rejection
  // would be a different, misleading failure (coordinator contract for the
  // companion's run-path branch). steps stays 0 and one jev_end is emitted.
  if (!Number.isInteger(tabId)) {
    return finish({
      outcome: "error",
      reason: "observation_failed",
      error: { code: "OBSERVATION_ERROR", message: `this run has no bound page tab (tabId ${String(tabId)}); a TypeSafe run observes the tab it is bound to` }
    });
  }

  // A run stopped before its first cycle does nothing at all — not even a
  // read-only observation (the loop's own stop check runs between every other
  // phase; this one covers entry).
  if (!isRunning()) return finish({ outcome: "stopped", reason: "stopped" });

  const first = await observe();
  if (!first.ok) {
    // The observation's own host-side checks are the first thing to notice a
    // stop that landed while the loop was between phases (the check refuses
    // `run_not_active`): that is the stop every other phase boundary reports,
    // not a failure to observe.
    if (!isRunning()) return finish({ outcome: "stopped", reason: "stopped" });
    if (first.unavailable?.reason === "restricted_page" && BLANK_START_URL_PATTERN.test(first.unavailable.url)) {
      pageAvailability = { status: "blank_start", url: first.unavailable.url };
    } else if (first.unavailable) {
      return finishUnavailable(first.unavailable);
    } else {
      return finish({ outcome: "error", reason: "observation_failed", error: { code: "OBSERVATION_ERROR", message: first.message } });
    }
  } else {
    snapshot = first.snapshot;
    recordObservation(snapshot);
    signature = observationSignature(snapshot);
  }
  let noProgress = 0;
  let scrollStreak = 0;
  let scrollElementKey = null;
  // The scroll-only streak and its post-recovery rule (design.md §3): the
  // streak counts consecutive EXECUTED scroll steps in either direction; the
  // flag is armed by a recovery that followed a scroll-stall trip and makes
  // the next executed scroll terminal (any other executed step clears it).
  let scrollOnlyStreak = 0;
  let scrollStallRecovered = false;
  // The last CLICK that left the page unchanged, by its stable document-local
  // ref. While it stands, clicking that same element again is predictably
  // futile — the live pattern this exists for is a result link that opens a
  // NEW TAB (the bound page never changes), re-clicked four times in a row
  // before the no-progress guard caught it. Any observed progress clears it.
  let lastIneffectiveClickRef = null;
  // Visible native-form semantics survive document reloads. Matching them
  // triggers a read-only completion checkpoint, not proof that hidden/server
  // state is identical. A rejected verifier can replan and retry within the
  // cumulative verification budget; meaningful new actions proceed normally.
  let lastSubmissionKey = null;
  const submissionKey = (target) => target?.submit && typeof target.submit === "object"
    ? JSON.stringify(target.submit) : null;

  // --- The run memory's lifecycle (design.md §1-§5) ------------------------
  //
  // The configured model owns the memory's CONTENT; this loop owns only when
  // it is asked, what it may replace, and how much of it a run can spend. The
  // plan is taken once after the first observation; revisions replace the
  // whole memory on a page-identity change, at the action cadence, and on a
  // rejected completion; a stall guard gets one bounded consultation before
  // it ends the run. Every event records the same frozen payload (design.md
  // §7): a 1-based index, the kind, the trigger, the memory, and the call's
  // latency.
  let memoryUrl = null; // the page URL the current memory was written from
  let memoryAtAction = 0; // `executed` when the memory was last written
  let memoryEvents = 0; // the 1-based `jev_memory` index
  let memoryUpdates = 0; // successful revisions (the plan is not counted)
  let recoveries = 0; // successful stall recoveries
  let verificationRejections = 0;

  function observedLinks(snap) {
    return (Array.isArray(snap?.elements) ? snap.elements : [])
      .filter((element) => typeof element?.href === "string" && element.href)
      .map((element) => ({ url: element.href, label: String(element.label ?? "") }));
  }
  const pageOf = (snap) => ({ url: snap?.url, title: snap?.title, text: snap?.text, links: observedLinks(snap) });

  const emitMemory = (kind, trigger, value, latencyMs) => {
    memoryEvents += 1;
    run.emit({ type: "jev_memory", index: memoryEvents, kind, trigger, memory: { ...value }, latencyMs });
  };

  let prepared = { textValues: [], navigation: [] };
  let planRevision = 0;
  let replansWithoutProgress = 0;
  let planAttempted = false;
  // A positive stuck judgment buys exactly one revised plan: once that plan
  // exists and nothing has run under it yet, the run owes its next selected
  // action an attempt rather than another identical consultation. True while
  // the current revision came from a stuck-triggered consultation and no
  // action has dispatched since; false once either stops being the case.
  let stuckRevisionPending = false;

  // Bind only host-observed identities; display labels in the LLM table are
  // shortened and must never become the identity of a persistent value.
  async function prepare(trigger) {
    const space = snapshot ? buildActionSpace(snapshot) : { elements: [], omitted: null, targets: {} };
    const image = snapshot && screenshotsEnabled ? await capturePage() : null;
    if (!isRunning()) return false;
    emitPhase("planning");
    const planned = await requestActionPlan({
      textModel: provider.textModel, goal: provider.goal, memory, page: pageOf(snapshot),
      pageAvailability, conversation: provider.conversation, elements: space.elements,
      elementsOmitted: space.omitted, history, image, reason: trigger, now, sleep
    });
    if (!isRunning()) return false;
    const revision = planRevision + 1;
    const textValues = planned.textValues.map((record, index) => {
      const target = space.targets[OPERATIONS.TYPE_TEXT]?.get(record.element);
      const raw = snapshot?.elements.find((el) => el.ref === target?.ref);
      if (!snapshot?.docNonce || !raw) throw new JevError("INVALID_RESPONSE", "prepared text requires an observed document identity and exact field");
      return { id: `${revision}:text:${index}`, ref: raw.ref, role: String(raw.role ?? ""),
        label: String(raw.label ?? ""), docNonce: snapshot.docNonce, value: record.value, consumed: false };
    });
    prepared = { textValues, navigation: planned.navigation.map((record, index) => ({
      ...record, id: `${revision}:url:${index}`, consumed: false
    })), ...(planned.visualNotes ? { visualNotes: planned.visualNotes } : {}), docNonce: snapshot?.docNonce,
      observation: snapshot ? observationSignature(snapshot) : null };
    memory = planned.memory;
    planRevision = revision;
    // Every revision starts unspent for the stuck bound except the one this
    // consultation was itself diverted for; any other trigger (start, an
    // explicit REPLAN, stall recovery, verification) means the monitor's
    // complaint about the prior plan no longer applies.
    stuckRevisionPending = trigger === "stuck";
    planAttempted = true;
    memoryUrl = snapshot?.url ?? null;
    memoryAtAction = executed;
    if (trigger !== "start") memoryUpdates += 1;
    emitMemory(trigger === "start" ? "plan" : trigger === "stall" ? "recovery" : "update", trigger, memory, planned.latencyMs);
    return true;
  }

  function eligiblePreparation() {
    // Invalidated bindings stay invalid even if an element later reappears.
    for (const record of prepared.textValues) {
      const field = snapshot?.elements.find((el) => el.ref === record.ref);
      if (!snapshot?.docNonce || record.docNonce !== snapshot.docNonce || !field ||
          String(field.role ?? "") !== record.role || String(field.label ?? "") !== record.label ||
          field.editable !== true || field.readonly === true || field.disabled === true ||
          String(field.value ?? "") === record.value) record.consumed = true;
    }
    if (!snapshot?.docNonce || snapshot.docNonce !== prepared.docNonce || observationSignature(snapshot) !== prepared.observation) delete prepared.visualNotes;
    return prepared;
  }

  async function replan(trigger) {
    if (!isRunning()) return finish({ outcome: "stopped", reason: "stopped" });
    if (memoryUpdates >= maxMemoryUpdates || replansWithoutProgress >= maxReplansWithoutProgress) {
      return finish({ outcome: "blocked", reason: "replan_limit" });
    }
    replansWithoutProgress += 1;
    try { await prepare(trigger); }
    catch (err) {
      if (!isRunning()) return finish({ outcome: "stopped", reason: "stopped" });
      return finish({ outcome: "error", reason: "preparation_failed", error: { code: err?.code ?? "INVALID_RESPONSE", message: err.message } });
    }
    if (!isRunning()) return finish({ outcome: "stopped", reason: "stopped" });
    return null;
  }

  async function recoverFromStall(reason) {
    if (!isRunning()) return finish({ outcome: "stopped", reason: "stopped" });
    if (recoveries >= maxRecoveries) return finish({ outcome: "blocked", reason });
    const ended = await replan("stall");
    if (ended) return ended;
    recoveries += 1;
    noProgress = 0;
    scrollStreak = 0;
    scrollElementKey = null;
    scrollOnlyStreak = 0;
    // A revised plan is not page progress. Keep the no-effect evidence until
    // a fresh observation actually changes, even across recovery.
    return null;
  }

  // The no-progress guard (design.md §6), evaluated after any counter change —
  // a dispatched action that changed nothing and a step skipped as
  // target-unresolved alike. Returns the terminal result when the guard ends
  // the run, or null to let the loop continue.
  async function noProgressGuard() {
    if (noProgress < NO_PROGRESS_LIMIT) return null;
    return recoverFromStall("no_progress");
  }

  try { await prepare("start"); }
  catch (err) {
    if (!isRunning()) return finish({ outcome: "stopped", reason: "stopped" });
    return finish({ outcome: "error", reason: "preparation_failed", error: { code: err?.code ?? "INVALID_RESPONSE", message: err.message } });
  }

  while (true) {
    phaseStep = executed + 1;
    if (!isRunning()) return finish({ outcome: "stopped", reason: "stopped" });
    if (decisionsMade >= maxDecisions) return finish({ outcome: "blocked", reason: "decision_budget" });
    // Re-read even after abstention, rejected completion, or replanning.
    if (snapshot) {
      const current = await observe();
      if (!isRunning()) return finish({ outcome: "stopped", reason: "stopped" });
      if (!current.ok) {
        if (current.unavailable) return finishUnavailable(current.unavailable);
        return finish({ outcome: "error", reason: "observation_failed", error: { code: "OBSERVATION_ERROR", message: current.message } });
      }
      const freshSignature = observationSignature(current.snapshot);
      const documentChanged = snapshot.docNonce !== current.snapshot.docNonce;
      if (documentChanged || freshSignature !== signature) {
        // A delayed page update is progress even when the immediate
        // post-action read was unchanged. Reused refs in a replacement
        // document cannot inherit an old ineffective-click guard.
        noProgress = 0;
        lastIneffectiveClickRef = null;
        replansWithoutProgress = 0;
        if (documentChanged) {
          scrollStreak = 0;
          scrollElementKey = null;
        }
      }
      snapshot = current.snapshot;
      signature = freshSignature;
      recordObservation(snapshot);
    }
    let built, selected;
    try {
      if (snapshot?.docNonce && snapshot.docNonce === pendingNewDocument) {
        snapshot = { ...snapshot, elements: snapshot.elements.map((element) =>
          pendingNewRefs.has(element.ref) ? { ...element, isNew: true } : element) };
      }
      built = buildDecisionRequest({ model: provider.model, goal: provider.goal, snapshot, memory, history, prepared: eligiblePreparation() });
      pendingNewRefs.clear();
      emitPhase("deciding");
      selected = await requestDecision({ source: provider.source, endpoint: provider.endpoint,
        apiKey: provider.apiKey, model: provider.model, body: built.body, now, sleep });
    } catch (err) {
      if (!isRunning()) {
        emitStep({ step: executed + 1, operation: null, target: null, tool: null, skippedReason: "stopped", decisionSource: "jev", pageChanged: false });
        return finish({ outcome: "stopped", reason: "stopped" });
      }
      return finish({ outcome: "error", reason: err?.code === "INVALID_RESPONSE" ? "invalid_decision" : "provider_error",
        error: { code: err?.code ?? "NETWORK_ERROR", message: err.message } });
    }
    decisionsMade += 1;
    const decision = selected.decision;
    const candidate = built.candidates.get(decision.actionKey);
    if (!isRunning()) {
      emitStep({ step: executed + 1, operation: candidate?.operation ?? null, target: null, tool: null, skippedReason: "stopped", decisionSource: "jev", pageChanged: false });
      return finish({ outcome: "stopped", reason: "stopped" });
    }
    if (!candidate) return finish({ outcome: "error", reason: "invalid_decision",
      error: { code: "INVALID_RESPONSE", message: "the selected action was not offered" } });
    const operation = candidate.operation;
    const intent = candidate.target?.label ?? null;
    const evaluation = null;
    const decidedStep = { ...candidate, text: candidate.value, latencyMs: selected.latencyMs };
    let image = null;
    // The record every route below fills in (design.md §7): the configured
    // model's operation and intent, TypeSafe's selected element when the step
    // needed one, the per-stage latencies, and — when nothing dispatched — why.
    const step = {
      step: executed + 1,
      operation,
      ...(intent ? { intent } : {}),
      ...(evaluation ? { evaluation } : {}),
      // The opaque complete-action key is scoped to this decision request.
      // Target metadata preserves the observed identity for presentation.
      decisionSource: "jev", actionKey: decision.actionKey,
      actionProbability: decision.actionProbability, actionConfidence: decision.confidence,
      monitors: { goalDone: decision.heads.goal_done, stuck: decision.heads.stuck },
      planRevision,
      target: candidate.target ? { index: decision.actionKey, label: operation === OPERATIONS.SELECT ? candidate.target.optionLabel : candidate.target.label, role: candidate.target.role,
        ...(operation === OPERATIONS.SELECT ? { elementLabel: candidate.target.label } : {}) } : null,
      targetProbability: decision.actionProbability,
      confidence: decision.confidence,
      tool: null,
      argsSummary: null,
      latencies: { decisionMs: decidedStep.latencyMs },
      pageChanged: false,
      // What the model was looking at when it decided, bounded — a diagnostic
      // record, never model input. Live runs that scrolled away from a page
      // whose target field may or may not have been offered could not be told
      // apart without this: "the control was never in the table" and "the
      // control was offered and the model chose poorly" need opposite fixes,
      // and only this field separates them in the transcript. The omission
      // counts are added below, for the steps whose element table was fitted.
      ...(pageAvailability ? { pageAvailability } : {}),
      observed: snapshot ? {
        ...observedPageUrl(snapshot?.url),
        elements: Array.isArray(snapshot?.elements) ? snapshot.elements.length : 0,
        sample: (Array.isArray(snapshot?.elements) ? snapshot.elements : [])
          .map((el) => (typeof el?.label === "string" ? el.label.slice(0, 40) : ""))
          .filter(Boolean)
          .slice(0, 12)
      } : null
    };

    // A stop that landed while the step decision was in flight ends the run
    // `stopped` on EVERY route below — including the ones whose verdict would
    // otherwise be blocked (`model_blocked`, a spent bound, an exhausted
    // recovery bound) or a dispatch. Nothing about the outcome may be credited
    // to a run that is no longer running (round-2 review finding).
    if (!isRunning()) {
      step.skippedReason = "stopped";
      emitStep(step);
      return finish({ outcome: "stopped", reason: "stopped" });
    }

    const resolves = selectionResolves(decision);
    const selectedSubmissionKey = operation === OPERATIONS.CLICK ? submissionKey(candidate.target) : null;
    const repeatedSubmission = selectedSubmissionKey !== null && selectedSubmissionKey === lastSubmissionKey;
    // Completion requests only trigger a fresh read and independent verifier;
    // uncertainty about which mutation to choose must not suppress them.
    if (!resolves.ok && operation !== OPERATIONS.DONE && !decision.goalDone && !repeatedSubmission) {
      step.skippedReason = "target_unresolved";
      step.targetAbstained = true;
      step.runnerUpProbability = resolves.runnerUp;
      emitStep(step);
      history.push({ operation, action: operation, outcome: "skipped", skipped_reason: step.skippedReason, page_changed: false });
      noProgress += 1;
      const ended = await noProgressGuard();
      if (ended) return ended;
      continue;
    }

    if (operation === OPERATIONS.DONE || decision.goalDone || repeatedSubmission) {
      if (repeatedSubmission) step.verificationTrigger = "repeated_submission";
      if (!snapshot) return finish({ outcome: "blocked", reason: "completion_unverified" });
      const current = await observe();
      if (!isRunning()) return finish({ outcome: "stopped", reason: "stopped" });
      if (!current.ok) return finish({ outcome: "blocked", reason: "completion_unverified", summaryError: current.message });
      snapshot = current.snapshot;
      recordObservation(snapshot);
      image = screenshotsEnabled ? await capturePage() : null;
      if (!isRunning()) return finish({ outcome: "stopped", reason: "stopped" });
      // A fresh completion consultation gets one optional screenshot. Jev
      // receives only structured text; its positive monitor is not proof.
      let check = null;
      let checkError = null;
      try {
        emitPhase("verifying");
        check = await requestCompletionCheck({
          textModel: provider.textModel,
          goal: provider.goal,
          conversation: provider.conversation,
          consultSources,
          memory,
          page: pageOf(snapshot),
          // The verdict is still judged on the current page; the REPORT this
          // call writes is the run's answer, and that may look back over the
          // pages the run passed through.
          observations,
          history,
          image,
          now,
          sleep
        });
      } catch (err) {
        checkError = (err && err.message) || String(err);
      }
      // A stop landing during the check discards the verdict and stops the
      // run: nothing about the outcome may change after a stop.
      if (!isRunning()) {
        step.skippedReason = "stopped";
        emitStep(step);
        return finish({ outcome: "stopped", reason: "stopped" });
      }
      if (!check) {
        // An unavailable or malformed check cannot establish completion.
        step.skippedReason = "completion_unverified";
        step.verification = { achieved: null, error: checkError };
        emitStep(step);
        return finish({
          outcome: "blocked",
          reason: "completion_unverified",
          doneVerified: false,
          summaryError: checkError || "the completion check could not be made"
        });
      }
      if (check.achieved === true) {
        // Confirmed: the report rides the same view of the page as the
        // verdict. A confirmation WITHOUT a usable report is still a verified
        // completion; the missing report is disclosed, never invented.
        step.skippedReason = "done";
        step.verification = { achieved: true };
        emitStep(step);
        // The check may answer with SOURCES instead of a report: the goal is
        // met, but the answer it deserves needs material this page does not
        // hold. Consult them once — here, at the analysis phase, after the
        // last cycle — and let `finish()` write the answer with them in hand.
        // When consultation is off, or the check named none, nothing is
        // fetched and the check's own report stands as it does today.
        if (consultSources && Array.isArray(check.sources) && check.sources.length > 0) {
          consultedSources = await consultNamedSources(check.sources);
          return finish({ outcome: "done", reason: null, doneVerified: true, completionCheck: check });
        }
        if (consultSources && provider.searchSources === true) {
          return finish({ outcome: "done", reason: null, doneVerified: true, completionCheck: check });
        }
        emitResult(check.report, check.latencyMs);
        const reportError = check.report ? null : check.reportError || "the completion check confirmed the goal but produced no report";
        return finish({ outcome: "done", reason: null, doneVerified: true, summaryError: reportError });
      }
      // Rejected: the step records the rejection — never as a completion — and
      // the verdict's guidance memory rides on when a valid one came with it
      // (recorded as a revision, so it can never change unobserved). The loop
      // then continues; the bound below is what keeps it from ping-ponging
      // DONE claims forever.
      verificationRejections += 1;
      step.skippedReason = "completion_rejected";
      step.verification = { achieved: false };
      emitStep(step);
      if (check.memory && memoryUpdates < maxMemoryUpdates) {
        memory = check.memory;
        planRevision += 1;
        // This revision was produced by a verification rejection, not a
        // stuck-triggered consultation, so the stuck bound owes it nothing.
        stuckRevisionPending = false;
        prepared = { textValues: [], navigation: [] };
        memoryUrl = snapshot?.url ?? null;
        memoryAtAction = executed;
        memoryUpdates += 1;
        emitMemory("update", "verification", check.memory, check.latencyMs);
      }
      if (verificationRejections >= maxVerificationRejections) {
        return finish({ outcome: "blocked", reason: "completion_unverified" });
      }
      if (repeatedSubmission) {
        // Visible form state cannot prove hidden/server state is unchanged.
        // Replan before permitting a bounded retry; cumulative rejection and
        // decision/action budgets prevent another unbounded submission loop.
        const ended = await replan("verification");
        if (ended) return ended;
        lastSubmissionKey = null;
      }
      continue;
    }
    if (operation === OPERATIONS.ASK || operation === OPERATIONS.BLOCKED) {
      // Jev's ASK uses the existing blocked/operator-needed outcome.
      const blockedReason = operation === OPERATIONS.ASK ? "needs_operator" : "model_blocked";
      step.skippedReason = blockedReason;
      emitStep(step);
      if (pageAvailability && intent) emitResult(intent, decidedStep.latencyMs);
      return finish({ outcome: "blocked", reason: blockedReason });
    }
    // An explicitly selected REPLAN is the action head's own request for new
    // content, not a monitor's veto, and always consults planning bounded by
    // the replan budget alone. A positive stuck judgment is different: it may
    // withhold the selected action at most once per plan revision. Once a
    // stuck-triggered consultation has produced a revision and nothing has
    // dispatched under it yet, the run owes the selected action an attempt —
    // a further positive stuck judgment falls through to dispatch instead of
    // requesting an identical plan a monitor has already been granted.
    if (operation === OPERATIONS.REPLAN || (decision.stuck && !stuckRevisionPending)) {
      step.skippedReason = "replan";
      emitStep(step);
      history.push({ operation, action: operation, outcome: "skipped", skipped_reason: "replan", page_changed: false });
      const stuckTriggered = operation !== OPERATIONS.REPLAN && decision.stuck;
      const ended = await replan(stuckTriggered ? "stuck" : "replan");
      if (ended) return ended;
      continue;
    }
    // The action bound is checked when an action is about to execute, so a
    // DONE decision at the bound still ends the run honestly (port of the
    // reference's ordering). Exhausting the action budget never authorizes
    // another dispatch, regardless of the selected action.
    if (executed >= maxActions) {
      step.skippedReason = "step_budget";
      emitStep(step);
      return finish({ outcome: "blocked", reason: "step_budget" });
    }

    const target = candidate.target ?? null;
    if (operation === OPERATIONS.CLICK && lastIneffectiveClickRef === target?.ref) {
      step.skippedReason = "repeated_no_change";
      emitStep(step);
      noProgress += 2;
      const ended = await noProgressGuard();
      if (ended) return ended;
      continue;
    }
    // The value or URL this step carries rides into the history row the next
    // request's `recent_actions` shows (and into exactly one dispatch). A
    // TYPE_TEXT value is never reused by another cycle and never recorded in a
    // durable event.
    let generatedText = null;
    let tool;
    let args;
    if (operation === OPERATIONS.CLICK) {
      tool = "computer";
      args = { action: "left_click", ref: target.ref, tabId };
    } else if (operation === OPERATIONS.HOVER) {
      // The pointer RESTS on the selected element and clicks nothing (design
      // §2): the extension's own `hover` action, which moves the pointer and
      // parks it while the page applies its hover state. The send-class
      // classifier already returns false for it, so the shared gates pass it
      // like a scroll and no approval card is raised. The identical-re-click
      // guard above stays CLICK-only: a repeated hover is cheap, and
      // re-hovering after the pointer moved elsewhere is exactly what a
      // hover-only menu needs.
      tool = "computer";
      args = { action: "hover", ref: target.ref, tabId };
    } else if (operation === OPERATIONS.TYPE_TEXT) {
      // The exact prepared value belongs to this observed field and plan
      // revision. Preflight rechecks its binding before single-use dispatch.
      step.textField = target.label;
      tool = "form_input";
      args = { ref: target.ref, value: decidedStep.text, tabId };
      generatedText = decidedStep.text;
    } else if (operation === OPERATIONS.NAVIGATE) {
      // The prepared URL was validated as bounded absolute http(s) content
      // before becoming an offered complete navigation action.
      tool = "navigate";
      args = { url: decidedStep.url, tabId };
      generatedText = decidedStep.url;
    } else if (operation === OPERATIONS.SELECT) {
      tool = "form_input";
      args = { ref: target.ref, value: target.value, tabId };
    } else if (operation === OPERATIONS.SCROLL_UP || operation === OPERATIONS.SCROLL_DOWN) {
      const viewport = snapshot.viewport ?? {};
      const x = Math.max(1, Math.floor(Number(viewport.w) / 2) || 1);
      const y = Math.max(1, Math.floor(Number(viewport.h) / 2) || 1);
      tool = "computer";
      args = {
        action: "scroll",
        coordinate: [x, y],
        scroll_direction: operation === OPERATIONS.SCROLL_UP ? "up" : "down",
        scroll_amount: SCROLL_ACTION_TICKS,
        tabId
      };
    } else if (operation === OPERATIONS.WAIT) {
      tool = "computer";
      args = { action: "wait", duration: WAIT_ACTION_SECONDS, tabId };
    } else {
      // Unreachable: the operation came from the step decision's validated
      // vocabulary, and every operation of that vocabulary is routed above.
      // Kept as the routing default so a future operation cannot silently
      // bypass the gate: it ends the run as an unexecutable decision.
      step.skippedReason = "unsupported_operation";
      emitStep(step);
      return finish({ outcome: "error", reason: "invalid_decision", error: { code: "INVALID_RESPONSE", message: `the decided operation ${operation} is not executable` } });
    }

    step.tool = tool;
    step.argsSummary = summarizeArgs(tool, args, { omitValue: operation === OPERATIONS.TYPE_TEXT });
    const dispatchStartedAt = now();
    const dispatched = await dispatch(tool, args, candidate);
    step.dispatched = dispatched.dispatched === true;
    if (step.dispatched) {
      step.actionOutcome = dispatched.unknown ? "unknown" : dispatched.failed || dispatched.actionFailed ? "failed" : "succeeded";
      if (dispatched.actionError) step.actionError = dispatched.actionError;
      else if (dispatched.unknown) step.actionError = { code: "RESULT_UNKNOWN", message: "The browser operation's outcome could not be confirmed." };
      else if (dispatched.failed) step.actionError = { code: "NAVIGATION_ERROR", message: "Navigation failed; the destination was not confirmed." };
    }
    if (dispatched.beforeEvidence) step.evidence = { before: dispatched.beforeEvidence, after: { unavailableReason: "observation_failed" } };
    step.latencies.dispatchMs = now() - dispatchStartedAt;
    if (!dispatched.ok) {
      if (!isRunning() || dispatched.stopped) {
        step.skippedReason = "stopped";
        emitStep(step);
        return finish({ outcome: "stopped", reason: "stopped" });
      }
      if (dispatched.stale) {
        step.skippedReason = "stale_observation";
        if (dispatched.staleReason) step.staleReason = dispatched.staleReason;
        emitStep(step);
        history.push({ operation, action: operation, outcome: "skipped", skipped_reason: "stale_observation", page_changed: false });
        noProgress += 1;
        const ended = await noProgressGuard();
        if (ended) return ended;
        continue;
      }
      if (dispatched.unknown) {
        if (step.evidence) step.evidence.after = { unavailableReason: "result_unknown" };
        // Result unknown: recorded on the run (which emits the durable
        // `tool_result_unknown`), never retried.
        step.skippedReason = "result_unknown";
        emitStep(step);
        return finish({ outcome: "error", reason: "tool_result_unknown", error: { code: "RESULT_UNKNOWN", message: dispatched.message } });
      }
      if (dispatched.failed) {
        step.skippedReason = "navigation_failed";
        emitStep(step);
        return finish({ outcome: "error", reason: "navigation_failed", error: { code: "NAVIGATION_ERROR", message: dispatched.message } });
      }
      step.skippedReason = "action_denied";
      if (dispatched.deniedReason) step.deniedReason = dispatched.deniedReason;
      emitStep(step);
      return finish({ outcome: "blocked", reason: "action_denied" });
    }

    executed += 1;
    // An action has now run under the current plan revision: the stuck bound
    // owes it nothing further until another stuck-triggered consultation
    // spends it again.
    stuckRevisionPending = false;
    if (![OPERATIONS.WAIT, OPERATIONS.SCROLL_UP, OPERATIONS.SCROLL_DOWN, OPERATIONS.HOVER].includes(operation)) {
      lastSubmissionKey = selectedSubmissionKey;
    }
    history.push({
      step: executed,
      operation,
      kind: KIND_BY_OPERATION[operation] ?? null,
      action: target?.label ?? operation,
      target: target?.label ?? null,
      outcome: dispatched.actionFailed ? "failed" : "executed",
      text: generatedText,
      page_changed: false
    });

    // An action that was already in flight when the run stopped settles as-is
    // (its real result was received, so it is recorded), and the loop then
    // stops. No post-stop observation is attempted: the lease may already be
    // released, and a failure there would misreport the run — so the step keeps
    // `pageChanged: false`, meaning "no change was observed", not "none
    // happened".
    if (!isRunning()) {
      if (step.evidence) step.evidence.after = { unavailableReason: "stopped" };
      emitStep(step);
      return finish({ outcome: "stopped", reason: "stopped" });
    }

    const next = await observeAfterDispatch(operation, signature);
    if (!next.ok) {
      emitStep(step);
      // Same rule as above: a refusal whose cause is the run no longer
      // running is the loop's own stop outcome, not an observation failure.
      if (!isRunning()) return finish({ outcome: "stopped", reason: "stopped" });
      if (next.unavailable) return finishUnavailable(next.unavailable);
      return finish({ outcome: "error", reason: "observation_failed", error: { code: "OBSERVATION_ERROR", message: next.message } });
    }
    recordObservation(next.snapshot);
    const nextSignature = observationSignature(next.snapshot);
    step.pageChanged = nextSignature !== signature || next.snapshot.docNonce !== snapshot?.docNonce;
    const afterEvidence = await captureStepEvidence(next.snapshot, target);
    step.evidence.after = afterEvidence.evidence;
    step.evidence.changes = { pageChanged: step.pageChanged, documentChanged: next.snapshot.docNonce !== snapshot?.docNonce,
      targetChanged: JSON.stringify(step.evidence.before.target) !== JSON.stringify(step.evidence.after.target) };
    history[history.length - 1].page_changed = step.pageChanged;
    emitStep(step);

    noProgress = step.pageChanged ? 0 : noProgress + 1;
    if (step.pageChanged) replansWithoutProgress = 0;
    snapshot = next.snapshot;
    pageAvailability = null;
    signature = nextSignature;
    // Maintain the ineffective-click memory: progress anywhere clears it; an
    // unchanged page after a CLICK arms it for that element's ref.
    if (step.pageChanged === true) {
      lastIneffectiveClickRef = null;
    } else if (step.pageChanged === false && operation === OPERATIONS.CLICK && target) {
      lastIneffectiveClickRef = target.ref;
    }
    // First guard site (design.md §5): one bounded consultation before the run
    // ends blocked, then (on a refusal or a spent bound) the same honest
    // no_progress reason as before this change.
    {
      const recovery = await noProgressGuard();
      if (recovery) return recovery;
    }

    const isScroll = operation === OPERATIONS.SCROLL_UP || operation === OPERATIONS.SCROLL_DOWN;
    // A recovery granted by the scroll-only streak below arms the post-recovery
    // rule for the NEXT executed step — never for the step whose guard just
    // consulted (design.md §3).
    let scrollStallRecoveredNow = false;

    // The scroll-only streak (design.md §3): consecutive EXECUTED steps whose
    // operation is a scroll, in either direction and regardless of what the
    // element table did — the guard the element-table brake cannot be, because
    // the live failure it exists for changed the table on every scroll. Any
    // other executed step resets the streak; reaching the limit takes the same
    // bounded consultation as every other stall.
    if (isScroll) {
      scrollOnlyStreak += 1;
      if (scrollStallRecovered) {
        // The recovered plan was answered with another scroll: end the run
        // with the guard's own honest reason (design.md §3).
        return finish({ outcome: "blocked", reason: "no_progress" });
      }
      if (scrollOnlyStreak >= scrollOnlyStreakLimit) {
        // Third guard site (design.md §5): the same one bounded consultation,
        // and a successful recovery resets the streak it broke.
        const recovery = await recoverFromStall("no_progress");
        if (recovery) return recovery;
        scrollStallRecoveredNow = true;
      }
    } else {
      scrollOnlyStreak = 0;
      scrollStallRecovered = false;
    }

    // Scroll brake: a scroll that moved the viewport counts as a change (see
    // observationSignature), so an unbroken run of scrolls can otherwise go
    // on forever. What distinguishes "scrolling is revealing new controls"
    // from "scrolling is hunting for a control that is already offered — or
    // absent" is the ELEMENT TABLE, not the position: once several
    // consecutive scrolls have brought nothing new into it, the run is stuck
    // and ends blocked instead of burning the whole decision budget.
    if (isScroll) {
      // Set-equality, not sequence-equality: the table's viewport-first fill
      // order shifts as the view moves even when the SAME controls remain
      // offered, and only a gain or loss of offered controls is what "this
      // scroll revealed something" means.
      const elementKey = (Array.isArray(next.snapshot?.elements) ? next.snapshot.elements : [])
        .map((el) => `${el?.ref ?? ""}\u0001${el?.label ?? ""}`)
        .sort()
        .join("\u0002");
      scrollStreak = elementKey === scrollElementKey ? scrollStreak + 1 : 1;
      scrollElementKey = elementKey;
      if (scrollStreak >= SCROLL_STREAK_LIMIT) {
        // Second guard site (design.md §5): the scroll brake consults once
        // too, and a successful recovery resets the streak it broke. Its own
        // semantics are unchanged: the loop continues, and only the
        // scroll-only streak above arms the post-recovery rule.
        const recovery = await recoverFromStall("no_progress");
        if (recovery) return recovery;
      }
    } else {
      scrollStreak = 0;
      scrollElementKey = null;
    }
    // A scroll-stall recovery is not permission to keep scrolling: the next
    // executed scroll ends the run blocked `no_progress` (design.md §3).
    if (scrollStallRecoveredNow) scrollStallRecovered = true;

    // The normal revision triggers (design.md §3), evaluated only after the
    // guards: a page-identity change since the memory was last written (the
    // action navigated) or the fixed action cadence. At most one revision per
    // cycle — a recovery above has already replaced the memory and reset the
    // guard counters, so neither trigger fires for it. Preparation is required:
    // failure ends with preparation_failed; it never keeps executing an old
    // plan as a silent fallback.
    if (isRunning() && planAttempted) {
      if (memoryUrl !== null && next.snapshot.url !== memoryUrl) {
        const ended = await replan("navigated");
        if (ended) return ended;
      } else if (executed - memoryAtAction >= memoryUpdateEveryActions) {
        const ended = await replan("cadence");
        if (ended) return ended;
      }
    }
  }
}
