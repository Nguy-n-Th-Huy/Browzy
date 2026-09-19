# Proposal: TypeSafe Jev Provider (Ultrafast Runtime)

## Why

Browzy's side-panel runtime currently drives every browser step through the Claude Agent SDK: the model reasons over page state in a text/tool-use loop, and latency per step is dominated by model round trips. `browser-use/jev-ultrafast` demonstrates a structurally different loop that is materially faster on the same class of tasks: an atomic DOM snapshot → one TypeSafe "System One" request that answers a structured *choice* question (operation + target, with probabilities, no text generation) → direct execution, with a small LLM used only to write text field values. TypeSafe's Jev model answers typed questions rather than producing text, so its wire shape is not a normal LLM chat protocol — the application must speak both protocols and keep both paths working. This change adds TypeSafe as a third provider whose runs use that loop, leaving the existing Anthropic/ChatGPT paths untouched.

## What Changes

- Settings gains a third provider type, `typesafe` ("Jev — ultrafast"): TypeSafe API key, text-model base URL/model/key, its own model list (seeded `jev-latest` when empty), capability test, and error surfaces. `anthropic`/`chatgpt` profiles are unchanged.
- New `host/agent/jev/` runtime in the companion: bounded observe→choose→act loop. Observe = one `page_snapshot` call returning a structured element table plus bounded page text. Choose = one `POST /v1/systemone` request carrying the operation question and every offered operation's target question (speculative fan-out, exactly one target head executes). Act = existing ref-based browser tools (`computer`, `form_input`) dispatched through the existing tool bridge.
- New registry operation `page_snapshot` (post-baseline addition, tracked in the baseline bookkeeping): structured, bounded, read-only observation available to both runtimes.
- Text values for `TYPE_TEXT` come from the configured OpenAI-compatible text model as exactly `{"text": ...}`; a missing value ends the run blocked instead of typing a guess.
- Guarded dispatch is single-sourced: the host-side checks every SDK tool dispatch already passes (run state, lease, tab scope, protected backstop) are extracted into one module the Jev runtime also calls; send-class actions route through the existing approval card flow and single-use pre-dispatch grants; result-unknown is never retried.
- New durable events (`jev_step` per decision, `jev_end` outcome) render the loop in the panel; run lifecycle, stop, transcript, reconnect, and queueing reuse the existing machinery.
- **BREAKING**: none. Protocol additions are additive under PROTOCOL_VERSION 1; an old host answers unknown settings ops with its existing PROTOCOL_ERROR, and a jev run against an extension without `page_snapshot` fails with a named observation error, never silent degradation.

## Capabilities

### New Capabilities

- `typesafe-jev-provider`: the TypeSafe Jev provider and its ultrafast runtime — profile configuration and credentials, capability test, structured observation (`page_snapshot`), single-request decision protocol with strict answer validation, small-model text values, guarded execution reusing the runtime's existing approval/confinement guarantees, bounded outcomes, and the observable step record.

### Modified Capabilities

- `agent-settings`: the provider-type set extends to `typesafe`; its profile fields, credentials, capability test, and model-discovery behavior join the existing provider requirements.
- `agent-browser-runtime`: a new post-baseline operation `page_snapshot` with its observable contract, and an explicit requirement that execution guarantees are identical whichever decision engine drives a run.
- `browser-assistant-panel`: Jev runs SHALL report their decisions, steps, and outcome in the panel, live and after a reopen.

## Impact

- **Registry**: `host/tool-definitions.js` (+`page_snapshot`), `host/agent/tools/mapping.js` (read-only classification, SDK-facing description), `test/registry-baseline.test.mjs`, README registry counts.
- **Extension**: `extension/content.js` + `extension/background.js` (snapshot builder + tool route), `extension/events/action-events.js` (read classification), extension tests.
- **Settings**: `host/agent/settings/{profile-schema,profile,errors}.js`, protocol ops (`set_typesafe_config`, `set_typesafe_credentials`), `extension/settings/*` (page, controller, client, relay allowlist), `host/agent/settings/testing/` fixture server.
- **Runtime**: new `host/agent/jev/*`; `host/agent/tools/adapter.js` (shared dispatch-checks extraction — behavior-preserving refactor); `host/agent/companion.js` (run-path branch); `host/agent/protocol.js` (event names).
- **Panel**: `extension/sidepanel/{conversation-model,sidepanel,tool-labels}.js`.
- **Docs/tests**: README provider + registry sections; new host and extension test suites; OpenSpec specs listed above.
