# Task 1.1 investigatory gate — document identity — evidence report

Change: `upgrade-agent-reliability-and-workflows`, tasks.md task **1.1 only**.
`design.md` decision 6.

Scope of this session: investigation only. No product code was touched.
Files created: `host/agent/spike/gates/gate-1.1-document-identity.mjs` (the
gate script) and this report. `tasks.md` 1.1 was checked off; 1.2–1.4 and
everything in group 2+ were left untouched, per instruction.

## What this gate is, and is not

This is the group-1 analogue of the group-0 SDK gate
(`host/agent/spike/gates/gate-0.2-sdk-continuity.mjs`,
`plans/reports/osf-apply-260909-1504-sdk-continuity-gate.md`), matched to its
shape: numbered gates, per-gate PASS/FAIL/UNOBSERVED/BLOCKED, hard-fail rather
than silently skip when a check cannot actually run, secret-free evidence.

Unlike gate-0.2 (which drives the installed Claude Agent SDK), the "installed
SDK" under test here is **real Chrome DevTools Protocol against a real,
freshly launched, fully isolated Chrome instance** — not the already-loaded
Browzy extension and not the operator's real browser:

- a throwaway `--user-data-dir` (never the operator's real profile)
- a throwaway `--remote-debugging-port` (OS-assigned, port 0)
- a local, in-process HTTP test-page server bound to `127.0.0.1` only —
  never a real site, never the operator's own browsing

**Why not drive the actual Browzy extension end-to-end**: verified
empirically that no MCP browser-automation tool available in this session can
drive the OS-native "Load unpacked" file picker (`chrome://extensions`
requires a native file dialog outside CDP's page-viewport scope), so loading
a *second*, differently-instrumented extension into a live browser was not
reliably automatable here — this is named explicitly as an **unobserved**
gap below, with the concrete steps a human would need to close it. What *is*
real in this report: a real Chrome binary, real navigation/frame/lifecycle
events observed over the same protocol family this extension already has
permission for (`"debugger"` in `extension/manifest.json`), and a genuine
process kill+relaunch for the "browser restart" scenario (this harness fully
owns the throwaway Chrome's lifecycle, so restart was actually exercised, not
inferred).

Two static findings (G0a, G0b) are read directly from this repo's own
`extension/manifest.json` and `extension/background.js` / `extension/events/
action-events.js` — not a re-implementation — cross-checked against Chrome's
own published extension API reference (fetched at investigation time, not
recalled from training memory) for the two claims that needed a primary
source: `chrome.tabs.onUpdated`'s `changeInfo.url` semantics, and
`chrome.webNavigation`'s permission requirement.

Reproduce:
```
node host/agent/spike/gates/gate-1.1-document-identity.mjs
```
Exit code is non-zero when any gate reports FAIL (2 gates do, both are real,
reproducible boundary findings — see below — not flakes). This file is
deliberately **not** under `host/test/*.test.mjs`, for the same reason
gate-0.2 and gate-1.2–1.6 are not: `.github/workflows/publish-host.yml`'s
`host/test/*.test.mjs` loop must exit 0 on every publish, and this file's
FAILs are genuine findings that must not silently gate the publish pipeline.

## Environment

| | |
|---|---|
| Chrome binary used (isolated instance) | `C:\Program Files\Google\Chrome\Application\chrome.exe` |
| Node.js | v24.19.0 (global `fetch`/`WebSocket`, no external deps) |
| Platform | win32 x64 (Windows 11) |
| CDP transport | raw DevTools Protocol WebSocket, hand-rolled client (no puppeteer/playwright) |
| Real product extension | left untouched; not loaded into the throwaway Chrome instance (see gap above) |
| Cleanup verified | no orphaned `chrome.exe` processes after the run; scratch `--user-data-dir` removed |

## Per-scenario table (task 1.1's exact seven scenarios)

| # | Scenario | Signal(s) used | Distinguishable? | Evidence |
|---|---|---|---|---|
| 1 | Same-URL reload | CDP `loaderId` (main-frame `Page.frameNavigated`); in-page nonce (`window.__nonce`) | **Yes — correctly produces a new identity** | `loaderId` changed, in-page nonce lost (G1, PASS) |
| 2 | SPA route change (same document, new route) | CDP `loaderId`; `Page.navigatedWithinDocument`; in-page nonce | **Yes — correctly stays stable** | `loaderId` unchanged, nonce unchanged, exactly one `navigatedWithinDocument` event, zero spurious full navigations (G2, PASS) |
| 3 | Tab close + reopen at same URL | in-page nonce; `sessionStorage`; `localStorage` (contrast) | **Yes** — in-memory/session identity is gone; **localStorage is the wrong tool** (it persists across a close+reopen, which decision 6's per-document nonce must never do) | (G3, PASS) |
| 4 | Browser restart | in-page nonce; `sessionStorage`; `localStorage` (contrast) — via a **real** kill+relaunch of the isolated Chrome process against the same profile dir | **Yes** — in-memory/session identity is gone; localStorage again persists (same wrong-tool warning, now confirmed across a genuine process restart, not simulated) | (G4, PASS) |
| 5 | Iframes / sub-frames | CDP `frameId`/`parentId`/`loaderId` per frame | **Frame identity IS separable from tab identity at the CDP layer** — but see the boundary list below: this repo's own content-script mechanism has **no presence in any iframe today** | (G5, PASS; boundary cross-referenced from G0b) |
| 6 | Authorized navigation commit | CDP `Page.frameRequestedNavigation.reason` | **Only conditionally** — see finding below; depends on which layer issues the "authorized" call | (G6, PASS on the raw signal; see the sharp caveat below) |
| 7 | Unexpected replacement | Same signal as #6 | Same signal as #6 shows the commit; **the browser cannot itself tell "authorized" from "unexpected"** | (G6) |

## The two real, load-bearing boundary findings (static, from this repo's own source)

**G0a — FAIL. `chrome.webNavigation` is not usable today.**
`extension/manifest.json`'s `permissions` array is
`["tabs","debugger","activeTab","scripting","nativeMessaging","tabGroups","windows","storage","alarms","offscreen","clipboardWrite","sidePanel"]`
— no `"webNavigation"` entry. Per Chrome's own extension API reference
(fetched at investigation time): *"The `webNavigation` permission must be
declared in the extension manifest to use this API."* Consequence:
`chrome.webNavigation.onCommitted` / `onBeforeNavigate` /
`onHistoryStateUpdated`, and their `documentId`/`frameId` fields (the single
cleanest, purpose-built committed-navigation + document-identity signal
Chrome offers), are **entirely unavailable to this extension as shipped
today.** Any design that assumes `documentId`/`frameId` from
`chrome.webNavigation` must either add this permission (a real manifest
change — a Chrome Web Store review-surface change, correctly out of scope
for this investigation) or **fail closed** without it, per decision 6's own
mandate ("If the browser cannot provide a stable token for a boundary, the
operation fails closed rather than falling back to URL-only identity").

**G0b — FAIL. `content.js` does not run in any iframe.**
`extension/manifest.json`'s `content_scripts` entry for `content.js` is
`{"matches":["<all_urls>"],"js":["content.js"],"run_at":"document_idle","all_frames":false}`.
`all_frames:false` means content.js — the only script positioned to host a
content-script/nonce handshake — executes **only in the top-level main
frame**. No content-script instance of any kind exists in a sub-frame today.
(`recorder/capture.js` is `all_frames:true`, but it is a separate script for
recording capture, not a document-identity handshake, and does not close
this gap.) Consequence: **per-frame document identity for a sub-frame is
currently unobservable from the content-script side at all** — G5 below
shows the CDP layer *can* separate frame identity, but there is no
corresponding in-page half of the handshake to corroborate it for any frame
but the top one.

**G0c — PASS (evidence), but reveals a third real finding.**
The only document-identity-adjacent mechanism that exists in the codebase
today, `extension/events/action-events.js`'s `DocumentIdTracker`
(`current(tabId)` returns `` `${tabId}:${generation}` ``, `bump(tabId)`
increments the generation), is bumped **only** from
`extension/background.js`'s `chrome.tabs.onUpdated` listener, gated on `if
(changeInfo.url) actionDocTracker.bump(tabId)`. Per Chrome's own
documentation (fetched at investigation time): `changeInfo.url` is present
*"only when the URL actually changes."* **A same-URL reload does not change
the URL string, so `changeInfo.url` is absent and this tracker's counter
does not bump on scenario 1 (same-URL reload) at all** — even though G1
below independently confirms, via real CDP evidence, that a same-URL reload
*is* in fact a new document at the browser level. This existing tracker is
explicitly not decision 6's mechanism (it is a best-effort action-event id,
per design.md 5c) — but it is worth flagging precisely because it is the
closest existing artifact, and it would fail scenario 1 outright if reused
as-is.

## G6's finding, precisely

The raw hypothesis going in was "a privileged navigate call (this product's
own authorized create/navigate) will look structurally different on the wire
from a page hijacking its own navigation." That hypothesis was **wrong as
originally framed** and this gate corrected it empirically rather than
reporting the wrong guess:

- A CDP `Page.navigate` call (the CDP analogue of the extension's own
  privileged `chrome.tabs.update({url})`) **does** emit a
  `Page.frameRequestedNavigation` event — it is not silent. Observed reason,
  reproduced identically across three separate runs: `"initialFrameNavigation"`.
- A page's own in-page script self-redirecting via `location.href = ...`
  (the proxy for "unexpected replacement", or equally for a content-script
  issuing the same call, since content scripts share the page's JS realm)
  produces `Page.frameRequestedNavigation` with reason `"scriptInitiated"`.
- These two reason strings **do** differ in this configuration, so the raw
  CDP signal is empirically a real distinguishing signal **in this specific
  case** — but the mechanism is fragile and narrow: it distinguishes
  *"issued through a privileged, non-page-script call"* from *"issued by
  script running inside the page,"* not *"authorized by this product"* from
  *"hijacked by something else."* **A content-script-issued
  `location.href = ...` — which is exactly how an in-page authorized
  create/navigate action would plausibly be implemented — would carry the
  identical `"scriptInitiated"` reason as a genuine unrelated hijack.** Both
  cases end in an ordinary `Page.frameNavigated` with a new `loaderId`,
  structurally identical there.

**Concrete implication for task 1.3** ("an authorized create/navigate action
may commit an in-scope destination after destination domain/scope
validation; unexpected replacement invalidates old refs"): if the
"authorized" path is implemented via the extension's own privileged API
(`chrome.tabs.update`/`create`, called from `background.js`, which already
holds the `"tabs"` permission), the browser-level signal is at least
partially distinguishable. If it is ever implemented via a content-script
call instead, the browser cannot tell the two cases apart at all —
authorization must then be established at the **application layer** (e.g. an
expected-navigation correlation id minted immediately before the product's
own privileged call and checked at commit), which is exactly what
`design.md` decision 6 and task 1.3 already specify. This gate makes that
requirement concrete rather than aspirational.

## Recommended identity construction, with its evidence

Given everything observed:

1. **Primary commit/lifecycle signal**: CDP-family `loaderId` (the
   `chrome.debugger`-accessible equivalent of `chrome.webNavigation`'s
   `documentId`, which is unavailable per G0a) changes exactly once per real
   document (G1: changes on reload; G2: **does not** change on an SPA
   `pushState` route change, confirmed via `Page.navigatedWithinDocument`
   firing instead of a full `frameNavigated`). This is the strongest
   feasible **committed-navigation** signal actually reachable given the
   current manifest.
2. **Per-document nonce**: must be minted in-page, held only in memory (a JS
   variable, not `localStorage`) — G3 and G4 both show an in-memory nonce is
   correctly lost on tab close+reopen and on a genuine process restart,
   while `localStorage` (disk-backed, per-origin) **wrongly** survives both
   — a concrete, twice-confirmed reason `localStorage` must never be used
   for this nonce. `sessionStorage` also correctly dies in both G3 and G4,
   so it is an acceptable *secondary* fallback store for the nonce's
   lifetime within a single tab, provided the primary check is still the
   in-memory value plus the loaderId/frameId pairing (never sessionStorage
   alone, since it is still page-script-writable, same trust boundary as
   `window.__nonce`).
3. **Frame identity**: per G5, frame-level identity (`frameId`/`parentId`)
   is genuinely separable from tab/main-frame identity at the CDP layer —
   navigating a sub-frame does not perturb the main frame's `loaderId`. This
   is necessary but **not sufficient**: per G0b, there is currently no
   content-script presence in any sub-frame to pair with that signal.
4. **Authorized vs. unexpected**: per G6, this cannot be established from
   the browser signal alone if the authorized path runs through page-context
   script. It requires an application-level correlation id issued
   immediately before the product's own privileged navigate call.

## Boundaries that must fail closed (decision 6's explicit requirement)

Per `design.md` decision 6: *"If the browser cannot provide a stable token
for a boundary, the operation fails closed rather than falling back to
URL-only identity."* Named precisely, from this session's evidence:

1. **Any sub-frame (iframe), for the content-script half of the identity.**
   G0b: `content.js` has no presence there at all today. A per-frame nonce
   handshake cannot exist until `all_frames:true` is added to that
   content-script entry (an actual product change, correctly out of this
   investigation's scope) — until then, any operation that needs a
   *content-script-confirmed* per-document identity for a frame other than
   the top one has no signal to check and must refuse rather than trust the
   CDP-only half alone.
2. **`documentId`/`frameId` via `chrome.webNavigation`, anywhere.** G0a: the
   permission is not declared. Any code path that assumes this API is
   reachable will throw or silently no-op depending on how it is guarded —
   this must be treated as categorically absent, not degraded.
3. **Distinguishing "authorized" from "unexpected" navigation when the
   authorized path is issued from page/content-script context.** G6: the
   browser-level signal is identical (`"scriptInitiated"`) in both cases.
   Only a privileged, background-script-issued navigate
   (`chrome.tabs.update`/`create`) gets a distinguishable
   `Page.frameRequestedNavigation` reason in this session's evidence, and
   even that finding (`"initialFrameNavigation"`) was reproduced but not
   independently explained from Chrome's own documentation (its exact
   internal meaning across all navigation orderings was not verified beyond
   this session's specific repeated scenario) — task 1.3 should not lean on
   this reason string alone as authoritative without further confirmation
   under more call orderings.

## What was left UNOBSERVED, and what it would take to close it

- **The real, live Browzy extension's own content.js/background.js document
  identity behavior end-to-end**, as opposed to this session's isolated CDP
  proxy. This session could not drive `chrome://extensions`'s native "Load
  unpacked" file-picker dialog from the available MCP browser-automation
  tools (CDP-based automation cannot reach an OS-native file dialog), so a
  differently-instrumented probe extension could not be loaded into a live
  browser here, and the already-installed Browzy extension does not yet
  implement anything beyond `tabId+url` (per `page-context.js`'s own
  `sameIdentity()`), so there is nothing product-side to observe yet for
  this specific task. **To close this**: once 1.2 lands a real content-script
  nonce handshake, a human (or an agent with OS-level input access, e.g. a
  computer-use tool that can drive native dialogs) should repeat these same
  seven scenarios against the *actual* loaded extension, with the
  extension's own background service worker console open, and confirm the
  real nonce/handshake behaves exactly as this gate's CDP proxy predicts.
- **A real cross-origin, out-of-process iframe (OOPIF).** This session's
  iframe test (G5) used a same-origin, same-port iframe for simplicity; Chrome
  may route true cross-origin iframes into a separate renderer process
  (`Target.setAutoAttach`/flattened sessions would then be required to reach
  its own CDP session rather than the parent page's `Page` domain events
  alone). The same-origin case already confirms `frameId`/`parentId`
  separation and loaderId isolation; whether an OOPIF's events arrive
  identically through this harness's single-target `Page` domain (without
  `Target.setAutoAttach`) was not verified. **To close this**: extend the
  gate script with `Target.setAutoAttach({autoAttach:true, flatten:true})`
  and a cross-port (or cross-hostname via `/etc/hosts`-style loopback alias)
  iframe, and confirm the OOPIF's frame events are still observable.
- **The exact internal Chrome semantics of the `"initialFrameNavigation"`
  reason string** for a privileged `Page.navigate` call issued as the
  *second* navigation of a session (not literally the tab's first
  navigation). Reproduced identically three times in this session, so it is
  not a fluke of a single run, but its documented meaning inside Chromium's
  own navigation-reason taxonomy was not independently confirmed against a
  primary source beyond the CDP protocol's own reason-enum listing. Treat as
  an empirically observed, reproducible fact about this Chrome version, not
  as an explained one.
- **`webNavigation`'s `documentId` continuity claim across `pushState`**
  specifically. Chrome's own webNavigation reference (fetched at
  investigation time) does not explicitly state whether
  `onHistoryStateUpdated` reports the same `documentId` as the prior state —
  it was inferred from documentId's stated purpose ("useful for determining
  when pages change their lifecycle state... because it remains the same"),
  not independently observed, since `chrome.webNavigation` itself is
  unreachable per G0a. This session's G2 (CDP `loaderId` stability across
  `pushState`) is the closest available substitute evidence and does confirm
  the underlying browser-level document does not change; it is not, however,
  a direct observation of the `webNavigation` API's own `documentId` field.

## Gate script summary (final clean run)

```
{
  "pass": 7,
  "fail": 2,
  "blocked": 0,
  "unobserved": 0,
  "total": 9
}
```

Both FAILs (G0a, G0b) are genuine, reproducible, static boundary findings —
not flakes, not bugs in the gate script — matching gate-0.2's own precedent
of reporting a real narrow finding as FAIL rather than suppressing it.

## Files touched this session

- Created: `host/agent/spike/gates/gate-1.1-document-identity.mjs`
- Created: this report
- Modified: `openspec/changes/upgrade-agent-reliability-and-workflows/tasks.md`
  — checked off **1.1 only**
- No product code was modified.
