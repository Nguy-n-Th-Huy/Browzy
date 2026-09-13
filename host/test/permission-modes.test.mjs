// Unit tests for host/agent/policy/permission-modes.js: action
// classification, protected detection, the mode resolver, and managed policy
// validation. Pure functions only — no SDK run, no browser.
import { TOOLS } from "../tool-definitions.js";
import {
  isMutatingCall,
  classifySendClassCall
} from "../agent/tools/mapping.js";
import {
  PERMISSION_MODES,
  DEFAULT_MODE,
  ACTION_CLASSES,
  PROTECTED_CATEGORIES,
  classifyActionClass,
  detectProtectedCategory,
  normalizeMode,
  resolveModeDecision,
  validateManagedPolicy
} from "../agent/policy/permission-modes.js";

let fail = 0;
const ok = (c, m) => { console.log((c ? "  PASS " : "  FAIL ") + m); if (!c) fail++; };

console.log("== classification coverage: every registry tool classifies ==");
{
  const gaps = [];
  // Canonical args per tool: a call missing required fields is
  // unclassifiable by construction (tested separately below), so coverage
  // is measured on well-formed calls.
  const canonicalArgs = { computer: { action: "screenshot" } };
  for (const t of TOOLS) {
    const r = classifyActionClass(t.name, canonicalArgs[t.name] || {}, null);
    if (r.gap) gaps.push(`${t.name}: ${r.gap}`);
  }
  ok(gaps.length === 0, gaps.length ? `classification gaps: ${gaps.join("; ")}` : `all ${TOOLS.length} registry tools classify with no gap`);
  const unknown = classifyActionClass("no_such_tool", {}, null);
  ok(
    unknown.class === ACTION_CLASSES.PROTECTED && typeof unknown.gap === "string" && unknown.gap.includes("no_such_tool"),
    "an unknown tool resolves to protected with a gap naming it"
  );
  const badAction = classifyActionClass("computer", { action: "teleport" }, null);
  ok(
    badAction.class === ACTION_CLASSES.PROTECTED && typeof badAction.gap === "string" && badAction.gap.includes("teleport"),
    "an unknown computer action resolves to protected with a gap naming it"
  );
  const bareAction = classifyActionClass("computer", {}, null);
  ok(
    bareAction.class === ACTION_CLASSES.PROTECTED && typeof bareAction.gap === "string",
    "a computer call with no action fails closed to protected"
  );
}
{
  const mismatches = [];
  for (const t of TOOLS) {
    const cls = classifyActionClass(t.name, {}, null);
    const dec = resolveModeDecision({ actionClass: cls.class, protectedCategory: cls.protectedCategory, mode: "auto" });
    const sendToday = classifySendClassCall(t.name, {}, null);
    const expectDecision =
      sendToday.verdict === "approve-known" || sendToday.verdict === "approve-unknown" || cls.class === ACTION_CLASSES.PROTECTED;
    if (dec.requiresDecision !== expectDecision) {
      mismatches.push(`${t.name}: resolver requiresDecision=${dec.requiresDecision} expected=${expectDecision}`);
    }
  }
  ok(mismatches.length === 0, mismatches.length ? `Auto drift: ${mismatches.join("; ")}` : "Auto column matches the pre-change gate for every entry");
}

console.log("== mode semantics ==");
{
  const mut = { actionClass: ACTION_CLASSES.MUTATING, mode: "manual" };
  ok(resolveModeDecision(mut).outcome === "decide", "Manual asks about ordinary mutating actions");
  ok(
    resolveModeDecision({ actionClass: ACTION_CLASSES.MUTATING, mode: "auto" }).outcome === "proceed",
    "Auto proceeds on non-send mutating actions"
  );
  ok(
    resolveModeDecision({ actionClass: ACTION_CLASSES.SEND, mode: "skip" }).outcome === "proceed",
    "Skip proceeds on send-class outside protected actions"
  );
  ok(
    resolveModeDecision({ actionClass: ACTION_CLASSES.READ_ONLY, mode: "manual" }).outcome === "proceed",
    "read-only actions never gate under any mode"
  );
  ok(
    resolveModeDecision({ actionClass: ACTION_CLASSES.PROTECTED, protectedCategory: "download", mode: "skip" }).outcome === "decide",
    "protected actions decide even under Skip"
  );
  ok(normalizeMode("MANUAL") === "manual" && normalizeMode("bogus") === DEFAULT_MODE, "mode parsing is case-insensitive with an Auto fallback");
  ok(PERMISSION_MODES.length === 3 && DEFAULT_MODE === "auto", "exactly three modes, Auto default");
}

console.log("== protected detection ==");
{
  const pwHint = { tagName: "input", attributes: { type: "password", name: "passwd" } };
  ok(
    detectProtectedCategory("computer", { action: "type", text: "x" }, pwHint) === PROTECTED_CATEGORIES.CREDENTIALS,
    "typing into a password field is credentials-protected"
  );
  ok(
    detectProtectedCategory("form_input", { ref: "ref_1" }, pwHint) === PROTECTED_CATEGORIES.CREDENTIALS,
    "form_input to a password field is credentials-protected"
  );
  ok(
    detectProtectedCategory("computer", { action: "type", text: "hello" }, { tagName: "input", attributes: { type: "text" } }) === null,
    "typing into a plain field is not protected"
  );
  const dlHint = { tagName: "a", attributes: { download: "", href: "https://x.test/f/setup.exe" } };
  ok(
    detectProtectedCategory("computer", { action: "left_click", coordinate: [1, 2] }, dlHint) === PROTECTED_CATEGORIES.DOWNLOAD,
    "clicking a download link is download-protected"
  );
  ok(
    detectProtectedCategory("computer", { action: "screenshot", save_to_disk: true }, null) === PROTECTED_CATEGORIES.FILE_WRITE,
    "persisting a screenshot is file-write-protected"
  );
  ok(
    detectProtectedCategory("gif_creator", { action: "export", download: true }, null) === PROTECTED_CATEGORIES.FILE_WRITE,
    "persisting a GIF export is file-write-protected"
  );
  ok(
    detectProtectedCategory("gif_creator", { action: "export" }, null) === null,
    "a non-persisted export is not protected"
  );
  ok(
    detectProtectedCategory("javascript_tool", { action: "javascript_exec", text: "Notification.requestPermission()" }, null) ===
      PROTECTED_CATEGORIES.PERMISSION_GRANT,
    "permission-granting script is protected"
  );
}

console.log("== resolver order: protected, managed, store, mode ==");
{
  // A remembered allowance never covers a protected action.
  const r = resolveModeDecision({
    actionClass: ACTION_CLASSES.PROTECTED,
    protectedCategory: "download",
    mode: "skip",
    siteMatch: { decision: "allow", source: "local" }
  });
  ok(r.outcome === "decide" && r.rememberable === false, "remembered grant ignored for protected actions");
  // Remembered decisions resolve without asking.
  ok(
    resolveModeDecision({ actionClass: "mutating", mode: "manual", siteMatch: { decision: "allow", source: "local" } }).outcome === "proceed",
    "remembered allowance proceeds"
  );
  const denied = resolveModeDecision({ actionClass: "mutating", mode: "manual", siteMatch: { decision: "deny", source: "local" } });
  ok(denied.outcome === "refuse", "remembered denial refuses without asking");
  const managed = resolveModeDecision({ actionClass: "mutating", mode: "manual", siteMatch: { decision: "allow", source: "managed" } });
  ok(managed.outcome === "proceed" && managed.reason === "managed-site-allow", "managed entries resolve with a managed reason");
}

console.log("== managed policy validation ==");
{
  ok(validateManagedPolicy(null).ok === true, "absent policy validates");
  ok(validateManagedPolicy({ mode: "manual" }).policy.mode === "manual", "mode pin validates");
  const bad = validateManagedPolicy({ mode: "turbo" });
  ok(bad.ok === false && bad.errors.length > 0, "unknown mode is reported, not absorbed");
  const badSite = validateManagedPolicy({ sites: [{ origin: "not a url", actionClass: "mutating", decision: "allow" }] });
  ok(badSite.ok === false, "invalid site origin is reported");
  const protSite = validateManagedPolicy({ sites: [{ origin: "https://x.test", actionClass: "protected", decision: "allow" }] });
  ok(protSite.ok === false, "protected actions are never storable, including by administrators");
  const good = validateManagedPolicy({
    mode: "skip",
    requireProtectedConfirm: true,
    sites: [{ origin: "https://x.test/", actionClass: "mutating", decision: "deny" }]
  });
  ok(
    good.ok === true && good.policy.sites[0].origin === "https://x.test" && good.policy.requireProtectedConfirm === true,
    "a well-formed policy validates with a normalized origin"
  );
  void isMutatingCall;
}

console.log(fail === 0 ? "\nALL PERMISSION MODES TESTS PASSED" : `\n${fail} FAILED`);
process.exit(fail ? 1 : 0);
