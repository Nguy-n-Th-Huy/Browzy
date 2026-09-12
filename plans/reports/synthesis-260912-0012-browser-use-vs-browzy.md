# browser-use vs Browzy — what is actually portable

Source: browser-use @ 50f2055, read in scratchpad. Detail reports:

- `browser-use-dom-260911-2354-page-representation.md`
- `browser-use-loop-260911-2354-agent-loop.md`
- `browser-use-click-260911-2354-action-execution.md`

Browzy state: master @ e5b4c69 (after today's five commits).

## Where the speed difference actually is

Not in the browser layer. In the number of LLM round trips.

| | browser-use | Claude in Chrome | Browzy |
|---|---|---|---|
| LLM calls per step | 1 | 1 | 1 |
| Actions executed per call | up to 5 (`max_actions_per_step`) | unbounded list (`browser_batch`) | **1** |
| Batch early-stop | URL + focus-target-id diff per action; static `terminates_sequence` flag on navigating actions | stop on first error; per-item permission check | n/a |

A form fill costs Browzy one model turn per action, plus the confirming screenshot its own prompt asks for after anything that changes the page. Batching collapses the predictable middle of that into one turn. Roughly **3–5× fewer turns on a typical form fill** — not more, because browser-use's own early-stop breaks the batch at a navigation just as Browzy's would. Everything else measured — CDP cost, capture time, dispatch — is small next to one model turn.

`browser_batch` exists in the real Claude in Chrome tool set and not in Browzy (`host/tool-definitions.js` has 27 tools, no batch). Its own description says to "use this tool extensively … whenever you can predict two or more steps ahead".

## Where Browzy is already at parity, or ahead

Click accuracy. Both resolve a stable id to a live node, scroll it into view, and hit-test before dispatching a coordinate click:

- browser-use: cached selector map → `DOM.scrollIntoViewIfNeeded` → geometry recomputed fresh (`getContentQuads` → `getBoxModel` → `getBoundingClientRect`) → `document.elementFromPoint` occlusion check → `Input.dispatchMouseEvent`.
- Browzy: `resolveRefToCoordinates` (scrolls into view, hit-tests) → `probeHit` → CDP dispatch. Since `fc9dca9` the ref always wins over a coordinate, so this path is no longer skippable.

Browzy is **ahead** on one point: it tells the model which element actually received the click (`hitLandedNote_`). browser-use has no post-click verification at all beyond a checkbox/radio `checked` diff.

## Not portable — deliberate Browzy decisions

**DOM-text-first page representation.** browser-use sends a serialized tree (capped 40k chars) as the primary channel and treats the screenshot as verification. Browzy deliberately does the opposite: `renderBrowserAutomationSystemPrompt()` calls `read_page` "a last resort … it is large, slow, and turns visible work into an invisible DOM operation", because the user is watching the work happen in their own browser. That is a stated product requirement recorded in the source, not an oversight. Reversing it is the user's call, not an optimization.

**History pruning.** browser-use keeps one state slot and drops old screenshots. Browzy delegates conversation management to the Claude Agent SDK (`query-options.js` forwards `maxTurns`/`resume` only). Hand-rolling pruning would fight the SDK's own compaction. The lever here was `scale` (36fda61).

## Recommendations, ordered

### 1. `browser_batch` — the whole speed gap

Port the Claude in Chrome tool, with browser-use's stop conditions layered on:

- items run sequentially, stop on first error;
- stop when the page URL changed after an item;
- stop when the focused element changed after an item;
- coordinates inside a batch refer to the screenshot taken *before* the batch — must be stated in the description, as Claude in Chrome does.

**Ref staleness inside a batch is already handled, and that is why the port is safe.** Browzy's refs are `WeakRef`s (`content.js:128`) that persist across calls, so item 3 may use a ref that item 2 invalidated by rebuilding the DOM. It does not matter: `resolveRefToCoordinates` re-resolves and hit-tests at dispatch time, so a stale ref fails loudly (detached / not reachable) instead of clicking the wrong thing. Coordinates get the Claude in Chrome rule — they refer to the screenshot taken before the batch.

**`find` does not belong inside a batch.** Its whole output is refs the model has to read before choosing one, so it cannot be item 1 with a click on its result as item 3. The useful shape is `find` first, then a batch of `click(ref) → type → key → screenshot`. The tool description must say this, or the model will batch a `find` and get nothing usable from it.

**The hard part is not the loop — it is the approval gate.** `canUseTool` (`host/agent/policy/can-use-tool.js`) is invoked by the SDK **per tool call**. A batch is one tool call, so every item inside it would bypass the gate, including send-class actions that currently require explicit user approval. The batch handler must re-run classification and approval per item, or the tool is a permission hole. This is a design task, not a mechanical port.

### 2. Mark newly-appeared elements in `read_page` / `find`

browser-use prefixes new elements with `*`. Cheap, and it targets a failure Browzy's own prompt already warns about at length: refs inside a dropdown go stale when it closes, and an autocomplete entry is often not the first. Telling the model which elements are new since the last read is directly useful there.

Implementation is small because refs already persist and increment: "new" = elements whose ref was assigned since the last `read_page`/`find` on this tab. That needs one per-tab high-water mark, not a stored snapshot of the previous tree.

### 3. Occluded-element fallback — needs a product decision, not a port

browser-use falls back to JS `element.click()` when the point is occluded. Browzy instead reports the covering element and lets the model decide. A JS click is invisible to the user watching the page, which cuts against the same product requirement as #1 above. Browzy already handles the common case (a visually hidden control is clicked via its label, `refProxiedFrom`). Recommend leaving as is unless the user wants the fallback.

## Unresolved

- No live measurement yet of how many round trips a real Browzy run spends; the batch estimate is from architecture, not from a profile. The `kind: "tool"` log would give the real number.
- Whether the Agent SDK's compaction already drops old screenshots aggressively enough is unverified.
