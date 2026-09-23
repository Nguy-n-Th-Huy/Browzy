## Why

Today Jev drives a browser task only as its own standalone `typesafe` run: Jev owns the whole loop, and the configured model is consulted for planning, content, recovery and completion. The `anthropic` and `chatgpt` runs are the opposite shape — the LLM drives directly, calling `computer`, `form_input` and `navigate` one action at a time. Ulka (a sibling Jev extension) shows a productive middle: the LLM plans, and delegates one bounded natural-language interaction at a time to Jev, which selects the concrete action from observed controls. This change brings that `browser_subgoal` capability to Browzy's LLM runs, so an `anthropic`/`chatgpt` task can hand a single subgoal to Jev instead of issuing raw clicks, while keeping every existing guard and leaving the standalone `typesafe` run untouched. Only the idea is ported; no ulka code or dependency is used.

## What Changes

- A new host-implemented SDK tool `browser_subgoal({ goal })` is offered to `anthropic`/`chatgpt` runs. The LLM calls it to accomplish one bounded interaction; the tool runs a short, bounded Jev sub-run on the same tab and returns an **unverified checkpoint** (observed page state + a bounded summary of the actions Jev took + a terminal reason), never a task-level success.
- The tool is registered **only when** the run's profile also has Jev configuration saved (typesafe source + typesafe API key + text model + text-model API key). When that configuration is absent, the tool is silently not registered — no error, exactly the WebMCP silent-absence pattern. There is no fallback to the Anthropic/Gateway key for Jev.
- The Jev runtime gains a **subgoal mode**: the caller (the LLM) supplies the goal, Jev selects concrete actions from observed controls, TYPE_TEXT values come from the configured Jev text model (and the operator-literal fast path applies, sourced from the subgoal text), and the sub-run ends at Jev's DONE as an unverified checkpoint. Subgoal mode does **not** run a task-level LLM plan/replan or a completion verification/report — those stay with the driving LLM.
- The sub-run shares the outer run's browser lease, tab scope, `toolBridge`, `canUseTool`, approval cards, single-use grants, dispatch checks and docNonce/target re-validation. It uses smaller bounded action/decision/no-progress budgets. `ASK` inside a subgoal surfaces a blocked/needs-operator outcome to the caller.
- The standalone `typesafe` run and the existing `anthropic`/`chatgpt` behavior are unchanged except for the added, opt-in tool.

## Capabilities

### New Capabilities

- `jev-browser-subgoal`: the `browser_subgoal` SDK tool — its schema, gated availability, bounded sub-run execution on the shared run, the unverified-checkpoint result contract, and honest failure/availability reporting.

### Modified Capabilities

- `jev-decision-layer`: adds a bounded **subgoal (checkpoint) mode** — Jev runs against a caller-supplied goal and ends at DONE as an unverified checkpoint, with no task-level completion verification, while every dispatch guard and run bound stays authoritative.
- `typesafe-jev-provider`: "Coexistence with the existing runtimes" is updated so it still holds with the new tool — a `typesafe` run is unchanged, and `anthropic`/`chatgpt` runs behave exactly as before except that, when Jev is configured, they additionally offer `browser_subgoal`; lease and queue arbitration are unchanged.

## Impact

- `host/agent/companion.js`: register `browser_subgoal` in the `createBrowserMcpServer` `extraTools` (~3944) only when the resolved profile snapshot carries Jev config; build the sub-run `provider` (goal = subgoal text, Jev source/endpoint/apiKey + textModel/apiKey, outer `tabId`, `sendScreenshots`) and invoke `runTypesafeRun` in subgoal mode sharing `run`/`toolBridge`/`coerceArgs`/`canUseTool`.
- `host/agent/jev/runtime.js`: add subgoal mode to `runTypesafeRun` (keep prepare/replan as content prep; skip only completion verify/report; end at DONE or positive `goal_done` as an unverified checkpoint; smaller bounds incl `maxMemoryUpdates` 1–2); return a structured checkpoint result.
- `host/agent/settings/profile.js`: new exported resolver returning the resolved Jev config (or `null`) for `anthropic`/`chatgpt` gating and sub-run `provider` construction, with the endpoint fallback to `typesafeDefaultForSource`.
- `host/agent/tools/` and `host/tool-definitions.js`: the tool definition/among the SDK extra tools (a host-implemented tool, not a new executor operation, so the 26-operation baseline is unchanged).
- Settings: no host change — `set_typesafe_config`/`set_typesafe_credentials` (companion.js ~2753-2823) already persist Jev config on any profile with the shape unchanged (confirmed in design decision 7). The extension-side settings UI hiding these fields for non-`typesafe` types is an out-of-scope, extension-side gap.
- Tests: new `host/test/jev-browser-subgoal.test.mjs` (tool gating, checkpoint contract, failure honesty) and subgoal-mode coverage in the existing Jev runtime tests.
- Out of scope: making Jev the sole driver of LLM runs; action caching; `extract_page`; standalone `typesafe` behavior changes; iframe/remote MCP tools.
