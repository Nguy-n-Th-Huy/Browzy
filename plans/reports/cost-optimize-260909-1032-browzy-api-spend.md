# Cost Optimization — Browzy in Chrome

## Step 0 — Scope, platform, quality bar, baseline

### Scope: three traffic classes, not one

| Class | Call site | Shape | Share of spend |
|---|---|---|---|
| **Conversation runs** | `host/agent/tools/query-options.js` → `buildIsolatedOptions()` | Agentic loop, 26 browser tools + SDK built-ins, multi-turn, screenshots accumulating | Dominant |
| **Prompt enhancement** | `host/agent/enhance-prompt.js` → `buildEnhanceOptions()` | Single-shot, `maxTurns: 1`, `tools: []`, no system prompt | Small |
| **Settings connection test** | `host/agent/settings/capability-test.js` | One-off per setup/profile change | Negligible |

Cost per task means nothing blended across these. Everything below is about class 1 unless stated.

### Platform: operator-configured, and this filters the lever list hard

`ANTHROPIC_BASE_URL` comes from the operator's profile (`host/agent/settings/profile.js:208` — `profile.baseUrl`), not a fixed Anthropic endpoint. Archived evidence shows a real installation pointing at a third-party gateway. **This is the single biggest unknown in this audit**, because it decides:

- whether the Usage and Cost Admin API exists at all (Step 1's measured path),
- whether published Anthropic per-token rates even apply,
- whether batch, fast mode, and the beta-gated levers are served.

Nothing below assumes first-party availability. Levers that depend on it are marked.

### Surface: Claude Agent SDK, not the Messages API

Calls go through `@anthropic-ai/claude-agent-sdk` 0.3.263 `query()`. That rules out the Messages-API levers by construction — no hand-placed `cache_control` breakpoints, no `messages.batches`, no `output_config.format`. **It does not rule out as much as it first appears**, which is the useful half of this finding: the pinned SDK exposes `effort`, `taskBudget` (alpha), `maxBudgetUsd`, `thinking`, `maxTurns`, a documented system-prompt cache boundary, and the four usage meters. Verified in `sdk.d.ts` at the line numbers cited per lever.

### Quality bar: none exists

No eval, no golden set, no outcome check on model output. The test suite (60 files in `test/`, plus `host/test/`) is unit and integration tests of the harness — protocol shapes, tool wiring, scope boundaries — none of which score what the model produces.

**Consequence, stated prominently as the guide requires: savings cannot be told apart from regressions.** Every tradeoff lever below is marked *needs an eval before applying*. Free wins remain safe to propose.

### Baseline: cannot be computed, and the reason is itself a finding

There is **no token accounting anywhere** in the project — `grep` for `usage.`, `input_tokens`, `output_tokens`, `cache_read` across `host/agent/**` returns nothing. The SDK reports `cacheReadInputTokens` and `cacheCreationInputTokens` (`sdk.d.ts:1314-1315`); nothing reads them.

So: no measured baseline, no cache hit rate, no input/output split. Per the guide's ranking-tier table, this audit is in the **pure code read** tier, and every ceiling below is quoted as a **relative bucket** — no dollar figures, no percentages. Quoting either would be fabrication.

---

## Step 1 — Token profile (estimated from code)

Project-controlled prefix, measured by character count (no API call made; ~3.7 chars/token used only to state an order of magnitude):

| Component | Chars | ≈ tokens |
|---|---|---|
| Browser-automation system prompt (`renderBrowserAutomationSystemPrompt`) | 9,204 | ~2,500 |
| Tool registry text, 26 tools (`host/tool-definitions.js`) | 24,336 | ~6,600 |
| **Project-controlled prefix subtotal** | **33,540** | **~9,100** |

Not included and not visible from source: the SDK's own preset system prompt and its built-in tool schemas (Read/Write/Edit/Bash/Glob/Grep/WebSearch/WebFetch/Task). Plausibly comparable in size or larger. The real prefix is therefore **at least** ~9K tokens and probably well past it.

**Shape of the workload** — this is what decides which levers pay:

- **Every turn resends the whole growing conversation.** A browser-automation task is many turns; cost grows roughly with the square of turn count. This is the classic caching workload.
- **Screenshots are the recurring bulk input.** `MODEL_IMAGE_MAX_EDGE = 1568` (`extension/background.js:2496`) is the API's own ceiling before it downscales anyway — so each screenshot lands near the top of the vision cost band. The system prompt instructs "Screenshot after anything that changes the page", so a task takes many.
- **Effort defaults to unset** (`query-options.js:696-699`), meaning the model's own default applies — on Opus-tier that is `high`. The panel exposes per-turn effort selection, so the mechanism exists; the default is simply never lowered.
- **Interactive.** A user is watching in a side panel, so the batch tier is off the table for class 1.

---

## Ranked shortlist

*Ranked by savings ceiling, not application order.* Ceilings are relative buckets because the data tier is a pure code read (Step 0).

| Lever | Type | Savings ceiling | Data source |
|---|---|---|---|
| 1. System-prompt cache boundary (`SYSTEM_PROMPT_DYNAMIC_BOUNDARY`) | Free win | **Large** | Code estimate |
| 2. Screenshot resolution below the 1568 ceiling | Free win (quality-coupled) | **Medium–large** | Code estimate |
| 3. Prompt-surface trim (already in flight) | Free win | **Small–medium** | Code estimate |
| 4. Effort default lowered per route | Tradeoff | **Medium** | Published curves only |
| 5. `taskBudget` on the agentic loop | Tradeoff | **Small–medium** | Published curves only |
| 6. `maxBudgetUsd` hard stop | Backstop | **None per task** — caps damage | Code estimate |
| — Usage logging | Prerequisite | **Zero on its own** | — |

The list stops there. Levers 4 and 5 cannot be applied at all until an eval exists, and lever 2 needs one to be safe. Usage logging saves nothing but is the measurement channel for everything above it, which is why it is proposed first despite a zero ceiling.

---

## Proposed changes

Numbered in **§ 2 application order** (free wins → tradeoffs), not savings rank. All are **proposals** — a bare `cost-optimize` invocation has not asked for edits, and no measurement budget has been approved.

### C1 — Log the SDK's usage meters *(free win; prerequisite; proposed)*

Nothing measures anything today. The SDK already reports the four meters; the companion discards them.

Record per run, into the existing `events.jsonl` the conversation already writes: `inputTokens`, `outputTokens`, `cacheCreationInputTokens`, `cacheReadInputTokens` (`sdk.d.ts:1314-1315`), keyed per turn and rolled up per conversation.

Without this, every number in this report stays an estimate and no lever below can be validated. With it, the next run of this audit moves from "relative buckets" to "% of bill" — at zero API cost.

### C2 — Split the system prompt at the SDK's documented cache boundary *(free win; largest ceiling; proposed)*

**The defect.** `query-options.js:566-572` builds one string:

```js
const systemPromptText = [
  renderBrowserAutomationSystemPrompt(serverName),  // static, ~2,500 tok
  renderPageContextSystemPrompt(pageContext)        // dynamic: tabId, URL, title — changes every run
].filter(Boolean).join("\n\n");
// ...
systemPrompt: { type: "custom", prompt: systemPromptText }
```

The per-run page context is concatenated *into* the same string as the static instructions. A prompt cache is a prefix match, so a system prompt whose tail changes every run makes the **whole** ~2,500-token block uncacheable across sessions — the static half pays full price on every single conversation.

**The fix is a documented SDK feature, not a workaround.** `systemPrompt` accepts an array with a boundary marker (`sdk.d.ts:2139-2142`): *"blocks before the marker are eligible for cross-session prompt caching; blocks after it are not."* The constant is exported (`sdk.d.ts:8513`, `SYSTEM_PROMPT_DYNAMIC_BOUNDARY = "__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__"`).

```js
import { SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from "@anthropic-ai/claude-agent-sdk";

const pageContextText = renderPageContextSystemPrompt(pageContext);
// The static browser-automation instructions are byte-identical for every run
// of every conversation, so they belong before the boundary where the SDK can
// cache them across sessions. The bound page context names this run's tab, URL
// and title, so it must sit after it — inside the same string it would drag the
// static half out of the cache with it.
systemPrompt: pageContextText
  ? [browserPrompt, SYSTEM_PROMPT_DYNAMIC_BOUNDARY, pageContextText]
  : [browserPrompt],
```

**Why the ceiling is large**: the static block is re-billed at full rate on every conversation today, and cross-session caching reprices it. It also compounds with turn count, since every turn of the loop resends it.

**Verification**: C1 first, then confirm `cacheReadInputTokens` dominates `inputTokens` on a warmed second conversation. Per the guide, measure from the second request on — cache writes bill above cost, so a cold first run reads as a regression.

**Risk**: low. No instruction text changes; only where the boundary falls. Worth checking that the gateway honours cross-session caching at all — see the open questions.

### C3 — Land the prompt-surface trim *(free win; in flight; no new work proposed)*

Already covered by the `prompt-audit` run earlier in this session (`plans/reports/prompt-audit-260909-1023-browzy-prompt-surface.md`) and currently being applied. Relevant here because F3 removes a duplicated system-prompt section — a straight prefix reduction on every request.

Published expectation for the general case: prompts written for a prior model cost ~36% more per task for no accuracy gain; audited, ~14% cheaper *and* more accurate. Not claimed as this project's number — it has no eval to confirm it.

### C4 — Screenshot resolution *(free win on cost, quality-coupled; needs an eval; proposed with a caveat)*

`MODEL_IMAGE_MAX_EDGE = 1568` sits at the API's own downscale ceiling, and the loop takes many screenshots per task, so this is plausibly the largest *recurring* input line item after the prefix. Vision cost scales with pixel area, so 1568 → 1280 would cut roughly a third off every screenshot.

**Do not apply this blind.** `extension/background.js:2496-2504` ties `MODEL_IMAGE_MAX_EDGE` to `screenshotToCssCoordinate()`, and the system prompt's own comment states the two are one mechanism that must not be changed apart. The coordinate route reads targets straight off the image; lowering resolution costs the model precision exactly where it has no label to search for. The scaling math would follow the constant correctly — the risk is accuracy, not arithmetic.

Needs an eval that exercises the coordinate route (unlabelled targets, small controls) before this can be judged.

### C5 — Lower the effort default per route *(tradeoff; needs an eval; proposed)*

`effort` defaults to unset → the model's own default (`high` on Opus-tier). The panel already exposes per-turn selection, so no new mechanism is needed — only a different default.

Published curves: on research and knowledge work, `medium` matched the default's accuracy at 70–85% of cost, and the default bought nothing measurable over `medium`. On long-horizon coding, a real trade (~2 points at `medium` for half the cost). Browser automation is not either benchmark — its curve is unknown and must be swept on this workload.

Two candidates worth separating: the **enhance-prompt** call (a bounded single-shot rewrite — a strong `low` candidate, and the cheapest place to start because it has no tool loop and no side effects to replay) and the **conversation loop** (genuinely agentic; do not lower without measurement).

### C6 — `maxBudgetUsd` as a hard stop *(backstop; proposed)*

`sdk.d.ts:1773-1777`: *"Maximum budget in USD for the query. The query will stop if this budget is exceeded, returning an `error_max_budget_usd` result."*

This saves nothing per task — it caps the tail. A runaway browser loop (the failure mode the system prompt's own "Avoid rabbit holes and loops" section exists to prevent) currently has no ceiling but the user noticing. Worth wiring as a per-run guard with a generous value, surfaced in the panel when it trips.

### C7 — `taskBudget` *(tradeoff; alpha; needs an eval; deferred)*

`sdk.d.ts:1778-1785`, marked `@alpha`, sent as `output_config.task_budget` with the `task-budgets-2026-03-13` beta header. Published measurement on coding: a generous budget gave up ~2.7 points of pass rate for 18% saving; the tightest gave up 4.4 points for 47%.

Deferred rather than proposed: it is alpha, beta-gated (availability on the operator's gateway unknown), and the guide says to set it from the loop's 90th-percentile token usage — a number this project cannot produce until C1 ships.

---

## Levers skipped, and why

So the next person does not re-litigate them:

| Lever | Why skipped |
|---|---|
| **Batch API** | Class 1 is interactive — a user watches in a side panel. Class 2 (enhance) is also user-blocking. No unattended traffic exists. |
| **Explicit `cache_control` breakpoints** | Messages-API parameter; not reachable through Agent SDK `query()`. C2 is the SDK's equivalent and is reachable. |
| **Structured outputs** to replace the enhance-prompt tag scaffold | Same reason — `output_config.format` is not exposed by `query()`. Recorded as F11 in the prompt audit so it is not "fixed" by reflex. |
| **Tool search / `defer_loading`** | The guide's threshold is ~10K schema tokens; the project's 26 tools are ~6,600. Below the line where the search step repays its overhead. Revisit if the registry grows. |
| **Context editing** | The guide is explicit that it is a context-window tool, not a savings lever — in the run measured for the platform docs it cost more than it saved. |
| **Compaction** | Handled by the SDK/CLI harness, not this project's to configure. |
| **Model swap** | Last lever by design, and unreachable without an eval. Model is operator-chosen per profile anyway, not a project default. |
| **Progressive disclosure of a reference doc** | No large reference document is inlined — the system prompt is instructions, not data. |
| **Files API + code execution** | No numeric or tabular work in this workload. |

---

## Next step / approvals needed

**Nothing here should be applied on this evidence alone**, except C1, which cannot regress anything.

Recommended order:

1. **Apply C1** (usage logging) — no API cost, no quality risk, and it converts this whole report from estimates into measurements.
2. **Collect a few days of real usage**, then re-run this audit. It moves to the "% of bill" tier and C2's ceiling becomes a number instead of a bucket.
3. **Apply C2** and confirm from the meters, measuring from the second conversation on.
4. **Build the minimal eval** (~20-30 real requests, frozen; an outcome check per output) before touching C4 or C5. That is the gate on every remaining lever.

### Open questions

1. **Which endpoint does the operator's profile actually point at?** First-party Anthropic, or a gateway? This decides whether the Admin API path exists, whether published rates apply, and whether the beta-gated levers (C7) are even served. Every ceiling in this report is shape-based and survives the answer, but the *measurement* path does not.
2. **Does that endpoint honour cross-session prompt caching?** C2's entire value rests on it. If the gateway does not cache across sessions, C2 becomes a no-op — worth confirming before spending effort on it.
3. **Is there any usage data at all today** — a Console the operator can read totals off, or gateway-side logs? That would skip step 2 above entirely.
4. **Whose bill is this?** If end users bring their own key, the optimization target is *their* cost and the framing changes: quality-for-cost tradeoffs (C4, C5) become defaults imposed on someone else's spend, which is a product decision, not an engineering one.
