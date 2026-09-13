## Why

Four operations that the browser capability baseline counts as preserved are not implemented. `gif_creator`, `shortcuts_list`, and `shortcuts_execute` return a hardcoded "not supported" sentence instead of doing anything (`extension/background.js:5668`, `:5672`, `:5676`), and `upload_image` (`:5524`) refuses every target that is not an `<input type=file>`, which excludes the editors users most want to paste an image into. Meanwhile the only way to move automation to another browser is `switch_browser` (`:5680`), which drops the native port and waits out a blind 15-second window (`SWITCH_RELEASE_MS`, `:766`) hoping some other browser grabs the shared runtime.

The baseline requirement in `agent-browser-runtime` already lists "GIF export, ... shortcuts, ... uploads, ... browser switching" among the preserved operations, and its "Baseline operation missing from the registry" scenario only checks registry *presence*. A stub therefore satisfies the current spec while delivering nothing, so preservation cannot currently be "measured by outputs and browser side effects" as that same requirement demands.

## What Changes

- `gif_creator` records the agent tab and returns a real animated GIF, with a click marker drawn at each dispatched click, replacing the placeholder string.
- `shortcuts_list` and `shortcuts_execute` gain real extension-side handlers behind the argument contract the native host already validates, replacing both placeholder strings.
- `upload_image` gains a coordinate-drop path for targets that expose no file input (Google Docs and comparable editors), while the existing `ref` → `DOM.setFileInputFiles` path stays unchanged for real file inputs.
- New `list_connected_browsers` and `select_browser` operations enumerate the browsers currently attached to the native host and transfer the runtime to a named one, reporting the outcome.
- **BREAKING** `switch_browser` is removed once `select_browser` lands. It has no callable contract worth preserving — its entire observable behavior is a text blob plus a timed disconnect — and keeping both would leave two ways to move the runtime with different failure modes.
- The baseline preservation requirement is strengthened so a registered-but-inert operation is reported as a preservation failure rather than passing on registry presence alone.

## Capabilities

### New Capabilities
<!-- None. All four operations belong to the existing browser runtime capability. -->

### Modified Capabilities
- `agent-browser-runtime`: adds requirements for real GIF export, real shortcut listing/execution, coordinate-based image drop, and explicit multi-browser enumeration/selection; strengthens "Preserve the browser capability baseline" so registry presence alone no longer counts as preservation; removes `switch_browser` from the operation set in favour of `select_browser`.

## Impact

- `extension/background.js` — four stubbed handlers replaced, `upload_image` extended, two handlers added, `switch_browser` and `SWITCH_RELEASE_MS` removed.
- `extension/recorder/offscreen.js` — reused as the GIF encoding site; it already owns `canvas`, `Image`, and `toDataURL`.
- `extension/content.js` — gains the coordinate-drop dispatch used by `upload_image`.
- `extension/events/action-events.js` — consumed as the click-marker source for GIF overlay; emission is not changed.
- `host/tool-definitions.js`, `host/agent/tools/mapping.js` — tool schemas and the tab-scope/mutation classification for the added and removed operations.
- `host/native-host.js`, `host/agent/broker/native-lease.js` — the native host becomes the authority that can enumerate attached browsers; today it arbitrates a lease but never reports who is connected.
- `openspec/specs/agent-browser-runtime/spec.md` — baseline operation count and the preservation criterion.
- Regression fixtures that assert the current placeholder strings will fail by design and must be updated to the real contracts.
