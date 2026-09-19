## Context

`markdown-lite.js` escapes untrusted text and supports tables, but only links explicit Markdown links. Its list collector ends at blank lines and discards numeric starts. `text-helper.js` asks for substantial analysis and next steps even for small extractions. The panel groups planning and verification with actions. Jev `capturePage()` currently returns optional in-memory `{data, mimeType}` only for planning/completion when `provider.sendScreenshots === true`; existing panel requirements already call for historical screenshot previews.

## Goals and non-goals

Implement all five authorized comparison findings without broad redesign. Keep grounded answers, independent completion verification and execution/privacy gates. Do not infer task success from a click or page change.

## Decisions

### Answer rendering

Keep the escaped renderer. Tokenize HTTP(S) bare URLs outside code and existing anchors; preserve query strings and balanced punctuation. Preserve explicit ordered starts and multiline/loose item boundaries. Reuse the scrollable table wrapper. Never accept model HTML or unsafe schemes.

### Task-first reports

Adjust completion and terminal-report instructions together: requested fields first, compact lists/tables for extraction, suggestions only when useful or requested. Preserve the report envelope and grounded URL validator. Recognized secondary sections may become renderer-owned accessible disclosures; arbitrary HTML stays escaped. Missing requested information and stopped/blocked outcomes remain visible. Per-result source links remain visible; long query diagnostics may be secondary. Historical freeform reports retain fallback rendering.

### Progress and count semantics

Emit host-owned phases at real boundaries: planning, observing/reading, deciding, executing, waiting, verifying and reporting. Phase does not mean success. Terminal, permission and stopping states take priority. Additive run/step-correlated metadata must restore without duplicate rows. Count actual dispatched browser operations separately from planning/read/check activity; skipped DONE verification and replans are not browser operations. Preserve conservative historical fallbacks.

### Evidence

Associate bounded masked before/after observations with actual dispatched steps, including relevant document/target changes and timestamps. Reuse the existing capture/artifact/preview pipeline for historical image references; never recapture when opening a thumbnail. Preserve explicit screenshot opt-in, scope/lease/run checks, masking and retention. Do not put raw image bytes in ordinary event summaries or send screenshots to Jev. Disabled, failed or stale captures produce honest unavailable reasons and text evidence. Capture failure never causes an uncertain mutation retry. Host and panel owners must agree concrete additive event fields before implementation and append the contract here.

### Host phase and evidence contract

`jev_phase` carries `{phase, step}` plus the run's existing correlation fields. Phase values are `planning`, `observing`, `deciding`, `executing`, `waiting`, `verifying`, `reporting`, emitted immediately before actual work; duplicate adjacent phase/step pairs are coalesced. `step` remains the current attempted operation through post-action observation. Terminal and approval UI states override these advisory phases.

Every new `jev_step` has an explicit `dispatched` boolean. It is true only once the mutation crosses the tool bridge, including unknown outcomes; false for verification, replanning, denied/stale/skipped actions. Legacy absence remains distinguishable. Existing `skippedReason: result_unknown` and terminal handling remain unchanged.

Dispatched rows also carry `actionOutcome: succeeded|failed|unknown`. Known tool failures remain counted attempts and may recover after fresh observation, but their action history is `outcome: failed` and the UI must not label them successful. Optional `actionError: {code,message}` uses bounded host-authored categories (`TARGET_OBSTRUCTED`, `TOOL_ERROR`, `NAVIGATION_ERROR`, `RESULT_UNKNOWN`), never raw tool error prose that might echo private input. Completion remains independently verified after any recovery.

Dispatched rows carry `evidence: {before, after, changes?}`. An observed side contains `{observedAt, url, urlTruncated, title, text, textTruncated, target, screenshot}`. URL/title/text are capped at 200/160/1000 characters; target is null or `{ref,role,label,checked?,expanded?,disabled?}`, never typed values or prepared content. `changes` contains `{pageChanged,documentChanged,targetChanged}`. An unavailable after-side is `{unavailableReason: stopped|observation_failed|result_unknown}`.

Screenshot is `{status: disabled}` when the user's existing screenshot option is off; `{status: available, artifactId, mimeType}` only for a real capture reference; or `{status: unavailable, reason}`. Reasons include capture failure, missing reference, blank capture, unavailable run/scope/page and stale capture. The artifact ID is extracted from the existing screenshot tool's canonical `Successfully captured screenshot ... - ID: screenshot_<number>` result. Background's existing COMPLETE action event sends exactly those bytes through the existing `action_artifact` chunk/store pipeline. A reference does not guarantee retention: the existing artifact request can still report missing/expired. No event contains image bytes, no new file writing occurs, and opening evidence must never recapture.

Before-image capture occurs after approval and target preflight. A fresh observation and final shared execution checks follow it before any mutation. After-images require an unchanged observation/document/target through the capture; otherwise the reference is withheld as stale. Capture failure alone does not alter or replay a mutation; unknown mutation outcomes retain before evidence and an unavailable after-side. Planning/completion images remain separate in-memory LLM inputs and never go to Jev.

### Scenario validation

Use changing browser fixtures that assert dispatches and completion, not just prompt text. Obstruction must recover or report honestly; delayed results must permit bounded observation without resubmission; empty results must not fabricate records; pagination and changed filters must remain legitimate new work. Parent live QA repeats the public search and inspects rendered links/numbering/table, phases/counts and historical evidence, plus representative difficult scenarios.

## Risks

Renderer changes require hostile markup, code-fence, URL query and list-boundary regressions. Evidence requires bounded storage/transport and disabled/failure tests. Telemetry must preserve unknown/cancelled outcomes. Disclosures must not hide material incompleteness.

## Validation

Run focused runtime/helper/grounding and panel rendering/model/history checks, required repository checks, independent review and live Brave QA after reload. Record concrete evidence and limitations in this directory.
