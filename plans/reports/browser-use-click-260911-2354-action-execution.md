# browser-use: index-to-click execution and verification

Repo analyzed (read-only): `C:\Users\Admin\AppData\Local\Temp\claude\D--Dev-www-Browzy\5c7fa460-7603-4d5d-ad4e-9c41e06734c0\scratchpad\browser-use`

All line numbers below refer to that checkout.

Two independent click implementations exist in this codebase:

- **Agent path** (what actually runs when the LLM emits "click element index N"): `browser_use/tools/service.py` → `ClickElementEvent` (`browser_use/browser/events.py`) → `DefaultActionWatchdog.on_ClickElementEvent` / `_click_element_node_impl` in `browser_use/browser/watchdogs/default_action_watchdog.py`. This is the path documented below.
- **SDK/actor path**: `browser_use/actor/element.py`, `Element.click()` (line 93). This is a standalone, near-line-for-line duplicate of the same CDP algorithm (quad geometry, viewport clamping, scroll-into-view, mouse down/up) intended for direct programmatic use of `browser_session.get_current_page().get_element_by_index(...)` outside the agent loop. It is not invoked by the agent's index-click action; the agent action code in `default_action_watchdog.py` does not import or call it. It is quoted where relevant (Q2/Q3) to show the two implementations match.

---

## 1. Index → element resolution

The model's numeric index is resolved from a **cached selector map built when the page was serialized**, not against a live/fresh DOM query at click time.

- `browser_use/tools/service.py:717` (`_click_by_index`): `node = await browser_session.get_element_by_index(params.index)`
- `browser_use/browser/session.py:2500-2503`:
```python
async def get_element_by_index(self, index: int) -> EnhancedDOMTreeNode | None:
    """Alias for get_dom_element_by_index for backwards compatibility."""
    return await self.get_dom_element_by_index(index)
```
- `browser_use/browser/session.py:2457-2472` (`get_dom_element_by_index`):
```python
#  Check cached selector map
if self._cached_selector_map and index in self._cached_selector_map:
    return self._cached_selector_map[index]
return None
```
`_cached_selector_map` (`session.py:562`) is populated by `update_cached_selector_map()` (`session.py:2486-2497`), called by the DOM watchdog after each DOM serialization pass — i.e. it reflects the DOM state as of the last `BrowserStateRequestEvent`, not the DOM at the instant of the click.

The resolved `EnhancedDOMTreeNode` is passed into `ClickElementEvent(node=node)` (`tools/service.py:731`). `ElementSelectedEvent` (`browser/events.py:51-80`) even strips circular-reference fields on validation, confirming the node travels as a **frozen snapshot** through the event, not a live handle:
```python
node: EnhancedDOMTreeNode
@field_validator('node', mode='before')
...
return EnhancedDOMTreeNode(
    node_id=data.node_id, backend_node_id=data.backend_node_id,
    session_id=data.session_id, frame_id=data.frame_id, target_id=data.target_id,
    ...
    content_document=None, shadow_root_type=None, shadow_roots=[],
    parent_node=None, children_nodes=[], ax_node=None, snapshot_node=None,
)
```
The one piece of the snapshot that is re-resolved live against the browser is the CDP `backend_node_id` (see Q2) — CDP itself validates/rejects it if the underlying DOM node no longer exists.

There is no "index still valid?" check before clicking. If the index is stale, failure surfaces only as a downstream CDP error, caught in `_click_element_node_impl`'s except block (`default_action_watchdog.py:1050-1057`):
```python
if selector_index:
    error_detail += f' If the page changed after navigation/interaction, the index [{selector_index}] may be stale. Get fresh browser state before retrying.'
```

## 2. Click mechanism: coordinate-based CDP mouse events (with a JS-click fallback)

The primary mechanism is **coordinate-based**, dispatched over CDP `Input.dispatchMouseEvent`, not a DOM `element.click()` call and not a Playwright/Puppeteer element-handle click.

Dispatch call, `_click_element_node_impl`, `default_action_watchdog.py:904-950`:
```python
await cdp_session.cdp_client.send.Input.dispatchMouseEvent(
    params={'type': 'mouseMoved', 'x': center_x, 'y': center_y}, session_id=session_id)
...
await cdp_session.cdp_client.send.Input.dispatchMouseEvent(
    params={'type': 'mousePressed', 'x': center_x, 'y': center_y, 'button': 'left', 'clickCount': 1},
    session_id=session_id)
...
await cdp_session.cdp_client.send.Input.dispatchMouseEvent(
    params={'type': 'mouseReleased', 'x': center_x, 'y': center_y, 'button': 'left', 'clickCount': 1},
    session_id=session_id)
```

**Coordinates are recomputed at click time**, every click, from the live element geometry — they are not cached from serialization time. `_click_element_node_impl` calls `browser_session.get_element_coordinates(backend_node_id, cdp_session)` (`session.py:2825`) right before clicking, which tries in order: CDP `DOM.getContentQuads` → CDP `DOM.getBoxModel` → JS `getBoundingClientRect()`. The resulting quad(s) are intersected against the current viewport (from `Page.getLayoutMetrics`, fetched fresh each click), the largest visible quad is chosen, and its center is used (`default_action_watchdog.py:824-885`):
```python
center_x = sum(best_quad[i] for i in range(0, 8, 2)) / 4
center_y = sum(best_quad[i] for i in range(1, 8, 2)) / 4
center_x = max(0, min(viewport_width - 1, center_x))
center_y = max(0, min(viewport_height - 1, center_y))
```

Fallback path: if no geometry can be obtained at all, or if the occlusion check (Q4) says the point is blocked, browser-use falls back to a **JS click** dispatched via CDP `Runtime.callFunctionOn`, not `Input.dispatchMouseEvent` (`default_action_watchdog.py:800-816`, repeated at 875-901 and 987-1010):
```python
result = await cdp_session.cdp_client.send.DOM.resolveNode(
    params={'backendNodeId': backend_node_id}, session_id=session_id)
object_id = result['object']['objectId']
await cdp_session.cdp_client.send.Runtime.callFunctionOn(
    params={'functionDeclaration': 'function() { this.click(); }', 'objectId': object_id},
    session_id=session_id)
```
If the coordinate-based CDP mouse click throws an exception, the same JS-click fallback is used (`default_action_watchdog.py:990-1010`).

Checkbox/radio special case: pre/post `checked` state is read via `Runtime.callFunctionOn` (`this.checked`) before and after the mouse click; if unchanged, it retries with a JS `this.click()` (`default_action_watchdog.py:730-750`, `953-982`).

`ClickCoordinateEvent` (agent's "click at coordinate x,y" action, distinct from index click) uses the same mouse-event dispatch, in `_click_on_coordinate` (`default_action_watchdog.py:1064-1135`), with fixed coordinates supplied by the caller (no geometry lookup).

The `actor/element.py` `Element.click()` (line 93) independently implements the identical algorithm (quads → viewport clamp → scroll-into-view → mouse move/down/up over CDP `Input.dispatchMouseEvent`), confirming coordinate-based CDP dispatch is the house standard, not an artifact of one code path.

## 3. Scroll-into-view before clicking: yes

`_click_element_node_impl`, `default_action_watchdog.py:764-772`:
```python
# Scroll element into view FIRST before getting coordinates
try:
    await cdp_session.cdp_client.send.DOM.scrollIntoViewIfNeeded(
        params={'backendNodeId': backend_node_id}, session_id=session_id
    )
    await asyncio.sleep(0.05)  # Wait for scroll to complete
```
This runs via CDP `DOM.scrollIntoViewIfNeeded` before any coordinate is computed, so the subsequent geometry read reflects the post-scroll position. (`_input_text_element_node_impl`, the type-text path, does the analogous thing at `default_action_watchdog.py:1780-1786`.)

## 4. Hit-test / occlusion verification: yes, before dispatching (no verification after)

Before the CDP mouse click is dispatched, `_click_element_node_impl` calls `_check_element_occlusion(backend_node_id, center_x, center_y, cdp_session)` (`default_action_watchdog.py:874`), which runs a JS `document.elementFromPoint()` hit-test via `Runtime.callFunctionOn` (`default_action_watchdog.py:597-621`):
```javascript
const elementAtPoint = document.elementFromPoint(arguments[0], arguments[1]);
...
let isClickable = this === elementAtPoint ||
    this.contains(elementAtPoint) ||
    elementAtPoint.contains(this);
// plus label<->input association fallbacks (for/id, wrapping <label>, etc.)
```
If `isClickable` is false, the element is treated as occluded and browser-use **does not perform the CDP mouse click at all** — it switches to the JS-click fallback (`this.click()` via `Runtime.callFunctionOn`) instead (`default_action_watchdog.py:876-901`):
```python
is_occluded = await self._check_element_occlusion(backend_node_id, center_x, center_y, cdp_session)
if is_occluded:
    self.logger.debug('🚫 Element is occluded, falling back to JavaScript click')
    ...
    await cdp_session.cdp_client.send.Runtime.callFunctionOn(
        params={'functionDeclaration': 'function() { this.click(); }', 'objectId': object_id},
        session_id=session_id)
```
If the occlusion check itself errors out (exception), the code assumes **not occluded** and proceeds with the coordinate click (`default_action_watchdog.py:701-702`):
```python
except Exception as e:
    self.logger.debug(f'Occlusion check failed: {e}, assuming not occluded')
    return False
```

There is **no post-click verification of what was actually hit** (no post-click `elementFromPoint`, no re-check that the click landed correctly), except for the checkbox/radio-specific `this.checked` before/after comparison described in Q2. For all other element types, success is inferred purely from the CDP calls not throwing/timing out — there is no generic "did this land on the right thing" check after dispatch.

## 5. Covered / offscreen / iframe / shadow-DOM elements

- **Covered (occluded) elements**: handled by the pre-click `elementFromPoint` hit-test (Q4) → falls back to `element.click()` via JS, which bypasses visual occlusion entirely since it doesn't depend on synthetic mouse coordinates.
- **Offscreen elements**: handled by `DOM.scrollIntoViewIfNeeded` (Q3) before geometry/coordinates are computed, plus explicit viewport-intersection filtering when choosing the "best quad" (`default_action_watchdog.py:824-861`):
```python
if max_x < 0 or max_y < 0 or min_x > viewport_width or min_y > viewport_height:
    continue  # Quad is completely outside viewport
```
  If no quad intersects the viewport at all, it falls back to using the first quad anyway (`default_action_watchdog.py:862-864`, logged as a warning), and the final center point is clamped into `[0, viewport_width-1] x [0, viewport_height-1]` (`default_action_watchdog.py:884-885`) — so an unscrollable offscreen element can still receive a click at a clamped-into-viewport point, which may miss the actual element.
- **iframes**: element resolution and CDP dispatch target the correct CDP session/frame via `BrowserSession.cdp_client_for_node()` (`session.py:3974-4029`), which picks the session in priority order: `node.session_id` (exact CDP session recorded when the node was serialized) → `node.frame_id` (via `cdp_client_for_frame`) → `node.target_id` (for out-of-process iframes, a separate CDP target) → fallback to `agent_focus_target_id` → last-resort main session. Comment at `session.py:3977-3979`:
```python
# IMPORTANT: backend_node_id is only valid in the session where the DOM was captured.
# We trust the node's session_id/frame_id/target_id instead of searching all sessions.
```
  This means all subsequent CDP calls (`scrollIntoViewIfNeeded`, `getContentQuads`, `Input.dispatchMouseEvent`, etc.) in `_click_element_node_impl` are issued against that specific frame/target session, so clicks on elements inside (same-process or OOPIF) iframes route to the right renderer.
- **Shadow DOM**: there is no shadow-DOM-specific branch in the click path itself. `backend_node_id` is a CDP-level identifier that is valid across open shadow roots, so no special-casing is needed for the actual click dispatch. The one explicit shadow-DOM mention in this file is a tolerant error handler in the *text-input* path (not click), `default_action_watchdog.py:1787-1793`:
```python
# Node detached errors are common with shadow DOM and dynamic content
# The element can still be interacted with even if scrolling fails
error_str = str(e)
if 'Node is detached from document' in error_str or 'detached from document' in error_str:
    self.logger.debug(f'Element node temporarily detached during scroll (common with shadow DOM), continuing: {element_node}')
```
  No equivalent shadow-DOM-aware handling was found inside `_click_element_node_impl` itself; a scroll failure there is caught generically (`default_action_watchdog.py:772-773`, plain `except Exception as e: self.logger.debug(...)`) without shadow-DOM-specific messaging.

## 6. Navigation / new-tab / download detection and settle-wait after a click

**New tab detection** (`browser_use/tools/service.py`, `_click_by_index`): tab IDs are snapshotted before dispatch, and after the click a helper polls for new targets:
```python
tabs_before = {t.target_id for t in await browser_session.get_tabs()}
...
event = browser_session.event_bus.dispatch(ClickElementEvent(node=node))
...
memory += await _detect_new_tab_opened(browser_session, tabs_before)
```
`_detect_new_tab_opened` (`tools/service.py:629-651`):
```python
await asyncio.sleep(0.05)   # let CDP Target.attachedToTarget propagate
tabs_after = await browser_session.get_tabs()
new_tabs = [t for t in tabs_after if t.target_id not in tabs_before]
if new_tabs:
    ...
    switch_event = browser_session.event_bus.dispatch(SwitchTabEvent(target_id=new_tab.target_id))
    await switch_event
    ...  # auto-switches focus to the new tab
```

**Download detection**: `on_ClickElementEvent` wraps the click in `_execute_click_with_download_detection` (`default_action_watchdog.py:44-224`), which registers callbacks on the downloads watchdog and races two waits after the click completes:
```python
await asyncio.wait_for(download_started.wait(), timeout=download_start_timeout)   # default 0.5s
...
await asyncio.wait_for(download_completed.wait(), timeout=download_complete_timeout)  # default 30.0s
```
If a download starts within 0.5s of the click, it waits up to 30s for completion (with active-progress detection via a "received update in the last 5s" heuristic before declaring the download stalled/timed out).

**Same-tab navigation caused by a click**: there is no dedicated "wait for this click's navigation" call in the click path itself — `_click_element_node_impl` does not call `_navigate_and_wait` or subscribe to `NavigationCompleteEvent`. Confirmed by search: the only listeners of `NavigationCompleteEvent` are `downloads_watchdog.py:277` and `security_watchdog.py:50`, neither of which is in the click's own await chain. Instead, page settling is picked up generically the next time the agent asks for browser state (`BrowserStateRequestEvent`, handled in `browser_use/browser/watchdogs/dom_watchdog.py:243-292`). That handler does:
1. A **bounded pending-network-request probe** with a hard 2s timeout on the probe itself (not a real network-idle wait):
```python
pending_requests_before_wait = await asyncio.wait_for(self._get_pending_network_requests(), timeout=2.0)
```
2. A **fixed sleep of 0.3s**, only if there were pending requests, then it proceeds regardless of whether the network actually went idle:
```python
if pending_requests_before_wait:
    # Reduced from 1s to 0.3s for faster DOM builds while still allowing critical resources to load
    await asyncio.sleep(0.3)
```
This is a fixed-sleep heuristic gated on a coarse pending-request check, not a true network-idle/load-event wait. A true "wait_until: load/domcontentloaded/networkidle" mechanism does exist in the codebase (`BrowserSession._navigate_and_wait`, `session.py:1016-1100`, polling `Page.lifecycleEvent` buffers for `load`/`DOMContentLoaded`/`networkIdle`), but it is used only for the explicit `navigate()` action (`NavigateToUrlEvent`), not for navigation that happens as a side effect of a click.

`BrowserProfile` also defines `minimum_wait_page_load_time` (default 0.25s) and `wait_for_network_idle_page_load_time` (default 0.5s) (`browser_use/browser/profile.py:691-692`), but a repo-wide search shows these are only threaded through `BrowserSession.__init__` overload signatures (`session.py:185-186, 219-220, 325-326`) — they are not read anywhere inside `dom_watchdog.py`'s stability wait or `default_action_watchdog.py`'s click path. They appear to be legacy/unused-at-the-call-site fields for this version of the code (the field default values exist, but no `grep` hit shows them being consumed inside the actual wait logic).

**Between multiple actions in one LLM turn**: `browser_use/agent/service.py:2766-2770`:
```python
# wait between actions (only after first action)
if i > 0:
    self.logger.debug(f'Waiting {self.browser_profile.wait_between_actions} seconds between actions')
    await asyncio.sleep(self.browser_profile.wait_between_actions)
```
`wait_between_actions` default is 0.1s (`browser_use/browser/profile.py:694`).

## 7. Concrete timing constants in the action path

From `default_action_watchdog.py` (click-relevant ones marked *):
| Constant | Value | Location |
|---|---|---|
| `download_start_timeout` | 0.5s | `_execute_click_with_download_detection` default, `default_action_watchdog.py:47` |
| `download_complete_timeout` | 30.0s | same, `default_action_watchdog.py:48` |
| *PDF generation timeout | 15.0s | `default_action_watchdog.py:261` |
| page-title fetch timeout | 2.0s | `default_action_watchdog.py:280` |
| type-fallback click timeout | 10.0s | `default_action_watchdog.py:494` |
| *sleep after `scrollIntoViewIfNeeded` (click) | 0.05s | `default_action_watchdog.py:771` |
| iframe-scroll settle sleep | 0.2s | `default_action_watchdog.py:553` |
| *sleep after JS-click fallback (no-quads path) | 0.05s | `default_action_watchdog.py:820` |
| *sleep after JS-click fallback (occluded path) | 0.05s | `default_action_watchdog.py:897` |
| *sleep after `mouseMoved` | 0.05s | `default_action_watchdog.py:915` |
| *`mousePressed` dispatch timeout | 3.0s | `default_action_watchdog.py:931` |
| *sleep after `mousePressed` | 0.08s | `default_action_watchdog.py:933` |
| *`mouseReleased` dispatch timeout | 5.0s | `default_action_watchdog.py:951` |
| *checkbox post-click state-read sleep | 0.05s | `default_action_watchdog.py:961` |
| *checkbox JS-click retry settle sleep | 0.05s | `default_action_watchdog.py:980` |
| *sleep after CDP-click-failed JS fallback | 0.1s | `default_action_watchdog.py:1020` |
| *refocus-after-click session timeout | 3.0s | `default_action_watchdog.py:1030` |
| *refocus `runIfWaitingForDebugger` timeout | 2.0s | `default_action_watchdog.py:1033` |
| *`_click_on_coordinate` mouseMoved sleep | 0.05s | `default_action_watchdog.py:1092` |
| *`_click_on_coordinate` mousePressed timeout | 3.0s | `default_action_watchdog.py:1108` |
| *`_click_on_coordinate` sleep after mousePressed | 0.05s | `default_action_watchdog.py:1110` |
| *`_click_on_coordinate` mouseReleased timeout | 5.0s | `default_action_watchdog.py:1127` |
| GoBack/GoForward settle sleep | 0.5s | `default_action_watchdog.py:2393`, `2421` |
| Refresh settle sleep | 1.0s | `default_action_watchdog.py:2436` |

Event-level timeouts (`browser_use/browser/events.py`, via `_get_timeout`, each overridable by an env var):
| Event | Default timeout |
|---|---|
| `NavigateToUrlEvent` | 30.0s (`events.py:122`) |
| `ClickElementEvent` | 15.0s (`events.py:133`) |
| `ClickCoordinateEvent` | 15.0s (`events.py:144`) |
| `TypeTextEvent` | 60.0s (`events.py:156`) |
| `ScrollEvent` | 8.0s (`events.py:166`) |
| `SwitchTabEvent` | 10.0s (`events.py:174`) |
| `CloseTabEvent` | 10.0s (`events.py:182`) |
| `ScreenshotEvent` | 15.0s (`events.py:191`) |
| `BrowserStateRequestEvent` | 30.0s (`events.py:201`) |
| `WaitEvent` | 60.0s (`events.py:237`) |

Page-settle / stability path (`dom_watchdog.py`):
| Constant | Value | Location |
|---|---|---|
| Pending-network-request probe timeout | 2.0s | `dom_watchdog.py:274` |
| *Fixed settle sleep (only if pending requests found)* | 0.3s | `dom_watchdog.py:283` (comment notes it was reduced from a prior 1.0s) |

Explicit-navigation wait path (`session.py`, used by `navigate()` action, not by click):
| Constant | Value | Location |
|---|---|---|
| Same-domain navigation readiness timeout | 3.0s | `session.py:1041` |
| Cross-domain navigation readiness timeout | 8.0s | `session.py:1041` |
| `Page.navigate()` call timeout | 20.0s | `session.py:1049-1050` |
| Lifecycle-event poll interval | 0.05s | `session.py:1091` |

Agent-loop pacing (`agent/service.py`, `browser/profile.py`):
| Constant | Value | Location |
|---|---|---|
| `wait_between_actions` (between actions in one LLM turn) | 0.1s (default) | `browser/profile.py:694`, used `agent/service.py:2770` |
| `minimum_wait_page_load_time` (declared, not consumed by click/stability path) | 0.25s (default) | `browser/profile.py:691` |
| `wait_for_network_idle_page_load_time` (declared, not consumed by click/stability path) | 0.5s (default) | `browser/profile.py:692` |

---

## Summary of the click pipeline (agent path)

1. LLM emits `click(index=N)` → `tools/service.py:_click_by_index` looks up `node = await browser_session.get_element_by_index(N)`, a **cached-selector-map lookup**, not a fresh DOM query.
2. Snapshot of tab IDs taken; `ClickElementEvent(node=node)` dispatched.
3. `DefaultActionWatchdog.on_ClickElementEvent` validates it's not a file input / `<select>`, special-cases print buttons, then calls `_execute_click_with_download_detection(self._click_element_node_impl(element_node))`.
4. `_click_element_node_impl`: resolves the correct CDP session for the node's frame/target (`cdp_client_for_node`) → captures pre-click checkbox state if relevant → reads viewport size → `DOM.scrollIntoViewIfNeeded` + 0.05s sleep → computes element geometry fresh (`getContentQuads` → `getBoxModel` → `getBoundingClientRect`) → picks the largest on-screen quad, clamps center to viewport → runs a JS `elementFromPoint` occlusion/hit-test → if occluded or no geometry, does a JS `element.click()` fallback via `Runtime.callFunctionOn`; otherwise dispatches CDP `Input.dispatchMouseEvent` (`mouseMoved` → `mousePressed` → `mouseReleased`) at the computed point → for checkboxes/radios, re-reads `checked` and retries with JS click if unchanged → always re-focuses the original CDP session in a `finally` block.
5. Back in `tools/service.py`, post-click it re-lists tabs after a 0.05s sleep to detect/auto-switch to any new tab opened by the click.
6. There is no explicit "wait for this click's navigation" step; page settling before the next model observation happens generically in `DOMWatchdog.on_BrowserStateRequestEvent` via a bounded (2.0s) pending-request probe followed by, at most, a fixed 0.3s sleep — not a true network-idle or load-event wait.

Everything above is sourced from the files in the FILES TO READ list plus `browser_use/tools/service.py`, `browser_use/browser/profile.py`, `browser_use/browser/watchdogs/dom_watchdog.py`, `browser_use/browser/watchdogs/downloads_watchdog.py`, and `browser_use/browser/watchdogs/security_watchdog.py`, followed as necessary to trace imports/usages. No claims here are speculative; anything not confirmed by source is marked "unclear" — there were none in this investigation.
