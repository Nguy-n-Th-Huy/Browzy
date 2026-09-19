# Proposal: Jev Run Screenshots (vision context for the configured model)

## Why

The configured model behind a TypeSafe (Jev) run decides every step from text alone — the page identity, the bounded text, and the recent steps — even when it is a vision-capable model whose strongest sense is exactly the one being starved. The structured element table stays Jev's job (nobody else should pay for it), but the step decision and the completion check can and should see the page: one screenshot per cycle, attached to the model's request. This is the follow-up the archived `add-jev-run-context` change explicitly deferred.

## What Changes

- **A capture rides the step decision.** When screenshots are enabled (the default), each run cycle captures the bound tab — after the structured observation — through the same read-only dispatch discipline every observation passes (run-state, lease, tab-scope checks; no approval; nothing changes on the page), and attaches the capture to that cycle's step-decision request for the configured model as image content beside the textual context. The capture is unannotated (no reference labels — the model must never confuse them with Jev's numbered table) and is never written to disk by this feature.
- **A failed capture never blocks.** The cycle proceeds text-only and a later cycle captures again — screenshots are an enhancement, not a dependency.
- **The completion check reuses the step's capture.** A `DONE` step's check sees the same image its decision saw; when a cycle has no capture, the check proceeds as today.
- **Jev's element-selection request never carries captures.** It answers only over the structured observation; the split from `add-jev-run-context` is unchanged.
- **A profile-level toggle, enabled by default.** `Gửi ảnh chụp màn hình cho mô hình quyết định` lives with the TypeSafe fields; a profile stored before the toggle existed loads with it enabled. Turning it off makes every request text-only.
- **Test connection proves image support.** A third capability stage sends one minimal completion carrying a small embedded image to the text-model endpoint and reports it separately (`image`); it SHALL NOT decide runnability — a text-only model remains runnable with the toggle off, and settings can point at the toggle (or a vision model) when the stage fails. The recorded result keeps its (endpoint, model, credential revision) key; stored results without the image stage show it as not yet tested.
- **Copy and disclosure.** The settings disclosure and README name the screenshots among the requests sent to the configured text-model endpoint (page content included), and the README documents the added calls and the cost control.
- **Unchanged**: the element-selection wire and its validation; the step-decision/completion-check strict validations; the dispatch discipline (a capture is a read-only dispatch under the same checks); the run records and events (a capture surfaces in the existing action timeline like any capture — no new event kinds); bounds; `anthropic`/`chatgpt` runs.

## Capabilities

### New Capabilities
- (none — the change extends existing capabilities)

### Modified Capabilities
- `typesafe-jev-provider`: a screenshot context for the configured model (per-cycle capture, advisory failure, completion-check reuse, the per-profile toggle), the capability test gains a separately reported image stage, and the step-decision and completion-check requirements name the capture among their inputs.
- `agent-settings`: the TypeSafe profile gains the screenshot toggle (enabled by default), the disclosure names the screenshots sent with the step decisions and completion check, and the connection test's typesafe stages gain the separately reported image stage.

## Impact

- **Host**: `host/agent/jev/runtime.js` (per-cycle capture through the bridge, attachment wiring, completion-check reuse, the provider flag), `host/agent/jev/text-helper.js` (multimodal message builders for the step decision, the completion check, and the capability probe), `host/agent/jev/capability.js` (image stage + the embedded test image), `host/agent/companion.js` (pass the toggle through the provider object), `host/agent/settings/profile.js` + `profile-schema.js` (the non-secret toggle field, default enabled), `host/test/` suites and the fixture server.
- **Extension**: `extension/settings/settings.html` (toggle + hint), `extension/settings/settings-controller.js` / `settings-app.js` / `settings-client.js` (read/write the toggle, render the image stage), `extension/settings/errors-ui.js` (stage copy for the image stage), their tests.
- **Docs/specs**: README (the Jev section: screenshots, toggle, test stage, costs), the two capability deltas above.
- **External calls**: one capture per cycle (local) and an image part on the configured model's step-decision requests (plus the check's reuse), billed by the text-model provider; the test adds one small image request. The toggle is the cost and privacy control.
