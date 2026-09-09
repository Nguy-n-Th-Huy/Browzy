# Task 7.3 / 7.4 / 7.5 evidence — Settings > Skills, the slash picker, tests, and docs

## Scope and what this session built

Files added/changed (all within this task's owned scope: `extension/settings/**`,
`extension/sidepanel/**`, `test/settings-ui-skills-*.test.mjs`,
`test/sidepanel-slash-picker-*.test.mjs`, `docs/**`, this report):

- `extension/settings/skills-client.js` — new wire-contract client.
- `extension/settings/skills-controller.js` — new DOM-free state machine.
- `extension/settings/skills.html` + `extension/settings/skills-app.js` — new Settings > Skills page + thin DOM layer.
- `extension/settings/settings.html`, `extension/settings/settings-app.js` — added the "Skills" nav row.
- `extension/settings/errors-ui.js` — added the skill-catalog error-code taxonomy (`INVALID_METADATA`, `DUPLICATE_NAME`, `PATH_TRAVERSAL`, `SYMLINK_ESCAPE`, `NOT_A_SKILL`, `UNSUPPORTED_CAPABILITY`, `NOT_FOUND`).
- `extension/sidepanel/skills-client.js` — new read-only wire-contract client for the picker.
- `extension/sidepanel/skills-model.js` — new DOM-free picker logic (eligibility filter, name/description filter, slash-query parsing, invocation-text builder, the empty `BUILTIN_COMMANDS` list).
- `extension/sidepanel/sidepanel.js` — real catalog fetch/cache/filter wired into the existing `<ui-slash-picker>`, invocation-text insertion on select, built-in/skill `data-kind` tagging, a debug hook for screenshot capture, and friendlier transcript error text for the three skill-related `run_error` reasons.
- `extension/sidepanel/tool-labels.js` — a `Skill` tool label (`"Đã chạy skill: <name>"` / running variant) for the transcript's tool-activity rows.
- `extension/sidepanel/sidepanel.css` — a page-local rule distinguishing a future built-in command from a skill in the picker (see "Built-in commands" below — nothing to render against yet).
- `docs/skills.html` — new standalone user-facing doc (task 7.5).
- Five new test files (`test/settings-ui-skills-client.test.mjs`, `test/settings-ui-skills-controller.test.mjs`, `test/settings-ui-skills-real-catalog.test.mjs`, `test/sidepanel-slash-picker-model.test.mjs`, `test/sidepanel-slash-picker-dispatch.test.mjs`).

## Architecture decision: the wire contract, and the companion-side gap it depends on

`host/agent/skills/index.js`'s own file header says the catalog-lifecycle surface
(`importSkill`/`refreshSkill`/`listCatalog`/`enableSkill`/`disableSkill`/
`removeSkill`/`setInvocationFlags`) is "Settings > Skills (task 7.3, out of
scope for this change)"'s expected caller. Investigating
`host/agent/companion.js`'s `_handleAgentSettings()` (the existing generic
`{type:"agent_settings", op, ...}` op-dispatch envelope
`extension/settings/settings-client.js` already uses for the provider-profile
surface) confirmed it has **no `skills_*` op case today** — only
`get_profile`/`save_profile`/`set_credential`/`remove_credential`/
`test_capability`/`discover_models`/`export_profile`. Adding those cases would
mean editing `host/agent/companion.js`, which is squarely under this task's
"Files you MUST NOT touch — host/** entirely."

This is the exact same shape of gap `extension/settings/settings-client.js`
itself documented when it was first built (task 4.4, before
`extension/background.js`'s relay and `host/agent/companion.js`'s
`_handleAgentSettings()` existed) — see that file's own header and
`reports/03-companion-evidence.md`'s addendum for how it was later closed by a
host/background-owning session. This task follows the identical, established
pattern:

- `extension/settings/skills-client.js` and `extension/sidepanel/skills-client.js`
  send real `chrome.runtime.sendMessage({ type: "agent_settings", op: "skills_*", ... })`
  calls, fully documented (op names, payload shapes) in each file's own header.
- Until a host/background-owning session adds (a) `skills_*` case branches to
  `host/agent/companion.js`'s `_handleAgentSettings()` and (b) nothing extra to
  `extension/background.js`'s relay (it already forwards any `agent_settings`
  op opaquely — confirmed by reading `createAgentSettingsRelay()`'s doc
  comment referenced in `settings-client.js`), every real call from these
  clients rejects with a `NETWORK_ERROR`-shaped error — **never a false
  "success."**
- This is not a workaround or a stub: the UI, the state machine, and the
  actual `host/agent/skills/**` catalog library are all real and fully tested
  (see below) against the real library directly. The one missing piece is a
  few `switch` cases in a file this task is expressly forbidden from editing.

**Recommendation for the next host/background-owning session**: add to
`host/agent/companion.js`'s `_handleAgentSettings()` a `switch` arm per
`skills_*` op that calls straight into `host/agent/skills/index.js`'s
same-named function (exactly mirroring the existing `get_profile`/
`save_profile`/etc. arms) — no new module, no new envelope type, no protocol
version bump needed.

### RESOLVED (later host-owning session): the companion-side gap above is closed

A later session, scoped exactly to `host/agent/companion.js` and a new
`host/test/agent-skills-ops.test.mjs`, implemented the recommendation above
verbatim: `_handleAgentSettings()`'s `switch` gained one arm per `skills_*` op
— `skills_list`/`skills_import`/`skills_refresh`/`skills_enable`/
`skills_disable`/`skills_remove`/`skills_set_invocation_flags` — each a
direct, unmodified delegation to `host/agent/skills/index.js`'s same-named
function (`listCatalog`/`importSkill`/`refreshSkill`/`enableSkill`/
`disableSkill`/`removeSkill`/`setInvocationFlags`), matching this file's
already-documented op names and payload shapes exactly (`sourceDir` for
import, `name` for refresh/enable/disable/remove, `name`+`userInvocable?`+
`modelInvocable?` for `setInvocationFlags`). No change to
`extension/background.js` was needed — its `agent_settings` relay already
forwarded every op opaquely, as this report predicted. No new module, no new
envelope type, no protocol version bump: exactly the shape of change task
4.4's own `agent_settings` gap needed when it was closed the same way.

`extension/settings/skills-client.js` and `extension/sidepanel/skills-client.js`
required zero changes — both already spoke the exact contract now
implemented host-side, so no `NETWORK_ERROR` is returned for any of these
ops anymore; every one now round-trips through the real
`host/agent/skills/**` catalog library.

Proven by 16 new tests in `host/test/agent-skills-ops.test.mjs` (offline,
real skills catalog against real temp-directory fixtures, injected
fake SDK — no live credential, no mocked filesystem): every `skills_*` op
works with no prior hello and no active conversation; `skills_list`
reflects a real import; `skills_import` rejects malformed metadata,
duplicate names, path traversal, and a symlink escaping the package root
each with its own distinct error code, and never executes a script shipped
in the package (a script-requiring skill imports successfully but is
rejected with `UNSUPPORTED_CAPABILITY` only at `skills_enable` time, never
silently granted); `skills_enable`/`skills_disable`/
`skills_set_invocation_flags` round-trip through the real catalog and
return `NOT_FOUND` for an unknown name; `skills_refresh` re-reads the
source folder and never flips enabled state on its own; `skills_remove`
leaves the original source directory byte-identical and untouched; a
skill disabled via `skills_disable` makes that SAME conversation's very
next slash dispatch of the identical command fail before the SDK is ever
called again, with no new conversation required; a `skills_refresh`
issued while a run is actively blocked in `query()` never changes that
run's already-materialized `.claude/skills/` snapshot, that same
conversation's next run is refused with `skills_snapshot_unavailable`,
and a brand-new conversation picks up the refreshed content; and an
unsupported protocol version on a `skills_*` op fails closed with
`PROTOCOL_ERROR` in the same `agent_settings`-shaped envelope, exactly
like every other op.

Full regression re-confirmed after this change: all 38 suites in
`host/test/` and all 32 suites in `test/` pass (`host/test/secrets-store.test.mjs`
passes cleanly on this Windows machine — its two macOS/Linux Secret
Service checks report `BLOCKED`, informational, not failures; no
pre-existing OS-keychain failure was observed here).

Task 7.3's own line in `tasks.md` is updated to record this closure; see
that file's task 7.3 entry.

## Real work proven without that wiring

- `test/settings-ui-skills-real-catalog.test.mjs` wraps `SkillsController`
  around a thin adapter that calls `host/agent/skills/index.js` **directly**
  (not through `companion.js`), against real temp-directory fixtures on disk
  (no mocks). This proves the actual product behavior end-to-end for every
  catalog-layer scenario the controller is responsible for surfacing:
  valid import + persistence across a simulated restart, enable/disable,
  invalid metadata, duplicate name, path traversal (via the frontmatter
  `name` field), a symlink escaping the package root (NTFS junction — no
  privilege elevation needed on Windows), unsupported-capability detection
  (`helper.sh` in the package) blocking `enable()` with an actionable
  error and never silently granting shell access, `remove()` leaving the
  original source folder untouched, and `refresh()` gating a source-folder
  edit until explicitly requested.
- `test/sidepanel-slash-picker-dispatch.test.mjs` goes one level deeper: it
  drives the **real** `host/agent/companion.js` `CompanionCore` (imported
  read-only, never modified) through the real wire envelope path, using
  `extension/sidepanel/{protocol-client,panel-controller,conversation-model}.js`
  — this task's own owned files — via the identical "fake companion harness"
  bridge `test/sidepanel-fake-companion.test.mjs` already established. This
  is genuinely new coverage layered on top of `host/test/agent-skills-wiring.test.mjs`
  (which proves the same rejection/authorization properties at the raw
  envelope level): it proves the **panel's own conversation-model rendering**
  of a rejected dispatch is honest (an error-lifecycle turn, never a
  fabricated success), and that the exact typed composer text reaches the
  SDK unchanged for an authorized dispatch.

## 7.4 test matrix

| Scenario (task 7.4 / design.md section 7) | Where it is proven | Result |
|---|---|---|
| Explicit skill invocation reaching the SDK | `sidepanel-slash-picker-dispatch.test.mjs` ("explicit invocation…") | PASS |
| Automatic invocation composition (skill present in `options.skills`/`skillOverrides` so the model *could* auto-invoke it) | `sidepanel-slash-picker-dispatch.test.mjs` ("hidden automatic-only skill…") + `host/test/agent-skills-wiring.test.mjs` | PASS — an actual autonomous model decision cannot be proven offline (no live credential); the wiring that makes it possible is proven for real |
| Relative resource access | `host/test/skills-catalog.test.mjs` / `skills-dispatch.test.mjs` (`assertCanonicalSkillResourcePath`, session-workspace materialization) — catalog-layer, out of this task's file ownership, referenced not duplicated | PASS (pre-existing) |
| **Disabled skill typed manually is rejected before SDK dispatch** | `sidepanel-slash-picker-dispatch.test.mjs` ("a DISABLED (never-enabled) skill…", "resume with an unavailable skill…") | **PASS** — zero SDK calls in both the "never enabled" and "enabled-then-disabled" cases; see note below on which of `dispatch.js`'s two rejection paths each takes |
| Non-user-invocable skill rejected on explicit dispatch | `sidepanel-slash-picker-dispatch.test.mjs` ("a non-user-invocable skill…") | PASS |
| Hidden automatic-only skill enabled without appearing in the picker | `sidepanel-slash-picker-model.test.mjs` + `sidepanel-slash-picker-dispatch.test.mjs` | PASS |
| Duplicate names | `settings-ui-skills-real-catalog.test.mjs` + `host/test/skills-catalog.test.mjs` | PASS |
| Path traversal / escaping symlinks | `settings-ui-skills-real-catalog.test.mjs` + `host/test/skills-catalog.test.mjs` | PASS |
| Changed snapshots (mid-run refresh does not affect the active run) | `host/test/agent-skills-wiring.test.mjs` ("mid-run refresh…") — referenced, not duplicated | PASS (pre-existing) |
| Unavailable skills on resume | `sidepanel-slash-picker-dispatch.test.mjs` ("resume with an unavailable skill…") | PASS |
| Unsupported script/write requirement → unsupported-capability error, never silent shell access | `settings-ui-skills-real-catalog.test.mjs` ("unsupported script capability…") | PASS |
| Wire-contract shape (ops, payloads, error translation) | `settings-ui-skills-client.test.mjs` | PASS |
| Settings > Skills state machine (import/enable/disable/refresh/remove/banner/pending states) | `settings-ui-skills-controller.test.mjs` | PASS |
| Slash-picker filtering, eligibility, invocation text | `sidepanel-slash-picker-model.test.mjs` | PASS |

**Note on the "disabled skill" rejection path** — a real, verified nuance
worth recording precisely rather than glossing over: `buildSessionSkills()`
(`host/agent/skills/session-workspace.js`) only ever materializes
**enabled** catalog entries into a conversation's bound `catalogSnapshot`. So
a skill that was **never enabled** is simply absent from that snapshot, and
`assertSlashDispatchAllowed()` (`host/agent/skills/dispatch.js`) reports it as
`UNKNOWN_COMMAND` — its separate `DISABLED` branch is reachable only via
`assertResumeSnapshotAvailable()`'s mismatch path (a skill that **was**
enabled at bind time, then disabled before the conversation's next run),
which reports `skills_snapshot_unavailable` instead. Both are correct,
both reject before any SDK call, both surface an actionable message — this
task's tests exercise both real paths and document which is which rather
than asserting a specific error code the system does not actually produce
for the "never enabled" case.

### Full regression

Ran every suite in `test/` (30 files, all new files included) and
`host/test/` (35 files) — **all 65 passed**, confirmed twice: once when this
session's own work was complete, and again after a transient, unrelated
regression in `host/agent/companion.js` (a concurrent session's own file,
see "Known blocker" below) was fixed by its owning session.

## Known blocker (transient, since resolved by the owning session)

Partway through this session, `host/agent/companion.js` (owned by other
concurrent sessions per this task's own file-scope rules — this task's brief
explicitly says "the skills catalog and companion are complete, call them,
do not modify") developed a **JavaScript syntax error**: a JSDoc comment
added for an unrelated task (5.10, chunked artifact ingestion) reads
`CHUNK_BEGIN/CHUNK_PART*/CHUNK_END sequence carrying` — the literal substring
`*/` inside `CHUNK_PART*/CHUNK_END` closes the `/** ... */` block comment
early, leaving `CHUNK_END sequence carrying a screenshot capture's actual
bytes...` as bare (invalid) JavaScript. This breaks `node --check` /
module loading for `companion.js` and therefore **every test file that
imports it**, including this task's own `sidepanel-slash-picker-dispatch.test.mjs`
and the pre-existing `sidepanel-fake-companion.test.mjs` and most of
`host/test/*`.

- Confirmed not caused by this session: `host/agent/companion.js` is outside
  this task's edited-file set (only read, never written by any command in
  this session's shell history), and the broken comment is explicitly about
  task 5.10, not skills.
- Confirmed the diagnosis: `sed -n '360,380p' host/agent/companion.js` shows
  the exact `CHUNK_PART*/CHUNK_END` text; `node test/sidepanel-slash-picker-dispatch.test.mjs`
  fails with `SyntaxError: Unexpected identifier 'sequence'` at that exact
  line.
- Per this task's own scope rules ("LINT/TEST/TYPE FAILURES IN UNOWNED
  FILES... Do NOT auto-fix by editing or deleting the unowned file... If an
  unowned failure blocks your work, stop and report to the caller"), this is
  **reported, not fixed**, here. The one-line fix (rewording the comment so
  it contains no literal `*/`, e.g. `CHUNK_BEGIN, CHUNK_PART(s), then
  CHUNK_END carrying...`) is trivial for whoever owns `companion.js` next.
- All five of this task's own new test files were verified passing for real,
  in isolation and as part of a full 65/65 regression run, **before** this
  regression transiently appeared in a file this task does not own.
- **Resolved**: by the time this report was finalized, the owning concurrent
  session had fixed the comment (`node --check host/agent/companion.js`
  now passes cleanly). A full re-run of every suite in `test/` (30 files)
  and `host/test/` (35 files) — **65/65 green** — confirms this task's own
  work needed no changes once the unrelated file was fixed, exactly as
  predicted above.

## Visual acceptance — partial, explicitly descoped by the user mid-session

A Chrome automation MCP session was used for real, live capture (never a
mockup): a minimal dependency-free static file server
(`http`/`fs`/`path` only, bound to `127.0.0.1`, `Cache-Control: no-store`,
started and stopped for this session only — confirmed torn down,
`netstat` shows port 4173 clear afterward) served the repo root, reproducing
the exact `file://`-cannot-be-navigated workaround `reports/05-visual-system.md`
and `reports/04-settings-ui-evidence.md` already documented. Page state was
driven through `window.__skillsDebug.controller` (a debug hook
`skills-app.js` exposes for exactly this purpose, same convention as
`settings-app.js`'s `window.__settingsDebug`), never a live companion.

**4 real screenshots captured** (under
`reports/skills-ui-captures/`) before the user explicitly instructed
mid-session to stop pursuing further tests/screenshots ("bỏ qua test vs chụp
màn hình đi"): `skills-empty-320-{light,dark}.jpg` (genuine "no skills
imported yet" state) and `skills-populated-long-320-{light,dark}.jpg` (two
normal entries — one enabled, one disabled — plus a long-description entry
verifying wrapping/ellipsis does not break the card layout). All four render
correctly, with real Vietnamese copy, real toggle switches, real icons.

**Not captured, per that explicit instruction**: the "error" (unsupported-capability
card) state screenshot; 400px and 480px widths for any state; every slash-picker
state (empty/filtered/long-description, both themes, all three widths). This
is a genuine, disclosed gap against this task's original visual-acceptance
brief — not a silent shortcut: the user's own mid-session instruction to stop
is why capture stopped here, recorded as the reason rather than papered over.
`extension/sidepanel/sidepanel.js`'s `window.__browzySkillsPickerDebug` debug
hook (added this session, same convention) is ready for whoever resumes this
capture: `setCatalog(catalog)` seeds the picker's item cache,
`open(query)`/`close()` force it open/closed at any composer query string.

### Defect found and diagnosed: a large single-step window-resize leaves the top of a tall page unpainted

While checking the long-description card at a taller viewport (to see the
whole list without scrolling), resizing the browser window directly from
557×836 to 557×1600 in one `resize_window` call left the newly-revealed top
portion of the page **visually blank** in the very next screenshot, even
though `getBoundingClientRect()` queried via `javascript_tool` immediately
before confirmed every `.skill-card`'s computed position and height were
correct (no real layout bug — cards stacked with the correct 8px gaps, no
overlap, no oversized element). A single scroll tick (up or down) forced a
full repaint and the content appeared exactly where the DOM said it should.
This reproduces the same class of issue this task's brief warned about ("a
tall `overflow:hidden` + `border-radius` container can silently fail to
paint" — `reports/05-visual-system.md`), just triggered here by a large
single-step viewport-height jump rather than that specific container/
border-radius combination (`.card` itself has no `overflow:hidden`).
**Workaround for future captures**: avoid a single large resize step
immediately before a screenshot; either resize in the final target
dimensions from the start (this task's normal 320/400/480×700-ish flow never
hit this — it only appeared when deliberately jumping to a much taller
window for defect-inspection purposes), or issue one small scroll (and let
it settle) before capturing. Not a page/CSS defect — no code change made.

### Toolchain quirk: window minimum width on this machine

`resize_window` clamps below a hard minimum total window width on this
machine/session (measured **exactly** 237px width / 136px height of
"chrome" overhead — the identical numbers `reports/04-settings-ui-evidence.md`
recorded, confirming this is a stable, per-machine constant, not a per-session
fluke). To get an exact `N`px viewport, request `resize_window` with
`width: N+237`. Verified: requesting 557×836 produces a reported viewport of
exactly 320×700; requesting 320×700 directly gets silently clamped to a
480px-ish viewport instead.

## Non-negotiables re-verified

- Skills grant no additional authority: proven by the real catalog test
  (`enableSkill()` throwing `UNSUPPORTED_CAPABILITY` for a script-requiring
  package, never silently succeeding) and by `assertSlashDispatchAllowed()`
  being the real, unmodified, already-existing application-side gate this
  task's new UI/tests call through — never weakened, never bypassed, never
  duplicated with a second, looser check.
- Imports never execute package scripts: `host/agent/skills/import.js`'s own
  behavior (unmodified), exercised for real against a fixture containing a
  `.sh` file that is only ever hashed/copied, never invoked.
- A disabled skill is un-invocable immediately, including manually typed
  slash text: proven twice, for the "never enabled" and "enabled-then-disabled"
  cases (see the dispatch-path note above).
- No fixed skill catalog is promised: `docs/skills.html` explicitly disclaims
  this, and `BUILTIN_COMMANDS` (`skills-model.js`) documents that no built-in
  slash command exists in this product today, only user-imported skills.

## Documentation (task 7.5)

`docs/skills.html` (new, standalone HTML — matching this repo's existing
`docs/imitation-learning-alignment.html` house style) covers: what a skill
is, one-time import/enable via Settings > Skills (no implicit scanning),
that this one-time step persists across future browser sessions with no
terminal needed daily, explicit (`/`) vs. automatic invocation, managing
imported skills (enable/disable/refresh/remove — remove never touches the
original source), and an explicit "what a skill cannot do" section (no
credential/scope/tool-permission change, script/write requirements rejected
rather than silently granted). It explicitly disclaims a fixed/bundled skill
catalog and explains the `skill-creator`-in-a-screenshot point directly.

**Not done**: linking this new page from `README.md`. `README.md` is listed
under this task's "Files you MUST NOT touch" ("recently rewritten by another
session"). Whoever next owns `README.md` should add a link next to its
existing `docs/imitation-learning-alignment.html` reference, and update the
"Settings > Skills UI" line currently listed there as "not-yet-shipped"
(`reports/08-docs-evidence.md`'s own per-claim table, via task 8.3) now that
this task has shipped it — that reconciliation is out of this task's file
scope, reported here for whoever does own it next.

## Summary

| Item | Status |
|---|---|
| Settings > Skills page (import/inspect/enable/disable/refresh/remove) | DONE — real, tested against the real catalog library; companion-side `skills_*` op wiring is now RESOLVED (see the "RESOLVED" addendum above) — no more `NETWORK_ERROR` fail-closed gap |
| Slash picker (search, keyboard nav, empty state, insert-not-submit, skill activity in transcript) | DONE — real, tested; "selected snapshot identity in transcript" not renderable yet (companion emits no such field today — disclosed, not fabricated) |
| 7.4 test matrix | DONE — every named scenario has a real, passing test (see table); full 65-suite regression passes (re-confirmed after a transient, unrelated `host/agent/companion.js` issue from a concurrent session was fixed by its owner — see "Known blocker") |
| 7.5 documentation | DONE — `docs/skills.html`; README linkage is a disclosed, out-of-scope follow-up |
| Visual acceptance (320/400/480 × light/dark × states) | PARTIAL — 4 real screenshots captured, the remainder explicitly stopped by the user mid-session; disclosed above, not silently skipped |
