# Tasks: fix-completion-check-timeout

## 1. The check's own timeout

- [x] 1.1 `host/agent/jev/text-helper.js`: export `COMPLETION_CHECK_TIMEOUT_MS = 120_000` and pass `timeoutMs: COMPLETION_CHECK_TIMEOUT_MS` from `requestCompletionCheck` only; every other caller keeps `DEFAULT_TIMEOUT_MS` — done: constant at text-helper.js:139, `requestCompletionCheck` defaults its `timeoutMs` to it and forwards through `postMemoryRequest`; the file header and the check's JSDoc name the one deliberate transport exception ← (verify: only the check's timeout changed; retry/fallback semantics untouched)
- [x] 1.2 `host/test/jev-text-helper.test.mjs`: pin the constant; observe that the completion-check call carries it while a step-decision/plan call carries the default; keep the unchanged-fallback assertions green — done: the new test records the transport's own abort timers through a delegating `setTimeout` wrapper (exactly one 120000 and zero 25000 for the check; exactly one 25000 and zero 120000 for the plan and the step decision); the runtime's unverifiable-check case stays green (done + summaryError + verification `achieved: null`) ← (verify: only the check's timeout changed; retry/fallback semantics untouched)

## 2. Focused suites and validation

- [x] 2.1 `cd host && node --test test/jev-text-helper.test.mjs test/jev-runtime.test.mjs test/jev-client.test.mjs` green; `openspec validate fix-completion-check-timeout --strict` valid (skip_specs) — done: 36/36, 76/76, 21/21 passed; validate valid. Independent verification (agent://VerifyCheckTimeout): verdict pass, 0 critical — the 120 s value reaches the transport's abort timer, a hang keeps the transport's single repeat and produces the identical live timeout signature, every other caller stays at 25 s, and the fallback is untouched ← (verify: green; only the owned files edited)

<!-- Verification note (F1, low, resolved by these ticks): the implementer shipped the work but left the boxes unchecked; ticked here with the verified evidence. F2 (info) accepted: whether a long report finishes inside 120 s is only answerable by a live run; the fallback stays honest either way. -->
