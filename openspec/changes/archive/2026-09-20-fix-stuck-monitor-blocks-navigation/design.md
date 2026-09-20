## Context

See proposal.md — Why, for the motivation and the incident evidence.

Two facts about the current decision loop shape this design.

The loop reaches its stuck branch before any dispatch route:

```
observe → build candidates → Jev decides { action, goal_done, stuck }
   → target resolved?  → no  → skipped: target_unresolved
   → DONE / goal_done? → yes → verification
   → ASK / BLOCKED?    → yes → blocked
   → REPLAN or stuck?  → yes → skipped: replan, consult planning   ← the trap
   → dispatch
```

The branch treats an explicitly selected `REPLAN` operation and a positive `stuck` monitor as the same event, so a positive `stuck` discards whatever the action head selected. Planning is then consulted with the same goal, the same page and the same conversation, and returns the same plan, which produces the same decision. Nothing in the cycle can change, so the loop runs until a budget is spent. The action head is already gated for confidence and margin by `selectionResolves`; the monitor that overrides it is gated by nothing.

The pre-dispatch preflight re-reads the page and refuses to dispatch when the observation moved. For a candidate with an observed target that rule is what keeps a click honest. A `NAVIGATE` candidate has no target: its payload is a URL the planner prepared, bound to the plan revision rather than to anything on the page. The preflight nonetheless requires the whole observation — document identity, URL and signature — to be unchanged, and, when screenshots are enabled, the evidence capture repeats the same equality and cancels the dispatch when the page moved during the capture.

## Goals / Non-Goals

**Goals:**

- A run that starts on a page unrelated to the goal reaches the site the goal names.
- The escape is bounded and provably terminating: no new retry loop, no budget reset.
- A genuine stuck state still consults planning, and a run that truly cannot progress still ends blocked with a named reason.
- The staleness guarantee that protects targeted operations is untouched.

**Non-Goals:**

- Judging the `stuck` monitor's answer. It was correct in the incident; the defect is what the runtime did with it.
- Relaxing staleness for `WAIT` and `SCROLL_*`. They are targetless too, and the same argument may well apply to them, but they were not the reported failure and each carries its own reasoning about a page that is still settling.
- Changing what the planner prepares or how the action head chooses.

## Decisions

**Bound the stuck diversion to one per plan revision, rather than gating the monitor on confidence.**

The incident shows a `stuck` head at confidence 0.37 overriding an action head at 0.99, which makes a confidence gate tempting: require the monitor to clear the same floor and margin `selectionResolves` applies. It was rejected. A threshold is a new tunable whose correct value is unknown, it silently changes behaviour for every run, and it does not actually guarantee termination — a confident-but-wrong monitor reproduces the same loop. Bounding the diversion is a structural rule instead of a numeric one: the first positive `stuck` buys exactly one revised plan, and if the next decision still selects an executable action, that action runs. The loop cannot repeat because the permission is spent, whatever the monitor's confidence.

The bound is per plan revision and resets on dispatch, which is the honest reading of what the monitor is asked: "no useful progress under the *present* plan". Once planning has answered, the plan is no longer the one the monitor complained about, and the run owes the selected action an attempt. If that attempt changes nothing, the existing no-progress and repeated-no-change guards take over and still end the run blocked — with `no_progress`, which describes the real situation far better than `replan_limit` did.

An explicitly selected `REPLAN` operation is excluded from the bound. It is the action head's own request for new content, not a monitor's veto, and the "Replans never progress" scenario depends on it staying bounded exactly as it is today.

**Exempt NAVIGATE from the observation-equality preflight, by operation rather than by absence of a target.**

The narrower, more obvious edit is to drop the `!oldTarget` signature clause, but that clause also covers `WAIT` and `SCROLL_*`, which are out of scope. Keying the exemption on `operation === NAVIGATE` changes exactly the operation the evidence implicates and leaves the other two provably untouched.

What replaces the equality check is not "nothing". A prepared navigation still has to be valid at dispatch time: the record must be unconsumed, which is the existing `validPrepared` check and the single-use guarantee the spec already makes, and the destination must differ from the current URL, which the candidate builder already enforces when it offers the action. Those two conditions are the complete precondition for a page-independent action; the rest of the preflight was protecting a target that does not exist.

The evidence capture follows the same reasoning. A screenshot that no longer matches the observation is a worse *picture*, not a reason to abandon a navigation whose correctness never depended on the picture, so for `NAVIGATE` it records `screenshot: { status: "unavailable", reason: "stale_capture" }` and lets the dispatch proceed. Every other operation still treats a non-fresh capture as a refusal.

## Risks / Trade-offs

**A genuinely useless action now executes once per stuck episode instead of being replanned away** → It is dispatched at most once per plan revision, and its lack of effect feeds the existing no-progress and repeated-no-change guards, which end the run bounded. The cost is one wasted action; the benefit is that "the plan is already right, just run it" becomes expressible.

**Exempting NAVIGATE from observation equality means a navigation can fire against a page that changed after the decision** → The destination does not depend on that page, so the change cannot make the navigation wrong. The prepared record is still consumed before crossing the bridge, so the same URL cannot be dispatched twice, and the post-navigation observation is what proves where the run landed.

**Keying an exemption on one operation invites the next operation to need its own** → Accepted deliberately. `WAIT` and `SCROLL_*` may well deserve the same treatment, but extending it without evidence would be guessing; the narrow rule keeps the untested operations exactly as they are today.

**The stuck bound interacts with the stall recovery path, which also replans** → Recovery is triggered by the no-progress counter, not by the monitor, and it keeps its own `MAX_RECOVERIES` budget. The new bound only decides whether a monitor may withhold an action; it neither grants nor consumes a recovery.

## Migration Plan

Not applicable. The change is internal to the decision runtime, alters no stored data, no wire format and no user-visible setting, and takes effect for runs started after it ships. Rollback is reverting the change.
