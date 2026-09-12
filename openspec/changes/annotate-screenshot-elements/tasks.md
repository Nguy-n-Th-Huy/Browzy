## 1. Annotation layer in the page

- [x] 1.1 In `extension/content.js`, add a draw routine that walks the same interactive elements `generateAccessibilityTree()` considers, limited to those in the viewport, and for each draws an outline over its client rects plus a label carrying its `getOrAssignRef()` reference.
- [x] 1.2 Put every drawn node inside one container with a fixed id, pinned at maximum z-index and `pointer-events: none`.
- [x] 1.3 Draw only as positioned overlay nodes — never set `outline`, `border`, `background` or any other style on the page's own elements. ← (verify: no page element is mutated; removing the container restores the page byte-for-byte)
- [x] 1.4 Add a teardown routine that removes the container, and make it safe to call when nothing is drawn.
- [x] 1.5 Exclude the container by id from `generateAccessibilityTree()`'s walk, from the `find` path, and from the draw routine itself, and ensure nothing inside it is ever assigned a ref. ← (verify: a `read_page` taken straight after an annotated capture contains no trace of the annotation, and the ref counter did not advance because of it)

## 2. Capture integration

- [x] 2.1 In `extension/background.js`, extend `takeScreenshot()` to request the draw inside the existing capture lease — the same bracket as `requestOverlayHide()`, sharing its correlation id and bounded wait.
- [x] 2.2 Tear the annotation down in a `finally` path so a capture that throws or times out still leaves the page clean. ← (verify: an induced capture failure still removes the annotation)
- [x] 2.3 Order annotation and the product overlay's hide/show so the two cannot race — one lease decides, not two independent brackets.
- [x] 2.4 Pass the capture's effective scale into the draw so label size can compensate for a downscaled image.
- [x] 2.5 Plumb the option through the `screenshot` action; leave `zoom` unannotated.

## 3. Schema and prompt

- [x] 3.1 Add the `annotate` boolean to `computer` in `host/tool-definitions.js`, on by default with `annotate: false` as the explicit opt-out. Describe what the labels are: the same references `find` and `read_page` return, usable directly as a click target.
- [x] 3.2 In `renderBrowserAutomationSystemPrompt()`, say that labelled screenshots are the normal case and when to opt out (`annotate: false`), and that a reference read off the picture is passed back exactly as one from `find`. ← (verify: the guidance does not undercut the existing find-first advice; annotation is an additional route, not a replacement)

## 4. Tests

- [x] 4.1 New `test/screenshot-annotation.test.mjs`: the draw routine labels an element with the same ref `getOrAssignRef()` returns for it; the container is excluded from the serialized tree; teardown removes everything; teardown is safe when nothing was drawn; annotating does not advance the ref counter for the container's own nodes.
- [x] 4.2 Assert no page element's inline style is modified by a draw/teardown cycle.
- [x] 4.3 Assert label sizing accounts for the capture scale, so a reduced-scale capture does not produce labels below the legibility floor.
- [x] 4.4 Regenerate `test/fixtures/registry-baseline.json` for the `computer` entry; confirm the diff adds only `annotate`.
- [x] 4.5 Run `node test/screenshot-annotation.test.mjs`, `node test/registry-baseline.test.mjs`, `node test/extension-scripts-parse.test.mjs`, then the full `test/*.test.mjs` sweep. ← (verify: only the two known-red files fail — `overlay-background-bridge`, `side-panel-group-scope`)

## 5. Check on a real page

- [ ] 5.1 MANUAL / NOT AUTOMATABLE OFFLINE — Reload the extension, annotate a dense real page, and confirm boxes land on their elements — particularly fixed headers, sticky bars and anything inside an iframe, the most likely places for a misplaced rect. ← (verify: this is the one thing the offline tests cannot cover; a box drawn in the wrong place is exactly the failure this change exists to prevent)
