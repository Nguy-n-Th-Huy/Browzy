## Context

nanobrowser's `chrome-extension/public/buildDomTree.js` is the reference. It assigns `highlightIndex++` to each interactive node while walking the DOM (`:1207`), draws an outline plus a numbered label into a single container pinned at `zIndex: 2147483647` (`:102`, `:150`), and excludes that container from its own traversal by id (`:1252`). browser-use does the same thing from the Python side.

Browzy's situation differs in one way that makes the port smaller, and one way that makes it more delicate.

**Smaller:** Browzy already has the identity. `getOrAssignRef()` in `extension/content.js` hands every serialized element a stable `ref_N` held through a `WeakRef` map, and `resolveRefToCoordinates()` already re-resolves, scrolls into view and hit-tests it at dispatch. nanobrowser had to invent `highlightIndex` and a selector map; Browzy only has to draw what it already has.

**More delicate:** nanobrowser and browser-use drive a browser nobody is looking at. Browzy draws on the tab the user is sitting in front of. Annotation is therefore something that happens *to the user's screen*, which is why it is transient, requested rather than automatic, and torn down inside the existing capture lease.

## Goals / Non-Goals

**Goals**

- A screenshot the assistant can act on directly, without a second call to learn what things are called.
- No new identifier scheme; the numbers are the refs.
- The page is left exactly as found, including when the capture fails.

**Non-Goals**

- Not automatic on every screenshot. Reading an article does not want eighty boxes on it.
- Not a replacement for `find` or `read_page`. Both remain, and remain better when the target is off-screen or named rather than seen.
- Not a change to dispatch. Resolution, scroll-into-view and hit-testing are untouched.
- Not a persistent overlay or an inspector — `design-mode-picker` already owns that.

## Decisions

### Decision: The label is the existing ref, not a new index

nanobrowser labels with a fresh per-capture integer and keeps a map from it back to the node. Browzy does not need that indirection and should not add it: a second identity would have to be kept in step with the first, and the failure mode when they drift is a click on the wrong element — the exact class of bug this change exists to remove.

Using `ref_N` also means an annotated capture and a page read are interchangeable views of the same thing, which is what makes the two routes composable rather than alternative.

The cost is that labels are longer than a bare integer. Rendering may abbreviate the common `ref_` prefix visually as long as what is read back is unambiguous; the reference passed to a tool is always the full identifier.

### Decision: Annotation is on by default, with an explicit opt-out

Originally specified off-by-default, on the reasoning that boxes should not land on the user's page while the assistant is merely reading. Shipping it that way showed the flaw: the assistant never asked for it. Every screenshot in the first runs after the feature landed carried `scale` and no `annotate`, so the capability existed and did nothing, and clicks went on being aimed by eye.

An option the model has to remember to want is an option that does not change behavior. The default is therefore on, with `annotate: false` for the cases where the boxes genuinely obstruct — reading body text, a table, an inspected image.

The cost of the wrong default in this direction is one frame of visual noise. The cost in the other direction is the failure this whole change exists to remove. Those are not comparable, and the default belongs on the cheaper side.

### Decision: Drawn and removed inside the existing capture lease

`takeScreenshot()` already brackets the capture with `requestOverlayHide()` / show, carrying a correlation id (`overlayCaptureIdCounter`) and a bounded wait (`OVERLAY_HIDE_WAIT_MS`) precisely so a slow or absent overlay never stalls a real capture. Annotation belongs in that same bracket, with the same bounds and the same `finally` teardown.

Reusing it rather than adding a parallel mechanism matters because the two would otherwise race: the product overlay hides, the annotation draws, and whichever restores last wins. One lease, one ordering.

### Decision: The container is excluded by id from serialization and from annotation

Exactly as nanobrowser does at `:1252`. Without this, the next `read_page` reports the annotation as page content, and the next annotated capture draws boxes around the boxes.

The container also must not receive refs of its own — otherwise annotating would advance the ref counter, and `mark-new-page-elements` would report the assistant's own drawings as newly appeared elements.

### Decision: Absolutely positioned overlay, never a style change on the element

Outlines are drawn as separate positioned nodes over the element's rects, never by setting `outline`/`border`/`background` on the element itself. Mutating the element risks reflow — which would move the very thing being pointed at, invalidating the capture — and risks not being cleanly reversible on a page with its own inline styles.

### Decision: A legibility floor on label size, tied to `scale`

`scale` (already in the working tree) reduces the returned image by area; a label sized for a full-size capture can become unreadable at 0.5. The label's rendered size accounts for the capture scale so the number survives to the model. nanobrowser clamps label font size to a floor (`:224`); the same idea, with the scale factor folded in.

## Risks / Trade-offs

**The user sees a flash of boxes on their own page.** This is the real cost and it cannot be fully removed — the annotation has to be on screen to be captured. Bounded by the capture lease, so it is one frame rather than a persistent layer. It is also arguably legible to the user as the assistant "looking" at the page, which fits the product's premise rather than fighting it.

**A dense page produces a cluttered image.** The reference screenshot shows roughly eighty labels. Mitigated by annotating only interactive elements in the viewport, and by annotation being opt-in.

**Fixed, sticky and iframe-hosted elements.** Their rects need the same coordinate treatment the existing capture path already applies; nanobrowser passes a `parentIframe` through for exactly this. The scroll-offset handling in `takeScreenshot`'s clip is the precedent to follow, and this is the most likely source of a misplaced box.

**Interaction with `probeHit`.** The container sits at maximum z-index, so a hit probe run while it is up would report the annotation as the covering element. Annotation exists only during capture and no dispatch happens inside that window, but the teardown must be reliable or clicks afterwards would report being covered by the assistant's own drawing.

## Migration Plan

Purely additive. The `computer` schema gains one optional field; `test/fixtures/registry-baseline.json` is regenerated for that entry alone. Existing screenshots, coordinates, refs and dispatch behavior are untouched.

Extension reload required.

## Open Questions

- Whether to abbreviate the `ref_` prefix in the drawn label. Leaning yes for density on crowded pages, provided the tool description states that what is passed back is the full reference. Decide during implementation against a real page.
