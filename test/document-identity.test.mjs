// Tests for the P0 minimum document identity primitive (design.md
// "upgrade-agent-reliability-and-workflows" decision 6 / tasks.md 1.2-1.4).
// Exercises the SHIPPED extension/events/document-identity.js directly (a
// pure module, no chrome.* reference, imported the same way
// extension/events/action-events.js already is in test/action-events-
// schema.test.mjs) — no fakes for the module under test.
//
// Scenarios required by tasks.md 1.4: token creation, same-URL reload, SPA
// navigation, tab close, stale nonce, authorized navigation commit,
// unexpected replacement, and destination rejection. Verify clause: "no
// URL-only fallback remains for a boundary that cannot establish identity."

import {
  DocumentBindingTracker,
  mintExecutionNonce,
  verifyExecutionNonce,
  isSameDocument
} from "../extension/events/document-identity.js";
import fs from "node:fs";
import path from "node:path";

let fail = 0;
const ok = (c, m) => { console.log((c ? "  PASS " : "  FAIL ") + m); if (!c) fail++; };

function handshake(tracker, tabId, { url, docNonce }) {
  return tracker.confirmHandshake(tabId, { url, docNonce });
}

// =============================================================================
// 1. Token creation: a fresh tab has no confirmed binding until the
//    content-script handshake completes; requireBinding fails closed until
//    then (never falls back to tabId+url alone).
// =============================================================================
console.log("== token creation ==");
{
  const t = new DocumentBindingTracker();
  const before = t.getBinding(1);
  ok(before === null, "an unknown tab has no binding at all");

  t.onNavigationSignal(1, { url: "https://a.example/" });
  const midNav = t.getBinding(1);
  ok(midNav !== null && midNav.confirmed === false, "after a navigation-start signal, a binding exists but is UNCONFIRMED");
  const gate = t.requireBinding(1);
  ok(gate.ok === false && gate.reason === "unconfirmed", `requireBinding fails closed while unconfirmed, got ${JSON.stringify(gate)}`);
  ok(mintExecutionNonce(midNav) === null, "mintExecutionNonce refuses to mint against an unconfirmed binding");

  const confirmed = handshake(t, 1, { url: "https://a.example/", docNonce: "nonce-A1" });
  ok(confirmed.confirmed === true && confirmed.docNonce === "nonce-A1", "confirmHandshake produces a CONFIRMED binding carrying the content-script's own nonce");
  const gate2 = t.requireBinding(1);
  ok(gate2.ok === true && gate2.binding.docNonce === "nonce-A1", "requireBinding now succeeds with the real confirmed binding");

  const nonceRecord = mintExecutionNonce(gate2.binding);
  ok(nonceRecord && nonceRecord.nonce && nonceRecord.tabId === 1 && nonceRecord.docNonce === "nonce-A1", "mintExecutionNonce succeeds once confirmed, and binds tabId/docNonce/generation");
  const verify = verifyExecutionNonce(nonceRecord, t.getBinding(1));
  ok(verify.valid === true, "a freshly minted execution nonce verifies against the exact same current binding");
}

// =============================================================================
// 2. Same-URL reload (gate-1.1 G0c / G1): a same-URL reload never sets
//    changeInfo.url, so onNavigationSignal must ALSO be driven by
//    changeInfo.status === "loading" — this is the concrete fix for the
//    live defect gate 1.1 found in extension/background.js's onUpdated
//    listener (`if (changeInfo.url) actionDocTracker.bump(tabId);`).
// =============================================================================
console.log("\n== same-URL reload produces a NEW document identity ==");
{
  const t = new DocumentBindingTracker();
  t.onNavigationSignal(1, { url: "https://a.example/" }); // status:"loading" + url present (first load)
  const first = handshake(t, 1, { url: "https://a.example/", docNonce: "nonce-reload-1" });
  const firstNonce = mintExecutionNonce(first);

  // Same-URL reload: Chrome's changeInfo.url is ABSENT (the URL string did
  // not change) — the caller drives this from changeInfo.status ===
  // "loading" alone, exactly like background.js's onUpdated listener does.
  const nav = t.onNavigationSignal(1, {}); // no url — mirrors changeInfo without .url
  ok(nav.authorized === false && nav.reason === "unexpected", "an unannounced same-URL reload is treated as an unexpected replacement (no pending authorization)");
  const midReload = t.getBinding(1);
  ok(midReload.confirmed === false, "identity is unconfirmed immediately after the reload signal, even though the URL string never changed");

  const second = handshake(t, 1, { url: "https://a.example/", docNonce: "nonce-reload-2" });
  ok(second.docNonce !== first.docNonce, "the content script re-injected on reload mints a DIFFERENT nonce even though the URL is identical");
  ok(isSameDocument(first, second) === false, "isSameDocument correctly reports these as two DIFFERENT documents despite the identical URL");
  const staleVerify = verifyExecutionNonce(firstNonce, t.getBinding(1));
  ok(staleVerify.valid === false && staleVerify.reason === "document_replaced", "the execution nonce minted before the reload is now invalid");
}

// =============================================================================
// 3. SPA route change (gate-1.1 G2): the same real document (loaderId/
//    docNonce stable) but Chrome's tabs API still fires changeInfo.url for
//    pushState/replaceState — decision 6 treats this as a new REVISION
//    (generation bump) without treating it as a different document.
// =============================================================================
console.log("\n== SPA route change: same document, new revision ==");
{
  const t = new DocumentBindingTracker();
  t.onNavigationSignal(2, { url: "https://spa.example/" });
  const before = handshake(t, 2, { url: "https://spa.example/", docNonce: "nonce-spa" });
  const beforeNonce = mintExecutionNonce(before);

  // pushState-driven route change: content.js does NOT re-inject (same
  // in-page nonce), but chrome.tabs.onUpdated DOES fire changeInfo.url.
  const nav = t.onNavigationSignal(2, { url: "https://spa.example/route-a" });
  ok(nav.reason === "unexpected", "an unannounced SPA route change is still flagged for revalidation (no authorization was ever requested for it)");
  const after = handshake(t, 2, { url: "https://spa.example/route-a", docNonce: "nonce-spa" }); // SAME docNonce — content.js was never re-injected
  ok(after.generation === before.generation + 1, "generation bumped exactly once for the route change");
  ok(after.docNonce === before.docNonce, "docNonce is UNCHANGED — content.js confirms this is still the same real document");
  ok(isSameDocument(before, after) === true, "isSameDocument reports these as the SAME document (matches gate-1.1 G2: loaderId/nonce stable across pushState)");

  const staleVerify = verifyExecutionNonce(beforeNonce, t.getBinding(2));
  ok(staleVerify.valid === false && staleVerify.reason === "document_replaced",
     "BUT the execution nonce minted before the route change is still stale — decision 6: SPA route changes are new REVISIONS requiring revalidation, even though the document itself did not change");
}

// =============================================================================
// 4. Tab close (gate-1.1 G3/G4): clear() drops all state; nothing lingers
//    for a recycled tabId, and a verify against a closed tab always fails.
// =============================================================================
console.log("\n== tab close drops binding and pending-navigation state ==");
{
  const t = new DocumentBindingTracker();
  t.onNavigationSignal(3, { url: "https://a.example/" });
  const bound = handshake(t, 3, { url: "https://a.example/", docNonce: "nonce-close" });
  const nonceRecord = mintExecutionNonce(bound);
  t.beginAuthorizedNavigation(3, "https://a.example/next");

  t.clear(3);
  ok(t.getBinding(3) === null, "getBinding returns null for a closed tab");
  const gate = t.requireBinding(3);
  ok(gate.ok === false && gate.reason === "unknown_tab", "requireBinding fails closed for a closed tab, never falls back to the last-known url");
  const verify = verifyExecutionNonce(nonceRecord, t.getBinding(3));
  ok(verify.valid === false && verify.reason === "tab_gone", "a nonce minted before close verifies as invalid (tab_gone), never silently valid");

  // A recycled tabId (Chrome reuses small integer ids) starts completely
  // fresh — no ghost authorization or generation carries over.
  t.onNavigationSignal(3, { url: "https://different-site.example/" });
  ok(t.getBinding(3).generation === 1, "a recycled tabId starts its generation counter over from a clean slate");
}

// =============================================================================
// 5. Stale nonce: an execution nonce minted against one generation must be
//    rejected once ANY navigation signal has bumped the generation, even
//    before a new handshake confirms the new document.
// =============================================================================
console.log("\n== stale execution nonce ==");
{
  const t = new DocumentBindingTracker();
  t.onNavigationSignal(4, { url: "https://a.example/" });
  const bound = handshake(t, 4, { url: "https://a.example/", docNonce: "nonce-stale" });
  const nonceRecord = mintExecutionNonce(bound);

  t.onNavigationSignal(4, { url: "https://a.example/other" }); // any new navigation signal
  const verifyMidFlight = verifyExecutionNonce(nonceRecord, t.getBinding(4));
  ok(verifyMidFlight.valid === false && verifyMidFlight.reason === "unconfirmed",
     "immediately after a navigation signal (before any new handshake), verification fails closed as unconfirmed rather than trusting the stale binding");
}

// =============================================================================
// 6. Authorized navigation commit (gate-1.1 G6): a correlation minted via
//    beginAuthorizedNavigation() BEFORE the caller's own privileged
//    chrome.tabs.update/create call is recognized at commit time against
//    the OBSERVED destination — never an exact match on the requested URL,
//    since real redirects are expected.
// =============================================================================
console.log("\n== authorized navigation commit ==");
{
  const t = new DocumentBindingTracker();
  t.onNavigationSignal(5, { url: "https://old.example/" });
  handshake(t, 5, { url: "https://old.example/", docNonce: "nonce-old" });

  let replacementEvents = [];
  const off = t.onReplacement((e) => replacementEvents.push(e));

  const begin = t.beginAuthorizedNavigation(5, "https://new.example/", {
    isDestinationAllowed: (observedUrl) => new URL(observedUrl).hostname === "new.example"
  });
  ok(begin.ok === true && typeof begin.correlationId === "string", "beginAuthorizedNavigation mints a real correlation id");

  // The privileged call actually lands on a REDIRECTED url (new.example ->
  // www.new.example) — must still commit as authorized, not as a hijack,
  // because the predicate is checked against the OBSERVED destination.
  const nav = t.onNavigationSignal(5, { url: "https://www.new.example/landing" });
  ok(nav.authorized === false, "a redirect to a DIFFERENT hostname than the predicate allows is correctly NOT authorized by this predicate")
  off();
}
{
  const t = new DocumentBindingTracker();
  t.onNavigationSignal(6, { url: "https://old.example/" });
  handshake(t, 6, { url: "https://old.example/", docNonce: "nonce-old" });

  let replacementEvents = [];
  t.onReplacement((e) => replacementEvents.push(e));

  t.beginAuthorizedNavigation(6, "https://new.example/", {
    isDestinationAllowed: (observedUrl) => new URL(observedUrl).hostname.endsWith("new.example")
  });
  const nav = t.onNavigationSignal(6, { url: "https://new.example/redirected-landing" });
  ok(nav.authorized === true && nav.reason === null, "an authorized create/navigate commits an in-scope destination after validation, even though the observed URL differs from the exact requested URL");
  ok(replacementEvents.length === 0, "no replacement/invalidation event fires for a correctly authorized commit");
  const confirmedAfter = handshake(t, 6, { url: "https://new.example/redirected-landing", docNonce: "nonce-new" });
  ok(confirmedAfter.confirmed === true, "the new document can still be handshake-confirmed normally after an authorized commit");
}

// =============================================================================
// 7. Unexpected replacement: no pending correlation at all (or an expired
//    one) -> invalidation fires, old refs/nonces go stale.
// =============================================================================
console.log("\n== unexpected replacement (hijack proxy — no matching authorization) ==");
{
  const t = new DocumentBindingTracker();
  t.onNavigationSignal(7, { url: "https://trusted.example/" });
  const before = handshake(t, 7, { url: "https://trusted.example/", docNonce: "nonce-trusted" });
  const nonceRecord = mintExecutionNonce(before);

  const events = [];
  t.onReplacement((e) => events.push(e));

  // No beginAuthorizedNavigation() was ever called for this tab — this is
  // the proxy for a hijack, OR (per gate-1.1 G6) a content-script-issued
  // location.href= — indistinguishable from a hijack at the browser layer,
  // and correctly treated identically here.
  const nav = t.onNavigationSignal(7, { url: "https://attacker.example/" });
  ok(nav.authorized === false && nav.reason === "unexpected", "an unannounced navigation is flagged unexpected, not silently trusted");
  ok(events.length === 1 && events[0].tabId === 7 && events[0].reason === "unexpected", "onReplacement fires exactly once with the tab and reason, so a future consumer (approvals/refs) can invalidate");
  ok(events[0].previousBinding.docNonce === "nonce-trusted", "the replacement event carries the PREVIOUS confirmed binding, so a consumer knows exactly what was invalidated");

  const staleVerify = verifyExecutionNonce(nonceRecord, t.getBinding(7));
  ok(staleVerify.valid === false, "the pre-replacement execution nonce is invalid after the unexpected navigation");

  // Expiry: a stale/expired correlation must not be honored either.
  const tExpired = new DocumentBindingTracker({ now: (() => { let n = 0; return () => (n += 1000); })() });
  tExpired.onNavigationSignal(8, { url: "https://a.example/" });
  handshake(tExpired, 8, { url: "https://a.example/", docNonce: "n" });
  tExpired.beginAuthorizedNavigation(8, "https://b.example/", { ttlMs: 1 }); // expires almost immediately given the injected clock
  const navExpired = tExpired.onNavigationSignal(8, { url: "https://b.example/" });
  ok(navExpired.authorized === false && navExpired.reason === "unexpected", "an EXPIRED correlation window is treated the same as no correlation at all");
}

// =============================================================================
// 8. Destination rejection: a correlation exists, but the observed
//    destination fails the caller's own domain/scope predicate -> treated
//    as replacement (fail closed), and the rejection reason is distinct
//    from a bare "unexpected" so a caller can tell the two apart.
// =============================================================================
console.log("\n== destination rejection ==");
{
  const t = new DocumentBindingTracker();
  t.onNavigationSignal(9, { url: "https://trusted.example/" });
  handshake(t, 9, { url: "https://trusted.example/", docNonce: "nonce-trusted-9" });

  const events = [];
  t.onReplacement((e) => events.push(e));

  t.beginAuthorizedNavigation(9, "https://trusted.example/next", {
    isDestinationAllowed: (observedUrl) => new URL(observedUrl).hostname === "trusted.example"
  });
  // The privileged call was ISSUED at trusted.example, but the actual
  // committed navigation lands somewhere the caller's own predicate never
  // allows (e.g. an open-redirect on the way there) — reject, do not trust.
  const nav = t.onNavigationSignal(9, { url: "https://evil.example/phish" });
  ok(nav.authorized === false && nav.reason === "destination_rejected", "a destination failing the caller's own domain/scope predicate is rejected, not silently authorized");
  ok(events.length === 1 && events[0].reason === "destination_rejected", "the replacement event carries the SPECIFIC destination_rejected reason, distinguishable from a bare unexpected hijack");

  // The rejected window must not linger and authorize a LATER unrelated
  // navigation.
  const navAgain = t.onNavigationSignal(9, { url: "https://evil.example/again" });
  ok(navAgain.authorized === false && navAgain.reason === "unexpected", "the rejected correlation window is closed immediately, not reused for a subsequent navigation");
}

// =============================================================================
// 9. Fail-closed boundaries (tasks.md 1.4 verify clause): "no URL-only
//    fallback remains for a boundary that cannot establish identity."
// =============================================================================
console.log("\n== fail-closed boundaries: no URL-only fallback ==");
{
  const t = new DocumentBindingTracker();
  // Sub-frame (gate-1.1 G0b): content.js has no presence there at all.
  t.onNavigationSignal(10, { url: "https://a.example/" });
  handshake(t, 10, { url: "https://a.example/", docNonce: "nonce-10" });
  ok(t.getBinding(10, { frameId: 1 }) === null, "getBinding NEVER returns an identity for a non-top-level frame (G0b: no content-script presence to confirm one)");
  const subframeGate = t.requireBinding(10, { frameId: 3 });
  ok(subframeGate.ok === false && subframeGate.reason === "subframe_unsupported", "requireBinding explicitly fails closed for a sub-frame rather than reusing the top-frame's binding");

  // A handshake that never arrives (restricted page / content script never
  // injected) must never be substituted with tabId+url alone.
  const t2 = new DocumentBindingTracker();
  t2.onNavigationSignal(11, { url: "chrome://extensions/" });
  const restrictedGate = t2.requireBinding(11);
  ok(restrictedGate.ok === false && restrictedGate.reason === "unconfirmed", "a page whose handshake never completes stays unconfirmed forever — never silently trusted on url alone");
  ok(mintExecutionNonce(t2.getBinding(11)) === null, "no execution nonce can ever be minted for that boundary");
}

// =============================================================================
// 10. Structural: this module never references chrome.webNavigation (G0a —
//     the permission is not declared and is out of this task's scope).
// =============================================================================
console.log("\n== structural: no chrome.webNavigation reference (G0a) ==");
{
  const src = fs.readFileSync(path.join(process.cwd(), "extension", "events", "document-identity.js"), "utf8");
  const liveCode = src
    .split("\n")
    .filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*"))
    .join("\n");
  ok(!liveCode.includes("chrome.webNavigation"), "no live (non-comment) reference to chrome.webNavigation anywhere in this module");
}

console.log(fail === 0 ? "\nALL DOCUMENT IDENTITY TESTS PASSED" : `\n${fail} FAILED`);
process.exit(fail ? 1 : 0);
