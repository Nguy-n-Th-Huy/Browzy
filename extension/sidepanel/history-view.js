// The history screen's list: search, filters, grouping, paging/virtualization,
// row states and incremental DOM patching (openspec/changes/optimize-chat-history
// tasks.md 4.1-4.3, spec chat-history-browsing).
//
// WHAT LIVES HERE, AND WHY IT IS A MODULE. `sidepanel.js` is DOM wiring with
// no exports and no importable surface — everything worth proving about the
// history screen would otherwise be provable only by brace-match extraction
// (test/_extract.mjs) or by asserting on source text. The policy this file
// owns is exactly the part the specs make claims about:
//
//   * metadata search (title, prompt preview, hostname, conversation id) plus
//     a date range and a domain filter — LOCAL, after the host summaries are
//     already loaded, per design.md decision 4. Full-transcript search stays
//     the explicit opt-in operation that decision describes; it is
//     deliberately NOT implemented here (no half-wired transfer path).
//   * grouping (pinned, then today / yesterday / last 7 days / last 30 days /
//     older), so a long list is navigable without a single 1000-row scroll.
//   * paging: only the first `pageSize` entries are rendered; `loadMore()` /
//     `onScroll()` grow the window on demand (spec "Incremental rendering" —
//     "only the first visible page is rendered and additional entries load on
//     demand").
//   * incremental DOM updates: a keyed reconcile in `_patch()`. Rows that
//     stay visible keep their exact DOM node (and focus); only rows whose
//     displayed content changed are updated in place; only moved rows are
//     reordered; departed rows are removed. There is no `innerHTML = ""`
//     rebuild anywhere in this file — that is the wave-B fix for the
//     "rebuilds every row" symptom the proposal names.
//   * scroll preservation: `render()` restores the scroll offset it observed
//     before patching, so a live sync from another panel does not jump the
//     reader to the top (spec "Incremental rendering": "SHALL preserve scroll
//     position when new metadata arrives"). The paging scenario in
//     test/sidepanel-history-view.test.mjs installs the reflow simulation on
//     the container this patch mutates and asserts the offset was moved and
//     restored — it fails if this restore is removed.
//   * the distinct loading / empty / offline / error / no-match states
//     (task 4.3) as data (`deriveHistoryState`), with the DOM rendering of a
//     placeholder or a banner above cached rows.
//
// WHAT LIVES ELSEWHERE. Storage and retention: history-store.js. Host I/O
// (reconcile, delete, rename/pin/archive, transcript pages for export):
// panel-controller.js. Toolbar controls (search box, date inputs, domain
// select), per-action confirmations and downloads: sidepanel.js. This module
// never talks to `chrome.*`, never fetches, and never mutates an entry.
//
// TESTABILITY. The DOM is injected (`document` in the constructor) and every
// node this class creates is built with `createElement` + `textContent` +
// `setAttribute` + `addEventListener` — no `innerHTML` parsing and no
// `querySelector` — so test/sidepanel-history-view.test.mjs can drive the real
// class against a ~60-line fake document and assert element identity across
// renders, which is the property "incremental, not rebuilt" actually means.

import { iconMarkup } from "../ui/icons.js";

/** Debounce window for the search box. Long enough to swallow a fast typist's
 * keystrokes (one filter+render pass per pause, not per key), short enough
 * that the list feels immediate. */
export const HISTORY_SEARCH_DEBOUNCE_MS = 200;

/** Entries rendered before the operator asks for more. */
export const HISTORY_PAGE_SIZE = 25;

/** Largest query stored; a paste of a whole document must not become the
 * filter or the persisted UI state. */
export const HISTORY_QUERY_MAX_CHARS = 120;

/** How close to the bottom (px) the list must be for `onScroll()` to pull the
 * next page — "load more" without a dead zone that never triggers. */
export const HISTORY_SCROLL_THRESHOLD_PX = 120;

export const HISTORY_STATE = Object.freeze({
  LOADING: "loading",
  READY: "ready",
  EMPTY: "empty",
  OFFLINE: "offline",
  ERROR: "error",
  NO_MATCH: "no_match"
});

export const HISTORY_GROUP = Object.freeze({
  PINNED: "pinned",
  TODAY: "today",
  YESTERDAY: "yesterday",
  WEEK: "week",
  MONTH: "month",
  OLDER: "older"
});

const GROUP_ORDER = [
  HISTORY_GROUP.PINNED,
  HISTORY_GROUP.TODAY,
  HISTORY_GROUP.YESTERDAY,
  HISTORY_GROUP.WEEK,
  HISTORY_GROUP.MONTH,
  HISTORY_GROUP.OLDER
];

const GROUP_LABEL = Object.freeze({
  [HISTORY_GROUP.PINNED]: "Đã ghim",
  [HISTORY_GROUP.TODAY]: "Hôm nay",
  [HISTORY_GROUP.YESTERDAY]: "Hôm qua",
  [HISTORY_GROUP.WEEK]: "7 ngày qua",
  [HISTORY_GROUP.MONTH]: "30 ngày qua",
  [HISTORY_GROUP.OLDER]: "Cũ hơn"
});

const DAY_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------- primitives

/**
 * Trailing-edge debounce with the two controls the view needs: `cancel()` (a
 * newer keystroke discards a pending search — spec "Search and filters":
 * "stale queries are cancelled") and `flush()` (apply the pending call now,
 * used by Enter in the search box and by the tests).
 */
export function debounce(fn, delayMs) {
  let timer = null;
  let pending = null;
  const run = () => {
    timer = null;
    const args = pending;
    pending = null;
    if (args) fn(...args);
  };
  const debounced = (...args) => {
    pending = args;
    clearTimeout(timer);
    timer = setTimeout(run, delayMs);
  };
  debounced.cancel = () => {
    clearTimeout(timer);
    timer = null;
    pending = null;
  };
  debounced.flush = () => {
    if (!timer && !pending) return false;
    clearTimeout(timer);
    run();
    return true;
  };
  debounced.pending = () => pending != null;
  return debounced;
}

/** Local midnight of the day containing `ts`. Grouping and the date filter
 * both work in the operator's own local time — a conversation written at
 * 23:30 belongs to that day for the person reading it, not to the previous
 * UTC day. */
export function startOfDay(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** `value` → inclusive lower bound (start of day) or null when unusable.
 * Accepts a number (ms), a Date, or the `YYYY-MM-DD` string an
 * `<input type="date">` produces; anything else means "no bound", never
 * "everything is filtered out". */
export function parseDayStart(value) {
  const ts = toTimestamp(value);
  return ts == null ? null : startOfDay(ts);
}

/** `value` → inclusive upper bound (end of day) or null. */
export function parseDayEnd(value) {
  const ts = toTimestamp(value);
  return ts == null ? null : startOfDay(ts) + DAY_MS - 1;
}

function toTimestamp(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.getTime();
  if (typeof value !== "string" || !value.trim()) return null;
  const text = value.trim();
  // `new Date("2026-09-13")` parses as UTC midnight, which shifts the local
  // day for every timezone west of Greenwich — the exact off-by-one a date
  // filter must not have. Parse the calendar fields explicitly instead.
  const m = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) {
    const ts = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
    return Number.isFinite(ts) ? ts : null;
  }
  const ts = new Date(text).getTime();
  return Number.isFinite(ts) ? ts : null;
}

/** Case- and diacritic-insensitive form used for every text comparison, so
 * "lich su" finds "Lịch sử" (the panel's own language). */
export function foldText(value) {
  return String(value == null ? "" : value)
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
}

/** Everything a query may match against for one entry: title, every locally
 * cached prompt preview, hostname and the conversation id (spec "Search and
 * filters": "debounced search by title, prompt preview, hostname, and
 * conversation ID"). */
export function historySearchText(entry) {
  if (!entry) return "";
  const prompts = entry.prompts && typeof entry.prompts === "object" ? Object.values(entry.prompts) : [];
  return [entry.title, entry.hostname, entry.conversationId, ...prompts].filter(Boolean).join("\n");
}

/** Normalize a raw filter object (the toolbar's current values) into the shape
 * every predicate below expects. Never throws on missing/odd input. */
export function normalizeFilters(raw = {}) {
  const query = typeof raw.query === "string" ? raw.query.slice(0, HISTORY_QUERY_MAX_CHARS) : "";
  const domain = typeof raw.domain === "string" ? raw.domain.trim() : "";
  return {
    query,
    queryFold: foldText(query.trim()),
    from: parseDayStart(raw.from),
    to: parseDayEnd(raw.to),
    domain
  };
}

/** Whether one entry survives the current filters. */
export function matchesFilters(entry, filters = normalizeFilters()) {
  if (!entry) return false;
  if (filters.domain && entry.hostname !== filters.domain) return false;
  const ts = entry.updatedAt || entry.createdAt || 0;
  if (filters.from != null && ts < filters.from) return false;
  if (filters.to != null && ts > filters.to) return false;
  if (filters.queryFold) {
    // Substring match on the folded text: metadata search is a "find the row
    // I remember" tool, not a scoring engine.
    if (!foldText(historySearchText(entry)).includes(filters.queryFold)) return false;
  }
  return true;
}

export function filterConversations(entries, filters = normalizeFilters()) {
  return (Array.isArray(entries) ? entries : []).filter((entry) => matchesFilters(entry, filters));
}

/** Which date bucket one entry belongs to (pinned is handled separately, by
 * the caller that owns the pin flag). */
export function dayBucket(ts, now = Date.now()) {
  const today = startOfDay(now);
  const value = typeof ts === "number" && ts > 0 ? ts : 0;
  if (value >= today) return HISTORY_GROUP.TODAY;
  if (value >= today - DAY_MS) return HISTORY_GROUP.YESTERDAY;
  if (value >= today - 6 * DAY_MS) return HISTORY_GROUP.WEEK;
  if (value >= today - 29 * DAY_MS) return HISTORY_GROUP.MONTH;
  return HISTORY_GROUP.OLDER;
}

/**
 * Group already-filtered entries for rendering. Pinned entries form their own
 * first group (a pin exists to keep a conversation reachable, so it must not
 * be buried in a date bucket); everything else lands in its date bucket in the
 * order it arrived — history-store.js's `list()` already sorts pinned-first
 * then most-recently-active, and this function preserves that order inside
 * each group.
 *
 * @returns {Array<{key: string, label: string, entries: Array<object>}>}
 *   Only non-empty groups, in fixed display order.
 */
export function groupConversations(entries, { now = Date.now() } = {}) {
  const buckets = new Map(GROUP_ORDER.map((key) => [key, []]));
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry) continue;
    const key = entry.pinned ? HISTORY_GROUP.PINNED : dayBucket(entry.updatedAt || entry.createdAt, now);
    buckets.get(key).push(entry);
  }
  return GROUP_ORDER.filter((key) => buckets.get(key).length).map((key) => ({
    key,
    label: GROUP_LABEL[key],
    entries: buckets.get(key)
  }));
}

/** Human-readable message for every reason the history surface can fail with.
 * Single source of truth: the delete alert, the rename/pin/archive alert, the
 * export alert and the list's error state all read from here, so a failure can
 * never be described one way in one place and another way somewhere else. */
export function historyErrorText(reason) {
  const code = typeof reason === "string" ? reason : reason && reason.reason;
  if (code === "host_unavailable") return "không kết nối được tới máy chủ companion";
  if (code === "host_protocol_unsupported") return "máy chủ companion cần được cập nhật để hỗ trợ thao tác này";
  if (code === "unknown_conversation") return "máy chủ companion không còn cuộc trò chuyện này";
  if (code === "conversation_deleted") return "cuộc trò chuyện đã bị xóa";
  if (code === "revision_conflict") return "một bảng điều khiển khác vừa thay đổi cuộc trò chuyện này — hãy tải lại danh sách";
  if (code === "empty_conversation_update") return "không có thay đổi nào để lưu";
  if (code === "malformed_conversation_title") return "tên cuộc trò chuyện không hợp lệ";
  if (code === "conversation_title_too_long") return "tên cuộc trò chuyện quá dài";
  if (code === "unknown_format") return "định dạng xuất không được hỗ trợ";
  return code || "lỗi không rõ";
}

/**
 * The list's state, as data (task 4.3). `kind` says which state the screen is
 * in; `message` is what the operator reads. The same function covers both
 * shapes the screen actually has:
 *
 *   * when nothing can be rendered, `message` is the only thing on screen
 *     (loading / empty / offline / error placeholder, or "no matches");
 *   * when cached rows exist, they still render (that is the point of the
 *     local cache) and an offline/error condition becomes a banner ABOVE
 *     them — an unreachable companion must not blank a usable list.
 */
export function deriveHistoryState({ loading = false, offline = false, error = null, total = 0, matched = 0 } = {}) {
  if (total > 0 && matched === 0) {
    return { kind: HISTORY_STATE.NO_MATCH, message: "Không có cuộc trò chuyện nào khớp bộ lọc." };
  }
  if (error && total === 0) return { kind: HISTORY_STATE.ERROR, message: historyErrorText(error) };
  if (offline && total === 0) {
    return { kind: HISTORY_STATE.OFFLINE, message: "Không kết nối được tới máy chủ companion và chưa có bản lưu cục bộ." };
  }
  if (loading && total === 0) return { kind: HISTORY_STATE.LOADING, message: "Đang tải danh sách trò chuyện…" };
  if (total === 0) return { kind: HISTORY_STATE.EMPTY, message: "Chưa có cuộc trò chuyện nào." };
  if (error) {
    return { kind: HISTORY_STATE.ERROR, message: `${historyErrorText(error)} — danh sách dưới đây là bản lưu cục bộ.` };
  }
  if (offline) {
    return { kind: HISTORY_STATE.OFFLINE, message: "Không kết nối được tới máy chủ companion — danh sách dưới đây là bản lưu cục bộ." };
  }
  return { kind: HISTORY_STATE.READY, message: null };
}

/** Everything a row displays. A row whose signature is unchanged is left
 * completely alone by `_patch()`; a changed one is updated in place. */
export function rowSignature(entry, { active = false } = {}) {
  if (!entry) return "";
  return [
    entry.title || "",
    entry.hostname || "",
    entry.updatedAt || 0,
    entry.pinned ? "pin" : "",
    entry.archived ? "archive" : "",
    entry.stale ? "stale" : "",
    entry.interrupted ? "interrupted" : "",
    active ? "active" : ""
  ].join("\u0001");
}

/** The status pills a row shows, as data (label + CSS class + tooltip). */
export function entryBadges(entry) {
  if (!entry) return [];
  const badges = [];
  if (entry.pinned) badges.push({ key: "pinned", label: "Đã ghim", className: "status-pill", title: null });
  if (entry.archived) badges.push({ key: "archived", label: "Đã lưu trữ", className: "status-pill is-unknown", title: null });
  if (entry.stale) {
    badges.push({
      key: "stale",
      label: "Không còn trên máy chủ",
      className: "status-pill is-unknown",
      title: "Không còn trên máy chủ companion"
    });
  }
  if (entry.interrupted) badges.push({ key: "interrupted", label: "Bị gián đoạn", className: "status-pill is-unknown", title: null });
  return badges;
}

/** Domain filter options, derived from what is actually in the cache. */
export function domainOptions(entries) {
  const counts = new Map();
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry || !entry.hostname) continue;
    counts.set(entry.hostname, (counts.get(entry.hostname) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([value, count]) => ({ value, label: `${value} (${count})` }));
}

/** Date + optional hostname, as the row's second line. */
export function formatRowSubtitle(entry, { locale = "vi-VN" } = {}) {
  if (!entry) return "";
  const ts = entry.updatedAt || entry.createdAt || null;
  const when = ts ? new Date(ts).toLocaleString(locale) : "";
  return entry.hostname ? `${when} · ${entry.hostname}` : when;
}

// ------------------------------------------------------------------- the view

/**
 * Renders (and incrementally patches) the conversation list.
 *
 * The container is owned by this class: everything inside it is created and
 * removed here. The toolbar controls are NOT owned — `sidepanel.js` wires
 * them and calls `setQuery` / `setDateRange` / `setDomain` / `clearFilters`.
 *
 * @param {object} deps
 * @param {Element} deps.container - the list element (e.g. #conversation-list)
 * @param {Element} [deps.scrollContainer] - the scrolling ancestor, for
 *   scroll preservation and `onScroll()` paging (defaults to `container`)
 * @param {Document} [deps.document] - document-like factory (`createElement`)
 * @param {object} [deps.actions] - `onOpen`, `onDelete`, `onRename`, `onPin`,
 *   `onArchive`, `onExport`, `onRetry`, each called with the entry
 * @param {number} [deps.pageSize] - entries per rendered page
 * @param {number} [deps.debounceMs] - search debounce window
 * @param {() => number} [deps.now]
 * @param {string} [deps.locale]
 */
export class HistoryListView {
  constructor({
    container,
    scrollContainer = null,
    document: doc = null,
    actions = {},
    pageSize = HISTORY_PAGE_SIZE,
    debounceMs = HISTORY_SEARCH_DEBOUNCE_MS,
    now = Date.now,
    locale = "vi-VN"
  } = {}) {
    if (!container) throw new Error("HistoryListView: a container element is required");
    const documentLike = doc || (typeof document !== "undefined" ? document : null);
    if (!documentLike || typeof documentLike.createElement !== "function") {
      throw new Error("HistoryListView: a document-like object with createElement is required");
    }
    this.container = container;
    this.scrollContainer = scrollContainer || container;
    this._doc = documentLike;
    this._actions = actions;
    this.pageSize = pageSize > 0 ? pageSize : HISTORY_PAGE_SIZE;
    this._now = now;
    this._locale = locale;

    this._entries = [];
    this._byId = new Map();
    this._filters = normalizeFilters();
    this._state = { loading: false, offline: false, error: null };
    this._limit = this.pageSize;
    this._activeId = null;
    this._busy = null;
    this._focusedId = null;
    this._records = new Map(); // key -> {node, parts, signature}
    this._report = emptyReport();
    this._renderToken = 0;
    this._appliedToken = 0;
    this._pendingQuery = "";
    this._search = debounce(() => this._applyQuery(), debounceMs);
  }

  // ---- inputs (what the panel feeds in) -----------------------------------

  /** The full set of cached conversations (already sorted by the store). */
  setEntries(entries) {
    this._entries = Array.isArray(entries) ? entries.filter(Boolean) : [];
    // Index by id once per feed, not once per row: `_entryById()` is called
    // from every row's update and from every action handler, and a 1000-entry
    // list must not cost a linear scan per row (tasks.md 5.3's budget).
    this._byId = new Map(this._entries.map((entry) => [entry.conversationId, entry]));
    return this;
  }

  /** Connection/refresh state for `deriveHistoryState()`. */
  setState({ loading, offline, error } = {}) {
    if (loading !== undefined) this._state.loading = loading === true;
    if (offline !== undefined) this._state.offline = offline === true;
    if (error !== undefined) this._state.error = error || null;
    return this;
  }

  /** Which conversation the panel currently shows (row highlight). */
  setActiveConversation(conversationId) {
    this._activeId = conversationId || null;
    return this;
  }

  /**
   * Mark one row's control as in flight (currently: export, the one history
   * action that takes long enough for a second click to be a real mistake —
   * see tasks.md 4.3's "export states"). The row's signature includes this, so
   * only that row is updated.
   */
  setBusy(busy) {
    this._busy = busy && busy.conversationId ? { conversationId: busy.conversationId, action: busy.action || "export" } : null;
    return this;
  }

  /** Queue a search-box value. Debounced: a newer keystroke cancels the
   * pending one, so a burst of typing produces one filter+render pass. */
  setQuery(raw) {
    this._pendingQuery = typeof raw === "string" ? raw : "";
    this._search();
    return this;
  }

  /** Apply any queued query immediately (Enter in the search box / tests). */
  flushQuery() {
    this._search.flush();
    return this;
  }

  /** Apply a date range (`YYYY-MM-DD` or null for "no bound"). Discrete
   * controls, so these apply immediately rather than through the debounce. */
  setDateRange({ from, to } = {}) {
    this._filters = normalizeFilters({ ...this._filters, from, to });
    this._limit = this.pageSize;
    return this;
  }

  setDomain(domain) {
    this._filters = normalizeFilters({ ...this._filters, domain });
    this._limit = this.pageSize;
    return this;
  }

  clearFilters() {
    this._filters = normalizeFilters();
    this._pendingQuery = "";
    this._search.cancel();
    this._limit = this.pageSize;
    return this;
  }

  /** True when any filter is actually narrowing the list — the toolbar's own
   * "clear" affordance keys off this. */
  hasActiveFilters() {
    return Boolean(this._filters.query || this._filters.domain || this._filters.from != null || this._filters.to != null);
  }

  filters() {
    return { query: this._filters.query, from: this._filters.from, to: this._filters.to, domain: this._filters.domain };
  }

  query() {
    return this._filters.query;
  }

  domainOptions() {
    return domainOptions(this._entries);
  }

  entries() {
    return this._entries.slice();
  }

  /** Ids currently rendered, in display order — the "visible page". */
  visibleIds() {
    return this._report.visibleIds.slice();
  }

  report() {
    return { ...this._report, groups: this._report.groups.map((g) => ({ ...g })) };
  }

  // ---- render token: "the newest refresh wins" ----------------------------

  /**
   * Claim a token BEFORE an async refresh starts, hand it to `render()` when
   * the refresh lands. `refreshHistoryView()` awaits the host reconcile and
   * the storage read; a keystroke (or another panel's write) can render a
   * newer pass in that window, and the older one must then be discarded
   * rather than rolling the screen back to what it was before
   * (spec "Search and filters": "stale queries are cancelled").
   */
  nextRenderToken() {
    this._renderToken += 1;
    return this._renderToken;
  }

  // ---- rendering ----------------------------------------------------------

  /**
   * Recompute the visible page and patch the container.
   *
   * @param {object} [opts]
   * @param {number} [opts.token] - from `nextRenderToken()`; a token older
   *   than the last applied one is ignored (reported as `stale: true`).
   * @returns {object} render report (see `report()`)
   */
  render({ token } = {}) {
    if (token != null && token < this._appliedToken) {
      this._report = { ...this._report, stale: true };
      return this.report();
    }
    if (token != null) this._appliedToken = token;

    const now = this._now();
    const matched = filterConversations(this._entries, this._filters);
    const groups = groupConversations(matched, { now });
    const state = deriveHistoryState({ ...this._state, total: this._entries.length, matched: matched.length });

    const flat = [];
    for (const group of groups) for (const entry of group.entries) flat.push({ entry, group: group.key, label: group.label });
    const visible = flat.slice(0, this._limit);
    const truncated = flat.length - visible.length;

    const ordered = [];
    if (state.message) {
      ordered.push({
        key: "state",
        kind: "state",
        signature: `${state.kind}\u0001${state.message}`,
        create: () => {
          const node = this._doc.createElement("p");
          node.className = "field-hint history-state";
          this._fillState(node, state);
          return { node, parts: null };
        },
        update: (parts, node) => this._fillState(node, state)
      });
    }
    let currentGroup = null;
    for (const row of visible) {
      if (row.group !== currentGroup) {
        currentGroup = row.group;
        ordered.push({
          key: `group:${row.group}`,
          kind: "group",
          signature: row.label,
          create: () => {
            const node = this._doc.createElement("p");
            node.className = "section-heading history-group";
            return { node, parts: null };
          },
          update: (parts, node) => {
            node.textContent = row.label;
          }
        });
      }
      ordered.push(this._rowItem(row.entry));
    }
    if (truncated > 0) {
      ordered.push({
        key: "more",
        kind: "more",
        signature: String(truncated),
        create: () => {
          const node = this._doc.createElement("button");
          node.className = "btn btn-secondary btn-sm history-more";
          node.setAttribute("type", "button");
          node.textContent = "";
          node.addEventListener("click", () => this.loadMore());
          return { node, parts: null };
        },
        update: (parts, node) => {
          node.textContent = `Xem thêm (còn ${truncated})`;
        }
      });
    }

    const counters = this._patch(ordered);
    this._report = {
      state: { ...state },
      total: this._entries.length,
      matched: matched.length,
      rendered: visible.length,
      truncated,
      groups: groups.map((g) => ({ key: g.key, label: g.label, count: g.entries.length })),
      visibleIds: visible.map((r) => r.entry.conversationId),
      stale: false,
      ...counters
    };
    if (this._focusedId && !this._report.visibleIds.includes(this._focusedId)) this._focusedId = null;
    const report = this.report();
    // The panel's own readouts (the "N/M match the filter" line) are derived
    // from the report, and MANY renders happen without the panel asking
    // (a debounced search, a storage adoption from another panel). Notifying
    // here, rather than at each call site, is what keeps those readouts from
    // disagreeing with the rows on screen.
    this._actions.onRender?.(report);
    return report;
  }

  /**
   * Grow the rendered window by one page. Returns `{more, rendered}` — `more`
   * false means the whole filtered list is on screen.
   */
  loadMore() {
    if (this._report.truncated <= 0) return { more: false, rendered: this._report.rendered };
    this._limit += this.pageSize;
    this.render();
    return { more: this._report.truncated > 0, rendered: this._report.rendered };
  }

  /** Scroll handler for the history scroll container: pull the next page as
   * the operator reaches the bottom (spec "Incremental rendering"). Returns
   * whether a page was added. */
  onScroll() {
    const scroller = this.scrollContainer;
    if (!scroller || this._report.truncated <= 0) return false;
    const scrollTop = scroller.scrollTop || 0;
    const clientHeight = scroller.clientHeight || 0;
    const scrollHeight = scroller.scrollHeight || 0;
    if (!clientHeight || !scrollHeight) return false; // unmeasurable (hidden view) — the "Xem thêm" control still works
    if (scrollHeight - scrollTop - clientHeight > HISTORY_SCROLL_THRESHOLD_PX) return false;
    this.loadMore();
    return true;
  }

  /** Focus one row by id (used by the keyboard navigation below). */
  focusRow(conversationId) {
    const record = this._records.get(rowKey(conversationId));
    if (!record) return false;
    this._focusedId = conversationId;
    if (typeof record.node.focus === "function") record.node.focus();
    return true;
  }

  /** Keyboard reopen (tasks.md 4.1): arrow keys walk the visible rows, Enter
   * activates the focused one. Wired on every row and on every row control, so
   * the operator can reach a conversation without leaving the keyboard — and
   * without a Tab stop per control on the way. */
  rowKeyDown(event, conversationId) {
    if (!event) return false;
    const key = event.key;
    if (key === "ArrowDown" || key === "ArrowUp") {
      const ids = this._report.visibleIds;
      const index = ids.indexOf(conversationId);
      if (index === -1) return false;
      const next = key === "ArrowDown" ? ids[index + 1] : ids[index - 1];
      if (!next) return false;
      event.preventDefault?.();
      this.focusRow(next);
      return true;
    }
    if (key === "Home" || key === "End") {
      const ids = this._report.visibleIds;
      const target = key === "Home" ? ids[0] : ids[ids.length - 1];
      if (!target) return false;
      event.preventDefault?.();
      this.focusRow(target);
      return true;
    }
    if (key === "Enter" || key === " ") {
      // Space would also scroll the list; both are claimed only when the rows
      // themselves are focused, never when a control inside a row is (its own
      // activation is the browser's job).
      const isRow = event.target === this._records.get(rowKey(conversationId))?.node;
      if (!isRow) return false;
      event.preventDefault?.();
      this._activate(conversationId);
      return true;
    }
    return false;
  }

  // ---- row construction ---------------------------------------------------

  /** Fill (or refill) the state line. Rebuilt on every state change rather
   * than patched, because the retry control belongs to some states and not
   * others — a leftover "Thử lại" button next to "no matches" would be a lie
   * about what can be retried. */
  _fillState(node, state) {
    node.dataset.state = state.kind;
    node.setAttribute("role", state.kind === HISTORY_STATE.ERROR ? "alert" : "status");
    node.textContent = "";
    const message = this._doc.createElement("span");
    message.textContent = state.message;
    node.appendChild(message);
    // A retry control belongs to the failure states only: the panel can ask
    // the host again, and the operator must be able to say "try now" instead
    // of waiting for the next automatic refresh (task 4.3).
    if (state.kind === HISTORY_STATE.ERROR || state.kind === HISTORY_STATE.OFFLINE) {
      const retry = this._doc.createElement("button");
      retry.className = "btn btn-secondary btn-sm history-retry";
      retry.setAttribute("type", "button");
      retry.textContent = "Thử lại";
      retry.addEventListener("click", () => this._actions.onRetry?.());
      node.appendChild(retry);
    }
    return node;
  }

  _rowItem(entry) {
    const conversationId = entry.conversationId;
    return {
      key: rowKey(conversationId),
      kind: "row",
      signature: `${rowSignature(entry, { active: conversationId === this._activeId })}\u0002${this._busy && this._busy.conversationId === conversationId ? this._busy.action : ""}`,
      create: () => {
        const node = this._doc.createElement("div");
        node.className = "list-item history-row";
        node.setAttribute("data-conversation-id", conversationId);
        node.setAttribute("tabindex", "-1");
        node.addEventListener("keydown", (event) => this.rowKeyDown(event, conversationId));

        const icon = this._doc.createElement("span");
        icon.className = "list-item-icon";
        icon.innerHTML = iconMarkup("page", { size: 18 });
        node.appendChild(icon);

        const main = this._doc.createElement("span");
        main.className = "list-item-main";
        const head = this._doc.createElement("span");
        head.className = "history-row-head";
        const title = this._doc.createElement("span");
        title.className = "list-item-title";
        const badges = this._doc.createElement("span");
        badges.className = "history-row-badges";
        head.appendChild(title);
        head.appendChild(badges);
        const sub = this._doc.createElement("span");
        sub.className = "list-item-sub";
        const actions = this._doc.createElement("span");
        actions.className = "list-item-actions";
        main.appendChild(head);
        main.appendChild(sub);
        main.appendChild(actions);
        node.appendChild(main);

        const parts = { title, sub, badges, actions, controls: {} };
        parts.controls.open = this._actionButton(actions, "open", "externalLink", "Mở lại cuộc trò chuyện", conversationId, () =>
          this._activate(conversationId)
        );
        parts.controls.pin = this._actionButton(actions, "pin", "pin", "Ghim cuộc trò chuyện", conversationId, () =>
          this._actions.onPin?.(this._entryById(conversationId))
        );
        parts.controls.archive = this._actionButton(actions, "archive", "folder", "Lưu trữ cuộc trò chuyện", conversationId, () =>
          this._actions.onArchive?.(this._entryById(conversationId))
        );
        parts.controls.rename = this._textButton(actions, "rename", "Đổi tên", conversationId, () =>
          this._actions.onRename?.(this._entryById(conversationId))
        );
        parts.controls.export = this._actionButton(actions, "export", "download", "Xuất cuộc trò chuyện", conversationId, () =>
          this._actions.onExport?.(this._entryById(conversationId))
        );
        parts.controls.delete = this._actionButton(actions, "delete", "trash", "Xóa cuộc trò chuyện", conversationId, () =>
          this._actions.onDelete?.(this._entryById(conversationId))
        );
        return { node, parts };
      },
      update: (parts, node) => this._updateRow(node, parts, this._entryById(conversationId), conversationId)
    };
  }

  _actionButton(parent, action, icon, label, conversationId, handler) {
    const button = this._doc.createElement("button");
    button.className = "btn-icon";
    button.setAttribute("type", "button");
    button.setAttribute("data-act", action);
    button.setAttribute("aria-label", label);
    button.innerHTML = iconMarkup(icon, { size: 16, title: label });
    button.addEventListener("click", handler);
    button.addEventListener("keydown", (event) => this.rowKeyDown(event, conversationId));
    parent.appendChild(button);
    return button;
  }

  _textButton(parent, action, label, conversationId, handler) {
    const button = this._doc.createElement("button");
    button.className = "btn btn-secondary btn-sm";
    button.setAttribute("type", "button");
    button.setAttribute("data-act", action);
    button.textContent = label;
    button.addEventListener("click", handler);
    button.addEventListener("keydown", (event) => this.rowKeyDown(event, conversationId));
    parent.appendChild(button);
    return button;
  }

  _updateRow(node, parts, entry, conversationId) {
    const current = entry || { conversationId };
    const active = conversationId === this._activeId;
    if (active) node.setAttribute("aria-current", "true");
    else node.removeAttribute("aria-current");
    parts.title.textContent = current.title || "Cuộc trò chuyện";
    parts.sub.textContent = formatRowSubtitle(current, { locale: this._locale });
    parts.badges.textContent = "";
    for (const badge of entryBadges(current)) {
      const pill = this._doc.createElement("span");
      pill.className = badge.className;
      if (badge.title) pill.setAttribute("title", badge.title);
      pill.textContent = badge.label;
      parts.badges.appendChild(pill);
    }
    // An orphaned row is never reopenable (spec chat-history-lifecycle
    // "Authoritative listing and reconciliation"), and the pin/archive/export
    // actions would all be host operations against a conversation the host no
    // longer has — the delete control stays live so the stale row can be
    // cleared.
    const stale = current.stale === true;
    parts.controls.open.disabled = stale;
    parts.controls.pin.disabled = stale;
    parts.controls.archive.disabled = stale;
    parts.controls.rename.disabled = stale;
    parts.controls.export.disabled = stale;
    const pinned = current.pinned === true;
    parts.controls.pin.setAttribute("aria-pressed", pinned ? "true" : "false");
    parts.controls.pin.setAttribute("aria-label", pinned ? "Bỏ ghim cuộc trò chuyện" : "Ghim cuộc trò chuyện");
    parts.controls.pin.innerHTML = iconMarkup(pinned ? "pinOff" : "pin", {
      size: 16,
      title: pinned ? "Bỏ ghim cuộc trò chuyện" : "Ghim cuộc trò chuyện"
    });
    const archived = current.archived === true;
    parts.controls.archive.setAttribute("aria-pressed", archived ? "true" : "false");
    parts.controls.archive.setAttribute("aria-label", archived ? "Bỏ lưu trữ cuộc trò chuyện" : "Lưu trữ cuộc trò chuyện");
    // The in-flight export: the control says what is happening and refuses a
    // second click, so one press is one artifact.
    const busy = this._busy && this._busy.conversationId === conversationId ? this._busy.action : null;
    const exporting = busy === "export";
    parts.controls.export.disabled = stale || exporting;
    parts.controls.export.setAttribute("aria-label", exporting ? "Đang xuất cuộc trò chuyện" : "Xuất cuộc trò chuyện");
    node.dataset.busy = busy || "";
  }

  _activate(conversationId) {
    const entry = this._entryById(conversationId);
    if (!entry || entry.stale) return false; // an orphan is not a reopenable conversation
    this._actions.onOpen?.(entry);
    return true;
  }

  _entryById(conversationId) {
    return (this._byId && this._byId.get(conversationId)) || null;
  }

  // ---- the keyed patch ----------------------------------------------------

  /**
   * Put `ordered` into the container, keeping every node whose key is still
   * present and whose signature did not change. This is what makes a live sync
   * from another panel (and a keystroke in the search box) cheap: the rows the
   * operator is looking at are untouched, no rebuild, no lost focus.
   *
   * The returned counters are ROW counters (group headings, the state line and
   * the "load more" control are structural chrome that would only blur the
   * signal the specs ask about): `reused` rows kept their exact DOM node,
   * `updated` rows kept it and had their content rewritten, `created` rows are
   * new nodes, `removed` rows are nodes that left the screen.
   *
   * @returns {{created:number, updated:number, reused:number, removed:number}}
   */
  _patch(ordered) {
    const scroller = this.scrollContainer;
    const scrollTop = scroller ? scroller.scrollTop || 0 : 0;
    const next = new Map();
    let created = 0;
    let updated = 0;
    let reused = 0;
    let removed = 0;
    let index = 0;
    for (const item of ordered) {
      const isRow = item.kind === "row";
      let record = this._records.get(item.key);
      const existed = !!record;
      if (!record) {
        const built = item.create();
        record = { node: built.node, parts: built.parts, signature: null, kind: item.kind };
        if (isRow) created += 1;
      } else if (record.signature === item.signature) {
        if (isRow) reused += 1;
      }
      if (record.signature !== item.signature) {
        item.update(record.parts, record.node);
        record.signature = item.signature;
        if (existed && isRow) updated += 1;
      }
      next.set(item.key, record);
      const current = this.container.children ? this.container.children[index] : null;
      if (current !== record.node) this.container.insertBefore(record.node, current || null);
      index += 1;
    }
    for (const [key, record] of this._records) {
      if (next.has(key)) continue;
      if (record.kind === "row") removed += 1;
      if (typeof record.node.remove === "function") record.node.remove();
      else this.container.removeChild(record.node);
    }
    this._records = next;
    // Scroll preservation (spec "Incremental rendering"): the offset the
    // operator had before this patch is restored after it, so metadata
    // arriving from the host — or from another panel — never scrolls the list
    // out from under the reader. Nothing user-driven can interleave: the whole
    // patch is one synchronous task.
    if (scroller && scrollTop > 0 && scroller.scrollTop !== scrollTop) scroller.scrollTop = scrollTop;
    return { created, updated, reused, removed };
  }

  _applyQuery() {
    this._filters = normalizeFilters({ ...this._filters, query: this._pendingQuery });
    this._limit = this.pageSize;
    this.render();
  }
}

function rowKey(conversationId) {
  return `row:${conversationId}`;
}

function emptyReport() {
  return {
    state: { kind: HISTORY_STATE.EMPTY, message: null },
    total: 0,
    matched: 0,
    rendered: 0,
    truncated: 0,
    groups: [],
    visibleIds: [],
    stale: false,
    created: 0,
    updated: 0,
    reused: 0,
    removed: 0
  };
}
