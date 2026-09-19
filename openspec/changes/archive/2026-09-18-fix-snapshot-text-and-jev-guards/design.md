# Design: Snapshot Text Visibility and Jev Scroll-Loop Guards

## Context

- **The failure, measured live** (conversation `conv_3c1b08a244ee270f59`, run `run_beba293ceaaec41734`): goal "phân tích gói thầu này" on a `dauthau.asia` tender page; 21 consecutive scroll steps in ~3.5 minutes; the model's own notes repeatedly said the returned page text contained only navigation/contact/footer chrome and that scrolling was ineffective; the run ended `blocked / no_progress` only when the table-based scroll brake finally tripped. Reproduced on the live page: the current extractor (`getPageText`, a **clone's `textContent`**) yields **111,724** cleaned characters, with "Chủ đầu tư" at index **7,075** — past the **6,000**-character snapshot text bound; the page's actual rendered text (`innerText`-equivalent) is **13,955** characters with "Chủ đầu tư" at **897** and "Danh sách hàng hóa" at **6,268**. The model received six thousand characters of invisible chrome; no operation could reveal more, because the extract does not depend on the viewport — so it scrolled.
- **The guards' gap**: the scroll brake counts scrolls that keep offering the *same controls*; on this page every scroll changed the viewport-first element table, and alternating directions reset nothing — so 21 fruitless scrolls passed before the brake fired. The recovery consultation at step 7 produced a correct plan ("stop scrolling; click the skip link") — which the step decisions then ignored.
- **See proposal.md** for motivation; deltas: `agent-browser-runtime` ("Page snapshot operation"), `typesafe-jev-provider` ("Bounded run and honest outcomes", "Step decisions from the configured model").

## Goals / Non-Goals

**Goals:**
- The snapshot's page text reflects what is **rendered** — invisible chrome cannot crowd out content — and the bound is sized so a long content page's content is reached.
- Consecutive scroll-only steps trip the same stall treatment as other guards, promptly, and cannot survive a recovery.
- The step-decision instruction obliges plan adherence and honest ends (`BLOCKED` when the goal's material is unobtainable); the completion check can confirm an information/analysis goal from gathered material.

**Non-Goals:**
- No change to the element table, reference semantics, or its bounds; no viewport-scoped text (the text stays a whole-page extract, deliberately); no change to dispatch/approval discipline, screenshots, or the other guards' semantics; no site-specific handling.

## Decisions

### 1. The extract walks the live DOM and keeps only rendered text

`getPageText` stops cloning-then-`textContent`. It walks the live tree and skips, besides the existing exclusions (`script, style, noscript, template, svg, [data-browzy-overlay], [data-browzy-annotation]`): any element that is not rendered — `Element.checkVisibility({ checkVisibilityCSS: true })` when available, else `getComputedStyle` (`display: none`, `visibility: hidden`) plus the `hidden` attribute and inline `display:none`. The masked-textarea rule becomes "a `textarea[data-browzy-masked]` contributes `••••••`" (its value is never read), and whitespace collapsing/trimming stays. Container selection and the coverage/fallback logic are unchanged, measured against the *rendered* body text.

- *Alternatives rejected*: raising the bound alone (111k of mostly-hidden text would still win); attribute-only stripping (`nav/header/footer/aside`) — measured: it leaves the content at index 6,820, still past 6,000, because this site's chrome is div-based; `innerText` on a clone (detached nodes have no rendering — the exact trap being fixed).

### 2. The text bound moves 6,000 → 10,000, consistently

Three places pin it and move together: `extension/content.js`'s snapshot bound, `host/agent/jev/questions.js`'s `MAX_PAGE_TEXT_CHARS` (the decision request's `page.text` projection), and the text-helper field context that re-bounds to the same promise. Rationale: on the failing page the goods list begins at 6,268 rendered characters — just past the old bound; 10,000 reaches it comfortably while the request fitter still enforces provider ceilings and truncation stays disclosed. (Old host + new extension and vice versa stay compatible: each side re-bounds independently.)

### 3. A scroll-only stall guard, with a post-recovery repeat rule

Exported `SCROLL_ONLY_STREAK_LIMIT = 8`. After each *executed* step, count consecutive executed steps whose operation is `SCROLL_UP`/`SCROLL_DOWN` — in either direction, regardless of element-table changes; any other executed step resets the count. On reaching the limit, the run takes the existing stall path (`recoverFromStall("no_progress")`): guidance revises the memory and the guard resets; refusal, an unavailable consultation, or a spent recovery bound ends the run blocked `no_progress` immediately. In addition, after a recovery that followed a scroll-stall trip, the *next executed scroll* ends the run blocked `no_progress` (a recovered plan must not be answered with more scrolling); any other executed step clears that flag. The table-based brake keeps its own semantics.

### 4. Instructions: plan adherence, honest ends, analysis-aware completion

`NEXT_STEP` gains: the memory's plan/notes are binding (do not repeat an action they call ineffective; choose the control they name); when the goal's material is unobtainable from this page with the available operations, choose `BLOCKED` naming the limit; for information/analysis goals, once the gathered material suffices, choose `DONE`. `COMPLETION_CHECK` gains: for such goals, confirm when the gathered material (page text, memory notes, captures) supports the requested analysis, naming anything unobtainable as a limitation. Tests assert the built request payloads carry these rules (instruction text is data the model reads; the assertions pin it).

### 5. Tests

- **Extension**: fixtures with large hidden menus ahead of content (content present within the bound); hidden-element visibility cases (`display:none`, `visibility:hidden`, `hidden` attr, inline); masked textarea still masked; truncation disclosure intact; container selection/fallback unchanged; the stand-in DOM harness extended to model hidden elements and provide the visibility seam.
- **Host**: the 8-scroll trip (either direction, with the table changing on every scroll), reset on a non-scroll step, post-recovery scroll → blocked, refusal/spent paths, and regressions on every existing guard test; instruction-payload assertions for the new NEXT_STEP/COMPLETION_CHECK rules.

## Risks / Trade-offs

- **[Visibility checks cost on very large DOMs]** → one walk with early skips; measured against the existing clone-everything cost; if a hot path appears, skip subtrees whose root fails the check (the implementer records the measurement in the change's tests/notes).
- **[A rare page whose content is genuinely hidden]** → excluded, as it is invisible to a human too; the element table still carries its controls.
- **[10,000-char text increases request size]** → the fitter and the provider ceilings still bound the request; truncation disclosure is unchanged.
- **[Guard false positives on legitimate long lists]** → 8 consecutive scroll *steps* with no other operation is already pathological; the recovery can steer, and a steered run continues.

## Migration Plan

1. Additive: no storage, profile, or wire change; host and extension can ship in either order (each side re-bounds the text independently).
2. Rollback: revert builds; nothing persisted depends on the new bound or guard.
3. Spec merge through this change's deltas at archive time.
