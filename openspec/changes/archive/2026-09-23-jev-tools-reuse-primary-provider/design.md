## Context

`extract_page` and `browser_subgoal` are offered to `anthropic`/`chatgpt` runs by two gate resolvers in `host/agent/settings/profile.js`: `resolveJevExtractPageConfig` and `resolveJevBrowserSubgoalConfig`. Both currently require a separate OpenAI-compatible text model (`textModelBaseUrl`, `textModelId`, and the `text_model_api_key` field in the typesafe secret record). `browser_subgoal` additionally requires `typesafeDecisionSource === "openai"` plus the `typesafe_api_key` transport key. `companion.js` (around the `jevSubgoalConfig`/`jevExtractPageConfig` block) calls both resolvers with `profileId` only.

The primary provider already speaks the Anthropic Messages wire for both profile types. `snapshotForRun` returns `{ model, env: { ANTHROPIC_BASE_URL, ANTHROPIC_API_KEY } }`. For `anthropic`, that is the real endpoint and key. For `chatgpt`, it is `http://127.0.0.1:<port>` of the CLIProxyAPI-derived loopback gateway (`host/agent/chatgpt/gateway.js`) and a run-scoped gateway token bound to `{profile, model, credentialRevision}`, released when the run settles (`_releaseRunGatewayToken`). The Jev text-model client (`host/agent/jev/text-helper.js`) already speaks this wire for `textModel.kind === "anthropic"` (it posts to `<baseUrl>/v1/messages`). `resolveTypesafeDecisionModel` already produces such an object for a `typesafe` profile's `anthropic`/`chatgpt` decision sources, which proves the gateway serves Jev calls.

## Goals / Non-Goals

**Goals:**
- On `anthropic`/`chatgpt` profiles, the Jev tools' text/decision model is the run's primary provider and model, with no separate text-model configuration.
- One gate for both tools: the Jev transport key (`typesafe_api_key` for the selected `typesafeSource`) is saved.
- The Jev-tools settings section collects only transport source + key + screenshot toggle, and saves successfully with just those.
- The Jev-tools connection test proves the primary model (default model) as the text model, plus the transport.

**Non-Goals:**
- No change to the standalone `typesafe` provider: its text-model fields, decision sources, run path and test are unchanged.
- No new profile schema field. No migration or cleanup of legacy stored text-model values; they stay stored, because the `typesafe` profile shares them.
- No OpenAI-compatible (`/v1/chat/completions`) route on the gateway. The Anthropic wire is sufficient.
- No change to Jev transport wires, the tool preference system prompt, or the sub-run/extraction behavior beyond which model they call.

## Decisions

1. **The text model comes from the run snapshot and needs no second credential.** For an `anthropic`/`chatgpt` run, the companion derives `textModel = { kind: "anthropic", baseUrl: snapshot.env.ANTHROPIC_BASE_URL, model: snapshot.model, apiKey: snapshot.env.ANTHROPIC_API_KEY }` once, through one exported helper in `profile.js` (e.g. `primaryTextModelFromSnapshot(snapshot)`), and passes it to both resolvers (`resolveJev…Config(profileId, { textModel })`).
   - The `chatgpt` gateway token is model-bound. Reusing `snapshot.model` with the run's token therefore needs no new token and no new release wiring, and the token's lifetime already covers every tool call inside the run.
   - The model is the conversation's own selected model, so the operator makes no separate choice.
   - Alternative rejected: each resolver minting its own gateway token for `defaultModelId`. That needs extra release bookkeeping, and it could diverge from the model the run actually uses.
2. **The gate is the transport key alone.** A resolver returns `null` (tool absent, silently) when:
   - the profile is not `anthropic`/`chatgpt`;
   - no `textModel` was supplied;
   - the typesafe secret record has no `typesafe_api_key`.

   The stored `typesafeDecisionSource` and the `textModel*` fields are not read for these profile types. `extract_page` shares the gate so that "empty section = no tools" still holds, and so the section has one enable switch. The transport request always uses `typesafe_api_key` and the per-source default endpoint (`typesafeDefaultForSource`) as today. The primary key or gateway token is only ever placed in `textModel`.
   - This reverses jev-browser-subgoal-tool design decision 5 ("a separate Jev key, never the Anthropic key") at the operator's explicit request. What still holds is that the primary credential never reaches the Jev transport.
3. **The Jev-tools capability test builds its own primary text model.** There is no run snapshot at test time.
   - If there is no `typesafe_api_key`, the test returns `not_configured` with no requests.
   - Otherwise it resolves the profile's `defaultModelId` as follows. For `anthropic`: `profile.baseUrl` plus the primary key from `credentialTarget(profileId)`. For `chatgpt`: a `purpose: "capability-test"` gateway token issued through the existing `resolveTypesafeDecisionModel` pattern (decision source = provider type, `decisionModelId` = default model, `decisionBaseUrl` = `profile.baseUrl` for anthropic), released in `finally`.
   - It then runs `runTypesafeCapabilityTest` with that text model and the transport. Both tools are reported enabled only when both stages pass.
   - A missing default model or primary credential is reported as a bounded `textModel` stage failure (host-authored code/message, no secret), not a throw.
4. **Jev-tools save on non-typesafe profiles is scoped.** `setTypesafeConfig` enforces the text-model and decision-model requirements only when the stored profile's `providerType` is `typesafe`. For `anthropic`/`chatgpt` it writes only `typesafeSource` and `jevToolsSendScreenshots`, and never alters `baseUrl`, `models`, `defaultModelId`, `textModel*`, decision fields or `lastCapabilityTest`. That last one holds the primary provider's test result, which a Jev transport change must not wipe. The `typesafe` path stays byte-for-byte in behavior.
5. **The settings UI drops the text-model group.** In `#jevtools-fields`, the "1. Mô hình văn bản" inputs, their key status and remove button, and their controller state and validation are removed. The copy (beta notice, group heading, screenshot hint, test disclosure) is rewritten in Vietnamese to say the tools use the primary provider (tài khoản ChatGPT hoặc API tương thích Anthropic) and the model currently selected. `saveJevTools()` sends only `typesafeSource` and `jevToolsSendScreenshots` through `set_typesafe_config`, plus the transport key through `set_typesafe_credentials`. The `#typesafe-fields` block and its text-model inputs are untouched.

## Risks / Trade-offs

- A profile configured under the old contract with only a text model (no transport key) loses `extract_page`. → This is accepted: the new contract is one switch. The spec scenario documents it.
- Jev tool calls now consume the primary provider's quota (the ChatGPT plan's usage windows, or the Anthropic bill). → The section copy states the tools use the primary provider.
- The text model now follows the conversation's selected model, which could be a large or slow model. → This is accepted as the operator's intent ("chỉ cần lưu model gpt + Jev"). The model is the one the operator already chose.
- A gateway token shared by the SDK subprocess and the tool calls within one run. → Tokens are bearer credentials validated per request against the credential revision, and a sign-out invalidates both uses together, which is the desired behavior.

## Migration Plan

No data migration. Stored `textModelBaseUrl`/`textModelId`/`text_model_api_key` on `anthropic`/`chatgpt` profiles become inert, and a later switch of the profile to `typesafe` still finds them. Rollback means reverting the code; stored data is compatible both ways.

## Open Questions

None.
