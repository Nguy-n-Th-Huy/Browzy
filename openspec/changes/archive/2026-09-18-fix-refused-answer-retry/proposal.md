# Proposal: Refused-Answer Retry

## Why

Seen live: after the run navigated from dauthau.asia to youtube.com, the very next **step decision** came back as prose rather than a JSON object — the host refused it, dispatched nothing, and ended the run `error` / `invalid_decision` after a single executed step (`run_adb7f08c73bbf9b9b7`, "mở nhạc youtube thế ggiowis của anh"). Nothing in the protocol asks the model a second time: one refused answer ends the run. The model's output shape is the one thing the host cannot control, and a large model through a gateway will occasionally wrap its object in prose or markdown fences even under a JSON response format. The host must stop treating that as terminal, ask once more with the refusal carried back as feedback, and name what came back when it still fails.

## What Changes

- **A refused answer is asked again exactly once.** `postMemoryRequest` — the shared transport for every answer the configured model gives: the step decision, the run plan, memory revisions, stall recoveries, and the completion check — retries once when its own validation refuses the answer (a malformed shape, a missing text value, an invalid URL, a memory that is not the required object), appending the refused answer and the refusal reason as a corrective turn. Only a second refusal is acted on with today's outcome.
- **A fenced answer is unwrapped before the strict parse** (a ```` ```json … ``` ```` wrapper around an otherwise valid object), because that is the benign wrapper the live refusal is expected to have come from. Nothing heuristic: the unwrapped text still faces the strict parse and the full validator.
- **The refusal names what came back.** The failure message gains a bounded preview of the model's own reply (or states that it was empty), mirroring the existing "a non-JSON success body names its cause" rule, so the next occurrence is diagnosable from the panel alone.
- **Unchanged**: validation strictness, every terminal outcome (a second refusal still ends `invalid_decision` / `blocked` / `text_model_error` exactly as today), the transport retry policy, and page-content untrustedness.

## Capabilities

### New Capabilities
- (none)

### Modified Capabilities
- `typesafe-jev-provider`: "Step decisions from the configured model" (the one-feedback-retry sentence + the reworded malformed scenario + a new scenario) and "Run plan and context held by the configured model" (the same one-retry sentence for the memory calls).

## Impact

- **Host**: `host/agent/jev/text-helper.js` (`postMemoryRequest`, `parseMessageObject`, the shared builder), `host/test/jev-text-helper.test.mjs`, `host/test/jev-runtime.test.mjs`.
- **Docs/specs**: `openspec/specs/typesafe-jev-provider/spec.md` via this change's delta.
