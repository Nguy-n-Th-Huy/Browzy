## Why

Describing a piece of a page to the assistant in words is the weakest link in every UI task Browzy is asked to do. "The blue button under the pricing table" costs the operator a sentence, costs the run a `find` call and often a screenshot, and still lands on the wrong element often enough to matter. The information the operator already has — they are looking straight at the thing — never reaches the model in the form the model can actually use.

Orca (`github.com/stablyai/orca`) solves this with one gesture: *"Click any UI element in a real Chromium window to send its HTML, CSS, and a cropped screenshot straight into your agent's prompt."* The operator points; the agent receives the element's markup, its resolved styling, and a picture of exactly that rectangle.

For Browzy this is unusually cheap, because the hard part is already built and shipped. `extension/background.js` already captures a screenshot clipped to an arbitrary CSS-pixel region — `normalizeCropRegion()` and the `Page.captureScreenshot` `clip` path serve the agent's own zoom feature, with scroll offset and device-pixel-ratio handling already correct. The composer already accepts, thumbnails, sends and persists image attachments. The panel already binds a page identity and already refuses to read pages a content script can never run on. What is genuinely missing is a *picker*: a mode in which the operator, not the agent, points at something.

## What Changes

- **A new operator-driven picker mode**, toggled from the side panel composer. While active, the bound tab shows a hover highlight over the element under the pointer, and a click selects it. `Escape` and a second activation both cancel. It is deliberately a mode, not a persistent state: it ends on selection, on cancel, and on any change of the bound page.
- **A selection produces one composer attachment plus one structured element record**: a screenshot clipped to the element's bounding rectangle, the element's sanitized `outerHTML`, and a filtered set of its computed styles. The screenshot rides the existing image-attachment path (`{id, fileName, mimeType, byteLength, objectUrl, blob}`, image MIME allowlist, 10 MB ceiling). The markup and styles ride alongside as their own record, so neither has to be smuggled through an image.
- **Values are stripped before anything leaves the page.** An element's `outerHTML` can carry a typed password, a session token in a `data-` attribute, or the contents of a hidden field. What crosses the boundary is defined explicitly and checkably, not left to whatever `outerHTML` happens to contain.
- **Both text payloads carry byte ceilings.** Over-ceiling markup or styles are truncated with the truncation stated in the record, never silently, and never sent unbounded.
- **Computed styles are a filtered set, not the full ~340 properties.** The full dump is mostly browser defaults, drowns the useful values, and would dominate the run's context window.
- **A picked element is bound to the page identity it came from.** If the bound tab or its URL changes between picking and sending, the operator is told and the send does not silently proceed — the same posture `page-context.js`'s `captureForSend()` already takes for the page-context chip itself.
- **Design mode is a user action, not an agent action.** It does not take the browser lease, does not pass through the approval gate, does not widen a run's tab scope, and cannot run while the agent is driving that tab. Nothing about it grants the agent reach it did not already have.
- **Restricted pages refuse explicitly.** `chrome://`, `chrome-extension://` and the extension gallery can never host a content script; activating design mode there says so rather than appearing to arm and then doing nothing.

## Capabilities

### New Capabilities

- `design-mode-picker`: the operator-driven page-element picker — activation and its refusals, the hover/select interaction and its cancellation, what a selection captures, what is stripped or truncated before leaving the page, how a selection is bound to a page identity, and the separation between this and the agent's own control of the browser.

### Modified Capabilities

(none — the composer control this adds is an ordinary panel control, already covered by `browser-assistant-panel`'s existing "Responsive and accessible controls" requirement; no existing requirement's behavior changes.)

## Impact

- **Extension (new)**: a picker content script under `extension/overlay/` (or a sibling directory), written as a classic non-module IIFE with named top-level functions — the same shape `extension/overlay/pointer-overlay.js` documents and for the same two reasons: `manifest.json` declares no `web_accessible_resources`, and `test/_extract.mjs` pulls pure functions out of the real shipped file to unit-test them in plain Node.
- **Extension (modified)**: `extension/sidepanel/sidepanel.js` and `sidepanel.html`/`sidepanel.css` (the composer toggle, the picked-element chip, its removal); `extension/sidepanel/panel-controller.js` (thread the element record through `sendMessage()` beside `attachments`); `extension/sidepanel/page-context.js` (bind and re-validate the picked element's page identity).
- **Extension (modified, CONTENDED — see below)**: `extension/background.js` (inject the picker, relay pick events to the panel, serve the clipped capture) and possibly `extension/manifest.json`.
- **Host**: the element record must reach the model as part of the user turn. Whether that is a new field on the existing message envelope or a rendered block in the turn text is a design decision, not a foregone one; either way `host/agent/` is touched.
- **Tests (new)**: pure-function coverage extracted from the picker script (geometry, sanitization, truncation, style filtering) plus panel-side coverage for the chip, the page-identity re-validation, and the refusal paths.
- **Explicitly unchanged**: the agent's tool surface. No new tool, no change to `host/tool-definitions.js`, no change to the approval gate or tab-scope authorization.

## Dependency — implementation is blocked, specification is not

`extension/background.js` and `extension/manifest.json` currently hold uncommitted work from a parallel session (the WebMCP page-tools stream), alongside `extension/sidepanel/tool-labels.js`, `host/agent/tools/mapping.js`, `host/agent/policy/authorization.js`, `host/tool-definitions.js`, `test/registry-*.test.mjs`, `test/fixtures/webmcp/` and `extension/webmcp/`. `background.js` is the single file this change most needs and the one that session is most actively editing.

Implementation therefore does not begin until that work is committed. This change is specified now — the design decisions below do not depend on how the WebMCP work lands, and settling them now is what makes the implementation a mechanical read of `tasks.md` later rather than a second round of design under merge pressure. `tasks.md` states the dependency as its first item.
