## Why

The host already persists and reads Jev configuration on any profile, and gates the `browser_subgoal` and `extract_page` tools on it (`resolveJevBrowserSubgoalConfig` / `resolveJevExtractPageConfig` in host/agent/settings/profile.js). But the Settings UI shows the Jev configuration block only when the provider type is `typesafe` (`extension/settings/settings-app.js`: `$("typesafe-fields").hidden = !isTypesafe`). On an `anthropic` or `chatgpt` profile there is no field to enter the Jev endpoint, source, decision model, keys, or text model — so a real user can never turn on `browser_subgoal`/`extract_page` even though the backend fully supports it. This change adds the missing UI.

## What Changes

- A new, opt-in **"Jev browser tools"** section appears in Settings on `anthropic` and `chatgpt` profiles (not on `typesafe`, which already carries its full Jev config as its primary provider). It is additive and off by default: a profile with nothing entered behaves exactly as today, and both tools stay silently absent.
- The section collects exactly what the two host resolvers read, in **separate inputs** that never touch the profile's primary Anthropic/ChatGPT fields:
  - **Text model** (enables `extract_page`, and required by `browser_subgoal`): base URL, model id, text-model API key.
  - **Decision model** (additionally enables `browser_subgoal`): the `openai` decision source with its base URL, model id, and decision API key — the section makes clear `browser_subgoal` requires this separate-key source.
  - **Transport** (for `browser_subgoal`): Jev source, endpoint, and typesafe API key.
- Keys are saved through the existing secret-store path (`set_typesafe_credentials`) and are never shown back, with the same "saved / clear key" affordances as the current key inputs. Non-secret config saves through `set_typesafe_config`.
- Availability stays honest: partial config leaves the corresponding tool absent (the host gate is the authority); the UI labels which group enables which tool but never claims a tool is active.
- No change to the primary Anthropic/ChatGPT settings, the standalone `typesafe` block, the host gate/resolvers, or the tool runtime behavior.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `agent-settings`: adds a requirement that a profile driven by an LLM provider (`anthropic`/`chatgpt`) can additionally configure the Jev browser tools through separate, opt-in settings fields, saved through the existing config/credential envelopes, with secrets isolated and no regression to the primary provider configuration.

## Impact

- `extension/settings/settings.html`: new "Jev browser tools" section markup with distinct input ids (mirroring the `typesafe-fields` inputs, not reusing them).
- `extension/settings/settings-app.js`: show the new section for `anthropic`/`chatgpt` (and keep it hidden for `typesafe`, which uses its own block); render saved/cleared key state; never render a secret.
- `extension/settings/settings-controller.js`: state and handlers for the new fields, saving via the existing `set_typesafe_config` / `set_typesafe_credentials` paths; reuse `typesafeSourceCopy` and related helpers.
- `extension/settings/settings-client.js` / `settings-validation.js`: field plumbing/validation only if a real gap is found.
- Tests: settings coverage that the section shows for `anthropic`/`chatgpt`, hides for `typesafe`, persists config+keys via the existing envelopes, leaves primary fields untouched, and renders no secret.
- Out of scope: host gate/resolvers (already shipped), the standalone `typesafe` block, which decision sources the gate accepts, and `browser_subgoal`/`extract_page` runtime behavior.
