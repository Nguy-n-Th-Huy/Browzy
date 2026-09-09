# Report 14 — Ask-the-user tool, approval card, question card, and approval-gate tests

**Scope:** Tasks 9.3, 9.5, 9.6, 9.7, 9.9 of the
`migrate-to-claude-agent-sdk` change.

**Status:** DONE. All 80 tests pass (`node --test "test/*.test.mjs"
"host/test/*.test.mjs"` → 80/80).

This report covers the user-facing half of the approval/ask-the-user gate:
the borrowed-tab auto-authorization (9.3), the application-owned ask-the-user
SDK tool (9.5), the panel approval card (9.6), the panel question card
(9.7), and the full approval-gate test matrix (9.9). The gate infrastructure
these build on (9.1, 9.2, 9.4, 9.8) is documented in `13-send-class-gate.md`.

---

## Task 9.3 — Automatic borrowed-tab mutation authorization (javascript_tool excluded)

**Requirement.** Call `authorizeBorrowedTabMutation()` automatically once a
run's bound tab is legitimately in scope for interaction, so the automatic
action set (typing, filling, non-submit clicks, scrolling, hovering —
`computer`'s non-submit-classified actions and `form_input` only) runs on a
borrowed tab with neither a prompt nor a `BorrowedTabMutationError`, without
widening the separate rule that a mere read/analyze request does not
authorize navigation, submission, closing, or regrouping of that tab.
**`javascript_tool` is deliberately excluded** (design section 9d): the
original "in-scope scripts" wording is unsound because
`authorizeBorrowedTabMutation()` is a per-tab flag with no notion of which
tool asked, so granting it for typing would silently also authorize a later
navigating script against the same tab.

**Implementation.**

- `host/agent/tools/adapter.js` — **`_isAutoAuthorizeEligible(toolName, args)`**
  (line 47): determines which calls are eligible for the automatic borrowed-tab
  mutation authorization.
  - `form_input` → always eligible (reliably classifiable as a non-send,
    filling action).
  - `computer` → eligible ONLY when `!isSendClassCall(toolName, args)` (a
    non-submit click/key, scroll/zoom/type/drag/hover all return false from
    the classifier). A send-class call (submit click, submit key) is gated
    through the approval card, not auto-authorized.
  - `javascript_tool` → **explicitly excluded** (line 63, comment cites
    design 9d). Every other tool → not part of the automatic action set.

- `host/agent/tools/adapter.js` — in the tool dispatch path (line ~145), for
  each eligible call with a `tabId` argument that targets a borrowed tab in
  this run's scope, `authorizeBorrowedTabMutation(run, tabId)` is called
  before `enforceBorrowedTabScope()`. This lifts the read-only default for
  that tab for `computer`/`form_input` only.

- `host/agent/tools/mapping.js` — **`authorizeBorrowedTabMutation(run, tabId)`**
  (line 224): adds `tabId` to the per-run `mutationAuthorizationsByRun` WeakMap
  set. **`isBorrowedTabMutationAuthorized(run, tabId)`** (line 229) checks it.

- `host/agent/tools/mapping.js` — **`enforceBorrowedTabScope(...)`** (line
  483): the borrowed-tab scope gate. For a mutating call against a borrowed
  tab: if the tool is `javascript_tool`, checks `isJavaScriptToolBorrowedTabAuthorized()`
  (a SEPARATE flag, never set by `authorizeBorrowedTabMutation()` — task 10.4);
  else checks `isBorrowedTabMutationAuthorized()`. If not authorized, throws
  `BorrowedTabMutationError`.

**Verify.**
- Filling a field on the bound article tab succeeds with no prompt and no
  rejection (the auto-grant fires for `form_input`).
- A `javascript_tool` call against that same tab, issued after that
  authorization, **still fails** `enforceBorrowedTabScope()` (the
  `javascript_tool` flag is separate and never auto-set).
- Anything not covered by this automatic set still requires either its
  existing authorization path or the new approval gate.

**Test.** `test/borrowed-tab-javascript-tool.test.mjs` (**6/6**):
- filling/form_input succeeds against a borrowed tab (auto-grant fires).
- `javascript_tool` against that same tab fails even after the auto-grant.
- read-only `javascript_tool` rejected.
- navigation-equivalent `javascript_tool` (`window.location.href = ...`)
  rejected.
- `window.location.href` rejection stays after the auto-grant for typing.
- the live-evidence rejection is preserved.

---

## Task 9.5 — Application-owned ask-the-user SDK tool

**Requirement.** Implement the application-owned ask-the-user SDK tool
(`tool()`/`createSdkMcpServer()`, registered alongside the existing browser
tools in `host/agent/tools/adapter.js`) accepting one question, a short
header, and 2-4 pre-written options, emitting a sequenced
`question_request` stream event, and resolving with the user's chosen
option(s) as plain tool-result content once `question_answer` arrives or its
own bounded timeout elapses. The tool's result is ordinary `CallToolResult`
content, never a `PermissionResult`, and is never read by the approval
gate.

**Implementation.**

- `host/agent/tools/ask-the-user.js` — **`createAskUserTool({ run,
  requestIdTracker, timeoutMs, now, requestIdMint, toolFactory })`** (line
  88): builds the `ask_user` SDK tool using the same `tool()` factory the
  browser tools use (lazy-imported from `@anthropic-ai/claude-agent-sdk`, or
  an injectable `toolFactory` for tests).

  - **Input schema** (line 103): zod shape — `question: z.string()`,
    `header: z.string()`, `options:
    z.array(z.object({label, description?})).min(2).max(4)`,
    `multiSelect: z.boolean().optional()`. Mirrors
    `AskUserQuestionInput` (sdk-tools.d.ts:1026) without adopting the
    built-in tool's unverified wiring.

  - **Handler** (line 129): validates 2-4 options, mints a `requestId`
    (`q_<now>_<random hex>`), emits a sequenced **`question_request`**
    stream event via `run.emit()` (carrying `requestId`, `question`,
    `header`, `options`, `multiSelect`, `ts` — same `TranscriptStore` path
    as `approval_request`, so it survives a reconnect), then awaits the
    panel's matching `question_answer` or a bounded timeout.

  - **Resolution** (line 162): `new Promise(resolve => ...)` with
    `setTimeout` bounded to `QUESTION_TIMEOUT_MS` (5 minutes, matching
    `approvals.defaultTtlMs` exactly — same abandonment discipline as the
    approval gate). On timeout → explicit `isError: true` tool result with
    a legible message (never a hang). On answer → the user's chosen option(s)
    as **plain `CallToolResult` content** (`{type:'text', text:'Người dùng đã
    chọn: ...'}`, `isError: false`). On no selection → `isError: true`.

  - The result is **never a `PermissionResult`**, **never consulted by
    `canUseTool`**, and **grants NO authority**: the answer is data the model
    can read and act on in its next turn, exactly like a `read_page` result.

- `host/agent/tools/adapter.js` — the `ask_user` tool is registered
  alongside the 26 browser tools in the SDK MCP server via
  `createSdkMcpServer()` (the same pattern all browser tools use).

- `host/agent/companion.js` — the run-start path (`_runAfterLeaseGranted`)
  builds the ask-user tool bound to the run + `this._pendingQuestions`
  tracker and includes it in the SDK `query()` options.

**Verify.** The tool's result is ordinary `CallToolResult` content (a text
block), never a `PermissionResult` (which is `{behavior:'allow'|'deny'}` —
the approval gate's shape, used only by `canUseTool`). The tool handler and
the `canUseTool` callback are completely separate code paths that never
share a return type.

**Test.** Covered end-to-end by the **16/16** in
`test/approval-gate.test.mjs` (task 9.9), which drives a real
`CompanionCore` through the `question_request` → `question_answer` cycle
and verifies the tool resolves with plain content on a real answer and a
legible error on timeout.

---

## Task 9.6 — Panel approval card

**Requirement.** Implement the panel approval card in
`extension/sidepanel/` (building on `conversation-model.js`'s existing
`pendingApproval` field and `run-states.js`'s `WAITING_FOR_PERMISSION`
phase) showing the concrete action/target with Allow/Deny, and sending
`approval_decision` with the matching `requestId`. The card is bound to and
cleared with the specific run/requestId, never applied to a different one.

**Implementation.**

- `extension/sidepanel/sidepanel.js` — **`renderPermission()`** (line 302):
  renders the approval card into `#permissionSlot` when
  `model.pendingApproval` is set. The card is an `alertdialog` showing the
  concrete action (`permission-card-title`), the target
  (`permission-card-target` text content = `JSON.stringify(target)`), and
  two buttons: **Từ chối** (Deny) and **Cho phép** (Allow). Button click
  handlers call `panel.respondApproval("deny"|"approve")`. The card is
  cleared (slot innerHTML set to `""`) when `pendingApproval` is null.

- `extension/sidepanel/conversation-model.js` — **`pendingApproval`** (line
  83): `{action, target, requestId, ts}` — set when an `approval_request`
  stream event arrives (line 306), cleared on `approval_decision` sent or a
  run-stop/complete (line 353). The `requestId` is carried through the model
  so the panel reply is correlated exactly.

- `extension/sidepanel/panel-controller.js` — **`respondApproval(decision)`**
  (line 189): reads `model.pendingApproval.requestId`, sends
  `approval_decision` via `protocol.sendApprovalDecision()` with the matching
  `requestId`, then clears the model's `pendingApproval`. A decision for a
  different `requestId` (a stale card after a reconnect/stop) finds the model
  without that pending entry and is dropped.

- `extension/sidepanel/conversation-model.js` — the `runPhase()` getter (line
  414) returns `WAITING_FOR_PERMISSION` when `pendingApproval` is set, so the
  panel's existing phase-based rendering surfaces the card.

**Verify.** The card is bound to the specific `requestId` in
`pendingApproval`; the reply sends that same `requestId`; a decision for a
different `requestId` is rejected by the companion's
`_handleApprovalDecision` (`unknown_approval_request` — task 9.4).

**Test.** The 16/16 in `test/approval-gate.test.mjs` (task 9.9) exercise the
full cycle; `test/sidepanel-conversation-model.test.mjs` and
`test/sidepanel-fake-companion.test.mjs` test the model's `pendingApproval`
state transitions against a real `CompanionCore`.

---

## Task 9.7 — Panel ask-the-user question card

**Requirement.** Implement the panel ask-the-user question card (options,
keyboard Tab/Enter/Space selection, a transcript entry recording the chosen
option) and send `question_answer` with the matching `requestId`.
Keyboard-only operation can select and submit an answer, and the transcript
shows exactly which option was chosen.

**Implementation.**

- `extension/sidepanel/sidepanel.js` — **`renderQuestion()`** (line 335):
  renders the question card into `#questionSlot` when
  `model.pendingQuestion` is set. The card is a `group` showing the header
  (title) and question (detail), the 2-4 option buttons (each a clickable
  `.question-option` with keyboard Tab focus, Enter/Space to toggle), and a
  **Xác nhận** (Confirm) button. `multiSelect` toggles single vs. multiple
  selection. Tab moves focus between options and the Confirm button;
  Enter/Space toggles an option; Confirm calls
  `panel.respondQuestion(selectedLabels)`.

- `extension/sidepanel/conversation-model.js` — **`pendingQuestion`** (line
  88): `{question, header, options, requestId, multiSelect, ts, runId}` —
  set when a `question_request` stream event arrives (line 322), cleared on
  `question_answer` sent or a stop (line 359). On confirm, a transcript entry
  is pushed (line 367) recording the chosen option(s) as a `user`-kind item
  with `isQuestionAnswer: true`.

- `extension/sidepanel/panel-controller.js` — **`respondQuestion(answer)`**
  (line ~213): reads `model.pendingQuestion.requestId`, sends
  `question_answer` via `protocol.questionAnswer()` (line 202 in
  `protocol-client.js`) with the matching `requestId`, then clears the
  model's `pendingQuestion`.

- `extension/sidepanel/protocol-client.js` — **`questionAnswer({conversationId,
  requestId, answer})`** (line 202): sends the `question_answer` envelope.

**Verify.** Keyboard-only operation: Tab navigates between option buttons
and the Confirm button (native browser focus), Enter/Space toggles
selection, Confirm submits. The transcript entry records the chosen
option(s) text.

**Test.** The 16/16 in `test/approval-gate.test.mjs` (task 9.9) cover the
question cycle end-to-end; `test/sidepanel-conversation-model.test.mjs`
covers the `pendingQuestion` state transitions.

---

## Task 9.9 — Approval-gate test matrix

**Requirement.** Test deny (action does not execute, transcript records
denial, run continues), timeout (explicit timeout-denied outcome
distinguishable from a user deny, no indefinite hang), reconnect-restore
(pending approval/question reappears exactly once with no auto-answer),
token misuse across runs/actions/targets (rejected with a distinguishable
reason), and the webpage/skill-cannot-self-authorize case (page content,
tool output, or skill instructions resembling an approval or a token have no
effect on a pending decision).

**Test.** `test/approval-gate.test.mjs` (**16/16**):

| # | Scenario | Verify |
|---|---|---|
| 1 | **Deny** — a send-class `computer` call is denied by the user | action does not execute, transcript records denial, run continues |
| 2 | **Timeout** — no decision within the TTL | explicit timeout-denied outcome with a distinguishable message (NOT the user-deny message), no indefinite hang |
| 3 | **Timeout ≠ deny** — the timeout reason string differs from the user-deny reason string | distinguishable |
| 4 | **Reconnect-restore** — a pending approval reappears after a snapshot+replay | exactly once, no auto-answer |
| 5 | **Reconnect-restore (question)** — a pending question reappears after a snapshot+replay | exactly once, no auto-answer |
| 6 | **Token misuse: wrong run** — a decision token from run A refused by run B | `run_mismatch` |
| 7 | **Token misuse: wrong action** — a decision for action X does not authorize action Y | rejected |
| 8 | **Token misuse: wrong target** — a decision for tab A does not authorize tab B | rejected |
| 9 | **Token misuse: after stop** — a decision token after `stopRun()` | `unknown_token` |
| 10 | **Webpage cannot self-authorize** — page content resembling an approval/token | no effect |
| 11 | **Skill cannot self-authorize** — skill instructions resembling an approval/token | no effect |
| 12 | **Tool output cannot self-authorize** — a tool result resembling an approval | no effect |
| 13 | **Question answer** — chosen option resolves the tool with plain content | `CallToolResult`, not `PermissionResult` |
| 14 | **Question timeout** — no answer within TTL | explicit `isError: true`, no hang |
| 15 | **Question wrong requestId** — answer for a different requestId | rejected |
| 16 | **Stop invalidates both** — `stopRun()` rejects pending approvals AND questions | both trackers cleared |

Every scenario in `specs/browser-assistant-panel/spec.md`'s and
`specs/agent-browser-runtime/spec.md`'s new requirements has a passing test.

---

## Summary

| Task | Status | Key file(s) | Test |
|---|---|---|---|
| 9.3 | DONE | `host/agent/tools/adapter.js` (`_isAutoAuthorizeEligible`), `host/agent/tools/mapping.js` (`authorizeBorrowedTabMutation`, `enforceBorrowedTabScope`) | `test/borrowed-tab-javascript-tool.test.mjs` (6/6) |
| 9.5 | DONE | `host/agent/tools/ask-the-user.js` (`createAskUserTool`), `host/agent/tools/adapter.js` (registration) | `test/approval-gate.test.mjs` (16/16) |
| 9.6 | DONE | `extension/sidepanel/sidepanel.js` (`renderPermission`), `conversation-model.js` (`pendingApproval`), `panel-controller.js` (`respondApproval`) | `test/approval-gate.test.mjs` (16/16) |
| 9.7 | DONE | `extension/sidepanel/sidepanel.js` (`renderQuestion`), `conversation-model.js` (`pendingQuestion`), `panel-controller.js` (`respondQuestion`), `protocol-client.js` (`questionAnswer`) | `test/approval-gate.test.mjs` (16/16) |
| 9.9 | DONE | — | `test/approval-gate.test.mjs` (16/16) |

All 80 tests pass.
