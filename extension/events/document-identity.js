// Document identity primitive (design.md "upgrade-agent-reliability-and-
// workflows" decision 6 / tasks.md 1.2-1.3). This module is the P0 minimum
// document binding and execution nonce, plus correlated navigation
// semantics, that later work (send, lease acquisition, read, mutation,
// approval validation — groups 2/3/7) is meant to build on. It does NOT
// wire itself into any of those consumers: this task defines the primitive
// and proves it against the eight scenarios in tasks.md 1.4, nothing more.
//
// Deliberately a PURE module: no `chrome.*` reference anywhere in this
// file, `now`/`randomId` are injectable, so it can be imported directly by
// a plain `node` test (see test/document-identity.test.mjs) the same way
// extension/events/action-events.js already is. extension/background.js
// wires this into `chrome.tabs.onUpdated` and the content-script handshake;
// extension/content.js supplies the per-document nonce this module never
// invents on its own.
//
// Evidence this design is built on: `host/agent/spike/gates/
// gate-1.1-document-identity.mjs` and
// `plans/reports/osf-apply-260909-1642-document-identity-gate.md` (task
// 1.1's investigatory gate). Concretely:
//
//   - G0a: `chrome.webNavigation` (and its `documentId`/`frameId` fields)
//     is UNREACHABLE — the permission is not declared, and adding it is a
//     real manifest/CWS-review-surface change explicitly out of this
//     task's scope. Nothing in this module ever references
//     `chrome.webNavigation`.
//   - G0b: `extension/content.js` runs ONLY in the top-level main frame
//     (`all_frames:false`). There is no content-script half of the
//     handshake for any sub-frame, so a sub-frame's identity can never be
//     CONFIRMED here — `getBinding()`/`requireBinding()` return null/
//     `{ok:false}` for any `frameId !== 0`, never a fabricated binding.
//   - G0c: the existing best-effort `DocumentIdTracker` (action-events.js)
//     only bumps on `changeInfo.url`, which Chrome does NOT set for a
//     same-URL reload — a same-URL reload is silently invisible to it. The
//     `onNavigationSignal()` contract below is written so a caller can
//     drive it from BOTH `changeInfo.url` and `changeInfo.status ===
//     "loading"` (background.js does both), which closes that gap.
//   - G1/G2: a same-URL reload IS a new document (new loaderId, in-page
//     nonce lost) and an SPA `pushState` route change is NOT (loaderId
//     stable, in-page nonce unchanged) at the real browser level — but
//     Chrome's tabs API still fires `changeInfo.url` for a pushState route
//     change (the address bar genuinely changes), so decision 6's own
//     wording ("treat SPA route/document changes as new revisions") is
//     honored by bumping `generation` (a revision counter) on an SPA route
//     change while `docNonce` (the real document identity) stays stable —
//     see the two-level design below.
//   - G3/G4: an in-memory/session-lifetime value is correctly lost on tab
//     close+reopen and on a real browser process restart; `localStorage`
//     (disk-backed) wrongly survives both. `docNonce` must never be
//     content.js's own `localStorage`-backed value — see content.js's own
//     comment at its nonce definition.
//   - G6: the raw CDP/browser signal alone cannot reliably distinguish "our
//     own privileged navigate" from "the page's own script redirecting
//     itself" — a content-script-issued `location.href=` would look
//     identical to an unrelated hijack. Authorization must be established
//     at the application layer: `beginAuthorizedNavigation()` mints a
//     correlation BEFORE the caller's own privileged `chrome.tabs.update`/
//     `create` call (never from page/content-script context), and
//     `onNavigationSignal()` consumes it at commit time against the
//     OBSERVED destination — never an exact match against the requested
//     URL, since a legitimate redirect chain is expected.
//
// Two independent, intentionally separate signals per tab:
//   - `generation`: a monotonic revision counter, bumped on EVERY
//     browser-visible navigation-start signal (a real navigation/reload
//     OR an SPA route change).
//   - `docNonce`: the browser DOCUMENT's own identity, confirmed only via
//     the content-script handshake (`getDocumentIdentity`). Stable across
//     an SPA route change; changes only on a genuine new document.
//
// A binding is CONFIRMED only once a handshake response has been recorded
// for the CURRENT generation. An unconfirmed binding is never treated as
// usable identity — `requireBinding()` fails closed instead of falling
// back to tabId+url alone (decision 6's explicit mandate).
//
// Persistent workflow domain/scope constraints (design.md decision 8, a
// LATER, longer-lived structure a workflow definition owns) are
// deliberately kept OUT of this module entirely: `beginAuthorizedNavigation`
// accepts a caller-injected `isDestinationAllowed` predicate and never
// stores it, and neither a `DocumentBinding` nor an execution-nonce record
// carries any domain/scope field. Different lifetimes, never conflated.

export class DocumentBindingTracker {
  constructor({ now = () => Date.now() } = {}) {
    this._now = now;
    this._tabs = new Map(); // tabId -> { generation, url, docNonce, confirmedGeneration }
    this._pendingNav = new Map(); // tabId -> { requestedUrl, isDestinationAllowed, expiresAt, correlationId }
    this._replacementListeners = new Set();
  }

  /** Subscribe to "this tab's document was replaced without a matching
   * authorization" events. Returns an unsubscribe function. Listener
   * failures are isolated from each other and from the caller, matching
   * action-events.js's `onActionEvent` discipline. */
  onReplacement(fn) {
    this._replacementListeners.add(fn);
    return () => this._replacementListeners.delete(fn);
  }

  _emitReplacement(tabId, info) {
    for (const fn of this._replacementListeners) {
      try {
        fn({ tabId, ...info });
      } catch {
        // one bad listener must never break tracking for every other tab
      }
    }
  }

  _record(tabId) {
    let r = this._tabs.get(tabId);
    if (!r) {
      r = { generation: 0, url: null, docNonce: null, confirmedGeneration: -1 };
      this._tabs.set(tabId, r);
    }
    return r;
  }

  /**
   * Call on every browser-visible navigation-start signal for a tab. The
   * intended caller (background.js's `chrome.tabs.onUpdated` listener)
   * drives this from `changeInfo.url` (fires for both a cross-URL
   * navigation and an SPA `pushState`/`replaceState` route change) OR
   * `changeInfo.status === "loading"` (fires for a real navigation/reload,
   * INCLUDING a same-URL reload, which never sets `changeInfo.url` at all —
   * this is the concrete fix for gate-1.1's G0c finding).
   *
   * Always bumps `generation` and clears the confirmed `docNonce` (identity
   * is unconfirmed until the next handshake succeeds), REGARDLESS of
   * whether this transition turns out to be authorized — every consumer
   * must still re-confirm fresh state before trusting it (decision 6:
   * "Revalidate at send, lease acquisition, read, and mutation").
   *
   * Returns `{authorized, reason}` — `reason` is `null` when authorized,
   * else `"unexpected"` (no matching/live correlation) or
   * `"destination_rejected"` (a correlation existed but the OBSERVED URL
   * failed the caller's own `isDestinationAllowed` predicate). Either
   * non-authorized outcome fires `onReplacement()`.
   */
  onNavigationSignal(tabId, { url = null } = {}) {
    if (tabId === undefined || tabId === null) return { authorized: false, reason: "missing_tab" };
    const r = this._record(tabId);
    const previousBinding = this._snapshot(tabId, r);
    r.generation += 1;
    r.url = url != null ? url : r.url;
    r.docNonce = null;

    const pending = this._pendingNav.get(tabId);
    let authorized = false;
    let reason = "unexpected";
    if (pending && pending.expiresAt > this._now()) {
      const observedUrl = url != null ? url : r.url;
      if (pending.isDestinationAllowed(observedUrl)) {
        authorized = true;
        reason = null;
        // Window stays open (a redirect chain may still be in flight) until
        // it expires on its own TTL — deliberately not closed on the first
        // passing check.
      } else {
        reason = "destination_rejected";
        this._pendingNav.delete(tabId); // reject -> close the window now
      }
    } else if (pending) {
      this._pendingNav.delete(tabId); // expired
    }

    if (!authorized) {
      this._emitReplacement(tabId, { previousBinding, reason });
    }
    return { authorized, reason };
  }

  /**
   * Record the content-script handshake response (extension/content.js's
   * `getDocumentIdentity`) for the CURRENT generation. `docNonce` must come
   * from the content script's own in-memory value — this module never
   * fabricates one.
   */
  confirmHandshake(tabId, { url = null, docNonce } = {}) {
    if (tabId === undefined || tabId === null || !docNonce) return null;
    const r = this._record(tabId);
    r.url = url != null ? url : r.url;
    r.docNonce = docNonce;
    r.confirmedGeneration = r.generation;
    return this._snapshot(tabId, r);
  }

  _snapshot(tabId, r) {
    if (!r) return null;
    const confirmed = r.confirmedGeneration === r.generation && r.docNonce != null;
    return {
      tabId,
      frameId: 0,
      generation: r.generation,
      url: r.url,
      docNonce: confirmed ? r.docNonce : null,
      confirmed
    };
  }

  /** Never returns a binding for anything but the top-level frame (G0b:
   * content.js has no presence in any sub-frame today, so there is no
   * content-script half of the handshake to confirm one — this NEVER
   * fabricates a sub-frame identity from the tab-level signal alone). */
  getBinding(tabId, { frameId = 0 } = {}) {
    if (frameId !== 0) return null;
    const r = this._tabs.get(tabId);
    if (!r) return null;
    return this._snapshot(tabId, r);
  }

  /** The explicit fail-closed gate (decision 6): `{ok:true, binding}` only
   * for a REAL, content-script-confirmed binding at the CURRENT generation;
   * `{ok:false, reason}` otherwise. Never a tabId+url-only fallback. */
  requireBinding(tabId, opts) {
    const frameId = opts && opts.frameId !== undefined ? opts.frameId : 0;
    if (frameId !== 0) return { ok: false, reason: "subframe_unsupported" };
    const r = this._tabs.get(tabId);
    if (!r) return { ok: false, reason: "unknown_tab" };
    const binding = this._snapshot(tabId, r);
    if (!binding.confirmed) return { ok: false, reason: "unconfirmed" };
    return { ok: true, binding };
  }

  /** Tab closed — drop its generation/nonce/pending-navigation state so
   * nothing lingers or is reused for a recycled tabId. */
  clear(tabId) {
    this._tabs.delete(tabId);
    this._pendingNav.delete(tabId);
  }

  /**
   * Mint the correlation for a PRIVILEGED, background-script-issued
   * navigate/create call. Per gate-1.1 finding G6/decision 6: this must
   * only ever be called from background.js's own privileged `chrome.tabs.
   * update`/`create` call site, never from page/content-script context —
   * a content-script-issued navigation is indistinguishable from a hijack
   * at the browser layer, so calling this from that context would defeat
   * the whole mechanism.
   *
   * `isDestinationAllowed` is an INJECTED predicate evaluated against the
   * OBSERVED committed URL at commit time (never an exact match against
   * `requestedUrl` — redirects are real and expected) and is never stored
   * as persistent state; it defaults to allow-all, matching today's
   * `navigate()` tool, which has no domain/scope constraint of its own
   * beyond the existing `isInGroup` tab-scope check. A real domain/scope
   * predicate is a workflow/approval concern (design.md decision 8, out of
   * this task's scope) supplied by that caller later.
   */
  beginAuthorizedNavigation(tabId, requestedUrl, { isDestinationAllowed = () => true, ttlMs = 15000, correlationId = null } = {}) {
    if (tabId === undefined || tabId === null) return { ok: false, reason: "missing_tab" };
    const id = correlationId || `nav_${tabId}_${this._now()}_${Math.random().toString(36).slice(2, 8)}`;
    this._pendingNav.set(tabId, { requestedUrl, isDestinationAllowed, expiresAt: this._now() + ttlMs, correlationId: id });
    return { ok: true, correlationId: id };
  }
}

// --- Execution nonce ---------------------------------------------------
//
// A SEPARATE concept from `docNonce` above (the document's own identity)
// and from any persistent workflow domain/scope constraint (decision 6:
// "Separate persistent workflow domain/scope constraints from per-execution
// document and approval nonces" — different lifetimes: a workflow's
// domain/scope constraint outlives many executions; an execution nonce is
// single-use, minted fresh for one send/lease/read/mutation/approval check,
// and goes stale the moment the document binding it was minted against no
// longer matches — including a same-document SPA revision bump, which
// decision 6 also treats as requiring revalidation).
let executionNonceCounter = 0;

/** Mint an execution nonce bound to a CONFIRMED document binding snapshot.
 * Fails closed (returns null) if the binding is missing or unconfirmed — a
 * caller must never mint a nonce against unconfirmed/URL-only identity. */
export function mintExecutionNonce(binding, { now = () => Date.now() } = {}) {
  if (!binding || !binding.confirmed || !binding.docNonce) return null;
  executionNonceCounter += 1;
  return {
    nonce: `xn_${executionNonceCounter.toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    tabId: binding.tabId,
    generation: binding.generation,
    docNonce: binding.docNonce,
    url: binding.url,
    mintedAt: now()
  };
}

/** Verify a previously minted execution nonce against the CURRENT binding.
 * Any mismatch — including "no current binding" (tab closed) or "current
 * binding exists but is unconfirmed" (mid-navigation, not yet
 * re-handshaken) — is invalid; identity is never re-derived from URL
 * alone. */
export function verifyExecutionNonce(record, currentBinding) {
  if (!record) return { valid: false, reason: "missing_nonce" };
  if (!currentBinding) return { valid: false, reason: "tab_gone" };
  if (!currentBinding.confirmed) return { valid: false, reason: "unconfirmed" };
  if (currentBinding.tabId !== record.tabId) return { valid: false, reason: "tab_mismatch" };
  if (currentBinding.docNonce !== record.docNonce || currentBinding.generation !== record.generation) {
    return { valid: false, reason: "document_replaced" };
  }
  return { valid: true, reason: null };
}

/** Two binding snapshots identify the SAME real document iff the tab and
 * the content-script-confirmed docNonce match — never url alone (decision
 * 6's fail-closed mandate), and never generation alone (an SPA route
 * change bumps generation for the SAME document — see the module header). */
export function isSameDocument(a, b) {
  if (!a || !b) return a === b;
  return a.tabId === b.tabId && a.docNonce != null && a.docNonce === b.docNonce;
}
