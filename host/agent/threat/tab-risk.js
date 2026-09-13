// Per-tab risk category: an advisory-only summary of what a controlled tab
// appears to be for, derived from observable signals, recomputed when the
// tab's document identity changes.
//
// design.md decision 6: "The category warns only ... the permission policy
// never reads it as an input to whether a decision is required. Keeping it
// out of the policy's inputs is what makes 'warns, never blocks' checkable
// rather than a claim." Nothing in this module is imported by
// host/agent/policy/can-use-tool.js or permission-modes.js, and it never
// will be — that is the property tasks.md 6.5 tests for.
//
// Document identity here reuses the same minimal shape the approval binding
// already tracks (host/agent/policy/approvals.js's `docIdentity: { tabId,
// url }`, and companion.js's own comment on it): a tab id plus its most
// recently observed URL. This module does not invent a second notion of
// "the page changed" — a document is considered replaced exactly when
// either (a) the `navigate` tool targets the tab (an explicit, unambiguous
// reset point — even a same-URL reload is a new document), or (b) a later
// observation reports a different URL for a tab whose URL was already known
// (an in-page navigation not made through the `navigate` tool, e.g. a
// clicked link). Learning a tab's URL for the first time is not a
// replacement — there is no prior document to have replaced.

export const TAB_RISK_CATEGORY = Object.freeze({
  // No signal has ever been observed for this tab (or its most recent
  // document). Distinguishable from LOW: this tab has not been looked at,
  // rather than looked at and found unremarkable (spec "Insufficient
  // signals").
  UNCATEGORIZED: "uncategorized",
  // At least one signal was observed and none of them were elevated.
  LOW: "low",
  // At least one elevated signal (a credential/payment content match, or an
  // injection finding — spec "An injection finding raises the tab's risk")
  // was observed for the current document.
  ELEVATED: "elevated"
});

// Bound how many contributing signals one tab's state keeps, so a long-lived
// tab in a long-running conversation cannot grow this without limit. The
// most recent signals are the ones worth inspecting; older ones age out.
const MAX_SIGNALS_PER_TAB = 50;

function computeCategory(signals) {
  if (signals.length === 0) return TAB_RISK_CATEGORY.UNCATEGORIZED;
  return signals.some((s) => s.severity === "elevated") ? TAB_RISK_CATEGORY.ELEVATED : TAB_RISK_CATEGORY.LOW;
}

function publicState(state) {
  return { category: state.category, signals: state.signals.map((s) => ({ ...s })) };
}

export class TabRiskRegistry {
  constructor() {
    this._tabs = new Map(); // tabId -> { url: string|null, category, signals: [] }
  }

  _ensure(tabId) {
    let state = this._tabs.get(tabId);
    if (!state) {
      state = { url: null, category: TAB_RISK_CATEGORY.UNCATEGORIZED, signals: [] };
      this._tabs.set(tabId, state);
    }
    return state;
  }

  /**
   * Report an observation of a tab's document identity.
   *
   * @param {number} tabId
   * @param {string|null} url - the URL observed for this tab right now, or
   *   null if unknown (e.g. `navigate` was called with no URL argument
   *   captured, or the returning tool never reports one).
   * @param {object} [opts]
   * @param {boolean} [opts.forceReset] - true for an explicit, unambiguous
   *   reset point (the `navigate` tool targeting this tab). Always resets
   *   the category and contributing signals, even if the URL is unchanged
   *   (a reload is still a new document) or unknown.
   * @returns {{changed: boolean, state: {category: string, signals: Array}}}
   *   `changed` is true only when the PUBLIC category or signal list
   *   actually differs from before this call.
   */
  observeDocument(tabId, url = null, { forceReset = false } = {}) {
    if (typeof tabId !== "number") return { changed: false, state: publicState({ category: TAB_RISK_CATEGORY.UNCATEGORIZED, signals: [] }) };
    const state = this._ensure(tabId);
    const hadSignals = state.signals.length > 0;
    const previousCategory = state.category;

    const isPassiveReplacement =
      !forceReset && typeof url === "string" && url && state.url && url !== state.url;

    if (forceReset || isPassiveReplacement) {
      state.signals = [];
      state.category = TAB_RISK_CATEGORY.UNCATEGORIZED;
      if (typeof url === "string" && url) state.url = url;
    } else if (typeof url === "string" && url && !state.url) {
      // First time this tab's URL is known — not a replacement.
      state.url = url;
    }

    const changed = state.category !== previousCategory || (hadSignals && state.signals.length === 0);
    return { changed, state: publicState(state) };
  }

  /**
   * Record one observable, independent signal against a tab (an injection
   * finding, or a content-derived heuristic — see content-signals.js) and
   * recompute the category from the full current signal list.
   *
   * @returns {{changed: boolean, state: {category: string, signals: Array}}}
   */
  recordSignal(tabId, signal) {
    if (typeof tabId !== "number" || !signal || typeof signal !== "object") {
      return { changed: false, state: publicState({ category: TAB_RISK_CATEGORY.UNCATEGORIZED, signals: [] }) };
    }
    const state = this._ensure(tabId);
    const previousCategory = state.category;
    state.signals.push({ ...signal, ts: Date.now() });
    if (state.signals.length > MAX_SIGNALS_PER_TAB) state.signals.shift();
    state.category = computeCategory(state.signals);
    return { changed: state.category !== previousCategory, state: publicState(state) };
  }

  /** Current category + contributing signals for a tab (never mutates). */
  getState(tabId) {
    const state = this._tabs.get(tabId);
    return state ? publicState(state) : { category: TAB_RISK_CATEGORY.UNCATEGORIZED, signals: [] };
  }
}

// Convenience default instance for production wiring
// (host/agent/tools/adapter.js builds its own per-run instance instead — see
// that module — so this default exists only for callers, such as ad hoc
// scripts or tests, that have no run-scoped instance of their own).
export const defaultTabRiskRegistry = new TabRiskRegistry();
