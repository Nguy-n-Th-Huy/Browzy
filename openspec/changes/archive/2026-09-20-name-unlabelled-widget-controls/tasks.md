## 1. Recognise a caption by its shape

- [x] 1.1 In `extension/content.js`, extend the context-label scan so a sibling may qualify as a field caption on its shape as well as on its tag or class: text-only content, no interactive descendant (the existing exclusion stays), within the existing length bound, and positioned before the control within the field group.
- [x] 1.2 Keep the existing ancestor-depth limit and length bound exactly as they are — they are what keep a shape-based rule from wandering into unrelated prose.
- [x] 1.3 Keep every sibling the current rule already accepts (`label`, `legend`, `th`, and the label-ish class pattern) accepted on the same terms. ← (verify: a page whose captions use the old markup gets byte-identical names before and after)

## 2. Let a generic container stand in its own text

- [x] 2.1 Extend the direct-text fallback so an interactive generic container may be named by its own visible text, keeping the existing length bound.
- [x] 2.2 Preserve the verified ordering: for `role="combobox"` the context label is still resolved first and the control's own text is used only when no caption was found. Do not reorder any other entry in the priority chain. ← (verify: the combobox ordering recorded in the existing in-file comment still holds, and no higher-priority source is bypassed)
- [x] 2.3 Record the invariant in the surrounding comments in the file's existing prose style — why a caption outranks a control's own text, and why an unnamed control is given its text rather than left blank. No plan, phase, change or audit identifiers.

## 3. Regression coverage

- [x] 3.1 In `test/page-snapshot-content.test.mjs`, add a case for an unnamed `div[role="combobox"]` whose displayed value lives in an uncaptured descendant and which has no caption: it is listed with a non-empty name that reveals the value it is displaying.
- [x] 3.2 Add the same structure with a visible caption preceding it in the field group: the caption names the control and the displayed value does not displace it.
- [x] 3.3 Add a case for a control that already carries an `aria-label` — including a poorly authored one: the name is reported unchanged and no fallback runs.
- [x] 3.4 Add a case for each sibling form the current rule already accepts (`label`, `legend`, `th`, label-ish class): names are unchanged from pre-change behaviour.
- [x] 3.5 Add a case for an unnamed interactive container holding or sitting beside long, unrelated text: no name is invented and the length bound holds. ← (verify: this test fails if the caption rule was widened without keeping the text-only, length and depth constraints)
- [x] 3.6 Confirm the two nested captured elements from the reported page — a `div` with `tabindex="0"` wrapping a `div[role="combobox"]`, both unnamed, both showing the same descendant text — are each listed with a name, so they can be told apart. ← (verify: reproduces the reported failure's exact shape and shows it resolved)

## 4. Validation

- [x] 4.1 Run `node test/page-snapshot-content.test.mjs` from the workspace root and confirm every test passes, including the pre-existing naming tests.
- [x] 4.2 Run `node test/page-snapshot-background.test.mjs` from the workspace root and confirm every test passes.
- [x] 4.3 Confirm each new test in group 3 fails against the pre-change `extension/content.js`, so the suite is load-bearing rather than merely green.
- [x] 4.4 Run `openspec validate name-unlabelled-widget-controls --strict` and resolve any reported issue. Do NOT fix the two pre-existing repo-wide failures in `spec/workflow/page-snapshot` and `spec/workflow/snapshot-comparison`; confirm only that they are neither introduced nor worsened by this change. ← (verify: both snapshot test files pass in full, the new tests are proven load-bearing, the delta validates, and the two pre-existing spec failures are untouched)
