# How browser-use represents a web page to the LLM

Source repo (read-only, cloned working copy):
`C:\Users\Admin\AppData\Local\Temp\claude\D--Dev-www-Browzy\5c7fa460-7603-4d5d-ad4e-9c41e06734c0\scratchpad\browser-use`

All file:line references below are relative to that repo root.

---

## 1. What is sent to the model each step — text, screenshot, or both?

Both, by default. Each step the agent builds one `UserMessage` containing:

- A structured **text block** (`<agent_history>`, `<agent_state>`, `<browser_state>` with the serialized interactive-elements tree, `<read_state>`, step metadata) — built in `AgentMessagePrompt.get_user_message` (`browser_use/agent/prompts.py:404-506`).
- Zero or more **screenshots** (current + optionally a previous one) as `image_url` content parts, appended after the text, each preceded by a `"Current screenshot:"` / `"Previous screenshot:"` label (`browser_use/agent/prompts.py:444-474`).

The screenshot is controlled by the `use_vision` flag:

```python
# browser_use/agent/views.py:62
use_vision: bool | Literal['auto'] = True
```

Default is **`True`** — screenshots are included every step unless the user sets `use_vision=False` or `'auto'`. `'auto'` means a screenshot is included only when an action explicitly requests one (e.g. the `screenshot` action tool); `True` always includes it; `False` never includes it (`browser_use/agent/message_manager/service.py:461-472`):

```python
if use_vision is True:
    include_screenshot = True
elif use_vision == 'auto':
    include_screenshot = include_screenshot_requested
```

Some models are force-downgraded to `use_vision=False` regardless of the user setting (DeepSeek, some XAI/Grok models) — `browser_use/agent/service.py:475-485`. Also, a screenshot is captured every step regardless of `use_vision` "so that cloud sync is useful" (`browser_use/agent/service.py:1097`, `include_screenshot=True` comment), but it is only attached to the LLM message per the `use_vision` logic above. New-tab/placeholder pages never get a screenshot attached (`is_new_tab_page` check, `prompts.py:407-408`, and a `PLACEHOLDER_4PX_SCREENSHOT` sentinel is filtered out at `prompts.py:442`).

So: **text tree is always sent; screenshot is sent by default (True) and is optional/configurable.**

---

## 2. Interactive element enumeration and identifier scheme

### Format

Interactive elements are rendered as one line per element, indented by depth (tab per level), of the form:

```
{depth_tabs}{new_prefix}[{index}]<{tag_name} {attr1=val1 attr2=val2 ...} />
```

Built in `DOMTreeSerializer.serialize_tree` (`browser_use/dom/serializer/serializer.py:1117-1134`):

```python
elif node.is_interactive:
    assert node.selector_index is not None
    new_prefix = '*' if node.is_new else ''
    scroll_prefix = '|scroll element[' if should_show_scroll else '['
    line = f'{depth_str}{shadow_prefix}{new_prefix}{scroll_prefix}{node.selector_index}]<{node.original_node.tag_name}'
...
line += ' />'
```

Example shape: `[13]<button aria-label=Submit />` or, if newly appeared since last step, `*[13]<button ... />`. Scrollable-but-not-interactive elements use `|scroll element|<div ...>` (no index); scrollable interactive elements get `|scroll element[13]<...`. Shadow-DOM hosts get an `|SHADOW(open)|` / `|SHADOW(closed)|` prefix. `<svg>` elements are shown with the interactive marker but their children are collapsed (`... <!-- SVG content collapsed -->`, lines 1016-1041). Iframes/frames that are *not* interactive are marked `|IFRAME|<iframe .../>` (line 1122-1127).

### Index scheme

The "index" (`selector_index`) is **not** an arbitrary incrementing counter — it is the CDP `backendNodeId` whenever that ID is unique in the map, falling back to a synthetic collision-free integer otherwise (`browser_use/dom/serializer/serializer.py:649-658`):

```python
def _allocate_selector_index(self, backend_node_id: int) -> int:
    """Preserve unique backend IDs and allocate a collision-free model index otherwise."""
    if backend_node_id not in self._selector_map:
        return backend_node_id
    while self._next_synthetic_index in self._reserved_backend_node_ids:
        self._next_synthetic_index += 1
    selector_index = self._next_synthetic_index
    self._next_synthetic_index += 1
    return selector_index
```

Indices are assigned by `_assign_interactive_indices_and_mark_new_nodes` (`serializer.py:660-770`), which walks the filtered tree and, for each element judged interactive/visible (see Q3), does:

```python
node.is_interactive = True
node.selector_index = self._allocate_selector_index(node.original_node.backend_node_id)
self._selector_map[node.selector_index] = node.original_node
```

The resulting `selector_map: dict[int, EnhancedDOMTreeNode]` (`browser_use/dom/views.py:919`, `DOMSelectorMap = dict[int, EnhancedDOMTreeNode]`) is what the agent's tools index into (`click(index=13)` etc.).

### Attributes included / whitelist

Yes — there is an explicit whitelist, `DEFAULT_INCLUDE_ATTRIBUTES` (`browser_use/dom/views.py:18-82`), a ~50-item list mixing raw HTML attributes (`title`, `type`, `id`, `name`, `role`, `value`, `placeholder`, `alt`, validation attrs like `pattern`/`min`/`max`/`step`, datepicker hints, `contenteditable`, etc.) and accessibility-tree properties (`checked`, `selected`, `expanded`, `pressed`, `disabled`, `invalid`, `valuemin/valuemax/valuenow`, `keyshortcuts`, `haspopup`, `ax_name`, etc.). `class` is present but commented out (excluded by default). This list is the default passed to `SerializedDOMState.llm_representation(include_attributes=...)` (`browser_use/dom/views.py:943-955`) and is caller-overridable (the agent can pass a different `include_attributes` list, e.g. via `AgentMessagePrompt.include_attributes`, `prompts.py:114/134/252`).

A **separate**, larger whitelist, `STATIC_ATTRIBUTES` (`views.py:84-136`), is used only for computing the element hash (see Q6), not for the LLM-visible attribute string.

The per-element attribute string itself is built in `DOMTreeSerializer._build_attributes_string` (`serializer.py:1204-1405`), which:
- Filters `node.attributes` down to keys present in `include_attributes` with non-empty values.
- Synthesizes extra attributes for date/time inputs (`format`, `expected_format`, datepicker placeholders) to remove ambiguity for the LLM.
- **Never includes `value`/`valuetext` for `<input type="password">`** — explicit anti-leak comment: "Never include values from password fields - they contain secrets that must not leak into DOM snapshots sent to the LLM" (`serializer.py:1294-1301`).
- Prefers the accessibility-tree's live `value`/`valuetext` over the static HTML `value` attribute for `input`/`textarea`/`select` (lines 1322-1341).
- De-duplicates attributes whose values are redundant with each other or with the element's own visible text (lines 1346-1392), and caps each value to 100 chars via `cap_text_length` (line 1398, `browser_use/dom/utils.py:1-5`).

---

## 3. Interactivity / visibility / top-most determination

Three independent passes, all done at **serialization time** using CDP snapshot data (not literal browser paint), plus one **real hit-test at click time**.

### a) Interactivity (`ClickableElementDetector.is_interactive`, `browser_use/dom/serializer/clickable_elements.py:6-246`)

A layered heuristic, first true wins:
1. `node.has_js_click_listener` — set from a CDP `getEventListeners()` probe done ahead of time (see Q4) — catches React/Vue/Angular `onClick` handlers with no native semantics.
2. Iframes/frames larger than 100×100px.
3. `<label>`/`<span>` wrapper heuristics: interactive if they wrap a real form control within 2 levels (`has_form_control_descendant`), else `<label for=...>` is excluded to avoid double-activation.
4. Class/id/data-attribute name heuristics for "search" widgets.
5. Accessibility-tree properties: `disabled`/`hidden` force false; `focusable`/`editable`/`settable`/`checked`/`expanded`/`pressed`/`selected`/`required`/`autocomplete`/`keyshortcuts` force true.
6. Native interactive tags: `button, input, select, textarea, a, details, summary, option, optgroup`.
7. Presence of `onclick`/`onmousedown`/`onmouseup`/`onkeydown`/`onkeyup`/`tabindex` attributes.
8. ARIA `role` in an interactive-role whitelist (`button, link, menuitem, option, radio, checkbox, tab, textbox, combobox, slider, spinbutton, search, searchbox, row, cell, gridcell`), checked both from the raw HTML `role` attribute and from the accessibility-tree role.
9. "Icon-sized" elements (10–50px both dimensions) with `class`/`role`/`onclick`/`data-action`/`aria-label`.
10. Fallback: CSS `cursor: pointer` from the DOMSnapshot computed styles.

Results are memoized per `(session_id, node_id)` in `DOMTreeSerializer._clickable_cache` (`serializer.py:434-453`) to avoid recomputation within one serialization pass.

### b) Visibility (`DomService.is_element_visible_according_to_all_parents`, `browser_use/dom/service.py:252-355`)

Not visible if `display:none`, `visibility:hidden`, or `opacity<=0` from DOMSnapshot computed styles, or if there is no bounding box. Otherwise checked against every ancestor `<iframe>`/HTML-frame in the chain, translating element bounds by each ancestor iframe's offset and testing intersection against that frame's scroll-adjusted viewport, **with a configurable `viewport_threshold` (default 1000px)** — i.e. elements up to 1000px outside the visible viewport are still counted "visible" (so the model can be told about near-offscreen content). Passing `viewport_threshold=None` disables all viewport filtering (CSS-only check). This is viewport filtering, not a hard clip.

Two special-case visibility overrides exist in tree construction (`serializer.py:519-531`): elements with `aria-*`/`pseudo` attributes are forced visible (helps validation-message elements), and `<input type="file">` is forced visible even if hidden via `opacity:0` (common custom-styled file-picker pattern).

### c) Top-most / occlusion (paint order)

Two distinct mechanisms:

**At serialization time** (heuristic, whole-tree, cheap): `PaintOrderRemover.calculate_paint_order` (`browser_use/dom/serializer/paint_order.py:146-225`) groups all nodes that carry a DOMSnapshot `paint_order` value, processes them from highest paint order to lowest, and maintains a `RectUnionPure` (a disjoint-rectangle union, capped at 5000 rects for performance, `paint_order.py:35-143`) per `(session_id, iframe_frame_id)` "document context". A node whose bounding rect is already fully contained in the union of higher-paint-order rects is flagged `node.ignored_by_paint_order = True` and excluded from the LLM text (used to hide, e.g., text under a modal overlay). A node is only added to the occluding union if it has non-transparent background (`background-color != rgba(0,0,0,0)`) and `opacity >= 0.8`. This is bounds-based coverage, not a per-pixel hit test.

**At click time** (real, single-point, expensive): `DefaultActionWatchdog._check_element_occlusion` (`browser_use/browser/watchdogs/default_action_watchdog.py:573-700`) runs actual JS in the page via CDP `Runtime.callFunctionOn`, calling `document.elementFromPoint(x, y)` at the element's center and checking whether the returned element is the target, contains it, is contained by it, or is a semantically-linked `<label>`/`<input>` pair. If not, the click is treated as occluded. This is invoked from `_click_element_node_impl` (`default_action_watchdog.py:876`) right before dispatching the actual mouse click, after the element has been scrolled into view via `DOM.scrollIntoViewIfNeeded`.

### d) Extra filtering

`_apply_bounding_box_filtering` / `_should_exclude_child` (`serializer.py:772-903`) drops descendants of "propagating" elements (`<a>`, `<button>`, `div/span/input[role=combobox|button]`, `PROPAGATING_ELEMENTS` list at `serializer.py:46-57`) whose bounding box is ≥99% contained (`DEFAULT_CONTAINMENT_THRESHOLD = 0.99`) inside the parent's box — i.e. nested spans/icons inside a button are collapsed into the button rather than serialized as separate interactive nodes.

---

## 4. CDP calls used to build the tree, and batching

Per top-level target (`DomService._get_all_trees`, `browser_use/dom/service.py`), the following CDP commands are issued:

- `DOMSnapshot.captureSnapshot` — with `computedStyles`, `includePaintOrder: True`, `includeDOMRects: True` (`service.py:570-580`).
- `DOM.getDocument` — `{depth: -1, pierce: True}` (full tree, pierce shadow roots) (`service.py:582-585`).
- `Accessibility.getFullAXTree` — issued **per frame** (recursively collected via `Page.getFrameTree`, then one `getFullAXTree` call per frame id, run concurrently with `asyncio.gather`) inside `_get_ax_tree_for_all_frames` (`service.py:357-401`).
- `Page.getLayoutMetrics` — for device pixel ratio (`service.py:228`, `_get_viewport_ratio`).
- `Runtime.evaluate` (with `includeCommandLineAPI: True`) — runs a page-injected script calling `getEventListeners(el)` on candidate elements to detect JS click/mouse listeners, then `DOM.describeNode` per candidate to map back to backend node IDs (`service.py:465-556`).

These are **not one CDP round trip** — each command is a separate CDP request — but the four main tree-building calls (`snapshot`, `dom_tree`, `ax_tree`, `device_pixel_ratio`) are **dispatched concurrently** in one `asyncio.wait(..., timeout=10.0)` batch, with a retry-once pattern for any that time out (`service.py:589-627`):

```python
tasks = {
    'snapshot': create_task_with_error_handling(create_snapshot_request(), name='get_snapshot'),
    'dom_tree': create_task_with_error_handling(create_dom_tree_request(), name='get_dom_tree'),
    'ax_tree': create_task_with_error_handling(self._get_ax_tree_for_all_frames(target_id), name='get_ax_tree'),
    'device_pixel_ratio': create_task_with_error_handling(self._get_viewport_ratio(target_id), name='get_viewport_ratio'),
}
done, pending = await asyncio.wait(tasks.values(), timeout=10.0)
```

The JS-click-listener detection and iframe/AX-tree collection happen before/alongside this on the same CDP session. All results are merged into one `TargetAllTrees` dataclass (`views.py:196-204`) and then walked to build `EnhancedDOMTreeNode` objects (`service.py:759` `_construct_enhanced_node`, referenced but not detailed here) that fuse DOM + AX + Snapshot data per node.

For cross-origin iframes and multiple frames/targets, this whole process is repeated per target/frame (capped by `max_iframes=100` and `max_iframe_depth=5`, `service.py:62-63,670,981,1055`), i.e. batching is per-target, not global across the whole page.

---

## 5. How the tree is kept small

Multiple independent mechanisms:

1. **Character cap on the whole serialized text**: `max_clickable_elements_length: int = 40000` in `AgentMessagePrompt.__init__` (`browser_use/agent/prompts.py:117`); the final `elements_text` is hard-truncated to this many characters with a `(truncated to 40000 characters)` note (`prompts.py:254-258`).
2. **Non-content element exclusion**: `DISABLED_ELEMENTS = {'style','script','head','meta','link','title'}` and all decorative SVG child tags (`path, rect, g, circle, ...`) are dropped outright during tree construction (`serializer.py:18-39, 481-486`).
3. **Non-interactive/non-scrollable pruning**: only elements that are interactive, scrollable, an iframe/frame, or contain such descendants survive `_create_simplified_tree`/`_optimize_tree` (`serializer.py:455-596`); plain non-interactive `<div>` wrappers etc. are display-collapsed (`should_display=False` path in `serialize_tree`, `serializer.py:1007-1014`) so only their children render, not the wrapper line itself.
4. **Paint-order occlusion filtering** (Q3c) removes elements fully hidden under higher-stacked content.
5. **Bounding-box containment filtering** (Q3d) collapses near-duplicate nested elements (icons/spans inside buttons/links) into their propagating parent.
6. **SVG subtree collapsing**: `<svg>` is emitted as one line with children collapsed (`serializer.py:1016-1041`).
7. **Per-attribute value cap**: each attribute value capped to 100 chars (`cap_text_length`, `serializer.py:1398`); page-statistics text content also capped implicitly by the same mechanism where used.
8. **Iframe/document caps**: `max_iframes=100` (documents truncated beyond this, with a warning log, `service.py:670-674`), `max_iframe_depth=5` (`service.py:981`).
9. **Iframe hidden-content hints instead of full content**: for cross-origin iframes beyond a viewport threshold, only a compact hint line is emitted (`... (N more elements below - scroll to reveal): <tag> "text" ~X pages down`) rather than serializing the full hidden subtree (`serializer.py:1184-1199`, populated by `DOMWatchdog._count_hidden_elements_in_iframes`, `dom_watchdog.py:80-193`).
10. **List/link truncation in the alternate eval serializer**: `DOMEvalSerializer` (`browser_use/dom/serializer/eval_serializer.py`) caps `max_list_items = 50` and `max_consecutive_links = 50` (lines 248-290) — note this serializer is used for evaluation/judge contexts (`eval_representation`, `views.py:957-978`), not the main agent loop.
11. **"New elements since last step" diffing** — see Q6 — does not shrink the tree itself, but flags additions with a `*` prefix rather than requiring the model to diff two full trees itself.
12. Page statistics (`<page_stats>` line, `prompts.py:150-250`) give the model a cheap summary (link/interactive/iframe/shadow/image counts, total elements, text density) so it doesn't have to infer page complexity from the truncated tree.

There is **no explicit token-count budgeting** (only a character cap) and **no depth-limit constant** for generic DOM nesting (interactive-tree depth is bounded implicitly by the filtering above, not a fixed max-depth parameter), except the `max_iframe_depth=5` cap for iframe nesting specifically.

---

## 6. Index stability across steps and staleness detection

### Are indices stable?

**Not stable across DOM rebuilds in general, but usually stable when the element itself hasn't been removed from the DOM**, because the index is derived from the CDP `backendNodeId` (Q2), which Chrome assigns per DOM node and keeps constant for that node's lifetime, changing only if the node is destroyed and recreated (e.g. React re-mounting a component, a full page reload, a same-tag replacement). Synthetic indices (used only on `backendNodeId` collisions) are **not guaranteed stable** since they depend on the order allocation ran during that particular serialization (`serializer.py:649-658`).

The DOM tree is **rebuilt from scratch via fresh CDP calls on every `BrowserStateRequestEvent`** (`dom_watchdog.py:244-...`, calling `_build_dom_tree_without_highlights` → `DomService.get_serialized_dom_tree`, `dom_watchdog.py:551-578`) — there is no skip-rebuild cache that reuses a previous tree across steps; the "previous state" is passed only for diffing (see below), not for avoiding a new capture:

```python
# dom_watchdog.py:367-368 (previous_state passed into a fresh rebuild, not a substitute for it)
previous_state = (
    self.browser_session._cached_browser_state_summary.dom_state ...
```

After each rebuild, `self.selector_map = self.current_dom_state.selector_map` and `browser_session.update_cached_selector_map(self.selector_map)` (`dom_watchdog.py:667-671`) replace the session's cached map wholesale — so an index the model saw two steps ago is only valid if it happens to still map to the same node in the latest map; it is not preserved by any versioning scheme.

### "New since last step" marking

`DOMTreeSerializer` accepts a `previous_cached_state: SerializedDOMState | None` (`serializer.py:63-83`) and builds `self._previous_node_ids = {(session_id, backend_node_id), ...}` from the previous selector map. During index assignment, any interactive node whose `(session_id, backend_node_id)` was **not** in that previous set gets `node.is_new = True` (`serializer.py:759-766`), which the serializer renders as a `*` prefix on the line (`serializer.py:1032, 1119`) — this is a highlight for the LLM ("this element wasn't here last step"), not a staleness mechanism for old indices.

### Staleness detection when the model acts on an index from a stale mental model

Two layers:

1. **Lookup-time check**: `browser_session.get_element_by_index(index)` (alias for `get_dom_element_by_index`, `browser_use/browser/session.py:2457-2502`) looks the index up only in `self._cached_selector_map` — the *current* map from the most recent rebuild. If the index isn't present there, tool handlers return an explicit error instead of acting, e.g. (`browser_use/tools/service.py:714-718`):
   ```python
   node = await browser_session.get_element_by_index(params.index)
   if node is None:
       msg = f'Element index {params.index} not available - page may have changed. Try refreshing browser state.'
   ```
   This pattern repeats for click, type/input, and other index-based actions (`tools/service.py:714-718, 785-789, 1389-1392, 1686-1688, 1714-1716`).
2. **Click-time CDP re-resolution**: even if the index *is* found (i.e. it maps to some node object), `_click_element_node_impl` calls `DOM.scrollIntoViewIfNeeded(backendNodeId=...)` and `DOM.resolveNode(backendNodeId=...)` (`browser_use/browser/watchdogs/default_action_watchdog.py:768-777, 804-805`) against the live page before clicking — these CDP calls fail if the backend node no longer exists in the current DOM (detached/removed), surfacing as an error/exception rather than silently clicking nothing or the wrong thing. Additionally, `_check_element_occlusion` (Q3c) does a live `document.elementFromPoint` hit-test right before the click, catching the case where a *different* element now visually occupies that position even if the backend node itself still technically exists.

What is **unclear from the source**: whether there is any explicit detection of "index N used to point at element A, but a page mutation caused backendNodeId reuse/collision such that index N now silently maps to unrelated element B" between the lookup and the click within the same tool call — the code trusts `_cached_selector_map` at lookup time and only re-validates the *specific* resolved node afterward (via `resolveNode`/`scrollIntoViewIfNeeded`/occlusion check), not a hash/identity comparison against what the LLM was shown. The separate `compute_stable_hash()`/`element_hash` mechanism on `EnhancedDOMTreeNode` (`browser_use/dom/views.py:830-916`) exists for **history-replay element re-matching** (`DOMInteractedElement`, `views.py:981-1047`, `MatchLevel` enum, `views.py:165-172`), not for per-step index staleness detection during live agent execution.

---

## Summary of key files

- `browser_use/agent/prompts.py` — assembles the full user message (text + screenshots), `use_vision` gating logic, character cap.
- `browser_use/agent/views.py:62` — `use_vision` default.
- `browser_use/agent/message_manager/service.py:449-502` — screenshot inclusion decision.
- `browser_use/dom/views.py` — `DEFAULT_INCLUDE_ATTRIBUTES`, `STATIC_ATTRIBUTES`, `EnhancedDOMTreeNode`, hashing for history replay.
- `browser_use/dom/serializer/serializer.py` — tree simplification, interactivity index assignment, attribute-string building, line-format rendering, bbox filtering, char cap consumer.
- `browser_use/dom/serializer/clickable_elements.py` — interactivity heuristic.
- `browser_use/dom/serializer/paint_order.py` — occlusion/top-most estimate at serialization time.
- `browser_use/dom/serializer/eval_serializer.py` — alternate serializer for eval/judge use (list/link truncation caps).
- `browser_use/dom/service.py` — CDP calls (`DOMSnapshot.captureSnapshot`, `DOM.getDocument`, `Accessibility.getFullAXTree`, `Page.getLayoutMetrics`, `Runtime.evaluate`/`getEventListeners`), concurrent dispatch, visibility-vs-viewport check, iframe/document caps.
- `browser_use/browser/watchdogs/dom_watchdog.py` — orchestrates a fresh rebuild every `BrowserStateRequestEvent`, updates `selector_map` cache, `is_new` diffing input.
- `browser_use/browser/watchdogs/default_action_watchdog.py` — click-time `resolveNode`/`scrollIntoViewIfNeeded` re-validation and live `elementFromPoint` occlusion hit-test.
- `browser_use/browser/session.py:2457-2502` — `get_element_by_index` / cached selector map lookup.
- `browser_use/tools/service.py` — index-not-found error messages for click/input/etc.

Status: DONE
Summary: Traced the full pipeline from CDP capture through serialization to the LLM message; report written with file:line citations for screenshot defaults, index/attribute scheme, interactivity/visibility/occlusion logic (both heuristic at serialization and real hit-test at click time), CDP call batching, size-control mechanisms, and index stability/staleness handling.
