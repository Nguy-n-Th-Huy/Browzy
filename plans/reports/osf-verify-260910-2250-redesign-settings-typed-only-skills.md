# Verification Report: redesign-settings-typed-only-skills

Verified against: `specs/agent-skills/spec.md`, `design.md` (D1-D9), `proposal.md`, `tasks.md` (32/32 ticked), and the implementer's own report (`plans/reports/osf-apply-260910-2215-redesign-settings-typed-only-skills.md`).

`openspec validate redesign-settings-typed-only-skills --strict` → **valid**.

## Summary

| Dimension | Status |
|---|---|
| Wire-surface security claim (no path-taking op) | PASS — verified independently |
| `skills_read_source` reads snapshot, not `record.source` | PASS — verified independently |
| Invocation flags from catalog record, not frontmatter | PASS |
| `host/agent/skills/*.js` byte-identical | PASS — `git diff --stat host/agent/skills/` is empty |
| `extension/ui/**` untouched | PASS — `git diff --name-only -- extension/ui/` is empty |
| Test coverage (dropped op-level cases have library counterparts) | PASS — 1:1 mapping confirmed |
| No inline `<script>` | PASS |
| Accessibility markup (tabs, radiogroup, status, confirm-card focus, field errors) | PASS by code review |
| Task 5.6 (320px / theme / keyboard, live) | NOT VERIFIED LIVE — code review only, no browser available |
| **Legacy folder-imported record: "Sửa" (edit) actually saving in place** | **CRITICAL — spec/proposal claim not met** |

All specified test suites pass (see "Test run" below).

## CRITICAL

### 1. Editing a legacy folder-imported skill in place does not work — contradicts the spec scenario and an explicit proposal.md claim

Verified independently by reading `host/agent/skills/author.js` (byte-identical, confirmed via empty `git diff --stat`):

```js
const existing = getSkillRecord(validName);
const editingOwnSkill = existing ? isOwnAuthoredSource(existing.source, validName) : false;
if (existing && !editingOwnSkill) {
  throw new SkillValidationError("DUPLICATE_NAME", ...);
}
```

`isOwnAuthoredSource()` returns `true` only when `record.source` resolves to `skillsRoot()/authored/<name>` — the directory `authorSkill()` itself writes. A record that entered the catalog through the removed folder-import flow has `source` pointing at the operator's original external folder, so `isOwnAuthoredSource()` is always `false` for it, and submitting "Sửa" on such a record **always** throws `DUPLICATE_NAME`. This is deterministic, not a corner case — every legacy record hits it.

This directly contradicts:

- **`proposal.md` line 20**: *"...can be edited and removed. Their snapshot is what `skills_read_source` reads, so 'Sửa' works on them too."* — unambiguous, and false as shipped.
- **The ADDED requirement's scenario "A skill stored before this behavior existed"**: *"...it is still listed, can still be enabled, disabled, **edited**, duplicated and removed..."* — "edited" in ordinary reading means the edit can be saved, not merely loaded into a form that then rejects the save.

What actually works: `loadForEdit()` on a legacy record succeeds (reads the approved snapshot correctly via `skills_read_source`, confirmed by `test/settings-ui-skills-real-catalog.test.mjs`'s "real Sửa (edit): a legacy folder-imported record loads correctly..." case). Only the **save** half fails, every time, for every legacy record.

**Root cause, independently confirmed — genuinely blocked, not a scope shortcut.** `design.md`'s own Non-Goals list forbids touching `author.js`, and D1 commits to it being byte-identical. `author.js`'s `isOwnAuthoredSource()` guard is exactly what blocks in-place saving for a legacy record, and that guard cannot be widened without editing the one file this change explicitly forbids editing. Given the scope constraints as written, there is no way to make `proposal.md`'s "so 'Sửa' works on them too" claim true. This is a **contradiction inside the change's own design artifacts** (D1's byte-identical commitment vs. proposal.md's explicit behavioral claim and the ADDED requirement's scenario), not implementer sloppiness.

**How the implementer handled it (verified, not just claimed):**
- Surfaced explicitly in their report before code was written.
- `skills-controller.js` detects `editingName === name && err.code === "DUPLICATE_NAME"` at submit time and replaces the generic banner with a specific one pointing at the working alternative (Nhân bản → edit the copy → optionally remove the original).
- The failure is proven end-to-end against the **real** library in `test/settings-ui-skills-real-catalog.test.mjs` ("real Sửa (edit): a legacy folder-imported record...", line ~287) — the test asserts the rejection and the untouched catalog, i.e. it encodes the actual (broken) behavior honestly rather than asserting a false pass.
- The Nhân bản (duplicate) workaround is also proven to work end-to-end for legacy records in the same file, including that the resulting duplicate can then be edited in place.

**This is not being reported as a fabricated/stubbed test or a hidden bug** — the implementer's tests and messaging are honest about the limitation. It is reported as CRITICAL because the shipped behavior does not match what `proposal.md` explicitly promises and what the ADDED requirement's scenario describes, and an operator reading the Settings UI's own copy ("Sửa") for a legacy skill will hit a save failure with no indication beforehand that saving won't work — only after clicking submit.

**This needs a decision from the user**, per the two options the implementer already identified (do not resolve unilaterally):
1. A follow-up change scoped to widen `author.js`'s in-place-edit guard for a record that is not reachable through any other wire op (the "real fix" — requires reopening the byte-identical constraint on `author.js`).
2. Amend the ADDED requirement's "Load a stored skill back for editing" scenario and `proposal.md` line 20 to say a legacy record is *duplicated* into an editable copy rather than edited in place — matching what actually ships, and updating the Settings UI copy so this is disclosed before submit, not after.

## Verified conformant (no findings)

- **Wire-surface claim**: `_handleAgentSettings()` (`host/agent/companion.js:913-1112`) has 8 skills-related cases: `skills_list`, `skills_read_source` (`{name}`), `skills_author` (`{name, description, body, userInvocable, modelInvocable, allowedTools}`), `skills_enable`/`skills_disable`/`skills_remove` (`{name}`), `skills_set_invocation_flags` (`{name, userInvocable, modelInvocable}`), and the unrelated `get_advertised_commands`. None accepts a path-shaped field. `host/test/agent-skills-read-source.test.mjs` enumerates this from `companion.js`'s own source at runtime (regex over the actual method body + a payload-key denylist scan) and pairs it with a runtime behavioral probe that `skills_import`/`skills_refresh` are unreachable (`PROTOCOL_ERROR`). This is a real enumeration, not a hardcoded mirror of the implementation.
- **`skills_read_source` resolution order** matches D2 exactly: `getSkill(name)` (not-found before any FS access) → `assertSafeSegment(record.snapshotId)` (wrapped as `PATH_TRAVERSAL` on failure) → `fs.readFileSync(snapshotDir(safeSnapshotId)/SKILL.md)` → `parseFrontmatter()`. It never reads `record.source`. `userInvocable`/`modelInvocable` are taken from `record`, never from the parsed file — confirmed at `companion.js:1055-1056`.
- **`host/agent/skills/{import,author,manage,frontmatter,paths,index}.js`**: `git diff --stat host/agent/skills/` is empty — genuinely byte-identical. `authorSkill()`'s only remaining callers are `skills_author`'s handler; `importSkill`/`refreshSkill` are still invoked internally by `author.js`, confirmed live by `host/test/agent-skills-author.test.mjs`'s "re-saving the form for an authored skill rewrites its own SKILL.md and refreshes in place" case.
- **Task 1.1's literal text vs. implementation**: tasks.md says "Import only from `host/agent/skills/index.js`", but `index.js` does not (and, per `git diff`, still does not) export `snapshotDir`/`assertSafeSegment`/`parseFrontmatter`. The implementer imported `snapshotDir`/`assertSafeSegment` from `paths.js` and `parseFrontmatter` from `frontmatter.js` directly into `companion.js`, keeping `index.js` untouched — documented inline with a comment explaining the conflict. This resolves the tension in favor of the stricter, machine-checkable acceptance criterion (`git diff --name-only` over `host/agent/skills/**` empty) and matches `proposal.md`'s Impact section, which lists the composed exports without mandating the `index.js`-only import path. Not a defect — flagging as a documentation inconsistency in `tasks.md` itself (MINOR).
- **Test coverage did not drop (task 2.2)**: the 5 dropped operation-level cases from `host/test/agent-skills-ops.test.mjs` (malformed metadata, duplicate name, path traversal, symlink escape, no-script-execution) map 1:1 onto existing, still-passing cases in `host/test/skills-catalog.test.mjs` ("malformed metadata rejected: ..." x5, "duplicate name rejected, first import untouched", "path traversal via frontmatter name rejected before any write", "symlink escaping the package root rejected (Windows junction)", "import never executes scripts found in the package"). Confirmed via `git diff` of the ops test file plus a fresh run of both suites.
- **No inline `<script>`** in `skills.html`/`settings.html`: only `<script type="module" src="...">` tags present, all external.
- **Accessibility**, verified by reading markup and binding code:
  - Soạn/Xem trước tab pair: `role="tablist"`/`role="tab"` x2/`role="tabpanel"`, `aria-selected`, roving `tabindex`, arrow-key handler in `skills-app.js`'s `wireBodyTabs()`, dynamic `aria-labelledby` on the panel.
  - Character counter: visible text counter plus a separate `aria-live="polite"` `#author-body-counter-announce` region that only updates text on threshold-band crossings (tracked via `lastAnnouncedBand`), not per keystroke.
  - Confirmation card (removal, D5): focus moves to Cancel on open, `Escape` cancels (`stopPropagation`), focus returns to the invoking "Gỡ bỏ" button on close via name-based lookup, and the row's enable/disable `<input type="checkbox">` toggle is explicitly `disabled` while confirming — nothing else is tabbable in the card.
  - Unsaved-draft guard card follows the same open/close focus pattern.
  - Radiogroup (D7): `#model-list` is `role="radiogroup"` with `aria-label`, one native `<input type="radio" name="default-model">` per model with its own `aria-label`, bound to `controller.setDefaultModel()`; visible "· Mặc định" label kept as a non-radio state carrier.
  - Field errors: `aria-describedby` wired on name/description/body inputs to their `.field-error` elements (`role="alert"`), `aria-invalid` toggled by `renderFieldError()`.
  - Chip nav (D6): real anchor links in a `<nav aria-label="...">`, `position: sticky`, `overflow-x: auto`; `aria-current` driven by an `IntersectionObserver`, never `preventDefault()` on click.
  - Status card (D8): `role="status"` at the top of the scroll area, reads only existing controller state, never tests on load (confirmed no test-triggering call in `renderStatusCard()`'s call sites).
- **Task 5.6** (320px/theme/keyboard live check): correctly **not** claimed as verified by the implementer — their report explicitly states "Not independently verified (no live browser available)". This verification agrees: no browser was used here either, so this remains unverified-live, confirmed only by code/CSS review (responsive rules, `overflow-x: auto`, existing `:focus-visible` tokens reused). Reporting this plainly rather than treating code review as equivalent to a live check.

## WARNING

- `extension/settings/errors-ui.js` (out of this change's file scope per `proposal.md`'s Impact section) still has stale copy: `DUPLICATE_NAME`'s action text says "...dùng Nạp lại để cập nhật..." (references the removed refresh button) and `NOT_FOUND`'s says "Kiểm tra lại đường dẫn thư mục..." (references a folder path). Confirmed present at lines 133 and 163. The controller routes around the one case that would actually surface `DUPLICATE_NAME` in the typed-only flow (in-place edit of a legacy record) with its own specific message, so this is low-impact today, but the stale copy is still live for any other path that surfaces these codes verbatim. Not a blocker for this change (correctly left alone, scope-disciplined), but worth a follow-up.
- The CRITICAL item above is really a spec-authoring defect (D1 vs. proposal.md line 20 / the ADDED scenario are in tension) that the implementer inherited and handled as well as the stated scope allowed. Recorded as CRITICAL because the shipped behavior does not match the written spec/proposal, per the verification brief's explicit instruction not to rationalize a divergence away — but the user should read the "how it was handled" section above before deciding severity/remediation, since this is not a quality lapse in the implementation itself.

## Test run (all commands actually executed, this session)

```
openspec validate redesign-settings-typed-only-skills --strict        → valid

host/test/agent-skills-read-source.test.mjs   8/8 PASS
host/test/agent-skills-ops.test.mjs          11/11 PASS
host/test/agent-skills-author.test.mjs        8/8 PASS
host/test/agent-skills-wiring.test.mjs        8/8 PASS
host/test/skills-catalog.test.mjs            16/16 PASS
host/test/skills-dispatch.test.mjs            PASS
host/test/skills-plugin-scope-verification.test.mjs   PASS
host/test/skills-scope-verification.test.mjs  PASS
host/test/skills-workflows.test.mjs           PASS

test/settings-ui-client.test.mjs              PASS
test/settings-ui-controller.test.mjs          PASS
test/settings-ui-no-conversation-leak.test.mjs PASS
test/settings-ui-real-companion.test.mjs      PASS
test/settings-ui-secrets.test.mjs             PASS
test/settings-ui-skills-client.test.mjs       PASS
test/settings-ui-skills-controller.test.mjs   PASS
test/settings-ui-skills-real-catalog.test.mjs PASS
test/settings-ui-validation.test.mjs          PASS

test/sidepanel-slash-picker-dispatch.test.mjs PASS
```

All green. Did not run `host/test/agent-tool-permission-preapproval.test.mjs` (out of this change's scope) — per the verification brief, its 26-vs-28-entry registry failure is known pre-existing damage from a concurrent session's WebMCP tool additions to `host/tool-definitions.js`, unrelated to this change.

## Scope discipline

`git status --porcelain` shows modifications to `extension/background.js`, `extension/manifest.json`, `extension/sidepanel/tool-labels.js`, `host/agent/policy/authorization.js`, `host/agent/policy/can-use-tool.js`, `host/agent/session/run.js`, `host/agent/tools/adapter.js`, `host/agent/tools/mapping.js`, `host/agent/tools/query-options.js`, `host/npm-shrinkwrap.json`, `host/package.json`, `host/tool-definitions.js`, `test/approval-gate.test.mjs`, `test/registry-*.test.mjs`, `test/webfetch-url-guard.test.mjs`, plus untracked `extension/webmcp/`, `test/fixtures/webmcp/`. All of these fall outside this change's `proposal.md` Impact list and match the documented concurrent-work hazard (WebMCP page-tools work and a `can-use-tool`/`run.js`/`query-options.js`/`approval-gate` thread from another session). Treated as "cannot verify ownership / another session's in-progress work," not flagged as defects, per this change's own hazard note and the verification brief's scope instructions.

Files this change actually modified, all within the declared Impact scope: `host/agent/companion.js`, `extension/settings/{settings,skills}.html`, `extension/settings/{settings,skills}-app.js`, `extension/settings/skills-{client,controller}.js`, `README.md`, `host/test/agent-skills-ops.test.mjs` (+new `agent-skills-read-source.test.mjs`), `test/settings-ui-skills-{client,controller,real-catalog}.test.mjs`, and the OpenSpec change directory itself.

## Unresolved questions for the user

1. For the CRITICAL item: widen `author.js`'s in-place-edit guard in a follow-up change (real fix, reopens the byte-identical constraint), or amend `proposal.md`/the ADDED requirement's scenario to say a legacy record is duplicated rather than edited in place (matches what ships, but should also update the Sửa button's copy for legacy records so the limitation is disclosed before submit, not discovered via a rejected save)?
2. Should `extension/settings/errors-ui.js`'s stale `DUPLICATE_NAME`/`NOT_FOUND` copy be cleaned up now (expands this change's file scope) or left for a later pass?
