## Why

On an `anthropic`/`chatgpt` profile, the Jev browser tools currently require a second, separate OpenAI-compatible "text model" (base URL, model id, API key) on top of the profile's own provider. So an operator signed in with a ChatGPT account has to configure and pay for another text-model endpoint just to turn on `extract_page`/`browser_subgoal`. The companion already speaks the Anthropic Messages wire to both primary provider types: the `anthropic` endpoint directly, and the ChatGPT account through the loopback gateway ported from CLIProxyAPI. The Jev text-model client can already use that wire. The separate text model adds nothing. The operator asked for it to go and for the configuration to shrink to "the primary provider + Jev". This deliberately reverses the earlier recorded decision "a separate Jev key, never the Anthropic key" (jev-browser-subgoal-tool design decision 5).

## What Changes

- On an `anthropic`/`chatgpt` run, the Jev text/decision model used by `extract_page` and `browser_subgoal` SHALL be the run's own primary provider and model. For `anthropic`, that is the profile's endpoint and API key. For `chatgpt`, it is the companion's loopback gateway with the run's already-issued gateway token. No separate text-model endpoint, model id or key is read for these profile types.
- **BREAKING (behavior)**: tool availability is now gated only on the Jev transport being configured, meaning the transport API key for the selected transport source (TypeSafe / Vercel AI Gateway / OpenRouter) is saved. Both tools appear together when it is saved, and neither appears when it is not. This removes the old `openai`-decision-source requirement and the old "text model alone enables `extract_page` only" state. A profile that previously had only a text model configured (no transport key) no longer offers `extract_page`.
- The Jev-tools connection test on these profiles tests the primary provider's current default model as the text model, plus the Jev transport. It never needs a separate text-model key.
- Settings: the "1. Mô hình văn bản" group (base URL, model id, API key) is removed from the LLM-profile "Jev browser tools" section. Its copy explains that the tools use the primary provider (ChatGPT account or Anthropic API) and its current model. The section keeps the transport source + key, the screenshot toggle, Test and Save.
- Saving the Jev-tools section on an `anthropic`/`chatgpt` profile succeeds with only the transport source, the transport key and the screenshot toggle. It no longer fails for a missing text-model id.
- Previously stored text-model fields and secrets are left in place, because a `typesafe` profile still uses them. They are simply no longer read for `anthropic`/`chatgpt` profiles. The standalone `typesafe` provider is unchanged.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `agent-settings`: the LLM-profile Jev-tools section and its connection test no longer collect or test a separate text model. They use the primary provider, and availability is gated on the transport alone.
- `jev-browser-subgoal`: the gate no longer requires the `openai` decision source or a separate text model. The sub-run's decision/content model is the run's primary provider.
- `jev-extract-page`: the gate becomes the configured Jev transport. The text-model call uses the run's primary provider instead of a separate text model.

## Impact

- Host: `host/agent/settings/profile.js` (the two Jev-tools resolvers, the Jev-tools capability test, the Jev-tools save path of `setTypesafeConfig`), `host/agent/companion.js` (run wiring that resolves the two tools from the run snapshot).
- Extension settings: `extension/settings/settings.html`, `settings-app.js`, `settings-controller.js`, `connection-gate.js`, `settings-validation.js` (only where they reference the removed Jev-tools text-model inputs).
- Tests: `host/test/jev-browser-subgoal.test.mjs`, `host/test/jev-extract-page.test.mjs`, `host/test/jev-tools-capability-test.test.mjs`, `host/test/agent-settings-relay.test.mjs`, `test/settings-ui-*.test.mjs`, `test/settings-connection-gate.test.mjs`.
- No new dependency and no profile schema field. The gateway (`host/agent/chatgpt/gateway.js`) and the Anthropic-wire text-model client (`host/agent/jev/text-helper.js`) are reused as is.
