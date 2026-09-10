## 1. Dependency gate (blocks every task below)

- [ ] 1.1 Confirm the parallel WebMCP session has committed its work before starting any implementation task. `git status --short` must show no uncommitted modification to `extension/background.js`, `extension/manifest.json`, `extension/sidepanel/tool-labels.js`, `host/agent/tools/mapping.js`, `host/agent/policy/authorization.js`, `host/tool-definitions.js`, `test/registry-*.test.mjs`, `test/fixtures/webmcp/` or `extension/webmcp/`. If any of those is still dirty, STOP and report — do not hand-split hunks in `background.js`, which is the file this change most needs. ← (verify: this gate is why the change was specified without being implemented; starting early is the one failure mode it exists to prevent)

## 2. Picker content script — pure logic first

- [ ] 2.1 Create `extension/overlay/element-picker.js` as a classic (non-module) IIFE with named top-level function declarations, matching `extension/overlay/pointer-overlay.js`'s documented structure and its stated reasons (no `web_accessible_resources`; `test/_extract.mjs` extraction). Add a header comment recording both.
- [ ] 2.2 Implement the pure functions, with no `chrome.*` and no DOM access, so they extract cleanly: the style filter over design.md D4's fixed property list, the markup truncation at design.md D5's 32 KB ceiling (truncating at a tag boundary where possible and reporting `truncated`), and the rect-to-region conversion producing `[x0,y0,x1,y1]` in CSS pixels.
- [ ] 2.3 Implement `sanitizeClone(el)` per design.md D3: clone first, then strip `value`/textarea content/`selected`/`checked` on the clone and every descendant; drop the subtree of a password control; preserve the named structural attributes and `data-*`. Never serialize the live element.
- [ ] 2.4 Name D5's ceilings and D4's property list as single top-level constants referenced everywhere else in the file, so the tests assert against the same constant the code uses.
- [ ] 2.5 Add `test/element-picker-pure.test.mjs` using `test/_extract.mjs` against the real shipped file: style filtering keeps exactly the listed properties and nothing else; a filled input, a textarea, a checked checkbox and a selected option all lose their value while keeping type/name/placeholder/label association; a nested control several levels down is stripped identically; a password value appears nowhere in the output; over-ceiling markup truncates and reports it. ← (verify: assert the password case against the full serialized output string, not just the attribute — a value can also survive as text content)

## 3. Picker interaction and teardown

- [ ] 3.1 Implement the highlight box: a picker-owned fixed-position outline positioned from `getBoundingClientRect()`, `pointer-events: none` so it can never become the element under the pointer, above page content.
- [ ] 3.2 Implement capture-phase `mousemove` tracking, capture-phase click selection calling `preventDefault()`/`stopPropagation()`, and capture-phase `Escape` handling so a page that swallows keydown cannot trap the operator in the mode.
- [ ] 3.3 Implement teardown: every listener removed with the same options object it was added with, the highlight node removed, all picker state dropped. Teardown runs on selection, on `Escape`, on a second activation, and on bound-page change.
- [ ] 3.4 Read the selected element's rectangle in the same frame as the selection (design.md D6) so a reflow immediately after cannot shift what was captured relative to what was highlighted.
- [ ] 3.5 Add `test/element-picker-lifecycle.test.mjs` against the minimal hand-rolled DOM fake this codebase already uses for overlay tests: after teardown by each of the four routes, the listener set and the node count are identical to before activation. ← (verify: listener add/remove symmetry is what the spec's "the page receives events exactly as before" requirement rests on — assert the exact listener tuples, not just a count)

## 4. Background wiring

- [ ] 4.1 Add the injection path for `element-picker.js`, reusing the `chrome.scripting.executeScript({target:{tabId}, files:[...]})` shape already used for `OVERLAY_SCRIPT_FILES` (`extension/background.js:1400`).
- [ ] 4.2 Add flat snake_case message handling matching the existing convention (`panel_bind_tab`, `tool_request`): panel→background activate/cancel, and content→background→panel selection delivery.
- [ ] 4.3 Serve the clipped capture by passing the picker's region straight into the existing capture path. Do NOT modify `normalizeCropRegion()`, the scroll-offset addition or the DPR handling, and do not duplicate any of it. Record in the result whether the rectangle was clipped to the viewport (design.md D6).
- [ ] 4.4 Enforce both activation refusals before anything is injected or shown (design.md D9): the page is `restricted` per `page-context.js`'s existing URL-string classifier, or a run currently controls that tab. Each refusal carries its specific cause. ← (verify: refusal happens BEFORE injection — an injected picker on a page that should have refused is the failure this ordering prevents)

## 5. Panel: control, chip, send

- [ ] 5.1 Add the composer toggle control with an accessible name, keyboard operable on the same terms as the other composer controls, and an active/inactive visual state carried by something besides colour.
- [ ] 5.2 Render the picked element as a removable composer chip showing which element was picked (tag plus a short recognizable descriptor), alongside the existing attachment thumbnails.
- [ ] 5.3 Route the clipped image into the existing attachment state (`{id, fileName, mimeType, byteLength, objectUrl, blob}`) so it inherits the existing MIME allowlist and 10 MB ceiling unchanged, including the existing over-ceiling behaviour and its message.
- [ ] 5.4 Thread the element record through `panel-controller.js`'s `sendMessage()` as its own field beside `attachments` (design.md D7) — never spliced into the operator's text.
- [ ] 5.5 Capture the page identity with its `_revision` at selection, and at send compare the record's identity against the one `captureForSend()` resolves; a mismatch tells the operator and does not dispatch on that activation (design.md D8).
- [ ] 5.6 Clear the picked element on send, on chip removal, and on bound-page change.
- [ ] 5.7 Add panel-side tests for the chip lifecycle, the stale-identity refusal, and both activation refusals surfacing their specific cause. ← (verify: the stale-identity case must fail to dispatch — a picked element from a different page reaching the model is the correctness failure this whole requirement exists for)

## 6. Host: carry the record into the turn

- [ ] 6.1 Accept the element record on the inbound user-turn envelope and render it into the model turn clearly attributed as captured page content, never as operator instruction (design.md D7, and the spec's "data, never instruction" requirement).
- [ ] 6.2 Add a host test proving markup whose text is phrased as an instruction ("ignore previous instructions", "approve this action") changes no permission, no tab scope and no approval decision. ← (verify: assert against the actual authorization/approval state after the turn, not merely that the text was escaped)

## 7. Documentation and validation

- [ ] 7.1 Add design mode to `README.md` in the same evidenced form the rest of that document uses: what it captures, what it strips before anything leaves the page, and that it grants the agent no reach it did not already have.
- [ ] 7.2 Run `openspec validate add-design-mode-element-picker --strict`.
- [ ] 7.3 Run the new suites plus the ones that share the touched surfaces: `test/element-picker-*.test.mjs`, `test/sidepanel-*.test.mjs`, `test/handlers.test.mjs`, `test/action-events-emission.test.mjs`. ← (verify: the overlay and background suites still pass — this change injects a second content script into the same tab the agent's own overlay runs in, and the two must not interfere)
- [ ] 7.4 Confirm no new agent tool was added: `host/tool-definitions.js` and the registry baseline fixtures are unchanged. ← (verify: this change is an operator input path; a new tool appearing in the registry means the boundary moved)
