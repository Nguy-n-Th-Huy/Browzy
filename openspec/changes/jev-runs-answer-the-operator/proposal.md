# Proposal: a Jev run owes the operator an answer

## Why

Ask the assistant to find something on a `chatgpt` or `anthropic` profile and it does two things: it operates the page, and it tells you what it found. Ask the same on a `typesafe` profile and you usually get only the first half — a column of step rows and a one-word outcome.

That is not an accident of prompting. It is where the code puts the only sentence a run can write:

```js
if (check.achieved === true) {
  …
  if (check.report) run.emit({ type: "jev_result", text: check.report, … });
```

`jev_result` is the event the side panel turns into the turn's answer text (`conversation-model.js:1305`). It is emitted from exactly one place — inside the branch where the completion check **confirmed** the goal (`runtime.js:901-909`). Every other ending writes nothing:

| How the run ended | What the operator gets |
|---|---|
| `DONE`, check confirmed | the report |
| `DONE`, check unreachable | outcome only, marked unverified |
| `blocked` — no progress, a spent bound, a denied approval, an unresolved target, a login wall | **nothing** |
| `stopped` by the operator | **nothing** |
| `error` | **nothing** |

So everything the run read on the way — the page text it observed, the notes it wrote into its own memory, the steps it executed — is discarded the moment it fails to reach a confirmed `DONE`. A run that opened three pages and hit a login wall reports `blocked: no_progress`, and the operator has to reconstruct from the step rows what it saw.

Two smaller gaps compound it:

- **A run cannot see the conversation it is part of.** The goal is the current prompt and nothing else (`companion.js:4177`: `goal: prompt`). A follow-up — "mở cái thứ hai", "thế còn chuyến bay sáng mai?" — starts with no idea what the previous turn did or found, even though the transcript is right there (`TranscriptStore.allEvents`).
- **The one report call is doing two jobs.** The completion check decides *whether the goal is met* and writes *what to tell the operator* in the same answer, so the second is only ever produced when the first says yes. They are different questions and only one of them is conditional.

## What Changes

- **Every run ends with an answer.** After the loop reaches its terminal outcome — done (verified or not), blocked for any reason, stopped by the operator, or failed — the run makes one bounded **final report** call over the goal, the run memory, the recent steps, and the last observation, and emits it as `jev_result`. The answer states what was accomplished, what was not, and why, naming the material it actually saw; it never claims an outcome the run did not reach. A run that executed nothing and observed nothing (no first observation) writes nothing, because there is nothing to report.
- **The report is separated from the verdict.** The completion check keeps its one job — deciding whether a `DONE` claim is true — and stops being the only path to prose. A confirmed `DONE` still answers from that same view of the page (no second call for the common case); every other ending gets the final report call instead.
- **The report's failure is advisory.** If the call cannot be made, the outcome stands exactly as it is, the failure is disclosed on the terminal record, and nothing is invented.
- **A run sees its conversation.** The run's context gains a bounded projection of the conversation's earlier turns — the operator's previous prompts and the previous runs' answers and outcomes — so a follow-up resolves against what already happened. Bounded, text only: no capture, no credential, and page content stays untrusted data that cannot steer the loop.
- **A question that needs no action is answered without touching the page.** When the first observation already satisfies an informational goal, the run may end on `DONE` with its report and dispatch nothing.
- **When it needs the operator, it says what it needs.** A `BLOCKED` decision made because only the operator can resolve the situation — a login, a choice between candidates, a missing value — records a reason that says so, and the final report states the question in the operator's own terms instead of a bare status.

## What "like the Claude/ChatGPT branch" can and cannot mean

Equal after this change: every turn ends with an answer in the transcript; the answer is honest about failure; a follow-up understands the turn before it; an informational question is answered without pointless clicking; the run asks the operator when only the operator can decide.

Not equal, and not attempted here — stated so it is not re-litigated:

- **No token streaming.** The SDK path streams an assistant turn as the model writes it. Jev's decision model answers one strict JSON object per cycle; the answer arrives when the run ends. The per-step evaluation (already shipped) is what narrates progress meanwhile.
- **No free-form narration mid-run.** Every answer in this loop is a validated object, by design — that is what keeps page content from steering it.
- **Not the SDK tool surface.** The loop has ten operations. `read_page`, `find`, `search`, documents, skills, workflows and MCP servers belong to the SDK engine and stay there.
- **No session resume, compaction, or subagents.** A Jev run is bounded and self-contained; this change gives it the conversation's text, not the SDK's session.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `typesafe-jev-provider`: the run's terminal record gains a final report on every outcome; the completion check narrows to its verdict; the run's context gains the conversation's earlier turns; a `BLOCKED` decision can name what it needs from the operator.
- `browser-assistant-panel`: a finished Jev run is expected to carry answer text whatever its outcome, and the absence of it is itself disclosed rather than normal.

## Impact

- `host/agent/jev/text-helper.js` — a `FINAL_REPORT` instruction and its strictly validated `{report}` answer; the conversation projection in the context of the decision-class calls.
- `host/agent/jev/runtime.js` — one report call on every terminal path, ordered after the outcome is decided and before `jev_end`; the confirmed-`DONE` path keeps its existing report; the `needs_operator` blocked reason.
- `host/agent/companion.js` — the bounded conversation projection read from the transcript store and passed on the provider object.
- `host/agent/protocol.js` — the terminal record's report-failure field and the new blocked reason.
- `extension/sidepanel/conversation-model.js`, `tool-labels.js` — the answer text on every terminal outcome, and the label for the new reason.
- Cost: one additional bounded completion per run that does not end on a confirmed `DONE`, on the operator's own configured decision model.
