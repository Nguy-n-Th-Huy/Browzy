# Wave 2E — extension summary (tasks 2.4, 7.1, 7.2, 7.3, 7.8, managed-policy relay)

Ground truth for what this wave actually shipped in `extension/**`. See
`tasks.md`'s own per-task notes for full detail; this file exists to flag one
cross-wave staleness issue for whichever session owns `docs/`/`README.md`.

## Files added

- `extension/managed-schema.json` — `chrome.storage.managed` schema (referenced from `manifest.json`'s new `storage.managed_schema` key). Without this, Chrome accepts no administrator policy for this extension at all.
- `extension/ui/permission-labels.js` — shared, pure (no `chrome`/`document`) display copy for mode/action-class/decision/protected-category labels, used by both `sidepanel/` and `settings/`.
- `extension/sidepanel/permissions-client.js`, `extension/settings/permissions-client.js` — thin `agent_settings` wire clients (`get_permission_state`/`set_permission_mode`, plus `revoke_site_entry`/`revoke_all_site_entries` in the settings one). Deliberately duplicated per surface, matching this repo's existing `skills-client.js` (sidepanel) vs `skills-client.js` (settings) precedent.
- `extension/settings/permissions-controller.js` — DOM-free state machine for Settings > Approved sites (mode control + site list + revoke), tested directly.
- `extension/settings/permissions.html` + `permissions-app.js` — the approved-sites/mode page itself, linked from `settings.html`.
- `test/permission-labels.test.mjs`, `test/settings-permissions-controller.test.mjs`, `test/permission-mode-panel-wiring.test.mjs`, `test/background-managed-policy-and-downloads.test.mjs` — new coverage.

## Files modified

`extension/manifest.json` (`downloads` permission, `storage.managed_schema`), `extension/background.js` (managed-policy push on hello_ack + `chrome.storage.onChanged` for `"managed"`; the `chrome.downloads.onCreated` pause/decision/resume-cancel gate, entirely local — see task 2.4's note in `tasks.md` for why it cannot route through `host/agent/policy/can-use-tool.js`), `extension/sidepanel/{conversation-model,protocol-client,panel-controller,sidepanel,sidepanel.html}.js/html` (protected-category/remember card copy, the download-decision card, the mode badge, mode-change card invalidation), `extension/settings/{settings.html,settings-app.js}` (nav entry to the new page), `extension/ui/icons.js` (added `lock`/`shield` icons).

## Cross-wave note for whoever owns `docs/`/`README.md`

`README.md` tasks 8.2 and 8.4 (already archived into their own checked-off
notes in `tasks.md`) were written when task 2.4 was still undone, and say so
explicitly: 8.2 states "page-initiated download observation is not yet
wired (no `downloads` permission ... no `chrome.downloads` listener ...)",
and 8.4 states the `downloads` permission "is not yet present in the shipped
manifest." **Both are now stale** — this wave added the `downloads`
permission and the `chrome.downloads.onCreated` gate (task 2.4, done). I did
not edit `README.md`/`docs/privacy-policy.md` myself (out of this wave's file
ownership, and another session may be mid-edit on them concurrently); those
two sections need a follow-up pass once this wave's changes are merged, to
describe the download gate as shipped rather than pending. The honest
architecture to describe: it is a fully LOCAL, extension-only pause/
decide/resume-cancel gate (chrome.downloads has no `tabId`, so it cannot
route through the host's per-call approval-token binding), gated on an agent
run currently holding the browser, and a download that completes before it
can be paused is reported (`download_notice`), never pretended to have been
blocked.

## Known, disclosed gaps

- The download gate's `pendingDownloadDecisions`/`activeAgentRuns` maps live only in the `background.js` service-worker's memory — an MV3 worker eviction mid-decision loses them, the same category of gap this file's other ephemeral maps (`pendingNative`, `screenshotSaves`, ...) already have and already accept.
- `permission-mode-panel-wiring.test.mjs` and `settings-permissions-controller.test.mjs` exercise the DOM-free logic directly; the DOM glue files (`sidepanel.js`'s render functions, `permissions-app.js`) are untested-by-design, matching this repo's existing convention (`settings-app.js`/`skills-app.js` are verified by captured screenshots, not unit tests — no such capture was performed here).
- Task 7.1's mode badge reloads on every fresh "ok" handshake but does not poll while connected — a mode change made from the Settings page while the chat panel is simultaneously open is picked up on the panel's next reconnect/render cycle that re-triggers a load, not instantly. Not a scenario the spec requires (no cross-surface live-sync requirement), but worth naming.
