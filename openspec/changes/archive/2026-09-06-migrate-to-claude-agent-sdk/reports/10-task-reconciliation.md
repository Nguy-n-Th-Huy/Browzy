# Task reconciliation — full `tasks.md` status audit

**Addendum (a later session closed this report's flagged 7.2 gap).** Every
section below is this report's original, unmodified account of the session
that wrote it — including its 7.2 row, which correctly stated the gap as
open at the time. A subsequent session verified the gap by reading
`host/agent/tools/query-options.js` directly (confirming `buildIsolatedOptions()`
still hard-coded `tools: []` and accepted no skills parameter, exactly as
described below), then closed it: `host/agent/tools/query-options.js` now
requires and composes a `skills` session (`cwd`, `skills` allowlist,
`skillOverrides`, `tools: ["Skill"]`), `host/agent/companion.js` gained
`_bindSkillsForRun()` (calls the real `buildSessionSkills()`, binds a
conversation to its snapshot, rechecks it every later run via
`assertResumeSnapshotAvailable()`) and an application-side
`assertSlashDispatchAllowed()` gate enforced before any SDK call, and
`host/agent/session/manager.js` gained `getSkillsBinding()`/`setSkillsBinding()`
to persist the per-conversation binding. Proof: 7 new tests in
`host/test/agent-skills-wiring.test.mjs` (all passing), plus all 30
`host/test/*.test.mjs` and 21 root `test/*.test.mjs` suites still passing.
Full detail: `reports/07-skills-evidence.md`'s "Task 7.2 SDK-facing wiring —
closed" section and `tasks.md`'s 7.2 entry (now ticked). The 7.2 table row,
the group-7 remaining-work bullet, and the "what this session did NOT do"
bullet below are left as this report's original historical record, each with
a short closing note pointing here rather than being rewritten.

**Second addendum (a later session closed two protocol gaps groups 3 and 5
had left open).** After this report's 5.1–5.4 rows below were written (as
"IN PROGRESS (concurrent session)"), that concurrent session landed
`extension/sidepanel/**`/`extension/settings/**` and reported two real
host-side protocol gaps in `reports/05-panel-evidence.md`'s "Known gaps"
section: no `LIST_CONVERSATIONS`/`DELETE_CONVERSATION` message type, and no
companion-side handler for the already-relayed `agent_settings` messages. A
later session — owning `host/agent/protocol.js`/`companion.js`/`session/**`/
`storage/**` only, never `extension/**` — closed both. See
`reports/03-companion-evidence.md`'s own addendum and
`reports/05-panel-evidence.md`'s "Known gaps ... RESOLVED" section for the
full detail; proof is 6 new tests in `host/test/agent-companion-core.test.mjs`
and 10 new tests in the new `host/test/agent-settings-relay.test.mjs`, with
all 31 `host/test/*.test.mjs` and 23 root `test/*.test.mjs` suites passing.
The 3.2/5.2/5.3 table rows below are left as this report's original,
now-partially-stale record (5.2/5.3 were also independently completed by the
concurrent panel session referenced above, before this protocol-gap fix
existed) — re-run this reconciliation's own table in full rather than trust
either addendum as a substitute for that.

Change: `migrate-to-claude-agent-sdk`. This report reconciles all 49 checkbox
items across `tasks.md`'s 8 task groups against the actual evidence reports
and, where evidence was stale or missing, against direct re-execution and
direct source reading performed in this session. It also records the
specific work this session did: extending and re-running gates 1.4 and 1.6,
and ticking/annotating `tasks.md` to match what is genuinely true today.

**Method**: every DONE/PARTIAL/BLOCKED/NOT STARTED status below is backed by
either (a) an existing evidence report's own executed output, (b) this
session's own re-run of `host/agent/spike/gate.mjs` and the full offline test
suite (captured below), or (c) this session's own direct reading of the
named source file. No status here is asserted without one of those three.
Nothing was ticked to make the count look better — every unticked/BLOCKED/NOT
STARTED row states the exact remaining gap and, where one exists, the exact
command to close it.

## What this session did

1. Extended `host/agent/spike/gates/gate-1.4-isolation.mjs` to exercise the
   now-complete group-3/7 infrastructure: a real `Run`
   (`host/agent/session/run.js`), a real `BrowserLease`
   (`host/agent/broker/browser-lease.js`), a real `ApprovalRegistry`
   (`host/agent/policy/approvals.js`), and the real production
   `host/agent/tools/adapter.js` tool registration/dispatch path (a
   call-counting fake stands in only for the final "call a live browser"
   hop). Proved for real: invalid tab scope rejected at the handler even
   when SDK/zod validation already accepted the call; an approval token
   rejected across a different run and after its own run stops; a stopped,
   superseded run rejected for any further dispatch; the `file_upload`
   filesystem allowlist rejecting/accepting/mixed-rejecting; and the
   enabled-skill-resource canonical-path allowlist
   (`host/agent/skills/session-workspace.js`) rejecting traversal and
   not-approved-but-on-disk skills. Result: **PASS**, no more documented
   gaps for this gate.
2. Extended `host/agent/spike/gates/gate-1.6-onboarding.mjs` to exercise
   skill invocation and companion-side onboarding readiness fully offline
   against the real `host/agent/skills/**` catalog (now that group 7 exists):
   a first-run companion with zero skills, a real imported+enabled fixture
   skill, real dispatch authorization/rejection, and composition into the
   isolated `query()` options contract — while explicitly and precisely
   flagging (in the gate's own output, not just this report) that this does
   NOT yet prove `host/agent/tools/query-options.js` (the real production
   options builder) actually threads skills into a real `query()` call,
   which remains task 7.2's open item. Verified this by directly reading
   `host/agent/tools/query-options.js`: `buildIsolatedOptions()` still
   hard-codes `tools: []` and accepts no skills-related parameter.
3. Re-ran `node host/agent/spike/gate.mjs` (full offline suite, real output
   captured below) and the complete `host/test/*.test.mjs` (28 files) +
   root `test/*.test.mjs` (21 files) suites — all pass, zero failures.
4. **Did not re-run `--live`.** Nothing changed by this session touches the
   live-credential code paths in gates 1.3/1.5, or gate 1.6's `--live`
   branch (only its offline section was extended). `reports/09-live-gate-evidence.md`
   already captured real, current live-run evidence for every credential-
   gated sub-item this session's changes could affect, and re-running would
   only repeat identical billed `POST /v1/messages` calls for no new
   evidence — the task's own instruction to "keep billed requests minimal,
   reuse prior evidence rather than repeating identical calls" applies
   directly here.
5. Reconciled every checkbox in `tasks.md` against the evidence: ticked 1.4
   and 1.5 (now genuinely closed), ticked 8.1 (this session's own full test
   run satisfies its literal scope), corrected 1.3's and 1.6's stale
   annotations, and added precise annotations to every previously-bare
   unticked item across groups 5, 6, 7, and 8.

## Re-run evidence captured this session

```
$ node host/agent/spike/gate.mjs
=== Summary ===
  SDK 0.3.263 / Node v24.19.0
  1.2   PASS                     In-process SDK MCP tools, no user MCP setup
  1.4   PASS                     Rejected shell injection / unknown tools / malformed args; env & config isolation; tab scope, stale/cross-session capabilities, and filesystem allowlists
  1.6   PASS                     Clean-profile onboarding: API-key-only auth, no Claude account dependency
  1.5   PASS_WITH_BLOCKED_SUBITEM Cancellation, reconnect, bounded errors, and an Anthropic endpoint/model round trip
  1.3   BLOCKED                  DOM read/navigate/form-fill/click + screenshot recognition of a randomized fixture

RESULT: no hard failures. See BLOCKED gates above for what needs live credentials/browser.
```

(1.5 shows `PASS_WITH_BLOCKED_SUBITEM` in *offline* mode because this
particular re-run did not pass `--live` — its live round trip was already
proven and captured in `reports/09-live-gate-evidence.md`, reused rather than
re-billed per point 4 above; `tasks.md` reflects the true, already-closed
status.)

```
$ node host/test/*.test.mjs   (28 files)  -> 28/28 pass, 0 failures
  (agent-chunked-transport, agent-companion-core, agent-lease,
   agent-native-handshake, agent-pipe-isolation, agent-protocol,
   agent-real-profile-integration, agent-recorder-push, agent-run-lifecycle,
   agent-tool-adapter, codemode-sandbox-lifecycle, endpoint, identity,
   ownership, parent-watch, recorder-companion-routing, secrets-redaction,
   secrets-store, settings-all, settings-atomic-store,
   settings-capability-test, settings-discovery, settings-http-client,
   settings-live [skips cleanly, no live env var set], settings-models,
   settings-profile, settings-url, skills-catalog, skills-dispatch)

$ node test/*.test.mjs   (21 files)  -> 21/21 pass, 0 failures
  (audit-segments, background-agent-settings-relay, handlers,
   humanize-executor, humanize-planners, registry-baseline,
   registry-borrowed-tab-scope, registry-sdk-mapping, settings-ui-client,
   settings-ui-controller, settings-ui-no-conversation-leak,
   settings-ui-real-companion, settings-ui-secrets, settings-ui-validation,
   sidepanel-conversation-model, sidepanel-fake-companion,
   sidepanel-history-store, sidepanel-markdown-lite, sidepanel-page-context,
   sidepanel-protocol-client, sidepanel-recordings-model)
```

Note on the acceptance criteria's warning that `test/settings-ui-*.test.mjs`
and `test/sidepanel-*.test.mjs` "may fail" because a parallel agent is
actively editing that code: **as of this run, all of them pass.** This is a
snapshot — the parallel session may change this before the change is
finalized — but nothing in this run needed to be reported as broken.

## Full task table (all 49 items)

Legend: **DONE** = fully closed, evidence executed and real (a disclosed,
environment-only sub-blocker does not change this). **PARTIAL** = the task's
own text has more than one requirement and at least one is genuinely closed
while at least one remains open. **BLOCKED** = genuinely cannot proceed
without a named external precondition (live browser, live OS, etc.).
**NOT STARTED** = no evidence of any kind exists for this task.

### Group 1 — SDK integration acceptance gate

| # | Status | Evidence | Blocker / closing command |
|---|---|---|---|
| 1.1 | DONE | `reports/01-sdk-gate-evidence.md` | — |
| 1.2 | DONE | `reports/01-sdk-gate-evidence.md` gate 1.2 | — |
| 1.3 | PARTIAL/BLOCKED | `reports/01-sdk-gate-evidence.md` gate 1.3, `reports/09-live-gate-evidence.md` | Vision/model leg fully closed (live). DOM read/nav/form-fill/click chain is real code, harnessed only (fake extension) — **needs a live browser**. Close: `node host/agent/spike/gate.mjs --live` with a real Chrome/Edge/Brave + extension attached. |
| 1.4 | **DONE** (this session) | `reports/01-sdk-gate-evidence.md` gate 1.4, `host/agent/spike/gates/gate-1.4-isolation.mjs` | — |
| 1.5 | **DONE** (ticked this session; was closed by an earlier session that was barred from editing `tasks.md`) | `reports/01-sdk-gate-evidence.md` gate 1.5, `reports/09-live-gate-evidence.md` | — |
| 1.6 | PARTIAL/BLOCKED | `reports/01-sdk-gate-evidence.md` gate 1.6, `host/agent/spike/gates/gate-1.6-onboarding.mjs` | Onboarding/auth isolation + skill-invocation application logic closed (offline + live credential). Current-page analysis + browser control **need a live browser**. Close: `node host/agent/spike/gate.mjs --live` once a real browser + extension is attached. |

### Group 2 — Stable packaging and native registration

| # | Status | Evidence | Blocker / closing command |
|---|---|---|---|
| 2.1 | DONE | `reports/02-packaging-evidence.md` | — |
| 2.2 | DONE | `reports/02-packaging-evidence.md` | — |
| 2.3 | DONE | `reports/02-packaging-evidence.md` | — |
| 2.4 | DONE (2 sub-items disclosed BLOCKED, ticked with disclosure) | `reports/02-packaging-evidence.md` | Extension reload / browser restart against a real profile, and observing Chrome actually refuse a foreign-id connection, both **need a real browser install**. Close: load the unpacked `extension/` in Chrome/Edge/Brave, confirm the derived id, reload, restart the browser. |

### Group 3 — Companion and SDK browser tools

| # | Status | Evidence | Blocker / closing command |
|---|---|---|---|
| 3.1 | DONE | `reports/03-companion-evidence.md` | — |
| 3.2 | DONE | `reports/03-companion-evidence.md` | — |
| 3.3 | DONE | `reports/03-companion-evidence.md` | — |
| 3.4 | DONE | `reports/03-companion-evidence.md` | — |
| 3.5 | DONE (one honestly-partial nuance disclosed: disconnected-browser handling is error-surfaced per call, not a dedicated pause state machine) | `reports/03-companion-evidence.md` | — |

### Group 4 — Provider settings and model catalog

| # | Status | Evidence | Blocker / closing command |
|---|---|---|---|
| 4.1 | DONE (macOS/Linux secret-store adapters implemented but BLOCKED for execution — no macOS/Linux box) | `reports/04-settings-evidence.md` | Close: `node host/test/secrets-store.test.mjs` on macOS and on Linux with a Secret Service provider running. |
| 4.2 | DONE | `reports/04-settings-evidence.md` | — |
| 4.3 | DONE (TOOL_ERROR/VISION_ERROR trigger conditions verified only against the deterministic fixture — this gateway's real Claude models complied fully, so a genuine tool-decline/vision-rejection was never observed live) | `reports/04-settings-evidence.md`, `reports/09-live-gate-evidence.md` | Not a real gap in this task's own scope (both codes' happy/rejection paths are exercised via the fixture); a live non-compliant model would additionally confirm the live wire shape if one becomes available. |
| 4.4 | DONE | `reports/04-settings-ui-evidence.md` | — |
| 4.5 | DONE (one item disclosed BLOCKED: anything requiring a real installed extension + native-messaging pipe) | `reports/04-settings-ui-evidence.md` | Close: real Chrome/Edge/Brave profile + companion installed + `extension/background.js`'s agent-channel relay wired to the `settings-client.js` contract + a real endpoint credential. |

### Group 5 — Assistant side panel

| # | Status | Evidence | Blocker / closing command |
|---|---|---|---|
| 5.0 | DONE | `reports/05-visual-system.md` | — |
| 5.1 | IN PROGRESS (concurrent session) | none yet | `extension/**` is being actively built by a parallel session right now (`reports/panel-captures/` screenshots exist for connecting/empty/queued/ready states) but has no written evidence report and is outside this session's file scope. Re-run this reconciliation once that session's evidence report lands. |
| 5.2 | IN PROGRESS (concurrent session) | none yet | Same as 5.1. |
| 5.3 | IN PROGRESS (concurrent session) | none yet | Same as 5.1. |
| 5.4 | NOT STARTED | none | Depends on 5.1-5.3. |
| 5.5 | NOT STARTED | none | No evidence report covers this item. |
| 5.6 | NOT STARTED | none | The borrowed-tab SDK-path primitives it would build on already exist (`host/agent/tools/mapping.js`, task 6.1) but the sidepanel-side wiring has no evidence. |
| 5.7 | NOT STARTED | none | Depends on 5.5/5.6. |
| 5.8 | NOT STARTED | none | Depends on 5.1-5.7; `reports/05-visual-system.md` covers only the pre-panel reference screens (task 5.0), not the real panel. |
| 5.9 | NOT STARTED | none | No evidence report covers this item. |
| 5.10 | NOT STARTED | none | No evidence report covers this item. |
| 5.11 | NOT STARTED | none | Depends on 5.9/5.10. |
| 5.12 | NOT STARTED | none | Depends on 5.9-5.11. |
| 5.13 | NOT STARTED | none | No evidence report covers this item. |

### Group 6 — Executor, sandbox, and recorder preservation

| # | Status | Evidence | Blocker / closing command |
|---|---|---|---|
| 6.1 | DONE | `reports/06-preservation-evidence.md`, `reports/06-registry-baseline.md` | — |
| 6.2 | DONE (live wrangler smoke test disclosed BLOCKED) | `reports/06-preservation-evidence.md` | Close: `node host/codemode/test-hybrid.js` (needs `npm install` inside `host/codemode/worker/` + the extension connected). |
| 6.3 | DONE | `reports/06-preservation-evidence.md` | — |
| 6.4 | PARTIAL/BLOCKED | `reports/06-preservation-evidence.md` | Offline-testable parts done. Real CDP round trips/screenshot-vision, real GIF export, real recording+retranscription, real upload/download, real browser handoff all **need live infra**. Close: `node host/agent/spike/gate.mjs --live` (vision/action), `node host/codemode/test-hybrid.js` (code-mode), a real record/stop/retranscribe cycle, a manual `switch_browser` handoff between two installed Chromium browsers. |
| 6.5 | NOT STARTED | none — `reports/06-preservation-evidence.md` explicitly states it is out of that delegation's scope | No evidence report covers this item. |
| 6.6 | NOT STARTED | none | Depends on 6.5. |

### Group 7 — Skills and slash-command support

| # | Status | Evidence | Blocker / closing command |
|---|---|---|---|
| 7.1 | DONE | `reports/07-skills-evidence.md` | — |
| 7.2 | PARTIAL at the time this report was written — **closed by a later session** | `reports/07-skills-evidence.md`, this session's gate-1.6 extension | Application-side logic (catalog, session-workspace materialization, dispatch authorization) DONE and now proven to compose with the isolation contract. **Genuinely open** (verified by reading the source this session): `host/agent/tools/query-options.js`'s `buildIsolatedOptions()` still hard-codes `tools: []` (which would also disable the SDK's `Skill` tool) and takes no `skillsDir`/`allowedSkillNames`/`skillOverrides` parameter. Close: wire `host/agent/skills/index.js`'s `buildSessionSkills()` output (plus `"Skill"` in `tools`) into `buildIsolatedOptions()`/the real `query()` call in group 3's session builder. — **Closed**: see this report's opening addendum and `reports/07-skills-evidence.md`'s "Task 7.2 SDK-facing wiring — closed" section; `tasks.md`'s 7.2 is now ticked. |
| 7.3 | NOT STARTED | `reports/04-settings-ui-evidence.md` confirms the "Skills" nav row was deliberately omitted (no page exists) | Depends on 7.2. |
| 7.4 | PARTIAL | `host/test/skills-catalog.test.mjs` (16/16), `host/test/skills-dispatch.test.mjs` (14/14) — see `reports/07-skills-evidence.md` | Catalog-layer half (duplicates, traversal/symlinks, disabled-skill rejection, unsupported-capability detection) DONE. End-to-end-through-the-SDK half depends on 7.2/7.3. |
| 7.5 | NOT STARTED | none | Depends on 7.2-7.4; also `README.md`/docs are outside this session's file scope. |

### Group 8 — Release validation and migration documentation

| # | Status | Evidence | Blocker / closing command |
|---|---|---|---|
| 8.1 | **DONE** (this session) | This report's "Re-run evidence captured this session" section | Re-run again once groups 5-7 add new suites (this is a repeatable check, not a one-time gate). |
| 8.2 | BLOCKED | none | Needs a live Windows browser install + a completed sidepanel (group 5, in progress). Close after group 5 lands, with a real browser attached. |
| 8.3 | NOT STARTED | none | `README.md`/`install.sh`/`install.ps1` are outside this session's file scope; also premature until groups 5-7 land. |
| 8.4 | NOT STARTED | none | Task's own text requires "full regression acceptance pass" first; groups 5, 6.5/6.6, 7.2-7.5 remain open. This report is a step toward it, not a substitute. |

## Remaining work, grouped by what it needs

**Needs a live browser (extension + native host + real Chromium attached)**
- 1.3 (DOM/nav/form-fill/click legs)
- 1.6 (current-page analysis, browser control legs)
- 6.4 (CDP round trips, GIF export, recording+retranscription, upload/download, browser handoff)
- 8.2 (panel acceptance tests)
- 2.4's two disclosed sub-items (extension reload/browser restart against a real profile; observing Chrome refuse a foreign origin)
- 4.5's one disclosed sub-item (anything needing a real installed extension + native-messaging pipe)
- 6.2's disclosed sub-item (live wrangler smoke test also needs `npm install` in `host/codemode/worker/`)

**Needs live non-Windows hardware**
- 4.1's disclosed sub-item (macOS Keychain / Linux Secret Service adapters — implemented, unexecuted on this OS)

**Needs the concurrent sidepanel session's work to land (extension/**, out of this session's scope)**
- 5.1-5.13 (all of group 5 except 5.0)
- 8.2 (also needs a live browser, above)
- 8.3, 8.4 (also blocked on other groups, above)

**Needs group 3's remaining session-builder integration work**
- ~~7.2 (thread skills into `host/agent/tools/query-options.js`'s real `query()` options)~~ — **closed by a later session, see this report's opening addendum**
- 7.3, 7.4 (depended on 7.2, now unblocked on that front; 7.3 is still `extension/**` UI work, and 7.4's live browser-workflow-skill half still needs a live browser)

**Genuinely not started, no dependency beyond "someone needs to do it"**
- 6.5, 6.6 (external MCP mode preservation — explicitly deferred by the group-6 delegation)
- 7.5, 8.3 (documentation — also outside this session's file scope: `README.md`, `install.sh`, `install.ps1`)

## What this session did NOT do, and why

- Did not touch `extension/**` (manifest, background.js, sidepanel, settings,
  recorder, ui) — explicitly out of scope, a parallel session owns it.
- Did not touch `host/agent/settings/**`, `host/agent/secrets/**`,
  `host/agent/companion.js`, `host/agent/session/**`, `host/agent/broker/**`,
  `host/agent/policy/**`, `host/agent/tools/**`, `host/agent/skills/**`,
  `host/native-host.js` — read extensively (to write correct, precise gate
  tests and tasks.md annotations), never modified.
- Did not fix task 7.2's real gap (wiring skills into
  `host/agent/tools/query-options.js`) — that file is explicitly outside
  this session's ownership; reported here and in `tasks.md`, not silently
  worked around. **A later session closed this gap** — see this report's
  opening addendum.
- Did not re-run `--live` (see "What this session did," point 4).
- Did not tick any group-5 item, despite visible concurrent progress
  (`reports/panel-captures/`) — no evidence report exists yet for that work,
  and ticking without one would be exactly the "tick to make the numbers
  look better" this task explicitly forbids.
