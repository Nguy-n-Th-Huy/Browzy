# Design: Completion Report Bound

## Context

- The live case: completion check confirmed, report 1,571 chars, bound 1,400 → `summaryError: "the completion check's 'report' is 1571 characters, over the 1400 bound"`, outcome `done` verified, no report shown. `MAX_REPORT_CHARS = 1400` and the shared `TEXT_MODEL_MAX_TOKENS = 1024` came from the run-context change, sized for a short result blurb.
- The shared builder `postMemoryRequest` hardcodes `max_tokens: TEXT_MODEL_MAX_TOKENS`; the completion check is its one caller whose output could legitimately be long.

## Goals / Non-Goals

**Goals:** an analysis fitting a page-sized report (~4,000 Vietnamese characters) is delivered; the completion check can actually emit it; every other call keeps its budget; beyond-bound behavior stays honest and unchanged.

**Non-Goals:** no requirement text changes (`skip_specs`); no change to parse/verdict semantics; no change to other calls' budgets; no streaming.

## Decisions

### 1. `MAX_REPORT_CHARS` 1,400 → 4,000

The observed analysis needed 1,571; 4,000 gives a page-sized analysis room while remaining a real bound. Beyond it, the existing behavior stands: the report is refused, `summaryError` records why, and the verdict is unchanged — the honest failure path the spec's "result report cannot be produced" scenario describes.

### 2. A per-call token budget, only for the completion check

`postMemoryRequest` gains an optional `maxTokens` (default `TEXT_MODEL_MAX_TOKENS`), and `requestCompletionCheck` passes `COMPLETION_CHECK_MAX_TOKENS = 4096`. Rationale: a 4,000-character Vietnamese report needs well over 1,024 tokens; a JSON object cut off mid-string would validate as nothing at all, which is strictly worse than a named oversize failure. The plan/revision/recovery/step-decision calls keep 1,024 — their answers are small structured objects (verified live within the budget).

### 3. The instruction says the target

`COMPLETION_CHECK`'s report bullet changes from "a concise report" to a focused report and states the bound ("keep the report within 4,000 characters"), so the model aims inside the parse. No other instruction rules change.

### 4. Tests

`host/test/jev-text-helper.test.mjs`: the parse boundary (4,000 accepted; 4,001 refused with the named error; the verdict preserved); the completion-check request carries `max_tokens: 4096` while the step decision, plan, and revision requests carry `1,024`; the instruction contains the bound sentence. No other suite pins these values.

## Risks / Trade-offs

- **[Larger outputs cost more tokens]** → only the completion-check call, once per run (plus rejections); the rest are unchanged.
- **[Longer reports in the transcript/panel]** → bounded at 4,000 chars, shown as the run's answer like any result report.
- **[A report between 4,001 and the model's own cutoff]** → refused with the recorded reason, unchanged from today.
