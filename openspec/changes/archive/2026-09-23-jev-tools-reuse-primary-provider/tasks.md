## 1. Host: primary provider as the Jev-tools text model

- [x] 1.1 In `host/agent/settings/profile.js`, add and export one helper that derives the Anthropic-wire text model `{kind:"anthropic", baseUrl, model, apiKey}` from an `anthropic`/`chatgpt` run snapshot (`env.ANTHROPIC_BASE_URL`, `env.ANTHROPIC_API_KEY`, `model`), returning `null` when the snapshot is not such a run (e.g. `runtime === "typesafe"`) or is incomplete
- [x] 1.2 Rewrite `resolveJevBrowserSubgoalConfig(profileId, { textModel })`. The gate is: provider type `anthropic`/`chatgpt`, a supplied `textModel`, and a saved `typesafe_api_key` read directly from the typesafe secret record. Stop reading `typesafeDecisionSource`, `textModelBaseUrl`, `textModelId` and `text_model_api_key`. Keep the transport fields (source, per-source default endpoint, transport key, seed model id), `sendScreenshots` from the Jev-tools toggle, `consultSources`, `searchSources:false`. Return `decisionSource` as the provider type. Rewrite the doc comment to describe the new contract (no stale "openai"/"separate key" wording)
- [x] 1.3 Rewrite `resolveJevExtractPageConfig(profileId, { textModel })` with the same gate as 1.2 (transport key saved), returning `{ textModel }` from the supplied primary model. Update its doc comment
- [x] 1.4 Check every consumer of the resolved configs (`host/agent/tools/browser-subgoal.js`, `host/agent/tools/extract-page.js`, `host/agent/jev/runtime.js` subgoal mode) for any assumption that `textModel.kind === "openai"` or `decisionSource === "openai"`, and make them correct for `kind:"anthropic"`
- [x] 1.5 In `host/agent/companion.js`, derive the primary text model from the run's resolved `snapshot` via the 1.1 helper and pass it to both resolvers. Keep the resolver-failure-means-absent behavior and the `this.profileProvider` resolution. Update the adjacent comments ← (verify: an anthropic/chatgpt run with a saved transport key registers both tools whose text model equals the run snapshot's base URL/key/model; with no transport key neither tool is registered and no error; a typesafe run never registers them; the chatgpt run mints no extra gateway token)

## 2. Host: Jev-tools capability test and save path

- [x] 2.1 Rewrite `testCapabilityForJevTools`:
  - No saved `typesafe_api_key` → `not_configured`, with no requests.
  - Otherwise, build the primary text model for the profile's `defaultModelId`:
    - `anthropic`: `profile.baseUrl` plus the primary key from `credentialTarget`.
    - `chatgpt`: a `purpose:"capability-test"` gateway token through `resolveTypesafeDecisionModel`'s chatgpt branch, released in `finally`.
  - Run `runTypesafeCapabilityTest` with the transport and the text model. Both tools are enabled only when both stages pass.
  - A missing default model or primary credential is a bounded `textModel` stage failure, never a throw and never a secret.
  - Keep the result shape (`status`, `tools`, `capabilities.{textModel,systemone}`, `errors`, `timestamp`).
- [x] 2.2 In `setTypesafeConfig`, when the stored profile's provider type is `anthropic`/`chatgpt`:
  - Skip the text-model and decision-model requirements.
  - Persist only `typesafeSource` and `jevToolsSendScreenshots`.
  - Never change `baseUrl`, `models`, `defaultModelId`, the `textModel*` fields, the decision fields or `lastCapabilityTest`.

  The `typesafe` profile's behavior must stay unchanged ← (verify: saving transport-only config on an anthropic profile whose stored decision source is the `openai` default succeeds and leaves the primary baseUrl/models/lastCapabilityTest intact; typesafe save validation unchanged)
- [x] 2.3 Confirm `setTypesafeCredentials`/the companion's `set_typesafe_config` relay accept a transport-only save from an `anthropic`/`chatgpt` profile, adjusting envelope validation in `host/agent/companion.js` only if it requires text-model fields

## 3. Extension settings UI

- [x] 3.1 `extension/settings/settings.html` `#jevtools-fields`: remove the "1. Mô hình văn bản" group (base URL, model id, key input, key status, remove button). Renumber the remaining groups. Rewrite in Vietnamese: the beta notice, the transport group heading and hint, the screenshot hint, and the `#jevtools-test-disclosure`. The copy must say the tools use the primary provider (tài khoản ChatGPT hoặc API tương thích Anthropic) with the currently selected model, may consume that provider's quota or usage limit, and are enabled by saving the Jev transport key. Update the HTML comment to the new contract. `#typesafe-fields` is untouched
- [x] 3.2 `extension/settings/settings-controller.js`:
  - `saveJevTools()` sends only `typesafeSource` and `jevToolsSendScreenshots` via `set_typesafe_config`, plus the transport key via `set_typesafe_credentials`.
  - Remove the Jev-tools-only text-model state, setters and validation (e.g. `jevToolsTextModelKeyInput*`).
  - Keep the text-model state that the `typesafe` block uses.
  - Update `testJevTools` and the rendering of its result to the new meaning.
- [x] 3.3 `extension/settings/settings-app.js`, `connection-gate.js`, `settings-validation.js`, `settings-client.js`: remove bindings, gates and validation for the removed Jev-tools text-model inputs, and keep everything shared with `#typesafe-fields` working ← (verify: anthropic/chatgpt profile shows no Jev-tools text-model inputs; Save Jev tools with just a transport key succeeds; typesafe profile block and its save unchanged; no dangling DOM id lookups)

## 4. Tests

- [x] 4.1 Update `host/test/jev-browser-subgoal.test.mjs` and `host/test/jev-extract-page.test.mjs`. Gate cases to cover:
  - transport key saved → both configs resolve, with `textModel` equal to the supplied primary model;
  - no transport key → `null`;
  - legacy text-model fields without a transport key → `null`;
  - typesafe profile → `null`;
  - missing `textModel` → `null`.
- [x] 4.2 Update `host/test/jev-tools-capability-test.test.mjs`:
  - `not_configured` without a transport key, with no requests;
  - an anthropic profile uses `baseUrl` plus the primary key;
  - a chatgpt profile issues a capability-test gateway token and releases it on pass and on fail;
  - a stage failure reports bounded errors and no tools enabled.
- [x] 4.3 Add or update a host test for the `setTypesafeConfig` scoped save on `anthropic`/`chatgpt` (2.2), plus a companion-level test that the run passes the snapshot-derived text model (reuse existing companion test doubles in `host/test/`)
- [x] 4.4 Update `test/settings-ui-client.test.mjs`, `test/settings-connection-gate.test.mjs`, the settings UI harness and scripted companion (`test/settings-ui-real-companion-harness.mjs`, `test/settings-ui-scripted-companion.mjs`) and `host/test/agent-settings-relay.test.mjs` for the removed inputs and the transport-only save
- [x] 4.5 Run the touched suites, then the full `npm test`. Report any failure in files outside this change's scope rather than editing them ← (verify: all touched suites pass; full suite has no new failures attributable to this change) — no root `npm test` script exists in this repo (no root `package.json`); ran every `*.test.mjs` under `test/` and `host/test/` (232 files) directly with `node`. All touched-scope suites pass. Three unrelated, unowned files show pre-existing/environmental failures — see report.

## 5. Docs

- [x] 5.1 Update any user-facing doc or README passage describing the Jev browser tools' text-model configuration on anthropic/chatgpt profiles (search `README.md` and `docs/` for "extract_page"/"browser_subgoal"/"Mô hình văn bản"), so it says the tools use the primary provider and only need the Jev transport key — no matches found; nothing to update
