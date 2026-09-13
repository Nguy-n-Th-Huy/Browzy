// Permission modes, action classification, and the mode resolver.
//
// Modes select among classifications the codebase already computes rather
// than adding a parallel one (design decision 1): Manual gates the mutating
// set, Auto gates the send/submit subset, Skip gates nothing but protected.
// Auto reproduces today's behavior exactly.
//
// Every function here is pure over caller-supplied inputs, matching how the
// existing policy modules are written and tested: no SDK run, no browser,
// no storage access inside this file. Callers supply mode snapshots,
// site-match results, and managed policy; storage lives with them.

import {
  isMutatingCall,
  classifySendClassCall,
  getJavaScriptSource,
  normalizeComputerAction,
  REGISTERED_COMPUTER_ACTIONS,
  _mutationClassificationCoverage
} from "../tools/mapping.js";
import { TOOLS } from "../../tool-definitions.js";

export const PERMISSION_MODES = Object.freeze(["manual", "auto", "skip"]);
export const DEFAULT_MODE = "auto";

export const ACTION_CLASSES = Object.freeze({
  READ_ONLY: "readonly",
  MUTATING: "mutating",
  SEND: "send",
  PROTECTED: "protected"
});

// Protected categories, named on the decision card that raises them.
export const PROTECTED_CATEGORIES = Object.freeze({
  DOWNLOAD: "download",
  FILE_WRITE: "file-write",
  CREDENTIALS: "credentials",
  PERMISSION_GRANT: "permission-grant"
});

// Action classes a per-site entry may cover. Protected is deliberately
// absent: no entry is ever created or consulted for it.
export const REMEMBERABLE_CLASSES = Object.freeze([
  ACTION_CLASSES.MUTATING,
  ACTION_CLASSES.SEND
]);

const KNOWN_TOOL_NAMES = new Set(TOOLS.map((t) => t.name));

// input[type] values that carry secrets, plus autocomplete tokens the
// platform defines for credentials and payment details. Matched against the
// classifier-level element hint (tagName/attributes), never against typed
// text — the runtime must not sniff what the user types to decide.
const SECRET_INPUT_TYPES = new Set(["password"]);
const SECRET_AUTOCOMPLETE = new Set([
  "current-password",
  "new-password",
  "cc-number",
  "cc-exp",
  "cc-exp-month",
  "cc-exp-year",
  "cc-csc",
  "cc-cvc",
  "cc-type"
]);
const SECRET_NAME_PATTERN = /(passw(or)?d|passwd|pwd|credential|card-?num|cc-num|cvv|cvc|ssn|social-security)/i;

// Binary extensions whose links the classifier treats as downloads when the
// target hint shows them. Documents (pdf/docx/...) are excluded: clicking
// one usually navigates rather than downloads, and a wrong guess here would
// nag on ordinary reading.
const DOWNLOAD_EXTENSION_PATTERN = /\.(exe|msi|dmg|pkg|apk|zip|rar|7z|tar|gz|bz2|iso|deb|rpm)(\?|#|$)/i;

// javascript_tool sources that grant a browser capability on the page's
// behalf (task 2.3). Static patterns over source text, the same discipline
// as the existing submit-script detectors.
const PERMISSION_GRANT_PATTERNS = [
  /Notification\s*\.\s*requestPermission\s*\(/,
  /navigator\s*\.\s*mediaDevices\s*\.\s*getUserMedia\s*\(/,
  /navigator\s*\.\s*mediaDevices\s*\.\s*getDisplayMedia\s*\(/,
  /navigator\s*\.\s*(bluetooth|usb|serial|hid)\s*\.\s*request(Device|Port)?\s*\(/
];

function hintIsSecretField(targetHint) {
  if (!targetHint || typeof targetHint !== "object") return false;
  const attrs = targetHint.attributes || {};
  const tag = String(targetHint.tagName || "").toLowerCase();
  if (tag !== "input" && tag !== "textarea") return false;
  const type = String(attrs.type || "").toLowerCase();
  if (SECRET_INPUT_TYPES.has(type)) return true;
  const autocomplete = String(attrs.autocomplete || "").toLowerCase();
  if (SECRET_AUTOCOMPLETE.has(autocomplete)) return true;
  const name = `${attrs.name || ""} ${attrs.id || ""}`;
  return SECRET_NAME_PATTERN.test(name);
}

function hintIsDownloadLink(targetHint, args = {}) {
  if (!targetHint || typeof targetHint !== "object") return false;
  const attrs = targetHint.attributes || {};
  if (attrs.download !== undefined && attrs.download !== null) return true;
  const href = String(attrs.href || "");
  if (href && DOWNLOAD_EXTENSION_PATTERN.test(href)) return true;
  // The model's own description saying "download" is weaker evidence than
  // the element, but a click the bridge never resolved carries no hint at
  // all — description is all there is. Kept narrow: whole-word match only.
  void args;
  return false;
}

function jsRequestsPermission(source) {
  if (typeof source !== "string" || !source) return false;
  return PERMISSION_GRANT_PATTERNS.some((re) => re.test(source));
}

// The single source of truth for "this tool's identical name can, under some
// argument shape, produce a protected call" — every branch inside
// detectProtectedCategory below keys on one of these names, and the guard at
// the top of that function refuses to look past this list. Consumers that
// need a coarse, per-tool-name (not per-call) answer to "must this tool never
// be silently preapproved" — the PreToolUse gate in
// host/agent/policy/can-use-tool.js's createPermissionModeGateHook, and this
// module's own regression coverage — read this constant directly rather than
// hand-maintaining a second list that could drift from the branches below:
// adding a new protected branch for a tool not listed here would leave the
// guard rejecting it before the new branch is ever reached, which fails
// loudly (the category never fires) instead of silently drifting.
export const PROTECTED_CAPABLE_TOOLS = Object.freeze(["computer", "form_input", "gif_creator", "javascript_tool"]);

/**
 * Detect the protected category for one call, or null when it is not
 * protected. Runs BEFORE send/submit classification: a protected call is
 * never also reported as send-class.
 *
 * @returns {string|null} a PROTECTED_CATEGORIES value or null
 */
export function detectProtectedCategory(legacyToolName, args = {}, targetHint = null) {
  if (!PROTECTED_CAPABLE_TOOLS.includes(legacyToolName)) return null;
  // Credential or payment-detail entry: typing or keying into a secret
  // field, or setting one through form_input with a resolving hint.
  if (legacyToolName === "computer" && (normalizeComputerAction(args?.action) === "type" || normalizeComputerAction(args?.action) === "key")) {
    if (hintIsSecretField(targetHint)) return PROTECTED_CATEGORIES.CREDENTIALS;
  }
  if (legacyToolName === "form_input") {
    if (hintIsSecretField(targetHint)) return PROTECTED_CATEGORIES.CREDENTIALS;
  }
  // An agent-caused download: a click-class press on a download link.
  if (legacyToolName === "computer") {
    const action = normalizeComputerAction(args?.action);
    if (action === "left_click" || action === "double_click" || action === "triple_click") {
      if (hintIsDownloadLink(targetHint, args)) return PROTECTED_CATEGORIES.DOWNLOAD;
    }
    // A screenshot the caller asks to persist is a file written to disk.
    if (action === "screenshot" && args?.save_to_disk === true) return PROTECTED_CATEGORIES.FILE_WRITE;
  }
  // A GIF export the caller asks to persist.
  if (legacyToolName === "gif_creator" && args?.action === "export" && args?.download === true) {
    return PROTECTED_CATEGORIES.FILE_WRITE;
  }
  // Granting a browser capability from page script.
  if (legacyToolName === "javascript_tool") {
    if (jsRequestsPermission(getJavaScriptSource(args))) return PROTECTED_CATEGORIES.PERMISSION_GRANT;
  }
  return null;
}

/**
 * Assign every call to exactly one action class. Unclassifiable actions —
 * unknown tools, unknown computer actions, registry entries with no
 * classification coverage — resolve to protected with a gap report, never
 * to a permissive class (task 1.2).
 *
 * @returns {{ class: string, protectedCategory: string|null, gap: string|null,
 *   sendVerdict: object|null }}
 */
export function classifyActionClass(legacyToolName, args = {}, targetHint = null) {
  if (typeof legacyToolName !== "string" || !KNOWN_TOOL_NAMES.has(legacyToolName)) {
    return {
      class: ACTION_CLASSES.PROTECTED,
      protectedCategory: null,
      gap: `no classification entry for tool "${String(legacyToolName)}"`,
      sendVerdict: null
    };
  }
  if (legacyToolName === "computer" && !REGISTERED_COMPUTER_ACTIONS.includes(normalizeComputerAction(args?.action))) {
    return {
      class: ACTION_CLASSES.PROTECTED,
      protectedCategory: null,
      gap: `no classification entry for computer action "${String(args?.action)}"`,
      sendVerdict: null
    };
  }
  const { readOnly, mutating } = _mutationClassificationCoverage();
  if (!readOnly.has(legacyToolName) && !mutating.has(legacyToolName) && legacyToolName !== "computer") {
    return {
      class: ACTION_CLASSES.PROTECTED,
      protectedCategory: null,
      gap: `no classification entry for tool "${legacyToolName}"`,
      sendVerdict: null
    };
  }
  const protectedCategory = detectProtectedCategory(legacyToolName, args, targetHint);
  if (protectedCategory) {
    return { class: ACTION_CLASSES.PROTECTED, protectedCategory, gap: null, sendVerdict: null };
  }
  const sendVerdict = classifySendClassCall(legacyToolName, args, targetHint);
  if (sendVerdict.verdict === "approve-known" || sendVerdict.verdict === "approve-unknown") {
    return { class: ACTION_CLASSES.SEND, protectedCategory: null, gap: null, sendVerdict };
  }
  if (isMutatingCall(legacyToolName, args)) {
    return { class: ACTION_CLASSES.MUTATING, protectedCategory: null, gap: null, sendVerdict };
  }
  return { class: ACTION_CLASSES.READ_ONLY, protectedCategory: null, gap: null, sendVerdict };
}

export function normalizeMode(mode) {
  const m = String(mode || "").toLowerCase();
  if (PERMISSION_MODES.includes(m)) return m;
  return DEFAULT_MODE;
}

/**
 * The mode resolver: pure function from (class, mode, per-site match,
 * managed policy) to a decision requirement. Fixed one-directional order —
 * protected, then managed, then per-site store, then mode — where no later
 * stage can remove a requirement an earlier stage imposed (design decision 2
 * / task 1.3).
 *
 * @param {object} input
 * @param {string} input.actionClass - an ACTION_CLASSES value
 * @param {string} [input.protectedCategory]
 * @param {string} [input.mode] - active mode (managed pin applied by caller or passed via managed)
 * @param {{decision:"allow"|"deny",source:"local"|"managed"}|null} [input.siteMatch]
 * @param {object|null} [input.managed] - validated managed policy or null
 * @returns {{requiresDecision:boolean, outcome:"proceed"|"decide"|"refuse",
 *   reason:string, rememberable:boolean}}
 */
export function resolveModeDecision({ actionClass, protectedCategory = null, mode = DEFAULT_MODE, siteMatch = null, managed = null } = {}) {
  const resolvedMode = normalizeMode(mode);
  // Protected: always a fresh decision, never rememberable, never covered
  // by any grant. Managed policy cannot remove this (decision 2).
  if (actionClass === ACTION_CLASSES.PROTECTED) {
    return {
      requiresDecision: true,
      outcome: "decide",
      reason: protectedCategory ? `protected:${protectedCategory}` : "protected:unclassified",
      rememberable: false
    };
  }
  // Managed site entries behave like remembered decisions with a managed
  // source; a managed mode pin selects the mode below. Anything malformed
  // never reaches here — validateManagedPolicy() filters it first.
  const match = siteMatch && (siteMatch.decision === "allow" || siteMatch.decision === "deny") ? siteMatch : null;
  if (match) {
    if (match.decision === "deny") {
      return {
        requiresDecision: false,
        outcome: "refuse",
        reason: match.source === "managed" ? "managed-site-deny" : "remembered-deny",
        rememberable: false
      };
    }
    return {
      requiresDecision: false,
      outcome: "proceed",
      reason: match.source === "managed" ? "managed-site-allow" : "remembered-allow",
      rememberable: false
    };
  }
  if (actionClass === ACTION_CLASSES.READ_ONLY) {
    return { requiresDecision: false, outcome: "proceed", reason: "readonly", rememberable: false };
  }
  if (resolvedMode === "manual") {
    return { requiresDecision: true, outcome: "decide", reason: "manual-mode-mutating", rememberable: true };
  }
  if (resolvedMode === "skip") {
    return { requiresDecision: false, outcome: "proceed", reason: "skip-mode", rememberable: false };
  }
  // Auto: send/submit-class asks, other mutating calls proceed — today's
  // behavior, entry by entry.
  if (actionClass === ACTION_CLASSES.SEND) {
    return { requiresDecision: true, outcome: "decide", reason: "auto-mode-send-class", rememberable: true };
  }
  return { requiresDecision: false, outcome: "proceed", reason: "auto-mode-mutating", rememberable: false };
}

/**
 * Validate an administrator-managed policy snapshot. Malformed input is
 * reported (never silently treated as absent): the caller falls back to
 * local settings and surfaces the errors.
 *
 * Shape: { mode?: "manual"|"auto"|"skip",
 *   requireProtectedConfirm?: boolean,
 *   sites?: [{ origin, actionClass, decision: "allow"|"deny" }] }
 */
export function validateManagedPolicy(snapshot) {
  const errors = [];
  if (snapshot === null || snapshot === undefined) return { ok: true, policy: null, errors };
  if (typeof snapshot !== "object" || Array.isArray(snapshot)) {
    return { ok: false, policy: null, errors: ["managed policy must be an object"] };
  }
  const policy = {};
  if (snapshot.mode !== undefined) {
    const m = String(snapshot.mode).toLowerCase();
    if (!PERMISSION_MODES.includes(m)) errors.push(`managed policy mode "${snapshot.mode}" is not manual/auto/skip`);
    else policy.mode = m;
  }
  if (snapshot.requireProtectedConfirm !== undefined) {
    if (typeof snapshot.requireProtectedConfirm !== "boolean") {
      errors.push("managed policy requireProtectedConfirm must be a boolean");
    } else policy.requireProtectedConfirm = snapshot.requireProtectedConfirm;
  }
  if (snapshot.sites !== undefined) {
    if (!Array.isArray(snapshot.sites)) {
      errors.push("managed policy sites must be an array");
    } else {
      policy.sites = [];
      snapshot.sites.forEach((s, k) => {
        if (!s || typeof s !== "object") {
          errors.push(`managed policy sites[${k}] must be an object`);
          return;
        }
        let origin = null;
        try {
          const u = new URL(String(s.origin || ""));
          if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("bad protocol");
          origin = u.origin;
        } catch {
          errors.push(`managed policy sites[${k}] has an invalid origin`);
          return;
        }
        if (!REMEMBERABLE_CLASSES.includes(s.actionClass)) {
          errors.push(`managed policy sites[${k}] has an invalid action class (protected actions are never storable)`);
          return;
        }
        if (s.decision !== "allow" && s.decision !== "deny") {
          errors.push(`managed policy sites[${k}] decision must be allow or deny`);
          return;
        }
        policy.sites.push({ origin, actionClass: s.actionClass, decision: s.decision });
      });
    }
  }
  if (errors.length) return { ok: false, policy: null, errors };
  if (!Object.keys(policy).length) return { ok: true, policy: null, errors };
  return { ok: true, policy, errors };
}

/**
 * Derive the matchable origin for per-site decisions from run-level
 * evidence. Prefers the bound document's URL; falls back to nothing (never
 * a guessed scheme), in which case no remembered entry applies and the mode
 * decides — a grant must never cover a site the runtime cannot name.
 */
export function originFromContext(context = {}) {
  const url = context && context.docIdentity && context.docIdentity.url;
  if (typeof url === "string" && url) {
    try {
      return new URL(url).origin;
    } catch {
      return null;
    }
  }
  return null;
}
