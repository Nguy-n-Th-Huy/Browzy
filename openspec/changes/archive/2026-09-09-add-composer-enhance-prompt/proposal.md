## Why

A draft typed into the panel composer is often vague, under-specified, or missing the concrete detail an agent needs, and the only way to improve it today is to rewrite it by hand. The operator already has a verified provider profile connected to the companion, so the model that will answer the prompt can also rewrite it first — turning a rough one-line draft into a clearer instruction without leaving the composer.

## What Changes

- The composer gains an **Enhance prompt** control placed immediately before the existing Send control. Activating it sends the text currently in the composer to the companion, which asks the configured model to rewrite that text so it is clearer and less ambiguous while preserving the operator's original language, then replaces the composer text with the rewritten version.
- A new **`enhance_prompt`** message type is added to the agent protocol as an additive request/reply pair correlated by `requestId`, with an `op` field (`generate` / `cancel`). It is gated behind the `hello` handshake like every other session-scoped message. `PROTOCOL_VERSION` is **not** bumped — an older companion answers with the existing `unknown_message_type` error, which the panel reports as an explicit "companion needs updating" state rather than a silent failure.
- The companion answers `enhance_prompt` with a bounded, single-turn model call that carries **no tools, no MCP servers, no skills, no browser lease, and no conversation session**. It is not a run: nothing is appended to any transcript, no run state is emitted, and the browser is never touched.
- Enhancement is cancellable. While a request is in flight the composer is read-only and the Enhance control acts as Cancel; cancelling, failing, disconnecting, or receiving an error all restore the exact text the operator had before the request started.
- The rewritten text is committed through the browser's own text-insertion path so the operator's native undo (Ctrl+Z) restores the pre-enhancement draft — no separate Revert affordance is introduced.
- **Out of scope** (deliberate, per the request "based on the text already entered"): page context, conversation history, attached images/files, project rules, and prompt templates configurable by the operator are **not** sent with an enhancement request. The composer text is the only input.

## Capabilities

### New Capabilities

None. The composer and its controls already belong to an existing capability.

### Modified Capabilities

- `browser-assistant-panel`: adds requirements for the composer's prompt-enhancement control — its availability rules, its in-flight/cancel/error states, the fact that enhancement never starts a run or touches the browser, and the undo guarantee for the replaced text.

## Impact

**Protocol**
- `host/agent/protocol.js` — new `ENHANCE_PROMPT` entry in `AGENT_MESSAGE_TYPES` (additive; no version bump).
- `extension/sidepanel/protocol-client.js` — mirrored `MSG.ENHANCE_PROMPT` constant plus a send method.

**Native host**
- New module `host/agent/enhance-prompt.js` — owns the rewrite instruction template, the response parser, and the bounded single-turn query options.
- `host/agent/companion.js` — new dispatch case and handler, plus per-`requestId` abort tracking for cancellation.

**Extension panel**
- `extension/sidepanel/sidepanel.html` — the new control in the composer action row.
- `extension/sidepanel/sidepanel.js` — control state machine, request/reply correlation, text replacement and restore.
- `extension/sidepanel/sidepanel.css` — busy/disabled presentation for the new control.

**Not affected**
- `extension/background.js` relays agent envelopes verbatim with no per-type allowlist (`handleAgentMessage` → `agentPorts`), so no relay change is needed.
- `host/agent/tools/query-options.js`, the browser tool registry, the session manager, and the browser lease are untouched.

**Tests**
- New plain-Node tests under `test/` following the existing convention (parser/template unit tests, protocol-client wire-shape test, companion request/reply and cancel tests against a fake SDK, composer control gating test).

**Docs**
- The panel's user-facing documentation under `docs/` gains a short description of the new control.
