## Context

`canUseTool` (`host/agent/policy/can-use-tool.js`) is invoked by the SDK **once per tool call**. A batch is one tool call. Left alone, every item inside it would be invisible to the gate — including the `computer` and `javascript_tool` actions that `SEND_CLASS_TOOL_NAMES` exists to catch. That is the whole difficulty of this change; the sequential loop itself is trivial.

Two facts from `classifySendClassCall()` (`host/agent/tools/mapping.js:612`) shape the design:

- A click whose target resolves to a submit/send/pay/confirm control is `approve-known` — it needs the user.
- A `key` press carrying Enter or Space **with no resolvable target hint** is `approve-unknown` — it also needs the user.

The second one is the awkward one, because the obvious high-value batch is `click(ref) → type → key Return → screenshot`, and that `key Return` is frequently exactly the hintless case.

## Goals / Non-Goals

**Goals**

- One round trip for a predictable run of actions.
- The send-class gate is exactly as strong with batching as without it.
- A batch that runs against assumptions that stopped holding stops, loudly, mid-way.

**Non-Goals**

- Not parallel execution. Sequential only; the ordering is the point.
- Not a way to get a submit past the user.
- Not a replacement for looking. A screenshot is still how the model sees what happened; the batch just stops paying a round trip for each step on the way there.

## Decisions

### Decision: Send-class items are refused inside a batch, not approved inside it

The alternative — classify every item up front and raise an approval card for each send-class one before dispatching — is rejected on accuracy grounds, not effort.

Classification binds to evidence about the target (`resolveTargetEvidence`). For item 1 that evidence describes the page as it is. For item 4 it describes the page as it was *before items 1 through 3 ran*. An approval card asking the user to confirm a payment, bound to evidence that no longer describes what will be clicked, is worse than having no batching at all: it is a decision made on a stale description. `test/approval-evidence-binding.test.mjs` exists precisely because that binding has to mean something.

Refusing instead is both safer and nearly free. An action requiring the user's decision was always going to cost a separate round trip — the user has to see a card and answer it. Hoisting it out of the batch costs nothing that batching was ever going to save.

So: the useful shape is `click(ref) → type → screenshot` as a batch, then `key Return` as its own gated call. The expensive, predictable part is still collapsed.

### Decision: The gate is enforced host-side, before the batch reaches the extension

The classifier, the approval registry and the evidence binding all live in the host. The extension has none of them and must not grow a second copy. The host validates the batch — rejecting it whole if any item classifies as anything other than `allow` — and only then dispatches.

Rejecting the **whole** batch rather than truncating at the offending item is deliberate: a partially-executed batch whose tail was silently dropped for a policy reason is a confusing result, and the model can reissue trivially with the item removed. Contrast the runtime stop conditions below, which are discovered mid-flight and therefore must report a partial result.

### Decision: Stop conditions are URL and focus, sampled between items

Taken from browser-use's `multi_act` (`agent/service.py:2730-2836`), which compares page URL and focus target id before and after each action rather than diffing element hashes.

Both map directly onto what a later item assumes. A URL change means the later items were written for a page that is gone. A focus change means a following `type` would land somewhere else — the single most damaging silent failure in a form fill.

Claude in Chrome's own batch stops on first error only. Adding the browser-use conditions on top is strictly more conservative, which is the right direction given the stated priority of accuracy over speed.

### Decision: Stale refs inside a batch need no new machinery

A ref resolved mid-batch goes through `resolveRefToCoordinates()`, which re-resolves against the live DOM, scrolls into view and hit-tests — then `probeHit` reports what actually received the click. A ref invalidated by an earlier item therefore fails with the existing "no longer exists on the page" or "could not bring into view" error, which trips the batch's stop-on-error condition.

This is why the port is safe, and it is a consequence of work already landed: since ref precedence was fixed, the resolve path can no longer be skipped by a coordinate arriving alongside the ref.

### Decision: Coordinates are interpreted against the pre-batch screenshot

Unchanged semantics — `screenshotToCssCoordinate()` maps against the tab's last recorded capture scale, and no capture inside the batch has reached the model. The only work here is saying so in the description, as Claude in Chrome does, so the model does not write a coordinate for a state it has not seen.

### Decision: `find` is documented as belonging before a batch

`find` returns references the model must read in order to choose one. It can appear as the last item of a batch (gathering for the next turn), but a batch of `find` then a click on its result is incoherent — the model would have to have known the ref already. The description says so, because the alternative is the model batching a `find` and then guessing.

## Risks / Trade-offs

**The gate edit is the highest-risk change in this proposal.** `can-use-tool.js` is the file that decides whether an action needs the user. Mitigation: the existing approval tests define the contract and must all still pass unchanged, plus new tests asserting that a send-class item is refused inside a batch and that no batch approval authorizes one.

**A long batch delays what the user sees.** The panel narrates per tool call, so a batch of six shows as one running operation instead of six. Accepted; the alternative is the round trips. Kept bounded by the stop conditions, which end a batch as soon as the page moves.

**Focus sampling costs a round trip to the page between items.** Small next to a model turn, and it is the check that prevents the worst silent failure. Measure before optimizing.

**The model may over-batch and get stopped constantly.** Self-correcting — a stopped batch returns partial results and the reason — but the description should steer toward batching only what is genuinely predictable.

## Migration Plan

Purely additive; no existing tool's schema or behavior changes. Regenerate `test/fixtures/registry-baseline.json` and add `browser_batch` to the enumerated post-baseline addition list.

Reload the extension.

Ship after `add-search-engine-tool` and `mark-new-page-elements`, which are independent and carry none of this risk.

## Open Questions

- Should there be a cap on items per batch? browser-use uses five; Claude in Chrome sets none. Leaning none, because the stop conditions already bound a runaway batch — but a cap is cheap insurance if a long batch proves hard to narrate in the panel. Decide during implementation, with the default being no cap.
