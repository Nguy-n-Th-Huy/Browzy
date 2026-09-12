## Why

A screenshot shows the assistant what the page looks like and tells it nothing about how to act on what it sees. The references that `computer` and `form_input` accept live in a separate text channel — `find` or `read_page` — so looking at the picture and knowing what to click are two different operations, one round trip apart.

That gap is where the original complaint comes from: shown a picture and asked to click something, the assistant reads a coordinate off the image by eye. A coordinate read by eye is an estimate, and a small target — a radio button, a checkbox, an icon — is exactly where the estimate lands next to the thing rather than on it.

nanobrowser and browser-use both close the gap the same way: draw a numbered box around every interactive element before capturing, so the number is in the picture. The assistant then names an element instead of estimating a position, from the one artifact it already has.

Browzy can do this without inventing anything new, because it already assigns a stable reference to every element it serializes. The number drawn on the screenshot can BE that reference — the same string `find` and `read_page` return, resolved at click time by the same `resolveRefToCoordinates` path that already scrolls into view and hit-tests. Nothing about dispatch changes; only what the assistant can see changes.

## What Changes

- `computer`'s `screenshot` action annotates by default: every interactive element in the viewport is outlined and labelled with its reference before the capture, and the labels are removed immediately after. `annotate: false` opts out for captures where the boxes would obstruct what is being read.
- The labels carry the existing reference identifiers. An annotated screenshot is therefore directly actionable: read a number off the picture, pass that reference to `computer` or `form_input`.
- Annotation is drawn into a dedicated container that is excluded from the tree Browzy serializes and from the assistant's own overlay handling, so it can never be mistaken for page content or annotate itself.
- The annotation is torn down within the same capture lease the product overlay already uses, so the page is left exactly as it was found.
- Label size has a legibility floor so a scaled-down capture (`scale`) still yields readable numbers.
- The browser-automation prompt explains when to ask for annotation: when about to interact, rather than when merely checking state.

Nothing is removed. Coordinates keep working, `find` and `read_page` keep working, and an unannotated screenshot is unchanged.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `agent-browser-runtime`: gains a requirement that a screenshot can carry the actionable identity of the elements it depicts, and that the annotation is transient and never becomes page content.

## Impact

- `extension/content.js` — draw and tear down the annotation layer; reuse `getOrAssignRef()` so labels are existing references, and exclude the container from `generateAccessibilityTree()`.
- `extension/background.js` — `takeScreenshot()` requests annotation inside the existing capture lease (alongside `requestOverlayHide`); the `screenshot` action passes the option through.
- `host/tool-definitions.js` — `annotate` on the `computer` schema; `test/fixtures/registry-baseline.json` regenerated.
- `host/agent/tools/query-options.js` — prompt guidance on when to annotate.
- `extension/background.js` and `extension/content.js` are extension code: an extension reload is required.

Interacts with two changes already in the working tree: `scale` (annotation must survive downscaling) and `mark-new-page-elements` (both reason about which elements are worth showing). Neither is blocked by this.
