## Context

See proposal.md — Why. The constraints that actually shape the approach:

- **`authorSkill()` is built on top of `importSkill()`/`refreshSkill()`.** `host/agent/skills/author.js` writes a composed `SKILL.md` into the application's own `authored/<name>/` directory and then runs the *same* import pipeline over it (`editingOwnSkill ? refreshSkill(name) : importSkill(dir)`). Every validation, capability detection, snapshot staging and hashing rule is therefore already shared between the two authoring paths. Removing the folder-import *library* would remove typed authoring with it.
- **The catalog record has no body.** `listCatalog()` returns `{ name, description, source, snapshotId, hash, version, enabled, userInvocable, modelInvocable, unsupportedCapabilities, importedAt, updatedAt }`. Nothing in it can populate an edit form. The approved snapshot does hold the full `SKILL.md`: `import.js` sets `snapshotId: meta.name` and `stageAndSwap()` writes the package files under `snapshotDir(snapshotId)`, with `SKILL.md` at its root.
- **`allowed-tools` is a frontmatter key, invocation flags are not.** `readManifestMeta()` reads `allowed-tools` from frontmatter; `userInvocable`/`modelInvocable` are product-owned catalog fields set by `setInvocationFlags()`. A read-back therefore has to compose from two places, and must not pretend the flags live in the file.
- **`extension/ui/**` is a shared, approved layer** consumed by both the settings pages and the side panel. Both settings pages already carry page-local `<style>` blocks and document that they never edit the shared layer, and the redesign stays inside that convention for layout. It does NOT stay inside it for one class of defect — see D10.
- **MV3 forbids inline scripts on extension pages.** All behavior lives in externally-loaded modules (`*-app.js`); `skills.html`/`settings.html` are markup plus a page-local stylesheet only.
- **The three-file split is the house pattern**: `*-client.js` (wire), `*-controller.js` (DOM-free state machine, unit tested from plain Node), `*-app.js` (thin DOM binding, verified by screenshots). New behavior goes into the layer that owns it, not into the DOM layer.

## Goals / Non-Goals

**Goals:**

- One authoring path, with the app able to state truthfully that it reads no directory of the user's.
- Edit and duplicate built on a read-back that cannot be steered at a path.
- Settings orientation improved without removing anything from the page or hiding content behind panes.
- No net loss of test coverage over the import pipeline.

**Non-Goals:**

- Changing `host/agent/skills/import.js`, `manage.js`, `frontmatter.js` or `paths.js`. This change composes their existing exports; it adds no new file-reading primitive. (`author.js` is changed, narrowly — see D11.)
- A Markdown *renderer* for the preview tab beyond what the project already ships (`extension/ui/prose.css` plus the panel's existing rendering path). The preview shows the composed body, it is not a new Markdown engine.
- Migrating or rewriting skills already in the catalog. Records stay as they are.
- Touching the side panel's own skills client or the slash picker. They only ever call `skills_list`, which is unchanged.
- Deleting orphaned `authored/<name>/` directories on removal. That behavior is unchanged and out of scope (see `author.js`'s note on it).

## Decisions

### D1. Remove the wire operations, keep the library

`skills_import` and `skills_refresh` are deleted from `_handleAgentSettings()` and their imports dropped from `companion.js`'s import list. `host/agent/skills/import.js` and `index.js`'s re-export of it are untouched.

*Why:* the security property the product wants to claim is "no operation the extension can issue reads an arbitrary directory". That is a property of the wire surface, not of the library. `authorSkill()` is an internal caller that only ever passes a directory the application itself just wrote under its own root.

*Alternative rejected:* keeping the operations wired but hiding the UI. The mockup's copy states the app reads no directory on the machine; a reachable operation that does exactly that would make the copy false, and an unused operation is a surface that outlives the reason it existed.

*Alternative rejected:* deleting `import.js` and inlining its pipeline into `author.js`. That duplicates symlink-escape, traversal, capability-detection and hashing logic which currently exists once and is covered by `host/test/skills-catalog.test.mjs`.

### D2. `skills_read_source` takes a name, never a path

New branch in `_handleAgentSettings()`:

```
skills_read_source  payload: { name }  ->  { name, description, body, allowedTools, userInvocable, modelInvocable }
```

Resolution order, all from existing exports:

1. `getSkill(name)` — absent record rejects with the existing `SkillNotFoundError` (`NOT_FOUND`), before any filesystem access.
2. `assertSafeSegment(record.snapshotId)` — re-validated at the point of use, matching the rule `paths.js` already applies everywhere else, so a catalog file tampered with out-of-band cannot steer the read.
3. Read `SKILL.md` from `snapshotDir(record.snapshotId)`.
4. `parseFrontmatter(raw)` → `description` and `allowed-tools` from the frontmatter, `body` from below it.
5. `userInvocable` / `modelInvocable` from the catalog record, not from the file — they are product-owned fields.

*Why the snapshot and not `record.source`:* the snapshot is the copy the application owns and the one a session actually runs. For a skill imported from a folder before this change, `record.source` points outside the app and may no longer exist; reading it would reintroduce exactly the reach this change removes.

*Why a separate operation rather than widening `skills_list`:* the list is fetched by the side panel's slash picker on every open. Bodies are unbounded Markdown; putting them in the list payload would grow a hot path for a rarely-used affordance.

### D3. Edit and duplicate are one form, distinguished by name

Both actions load the read-back into the existing author form. They differ only in the name they seed and in what the submit means:

- **Sửa** seeds the skill's own name. Submitting hits `authorSkill()` with that name, which `author.js` already treats as an in-place rewrite (`editingOwnSkill` → `refreshSkill()`), and the controller already reports it as "Đã cập nhật skill" rather than "Đã tạo".
- **Nhân bản** seeds a name that is not taken (`<name>-copy`, then `-copy-2`, … checked against the loaded catalog), leaving the original untouched. If the derived name would exceed the 64-character name limit, the suffix replaces the tail rather than pushing past the limit.

*Why not a separate edit screen:* the form already carries every field the record has. A second screen would duplicate validation display and the busy-state handling for no behavioral gain.

The controller gains `loadForEdit(name)` and `loadForDuplicate(name)`, plus `editingName` in state (`null` for a fresh compose) so the form's heading and submit label can say which of the three things is happening. Loading a skill into a form that already holds an unsaved draft asks for confirmation through the same in-page confirmation surface as removal (D5) rather than silently discarding typed work.

### D4. Compose/Preview is a tab pair, not a live split

`role="tablist"` with two `role="tab"` controls over one `role="tabpanel"`; arrow keys move between tabs, the panel is labelled by its tab. The compose tab holds the existing textarea; the preview tab renders the current draft body through the project's existing prose styling. The character counter lives outside the tab panel so it stays visible in both, and it is a `aria-live="polite"` region that announces only on threshold crossings, never per keystroke.

*Why a tab pair over a side-by-side split:* the page must work at 320px, where a split gives each half ~150px.

### D5. Destructive confirmation becomes an in-page card

`window.confirm()` is replaced by a confirmation card rendered in place of the card's action row: focus moves to its cancel control on open, `Escape` cancels, focus returns to the control that opened it, and it is the only thing in the card that is tabbable while open.

*Why:* a native modal blocks the page's event loop, which is a real hazard on an extension page driven by asynchronous companion messages; and the mockup specifies an in-page card with named consequences ("Nội dung skill này sẽ bị xóa khỏi kho của Browzy và không khôi phục được").

### D6. Settings chip nav is anchor navigation, not panes

The chips are real in-page anchor links to the existing section headings, in a `<nav>` with an accessible name, marked `aria-current="true"` on the section nearest the top of the viewport. The page keeps one continuous scroll and every section stays rendered.

*Why not tabs/panes:* panes hide content and add state that must survive validation errors and busy states in sections the user cannot see. The complaint the redesign answers is orientation, not length.

*Sticky behavior:* `position: sticky` under the header, horizontally scrollable at narrow widths (four chips do not fit at 320px), with the scroll container never causing the page body to scroll horizontally.

### D7. Model default becomes a radio group

The existing per-row "set default" affordance becomes one `radiogroup` with an accessible name, one radio per model, bound to the existing `setDefaultModel()`. The "· Mặc định" trailing text becomes the radio's checked state plus a visible label, so the state has a non-text-only carrier.

*Why:* the capability already exists (`state.defaultModelId`, `setDefaultModel()`); this is presentation. A radio group is the native control for "exactly one of these", which also gives keyboard semantics for free.

### D8. Connection status card is a view of existing state

The card reads `state.connectionStatus`, `state.hasCredential` and `state.defaultModelId` — all already in the controller — and renders one of: not configured, configured but untested, testing, pass, fail. It is a `role="status"` (`aria-live="polite"`) region. No new controller state, no new operation, and it does not test the connection on load — testing stays an explicit user action because it costs API usage (an existing, disclosed constraint).

### D9. Test migration

`host/test/agent-skills-ops.test.mjs` currently exercises the import pipeline *through* the removed operations. Each of its cases moves to whichever of these is true:

- The case asserts library behavior already covered by `host/test/skills-catalog.test.mjs` (invalid metadata, duplicate name, traversal, symlink escape, no script execution) → the operation-level duplicate is dropped; the library case is the coverage.
- The case asserts something only reachable through the operation layer (mid-run refresh isolation, snapshot immutability across a run) → rewritten to call the library directly from the same test file, preserving the assertion.

Two cases are added: one enumerating the operations `_handleAgentSettings()` accepts and asserting none takes a path-shaped payload, and one asserting `skills_read_source` rejects a traversal-shaped or unknown name without opening a file.

*Why not simply delete the file's import cases:* coverage of the pipeline must not drop just because its entry point moved. The assertions are the asset; the operation was only the harness.

### D10. Shared primitives move to the shared stylesheet

`.section-heading`, `.list-column` and `.list-item*` were defined only in `extension/sidepanel/sidepanel.css`, which neither settings page loads — so on both settings pages every one of those classes resolved to nothing: headings rendered as plain body text and each list row collapsed into stacked, unstyled spans. They are moved to `extension/ui/components.css` and removed from `sidepanel.css`.

*Why this overrides the "`extension/ui/**` is read-only" constraint stated above:* that constraint exists to stop a page-level change from quietly restyling every surface. Here the shared layer is where the bug is — a primitive used by three pages was living in one page's stylesheet. The alternative, copying the rules into each settings page's local `<style>`, duplicates the definition into the very pages that would then drift from the panel. The constraint was protecting against the wrong thing in this one case, so it is lifted deliberately and narrowly: two files, one block of rules, no values changed.

### D11. Editing adopts a foreign-sourced record

`author.js`'s `isOwnAuthoredSource()` treats a record as editable only when its `source` resolves under `authoredSkillsRoot()`. A record that entered the catalog by folder import never satisfies that, so `authorSkill()` threw `DUPLICATE_NAME` on every attempt to save an edit of one — contradicting this change's own requirement that such a record "can still be edited".

`authorSkill()` therefore takes an explicit `editing` flag. With it, a record whose source lies outside the authored root is ADOPTED: its `source` is re-pointed at the authored folder just written, then the ordinary in-place refresh runs. Without it, the `DUPLICATE_NAME` rejection is unchanged — the flag, not the name, carries the intent, because someone composing a new skill who picks a taken name must still be told the name is taken rather than silently overwriting the skill holding it.

*Why this overrides D1's "author.js is not modified":* D1's purpose was to protect the import pipeline `authorSkill()` runs on. That pipeline is untouched; what changed is one ownership predicate and one field re-point. Keeping D1 literal would have meant shipping a spec scenario the code cannot satisfy.

## Risks / Trade-offs

- **Removing a wire operation is a breaking contract change for anything that speaks it.** → Only `extension/settings/skills-client.js` ever sent them, and it is edited in the same change. The side panel's client sends `skills_list` only. A companion that receives an unknown operation already fails closed with a specific error rather than misbehaving.
- **A skill imported from a folder before this change loses its "Nạp lại" affordance**, so an edit made in the original folder no longer reaches the app. → This is the intended consequence, not a regression to paper over: the app no longer follows directories. The skill's content is still editable — through "Sửa", which loads the approved snapshot. Worth stating in the UI copy for such records rather than leaving the operator to discover it.
- **`skills_read_source` returns a full Markdown body over the wire.** → Bounded by what the operator themselves composed and by the existing snapshot; no secret ever lives in a skill body (the catalog record has never carried one). It is fetched on an explicit edit/duplicate action, never on list.
- **A tampered `catalog.json` could carry a hostile `snapshotId`.** → `assertSafeSegment()` is re-applied at the point of use rather than trusted from the record, matching what `paths.js` already does elsewhere.
- **The redesign touches two pages that another session's uncommitted work sits near.** → Scope is `extension/settings/**`, `host/agent/companion.js`, and the two files named in D10/D11; the hazard list in proposal.md is not to be edited.
- **Preview rendering could drift from how the panel renders a skill body.** → Preview reuses the project's existing prose styling rather than introducing its own; it is a formatting aid, and the stored artifact is the raw Markdown either way.

## Migration Plan

No data migration. Catalog records, snapshots and the on-disk layout are unchanged; the change is additive on the host (one operation) and subtractive on the wire (two operations) and in the UI.

Rollback is reverting the change: the removed operations are restored by restoring `companion.js`'s two branches and the client/controller/UI surface, since the library they call was never removed.
