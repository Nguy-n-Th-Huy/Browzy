## Why

Browzy currently calls its configured language model for every next action, then asks Jev to reconstruct the target from prose. The user requests the decision-layer architecture in the supplied reference: the language model plans and prepares content, Jev decides the next bounded action from current state, and existing browser tools execute it. This deliberately supersedes the per-step role split in `add-jev-run-context`; the separate unimplemented `decision-model-names-the-element` proposal is not applied or edited.

## What Changes

- Prepare a bounded plan, completion criteria, field-bound text values and navigation URLs with the configured language model initially and when replanning is required.
- Rebuild executable action candidates from each fresh observation. Jev chooses one complete operation/target/payload key in a single request, alongside independent completion and progress judgments.
- Offer WAIT, REPLAN, ASK and DONE control choices. Routine cycles no longer require an LLM NEXT_STEP call or prose-to-target resolution.
- Preserve host permissions, offered-key validation, bounded execution, stop behavior, screenshot context for LLM consultations, source consultation and reporting.
- Require confirmed completion. A failed or malformed completion check ends blocked rather than successful done.
- Make transcript attribution honest: Jev chooses actions, the LLM plans/checks completion, and ASK uses the existing blocked/operator-needed outcome.

## Capabilities

### Modified Capabilities

- `typesafe-jev-provider`: planning and content preparation, complete action choices, independent monitors, fresh host binding, honest completion and bounded replanning.

### Added Capabilities

- `jev-decision-layer`: the end-to-end runtime contract and observable attribution of the fast decision layer.

## Impact

`host/agent/jev/questions.js`, `client.js`, `text-helper.js`, `runtime.js`; directly affected protocol, capability, panel presentation and documentation; corresponding Jev, runtime and panel tests. Anthropic and ChatGPT runtime behavior stays unchanged. No new provider or image-input API is assumed.

## Non-goals

Native desktop execution, autonomous permission grants, guaranteed latency gains, a new operator resume mechanism, applying the competing unimplemented proposal, or removing existing report/source capabilities.
