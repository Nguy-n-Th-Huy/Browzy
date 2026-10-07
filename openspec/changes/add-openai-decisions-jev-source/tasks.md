## 1. Decision client

- [x] 1.1 Add `OPENAI_DECISIONS_PATH`, `openaiDecisionsUrl`, `openaiRequestBody(body, image)` (text vs message-array input, a `choice` question per head, single-option heads answered locally) in `host/agent/jev/client.js`
- [x] 1.2 Add `normalizeOpenAIResponse` mapping `answers[]` → Jev answers, and fail on missing heads, probabilities, or confidence
- [x] 1.3 Add the `openai` branch to `requestDecision` with an optional `image` param, using `postJson` + `validateDecision`, and update the JSDoc and file header ← (verify: request body matches the spec exactly; no invented confidence; errors follow the taxonomy)

## 2. Runtime and text helper

- [x] 2.1 In `host/agent/jev/runtime.js`, compute `imageToDecision` from the resolved source and `sendScreenshots`; pass a fresh, non-stale capture to `requestDecision`
- [x] 2.2 In `host/agent/jev/text-helper.js` planning/completion, send no image and no visualNotes instruction when `imageToDecision` ← (verify: for the openai source the planning request has no image part; other sources unchanged; stale/failed capture → string input)
- [x] 2.3 Thread the source through `host/agent/companion.js` if it is not already available to the runtime

## 3. Capability and settings

- [x] 3.1 Add text and image probes for `openai` in `host/agent/jev/capability.js`
- [x] 3.2 Allow `openai` with its defaults in `host/agent/settings/profile.js`
- [x] 3.3 Add the "OpenAI Decisions" option to `extension/settings/settings.html` and `settings-controller.js` (defaults, key field, custom base URL), keeping `openspec/ui-dna.md` ← (verify: saving a key enables the tools; the key is never logged or re-displayed)

## 5. Factored action question (after live runs)

- [x] 5.1 Ask the runtime `action` head as `operation` plus `target_<OPERATION>` questions, with role/label descriptions, and recompose the joint in `host/agent/jev/client.js`
- [x] 5.2 Record `decisionImage` on each `jev_step` for the openai source in `host/agent/jev/runtime.js`
- [x] 5.3 Update `host/test/jev-openai-decisions.test.mjs` and the `jev-runtime.test.mjs` stub/assertions ← (verify: the joint covers every key and sums to 1; non-runtime bodies are asked head by head)

- [x] 5.4 Rescale each OpenAI question's rounded probabilities by their sum (all-zero → uniform) in `normalizeOpenAIResponse`, and record the failure code and message on `jev_end` ← (verify: two-decimal answers over 40+ choices validate; an errored run's log names its reason)
- [x] 5.5 Name the decision service neutrally in the panel's `provider_error` / `invalid_decision` labels (`extension/sidepanel/tool-labels.js`)

## 4. Tests and docs

- [x] 4.1 Add `host/test/jev-openai-decisions.test.mjs`: URL, text/image input, question translation, response mapping, invalid responses, 401/429
- [x] 4.2 Extend the capability, settings, and subgoal tests for the openai source and image routing
- [x] 4.3 Update the README "Jev browser tools" section (source list, screenshot routing, billing)
- [x] 4.4 Run the full host test suite; grep the repo to confirm no `sk-` key literal was added ← (verify: all tests pass; no secrets)
