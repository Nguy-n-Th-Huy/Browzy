## Why

Every browser action costs a full model round trip. A form fill — click the field, type, click the next field, type, look — spends most of its wall-clock time waiting on the model between actions that were entirely predictable before the first one was sent.

Claude in Chrome solves this with `browser_batch`: a list of tool calls executed sequentially in one round trip, stopping at the first error. browser-use reaches the same result with a list of actions per model response, capped at five, aborted when the page changes underneath it. Browzy has neither, and is the slower for it by roughly three to five times the turns on a typical form fill.

The reason this can be done without losing accuracy is that Browzy already re-validates at dispatch: a ref is re-resolved, scrolled into view and hit-tested when the action runs, not when it was written. A ref that went stale between items fails loudly instead of clicking the wrong thing.

## What Changes

- Add a `browser_batch` tool taking an ordered list of `{ name, input }` items, executed sequentially in one call. It cannot be nested.
- The batch stops, and reports where it stopped, on any of: an item returning an error; the page URL changing after an item; the focused element changing after an item.
- Coordinates written inside a batch refer to the screenshot taken before the batch, since no new screenshot has reached the model mid-batch. The tool description states this.
- **Send-class items are refused inside a batch.** A batch containing an item that classifies as send-class is rejected before anything executes, naming the offending item. Such actions require the user's own decision and must be issued as their own call.
- `find` is documented as belonging before a batch, not inside it: its output is references the model has to read before it can choose one.
- Record `browser_batch` in the enumerated set of post-baseline registry additions.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `agent-browser-runtime`: gains a requirement for sequential batched execution with its stop conditions, and a requirement that batching cannot become a route around the send/submit-class approval gate. The existing "Send/submit-class actions gate at canUseTool" requirement is preserved and explicitly extended to cover items nested inside a batch.

## Impact

- `host/tool-definitions.js` — new `browser_batch` schema.
- `host/agent/tools/mapping.js` — `browser_batch` classification; a pre-flight that classifies every item with the existing `classifySendClassCall()`.
- `host/agent/policy/can-use-tool.js` — the gate must see inside a batch rather than treating it as one opaque call. **This is the security-critical edit in this change.**
- `extension/background.js` — the batch executor: sequential dispatch through the existing `toolHandlers`, URL and focus sampling between items, stop-and-report.
- `test/fixtures/registry-baseline.json` — regenerated for the new tool.
- Existing approval tests (`approval-gate`, `approval-evidence-binding`, `send-class-classifier`) define the contract this must not weaken; new tests must prove the batch cannot bypass them.
- `extension/background.js` is a service worker — reload required.
