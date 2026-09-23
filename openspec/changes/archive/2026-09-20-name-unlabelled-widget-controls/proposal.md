## Why

A widget control that carries no accessible name reaches the decision model as an empty row: no name, and — because it is a `div` rather than a form element — no value either. The model is handed a blank, and when a page nests two such blanks inside one another it cannot tell them apart or know which one opens the menu.

This is observed, not theoretical. Run `run_...` in conversation `conv_60398a2d6b8cfa5caf` was asked to switch the "Tìm theo" filter on the national procurement portal's advanced search from "Thông báo mời thầu" to "Kế hoạch lựa chọn nhà thầu". It opened the advanced search panel successfully, then clicked an element whose recorded `target.label` was the empty string, clicked the same reference again, and was stopped: `repeated_no_change` five times, then `blocked / no_progress`. The element count stayed at 74 across both clicks, so the menu never opened.

Measuring the live page explains it exactly. The control is an Ant Design select whose visible text lives in a child the snapshot does not capture:

```
div.ant-select[tabindex=0]                     captured
  div[role=combobox].ant-select-selection      captured
    div.ant-select-selection__rendered         not captured
      div…  "Thông báo mời thầu"               not captured
```

Both captured elements have no `aria-label`, no `aria-labelledby`, no `title`, no associated `<label>`, and no value of their own. Two sources could have named them and both decline:

- the direct-text fallback is gated on a tag allow-list (`a`, `button`, `h1`–`h6`, `li`, `summary`, `label`, `th`, `td`, `span`) that does not include `div`, so a `div`-based control can never fall back to its own text;
- the context-label fallback only accepts a sibling that is a `<label>`, `<legend>` or `<th>`, or whose class matches a small label-ish pattern — and this page's "Tìm theo" caption is none of those.

So the row is named `""`. Worth stating plainly: when the same measurement opened the menu, it produced a perfectly standard `<ul role="listbox">` with `<li role="option">` children carrying correct text, all of which the snapshot already captures. The options were never the problem; naming the control that opens them is.

## What Changes

- The context-label fallback recognises a visible field caption by its shape as well as by tag and class: a short, text-only sibling that carries no interactive descendant and precedes the control within the same field group. The existing depth limit and length bound are unchanged.
- The direct-text fallback applies to interactive generic containers as well as the tags it already covers, so a `div`-based control can stand in its own visible text when nothing else names it.
- The established priority is preserved exactly. A control with a real accessible name is unaffected — the fallbacks run only when every higher-priority source is empty. For a `role="combobox"`, the context label is still tried before the control's own text, because that text is the control's current value rather than its name.
- An unnamed widget control therefore reaches the model identifiable: named by its caption when the page provides one, and otherwise by the value it is displaying.

No breaking changes.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `agent-browser-runtime`: the requirement "Page snapshot operation" gains a statement that a visible, enabled interactive control is never listed without something that identifies it, and that a control's own text may name it only when no caption does.

## Impact

- `extension/content.js` — the accessible-name resolution's two fallbacks.
- `test/page-snapshot-content.test.mjs` — regression coverage for the newly named control, for the caption-wins-over-text ordering, and for the untouched cases.
- `openspec/specs/agent-browser-runtime/spec.md` — delta for the requirement above.

Out of scope, deliberately: the interactive-element test and the capture of `role="option"` / `role="listbox"` nodes, which measurement showed already work; the `repeated_no_change` guard in the decision runtime; the priority order of the accessible-name sources; `aria-label` values a page authors badly (this portal labels several inputs `"Default"`, which the standard says wins over everything, and overriding it would be wrong); and the snapshot's visibility test, reference assignment and bounds.

Note for validation: `openspec validate --specs --strict` across the whole repository already reports two pre-existing failures in `spec/workflow/page-snapshot` and `spec/workflow/snapshot-comparison`. They predate this change and belong to other work; this change must neither fix nor worsen them.
