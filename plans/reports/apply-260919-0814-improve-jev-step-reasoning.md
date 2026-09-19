# Apply: improve-jev-step-reasoning

Change: `openspec/changes/improve-jev-step-reasoning/`
Branch: master. No commit made.

## What was implemented

### 1. Observation (tasks 1.1-1.5)

- `extension/content.js`: pointer-affordance pass in the snapshot walk (rendered, viewport-intersecting, computed `cursor: pointer`, innermost-only, no nested native control, own cap, drops counted into the existing omission disclosure); snapshot element records now carry the existing per-document `isNew` watermark marking (the same mechanism `find` and the accessibility tree use, including the document-identity reset).
- Measured before/after element counts on 4 fixtures — see `apply-260919-0814-snapshot-pointer-pass.md`: native-only 4→4 (zero growth, the required result), autocomplete 0→5, product cards 3→4 (no wrapper duplication), decorative pointer-cursor page 0→40 (capped, 20 disclosed).
- `host/agent/jev/runtime.js`: a cycle after a dispatched `TYPE_TEXT` settles — up to 3 probes x 200 ms, stopping as soon as the observation reports newly appeared controls OR the page changed at all. No other operation waits; a cycle whose page already answered observes exactly once.
- `host/agent/jev/questions.js`: the observation's `isNew` rides each action-space row as `new`, carried (never recomputed) into the decision's element table and the selection request's state; `NEXT_STEP`/`TARGET_SELECTION` say what it means.

### 2. Jev's third source: OpenRouter (tasks 2.1-2.5)

- `host/agent/jev/client.js`: `openrouter` source — `POST {endpoint}/api/alpha/decisions`, the direct source's body (model id included), Bearer auth, sharing the one `postJson`, retry policy and failure taxonomy.
- Response is read as the direct source's shape. **No normalizer was invented**: no live response has been captured, and a synthesized confidence is exactly what the selection floor must never act on. If the route reports confidence elsewhere, the validator refuses and the run reports an invalid decision — the honest outcome. Task 2.2's capture is still open.
- `profile-schema.js` / `profile.js`: `openrouter` in `TYPESAFE_SOURCES`, `https://openrouter.ai` default endpoint, `typesafe/jev-1.13` model seed, and one `isDefaultTypesafeEndpoint()` helper so a profile sitting on the new default is not stranded by a later source change.
- `capability.js`: stage 1 runs on the selected source's own route.

### 3. The decision model speaks the project's own standard (tasks 3.1-3.7)

- `profile-schema.js`: `TYPESAFE_DECISION_SOURCES = ["openai","anthropic","chatgpt"]`, default `openai`, plus resolver.
- `profile.js`: only the selected source must be configured; a deselected source's values are kept. Credentials follow the source — the text-model key in the existing TypeSafe record (`openai`), the profile's own Anthropic credential (`anthropic`), a run/test-scoped gateway token from the existing ChatGPT gateway (`chatgpt`). One `resolveTypesafeDecisionModel()` serves both the run snapshot and the capability test, so a probe cannot prove a transport the run does not use. `env.ANTHROPIC_BASE_URL` keeps the `typesafe:jev` identity marker.
- `text-helper.js`: the Anthropic Messages wire beside the Chat Completions one — `POST {baseUrl}/v1/messages`, `x-api-key` (never a Bearer beside it), pinned `anthropic-version`, the instruction as `system`, no `response_format` (the strict validator plus the existing one feedback retry carry the shape), thinking blocks read as reasoning and never as the answer or echoed into a retry, and the capture as an image content block.
- `client.js`: `postJson` gained an `authHeader` option for exactly that.
- `companion.js`: `set_typesafe_config` passes the three new fields through.

### 4. Reasoning budget by call class (tasks 4.1-4.5)

- Decision-class calls (step decision, plan, revision, stall recovery, completion check) now reason deliberately: extended thinking on the Anthropic wire (budget 1024, skipped when `max_tokens` cannot hold it plus headroom), DeepSeek's thinking switch **enabled**, `reasoning.effort: "medium"` on every other OpenAI-compatible host. Previously every call — including the one carrying the run's whole judgment — sent the reference's value-filler parameters.
- The step decision has its own `max_tokens` (4096) so a bounded answer carrying the evaluation cannot be truncated mid-string.
- The capability test's decision-model stage now sends the decision-class parameters, so a pass proves the source answers in the required shape *while reasoning* — settings time, not first decision. The image stage stays minimal. (The spec delta was updated to say this; it previously said both probes stay minimal.)

### 5-6. The element table and the evaluation (tasks 5.1-6.4)

- The step-decision context gains the observation's own element rows (`buildActionSpace`, reused — no second projection), fitted to a 16 KiB budget by dropping from the tail, with the dropped count summed onto the observation's own omission. Context only: no `ref`, selector or coordinate, and the executed element still comes solely from Jev's answer.
- `NEXT_STEP` requires a bounded `evaluation` (300 chars) of the previous step; `parseStepDecision` validates it; the runtime records it on the step and `protocol.js` documents it.
- `recentActionRows` now carries the element actually operated and the outcome (`executed` / `skipped` + reason / denied), so a skipped step and an executed-but-ineffective step stop looking identical to the next decision.

### 7. The selection floor (tasks 7.1-7.4)

- `TARGET_SELECTION`'s "choose the closest offered key" is gone; it now says to select only on a genuine match.
- `runtime.js` applies two constants before dispatch: a confidence floor (0.25, only where the wire reported a confidence) and a top-two probability margin (0.05, on every source). **No absolute floor on the chosen probability** — a winner at 0.15 against a field of 0.003 is a confident pick.
- An unresolved answer takes the existing `target_unresolved` skip path, records `targetAbstained` plus the confidence/probabilities that caused it, counts one toward no-progress, and the loop continues.

### 7b. Settings surface (tasks 2.3, 3.6)

- The Jev source picker gains OpenRouter, labelled alpha, with its own key label, documented default endpoint and model seed.
- A decision-model source picker (Anthropic endpoint + key / ChatGPT subscription / OpenAI-compatible text model) showing only the selected source's fields, reusing the existing Anthropic key field and the existing ChatGPT sign-in/account/usage/sign-out block rather than duplicating them. Validation requires only the active source and never sends a deselected source's fields, so its stored values survive. The disclosure text names the actual destination per source. The connection gate checks only the selected source's precondition.
- Host follow-up found by that work and fixed here: `hasCredential` is one flat flag over every secret a profile holds, and `setTypesafeCredentials` rewrote it from the TypeSafe record alone — so a `typesafe` profile whose decision model reuses the Anthropic key would have reported "key saved" as soon as its TypeSafe key was saved. `setCredential`/`removeCredential` now maintain `hasAnthropicKey`, the TypeSafe write preserves it, and `loadProfile` exposes it. Covered by a new test in `settings-typesafe`.

### 8. Panel (tasks 8.1-8.3)

- The step row carries `evaluation`, `targetAbstained` and `runnerUpProbability`, live and rebuilt from the transcript; the evaluation renders as its own line and an abstained step reads as a skip naming low selection confidence, distinct from a no-compatible-candidate skip and never as a failure.

## Tests

All run on this branch, real results:

| suite | result |
|---|---|
| `host/test/jev-client.test.mjs` | 24/24 |
| `host/test/jev-questions.test.mjs` | 32/32 |
| `host/test/jev-capability.test.mjs` | 16/16 |
| `host/test/jev-text-helper.test.mjs` | 53/53 |
| `host/test/jev-runtime.test.mjs` | 88/88 |
| `host/test/settings-typesafe.test.mjs` | 20/20 |
| `host/test/agent-typesafe-run.test.mjs` | 7/7 |
| `host/test/agent-settings-relay.test.mjs` | 31/31 |
| `host/test/chatgpt-gateway.test.mjs` / `chatgpt-auth` | 23/23, 18/18 |
| `host/test/agent-protocol.test.mjs` / `agent-tool-adapter` | 11/11, 6/6 |
| `test/page-snapshot-content.test.mjs` / `-background` | all passed |
| `test/registry-baseline.test.mjs` / `registry-sdk-mapping` | all passed |
| `test/sidepanel-conversation-model.test.mjs` / `-streaming-render` | all passed |
| `test/settings-ui-controller` / `-client` / `settings-connection-gate` / `settings-ui-secrets` | all passed |
| `test/background-agent-settings-relay.test.mjs` | all passed |

New tests cover: the evaluation's requirement/bound/retry, the element table's fitting and disclosure and the absence of execution handles, the Anthropic wire (URL, auth header, system prompt, no `response_format`, thinking-as-reasoning, image block), the reasoning split per call class, the OpenRouter route and its refusal to invent a confidence, the unknown-source guard, the confidence floor and the margin (including a clear winner with a small absolute probability still dispatching), the outcome-bearing history rows, and the typing settle's bound.

Fixtures were updated where the change deliberately reverses what they asserted (the closest-offered-key rule, the `effort: "low"` parameter, decisions without an evaluation). No assertion was weakened to pass.

## Known-failing, not caused here

`test/overlay-background-bridge.test.mjs` fails with `ReferenceError: requestAnnotationClear is not defined`. `extension/background.js` was already modified and uncommitted before this work started; the function exists at `background.js:3632` but the suite's extraction (`test/_extract.mjs`) does not include it. Nothing in this change touches that file.

## Open items

1. **Task 2.2 — capture OpenRouter's live response** before writing a normalizer: where the confidence lives and what `usage` looks like. Until then that source refuses an answer carrying no confidence rather than guessing.
2. **Task 9.2 — one real run** to calibrate `SELECTION_CONFIDENCE_FLOOR` (0.25) and `SELECTION_PROBABILITY_MARGIN` (0.05) against the live distribution, and to record the reasoning-enabled decision latency. Both are conservative guesses today; three abstentions in a row end a run through the no-progress guard, so a floor set too high is not free.
3. **The typing settle's bound** (3 x 200 ms) and the element table's 16 KiB budget are likewise unmeasured defaults.
4. A `typesafe` profile's ChatGPT decision source gates on `chatgptSessionState === "signed_in"`, which is the accurate signal; the flat `hasCredential` flag remains a coarse "at least one secret stored" and is no longer what the Anthropic key's own reporting depends on (see 7b).
