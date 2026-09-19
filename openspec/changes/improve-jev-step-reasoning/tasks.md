# Tasks: Jev step decisions that reason before they act

Evidence for the ordering: `plans/reports/research-260919-0743-jev-agent-loop.md` (upstream loop, question surface, and the ranked causes). Section 1 is first because it is the mechanical cause; the prompt-surface work is worth little on an observation that omits the control. Sections 2 and 3 are independent of the rest and of each other, and can land in parallel.

## 1. Observation: see the control, then decide about it

- [x] 1.1 `extension/content.js` `isInteractive()` (~line 351): add the pointer-affordance pass — rendered, intersecting the viewport, computed `cursor: pointer`, innermost candidate only, no nested native form control, its own hard cap — beside the existing markup tests, with dropped candidates counted in the existing omission disclosure.
- [x] 1.2 Measure element-table size before/after on 3-4 fixture pages: growth only where a delegated-listener control exists, zero growth elsewhere. Record the numbers in the change's reports.
- [x] 1.3 `host/agent/jev/runtime.js`: settle after a dispatched `TYPE_TEXT` before the next observation — re-observe up to a small number of times inside a short fixed ceiling, stop as soon as the observation reports newly appeared controls (task 1.4's flag), and never extend any other cycle.
- [x] 1.4 Put the existing per-document newly-appeared marking on the snapshot element record in `extension/content.js` (~line 1310) — the same watermark `find` (`isNew`, ~1719) and the accessibility tree (`*[ref]`, ~661) already use, with its document-identity reset — then carry that flag into the step-decision element table and the selection request's state, and add the one explanatory sentence to `NEXT_STEP` and `TARGET_SELECTION`. Compute no second marking host-side.
- [x] 1.5 Tests: snapshot fixtures for the pointer pass (listed, innermost-only, no duplication, capped, disclosed); runtime tests for the settle bound and for the new-element marking across two observations.

## 2. Jev's third source: OpenRouter

- [x] 2.1 `host/agent/jev/client.js`: add `openrouter` to the source switch — `POST {endpoint}/api/alpha/decisions`, body `{model, state, questions}` with the namespaced model id (`typesafe/jev-1.13`), Bearer auth — reusing the shared `postJson`, retry policy, and failure taxonomy. Do not route Jev through any chat-completion or Messages endpoint on any source.
- [ ] 2.2 (OPEN — no live key available in this session) Capture the live response first, the way the Vercel constants were captured: where the answer's confidence lives and what `usage` looks like. Write the normalizer only against what was observed; never synthesize a confidence. Pin the constants in one block with a comment naming the capture date.
- [x] 2.3 Settings: OpenRouter joins the Jev source choice with its credential, its documented default endpoint (`https://openrouter.ai`), its model-list seed, and an alpha label on the route.
- [x] 2.4 Capability test: the TypeSafe question stage runs over the selected source's route and reports the existing actionable codes; a protocol drift fails loudly rather than degrading a decision.
- [x] 2.5 Tests: `jev-client.test.mjs` (URL, body, headers, normalization, retry parity across the three sources), `jev-capability.test.mjs`, `settings-typesafe.test.mjs`.

## 3. The decision model speaks the project's own standard

- [x] 3.1 `host/agent/settings/profile-schema.js`, `profile.js`: add the `typesafe` profile's decision-model source (`anthropic` | `chatgpt` | `openai`, defaulting to `openai` for a profile stored before it) and resolve its endpoint/credential into their **own** snapshot field. `env.ANTHROPIC_BASE_URL` keeps the `typesafe:jev` identity marker — do not overload it, or conversation identity binding breaks.
- [x] 3.2 Credentials by source: the Anthropic key under the profile's existing Anthropic target, the ChatGPT sign-in through the existing refresh-token target and gateway-token issuance, the text-model key in the existing TypeSafe record. Keep `SECRET_TOO_LARGE`, the revision bump, and cancel-active-runs-on-removal as they are; a deselected source's stored configuration is kept, not cleared.
- [x] 3.3 `host/agent/jev/text-helper.js`: add the Anthropic-standard decision transport beside the Chat Completions one — the bounded, tool-free, session-free `query()` options pattern of `enhance-prompt.js:135` (`mcpServers: {}`, `tools: []`, `maxTurns: 1`, no cwd/skills/hooks/permission mode, the profile's own env). One decision-class call is one such query.
- [x] 3.4 On that transport: no `response_format` exists, so the strict instruction + existing validator + existing single feedback retry carry the shape (keep the fenced-answer unwrap); thinking blocks are read as reasoning, never as the answer, and never carried into a later request; the cycle's capture attaches as an image content block instead of an `image_url` data URI.
- [x] 3.5 `host/agent/jev/capability.js`, `host/agent/settings/capability-test.js`: run the decision-model and image stages over the selected source's transport (a `chatgpt` source through the companion gateway with a test-scoped token), reported under the existing result shape and codes; record the result against the full configuration tuple including the source.
- [x] 3.6 `extension/settings/*`: the source picker, conditional fields per source, the ChatGPT account/usage/sign-out controls reused on a `typesafe` profile, validation that requires only the selected source, and the disclosure naming where requests go.
- [x] 3.7 Tests: `settings-typesafe.test.mjs`, `jev-capability.test.mjs`, the settings UI suites (client/controller/validation), and `agent-typesafe-run.test.mjs` driving one run on each of the three sources through scripted transports.

## 4. Reasoning budget by call class

- [x] 4.1 Re-check the vendor docs for the sources this is expected to run on: does the source support its reasoning mode together with the strict answer shape, and in which field or block does it return the answer? Then split the reasoning parameter in `host/agent/jev/text-helper.js` (`reasoningParam`, ~line 330) by call class: decision-class stages (`step_decision`, `run_plan`, memory revision, stall recovery, completion check) get the source's deliberate level — extended thinking on the Anthropic-standard sources, `reasoning: {effort: "medium"}` on every OpenAI-compatible host, the DeepSeek special case following the same rule; the capability probes keep the current minimal parameters. Document the split at the constant.
- [x] 4.2 Read the answer channel only, on both wires: a separate reasoning channel or thinking block is never the answer and is never echoed into a later request.
- [x] 4.3 Extend the capability test with one decision-class probe proving the source accepts reasoning together with the strict answer shape, reported as its own stage with the existing actionable codes, so an incompatible source is known at settings time rather than at the first decision.
- [x] 4.4 Give the step decision its own `max_tokens`, sized like `COMPLETION_CHECK_MAX_TOKENS` was, so a bounded answer carrying `evaluation` cannot be truncated mid-string.
- [x] 4.5 `host/test/jev-text-helper.test.mjs` and `jev-capability.test.mjs`: assert the parameter each stage sends per source, the answer-channel parse, and the new probe's reporting.

## 5. The element table in the decision context

- [x] 5.1 In `host/agent/jev/questions.js`, export a bounded element-table projection (index, tag/role, bounded label, bounded current value, state flags, the new-since-last-observation flag) built from the same observation the action space uses — no `ref`, no selector, no coordinate — with a deterministic tail-dropping ladder and an omitted-count disclosure.
- [x] 5.2 Carry it in the step-decision context in `text-helper.js` (`requestStepDecision`), as a sibling of `page`, under the decision request's own byte budget, on both transports.
- [x] 5.3 Extend `NEXT_STEP`: an intent must name a control the table offers; when none can advance the goal, choose `SCROLL_*`, `WAIT`, `NAVIGATE`, or `BLOCKED` rather than invent one; an omission disclosure means more page to reach, not an unreachable goal.
- [x] 5.4 Tests (`jev-questions.test.mjs`, `jev-text-helper.test.mjs`): bounds respected, execution handles absent, fitting deterministic from the tail, omission disclosed, oversize page still produces a sendable request.

## 6. Evaluation of the previous step

- [x] 6.1 Add the required bounded `evaluation` key to the `NEXT_STEP` answer contract and to `parseStepDecision` (`MAX_STEP_EVALUATION_CHARS`), keeping the unrecognized-key refusal and the one feedback retry unchanged in kind.
- [x] 6.2 Extend `recentActionRows` in `questions.js` with the bounded label of the element actually operated and the step's outcome (executed / skipped with reason / denied); thread the values from the runtime's step records. One projection serves both the decision and the selection request — do not add a second.
- [x] 6.3 Carry `evaluation` onto the step record in `host/agent/jev/runtime.js` and into the `jev_step` payload in `host/agent/protocol.js`.
- [x] 6.4 Tests: a missing evaluation is refused and spends exactly one feedback retry; an oversize one is refused; a valid one reaches the step record; recent rows carry element and outcome.

## 7. The selection floor and honest abstention

- [x] 7.1 Replace the closest-key fallback sentence in `TARGET_SELECTION` with the abstain instruction (select only on a genuine match).
- [x] 7.2 Add the two constants to `runtime.js` — a confidence floor (applied only where the wire reported a confidence) and a top-two probability margin (applied on every source) — documented beside their definitions with the distribution they are calibrated against. Apply them to the validated answer before dispatch: unresolved takes the existing `target_unresolved` skip path, recording the reported confidence and the top candidates' probabilities, counting one toward no-progress, and continuing the loop. Do not add an absolute floor on the chosen probability alone.
- [x] 7.3 Make the abstained skip distinguishable from a no-compatible-candidate skip in the step record and the protocol payload.
- [x] 7.4 Tests (`jev-runtime.test.mjs`): a below-floor confidence and a near-tied top two each dispatch nothing and record the skip with their values; a clear winner with a small absolute probability still dispatches; a source reporting no confidence is decided by the margin alone; consecutive abstentions reach the no-progress guard and end the run blocked with its existing reason after the guard's one consultation.

## 8. Panel surface

- [x] 8.1 `extension/sidepanel/conversation-model.js`: carry `evaluation` and the abstain values on the step row, live and restored.
- [x] 8.2 `extension/sidepanel/tool-labels.js`: human-readable evaluation line and a low-confidence skip label that reads as a skip, not a failure.
- [x] 8.3 Side-panel tests: live and restored rendering of both, no duplication after reconnect.

## 9. Verification and docs

- [x] 9.1 Run the Jev suites: `jev-text-helper`, `jev-questions`, `jev-runtime`, `jev-client`, `jev-capability`, `settings-typesafe`, `agent-typesafe-run`, plus the side-panel conversation-model, tool-label, and page-snapshot suites, the settings UI suites, and the registry/baseline suites if the snapshot's shape changed.
- [ ] 9.2 (OPEN — needs a live run) Drive one real run against a live page through a `typesafe` profile on the decision-model source the operator actually uses, and record the step rows in the change's reports: the evaluation text, at least one abstained step, and the reasoning-enabled decision latency, so the floor, the margin, and the effort level are calibrated against evidence rather than assumption.
- [x] 9.3 Update the README's "Run it on TypeSafe (Jev)" section where operator-visible behaviour changed: the decision-model source choice (including running the decision model on an existing Anthropic key or ChatGPT subscription), the evaluation line, the low-confidence skip, and the slower but deliberate decision step.
