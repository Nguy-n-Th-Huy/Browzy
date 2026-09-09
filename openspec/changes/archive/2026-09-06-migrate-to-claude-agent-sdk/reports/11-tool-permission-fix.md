# SDK tool-permission regression — root cause, fix, and remaining approval-path gap

Change: `migrate-to-claude-agent-sdk`. This report documents a live,
user-reproduced regression (the assistant could not read a page or control
the browser at all — every browser tool call was denied), a first fix pass
that was **incomplete and still shipped the bug**, and the corrected,
verified fix.

## The bug, as reported (first occurrence)

A user asked the assistant to read `https://dauthau.asia/`. The browser
surfaced:

```
filter: interactive · tabId: 1300523751
Claude requested permissions to use mcp__open-claude-in-chrome-browser__read_page,
but you haven't granted it yet.
```

Every browser tool call — read, navigate, click, screenshot — failed the same
way, regardless of the requested page or action.

## The bug, still live after the first fix (second occurrence)

After the first fix below shipped, the user restarted Brave entirely and the
companion process was killed and respawned — ruling out stale in-memory code
— and still hit:

```
tabId: 1300523751
Claude requested permissions to use mcp__open-claude-in-chrome-browser__get_page_text,
but you haven't granted it yet.
```

Same failure mode, different tool name, on a cold process. The `query()`
options themselves were still wrong.

## Root cause, part 1 (fixed by the first pass): tools were not even *available*

`host/agent/tools/query-options.js`'s `buildIsolatedOptions()` originally set:

```js
tools: ["Skill"],
```

Per `host/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` (`Options.
tools`, line ~1505 in the current file — the field was cited around line 1449
in this report's first draft because a second, differently-shaped `tools`
field exists on the unrelated `AgentDefinition` type at line ~46; both carry
the identical "specify the base set of available built-in tools" docstring,
but `AgentDefinition.tools` governs subagent definitions, not the top-level
`query()` `Options` this file actually builds):

> "Specify the base set of available built-in tools. - `string[]` - Array of
> specific tool names (e.g., `['Bash', 'Read', 'Edit']`) - `[]` (empty array)
> - Disable all built-in tools - `{ type: 'preset'; preset: 'claude_code' }` -
> Use all default Claude Code tools"

`tools: ["Skill"]` is a base-set allowlist containing exactly one entry.
Every browser MCP tool this project's own in-process SDK server exposes
(registered by `host/agent/tools/adapter.js`'s `buildSdkTools()` under
fully-qualified names `mcp__${SDK_MCP_SERVER_NAME}__${toolName}`, where
`SDK_MCP_SERVER_NAME = "open-claude-in-chrome-browser"`, `adapter.js:30`) was
outside that allowlist — not even *available* to the model, let alone
approved.

The first pass's fix: `buildIsolatedOptions()` was changed to build
`tools: ["Skill", ...qualifiedBrowserToolNames]`, where
`qualifiedBrowserToolNames = sdkQualifiedToolNames(serverName,
browserToolNames)` (`host/agent/tools/adapter.js`), making every registered
browser tool available.

## Root cause, part 2 (the gap the first pass missed): available is not the same as auto-approved

This is the actual defect that shipped the still-live regression. `sdk.d.ts`
defines **two distinct options** on `Options` (both confirmed by reading the
docstrings verbatim in the pinned SDK's `.d.ts` in this working tree):

- **`Options.tools?: string[]`** (line ~1505): "Specify the base set of
  available built-in tools... Array of specific tool names." This governs
  **availability** — whether the model can even see/call the tool at all.
- **`Options.allowedTools?: string[]`** (lines 1443-1449, docstring
  immediately above the field): "List of tool names that are **auto-allowed
  without prompting for permission**. These tools will execute automatically
  without asking the user for approval. **To restrict which tools are
  available, use the `tools` option instead.** Note: passing `'Skill'` here
  is deprecated — use the `skills` option instead." This governs
  **auto-approval** — whether a call to an available tool still triggers the
  SDK's interactive permission-prompt path.

These are orthogonal axes. The first fix pass added every qualified browser
tool name to `tools` only. That made every browser tool *available*, but
left every one of them *absent from `allowedTools`*. With no `canUseTool`
callback and no `permissionMode` set (both confirmed unset by reading
`query-options.js`, `adapter.js`, and `companion.js` end to end), an
available-but-not-auto-approved tool call falls through to the SDK's default
permission path (`Options.permissionMode`, line ~2317: `'default'` —
"Standard behavior, prompts for dangerous operations"). In this headless
companion process there is no terminal and no `canUseTool` handler to answer
that prompt, so the SDK treats the unanswered prompt as a denial. This
matches the reproduced failure exactly — a permission request that "you
haven't granted... yet" for a tool that was, in fact, already *available*.

This report's own first draft additionally misread the relationship between
`allowedTools` and `Skill`. Its `query-options.js` comment claimed
`sdk.d.ts:2087`'s note ("you do not need to add `'Skill'` to `allowedTools`
yourself when using [the `skills`] option") meant `allowedTools` itself was
"the deprecated `allowedTools` field." That is wrong, and has been corrected
in `query-options.js`'s comments as part of this fix. What is actually
deprecated, per `allowedTools`'s own docstring (`sdk.d.ts:1447`), is passing
the literal string `'Skill'` through `allowedTools` — `allowedTools` itself
is the current, correct, non-deprecated mechanism for auto-approving named
tools (including this project's qualified MCP tool names), and is exactly
what this fix now uses.

## The fix

`design.md`'s SDK-integration decision ("SDK-managed browser tools with no
mandatory user MCP setup") states directly:

> "Validate run state, arguments, browser lease, and tab scope inside each
> tool handler, even when SDK permission checks preapprove the tool."

The intended architecture is: browser tools are **preapproved at the SDK
layer** (so the product's own "no mandatory user MCP setup / no manual
permission grant" promise holds), and the actual authorization boundary is
the handler-side validation `host/agent/tools/adapter.js`'s
`authorizeToolCall()` (`host/agent/policy/authorization.js`) and
`enforceBorrowedTabScope()` (`host/agent/tools/mapping.js`) already implement
and test — unconditionally, on every dispatched call, regardless of what the
SDK already decided.

`host/agent/tools/query-options.js`'s `buildIsolatedOptions()` now sets
**both**:

```js
tools: ["Skill", ...qualifiedBrowserToolNames],
allowedTools: [...qualifiedBrowserToolNames],
```

`qualifiedBrowserToolNames` is computed exactly once
(`sdkQualifiedToolNames(serverName, browserToolNames)`, unchanged from the
first pass) and reused for both arrays, so availability and auto-approval
can never drift apart from each other or from `host/tool-definitions.js`'s
26-entry `TOOLS` registry — `sdkQualifiedToolNames()` and `adapterToolNames()`
(both in `host/agent/tools/adapter.js`, untouched by this fix — they were
already correct and are reused, not duplicated) derive from that same
`TOOLS` array. `"Skill"` is added to `tools` (as before) but **deliberately
never** to `allowedTools`, per `allowedTools`'s own deprecation note for that
specific usage — the `skills` option (already wired by task 7.2) already
makes a separate `allowedTools` entry for `Skill` unnecessary.

Everything else is byte-for-byte unchanged: `disallowedTools:
[...HIGH_RISK_BUILTINS]` (`Bash`, `Write`, `Edit`, `Task`, `WebFetch`,
`WebSearch`, `NotebookEdit`), `settingSources: []`, `strictMcpConfig: true`,
`env` still replaces rather than merges with `process.env`, and exactly one
`mcpServers` entry (the application-owned browser server, keyed by
`serverName`). `host/agent/tools/adapter.js` needed no code changes — its
existing `sdkQualifiedToolNames()`/`adapterToolNames()` helpers already
derive from the live registry and are simply called a second time (for
`allowedTools`) from `query-options.js`.

## SDK option citations (`sdk.d.ts`, this repo's pinned `@anthropic-ai/claude-agent-sdk@0.3.263`)

- `Options.tools` (~line 1505): "Specify the base set of available built-in
  tools... `string[]` - Array of specific tool names... `[]` (empty array) -
  Disable all built-in tools... `{ type: 'preset'; preset: 'claude_code' }` -
  Use all default Claude Code tools." Governs **availability** only.
- `Options.allowedTools` (~lines 1443-1449): "List of tool names that are
  auto-allowed without prompting for permission. These tools will execute
  automatically without asking the user for approval. To restrict which
  tools are available, use the `tools` option instead. Note: passing
  `'Skill'` here is deprecated — use the `skills` option instead." Governs
  **auto-approval**; this is the field the first fix pass never set, and
  setting it (for the 26 browser tools, excluding `'Skill'`) is the entire
  substance of this fix.
- `Options.disallowedTools` (~line 1469): "List of tool names that are
  disallowed. These tools will be removed from the model's context and
  cannot be used, even if they would otherwise be allowed." Unchanged; still
  holds `HIGH_RISK_BUILTINS`, checked against both `tools` and `allowedTools`
  by the extended test suite.
- `Options.canUseTool` / `CanUseTool` type (~line 209): "Permission callback
  function for controlling tool usage. Called before each tool execution to
  determine if it should be allowed." Not set. With `allowedTools` now
  covering every intended auto-approval, there is nothing left for a
  `canUseTool` callback to decide for the 26 browser tools; it remains absent
  because a half-wired one (see "What remains" below) would fake or hang
  every mutation-authorization decision it touched.
- `Options.permissionMode` (~line 2317): `'default' | 'acceptEdits' |
  'bypassPermissions' | 'plan' | 'dontAsk' | 'auto'`. Not set (stays SDK
  default, `'default'` — "Standard behavior, prompts for dangerous
  operations"). Deliberately not changed to `'bypassPermissions'`
  ("Bypass all permission checks (requires allowDangerouslySkipPermissions)")
  or any other blanket mode: any of those would also auto-approve
  `HIGH_RISK_BUILTINS` and anything else not explicitly disallowed, which is
  far broader than the 26 named browser tools this fix needs to preapprove,
  and the task's constraints explicitly forbid it.
- `Options.strictMcpConfig` (~line 2134, exact line shifts by SDK build):
  "Only use MCP servers passed via the `mcpServers` option... ignoring all
  other MCP configurations." Unchanged.
- `Options.settingSources` (~line 2085): "Pass `[]` to disable filesystem
  settings (SDK isolation mode)." Unchanged.
- `Options.skills` (~lines 2086-2107): "Skills to enable for the main
  session. This is the single place to turn skills on; you do not need to
  add `'Skill'` to `allowedTools` yourself when using this option... This is
  a context filter, not a sandbox." Unchanged; confirms both that `Skill`'s
  inclusion in `tools` (from task 7.2) was never the problem, and that
  `Skill` must not be separately added to `allowedTools` now that
  `allowedTools` is populated for the first time.

## Handler-side authorization: unchanged, and still the real boundary

`host/agent/tools/adapter.js`'s `buildSdkTools()` already calls
`authorizeToolCall()` then `enforceBorrowedTabScope()` inside every tool's
handler, unconditionally, before any dispatch — this was not touched by
either fix pass. The extended test suite
(`host/test/agent-tool-permission-preapproval.test.mjs`, now 5 tests)
proves, in one file:

1. All 26 registry-backed browser tools plus `"Skill"` are present in the
   SDK's `tools` (availability) allowlist.
2. All 26 registry-backed browser tools are **also** present in
   `allowedTools` (auto-approval) — computed independently from
   `host/tool-definitions.js`'s `TOOLS` export, not by reusing the
   implementation's own derivation, so a future drift is actually caught —
   and `"Skill"` is confirmed present in `tools`/`skills` but **absent** from
   `allowedTools`; `tools` (minus `"Skill"`) and `allowedTools` are asserted
   to name the identical set.
3. `HIGH_RISK_BUILTINS` remain disallowed from **both** `tools` and
   `allowedTools`, and every other isolation guarantee (`settingSources`,
   `strictMcpConfig`, single `mcpServers` entry) is untouched.
4. A deliberately-stale tool list is provably distinguishable from the
   correct default in **both** arrays, so the coverage checks are not
   vacuous.
5. The real registered `read_page` handler still rejects a call against a
   tab outside the run's scope, even though `read_page`'s fully-qualified
   name is present in both `tools` and `allowedTools` — preapproval at the
   SDK layer (of either kind) does not replace handler-side authorization.

## What remains: the interactive user-decision path

Unchanged from the first pass; recorded again here for completeness. The
spec (`specs/browser-assistant-panel/spec.md`, "Scope and permission
controls") requires: "Actions outside the task's existing authorization SHALL
wait for a user decision," with an "Approval response" scenario describing a
permission card bound to that run and invalidated on stop or scope change.
`specs/agent-browser-runtime/spec.md`'s "Confined tool execution and browser
scope" requirement is the one this fix directly satisfies (unknown tools,
invalid arguments, unauthorized scopes rejected before execution) — that part
is fully covered by the unconditional handler-side checks above, independent
of any SDK preapproval.

The **interactive wait-for-a-user-decision** part is not implemented, and
this fix does not add it. Concretely, what exists today:

- `host/agent/policy/approvals.js`'s `ApprovalRegistry` (issue/consume,
  bound to run id + action + target, invalidated on stop via
  `Run.stop()` → `approvals.invalidateForRun()`, or on scope change via
  `invalidateAll()`) is fully implemented and unit-tested.
- `host/agent/tools/mapping.js`'s `authorizeBorrowedTabMutation()` /
  `isBorrowedTabMutationAuthorized()` is the exact, real hook design.md 5b
  calls for ("mutations need authorization from the actual user task") —
  calling it genuinely and permanently lifts the restriction for one
  (run, tabId) pair; nothing fakes this.

What does **not** exist, confirmed again by reading `companion.js` end to
end and grepping for `canUseTool`/`permissionMode`/`permission_decision`/
`approval_decision` across `host/agent/`:

- No wire protocol message for "the SDK needs a permission decision, ask the
  panel, wait for the answer" — `companion.js` has no handler for anything
  like `permission_decision`, and the native-messaging protocol documented in
  `design.md`'s architecture decision ("hello/version, start/resume, stop,
  permission decision, ...") lists this message type but it was never
  implemented here.
- No `canUseTool` callback wired into `buildIsolatedOptions()`/`_runQuery()`
  that would call into `ApprovalRegistry`/`authorizeBorrowedTabMutation()` and
  round-trip to the extension's permission-card UI.
- Consequently, today an unauthorized mutation on a borrowed tab is
  **unconditionally rejected** (`BorrowedTabMutationError`, a hard "no") —
  not paused for an interactive user decision as the spec describes. This is
  a safe, fail-closed behavior (it cannot let an unauthorized mutation
  through), but it is not the approval-card flow the spec and the task's own
  item 4 describe.

Why this fix does not wire it: the panel's permission-card UI lives in
`extension/sidepanel/**`, which is out of this task's ownership and is
actively being edited by a parallel session right now (per this task's own
constraints). A `canUseTool` implementation that has nothing real to await —
no protocol message to send, no extension handler to receive it, no response
path back — would be exactly the kind of half-wiring the task's root-cause
completion rule forbids: it would either fake a decision, silently deny
everything it touches (changing today's behavior without adding the promised
interactivity), or block forever waiting on an answer nobody can send. Doing
that now would also risk colliding with the parallel session's protocol
changes on the same wire.

**Concretely, closing this gap requires** (recorded here, not implemented):

1. A new native-messaging/wire message pair (e.g. `permission_request` /
   `permission_decision`) between `companion.js` and the extension, carrying
   run id, the concrete action/target, and a request id.
2. A `canUseTool` callback passed into `query()`'s options that, for a call
   `enforceBorrowedTabScope()` would otherwise hard-reject, instead issues an
   `ApprovalRegistry` token (`run.issueApproval()`), sends the
   `permission_request`, and resolves its `Promise<PermissionResult>` from
   the matching `permission_decision` reply — falling back to `deny` on
   timeout, run stop, or scope change (all of which already invalidate the
   registry entry).
3. On an "allow" decision, call `authorizeBorrowedTabMutation(run, tabId)`
   (the existing hook) before letting the call proceed, so the unconditional
   handler-side check downstream still passes normally.
4. Extension-side: the panel's existing permission-card UI needs to send
   `permission_decision` for the corresponding request id — this is
   `extension/sidepanel/**` territory.

None of this changes what this fix already delivers: SDK-layer preapproval
(both availability and auto-approval) is correct and complete for the 26
registered browser tools plus `Skill`'s availability, and handler-side
authorization remains the unconditional real boundary regardless of whatever
the SDK layer preapproves.

## Tests

- Extended (not new — the file already existed from the first pass):
  `host/test/agent-tool-permission-preapproval.test.mjs`, now 5 tests, all
  passing:
  1. All 26 `TOOLS` entries plus `Skill` are present in `options.tools`
     (unchanged from the first pass).
  2. **New**: all 26 `TOOLS` entries are present in `options.allowedTools`;
     `"Skill"` is present in `tools`/`skills` but **absent** from
     `allowedTools`; `tools` (minus `"Skill"`) and `allowedTools` name the
     identical set. This is the assertion that would have caught the
     regression this report documents — the first pass's suite asserted
     only on `tools` and never checked `allowedTools` existed at all.
  3. `HIGH_RISK_BUILTINS` remain disallowed **and** never appear in either
     `tools` or `allowedTools` (extended from `tools`-only).
  4. A deliberately-stale tool list is provably distinguishable from the
     correct default in **both** `tools` and `allowedTools` (extended from
     `tools`-only).
  5. The real registered `read_page` handler still rejects an out-of-scope
     tab even though `read_page` is SDK-preapproved in both arrays
     (unchanged from the first pass).
- Unmodified and still passing: `host/test/agent-skills-wiring.test.mjs`
  (its `options.tools` assertions are unaffected by adding `allowedTools`),
  `host/test/agent-tool-adapter.test.mjs`, `host/test/agent-context-channel.test.mjs`.

Full `host/test/*.test.mjs` sweep at completion: **39/39 passing** (all
`.test.mjs` files under `host/test/`, run individually), including
`settings-live.test.mjs` (skipped by default, as designed — requires
`OCIC_RUN_LIVE_PROVIDER_TESTS=1`, not set for this sweep) and the extended
`agent-tool-permission-preapproval.test.mjs` (5/5). `test/**` was not run or
touched, per this task's scope (owned by the parallel extension session).

## Live verification (this fix's central evidence)

The first pass's live check ran a `query()` call and observed `is_error:
false` with no explicit permission-denial event, and concluded the fix was
complete. **That conclusion was wrong** — the tool call that check exercised
(`get_config`, a tool with no browser-facing side effect) evidently did not
trigger the same default-permission-prompt path that `get_page_text`/
`read_page` did in the user's real report, so a superficially clean result
masked the still-broken `allowedTools` gap. This is exactly why this second
attempt is verified against **the same tool and the same failure shape the
user actually hit** (`get_page_text`, `tabId: 1300523751` — the literal tab
id from the user's second report), not a differently-behaved tool chosen for
convenience.

Setup, deliberately safer and more real than the first pass's fully-stubbed
`toolBridge`:

- **Real credential, resolved the required way**: via
  `host/agent/settings/profile.js`'s `snapshotForRun()` (through
  `query-options.js`'s `resolveProfileSnapshot()` — the exact production
  path), using the profile already stored on this machine (`profileId:
  "default"`, `baseUrl: https://node1.viber.vn`, `defaultModelId:
  claude-sonnet-5`, secret backed by `windows-credential-manager`). Never
  read from shell env, never printed, never written to any repo file — the
  check script only ever calls `loadProfile()`/`resolveProfileSnapshot()`
  and logs the non-secret profile id/base URL/model.
- **Real dispatch path, not a stub**: the `ToolBridge` was wired to the
  actual `host/tool-runtime.js` exports (`init`, `callTool`, `shutdown`) —
  the identical wiring `host/agent/companion.js` uses in production — rather
  than a fake `callTool`. To do this safely without touching whatever real
  companion/browser connection might already be live on this machine (this
  bug report describes the user's own real Brave + companion process),
  `OCIC_PIPE` was overridden to a nonexistent scratch pipe name **before**
  `tool-runtime.js` was ever imported, so its real connection attempt can
  only ever fail to find a listener — it never reaches, and never sends
  anything to, the user's actual browser or a live production companion.
- **Real, unmodified `buildIsolatedOptions()` output** — the exact fix under
  test, including the new `allowedTools` field.
- **Real SDK `query()`**, prompted with: "Call the get_page_text tool now
  with tabId=1300523751 and no other arguments, then stop without saying
  anything else, regardless of what the tool returns."

Result:

```
Using stored profile "default" (baseUrl https://node1.viber.vn, model claude-sonnet-5) — credential resolved via snapshotForRun(), never read from env or printed.
tools allowlist size: 27 (expect 27 = 26 browser tools + Skill)
allowedTools allowlist size: 26 (expect 26 = 26 browser tools, no Skill)
get_page_text preapproved in tools: true
get_page_text preapproved in allowedTools: true
tool_use: mcp__open-claude-in-chrome-browser__get_page_text args={"tabId":1300523751}
result subtype: success is_error: false

tool result text: Error: Browser extension is not connected. Make sure a supported Chromium browser is running with the Open Claude in Chrome extension installed and enabled.

SUMMARY: sawToolUse = true  sawPermissionDenial = false
```

Interpretation:

- The model called `mcp__open-claude-in-chrome-browser__get_page_text` with
  the exact `tabId` from the user's own bug report. No permission-denial
  event fired, and the turn's `result` message reports `is_error: false` —
  the SDK let the call through without a prompt, which is the thing under
  test.
- The tool call still produced an error — but it is the **real, unmodified**
  `host/tool-runtime.js` `NO_BRIDGE_ERROR` text ("Browser extension is not
  connected...") that fires when `sendToExtension()`'s real connection
  attempt genuinely finds nothing listening (this environment has no
  attached browser and `OCIC_PIPE` was deliberately pointed at a scratch
  pipe). This is precisely the "browser-not-connected error that still
  proves the permission gate was passed" scenario: the call reached the
  real handler and the real dispatch layer, past both `authorizeToolCall()`
  (the `tabId` was in this run's `tabScope`) and the SDK's permission check,
  and failed only on real infrastructure absence — not on a denied
  permission.
- This is a materially different, and materially stronger, result than the
  first pass's live check: it exercises the exact tool and tab id from the
  live regression, through the real dispatch code path, with `allowedTools`
  populated — and it is the check that would have failed loudly (a
  `permission_denials` entry, `sawPermissionDenial: true`) had this second
  fix pass also been incomplete.

One handler-side authorization check was additionally re-confirmed live in
the same run: the tab id used (`1300523751`) was placed inside this run's
own `tabScope`, so `authorizeToolCall()` allowed it through to real dispatch;
the existing offline test (`agent-tool-permission-preapproval.test.mjs`,
test 5) independently proves the same handler rejects a tab **outside**
scope even though the tool is SDK-preapproved — that assertion was not
re-run live in this same script to avoid a second billed call, since it
requires no SDK round trip to prove (it is a pure function of
`authorizeToolCall()`'s inputs, already exercised directly against the real
registered handler in the offline suite).
