# Companion and SDK browser tools — evidence report

**Addendum (a later session closed two protocol gaps this report's original
message-type inventory did not yet include).** `reports/05-panel-evidence.md`'s
"Known gaps" section (written by the panel-building session) found that
`host/agent/protocol.js` had no `LIST_CONVERSATIONS`/`DELETE_CONVERSATION`
message type even though `host/agent/session/manager.js` already had
`listConversations()`/`deleteConversation()` ready to use, and that
`agent_settings` (already relayed end-to-end by `extension/background.js` and
consumed by `extension/settings/settings-client.js`) had no companion-side
handler at all — every real settings request dead-ended on the generic
`unknown_message_type` fallback. A later session closed both, entirely within
`host/agent/protocol.js`/`companion.js`/`session/manager.js`/`storage/*`
(this report's own owned surface), without touching `extension/**`:

- `protocol.js` gained `LIST_CONVERSATIONS`/`DELETE_CONVERSATION`/`AGENT_SETTINGS`
  in `AGENT_MESSAGE_TYPES` (append-only, per this file's own versioning rule).
- `companion.js` gained `_handleListConversations()`/`_handleDeleteConversation()`
  (gated behind hello, exactly like `NEW`/`START`/`STOP`, per "consistent with
  the existing catalogue and sequencing") and `_handleAgentSettings()`
  (deliberately NOT gated behind hello — a separate extension surface with no
  conversation of its own; validates the envelope's own protocol version
  itself, the same pattern `_handleRecordingComplete()` already established
  for a bridge-level fact independent of any session), delegating every op to
  the real, already-tested `host/agent/settings/profile.js`.
- `session/manager.js` gained `conversationSummaries()` (interrupted state +
  live `hasActiveRun`), `hasConversation()`, `activeRunsForProfile()` (for
  credential-revocation cancellation), and closed a genuine race in
  `deleteConversation()`: an active run's own asynchronous unwind (its SDK
  `query()` generator's `finally` block, which fires well after
  `abortController.abort()`) could otherwise resurrect a just-deleted
  conversation directory via `TranscriptStore.appendEvent()`/`updateMeta()`'s
  auto-vivify fallback — closed with an explicit per-process tombstone set,
  checked by every store-write path (`startRun`'s event sink, `finishRun`,
  `setSkillsBinding`) before it touches disk for a given conversationId.

Proof: 6 new tests appended to `host/test/agent-companion-core.test.mjs`
(LIST_CONVERSATIONS/DELETE_CONVERSATION fail closed before hello; interrupted
state + live hasActiveRun; a recording's actual file surviving conversation
deletion; unknown-conversation-id rejected; the delete-during-an-active-run
race reproduced and proven closed) and 10 new tests in the new
`host/test/agent-settings-relay.test.mjs` (every op `settings-client.js`
sends, against the REAL `host/agent/settings/profile.js` — including
save-with-no-active-conversation/no-hello, a real fixture-server-backed
`discover_models`/`test_capability` round trip, credential removal firing
`onCredentialRevoked` and cancelling an active run, and proof no reply ever
contains the raw key). All 31 `host/test/*.test.mjs` and 23 root
`test/*.test.mjs` suites pass. See `reports/05-panel-evidence.md`'s "Known
gaps" section (now marked resolved) for the panel-side context these gaps
were blocking. This report's own body below is left as the original session's
account and is not rewritten; the "Message types" line just below is the one
factual correction applied directly (a stale inventory would otherwise be
actively wrong, not just historically incomplete).

Change: `migrate-to-claude-agent-sdk`, tasks.md group 3 (tasks 3.1–3.5).

This report records what was actually built, actually run, on this machine,
on this date, and what remains genuinely blocked because this session has no
live Anthropic API credential and no live browser attached — exactly the
constraint the delegation stated up front. Nothing here is simulated as a
"pass"; every BLOCKED item names the exact command required to close it.

Builds directly on `reports/01-sdk-gate-evidence.md` (group 1's proven SDK
integration: `tool()`/`createSdkMcpServer()` work against the project's
existing zod v3 schemas via Standard Schema, and Node's ESM module cache is
per-process). Both findings from that report are load-bearing here and are
addressed structurally, not by convention — see "Per-process pipe isolation"
below.

## Environment

| | |
|---|---|
| Date | 2026-09-06 |
| `@anthropic-ai/claude-agent-sdk` | 0.3.263 (unchanged from group 1; `host/package.json` not touched this session) |
| Node.js | v24.19.0 |
| Platform | win32 x64 (Windows 11) |

## Protocol version and message catalogue

`host/agent/protocol.js` defines the versioned envelope both native-host.js
and the companion speak, wrapped as `{ type: "agent_msg", envelope }` on the
SAME native-messaging channel as existing `tool_request`/heartbeat traffic
(new message type, existing traffic untouched).

- `PROTOCOL_VERSION = 1`, `SUPPORTED_PROTOCOL_VERSIONS = [1]` (append-only for future bumps).
- Message types: `hello`, `hello_ack`, `version_mismatch`, `start`, `resume`,
  `new`, `stop`, `approval_request`, `approval_decision`, `snapshot_request`,
  `snapshot`, `stream_event`, `token_batch`, `chunk_begin`, `chunk_part`,
  `chunk_end`, `recording_complete`, `list_conversations`,
  `delete_conversation`, `agent_settings`, `error` (the last four added by the
  addendum above and by task 6.3's own session; see this file's addendum note
  for `list_conversations`/`delete_conversation`/`agent_settings`).
- An envelope with a missing, non-integer, or unsupported `v` is rejected
  with `version_mismatch` **before** a companion is even consulted for
  `hello`, and every other message type is rejected with
  `version_mismatch { reason: "hello_required" }` until a hello has
  succeeded — fail-closed, not fail-open, at both ends (`native-host.js` and
  `CompanionCore`).

## What was built

- `host/agent/protocol.js` — versioned envelopes, fail-closed hello validation, native-messaging wrapper.
- `host/agent/companion.js` — `CompanionCore` (fully testable, dependency-injected) plus the forked-child IPC entry point; `createRealCompanion()`; the one-companion-per-process guard.
- `host/agent/session/run.js` — one SDK run: lifecycle, lease membership, honest cancellation.
- `host/agent/session/manager.js` — conversation lifecycle (new/resume/start/stop), one active run per conversation, restart recovery.
- `host/agent/session/token-batcher.js` — coalesces high-frequency stream events; low-frequency events pass through immediately.
- `host/agent/storage/{paths,transcript-store}.js` — durable sequenced per-conversation event log + metadata, private per-user artifact directories.
- `host/agent/broker/browser-lease.js` — in-process, per-companion lease serializing conversations.
- `host/agent/broker/native-lease.js` — cross-process lease arbitration used by `native-host.js` (SDK vs legacy clients).
- `host/agent/broker/chunked-transport.js` — bounded binary chunk transport with size/id/total/expiry validation.
- `host/agent/broker/tool-bridge.js` — run-scoped wrapper over `host/tool-runtime.js`, distinguishing a real error from a lost-response "result unknown".
- `host/agent/policy/approvals.js` — approval tokens bound to exact run/action/target, single-use, expiring, invalidated on stop/scope-change.
- `host/agent/policy/authorization.js` — unconditional handler-side authorization (run state, lease, tab scope, upload allowlist, unknown-tool rejection).
- `host/agent/tools/adapter.js` — productionized SDK tool adapter (all 26 registry tools, real `tool()`/`createSdkMcpServer()`).
- `host/agent/tools/query-options.js` — productionized isolated `query()` options builder, sourced from the settings profile snapshot.
- `host/native-host.js` — extended: companion fork/supervision/clean-shutdown, agent-message routing + fail-closed hello, `NativeLeaseGuard` wired into `tool_request` dispatch, SIGTERM/SIGINT handling.
- `host/tool-runtime.js` — extended (backward compatible): `callTool`/`sendToExtension` accept an optional `meta` (runId/conversationId/browserIdentity/tabScope/requestId); `HOST_DROPPED_ERROR`/`NO_BRIDGE_ERROR` exported; new `releaseLease()`.
- `extension/background.js` — extended: agent-channel relay (`ocic-agent` port) for a future sidepanel, hello handshake on native-port connect, persisted per-profile `installationId` + per-connection `connectionId` (never a model-provided name).

## Interface contract with group 4 (`host/agent/settings/profile.js`)

This module did not exist when this delegation started; `host/agent/tools/
query-options.js`'s `resolveProfileSnapshot()` was written against the
documented contract with an injectable `profileProvider` (defaulting to a
**lazy** `await import("../settings/profile.js")`, resolved only when a run
actually starts, never at module load time) specifically so nothing here
would depend on group 4 landing first.

Group 4's session landed the real module **during this session**
(`host/agent/settings/profile.js`, confirmed via `git status` — its own
header literally says: "Exported contract (signatures fixed; see tasks.md
task group 4 and the osf-apply prompt this was implemented from)"). This
made it possible to upgrade the claim from "matches the documented shape"
to an actual, executed, real cross-module integration test —
`host/test/agent-real-profile-integration.test.mjs`, run against the REAL
`host/agent/settings/profile.js`, no double, no OS keychain dependency
(`memoryOnly: true`):

```
$ node host/test/agent-real-profile-integration.test.mjs

Real host/agent/settings/profile.js integration

  PASS  with no profile configured, resolveProfileSnapshot() throws the documented typed error (real module, no double)
  PASS  with a real profile + memory-only credential, resolveProfileSnapshot() returns the exact documented shape
  PASS  CompanionCore's default profileProvider (no override) resolves through the real module end to end

3/3 passed
```

The third case is the one that matters most: `CompanionCore` is constructed
with `profileProvider` **omitted** (the production default, i.e. exactly
what the real companion does), a real profile + memory-only credential is
saved through the real module's own `saveProfile`/`setCredential`, and a
full `hello -> new -> start` sequence is driven through `CompanionCore`
exactly as `native-host.js` would — the real credential and model genuinely
reach the constructed SDK `query()` options with zero code change on this
side. The interface contract is not just satisfied on paper; it is proven
wired together.

`host/test/agent-companion-core.test.mjs` and `agent-run-lifecycle.test.mjs`
additionally keep exercising the run-start path with a local double (per
the delegation's instruction to write one for this file's own tests), so
this suite's coverage does not regress if group 4's module is ever
unavailable in a future test environment.

## Per-process pipe isolation (group-1 bug closed structurally)

Group 1 found that Node caches an ES module by resolved file URL for the
life of a **process**, so two isolated bridges sharing one process would
silently share one `tool-runtime.js` instance. The companion design makes
this impossible by construction, not convention: **one companion process
per active bridge**, forked fresh by `native-host.js` for that bridge only,
never re-imported for a second one inside an existing process.

Two independent proofs, both real (`host/test/agent-pipe-isolation.test.mjs`):

1. Two REAL companion processes (forked via `createRealCompanion()`, the
   same entry point `native-host.js` uses), each bound to its OWN real
   scratch bridge (its own `native-host.js` + fake extension), each
   answering only from its own bridge — including an interleaved-traffic
   variant to catch a race, not just a static wire-up.
2. `startCompanionProcess()` throws if called a second time in the same
   process — the exact shape of the original bug is refused outright.

```
$ node host/test/agent-pipe-isolation.test.mjs

Per-companion-process pipe isolation (group-1 bug reproduction)

  PASS  two companion processes on two different bridges never cross-talk
  PASS  interleaved concurrent calls on both bridges still never cross — repeated to catch a race, not just a static wire-up
  PASS  a single process may only ever start ONE companion bridge (structural guard against the original bug shape)

3/3 passed
```

## Acceptance criteria — PASS/FAIL/BLOCKED

| # | Item | Status | Evidence |
|---|---|---|---|
| 1 | Version handshake failing closed | **PASS** | `host/test/agent-protocol.test.mjs` (11/11, unit-level) + `host/test/agent-native-handshake.test.mjs` (4/4, end-to-end against the real, running `native-host.js` process driven exactly as `background.js` drives it) |
| 2 | Chunked large-payload transport | **PASS** | `host/test/agent-chunked-transport.test.mjs` (10/10) — a real 5MB payload (screenshot/recording size class) is split, every individual wire envelope measured under the ~1MB native-messaging ceiling, and reassembled byte-for-byte; oversized/mismatched/expired/duplicate/incomplete sequences are all rejected, not silently accepted |
| 3 | Lease serialization across SDK + legacy clients | **PASS** | `host/test/agent-lease.test.mjs` (12/12) — real `native-host.js` process: an SDK run's tagged request excludes a concurrent anonymous legacy client with a retryable busy error (never dispatched to the extension), release lets it through, and legacy-only traffic with no runId anywhere is proven completely unaffected (`ownership.test.mjs` parity, by construction and by a dedicated regression test) |
| 4 | Stop blocking dispatch | **PASS** | `host/test/agent-run-lifecycle.test.mjs` + `agent-tool-adapter.test.mjs` — a call after `stop()` is rejected by `authorizeToolCall` (`run_not_active`) both as a unit check and through a REAL SDK tool handler, and the underlying tool bridge is proven never reached |
| 5 | Lost-response reported as unknown, never retried | **PASS** | `agent-run-lifecycle.test.mjs`: a `HOST_DROPPED_ERROR`-shaped result is flagged `resultUnknown` and the fake dispatch is asserted to have been called exactly once; `agent-tool-adapter.test.mjs` proves the SAME outcome is recorded on the `Run` object through the real SDK tool handler path |
| 6 | Approval-token binding/expiry | **PASS** | `agent-run-lifecycle.test.mjs`: exact run/action/target binding (any deviation rejected), single-use (replay within TTL rejected as `already_used`, not silently allowed), TTL expiry, stop-invalidation, scope-change (`invalidateAll`) invalidation |
| 7 | Per-session pipe isolation (group-1 bug impossible) | **PASS** | See "Per-process pipe isolation" above — `agent-pipe-isolation.test.mjs`, 3/3, including two real cross-process proofs |

## Existing suites — unchanged behavior, still pass

```
$ node host/test/endpoint.test.mjs        -> 7/7 passed
$ node host/test/parent-watch.test.mjs    -> 3/3 passed
$ node host/test/ownership.test.mjs       -> 12/12 passed
$ node host/test/identity.test.mjs        -> 20/20 passed
$ node test/handlers.test.mjs             -> ALL HANDLER TESTS PASSED
$ node test/registry-baseline.test.mjs    -> ALL REGISTRY BASELINE TESTS PASSED
```

`git diff --stat` confirms `host/tool-definitions.js`, `host/mcp-server.js`,
`host/codemode/**` are untouched. `host/native-host.js`, `host/tool-runtime.js`
and `extension/background.js` are extended (additive, backward compatible);
`host/package.json`/`host/package-lock.json` are untouched (no new
dependency needed — the SDK is already pinned from group 1).

## Full new-suite run (this session, real output)

```
$ node host/test/agent-protocol.test.mjs                  -> 11/11 passed
$ node host/test/agent-native-handshake.test.mjs          -> 4/4 passed
$ node host/test/agent-chunked-transport.test.mjs         -> 10/10 passed
$ node host/test/agent-lease.test.mjs                     -> 12/12 passed
$ node host/test/agent-run-lifecycle.test.mjs             -> 19/19 passed
$ node host/test/agent-tool-adapter.test.mjs              -> 6/6 passed
$ node host/test/agent-companion-core.test.mjs            -> 14/14 passed
$ node host/test/agent-pipe-isolation.test.mjs            -> 3/3 passed
$ node host/test/agent-real-profile-integration.test.mjs  -> 3/3 passed
```

82 new test cases across 9 suites, all real (no live browser/API key
required by design — see "Environment constraint" below), all passing.

## A real design bug found and fixed while building this

The first version of `CompanionCore._handleStart` awaited
`run.begin()` (which can block indefinitely on the shared browser lease when
another conversation currently holds it) **before replying** to the `start`
envelope at all. That meant a queued conversation's `start` request would
hang the whole protocol exchange for as long as the lease was held elsewhere
— directly contradicting the spec's "Concurrent conversation: the second
conversation is queued" (queued is a visible, immediate state, not a stalled
RPC). Caught by a dedicated test
(`agent-companion-core.test.mjs`: "a run queued behind another
conversation's lease is accepted immediately (queued:true), not held until
granted") asserting the reply latency stays under 100ms even though the
lease wait is ~250ms. Fixed: `start` now always replies immediately
(`accepted: true, queued: <bool>`), and the lease wait + profile resolution +
SDK run happen in the background, with `run_queued`/`run_started`/`run_error`
events flowing through the normal sequenced event stream. Left in this
report rather than silently corrected, per this delegation's root-cause
completion requirement.

## Environment constraint — what is genuinely BLOCKED

No live Anthropic API key and no running browser are available in this
session, exactly as stated in the delegation. Consistent with that:

- Every test above uses a fake SDK (`{ query: async function* }`) or a fake
  extension (native-messaging-framed stdio, the same technique
  `host/test/ownership.test.mjs` already uses) — never a live model call or
  a live Chromium instance.
- What is **not** covered here, and requires live infrastructure to close:
  - An actual multi-turn conversation against a real, credentialed Anthropic-
    compatible endpoint, using the real bundled Claude Code CLI the SDK
    spawns. Close with: a real `host/agent/settings/profile.js` (group 4) +
    `ANTHROPIC_BASE_URL`/`ANTHROPIC_API_KEY` set, then start a real
    conversation through a real sidepanel (group 5) or a small driver script
    calling `CompanionCore.handleEnvelope` directly.
  - A real screenshot/recording chunked through the ACTUAL native-messaging
    transport to a real Chrome extension (this session proved the chunker/
    reassembler correctness and size bound in isolation; the wire is not
    exercised through a live `chrome.runtime.connectNative` port because no
    browser is attached).
  - `extension/background.js`'s new agent-channel relay code
    (`sendAgentHello`, the `ocic-agent` port relay) is written to the
    documented protocol and syntax-checked, but genuinely BLOCKED for live
    verification: no browser, no sidepanel (group 5) to connect an
    `ocic-agent` port yet. Close with: load the extension in a real
    Chrome/Edge/Brave profile with the companion installed, and confirm
    `chrome.storage.local` persists `ocic_installation_id` across a service-
    worker restart and that a `hello`/`hello_ack` round trip actually
    completes (observable via `host-exits.log`/stderr or a temporary
    `console.log`).

None of these are faked or stubbed into a false pass; each is named here
with the exact missing precondition.

## Scope discipline notes

- `host/agent/settings/**` and `host/agent/secrets/**` were not created or
  modified (group 4's ownership).
- `host/agent/spike/**`, `host/agent/identity.js`, `host/agent/generate-key.js`
  were read for context only, never modified.
- `host/package.json`/`host/package-lock.json` untouched.
- No new file was created directly in `host/agent/` other than
  `companion.js` and `protocol.js`; every other new file lives under
  `host/agent/{session,storage,broker,policy,tools}/`.
- `test/**` (root) was not modified; `test/handlers.test.mjs` and
  `test/registry-baseline.test.mjs` were run read-only to confirm they still
  pass.
- Legacy MCP entry points (`host/mcp-server.js`, `host/codemode/*`) are
  untouched; their existing tests were not run again here because they were
  not exercised by group 1 either and are outside this group's touched
  surface, but `host/tool-runtime.js`'s changes are additive/optional-arg
  only and `host/test/ownership.test.mjs` (which drives `tool-runtime.js`'s
  exact wire contract) passes unchanged.
