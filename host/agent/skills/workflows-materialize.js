// Materialization: derive a reviewable workflow draft from a COMPLETED run's
// recorded action trail (openspec/changes/add-workflow-materialization-and-heal
// — design.md decisions 1-3, spec "Materialization from a completed run").
//
// Why the trail and not the model's memory (decision 1): the derivation input
// must be a record anyone can re-read and check. Three recorded sources exist
// and they are NOT equivalent:
//
//   1. The transcript's stored `stream_message` events — the SDK's own
//      assistant messages. This is the SDK source of a run's tool
//      calls WITH their arguments: storage/transcript-store.js stores each
//      assistant message verbatim, and the panel already replays
//      `block.type === "tool_use"` / `block.input` from exactly these events
//      (extension/sidepanel/conversation-model.js's _applyStreamMessage), so
//      the draft is derived from the same bytes the operator watched.
//   2. Jev's `jev_step` events record the dispatched tool and argsSummary.
//      Only actual actions count; observations and skipped decisions do not.
//      TYPE_TEXT deliberately omits its value, so it is incomplete. Element
//      identity belongs to each step, never to a run-global ref map.
//   3. storage/action-timeline.js's sanitized `action_event` records. They
//      are secret-redacted by construction, but they carry a tool NAME and a
//      summary — never the dispatched arguments. A definition derived from
//      them alone cannot be complete, so they are the FALLBACK only, and a
//      recorded tool name with no resolved arguments is a specific
//      incompleteness reason, never a guessed argument.
//
// The screen below is load-bearing, not decoration: the transcript is NOT
// redacted (that redaction applies to the action timeline only), so an
// argument that is a secret, a credential-shaped value, or an opaque
// high-entropy token must never become a literal in a saved definition. It
// becomes an incompleteness reason naming the argument KEY — never its
// value — and the operator supplies the real value at review (design.md
// "Risks": redaction is a feature of the input, not a bug to route around).
// Everything else stays a literal constant: v1 ships no speculative
// parameterization, because turning a recorded value into a `{{template}}`
// would be inventing a parameter the operator never declared.
//
// Run OUTPUTS never reach a definition: steps come from tool calls and their
// arguments only. The assistant's own text and any fetched content are
// deliberately not read here — that is what makes the freshness requirement
// ("a stored definition never embeds previously fetched content")
// structurally true for materialized drafts, and what
// host/test/workflows-materialize.test.mjs pins. ONE exception, as narrow as
// it can be: recorded evidence a replay cannot work without — element-
// IDENTITY lines (the `[ref_N] role "name"` line of a search result, or the
// `… landed on <tag> "Name"` line of a click's own result), and the run's
// STARTING PAGE URL from its own first tab listing — and nothing else from
// any result; see extractRunTargetIdentities() and recordedStartUrl().

import { buildRecordingDraft } from "./workflows-run.js";
import { hostOfUrl } from "./workflows-match.js";

/** Bumped only if the derivation's own record shape ever changes (the draft
 *  it produces is a workflow definition validated by the registry schema,
 *  which owns its own version). v2: recorded refs are frozen as stable
 *  targets (see extractRunTargetIdentities/freezeStableTargets).
 *  v3: Jev's recorded steps are a separate, screened action source.
 *  v4: Jev requires a complete, screened starting URL before a non-navigation
 *  action; full replay URLs are distinct from the legacy display digest. */
export const MATERIALIZE_VERSION = 4;

// --- Keep / exclude rule (frozen by the change's task contract) ------------
//
// Bookkeeping and diagnostic tools describe HOW the agent worked, not WHAT
// the operator asked for. A workflow that replayed "update_plan" or
// "read_console_messages" would be noise at best and a different operation
// at worst, so these are dropped from a derived draft silently — they are
// not gaps the operator could resolve.
export const TRAIL_EXCLUDED_TOOL_REFS = Object.freeze([
  "update_plan",
  "debug",
  "debug_timings",
  "get_config",
  "set_config",
  "set_tab_focus",
  "resize_window",
  "read_console_messages",
  "read_network_requests",
  "gif_creator",
  "shortcuts_list",
  "shortcuts_execute",
  "webmcp_list_tools",
  "webmcp_call_tool",
  "list_connected_browsers",
  "select_browser",
  "retranscribe_recording",
  "tabs_close_mcp"
]);

// Tools whose arguments are per-run USER FILES (a path on this machine, an
// image the operator picked). Freezing either into a definition would store
// a value that is meaningless — or wrong — on the next run, and it cannot be
// resolved from the trail, so the step is reported as incomplete rather than
// frozen as a constant.
export const TRAIL_USER_FILE_TOOL_REFS = Object.freeze(["file_upload", "upload_image"]);

// Argument keys that are never part of a replayable step, with why:
//   - tabId: the executor injects the tab the shortcut was addressed to on a
//     step that omits it (extension/background.js's SHORTCUT_TAB_SCOPED_TOOLS),
//     so a frozen tab id would pin the definition to a tab that no longer
//     exists. Dropping it is what makes the step land on the right tab.
//   - runId/requestId/messageId-style keys: run-scoped bookkeeping.
const RUN_SCOPED_ARG_KEY_PATTERN = /^(tabId|runId|requestId|messageId|executionId)$/;

// --- Stable element identities (refs that outlive their document) ----------
//
// A recorded `ref_N` is a handle into ONE document's in-memory element map
// (content.js: a WeakRef map wiped by navigation, SPA route changes, tab
// close/reopen and browser restart). Freezing it into a definition pins the
// step to a handle that is guaranteed dead by the next session, so a replayed
// click could never land. What DOES survive is the identity the search
// results stated beside the ref — role + accessible name — so the ref is
// replaced by that identity and the replay re-resolves it live
// (extension/content.js's getTargetCoordinates, background.js's
// resolveTargetToCoordinates). The rewrite happens ONLY when an identity was
// actually recorded; an unmapped ref is left exactly as recorded rather than
// guessed at, and drifts honestly if a replay cannot resolve it.

const REF_LINE_PATTERN = /\[(ref_\d+)\]\s+([a-z][a-z0-9_-]*)\s+"([^"]+)"/g;
// What a click's own result says it landed on: `… — landed on <li> "Hải
// Phòng"`. The quoted name is THE element that received the click (evidence
// local to the click's own document), and for a ref picked off a screenshot
// it is the only identity that exists anywhere in the trail. Deliberately
// anchored to the quoted-name form: variants like `<span> — a dropdown list
// is now OPEN …` describe state, not identity, and never match. A landing on
// a FORM CONTROL is not a name at all — `<select> "…"` quotes the control's
// option list (a 2026-09-15 recording froze exactly that and no later run
// could ever match it) — so those tags are skipped below and the handle is
// kept as recorded instead.
const LANDED_ON_LINE_PATTERN = /landed on <([a-z][a-z0-9_]*)[^>]*>\s*"([^"]+)"/;
const FORM_CONTROL_TAGS = new Set(["select", "input", "textarea"]);
const REF_ARG_VALUE_PATTERN = /^ref_\d+$/;
const MAX_TARGET_NAME = 200;

function normalizeTargetName(name) {
  return String(name || "").replace(/\s+/g, " ").trim().slice(0, MAX_TARGET_NAME);
}

/**
 * Collect `ref_N → {role?, name}` for one run's recorded refs — the ONLY
 * thing any tool result is ever read for (see the module header). Two
 * evidence sources, strongest first:
 *
 *   1. the click's OWN result — `… landed on <tag> "Name"` describes exactly
 *      the element that received that click (associated with its call by
 *      tool id). It is the only evidence that exists for a ref the model
 *      picked off a screenshot, and it is local to the click's own document.
 *   2. the search results' `[ref_N] role "name"` lines.
 *
 * Across a mid-run navigation the same ref number can name two different
 * elements: each source marks such a ref ambiguous (null) rather than
 * choosing. The landing description then wins the name when it exists (it
 * disambiguates), and the search line contributes the role only when it
 * corroborates that same name. A ref with no evidence at all is absent.
 *
 * @returns {Map<string, {role?: string, name: string}>}
 */
export function extractRunTargetIdentities({ conversationEvents, runId }) {
  const events = Array.isArray(conversationEvents) ? conversationEvents : [];
  const out = new Map();
  const window = runTrailWindow({ conversationEvents: events, runId });
  if (!window.ok) return out;

  const search = new Map(); // ref -> {role, name} | null (ambiguous)
  const landed = new Map(); // ref -> {name} | null (ambiguous)
  const refOfToolUse = new Map(); // tool_use id -> the ref that call aimed at

  const record = (map, ref, identity, same) => {
    if (!map.has(ref)) {
      map.set(ref, identity);
      return;
    }
    const prev = map.get(ref);
    if (prev && !same(prev, identity)) map.set(ref, null);
  };

  for (const event of events) {
    if (!event || typeof event.seq !== "number") continue;
    if (event.seq <= window.startSeq || event.seq > window.endSeq) continue;
    if (event.runId !== runId) continue;
    if (event.type !== "stream_message") continue;
    const message = event.message;
    if (!message) continue;
    const content = message.message && Array.isArray(message.message.content) ? message.message.content : [];

    if (message.type === "assistant") {
      for (const block of content) {
        if (!block || block.type !== "tool_use") continue;
        const input = block.input;
        const ref =
          isPlainObject(input) && typeof input.ref === "string" && REF_ARG_VALUE_PATTERN.test(input.ref)
            ? input.ref
            : null;
        if (ref && typeof block.id === "string" && block.id) refOfToolUse.set(block.id, ref);
      }
      continue;
    }
    if (message.type !== "user") continue;

    for (const block of content) {
      if (!block || block.type !== "tool_result") continue;
      const parts = Array.isArray(block.content) ? block.content : [];
      const text = parts
        .filter((part) => part && part.type === "text" && typeof part.text === "string")
        .map((part) => part.text)
        .join("\n");
      if (!text) continue;

      for (const match of text.matchAll(REF_LINE_PATTERN)) {
        const name = normalizeTargetName(match[3]);
        // A label is page text; one that looks credential-bearing is never
        // frozen into a definition (same screen every other frozen value
        // passes).
        if (!name || looksSecretBearing(name)) continue;
        record(search, match[1], { role: match[2], name }, (a, b) => a.role === b.role && a.name === b.name);
      }

      const ref = refOfToolUse.get(block.tool_use_id);
      if (ref) {
        const landing = text.match(LANDED_ON_LINE_PATTERN);
        // Landing evidence only counts for elements whose text is a LABEL —
        // a form control's quoted text is its content (a select's option
        // list), not a name a later run could match.
        if (landing && !FORM_CONTROL_TAGS.has(landing[1])) {
          const name = normalizeTargetName(landing[2]);
          if (name && !looksSecretBearing(name)) record(landed, ref, { name }, (a, b) => a.name === b.name);
        }
      }
    }
  }

  for (const ref of new Set([...search.keys(), ...landed.keys()])) {
    const fromSearch = search.get(ref) || null;
    const fromLanded = landed.get(ref) || null;
    if (landed.has(ref) && !fromLanded) continue; // this ref landed on two different elements: nothing is safe to freeze
    if (fromLanded) {
      out.set(
        ref,
        fromSearch && fromSearch.name === fromLanded.name && fromSearch.role
          ? { role: fromSearch.role, name: fromLanded.name }
          : { name: fromLanded.name }
      );
    } else if (fromSearch) {
      out.set(ref, fromSearch);
    }
  }
  return out;
}

/**
 * Rewrite one step's arguments: every recorded `ref` that has a known
 * identity becomes a `target` (role + name) and the dead handle is dropped.
 * Nested objects and arrays are walked exactly like screenTrailArgs walks
 * them. A ref with no derivable identity is preserved untouched — the step
 * still works within the recording session, and a later replay fails
 * honestly rather than clicking a guess.
 *
 * @returns {{ args: object, rewritten: boolean }}
 */
export function freezeStableTargets(args, identities) {
  if (!isPlainObject(args) || !(identities instanceof Map)) return { args, rewritten: false };
  let rewritten = false;
  const walk = (node) => {
    if (Array.isArray(node)) return node.map(walk);
    if (!isPlainObject(node)) return node;
    const out = {};
    for (const [key, value] of Object.entries(node)) {
      if (
        key === "ref" &&
        typeof value === "string" &&
        REF_ARG_VALUE_PATTERN.test(value) &&
        // Absent (undefined) and ambiguous (null) both fall through: an
        // unmapped or conflicting ref stays as recorded, never a guess.
        identities.get(value) &&
        !("target" in node)
      ) {
        const identity = identities.get(value);
        out.target = { role: identity.role, name: identity.name };
        rewritten = true;
        continue;
      }
      out[key] = walk(value);
    }
    return out;
  };
  return { args: walk(args), rewritten };
}

// Registry tools whose ref survives unchanged; anything else must resolve to
// a tool this product actually dispatches (the schema re-checks the shape).
const TOOL_REF_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

// --- Secret / high-entropy screening --------------------------------------

const SECRET_ARG_KEY_PATTERN =
  /(pass(word|wd)?|pwd|secret|token|api[-_]?key|apikey|auth|authorization|cookie|credential|otp|pin|session|private[-_]?key|card|cvv|iban|ssn)/i;

// A value shorter than this cannot carry enough entropy to be an opaque
// credential even if every character were random (20 hex chars = 80 bits, so
// this is a deliberately conservative floor: it errs toward ASKING).
const HIGH_ENTROPY_MIN_LENGTH = 24;
// Bits per character. English prose sits near 2.5-3.0, base64/hex blobs near
// 3.9-4.0; the threshold sits between them.
const HIGH_ENTROPY_MIN_BITS_PER_CHAR = 3.4;
// A token has to use a real alphabet: a long lowercase slug with hyphens has
// plenty of entropy per character while carrying nothing secret.
const HIGH_ENTROPY_MIN_DISTINCT_CHARS = 12;
// A bare lowercase hex blob is the one single-class token shape worth
// flagging (session ids and keys are routinely hex).
const HEX_TOKEN_PATTERN = /^[0-9a-f]{32,}$/;
const URL_SHAPE_PATTERN = /^[a-z][a-z0-9+.-]*:\/\//i;
// A token embedded in a larger value (a script line, a templated string) is
// the same leak as a bare one: scan for long token-alphabet runs inside.
const EMBEDDED_TOKEN_RUN_PATTERN = /[A-Za-z0-9+/_=-]{24,}/g;

// A query parameter whose NAME is credential-shaped, anywhere in a URL.
const SECRET_QUERY_PARAM_PATTERN = /[?&]([A-Za-z0-9_.\-\[\]]+)=/g;
// A JWT: three base64url segments, the last two non-empty.
const JWT_PATTERN = /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const BEARER_PATTERN = /^\s*(bearer|basic)\s+\S/i;
// 13-19 digits, optionally separated — a payment card is the operator's data,
// never a step constant.
const CARD_PATTERN = /^(?:\d[ -]?){12,18}\d$/;

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Shannon entropy in bits per character (0 for the empty string). */
export function entropyBitsPerChar(value) {
  if (typeof value !== "string" || value.length === 0) return 0;
  const counts = new Map();
  for (const ch of value) counts.set(ch, (counts.get(ch) || 0) + 1);
  let bits = 0;
  for (const n of counts.values()) {
    const p = n / value.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

/**
 * The opaque-token shape: long, whitespace-free, drawn from a real alphabet,
 * and mixing case with digits — or a bare lowercase hex blob. A slug, an
 * order number, or a human-readable phrase never matches; a base64/api-key
 * value does.
 */
export function looksHighEntropyToken(value) {
  if (typeof value !== "string") return false;
  const v = value.trim();
  if (v.length < HIGH_ENTROPY_MIN_LENGTH || /\s/.test(v)) return false;
  if (new Set(v).size < HIGH_ENTROPY_MIN_DISTINCT_CHARS) return false;
  if (HEX_TOKEN_PATTERN.test(v)) return entropyBitsPerChar(v) >= 3.5;
  if (!/[a-z]/.test(v) || !/[A-Z]/.test(v) || !/[0-9]/.test(v)) return false;
  return entropyBitsPerChar(v) >= HIGH_ENTROPY_MIN_BITS_PER_CHAR;
}

/** Credential material inside a URL: userinfo, a credential-named query
 *  parameter, or an opaque token sitting in a path segment. */
function urlCarriesSecret(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    // Scheme-shaped but unparseable: treat it as opaque rather than assume
    // there is nothing in it (the conservative direction).
    return true;
  }
  if (url.username || url.password) return true;
  for (const name of url.searchParams.keys()) {
    if (SECRET_ARG_KEY_PATTERN.test(name)) return true;
  }
  for (const segment of url.pathname.split("/")) {
    if (looksHighEntropyToken(segment)) return true;
  }
  return false;
}

/**
 * Does this STRING VALUE look like an opaque credential?
 *
 * Deliberately structural (no dictionary of real secrets, no network): a
 * JWT/Bearer/card shape, credential material inside a URL, or an opaque
 * high-entropy token. Conservative by construction — a false positive costs
 * one incompleteness reason the operator resolves by editing, a false
 * negative would freeze a live credential into a stored definition.
 */
export function looksSecretBearing(value) {
  if (typeof value !== "string") return false;
  const v = value.trim();
  if (!v) return false;
  if (JWT_PATTERN.test(v) || BEARER_PATTERN.test(v) || CARD_PATTERN.test(v)) return true;
  if (URL_SHAPE_PATTERN.test(v)) return urlCarriesSecret(v);
  for (const match of v.matchAll(SECRET_QUERY_PARAM_PATTERN)) {
    if (SECRET_ARG_KEY_PATTERN.test(match[1])) return true;
  }
  if (looksHighEntropyToken(v)) return true;
  for (const match of v.matchAll(EMBEDDED_TOKEN_RUN_PATTERN)) {
    if (looksHighEntropyToken(match[0])) return true;
  }
  return false;
}

/** True when this argument KEY names credential-shaped material. */
export function looksSecretArgKey(key) {
  return typeof key === "string" && SECRET_ARG_KEY_PATTERN.test(key);
}

/**
 * Screen one recorded step's arguments.
 *
 * @returns {{ ok: true, args: object } | { ok: false, reasons: string[] }}
 *   Reasons name the argument PATH (`args.token`) and never the value: a
 *   reason is written into a review surface and a transcript event, so it
 *   must not itself become the leak it reports.
 */
export function screenTrailArgs(args) {
  const reasons = [];
  const clean = {};
  if (args === undefined || args === null) return { ok: true, args: {} };
  if (!isPlainObject(args)) return { ok: false, reasons: ["the recorded arguments are not an object"] };
  const walk = (node, path, target) => {
    for (const [key, value] of Object.entries(node)) {
      const here = `${path}.${key}`;
      if (RUN_SCOPED_ARG_KEY_PATTERN.test(key)) continue; // run-scoped, never frozen — see the pattern's comment
      if (looksSecretArgKey(key)) {
        reasons.push(`argument "${here}" is credential-shaped and was not recorded in a reusable form`);
        continue;
      }
      if (typeof value === "string") {
        if (looksSecretBearing(value)) {
          reasons.push(`argument "${here}" holds an opaque high-entropy value that cannot be frozen into a workflow`);
          continue;
        }
        target[key] = value;
        continue;
      }
      if (Array.isArray(value)) {
        const out = [];
        for (const [index, item] of value.entries()) {
          if (isPlainObject(item)) {
            const inner = {};
            walk(item, `${here}[${index}]`, inner);
            out.push(inner);
          } else if (typeof item === "string" && looksSecretBearing(item)) {
            reasons.push(`argument "${here}[${index}]" holds an opaque high-entropy value that cannot be frozen into a workflow`);
          } else {
            out.push(item);
          }
        }
        target[key] = out;
        continue;
      }
      if (isPlainObject(value)) {
        const inner = {};
        walk(value, here, inner);
        target[key] = inner;
        continue;
      }
      target[key] = value;
    }
  };
  walk(args, "args", clean);
  if (reasons.length) return { ok: false, reasons };
  return { ok: true, args: clean };
}

// --- Trail reading ---------------------------------------------------------

/** The terminal events that make a run's trail derivable. A run that was
 *  interrupted by a companion restart never reached one of these: the work
 *  may have happened, but "a COMPLETED run" is the spec's criterion and an
 *  interrupted trail cannot be distinguished from a truncated one. */
const RUN_TERMINAL_EVENT_TYPES = new Set(["run_done", "run_stopped"]);

/** Un-qualify the SDK-facing name back to the registry tool name
 *  (`mcp__browzy-in-chrome-browser__read_page` → `read_page`). Mirrors
 *  host/agent/tools/adapter.js's legacyToolNameFromSdkName semantics without
 *  importing the adapter (which loads the Anthropic SDK at module scope and
 *  has no business in a pure derivation module). */
export function registryToolRef(name) {
  if (typeof name !== "string") return null;
  const trimmed = name.trim();
  if (!trimmed) return null;
  if (!trimmed.startsWith("mcp__")) return trimmed;
  const parts = trimmed.split("__");
  return parts.length >= 3 ? parts.slice(2).join("__") : trimmed;
}

/**
 * Locate one run's trail window inside its conversation's stored event log:
 * the `run_created` event that minted `runId` through the run's terminal
 * event, inclusive of the terminal's own seq so a tool call in the last
 * message is never dropped.
 *
 * @returns {{ ok: true, startSeq, endSeq } | { ok: false, reason: "unknown_run"|"run_not_completed" }}
 */
export function runTrailWindow({ conversationEvents, runId }) {
  const events = Array.isArray(conversationEvents) ? conversationEvents : [];
  if (!runId || typeof runId !== "string") return { ok: false, reason: "unknown_run" };
  let startSeq = null;
  let endSeq = null;
  for (const event of events) {
    if (!event || event.runId !== runId) continue;
    if (event.type === "run_created" && startSeq === null) startSeq = event.seq;
    else if (RUN_TERMINAL_EVENT_TYPES.has(event.type)) endSeq = event.seq;
  }
  if (startSeq === null) return { ok: false, reason: "unknown_run" };
  if (endSeq === null) return { ok: false, reason: "run_not_completed" };
  return { ok: true, startSeq, endSeq };
}

const JEV_ACTIONS = Object.freeze({
  CLICK: { tool: "computer", action: "left_click" },
  HOVER: { tool: "computer", action: "hover" },
  TYPE_TEXT: { tool: "form_input" },
  SELECT: { tool: "form_input" },
  NAVIGATE: { tool: "navigate" },
  SCROLL_UP: { tool: "computer", action: "scroll" },
  SCROLL_DOWN: { tool: "computer", action: "scroll" },
  WAIT: { tool: "computer", action: "wait" }
});
const REDACTED_VALUE_PATTERN = /^(?:\[(?:redacted|masked|hidden)\]|<(?:redacted|masked|hidden)>|\*{3,})$/i;

function containsRedactedValue(value) {
  if (typeof value === "string") return REDACTED_VALUE_PATTERN.test(value.trim());
  if (Array.isArray(value)) return value.some(containsRedactedValue);
  return isPlainObject(value) && Object.values(value).some(containsRedactedValue);
}

// Match runtime.js's durable capture bound without importing the runtime and
// its provider/dispatch dependencies into this pure derivation module.
const MAX_JEV_REPLAY_URL_CHARS = 8192;
const REDACTED_URL_PART_PATTERN = /\[(?:redacted|masked|hidden)\]|<(?:redacted|masked|hidden)>|\*{3,}|•{3,}/i;

// A current capture records replayUrl and explicit completeness metadata.
// Legacy observed.url was capped at 200: a value at that cap may be only a
// prefix. Missing/invalid modern metadata must never fall back to that digest.
function recordedJevUrl(observed) {
  const refuse = (reason) => ({ url: null, reason });
  const modern = isPlainObject(observed) && ("replayUrl" in observed || "replayUrlTruncated" in observed);
  if (modern && observed.replayUrlTruncated === true) {
    return refuse(`the recorded page URL exceeded the ${MAX_JEV_REPLAY_URL_CHARS}-character capture limit and was not retained in full`);
  }
  if (modern && observed.replayUrlTruncated !== false) return refuse("the recorded page URL has no completeness confirmation");
  const url = modern ? observed.replayUrl : observed?.url;
  if (url == null || url === "") return refuse("the starting page URL is missing from the recorded action");
  if (typeof url !== "string") return refuse("the recorded page URL is not a valid absolute HTTP(S) URL");
  if (url.length > MAX_JEV_REPLAY_URL_CHARS) return refuse(`the recorded page URL exceeds the ${MAX_JEV_REPLAY_URL_CHARS}-character replay limit`);
  if (!modern && url.length >= 200) return refuse("the legacy page URL reached the 200-character display cap and may be truncated; the complete starting URL is unavailable");
  let decoded;
  try {
    decoded = decodeURIComponent(url);
  } catch {
    return refuse("the recorded page URL contains invalid URL encoding");
  }
  if (observed?.redaction?.applied === true || REDACTED_URL_PART_PATTERN.test(decoded)) {
    return refuse("the recorded page URL contains redacted values that cannot be reused");
  }
  if (!/^https?:\/\//i.test(url) || /[\s\\]/.test(url) || !hostOfUrl(url)) return refuse("the recorded page URL is not a valid absolute HTTP(S) URL");
  const screened = screenTrailArgs({ url });
  if (!screened.ok) return refuse(screened.reasons.join("; "));
  return { url, reason: null };
}

/** Jev's hand-built summary is exact for each operation except TYPE_TEXT.
 * Validate that contract before accepting it; an omitted argument is not a
 * default, and a SELECT option's label is not its control's identity. */
function jevCall(event) {
  const name = registryToolRef(event.tool) || "jev_step";
  const input = isPlainObject(event.argsSummary) ? event.argsSummary : null;
  const observed = recordedJevUrl(event.observed);
  const call = {
    name, input, seq: event.seq, toolUseId: null, source: "jev_steps",
    observedUrl: observed.url, observedUrlIssue: observed.reason, argsResolved: Boolean(input), issues: []
  };
  const refuse = (reason) => { call.issues.push(reason); return call; };
  if (event.skippedReason === "result_unknown") return refuse("the dispatched action's result is unknown; its completion cannot be confirmed");
  if (event.operation === "TYPE_TEXT") {
    return refuse('TYPE_TEXT does not retain the typed value in the durable trail; argument "args.value" must be supplied before this step can be reused');
  }
  const expected = JEV_ACTIONS[event.operation];
  if (!expected || name !== expected.tool) return refuse("the recorded Jev operation and tool do not identify a supported action");
  if (!input) return call;
  if (event.redaction?.applied === true || containsRedactedValue(input)) return refuse("the recorded arguments contain redacted values that cannot be reused");
  if (expected.action && input.action !== expected.action) return refuse('the recorded argument "args.action" is missing or inconsistent with the operation');
  const nonempty = (value) => typeof value === "string" && Boolean(value.trim());
  const missing = (key) => refuse(`the recorded argument "args.${key}" is missing or invalid`);
  if (event.operation === "NAVIGATE" && (!nonempty(input.url) || !/^https?:\/\//i.test(input.url) || !hostOfUrl(input.url))) return missing("url");
  if (event.operation === "WAIT" && !(Number.isFinite(input.duration) && input.duration > 0)) return missing("duration");
  if (event.operation === "SCROLL_UP" || event.operation === "SCROLL_DOWN") {
    if (!Array.isArray(input.coordinate) || input.coordinate.length !== 2 || !input.coordinate.every(Number.isFinite)) return missing("coordinate");
    if (input.scroll_direction !== (event.operation === "SCROLL_UP" ? "up" : "down")) return missing("scroll_direction");
    if (!(Number.isFinite(input.scroll_amount) && input.scroll_amount > 0)) return missing("scroll_amount");
  }
  if (["CLICK", "HOVER", "SELECT"].includes(event.operation)) {
    if (typeof input.ref !== "string" || !REF_ARG_VALUE_PATTERN.test(input.ref)) return missing("ref");
    if (event.operation === "SELECT" && typeof input.value !== "string") return missing("value");
    const label = event.operation === "SELECT" ? event.target?.elementLabel : event.target?.label;
    if (!nonempty(label) || containsRedactedValue(label)) return refuse("the recorded target's control name is unavailable for replay");
    // Screen the whole recorded label before normalization; never truncate a
    // secret-bearing suffix away and then accept its prefix as an identity.
    const identity = screenTrailArgs({ target: { name: label, ...(nonempty(event.target?.role) ? { role: event.target.role } : {}) } });
    if (!identity.ok) { call.issues.push(...identity.reasons); return call; }
    call.identities = new Map([[input.ref, { ...identity.args.target, name: label.replace(/\s+/g, " ").trim() }]]);
  }
  return call;
}

/**
 * Read one run's tool calls out of its conversation's stored event log.
 *
 * @returns {{ ok: true, calls: Array<{name, input, seq, toolUseId, argsResolved}>, startSeq, endSeq }
 *          | { ok: false, reason: "unknown_run" | "run_not_completed" | "no_trail" }}
 */
export function extractRunToolCalls({ conversationEvents, runId }) {
  const events = Array.isArray(conversationEvents) ? conversationEvents : [];
  const window = runTrailWindow({ conversationEvents: events, runId });
  if (!window.ok) return window;
  const { startSeq, endSeq } = window;

  const calls = [];
  const seenToolUseIds = new Set();
  for (const event of events) {
    if (!event || typeof event.seq !== "number") continue;
    if (event.seq <= startSeq || event.seq > endSeq) continue;
    // Both bounds matter: the seq window is the run's own, and the runId tag
    // is what keeps a concurrently-written event (another conversation's run
    // shares nothing, but a resumed/interrupted sibling could interleave)
    // from being attributed to this run.
    if (event.runId !== runId) continue;
    if (event.type !== "stream_message") continue;
    const message = event.message;
    if (!message || message.type !== "assistant") continue;
    const content = message.message && Array.isArray(message.message.content) ? message.message.content : [];
    for (const block of content) {
      if (!block || block.type !== "tool_use") continue;
      const name = registryToolRef(block.name);
      if (!name) continue;
      // One action has one tool_use id; a transcript that carries the same
      // block twice (a redelivered message) must not become two steps.
      if (typeof block.id === "string" && block.id) {
        if (seenToolUseIds.has(block.id)) continue;
        seenToolUseIds.add(block.id);
      }
      calls.push({
        name,
        // `input` is the SDK's own tool_use input. `input === undefined` is
        // recorded as argsResolved:false — an unresolvable argument set is a
        // reason, never an empty object presented as "this step takes none".
        input: isPlainObject(block.input) ? block.input : null,
        argsResolved: isPlainObject(block.input),
        seq: event.seq,
        toolUseId: typeof block.id === "string" ? block.id : null
      });
    }
  }
  if (!calls.length) {
    const steps = events.filter((event) => event?.type === "jev_step" && event.runId === runId &&
      typeof event.seq === "number" && event.seq > startSeq && event.seq <= endSeq).sort((a, b) => a.seq - b.seq);
    if (steps.length) {
      const seenSteps = new Map();
      for (const event of steps) {
        // A refused decision reuses the next executed step number. Filter it
        // BEFORE deduplication. result_unknown did dispatch and must block a
        // draft instead of silently removing a possibly completed mutation.
        if (event.operation === "DONE" || event.operation === "BLOCKED") continue;
        if (event.skippedReason && event.skippedReason !== "result_unknown") continue;
        const call = jevCall(event);
        if (Number.isInteger(event.step) && event.step > 0) {
          const fingerprint = JSON.stringify([event.operation, event.tool, event.argsSummary, event.target, event.skippedReason,
            call.observedUrl, call.observedUrlIssue]);
          if (seenSteps.has(event.step)) {
            if (seenSteps.get(event.step) !== fingerprint) {
              call.issues.push("conflicting records for the same Jev action cannot be resolved");
              calls.push(call);
            }
            continue;
          }
          seenSteps.set(event.step, fingerprint);
        }
        calls.push(call);
      }
      // Even a Jev run that only observed or skipped has an authoritative
      // step trail. Never fall back to its auxiliary action timeline.
      return calls.length
        ? { ok: true, calls, startSeq, endSeq, source: "jev_steps", startUrl: calls[0].observedUrl, startUrlIssue: calls[0].observedUrlIssue }
        : { ok: false, reason: "no_trail" };
    }
    // Fallback (frozen contract): the SANITIZED action timeline. It is the
    // secret-free record, and it names the tools a run dispatched — but it
    // never carries the dispatched arguments (only a redacted summary), so a
    // step derived from it can never be complete. Returning these as
    // unresolved calls is what turns "the messages are gone" into a specific
    // per-step reason instead of a bare `no_trail`.
    //
    // Scoped by the inner event's own runId, not by the seq window: these are
    // batched on the wire and a batch can be appended a moment after the
    // run's terminal event.
    for (const event of events) {
      if (!event || event.type !== "action_event") continue;
      const inner = event.event;
      if (!inner || inner.runId !== runId) continue;
      const name = registryToolRef(inner.action && inner.action.tool);
      if (!name) continue;
      calls.push({
        name,
        input: null,
        argsResolved: false,
        seq: event.seq,
        toolUseId: typeof inner.actionId === "string" ? inner.actionId : null,
        source: "action_timeline"
      });
    }
    if (calls.length) return { ok: true, calls, startSeq, endSeq, source: "action_timeline" };
    return { ok: false, reason: "no_trail" };
  }
  return { ok: true, calls, startSeq, endSeq, source: "transcript_messages" };
}

/** Recorded page hosts, in trail order — from the tool calls' own arguments
 *  (a `navigate`/`read_page`-style call that names a URL). Recorded data
 *  only: nothing here is inferred from the current page. */
function recordedHosts(calls) {
  const hosts = [];
  for (const call of calls) {
    const url = call.input && typeof call.input.url === "string" ? call.input.url : null;
    for (const recordedUrl of [call.observedUrl, url]) {
      const host = recordedUrl ? hostOfUrl(recordedUrl) : null;
      if (host && !hosts.includes(host)) hosts.push(host);
    }
  }
  return hosts;
}

/** The page a run STARTED on, as the run itself recorded it: the URL of the
 *  tab(s) its context named, read from the run's first tab listing
 *  (`tabs_context_mcp`'s result — `{"availableTabs":[…"url":"…"]}`). This is
 *  the one piece of starting state a replay cannot infer: the operator had
 *  the page open already, so no `navigate` call records it — and a replay
 *  launched from any other page state silently mis-aims every step. Returns
 *  null when the window carries no such listing, or the URL is not an
 *  ordinary http(s) page — a replay is never pointed at an invented
 *  address. */
function recordedStartUrl({ conversationEvents, runId, calls }) {
  const listCallIds = new Set(
    calls.filter((call) => call.name === "tabs_context_mcp" && call.toolUseId).map((call) => call.toolUseId)
  );
  if (!listCallIds.size) return null;
  const events = Array.isArray(conversationEvents) ? conversationEvents : [];
  const window = runTrailWindow({ conversationEvents: events, runId });
  if (!window.ok) return null;
  for (const event of events) {
    if (!event || typeof event.seq !== "number") continue;
    if (event.seq <= window.startSeq || event.seq > window.endSeq) continue;
    if (event.runId !== runId) continue;
    if (event.type !== "stream_message") continue;
    const message = event.message;
    if (!message || message.type !== "user") continue;
    const content = message.message && Array.isArray(message.message.content) ? message.message.content : [];
    for (const block of content) {
      if (!block || block.type !== "tool_result") continue;
      if (!listCallIds.has(block.tool_use_id)) continue;
      const parts = Array.isArray(block.content) ? block.content : [];
      for (const part of parts) {
        if (!part || part.type !== "text" || typeof part.text !== "string") continue;
        const match = part.text.match(/"url"\s*:\s*"([^"]+)"/);
        if (!match) continue;
        const url = match[1];
        if (!/^https?:\/\//i.test(url)) continue;
        if (!hostOfUrl(url)) continue;
        return url;
      }
    }
  }
  return null;
}

function slugify(text) {
  const slug = String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "");
  return slug || "workflow";
}

/**
 * Derive a reviewable draft from a completed run's trail.
 *
 * @param {object} args
 * @param {Array} args.conversationEvents - the conversation's stored event log
 *   (TranscriptStore.allEvents()).
 * @param {string} args.runId
 * @param {string|null} [args.metaHostname] - the conversation's recorded
 *   hostname (presentation metadata) — the domain fallback when the trail
 *   itself names no URL.
 * @param {object|null} [args.document] - the recorded document binding, when
 *   one exists. Optional in v1: a run with no recorded document binding
 *   derives a draft without one (the definition's own documentConstraints
 *   stay {}), which is the honest representation, not a gap.
 * @returns {{ ok: true, draft, review }
 *          | { ok: false, reason }
 *          | { ok: false, incomplete: string[] }}
 */
export function deriveRunDraft({ conversationEvents, runId, metaHostname = null, document = null } = {}) {
  const extracted = extractRunToolCalls({ conversationEvents, runId });
  if (!extracted.ok) return extracted;
  // What the search results said each recorded ref pointed at, so dead
  // handles can be frozen as live-resolvable identities (see below).
  const identities = extractRunTargetIdentities({ conversationEvents, runId });

  const incomplete = [];
  const events = [];
  let stepNumber = 0;
  for (const call of extracted.calls) {
    if (TRAIL_EXCLUDED_TOOL_REFS.includes(call.name)) continue;
    stepNumber += 1;
    if (!TOOL_REF_PATTERN.test(call.name)) {
      incomplete.push(`step ${stepNumber}: recorded tool "${call.name}" is not a registry tool name`);
      continue;
    }
    if (TRAIL_USER_FILE_TOOL_REFS.includes(call.name)) {
      incomplete.push(
        `step ${stepNumber} (${call.name}): the step uses a file the operator picked for this run, which cannot be frozen into a workflow`
      );
      continue;
    }
    if (call.issues?.length) {
      for (const reason of call.issues) incomplete.push(`step ${stepNumber} (${call.name}): ${reason}`);
      continue;
    }
    if (!call.argsResolved) {
      incomplete.push(`step ${stepNumber} (${call.name}): the recorded arguments could not be resolved from the transcript`);
      continue;
    }
    const screened = screenTrailArgs(call.input);
    if (!screened.ok) {
      for (const reason of screened.reasons) incomplete.push(`step ${stepNumber} (${call.name}): ${reason}`);
      continue;
    }
    // A recorded ref is a handle into one document's memory; freeze the
    // element's identity beside it instead so a replay can re-resolve the
    // step against the live page. Unmapped refs stay exactly as recorded.
    const frozen = freezeStableTargets(screened.args, call.source === "jev_steps" ? call.identities : identities);
    events.push({ kind: "tool", ref: call.name, params: frozen.args });
  }
  if (!events.length && !incomplete.length) {
    // Every recorded call was bookkeeping: there is no operator action left
    // to turn into a workflow, which is a "no trail" outcome, not a draft.
    return { ok: false, reason: "no_trail" };
  }

  // Only a leading navigation establishes state before the first action.
  // A hostname, a later observation or a later navigate cannot recover the
  // exact page that an earlier click needed. Refuse the whole draft instead
  // of silently making those clicks run on whichever page is currently open.
  if (extracted.source === "jev_steps" && extracted.calls[0].name !== "navigate" && !extracted.startUrl) {
    incomplete.push(`starting page: ${extracted.startUrlIssue || "the complete starting page URL is unavailable"}`);
  }

  const hosts = recordedHosts(extracted.calls);
  const jevStartHost = extracted.startUrl ? hostOfUrl(extracted.startUrl) : null;
  if (jevStartHost && !hosts.includes(jevStartHost)) hosts.unshift(jevStartHost);
  const domain = hosts[0] || (typeof metaHostname === "string" && metaHostname.trim() ? metaHostname.trim().toLowerCase() : null);
  if (!domain) incomplete.push("the run's recorded trail names no page host, so no domain binding can be derived");
  if (incomplete.length) return { ok: false, incomplete };

  // A replay must start where the run started. The trail usually records no
  // `navigate` for that page — the operator already had it open (exactly how
  // the dauthau.asia run began), so a replay launched from some other page
  // state mis-aims every step at whatever is on screen. When the run's own
  // first tab listing recorded that starting URL and the trail itself never
  // navigates, the replay gets an explicit first step back to it; a trail
  // that does navigate already says where it goes and is left alone.
  const trailNavigates = extracted.source === "jev_steps"
    ? extracted.calls[0].name === "navigate"
    : extracted.calls.some((call) => call.name === "navigate");
  const startUrl = trailNavigates ? null : extracted.source === "jev_steps"
    ? extracted.startUrl
    : recordedStartUrl({ conversationEvents, runId, calls: extracted.calls });
  if (startUrl) {
    const screenedStart = screenTrailArgs({ url: startUrl });
    if (!screenedStart.ok) return { ok: false, incomplete: screenedStart.reasons.map((reason) => `starting page: ${reason}`) };
  }
  if (startUrl) events.unshift({ kind: "tool", ref: "navigate", params: { url: startUrl } });
  const startHost = startUrl ? hostOfUrl(startUrl) : null;

  // The registry's own draft contract decides what "reviewable" means: the
  // events map onto the same shape buildRecordingDraft() consumes, so there
  // is exactly one definition of "fully resolved or specific reasons" in the
  // codebase (design.md decision 2). Parameter schemas do not exist yet for a
  // run-derived draft, so there is nothing to resolve against them.
  const derived = buildRecordingDraft({
    events,
    domain,
    document,
    workflow: { parameterSchema: {} },
    // A run trail may legitimately bind no document (see this function's
    // `document` parameter): the recording path keeps requiring one.
    requireDocument: false
  });
  if (!derived.ok) return derived;

  const hostLabel = domain.replace(/^www\./, "");
  const name = `${hostLabel} workflow`;
  const workflowId = slugify(`${hostLabel}-workflow`);
  const draft = {
    workflowId,
    name,
    steps: derived.draft.steps,
    domain,
    document: document || null,
    // Every host the trail recorded — and the recorded start page's own host
    // — in order: a run that visited several hosts is bound to all of them,
    // never to a guessed single one.
    domains: [...new Set([...(hosts.length ? hosts : [domain]), ...(startHost ? [startHost] : [])])]
  };
  return {
    ok: true,
    draft,
    review: { workflowId, name, steps: draft.steps, domain, document: draft.document, domains: draft.domains }
  };
}
