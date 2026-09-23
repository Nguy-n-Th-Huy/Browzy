## Why

An `anthropic`/`chatgpt` run today reads a page with `read_page`/`get_page_text` and then spends the driving model's own reasoning to pull structured facts out of that text. Ulka (a sibling Jev extension) offers `extract_page`: the agent names the fields and types it wants, a cheaper configured model returns a schema-validated object, and any field with no clear evidence comes back `null`. This gives typed, bounded, null-honest extraction the driving model can call instead of re-deriving it inline. This change brings that capability to Browzy's LLM runs using the already-configured Jev text model, keeping the extraction read-only and the page content untrusted. Only the idea is ported; no ulka code or dependency is used.

## What Changes

- A new read-only SDK tool `extract_page({ instruction, fields })` is offered to `anthropic`/`chatgpt` runs. It observes the bound tab, asks the configured Jev **text model** to extract the caller's requested fields from that observation, and returns a JSON object keyed by those field names — every field nullable, `null` when evidence is absent or ambiguous.
- The extraction schema is built **only** from the caller's requested fields. Page-provided names, labels or instructions can never add, rename or drive a field. Field names are validated against a safe identifier pattern, with bounded field count, nesting depth and description length.
- Page content is untrusted data, never instructions. The tool extracts only from the observed snapshot; it does not scroll, navigate or mutate anything, and it needs no approval card (same read-only class as `read_page`/`get_page_text`).
- The tool is registered **only when** the run's profile has the Jev text model configured (text model base URL + model id + text-model key). Unlike `browser_subgoal`, it does not require the `openai` decision source — it uses only the text model. When the text model is not configured, the tool is silently absent (no error). It is never offered to a standalone `typesafe` run and never falls back to the Anthropic/Gateway key.
- Model/transport failure or structurally malformed output returns a bounded, host-authored named failure (no secrets), never a fabricated result. A field with no evidence is `null` — a valid result, not a failure.

## Capabilities

### New Capabilities

- `jev-extract-page`: the read-only `extract_page` SDK tool — its schema, caller-only field schema, gated availability/silent absence, untrusted-page-content rule, `null` semantics, honest failure, and no-approval read-only execution.

### Modified Capabilities

- `typesafe-jev-provider`: "Coexistence with the existing runtimes" notes that an `anthropic`/`chatgpt` run may additionally offer `extract_page` when the Jev text model is configured; additive only, standalone `typesafe` unchanged, no other behavior change.

## Impact

- `host/agent/tools/extract-page.js` (new): the read-only tool — validates the caller schema, observes the bound tab, calls the text model, validates output, maps `null`/failure.
- `host/agent/jev/text-helper.js`: reuse the existing text-model structured-call machinery (`postMemoryRequest`-style) or add one minimal exported `requestPageExtract` following the same wire/timeout/retry/no-secret-logging discipline.
- `host/agent/settings/profile.js`: a text-model-only config resolver (a looser sibling of `resolveJevBrowserSubgoalConfig`) returning the text model config or `null` — no `openai` decision-source requirement.
- `host/agent/companion.js`: register `extract_page` in the `createBrowserMcpServer` `extraTools` only when the text-model resolver is non-null.
- Page observation reuses the existing `page_snapshot` path (host/agent/jev/runtime.js `PAGE_SNAPSHOT_TOOL` via `toolBridge`); no second snapshot mechanism.
- Tests: new `host/test/jev-extract-page.test.mjs`.
- Out of scope: writing/mutating the page, scrolling/navigating for more content, action caching, `browser_subgoal` changes, standalone `typesafe` changes, extension-side settings UI.
