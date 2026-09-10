# Implementation report — redesign-settings-typed-only-skills

Status: **DONE_WITH_CONCERNS** (one pre-existing, unfixable-in-scope limitation surfaced and handled; everything else complete, tested, and validated).

## Summary

Implemented all 6 task groups (32/32 tasks ticked in `openspec/changes/redesign-settings-typed-only-skills/tasks.md`). Removed the `skills_import`/`skills_refresh` wire operations from `host/agent/companion.js`, added `skills_read_source`, made Settings > Skills typed-only (compose/edit/duplicate, in-page removal confirmation, Soạn/Xem trước tabs, per-field errors, empty state), and redesigned Settings with a sticky chip nav, a connection-status card, and a model-default radiogroup. `openspec validate redesign-settings-typed-only-skills --strict` passes. All required test suites pass.

## Decision surfaced during implementation (flagged before writing code, per advisor review)

**`index.js` scope conflict.** Task 1.1's text says "import only from `host/agent/skills/index.js`", but `index.js` doesn't export `snapshotDir`/`assertSafeSegment`/`parseFrontmatter`, and the hard "MUST NOT TOUCH" boundary explicitly includes `index.js` as byte-identical (design.md's own "unchanged, deliberately" list does *not* include `index.js`, but your scope note does). I resolved this in favor of the stricter, checkable acceptance criterion — `git diff --name-only` must show nothing under `host/agent/skills/` — by importing `snapshotDir`/`assertSafeSegment` from `host/agent/skills/paths.js` and `parseFrontmatter` from `host/agent/skills/frontmatter.js` directly in `companion.js`, leaving `index.js` byte-identical. Confirmed: `git diff --name-only` shows nothing under `host/agent/skills/`.

## Known limitation (cannot be fixed within this change's scope — surfacing per "root-cause completion, don't paper over")

**Editing (Sửa) a legacy folder-imported record in place fails with `DUPLICATE_NAME`.** Traced and proven with a real test (`test/settings-ui-skills-real-catalog.test.mjs`, "real Sửa (edit): a legacy folder-imported record..."):

- `loadForEdit(name)` on such a record **works** — it reads the approved snapshot correctly via `skills_read_source` and populates the form.
- Submitting that edit calls `authorSkill({ name, ... })` → `author.js`'s `isOwnAuthoredSource()` checks whether the record's `source` is under `authoredSkillsRoot()`. A folder-imported record's `source` is the operator's original external folder, so this returns `false`, and `author.js`'s (byte-identical, per the hard scope boundary) `DUPLICATE_NAME` guard fires — **the save is rejected**.

This contradicts the ADDED spec's scenario "A skill stored before this behavior existed... editing it loads the content from the application's approved copy" (the *load* half is true; the *save-in-place* half is not) and design.md's Risk section, which assumed Sửa would work on these without checking the guard.

I could not fix the root cause (`author.js`'s `DUPLICATE_NAME` guard) because `host/agent/skills/author.js` is on the explicit "MUST NOT TOUCH — stays byte-identical" list. Within scope, I implemented the most honest mitigation:

- The controller (`skills-controller.js`) detects this exact case (`editingName === name` at submit time + `err.code === "DUPLICATE_NAME"`) and replaces the generic "already imported from a different source" banner with a specific one: *"Skill "<name>" được nhập từ một thư mục trước đây nên chưa thể lưu bản sửa trực tiếp lên nó. Dùng "Nhân bản" để tạo một bản có thể chỉnh sửa, rồi gỡ bản cũ nếu muốn."* — pointing the operator at the working alternative (Nhân bản → edit the copy → optionally remove the original), which I proved works end-to-end against the real library in the same test file.
- `test/settings-ui-skills-controller.test.mjs` and `test/settings-ui-skills-real-catalog.test.mjs` both encode this as the *actual, correct* expected behavior — they do not paper over it as a false pass.

**Options for the user to resolve properly, in a follow-up change:**
1. A scoped `author.js` change: widen `isOwnAuthoredSource()`/the in-place-edit check so a record whose `source` is *not* reachable through any other wire operation (i.e., nothing else can re-import it) is treated as editable-in-place too. This is the real fix, but it touches a file this change was explicitly forbidden from touching.
2. Accept the limitation permanently: update the ADDED requirement's "Load a stored skill back for editing" scenario to say a pre-existing folder-imported record is *duplicated* into an editable copy rather than edited in place, matching what actually ships.
3. (Rejected, per advisor guidance during planning) Have `companion.js` orchestrate remove-then-author for this case — this would add non-atomic business logic to a file whose entire job is pure delegation, and was explicitly rejected as a workaround.

I recommend option 1 as a small, well-scoped follow-up.

## Files changed (all within the assigned scope)

- `host/agent/companion.js` — removed `skills_import`/`skills_refresh` branches and their imports; added `skills_read_source` (composes `getSkill` from `index.js` + `snapshotDir`/`assertSafeSegment` from `paths.js` + `parseFrontmatter` from `frontmatter.js`, plus a local `extractSkillBody()` helper); updated the header comment.
- `host/test/agent-skills-ops.test.mjs` — cases proven redundant against `host/test/skills-catalog.test.mjs` dropped (malformed metadata, duplicate name, traversal, symlink escape, script-execution+enable-rejection); remaining cases' setup switched from the removed `skills_import` op to a direct `importSkill()` library call; mid-run-refresh-isolation and refresh-preserves-enabled-state rewritten to call `refreshSkill()` directly.
- `host/test/agent-skills-read-source.test.mjs` (new) — 8 cases: valid read + invocation-flags-from-record, missing `allowed-tools`, unknown name (no file opened), traversal/separator-bearing names (no file opened), tampered `snapshotId` → `PATH_TRAVERSAL` (no file opened), missing snapshot → `NOT_FOUND`, and the two "no operation accepts a path" cases (source-level enumeration + runtime behavioral probe for `skills_import`/`skills_refresh`).
- `extension/settings/skills-client.js` — `importSkill()`/`refreshSkill()` removed; `readSkillSource(name)` added; header updated.
- `extension/settings/skills-controller.js` — `importDraft`/`importing` state and `setImportDraft()`/`importFromDraft()`/old `refreshSkill()` removed; added `editingName`, `dirty`, `pendingLoad`, `pendingRemoval`, `fieldErrors` state; `loadForEdit()`/`loadForDuplicate()`/`_loadInto()`/`_performLoad()`/`confirmPendingLoad()`/`cancelPendingLoad()`/`discardDraft()`/`requestRemoval()`/`cancelRemoval()`/`confirmRemoval()` added; `deriveDuplicateName()` (truncates the base to respect the 64-char limit); `fieldForAuthorError()` maps a rejection to the offending form field.
- `extension/settings/skills.html` — "Nhập skill mới" section removed; explanatory note card added; "Tạo skill" is now `btn-primary`; Soạn/Xem trước tab pair + character counter (visible + `aria-live` threshold-only announcer) over the body field; per-field `field-error` elements with `aria-describedby`; empty state with primary CTA; no inline `<script>`.
- `extension/settings/skills-app.js` — import bindings removed; Sửa/Nhân bản per-card buttons wired to the controller; card provenance line changed to "Tự soạn · sửa lần cuối …"; `window.confirm()` replaced with an in-page removal-confirmation card (focus → Cancel on open, `Escape` cancels, focus returns to the invoking "Gỡ bỏ" button on close via name-based lookup since the card list is rebuilt on every render); the unsaved-draft confirm card for Sửa/Nhân bản follows the same pattern; tab-pair keyboard handling (arrow keys) and dynamic `aria-labelledby`.
- `extension/settings/settings.html` — sticky chip nav (`<nav>` with 4 anchor links to existing section headings, `overflow-x: auto`); connection-status card (`role="status"`) at the top of the scroll area; `#model-list` marked `role="radiogroup"`; Skills nav sub-label updated to "Tự soạn nội dung, bật/tắt, sửa, gỡ bỏ".
- `extension/settings/settings-app.js` — `renderStatusCard()` (reads only existing `connectionStatus`/`hasCredential`/`defaultModelId`, never tests on load); `wireChipNav()` (`IntersectionObserver`-based `aria-current`, never `preventDefault`s a chip click); `renderModels()` converted to one radio per model (`name="default-model"`) bound to `controller.setDefaultModel()`, "· Mặc định" text kept as a non-radio carrier of the state.
- `test/settings-ui-skills-client.test.mjs` — import/refresh cases replaced with `readSkillSource` coverage; confirms `client.importSkill`/`client.refreshSkill` no longer exist.
- `test/settings-ui-skills-controller.test.mjs` — rewritten: drops import-draft tests; adds loadForEdit/loadForDuplicate (incl. duplicate-name-collision increment and 64-char truncation), the unsaved-draft guard (park/confirm/cancel), the removal-confirmation transitions (request/cancel/confirm), field-error coverage, and the legacy-record DUPLICATE_NAME-on-edit banner case. Runs under plain Node with no DOM.
- `test/settings-ui-skills-real-catalog.test.mjs` — rewritten against the real `host/agent/skills/**` library (its own `readSkillSource` adapter mirrors `companion.js`'s `skills_read_source` case exactly): real listing, enable/disable, capability-gated enable, remove, author (typed), Sửa on an authored record (works fully), **Sửa on a legacy folder-imported record (loads correctly, save rejected with the specific message — the known limitation, proven for real)**, and Nhân bản on a legacy record (works fully, and the resulting duplicate can then be edited in place).
- `README.md` — added a short paragraph ("Skills are composed in the app, not imported from a folder...") stating no interface accepts a filesystem path; no pre-existing folder-import statement was found to rewrite (the README never described that flow explicitly before this change).
- `openspec/changes/redesign-settings-typed-only-skills/tasks.md` — all 32 boxes ticked.

## Verification performed

- `node --check` on every edited `.js`/`.mjs` file — clean.
- `openspec validate redesign-settings-typed-only-skills --strict` — passes.
- Full required suite, run twice for stability: `host/test/agent-skills-*.test.mjs`, `host/test/skills-*.test.mjs`, `test/settings-ui-*.test.mjs`, `test/sidepanel-slash-picker-dispatch.test.mjs` — **all green**. (One transient timeout in `sidepanel-slash-picker-dispatch.test.mjs` occurred once during a long back-to-back batch run under system load; it passed 5/5 times standalone and in the final full-suite re-run — pre-existing polling-based flakiness unrelated to this change, not a regression: nothing this change touches affects that test's timing.)
- `git diff --name-only` confirms: nothing under `extension/ui/`, nothing under `host/agent/skills/`.
- No inline `<script>` in `skills.html` or `settings.html` (both only load external `type="module"` scripts).

## Scope discipline / concurrent-work note

Another session continued editing `host/agent/policy/can-use-tool.js`, `host/agent/session/run.js`, `host/agent/tools/query-options.js`, and `test/approval-gate.test.mjs` **while this task ran** (none of these appeared in the pre-task baseline `git status` I captured before starting). I did not touch any of them — confirmed by diffing the baseline snapshot against the current `git status --porcelain` and by my own tool-call history. Flagging per the orchestration protocol's "unfamiliar code = another session's in-progress work" rule; no action taken.

`extension/settings/errors-ui.js` (out of my file scope) still has stale copy referencing "Nạp lại" (the removed refresh button) in its `DUPLICATE_NAME` action text, and its `NOT_FOUND` copy still says "Kiểm tra lại đường dẫn thư mục" (check the folder path). I did not touch it (not in scope), but the controller routes around the stale `DUPLICATE_NAME` copy for the one case that would actually hit it (in-place edit of a legacy record) with its own specific message, so the stale text is unlikely to surface in the typed-only flow in practice. Worth a follow-up cleanup pass on `errors-ui.js` when it's back in scope for someone.

## Not independently verified (no live browser available in this session)

Task 5.6 asks to confirm both pages at 320px/default width, light/dark, keyboard-only, with visible focus — verified by careful code review (CSS responsive rules, existing `.field-row` wrap pattern reused, `overflow-x: auto` on the sticky nav, `:focus-visible` outlines using existing tokens, ARIA roles/attributes on the tab pair/radiogroup/confirmation cards) rather than by capturing real screenshots, since this delegated session had no way to load an unpacked MV3 extension into a real browser. I'd recommend a manual or screenshot-based pass before shipping, per this project's established visual-QA convention.

## Unresolved questions for the user

1. Which of the two options above (widen `author.js`'s in-place-edit guard, or amend the spec scenario to say "duplicated" instead of "edited in place") do you want for the legacy-record Sửa limitation?
2. Should `extension/settings/errors-ui.js`'s stale `DUPLICATE_NAME`/`NOT_FOUND` copy be cleaned up now (would require expanding this change's file scope) or left for a later pass?
