# Tasks 2.1–2.2 — versioned conversation metadata + app/SDK snapshot boundary

Change: `upgrade-agent-reliability-and-workflows`, tasks.md group 2, **tasks
2.1 and 2.2 only**. `design.md` decision 2 (and decision 1 for context).
Built directly on group 0's SDK gate
(`plans/reports/osf-apply-260909-1504-sdk-continuity-gate.md`) and group 1's
document-identity work
(`plans/reports/osf-apply-260909-1642-document-identity-gate.md`,
`plans/reports/osf-apply-260909-1752-document-identity-binding.md`).

## Status

DONE_WITH_CONCERNS — see Concerns below. Nothing in 2.1/2.2 itself is
unfinished; the concern is a pre-existing hazard for 2.5 that this task's own
census surfaced.

## Summary

Defined a versioned conversation-metadata schema (`schemaVersion: 1`) with
secret-free app profile identity, session-schema identity, permission-policy
identity, a reserved (null) SDK session reference, budget policy, lifecycle,
usage epoch, and migration state; wired it into `TranscriptStore` (seeded on
every conversation, including the `appendEvent` auto-vivify path) and
`SessionManager` (migrate-on-read, bind-once-per-conversation); wired
`companion.js` to bind it from the exact values a run already resolved
(profile snapshot, skills binding, built SDK options) after every existing
regression stayed green; and made the app/SDK snapshot boundary an explicit,
tested code contract (`systemPrompt.snapshot: false`) instead of an
incidental default. Migration was proven against 877 real on-disk
conversations from this machine (0 parse failures, 0 throws) plus three
fixture shapes reproduced verbatim from that same real tree.

## Files changed

New:
- `host/agent/storage/conversation-metadata.js` — the schema module: constants, `initConversationMetadataEnvelope()`, `buildAppProfileIdentity()`, `buildSessionSchemaIdentity()`, `buildPermissionPolicyIdentity()`, `migrateConversationMetadata()`.
- `host/test/agent-conversation-metadata.test.mjs` — 78 assertions (schema shape, secret-freedom, migration against three real-shape fixtures, SessionManager wiring against a real on-disk-written legacy record, the `systemPrompt.snapshot:false` boundary, and an end-to-end CompanionCore run proving the bound metadata cannot contain the credential, the SDK system-prompt text, or the run's page URL).

Modified:
- `host/agent/storage/transcript-store.js` — `createConversation()`'s default record now always includes a fresh `conversationMetadata` envelope (covers both `SessionManager.newConversation()` and `appendEvent()`'s auto-vivify fallback).
- `host/agent/session/manager.js` — new `getConversationMetadata()` (migrate-on-read, persists once, no redundant write) and `bindConversationAppSnapshot()` (binds appProfile/sessionSchemaIdentity/permissionPolicy once, mirrors the existing `setSkillsBinding()` once-only contract).
- `host/agent/companion.js` — after `options` is built in `_runAfterLeaseGranted()`, calls `bindConversationAppSnapshot()` with values derived from the SAME `snapshot`/`skills`/`options` the run already used (never a second resolution); wrapped in try/catch, best-effort, never blocks a run.
- `host/agent/settings/profile.js` — additive: `snapshotForRun()` now also returns `credentialRevision` (from the already-tracked, non-secret `profile.credentialRevision` counter). Required because decision 2 names "credential revision" explicitly as part of the secret-free identity and `snapshotForRun()` previously exposed only the whole-profile `revision`, a different counter (bumped by any edit, not just a credential change). No existing consumer's shape assertion broke (verified: `settings-profile.test.mjs`'s "exact contract shape" test only checks `Object.keys(snapshot.env)`, never the top-level key set).
- `host/agent/tools/query-options.js` — `buildIsolatedOptions()`'s `systemPrompt` now sets `snapshot: false` explicitly (was: omitted, relying on the SDK's current default).
- `host/test/settings-profile.test.mjs` — one added test proving `credentialRevision` is a distinct counter from `revision` (unrelated profile edits don't bump it; `setCredential` does).
- `openspec/changes/upgrade-agent-reliability-and-workflows/tasks.md` — checked off 2.1, 2.2 only.

`git status --short` at completion (for the orchestrator — two entries are
**not mine**, a parallel session's in-flight work on this shared branch, left
untouched per scope discipline):
```
 M extension/background.js                                    <- NOT MINE (parallel session)
 M host/agent/companion.js
 M host/agent/session/manager.js
 M host/agent/settings/profile.js
 M host/agent/storage/transcript-store.js
 M host/agent/tools/query-options.js
 M host/test/settings-profile.test.mjs
 M openspec/changes/upgrade-agent-reliability-and-workflows/tasks.md
?? host/agent/storage/conversation-metadata.js
?? host/test/agent-conversation-metadata.test.mjs
?? openspec/changes/side-panel-follows-active-tab/                <- NOT MINE (parallel session)
```

## The metadata schema, and why

`host/agent/storage/conversation-metadata.js`'s envelope (`schemaVersion: 1`):

```
{
  schemaVersion: 1,
  appProfile: { profileId, endpoint, modelId, credentialRevision } | null,
  sessionSchemaIdentity: { cwd, pluginDir, pluginName, configDir,
                            allowedSkillNames (sorted), skillOverrides,
                            settingSources: [] } | null,
  permissionPolicy: { tools, allowedTools, disallowedTools } (each sorted) | null,
  sdkSessionRef: null,                     // reserved for group 2.3+
  budgetPolicy: { maxTurns: null, maxBudgetUsd: null, wallClockDeadlineMs: null },
  lifecycle: "active",                     // "deleted" reserved for 2.3's tombstones
  usageEpoch: 0,                           // group 4/5's counter
  migrationState: { schemaVersion, backfilled, backfilledAt, legacy }
}
```

Field-by-field rationale:

- **`appProfile`** — exactly decision 2's list (profile id, endpoint/model
  identity, credential revision), nothing else. Structurally cannot carry a
  secret: `buildAppProfileIdentity()` only ever destructures `profileId`,
  `baseUrl` (from `snapshot.env.ANTHROPIC_BASE_URL`, never the sibling
  `ANTHROPIC_API_KEY`), `modelId`, `credentialRevision`. Proven by a test
  that JSON-stringifies a real bound envelope and asserts the fake API key
  value, the string `"ANTHROPIC_API_KEY"`, and the run's bound page URL all
  never appear.
- **`sessionSchemaIdentity`** — reproduces, field-for-field, the "concrete
  session-schema-identity inputs" list from the group-0 gate's own evidence
  report (cwd, materialized plugin directory + its fixed name, plugin-
  qualified `allowedSkillNames`, same-keyed `skillOverrides`, fixed
  `settingSources: []`) — not re-derived, because G3b already proved the SDK
  will not gate `resume` on any of this itself; a future compatibility check
  (2.4) needs the application to have recorded it. `pluginName` is reported
  only when the binding actually has a `pluginDir`, so a pre-plugin legacy
  record is never misattributed today's fixed plugin name.
- **`permissionPolicy`** — derived FROM the real `options` object
  `buildIsolatedOptions()` already built for the run (sorted `tools`/
  `allowedTools`/`disallowedTools`), not a hand-maintained constant — it can
  never silently drift from what the run actually got.
- **`sdkSessionRef`** — deliberately left `null` everywhere in this task.
  `companion.js` still never reads `session_id` off the SDK's `init`
  message (confirmed unchanged: only one `message.type === "system"` check
  exists, for `slash_commands`). Populating this, and the "per-turn id / SDK
  message/result identity" decision 2's last sentence also names, is 2.3's
  atomic-ownership job — out of this task's scope by instruction.
- **`budgetPolicy`** — all-null defaults; group 5 populates real values.
  Included now only so the schema shape is stable before that lands.
- **`lifecycle`** — `"active"` always, in this task. `"deleted"` is reserved
  for 2.3's tombstone semantics; nothing here writes it (conversation
  deletion today still works exactly as before — whole-directory removal in
  `SessionManager.deleteConversation()`, untouched).
- **`usageEpoch`** — `0` always, in this task; group 4/5's counter to
  increment.
- **`migrationState`** — `{schemaVersion, backfilled, backfilledAt, legacy}`.
  A freshly created conversation gets `backfilled: false, legacy: false`; a
  record migrated from a pre-existing on-disk shape gets `backfilled: true,
  legacy: true` plus a real timestamp. This is itself the "migration state"
  field 2.1 asks for.

## App vs. SDK snapshot boundary (2.2)

The "SDK persisted prompt/system snapshot" decision 2 says never to conflate
with the app snapshot is a real, named SDK mechanism, not a metaphor: the
pinned SDK's `Options.systemPrompt.snapshot` boolean (sdk.d.ts ~2192–2220) —
when `true`, the CLI records the system prompt once and replays it verbatim
on every later request and `resume`/`continue`. This project's system prompt
always embeds the run's current bound page/document context
(`renderPageContextSystemPrompt`), so recording it would freeze stale page
identity across every future resumed turn — the exact failure decision 2
forbids.

Before this task, `buildIsolatedOptions()` simply omitted the `snapshot` key,
which today defaults to "off" — correct by accident, not by contract, and
the SDK's own doc block says recording is "rolling out" and "recommended"
long-term. `query-options.js` now sets `snapshot: false` explicitly. A new
test asserts the field is the strict boolean `false` (not merely `!== true`)
and that two runs bound to different page contexts produce two different
rendered `systemPrompt.prompt` strings — i.e. nothing is cached or frozen
per conversation.

The app-snapshot half of the boundary is structural, not just documented:
`conversation-metadata.js`'s builders only ever accept the specific
non-secret, non-page fields listed above — there is no code path by which a
credential, a page URL, or rendered system-prompt text could reach the
persisted `conversationMetadata` envelope. Proven directly (not just
asserted) by the end-to-end CompanionCore test.

Wiring `requireBinding`/`mintExecutionNonce`/`beginAuthorizedNavigation` from
group 1's `extension/events/document-identity.js` into send/lease/read/
mutation (so "fresh page/document context" is actually *enforced*, not just
possible) remains groups 2.3+/3/7's job, per the orchestrator's own framing
— this task only had to make that separation exist at the snapshot-boundary
level, which it now does.

## Migration — tested against real pre-existing shapes, not invented ones

Three fixture shapes in the new test file are typed verbatim from real
`meta.json` files read directly off this machine's own
`~/.config/browzy-in-chrome/agent/conversations/` tree during this task's own
investigation (chosen: newest, oldest, and a never-run conversation):

1. **No `skillsBinding` at all** (a conversation created but never run).
2. **Pre-plugin `skillsBinding`** (`skillsDir` under `.claude/skills`, no
   `pluginDir`/`configDir` — predates the skills-plugin mechanism).
3. **Plugin-era `skillsBinding`** (`pluginDir`+`configDir` present,
   plugin-qualified `allowedSkillNames`).

All three migrate without throwing; `appProfile` stays `null` in every case
(never reconstructed); `sessionSchemaIdentity` is correctly derived from
whatever `skillsBinding` existed (or `null` when none did);
`migrationState.legacy` is `true` for all three.

Beyond the fixtures, a **read-only census script** (scratchpad-only, not
committed, never touches the repo) loaded the real `migrateConversationMetadata()`
and ran it — read-only, zero writes — over **every** real conversation
directory on this machine:

```
{ total: 877, parseFail: 0, throwCount: 0,
  noBinding: 137, prePlugin: 624,
  pluginNoConfigDir: 45, pluginWithConfigDir: 71 }
```

Zero parse failures, zero throws across all 877 real records. `SessionManager`
integration is additionally proven against a real on-disk write (not just the
pure function): a raw pre-plugin `meta.json` is written directly to a scratch
conversation directory, `getConversationMetadata()` migrates and persists it,
a byte-identical second read confirms no re-migration, and the on-disk
`updatedAt` timestamp is confirmed unchanged across the second read (proving
no redundant write — `updateMeta()` has millisecond resolution, so the test
sleeps 5ms between reads to make a spurious write detectable).

Migration is **lazy**: it only runs (and only writes) the first time
`getConversationMetadata()` is called for a given conversation. Listing
conversations (`listConversations()`/`conversationSummaries()`, used by the
history screen) never touches `conversationMetadata` and triggers zero
migration writes.

## What 2.3+ inherits (deliberately not built here)

- `sdkSessionRef` population (capturing `session_id` from the SDK's `init`
  message) and the actual `resume`/`persistSession`/`forkSession` wiring.
- The "per-turn id / SDK message/result identity" record decision 2's last
  sentence names, stored in the transcript/session storage.
- `lifecycle: "deleted"` tombstone semantics and atomic compare-and-set
  ownership.
- `usageEpoch` increments on SDK-total resets.
- Resume-compatibility rejection (2.4) actually consuming
  `sessionSchemaIdentity`/`appProfile`/`permissionPolicy` to accept/reject a
  resume — this task only made those fields exist and be comparable
  (sorted, stable).

## Test output (real, this session)

New file, standalone:
```
node host/test/agent-conversation-metadata.test.mjs
-> 78 assertions, ALL CONVERSATION METADATA TESTS PASSED
```

Extended existing file, standalone:
```
node host/test/settings-profile.test.mjs
-> 17/17 passed (1 new: credentialRevision distinct-counter proof)
```

Full suites, this session, real output:
```
for t in test/*.test.mjs; do node "$t" || break; done        -> 62 files, 0 failures
for t in host/test/*.test.mjs; do node "$t" || break; done   -> 49 files (48 + 1 new), 0 failures
```
Combined: 111 files, 0 failures — no regression from the group-0/1 baseline
of 62+48=110; the one added file accounts for the difference.

## Tasks checked off, with evidence

- **2.1** — `host/agent/storage/conversation-metadata.js` (schema + builders
  + migration), `host/agent/storage/transcript-store.js` (seeded by
  default), `host/agent/session/manager.js` (`getConversationMetadata`/
  `bindConversationAppSnapshot`), `host/agent/settings/profile.js`
  (`credentialRevision`). Evidence: `host/test/agent-conversation-metadata.test.mjs`
  sections 2.1a–2.1f, `host/test/settings-profile.test.mjs`'s new case, and
  the 877-record real-data census above.
- **2.2** — `host/agent/tools/query-options.js` (`snapshot: false` explicit),
  `host/agent/companion.js` (app-snapshot bind point, secret/page-context
  structurally excluded). Evidence: `host/test/agent-conversation-metadata.test.mjs`
  sections 2.2a–2.2b (strict-boolean assertion, cross-run prompt-divergence
  proof, and the end-to-end CompanionCore test proving the bound metadata
  cannot contain the credential, the SDK system-prompt text, or the page
  URL).

## Concerns for the controller

**A pre-existing hazard for 2.5 ("legacy conversations"), found but not
fixed here — out of this task's scope, surfacing it rather than touching
it:** the real census above found **45** on-disk conversations with a
plugin-era `skillsBinding` (`pluginDir` present) but **no** `configDir`
(`pluginNoConfigDir: 45`). `companion.js`'s existing `_bindSkillsForRun()`
configDir-backfill only checks `!existing.configDir` and fixes exactly that
— it does not touch `pluginDir`. Separately, and more sharply: the **624**
`prePlugin` records (no `pluginDir` at all) will, on their next real run,
pass the configDir backfill and reach `buildIsolatedOptions()` with
`skills.pluginDir === undefined`, producing
`plugins: [{ type: "local", path: undefined, skipMcpDiscovery: true }]`.
`buildIsolatedOptions()` validates `skills.cwd` and `skills.configDir` are
present but never validates `skills.pluginDir`. This is not a defect I
introduced and not in 2.1/2.2's scope to fix (it is squarely "legacy
conversations ... require an explicit new context/session choice," 2.4/2.5's
job) — flagging it now because this task's own real-data census is what
surfaced the exact count, and 2.4/2.5 will need it.

No other concerns. `extension/background.js` and
`openspec/changes/side-panel-follows-active-tab/` in `git status` are a
parallel session's in-flight work on this shared branch — confirmed
untouched by this session, left alone per scope discipline.
