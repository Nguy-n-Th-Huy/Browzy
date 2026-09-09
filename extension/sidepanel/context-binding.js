// Detects whether the user's own text plausibly refers to the current page,
// and builds the STRUCTURED metadata payload the panel attaches to a bound
// context (design.md section 5b / specs/agent-browser-runtime.md "Live
// current-page reading"):
//
//   "For a request referring to the current article, provide the bound
//   context as structured trusted metadata and call live page extraction
//   (get_page_text/read_page as appropriate) before analysis... Context
//   metadata alone SHALL not count as reading."
//
// This module does NOT touch the wire "prompt" field at all. Historically it
// composed a `<bound_page_context>` block directly into the user's prompt
// text because host/agent/companion.js and host/agent/tools/query-options.js
// exposed no separate channel for trusted metadata — that deviated from
// design.md section 5 ("User messages and page/tool content remain
// distinctly typed") and 5b ("structured trusted metadata"). Both files now
// accept a dedicated `context` field on the `start` envelope
// (panel-controller.js's `sendMessage()` sends it alongside — never inside —
// `prompt`), which host/agent/tools/query-options.js renders into the SDK's
// own `systemPrompt` Options field (see that file's header for the exact
// sdk.d.ts citation). This file's job is only to produce that structured
// object; the host owns turning it into text.
//
// Two independent decisions:
//   1. Whenever a bound context exists at Send time, attach its metadata —
//      unconditionally. This is cheap and safe: a model that has no reason
//      to read the page simply never calls get_page_text/read_page, and the
//      metadata itself is explicitly labeled (host-side) as non-content
//      (title/URL/hostname only), so merely attaching it is not "reading"
//      anything.
//   2. When the user's own words plausibly refer to "this page" / "this
//      article" (English or Vietnamese — the acceptance fixture is
//      Vietnamese), the metadata's `mustRead` flag escalates the host-
//      rendered instruction from "you may read this" to an explicit "call
//      get_page_text or read_page on this tabId before answering — metadata
//      alone is not reading". Keyword detection is a heuristic and is
//      deliberately over-inclusive (false positives are harmless — an
//      irrelevant instruction to read a page a message never asked about
//      costs nothing but a wasted tool call the model can decline to make
//      sense of; a false negative would mean the fixture silently degrades
//      to metadata-only, which is the one failure mode this task must not
//      exhibit).

const CURRENT_PAGE_PATTERNS = [
  // Vietnamese — covers the acceptance fixture ("đọc bài viết này và phân
  // tích") and its common variants.
  /bài viết này/i,
  /bài này/i,
  /trang này/i,
  /trang hiện tại/i,
  /nội dung (này|trang)/i,
  /đọc bài/i,
  /đọc trang/i,
  /tóm tắt (bài|trang)/i,
  /phân tích (bài|trang|nội dung)/i,
  // English
  /\bthis page\b/i,
  /\bthis article\b/i,
  /\bcurrent page\b/i,
  /\bcurrent article\b/i,
  /\bread this\b/i,
  /\bsummarize this\b/i,
  /\banalyze this\b/i,
  /\bsummarise this\b/i
];

/** Heuristic-only, over-inclusive by design — see file header. */
export function referencesCurrentPage(text) {
  return typeof text === "string" && CURRENT_PAGE_PATTERNS.some((re) => re.test(text));
}

/**
 * Build the structured trusted-metadata object for a bound page context, or
 * `null` when nothing is bound. This is a PLAIN DATA object (no markup, no
 * prose) — it travels over the wire as the `start` envelope's `context`
 * field, distinct from `prompt`, and is only ever rendered into text on the
 * host side (host/agent/tools/query-options.js's
 * `renderPageContextSystemPrompt()`).
 *
 * @param {object} params
 * @param {string} params.text - the user's own literal composer text, used
 *   only to decide `mustRead` — never mutated, never included in the
 *   returned object.
 * @param {object|null} params.context - a PageContextTracker snapshot
 *   ({tabId, url, title, hostname, favIconUrl, pinned, restricted, revision,
 *   doc}), or null when no page context is bound (removed / never established).
 * @param {number} [params.boundAt] - capture time (ms epoch); defaults to now.
 * @returns {{tabId:number, url:string|null, title:string|null,
 *   hostname:string|null, revision:number, boundAt:number,
 *   restricted:boolean, pinned:boolean, mustRead:boolean,
 *   docGeneration:number|null, docConfirmed:boolean, docNonce:string|null}|null}
 *
 * Tasks.md 7.1/7.2: the minimum document identity rides along (`doc*`
 * fields, straight from the snapshot's own `doc` block). `docNonce` is
 * panel-observed evidence for the host's approval binding — never invented
 * here (null unless the snapshot's doc channel confirmed it). A null
 * `docGeneration` means the doc channel was unavailable for this send: the
 * host must apply its own fail-closed read/mutation guards rather than treat
 * tabId+url as confirmed identity.
 */
export function buildContextMetadata({ text, context, boundAt } = {}) {
  if (!context || context.tabId == null) return null;
  const doc = context.doc && typeof context.doc === "object" ? context.doc : null;
  return {
    tabId: context.tabId,
    url: context.url || null,
    title: context.title || null,
    hostname: context.hostname || null,
    revision: context.revision ?? 0,
    boundAt: boundAt ?? Date.now(),
    restricted: !!context.restricted,
    pinned: !!context.pinned,
    mustRead: referencesCurrentPage(text),
    // Minimum document identity (tasks.md 7.1/7.2) — see the docstring above
    // for the null/confirmed contract. Captured content keeps THESE values
    // as its original source identity even after later refreshes.
    docGeneration: doc && doc.generation !== undefined ? doc.generation : null,
    docConfirmed: doc ? doc.confirmed === true : false,
    docNonce: doc && doc.confirmed === true && doc.docNonce ? doc.docNonce : null
  };
}
