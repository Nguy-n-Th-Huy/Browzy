## 1. Confirm the persistence path

- [x] 1.1 Confirm `set_typesafe_config` / `set_typesafe_credentials` (companion.js ~2753-2823) and the settings-client path carry every field the two resolvers read (transport source/endpoint/typesafe key; `openai` decision base URL/model id/decision key; text model base URL/model id/text-model key) on an `anthropic`/`chatgpt` profile. If a field cannot be persisted through the existing envelopes, STOP and surface it (do not add a host path). ← (verify: no host/schema change needed; all resolver fields are writable via existing envelopes)

  Confirmed, no gap: every field is writable through the existing envelopes.
  One correction to this task's own premise, verified directly against
  host/agent/settings/profile.js — `resolveJevBrowserSubgoalConfig`'s
  `openai`-decision-source branch does NOT read a separate decision base
  URL/model id/key; it reads `textModelBaseUrl`/`textModelId` and the
  text-model secret directly (`readTypesafeKeys`'s `openai` branch returns
  `decisionApiKey: secret.text_model_api_key`, and
  `resolveTypesafeDecisionModel`'s `openai` branch builds `textModel` from
  `eligible.textModelBaseUrl`/`textModelId`). `typesafeDecisionBaseUrl`/
  `typesafeDecisionModelId` are read only for the `anthropic`/`chatgpt`
  decision sources, which this section never offers (fixed to `openai`). So
  there is no separate "decision model" field to persist — sending
  `decisionSource: "openai"` plus the Text-model fields IS the full decision
  model. A distinct decision-model base URL/model id input would be a dead
  field (never read by the gate). Also confirmed: `baseUrl` must never be
  sent from this section — it is the profile's PRIMARY Anthropic/ChatGPT
  endpoint on this provider type, and the gate always derives the Jev
  endpoint from the transport source instead
  (`typesafeDefaultForSource(resolveTypesafeSource(profile))`), never from
  `profile.baseUrl`.

## 2. Settings markup

- [x] 2.1 In `extension/settings/settings.html`, add a distinct "Jev browser tools (browser_subgoal / extract_page)" section with its own `jevtools-*` input ids: text model (base URL, model id, key), decision model (`openai` base URL, model id, key), transport (source, endpoint, key). Mirror the existing key-item markup for each key input (saved-state line + clear-key action). Do NOT reuse `typesafe-fields` ids or the primary provider inputs.

  Implemented as two input groups plus a decision-source note (see task 1.1's
  finding): (1) Text model — base URL/model id/key
  (`jevtools-textmodel-baseurl`/`jevtools-textmodel-id`/
  `jevtools-textmodel-key-input`), whose hint states it also serves as the
  fixed-`openai` decision model for `browser_subgoal`; (2) Transport —
  source select/endpoint hint/key
  (`jevtools-transport-source-select`/`jevtools-transport-endpoint-text`/
  `jevtools-transport-key-input`). The endpoint is a read-only hint, never an
  editable field or a sent value (task 1.1). Each key input carries a
  saved-state line and a clear-key button. No `typesafe-fields` id or
  primary provider input (`#provider-baseurl-item`/`#anthropic-key-item`/
  `#key-input`) is reused or touched.

## 3. Render/visibility

- [x] 3.1 In `extension/settings/settings-app.js`, show the new section only when `providerType === "anthropic" || "chatgpt"`; keep it hidden for `typesafe`. Add a new hidden-toggle beside the existing ones without altering the `isTypesafe`/`isChatgpt` branches or the `typesafe-fields` toggle. Render saved/cleared key state; never render a secret value. ← (verify: section shows for anthropic/chatgpt, hidden for typesafe; primary base URL/key inputs and typesafe-fields behavior unchanged)

## 4. Controller wiring

- [x] 4.1 In `extension/settings/settings-controller.js`, add state + handlers for the new fields; save non-secret config via `set_typesafe_config` and keys via `set_typesafe_credentials` targeted at the current profile; reuse `typesafeSourceCopy`/existing helpers. Fix the decision source to `openai` for this section. Add validation in `settings-validation.js`/`settings-client.js` only if a real gap exists.

  No gap found in settings-validation.js/settings-client.js; neither was
  touched. Reused the EXISTING, already provider-agnostic state/setters
  (`textModelBaseUrlDraft`/`textModelIdDraft`/`typesafeSource`/
  `hasTypesafeKey`/`hasTextModelKey`, `setTextModelBaseUrlDraft`/
  `setTextModelIdDraft`/`validateTextModelFields`/`typesafeSourceCopy`) since
  the host stores them as flat profile fields with no providerType gate.
  Added `saveJevTools()` (new, separate from `save()` — never sends
  `baseUrl`/models/the primary credential) and
  `setJevToolsTransportSource()` (new — deliberately NOT `setTypesafeSource()`,
  which also moves the profile's PRIMARY Anthropic/ChatGPT `baseUrlDraft`
  when it equals a known Jev default; see that method's doc comment for the
  collision this avoids).

- [x] 4.2 Keys go to the secret store and are never read back into the DOM; clear-key uses the existing credential-clear path. ← (verify: no secret ever rendered; primary Anthropic/ChatGPT credentials untouched by Jev-tools saves)

  Reused the existing `removeTypesafeKey()` for both new "Xóa key" buttons.
  Found and fixed a real gap while wiring this: `removeTypesafeKey()` and
  `confirmMemoryOnlyCredential()`'s typesafe-pair branch unconditionally
  overwrote `hasCredential`/`memoryOnlyCredential`/`secretBackend` from the
  two Jev key booleans — correct on a `typesafe` profile (its only
  credential) but WRONG on an anthropic/chatgpt profile, where those three
  fields describe the separate, untouched primary Anthropic/ChatGPT
  credential. Both methods are now guarded on
  `this.state.providerType === "typesafe"` before touching those three
  fields; behavior for a `typesafe` profile is byte-for-byte unchanged
  (regression-tested).

## 5. Tests

- [x] 5.1 Following existing settings test conventions, cover: section visible for `anthropic`/`chatgpt` and hidden for `typesafe`; saving config+keys on an `anthropic` profile persists via the existing envelopes; primary provider fields unchanged after a Jev-tools save; no secret rendered; decision source fixed to `openai`. ← (verify: every spec scenario has a test; no regression to existing provider-settings tests)

  Added test/settings-ui-jevtools-llm-profiles.test.mjs (controller-level,
  scripted companion — same convention as test/settings-ui-controller.test.mjs;
  settings-app.js/DOM stays untested-by-design per that file's own header).
  Covers: empty section sends nothing; text-model-only save enables the
  config path and never sends `baseUrl`; decisionSource always forced to
  `openai`; both-keys save never mirrors a raw value and never touches the
  primary Anthropic credential fields; the `removeTypesafeKey()`/
  `setJevToolsTransportSource()` regressions found in 4.1/4.2 are directly
  asserted; a `typesafe`-profile regression check proves the original
  behavior is unchanged; `saveJevTools()` is refused on a `typesafe` profile.

- [x] 5.2 Run the settings/extension test suite and report actual output; report failures in unowned files (parallel-session work) without editing them ← (verify: in-scope tests green; pre-existing out-of-scope failures noted with ownership)

  All settings/settings-UI/background-agent-settings test files pass (see
  implementation report). Two existing assertions in
  test/settings-connection-gate.test.mjs broke as a direct, in-scope
  consequence of this change (a page-wide "exactly 3 `<option>`" count and a
  key-input-variable-name count that both assumed only one Jev-source select/
  one Save handler existed) and were corrected in that same test file to be
  correctly scoped rather than weakened. No unowned/out-of-scope test
  failures were encountered.
