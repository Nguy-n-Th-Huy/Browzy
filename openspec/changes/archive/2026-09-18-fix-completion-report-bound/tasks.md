# Tasks: fix-completion-report-bound

## 1. Bound and budget

- [x] 1.1 `host/agent/jev/text-helper.js`: `MAX_REPORT_CHARS` 1,400 → 4,000; add `COMPLETION_CHECK_MAX_TOKENS = 4096` and an optional `maxTokens` seam on `postMemoryRequest` (default `TEXT_MODEL_MAX_TOKENS`); `requestCompletionCheck` passes it; the completion-check instruction's report bullet targets the bound ("keep the report within 4,000 characters") under the unchanged no-invention rules
- [x] 1.2 `host/test/jev-text-helper.test.mjs`: parse boundary (4,000 accepted; 4,001 refused with the named error and the verdict preserved); the completion-check request carries `max_tokens: 4096` while step-decision/plan/revision requests carry `1,024`; the instruction contains the bound sentence ← (verify: every other instruction/validator byte-identical; only the check's budget changed)

## 2. Focused suites and validation

- [x] 2.1 `cd host && node --test test/jev-text-helper.test.mjs test/jev-runtime.test.mjs test/jev-capability.test.mjs` green; `openspec validate fix-completion-report-bound --strict` valid (skip_specs) — done: 35/35, 76/76, 15/15; valid ← (verify: green; only the owned files edited)
