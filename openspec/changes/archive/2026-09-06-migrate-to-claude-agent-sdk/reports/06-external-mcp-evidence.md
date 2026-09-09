# Tasks 6.5/6.6 — External MCP as an ongoing supported mode

Scope: `openspec/changes/migrate-to-claude-agent-sdk` tasks 6.5 and 6.6 —
preserve the three external MCP launch modes (default `host/mcp-server.js`,
codemode `host/codemode/server-codemode.js`, hybrid
`host/codemode/server-hybrid.js`) as an ongoing supported mode alongside the
new SDK/side-panel path, and prove it. Explicitly out of scope for the prior
group-6 delegation that closed 6.1-6.4 (`reports/06-preservation-evidence.md`:
"Tasks 6.5/6.6 are explicitly out of this delegation's scope and untouched").

**Environment**: no live browser, no live Anthropic API key, exactly the
constraint stated in the delegation. Every fake extension below is the REAL
`host/native-host.js` on a scratch pipe, driven exactly as Chrome would (the
same technique `host/test/ownership.test.mjs` already uses). Mixed-client
contention is proven against a REAL forked companion process
(`host/agent/companion.js`'s `createRealCompanion()`, via the existing,
unmodified `host/test/agent-companion-child.mjs` harness), not a fake
stand-in. Nothing here is simulated as a pass; the one item that genuinely
needs a live browser (repeated extension reload / browser restart) is marked
BLOCKED with exact reproduction steps, matching this delegation's explicit
instruction to never fake that leg.

## Verdict

**6.5 and 6.6 are DONE for everything testable without a live browser.** The
three launch modes already preserve their contracts by construction (none of
them import, reference, or could reach `host/agent/**`, any provider
credential env var, or the extension's id) — this was true before this
session and remains true; no source-code change to `host/mcp-server.js`,
`host/codemode/server-codemode.js`, `host/codemode/server-hybrid.js`, or
`host/codemode/common.js` was needed or made. This session's job was almost
entirely proof, not modification — see "Files touched" below for the one
genuine finding that DID require a testing-technique fix (not a production
code fix).

One item — repeated keyed-extension reload and browser restart against a
real installed browser — is **BLOCKED**, consistent with
`reports/02-packaging-evidence.md`'s own identical item #5, with exact
reproduction steps below.

## Files touched

Owned and added (all new; nothing pre-existing was edited):
- `host/test/external-mcp-launch-contracts.test.mjs` (new, 13 tests)
- `host/test/external-mcp-companion-resilience.test.mjs` (new, 2 tests)
- `host/test/external-mcp-lease-contention.test.mjs` (new, 2 tests)
- `openspec/changes/migrate-to-claude-agent-sdk/tasks.md` (6.5/6.6 checkboxes only)
- this report

Read for context, **never edited**: `host/mcp-server.js`,
`host/codemode/server-codemode.js`, `host/codemode/server-hybrid.js`,
`host/codemode/common.js`, `host/native-host.js`, `host/tool-runtime.js`,
`host/endpoint.js`, `host/tool-definitions.js`,
`host/agent/broker/native-lease.js`, `host/agent/broker/tool-bridge.js`,
`host/agent/companion.js`, `host/test/ownership.test.mjs`,
`host/test/agent-lease.test.mjs`, `host/test/agent-companion-child.mjs`,
`host/test/endpoint.test.mjs`, `test/handlers.test.mjs`, `install.sh`,
`install.ps1`, proposal.md, design.md, tasks.md, and the group 3/6 evidence
reports cited throughout.

`git diff --stat` confirms zero production files changed by this session —
only the three new test files and this report exist as uncommitted work from
this delegation.

## A genuine testing-technique finding (not a production bug)

While building the codemode/hybrid launch tests, `taskkill /PID <pid> /T /F`
on the top-level spawned MCP server process was tried first and found
**unreliable** for cleaning up the real `wrangler dev` process tree
`host/codemode/common.js`'s `startWorkerd()` spawns unconditionally on
startup (cmd.exe → node `bin/wrangler.js` → node `wrangler-dist/cli.js` →
`workerd.exe`, a chain that finishes materializing over roughly 1-3 real
seconds — well after this suite's own fast MCP-level assertions return, so
`/T`'s process-tree snapshot, taken immediately after, predates most of the
chain even existing yet). Verified by hand: after a first version of these
tests ran, `Get-CimInstance Win32_Process` showed live `cmd.exe`/`node.exe`
(wrangler)/`workerd.exe` processes still running. Cleaned up immediately
(`taskkill /PID <pid> /F` on each), and the test's cleanup logic was fixed to
sweep the ENTIRE system process list for `startWorkerd()`'s own
`--persist-to <tmpdir>/oc-wrangler-<variant>-<PID>` command-line fingerprint
(PID = the test's own spawned top-level server process, so this is a unique,
greppable tag), plus one hop to each matched process's direct children
(catching `workerd.exe`, which doesn't carry the tag itself), repeated twice
with a pause to catch late-spawning members. Re-verified clean by hand after
the fix — see "Process hygiene verification" below. This is a testing
technique fix in a NEW file this session owns; `host/codemode/common.js`
itself was not touched, and this is not claimed as a fix to any production
behavior (a real user's Ctrl+C during codemode/hybrid startup has the same
underlying OS-level characteristic — outside this task's scope to change).

## 6.5 — Launch and protocol contracts preserved, independent of sidepanel/SDK

### Structural proof (no live process needed)

| Property | Test | Result |
|---|---|---|
| `host/mcp-server.js`'s import graph never reaches `host/agent/**` | `external-mcp-launch-contracts.test.mjs` | PASS |
| `host/codemode/server-codemode.js`'s import graph never reaches `host/agent/**` | same | PASS |
| `host/codemode/server-hybrid.js`'s import graph never reaches `host/agent/**` | same | PASS |
| `host/codemode/common.js` (shared by both) never reaches `host/agent/**` | same | PASS |
| None of the three launch files reference `ANTHROPIC_API_KEY`/`ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN`/Claude OAuth state in their own source | same | PASS |
| None of the three launch files (or `host/endpoint.js`) reference the extension's id / `allowed_origins` — external MCP registration is ID-agnostic by construction | same | PASS |

This is the strongest form of "assistant credentials are irrelevant to this
path": the SDK/settings/secrets/companion machinery, and any concept of the
extension's Chrome-assigned id, is not merely unused at runtime by these four
files — it is **unreachable** from their own import graphs and source text,
computed by a recursive relative-import walker (the same class of read-only
source-extraction technique `test/_extract.mjs` already uses elsewhere in
this repo), re-verified live against the real files on every run rather than
hand-asserted once.

### Behavioral proof: each of the three modes starts and serves tools with no provider profile, no stored key, and no companion

Every launch-mode test connects via the REAL `@modelcontextprotocol/sdk`
`Client`/`StdioClientTransport`, whose own `getDefaultEnvironment()` inherits
only a small, fixed, platform-specific allowlist (Windows:
`APPDATA/HOMEDRIVE/HOMEPATH/LOCALAPPDATA/PATH/PROCESSOR_ARCHITECTURE/
SYSTEMDRIVE/SYSTEMROOT/TEMP/USERNAME/USERPROFILE/PROGRAMFILES`) — this test
process's own `ANTHROPIC_*`/`CLAUDE_*` environment, if any existed, would
never even be forwarded to the child. Only `OCIC_PIPE` (pointed at a scratch
bridge) is added on top. No `host/agent/settings/` profile file, no OS
credential store entry, and no companion process was ever created or
consulted for any of these tests:

```
$ node host/test/external-mcp-launch-contracts.test.mjs

External MCP — launch and protocol contract preservation (6.5/6.6)

  PASS  structural: host/mcp-server.js's import graph never reaches host/agent/**
  PASS  structural: host/codemode/server-codemode.js's import graph never reaches host/agent/**
  PASS  structural: host/codemode/server-hybrid.js's import graph never reaches host/agent/**
  PASS  structural: host/codemode/common.js (shared by both) never reaches host/agent/**
  PASS  structural: none of the three launch files reference ANTHROPIC_/CLAUDE_ env vars in their own source
  PASS  structural: none of the three launch files (or the endpoint they share) reference the extension's ID or allowed_origins at all — external MCP registration is ID-agnostic by construction
  PASS  default mode (host/mcp-server.js): starts, lists the full registry, and calls a tool — env limited to the MCP SDK's own minimal allowlist (no ANTHROPIC_*/CLAUDE_* anywhere)
  PASS  default mode: legacy argument coercion is preserved (string tabId/coordinate arrive as real number/array at the extension)
  PASS  default mode: an image content block from the extension survives byte-identical (never collapsed to text)
  PASS  default mode: a tool_error from the extension surfaces as plain text content — the EXISTING shape, not upgraded to isError:true
  PASS  codemode mode (server-codemode.js): starts, exposes execute_code + screenshot + zoom, and a passthrough (screenshot) call reaches the extension — no ANTHROPIC_*/CLAUDE_* env, no companion
  PASS  hybrid mode (server-hybrid.js): starts, exposes all 26 upstream tools + execute_code + recording_ack, and a direct passthrough call reaches the extension — no ANTHROPIC_*/CLAUDE_* env, no companion
  PASS  hybrid mode: an error from the extension on a direct passthrough call is not upgraded to isError:true (unchanged contract)

13/13 passed
```

`host/mcp-server.js` lists all 26 registry tools (byte count re-verified live
against `host/tool-definitions.js`, matching `reports/06-registry-baseline.md`'s
already-committed baseline — not re-derived here). `server-codemode.js`
exposes `execute_code`/`screenshot`/`zoom`. `server-hybrid.js` exposes all 26
upstream tools plus `execute_code` and `recording_ack` — 28 tools total,
matching `test-hybrid.js`'s own long-standing expectation.

### SDK/companion failure does not degrade external MCP operation

`host/native-host.js` (read-only for this task) forks a real companion child
automatically on ordinary bridge startup. This suite kills that REAL forked
companion process (found by walking the OS process tree via
`ParentProcessId`, matching on `companion.js` in the command line — no fake
stand-in) out from under a connected legacy MCP client, and proves the
client's traffic is never interrupted, both immediately after the crash and
after native-host.js's own scheduled restart, and even after the companion
crash-loops past its restart budget and native-host.js permanently gives up
on it:

```
$ node host/test/external-mcp-companion-resilience.test.mjs

External MCP — SDK/companion failure does not degrade the shared host (6.5/6.6)

  PASS  a legacy client's traffic is completely unaffected by the real companion's death (native-host.js keeps serving)
  PASS  the legacy client keeps working even after the companion crash-loops past its restart budget and native-host.js gives up on it

2/2 passed
```

(This suite's companion-pid discovery uses a Windows-specific
`Get-CimInstance Win32_Process` query, matching this session's actual
platform; it prints a clean `SKIPPED (non-Windows)` with a pointer to
`agent-lease.test.mjs`'s portable equivalent rather than failing on a
non-Windows runner.)

## 6.6 — Regression coverage

### Mixed-client contention with a REAL companion (not a fake SDK-shaped client)

`host/test/agent-lease.test.mjs` (task-group-3-owned, unmodified) already
proves SDK-vs-legacy exclusivity end to end against a fake SDK-shaped raw
socket client. This session's addition drives the same property through the
REAL `host/agent/companion.js` `CompanionCore`'s REAL `ToolBridge` (via the
existing, unmodified `host/test/agent-companion-child.mjs` harness —
already used by `host/test/agent-pipe-isolation.test.mjs`), which is what
actually attaches run/conversation/tabScope metadata in production:

```
$ node host/test/external-mcp-lease-contention.test.mjs

External MCP — mixed-client contention with a REAL companion (6.5/6.6)

  PASS  a REAL companion's run excludes a concurrent legacy client (busy, retryable, NEVER dispatched), release lets it through, and legacy-vs-SDK dispatch is never interleaved
  PASS  a second REAL SDK run is excluded exactly like a legacy client would be — exclusivity is not legacy-specific

2/2 passed
```

**"Control never crosses client scope"** is proven at its strongest possible
level: the excluded party is asserted to have **zero** dispatch entries in
the fake extension's own received-call log while the lease is held (not
merely "got an error back") — so it cannot act on any tab, the SDK run's or
anyone else's, regardless of what `tabScope` either side declares. This is
checked explicitly by counting the extension's `received` array before and
after the busy rejection and asserting it is unchanged. Per-tab scope
enforcement for calls that DO get dispatched (the
`extension/background.js` borrowed-tab-scope logic from design section 5b)
is a separate, already-covered concern — see
`test/registry-borrowed-tab-scope.test.mjs` (task group 6.1, unowned here,
unmodified, still passing) — not duplicated in this suite.

### Legacy argument coercion, image results, error shapes — unchanged

Covered above under 6.5's behavioral proof (the same tests satisfy both
tasks' overlapping requirement): string `tabId`/`coordinate` are coerced to
real number/array types before reaching the extension exactly as
`host/mcp-server.js`'s `coerceArgs` wrapping has always done; an image
content block survives byte-identical through `host/mcp-server.js`,
`server-codemode.js`'s `screenshot` passthrough, and `server-hybrid.js`'s
generic passthrough; a `tool_error` from the extension surfaces as **plain
text content with no `isError:true`** — this is `host/tool-runtime.js`'s
existing `callTool()` catch-branch shape (`textResult(`Error: ${err.message}`)`,
no `isError` field), explicitly asserted as NOT upgraded, since "improving"
it would be a behavior change to a frozen contract, not preservation. Diffed
conceptually against `test/fixtures/registry-baseline.json` by relying on
the already-passing, unmodified `test/registry-baseline.test.mjs` for the
tool/schema shape itself (not re-derived here); this suite adds the
transport-level proof that the SAME shapes survive through each of the three
launch modes' own MCP protocol surface specifically, which the baseline
suite (correctly) does not test since it has no SDK adapter or external MCP
process dependency.

### Event behavior (recording_complete channel notification)

Not re-tested end-to-end through a live MCP channel notification in this
session — already covered at the level that matters for this task
(`onRecordingEvent()`/`server-hybrid.js`'s channel bridge is unmodified
source, and `host/test/recorder-companion-routing.test.mjs`, task-group-6.3-
owned and unmodified, already exercises the underlying event delivery
end-to-end including through a real `native-host.js`). Re-run as part of
this session's full regression sweep below and still passes.

### Repeated keyed-extension reload and browser restart — BLOCKED

Consistent with `reports/02-packaging-evidence.md`'s own item #5
("Extension reload / browser restart against a real browser profile —
BLOCKED: requires a real browser install"), which this task does not
duplicate. What IS new and closed here is the external-MCP-specific half of
"no repeated ID registration is needed": an external MCP client's own
registration (`claude mcp add ... -- node host/mcp-server.js`, or
codemode/hybrid's identical stdio launch command) is a **fixed absolute
command line on disk** — proven above to reference neither the extension's
id nor `allowed_origins` anywhere in its own source — so nothing about that
registration could ever need to change across a reload/restart in the first
place, independent of whatever the extension's Chrome-assigned id does. The
keyed manifest (group 2's work, `extension/manifest.json`'s persistent
public key) makes that id permanent
(`ihljfjgoakmoemkdondoaadegpmibimh`, independently verified via `openssl`
outside this codebase's own crypto code — see `host/test/identity.test.mjs`'s
header and `reports/02-packaging-evidence.md`), and native-host.js's
`allowed_origins` registration is a one-time OS-level artifact (installed by
`install.sh`/`install.ps1`, group 2's ownership, unmodified here) keyed to
that same permanent id.

**What remains genuinely BLOCKED** (requires a real installed browser, not
available in this session): observing an ACTUAL Chrome/Edge/Brave process
reload the extension and restart, and confirming (a) the extension's
`chrome.runtime.id` is unchanged both times, and (b) an already-configured
external MCP client (Claude Code with `claude mcp add`, or a running
codemode/hybrid session) reconnects and keeps working without any
re-registration step. Exact reproduction:

1. Install the extension unpacked (`chrome://extensions` → Developer mode →
   Load unpacked → `extension/`) and confirm the shown id is
   `ihljfjgoakmoemkdondoaadegpmibimh`.
2. Run `install.sh` (or `install.ps1` on Windows) once to register the
   native-messaging host.
3. Configure ONE external MCP client against the fixed launch command, e.g.
   `claude mcp add open-claude-in-chrome -- node <repo>/host/mcp-server.js`
   (or point a codemode/hybrid MCP client at `server-codemode.js`/
   `server-hybrid.js` the same way), and confirm it connects and can call a
   tool (e.g. `tabs_context_mcp`) against the real browser.
4. In `chrome://extensions`, click "Reload" on the extension. Confirm the id
   shown is still `ihljfjgoakmoemkdondoaadegpmibimh` (unchanged).
5. Without touching the MCP client's configuration or re-running
   `install.sh`/`install.ps1`/`claude mcp add`, call a tool through the SAME
   already-configured MCP client again and confirm it still works (proves no
   repeated registration was needed after a reload).
6. Fully quit and restart the browser. Confirm the id shown in
   `chrome://extensions` is still unchanged.
7. Again without touching the MCP client's configuration or re-running any
   installer/registration step, call a tool through the same MCP client and
   confirm it still works.

Never faked as a pass; this is the one item this task set explicitly
expected to require live infrastructure to close.

## Non-negotiable assertions — explicit verification

| Assertion | Evidence | Result |
|---|---|---|
| No deletion, deprecation, or modification of any user's MCP registration | `git diff --stat` shows zero changes to `host/mcp-server.js`, `server-codemode.js`, `server-hybrid.js`, `common.js`, `install.sh`, `install.ps1`, or any registration-adjacent file this session | PASS |
| Legacy schemas/behavior not "improved" — byte-identical contracts | Argument coercion, image passthrough, and error-shape tests above all assert the EXACT existing shape, including explicitly asserting `isError` is NOT set (the arguably nicer shape) where the existing code never sets it | PASS |
| Control never crosses client scope | Lease-contention tests assert zero extension-side dispatch for the excluded party, both legacy-excluded-by-SDK and SDK-excluded-by-SDK | PASS |
| All existing suites still pass | See full regression run below | PASS |

## Full regression — every suite in `host/test/` and `test/`

Baseline (before this session's new files): 32 `host/test/*.test.mjs` +
23 `test/*.test.mjs` = 55 suites, all green (re-run and confirmed at the
start of this session, before any new file was added).

With this session's three new files added (35 + 23 = 58 suites total),
re-run in full after all three new suites were finished:

```
$ for f in host/test/*.test.mjs test/*.test.mjs; do
    out=$(node "$f" 2>&1); code=$?
    [ $code -ne 0 ] && echo "FAIL: $f" || echo "OK: $f"
  done

OK: host/test/agent-chunked-transport.test.mjs
OK: host/test/agent-companion-core.test.mjs
OK: host/test/agent-context-channel.test.mjs
OK: host/test/agent-lease.test.mjs
OK: host/test/agent-native-handshake.test.mjs
OK: host/test/agent-pipe-isolation.test.mjs
OK: host/test/agent-protocol.test.mjs
OK: host/test/agent-real-profile-integration.test.mjs
OK: host/test/agent-recorder-push.test.mjs
OK: host/test/agent-run-lifecycle.test.mjs
OK: host/test/agent-settings-relay.test.mjs
OK: host/test/agent-skills-wiring.test.mjs
OK: host/test/agent-tool-adapter.test.mjs
OK: host/test/codemode-sandbox-lifecycle.test.mjs
OK: host/test/endpoint.test.mjs
OK: host/test/external-mcp-companion-resilience.test.mjs
OK: host/test/external-mcp-launch-contracts.test.mjs
OK: host/test/external-mcp-lease-contention.test.mjs
OK: host/test/identity.test.mjs
OK: host/test/ownership.test.mjs
OK: host/test/parent-watch.test.mjs
OK: host/test/recorder-companion-routing.test.mjs
OK: host/test/secrets-redaction.test.mjs
OK: host/test/secrets-store.test.mjs
OK: host/test/settings-all.test.mjs
OK: host/test/settings-atomic-store.test.mjs
OK: host/test/settings-capability-test.test.mjs
OK: host/test/settings-discovery.test.mjs
OK: host/test/settings-http-client.test.mjs
OK: host/test/settings-live.test.mjs
OK: host/test/settings-models.test.mjs
OK: host/test/settings-profile.test.mjs
OK: host/test/settings-url.test.mjs
OK: host/test/skills-catalog.test.mjs
OK: host/test/skills-dispatch.test.mjs
OK: test/audit-segments.test.mjs
OK: test/background-agent-settings-relay.test.mjs
OK: test/handlers.test.mjs
OK: test/humanize-executor.test.mjs
OK: test/humanize-planners.test.mjs
OK: test/registry-baseline.test.mjs
OK: test/registry-borrowed-tab-live-extraction.test.mjs
OK: test/registry-borrowed-tab-scope.test.mjs
OK: test/registry-sdk-mapping.test.mjs
OK: test/settings-ui-client.test.mjs
OK: test/settings-ui-controller.test.mjs
OK: test/settings-ui-no-conversation-leak.test.mjs
OK: test/settings-ui-real-companion.test.mjs
OK: test/settings-ui-secrets.test.mjs
OK: test/settings-ui-validation.test.mjs
OK: test/sidepanel-context-binding.test.mjs
OK: test/sidepanel-conversation-model.test.mjs
OK: test/sidepanel-fake-companion.test.mjs
OK: test/sidepanel-history-store.test.mjs
OK: test/sidepanel-markdown-lite.test.mjs
OK: test/sidepanel-page-context.test.mjs
OK: test/sidepanel-protocol-client.test.mjs
OK: test/sidepanel-recordings-model.test.mjs
ALL DONE
```

**58/58 suites pass** (0 FAIL lines). Note: this repo is under active
parallel development per this delegation's own stated environment (other
sessions concurrently editing `extension/**`, `host/agent/**`); the exact
suite count (55 pre-existing at this session's start, several of which
— `agent-context-channel.test.mjs`, `agent-skills-wiring.test.mjs`,
`secrets-*`, `settings-*`, `sidepanel-*`, `background-agent-settings-relay.test.mjs`,
`registry-borrowed-tab-live-extraction.test.mjs` — postdate the "54/54"
figure in this task's own delegation prompt) reflects the state of the tree
at the time this session ran, not a claim that no other suite has landed
since.

Verified with `Get-CimInstance Win32_Process` after this run that no
`wrangler.js`/`wrangler-dist`/`workerd.exe` process was left running.

## Process hygiene verification

Per the process-management rule (never leave orphaned processes), every test
that spawns a real `native-host.js` or a real `wrangler dev` tree explicitly
tears it down (`ext.kill()` for the fake extension; the tag-based recursive
sweep described above for codemode/hybrid's wrangler tree; `child.kill()`
for the real forked companion harness). Verified by hand after every test
run in this session via `Get-CimInstance Win32_Process` filtered on
`companion.js`/`native-host.js`/`wrangler`/`workerd` — no orphan from this
session's own test runs was left behind. (A small number of unrelated
`native-host.js` processes were observed on the machine during this session,
one with a `chrome-extension://...` argument identifying it as the
machine's own real, already-running browser connection, and others
plausibly belonging to a concurrent parallel session's own test runs per
this delegation's stated multi-session environment — none were touched, per
the scope rule against killing processes this session did not start.)
