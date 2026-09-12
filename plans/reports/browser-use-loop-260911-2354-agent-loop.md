# browser-use Agent Loop: LLM Round-Trip Analysis

Repo analyzed (read-only): `.../scratchpad/browser-use`
Key files: `browser_use/agent/service.py`, `browser_use/agent/views.py`,
`browser_use/agent/message_manager/service.py`, `browser_use/agent/message_manager/views.py`,
`browser_use/agent/prompts.py`, `browser_use/agent/system_prompts/system_prompt.md`,
`browser_use/tools/service.py`, `browser_use/tools/registry/service.py`, `browser_use/tools/registry/views.py`,
`browser_use/llm/anthropic/chat.py`, `browser_use/llm/anthropic/serializer.py`.

---

## 1. LLM calls per "step"

One LLM call per step in the normal path.

`Agent.step()` (`service.py:1035`) runs three phases:
1. `_prepare_context()` — gathers browser state, builds messages (no LLM call).
2. `_get_next_action()` → `_get_model_output_with_retry()` → `get_model_output()` (`service.py:1945`) — makes exactly one `await self.llm.ainvoke(input_messages, **kwargs)` call (`service.py:1955`).
3. `_execute_actions()` → `multi_act()` — executes the returned action list against the browser (no LLM call).

```python
# service.py:1064-1069
# Phase 2: Get model output and execute actions
await self._get_next_action(browser_state_summary)
await self._execute_actions()
```

Extra LLM calls only happen in two non-normal-path cases, both in `_get_model_output_with_retry` (`service.py:1670`):
- The model returns an empty/invalid `action` list → one retry call with a clarification message appended (`service.py:1687-1688`); if still empty, a synthetic `done(success=false)` action is inserted with no further LLM call.
- A rate-limit/provider error in `get_model_output` triggers a fallback-LLM retry (`service.py:1975-1981`), which is still one call, just to a different model.

So: **1 LLM call per step**, with a bounded retry (at most 1 extra call) only on malformed output.

---

## 2. Multi-action batching

Yes — the model can return several actions in one structured-output response, and `multi_act()` executes them all without another LLM call (subject to the early-stop guards in Q3).

Schema (`views.py:388-399`):
```python
class AgentOutput(BaseModel):
	model_config = ConfigDict(arbitrary_types_allowed=True, extra='forbid')

	thinking: str | None = None
	evaluation_previous_goal: str | None = None
	memory: str | None = None
	next_goal: str | None = None
	current_plan_item: int | None = None
	plan_update: list[str] | None = None
	action: list[ActionModel] = Field(
		...,
		json_schema_extra={'min_items': 1},  # Ensure at least one action is provided
	)
```
`action` is a `list[ActionModel]`, min 1 item, capped server-side at `max_actions_per_step` (default `5`, `views.py:71`), enforced in `get_model_output`:
```python
# service.py:1963-1964
if len(parsed.action) > self.settings.max_actions_per_step:
	parsed.action = parsed.action[: self.settings.max_actions_per_step]
```

Executor loop (`_execute_actions` at `service.py:1225-1230`):
```python
async def _execute_actions(self) -> None:
	result = await self.multi_act(self.state.last_model_output.action)
	self.state.last_result = result
```
`multi_act()` (`service.py:2730`) then iterates over `actions` in a single `for i, action in enumerate(actions)` loop, calling `self.tools.act(...)` for each — all within the same step, no re-invocation of the LLM.

---

## 3. What stops the batch early

Two independent guard layers inside `multi_act()` (`service.py:2730-2836`), documented in its own docstring:

```python
"""Execute multiple actions with page-change guards.

Two layers of protection prevent executing actions against stale DOM:
  1. Static flag: actions tagged with terminates_sequence=True (navigate, search, go_back, switch)
     automatically abort remaining queued actions.
  2. Runtime detection: after every action, the current URL and focused target are compared
     to pre-action values. Any change aborts the remaining queue.
"""
```

**Layer 1 — static `terminates_sequence` flag** on the action registration (`tools/registry/views.py:23-24`):
```python
# multi_act() will abort remaining queued actions after executing a terminates_sequence action.
terminates_sequence: bool = False
```
Checked in the loop:
```python
# service.py:2814-2819
registered_action = self.tools.registry.registry.actions.get(action_name)
if registered_action and registered_action.terminates_sequence:
	self.logger.info(
		f'Action "{action_name}" terminates sequence — skipping {total_actions - i - 1} remaining action(s)'
	)
	break
```
Actions marked `terminates_sequence=True` in `tools/service.py`: the search action (line 461), `navigate` (line 505), `go_back` (line 583), the tab-switch action (line 1007), and `evaluate` (arbitrary JS execution, line 1835).

**Layer 2 — runtime URL/focus comparison** (not element-hash comparison — see note below):
```python
# service.py:2782-2783 (pre-action capture)
pre_action_url = await self.browser_session.get_current_page_url()
pre_action_focus = self.browser_session.agent_focus_target_id
...
# service.py:2821-2826
post_action_url = await self.browser_session.get_current_page_url()
post_action_focus = self.browser_session.agent_focus_target_id

if post_action_url != pre_action_url or post_action_focus != pre_action_focus:
	self.logger.info(f'Page changed after "{action_name}" — skipping {total_actions - i - 1} remaining action(s)')
	break
```

Also stops the batch (unconditionally, same loop, `service.py:2803-2804`):
```python
if results[-1].is_done or results[-1].error or i == total_actions - 1:
	break
```
i.e. an action that errors, or the `done` action, or simply reaching the last action in the list, also ends the loop. Separately, `done` can only be executed as a single action — if it appears mid-batch (`i > 0`) the loop breaks before executing it (`service.py:2762-2766`).

**Note on the prompt's mention of "element hashes":** the multi_act mechanism itself compares **URL + focused-element target id**, not DOM/element hashes. The system prompt (`system_prompts/system_prompt.md:158`) states this to the model in plain terms: *"If the page changes after an action, the remaining actions are automatically skipped and you get the new state."* No element-hash diffing was found anywhere in `multi_act`. A `cached_selector_map` variable is computed at the top of `multi_act` (`service.py:2745-2753`) from `browser_session._cached_browser_state_summary`, but it is not referenced anywhere later in the function in this version of the code — it does not participate in the early-stop logic.

---

## 4. Structured output fields besides `action`

From `AgentOutput` (`views.py:388-399`, quoted above): `thinking`, `evaluation_previous_goal`, `memory`, `next_goal`, `current_plan_item`, `plan_update`, plus `action`.

- `thinking: str | None` — scratchpad reasoning (can be stripped — see below).
- `evaluation_previous_goal: str | None` — required in the enforced JSON schema (see `model_json_schema` override, `views.py:400-403`) even though the Python type is optional.
- `memory: str | None` — also schema-required.
- `next_goal: str | None` — also schema-required.
- `current_plan_item` / `plan_update` — optional plan-tracking fields.

`model_json_schema` override forces some fields to be required at the JSON-schema level regardless of the Python `Optional` typing:
```python
# views.py:400-403
@classmethod
def model_json_schema(cls, **kwargs):
	schema = super().model_json_schema(**kwargs)
	schema['required'] = ['evaluation_previous_goal', 'memory', 'next_goal', 'action']
	return schema
```

There is also an `AgentBrain` model (`views.py:381-386`) with the same four fields (`thinking`, `evaluation_previous_goal`, `memory`, `next_goal`) kept for backward compatibility, built from `AgentOutput.current_state` (`views.py:405-411`).

Reduced-field variants exist for cost/latency tuning:
- `type_with_custom_actions_no_thinking` (`views.py:432-454`) drops `thinking` from the schema.
- `type_with_custom_actions_flash_mode` (`views.py:456-...`) additionally drops `thinking`, `evaluation_previous_goal`, `next_goal`, `current_plan_item`, `plan_update`, leaving essentially `memory` + `action` (comment: *"memory and action fields only"*).

---

## 5. Conversation history management across steps

**Not** a growing full-history transcript and **not** a token-based rolling window of raw messages. The LLM input is rebuilt fresh every step from a fixed small set of message "slots," while cross-step history is compressed into short text summaries — old DOM trees and screenshots are structurally dropped, not just truncated.

`MessageHistory` (`message_manager/views.py:69-83`) holds only three things:
```python
class MessageHistory(BaseModel):
	system_message: BaseMessage | None = None
	state_message: BaseMessage | None = None
	context_messages: list[BaseMessage] = Field(default_factory=list)

	def get_messages(self) -> list[BaseMessage]:
		"""Get all messages in the correct order: system -> state -> contextual"""
		messages = []
		if self.system_message:
			messages.append(self.system_message)
		if self.state_message:
			messages.append(self.state_message)
		messages.extend(self.context_messages)
		return messages
```
`system_message` is set once (only if history is empty, `message_manager/service.py:148-149`). `state_message` is **replaced** (not appended) every step via `_set_message_with_type(..., 'state')` (`message_manager/service.py:556-568`) inside `create_state_messages` (`message_manager/service.py:424`). So `get_messages()` always returns a short, roughly-constant-size list (system + current state + any context messages), regardless of how many steps have run.

Cross-step memory of *what happened* is carried as **text**, in `MessageManagerState.agent_history_items: list[HistoryItem]` (`message_manager/views.py:93-95`), appended to each step by `_update_agent_history_description` (`message_manager/service.py:304`). Each `HistoryItem` stores only `evaluation_previous_goal`, `memory`, `next_goal`, and a compacted `action_results` string (`message_manager/views.py:15-23`) — no DOM, no screenshot. This text list is joined into the `<agent_history>` block via the `agent_history_description` property (`message_manager/service.py:153-186`), which also supports an explicit cap:
```python
# message_manager/service.py:107-121 (constructor) / 176-184
max_history_items: int | None = None
...
items_to_include = [
	self.state.agent_history_items[0].to_string(),  # Keep first item (initialization)
	f'<sys>[... {omitted_count} previous steps omitted...]</sys>',
]
items_to_include.extend([item.to_string() for item in self.state.agent_history_items[-recent_items_count:]])
```
Older history text can also be summarized/compacted by an LLM via `maybe_compact_messages` (`message_manager/service.py:216`) into `self.state.compacted_memory`, prefixed into the description (`message_manager/service.py:158-165`).

Screenshots specifically: `create_state_messages` builds `screenshots` fresh each call from the **current** `browser_state_summary.screenshot` only:
```python
# message_manager/service.py:449-476
# Use only the current screenshot, but check if action results request screenshot inclusion
screenshots = []
...
if include_screenshot and browser_state_summary.screenshot:
	screenshots.append(browser_state_summary.screenshot)
```
No prior-step screenshot is ever kept in `screenshots` — only the just-captured one, and only if vision is enabled/requested for that step (see Q6). Likewise `read_state_images`/`read_state_description` are explicitly cleared at the top of every `_update_agent_history_description` call (`message_manager/service.py:317-318`: `self.state.read_state_description = ''` / `self.state.read_state_images = []  # Clear images from previous step`) and only hold the immediately-preceding step's extraction output.

---

## 6. System prompt guidance: screenshot vs DOM text

From `browser_use/agent/system_prompts/system_prompt.md`:

Input description (lines 20-22):
```
5. <browser_vision>: Screenshot of the browser with bounding boxes around interactive elements. If you used screenshot before, this will contain a screenshot.
6. <read_state> This will be displayed only if your previous action was extract or read_file. This data is only shown in the current step.
```

`<browser_vision>` block (lines 64-68):
```
<browser_vision>
If you used screenshot before, you will be provided with a screenshot of the current page with  bounding boxes around interactive elements. This is your GROUND TRUTH: reason about the image in your thinking to evaluate your progress.
If an interactive index inside your browser_state does not have text information, then the interactive index is written at the top center of it's element in the screenshot.
Use screenshot if you are unsure or simply want more information.
</browser_vision>
```

Verification / evaluation guidance (line 186):
```
Always verify using <browser_vision> (screenshot) as the primary ground truth. If a screenshot is unavailable, fall back to <browser_state>. If the expected change is missing, mark the last action as failed (or uncertain) and plan a recovery.
```

Critical reminders / error recovery (lines 245, 249, 262):
```
1. ALWAYS verify action success using the screenshot before proceeding
5. NEVER assume success - always verify from screenshot or browser state
1. First, verify the current state using screenshot as ground truth
```

This text describes the *taking of a screenshot as an explicit tool-triggered event* ("If you used screenshot before..."), consistent with the code behavior found in Q5: by default the automatic per-step screenshot is only attached to the LLM message when `use_vision=True`, or in `"auto"` mode only when an action result explicitly requested it (`message_manager/service.py:461-472`, quoted above) — i.e. the DOM text (`<browser_state>`) is the default channel, and the screenshot/`<browser_vision>` channel is added when vision is enabled or an action (e.g. `screenshot`) asks for it.

---

## 7. Explicit latency optimizations

No `asyncio.gather`/parallel LLM+DOM prep and no next-state prefetch were found around the step loop in `service.py`. What is present:

**a) Fixed-prefix LLM prompt caching (Anthropic-style, cost/latency).** System message and state (user) message are marked cacheable:
```python
# prompts.py:58
self.system_message = SystemMessage(content=prompt, cache=True)
```
```python
# prompts.py:504, 506
return UserMessage(content=content_parts, cache=True)
...
return UserMessage(content=state_description, cache=True)
```
The Anthropic chat client serializes these into `cache_control=CacheControlEphemeralParam(type='ephemeral')` breakpoints (`llm/anthropic/serializer.py:64-66`, `102-106`, `211-212`, `244`) and reports cache hit/creation token counts back:
```python
# llm/anthropic/chat.py:218-221
prompt_cached_tokens=response.usage.cache_read_input_tokens,
prompt_cache_creation_tokens=response.usage.cache_creation_input_tokens,
prompt_cache_creation_5m_tokens=cache_creation_5m_tokens,
prompt_cache_creation_1h_tokens=cache_creation_1h_tokens,
```
The system-prompt builder is explicitly aware of caching requirements for specific model families:
```python
# tools/registry/service.py:266-267
# Check if this is an Anthropic 4.5 model that needs longer prompts for caching
self.is_anthropic_4_5 = _is_anthropic_4_5_model(model_name)
```
This is enabled structurally by the fact (Q5) that the system message is built once and the state message replaces (not appends to) history each step, keeping a stable, cacheable prefix instead of an ever-growing transcript.

**b) Browser-state caching to avoid a redundant DOM/screenshot fetch.** `get_browser_state_summary(..., cached: bool = False, ...)` (`browser/session.py:1595-1611`) can return `self._cached_browser_state_summary` instead of re-querying the page:
```python
# browser/session.py:1601-1611
if cached and self._cached_browser_state_summary is not None and self._cached_browser_state_summary.dom_state:
	selector_map = self._cached_browser_state_summary.dom_state.selector_map
	if include_screenshot and not self._cached_browser_state_summary.screenshot:
		...  # fall through to fetch fresh
	elif selector_map and len(selector_map) > 0:
		self.logger.debug('🔄 Using pre-cached browser state summary for open tab')
		return self._cached_browser_state_summary
```
Note: `Agent._prepare_context` (`service.py:1094-1098`) calls `get_browser_state_summary(include_screenshot=True, include_recent_events=...)` without passing `cached=True`, so the per-step call in the main agent loop always fetches a fresh state; the `cached=True` path exists as a capability on `BrowserSession` but is not exercised by the step loop itself. `multi_act` separately reads `browser_session._cached_browser_state_summary` (`service.py:2745-2753`) just to build a `cached_selector_map` dict, which — per Q3 — was not found to be used further in this function.

**c) Reduced-field output schemas** (`no_thinking`, `flash_mode` variants, Q4) cut output tokens/generation latency by omitting `thinking` and other narrative fields from the required JSON schema.

**d) Multi-action batching itself (Q2/Q3)** is the primary mechanism that reduces round-trip *count*: several tool actions execute per LLM call instead of one action per call, subject to the page-change guards.

No evidence of: parallel/concurrent LLM calls, background prefetch of the next browser state while the LLM is thinking, or `asyncio.gather` used anywhere in the step/`_prepare_context`/`_get_next_action`/`_execute_actions` chain in `service.py` (the only `asyncio.gather` found in the read files is unrelated, in `browser/session.py:1951`, for redirect-tracking tasks).

---

## Summary

The loop is 1 LLM call → up to `max_actions_per_step` (default 5) tool actions executed in-process → repeat. Round-trip count is kept low primarily by (1) letting the model emit a batch of actions per call rather than one action per call, (2) safety-gating that batch with cheap runtime checks (URL/focus-target diff, a static `terminates_sequence` flag on navigation-like actions, and hard stops on `done`/error/end-of-list) so it never blindly executes against a stale DOM, and (3) keeping the per-step LLM input small and prefix-stable (fixed system message + single replaced state message + compact text-only history) which both bounds prompt growth and makes the prefix cacheable, rather than by parallelizing LLM calls.
