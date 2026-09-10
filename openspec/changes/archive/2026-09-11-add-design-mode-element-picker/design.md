## Context

See proposal.md — Why. The constraints that actually shape the approach, each verified in the tree:

- **Region-clipped capture already exists and is already correct.** `extension/background.js` takes `opts.region` as `[x0,y0,x1,y1]` in CSS pixels (`:2860`), normalizes it against the viewport (`normalizeCropRegion()`, `:2837`), and builds the CDP clip adding `scrollX`/`scrollY` and multiplying by `shotScale * inverseDpr` (`:2930-2946`) before `Page.captureScreenshot` (`:2962-2965`). Getting the device-pixel-ratio and scroll-offset arithmetic right is the part that is normally wrong; here it is already shipped and exercised by the agent's zoom path.
- **Content scripts in this codebase are classic scripts, not modules.** `extension/overlay/pointer-overlay.js`'s header states both reasons: `manifest.json` declares no `web_accessible_resources`, so Chrome forbids a dynamic `import()` from a content script; and the file is written as one IIFE with named top-level function declarations precisely so `test/_extract.mjs` can pull pure functions out of the real shipped file and unit-test them in plain Node, with no bundler, no second copy and no browser.
- **The existing overlay is output-only.** `pointer-overlay.js` renders the agent's cursor, the active-control notice and a Stop button, driven entirely by the action-event stream. It never reads a pointer position from the operator. A picker is the opposite direction of data flow.
- **The composer already carries images end to end.** `extension/sidepanel/sidepanel.js:1282-1325` holds `attachments = [{id, fileName, mimeType, byteLength, objectUrl, blob}]` with an image-only MIME allowlist and a 10 MB per-image ceiling; `panel-controller.js:506` threads them through `sendMessage(text, {tabScope, profileId, modelId, pageContext, attachments, effort})`; `sidepanel.js:780-791` thumbnails them in the user bubble; the host persists them under `conversationAttachmentsDir`.
- **Page identity is already a solved problem in the panel.** `extension/sidepanel/page-context.js` keeps a monotonic `_revision` bumped whenever the displayed target actually changes, exposes `captureForSend()` which re-queries the live tab at send time and reports `changed:true` rather than dispatching against a target the operator never saw, and classifies `restricted` pages (`chrome://`, `chrome-extension://`, the extension gallery) from the URL string alone, without touching page content to find out.
- **Wire message types are flat snake_case** on a single `chrome.runtime` channel: `panel_bind_tab`, `tool_request`, `agent_settings`, `screenshot_saved`.

## Goals / Non-Goals

**Goals:**

- One gesture from pointing to a composed message that carries the element's picture, markup and styling.
- Reuse the clipped-capture, attachment and page-identity machinery rather than growing parallel copies of any of them.
- Make the privacy boundary explicit and testable, not a matter of what `outerHTML` happened to include.
- Keep the picker's pure logic unit-testable in plain Node, matching how the rest of this codebase tests content-script code.

**Non-Goals:**

- Any new agent tool. The agent gains no reach; this is an operator input path.
- Editing the page, or writing anything back to it. The picker reads and highlights only.
- Multi-element selection, region/rubber-band selection, or an element tree browser. One element per activation.
- Persisting picked elements across conversations, or a library of saved elements.
- Reproducing Orca's embedded-Chromium architecture. Browzy drives the operator's real browser; the picker runs in the page, not in a hosted browser view.

## Decisions

### D1. The picker is a separate content script, not a mode inside `pointer-overlay.js`

A new classic-script file (`extension/overlay/element-picker.js`), injected on demand by the same `chrome.scripting.executeScript({target:{tabId}, files:[...]})` call shape `background.js:1400` already uses for `OVERLAY_SCRIPT_FILES`.

*Why not extend the existing overlay:* `pointer-overlay.js` is 1533 lines whose single job is rendering what the agent is doing, driven by one event stream, and it is currently owned by an in-flight change (`repair-overlay-mount-and-visibility`). The picker has the opposite data direction (page → panel), a different lifetime (a brief mode, not the run's duration), and must not be mounted at all for the vast majority of runs. Merging them would couple a rarely-used operator affordance to the hot path that shows a run's cursor.

*Why not a module:* stated in Context — the manifest has no `web_accessible_resources`, and the extraction-based test harness requires named top-level declarations in a classic script.

### D2. Highlight and capture the element under the pointer, resolved at the topmost point

The highlight box is a fixed-position outline element the picker owns, positioned from `element.getBoundingClientRect()`, sitting above page content and **not** hit-testable (`pointer-events: none`), so it never becomes the element under the pointer itself. The candidate element comes from the event target during a capture-phase `mousemove`.

Selection listens in the **capture phase** and calls `preventDefault()` and `stopPropagation()`, so the click selects rather than activating a link or submitting a form. Every listener is registered with the same options object it is removed with, and teardown removes all of them plus the highlight node — this is what the spec's "the page receives events exactly as before" requirement rests on. `Escape` is handled on the same capture-phase basis so a page that swallows keydown cannot trap the operator in the mode.

*Alternative rejected:* `document.elementFromPoint()` polling on a timer. It re-queries on a schedule the pointer does not follow, and costs a layout read per tick on pages that are already busy.

### D3. Sanitize in the page, before anything crosses the boundary

Markup is serialized by cloning the selected element, walking the clone, and stripping values — never by sending `outerHTML` and cleaning it afterwards. Cleaning after the fact means the raw value has already crossed a process boundary and may sit in a message queue, a log or a crash dump.

What is removed from the clone, on the element and every descendant:

- `value` on `input` (attribute and property), text content of `textarea`, `selected` on `option`, `checked` on `input[type=checkbox|radio]`.
- The entire subtree of any element inside a password input's containing control.

What is preserved, because it is what makes the markup describable: `type`, `name`, `id`, `class`, `placeholder`, `for`, `aria-*`, `role`, `disabled`, `required`, `href`, `src`, `alt`, `title`.

`data-*` attributes are **preserved by default**. They frequently carry the framework hooks that make markup recognizable (`data-testid`, `data-component`), and blanket removal would gut the feature's usefulness. This is a deliberate trade-off, and it is the one place where a page could still leak an application-specific token into a message the operator chose to send. It is stated here rather than hidden: the operator sees the element they picked, the markup is theirs to send, and the alternative — dropping every `data-*` — makes the common case much worse to fix a case the operator can see coming.

### D4. Styles are a named subset, chosen for describing appearance

`getComputedStyle()` exposes roughly 340 longhand properties, nearly all at browser defaults. Transmitting all of them buries the handful that matter and spends the run's context window on `-webkit-border-before-color`. The transmitted set is fixed and named in one place in the picker:

- **Box**: `display`, `position`, `width`, `height`, `padding`, `margin`, `box-sizing`, `overflow`
- **Flex/grid**: `flex-direction`, `flex-wrap`, `justify-content`, `align-items`, `gap`, `grid-template-columns`, `grid-template-rows`
- **Type**: `font-family`, `font-size`, `font-weight`, `line-height`, `letter-spacing`, `text-align`, `text-transform`, `color`
- **Surface**: `background-color`, `background-image`, `border`, `border-radius`, `box-shadow`, `opacity`
- **Layering**: `z-index`, `transform`

*Why a fixed list rather than "properties that differ from the default":* computing a per-element default means instantiating a clean element of the same tag in an isolated document and diffing — expensive on every hover-free selection, and it drops values that happen to equal the default but are load-bearing for the description (`display: block` on a flex child).

### D5. Two payloads, two ceilings, truncation stated in the record

- Markup: 32 KB. Truncated at a tag boundary where possible, and the record carries `truncated: true` with the ceiling.
- Styles: bounded by D4's fixed list, so no ceiling is needed for it; the record still carries the list identity so a later reader knows what was and was not captured.

32 KB is roughly a large component's subtree and small against a run's context window. Both numbers live as named constants in the picker, referenced by the tests, so changing one is a visible edit rather than a scattered literal.

### D6. Capture reuses the agent's clipped-screenshot path unchanged

The picker sends the selected element's bounding rectangle in CSS pixels; `background.js` converts it exactly as it already does for the agent's zoom, and returns the clipped image. Nothing about `normalizeCropRegion()`, the scroll-offset addition or the DPR handling is modified or duplicated.

The rectangle is read at selection time, in the same frame as the selection, so a page that reflows immediately afterwards cannot shift what was captured relative to what was highlighted.

*Consequence, stated rather than papered over:* an element extending beyond the viewport is captured as the visible part only, because the underlying path clips to the viewport. Capturing the whole of a taller-than-viewport element would need scroll-and-stitch, which is its own feature; the record states when the rectangle was clipped so neither the operator nor the model believes it is seeing the whole element.

### D7. The element record travels beside the attachment, not inside it

`sendMessage()` gains one field alongside `attachments` — the element record `{ pageIdentity, selector, tagName, markup, markupTruncated, styles, rectClipped }` — rather than encoding markup into the image or splicing it into the operator's message text.

*Why not splice into the text:* the operator's own words and the captured markup are different kinds of content with different trust levels. The spec requires captured content to be data, never instruction; merging it into the text the operator typed is exactly the shape that makes that boundary hard to hold, and it would also let a long markup blob silently dominate a short question.

How the host renders the record into the model turn is left to implementation, with one constraint from the spec: it arrives clearly attributed as captured page content, not as operator instruction.

### D8. Page identity is the existing one, re-checked by the existing gate

The record carries the same page identity `page-context.js` already tracks, captured at selection with its `_revision`. At send, `captureForSend()`'s existing comparison covers it: a changed target already refuses to dispatch on that activation and requires a second, explicit Send. The picker adds a check that the element's recorded identity matches the one being sent, so a stale picked element is caught even when the chip itself looks unchanged.

*Why reuse rather than add a second mechanism:* two independent notions of "which page are we talking about" is precisely how a message ends up carrying an element from one page and a context chip from another.

### D9. Refusals are decided before the mode appears active

Two refusals are checked at activation, before any injection or highlight: the page is `restricted` (decided from the URL string by the existing classifier, without touching page content), or a run currently controls that tab. Both are reported in the panel with their specific cause. The control does not enter its active state in either case.

*Why refuse while the agent is driving:* the operator's capture-phase click handler and the agent's synthesized clicks would contend for the same page, and a picked element captured mid-run describes a page the run is actively changing.

## Risks / Trade-offs

- **`data-*` attributes are preserved (D3).** → A page-specific token in a `data-` attribute can reach the model in a message the operator chose to send. Mitigated by the operator seeing what they picked, and by every other value being stripped. Revisit if a real leak shows up; the alternative gutted the feature.
- **Capture-phase `preventDefault()` on click.** → A page relying on capture-phase click handling behaves differently while the mode is active. Bounded: the mode is brief, operator-initiated, and ends on the first selection. Teardown symmetry is what keeps it from outliving the mode, and it is the single most important thing for the tests to pin.
- **An element taller than the viewport is captured partially (D6).** → Stated in the record rather than hidden, so nothing downstream mistakes a partial picture for a whole one.
- **The picker runs in the page's world and can be observed by the page.** → It is operator-initiated and reads only what the operator points at; it holds no credential and no run authority. A hostile page could style itself to make the highlight misleading — the same limitation any in-page picker has, including devtools' own.
- **`background.js` is contended.** → Implementation is gated on the parallel session committing (proposal.md, and `tasks.md` item 1). Specifying now is what keeps that wait from also being a design wait.

## Migration Plan

Additive throughout. No stored data changes, no existing message shape changes, no change to the agent's tool surface. A conversation in which the operator never activates design mode produces byte-identical messages to today.

Rollback is removing the composer control and the injection call; the picker script is inert unless injected.

## Open Questions

- Whether the element record is rendered into the model turn as a fenced block in the user message or as a separate content part is an implementation choice that does not change any requirement or task boundary; both satisfy D7's attribution constraint.
