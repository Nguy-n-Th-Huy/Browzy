## 1. Host: read-back operation and wire-surface removal

- [x] 1.1 Add a `skills_read_source` branch to `_handleAgentSettings()` in `host/agent/companion.js`, taking `{ name }` and only `{ name }`. Resolve in this order: `getSkill(name)` (absent → the existing not-found error, before any filesystem access) → `assertSafeSegment(record.snapshotId)` → read `SKILL.md` from `snapshotDir(record.snapshotId)` → `parseFrontmatter(raw)`. Return `{ name, description, body, allowedTools, userInvocable, modelInvocable }`, taking `description`/`allowedTools` from the parsed frontmatter and the two invocation flags from the catalog record (never from the file). Import only from `host/agent/skills/index.js`; add no new file-reading helper.
- [x] 1.2 Remove the `skills_import` and `skills_refresh` branches from `_handleAgentSettings()` and drop `importSkill`/`refreshSkill` from `companion.js`'s import list. Do not edit `host/agent/skills/import.js`, `author.js`, `manage.js`, `frontmatter.js` or `paths.js`, and do not remove `index.js`'s re-export of `import.js` — `authorSkill()` runs on that pipeline.
- [x] 1.3 Update the header comment above the skills operation block so it describes the operation set that now exists, including why the import library is still present with no wire entry point.
- [x] 1.4 Add `host/test/agent-skills-read-source.test.mjs`: a valid read returns the composed body and the record's invocation flags; an unknown name is rejected without opening a file; a traversal-shaped or separator-bearing name is rejected without opening a file; a skill whose frontmatter has no `allowed-tools` returns an empty allowed-tools value rather than throwing. ← (verify: every rejection path opens no file — assert via a filesystem spy or by pointing the catalog at a path that would throw if opened)
- [x] 1.5 Add a case asserting that no operation `_handleAgentSettings()` accepts takes a filesystem path — enumerate the accepted operation names and their payload keys and assert none is a path input. ← (verify: this is the change's security claim; it must fail if a path-taking operation is ever reintroduced)

## 2. Host: test migration for the removed operations

- [x] 2.1 In `host/test/agent-skills-ops.test.mjs`, rewrite the cases that exercise library behavior through `skills_import`/`skills_refresh` (mid-run refresh isolation, snapshot immutability across a run, refresh preserving enabled state) to call `host/agent/skills/index.js` directly, preserving each assertion unchanged.
- [x] 2.2 Drop only those operation-level cases whose assertion is already made against the library in `host/test/skills-catalog.test.mjs` (invalid metadata, duplicate name, path traversal, symlink escape, no script execution). For each one dropped, confirm the equivalent library case exists before removing it.
- [x] 2.3 Run `host/test/skills-catalog.test.mjs`, `host/test/agent-skills-ops.test.mjs`, `host/test/agent-skills-author.test.mjs` and `host/test/agent-skills-wiring.test.mjs`. ← (verify: import-pipeline coverage did not drop — every assertion removed in 2.2 has a named counterpart that still runs)

## 3. Extension: skills client and controller

- [x] 3.1 In `extension/settings/skills-client.js`, remove `importSkill()` and `refreshSkill()`, add `readSkillSource(name)` calling `skills_read_source`, and update the file's documented wire contract to match the operation set that now exists.
- [x] 3.2 In `extension/settings/skills-controller.js`, remove `importDraft`/`importing` from state and `setImportDraft()`/`importFromDraft()`/`refreshSkill()` from the class.
- [x] 3.3 Add `editingName` (`null` when composing fresh) to state, and `loadForEdit(name)` / `loadForDuplicate(name)` which fetch through `readSkillSource()` and populate `authorDraft`. Duplicate seeds a name not present in the loaded catalog (`<name>-copy`, `-copy-2`, …), truncating the base rather than exceeding the 64-character name limit. Clear `editingName` after a successful submit and on an explicit draft discard.
- [x] 3.4 Guard draft loss: `loadForEdit`/`loadForDuplicate` over a non-empty unsaved draft sets a pending-confirmation state instead of overwriting, and only proceeds on explicit confirmation.
- [x] 3.5 Add a `pendingRemoval` state (skill name or `null`) with request/confirm/cancel transitions, so removal confirmation is controller state rather than a browser dialog.
- [x] 3.6 Update `test/settings-ui-skills-client.test.mjs` and `test/settings-ui-skills-controller.test.mjs`: drop import/refresh cases, add cases for read-back forwarding, edit vs duplicate name seeding, the unsaved-draft guard, and the removal confirmation transitions. ← (verify: controller stays DOM-free — the suite must still run under plain Node with no DOM shim)
- [x] 3.7 Update `test/settings-ui-skills-real-catalog.test.mjs` to drive the same flows against the real `host/agent/skills/**` library, including editing a record that entered the catalog through a folder import.

## 4. Extension: skills page markup and binding

- [x] 4.1 In `extension/settings/skills.html`, remove the "Nhập skill mới" section: the `#import-row` block, `#import-path`, `#btn-import`, `#ic-folder` and their page-local styles.
- [x] 4.2 Add the explanatory note card stating that skills are composed in the app and that the app reads no directory on the machine; make "Tạo skill" `btn-primary`; restructure the author block per `design/Skills.dc.html`.
- [x] 4.3 Add the Soạn/Xem trước tab pair over the body field: `role="tablist"` with two `role="tab"` controls and one `role="tabpanel"` labelled by its active tab, arrow-key movement between tabs, and a character counter outside the panel as an `aria-live="polite"` region that announces on threshold crossings only.
- [x] 4.4 In `extension/settings/skills-app.js`, drop the import bindings and the "Nạp lại" button wiring; add per-card "Sửa" and "Nhân bản" bound to the controller's new methods; change the card provenance line to "Tự soạn · sửa lần cuối …" derived from `updatedAt`.
- [x] 4.5 Replace the `window.confirm()` removal path with the in-page confirmation card: focus moves to cancel on open, `Escape` cancels, focus returns to the invoking control on close, and nothing else inside the card is tabbable while it is open.
- [x] 4.6 Add the empty state ("Chưa có skill nào" with a primary action) and inline per-field error rendering with `aria-invalid` on the offending control and the message referenced by `aria-describedby`.
- [x] 4.7 Confirm no file under `extension/ui/**` was modified, and that `skills.html` contains no inline `<script>`. ← (verify: `git diff --name-only` shows nothing under `extension/ui/`; MV3 forbids inline scripts on extension pages)

## 5. Extension: settings page redesign

- [x] 5.1 Add the sticky chip navigation to `extension/settings/settings.html`: a `<nav>` with an accessible name holding in-page anchor links to the existing section headings, horizontally scrollable at narrow widths without the page body scrolling horizontally.
- [x] 5.2 In `settings-app.js`, mark the chip nearest the top of the viewport with `aria-current="true"` as the page scrolls, without hijacking normal anchor activation or keyboard focus order.
- [x] 5.3 Add the connection-status card at the top of the scroll area as a `role="status"` region rendering one of: not configured, configured but untested, testing, pass, fail — reading only existing controller state, and never initiating a connection test on load.
- [x] 5.4 Convert the model list's default-model affordance into one `radiogroup` with an accessible name, one radio per model, bound to the existing `setDefaultModel()`; keep the visible "Mặc định" label so the state has a carrier besides the radio itself. Leave add/edit/remove/reorder behavior unchanged.
- [x] 5.5 Update the Skills navigation row's sub-label to describe composing rather than importing.
- [x] 5.6 Confirm both pages remain usable at 320px with no horizontal body scroll, all interactive controls reachable and operable by keyboard with a visible focus indicator, and every new non-text state carried by something besides color. ← (verify: check at 320px and at default width, in light and dark theme, including the tab pair, the radio group and the confirmation card)

## 6. Documentation and validation

- [x] 6.1 Update any README or docs statement describing skill import from a folder so it describes composing in the app; add the statement that no interface accepts a filesystem path.
- [x] 6.2 Run `openspec validate redesign-settings-typed-only-skills --strict`.
- [x] 6.3 Run the full test suite for the touched areas: `host/test/agent-skills-*.test.mjs`, `host/test/skills-*.test.mjs`, `test/settings-ui-*.test.mjs`, `test/sidepanel-slash-picker-dispatch.test.mjs`. ← (verify: the slash-picker suite still passes — it calls the import library directly, which this change deliberately left intact, and is the clearest proof the library was not collaterally removed)
- [x] 6.4 Confirm the working tree carries no edit to `extension/background.js`, `extension/manifest.json`, `extension/sidepanel/tool-labels.js`, `host/tool-definitions.js`, `host/agent/tools/*`, `host/package.json`, `host/npm-shrinkwrap.json`, `test/registry-*.test.mjs`, `test/webfetch-url-guard.test.mjs`, `extension/webmcp/` or `test/fixtures/webmcp/` beyond what was already uncommitted before this change began. ← (verify: another session owns those files; an edit there is a scope violation, not a fix)
