# Action-event schema — evidence report (Batch 1 of the overlay/timeline split, tasks 5.9/5.10 groundwork)

Change: `migrate-to-claude-agent-sdk`. This is **Batch 1 of 3**: it defines
the one shared action-event schema design.md decision 5c and spec.md's
"Visible agent pointer and control status" / "Truthful action timeline and
screenshot previews" requirements both need, and instruments the real
dispatch paths in `extension/background.js` / `extension/humanize/**` to
emit it. It deliberately does **not** build the overlay renderer
(`extension/overlay/**`, Batch 2), the sidepanel timeline UI (Batch 2), or
the host-side timeline storage (`host/**`, Batch 3). Those two batches build
against this document — it is written so they can do that **without reading
this batch's code**.

## Environment

| | |
|---|---|
| Date | 2026-09-06 |
| Platform | win32 x64 (Windows 11) |
| Node.js | v24.19.0 |
| Browser automation | none used — see "What is BLOCKED" below |

The extension is **not loaded in a real browser** this session (stated in the
task brief). Every claim below is proven one of two ways, and each claim says
which:

1. **Executed, offline, against the real shipped source** — pure unit tests
   of `extension/events/action-events.js` (no chrome.*, no DOM, genuinely
   runnable in plain Node), plus the `test/_extract.mjs` brace-matching
   technique `test/handlers.test.mjs` / `test/registry-borrowed-tab-scope.
   test.mjs` / `test/registry-borrowed-tab-live-extraction.test.mjs` already
   use to run small, named pieces of the SHIPPED `extension/background.js`
   against injected fakes.
2. **Structural / textual proof against the shipped source** — for the parts
   of `extension/background.js` too large to usefully execute offline
   (`handleToolRequest`'s full dependency graph: `audit`, `toolHandlers`,
   `nativePort`, `dbg`, `sendResponse`/`sendError`, ...), a regex/text-search
   check against the real file, in the same spirit as `test/registry-
   baseline.test.mjs`'s `handlerProducesImage`/`handlerIsStub`.

Nothing here is faked into a false pass. Anything that genuinely needs a
live installed extension + real Chromium is called out explicitly as
**BLOCKED**, with the exact command to close it later.

## Files touched

Owned and edited:
- `extension/events/action-events.js` (**new** — the schema module itself).
  Chosen path/name: task brief suggested this exact path and it fits the
  repo's existing convention of a dependency-free, pure `extension/<area>/`
  module (mirrors `extension/humanize/index.js`'s own "PURE: nothing here
  touches chrome.*" discipline) — no reason to deviate.
- `extension/background.js` — imports `action-events.js`; adds a per-tab
  `DocumentIdTracker` instance wired to the existing tab-URL-change listener
  and tab-removal cleanup; adds the action-event identity side-channel
  (`currentAction`/`currentActionExtras`, parallel to the existing
  `currentToolMeta`) and five small wiring functions
  (`deriveOutcomeStatus`, `emitActionStart`, `emitActionProgress`,
  `makePointerStepHandler`, `emitActionSettled`); wires `start`/`complete`/
  `error` emission generically into `handleToolRequest()` (covers **all 26**
  registry tools, including sandbox/`execute_code`-generated calls — see
  "Emission wiring" below for why that one hook is sufficient); wires
  `progress` (pointer) emission into `computer()`'s pointer-capable cases
  (`left_click`/`right_click`/`double_click`/`triple_click`/`hover`/
  `scroll`/`left_click_drag`) and artifact-id capture into `screenshot`/
  `zoom`; adds an optional 4th `onStep` parameter to `dispatchPlan()` and an
  `opts.onStep` passthrough to `mouseClick()` (both purely additive — see
  "No behavior change" below).
- `extension/humanize/**` — **not modified**. The humanized planners in
  `extension/humanize/index.js`/`cursor.js`/`keyboard.js` stay exactly as
  they were: they already return plain step arrays with real coordinates,
  which is all `dispatchPlan`'s new `onStep` callback needs. Instrumenting
  the *executor* (`dispatchPlan`, which is `extension/background.js`'s, not
  `extension/humanize/`'s) rather than the planners is deliberate — see
  "Never animate from a model's proposed plan" below.
- `test/action-events-schema.test.mjs` (**new**) — pure unit tests of the
  schema module.
- `test/action-events-emission.test.mjs` (**new**) — extraction-harness
  tests of the wiring in `extension/background.js`, plus structural checks.
- `reports/05-action-event-schema.md` (this file).

Not touched (per the batch's scope boundary, verified by `git status`/diff
before finishing): `extension/sidepanel/**`, `extension/content.js`,
`extension/overlay/**` (does not exist yet), `extension/settings/**`,
`extension/ui/**`, `extension/recorder/**`, `extension/manifest.json`,
`host/**` entirely, `README.md`, `install.sh`, `install.ps1`, `docs/**`,
`tasks.md`, `REAL/`, `benchmark/`, `scratch/`.

## No behavior change to existing dispatch

Every edit to an already-shipped function is **additive**:
- `dispatchPlan(tabId, plan, modifiers = 0, onStep)` — `onStep` is a new
  trailing optional parameter. Every existing 3-argument call site (and
  `test/humanize-executor.test.mjs`'s fixture, which predates this batch and
  was **not modified**) behaves byte-for-byte identically, because `onStep`
  is simply `undefined` and every new call site is `if (onStep) onStep(step)`.
- `mouseClick(tabId, x, y, opts)` — reads a new optional `opts.onStep`;
  absent, it is a no-op, identical to before.
- `computer()`'s pointer-capable cases gained `onPointerStep`/`.flush()`
  calls that are `null`-safe (`if (onPointerStep) ...`) — for a
  non-pointer-capable action, `makePointerStepHandler()` returns `null` and
  every one of those calls is skipped.
- `handleToolRequest()` gained emission calls around the *existing*
  `try { result = await handler(args); } finally { currentToolMeta =
  undefined; }` structure, without changing that structure, its error
  handling, or what gets sent back to the caller (`sendResponse`/`sendError`
  calls are unchanged, same arguments, same order).

**Proof:** `test/action-events-emission.test.mjs`'s first block runs the
exact same humanized click plan through the real, extracted `dispatchPlan`
twice — once with `onStep` omitted (the pre-existing call shape), once with a
real callback — and asserts the two runs' recorded CDP/sleep call sequences
are **byte-identical** (`JSON.stringify` equality over 52 calls). This is the
concrete evidence for "instrumentation did not alter dispatch ordering or
timing behavior." `test/humanize-executor.test.mjs` (pre-existing, not
modified) still passes unchanged, which is the same guarantee from the other
direction — the shipped 3-arg call shape it exercises never sees `onStep` at
all.

## The schema

One JSON-serializable event object. Every event produced by
`extension/background.js`/`extension/humanize/**`'s dispatch goes through
`action-events.js`'s `buildEvent()` — there is exactly one shape, not one per
producer.

```jsonc
{
  "schemaVersion": 1,
  "kind": "start" | "progress" | "complete" | "error",

  // --- identity ---
  "runId": "run_abc123" | null,          // null for a legacy/external-MCP call — no SDK run exists
  "conversationId": "conv_xyz" | null,   // present only when the run has one (SDK path)
  "requestId": "req_..." | null,         // the specific dispatched tool_request's own id (SDK path)
  "actionId": "act_3_k2j9f1",            // STABLE across every event of ONE logical action instance
  "tabId": 123 | null,
  "documentId": "123:2" | null,          // "<tabId>:<generation>" — see "Document identity" below

  // --- ordering / dedup ---
  "seq": 1,                              // see "Sequencing and dedup" below
  "streamKey": "run:run_abc123" | "legacy",

  "ts": 1757100000000,                   // epoch ms this EVENT OBJECT was produced

  // --- what happened ---
  "action": {
    "type": "open_page" | "read" | "find" | "click" | "hover" | "scroll" |
             "type" | "wait" | "drag" | "capture" | "script" | "other",
    "tool": "computer",                  // the legacy registry tool name (host/tool-definitions.js)
    "op": "left_click" | null            // computer's own args.action sub-operation, else null
  },
  "timing": {
    "startedAt": 1757099999500,          // stamped ONCE at `start`, copied onto every later event of this action
    "endedAt": 1757100000000 | null      // stamped only on `complete`/`error`
  },

  // --- pointer-only fields (see "Pointer field" below) ---
  "pointer": null | {
    "points": [ { "x": 412, "y": 220, "t": 1757099999600, "phase": "move" }, ... ],
    "frame": { "frameId": 0, "isMainFrame": true }
  },

  // --- capture-only field ---
  "capture": null | { "artifactId": "screenshot_1757100000000" },

  // --- always present ---
  "summary": "Click at (412, 220)",      // safe, redaction-applied — see "Redaction" below
  "redaction": { "applied": false, "reason": null | "content_redacted" },

  // --- complete/error only ---
  "outcome": null | { "status": "success" | "unknown" | "error", "detail": string | null }
}
```

### Field-by-field

| Field | Type | Present on | Meaning |
|---|---|---|---|
| `schemaVersion` | integer | always | `action-events.js`'s `SCHEMA_VERSION` (currently `1`). Bump together with any breaking shape change. |
| `kind` | enum | always | `start` \| `progress` \| `complete` \| `error` — see "Event kinds" below. |
| `runId` | string \| null | always | The SDK run's own id (`host/agent/broker/browser-lease.js`'s `describeForWire()` — unchanged, read-only, not touched by this batch). `null` for any legacy/external-MCP tool call, which carries no run identity today (`extension/background.js`'s `currentToolMeta` is `undefined` for those — see its header comment). |
| `conversationId` | string \| null | always | From the same wire `meta`, when present. |
| `requestId` | string \| null | always | The specific dispatched request's own id, from the same wire `meta`. Distinct from `actionId` — one browser-side action can in principle be re-attempted under a new `requestId` by the SDK layer; this batch does not merge those, it just threads whatever `requestId` accompanied the dispatch it is instrumenting. |
| `actionId` | string | always | Generated once per action instance (`newActionId()`), at `start`, and copied onto every later event of that SAME action (`progress*`, then exactly one of `complete`/`error`). This is the field a renderer groups rows by. |
| `tabId` | number \| null | always | From `args.tabId`. `null` only for a tool call with no `tabId` argument at all (rare — every browser-control tool takes one). |
| `documentId` | string \| null | always | See "Document identity" below. |
| `seq` | integer ≥ 1 | always | Monotonic **per `streamKey`**, starting at 1. See "Sequencing and dedup" below. |
| `streamKey` | string | always | `` `run:${runId}` `` when `runId` is set, else the single literal `"legacy"`. |
| `ts` | integer (epoch ms) | always | When `buildEvent()` produced this specific object — i.e. when the event was emitted, not when the underlying browser action happened (that is `timing.startedAt`/`timing.endedAt`). |
| `action.type` | enum | always | The taxonomy key — see "Action taxonomy" below. |
| `action.tool` | string | always | The exact legacy registry tool name (`computer`, `navigate`, `find`, `read_page`, `get_page_text`, `javascript_tool`, or any of the other 26 — see `host/tool-definitions.js`, unmodified). |
| `action.op` | string \| null | always | For `tool === "computer"`, the exact `args.action` value (`"left_click"`, `"scroll"`, ...). `null` for every other tool. |
| `timing.startedAt` | integer (epoch ms) | always | Wall-clock time `start` was built. Identical value on every event of the same action. |
| `timing.endedAt` | integer \| null | always (null until settled) | Wall-clock time `complete`/`error` was built. `null` on `start`/`progress`. |
| `pointer` | object \| null | always (usually null) | See "Pointer field" below. |
| `pointer.points[].x`/`.y` | number | when `pointer` set | **The exact same numbers already passed to `Input.dispatchMouseEvent`** — no coordinate transform happens in this schema. See "Coordinate system" below. |
| `pointer.points[].t` | integer (epoch ms) | when `pointer` set | When that specific point was dispatched (captured at the `onStep`/`onPointerStep` call, i.e. immediately after the real CDP call for that point). |
| `pointer.points[].phase` | string | when `pointer` set | Which real dispatch produced it: `"move"` \| `"down"` \| `"up"` \| `"wheel"`. |
| `pointer.frame` | object | when `pointer` set | See "Coordinate system / frame limitation" below. |
| `capture.artifactId` | string | `complete` of a `capture`-type action, when a screenshot was actually taken | The exact key used in `extension/background.js`'s existing `screenshotStore` Map (`screenshot_<timestamp>`) — the same id the tool's own text response already reports as `ID: <imageId>`. Batch 2/3 resolve the actual image through whatever existing channel already serves `screenshotStore` entries (unchanged by this batch); this field only carries the reference. |
| `summary` | string | always | Safe to log/render/forward as-is. See "Redaction" below for exactly what it can and cannot contain. |
| `redaction.applied` | boolean | always | `true` when `summary` deliberately omits the action's own free-text content (typed text, script source). |
| `redaction.reason` | string \| null | always | `"content_redacted"` when `applied`, else `null`. A single reason code today — extend `action-events.js`'s `redactedLength()`/`plain()` helpers if a future producer needs a second reason. |
| `outcome.status` | enum | `complete`/`error` only | `"success"` \| `"unknown"` \| `"error"`. See "Outcome derivation" below. |
| `outcome.detail` | string \| null | `complete`/`error` only | For `error`, the error's own message (via `safeErrorSummary()` — length-capped, never includes `args`/`result`). For `complete`, an optional short reason when `status` is `"unknown"` (e.g. `"post-scroll confirmation screenshot unavailable"`), else `null`. |

### Event kinds

- **`start`** — built and emitted by `emitActionStart()` **before** the
  registry handler is ever invoked. `extension/background.js`'s
  `handleToolRequest()` calls it immediately before `await handler(args)`,
  with the exact same "synchronous assignment, no `await` in between"
  discipline the file's existing `currentToolMeta` already relies on (see
  that variable's own header comment, right above the new
  `currentAction`/`currentActionExtras` pair this batch adds beside it).
  **Proof:** `test/action-events-emission.test.mjs`'s structural section
  greps the shipped `handleToolRequest` source and asserts the
  `emitActionStart(...)` call site's text index is strictly less than the
  `result = await handler(args);` line's — i.e. it is provably impossible for
  `start` to be emitted after (or without) execution beginning, in the
  shipped file, not just in a test double.
- **`progress`** — built only from values a caller has **already dispatched**
  (`makePointerStepHandler()`'s callback is invoked by `dispatchPlan()`/
  `mouseClick()`/`computer()`'s manual dispatch loops immediately *after*
  the real CDP call, never before). Zero or more per action. Only ever
  carries a `pointer` payload in this batch (no other progress content is
  emitted yet — see "What Batch 2/3 still need to add" for e.g. a possible
  future non-pointer progress use).
- **`complete`** — built by `emitActionSettled()`, called exactly once, only
  after the registry handler's promise **resolves**. Never guesses; every
  field comes from either the action's own `args` (via `summarize()`,
  content-redacted as needed) or from `currentActionExtras`, a slot only the
  handler itself writes into (an artifact id, an outcome the handler's own
  existing verification already computed).
- **`error`** — built by `emitActionSettled()`, called exactly once, only
  from inside `handleToolRequest()`'s existing `catch (err)` block, i.e. only
  on an actual thrown/rejected promise. `outcome.status` is unconditionally
  `"error"` for this kind — nothing can override it to `"success"`.
  **Proof (both `complete`/`error`):** the same structural test asserts both
  emission call sites are textually *after* `result = await handler(args);`
  in the shipped source, and `test/action-events-emission.test.mjs`'s second
  block exercises `emitActionSettled()` directly to prove its actual field
  derivation (default `success` with no override; an explicit `unknown`/
  `artifactId` from `extras` preserved verbatim; `error` kind always yields
  `outcome.status === "error"` regardless of what `extras` contains).

Lifecycle per action: exactly one `start`, zero or more `progress`, then
exactly one of `complete`/`error`.

### Action taxonomy

`classifyAction(tool, args)` in `action-events.js`:

| `action.type` | Produced by | Design 5c label example |
|---|---|---|
| `open_page` | `navigate` | "Opened page" |
| `read` | `read_page`, `get_page_text` | "Reading" |
| `find` | `find` | "Finding [target]" |
| `click` | `computer` `left_click`/`right_click`/`double_click`/`triple_click` | "Clicked" |
| `hover` | `computer` `hover` | (spec.md's pointer requirement) |
| `scroll` | `computer` `scroll`/`scroll_to` | "Scrolled" |
| `type` | `computer` `type`/`key` | "Typed" |
| `wait` | `computer` `wait` | "Waited N seconds" |
| `drag` | `computer` `left_click_drag` | (spec.md's pointer requirement — "drag") |
| `capture` | `computer` `screenshot`/`zoom` | "Captured page" |
| `script` | `javascript_tool` | "Ran page script" |
| `other` | every other registry tool (tab/session management, `debug`, `get_config`, etc.) and `computer`'s hidden `diag_input` | — (a renderer can choose to hide `other` rows, or show them generically) |

`action.type` is a **stable taxonomy key**, not localized text — Batches
2/3 own rendering/localization (design.md 5a/5c both discuss localized
labels; this schema deliberately carries the key, `action.tool`, and
`action.op`, so a renderer can localize without re-deriving classification).

`POINTER_ACTION_TYPES` (exported from `action-events.js`) = `{click, hover,
scroll, drag}`. `isPointerCapable(type)` checks membership.
`buildEvent()` **enforces** this: passing a non-null `pointer` payload for
any other `action.type` throws. This is the enforceable half of "never
fabricate pointer motion for DOM/script-only calls" — see next section.

### Pointer field — coordinate system, frame context, and no-fabrication

`pointer.points[].x`/`.y` are **the literal numbers already passed to
`Input.dispatchMouseEvent`/`Input.dispatchMouseEvent(type: mouseWheel)`** —
copied at the exact call site, not recomputed, not transformed. This is true
for both the humanized path (`dispatchPlan`'s `step.x`/`step.y`, which are
`humanize/cursor.js`'s `planPath()` output — a curve computed from real
`from`/`to` points, never emitted as points until `dispatchPlan` actually
dispatches each one) and the direct path (`computer()`'s own coordinate-based
cases). **No separate visual/CSS transform, DPR scaling, or interpolation
happens in this schema** — whatever coordinate space `extension/background.js`
already dispatches in (CSS-pixel viewport coordinates — see
`takeScreenshot()`'s own header comment on why screenshots are already
DPR-corrected to match) is what `pointer.points` carries.

**No-fabrication guarantees, and how each is actually enforced (not just
asserted):**
- *"Never fabricate pointer motion for DOM/script-only calls."* — `read_page`,
  `get_page_text`, `find`, `navigate`, `javascript_tool` never call
  `makePointerStepHandler()`/`emitActionProgress()`/`PointBatcher` at all.
  **Proof:** `test/action-events-emission.test.mjs`'s structural section
  extracts each of those five handler bodies (the exact same
  `extractMethod()` used by other test files) and regex-asserts none of them
  reference those three identifiers, at all, anywhere in their shipped
  source. `computer()`'s own non-pointer cases (`wait`, `type`, `key`,
  `screenshot`, `zoom`, `scroll_to`) never call `onPointerStep(...)` either
  (verified by inspection during implementation; `scroll_to` in particular
  shares `action.type: "scroll"` with `scroll` for labeling purposes but
  dispatches no CDP mouse event at all, so its `onPointerStep` handler,
  though constructed, is simply never invoked and never emits anything).
- *"Never animate from a model's proposed plan — only from real dispatch."*
  — `onStep`/`onPointerStep` are invoked by `dispatchPlan()`/`mouseClick()`/
  `computer()`'s manual loops **after** each step's own `await
  dispatchMouse(...)`/`await sendMouseEvent(...)`/`await cdp(...)` call
  settles, never before, and never from the plan array itself before
  dispatch. `extension/humanize/index.js`'s planners (`planClick`,
  `planHover`, `planDrag`, `planType`) are **unmodified** — they still just
  return a plain array; nothing reads that array for animation purposes
  except the same executor (`dispatchPlan`) that was already the "ONLY place
  plans meet the browser" before this batch (see that function's own
  pre-existing header comment, unchanged).
- *Movement samples are grouped, never one row per sample.* — `PointBatcher`
  (in `action-events.js`) buffers real dispatched points and flushes in
  chunks of ≤20 (`makePointerStepHandler()`'s default), all sharing the
  triggering action's `actionId`. **Proof:** `test/action-events-schema.
  test.mjs`'s `PointBatcher` section (45 points at batch size 20 flush
  exactly twice, 20+20, with 5 recoverable via `drain()`) and `test/action-
  events-emission.test.mjs`'s `makePointerStepHandler` section (25 real
  moves flush once at 20, `.flush()` drains the trailing 5, every point in
  both batches carries the same `actionId`).

**Coordinate system / frame limitation (honestly scoped, not glossed over):**
`pointer.frame` is currently always `{ frameId: 0, isMainFrame: true }`.
`extension/background.js`'s CDP dispatch has no per-frame targeting today —
`resolveRefToCoordinates()`'s underlying content-script call
(`getRefCoordinates` in `extension/content.js`, **not modified by this
batch** — owned by a parallel batch) already returns top-level-viewport-
relative coordinates via `getBoundingClientRect()`, with no documented
handling for an element inside a cross-origin or scrolled nested iframe.
This schema declares the `frame` field precisely so Batch 2 (overlay
positioning) and task 5.11 ("Validate iframe and nested-scroll cases") have
somewhere to put real per-frame offset data once `content.js` is extended to
compute it — but that computation does not exist yet, is out of this batch's
file ownership (`extension/content.js` is explicitly excluded), and this
report does not claim otherwise. Treat `pointer.frame` as a forward-declared
field, not a solved problem, until a future batch populates it with real
values.

### Document identity

`DocumentIdTracker` (in `action-events.js`) keeps a per-tab generation
counter, exposed as `` `${tabId}:${generation}` ``. `extension/background.js`
instantiates one (`actionDocTracker`) and bumps it from its **existing**
`chrome.tabs.onUpdated` listener whenever `changeInfo.url` fires (the same
signal that already drives the recorder's own `navigate` event and the
audit trail — see that listener's existing `recordSwEvent("navigate", ...)`
call, unchanged), and clears it on `chrome.tabs.onRemoved` (alongside the
existing `cursorByTab.delete(tabId)` cleanup).

**This is explicitly NOT the same thing as `extension/content.js`'s own
`documentEpoch`** (a separate, finer-grained SPA-navigation tracker owned by
a parallel batch — see that file's header comment on "Document/SPA identity
tracking"). `actionDocTracker` only observes browser-visible URL changes the
`chrome.tabs` API itself surfaces (which does include History-API/SPA
navigation, since the tabs API's own `url` property changes for those too —
but not, e.g., a same-URL DOM replacement that never touches the address
bar). It exists so the schema's `documentId` field has *some* real,
monotonic value today, primarily so a stale-overlay-clearing consumer
(Batch 2, per design.md 5c: "document replacement... clear stale overlays")
has a document-generation signal to compare against, without this batch
having to touch `extension/content.js`. If a future batch wires
`content.js`'s own `documentEpoch` through to `extension/background.js` (it
is not exposed there today), that would be a strictly more precise
`documentId` source and could replace this tracker outright without changing
the schema's field shape.

### Sequencing and dedup

`nextSeq(streamKey)` returns a monotonically increasing integer starting at
1, independently **per stream**. `streamKeyForRun(runId)` returns
`` `run:${runId}` `` when a run exists, else the single literal `"legacy"`
(every external-MCP/legacy tool call shares that one bucket — there is no
run concept to key on for them, consistent with design.md 5d treating
external MCP as a distinct, non-run-scoped mode).

**Reconnect dedup semantics for Batch 3 (host-side timeline) to implement
against:** a companion reconnecting after a drop should request "everything
after sequence N" for a given `streamKey` (mirroring the existing pattern
`host/agent/storage/transcript-store.js`'s `TranscriptStore` already uses for
the SDK message stream — this batch does not touch that file, but the
pattern is the same: sequence numbers exist so a resync never re-plays or
skips a row). A `seq` gap is a genuine signal of a lost event, not
renumbering — this module never reassigns or reuses a sequence number once
issued. `resetStream(streamKey)` is provided for hygiene (drop a finished
run's counter so memory does not grow unbounded across a long session) but
is **not wired to anything in this batch** — run lifecycle/teardown is
host-owned; Batch 3 should call it when it owns tearing down a run's
resources.

**Proof:** `test/action-events-schema.test.mjs`'s "sequence numbers are
monotonic PER STREAM" section interleaves `nextSeq()` calls across two
different `streamKey`s and asserts each stream's own count (1, 2, 3, ...) is
completely unaffected by the other stream's calls.

### Redaction

Design.md 5c: *"never raw password values or secret-bearing payloads"*;
spec.md's "Sensitive input" scenario: *"the timeline identifies the action
without displaying the typed secret or exposing raw sensitive arguments."*

**There is no reliable signal in `extension/background.js` today about
whether a given coordinate/ref is a credential field** — that would require
a content-script change (detecting `<input type="password">` or similar) and
is out of this batch's file ownership (`extension/content.js` is explicitly
excluded — owned by a parallel batch). Given that, the schema takes the
categorical, root-cause-safe position rather than a heuristic one:
**`summarize(tool, args)` never derives a summary from the free-text CONTENT
of an argument that could carry a secret — only from its length** — for
exactly two argument shapes:
- `computer` `type`'s `args.text` → `` `Type (${length} characters)` ``,
  `redaction.applied: true`.
- `javascript_tool`'s `args.text` (the executed script source, which could
  contain a hardcoded token even though it is not itself "typed into a
  field") → `` `Run page script (${length} characters)` ``,
  `redaction.applied: true`.

Every other summary (`click`/`navigate`/`find`/`wait`/`scroll`/`drag`/
`capture`/`key`) is built entirely from **structural** argument shape
(coordinates, a ref name, a URL, a search query, a duration) — never from
`result` content (which could itself embed page text, e.g. `get_page_text`'s
extracted article, or `javascript_tool`'s eval output — this schema never
reads `result` to build a summary at all, by construction, so neither can
leak through this channel).

**This is a deliberate, conservative default, not the final word** — the
schema has a genuine extension point (`redaction.reason`, currently only
`"content_redacted"`) for a future, more precise signal (e.g. a real
`type="password"` detection from `content.js`) to add a second reason code
without a shape change. Documented here as a known limitation, not hidden.

**Proof:** `test/action-events-schema.test.mjs`'s redaction section builds a
summary for a `type` action carrying a literal secret string and asserts the
returned `summary` does **not** contain that string (only its length), and
does the same for a `javascript_tool` call embedding a literal token in its
source text.

### Outcome derivation

Design.md 5c: *"Successful dispatch is not proof of the intended DOM effect.
Preserve existing post-action verification and unknown-outcome states."*

This batch does **not** invent new verification. `extension/background.js`'s
`computer()` already computes a `hitNote` warning string (via
`probeHit()`/`hitNote_()`/the ref-covering check) whenever a click/hover/
scroll/drag's dispatched coordinate did not cleanly land on what was asked
for — that exact text is what the tool's own response already surfaces to
the caller today, unchanged by this batch. `deriveOutcomeStatus(hitNote)`
re-labels that **existing** signal: non-empty `hitNote` → `outcome.status:
"unknown"`, empty → `"success"`. The one additional case this batch adds is
`scroll`'s existing "post-scroll confirmation screenshot unavailable"
fallback branch (already there — the screenshot capture is best-effort and
degrades to text-only on a timeout) — also re-labeled as `"unknown"` rather
than treated as new.

`outcome.status` for `error`-kind events is unconditionally `"error"` —
`emitActionSettled()` does not let a handler's `extras` override that.

**Proof:** `test/action-events-emission.test.mjs` exercises
`deriveOutcomeStatus("")` → `"success"` and `deriveOutcomeStatus(<a real
hitNote warning string>)` → `"unknown"`, and separately proves an `error`-
kind settle always yields `outcome.status === "error"` regardless of what
`extras` contains.

## Emission wiring — where, and why one hook covers three dispatch paths

Task brief: *"instrument the real dispatch points: direct computer actions,
humanized samples, and sandbox-generated browser calls."*

- **Direct computer actions and humanized samples** — both go through
  `computer()`'s single switch statement in `extension/background.js`, which
  is where `start`/`complete`/`error` (via `handleToolRequest`, see below)
  and `progress` (via `onPointerStep`, wired per pointer-capable case) are
  emitted. Humanized dispatch (`dispatchPlan`) and direct dispatch
  (`mouseClick`'s non-humanized branch, and `computer()`'s own manual
  drag loop) both feed the SAME `onPointerStep` callback — the schema does
  not distinguish "humanized" vs "direct" as a field, because from the
  browser's point of view they dispatch through the identical CDP calls
  (`extension/background.js`'s own long-standing design: "a humanized action
  cannot do anything a normal one could not").
- **Sandbox-generated browser calls** (`execute_code`/code-mode, `host/
  codemode/**` — not touched by this batch) are **not a separate dispatch
  path at the extension boundary**: `host/codemode/common.js`'s generated
  code calls the exact same registry tools (`navigate`, `computer`, `find`,
  ...) through the exact same `host/tool-runtime.js` → native-messaging →
  `extension/background.js`'s `handleToolRequest()` route as every other
  caller (SDK adapter, legacy MCP client). This is *why* instrumenting
  `handleToolRequest()` once — rather than each of the 26 handlers
  individually — is sufficient to cover "sandbox-generated browser calls"
  without touching `host/codemode/**` at all: a script-generated `computer`
  call is, by the time it reaches `extension/background.js`, indistinguishable
  from any other `computer` call, and gets the exact same `start`/`complete`/
  `error` events (plus `progress`, since `computer()`'s own pointer wiring
  does not care who dispatched the call).

**Race-safety of the identity side-channel (`currentAction`/
`currentActionExtras`):** `handleToolRequest()` assigns these module-level
variables synchronously, immediately before calling `handler(args)`, with no
`await` in between — the exact same invariant the pre-existing
`currentToolMeta` variable already documents and relies on. Any handler that
needs the identity across its OWN internal `await`s (as `computer()` does,
extensively) must capture a **local** snapshot at its own first synchronous
line, before its own first `await` — `computer()` does this
(`const actionCtx = currentAction; const actionExtras = currentActionExtras;`
as its literal first two statements, before `await isInGroup(tabId)`),
mirroring the exact workaround `tabs_close_mcp` already uses for
`currentToolMeta` for the same reason (documented in that variable's header
comment). `handleToolRequest()` itself was **also** fixed to use its own
local (`actionCtx`/`actionExtras`, declared outside its `try` block so a
`catch` can still see them) rather than re-reading the module-level
variables after `await handler(args)` — a subtlety this batch had to get
right that `currentToolMeta` did not have to worry about (nothing re-reads
`currentToolMeta` after its own await inside `handleToolRequest`; this
batch's emission code does, in the same function, so it needed its own
per-call capture to stay correct under concurrent dispatch).

## What is BLOCKED (needs a live browser)

Everything above is genuinely testable offline and was actually executed.
What is **not** testable without a real installed extension + Chromium:
- Real CDP round trips confirming the emitted `pointer.points` coordinates
  visually correspond to where a real click/drag/hover/scroll actually
  landed on a real page (this batch proves the *numbers are the same ones
  dispatched*, not that a human watching the page would see them line up —
  that visual proof is Batch 2's overlay-rendering acceptance, task 5.11).
- Real iframe/nested-scroll coordinate cases (depends on `content.js`
  changes out of this batch's scope, per "Pointer field" above).
- A real multi-run/multi-client concurrency stress test proving the
  `currentAction`/`currentActionExtras` race-safety fix holds under actual
  native-messaging-driven concurrent dispatch (this batch proves it via
  code inspection + the documented invariant already established for
  `currentToolMeta`, not via an executed concurrent-dispatch test — building
  a real two-run concurrent harness would need the SDK/native-host
  machinery this batch does not own).

Close with: load the extension unpacked in Chrome/Edge/Brave per
`reports/05-visual-system.md`'s file-served + chrome-shim technique (for
inspection) or a full native-messaging install (for the concurrency case),
once a batch with browser access picks this up.

## Test evidence summary

- `test/action-events-schema.test.mjs` — 60 assertions, pure unit tests of
  `action-events.js` (taxonomy, pointer-capability, redaction, sequencing,
  action-id uniqueness, `buildEvent()`'s required-field and pointer-type
  enforcement, `PointBatcher` grouping, `DocumentIdTracker`, the emission
  bus). **PASS.**
- `test/action-events-emission.test.mjs` — extraction-harness + structural
  tests of the wiring in `extension/background.js`. **PASS.** Covers:
  `dispatchPlan`'s `onStep` additivity and dispatch-order/timing identity;
  `emitActionStart`/`emitActionProgress`/`emitActionSettled`/
  `makePointerStepHandler`/`deriveOutcomeStatus` compiled against the REAL
  `action-events.js`; structural proof that the five DOM/script-only
  handlers never reference pointer-emission primitives; structural proof of
  `handleToolRequest`'s `start`-before-execution and `complete`/`error`-
  after-settlement call ordering in the shipped source.
- **Full regression:** every file in `test/*.test.mjs` (25 files, including
  the two new ones) and `host/test/*.test.mjs` (all pre-existing files —
  `host/**` was not touched by this batch) passes. `node --check` on both
  modified/new extension files passes.

## Acceptance-criteria mapping

| Criterion | Where proven |
|---|---|
| `start` precedes execution | `handleToolRequest` structural ordering check + `emitActionStart` unit test |
| `complete`/`error` derive only from executor results | `emitActionSettled` unit tests (default success, explicit override preserved, error always error) + structural ordering check |
| DOM/script-only calls emit no pointer motion | `classifyAction`/`isPointerCapable` unit tests + structural absence check on the 5 handler bodies |
| Movement samples group under a parent action | `PointBatcher` unit tests + `makePointerStepHandler` integration test (shared `actionId` across a flushed batch) |
| A credential-typing action carries no secret | `summarize()` redaction unit tests (type + javascript_tool) |
| Sequence numbers are monotonic per run | `nextSeq`/`streamKeyForRun` unit test (two independent interleaved streams) |
| Instrumentation did not alter dispatch ordering/timing | `dispatchPlan` onStep-vs-no-onStep identical-calls test |
| All existing suites pass | full regression run, `test/` (25 files) + `host/test/` (all pre-existing files), reported above |

## What Batch 2 and Batch 3 build against (and must NOT re-derive)

- **Batch 2 (overlay + sidepanel timeline UI, `extension/overlay/**`,
  `extension/sidepanel/**`):** subscribe to `action-events.js`'s
  `onActionEvent(fn)` for a live, in-process stream (same extension
  execution context — no wire hop needed for the overlay). Group by
  `actionId`. Use `action.type` for taxonomy-driven rendering/labels, not
  `action.tool`/`action.op` directly (those are for debugging/fidelity, not
  for driving UI logic). Treat `pointer.frame` as forward-declared, not
  populated with real per-frame data yet (see "Pointer field" above) — do
  not assume it is safe to ignore forever, but also do not block on it if
  the current default (`frameId: 0`) is good enough for a first pass.
- **Batch 3 (host-side timeline storage, `host/**`):** there is
  **deliberately no wire transport wired up yet** in this batch — no new
  native-messaging message type, no forwarding through `nativePort`. That
  was a scope decision, not an oversight: `host/native-host.js` and
  `host/agent/**` are entirely out of this batch's file ownership, and
  `host/native-host.js`'s `routeFromExtension()` already silently ignores
  any message shape it does not recognize (verified by reading that
  function — the `msg.id`/`clientRequestMap` fallthrough at its end), so
  adding a new message type from the extension side with no host-side
  handler would be inert plumbing this batch cannot verify end-to-end
  without touching `host/**`. Batch 3 should: (1) add a native-messaging
  message type (e.g. `action_event`) carrying one schema event per message;
  (2) have `extension/background.js`'s `emitActionEvent`-driven listener
  (register one via `onActionEvent()`, best-effort `nativePort.postMessage`,
  matching the existing `postToHost` pattern `handleToolRequest`'s audit
  block already uses) forward each event — this one extra listener
  registration is the only `extension/background.js` change Batch 3 should
  need; (3) implement `host/**`-side storage keyed by `streamKey`/`seq` for
  reconnect dedup, per "Sequencing and dedup" above. Use `resetStream()` when
  a run's storage is torn down.

## Unrelated failure observed, not fixed (scope discipline)

While re-running the full suite immediately before finishing, a large amount
of unrelated concurrent work had landed from other batches in this session
(`extension/content.js`, `extension/manifest.json`, `host/**`,
`extension/sidepanel/**`, `extension/settings/**`, and many new test files —
none of it touched by this batch). One of those new files,
`test/sidepanel-slash-picker-dispatch.test.mjs`, fails on one assertion
(`errorInfo.detail` message-text mismatch for a disabled-skill slash-dispatch
rejection — `"Unknown command..."` vs. the test's expected wording). This is
entirely inside the skills/slash-picker area (`extension/sidepanel/**`,
`host/agent/skills/**`), which this batch does not own and did not touch.
Reported here per this batch's scope discipline, not fixed. Every other file
in `test/*.test.mjs` (24 of 25, excluding that one) and every file in
`host/test/*.test.mjs` passes.

## Status of tasks 5.9/5.10 after this batch

**Not complete** — this batch is explicitly the schema + emission half only.
Task 5.9 (the overlay module itself) and task 5.10's UI-facing half (labels/
durations/thumbnails/reconnect-dedup *rendering*) remain for Batch 2/3.
`tasks.md` is out of this batch's file ownership (a parallel/final
reconciliation batch owns it) — this report is the evidence a later session
should cite when updating those checkboxes' status text, not a claim that
they are now checked.
