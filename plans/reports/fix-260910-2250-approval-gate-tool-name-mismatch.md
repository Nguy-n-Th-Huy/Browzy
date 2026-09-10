# Fix: approval gate never ran; dispatch refused what it never gated

Date: 2026-09-10 22:50 · Branch: master · Type: fix (host, security-relevant)

## Trigger

User reported agent text in conversation log: "The click was blocked by the approval gate. Let me request a fresh approval." Traced from `~/.config/browzy-in-chrome/agent/conversations/`.

## Evidence (from stored logs, all conversations)

| metric | count |
|---|---|
| `tool_rejected reason=stale_approval` | 8 (5 conversations) |
| `approval_request` emitted, ever | **0** |
| `approval_decision`, ever | **0** |
| ref-clicks succeeded | 220 |
| coordinate-clicks succeeded | 156 |

Representative trace (`conv_39b139734c8624666b`, run_2e460baf22c8b87c9e):
`find` → `left_click{ref}` → stale → retry → stale → screenshot/update_plan/`find` → `left_click{ref}` → stale → `left_click{coordinate:[862,138]}` → **OK, same element**.

## Root cause (two defects, same boundary)

### 1. Gate compared an SDK-qualified name against legacy names

`Options.canUseTool` receives `mcp__browzy-in-chrome-browser__computer`. Every classifier in `host/agent/tools/mapping.js` keys on legacy names by exact equality (`SEND_CLASS_TOOL_NAMES.includes(...)`, `legacyToolName === "computer"`). So `classifySendClassCall` took its `non-gated-tool` branch for **every** computer/javascript_tool call → gate auto-allowed, never prompted, never minted a grant.

Proven directly:

```
classifySendClassCall("mcp__browzy-in-chrome-browser__computer", {action:"click",description:"submit the form"})
  -> {verdict:"allow", reason:"non-gated-tool"}
classifySendClassCall("computer", <same args>)
  -> {verdict:"approve-known", reason:"target resolves to a submit/send/pay/confirm control"}
```

Impact: submit/pay/confirm clicks dispatched with **no user approval ever requested**. This is the serious half — worse than the symptom reported.

Why it shipped: `test/approval-gate.test.mjs` passed bare `toolName: "computer"` everywhere, so the whole suite was green against a name live traffic never uses.

### 2. Gate and dispatch classified on different evidence

`can-use-tool.js` classifies WITH a resolved target hint (`resolveHintFor()` dereferences `ref` against the live page). `adapter.js#verifyPreDispatchApproval` has no page access and classified hintless. When the hint is what downgrades a call to non-send: gate allows (no grant) → dispatch says approve-unknown → demands a grant → `unknown_grant` → refusal. Unrecoverable: nothing in the loop can mint a grant, so retry always fails. Coordinate clicks escaped because different args → hintless classification no longer send-class.

`adapter.js`'s own comment asserted both sides were "hintless and identical by construction". False; that assumption is what broke.

Not caused by the concurrent WebMCP session: `git diff` shows the `computer` pre-dispatch call is an unchanged line; that session only adds `webmcp_call_tool` to the same guard.

## Changes

| file | change |
|---|---|
| `host/agent/tools/adapter.js` | new `legacyToolNameFromSdkName()` (inverse of `sdkQualifiedToolNames()`; strips `mcp__<server>__` only when the suffix is a tool this adapter registers). `verifyPreDispatchApproval()` consults the gate's recorded verdict before re-classifying; stale comment corrected. |
| `host/agent/policy/can-use-tool.js` | normalizes the SDK name to legacy before classification; records its `allow` verdict for the call's fingerprint. |
| `host/agent/session/run.js` | `recordGateVerdict()` / `consumeGateVerdict()` — single-use, mirroring grant semantics. |
| `host/agent/tools/query-options.js` | inline `lastIndexOf("__")` strip replaced by the shared helper (DRY). |
| `test/approval-gate.test.mjs` | 5 regression cases (below). |

Invariant preserved: no recorded verdict AND no grant still means "never passed the gate" → send-class call refused. Fall-through classification unchanged.

## Verification

- `test/approval-gate.test.mjs` — 21/21 (was 16 cases, +5).
  New: qualified name reaches the gate; a foreign MCP server's identically-suffixed tool is NOT pulled onto this gate; a hint-allowed call dispatches instead of failing stale; a handler that never passed the gate is still refused; a gate verdict authorizes exactly one dispatch (no replay).
- Non-vacuous: old path demonstrated returning `allow/non-gated-tool` for a submit click (above).
- Pass: `approval-evidence-binding` 35/35, `send-class-classifier` 15/15, `webfetch-url-guard`, `agent-tool-adapter` 6/6, `agent-run-lifecycle` 19/19, `agent-bound-tab-authorized` 5/5, `borrowed-tab-javascript-tool` 6/6.
- `allowedTools` composition byte-identical after the DRY refactor: 28 registry tools → 26 auto-approved, dropping exactly `computer` + `javascript_tool`.
- Panel side already wired (`extension/background.js:591`, `conversation-model.js:328`, `panel-controller.js:755`), so restored prompts render rather than time out.

## Out of scope — reported, not fixed

- `host/test/agent-tool-permission-preapproval.test.mjs` — 2 failures, `expected the known 26-entry registry baseline, got 28`. Caused by the concurrent session's 2 WebMCP page tools in `host/tool-definitions.js`. Their baseline to update.
- **Latent, same class**: `webmcp_call_tool` IS in `allowedTools` (only `computer`/`javascript_tool` are excluded), so it never reaches `canUseTool` — yet `verifyPreDispatchApproval` now guards it. Any send-class WebMCP call will be refused with `stale_approval` and no way to mint a grant. One-line fix in that session's scope: add `webmcp_call_tool` to `ALLOWED_TOOL_EXCLUDE` in `query-options.js`.

## Unresolved questions

1. Restoring the gate means submit/pay/confirm clicks now prompt. Send-class classification has never run in production — real prompt frequency is unmeasured. Worth a live pass before shipping.
2. Approval TTL is `approvals.defaultTtlMs`; an unanswered prompt denies on timeout. Unverified whether the current value suits a user who steps away.
3. No test asserts gate and dispatch agree across the whole arg space — only the cases above. A property test over generated args would close the class, not just these instances.
