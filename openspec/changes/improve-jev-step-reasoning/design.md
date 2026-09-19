# Design: Jev step decisions that reason before they act

## 0. What is not changing

The labour split pinned by the user in `2026-09-18-add-jev-run-context` stands: **the configured model decides every step; Jev decides only which observed element that step refers to.** Nothing below moves a decision across that line. In particular, the element table added to the decision context (§5) is *context*, never a selection channel — the decision keeps naming its element in plain language, and the numbered key that reaches a dispatch still comes only from Jev's validated answer.

Also unchanged: Jev's own decision protocol (§3 adds a source for it, not a different protocol) and the OpenAI-compatible text-model wire for profiles that keep it (§2), the answer-validation rules, the retry policy, the request-size budget, the approval gate and `runHostSideChecks`, the run bounds, the credential storage, the capability test's stages, settings fields, and the `anthropic`/`chatgpt` runtimes.

## 1. Visibility first: the observation must contain the control

Research into the upstream loop (`plans/reports/research-260919-0743-jev-agent-loop.md`) settled one thing before any prompt work: upstream jev-ultrafast has **no** planner, no prior-step evaluation, no notes, no backtracking, and it still behaves competently. This port already has more loop machinery than the reference (`RUN_PLAN`, `MEMORY_REVISION`, `COMPLETION_CHECK`, three stall guards, per-`ref` ineffective-click memory, history rows on both requests). So the operator's complaint is not a missing planning stage, and adding one would be treating a symptom.

The mechanical cause that ranks first is visibility. `extension/content.js:351-359`:

```js
function isInteractive(el) {
  // native tags | role from a fixed list | tabIndex >= 0 | inline onclick | contenteditable
}
```

A framework suggestion row — `<div class="cityline"><span>…</span></div>` with a delegated listener — satisfies none of these, so it never reaches the element table, so neither model can choose it, so the run re-types into the one field it can see. This is upstream issue #23 ("reads like a model problem but is a visibility problem") reproduced exactly.

The second pass is deliberately narrow, because the failure mode of a loose pass is a table full of wrappers:

- rendered (the existing visibility test), intersecting the viewport;
- computed `cursor: pointer`;
- innermost candidate only — an ancestor that merely wraps an already-listed control is not listed;
- no nested native form control inside the candidate;
- its own hard cap, with anything dropped counted in the existing omission disclosure;
- ordering and the `MAX_ELEMENTS` bound unchanged.

This is the one part of the change that leaves the Jev loop: every runtime observes through `page_snapshot`. That is intended — the Anthropic and ChatGPT runtimes are blind to the same controls — but it also means the acceptance bar is a measured before/after element count on fixture pages: growth where a delegated-listener control exists, **zero** growth where none does.

Paired with it, one timing fix: `runtime.js` observes immediately after a dispatch, so the observation after a `TYPE_TEXT` is taken before an autocomplete list has rendered and the decision legitimately re-types. The cycle following a dispatched `TYPE_TEXT` settles — bounded by a short fixed ceiling, returning as soon as the revealed controls appear (upstream waits up to 200 ms for visible options). The wait applies to that one case only; nothing else about any cycle changes.

And one cheap grounding signal from browser-use: elements **new since the previous read of the document** are marked. This is not new machinery — `2026-09-12-mark-new-page-elements` already built it, and `content.js` carries it on `find` results (`isNew`, line ~1719) and on the accessibility tree (`*[ref]`, line ~661) through a shared per-document watermark that resets on a document-identity change. `page_snapshot`'s element record (line ~1310) is simply missing it. The work is to put the existing marking on the snapshot record and carry it into the decision table, the selection state, and one sentence in each instruction ("a control that just appeared is very likely what your last action revealed"). The run computes no diff of its own: a second marking with its own notion of "new" is exactly what the shared watermark was built to prevent.

The settle in the previous paragraph uses the same signal: after a `TYPE_TEXT` dispatch, re-observe up to a small number of times within the fixed ceiling and stop as soon as the observation reports newly appeared controls — one mechanism, two uses.

## 2. One decision wire: the project's own Anthropic standard

The project speaks one model language everywhere except here. An `anthropic` profile resolves to the real endpoint; a `chatgpt` profile resolves to the companion's local gateway, which translates Anthropic `POST /v1/messages` to the Codex `/responses` upstream (`host/agent/chatgpt/gateway.js:417`, `upstream-client.js:29`) and hands the SDK an `env.ANTHROPIC_BASE_URL` pointing at it (`profile.js:960`). A `typesafe` profile is the exception: its snapshot env is the identity marker `typesafe:jev` (`profile.js:84`), and its decision model is reached over a second, OpenAI-shaped wire (`{textModel.baseUrl}/chat/completions`) with a second credential. That wire is inherited from the reference implementation, not chosen for this project.

The consequence the operator hit: the decision model of a Jev run cannot be any provider this project already supports. An Anthropic key or a ChatGPT subscription — both already configured, credentialled, and tested elsewhere in the product — are unusable as the run's brain, and a second API key for a second service is mandatory.

**A `typesafe` profile's decision model therefore becomes a choice of source:**

- `anthropic` — an Anthropic endpoint and key, configured and stored exactly as an `anthropic` profile's are;
- `chatgpt` — the ChatGPT subscription, signed in and reached through the existing companion gateway with a gateway token, exactly as a `chatgpt` profile's runs are;
- `openai` — today's OpenAI-compatible text model (base URL, model id, key), kept unchanged so a local model, OpenRouter, or any other Chat Completions host stays usable. Removing it is explicitly not part of this change.

Jev itself is untouched by this: element selection is still one `POST /v1/systemone` with its own credential and its own endpoint.

**Transport for the two Anthropic-standard sources** is one direct `POST {baseUrl}/v1/messages` through the loop's own `postJson` — the same helper, retry policy and failure taxonomy every other call here uses — with `x-api-key` and a pinned `anthropic-version`.

That is a deliberate narrowing of what this section first proposed (`enhance-prompt.js:135`'s bounded, tool-free `query()` options). Both satisfy the requirement that a decision call carry no tools, no MCP, no conversation and a single turn; the direct POST also keeps this subsystem free of the SDK and session machinery, keeps one transport for every call it makes, and stays testable against the same local stub servers the rest of the loop's tests use. The gateway a `chatgpt` source points at speaks exactly this wire (`gateway.js` routes `POST /v1/messages`), so one client serves both sources. The guarded dispatch discipline is untouched and unreachable from a decision call either way.

Four consequences to design for rather than discover:

1. **Identity stays intact.** `env.ANTHROPIC_BASE_URL` remains the `typesafe:jev` marker, because `buildAppProfileIdentity` uses it to keep a conversation bound to a typesafe profile distinguishable from one bound to a real Anthropic/ChatGPT endpoint. The decision model's endpoint and credential resolve into their own field of the snapshot; they never overload the identity env. A conversation started on a typesafe profile stays a typesafe conversation whatever its decision source is.
2. **No `response_format` on this wire.** The OpenAI path pins `{"type": "json_object"}`; the Anthropic Messages API has no equivalent. What replaces it is what already guards every answer here: the instruction states the exact object, the strict validator refuses anything else, and the existing single feedback retry re-asks once with the refusal in front of the model. That is the same discipline, one round trip more expensive in the rare refusal case. The fenced-answer unwrap already in `postMemoryRequest` stays and matters more on this wire.
3. **Reasoning is native, and so is the channel problem.** Extended thinking on this wire returns thinking blocks beside text blocks; the parse reads the answer text only, never treats thinking content as the answer, and never carries it into a later request. This is the same rule §4 states for a host with a separate reasoning channel — one rule, two wires. It also removes §3's compatibility worry for these two sources: nothing here forces a JSON-mode-versus-reasoning trade-off.
4. **Images ride as content blocks.** The cycle's capture attaches as an image content block instead of an `image_url` data URI. Capture, bounds, reuse by the completion check, and the advisory-failure contract are unchanged.

**Credentials** follow the sources: an Anthropic key is stored under the profile's existing Anthropic credential target shape, a ChatGPT sign-in uses the existing refresh-token target and gateway-token issuance, and the text-model key is required only when the `openai` source is selected. The `SECRET_TOO_LARGE` behaviour, the revision bump, and the cancel-active-runs-on-removal rule are the existing ones.

**The capability test follows the source too:** the TypeSafe question stage is unchanged; the decision-model stage and the image stage run against whichever source the profile selected, reporting under the same result shape and the same actionable codes, with the image stage still non-deciding for runnability.

## 3. Jev's own protocol, and a third source for it

One boundary this change must not blur: **Jev is not a chat model.** It answers a `state` plus a typed `questions` object over its own decision route, and its general-purpose ports are not an alternative — the Vercel gateway's Anthropic- and OpenAI-compatible endpoints refuse the model outright ("evaluation model, not a language model"), which is why `client.js` pins the AI-SDK evaluation wire for that source. §2 moves **the decision LLM** onto the project's Anthropic standard; it does not, and must not, move Jev anywhere.

`client.js` already has the right shape for this: one `source` switch choosing a URL, a body adapter, and a response normalizer, over one shared `postJson`, one retry policy, and one failure taxonomy. OpenRouter is a third entry in that switch:

| source | route | body | confidence |
|---|---|---|---|
| `typesafe` | `POST {endpoint}/v1/systemone` | `{model, state, questions}` | on the answer |
| `vercel` | `POST {endpoint}/v4/ai/evaluation-model` | `{state, questions, providerOptions:{}}`, model in `ai-model-id` header | `providerMetadata.typesafe.confidence[head]` |
| `openrouter` | `POST {endpoint}/api/alpha/decisions` | `{model, state, questions}` with a namespaced model id (`typesafe/jev-1.13`) | to be established against the live response before the normalizer is written |

Two things the implementer must settle from the live wire rather than assume, exactly as the Vercel source's constants were captured: where the answer's confidence lives, and whether `usage` is reported in the same shape. Until both are observed, no normalizer is written — an invented confidence is precisely what §6's floor must never act on. The route is published under `/alpha/`, so it is labeled as alpha where it is selected, and its constants live in one block whose protocol drift fails loudly (`MODEL_UNAVAILABLE_ERROR` / `INVALID_RESPONSE`) rather than degrading a decision silently.

Model ids differ per source and belong in the profile's model list, which already seeds `jev-latest` for the direct source; the OpenRouter seed is its namespaced id.

## 4. Reasoning budget by call class

`reasoningParam()` (`host/agent/jev/text-helper.js:~330`) today returns the reference's value-filler parameters for every call:

```js
if (isDeepSeekHost(baseUrl)) return { thinking: { type: "disabled" } };
return { reasoning: { effort: "low" } };
```

The reference sent these because its configured model only ever produced a field value — and because its own default happened to be DeepSeek. In this port the same model produces the run's entire judgment, on whatever OpenAI-compatible host the profile configures. The parameter is therefore split by call class, host-agnostically:

- **Decision class** — step decision, run plan, memory revision, stall recovery, completion check: the source's own reasoning control at a deliberate level — extended thinking on the Anthropic-standard sources (§2), `reasoning: {effort: "medium"}` on every OpenAI-compatible host. This is the branch that matters: `reasoningParam()` special-cases only `api.deepseek.com`, so **every other configured host** — OpenAI, a gateway, a local model — is today running the run's whole judgment at `effort: "low"`. The DeepSeek branch follows the same rule (its thinking switch enabled rather than `disabled`) and is a footnote, not the point.
  Two host facts to re-check against the vendor's current docs at implementation time rather than assume, for whichever host the profile actually points at: (1) the host supports its reasoning mode together with `response_format: {type: "json_object"}` — where it does not, that host keeps the minimal parameters instead of failing every decision; (2) where the host returns its chain of thought in a channel of its own beside the answer (DeepSeek's `reasoning_content`, and the equivalent on other hosts), the strict parse reads the answer channel only, never treats reasoning text as the answer, and never echoes it into a later request — this loop sends no `tools` parameter, so nothing requires it to be carried back. The capability test is where the pair is proven, so a profile whose host refuses it is known at settings time rather than at the first decision.
- **Value class** — the capability test's image probe: unchanged low/disabled parameters. It proves that a wire accepts image content, not that a model can judge.
- The capability test's **decision-model stage** is deliberately decision class, not value class: it sends what a real decision sends, so a pass proves the source can answer in the required shape while reasoning is enabled. That is the combination every step of a run depends on, and settings time is where a host that refuses it should be discovered.

`max_tokens` for the step decision rises from `TEXT_MODEL_MAX_TOKENS` (1024) to a step-decision budget that holds the evaluation field beside the decision, chosen the way `COMPLETION_CHECK_MAX_TOKENS` was: large enough that a bounded answer cannot be cut mid-string, since a truncated JSON object fails the strict parse and spends the one feedback retry for no reason.

Trade-off, stated rather than hidden: a thinking step decision is slower than a non-thinking one, and Jev's pitch is speed. The speed Jev sells is the *element selection* — one structured request, no free text — and that call is untouched. The decision call is one per cycle and already dominated by network latency; the existing per-run ceilings (60 actions / 120 step decisions) bound the total. No profile setting is introduced for this: a knob whose wrong setting reproduces the exact defect this change fixes is not a feature.

## 5. The decision sees the controls it is deciding among

Today the decision context is:

```js
{ goal, memory, page: { url, title, text }, recent_actions }
```

The observation that produced it already carries the full element list — `questions.js` turns it into the numbered action space Jev is offered. The decision model gets a bounded projection of the same list:

- Rows: the element's 1-based index in the observation, its tag/role, its bounded label, its bounded current value, and its state flags (disabled, checked, selected) where the observation carries them. No `ref`, no selector, no coordinate — those never leave the host's mapping.
- Bounds: the existing per-field bounds (`MAX_ELEMENT_LABEL_CHARS`, `MAX_ELEMENT_VALUE_CHARS`, `MAX_ELEMENTS`) plus a byte budget of the decision request's own, fitted by the same deterministic ladder the selection request uses — drop from the **tail**, keep the top-of-page view the operator sees, and disclose the omitted count inside the context so the model knows its view is partial.
- Placement: a sibling of `page`, so the page prose and the control list are distinguishable to the model.

Why this is the fix and not decoration: the decision's whole job is to pick an operation and describe a target. Without the table it is describing a page it can only infer from prose — the origin — together with §1's invisible controls — of both failure shapes the operator reports: an intent for a control that does not exist, and the endless re-click of a control that does exist but does nothing. With the table, `NEXT_STEP` can carry the rule that follows from it: *an intent must name a control this table offers; when none does, choose `SCROLL_*`, `WAIT`, `NAVIGATE`, or `BLOCKED` — never invent one.*

Cost note: the table is the largest single addition to the decision request. The tail-dropping ladder and `MAX_ELEMENTS` keep it inside the same order of magnitude as the page text bound (`MAX_PAGE_TEXT_CHARS` = 10,000), and both are already fitted before send.

## 6. Evaluation of the previous step

`parseStepDecision` accepts exactly `{operation, intent, text, url}` and refuses any unrecognized key. It gains one more:

- `evaluation` — **required**, bounded (order of 300 characters), plain language: what the previous action was meant to achieve and whether the current observation shows it did. For the first decision of a run it states the starting position instead.

This is the cheapest available injection of deliberation: the model cannot answer it without comparing the previous intent to the current page, which is exactly the comparison it never makes today. It is also the field that makes the no-progress guards legible after the fact — the run's row list gains a per-step sentence, so an operator reading a blocked run sees where the model's model of the page diverged.

For the evaluation to be answerable, the recent-step rows must describe outcomes rather than intentions. `recentActionRows` today projects `{action, kind, text, page_changed}`. It gains:

- the element actually operated (its bounded label, from the step's recorded target), and
- the step's outcome: executed, skipped with its reason (`target_unresolved`, the new low-confidence abstain), or denied by the gate.

Without these two fields a step that was *skipped* and a step that was *executed with no effect* look identical in the history, and the model repeats both.

`recentActionRows` feeds **both** the step decision and the Jev selection request (`questions.js:~496`), so the two added fields ride under `MAX_REQUEST_BYTES` on the selection side as well. One projection serves both — do not add a second.

Validator discipline is unchanged in kind: the unrecognized-key refusal stays (it is what keeps commentary out of the answer), the bound is enforced host-side, and the one feedback retry applies to a refusal of this field exactly as to any other.

## 7. Jev may abstain

Two mechanisms already exist and are unused:

- `TARGET_SELECTION` ends with "if several offered elements match the intent, choose the best one; **if none matches, choose the closest offered key**". That sentence is a standing instruction to click something wrong.
- Every validated answer carries a `confidence` and the chosen candidate's probability. `runtime.js:926` records both on the step and routes on neither.

The change:

1. The instruction's closest-key fallback is replaced by: choose an offered element only when one genuinely matches the stated intent; when none does, answer with the lowest confidence the question allows rather than selecting a near-match.
2. The runtime applies a fixed floor to the validated answer before dispatch. Below the floor, the step takes the path a step with no compatible candidate already takes: recorded **skipped** with the `target_unresolved` reason (extended to carry the confidence that caused it), one count toward the no-progress bound, loop continues. Nothing new is invented — the outcome, the reason vocabulary, the guard accounting, and the UI row already exist for exactly this situation.
3. The skip is visible to the next decision through the recent-step rows of §3, so the model's next evaluation reads "the intent named a control the page does not offer" and changes course instead of restating it.

Two values, not one, because the distribution shape matters more than any absolute number: a **confidence floor** applied to the provider-reported confidence for the answered head (`client.js` lifts it from the answer, or from `providerMetadata.typesafe.confidence` on the Vercel source, and leaves it absent when the wire reports none), and a **margin** between the chosen candidate's probability and the runner-up's. The margin is the rule that always applies, including on a source that reports no confidence at all. An absolute floor on the chosen probability alone is deliberately rejected: over a 250-candidate head, 0.15 against 249 candidates at 0.003 is a confident pick that such a floor would throw away.

Both values are constants in `runtime.js`, chosen against the live distribution and documented beside them; it is deliberately a floor and not a setting, for the reason given in §4. Calibration risk is real and stated: a floor set too high turns competent selections into skips, and three of those end a run blocked through the no-progress guard. They are therefore set conservatively — values that only reject a genuinely near-uniform or near-tied distribution — and the abstain is required to be distinguishable in the step record so a misfire is attributable rather than invisible.

## 8. Why not the alternatives

- **Give Jev the operation question back (upstream's `NEXT_ACTION`).** The constant is still in `questions.js` and the capability test still exercises it, so it is a small code change — but it reverses the user's pinned clarification and hands the run's judgment to a model that does not reason at all. Rejected. Recorded here as the option it is, not removed from the codebase.
- **Multi-action batching per cycle (browser-use's action list).** Would reduce round trips, but the complaint is decision *quality*, not throughput; batching multiplies the cost of a wrong decision and interacts with the approval gate, the lease, and the no-progress accounting. Out of scope.
- **Adding a planner, a todo list, or a page-state triage stage.** The research is explicit that upstream carries none of them and that this port already has more loop machinery than upstream; a new stage would add calls and latency on top of a loop whose inputs were the actual defect. Revisit only if the measured run after this change still stalls.
- **Merging the Jev loop into the SDK runtime.** §2 lets a decision call reach the SDK's model transport, deliberately as a bounded, tool-free, single-turn query. That is not the same as running the Jev loop as an SDK agent: the two engines still share the one dispatch gate and nothing else, and the loop keeps owning observation, selection, bounds, and guards. Merging the engines stays out of scope.
- **Removing the OpenAI-compatible text model.** Keeping it costs one branch and preserves local models, OpenRouter, and any Chat Completions host. Removing it would be a breaking change for existing `typesafe` profiles for no gain here.
- **Exposing reasoning effort, the confidence floor, or the element-table size as profile settings.** Each adds a settings, storage, and validation surface, and each default-wrong value reproduces the defect. Fixed constants, documented at their definition.

## 9. Verification

- Unit: `parseStepDecision` accepts a bounded `evaluation`, refuses a missing one, refuses an oversize one, and still refuses unrecognized keys; the reasoning parameter is `medium`/enabled for each decision-class stage and unchanged for the probe stages; the element-table projection respects every bound and discloses omissions; `recentActionRows` carries the operated element and the outcome.
- Runtime: a validated selection below the floor dispatches nothing, records a skipped step with the reason and the confidence, counts one toward no-progress, and continues; a selection above it is unchanged; three consecutive abstains end the run blocked through the existing guard with the existing reason.
- Run path: `agent-typesafe-run.test.mjs` drives a scripted provider through a cycle carrying the element table and an evaluation, and asserts the step record and emitted events.
- Side panel: the evaluation row renders and the abstain label reads as a skip, not a failure.
