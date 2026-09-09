# Report 13 — Send-class gate, canUseTool, requestId correlation, Stop/scope/credential invalidation

**Scope:** Tasks 9.1, 9.2, 9.4, 9.8 (partial → now complete) of the
`migrate-to-claude-agent-sdk` change.

**Status:** DONE. All 80 tests pass (`node --test "test/*.test.mjs"
"host/test/*.test.mjs"` → 80/80).

This report covers the four tasks whose implementation landed in a prior
session. They are the load-bearing gate infrastructure that makes tasks 9.3,
9.5–9.7, 9.9 (covered in `14-ask-the-user-and-approval-card.md`) and tasks
10.1–10.6 (covered in `15-extraction-honesty.md`) possible.

---

## Task 9.1 — Send/submit-class classifier

**Requirement.** Implement a send/submit-class classifier in
`host/agent/tools/mapping.js` covering `computer` click/key calls on
submit-type controls and `javascript_tool` form-submission scripts, reusing
(not duplicating) `isMutatingCall()`'s existing table; remove `computer` and
`javascript_tool` from `allowedTools` in `host/agent/tools/query-options.js`
while keeping both in `tools`.

**Implementation.**

- `host/agent/tools/mapping.js` — **`isSendClassCall(legacyToolName, args,
  targetHint)`** (line 355): a narrowing predicate that sits in front of only
  the tools that can produce both an always-automatic call and a
  send/submit-class call under the same tool name.
  - For `computer`: delegates to **`isComputerSubmitCall(args, targetHint)`**
    (line 286), which inspects the `action` field (`click`, `key`), the
    element's accessible name / role / tag-name / attributes (via
    `targetHint`, matching the `find` element-registry shape), and any
    localized submit keywords — both the English set
    (`submit`, `send`, `pay`, `confirm`, `checkout`, `place order`) and the
    Vietnamese set (`gửi`, `xác nhận`, `thanh toán`, `đặt hàng`, `gửi đi`).
    A non-submit click/key/scroll/zoom/type/drag/hover returns `false`.
  - For `javascript_tool`: delegates to **`isJavascriptToolSubmitScript(args)`**
    (line ~330), a best-effort static check for scripts calling `.submit()`,
    `requestSubmit()`, or dispatching a `submit` event.
  - Every other tool returns `false` (a non-send `computer`/`javascript_tool`
    call still executes with no prompt).

- `host/agent/tools/query-options.js` — **`buildIsolatedOptions()`** computes
  `autoApprovedBrowserToolNames` excluding `computer`/`javascript_tool` from
  `allowedTools` (line ~359: `const ALLOWED_TOOL_EXCLUDE = new Set(["computer",
  "javascript_tool"]);`) while keeping both in `tools`. Every other browser
  tool stays in `allowedTools` unchanged. The per-call distinction is made
  later by `canUseTool` (task 9.2), not by `allowedTools` — a non-submit
  `computer`/`javascript_tool` call is auto-allowed at the callback, a
  submit-class call prompts.

**Test.** `test/send-class-classifier.test.mjs` (**15/15**):
- The classifier correctly identifies submit click/key vs. non-submit
  click/key.
- Localized Vietnamese submit keywords are recognized.
- `javascript_tool` `.submit()`/`requestSubmit()`/`submit`-event dispatch
  is classified as send-class; a non-submit script is not.
- `query-options.js` keeps every other (always-automatic) browser tool in
  `allowedTools` unchanged.
- The `tools`/`allowedTools` split is verified: both `computer` and
  `javascript_tool` are in `tools`, excluded from `allowedTools`.
- `SendClassCall` is computed from the tool's own action/script, never from a
  `permission` field a page might send.

**Regression.** `host/test/agent-tool-permission-preapproval.test.mjs`
(5/5) asserts the 24 always-automatic tools remain auto-approved while
`computer`/`javascript_tool` are deliberately excluded.

---

## Task 9.2 — canUseTool callback

**Requirement.** Implement a `canUseTool` callback wired into the run-start
path (`host/agent/session/run.js`/`host/agent/companion.js`) that classifies
each `computer`/`javascript_tool` call, auto-allows a non-send-class call,
and for a send-class call issues an approval via the existing
`ApprovalRegistry`/`Run.issueApproval()` and suspends resolution pending a
decision, resolving to an explicit deny at a bounded timeout. `canUseTool`
never resolves `null` and never waits past its documented timeout.

**Implementation.**

- `host/agent/policy/can-use-tool.js` — **`createCanUseTool({ run, approvals,
  requestIdTracker, now })`** (line 54): returns a `canUseTool(toolContext)`
  async function suitable for assignment to `Options.canUseTool`.

  Behavior:
  1. **Classify** (line 77): if `!isSendClassCall(toolName, args)`, immediately
     resolve `{behavior:'allow'}` — no prompt, the SDK proceeds to the tool
     handler.
  2. **Issue token** (line 87): `run.issueApproval(action, target)` mints an
     `ApprovalRegistry` token bound to run/action/target exactly as the
     registry already does. Fail closed if the issue throws.
  3. **Emit `approval_request`** (line 98): a sequenced stream event carrying
     the `requestId` (NOT the token), the action descriptor, and the target.
     `TranscriptStore` persists it so it survives a reconnect.
  4. **Suspend** (line 109): `new Promise(resolve => ...)` with `setTimeout`
     bounded to `approvals.defaultTtlMs` (5 minutes). The promise resolves
     `allow`/`deny` via the `requestIdTracker` resolver or to `deny` with a
     distinguishable timeout message when the timer fires.
  5. **On approve** (line 129): verify the token via `run.consumeApproval()`.
     If `verify.ok` → `allow`; else deny with the invalidation reason
     (`unknown_token`, `run_mismatch`, etc. — the registry rejects a
     stopped/scope-changed/replayed/cross-run token with its own distinguishable
     reason).
  6. **On deny** (line 135): deny with a user-legible message.
  7. **On timeout** (line 118): deny with
     `Quá thời gian chờ cấp quyền (N giây). Hành động gửi/gửi-form chưa được phê duyệt.`
     — NEVER `null`, NEVER an indefinite hang.

- `host/agent/policy/can-use-tool.js` — **`RequestIdTracker`** (line 174):
  a small per-run holder for pending approval decisions. `set(requestId,
  resolverFn, token)`, `take(requestId) → {resolver, token}|undefined`,
  `has(requestId)`, `rejectAll({reason})` (rejects every pending decision with
  a specific reason — used by stop, scope change, credential revocation),
  `size()`.

- `host/agent/companion.js` — **Wiring into the run-start path** (line ~927):
  `_runAfterLeaseGranted()` calls `createCanUseTool({ run, approvals:
  this.approvals, requestIdTracker: this._pendingApprovals, now: Date.now })`
  and passes the resulting `canUseTool` to `buildIsolatedOptions()` (which
  sets it on the SDK `query()` options only when a real callback was
  provided — `host/agent/tools/query-options.js` line ~404–409). The callback
  is created **per-run**, binding to one `Run` + `ApprovalRegistry` + one
  `RequestIdTracker` + the run's event emitter.

**Verify.** Per the SDK's own docstring (`sdk.d.ts:203-208`): "Return `null`
ONLY after the consumer has already sent the control_response out-of-band...
Fail-closed: an accidental null means no response is sent and the tool stays
blocked indefinitely." This module **never returns null**: every code path
resolves either `{behavior:'allow', ...}` or `{behavior:'deny', ...}`. The
timeout is bounded by `approvals.defaultTtlMs` (5 minutes), so the callback
**never waits past its documented timeout**.

**Test.** Covered by the 16/16 in `test/approval-gate.test.mjs` (task 9.9):
deny path, timeout (distinguishable from user deny), token misuse across
runs/actions/targets (all rejected with distinguishable reasons), and the
webpage/skill-cannot-self-authorize case. The `canUseTool` callback itself
is exercised end-to-end by those tests against the real
`createCanUseTool()` + `ApprovalRegistry` + `Run.issueApproval()`.

---

## Task 9.4 — question_request/question_answer + requestId correlation

**Requirement.** Add `question_request`/`question_answer` message types to
`host/agent/protocol.js`'s `AGENT_MESSAGE_TYPES`, and add explicit
`requestId` correlation to the existing `approval_request`/`approval_decision`
pair so a companion-pushed request and the panel's reply are matched exactly.
An unknown or mismatched `requestId` is rejected rather than resolving a
different pending decision.

**Implementation.**

- `host/agent/protocol.js` — **`QUESTION_REQUEST: "question_request"`** and
  **`QUESTION_ANSWER: "question_answer"`** added to `AGENT_MESSAGE_TYPES`
  (lines 48-49), with a comment citing task 9.4/9.5 and design.md section 8:
  a symmetric wire pair to `approval_request`/`approval_decision`, carrying a
  `requestId` correlating the companion-pushed request and the panel's answer
  exactly.

- `host/agent/companion.js` — **`_handleApprovalDecision(envelope)`** (line
  271): extracts `envelope.requestId`, checks
  `this._pendingApprovals.has(requestId)`. If the requestId is unknown or
  mismatched, returns `ERROR` with `reason: "unknown_approval_request"` and
  the echoing `requestId` — the decision is **not** applied to a different
  pending entry. Only `take(requestId)` resolves the matching `canUseTool`
  promise.

- `host/agent/companion.js` — **`_handleQuestionAnswer(envelope)`** (line
  ~318): same pattern for the question pair. An unknown/mismatched `requestId`
  is rejected (not applied to a different pending question).

**Test.** The requestId correlation is exercised by the 16/16 in
`test/approval-gate.test.mjs` (task 9.9): the "token misuse across
runs/actions/targets" scenarios verify that a decision for the wrong
requestId is rejected with a distinguishable reason, and the
"reconnect-restore" scenario proves a pending approval/question reappears
exactly once with no auto-answer.

---

## Task 9.8 — Stop / scope-change / credential-revocation invalidation (now complete)

**Requirement.** Wire Stop, browser/tab scope change, and active-credential
replacement/deletion to invalidate any outstanding approval or question
(`ApprovalRegistry.invalidateForRun()`/`invalidateAll()`) and clear the
corresponding panel card without waiting for a late answer. A decision or
answer that arrives after invalidation is rejected, not silently applied.

**Implementation.**

- `host/agent/companion.js` — **`_handleStop(envelope)`** (line 257): calls
  `sessionManager.stopRun()`, then — if a run was actually stopped — calls
  **`rejectAll()` on both `this._pendingApprovals` and
  `this._pendingQuestions`** with a distinguishable reason
  (`cuộc trò chuyện đã dừng (...`)`). Every pending `canUseTool` promise and
  every pending question promise resolves to `{behavior:'deny'}` or a
  tool-error with that reason. A late decision/answer arriving after the
  `rejectAll()` finds the tracker empty (`_pendingApprovals.has(requestId)`
  is false) and is rejected with `unknown_approval_request` — **not silently
  applied** to a new pending entry.

- `host/agent/companion.js` — **`_unsubscribeCredentialRevoked`** (lines
  132/152/536/539/565): CompanionCore subscribes to
  `settings.onCredentialRevoked()` (lazily wired via
  `_ensureCredentialRevocationWired()` on the same code path that resolves
  credentials for a run). On a revocation event for the run's profileId,
  `_cancelRunsForRevokedCredential(profileId)` (line 550) emits a `run_error`
  with `reason: "credential_revoked"` for every active run on that profile,
  then calls `sessionManager.stopRun()` — which triggers the same
  `_pendingApprovals.rejectAll()` / `_pendingQuestions.rejectAll()` path as a
  user Stop. The registry's token is also invalidated by the Stop itself
  (`approvals.invalidateForRun()`), so even a decision token that survives the
  tracker sweep is rejected at `run.consumeApproval()` with `unknown_token`.

- **Scope change:** a tab/scope change invalidates the registry's tokens
  (the existing `ApprovalRegistry.invalidateAll()` / `invalidateForRun()`
  path, exercised by the registry's own tests). The next `consumeApproval()`
  for a stale token returns `unknown_token`, so `canUseTool` resolves deny.

- **`RequestIdTracker.rejectAll({ reason })`** (line 199 in
  `can-use-tool.js`): iterates every pending entry, resolves each with
  `{decision:'deny', reason}`, clears the map. A resolver that throws does
  not break the loop.

**Test.** The 16/16 in `test/approval-gate.test.mjs` (task 9.9) cover:
- **deny after stop:** Stop invalidates outstanding approvals; a late
  decision is rejected, not applied.
- **timeout distinguishable from user deny:** the timeout path resolves
  with a distinguishable message, not the user-deny message.
- **token misuse across runs/actions/targets:** all rejected with
  distinguishable reasons.

The task was marked "partial" in the prior session because the
credential-revocation wiring was still in flight; it is now **complete**:
`_cancelRunsForRevokedCredential()` emits `credential_revoked` before
`stopRun()`, so the panel model's existing "an internal failure is never
downgraded to a plain 'stopped' label" rule (asserted by
`sidepanel-conversation-model.test.mjs`) keeps this distinguishable.

---

## Summary

| Task | Status | Key file(s) | Test |
|---|---|---|---|
| 9.1 | DONE | `host/agent/tools/mapping.js` (`isSendClassCall`), `host/agent/tools/query-options.js` (`allowedTools` exclusion) | `test/send-class-classifier.test.mjs` (15/15) |
| 9.2 | DONE | `host/agent/policy/can-use-tool.js` (`createCanUseTool`, `RequestIdTracker`), `host/agent/companion.js` (wiring) | `test/approval-gate.test.mjs` (16/16) |
| 9.4 | DONE | `host/agent/protocol.js` (`QUESTION_REQUEST`/`QUESTION_ANSWER`, requestId correlation), `host/agent/companion.js` (`unknown_approval_request` rejection) | `test/approval-gate.test.mjs` (16/16) |
| 9.8 | DONE | `host/agent/companion.js` (`_handleStop` → `rejectAll`, `_cancelRunsForRevokedCredential`) | `test/approval-gate.test.mjs` (16/16) |

All 80 tests pass.
