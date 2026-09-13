# Wave 2D — documentation (tasks 8.1–8.4)

Scope: `docs/**`, `README.md`, this change's `tasks.md`/`reports/`. No file
under `host/`, `extension/`, or `test/` was modified — only read, to verify
claims.

## What changed

- `README.md` — new top-level section **"Permission modes and protected
  actions"**, inserted after the existing "Auditing agent sessions" section
  (before "Updating After Code Changes"), matching that part of the
  document's existing English, feature-by-feature voice. Three subsections:
  - `### The three modes` — Manual/Auto/Skip, what each gates, Auto as
    default reproducing prior behavior, mode is per-profile/no sync,
    mid-run mode changes invalidate pending decisions rather than
    reinterpreting them, and how remembering scopes to origin+action-class.
  - `### Protected actions` — the three categories (file write/download,
    credential/payment entry, browser-permission grant), that nothing
    (mode, remembered grant, managed policy) bypasses them, and that a
    protected decision is never remembered. States plainly that
    page-initiated download observation is not yet wired (verified: no
    `downloads` entry in `extension/manifest.json`, no `chrome.downloads`
    call in `extension/background.js`, re-checked immediately before
    writing and again right before finishing this report) — today the
    protected download category only catches a `computer` click the
    classifier already recognizes as a download from page markup.
  - `### Administrator-managed policy` — the `chrome.storage.managed`
    channel, override/precedence/withdrawal behavior, the exact validated
    shape (copied verbatim from `reports/wave1-contracts.md`, not
    re-derived), and `requireProtectedConfirm`'s honest status: validated
    for shape, not separately consumed, because protected actions already
    require a decision unconditionally — the field can only ever add a
    confirmation, never remove one.
  - Deliberately does **not** describe a panel click path for switching
    modes: that UI control is being built in a parallel wave and was not
    independently verified here (per this task's own instruction).
- `docs/privacy-policy.md` — new section **"Quyền downloads (đang được bổ
  sung)"**, placed after the existing "Quyền `debugger`" section (same
  pattern: why it exists, what it's used for). States the exact intended
  scope (observe download creation only, to pause/resume/cancel pending a
  decision; never to start, redirect, or read a download) and, in the same
  section, states plainly that the permission is **not yet** in the shipped
  manifest — this documents an accepted decision, not a shipped grant.
  Bumped the file's own "Cập nhật lần cuối" date, per that document's stated
  convention that a substantive change updates it.
- `openspec/changes/add-permission-modes-and-threat-signals/tasks.md` —
  checked off 8.1–8.4 with evidence notes pointing at what was verified and
  where.

## Evidence classes

- Permission-mode semantics, protected-action categories, and the mode
  resolution order (protected → managed policy → per-site store → mode):
  **current decisions**, sourced from `specs/agent-permission-policy/spec.md`
  and `design.md`'s Decisions section — these are accepted target contracts
  for a change still landing, not asserted as fully wired end-to-end UI.
- The exact `agent_settings` op shapes and the `validateManagedPolicy`
  schema, including `requireProtectedConfirm`'s non-consumption: **current
  evidence**, taken verbatim from `reports/wave1-contracts.md`, which is
  itself sourced from shipped `host/agent/**` code (per that report's own
  header).
- The `downloads` permission's absence from `extension/manifest.json` and
  the absence of any `chrome.downloads` call in `extension/background.js`:
  **current evidence**, directly re-verified with `grep` immediately before
  finishing, not inferred from `tasks.md`'s own note.
- No store-listing draft file (e.g. a Chrome Web Store description) exists
  anywhere in the repository — checked via a repo-wide grep for
  "store listing"/"Chrome Web Store" — so `docs/privacy-policy.md` is the
  only store-adjacent surface that needed the `downloads` update.

## Validation run

- Re-read both edited files in full after editing; headings, the one JS code
  fence, bullet lists, and the two cross-links (`README.md` →
  `docs/privacy-policy.md#quyền-downloads-đang-được-bổ-sung` and
  `docs/privacy-policy.md` → `../README.md#permission-modes-and-protected-actions`)
  render as plain, unambiguous Markdown; both anchors are derived from their
  heading text with no punctuation left to make slug generation ambiguous.
- Re-ran the manifest/background.js grep for `downloads` twice — once before
  drafting 8.4's content, once at the end — to catch a possible landing by
  the parallel extension wave before this report was filed. Still absent
  both times.

## Docs impact

Two authority surfaces changed (`README.md`, `docs/privacy-policy.md`); none
removed. No other doc file in `docs/` referenced permission modes, protected
actions, or the `downloads` permission before this change, so nothing else
needed reconciling.

## Unresolved / for the lead

- The `downloads` permission and its observation code are owned by task 2.4,
  not yet landed as of this report. Both new doc sections already say so in
  plain language and point at the exact scope decision, so they will not go
  stale if 2.4 lands later — but whoever lands it should flip the two
  "not yet shipped" sentences (README's protected-actions subsection, and
  the privacy-policy section's last paragraph) once `extension/manifest.json`
  actually carries the permission.
- The panel's mode control (task 7.1) and its exact settings-page location
  are not described anywhere in the new README section, by design — once
  that control ships, a short "where to change it" pointer would be a
  reasonable, small follow-up addition, but it is out of this wave's
  verified scope.

Status: DONE
Summary: Documented the three permission modes, the protected-action categories and their non-bypassability, and the administrator-managed policy keys in a new README section, and added a privacy-policy section for the `downloads` permission that honestly states it has not yet landed in the manifest.
Concerns/Blockers: The `downloads` permission (task 2.4) and the panel mode control (task 7.1) are still in flight in other waves; both new doc sections are written to stay accurate either way, but flag the exact sentences to flip once those land.
