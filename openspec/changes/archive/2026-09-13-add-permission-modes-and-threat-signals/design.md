## Context

See proposal.md — Why. The machinery this builds on, and the constraints it imposes:

- Gating today runs through `host/agent/policy/can-use-tool.js`, which never returns null and always resolves allow or deny. Its classification comes from `classifySendClassCall()` in `host/agent/tools/mapping.js`, a four-way verdict (`allow`, `approve-known`, `approve-unknown`, `deny`) that applies only to `SEND_CLASS_TOOL_NAMES` — `computer`, `javascript_tool`, `webmcp_call_tool`. Every other tool bypasses it entirely.
- A separate, deliberately exhaustive classification already exists in the same file: `READ_ONLY_LEGACY_TOOLS` and `MUTATING_LEGACY_TOOLS` cover every registered tool, with `computer` split per-action via `COMPUTER_READ_ONLY_ACTIONS`. A registry-baseline test asserts the two sets plus `computer` account for every registry entry, so a new tool cannot fall through a default.
- Approvals are already bound hard: `ApprovalRegistry` tokens carry run, action, target, domain, document identity, execution nonce, normalized-argument fingerprint, observed state, and credential revision, are single-use, and are invalidated on Stop and scope change. The existing spec requires that no approval be derivable from webpage content.
- Downloads in this product do not use `chrome.downloads`. Recorder output is written by the native host because the browser download path pops an OS dialog. The extension therefore cannot currently observe a download a page starts.
- Settings persist through `chrome.storage.local` and `chrome.storage.session`. `chrome.storage.managed` is unused and is read-only by construction.
- Host-side policy modules are written as pure functions over caller-supplied snapshots specifically so every rejection path is unit-testable without standing up an SDK run. Extension-side logic is tested by brace-extraction from the shipped file under plain Node.

## Goals / Non-Goals

**Goals:**

- Auto mode reproduces today's behavior exactly, so the change is observably inert until a user opts into something else.
- Every action reaching dispatch has a class, and an unclassified action fails closed rather than open.
- Warning signals and authorization stay separable in the code, not only in the copy.
- Administrator policy is enforced where decisions are made, not only where settings are displayed.

**Non-Goals:**

- No change to approval-token binding, single-use semantics, or invalidation. Remembered decisions are a separate mechanism that produces a decision; they are never a stored token.
- No blocking on threat signals. The user's decision was explicitly warn-not-block, and no scenario in this change refuses an action because of a finding or a category.
- No model-side injection defense. The captured system prompt already instructs the model; this adds an independent observation of the same content, and the two are not merged.
- No sync of remembered decisions or mode across profiles or devices.
- No enumeration of installed browsers, profiles, or history for risk scoring. Signals come from the tab being controlled.

## Decisions

### 1. Mode selects among existing classifications rather than adding a parallel one

The exhaustive read-only/mutating split already exists and is test-enforced against the registry. Manual mode is "gate the mutating set", Auto is "gate the send/submit subset", Skip is "gate nothing but protected". No mode needs a classification the codebase does not already compute, so modes become a selection function over existing verdicts.

Alternative considered: a per-tool permission matrix the user edits. Rejected — it multiplies the decision surface by the registry size, has no defensible default, and would drift from the registry the moment a tool is added, whereas the existing sets are held to the registry by a test.

### 2. Protected classification is not policy-controlled

Protected is computed from what an action does, not from settings. Managed policy can pin modes and place site entries but cannot mark something unprotected — the spec makes that a scenario precisely so the implementation cannot grow a bypass. Placing the check in `authorization.js`, which runs unconditionally on every dispatch and cannot be short-circuited by an SDK preapproval, keeps it outside the path any mode or grant can reach.

The ordering is therefore: protected check first, then managed policy, then per-site store, then mode. Each later stage can only add a decision requirement, never remove one an earlier stage imposed.

### 3. Observing downloads requires the `downloads` permission, and its absence is a stated limit

The product writes files through the native host, so file writes it initiates are already observable. A download the agent causes by clicking a link on a page is not: the extension cannot see it without the `downloads` permission. The permission is therefore added, and used only to observe download creation for the protected-action class — not to start, redirect, or read downloads.

Trade-off: a new permission on an extension that already holds `debugger` and `<all_urls>`, in exchange for the protected class covering the case users actually mean by "download". Without it, the download category would silently cover only host-initiated writes while appearing to cover everything, which is the kind of gap this change exists to close.

### 4. Remembered decisions are origin-scoped entries, never stored tokens

A remembered decision is consulted to produce a decision; it never substitutes for an approval token. This keeps the existing binding requirements intact: a resolved call still goes through the same dispatch path with the same evidence checks, and a remembered entry cannot be replayed, transplanted to another run, or presented as authorization.

Scoping is by origin, not hostname or registrable domain: an origin is what the browser itself treats as a security boundary, and anything broader would let one subdomain's grant cover another's.

### 5. The injection probe is an independent observer, not a filter

The probe records findings and delivers content unchanged. It does not redact, rewrite, or withhold. Two reasons: withholding would break the reading requirements the runtime already guarantees, and a probe that alters content destroys the ability to compare what the model saw against what it did — which is the main thing an independent probe is for.

Matched text is carried as quoted data everywhere it travels. The spec states this for display; the implementation must also ensure a finding never re-enters the model's context as prose.

### 6. Risk category is derived from the controlled tab and recomputed on document identity change

Document identity is already tracked for the approval binding, and already has a defined reset point. Reusing it means the category cannot outlive the document it describes, and the reset needs no new notion of "the page changed".

The category warns only. It appears on the controlled tab through the existing pointer overlay's notice surface and in the panel, and it is listed among a decision card's context when one is shown — but the permission policy never reads it as an input to whether a decision is required. Keeping it out of the policy's inputs is what makes "warns, never blocks" checkable rather than a claim.

### 7. Managed policy is read at the decision point, not cached into local settings

Managed values are read where the decision is made, so a withdrawn policy stops applying immediately and can never persist as if it had been chosen locally. A malformed policy is reported rather than treated as absent — silently falling back would make a broken administrator deployment indistinguishable from an unmanaged one, which is the failure an administrator is least able to detect.

## Risks / Trade-offs

- **Manual mode makes ordinary browsing unusable through prompt volume** → Manual is opt-in and Auto is the default; remembering a decision per origin and action class is offered on every non-protected card, so the volume falls as the user answers. This is the mechanism that makes Manual survivable, not an afterthought.
- **Skip mode is a large capability reduction in safety** → Protected actions still gate under Skip, managed policy can require confirmation regardless, and the mode is visible whenever a run can act. A user in Skip can always see they are in Skip.
- **A remembered allowance is a standing grant for an origin** → It is origin-scoped, action-class-scoped, never covers protected actions, is listed with its recording time, and is revocable individually or wholesale. Page content cannot create one.
- **A new `downloads` permission widens the manifest** → Used solely to observe download creation; the store review note and privacy documentation must say so, since a permission that looks broader than its use is itself a trust cost.
- **The probe produces false positives on pages that legitimately discuss agent instructions** → Findings warn and never block, so a false positive costs a warning, not a failed task. This is the direct consequence of the warn-not-block decision and is accepted.
- **The probe produces false negatives** → It is an independent second observation, not the primary defense; the model's own instructed behavior is unchanged. A missed finding leaves the system exactly where it is today.
- **Risk categories could be mistaken for a security boundary** → No scenario lets a category refuse an action, it is excluded from the policy's inputs by design, and it is rendered in a surface with no decision controls.
- **Decision volume across modes, store, managed policy, and protected class creates combinatorial paths** → The resolution order is fixed and one-directional: each stage may only add a decision requirement. The stages are pure functions over a snapshot, matching how the existing policy modules are already written and tested.

## Migration Plan

1. Land the classifier extension and the mode resolver with the mode fixed at Auto and no user control. Behavior is provably unchanged; tests assert the resolver returns today's verdict for every registry entry.
2. Land the protected class and the `downloads` observation. Protected actions begin gating under Auto — a strict increase in what is asked, never a decrease.
3. Land the per-site store and its management surface, then expose the mode control.
4. Land the probe and the risk category as warning-only surfaces.
5. Land the managed policy channel last, once every value it can pin exists.

Rollback: steps are independently revertible in reverse order. Reverting to step 1 leaves the system at today's behavior with a mode resolver pinned to Auto.

## Open Questions

- The wording and iconography distinguishing a warning surface from a decision card. The spec fixes the semantic requirement — no decision controls on a warning — and any visual treatment satisfying it is acceptable; the concrete design can follow the panel's existing visual language after the surfaces exist.
