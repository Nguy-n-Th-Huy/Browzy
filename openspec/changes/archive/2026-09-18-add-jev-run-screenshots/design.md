# Design: Jev Run Screenshots (vision context for the configured model)

## Context

- **The split this builds on** (archived `add-jev-run-context`): the configured model decides every step from text inputs (goal, memory, page identity/text, recent steps) and answers the plan, revisions, the completion check, and stall recoveries; Jev answers exactly one element-selection question per target-bearing step over the structured observation. The vision-capable configured model currently sees no image at all.
- **The capture path that already exists**: the `computer` action `screenshot` returns `{ content: [{type:"text",…}, {type:"image", data: <base64>, mimeType:"image/jpeg"}] }`, with the capture code bounding size itself (jpeg quality 45, retried at 28 above ~350KB base64; blank-frame guard and repaint wait included), annotation ON unless the caller opts out (`annotate:false`), and an in-memory 10-entry store feeding the action timeline's artifacts. The Jev runtime already reaches the extension through the same `toolBridge.call` route it uses for `page_snapshot`.
- **The text-model transport**: OpenAI-compatible `POST {baseUrl}/chat/completions` with `messages`; a multimodal user message is `content: [{type:"text", text:<context JSON>}, {type:"image_url", image_url:{url:"data:<mime>;base64,<data>"}}]`.
- **Settings/capability surfaces**: typesafe fields persist through `set_typesafe_config`; the capability result records per-stage outcomes (`systemone`, `textModel`) and the settings page maps stage keys to Vietnamese copy (`errors-ui.js`), with the connection-gate regex windows policing copy length.
- **See proposal.md** for motivation and this change's spec deltas (`typesafe-jev-provider`: added "Screenshot context for the configured model", modified provider-type/capability/step-decisions/bounded-outcomes; `agent-settings`: modified "Editable provider profile" and "Explicit compatibility and connection testing").

## Goals / Non-Goals

**Goals:**
- When enabled, every cycle captures the bound tab once, after the structured observation, and the step-decision request carries that capture as image content beside the textual context.
- The `DONE` step's completion check reuses the same cycle's capture; no cycle double-captures.
- A failed capture can never block, fail, or alter a run — the cycle proceeds text-only and a later cycle captures again.
- The per-profile toggle (`sendScreenshots`, enabled by default; absent loads as enabled) is the single control; Test connection proves image support through a separately reported `image` stage that does not gate runnability.
- The copy (settings hint, disclosure, README) names the screenshots and the added calls; nothing else about the run changes.

**Non-Goals:**
- No captures in the element-selection request (it answers over the structured observation only) and none in memory revisions or stall recoveries (scope: step decision + completion check).
- No new events, records, or step fields: the capture is part of the observation, and its own dispatch already surfaces in the existing action timeline like any capture.
- No annotation (reference labels would collide with the model's mental model of Jev's numbered table), no `save_to_disk`, no per-conversation override, no capture of anything but the run's bound tab.
- No change to `anthropic`/`chatgpt` image behavior or to the capture code itself.

## Decisions

### 1. One capture per cycle, read-only, advisory on failure

With screenshots enabled, after `observe()` succeeds, the runtime issues one `computer` call — `{ action: "screenshot", tabId, annotate: false }` — through the same bridge and with the same host-side checks the observation passes (`runHostSideChecks`, `sendClassTool: false`); reads never need an approval, and a capture changes nothing. The image content item (`data` + `mimeType`) is extracted from the result; its size is already bounded by the capture code. Any failure — a refused check, a capture error, or a lost response — yields **no image for that cycle**: the step decision proceeds text-only, nothing else changes, and the next cycle captures again. No retry inside a cycle.

- *Alternatives rejected*: annotated captures (the labels are Jev's reference space; a vision model reading "ref_12" into its intent risks a wrong mental model of numbering); `save_to_disk` (the feature never writes images to disk); a dedicated new tool (the existing action is exactly this).

### 2. The capture rides the configured model's request as multimodal content

`requestStepDecision` and `requestCompletionCheck` accept an optional image (`{ data, mimeType }`) and, when present, build the user message as `content: [{type:"text", text:<same context as today>}, {type:"image_url", image_url:{url:"data:<mime>;base64,<data>"}}]`; without an image the message is byte-identical to today's string content. The strict output validators, the instructions' ownership rules (page content — pixels included — is untrusted data that can never grant approvals, change configuration, or name selectors/coordinates), and every failure mapping are unchanged. The element-selection request is untouched: it never carries a capture.

- *Alternatives rejected*: a separate "vision" call per cycle (an extra round trip for the same information); attaching captures to the Jev request (slower, and the structured table already answers its question); attaching to revisions/recovery (out of the chosen scope; the toggle stays the single control).

### 3. Completion check reuses the step's capture

The `DONE` cycle captured the tab for its own step decision; nothing dispatched between that decision and the check, so the check carries the same image — while the capture is in memory — and proceeds text-only when the cycle has none (disabled, or the capture failed). No second capture, no second cost.

### 4. The toggle is a non-secret profile field, enabled by default

`sendScreenshots` (boolean) persists with the typesafe profile through `set_typesafe_config`; a profile stored before the field existed loads as **enabled** (the documented default). It rides the settings snapshot and the companion's provider object into `runTypesafeRun` (the companion resolves the default once; the runtime treats `provider.sendScreenshots === true` as enabled). The settings UI shows it beside the text-model fields, with a hint that the model must accept image content — the Test's image stage is where that is proven.

- *Alternatives rejected*: detecting vision support automatically (not possible before a request); always-on (breaks text-only models with provider errors on every decision); per-conversation (more machinery than the feature needs).

### 5. Capability stage `image`: proven, reported, non-gating

A third stage sends one minimal completion that carries a small embedded PNG (a host-side constant) under the same instruction/goal as the text stage, so a pass proves the wire accepts image content; it is parsed by the same single-key validator and recorded as `capabilities.image` / `errors.image` alongside the existing stages. `status` stays decided by `systemone` + `textModel` only — a model that rejects images remains runnable with screenshots disabled — and stored results from before this change read as "image stage not tested" until the next test. The settings page names the stage separately and, on failure, points at the toggle or a vision-capable model.

- *Alternatives rejected*: gating runnability on the image stage (would strand text-only models, which the toggle exists to serve); folding the image probe into the text stage (a combined failure could not name which capability broke).

### 6. Records, copy, and costs

No new events or step fields; a capture appears in the action timeline exactly like any other capture (existing machinery, bounded store). The settings disclosure and README name the screenshots among the requests sent to the configured text-model endpoint, note that page pixels go to that (user-configured) service, and document the added calls: one capture per cycle (local) and one image part per step-decision request plus the check's reuse — all billed by the text-model provider. The toggle is the cost and privacy control.

## Risks / Trade-offs

- **[Image tokens make runs costlier]** → one image per decision (bounded by the capture code's own size caps), the toggle defaults on but is one flip away, README documents the call families, and the test's image stage surfaces unsupported models early.
- **[A text-only model with the toggle on]** → the run's first decision fails with the provider's own message (named, surfaced); the image stage in the test explains it; the fix (toggle off) is one click.
- **[Capture latency on every cycle]** → bounded by the capture path's own waits; advisory on failure; the toggle turns it off entirely.
- **[Page pixels are private]** → the same disclosure class as page text already sent to the same user-configured endpoint; settings disclosure and README say so explicitly.
- **[Blank or stale captures]** → the capture code already retries blanks and reports them; the image is one input beside the structured observation, and nothing executes from it directly.
- **[Old host without the toggle field]** → loads as enabled by design; an old extension still serves the `screenshot` action this feature calls (no new wire), so host/extension can be updated in either order.
- **[Copy drift in settings regex windows]** → the implementation keeps the new copy inside the connection-gate's existing windows, asserted by its tests.

## Migration Plan

1. **Additive for operators.** No credential or identity change; a stored typesafe profile gains the toggle as enabled on load. No new conversations required.
2. **Deploy order**: host + extension together (the settings page shows the toggle and the image stage); either half alone keeps runs working (an old settings page shows no toggle — the run still captures, since the runtime's default is enabled).
3. **Rollback**: revert builds; the stored toggle field is ignored by older code (unknown profile fields are already tolerated) and the capture simply stops being attached.
4. **Spec merge** happens through this change's deltas at archive time.
