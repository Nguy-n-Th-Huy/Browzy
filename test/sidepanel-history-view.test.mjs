#!/usr/bin/env node
// History screen behaviour for openspec/changes/optimize-chat-history tasks
// 4.1-4.3 and the export half of 5.1: the REAL
// extension/sidepanel/history-view.js and extension/sidepanel/history-export.js
// driven against a fake document (test/_fake-dom.mjs).
//
// The acceptance-critical properties this file pins, each named after the
// spec scenario it serves:
//   * chat-history-browsing "Search and filters": matching results update
//     without rebuilding unrelated rows, and a superseded query is cancelled
//     rather than applied late.
//   * chat-history-browsing "Incremental rendering": only the first page is
//     rendered, more loads on demand, and the scroll offset survives a render
//     that arrives from outside the operator's own typing.
//   * chat-history-browsing "Live synchronization": a row whose data changed
//     underneath the view is updated IN PLACE (same DOM node), a deleted one is
//     removed, and the states loading / empty / offline / error / no-match /
//     stale are distinguishable.
//   * chat-history-lifecycle "Organization and export": pin, archive, rename
//     and export are offered per row (and are refused on an orphan), and the
//     artifact carries metadata plus the transcript it was given.
//
// Run: node test/sidepanel-history-view.test.mjs

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  HistoryListView,
  HISTORY_SEARCH_DEBOUNCE_MS,
  HISTORY_PAGE_SIZE,
  HISTORY_STATE,
  HISTORY_GROUP,
  HISTORY_QUERY_MAX_CHARS,
  debounce,
  normalizeFilters,
  matchesFilters,
  filterConversations,
  groupConversations,
  dayBucket,
  parseDayStart,
  parseDayEnd,
  deriveHistoryState,
  historyErrorText,
  historySearchText,
  entryBadges,
  domainOptions,
  rowSignature,
  formatRowSubtitle
} from "../extension/sidepanel/history-view.js";
import {
  buildConversationArtifact,
  transcriptMessages,
  artifactMessages,
  exportFilename,
  slugify,
  normalizeExportFormat,
  EXPORT_FORMAT,
  EXPORT_SCHEMA_VERSION
} from "../extension/sidepanel/history-export.js";
import { createDocument } from "./_fake-dom.mjs";
import { extractFunction, compile } from "./_extract.mjs";
import { HistoryStore } from "../extension/sidepanel/history-store.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NOW = new Date(2026, 8, 13, 12, 0, 0).getTime(); // 2026-09-13 12:00 local
const DAY = 24 * 60 * 60 * 1000;

let fail = 0;
function ok(cond, msg) {
  console.log((cond ? "  PASS " : "  FAIL ") + msg);
  if (!cond) fail++;
}

function entry(id, over = {}) {
  return {
    conversationId: id,
    title: over.title ?? `Cuộc trò chuyện ${id}`,
    hostname: over.hostname ?? null,
    createdAt: over.createdAt ?? NOW,
    updatedAt: over.updatedAt ?? NOW,
    pinned: over.pinned === true,
    archived: over.archived === true,
    stale: over.stale === true,
    interrupted: over.interrupted === true,
    hasActiveRun: false,
    revision: over.revision ?? 1,
    prompts: over.prompts || {}
  };
}

function buildView(over = {}) {
  const doc = createDocument();
  const container = doc.createElement("div");
  const scroller = doc.createElement("div");
  scroller.appendChild(container);
  const calls = { open: [], delete: [], rename: [], pin: [], archive: [], export: [], retry: 0 };
  const view = new HistoryListView({
    container,
    scrollContainer: scroller,
    document: doc,
    debounceMs: 15,
    pageSize: over.pageSize || 3,
    now: () => NOW,
    actions: {
      onOpen: (e) => calls.open.push(e.conversationId),
      onDelete: (e) => calls.delete.push(e.conversationId),
      onRename: (e) => calls.rename.push(e.conversationId),
      onPin: (e) => calls.pin.push(e.conversationId),
      onArchive: (e) => calls.archive.push(e.conversationId),
      onExport: (e) => calls.export.push(e.conversationId),
      onRetry: () => {
        calls.retry += 1;
      }
    }
  });
  return { view, container, scroller, doc, calls };
}

/** The minimal chrome.storage.local contract the history cache needs (the
 * store suite's fake, without its write counters). */
function memStorage(seed = {}) {
  const data = { ...seed };
  return {
    async get(key) {
      if (key == null) return { ...data };
      if (Array.isArray(key)) {
        const out = {};
        for (const k of key) if (k in data) out[k] = data[k];
        return out;
      }
      return key in data ? { [key]: data[key] } : {};
    },
    async set(obj) {
      Object.assign(data, obj);
    },
    async remove(keys) {
      for (const k of Array.isArray(keys) ? keys : [keys]) delete data[k];
    }
  };
}

function rowNodeOf(container, conversationId) {
  return container.children.find((child) => child.getAttribute("data-conversation-id") === conversationId) || null;
}

function rowNodes(container) {
  return container.children.filter((child) => child.getAttribute("data-conversation-id") != null);
}

function stateNode(container) {
  return container.children.find((child) => child.dataset.state != null) || null;
}

/** Simulates the reflow a browser performs when rows are added or removed
 * above the viewport: the scroll offset moves by one row per mutation. It is
 * installed on the element whose CHILDREN the patch mutates (the container)
 * and moves the offset on the SCROLLER `_patch()` measures — installing it on
 * the scroller itself would never fire (nothing mutates the scroller's
 * children) and would let "scroll survived" pass whether or not the view
 * restores anything. `mutations`/`lastClampedTo` make the simulation
 * observable, so a scenario can assert it really ran. */
function withReflowClamping(container, { scroller = container, rowHeight = 60 } = {}) {
  const insertBefore = container.insertBefore.bind(container);
  const removeChild = container.removeChild.bind(container);
  const state = { mutations: 0, lastClampedTo: null };
  const clamp = () => {
    state.mutations += 1;
    scroller.scrollTop = Math.max(0, (scroller.scrollTop || 0) - rowHeight);
    state.lastClampedTo = scroller.scrollTop;
  };
  container.insertBefore = (child, reference) => {
    const result = insertBefore(child, reference);
    clamp();
    return result;
  };
  container.removeChild = (child) => {
    const result = removeChild(child);
    clamp();
    return result;
  };
  scroller.scrollHeight = 4000;
  scroller.clientHeight = 400;
  return state;
}

async function main() {
  console.log("== search: debounced, cancelled when superseded, diacritic-insensitive, metadata-only ==");
  {
    const filters = normalizeFilters({ query: "  báo cáo  " });
    ok(filters.query === "  báo cáo  " && filters.queryFold === "bao cao", "a query is folded for matching but kept verbatim for the input box");
    ok(normalizeFilters({ query: "x".repeat(500) }).query.length === HISTORY_QUERY_MAX_CHARS, "an absurd query is capped, never stored whole");

    const rows = [
      entry("c1", { title: "Đọc báo cáo tài chính", hostname: "vnexpress.net" }),
      entry("c2", { title: "Khác", hostname: "example.com", prompts: { r1: "tóm tắt bài viết về lịch sử" } }),
      entry("c3", { title: "Khác nữa", hostname: "vnexpress.net" })
    ];
    ok(filterConversations(rows, normalizeFilters({ query: "bao cao" })).map((r) => r.conversationId).join() === "c1", "a diacritic-free query finds the accented title");
    ok(filterConversations(rows, normalizeFilters({ query: "lich su" })).map((r) => r.conversationId).join() === "c2", "…and the locally cached prompt preview");
    ok(filterConversations(rows, normalizeFilters({ query: "c2" })).map((r) => r.conversationId).join() === "c2", "…and the conversation id");
    ok(filterConversations(rows, normalizeFilters({ domain: "vnexpress.net" })).length === 2, "the domain filter selects by hostname");
    ok(historySearchText(rows[1]).includes("tóm tắt"), "the searchable text includes prompt previews");
    ok(matchesFilters(rows[0], normalizeFilters({ from: "2026-09-13", to: "2026-09-13" })) === true, "a same-day range includes an entry updated that day");
    ok(matchesFilters(rows[0], normalizeFilters({ from: "2026-09-14" })) === false, "a later from-date excludes it");
    ok(matchesFilters(entry("c9", { updatedAt: NOW }), normalizeFilters({ to: "2026-09-13" })) === true, "the to-date is inclusive of the whole day");
    ok(parseDayStart("2026-09-13") === new Date(2026, 8, 13).getTime(), "a date input is parsed as LOCAL midnight, not UTC");
    ok(parseDayEnd("2026-09-13") - parseDayStart("2026-09-13") === DAY - 1, "the end bound is the last millisecond of that local day");
  }

  console.log("== search: typing burst is one render pass, and the superseded query never lands ==");
  {
    const { view, container } = buildView();
    const renders = [];
    const original = view.render.bind(view);
    view.render = (opts) => {
      renders.push(view.filters().query);
      return original(opts);
    };
    view.setEntries([entry("c1", { title: "alpha" }), entry("c2", { title: "beta" })]);
    for (const text of ["b", "be", "bet", "beta"]) view.setQuery(text);
    ok(renders.length === 0, `no render happens inside the debounce window (${HISTORY_SEARCH_DEBOUNCE_MS}ms default, 15ms here)`);
    await new Promise((r) => setTimeout(r, 60));
    ok(renders.length === 1, "the whole burst produced exactly one filter+render pass");
    ok(view.query() === "beta", "and the query applied is the last one typed, not an intermediate");
    ok(rowNodes(container).length === 1 && rowNodeOf(container, "c2"), "the list shows only the matches");

    // A flush (Enter) applies immediately, and a cancelled query leaves nothing behind.
    view.setQuery("alpha");
    view.flushQuery();
    ok(view.query() === "alpha" && rowNodes(container).length === 1, "flushQuery() applies the pending query immediately");
    const rendersBeforeClear = renders.length;
    view.setQuery("beta");
    view.clearFilters();
    await new Promise((r) => setTimeout(r, 40));
    ok(renders.length === rendersBeforeClear, "clearing filters cancels the pending search instead of applying it late");
    ok(view.query() === "", "…and the filter really is cleared");
    view.render();
    ok(rowNodes(container).length === 2, "the cleared list shows everything again");

    const d = debounce(() => {}, 5);
    ok(typeof d.cancel === "function" && typeof d.flush === "function", "debounce() exposes cancel() and flush()");
  }

  console.log("== rendering: incremental patch keeps unrelated rows, updates changed ones in place ==");
  {
    const { view, container, calls } = buildView({ pageSize: 10 });
    view.setEntries([entry("c1", { title: "một" }), entry("c2", { title: "hai" }), entry("c3", { title: "ba" })]);
    let report = view.render();
    ok(report.created === 3 && report.reused === 0, "the first render creates every row");
    const c1 = rowNodeOf(container, "c1");
    const c2 = rowNodeOf(container, "c2");
    const c3 = rowNodeOf(container, "c3");
    ok(!!c1 && !!c2 && !!c3, "all three rows are in the DOM, in order");

    // Another panel renamed c2 and pinned c3: a live sync re-render.
    view.setEntries([entry("c1", { title: "một" }), entry("c2", { title: "đã đổi tên" }), entry("c3", { title: "ba", pinned: true })]);
    report = view.render();
    ok(rowNodeOf(container, "c1") === c1 && rowNodeOf(container, "c3") === c3, "rows whose data did not change keep their exact DOM node");
    ok(rowNodeOf(container, "c2") === c2, "a changed row is updated IN PLACE, not recreated");
    ok(c2.children[1].children[0].children[0].textContent === "đã đổi tên", "…and the new title is what it shows");
    ok(report.reused === 1 && report.updated === 2 && report.created === 0, `the report says 1 reused / 2 updated / 0 created (${JSON.stringify({ reused: report.reused, updated: report.updated, created: report.created })})`);
    const pinnedBadge = c3.children[1].children[0].children[1];
    ok(pinnedBadge.children.some((pill) => pill.textContent === "Đã ghim"), "a pin made elsewhere shows as a badge without a reload");

    // A delete elsewhere removes exactly that row.
    view.setEntries([entry("c1", { title: "một" }), entry("c3", { title: "ba", pinned: true })]);
    report = view.render();
    ok(rowNodeOf(container, "c2") === null && report.removed === 1, "the deleted row is removed and nothing else is");
    ok(rowNodeOf(container, "c3") === c3, "the surviving row is still the same node");
    ok(calls.open.length === 0, "none of this activation business fires on a re-render");
  }

  console.log("== paging: only the first page renders, more loads on demand, scroll survives a render ==");
  {
    const { view, container, scroller } = buildView({ pageSize: 5 });
    const reflow = withReflowClamping(container, { scroller });
    const rows = Array.from({ length: 12 }, (_, i) => entry(`c${i}`, { title: `t${i}` }));
    view.setEntries(rows);
    let report = view.render();
    ok(report.rendered === 5 && report.truncated === 7, `only the first page renders (${report.rendered} of ${report.total}, ${report.truncated} left)`);
    ok(rowNodes(container).length === 5, "…and only that many row nodes exist in the DOM at all");
    const more = container.children[container.children.length - 1];
    ok(more.getAttribute("type") === "button" && /còn 7/.test(more.textContent), `the "load more" control says how many are left ("${more.textContent}")`);

    more.click();
    report = view.report();
    ok(report.rendered === 10 && rowNodes(container).length === 10, "clicking it renders the next page");
    view.loadMore();
    report = view.report();
    ok(report.rendered === 12 && report.truncated === 0, "and the last page leaves nothing unrendered");
    ok(container.children[container.children.length - 1].getAttribute("type") !== "button", "with everything rendered the control is gone");

    // Scroll preservation across a data-driven render: pinned to the top
    // (reordered), one row deleted, one row renamed in place, one row added —
    // so the patch really inserts and removes container children, the reflow
    // clamp really moves the offset, and only the restore can put it back.
    scroller.scrollTop = 500;
    const mutationsBefore = reflow.mutations;
    view.setEntries([
      { ...rows[8], pinned: true },
      ...rows.slice(0, 2).map((r) => ({ ...r, title: `${r.title} (đổi)` })),
      ...rows.slice(3),
      entry("c12", { title: "mới" })
    ]);
    view.render();
    const moved = reflow.mutations - mutationsBefore;
    ok(moved > 0, `the re-render mutated the container, so the reflow simulator fired (${moved} insert/remove calls)`);
    ok(reflow.lastClampedTo !== 500, `…and it moved the scroll offset away from the snapshot (clamped to ${reflow.lastClampedTo})`);
    const mutated = view.report();
    ok(mutated.created === 1 && mutated.removed === 1, `…with one row created and one removed, the rest kept (${JSON.stringify({ created: mutated.created, updated: mutated.updated, reused: mutated.reused, removed: mutated.removed })})`);
    ok(scroller.scrollTop === 500, `the reader's scroll offset survives a render that reordered, added and removed rows (scrollTop=${scroller.scrollTop})`);

    // Scroll-triggered paging.
    const paged = buildView({ pageSize: 5 });
    withReflowClamping(paged.container, { scroller: paged.scroller });
    paged.view.setEntries(rows);
    paged.view.render();
    paged.scroller.scrollTop = 0;
    ok(paged.view.onScroll() === false, "far from the bottom, scrolling does not pull a page");
    paged.scroller.scrollTop = paged.scroller.scrollHeight - paged.scroller.clientHeight - 10;
    ok(paged.view.onScroll() === true && paged.view.report().rendered === 10, "near the bottom it does");
  }

  console.log("== states: loading, empty, no-match, offline, error are distinguishable and honest ==");
  {
    const { container } = buildView();
    ok(deriveHistoryState({ total: 0, loading: true }).kind === HISTORY_STATE.LOADING, "no rows + a refresh in flight = loading");
    ok(deriveHistoryState({ total: 0 }).kind === HISTORY_STATE.EMPTY, "no rows + nothing in flight = empty");
    ok(deriveHistoryState({ total: 0, offline: true }).kind === HISTORY_STATE.OFFLINE, "no rows + no companion = offline");
    ok(deriveHistoryState({ total: 0, error: "host_unavailable" }).kind === HISTORY_STATE.ERROR, "no rows + a failed request = error");
    ok(deriveHistoryState({ total: 3, matched: 0 }).kind === HISTORY_STATE.NO_MATCH, "rows exist but the filter matches none = no-match, not empty");
    const banner = deriveHistoryState({ total: 3, matched: 3, offline: true });
    ok(banner.kind === HISTORY_STATE.OFFLINE && /bản lưu cục bộ/.test(banner.message), "cached rows + no companion = an offline banner over the rows, not a blank list");
    ok(deriveHistoryState({ total: 3, matched: 3 }).kind === HISTORY_STATE.READY, "rows + a healthy host = ready");
    ok(historyErrorText("host_protocol_unsupported").includes("cập nhật"), "an outdated companion is described as one");
    ok(historyErrorText("revision_conflict").includes("bảng điều khiển khác"), "a revision conflict names the other panel as the cause");
  }

  console.log("== states in the DOM: placeholder vs banner, with retry only where retrying can help ==");
  {
    const empty = buildView();
    empty.view.setState({ loading: true });
    empty.view.render();
    ok(stateNode(empty.container).dataset.state === HISTORY_STATE.LOADING, "an empty loading list renders the loading placeholder");
    ok(stateNode(empty.container).children.every((child) => child.tagName !== "BUTTON"), "the loading placeholder offers nothing to retry");

    empty.view.setState({ loading: false });
    empty.view.render();
    ok(stateNode(empty.container).dataset.state === HISTORY_STATE.EMPTY, "then the empty placeholder");

    const full = buildView({ pageSize: 10 });
    full.view.setEntries([entry("c1", { title: "alpha" }), entry("c2", { title: "beta" })]);
    full.view.setState({ offline: true, error: "host_unavailable" });
    full.view.render();
    const node = stateNode(full.container);
    ok(node.dataset.state === HISTORY_STATE.ERROR && node.getAttribute("role") === "alert", "an error state is announced, not just drawn");
    ok(rowNodes(full.container).length === 2, "…and the cached rows are still rendered underneath it");
    const retry = node.children.find((child) => child.tagName === "BUTTON");
    ok(!!retry, "the failure banner offers a retry control");
    retry.click();
    ok(full.calls.retry === 1, "…which asks the panel to try again");

    full.view.setDomain("beta.example");
    full.view.render();
    ok(stateNode(full.container).dataset.state === HISTORY_STATE.NO_MATCH, "a filter that matches nothing says so instead of showing the offline banner");
    ok(!stateNode(full.container).children.some((child) => child.tagName === "BUTTON"), "and it offers no retry, because retrying is not what is missing");
  }

  console.log("== rows: stale, pin, archive, rename, export controls ==");
  {
    const { view, container, calls } = buildView({ pageSize: 10 });
    view.setEntries([
      entry("live", { title: "bình thường", hostname: "example.com" }),
      entry("orphan", { title: "mồ côi", stale: true }),
      entry("pinned", { title: "đã ghim", pinned: true }),
      entry("archived", { title: "đã lưu trữ", archived: true, interrupted: true })
    ]);
    view.render();
    const orphan = rowNodeOf(container, "orphan");
    const orphanActions = orphan.children[1].children[2];
    const controlFor = (row, act) => row.children[1].children[2].children.find((button) => button.getAttribute("data-act") === act);
    ok(controlFor(orphan, "open").disabled === true, "an orphan cannot be reopened");
    ok(controlFor(orphan, "export").disabled === true, "…nor exported (the host no longer has it)");
    ok(controlFor(orphan, "delete").disabled === false, "…but it can still be deleted, so a stale row is clearable");
    ok(orphan.children[1].children[0].children[1].children.some((p) => p.textContent === "Không còn trên máy chủ"), "and it is marked as not on the host");
    ok(orphanActions.children.length === 6, "every row carries open/pin/archive/rename/export/delete");

    const pinnedRow = rowNodeOf(container, "pinned");
    ok(controlFor(pinnedRow, "pin").getAttribute("aria-pressed") === "true", "a pinned row's pin control reports its state");
    const archivedRow = rowNodeOf(container, "archived");
    ok(archivedRow.children[1].children[0].children[1].children.some((p) => p.textContent === "Đã lưu trữ"), "an archived row is badged");
    ok(archivedRow.children[1].children[0].children[1].children.some((p) => p.textContent === "Bị gián đoạn"), "…as is an interrupted one");

    controlFor(rowNodeOf(container, "live"), "pin").click();
    controlFor(rowNodeOf(container, "live"), "rename").click();
    controlFor(rowNodeOf(container, "live"), "export").click();
    controlFor(rowNodeOf(container, "live"), "delete").click();
    controlFor(rowNodeOf(container, "live"), "open").click();
    ok(calls.pin.join() === "live" && calls.rename.join() === "live" && calls.export.join() === "live" && calls.delete.join() === "live", "each control reports its own action for its own row");
    ok(calls.open.join() === "live", "the open control reopens that row");

    // The orphan's open control is disabled, and even a programmatic click
    // must not reopen it (the model refuses, not just the button).
    controlFor(orphan, "open").click();
    ok(calls.open.length === 1, "an orphan is not reopened even if its disabled control is clicked");

    // Export in flight: the row says so and refuses a second press.
    view.setBusy({ conversationId: "live", action: "export" });
    view.render();
    const live = rowNodeOf(container, "live");
    ok(live.dataset.busy === "export", "a row being exported is marked busy");
    ok(controlFor(live, "export").disabled === true, "…and its export control is disabled while the export runs");
    ok(controlFor(live, "export").getAttribute("aria-label") === "Đang xuất cuộc trò chuyện", "…with an accessible name that says what is happening");
    ok(controlFor(live, "delete").disabled === false, "the other controls stay usable");
    view.setBusy(null);
    view.render();
    ok(rowNodeOf(container, "live").dataset.busy === "" && controlFor(rowNodeOf(container, "live"), "export").disabled === false, "and it is released when the export finishes");
  }

  console.log("== keyboard reopen: arrows walk the rows, Enter opens, Home/End jump ==");
  {
    const { view, container, doc, calls } = buildView({ pageSize: 10 });
    view.setEntries([entry("c1"), entry("c2"), entry("c3")]);
    view.render();
    const c1 = rowNodeOf(container, "c1");
    const c2 = rowNodeOf(container, "c2");
    const control = c1.children[1].children[2].children[0];

    control.dispatchEvent({ type: "keydown", key: "ArrowDown" });
    ok(doc.activeElement === c2, "ArrowDown from a row's control focuses the next row");
    c2.dispatchEvent({ type: "keydown", key: "ArrowUp" });
    ok(doc.activeElement === c1, "ArrowUp focuses the previous row");
    c2.dispatchEvent({ type: "keydown", key: "End" });
    ok(doc.activeElement === rowNodeOf(container, "c3"), "End jumps to the last row");
    c2.dispatchEvent({ type: "keydown", key: "Home" });
    ok(doc.activeElement === c1, "Home jumps back to the first");

    c1.dispatchEvent({ type: "keydown", key: "Enter" });
    ok(calls.open.join() === "c1", "Enter on a focused row reopens it");
    c2.dispatchEvent({ type: "keydown", key: "Enter" });
    ok(calls.open.join() === "c1,c2", "…for whichever row is focused");

    // A row that is no longer visible drops the keyboard focus marker, so a
    // later arrow cannot walk to a row the operator cannot see.
    view.setEntries([entry("c5")]);
    view.render();
    ok(view.focusRow("c1") === false, "focusing a row that is not rendered is refused, not silently misapplied");
    view.focusRow("c5");
    ok(doc.activeElement === rowNodeOf(container, "c5"), "focusing a rendered row works");
  }

  console.log("== onRender: the panel's readouts follow every render, including debounced ones ==");
  {
    const doc = createDocument();
    const container = doc.createElement("div");
    const reports = [];
    const view = new HistoryListView({
      container,
      document: doc,
      debounceMs: 10,
      now: () => NOW,
      actions: { onRender: (report) => reports.push(report) }
    });
    view.setEntries([entry("c1", { title: "alpha" }), entry("c2", { title: "beta" })]);
    view.render();
    ok(reports.length === 1 && reports[0].total === 2 && reports[0].matched === 2, "the hook fires once per render with the report");
    view.setQuery("alpha");
    await new Promise((r) => setTimeout(r, 40));
    ok(reports.length === 2 && reports[1].matched === 1, "…including the render a debounced search produces on its own");
  }

  console.log("== render token: a slow refresh cannot roll the screen back over a newer one ==");
  {
    const { view, container } = buildView();
    const staleToken = view.nextRenderToken();
    view.setEntries([entry("c1", { title: "mới" })]);
    const newer = view.nextRenderToken();
    view.render({ token: newer });
    ok(view.report().rendered === 1, "the newer render applied");
    const before = rowNodeOf(container, "c1");
    view.setEntries([entry("c1", { title: "cũ" })]);
    const late = view.render({ token: staleToken });
    ok(late.stale === true, "the older refresh is reported as stale");
    ok(rowNodeOf(container, "c1") === before && rowNodeOf(container, "c1").children[1].children[0].children[0].textContent === "mới", "…and it did not overwrite what the newer render put on screen");
  }

  console.log("== grouping: pinned first, then local date buckets ==");
  {
    const rows = [
      entry("pin", { pinned: true, updatedAt: NOW - 40 * DAY }),
      entry("today", { updatedAt: NOW }),
      entry("yesterday", { updatedAt: NOW - DAY }),
      entry("week", { updatedAt: NOW - 3 * DAY }),
      entry("month", { updatedAt: NOW - 20 * DAY }),
      entry("older", { updatedAt: NOW - 90 * DAY })
    ];
    const groups = groupConversations(rows, { now: NOW });
    ok(groups.map((g) => g.key).join() === "pinned,today,yesterday,week,month,older", `groups appear in a fixed order (${groups.map((g) => g.key).join()})`);
    ok(groups[0].entries[0].conversationId === "pin", "a pin from 40 days ago is still in the first group — that is what pinning is for");
    ok(groups.every((g) => g.label), "every group carries a label");
    ok(dayBucket(NOW, NOW) === HISTORY_GROUP.TODAY && dayBucket(NOW - DAY, NOW) === HISTORY_GROUP.YESTERDAY, "dayBucket uses local day boundaries");
    ok(dayBucket(0, NOW) === HISTORY_GROUP.OLDER, "an entry with no timestamp falls into the oldest bucket rather than vanishing");

    const { view, container } = buildView({ pageSize: 10 });
    view.setEntries(rows);
    view.render();
    const headings = container.children.filter((child) => child.className === "section-heading history-group").map((child) => child.textContent);
    ok(headings.length === 6 && headings[0] === "Đã ghim", `the DOM shows one heading per non-empty group (${headings.join(" / ")})`);
  }

  console.log("== domain options and summary line are derived from what exists ==");
  {
    const rows = [entry("a", { hostname: "b.example" }), entry("b", { hostname: "a.example" }), entry("c", { hostname: "a.example" }), entry("d")];
    const options = domainOptions(rows);
    ok(options.length === 2 && options[0].value === "a.example" && options[1].label === "b.example (1)", "options are sorted, labelled with counts, and skip entries with no hostname");
    ok(rowSignature(entry("x", { title: "t" })) === rowSignature(entry("x", { title: "t" })), "the same data produces the same signature");
    ok(rowSignature(entry("x", { title: "t" })) !== rowSignature(entry("x", { title: "t2" })), "a changed title changes it");
    ok(rowSignature(entry("x", { title: "t", pinned: true })) !== rowSignature(entry("x", { title: "t" })), "…as does a pin");
    ok(formatRowSubtitle(entry("x", { hostname: "a.example" }), { locale: "vi-VN" }).includes("a.example"), "the subtitle carries the hostname");
    ok(entryBadges(entry("x", { stale: true, pinned: true })).map((b) => b.key).join() === "pinned,stale", "badges are data, in a stable order");
  }

  console.log("== export: metadata + transcript, both formats, order- and duplicate-independent ==");
  {
    const T0 = Date.UTC(2026, 8, 13, 10, 0, 0);
    const events = [
      { seq: 1, type: "run_created", runId: "r1", ts: T0 },
      { seq: 2, type: "run_started", runId: "r1", ts: T0 },
      { seq: 3, type: "stream_message", runId: "r1", ts: T0, message: { type: "assistant", message: { content: [{ type: "text", text: "Xin chào" }] } } },
      { seq: 4, type: "stream_message", runId: "r1", ts: T0, message: { type: "assistant", message: { content: [{ type: "tool_use", id: "tu1", name: "navigate", input: { url: "https://x" } }] } } },
      { seq: 5, type: "stream_message", runId: "r1", ts: T0, message: { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu1", is_error: false, content: "ok" }] } } },
      { seq: 6, type: "stream_message", runId: "r1", ts: T0, message: { type: "assistant", message: { content: [{ type: "text", text: "Đã điều hướng." }] } } },
      { seq: 7, type: "run_done", runId: "r1", ts: T0 }
    ];
    const summary = {
      conversationId: "conv-1",
      title: "Đọc báo cáo",
      hostname: "vnexpress.net",
      createdAt: T0,
      updatedAt: T0 + 1000,
      pinned: true,
      archived: false,
      interrupted: false,
      revision: 4
    };
    const prompts = { r1: "đọc bài báo này" };

    const messages = artifactMessages(transcriptMessages({ conversationId: "conv-1", events, prompts }).items);
    ok(messages.length === 2, `the transcript rebuilds as the user's turn and the assistant's (${messages.length} messages)`);
    ok(messages[0].role === "user" && messages[0].text === "đọc bài báo này", "the user's own text comes from the local prompt echo");
    ok(messages[1].role === "assistant" && messages[1].text === "Xin chàoĐã điều hướng.", "assistant text is concatenated in order");
    ok(messages[1].toolCalls.length === 1 && messages[1].toolCalls[0].name === "navigate" && messages[1].toolCalls[0].status === "succeeded", "tool activity is carried as data with its outcome");

    const md = buildConversationArtifact({ summary, events, prompts, format: "md", exportedAt: T0 });
    ok(md.format === EXPORT_FORMAT.MARKDOWN && /\.md$/.test(md.filename), `Markdown export produces a .md artifact (${md.filename})`);
    ok(md.filename.startsWith("browzy-doc-bao-cao-") && md.filename.includes("20260913"), "the filename is a slug of the title plus a local timestamp");
    ok(md.content.includes("# Đọc báo cáo") && md.content.includes("**Trang:** vnexpress.net") && md.content.includes("**Revision:** 4"), "the artifact carries the conversation's metadata");
    ok(md.content.includes("đọc bài báo này") && md.content.includes("Đã điều hướng."), "…and the full transcript");
    ok(/`navigate` \(succeeded\)/.test(md.content), "…including what the tools did");
    ok(md.eventCount === events.length && md.messageCount === 2, "the artifact reports what it contains");

    const json = buildConversationArtifact({ summary, events, prompts, format: "json", exportedAt: T0 });
    const parsed = JSON.parse(json.content);
    ok(json.mimeType.startsWith("application/json"), "the JSON artifact declares its type");
    ok(parsed.schemaVersion === EXPORT_SCHEMA_VERSION && parsed.conversation.conversationId === "conv-1" && parsed.conversation.pinned === true, "the JSON artifact carries versioned metadata");
    ok(parsed.messages.length === 2 && parsed.messages[1].toolCalls[0].name === "navigate", "…and the same messages as structured data");
    ok(parsed.transcript.eventCount === events.length && parsed.transcript.source === "host", "…and where the transcript came from");
    ok(parsed.messages[1].ts === T0 && parsed.messages[0].ts === null, "the assistant turn is stamped from the host's own event time, and the user turn carries no invented timestamp");

    // The host pages the transcript NEWEST FIRST; the builder must not care.
    const reversed = buildConversationArtifact({ summary, events: [...events].reverse(), prompts, format: "json", exportedAt: T0 });
    ok(reversed.content === json.content, "a newest-page-first event list produces byte-identical output to an oldest-first one");
    const again = buildConversationArtifact({ summary, events, prompts, format: "json", exportedAt: T0 });
    ok(again.content === json.content, "…and exporting the same unchanged conversation twice produces the same bytes");
    const doubled = buildConversationArtifact({ summary, events: [...events, ...events], prompts, format: "json", exportedAt: T0 });
    ok(JSON.parse(doubled.content).messages.length === 2, "a page delivered twice cannot duplicate a message (sequence watermarks)");
    ok(events[0].seq === 1 && events.length === 7, "the builder did not mutate the caller's event list");

    // A prompt this profile never cached is exported as the placeholder it is.
    const incomplete = buildConversationArtifact({ summary, events, prompts: null, format: "md", exportedAt: T0 });
    ok(incomplete.incompleteMessages === 1 && /không có nội dung tin nhắn/.test(incomplete.content), "an uncached prompt is marked incomplete rather than exported as a blank turn");

    ok(normalizeExportFormat("MD") === "md" && normalizeExportFormat("markdown") === "md" && normalizeExportFormat(" Json ") === "json", "the format names a person types are accepted");
    ok(normalizeExportFormat("pdf") === null, "an unsupported format is refused rather than guessed at");
    let threw = false;
    try {
      buildConversationArtifact({ summary, events, format: "pdf" });
    } catch {
      threw = true;
    }
    ok(threw, "building with an unsupported format throws instead of silently producing Markdown");
    ok(slugify("  Đọc Báo cáo: 2026 / Q3!  ") === "doc-bao-cao-2026-q3", `titles become filename-safe slugs (${slugify("Đọc Báo cáo: 2026 / Q3!")})`);
    ok(exportFilename({ title: "" }, { format: "md", at: T0 }).includes("cuoc-tro-chuyen"), "a conversation without a title still gets a usable filename");
    ok(exportFilename({ title: "x" }, { format: "md", at: T0 }) !== exportFilename({ title: "x" }, { format: "json", at: T0 }), "the two formats do not collide on disk");
  }

  console.log("== empty conversations render no row: the filter sidepanel.js puts in front of the view ==");
  {
    // The shipped predicate, extracted from sidepanel.js the same way the
    // older-page trigger below is: this is the single display decision
    // refreshHistoryView() makes about the list it hands the view.
    const panelPath = path.join(ROOT, "extension", "sidepanel", "sidepanel.js");
    const isListable = compile(extractFunction("isListableHistoryEntry", panelPath), {}, "isListableHistoryEntry");
    ok(isListable({ hasData: false }) === false, "a conversation KNOWN to hold nothing is not listed");
    ok(isListable({ hasData: true }) === true, "one with data is listed");
    ok(isListable({}) === true, "an entry without the field (an older companion, an older cached row) is listed — unknown is not empty");
    ok(isListable({ hasData: null }) === true, "…and neither is an explicitly unknown value");
    ok(isListable(null) === false, "a missing entry is not a row");

    // The whole chain with the REAL cache and the REAL view: exactly the
    // conversation the host graded as empty disappears, and nothing else
    // does — including the orphan the host no longer reports.
    const store = new HistoryStore({ storage: memStorage() });
    await store.upsert({ conversationId: "orphan", title: "chỉ cục bộ", updatedAt: NOW - 3000 });
    await store.reconcile([
      { conversationId: "empty", title: "Trống", updatedAt: NOW, hasData: false },
      { conversationId: "used", title: "Đã hỏi", updatedAt: NOW - 1000, hasData: true },
      { conversationId: "old-host", title: "Máy chủ cũ", updatedAt: NOW - 2000 }
    ]);
    const { view, container } = buildView({ pageSize: 10 });
    const feed = async () => (await store.list()).filter(isListable);

    view.setEntries(await feed());
    let report = view.render();
    ok(rowNodeOf(container, "empty") === null, "the known-empty conversation renders no row");
    ok(!!rowNodeOf(container, "used") && !!rowNodeOf(container, "old-host"), "a conversation with data renders — and so does one described by a summary without the field");
    ok(
      report.total === 3 && report.matched === 3 && report.rendered === 3,
      `the counts describe the same filtered feed as the rows (total ${report.total}, matched ${report.matched}, rendered ${report.rendered})`
    );
    const orphanRow = rowNodeOf(container, "orphan");
    ok(!!orphanRow, "a stale/orphan entry still renders");
    ok(orphanRow.children[1].children[0].children[1].children.some((p) => p.textContent === "Không còn trên máy chủ"), "…with its stale badge, unchanged");

    // Nothing but empty conversations: the screen says there is no history,
    // not that a filter matched nothing, and it counts nothing.
    view.setEntries([await store.get("empty")].filter(isListable));
    report = view.render();
    ok(rowNodes(container).length === 0, "with only empty conversations there are no rows at all");
    ok(report.total === 0 && report.matched === 0, "…and nothing is counted");
    ok(report.state.kind === HISTORY_STATE.EMPTY && stateNode(container).dataset.state === HISTORY_STATE.EMPTY, "…so the screen shows the empty state, not a no-match filter result");
    ok(/Chưa có cuộc trò chuyện nào/.test(stateNode(container).textContent), `the empty state's own message is what renders ("${stateNode(container).textContent}")`);

    // And the row comes straight back once the conversation has data: this is
    // the panel's own persist after the first question.
    await store.upsert({ conversationId: "empty", hasData: true });
    view.setEntries(await feed());
    report = view.render();
    ok(!!rowNodeOf(container, "empty") && report.total === 4, "the first question's persist brings the row back");
  }

  console.log("== the transcript's older-page trigger (tasks.md 3.2's UI half) ==");
  {
    // Extracted from the shipped sidepanel.js (test/_extract.mjs's brace
    // matcher, the same technique test/sidepanel-permission-mode-retry.test.mjs
    // uses): this predicate is the one decision of the older-page feature that
    // can be reasoned about without a DOM, since sidepanel.js as a whole
    // touches `document`/`chrome.*` at module scope.
    const shouldLoad = compile(
      extractFunction("shouldLoadOlderTranscript", path.join(ROOT, "extension/sidepanel/sidepanel.js")),
      {},
      "shouldLoadOlderTranscript"
    );
    ok(shouldLoad({ scrollTop: 0, hasOlder: true, loading: false }) === true, "at the very top, with more history and nothing in flight: load");
    ok(shouldLoad({ scrollTop: 600, hasOlder: true, loading: false }) === false, "scrolling anywhere else does not load");
    ok(shouldLoad({ scrollTop: 0, hasOlder: false, loading: false }) === false, "a conversation with no older history never loads");
    ok(shouldLoad({ scrollTop: 0, hasOlder: true, loading: true }) === false, "and a load already in flight is not started twice");
    ok(shouldLoad({ scrollTop: 60, hasOlder: true, loading: false }) === false, "just below the threshold is still not the top");
  }

  console.log("== the shipped files this wave edits parse as ES modules ==");
  {
    for (const rel of [
      "extension/sidepanel/history-view.js",
      "extension/sidepanel/history-export.js",
      "extension/sidepanel/panel-controller.js",
      "extension/sidepanel/sidepanel.js"
    ]) {
      const source = fs.readFileSync(path.join(ROOT, rel), "utf8");
      const tmp = path.join(os.tmpdir(), `browzy-history-parse-${process.pid}-${path.basename(rel)}.mjs`);
      fs.writeFileSync(tmp, source, "utf8");
      let error = null;
      try {
        const res = spawnSync(process.execPath, ["--check", tmp], { encoding: "utf8" });
        if (res.status !== 0) error = (res.stderr || "").trim().split("\n").slice(0, 3).join(" ");
      } finally {
        try {
          fs.unlinkSync(tmp);
        } catch {}
      }
      ok(!error, `${rel} parses as a module${error ? ` — ${error}` : ""}`);
    }
  }

  console.log(fail === 0 ? "\nALL SIDEPANEL HISTORY-VIEW TESTS PASSED" : `\n${fail} FAILED`);
  process.exit(fail ? 1 : 0);
}

main();
