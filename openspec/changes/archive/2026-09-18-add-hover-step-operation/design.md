# Design: Hover Step Operation

## Context

- Measured live (headless Chromium, dauthau.asia): `li.item-menu-lev1.dropdown` for "Đấu thầu" — fresh load: no `open`, submenu `display: none`; after `mouse.click` on the label: unchanged, still closed; after `mouse.move` onto it: `open` + submenu `display: block` (279 px tall, offering "Thông tin nhà thầu"). Both user runs died on exactly this: a click left `pageChanged: false`, then the model re-clicked the menu level and never reached the submenu item.
- The extension's `computer` tool already has the action: `hover` moves the pointer (humanized approach, parks still, Brave gets a settle window) and clicks nothing. `dispatch-checks.js` already returns non-send-class for it, so a hover needs no approval. Nothing on the extension side changes.
- The run's vocabulary is host-owned: `OPERATIONS` / `TARGET_BEARING_OPERATIONS` in `questions.js`, validated by `parseStepDecision`, routed by `runtime.js`.

## Goals / Non-Goals

**Goals:** the decision model can open hover-only menus and tooltips; it is told when; the step record shows exactly what was dispatched (a pointer move, no click).

**Non-Goals:** no composite hover+click step (two steps keep one operation per record and reuse the same selection protocol); no change to the no-progress guard (a hover that changes nothing counts like any executed action); no extension changes; no new gate.

## Decisions

### 1. `HOVER` is target-bearing, with `CLICK`'s candidate set

`OPERATIONS.HOVER = "HOVER"` joins `TARGET_BEARING_OPERATIONS`, so `parseStepDecision` requires an `intent` for it (existing rule), refuses `text`/`url` on it (existing generic rules), and the runtime asks the element-selection request with the `hover_target` head, whose candidates are built in `buildActionSpace` beside `CLICK`'s — every offered interactive element, because anything the pointer can rest on is hoverable. The supported-operations list gains `HOVER` when it has candidates, so the observation advertises it like the other target-bearing operations.

- *Alternatives rejected*: a `CLICK` variant flag ("click: false") — an operation is the decision's unit and its own record; a coordinate-carrying op — coordinates are exactly what the selection protocol exists to avoid.

### 2. Dispatch: `computer`'s `hover` by ref, once, on the guarded path

`{ action: "hover", ref: target.ref, tabId }` through the `computer` tool, recorded with history kind `hover`. The send-class classifier already returns false for hover (`dispatch-checks.js`), so `runHostSideChecks` passes it without an approval card exactly as scroll does; every other gate applies unchanged. The identical-re-click guard stays `CLICK`-only: a repeated hover is cheap, and re-hovering after the pointer moved elsewhere can be exactly what a hover-only menu needs.

### 3. The instruction teaches the pattern, once

`NEXT_STEP` gains `HOVER` in the two enumerations (operations, operations requiring an intent) and one behavioral line: menus and tooltips that appear only while the pointer rests on a control need `HOVER` — a click on such a control does nothing; hover the control the intent names, then `CLICK` an item the menu then offers. The existing "if an action left the page unchanged, do not repeat it" already pushes the model off a click loop.

### 4. Record and label

`KIND_BY_OPERATION` gains `hover`; `summarizeArgs` already carries `action`/`ref` generically; the panel's computer-op label map gains `hover` ("Đã di chuột") beside `mouse_move`.

## Risks / Trade-offs

- **[A hover step can burn a decision when the element has no hover behavior]** → it counts toward the no-progress guard like any other no-change action, and the model sees the unchanged page in the next observation.
- **[Hover state and the next click]** → pointer state persists between dispatches (the extension tracks it), so a following CLICK on a revealed item keeps the menu chain hovered; if a site closes the menu on the click's press, the record shows it and the model recovers with a re-hover.
