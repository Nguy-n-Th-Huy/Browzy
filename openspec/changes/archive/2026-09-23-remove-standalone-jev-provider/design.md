## Context

The `typesafe` provider type ("Jev — ultrafast") runs a whole conversation turn on the Jev engine. It has its own profile configuration: the endpoint and source, a TypeSafe key, an OpenAI-compatible text model, a decision-model source (`openai`/`anthropic`/`chatgpt`), and screenshot and consult-sources toggles. It also has its own capability test (`testCapabilityForTypesafe`), its own snapshot (`snapshotForTypesafeRun`, `runtime: "typesafe"`) and its own companion run path (`_runTypesafe`, branched on `snapshot.runtime` in `companion.js`).

The same engine is also reached from `anthropic`/`chatgpt` runs through `extract_page` and `browser_subgoal`, which now use the primary provider as their model. Those tools share pieces with the standalone provider:

- the typesafe secret record, which holds the transport key;
- `setTypesafeConfig`'s non-typesafe branch, which holds `typesafeSource` and `jevToolsSendScreenshots`;
- `typesafeModelSeeds`, which supplies the Jev transport's model id;
- `typesafeDefaultForSource`;
- `runTypesafeCapabilityTest`;
- the Jev client, questions, runtime (subgoal mode) and text-helper;
- the side-panel `jev_step`/`jev_end` rendering.

## Goals / Non-Goals

**Goals:**
- `typesafe` is no longer a selectable, storable or runnable provider type.
- Every UI, host and protocol surface that exists only for the standalone provider is removed, together with its tests.
- Stored `typesafe` profiles, both active and named, keep working after migrating to `anthropic`, and their Jev transport key keeps enabling the Jev browser tools.
- The Jev browser tools behave exactly as before.

**Non-Goals:**
- Pruning the engine's non-subgoal branches (completion check, final report, source consultation, answering the operator) from `runtime.js`, `text-helper.js`, `source-fetch.js` and `report-grounding.js`. After this change these branches are unreachable from product code but still have unit tests. They are left as a conscious trade-off, for a follow-up engine refactor that can be verified in isolation, so that `browser_subgoal` is not destabilised by a mixed deletion.
- Deleting stored secrets. The legacy text-model key stays in the typesafe record, inert.
- Renaming the `set_typesafe_config`/`set_typesafe_credentials` envelopes or the `browzy-in-chrome/typesafe/<profileId>` secret target. They are wire and storage contracts that the Jev-tools section still uses.

## Decisions

1. **Provider types are `anthropic` and `chatgpt` only.** `PROVIDER_TYPES` drops `typesafe`. `setProviderType` and the `set_provider_type` envelope reject `typesafe` with the existing invalid-provider error. `isKnownProviderType("typesafe")` becomes false. Constants that only served the standalone provider are removed: `TYPESAFE_DECISION_SOURCES`, `resolveTypesafeDecisionSource`, `DEFAULT_SEND_SCREENSHOTS`/`resolveSendScreenshots`, consult-sources, `DEFAULT_TYPESAFE_BASE_URL` (unless the transport endpoint table still needs it), and the typesafe fields in `createEmptyProfile`. `typesafeSource`, `jevToolsSendScreenshots`, `typesafeModelSeeds` and `typesafeDefaultForSource` are kept, because the Jev browser tools use them.
2. **Migration happens once, at the load normalization point.** The chosen point is the single function every read goes through: the one `loadProfile`/`readProfileFromDisk` use, and the equivalent point in `named-profiles.js` for stored named profiles. A stored profile with `providerType === "typesafe"` is rewritten as follows:
   - `providerType: "anthropic"`;
   - `baseUrl` set to `DEFAULT_BASE_URL`;
   - if `models` exactly equals a Jev seed list (any source's seed), then `models: []` and `defaultModelId: null`; otherwise both are kept;
   - `lastCapabilityTest: {}`;
   - the standalone-only fields removed: `typesafeDecisionSource`, `typesafeDecisionBaseUrl`, `typesafeDecisionModelId`, `sendScreenshots`, `consultSources`, `hasTypesafeKey`/`hasTextModelKey` where they only served the removed block;
   - `revision + 1`;
   - `textModelBaseUrl`/`textModelId`, `typesafeSource` and `jevToolsSendScreenshots` kept.

   The result is written back atomically through the existing store, so the migration runs once. The secret record is untouched. The primary Anthropic credential is absent, so the profile reports "no API key" until the operator enters one, which is the existing honest state. Alternative rejected: refusing to load (`INVALID_PROFILE`). The operator chose automatic migration.
3. **The standalone run path is deleted.** The following are removed: `snapshotForTypesafeRun`, the `typesafe` branch of `snapshotForRun`, `testCapabilityForTypesafe` and its branch in `testCapability`, `requireTypesafeEligible`, and the typesafe discovery branch. In `companion.js`, `_runTypesafe`, the `snapshot.runtime === "typesafe"` branches, the typesafe skip in the skills binding, and every helper reachable only from `_runTypesafe` are removed. `resolveTypesafeDecisionModel` is kept only if the Jev-tools capability test still uses its chatgpt branch; otherwise that branch is inlined there. `setTypesafeConfig` keeps only the anthropic/chatgpt branch, which persists `typesafeSource` and `jevToolsSendScreenshots`. The typesafe branch goes. `setTypesafeCredentials` keeps writing the transport key, and whatever text-model-key write paths only the removed UI used are removed with it.
4. **The UI removes the whole standalone block.** The provider radio "Jev — ultrafast" and its BETA badge are removed, along with `#typesafe-fields` and its CSS and beta-notice rules, `test-disclosure-typesafe`, and every controller state, setter, validator and renderer that only served them. That includes the text-model drafts and decision-source controls, provided they are no longer used by the Jev-tools section, which since the previous change collects only the transport. Connection-gate and error copy for typesafe stages are removed where only the standalone test produced them. The Jev-tools test's stage labels are kept: it still reports `textModel`/`systemone`. Onboarding lists two provider types.
5. **Tests and fixtures.** `host/test/agent-typesafe-run.test.mjs` is deleted, because it covers only the removed path. `host/test/settings-typesafe.test.mjs` is reduced to what remains: the transport-key credentials and the non-typesafe `setTypesafeConfig` branch. If nothing remains, it is deleted. `fixture-typesafe-server.mjs` is kept if the Jev-tools or engine tests still use it. New tests cover the migration of an active profile and a named profile, including a custom model list being kept, the secret record being kept, and a single write. Engine unit tests (`jev-runtime`, `jev-decision-runtime`, `jev-text-helper`, and the others) are left as they are.

## Risks / Trade-offs

- An operator on a `typesafe` profile finds an `anthropic` profile with no key after upgrading. → That is the honest state. The existing no-key messaging and the Jev-tools section (still configured) explain it.
- Deleting shared helpers by mistake could break the Jev browser tools. → The apply step greps every removed export for remaining callers. The Jev-tools suites (`jev-browser-subgoal`, `jev-extract-page`, `jev-tools-capability-test`, `settings-ui-jevtools-llm-profiles`) must stay green.
- Unreachable engine branches remain. → This is recorded in Non-Goals as a follow-up.

## Migration Plan

The automatic on-load migration is described in Decision 2. Rollback: an older build reading a migrated profile sees a valid `anthropic` profile, so there is no data loss. Profiles cannot be migrated back to `typesafe`, and that is intended.

## Open Questions

None.
