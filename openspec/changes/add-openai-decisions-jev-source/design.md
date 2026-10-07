## Context

`host/agent/jev/client.js` `requestDecision` dispatches by source (`typesafe`, `vercel`, `openrouter`, `runanywhere`). `runanywhere` already translates Jev's head-keyed `questions` into an array-question wire and back again. The screenshot path is in `runtime.js` (`capturePage`, around L752–818; used near L1069 for planning and L1408 for completion) and goes to `text-helper.js`, which inlines it as `image_url` for the primary provider and asks for `visualNotes`.

## Goals / Non-Goals

**Goals:** add the `openai` source; route the screenshot to the decision model for that source; have the LLM generate text only for that source.

**Non-Goals:** changing other sources; using `predicate`/`score` question types; bracketing; changing `extract_page` (it uses no screenshot).

## Decisions

1. **New `openai` branch in `requestDecision`.** Add `OPENAI_DECISIONS_PATH = "/v1/decisions"`, `openaiDecisionsUrl(base)`, `openaiRequestBody(body, image)`, and `normalizeOpenAIResponse(json, heads)`. The branch reuses `postJson` and `validateDecision`. It is separate from the RunAnywhere code because the field names differ (`name`/`instructions`/`choices[{value}]` instead of `id`/`question`/`options[{name}]`, and an array response with its own `confidence`).
2. **All heads become `choice`, including yes/no heads.** The `predicate` type returns no `confidence`, and the validator needs one. Treating yes/no as a two-choice question keeps Jev's shape without inventing numbers.
3. **No bracketing.** The docs give no option limit. If the provider returns a 4xx about a limit, it surfaces through the existing `extractProviderMessage` path. This is an explicit trade-off: if a limit is found later, add bracketing based on a captured error, not a guess.
4. **Image plumbing.** `requestDecision` gains an optional `image: { data, mimeType }`, and only the `openai` branch uses it. In `runtime.js`, a flag `imageToDecision = source === "openai" && screenshotsEnabled` decides where a fresh, non-stale capture goes. When the flag is set, the capture is passed to `requestDecision`, and the text-helper planning and completion calls get `image = null` and omit the visualNotes instruction. Evidence and the screenshot artifact recording stay the same.
5. **Capability.** `capability.js` adds an openai branch with a text probe and an image probe. The image probe reuses the existing stage-3 embedded probe PNG.
6. **Settings.** `profile.js` adds `openai` to the allowed sources, with defaults `{ endpoint: "https://api.openai.com", model: "gpt-6-luna" }`. The settings UI adds the option and keeps the existing key field and custom base URL behavior. The key never appears in code, tests, or docs.

7. **The action is asked factored for the `openai` source.** In live runs (2026-10-07, dauthau.asia, with screenshots both off and on), the direct `action` head gave top probabilities of 0.1–0.39 with a runner-up within 0.05. Most cycles abstained at the 0.25/0.05 selection floor, and each abstention cost a 5–10 s replan. There are two causes. Every element is offered twice (CLICK and HOVER), which splits its probability mass. And each choice is described only as `{"operation","ref"}`, so a general model has to look the ref up in `state.elements`. The fix is one request with an `operation` question plus one `target_<OPERATION>` question per family, with choices described by role, label, and ref; the answers are recomposed as a joint distribution. This adds no latency (it is still one request), leaves the runtime and the validator unchanged, and keeps the selection floor meaningful because the confidence is the joint probability. Each `jev_step` now records `decisionImage` for image-capable sources, so a log shows whether the decision saw the page.

## Risks / Trade-offs

- The API is new and may change shape → the capability probe fails loudly, and the constants live in one block.
- Images increase input tokens (billed at $0.10/1M) → only when screenshots are enabled.
- Jev's prompts were tuned without images → no change for other sources, and the image is evidence only.
