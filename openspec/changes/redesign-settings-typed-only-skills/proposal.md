## Why

Browzy's skill catalog has two authoring paths that produce identical records: importing a folder from the operator's filesystem (`skills_import` / `skills_refresh`, wired to a free-text folder-path field in Settings > Skills) and typing the skill directly into the panel (`skills_author`). The folder path is the weaker of the two. It requires the operator to have a valid `SKILL.md` already sitting on disk, it makes the skill's content invisible in the product (the card shows only a path), it forces a "Nạp lại" button whose only job is to re-read a directory the app does not own, and — most importantly — it means the companion exposes a wire operation that reads an arbitrary directory path supplied by the extension. Nothing in the product needs that reach: `authorSkill()` already composes a real `SKILL.md` under the app's own root and runs it through the identical validation pipeline.

Removing the folder path collapses two flows into one, lets the app tell the truth about what it touches ("the app does not read any directory on your machine"), and unblocks two things the folder model made awkward: editing a skill's content in place and duplicating an existing skill as the starting point for a new one.

At the same time the Settings screen itself is a single flat scroll of four unlabelled sections in which the connection status — the one fact that decides whether anything works — sits at the bottom of the provider block, and the model list shows which model is default as trailing text rather than as something selectable.

## What Changes

- **BREAKING (wire contract): the `skills_import` and `skills_refresh` operations are removed** from `_handleAgentSettings()` in `host/agent/companion.js`. After this change no wire operation accepts a filesystem path from the extension, and no wire operation reads a directory the application does not own. This is the security-relevant half of the change and is stated below as a checkable requirement rather than as a side effect.
- **`host/agent/skills/import.js` is NOT removed and its contract does not change.** `importSkill()` / `refreshSkill()` remain exactly as they are because `authorSkill()` runs on them (`host/agent/skills/author.js`: an authored skill is written to the app's own directory and then imported or refreshed through that same pipeline). What is removed is the *entry point through the wire*, not the library. Deleting the library would break the only remaining authoring path.
- **New wire operation `skills_read_source`**, taking a catalog `name` and nothing else, returning `{ name, description, body, allowedTools, userInvocable, modelInvocable }` read back from the skill's approved snapshot. This is what makes "Sửa" and "Nhân bản" possible: `listCatalog()` returns metadata only and has never carried the Markdown body. It accepts no path, resolves the snapshot directory itself from the catalog record, and re-validates the name segment before touching disk.
- **Settings > Skills becomes typed-only.** The "Nhập skill mới" block, the folder-path field, the "Nhập thư mục" button and the per-card "Nạp lại" button are removed, together with the controller state (`importDraft`, `importing`) and methods (`importFromDraft()`, `refreshSkill()`) and the client methods (`importSkill()`, `refreshSkill()`) that served them. "Tạo skill" becomes the page's primary action. Each card gains "Sửa" (loads the skill back into the form) and "Nhân bản" (loads it under a free name). The content field gains a Soạn/Xem trước tab pair and a character counter, because the whole Markdown body must now be composed in the panel rather than pasted in from a file.
- **Destructive confirmation moves in-page.** Removal currently goes through `window.confirm()`. It becomes an in-page confirmation card with real focus management, which is both an accessibility improvement and a correctness one — a native modal dialog blocks the extension page's event loop.
- **Settings gains orientation without hiding anything**: a sticky chip navigation bar over the existing sections, a connection-status card promoted to the top of the page, and a model list whose default entry is chosen through a radio group rather than reported as trailing text. The underlying behavior is unchanged — `setDefaultModel()` and `state.defaultModelId` already exist; this makes an existing capability visible and directly operable.
- **Card provenance copy changes** from a filesystem path to "Tự soạn · sửa lần cuối …", because after this change a path is no longer the truth about where a skill came from.
- Empty, invalid-input and confirm-removal states are specified explicitly rather than left to whatever the DOM happens to do.

Not a breaking change for stored data: existing catalog records — including any imported from a folder before this change — keep working, stay listed, stay toggleable, and can be edited and removed. Their snapshot is what `skills_read_source` reads, so "Sửa" works on them too.

## Capabilities

### New Capabilities

(none — this change removes an authoring path, redistributes its surface, and re-presents existing settings behavior)

### Modified Capabilities

- `agent-skills`: the "Local skill catalog" requirement is removed (it mandated the folder-import flow itself) and replaced by an "In-app skill catalog" requirement mandating typed authoring as the only way a skill enters the catalog, stating that no interface the extension can invoke accepts a filesystem path, and covering reading a stored skill back for editing and duplication.

## Impact

- **Extension (modified)**: `extension/settings/settings.html`, `settings-app.js` (chip nav, status card, model radio group); `extension/settings/skills.html`, `skills-app.js`, `skills-client.js`, `skills-controller.js` (import surface removed; edit/duplicate/preview/counter/confirm added).
- **Host (modified)**: `host/agent/companion.js` — two operation branches removed, one added.
- **Host (`author.js` narrowly changed, rest unchanged)**: `authorSkill()` gains an explicit `editing` flag so a folder-imported record can actually be edited, as this change's own requirement states (design.md D11). `host/agent/skills/import.js`, `manage.js`, `frontmatter.js`, `paths.js` are unchanged. The new read-back operation composes existing exports (`getSkill`, `snapshotDir`, `assertSafeSegment`, `parseFrontmatter`); it introduces no new file-reading primitive.
- **Shared layer (narrowly changed)**: `extension/ui/components.css` and `extension/sidepanel/sidepanel.css` — `.section-heading`, `.list-column` and `.list-item*` move from the panel's own stylesheet, which the settings pages never load, into the shared one they do. No token and no existing value changes; see design.md D10. Everything else under `extension/ui/**` is consumed, never edited.
- **Tests (modified)**: `host/test/agent-skills-ops.test.mjs` (its `skills_import` / `skills_refresh` operation cases must move to direct library calls or be dropped where `host/test/skills-catalog.test.mjs` already covers the same library behavior), `test/settings-ui-skills-client.test.mjs`, `test/settings-ui-skills-controller.test.mjs`, `test/settings-ui-skills-real-catalog.test.mjs`. Library-level import coverage in `host/test/skills-catalog.test.mjs` stays as-is; total coverage of the import pipeline must not drop.
- **Tests (new)**: a case proving no wire operation accepts a filesystem path, and cases for the read-back operation's name validation and traversal rejection.
- **Concurrent-work hazard**: another session holds uncommitted work in `extension/background.js`, `extension/manifest.json`, `extension/sidepanel/tool-labels.js`, `host/tool-definitions.js`, `host/agent/tools/*`, `host/package.json`, `host/npm-shrinkwrap.json`, `test/registry-*.test.mjs`, `test/webfetch-url-guard.test.mjs`, `extension/webmcp/`, `test/fixtures/webmcp/`. This change needs none of them and must not edit them.
