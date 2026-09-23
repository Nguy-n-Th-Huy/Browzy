## Why

The Jev browser tools (`browser_subgoal`, `extract_page`) are configurable on `anthropic`/`chatgpt` profiles, but two gaps make them unusable and unverifiable in practice:

- **No way to verify the Jev config.** `testCapability()` only tests the primary `chatgpt`/`anthropic` provider or a standalone `typesafe` profile; there is no test for the Jev config attached to an LLM profile. The new "Jev browser tools" settings section has a Save button but no "Kiểm tra kết nối", so a user cannot tell whether their Jev key/model works.
- **The model never uses the tools.** A real run ("Tìm gói thầu…") shows, in the extension's own log, only native tools (`computer`×27, `find`, `form_input`, `get_page_text`) and zero `browser_subgoal`/`extract_page`. Nothing in the run's guidance tells the model these tools exist or to prefer them, so it defaults to clicking inline.

This change adds a connection test for the Jev-tools config and a conditional guidance nudge so the model actually uses the tools when they are available.

## What Changes

- **Jev-tools connection test.** A "Kiểm tra kết nối Jev" affordance in the "Jev browser tools" settings section runs a capability test against the *resolved Jev config* for the current `anthropic`/`chatgpt` profile (the `openai` decision model and the text model), reusing the existing typesafe capability-test core. It reports success/failure with a host-authored, secret-free message and makes clear which tool(s) the current config enables (`extract_page` needs only the text model; `browser_subgoal` needs the decision model + text model + transport). No secret is ever shown or logged.
- **Preference guidance nudge.** When `browser_subgoal` and/or `extract_page` are actually registered for a run, the SDK-run system guidance instructs the model to prefer `browser_subgoal` for page interactions and `extract_page` for structured reads over doing them inline. The instruction is strictly conditional on the tool being present for that run and is never emitted when the tool is absent; the existing browser-automation guidance is unchanged.
- No change to the tool gates/resolvers, the tool runtime behavior, the standalone `typesafe` path, or any guard.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `agent-settings`: adds a Jev-tools connection-test requirement — an `anthropic`/`chatgpt` profile can test its Jev-tools config and get a success/failure result without exposing secrets, distinguishing which tool(s) the config enables.
- `agent-browser-runtime`: adds a requirement that when the Jev browser tools are available in a run, the run's system guidance instructs preferring them, and never references them when absent.

## Impact

- `host/agent/settings/profile.js`: a Jev-tools capability test (reusing `testCapabilityForTypesafe`/`capability-test.js` core against the `resolveJevBrowserSubgoalConfig`/`resolveJevExtractPageConfig`-resolved config; the text-model-only path validates `extract_page`, the full path validates `browser_subgoal`).
- `host/agent/companion.js`: the `test_capability` envelope (~2506) extended with a Jev-tools target (or a new op) so the extension can trigger the test.
- `extension/settings/settings.html`, `settings-app.js`, `settings-controller.js`, `settings-client.js`: a test button + result/disclosure line in the `#jevtools-fields` section, reusing the existing capability-test result rendering.
- `host/agent/tools/query-options.js`: the SDK-run `systemPromptText` assembly (~742) gains a preference instruction gated on `extraToolNames` membership of `browser_subgoal`/`extract_page`.
- Tests: host capability-test coverage (extract_page-only vs browser_subgoal-capable, bounded named success/failure, no secret leak), a settings-controller test for the button/envelope/result rendering, and a `query-options.js` test that the nudge appears only when the tools are present.
- Out of scope: which decision sources the gate accepts, the standalone `typesafe` block, tool runtime behavior, panel rendering of subgoal steps.
