// Pure, DOM-free display copy + view-model shaping for injection findings
// and per-tab risk categories (openspec/changes/add-permission-modes-and-
// threat-signals, tasks 7.4-7.6). Mirrors extension/ui/permission-labels.js's
// own convention: no chrome.*/document reference anywhere in this file, so
// every export is unit-testable exactly like conversation-model.js already
// is, and shared between whatever surfaces need to render these identically.
//
// SECURITY-CRITICAL SPLIT (task 7.5 — read before touching this file):
// `matchedText` (on an `injection_finding` event, and on an
// `injection_finding`-kind signal inside a `tab_risk_update`) is LITERALLY
// WHAT A WEB PAGE SAID. Every such value is returned here verbatim, under a
// `quoted*`-prefixed key, and NEVER combined into a title/label string this
// module builds. Callers MUST render every `quoted*` field as inert text —
// escape-and-insert into an HTML string (e.g. escapeHtml()) or assign via
// `.textContent` — and MUST NEVER run it through a markdown renderer or any
// other formatter that could turn its own content into a link, bold text, or
// anything else with power. By contrast, every OTHER field this module
// returns (titles, category labels, a signal's own `label`) is host- or
// panel-authored copy and is safe to render directly — see
// reports/wave2h-events.md's own note that `signals[].label` is
// "host-authored, not page content".

export const RISK_CATEGORIES = Object.freeze(["uncategorized", "low", "elevated"]);

const RISK_CATEGORY_LABELS = {
  uncategorized: "Chưa phân loại",
  low: "Rủi ro thấp",
  elevated: "Rủi ro cao"
};

/** @param {string} category */
export function riskCategoryLabel(category) {
  return RISK_CATEGORY_LABELS[category] || RISK_CATEGORY_LABELS.uncategorized;
}

function mapSignal(s) {
  return {
    kind: s.kind,
    severity: s.severity,
    // Host-authored — safe to render directly (see file header).
    label: s.label,
    // QUOTED DATA when present (only ever populated on an
    // "injection_finding"-kind signal) — same rule as every other
    // quoted* field in this module.
    quotedText: s.matchedText != null ? String(s.matchedText) : null
  };
}

/**
 * View model for one turn-anchored warning — `injection_finding`,
 * `injection_probe_failed`, or `tab_risk_update` (tasks 7.4/7.5). The
 * returned shape carries NO allow/deny/decision field of any kind: a warning
 * is never a decision, and this function's whole job is to prove that by
 * construction rather than by convention.
 * @param {{kind:string, tool?:string, tabId?:number|null, field?:string,
 *   patternId?:string, matchedText?:string, error?:string, category?:string,
 *   signals?:Array<object>, ts?:number}} warning
 */
export function viewWarning(warning) {
  const base = { key: warning.key, kind: warning.kind, tabId: warning.tabId != null ? warning.tabId : null, ts: warning.ts || null };
  if (warning.kind === "injection_probe_failed") {
    return {
      ...base,
      title: "Không quét được nội dung trang để tìm chỉ dẫn ẩn",
      toolLabel: warning.tool || null,
      // Diagnostic string, not user-facing copy (reports/wave2h-events.md) —
      // still treated as inert/quoted since it can echo tool-side detail.
      quotedDetail: warning.error != null ? String(warning.error) : ""
    };
  }
  if (warning.kind === "tab_risk_update") {
    return {
      ...base,
      title: `Mức rủi ro của tab: ${riskCategoryLabel(warning.category)}`,
      category: warning.category,
      isElevated: warning.category === "elevated",
      signals: (warning.signals || []).map(mapSignal)
    };
  }
  // injection_finding
  return {
    ...base,
    title: `Phát hiện nội dung có thể chứa chỉ dẫn nhắm vào trợ lý${warning.tool ? ` (từ ${warning.tool})` : ""}`,
    toolLabel: warning.tool || null,
    // QUOTED DATA — see file header. Never rendered as HTML/markdown/a link.
    quotedText: warning.matchedText != null ? String(warning.matchedText) : ""
  };
}

/**
 * View model for the risk-context block shown ON a decision card (task 7.6)
 * — context only, never a control of its own. Returns `null` when there is
 * nothing worth showing, which per spec ("Risk context on a decision card")
 * is exactly when the tab's CURRENT category is not elevated — an
 * `injection_finding` always drives its tab's category to "elevated" (see
 * reports/wave2h-events.md), so this one condition also covers "the tab has
 * a live finding" without duplicating that check.
 * @param {{category:string, signals:Array<object>}|null|undefined} entry
 */
export function viewRiskContext(entry) {
  if (!entry || entry.category !== "elevated") return null;
  return {
    category: entry.category,
    categoryLabel: riskCategoryLabel(entry.category),
    signals: (entry.signals || []).map(mapSignal)
  };
}
