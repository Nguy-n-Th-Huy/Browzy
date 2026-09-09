# Skills catalog and dispatch-authorization — evidence report

Change: `migrate-to-claude-agent-sdk`, tasks.md group 7 (task 7.1 in full, plus
the application-owned half of 7.2 — session-workspace materialization and
the pre-SDK dispatch gate). The Settings/slash-picker UI (7.3), UI-dependent
tests (7.4), and documentation (7.5) are explicitly out of scope for this
report and remain unticked in tasks.md.

Everything below was run for real, on this machine, against real
temp-directory fixture skill packages on disk — no mocked filesystem, no
live Anthropic API call (none is needed or available in this session; every
requirement in scope is testable offline).

## Environment

| | |
|---|---|
| Date | 2026-09-06 |
| Platform | win32 x64 (Windows 11), PowerShell/Git Bash |
| Node.js | same host runtime used by `host/test/*.test.mjs` |

Reproduce:

```
node host/test/skills-catalog.test.mjs
node host/test/skills-dispatch.test.mjs
node host/test/endpoint.test.mjs
node host/test/parent-watch.test.mjs
node host/test/ownership.test.mjs
```

## What was built

```
host/agent/skills/
  paths.js              filesystem layout (skills/catalog.json, skills/snapshots/<name>/)
  errors.js             SkillValidationError, SkillPathError, SkillCapabilityError,
                         SkillDispatchError, SkillSnapshotMismatchError, SkillNotFoundError
  frontmatter.js         minimal SKILL.md frontmatter reader (no YAML dependency added -
                         host/package.json is out of scope for this task)
  capabilities.js        two independent unsupportedCapabilities signals (declared +
                         content-detected) plus the skillOverrides mapping - see the
                         "SDK reconciliation" section below
  hash.js                deterministic sha256 over the validated, sorted file list
  source-scan.js         validated recursive walk: symlink/junction escape checks,
                         path-containment checks, never executes anything it finds
  catalog-store.js       atomic write-then-rename JSON store (mirrors the pattern in
                         host/agent/storage/transcript-store.js, independently implemented -
                         see "Design decisions" below for why it is not imported directly)
  import.js               importSkill(), refreshSkill()
  manage.js               listCatalog(), getSkill(), enableSkill(), disableSkill(), removeSkill()
  session-workspace.js    buildSessionSkills(), assertCanonicalSkillResourcePath()
  dispatch.js             assertSlashDispatchAllowed(), assertResumeSnapshotAvailable()
  index.js                public facade (the interface contract group 3 consumes)

host/test/skills-catalog.test.mjs    16 checks (task 7.1)
host/test/skills-dispatch.test.mjs   14 checks (task 7.2's application half)
```

## Catalog schema (persisted in `skills/catalog.json`)

```jsonc
{
  "version": 1,
  "skills": [
    {
      "name": "my-skill",              // canonical id; also the snapshot dir name;
                                        // validated against ^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$
      "description": "…",
      "source": "C:\\Users\\...\\my-skill", // absolute original folder — informational only,
                                             // re-read ONLY on an explicit refresh() call
      "snapshotId": "my-skill",
      "hash": "sha256:…",              // over the validated (symlink-resolved) file list
      "version": "1.0.0" | null,       // from SKILL.md frontmatter, optional
      "enabled": false,
      "userInvocable": true,           // product-owned catalog flag, defaults to true on
                                        // import; adjustable via setInvocationFlags() — NOT
                                        // sourced from any SKILL.md frontmatter field (see
                                        // "SDK reconciliation" below)
      "modelInvocable": true,          // same: product-owned, defaults true, via setInvocationFlags()
      "unsupportedCapabilities": [],   // merged from two independent signals — an optional,
                                        // tolerated `allowed-tools` frontmatter hint, and
                                        // unconditional content-based script/executable
                                        // detection — see "SDK reconciliation" below
      "importedAt": 1234567890,
      "updatedAt": 1234567890
    }
  ]
}
```

`listCatalog()` returns every imported skill (enabled or not) with this
shape, a superset of the interface contract's minimum fields
(`name, description, source, snapshotId, hash, enabled, userInvocable,
modelInvocable`) — extra fields are additive and safe for a consumer that
destructures only the documented ones.

## SDK reconciliation (supersedes this report's original "Design decisions" item 2)

This section replaces an earlier version of this report, which flagged
`allowed-tools`/`user-invocable`/`disable-model-invocation` SKILL.md
frontmatter fields as an unverified guess pending network/docs access. The
coordinator subsequently read the pinned SDK's own installed source
directly (`host/node_modules/@anthropic-ai/claude-agent-sdk`, version
**0.3.263**, matching `host/package.json`'s pin and the group-1 SDK-gate
evidence) and reported concrete findings, independently re-verified in this
session with the same commands:

- `grep -roh "allowed-tools\|allowed_tools" .` across the entire installed
  package: **zero hits**. The 22 `allowedTools` hits that do exist are all
  the `query()`-level option, not a SKILL.md frontmatter field.
- `grep -rn "disable-model-invocation\|disable_model_invocation" .`:
  **zero hits**.
- `grep -rn "user-invocable" .`: the only hits are `sdk.d.ts:5979`'s
  docstring for a session-level option (see below) and its literal value
  string `'user-invocable-only'` inside `sdk.mjs`'s minified bundle — no
  per-package frontmatter field by this name exists anywhere.
- **`sdk.d.ts:2108`** (the pinned package's actual file, this line number
  re-confirmed in this session): a `query()` option,
  `skills?: string[] | 'all'`, whose docstring is quoted here verbatim
  because it is the direct justification for this module's whole
  architecture:

  > "This is a context filter, not a sandbox: unlisted skills are hidden
  > from the model's listing and rejected by the Skill tool, but their
  > files remain on disk and are reachable via Read/Bash. Do not store
  > secrets in skill files."

  This is independent, SDK-authored confirmation that copying only enabled,
  approved snapshots into the per-session `.claude/skills/` workspace (this
  module's actual security boundary) and enforcing
  `assertSlashDispatchAllowed()` application-side (never trusting SDK
  discovery as authorization) is the right architecture — the SDK says so
  itself, in its own option's docstring.

- **`sdk.d.ts:5979`**: another `query()` option,
  `skillOverrides?: { [k: string]: 'on' | 'name-only' | 'user-invocable-only' | 'off' }`,
  docstring: "Per-skill listing overrides keyed by skill name. `name-only`
  lists the skill without its description; `user-invocable-only` hides it
  from the model but keeps `/name`; `off` hides it from both. Absent = on."
  This is a **session-level presentation override the host sets**, not a
  per-package self-declaration — confirming that skill invocability is a
  host/application concern, not something a skill package declares about
  itself in its own frontmatter.

**What changed as a result:**

1. `userInvocable`/`modelInvocable` are no longer read from SKILL.md
   frontmatter at all (they never had SDK backing for that). They are now
   plain product-owned catalog flags: `import.js` defaults both to `true`
   on a fresh import, and `manage.js`'s new `setInvocationFlags(name,
   { userInvocable, modelInvocable })` — a catalog lifecycle operation
   alongside enable/disable/refresh/remove, not a UI concern — is how they
   change afterward (the eventual Settings > Skills UI, task 7.3, is the
   expected caller, but the mutation itself belongs with this catalog
   layer). `refreshSkill()` never touches them; a content refresh does not
   silently change who may invoke a skill.
2. `buildSessionSkills()` now also returns a fourth field, `skillOverrides:
   Record<string, string>`, mapping this catalog's own flags onto the SDK's
   real `skillOverrides` values via `capabilities.js`'s
   `toSkillOverrideValue(userInvocable, modelInvocable)`:
   - `true, true` → `"on"` (exact match)
   - `false, false` → `"off"` (exact match)
   - `true, false` (explicit-only, never auto-invoked) → `"user-invocable-only"`
     (exact match — this is literally what the SDK docstring describes)
   - `false, true` (hidden-from-picker, automatic-only) → **no SDK value
     expresses this** (the closest, `user-invocable-only`, means the
     opposite — hidden from the model, kept for the user). The documented
     fallback is `"on"` (preserves the model-visibility we actually need);
     the real enforcement for the user-facing side is
     `assertSlashDispatchAllowed()`'s `NOT_USER_INVOCABLE` check, which
     never depends on `skillOverrides` at all. This exact case is what
     `sdk.d.ts:2108`'s "context filter, not a sandbox" warning is about:
     the SDK's own presentation controls are not a security boundary, so a
     gap in what they can express is not a gap in this module's actual
     enforcement.
   Both `allowedSkillNames` (→ SDK `skills` option) and `skillOverrides`
   (→ SDK `skillOverrides` option) are additive fields group 3's session
   builder can pass straight into `query()`; `catalogSnapshot` remains the
   only array `assertSlashDispatchAllowed()` itself trusts.
3. Capability detection (the "unsupported capability" gate) no longer
   depends on the `allowed-tools` frontmatter key at all for its security
   property, though that key is still read and honored if a package
   happens to carry one (it is a real convention some skill packages use in
   the wild — its **absence is normal, not missing metadata**, and it is no
   longer presented as SDK-verified). `capabilities.js` now has two
   independent signals, merged by `import.js`/`refreshSkill()`:
   - `computeDeclaredCapabilities(allowedTools)` — the original
     frontmatter-declared signal, unchanged in mechanism.
   - `detectContentCapabilities(files)` — new, unconditional: inspects the
     package's actual files (script/executable extensions -
     `.sh/.bash/.zsh/.ps1/.psm1/.cmd/.bat/.vbs/.py/.rb/.pl/.exe/.com/.msi` -
     or a `#!` shebang on an extensionless file) regardless of what any
     frontmatter says. A package cannot obtain shell/write capability by
     simply omitting `allowed-tools` — proven directly by the new
     "a package with no tools frontmatter still imports, and still cannot
     obtain shell/write capability" test below, which ships a real `.sh`
     script with zero `allowed-tools` field and confirms it still gets
     flagged and still cannot be enabled. The companion "a plain package
     with neither tools frontmatter nor script content imports and enables
     cleanly" test proves the flip side: absence of both signals is a
     normal, enableable skill, not an error.

## Interface contract delivered to group 3

`host/agent/skills/index.js` exports exactly the three functions named in
the task brief, with the documented signatures:

- `async function listCatalog()` → the full catalog (enabled + disabled),
  for display and dispatch filtering.
- `async function buildSessionSkills(sessionWorkspaceDir)` → `{ skillsDir,
  allowedSkillNames, catalogSnapshot, skillOverrides }`. Materializes only
  `enabled === true && unsupportedCapabilities.length === 0` snapshots under
  `${sessionWorkspaceDir}/.claude/skills/`. `catalogSnapshot` is a deep
  clone, so a later catalog mutation can never retroactively change what an
  already-built session believes its bound snapshot looked like.
  `skillOverrides` (added during the SDK-reconciliation pass below) maps
  each materialized skill's name to the SDK's real `skillOverrides` query()
  value, for group 3 to pass straight through alongside `allowedSkillNames`.
- `function assertSlashDispatchAllowed(commandName, catalogSnapshot)` →
  returns the matching entry or throws `SkillDispatchError` with code
  `UNKNOWN_COMMAND`, `DISABLED`, `NOT_USER_INVOCABLE`, or
  `UNSUPPORTED_CAPABILITY`. Checks ONLY the caller-supplied
  `catalogSnapshot` array — it has no filesystem or SDK dependency, so it
  cannot be fooled by anything the SDK discovers on disk that isn't in that
  array.

Two bonus exports beyond the mandatory three, both documented at their
definition as optional integration points for whichever code ends up owning
conversation resume and Read-tool dispatch (group 3):

- `assertResumeSnapshotAvailable(boundCatalogSnapshot)` — re-checks a
  resumed conversation's bound snapshot against the live catalog; throws
  `SkillSnapshotMismatchError` with a per-skill reason (`removed`,
  `disabled`, `changed`) if anything drifted.
- `assertCanonicalSkillResourcePath(skillsDir, allowedSkillNames,
  requestedPath)` — canonical-path enforcement for a Read into a session's
  materialized skill snapshot, meant to be called by whichever code
  implements the Read tool handler, on every access (not only at import).

## Design decisions worth flagging explicitly

1. **No YAML dependency.** `host/package.json`/lockfile are out of scope for
   this task (owned by the group-1 SDK-gate work). `frontmatter.js`
   implements a deliberately minimal "flat key: value, booleans, quoted
   strings, one inline `[a, b]` list" parser — anything it cannot parse with
   confidence (nested mappings, multi-line scalars) is rejected as
   `INVALID_METADATA` rather than guessed at.
2. **(Reconciled — see "SDK reconciliation" above.)** An earlier version of
   this report flagged `allowed-tools`/`user-invocable`/
   `disable-model-invocation` as unverified guesses at real SDK frontmatter
   fields. They are not: the pinned SDK (0.3.263) defines none of them.
   Capability detection is now content-based-first (unconditional) with
   `allowed-tools` as a tolerated, non-authoritative bonus signal, and
   invocability is a product-owned catalog flag mapped onto the SDK's real
   `skillOverrides` query() option. See "SDK reconciliation" above for the
   full findings, citations, and code changes.
3. **`host/agent/skills/paths.js` does NOT import
   `host/agent/storage/paths.js`.** Both independently compute the same
   `OCIC_AGENT_HOME`-rooted directory convention (a ~10-line duplication).
   This is deliberate: `host/agent/storage/**` is owned by a different,
   concurrently active work stream (group 3) per this task's scope
   boundaries, and importing a file another session may be actively
   rewriting is a real risk during parallel work, not a hypothetical one —
   see the orchestration-protocol guidance on avoiding cross-session
   coupling. Both modules compute the exact same root formula, so they
   never collide on disk; they just don't share code to get there.
4. **Refresh overwrites the same shared snapshot directory in place**
   (staged, then swapped in with two renames, old copy removed only after
   the swap succeeds). This is safe for an active run because
   `buildSessionSkills()` already COPIED the snapshot into the session's own
   private `.claude/skills/` directory at session-build time — an active run
   never reads the shared `skills/snapshots/` store again after that point,
   so a later `refreshSkill()` there cannot reach back into it. This is
   proven directly by the "refresh re-hashes and does not disturb an
   already-built session snapshot" test below, not merely asserted.
5. **Disabling a skill's effect on an already-active run** ("active affected
   runs SHALL be interrupted before another dispatch") is explicitly a
   session/run-lifecycle concern, not implemented here — `disableSkill()`'s
   contract ends at making the catalog change immediately visible to
   `listCatalog()`, `assertSlashDispatchAllowed()` (via a live
   `catalogSnapshot` the session builder should re-derive per dispatch if it
   wants live disable to interrupt), and the next `buildSessionSkills()`
   call. Group 3 owns run/interrupt lifecycle (tasks.md 3.5).

## Rejection table (task 7.1's "reject with a specific, actionable error")

| Input condition | Error class | Code | Tested |
|---|---|---|---|
| Missing `SKILL.md` | `SkillValidationError` | `INVALID_METADATA` | yes |
| `SKILL.md` with no `---` frontmatter delimiters | `SkillValidationError` | `INVALID_METADATA` | yes |
| Frontmatter missing `name` | `SkillValidationError` | `INVALID_METADATA` | yes |
| Frontmatter missing `description` | `SkillValidationError` | `INVALID_METADATA` | yes |
| Frontmatter line the flat parser can't parse (nested mapping) | `SkillValidationError` | `INVALID_METADATA` | yes |
| `name` already used by another imported skill | `SkillValidationError` | `DUPLICATE_NAME` | yes |
| `name` contains `/`, `\`, or `..` | `SkillValidationError` | `PATH_TRAVERSAL` | yes |
| Package contains a symlink/junction resolving outside its root | `SkillValidationError` | `SYMLINK_ESCAPE` | yes |
| Enabling a skill whose `allowed-tools` frontmatter requests an unsupported tool | `SkillCapabilityError` | `UNSUPPORTED_CAPABILITY` | yes |
| Enabling a skill whose files are script/executable content, `allowed-tools` present or not | `SkillCapabilityError` | `UNSUPPORTED_CAPABILITY` | yes |
| Unknown slash command | `SkillDispatchError` | `UNKNOWN_COMMAND` | yes |
| Disabled skill dispatched by name | `SkillDispatchError` | `DISABLED` | yes |
| Non-user-invocable skill dispatched explicitly | `SkillDispatchError` | `NOT_USER_INVOCABLE` | yes |
| Dispatch of a skill flagged with an unsupported capability | `SkillDispatchError` | `UNSUPPORTED_CAPABILITY` | yes |
| Read path resolving outside a session's skill snapshot | `SkillPathError` | `PATH_TRAVERSAL` | yes |
| Read path naming a skill not in this session's `allowedSkillNames` | `SkillPathError` | `PATH_TRAVERSAL` | yes |
| Resumed conversation's bound skill removed/disabled/changed | `SkillSnapshotMismatchError` | `SNAPSHOT_UNAVAILABLE` | yes |

## Windows symlink-escape testing note

Real symlink creation (`fs.symlinkSync(target, link)`, non-junction) needs
`SeCreateSymbolicLinkPrivilege` or Developer Mode on Windows, neither
guaranteed in this session. The equivalent real mechanism used instead: an
**NTFS junction** (`fs.symlinkSync(target, link, "junction")`), which needs
only write access to the parent directory. Node reports a junction via
`Dirent.isSymbolicLink() === true` and `fs.realpathSync()` resolves it
exactly like a true symlink, so `source-scan.js`'s symlink-escape check
(which uses exactly those two APIs) exercises the identical code path a real
symlink would. This was verified to actually work on this machine without
elevation — the "symlink escaping the package root rejected (Windows
junction)" test below passed on the first real run, not simulated.

## Test run — `node host/test/skills-catalog.test.mjs` (task 7.1)

```
Skills catalog (task 7.1)

  PASS  valid import + enable + survives restart (real subprocess re-read)
  PASS  malformed metadata rejected: missing SKILL.md
  PASS  malformed metadata rejected: no frontmatter delimiters
  PASS  malformed metadata rejected: missing name
  PASS  malformed metadata rejected: missing description
  PASS  malformed metadata rejected: unparseable frontmatter line
  PASS  duplicate name rejected, first import untouched
  PASS  path traversal via frontmatter name rejected before any write
  PASS  symlink escaping the package root rejected (Windows junction)
  PASS  import never executes scripts found in the package
  PASS  removal leaves the source directory intact
  PASS  refresh re-hashes and does not disturb an already-built session snapshot
  PASS  a skill requiring an unsupported capability cannot be enabled
  PASS  a package with no tools frontmatter still imports, and still cannot obtain shell/write capability
  PASS  a plain package with neither tools frontmatter nor script content imports and enables cleanly
  PASS  canonical-path enforcement blocks reads outside the session snapshot

16/16 passed
```

Notes on what each of these actually proves (not just that it passed):

- **"valid import + enable + survives restart"** spawns a genuinely separate
  Node child process (`spawnSync`, not an in-process re-import) pointed at
  the same `OCIC_AGENT_HOME`, so "survives restart" is proven against a
  process with nothing carried over in memory, not just a fresh function
  call in the same process.
- **"import never executes scripts"** ships a real `.cmd`/`.sh` script whose
  content, if actually executed, would write a canary file to a path
  outside the skill folder; the test asserts that file was never created,
  while separately asserting the script bytes themselves WERE copied
  byte-identical into the snapshot (proving it was treated as inert data,
  not executed and not stripped). It also now asserts
  `unsupportedCapabilities` is non-empty for this fixture, since it ships
  real scripts — the content-based detector catches it independently of the
  fact that this fixture never sets `allowed-tools`.
- **"a package with no tools frontmatter still imports, and still cannot
  obtain shell/write capability"** (added during SDK reconciliation) is the
  test the coordinator specifically asked for: a package with a real `.sh`
  script and zero `allowed-tools` field still imports successfully (absence
  of the field is not treated as invalid metadata) but is still flagged and
  still cannot be enabled — proving the security property does not depend
  on that optional frontmatter key.
- **"a plain package with neither tools frontmatter nor script content..."**
  is the flip side: an ordinary package with no `allowed-tools` and no
  script-like files imports with an empty `unsupportedCapabilities` and
  enables without error — proving detection does not over-flag ordinary
  packages.
- **"path traversal ... rejected before any write"** additionally asserts
  the literal filesystem location the traversal targeted
  (`path.resolve(skillsRoot, "..", "..", "evil")`) does not exist afterward
  — not just that an error was thrown.
- **"symlink escaping ... rejected"** additionally recursively scans the
  entire skills root afterward for the outside folder's secret content
  string and asserts zero hits.
- **"refresh re-hashes and does not disturb an already-built session
  snapshot"** builds three separate session workspaces around a source edit
  and a refresh call, and asserts each one's on-disk resource content
  independently (session built before refresh keeps old content forever;
  session built between the source edit and the refresh call still gets old
  content, proving "changed source takes effect only after an explicit
  refresh"; session built after refresh gets new content).

## Test run — `node host/test/skills-dispatch.test.mjs` (task 7.2, application half)

```
Skills dispatch authorization (task 7.2)

  PASS  rejects an unknown command not present in the bound snapshot
  PASS  rejects a disabled command, even though its metadata is otherwise valid
  PASS  rejects an enabled but non-user-invocable command on explicit slash dispatch
  PASS  rejects a command flagged with an unsupported capability
  PASS  allows an enabled, user-invocable command and normalizes leading slash + arguments
  PASS  empty or missing command name is rejected, not silently allowed
  PASS  a hidden automatic-only skill materializes for the model but is rejected on explicit dispatch
  PASS  toSkillOverrideValue matches the pinned SDK's skillOverrides values exactly where one exists
  PASS  buildSessionSkills emits the correct skillOverrides for an explicit-only (model-hidden) skill
  PASS  buildSessionSkills emits "off" for a skill enabled but invocable by neither surface
  PASS  assertResumeSnapshotAvailable passes for an unchanged bound snapshot
  PASS  assertResumeSnapshotAvailable reports a disabled skill and requires a new conversation
  PASS  assertResumeSnapshotAvailable reports a changed (refreshed) skill
  PASS  assertResumeSnapshotAvailable reports a removed skill

14/14 passed
```

The "hidden automatic-only skill" test is the one that most directly proves
the spec's user-invocable/model-invocable interaction: a real imported,
enabled skill with `userInvocable: false` (set via `setInvocationFlags()`,
now a product-owned catalog operation — see "SDK reconciliation" above) IS
materialized by `buildSessionSkills()` into `allowedSkillNames`/
`.claude/skills/` (so the SDK can still auto-invoke it), with
`skillOverrides["auto-only-skill"] === "on"` (the documented SDK-mapping
fallback for this exact combination), but `assertSlashDispatchAllowed()`
still rejects an explicit `/auto-only-skill` dispatch with
`NOT_USER_INVOCABLE` — proving the two mechanisms are independent, and that
enforcement never actually depends on what `skillOverrides` says, exactly as
design.md requires and as `sdk.d.ts:2108`'s own "context filter, not a
sandbox" warning anticipates. The three `toSkillOverrideValue`/
`skillOverrides` tests directly verify the mapping against the pinned SDK's
own four documented values, including the two combinations that map
exactly (`user-invocable-only`, `off`) and the one that has no SDK
equivalent (documented fallback to `on`).

## Existing suites — unaffected (task acceptance criteria)

```
$ node host/test/endpoint.test.mjs
7/7 passed

$ node host/test/parent-watch.test.mjs
3/3 passed

$ node host/test/ownership.test.mjs
12/12 passed
```

No file outside `host/agent/skills/**`, `host/test/skills-*.test.mjs`, this
report, and the two `tasks.md` line edits was created or modified by this
session (`git status --porcelain -- host/agent/skills host/test/skills-catalog.test.mjs host/test/skills-dispatch.test.mjs`
shows exactly those three untracked paths; no other file shows as modified
by this session's work).

## Task 7.2 SDK-facing wiring — closed

A later session (`reports/10-task-reconciliation.md`) verified, by directly
reading `host/agent/tools/query-options.js`, that everything above this
section had been built and tested but never actually reached a real
`query()` call: `buildIsolatedOptions()` hard-coded `tools: []` (which also
disabled the SDK's own `Skill` tool) and accepted no skills-related
parameter at all. This section records how that gap was closed, by the
session that did the closing.

**What changed** (files owned by that session: `host/agent/tools/query-options.js`,
`host/agent/session/**`, `host/agent/companion.js`; this catalog module
itself, `host/agent/skills/**`, was consumed as-is with no changes needed —
its documented interface contract already had every field group 3 needed):

1. `host/agent/tools/query-options.js`'s `buildIsolatedOptions()` now
   **requires** a `skills` parameter — `{ cwd, allowedSkillNames,
   skillOverrides }` — and throws if it is missing, so a run can no longer
   silently reach `query()` without ever having gone through the skills
   catalog/materialization/binding path. It sets:
   - `cwd: skills.cwd` — the session workspace directory `buildSessionSkills()`
     was called with, so `${cwd}/.claude/skills/` (where approved snapshots
     were actually materialized) is what the SDK's `skills` discovery
     resolves against, not the companion process's own shared `process.cwd()`.
   - `tools: ["Skill"]` — the only built-in added to the isolated baseline.
     `sdk.d.ts:2087`'s "you do not need to add 'Skill' to allowedTools
     yourself" refers to the deprecated `allowedTools` field, not the `tools`
     allowlist this isolation contract actually uses to gate which built-ins
     exist at all — `Skill` must be listed there explicitly.
   - `skills: [...skills.allowedSkillNames]` and `skillOverrides: {
     ...skills.skillOverrides }` — passed straight through from
     `buildSessionSkills()`'s output, unmodified.
   - `disallowedTools` (HIGH_RISK_BUILTINS: Bash/Write/Edit/Task/WebFetch/
     WebSearch/NotebookEdit) and `settingSources: []`/`strictMcpConfig: true`
     are untouched — the isolation contract gate-1.6 already proved is
     unaffected by adding skills.
2. `host/agent/companion.js` gained `_bindSkillsForRun(conversationId)`:
   on a conversation's first run, calls the real `buildSessionSkills()`
   against that conversation's own on-disk workspace
   (`host/agent/storage/paths.js`'s `conversationDir()`) and persists the
   result via two new `SessionManager` methods
   (`getSkillsBinding`/`setSkillsBinding`, `host/agent/session/manager.js`,
   stored on the conversation's existing `meta.json`). Every later run of the
   SAME conversation reuses that persisted binding verbatim and instead calls
   `assertResumeSnapshotAvailable()` against it — a removed/disabled/changed
   skill the conversation depends on fails that run with `run_error` reason
   `skills_snapshot_unavailable` rather than silently swapping instructions
   mid-conversation. This is also what makes "a mid-run refresh does not
   affect a running conversation" true beyond the single active run: since
   the binding is fixed for the conversation's lifetime once made, a refresh
   between two turns of the SAME conversation surfaces as the same
   `skills_snapshot_unavailable` refusal (a refresh changes the catalog
   entry's hash, which `assertResumeSnapshotAvailable` already treats as a
   "changed" mismatch — this was already this catalog module's own tested
   behavior, e.g. skills-dispatch.test.mjs's "reports a changed (refreshed)
   skill"; the companion wiring just had to actually call it).
3. `_runAfterLeaseGranted()` now extracts a leading `/command` from the
   prompt (only a plain string starting with `/` once trimmed — the exact
   shape the slash picker is specified to insert) and calls
   `assertSlashDispatchAllowed(command, skills.catalogSnapshot)` — using the
   run's own bound snapshot, never anything the SDK might discover on disk —
   BEFORE resolving provider credentials or building `query()` options at
   all. An unknown, disabled, or non-user-invocable command fails the run
   with `run_error` reason `slash_dispatch_rejected` and `query()` is never
   called. This is the literal enforcement of `sdk.d.ts:2108`'s own warning
   that `skills` "is a context filter, not a sandbox": the real
   authorization boundary lives here, application-side, not in what the SDK
   chooses to display.

**New evidence**: `host/test/agent-skills-wiring.test.mjs`, 7/7 passing,
entirely offline (real `host/agent/skills/**` catalog against a scratch
`OCIC_AGENT_HOME`, injected fake SDK/profile provider — no live credential,
no live browser):

```
Skills wiring into query() options (task 7.2's closed gap)

  PASS  buildIsolatedOptions throws when no skills session is provided — a run can never silently reach query() without one
  PASS  buildIsolatedOptions composes cwd/skills/skillOverrides and adds the Skill tool, without weakening the isolated baseline
  PASS  only enabled, capability-approved snapshots are materialized on disk and reach query()'s skills allowlist
  PASS  an unknown slash command is rejected application-side and never reaches the SDK
  PASS  a disabled skill's explicit slash dispatch is rejected application-side and never reaches the SDK
  PASS  an enabled, user-invocable skill's slash dispatch is authorized and its name reaches the SDK
  PASS  mid-run refresh does not affect an already-bound conversation; the same conversation's next run is refused; a new conversation gets the refresh

7/7 passed
```

All 30 `host/test/*.test.mjs` files (28 pre-existing + this new one +
`agent-skills-wiring.test.mjs` — the pre-existing count already included
`skills-catalog.test.mjs`/`skills-dispatch.test.mjs`) and all 21 root
`test/*.test.mjs` files still pass unmodified.

**What is still genuinely open, not folded into this closure**: task 7.3
(Settings > Skills UI, slash picker — `extension/**`, a different session's
scope), task 7.4's full matrix specifically through a LIVE browser-workflow
skill invocation (this session's evidence proves the dispatch/options-wiring
half offline; an actual SDK-invoked skill performing a real browser action
still needs a live browser + live model, per this change's own "prefer
offline assertions" guidance for this task), and task 7.5 (documentation).
`assertCanonicalSkillResourcePath()` (Read-tool enforcement for skill
resources) remains an available, tested, but not-yet-wired-in bonus export —
no Read tool is enabled in `tools` at all (deliberately: "keeping ...
arbitrary filesystem reads ... disabled by default" stays true), so there is
currently no call site that needs it; wiring an actual restricted Read tool
for skill resources, if ever needed, is future scope, not silently assumed
done here.

## Summary

| Item | Status |
|---|---|
| 7.1 — validated import, immutable snapshots, catalog metadata, enable/disable/refresh/remove | **DONE** |
| 7.2 (application half) — session workspace materialization, dispatch authorization gate, resume-snapshot check | **DONE** |
| 7.2 (SDK-facing half) — actual `query()` options, `Skill` tool inclusion, session builder integration | **DONE** — see "Task 7.2 SDK-facing wiring — closed" above |
| 7.3 — Settings > Skills UI, slash picker | out of scope for this task |
| 7.4 — UI-dependent tests | out of scope for this task (dispatch/options-wiring half now covered offline; live browser-workflow-skill half still open) |
| 7.5 — documentation | out of scope for this task |

No item in this report's scope is BLOCKED. Every acceptance-criteria test
listed in the task brief was written against a real on-disk fixture and
actually run; no offline substitute stands in as a "pass" for anything that
would have genuinely required a live SDK/model call, and none of task 7.1 or
either half of 7.2 required one.
