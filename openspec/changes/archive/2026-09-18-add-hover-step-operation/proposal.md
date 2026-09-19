# Proposal: Hover Step Operation

## Why

Live, twice, on dauthau.asia: the run's goal was to reach a contractor page through the site's top menu. The menu's dropdown opens **only while the pointer rests on the menu item** — measured directly in Chromium against the live page: after a click on "Đấu thầu" the item stays without its `open` state and the submenu stays `display: none`; after a pointer move over it the item gains `open` and the submenu becomes `display: block` with its items (including "Thông tin nhà thầu") offered. Both runs show the same dead end — the click changes nothing (`pageChanged: false`), the model clicks again, loops over the menu, and the goal never progresses.

The cause is the run's own vocabulary: the step decision can `CLICK`, `TYPE_TEXT`, `SELECT`, `NAVIGATE`, `SCROLL_*`, `WAIT`, `DONE`, or `BLOCKED` — there is no way to say "rest the pointer here". The extension already implements the missing action (`computer`'s `hover`: a real pointer move with a settle window, never a click; the send-class gate already classifies it as non-send), so the fix is to give the run's decision model the operation.

## What Changes

- **`HOVER` joins the step-decision vocabulary** as a target-bearing operation: the decision carries a bounded intent, the element-selection request resolves it exactly as a `CLICK`'s is resolved, and the dispatch moves the pointer over the selected element without clicking — once, on the same guarded path (run-state, lease, tab scope, protected backstop; no approval card, hover being non-send-class).
- **The instruction tells the model when**: hover-only menus and tooltips exist, a click that leaves such a menu closed is the signal, and the pattern is `HOVER` the named control, then `CLICK` an item the menu then offers.
- **Unchanged**: every other operation, the selection protocol, the gates, the no-progress semantics (a hover that changes nothing counts like any executed action), and the extension itself (the action already exists there).

## Capabilities

### New Capabilities
- (none)

### Modified Capabilities
- `typesafe-jev-provider`: "Step decisions from the configured model" (the vocabulary and the intent list gain `HOVER`, plus the dispatch sentence and a scenario).

## Impact

- **Host**: `host/agent/jev/questions.js` (vocabulary, target-bearing set, candidates), `host/agent/jev/text-helper.js` (instruction + docs), `host/agent/jev/runtime.js` (dispatch branch, history kind, header comment), tests `host/test/jev-questions.test.mjs`, `host/test/jev-text-helper.test.mjs`, `host/test/jev-runtime.test.mjs`.
- **Panel**: `extension/sidepanel/tool-labels.js` (one label).
- **Docs/specs**: `openspec/specs/typesafe-jev-provider/spec.md` via this change's delta.
