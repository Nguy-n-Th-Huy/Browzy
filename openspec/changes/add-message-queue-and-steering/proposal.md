## Why

A run occupies its conversation. While it streams, the operator's next thought has nowhere to go: the host enforces one active run per conversation (`startRun()` refuses a second — `host/agent/session/manager.js`), so the choice is waiting or stopping a run that may be one turn from finishing. The support machinery for a queue already exists one layer up — conversations queue behind the shared browser lease (`Run` starts `QUEUED`, `run_queued`/`run_started` events, the panel's `Đang chờ lượt` state), restart recovery and pending-decision restore are established patterns, and send idempotency keys exist — but nothing accepts, tracks, or renders a message submitted during a run. Every alternative available today (an errored send, a disabled composer) throws away typed work at the moment losing it is most expensive.

## What Changes

- A message submitted while the conversation's run is active is accepted into a **bounded, durable per-conversation queue** and runs as a subsequent turn, in submission order.
- Sending gains two modes. **Queue** (default) files the message behind the active run. **Run now** (interrupt) attempts to cancel the active run through the existing stop path so the message runs immediately; interrupt is best-effort — when the cancellation cannot be delivered, the message remains queued and the panel says so. Interrupt with no active run behaves as an ordinary send (borrowed from browser-use V4's session queue, whose documented rules this change keeps: bounded queue, explicit refusal when full, cancel only before a claim).
- Each queued message has an observable lifecycle: `pending → dispatching → consumed`, with `cancelled` and `failed` as terminal outcomes. Cancel is offered while a message is pending; once the next turn has claimed it, the request is refused with the claimed state disclosed, and the run's Stop remains the control.
- The queue is durable and restorable: a claim and its turn are a single commit, so no message can be owned by two turns or silently lost; panel reload and companion restart restore pending messages exactly; a message owned by a run interrupted by restart follows the existing interrupted-run handling and is never automatically replayed (the no-automatic-replay rule is untouched).
- Stop pauses the drain: pending messages remain pending and individually cancellable, and the drain resumes on an explicit resume action or on any new submission. Interrupt does not clear other pending messages: the interrupted message runs as the immediate next turn, and earlier pending messages keep their order after it.
- Queue state is rendered truthfully in the panel using the existing Vietnamese state vocabulary; each queued message's page context is bound at submission time and never re-resolved when its turn starts.
- Queued messages pass the same approval, scope, and untrusted-content gates as any run. Queueing never answers, bypasses, or races a pending decision. Interrupt invalidates pending decisions exactly as Stop does today.

No change to lease-level queueing between conversations, to Stop's meaning for an active run, or to any tool. No scheduling, no cron, no run-internal steering of tool sequences.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `agent-browser-runtime`: new requirements fix the queued-message lifecycle and claim boundary, interrupt-to-run-now semantics, operator-controlled drain, queue durability and restore, and the queue's relation to pending decisions. Existing requirements — one active run per conversation, honest cancellation, no automatic replay after dispatch — are preserved and extended, not weakened.
- `browser-assistant-panel`: new requirements keep the composer usable during a run, render queue states truthfully with per-message cancel and resume, and preserve each queued message's submission-time page-context identity.

## Impact

- `host/agent/session/manager.js` — queue ownership, admission of a message while a run is active, claim/drain integration with the run lifecycle, stop and conversation-delete interactions.
- `host/agent/session/run.js` — claim-at-start; interrupt reuses `stop()`; no new stop semantics.
- `host/agent/companion.js` — send acceptance while active, interrupt handling, idempotency-key extension to queued sends.
- `host/agent/protocol.js` — send-mode field plus queue-transition events (queued / claimed / cancelled / failed) in the existing sequenced-event family.
- New `host/agent/session/message-queue.js` — durable store with the atomic write-then-rename convention used by `transcript-store.js` and `workflows-store.js`.
- `extension/sidepanel/panel-controller.js`, `sidepanel.js`, `conversation-model.js`, `run-states.js` — composer availability, per-message state chips and cancel, resume control, restore rendering.
- Tests: `host/test/*.test.mjs` (lifecycle, claim race, interrupt fallback, restore, dedupe) plus extension-side coverage where existing patterns apply.
- `README.md` side-panel status section — updated when the behavior ships, not before.
