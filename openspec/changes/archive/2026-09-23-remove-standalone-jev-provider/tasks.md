## 1. Host: provider type and migration

- [x] 1.1 `host/agent/settings/profile-schema.js`: drop `typesafe` from `PROVIDER_TYPES`. Remove the constants, resolvers and `createEmptyProfile` fields that only served the standalone provider (decision sources, primary screenshot and consult-sources toggles, typesafe key flags). Keep `typesafeSource`/`TYPESAFE_SOURCES` and the Jev-tools screenshot toggle, plus whatever transport endpoint defaults the Jev tools still read. Update the header comments to the two-provider contract.
- [x] 1.2 Add the one-time migration of stored `typesafe` profiles to `anthropic` at the single load-normalization point used by `loadProfile` and the run/settings readers in `host/agent/settings/profile.js`. Apply it to stored named profiles too (`host/agent/settings/named-profiles.js`). The rules are in design.md decision 2, and the result is written back atomically once. Grep every place that reads the profile file to make sure no reader bypasses the migration ← (verify: a stored typesafe profile loads as anthropic with default base URL, seed models cleared / custom models kept, lastCapabilityTest cleared, typesafeSource/jevToolsSendScreenshots kept, secret record untouched, written once; named profile likewise)
- [x] 1.3 `setProviderType`, and the companion's `set_provider_type` envelope validation, reject `typesafe` with the existing invalid-provider error. Remove the seed-on-switch logic for typesafe.

## 2. Host: remove the standalone run and test paths

- [x] 2.1 `host/agent/settings/profile.js`: remove the following, then grep each removed export or function for remaining callers:
  - `snapshotForTypesafeRun` and the typesafe branch of `snapshotForRun`;
  - `testCapabilityForTypesafe` and its branch in `testCapability`;
  - `requireTypesafeEligible`;
  - the typesafe discovery branch;
  - `readTypesafeKeys` branches only the standalone path used;
  - `resolveTypesafeDecisionModel`: keep it only if the Jev-tools capability test still needs its chatgpt branch, otherwise inline that branch there;
  - the typesafe branch of `setTypesafeConfig`, keeping the anthropic/chatgpt branch;
  - the text-model/decision key handling in `setTypesafeCredentials` that only the removed UI used, keeping the transport-key write.

  Keep `typesafeModelSeeds`/`typesafeDefaultForSource`, which the Jev-tools resolvers use.
- [x] 2.2 `host/agent/companion.js`: remove `_runTypesafe`, every `snapshot.runtime === "typesafe"` branch (run start, skills-binding skip, identity handling), and the helpers and imports reachable only from them. Keep `browser_subgoal`/`extract_page` wiring, the Jev-tools capability relay, and the `set_typesafe_config`/`set_typesafe_credentials` relays. Update comments that describe a standalone Jev run ← (verify: no remaining reference to a typesafe runtime in companion.js; anthropic/chatgpt runs with Jev tools unchanged; companion tests green)
- [x] 2.3 Remove the standalone-only references in the other host modules found by `grep -rn typesafe host/agent`: `profile-protocol.js`, `protocol.js`, `errors.js`, `tools/mapping.js`, `tools/adapter.js`, `tools/dispatch-checks.js`, `policy/authorization.js`, and `jev/*` comments. Change code only where behavior branches on the removed provider. Rewrite comments that claim a standalone Jev provider exists, and leave comments that name the Jev transport "TypeSafe" as they are. Do NOT prune engine branches in `runtime.js`/`text-helper.js`/`source-fetch.js`/`report-grounding.js`; design.md Non-Goals covers this.

## 3. Extension

- [x] 3.1 `extension/settings/settings.html`: remove the "Jev — ultrafast" provider radio and its BETA badge, `#typesafe-fields` in full, `#test-disclosure-typesafe`, and the CSS and comments only they used. Update the onboarding and provider copy to list two provider types, in Vietnamese with full diacritics. The `#jevtools-fields` section now shows for every profile.
- [x] 3.2 `settings-controller.js`, `settings-app.js`, `settings-client.js`, `connection-gate.js`, `settings-validation.js`, `errors-ui.js`: remove the state, setters, validators, renderers, gates and error copy that served only the standalone provider. That includes text-model and decision-source drafts, the primary screenshot and consult-sources toggles, typesafe test stages, and the typesafe branch of `save()`/`testConnection()`/`setProviderType`. Keep everything the Jev-tools section uses (`saveJevTools`, `testJevTools`, transport source/key, `jevToolsSendScreenshots`, `typesafeStageLabel` if the Jev-tools result still uses it) ← (verify: no dangling DOM id or state reference; provider picker shows two options; Jev-tools section save/test still work)
- [x] 3.3 `extension/background.js` and the side panel (`sidepanel.js`, `conversation-model.js`, `tool-labels.js`): remove the provider-type handling specific to the standalone provider. Keep `set_typesafe_*` relay ops and the `jev_step`/`jev_end` rendering, which `browser_subgoal` uses.

## 4. Tests

- [x] 4.1 Delete `host/test/agent-typesafe-run.test.mjs`, which covers only the removed run path. Reduce `host/test/settings-typesafe.test.mjs` to the behavior that is kept (transport credentials, non-typesafe `setTypesafeConfig`), or delete it if nothing remains. Keep `fixture-typesafe-server.mjs` if other suites still import it. List every deleted file in the report.
- [x] 4.2 Add migration tests covering an active profile and a named profile: seed list cleared, custom models kept, secret record kept, single write, idempotent on a second load. Also test that `setProviderType("typesafe")` is rejected.
- [x] 4.3 Update the settings UI tests (`test/settings-ui-*.test.mjs`, `test/settings-connection-gate.test.mjs`, the harness and the scripted companion), `host/test/agent-settings-relay.test.mjs`, and any other suite that selected or asserted the `typesafe` provider. Assert the new two-provider behavior, and do not weaken assertions.
- [x] 4.4 Run the Jev-tools suites (`jev-browser-subgoal`, `jev-extract-page`, `jev-tools-capability-test`, `settings-ui-jevtools-llm-profiles`), the engine suites (`jev-runtime`, `jev-decision-runtime`, `jev-text-helper`, `jev-capability`, `jev-client`), the companion/settings suites, then every `*.test.mjs` under `test/` and `host/test/`. Report failures outside this change's scope without editing them ← (verify: Jev tools unchanged and green; no new failures attributable to this change)

## 5. Docs

- [x] 5.1 Update `README.md` and `docs/` wherever they describe the "Jev — ultrafast"/TypeSafe provider type or its setup, so they say Jev is used through the Jev browser tools on Anthropic/ChatGPT profiles.
