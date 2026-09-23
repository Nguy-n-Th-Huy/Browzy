## Why

The Jev engine now reaches operators through the `extract_page`/`browser_subgoal` tools on `anthropic` and `chatgpt` profiles, and those tools reuse the primary provider as their text/decision model. The standalone "Jev — ultrafast" provider type (`typesafe`) duplicates that same engine behind a second provider. It has its own settings block, text-model and decision-source configuration, capability test and run path. The operator asked for it to be removed completely. The goal is one way to use Jev and no leftover configuration.

## What Changes

- **BREAKING**: remove the `typesafe` provider type. `PROVIDER_TYPES` becomes `anthropic` and `chatgpt`.
  - Settings no longer offers the "Jev — ultrafast" radio or its `#typesafe-fields` block. That block holds the endpoint, the source, the TypeSafe key, the text-model fields, the decision-source fields, the screenshot and consult-sources toggles, the beta notice and the typesafe disclosures.
  - Onboarding copy no longer mentions it.
- Remove the companion's standalone Jev run path (the `runtime: "typesafe"` snapshot branch and the code that starts a standalone Jev run for a conversation). Also remove the profile-layer code that only served that path:
  - `snapshotForTypesafeRun` and `testCapabilityForTypesafe`;
  - `requireTypesafeEligible`, `resolveTypesafeDecisionModel` (only where it serves the removed path), and the typesafe decision-source and model-seed switching;
  - the typesafe-specific handling of the text-model and decision fields in `setTypesafeConfig`.
- **Migration**: a stored profile whose `providerType` is `typesafe` loads as `anthropic`, and the migration is written back once.
  - The TypeSafe endpoint `baseUrl` becomes the default Anthropic base URL.
  - A model list equal to the Jev seed (`jev-latest`), together with its default, is cleared. Any other entries are kept.
  - `lastCapabilityTest` is cleared.
  - The typesafe secret record is kept, so a saved Jev transport key keeps enabling the Jev browser tools. The legacy text-model key and fields stay stored but are never read.
  - The same rule applies to named profiles.
- Keep the shared Jev engine used by the Jev browser tools. This covers the Jev transport client and sources, `page_snapshot`, the decision questions, the subgoal mode of the runtime, the text-helper functions the tools and their capability test call, the Jev-tools capability test, the transport-key credential envelope, and the side-panel `jev_step`/`jev_end` rendering.
- Out of scope (explicit trade-off): the runtime's standalone-only branches become unreachable from product code. These cover the completion check, final report, source consultation and answering the operator in the non-subgoal mode, and they stay covered by their existing unit tests. Pruning them from `host/agent/jev/runtime.js`, `text-helper.js`, `source-fetch.js` and `report-grounding.js` is a separate engine refactor. It is not bundled here, to keep the `browser_subgoal` engine safe.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `agent-settings`: provider types are only `anthropic` and `chatgpt`, stored `typesafe` profiles migrate to `anthropic`, and the typesafe settings, test, discovery and onboarding clauses are removed.
- `typesafe-jev-provider`: the standalone provider-type, configuration-surface, capability-test and coexistence requirements are removed. The credential-storage requirement is narrowed to the Jev transport key used by the Jev browser tools.
- `jev-browser-subgoal` and `jev-extract-page`: the "standalone Jev run does not offer it" scenarios are dropped, because such a run no longer exists.

## Impact

- Host:
  - `host/agent/settings/profile-schema.js`, `profile.js`, `named-profiles.js` and `profile-protocol.js`, wherever they validate provider types;
  - `host/agent/companion.js` (the standalone run branch, and the `set_provider_type` validation);
  - `host/agent/settings/testing/fixture-typesafe-server.mjs` (only if the removed tests alone use it).
- Extension:
  - `extension/settings/settings.html`, `settings-app.js`, `settings-controller.js`, `settings-client.js`, `connection-gate.js`, `settings-validation.js` and `errors-ui.js`;
  - any provider-type handling in `extension/background.js` and the side panel.
- Tests: `host/test/agent-typesafe-run.test.mjs` and `host/test/settings-typesafe.test.mjs` (removed or reduced to the kept Jev-tools behavior), the settings UI tests, and new migration tests.
- Specs: `agent-settings`, `typesafe-jev-provider`, `jev-browser-subgoal`, `jev-extract-page`.
