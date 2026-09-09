# settings-migration

One-time export/import of **non-secret** settings and recorder session
metadata across an extension-id change — see
`openspec/changes/migrate-to-claude-agent-sdk/specs/stable-extension-installation/spec.md`
("Migration and diagnostics").

## Why you need this

Chrome (and every Chromium browser) partitions `chrome.storage` and
IndexedDB by extension id. If you were previously running this extension
**unpacked with no persistent key**, each browser/profile assigned it a
random id. Now that the extension ships a persistent public key
(`extension/manifest.json`'s `"key"`), it gets a new — but from now on,
permanent — id. The old extension's storage is not visible to the new one;
this is a one-time transition, not a recurring one.

`install.sh` / `install.ps1` print this same guidance after registering the
new build.

## What is carried over

- The non-secret operational config (`humanize`, `humanize_speed`,
  `humanize_seed`, `audit_mode` — the same settings `get_config`/`set_config`
  report).
- The recorder session index: one row per recording with its id, start/end
  times, first URL, event/utterance counts, on-disk `path`, transcript
  status, and the full behavior/cognitive/cursor trace — enough to
  repopulate the Options page's session list and its timeline view.

## What is NOT carried over

- **Secrets** (the OpenAI transcription key). Secrets are never exported.
  Re-enter them in the new extension's Options page after migrating.
- The cached `audio` Blob and `images` (thumbnail dataURLs). These are a
  disposable cache of what a session's `path` already points to — the
  native host writes the authoritative `trace.json`/audio/images bundle to
  disk at that path, independent of which extension id is active.
  **Host-side recordings are not touched or moved by this migration.**
  After import, a session's audio player and frame thumbnails won't be
  available in-app, but its `path` still resolves to the real bundle on
  disk (see the "Copy reference" button in Options).

## How to use it

This module is not yet wired into a Settings UI button (that lands with the
side panel / settings work in a later task group). Until then, run it from
each extension's own DevTools console:

1. Open `chrome://extensions` (or `edge://extensions`, `brave://extensions`).
2. Find the **old** (unkeyed) extension, click **Inspect views: service
   worker** or open its Options page and inspect that.
3. In the console:

   ```js
   const m = await import(chrome.runtime.getURL("settings-migration/migrate.js"));
   const data = await m.exportAndDownload(); // downloads ocic-legacy-export-<timestamp>.json
   ```

4. Install/reload the **new** keyed build, open its Options page console:

   ```js
   const m = await import(chrome.runtime.getURL("settings-migration/migrate.js"));
   const text = await (await fetch("<file:// or the downloaded file's blob/object URL>")).text();
   // or paste the exported JSON directly:
   //   const text = `...paste the file contents here...`;
   const result = await m.importFromText(text);
   console.log(result); // { importedSettings, importedRecordings, skipped }
   ```

5. Re-enter the OpenAI transcription key (if you used one) in the new
   extension's Options page.

## Testing

`migrate.test.mjs` exercises the actual export/import logic
(`buildExport`/`applyImport`) against an in-memory fake storage adapter —
no browser needed, since storage access is dependency-injected. Run:

```sh
node extension/settings-migration/migrate.test.mjs
```

The browser-only convenience wrappers (`exportAndDownload`, and
`defaultAdapter()`'s real `chrome.storage`/`indexedDB` calls) need an actual
extension environment and are BLOCKED in that test file — see its printed
BLOCKED note for the exact console commands to exercise them for real.
