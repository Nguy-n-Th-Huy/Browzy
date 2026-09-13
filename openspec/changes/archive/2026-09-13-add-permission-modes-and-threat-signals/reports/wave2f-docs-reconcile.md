# Wave 2F — reconcile docs with the shipped mode control and download gate

Scope: `docs/**`, `README.md`, this change's `tasks.md`/`reports/`. No file
under `host/`, `extension/`, or `test/` was modified — only read, to verify
claims.

## What changed

- `README.md`, `## Permission modes and protected actions`:
  - `### The three modes` gained a new **"Where to change it"** paragraph
    naming the two surfaces that now exist: the chat panel's mode badge
    (`extension/sidepanel/sidepanel.js`'s `renderModeMenu`/
    `changePermissionMode`, wired to `extension/sidepanel/permissions-client.js`)
    and Settings > "Quyền & trang đã ghi nhớ" (`extension/settings/permissions.html`
    + `permissions-app.js`/`permissions-controller.js`), including that an
    administrator-pinned mode disables both.
  - `### Protected actions`' download paragraph no longer says the
    `downloads` permission or its observation code are absent. It now
    describes the shipped gate: the extension holds `downloads`
    (`extension/manifest.json`), the gate only pauses a download started
    while an agent run currently holds the browser (`isAgentRunActive()` in
    `extension/background.js`, keyed off `activeAgentRuns`), the pause/ask/
    resume-or-cancel flow (`handleDownloadCreated`/`handleDownloadDecision`),
    and the one honest limit stated in the task brief: a download the
    browser finishes before the extension can pause it is reported
    (`download_notice`, `outcome: "completed_before_pause"`) rather than
    blocked. A user's own manual download outside of an agent run is never
    gated — stated explicitly so the feature isn't overclaimed as catching
    every download.
- `docs/privacy-policy.md`: section renamed from "Quyền downloads (đang được
  bổ sung)" to **"Quyền downloads"**. Removed the sentence stating the
  permission is not yet in the shipped manifest. Added the same two
  disclosures as the README (agent-run-scoped pause; a download that
  finishes before pause is only reported, not blocked), in Vietnamese,
  matching the file's existing voice and paragraph structure. The
  cross-reference to `README.md#permission-modes-and-protected-actions`
  (unchanged heading, so the anchor still resolves) was kept as-is.
- `README.md`'s inbound link to the privacy policy was updated from
  `docs/privacy-policy.md#quyền-downloads-đang-được-bổ-sung` to
  `docs/privacy-policy.md#quyền-downloads` to match the renamed heading —
  verified this is the only place in the repository that linked to the old
  anchor (`grep -rn "privacy-policy.md#"`).
- `docs/privacy-policy.md`'s "Cập nhật lần cuối" date was already `13/09/2026`
  (today) from the prior pass; left as-is since it already reflects the date
  of this substantive edit too, per the file's own convention.
- This change's `tasks.md`: appended follow-up notes to 8.1, 8.2, and 8.4
  recording what was re-verified and what changed in the docs; 8.3 marked
  unchanged this pass (administrator-managed policy section was not in
  scope for this reconciliation and nothing in the code it describes moved).

## What was verified against code (not taken from reports alone)

- `extension/manifest.json`: `permissions` array includes `"downloads"`
  (line 20); `"storage": {"managed_schema": "managed-schema.json"}` is
  present (lines 25–27).
- `extension/background.js`: `chrome.downloads.onCreated.addListener(handleDownloadCreated)`
  (line 479); `handleDownloadCreated` (lines 444–476) skips gating unless
  `isAgentRunActive()`, reports-and-returns immediately if the item is
  already `"complete"`, otherwise calls `chrome.downloads.pause` and, on
  success, emits a `download_protected_decision` envelope with a fresh
  `requestId`; `handleDownloadDecision` (lines 487–496) resumes or cancels
  the paused download based on the reply and drops an unknown/already-settled
  `requestId`.
- `extension/sidepanel/sidepanel.js`: a working mode badge/menu exists
  (`renderModeMenu`, `changePermissionMode`, lines 437–513), backed by
  `extension/sidepanel/permissions-client.js`; it disables itself and shows
  a lock icon when `modeSource === "managed"`.
- `extension/settings/permissions.html` (+ `permissions-app.js`,
  `permissions-controller.js`, `permissions-client.js`) exists, is linked
  from `extension/settings/settings.html`'s `#nav-permissions` entry (nav
  copy: "Quyền & trang đã ghi nhớ" / "Chế độ cấp quyền, trang đã cho phép/từ
  chối"), and renders a mode radio group plus a remembered-sites list with
  individual and bulk revoke.
- Confirmed no mention of the injection probe, per-tab risk category, or any
  panel warning surface exists in either edited file before or after this
  pass (`grep -i` for "injection", "risk", "threat", "warning" in both — no
  matches) — nothing needed walking back, and none was added.

## Evidence classes

- The download gate's exact control flow (agent-run-scoped, pause/ask/
  resume-cancel, completed-before-pause reporting): **current evidence**,
  read directly from `extension/background.js`.
- The mode badge and Settings permissions page's existence and wiring:
  **current evidence**, read directly from `extension/sidepanel/sidepanel.js`
  and `extension/settings/permissions.html`/`permissions-app.js`.
- The administrator-managed policy shape and `requireProtectedConfirm`'s
  non-consumption (`### Administrator-managed policy`, left unchanged):
  **current decisions**, unchanged from the prior pass's sourcing in
  `reports/wave1-contracts.md`.

## Validation run

- Re-read both edited files in full after editing.
- `grep -rn "đang được bổ sung|not yet in the shipped manifest|not yet wired|page-initiated download observation is not yet"` across `README.md` and
  `docs/privacy-policy.md`: no remaining stale download-related sentences
  (one unrelated hit, a pre-existing note about console commands not being
  wired to a Settings button, is unrelated to this task).
- `grep -rn "privacy-policy.md#"` and `grep -rn "README.md#"` across the
  repository: confirmed the only cross-links between these two files are the
  two already accounted for, and both anchors resolve to their files'
  current headings.

## Docs impact

Two authority surfaces changed (`README.md`, `docs/privacy-policy.md`); none
removed, none created. `tasks.md` annotated with follow-up notes; no new
report superseded an old one (`wave2d-docs.md` is left in place as the
historical record of what was true when it was written).

## Unresolved / for the lead

None. Both flagged sentences from `wave2d-docs.md`'s "Unresolved" section
are now flipped, and the panel's mode-control "where to change it" follow-up
that report suggested is included.

Status: DONE
Summary: Reconciled README.md's permission-modes section and docs/privacy-policy.md's downloads section with the now-shipped downloads permission, download gate, and panel/settings mode controls, verified directly against extension/manifest.json, extension/background.js, extension/sidepanel/sidepanel.js, and extension/settings/permissions.html rather than trusting prior reports alone.
Concerns/Blockers: None.
