## Context

See proposal.md — Why, for the motivation and the measured evidence.

Accessible-name resolution in `extension/content.js` walks a priority chain: `aria-label`, then `aria-labelledby`, then a submit input's `value`, then `placeholder`, `title`, `alt`, an associated or enclosing `<label>`, then the element's own text, and finally a context label drawn from a nearby sibling. The two tail entries are the ones this change touches, and each declines for its own reason:

- the direct-text entry is gated on a tag allow-list. It exists so that a link or a button can be named by what is written on it, and `div` was never added because a `div` is usually a container whose text belongs to something else.
- the context-label entry scans up to six ancestors for a sibling that looks like a field caption, recognising it by tag (`label`, `legend`, `th`) or by a class matching a small pattern. A caption that is a plain styled `div` matches neither.

One decision already recorded in that code constrains the fix. A comment there records a live finding on DauThau.info: for `role="combobox"`, the element's own text is the value it currently displays, not its name, so a run that searched for the control by that text never found it. The code therefore prefers the context label for a combobox and lets text stand in only when there is no caption. That ordering is verified behaviour and is preserved here; this change widens where the existing rule applies, and does not reorder it.

## Goals / Non-Goals

**Goals:**

- No visible, enabled control reaches the model as an unidentifiable blank row.
- A caption the page shows beside a control names that control, however the page marked it up.
- The verified combobox ordering — caption before own text — survives unchanged.
- A well-authored page sees no change at all.

**Non-Goals:**

- Overriding a name the page did author. This portal labels several inputs `aria-label="Default"`; the standard says `aria-label` wins, the snapshot is right to report it, and second-guessing it would make naming unpredictable.
- Capturing dropdown options. Measurement showed the opened menu already produces `role="listbox"` and `role="option"` nodes that the snapshot lists correctly.
- Touching the decision runtime's `repeated_no_change` guard. It behaved as designed; it only looked fatal because the control it banned was the one the run needed, and it needed it because the control was unnamed.

## Decisions

**Widen the two existing fallbacks rather than special-casing the widget library.**

The tempting shortcut is to recognise this component — match `ant-select`, read `.ant-select-selection-selected-value`. It was rejected. It fixes one library on one page and leaves every other unlabelled widget exactly as broken, and it puts third-party class names into the snapshot's naming rules, which then rot silently when the library changes. Both fallbacks already encode the right intent; they are simply too narrow about which markup counts. Widening them fixes the class of problem and keeps the rules describable without naming any framework.

**Recognise a caption by shape, not only by tag and class.**

A caption is short, is text through and through, holds no control of its own, and sits before the control it describes. Those properties are what make it a caption, and they are checkable without knowing how the page styled it. The existing guard that skips any sibling containing an interactive descendant already does much of this work and is kept; what is added is that a sibling passing those checks may be accepted on its shape rather than only on its tag or class. The existing depth limit and the existing length bound both stay as they are — they are what stop the scan from wandering into unrelated prose, and they are the reason a shape-based rule can be safe.

**Let a generic container stand in its own text, last.**

Once a caption has been looked for and not found, the alternative to the control's own text is an empty name, which is strictly worse: the model cannot act on a blank. For a combobox that text is its current value, so what the model gets is "this control is showing Thông báo mời thầu" — not the control's title, but enough to identify it among its neighbours and to see that it holds the wrong value. That is precisely what the failing run lacked.

## Risks / Trade-offs

**A shape-based caption rule could pick up text that is not a caption** → It must still clear every constraint the current rule imposes: no interactive descendant, within the existing length bound, within the existing ancestor-depth limit, and positioned before the control. A regression test drives the noisy case — a container of long, unrelated text — and asserts no name is invented from it.

**A combobox named by its own text reads as a value, not a title** → Accepted, and preferred over an empty name. The caption is still tried first, so this only happens where the page offers nothing better. A test locks the ordering so a future edit cannot silently flip it.

**More elements gain non-empty names, changing what the element table looks like on many pages** → Only elements that previously had an empty name are affected; anything already named is untouched, which is asserted by test. A blank row was never useful, so the change can only add information.

**Naming rules live in the extension and affect every page** → This is why the change is bounded to the two tail fallbacks and why the priority chain above them is explicitly out of scope. The existing snapshot test suite covers the surrounding behaviour and must pass unchanged.

## Migration Plan

Not applicable. The change is internal to the extension's page observation, alters no stored data, no wire format and no user-visible setting, and takes effect for observations made after it ships. Rollback is reverting the change.
