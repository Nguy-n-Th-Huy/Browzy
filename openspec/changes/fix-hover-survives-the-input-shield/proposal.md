# Proposal: the agent's own hover survives the input shield

## Why

Seen live, on a real run (`conv_d3bb74afe4104b5ae9`, 24 steps, 19 September): the goal named a site's nav menu. The run did everything right — it chose `HOVER` on "Đấu thầu" (confidence 0.99), the submenu opened, the observation listed "Thông tin nhà thầu", the decision named it, Jev resolved it at 0.98, the click dispatched to that element's own ref. The URL never changed. Then it hovered again, clicked again, hovered again — five times — until the operator stopped it. Its own recorded evaluation shows it understood the page perfectly: *"HOVER Đấu thầu đã mở menu ĐẤU THẦU hiển thị các mục con, trong đó có Thông tin nhà thầu"*.

The cause is two changes landing on the same day and defeating each other:

- `2026-09-18-add-hover-step-operation` added `HOVER` for exactly this case — "a menu or tooltip that appears only while the pointer rests on a control".
- `2026-09-18-fix-lock-suppresses-hover` added the full-viewport input shield, whose own proposal states the mechanism plainly: *"CSS `:hover` and hover menus are decided by the browser's hit-testing"*, so the shield *"takes the pointer so hit-testing never reaches the page — no hover state, no tooltip, no hover-only menu"*.

The shield is lifted while the agent's action is in flight, so the hover's own dispatch reaches the page and the menu opens. It re-arms the instant that dispatch completes — and the browser re-runs its hit test at the pointer's resting position, finds the shield on top, and takes the hover state straight back off the page. The menu closes before the next cycle can click anything inside it. The operator's own mouse, in a tab with no run, opens the same menu normally; that is the same difference.

Every hover-only menu and every hover tooltip is unreachable to the agent today. The `HOVER` operation cannot do the one job it was added for.

## What Changes

- **A completed `HOVER` holds the shield off** until the agent moves the pointer again. The hold is set when a hover settles, and ends at the next action that can move the pointer (click, hover, scroll, drag) — which lifts the shield through the in-flight rule anyway. So the shield re-arms the moment the next step's own dispatch settles, exactly as it does today for every other action.
- **The hold survives what happens between two steps.** The observation, a capture, a script: none of them can move the pointer, so none of them may take the hover off the page. This is what makes the hold useful at all — a step's observation and decision sit between the hover and the click that needs it.
- **Everything else about the lock is unchanged.** Click, wheel, key, paste and drop stay suppressed in capture phase while the hold is in force; the wait cursor and the indicator still show the page is held; the host stays `pointer-events:none`; Stop and Open-panel stay operable; teardown is untouched.

The cost, stated plainly: while the agent is holding a hover, the operator's own pointer can also produce hover states on the page. The window is bounded by the agent's next pointer action, and only hit-testing is conceded — no click, scroll, key or selection of the operator's reaches the page in it.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `browser-assistant-panel`: "A locked page answers no operator pointer input" gains the hover-hold exception, with the rule that ends it.

## Impact

- `extension/overlay/pointer-overlay.js` — one carried state field (`hoverHeld`), set when a hover settles, cleared by the next pointer-moving action's `start`, read by `shouldBlockInput()`. The existing `POINTER_ACTION_TYPES` set answers "did this action move the pointer?" for both the cursor label and this rule; no second copy of that taxonomy.
- `test/overlay-pointer.test.mjs` — reducer cases and a live wiring case (hover settles → shield off; observation → still off; click settles → shield back on).
- No host change. No change to the Jev loop, the dispatch discipline, or any tool.
