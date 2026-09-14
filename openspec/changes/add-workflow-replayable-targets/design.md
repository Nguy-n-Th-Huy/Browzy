# Design

## Context

- Refs are ephemeral BY DESIGN: `content.js`'s `elementMap` is a document-scoped WeakRef map; `bumpDocumentEpoch()` deletes every entry on real navigation and SPA route changes, and the isolated world (hence the map) is lost on tab close/reopen and browser restart. Persisting it to disk was explicitly rejected (it would silently defeat the gate the map exists for).
- The trail already records, beside every ref the model used, that element's identity: search results carry `[ref_N] role "name" at (x, y)` lines, because the model needed them to choose a ref in the first place. That is the only surviving evidence of what a recorded ref pointed at.
- The executor already has the machinery a replay needs: `findElements` (fuzzy search that mints fresh refs), `getRefCoordinates` (scroll into view, hit test, reachability/detached/interception reporting), and `computer`/`form_input` dispatching off resolved coordinates.

## Goals / Non-Goals

**Goals:** a stored interactive step lands on the element it was recorded against, in a later session, without re-recording; the fetch still fails honestly, as drift, when the site genuinely changed; the freshness rule for definitions stays intact.

**Non-Goals:** a general selector language; persisting refs across sessions; coordinate fallbacks (a pixel is a guess — `ref-beats-coordinate` already settled that); healing existing stored refs automatically.

## Decisions

### 1. Freeze the identity; never the handle

A recorded `ref` with a known identity becomes `target: {role, name}`; the handle is dropped. Identity equality at replay is STRICT (whitespace-normalized, case-insensitive) with role preferred but not required (pages re-role controls; the name is the identity). A near-miss is a drift, not a click: unlike a coordinate, a wrong element here would be indistinguishable from a right one.

### 2. Read exactly the identity evidence out of tool results, and say so

Materialize's purity rule ("run outputs never reach a definition") existed so definitions never embed fetched content. The ref→identity evidence is metadata the definition NEEDS to be replayable at all, so the rule is narrowed exactly once, in code and comment, to two narrow line shapes: a search result's `[ref_N] role "name"` line, and a click result's `… landed on <tag> "Name"` description. The landing line is the stronger evidence — it names what that click actually received — and it is the only evidence that exists when a ref was picked off a screenshot; it wins the name, with the search line contributing the role only when it corroborates the same name. Landing evidence counts only where the element's text is a LABEL: `<select> "…"` quotes the control's option list (frozen once on 2026-09-15, unmatched by every later run), so form controls are skipped and the handle stays as recorded. Names are whitespace-normalized, length-capped, and anything that looks credential-bearing is refused. Nothing else from any result is read, ever. A ref number reused across a mid-run navigation (the counter restarts with the document) marks the ref ambiguous in whichever source sees the conflict — never a coin flip.

### 3. Unmapped refs are preserved, not guessed at

A ref whose identity never appeared in the trail (e.g. chosen off an annotated screenshot: her workflow's `ref_145` is exactly this) stays as recorded. Blocking the draft would make the feature unusable; inventing an identity would be a lie. The step still works inside the recording session and drifts honestly on replay.

### 4. Replay order: live ref first, frozen target second

Within one document a ref is more precise (it is the exact element, freshly minted), so it is tried first; the target is the fallback that survives documents. Both resolve through the same reachability/hit-test path, so `refCovering`/`refProxiedFrom` notes and the hit-probe reporting remain exactly as accurate for a target-resolved click as for a ref click.

### 5. Failure wording is classifier-compatible by construction

The drift classifier anchors on `^could not (resolve|bring)` and `ref "…" no longer exists`. Target failures reuse the same openings (`Could not resolve the step target …`, `Could not bring the step target … into view`), so drift classification needs no new vocabulary and older readers (batch stop conditions) keep working.

### 6. The replay starts at the recorded starting page

A workflow's steps only mean anything against the page state the run began on. That URL is recorded in exactly one place — the run's own first `tabs_context_mcp` result names its tab context — and the derivation speaks it as a leading `navigate` step (its host folded into the domain binding) whenever the trail does not already navigate, because the trail usually records no `navigate` for a page the operator already had open. A trail that navigates already says where it is going and is left alone; a trail that records no starting page gets no invented one.

### 7. Out of scope deliberately

- No automatic re-derivation of already-stored refs (re-derive or heal produces new steps; a migration is a different change).
- No `target` support on other tools (navigate/read/search steps address URLs and text, not elements).
- No panel rendering changes: the step summary stringifies args, so a `target` shows up like any other argument.
