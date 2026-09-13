// The history screen's privacy and retention controls: the switch that stops
// the local cache from keeping what the operator asked, and the line that
// reports what bounded retention did to that cache
// (openspec/changes/optimize-chat-history tasks.md 2.2; spec
// chat-history-storage "Privacy control" and "Bounded retention" — "...and
// the user can see the outcome").
//
// WHY A MODULE. The enforcement already lives in history-store.js (the single
// write point, `recordPrompt()`, plus retention and `evictionReport()`), and
// sidepanel.js is DOM wiring with no importable surface — the same reason
// history-view.js and history-export.js exist. What was missing was exactly
// the user-reachable half: the store APIs were real and tested, but nothing
// shipped ever called `setRawPromptCachingEnabled` or read
// `evictionReport()`, so no operator could turn raw-prompt caching off and no
// retention outcome was ever shown.
//
// NO STATE OF ITS OWN. The switch reads and writes the store's persisted
// policy, and the outcome line renders the store's eviction report. A change
// made in another panel reaches this one through the store's own storage
// watcher, and `sync()` re-reads it, so two panels cannot show two different
// privacy settings.

import { EVICTION_OUTCOME } from "./history-store.js";

/**
 * The outcome line's text for what retention has done lately. Counts rather
 * than conversation ids: the affected rows are on the screen right behind the
 * line, and an id would not mean anything to a reader. Empty string when
 * nothing has been evicted — the common case, where the line stays hidden and
 * the screen does not announce a non-event.
 *
 * @param {Array<{conversationId: string, outcome: string, at: number}>} report
 *   from `HistoryStore#evictionReport()` (newest first).
 */
export function retentionSummaryText(report) {
  const list = Array.isArray(report) ? report.filter((entry) => entry && entry.outcome) : [];
  if (!list.length) return "";
  const archived = list.filter((entry) => entry.outcome === EVICTION_OUTCOME.ARCHIVED).length;
  const removed = list.length - archived;
  const kinds = [];
  if (archived) kinds.push(`lưu trữ ${archived}`);
  if (removed) kinds.push(`xóa ${removed}`);
  return `Bản lưu cục bộ đã tự ${kinds.join(" và ")} cuộc trò chuyện cũ để giữ trong giới hạn; hội thoại vẫn còn trên máy chủ companion.`;
}

/**
 * Binds the history screen's privacy switch and retention outcome line to a
 * HistoryStore.
 *
 * @param {object} deps
 * @param {object} deps.store - the panel's HistoryStore; the only authority
 *   for the policy and for what retention did
 * @param {Element} [deps.toggle] - the `<input type="checkbox">` switch
 * @param {Element} [deps.outcome] - the line that shows the retention outcome
 */
export class HistoryPrivacyControls {
  constructor({ store, toggle = null, outcome = null } = {}) {
    if (!store || typeof store.setRawPromptCachingEnabled !== "function" || typeof store.evictionReport !== "function") {
      throw new Error("HistoryPrivacyControls: a HistoryStore is required");
    }
    this._store = store;
    this._toggle = toggle;
    this._outcome = outcome;
    this._applying = false;
    this._onToggleEvent = () => {
      this._apply(this._toggle.checked === true).catch(() => {
        /* the store's own write path is best-effort; a failed policy write
           must not leave the switch stuck in its busy state */
      });
    };
    if (this._toggle) this._toggle.addEventListener("change", this._onToggleEvent);
    // The outcome line follows retention wherever it runs — this panel's
    // policy change, another panel's, or any flush that crossed a limit.
    this._unsubscribe =
      typeof store.onChange === "function"
        ? store.onChange((event) => {
            if (event && event.type === "retention") this.renderOutcome();
          })
        : null;
  }

  /**
   * Adopt the persisted policy into the switch and re-render the outcome.
   * Called whenever the history screen is (re)built: the policy is read after
   * the store's first load, and the flush runs any retention this session has
   * not applied yet, so the line reports this cache rather than a stale
   * nothing.
   */
  async sync() {
    const policy = await this._store.effectivePolicy();
    this._renderToggle(policy.rawPromptCaching === true);
    await this._store.flushNow();
    this.renderOutcome();
  }

  /** The retention outcome, as the operator sees it: one line, hidden when
   * retention has evicted nothing. */
  renderOutcome() {
    if (!this._outcome) return;
    const text = retentionSummaryText(this._store.evictionReport());
    this._outcome.textContent = text;
    this._outcome.hidden = !text;
  }

  /** Detach every listener this control installed (panel teardown). */
  destroy() {
    if (this._toggle) this._toggle.removeEventListener("change", this._onToggleEvent);
    if (this._unsubscribe) this._unsubscribe();
    this._unsubscribe = null;
  }

  /**
   * The switch is a NEGATIVE control ("do not keep my prompts"), so it is
   * checked when raw-prompt caching is disabled — the opposite of the stored
   * `rawPromptCaching` flag. Keeping the inversion in one place means the
   * checkbox, the policy and the copy can never disagree.
   */
  _renderToggle(cachingEnabled) {
    if (!this._toggle) return;
    this._toggle.checked = cachingEnabled !== true;
  }

  /** One press of the switch: the store drops every cached preview when
   * caching is turned off (history-store.js), persists the policy, and
   * notifies — which is what re-renders the history list and this outcome
   * line. Disabled while in flight so a second press cannot interleave two
   * policy writes. */
  async _apply(disabled) {
    if (this._applying) return;
    this._applying = true;
    if (this._toggle) this._toggle.disabled = true;
    try {
      const policy = await this._store.setRawPromptCachingEnabled(disabled !== true);
      this._renderToggle(policy.rawPromptCaching === true);
      this.renderOutcome();
    } finally {
      this._applying = false;
      if (this._toggle) this._toggle.disabled = false;
    }
  }
}
