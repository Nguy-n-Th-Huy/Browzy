## Context

See proposal.md — Why, for the motivation and the incident evidence.

The pre-dispatch path currently runs three checks in sequence, and all three can abort the dispatch with the same indistinguishable outcome:

```
canUseTool (gate)
  → re-read page
      → preflight: document, URL, target identity, prepared record,
                   whole-page signature for targetless operations
  → captureStepEvidence: screenshot, then re-read AGAIN
      → fresh = re-read ok AND same document
                AND whole-page signature equal
                AND target state equal
  → host-side checks
  → dispatch
```

The preflight's whole-page signature clause is deliberately narrow — it applies only to operations with no observed target, and `NAVIGATE` is already exempt. The capture's clause is not narrow: it applies to every operation, including a targeted click, and it compares the observation across a screenshot round-trip of roughly two seconds.

That clause was written to serve a real invariant, recorded in the code as "the picture can only claim this observation when the page survived the capture unchanged" together with "the same re-read prevents stale pre-action captures from authorizing a mutation". Those are two invariants, not one, and the single boolean conflates them. The first is about what the screenshot may be said to depict. The second is about whether the action may still fire — and for a targeted action, what makes it safe to fire is that the target has not moved or changed, which the same expression already tests separately, and which the preflight tests again more strictly through the full identity-field comparison.

## Goals / Non-Goals

**Goals:**

- A click succeeds on an ordinary page that changes while nobody is touching it.
- The invariant that protects a mutation — you act on the target you decided about — is preserved exactly, and remains enforced in two independent places.
- The screenshot never overstates what it depicts.
- A future occurrence of this failure class is readable from the run log rather than reconstructed by re-measuring a live page.

**Non-Goals:**

- Changing the preflight. Its whole-page clause governs only targetless operations, whose correctness genuinely can depend on the surrounding page, and it was left untouched deliberately once before.
- Changing `observationSignature` or the guards that consume it. As a progress detector it is doing its job; the defect is using it as an authorization gate.
- Fixing the terminal `action_denied`. See the limitation recorded in proposal.md.

## Decisions

**Split the freshness value by concern rather than by operation.**

The precedent in this file is an operation-keyed exemption: `NAVIGATE` was excused from the preflight because its payload is page-independent. Repeating that shape here — excusing `CLICK` too — was rejected. It would be a second special case papering over the same structural conflation, and it would leave `TYPE_TEXT`, `SELECT` and `HOVER` failing on exactly the same pages for exactly the same reason. The defect is not "which operations should be excused" but "the screenshot's honesty is not the action's authorization". Separating the two fixes every targeted operation at once and needs no list of exemptions to maintain.

Concretely, the capture keeps computing whether the picture still depicts the observation and keeps recording `stale_capture` when it does not. What changes is that this answer stops feeding the dispatch decision for an operation with an observed target. The post-capture dispatch decision is operation-aware: for `CLICK`, `TYPE_TEXT`, `SELECT` and `HOVER` it becomes the re-read succeeded, the document is the same, and the target's state is the same — the whole-page term is dropped. A targetless operation (`WAIT`, `SCROLL_*`) has no target row for that comparison to anchor on, so it keeps the whole-page `observationSignature` term in this second re-read exactly as it always had; only the preflight's *first* re-read was ever a candidate for this change, and only for operations the whole-page term can safely stop covering. Targetless operations therefore keep whole-page freshness enforced in both re-reads, unchanged by this fix.

**Why this does not weaken the changed-submission invariant.**

The existing regression that mutates a form's submission state inside the gate and expects a stale skip stays green without modification, and this is not incidental. That test changes the submit target's own observed row, which is precisely what the retained target-state comparison detects, and what the preflight's identity comparison detects independently. What is being removed is only the ability of an unrelated element elsewhere in the document to veto the click. A change to what the button would submit is not unrelated — it lives on the button's own row.

**Record a bounded host-authored code on every abandoned dispatch.**

Three distinct conditions currently collapse into one word in the log. Naming them is cheap and is the difference between reading the cause and re-deriving it. The codes are fixed strings chosen by the host, never text from the page or from a tool, which is the rule this file already follows where it refuses to persist echoes of tool error prose. The denial path is exactly where that rule bites: `dispatch()`'s own refusal `message` is built from `verdict?.message` or `firstTextOf(finalCheck.result)`, either of which can carry approval-gate or tool-supplied prose, so persisting it verbatim in the step record would be the same echo this file already refuses elsewhere. A fixed `deniedReason` enum naming which of the two gates refused carries the same diagnostic value without that risk, so it is what gets recorded — the free-text message stays out of the durable record.

Diagnostics alone would not be a fix, and are not offered as one; they ship alongside the behavioural change, not instead of it.

## Risks / Trade-offs

**An action could now fire while the page is mid-transition** → Only when the document identity and the target's own row are both unchanged. A transition that replaces the document, removes the target, or alters its state still aborts, in two independent places. What is newly tolerated is movement the action does not depend on.

**The screenshot attached to a step may now depict a page that has already moved on** → It is marked `unavailable` with `stale_capture` exactly as before, so nothing reads it as authoritative. The change is that an unreliable picture no longer decides whether an action happens — which is the behaviour already established for navigation.

**Reason codes could drift or multiply** → Each code is asserted by a test, so an unannounced rename or removal fails the suite.

**The terminal denial remains unexplained** → Accepted and documented rather than guessed at. It surfaced only after fourteen spurious aborts that this change eliminates, and the new denial reason makes it readable if it recurs.

## Migration Plan

Not applicable. The change is internal to the decision runtime, alters no stored data, no wire format and no user-visible setting, and takes effect for runs started after it ships. The step record gains fields; readers that ignore unknown fields are unaffected. Rollback is reverting the change.
