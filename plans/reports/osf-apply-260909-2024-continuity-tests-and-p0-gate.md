# Task 2.6 (continuity test matrix) and group 4 (P0 release gate)

Change: `upgrade-agent-reliability-and-workflows`. Scope: tasks.md 2.6 and 4.1/4.2/4.3 only. Group 3 and later untouched.

## Status

DONE_WITH_CONCERNS

## Summary

2.6 is done: audited existing coverage (47 assertions across 2.3-2.5), found two real
gaps (credential-unavailable, and a race between deletion and an in-flight
session_id capture), added them plus symmetry/scope assertions — 66/66 pass.
Group 4 was run to the extent actually observable this session: 4.1's regression
set passes (111/113 across both suites, the 2 failures independently confirmed
as the parallel session's own in-flight work, not mine). 4.2 and 4.3 are
correctly **BLOCKED** — group 3 (evidence-backed approval) has not been
implemented, and both dependency changes carry unchecked live/gateway/a11y
items. I did not fabricate live-browser evidence to force a green gate.

## Files changed

- `host/test/agent-session-continuity.test.mjs` — added 2 new test blocks (credential-unavailable, race), added `toolCalls` tracking to `buildCore()`, added "zero browser tool calls" assertions to 6 existing failure-path tests, added a `run_stopped` symmetry assertion to the new credential-unavailable test and a prompt-exactness assertion to the partial-turn test.
- `openspec/changes/upgrade-agent-reliability-and-workflows/tasks.md` — checked off **2.6 only**.

No other file touched. `extension/background.js`, `extension/sidepanel/*`, `extension/ui/icons.js`, `test/sidepanel-conversation-model.test.mjs`, `openspec/changes/side-panel-follows-active-tab/` are the parallel session's — left untouched, per constraints.

## Task 2.6 — coverage audit (what existed vs. what I added)

Read `host/test/agent-session-continuity.test.mjs` (2.3-2.5's 47 assertions) against the task's own matrix of 11 items:

| Matrix item | Already covered (2.3-2.5) | Gap found | Action |
|---|---|---|---|
| two-turn | `firstTurnCapturesAndSecondTurnResumes` | none | none |
| restart | `sdkSessionRefSurvivesASimulatedCompanionRestart` | none | none |
| incompatible-selection | `incompatibleModelIsRejectedWithStructuredMismatches` | missing "zero tool dispatch" proof | added assertion |
| missing-session | `missingSessionIsClassifiedAndNeverAutoRetried` | same | added assertion |
| **credential-unavailable** | none (only generic `profile_unavailable` coverage in `agent-companion-core.test.mjs`'s first-turn case and `agent-real-profile-integration.test.mjs`'s typed-error case) | **real gap**: nothing tested what happens when a *second, resume-eligible* turn's credential resolution fails — does resume get attempted anyway? does the ref get poisoned? | **new test added** |
| fork/new-conversation | `newSdkSessionExplicitlyBypassesRejectionAndResume` | none — confirmed via source (`query-options.js`'s own comment) that real SDK `forkSession` is deliberately not wired; `newSdkSession` **is** the fork/new-conversation host-side hook this task's matrix item refers to | none (documented, not a gap) |
| cancellation | `deliberateStopIsNeverReclassifiedAsAResumeFailure` | missing "zero tool dispatch" proof | added assertion |
| partial-turn | `abortedPartialTurnStillPreservesTheCapturedRefForTheNextTurn` | missing "zero tool dispatch" + prompt-exactness proof | added assertions |
| **race** | `deletionTombstoneOrderingPreventsLateResurrectionDuringAnActiveRun` (delete vs. active-run unwind — the SDK never yields a session_id in that scenario) + `agent-companion-core.test.mjs`'s own near-identical test | **real gap**: no test exercised a session_id/`init` message arriving from the SDK *strictly after* `DELETE_CONVERSATION` had already tombstoned the conversation — the exact race `companion.js`'s own `_runQuery` comment names ("this conversation was deleted the instant this message arrived") and `session/manager.js`'s `claimSdkSessionRef`/`markSdkSessionRefStatus` guard against, but which no test exercised end-to-end | **new test added** |
| late-unwind | `deletionTombstonesFirstAndLateUnwindSweepRetries` | none | none |
| deletion | `deletionTombstoneOrderingPreventsLateResurrectionDuringAnActiveRun` + the late-unwind test | missing "zero tool dispatch" proof | added assertion |

**The two hard rules, made explicit and checked on every failure path exercised** (incompatible-selection, missing-session, credential-unavailable, partial-turn, cancellation, deletion, race — 7 of the 11 matrix items; two-turn/restart/late-unwind/fork are success or pure-metadata paths where the rule doesn't apply):

- *"no failure path replays a browser mutation"* — every failure-path test now asserts a shared `toolCalls` counter (wired through `buildCore()`'s `ToolBridge.callTool`) stays at 0. **Scope of this proof, stated honestly**: it proves this layer's own failure handling (companion.js's catch blocks, the compatibility gate, the profile-resolution failure path) contains no code that itself calls the tool bridge to replay an action. It does **not** prove the SDK itself never replays a tool call on resume — that is a separate claim, already closed by gate-0.2's G1 (in-process tool-handler invocation-count delta of 0 across a resumed turn), with the "live browser tool call replay end to end" gap still open in both gate-0.2 and gate-1.1 (no live Chrome/extension attached in either). I documented this distinction inline in the test file rather than let the two claims blur.
- *"no failure path synthesizes model memory from transcript events"* — already proven for two-turn/incompatible/missing-session by prompt-exactness assertions (2.3-2.5's own work); extended the same pattern to partial-turn (new assertion: the recovery turn's prompt is exactly `"b"`) and to the two new tests (credential-unavailable never reaches `sdk.query()` at all; the race test's late-arriving message is never turned into a prompt for anything).

Test output:
```
$ node host/test/agent-session-continuity.test.mjs
[... all PASS lines ...]
ALL SESSION CONTINUITY TESTS PASSED   (66/66, up from 47/47)
```

## Group 4 — the P0 release gate

### 4.1 — regression set

Mapped the 12 named categories to files (approximate — the categories overlap; several files serve more than one):

| Category | Representative files |
|---|---|
| continuity | `host/test/agent-session-continuity.test.mjs`, `agent-conversation-metadata.test.mjs` |
| minimum-document | `test/document-identity.test.mjs`, `test/document-identity-wiring.test.mjs` |
| approval | `test/approval-gate.test.mjs`, `test/send-class-classifier.test.mjs`, `host/test/agent-tool-permission-preapproval.test.mjs` — group 3's own suite (3.5) does not exist yet |
| runtime | `host/test/agent-run-lifecycle.test.mjs`, `agent-companion-core.test.mjs` |
| lease | `host/test/agent-lease.test.mjs`, `agent-native-lease-release.test.mjs`, `external-mcp-lease-contention.test.mjs` |
| permission | `host/test/agent-tool-permission-preapproval.test.mjs` |
| action-event | `test/action-events-emission.test.mjs`, `test/action-events-schema.test.mjs` |
| external-MCP | `host/test/external-mcp-*.test.mjs` (3 files) |
| overlay | `test/overlay-pointer.test.mjs`, `overlay-background-bridge.test.mjs`, `overlay-companion-sender.test.mjs` |
| extraction | `test/extraction-honesty.test.mjs`, `registry-borrowed-tab-live-extraction.test.mjs` |
| attachment | `host/test/agent-attachment-kinds-effort.test.mjs`, `test/composer-add-and-effort.test.mjs`, `sidepanel-recordings-model.test.mjs` |
| skill | `host/test/agent-skills-*.test.mjs`, `skills-*.test.mjs`, `test/settings-ui-skills-*.test.mjs`, `sidepanel-skills-client.test.mjs` |

Given the overlap, I ran the **full** `host/test/*.test.mjs` (51 files) and `test/*.test.mjs` (62 files) suites rather than a hand-curated subset — this is a superset of every category above.

**Real output, `host/test/` (51 files, 25s per-file cap, then the known-slow 4 re-run individually at 100s):**
```
First pass: TOTAL PASS=48 FAIL=3
  FAIL host/test/external-mcp-companion-resilience.test.mjs   (timeout at 25s)
  FAIL host/test/settings-all.test.mjs                        (timeout at 25s)
  FAIL host/test/settings-capability-test.test.mjs             (timeout at 25s)
Re-run individually at 100s: all 3 PASS
  (external-mcp-launch-contracts.test.mjs also re-checked at 100s: PASS)
Net: 51/51 pass — identical harness-timeout pattern to the prior wave's own
report (these spawn real subprocesses / hit the real Windows Credential
Manager and legitimately take 5-40s; none touch this task's scope).
```

**Real output, `test/` (62 files, 25s per-file cap):**
```
TOTAL PASS=60 FAIL=2
  FAIL test/navigate-url-scheme.test.mjs        — hung mid-assertion at
       "host:port/path still gets https:// prepended" (identical stall
       point the 2.3-2.5 wave already reported and attributed to the
       parallel session's in-flight extension/background.js).
  FAIL test/side-panel-group-scope.test.mjs     — 4 named assertion
       failures, all about tab/group adoption on icon click — this IS the
       parallel session's own side-panel-follows-active-tab work in
       progress.
Net: 60/62 pass, both non-passing files independently re-confirmed this
session as attributable to the parallel session, not this change.
```

Neither failure touches anything `host/agent/**`, `host/agent/companion.js`, `session/manager.js`, `conversation-metadata.js`, `protocol.js`, or `query-options.js` — the files this and the prior continuity waves actually changed.

**Whether 4.1 is checked off: no.** The "approval" line item in a P0 gate reads most naturally as group 3's own adversarial suite (3.5), which does not exist — group 3 is unstarted. What I ran today is a real, green baseline of the *existing* regression surface (unaffected by 2.6's own changes), not the complete P0 regression set the task names. Leaving 4.1 unchecked and recording today's numbers as the baseline for a full re-run once group 3 lands.

### 4.2 — real browser session (BLOCKED, not attempted as a live run)

The task explicitly asks me to be honest about what's reachable, citing gate-1.1's own precedent of recording unobserved items with concrete steps rather than inferring them. Three independent reasons this item cannot pass right now, any one of which is sufficient on its own:

1. **Structurally blocked by group 3.** The verify clause is *"evidence distinguishes completed, partial, unknown, stale, and denied effects."* "Denied" requires the evidence-backed approval pipeline (tasks 3.2/3.3, unimplemented). "Stale" requires pre-dispatch revalidation (task 3.4, unimplemented). "Authorized navigation / unexpected replacement / scope change" all route through that same not-yet-built pipeline. No amount of live browsing produces evidence for a pipeline that doesn't exist yet.
2. **The live extension is running the parallel session's in-flight code.** `extension/background.js` and `extension/sidepanel/*` are modified in the working tree by the other session (git status confirms), and two `test/` files fail/hang because of it — "active/background tabs" is literally the subject of their `side-panel-follows-active-tab` change. Any live evidence gathered against this tree would be evidence about an unstable, foreign-owned base, not about this change.
3. **Credential revocation is destructive and out of scope for a subagent to perform unattended.** The task explicitly lists "credential revocation" as one of the nine scenarios; revoking the operator's real Windows Credential Manager entry mid-session is not something to do autonomously to produce test evidence.

I did **not** build a bare-CDP throwaway-Chrome gate script (the gate-1.1 pattern) as a substitute, because gate-1.1 answered "what does Chrome expose at the protocol level" — a question a bare CDP session can answer. 4.2 asks "does the *product* (extension + host companion + side panel + approval pipeline) behave correctly live" — every one of the nine scenarios is specifically about that integrated pipeline, which a bare-CDP session without the real extension/host cannot exercise. Producing PASS lines about raw Chrome tab primitives under a 4.2 heading would be exactly the "proxy reported as a pass" the task warns against.

**Per-item table — all UNOBSERVED, with what would close each:**

| Item | Status | Blocker(s) | To close |
|---|---|---|---|
| active/background tabs | UNOBSERVED | 2, 3.2/3.3 gap | After group 3 lands and the parallel session's tree stabilizes: load the real unpacked extension, register the native host, drive two tabs (one active, one background) through a real conversation, capture panel/host evidence distinguishing them. |
| restart | UNOBSERVED | 1, 2 | Same setup; kill and relaunch the host companion mid-run, confirm resume/reject per 2.3-2.5's already-passing structural tests, this time with a live SDK session and live browser lease. |
| stop | UNOBSERVED | 1, 2 | Same setup; issue STOP mid-action, confirm the overlay/lease release live (structural coverage exists in `agent-lease.test.mjs`/`agent-native-lease-release.test.mjs`, already green). |
| disconnect | UNOBSERVED | 1, 2 | Same setup; kill the native-messaging port, confirm the companion and panel both report the disconnect explicitly. |
| authorized navigation | UNOBSERVED | 1 (routes through group 3's approval pipeline) | Requires 3.1-3.4 implemented first. |
| unexpected replacement | UNOBSERVED | 1 | Requires 3.1-3.4 implemented first — this is precisely the "stale evidence" case the verify clause names. |
| scope change | UNOBSERVED | 1 | Requires 3.1-3.4 implemented first. |
| credential revocation | UNOBSERVED | 3 (destructive, requires explicit operator action) | Requires the operator to revoke a throwaway test credential (never the real one) in a dedicated, opt-in live session. |
| deletion | UNOBSERVED | 2 | Same setup as above; the structural coverage (this session's own new race test, plus 2.3-2.5's tombstone tests) is green, but no live-browser artifact-cleanup evidence exists. |

**4.2 left unchecked.**

### 4.3 — keep P0 blocked until the four named gates pass

Read `tasks.md` 4.3 literally: *"Keep P0 blocked until SDK, minimum-document, live approval, and outstanding active-change live gates pass; structural tests cannot substitute for live evidence."* Checked each of the four by name:

| Gate | Status | Evidence |
|---|---|---|
| SDK (group 0) | PASS, with one open item | `plans/reports/osf-apply-260909-1504-sdk-continuity-gate.md` — gate-0.2 passed overall (no stop condition held); "live browser tool call replay end to end" is explicitly recorded UNOBSERVED (no live Chrome/extension attached), matching gate-1.1's own identical gap. |
| minimum-document (group 1) | Structurally PASS, live-extension e2e UNOBSERVED | tasks 1.1-1.4 checked; `gate-1.1-document-identity.mjs` used a real throwaway Chrome over CDP (not the shipped extension) and recorded live-extension end-to-end verification as unobserved with concrete steps to close, same convention this report follows for 4.2. |
| live approval (group 3, task 3.6) | **BLOCKED** | Group 3 (3.1-3.6) is entirely unimplemented — 0 of 6 tasks done. Nothing to evaluate. |
| outstanding active-change live gates | **BLOCKED**, itemized | `repair-overlay-mount-and-visibility/tasks.md`: task **0.1** unchecked — "requires a real browser run, which this implementation session cannot perform" (RC7 closed structurally only); task **12.1** unchecked — live confirmation of the whole fix, explicitly deferred to the operator. `adopt-panel-design-and-image-attachments/tasks.md`: tasks **5.1** (cross-entry-point e2e identity), **5.2** (real-gateway vision round-trip — explicitly "NOT done... must not be claimed as done"), **5.3** (no-attachment regression suite not run this cycle), **5.4** (size ceilings not validated against a live gateway), **5.5** (full 320/400/480 both-themes a11y matrix with picker/thumbnails not executed) — all 5 unchecked. |

**Verdict: P0 is BLOCKED.** Three of the four named gates have open items (SDK's live-replay item is the mildest — already carried forward twice as an accepted residual, not a fresh gap); live approval and both dependency changes have substantive, named, unchecked live work. **4.3 left unchecked** — the task itself is a standing instruction to keep the gate blocked, not a checkbox that becomes true once read.

## Tasks checked off this session

- **2.6** — evidence: `host/test/agent-session-continuity.test.mjs`, 66/66 assertions passing, covering all 11 matrix items plus both hard-rule properties across 7 failure paths.

**4.1, 4.2, 4.3 left unchecked**, per the task's own 11.5 rule ("leave every task unchecked until its evidence exists and keep release gates blocked when live/provider checks are unavailable") and the honest-gate instruction in my own task brief.

## Concerns for the controller

- 4.1's regression run is a real, green baseline (111/113, both failures independently confirmed as the parallel session's), but it is not the *complete* P0 regression set the task names (group 3's approval suite doesn't exist yet) — needs a full re-run once group 3 lands, not just a checkbox flip.
- `test/navigate-url-scheme.test.mjs` still hangs deterministically at the identical point the prior wave reported, and `test/side-panel-group-scope.test.mjs` still fails on the same 4 assertions about icon-click tab/group adoption — both re-confirmed this session, both attributable to the parallel session's `side-panel-follows-active-tab` change in progress, neither touched by me.
- P0 is genuinely blocked on real work (group 3 in full, plus live QA this session structurally cannot perform) — this is not a process gap to route around, it's the correct state given what exists today.
