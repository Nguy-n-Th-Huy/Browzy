# SDK integration acceptance gate — evidence report

Change: `migrate-to-claude-agent-sdk`, tasks.md group 1 (tasks 1.1–1.6).

This report records what was actually run, on this machine, on this date.
**Update (later session, same date): a live Anthropic-compatible provider
credential became available and every item that was previously BLOCKED
strictly on missing credentials (1.3's vision half, 1.5's endpoint/model
round trip, 1.6's real-run proof) has now been closed with real, captured
evidence.** See `reports/09-live-gate-evidence.md` for the full consolidated
live-run transcript, the model-by-model capability matrix, the error-taxonomy
verification, and the credential-handling/leak-proof. The sections below are
updated in place; anything still BLOCKED is blocked strictly on the
**browser** (no live Chrome/extension exists in this session), never on
credentials.

**Update (task-reconciliation session, same date): gates 1.4 and 1.6 have
been extended and re-run against the now-complete group 3 (companion/browser
lease/session) and group 7 (skills catalog) infrastructure.** Gate 1.4's two
previously-documented gaps (invalid tab scope / stale-cross-session
capability revocation, and the capability-scoped filesystem allowlist) are
now closed for real against the production modules
(`host/agent/tools/adapter.js`, `host/agent/policy/authorization.js`,
`host/agent/policy/approvals.js`, `host/agent/broker/browser-lease.js`,
`host/agent/session/run.js`, `host/agent/skills/session-workspace.js`) — see
the rewritten gate 1.4 section below. Gate 1.6 now also exercises skill
invocation and companion-side onboarding readiness fully offline against the
real `host/agent/skills/**` catalog/dispatch modules — see the rewritten
gate 1.6 section below; its current-page-analysis/browser-control gap is
unchanged (still genuinely blocked on a live browser). `tasks.md` 1.4 and 1.5
are now ticked by this session; 1.3 and 1.6 remain unticked with refreshed,
precise annotations. See `reports/10-task-reconciliation.md` for the full,
all-groups reconciliation this session performed.

## Environment

| | |
|---|---|
| Date | 2026-09-06 |
| `@anthropic-ai/claude-agent-sdk` | **0.3.263** (exact, pinned — not a caret range) |
| Bundled Claude Code CLI (inside the SDK package) | 2.1.263 |
| Node.js | v24.19.0 |
| npm | 11.17.0 |
| Platform | win32 x64 (Windows 11) |
| `zod` (existing, unchanged) | 3.25.76 (resolved from `host/package.json`'s existing `^3.23.8`) |
| `@modelcontextprotocol/sdk` (existing, unchanged) | 1.29.0 |

Reproduce the full offline gate suite:

```
cd host
npm install
node agent/spike/gate.mjs
```

## Dependency install — a real, documented compatibility finding

`@anthropic-ai/claude-agent-sdk@0.3.263` declares a **peer** dependency on
`zod: ^4.0.0`. This host project already depends on `zod: ^3.23.8` for the
existing 26-tool registry (`host/tool-definitions.js`, via `zod-to-json-schema`
for the stdio MCP server). A plain `npm install` therefore fails with
`ERESOLVE`:

```
npm error Found: zod@3.25.76
npm error   zod@"^3.23.8" from the root project
npm error Could not resolve dependency:
npm error   peer zod@"^4.0.0" from @anthropic-ai/claude-agent-sdk@0.3.263
```

Two mitigations were evaluated and are recorded here because either is a real
decision, not a formality:

1. **Bump the shared `zod` dependency to v4.** Rejected: `zod-to-json-schema@3.24.0`
   (used by the existing stdio MCP server, `host/mcp-server.js`) reads zod v3's
   internal `_def.typeName` structure, which zod v4 does not have in the same
   shape. Bumping the shared dependency risks silently breaking the existing,
   already-shipped tool schema generation — exactly the "product default
   unchanged" constraint this task must not violate. Not attempted against
   product code.
2. **`npm install --legacy-peer-deps`.** Adopted. `host/package.json` was
   changed only by adding one dependency line
   (`"@anthropic-ai/claude-agent-sdk": "0.3.263"`, exact version, no caret);
   no other dependency in `host/package.json` was touched. `npm install`
   (without any flag) still fails the same ERESOLVE check on a clean clone
   with today's `package.json` — **the exact command to reproduce this
   install is `npm install --legacy-peer-deps` in `host/`.** This is recorded
   as a real, load-bearing fact for whoever runs setup, not smoothed over.

**Empirically verified this is safe** (not just assumed): the SDK's own type
declarations (`node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`) import
from both `zod/v3` and `zod/v4` and state directly on `SdkMcpToolDefinition`:
*"Supports both Zod 3 and Zod 4 schemas."* The installed `zod@3.25.76` (a
zod-v3-line release ≥3.24) implements the Standard Schema interface
(`schema['~standard'].validate`), which is what the SDK's runtime dispatch
actually calls — confirmed by reading `node_modules/zod/index.js` and by
gate 1.2 below, which builds real SDK tools from the project's existing zod v3
`paramShape`s and calls them successfully through the real
`@modelcontextprotocol/sdk` `McpServer` dispatch path the SDK wraps.

**Root-cause note for a future session:** if the SDK ever requires a runtime
zod v4 API (not just typings), the correct fix is still not "bump the shared
zod" — it is scoping a private zod v4 for the SDK's own subtree (e.g. via a
package manager feature that nests a second `zod` install under
`node_modules/@anthropic-ai/claude-agent-sdk/node_modules/`) so
`tool-definitions.js`'s zod v3 usage is never disturbed. This was investigated
(`npm overrides` with an aliased `npm:zod@^4` target) and did not succeed with
this npm version (11.17.0) — the override changed the peer *requirement* npm
checked against, not the resolution, so the ERESOLVE persisted. `--legacy-peer-deps`
was verified sufficient for everything this gate needed and is the documented
path; no further action was necessary this session.

## What the spike is

- `host/agent/spike/lib/adapter.mjs` — wraps the **existing**
  `host/tool-runtime.js` + `host/tool-definitions.js` (unmodified) as official
  SDK custom tools via `tool()`, and assembles them with `createSdkMcpServer()`.
  It contains zero new browser-automation logic; it is a name/schema/handler
  passthrough, mirroring `host/mcp-server.js`'s own registration loop exactly.
- `host/agent/spike/lib/query-options.mjs` — builds the isolated `query()`
  `Options` object (env replacement, `strictMcpConfig`, `settingSources: []`,
  `tools: []`, `disallowedTools`).
- `host/agent/spike/lib/fixture.mjs` — generates a randomized local HTML
  fixture (random token/shape/color) per run for the vision gate.
- `host/agent/spike/lib/fake-extension.mjs` — a stand-in for the Chrome side
  of native messaging, spawning the **real** `host/native-host.js` on a
  scratch pipe and speaking its exact wire framing. This is the same
  technique `host/test/ownership.test.mjs` already uses to test
  `native-host.js` without Chrome; it is not new risk surface.
- `host/agent/spike/gates/gate-1.{2,3,4,5,6}-*.mjs` — one file per gate.
- `host/agent/spike/gate.mjs` — orchestrator; runs every gate in its **own**
  child process (see "A real bug found while building this" below) and
  prints per-gate PASS/FAIL/BLOCKED with captured evidence.

No product file was imported for anything other than reading its existing,
exported behavior: `host/tool-runtime.js`, `host/tool-definitions.js`, and
`host/native-host.js` are used exactly as-is. `host/mcp-server.js` is not
imported by the spike at all.

## A real bug found while building this (worth carrying into group 3)

Node's ESM loader caches a module by resolved file URL for the life of a
process, regardless of which file imports it. `host/tool-runtime.js` reads its
pipe path once, at module-load time, from `endpoint.js`'s `getPipePath()`
(honoring `process.env.OCIC_PIPE`). The first version of `gate.mjs` dynamically
imported every gate module into one long-lived process; gate 1.5's reconnect
test then silently got gate 1.2's **already-initialized, already-connected**
`tool-runtime.js` module instance — still bound to gate 1.2's dead scratch pipe
— instead of its own. It hung. The fix (now in `gate.mjs`) runs every gate in
its own child process. **This is a real, load-bearing finding for group 3**
(task 3.2, "companion supervision"): any code that reads `OCIC_PIPE` or similar
env-derived config at module load time must not be assumed reconfigurable by
setting the env var later in the same process — this exact case burned real
time in this session and would burn more in the companion.

A second, smaller safety finding from the same debugging: a naive `import`
(static, top of file) of `tool-runtime.js` **before** `process.env.OCIC_PIPE`
is set does not isolate anything, because ESM static imports are hoisted and
the whole dependency graph evaluates before the importing module's own
top-level statements run. An early smoke test in this session accidentally
connected to **this machine's real, currently-running native-host.js bridge**
(a live Chrome/extension session was apparently up) and got a real, harmless,
read-only response (`"No MCP tab group exists."`) back — no mutation occurred,
but it is a sharp edge worth documenting: every isolated gate here sets
`OCIC_PIPE` and only then does a **dynamic** `await import(...)`, never a
static top-level import, specifically to guarantee no gate can ever reach a
real user bridge.

## Per-gate results

### 1.1 — SDK spike created, versions documented — **DONE**

`host/agent/spike/` created under the approved path. SDK pinned to an exact
version (`0.3.263`, no caret) in `host/package.json`. Node/SDK/CLI versions
captured above and printed by `node host/agent/spike/gate.mjs` on every run.
Product default unchanged (see "Product default unchanged" section below).

### 1.2 — In-process SDK MCP tools, no user MCP setup — **PASS**

Command: `node host/agent/spike/gates/gate-1.2-mcp-tools.mjs`

- Built all 26 tools from `host/tool-definitions.js` as official SDK
  `tool()` definitions and assembled them with `createSdkMcpServer()`.
  Verified the registered tool-name set is byte-identical to the registry —
  nothing added, nothing missing.
- Called `tabs_context_mcp` through the **real** `@modelcontextprotocol/sdk`
  `McpServer` dispatch path (`validateToolInput` → `executeToolHandler`, the
  same methods a live `tools/call` request uses) with no browser attached.
  Got back the real, production `NO_BRIDGE_ERROR` text from
  `host/tool-runtime.js` — proof the call reached the real runtime, not a stub.
- Verified `strictMcpConfig: true` and exactly one `mcpServers` entry (see 1.4).
- Verified no reference to `.claude.json`, `claude mcp add`, or a proprietary
  Chrome-integration string anywhere in the adapter or `tool-runtime.js`
  source.

Captured output (real run):
```
tool-runtime.init() joined scratch pipe \\.\pipe\ocic-spike-1.2-10032 (unreachable — proves isolation from any real browser bridge)
createSdkMcpServer() -> { type: "sdk", name: "open-claude-in-chrome-browser" }
registered SDK tools: 26, registry (host/tool-definitions.js): 26
PASS: every tool in host/tool-definitions.js is registered on the SDK server, and nothing extra was added
tabs_context_mcp() through the SDK tool path -> "Error: Browser extension is not connected. Make sure a supported Chromium browser is running with the Open Claude in Chrome extension installed and enabled."
PASS: the SDK tool call reached the real host/tool-runtime.js (verified against its NO_BRIDGE_ERROR text), not a stub
PASS: no reference to .claude.json, claude mcp add, chrome-integration, claude_chrome in the adapter or host/tool-runtime.js source
```

### 1.3 — DOM/nav/form/click + screenshot recognition of a randomized fixture — **PASS (live credential; browser half still harnessed)**

Command: `node host/agent/spike/gates/gate-1.3-vision.mjs --live` (or via
`node host/agent/spike/gate.mjs --live`), with a profile+credential already
configured through `host/agent/settings/profile.js`.

The offline half is unchanged: `host/agent/spike/lib/fixture.mjs` generates a
fresh local HTML page per run with a random hex token/shape/color, and the
full `navigate → read_page → find → form_input → computer(screenshot)` chain
is proven wired to the real `tool-runtime.js` (each call returns the real "not
connected" error with nothing attached).

**What changed with a live credential:** the gate now has a real `--live`
implementation (it previously `throw`ed). State precisely which half is
which, per the task's instruction not to overclaim:

- **HARNESSED** (still no live Chrome in this session): navigate, read_page,
  find, form_input, and the `computer(screenshot)` call itself all dispatch
  through the **real** `host/native-host.js` + `host/tool-runtime.js`, but a
  fake-extension stand-in (`lib/fake-extension.mjs`, the same technique gate
  1.5 and `host/test/ownership.test.mjs` already use) supplies every
  response — including the screenshot image, which is a hand-rolled PNG
  (`host/agent/spike/lib/tiny-png.mjs`, a new ~90-line dependency-free encoder
  using only Node's built-in `zlib`; no image library exists in this project).
- **LIVE**: a freshly randomized shape+color image (never checked into the
  repo, regenerated every run) is sent to the real configured provider via
  `query()`, which must identify it — something it cannot have memorized or
  guessed. The recognized answer then drives a real dependent `form_input`
  call through the same harnessed dispatch chain, and the harness is asserted
  to have observed exactly that value.

Captured real run (redacted of any credential):
```
Generated a randomized live-vision fixture image (never checked into the repo): shape=circle color=orange (64x64 PNG, 250 bytes)
Harnessed browser half connected (fake-extension stand-in for the browser, real host/native-host.js + host/tool-runtime.js dispatch) after 1 poll(s)
[harnessed] navigate -> [harnessed] navigated to file:///live-vision-fixture.html
[harnessed] read_page -> [harnessed] synthetic page: a colored shape fixture and a one-field form.
[harnessed] find -> [{"ref":"ref_1","role":"textbox","name":"answer"}]
[harnessed] computer(screenshot) -> real image content block returned through the real tool-runtime.js dispatch path (image itself synthesized by the fake extension, not a live Chromium render)
LIVE vision call replied: "circle orange" (ground truth, never sent to the model: "circle orange")
PASS (LIVE): the real configured provider correctly identified a freshly randomized shape+color image it could not have memorized or guessed
[harnessed] form_input(recognized value) -> [harnessed] form_input accepted: circle orange
PASS (harnessed dependent action): the LIVE vision answer was used to drive a real form_input call through the real tool-runtime.js/native-host.js dispatch chain, and the harness observed exactly that value
```

A second independent run (different random image) also matched exactly
(`square yellow`) — see `reports/09-live-gate-evidence.md` for both full
transcripts. **Remaining, genuinely BLOCKED gap:** a live Chrome/extension —
the DOM/navigate/form-fill/click half is real code, harnessed responses; that
part of task 1.3 stays open pending group 3/5/7's live browser infrastructure.

### 1.4 — Rejected shell injection / unknown tools / malformed args; isolation — **PASS (fully closed)**

Command: `node host/agent/spike/gates/gate-1.4-isolation.mjs`

Demonstrated for real, against the actual `query()` options object and the
actual installed `@modelcontextprotocol/sdk` dispatch code:

- `options.env` contains **only** `PATH`, `SystemRoot`, `ANTHROPIC_BASE_URL`,
  `ANTHROPIC_API_KEY` — verified against this machine's actual `process.env`
  (124 other ambient variables present and confirmed **not** to leak through).
- `settingSources === []`, `strictMcpConfig === true`, exactly one
  `mcpServers` entry, `tools === []` (all SDK built-ins — Bash, Write, Edit,
  Read, Glob, Grep, WebFetch, Task/subagents — disabled), plus
  `disallowedTools` repeating the highest-risk names as defense in depth.
- **No shell execution possible by construction**: read the real
  `host/tool-runtime.js` source and confirmed zero occurrences of
  `child_process`, `exec(`, `execSync(`, or `spawn(` anywhere in the tool
  dispatch path — its only contract to the extension is one JSON line over a
  socket. A shell-metacharacter payload (`"1; $(rm -rf / --no-preserve-root) #"`)
  passed as a `javascript_tool` argument was forwarded as inert JSON data
  (real "not connected" result) — never interpreted.
- An unknown tool name has no registered handler; a malformed/missing-argument
  call to `navigate({})` was rejected before dispatch by the real zod schema
  validation (`MCP error -32602: Input validation error...`).

**Update (task-reconciliation session): the two previously-open sub-items are
now closed for real**, against the group-3/7 infrastructure that did not
exist when this gate was first written. The gate was extended to build a
real `host/agent/session/run.js` `Run`, a real
`host/agent/broker/browser-lease.js` `BrowserLease`, a real
`host/agent/policy/approvals.js` `ApprovalRegistry`, and to register tools
through the REAL production `host/agent/tools/adapter.js`
`buildSdkTools()`/`createBrowserMcpServer()` — the exact code group 3's
session builder uses — dispatching through the real
`@modelcontextprotocol/sdk` `validateToolInput`/`executeToolHandler` path.
Only the final "call a live browser" hop is stood in for by a call-counting
fake `host/agent/broker/tool-bridge.js` `ToolBridge` (there is still no live
browser in this session), which is exactly the right place to stand in:
everything asserted below is the authorization/scope logic that runs
*before* that hop, and the fake makes "the tool bridge was never dispatched
to" a positive, checkable assertion rather than an absence of a thrown error.

1. **Invalid tab scope, even when SDK/zod validation already accepted the
   call as well-formed**: `navigate({tabId: 999})` against a run whose
   `tabScope` is `[100]` is rejected (`tab_out_of_scope`) by the real
   handler-side `authorizeToolCall()` (`host/agent/policy/authorization.js`)
   — zero dispatches reach the tool bridge. The identical call shape with
   `tabId: 100` (in scope) is authorized and dispatches exactly once,
   proving the rejection was scope-specific, not a blanket failure.
2. **Stale / cross-session capability rejected**: an approval token issued
   to run A (`ApprovalRegistry.issue`) is rejected `run_mismatch` when a
   different, independent run B attempts to consume it. Stopping run A
   invalidates every approval it issued (`invalidateForRun`), so even run
   A's own token is then rejected `unknown_token` — a capability from a
   finished run does not linger. At the browser-lease level: once run A
   stops and a fresh run C acquires the now-freed lease, run A — superseded
   — is rejected `run_not_active` for a further dispatch attempt using the
   *exact same* well-formed, in-scope call that succeeded before it was
   stopped, with zero additional dispatch reaching the tool bridge.
3. **Capability-scoped filesystem allowlist**: `file_upload` for a real,
   existing filesystem path never added to a run's own
   `RunUploadAllowlist` is rejected (`path_not_allowlisted`), zero
   dispatches. The identical call for the same path, after the run's own
   allowlist explicitly authorized it (simulating a user's own file-picker
   selection — the only thing that can ever populate this allowlist), is
   authorized and dispatches exactly once. A single call mixing one
   allowlisted and one non-allowlisted path is rejected *in full* — no
   partial dispatch of only the approved path. For **enabled-skill
   resources**, the real `assertCanonicalSkillResourcePath()`
   (`host/agent/skills/session-workspace.js`) allows a resource inside an
   enabled skill's own materialized session snapshot, rejects a path
   traversal outside that snapshot, and rejects a resource under a skill
   folder that exists on disk but was never part of *this session's own*
   approved `allowedSkillNames` — the allowlist is scoped per-session, not
   by mere on-disk presence. **"Approved artifacts" has no separate
   model-facing surface to test**: grep-verified against
   `host/tool-definitions.js` that no registry tool accepts an arbitrary
   artifact path from the model at all — every artifact path is
   host-constructed and id-validated (`host/agent/storage/paths.js`'s
   `assertSafeId()`), never model-supplied, so there is nothing beyond
   that id-safety check to additionally exercise here. Recorded rather than
   silently claimed as "tested."

Because every sub-item the task text asks for is now demonstrated for real,
**task 1.4 is ticked** in tasks.md. Its narrower parenthetical verify clause
("no arbitrary command runs and no secret or unapproved file reaches model
output") remains satisfied as before.

### 1.5 — Cancellation, reconnect, bounded errors, live round trip — **PASS (fully closed)**

Command: `node host/agent/spike/gates/gate-1.5-cancel-reconnect.mjs --live`
(profile+credential already configured via `host/agent/settings/profile.js`).

**Root-cause fix applied before running live:** the gate's original `--live`
branch would have read `ANTHROPIC_BASE_URL`/`ANTHROPIC_API_KEY` directly from
`process.env` (see the "Command to close" line this replaced) — bypassing the
actual production credential path entirely. That was corrected: the live
round trip now resolves the endpoint/model/credential exclusively through
`host/agent/settings/profile.js`'s `loadProfile()` + `snapshotForRun()` (OS
credential store → isolated per-run `env`), the same contract task group 3's
session orchestration will use, and the gate now also asserts the parent
process itself carries no ambient `ANTHROPIC_API_KEY`/`ANTHROPIC_BASE_URL`/
`ANTHROPIC_AUTH_TOKEN` before trusting the result — proving the isolation
claim empirically, not just by construction.

Reconnect/bounded-error sub-gates ran the **real** `host/native-host.js` and
**real** `host/tool-runtime.js` against a scratch pipe with a fake-extension
stand-in (same technique as `host/test/ownership.test.mjs`):

1. No extension attached → real `NO_BRIDGE_ERROR`.
2. A stand-in extension attaches → a tool call round-trips end to end through
   the real host + runtime.
3. **Disconnect mid-flight**: a request reaches the fake extension, which is
   killed before replying → `tool-runtime.js` reports the real
   `HOST_DROPPED_ERROR` ("result is unknown... do not blindly retry"), never
   silently retried.
4. **Reconnect**: a fresh stand-in extension attaches on the same pipe → calls
   succeed again with no manual restart of `tool-runtime.js`.

Cancellation: spawned the **real, bundled Claude Code CLI binary**
(`@anthropic-ai/claude-agent-sdk-win32-x64`, 209 MB) via
`query({ options: { abortController } })`, pointed at `http://127.0.0.1:1`
(refuses connections instantly — no live endpoint was ever reachable), and
called `controller.abort()` after 300ms. The generator threw
`Error: Operation aborted` and `controller.signal.aborted` was `true`.
Measured latency from `abort()` to actual termination: **~7.1 seconds**,
bound by the CLI's own retry/backoff loop before it next checks the abort
signal — real, measured behavior, not an assumption, and worth carrying into
group 3's UX design for Stop (a 7s worst case if abort lands mid-backoff).

The **live Anthropic endpoint/model round trip** sub-item is now closed with
real evidence:
```
Ambient shell env check: clean — no ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN set in this process's own environment
snapshotForRun("default", "claude-sonnet-5") resolved a credential from the OS credential store (secretBackend: windows-credential-manager) — env is isolated (only ANTHROPIC_BASE_URL/ANTHROPIC_API_KEY/PATH/SystemRoot), never merged with process.env
message types observed: system:init, system:thinking_tokens, system:thinking_tokens, system:thinking_tokens, system:thinking_tokens, system:thinking_tokens, assistant, assistant, result:success
PASS: a real round trip through query() succeeded using ONLY the isolated env produced by snapshotForRun() — subtype=success, 1 turn(s), 1780ms
```
This closes task 1.5's remaining sub-item; see `reports/09-live-gate-evidence.md`
for the full run and cost accounting.

### 1.6 — Clean-profile onboarding: no Claude account dependency — **PASS**

Command: `node host/agent/spike/gates/gate-1.6-onboarding.mjs`

Proven **programmatically against the constructed `Options` object**, not by
claim, per the task's explicit instruction:

- `settingSources === []` — the run never reads `~/.claude/settings.json`,
  project, or local settings. Verified this is not vacuous on this particular
  machine: 2 of the 2 files this would otherwise read (`~/.claude/settings.json`,
  `~/.claude.json`) actually exist here, and the constructed options object
  provably does not depend on them.
- Isolated `env` carries only `PATH`, `SystemRoot`, `ANTHROPIC_BASE_URL`,
  `ANTHROPIC_API_KEY` — no key matching `OAUTH`/`SESSION`/`COOKIE` of any kind.
- Both `ANTHROPIC_BASE_URL` and `ANTHROPIC_API_KEY` are present and are the
  **only** provider-identifying fields — `x-api-key` semantics, no
  bearer/OAuth path.
- The full serialized options object contains no reference to `subscription`,
  `oauth`, `claude-account`, `session-cookie`, or `chrome-integration`.

**Update with a live credential:** the same assertions were re-run against a
**real, non-placeholder** resolved credential (via `snapshotForRun()` against
the actual configured profile), confirming the isolation contract holds for
genuine secret material, not just the offline `"sk-ant-spike-placeholder"`
value:
```
PASS (live): snapshotForRun() against the REAL configured profile ("default", model "claude-sonnet-5", endpoint "https://node1.viber.vn") resolved a real credential from the OS credential store (windows-credential-manager) into the same isolated env shape asserted above with the placeholder — no OAuth/session/cookie key, no Claude account/subscription reference
```
The "a real run completes" proof (an actual `query()` round trip using this
exact isolated env, with no ambient `ANTHROPIC_*` in the parent process) is
gate 1.5's `testConfiguredRoundTrip()` result above — cross-referenced here
rather than re-run, to avoid a duplicate billed request for identical
evidence (see `reports/09-live-gate-evidence.md`).

**Update (task-reconciliation session): skill invocation and companion-side
onboarding readiness are now also proven offline**, against the real
`host/agent/skills/**` catalog now that task group 7 has landed it. Using a
scratch `OCIC_AGENT_HOME` (this machine's real skill catalog, if any, is
never touched):

- A genuinely first-run companion (zero skills ever imported) builds an
  empty session skills workspace with no error — empty
  `allowedSkillNames`/`catalogSnapshot`, a real (empty) `skillsDir` on disk —
  proving the "daily browser-only startup, no terminal step" onboarding
  shape holds even before any skill exists.
- A real fixture skill (a genuine `SKILL.md` package, imported and enabled
  through the real `importSkill()`/`enableSkill()`) materializes into a real
  per-session `.claude/skills/` workspace via `buildSessionSkills()`, is
  authorized for explicit slash dispatch by the real
  `assertSlashDispatchAllowed()`, and an unknown command is rejected
  `UNKNOWN_COMMAND` by the same real gate.
- The resulting `allowedSkillNames`/`skillOverrides` compose cleanly into
  the same isolated `query()` options object already proven above
  (`settingSources: []`, isolated env unchanged) — skill invocation's
  application-side logic does not require, and does not reopen, any
  Claude-account/OAuth/subscription dependency.

**Precision, not overclaim** (recorded in the gate's own output, not just
here): this proves the real catalog/session/dispatch logic composes
correctly with the isolated `query()` options *contract*. It does **not**
yet prove that `host/agent/tools/query-options.js` — the actual production
options builder task group 3 built — threads `skillsDir`/
`allowedSkillNames`/`skillOverrides`/the `Skill` tool into a real `query()`
call: as of this session that module's `buildIsolatedOptions()` still
hard-codes `tools: []` and accepts no skills-related parameter at all (its
docstring mentions a `skillsConfig` hook, but no such parameter exists in
the function signature). That remaining wiring is task **7.2**'s open item.

**Still left unticked** in tasks.md for its full scope: the task's text also
requires "current-page analysis [and] browser control" to be verified end to
end, which needs a live browser + companion attached to a real Chromium
instance — genuinely not available in this session (no live Chrome exists
here, independent of credentials; see gate 1.3, which owns the live-browser
DOM/action legs). What's proven here — the auth/isolation contract (now
against a real credential and a real completed run) and skill invocation's
application-side logic — is the part task 1.6's own verify clause ("no
Claude login prompt or hidden dependency on existing account state") asks
for, plus the newly-closable skill-invocation sub-item; the browser-driven
journey is the one remaining, disclosed gap.

## Product default unchanged

- `host/native-host.js`, `host/tool-runtime.js`, `host/tool-definitions.js`,
  `host/endpoint.js`, `host/mcp-server.js`, `host/codemode/common.js`: **not
  modified** (confirmed via `git diff` — zero changes to these files).
- `host/package.json`: one line added
  (`"@anthropic-ai/claude-agent-sdk": "0.3.263"`); no existing dependency
  version changed.
- `host/package-lock.json`: updated by `npm install --legacy-peer-deps` to
  add the new dependency's resolved subtree; no existing package's resolved
  version changed (`git diff --stat`: `+141` lines, `0` removed).
- Existing host tests still pass, run this session, real output:

```
$ node host/test/endpoint.test.mjs
7/7 passed

$ node host/test/parent-watch.test.mjs
3/3 passed

$ node host/test/ownership.test.mjs
12/12 passed
```

**This session's additions** (product files still untouched): the `--live`
branches of `host/agent/spike/gates/gate-1.3-vision.mjs`,
`gate-1.5-cancel-reconnect.mjs`, and `gate-1.6-onboarding.mjs` were
implemented for real (previously they `throw`ed); a new dependency-free PNG
encoder `host/agent/spike/lib/tiny-png.mjs` was added (no npm dependency —
this project has no image library); `host/agent/settings/capability-test.js`
got a documentation/message fix (see `reports/09-live-gate-evidence.md`); and
`host/test/settings-live.test.mjs` is a new, opt-in (env-var-gated) live test
file. Full offline suite re-run after all of the above: 28/28 `host/test/`
files pass with no ambient credentials present (see
`reports/09-live-gate-evidence.md`).

## Summary

| Task | Status | Ticked in tasks.md |
|---|---|---|
| 1.1 | DONE | Yes |
| 1.2 | PASS | Yes |
| 1.3 | PASS — vision half LIVE; DOM/browser-control half HARNESSED, genuinely BLOCKED on a live browser | No — annotated |
| 1.4 | PASS — fully closed (tab scope, stale/cross-session capability, and filesystem allowlist all now demonstrated against real group-3/7 infrastructure) | **Yes** |
| 1.5 | PASS — fully closed, including the live round trip | **Yes** |
| 1.6 | PASS for auth/isolation/real-run scope and (new) skill invocation's application-side logic; current-page-analysis/browser-control BLOCKED on a live browser | No — annotated |

**No gate produced a hard FAIL.** Every item that was previously BLOCKED
strictly on missing live credentials has real, captured evidence (see
`reports/09-live-gate-evidence.md`); every item that was previously BLOCKED
strictly on group-3/7 infrastructure not existing (1.4's two gaps, 1.6's
skill-invocation leg) is now demonstrated for real against that
infrastructure (this session, see the rewritten 1.4/1.6 sections above and
`reports/10-task-reconciliation.md`). The only genuinely remaining gap
across this whole report is a **live browser** (no Chrome + extension
attached in this session) — a different, still-real precondition, tracked
separately, closed by neither a credential nor the group-3/7 work.

This report's task-1.4/1.5 tick and its 1.3/1.6 annotation refresh were made
by this reconciliation session directly (this session owns `tasks.md` for
its duration — see `reports/10-task-reconciliation.md` for the full,
all-groups reconciliation and the exact evidence backing every checkbox).
