# Design: Refused-Answer Retry

## Context

- Every configured-model call goes through `postMemoryRequest`, which sends one `/chat/completions` request with `response_format: {type: "json_object"}`, parses the message content as one JSON object (`parseMessageObject`), and runs the caller's strict validator. On a refusal it throws a `JevError` (`INVALID_RESPONSE` / `MISSING_VALUE` / `INVALID_URL`) and the runtime acts on that refusal — for the step decision, one refusal ends the run.
- The live failure (`run_adb7f08c73bbf9b9b7`): the step decision's message content was not JSON; nothing had ever asked the model again. Gateways that ignore or only partially honor `json_object` make non-JSON answers a certainty at some rate, so the protocol's resilience must live in the host, not in the server's compliance.
- Precedent already in the codebase: a transport failure gets one repeat (safe because no side effects), a non-JSON HTTP body is named by content type and a bounded preview, and every validator stays strict.

## Goals / Non-Goals

**Goals:** one refused answer never ends a run by itself; the second attempt is grounded in the refusal itself; a benign fenced wrapper parses on the first attempt; a final refusal is diagnosable from the panel.

**Non-Goals:** loosening any validator or accepting anything short of a strictly valid answer; generic brace-hunting out of prose (the strict protocol exists to prevent acting on a wrong object); changing which outcomes exist; adding retries around transport failures (postJson owns that policy already).

## Decisions

### 1. The retry lives in `postMemoryRequest`, once, for every call

Attempts are bounded at 2. When the transport succeeds and the refusal came from the host's own parse/validator, the second request re-sends the same body with two extra messages appended: the refused answer as the assistant turn, then a user turn carrying the refusal reason and the corrective instruction ("Your previous reply was refused: <reason>. Reply with ONLY the JSON object the instruction requires — no prose, no markdown fences."). The second answer faces the identical parse and validator; if it is refused again, the original `JevError` shape is thrown with `attempts: 2` in its detail.

Rationale: one place covers the step decision, the plan, the revisions, the stall consultation, and the completion check, and the semantics stay exactly "the model gets one more look with the reason in front of it". *Alternatives rejected*: retrying at each call site (five copies of the same logic, drift guaranteed); retrying on transport failures here (that policy already exists one layer down, and there is nothing for the model to correct); a repair pass that guesses at the answer (fabrication).

### 2. A fenced block is unwrapped, then strictly parsed

`parseMessageObject` first trims the content; when it starts with a ```` ``` ```` fence, the opening fence line and the closing fence are stripped and the inner text is parsed instead. Nothing else is extracted: no first-brace-to-last-brace scanning, no prose stripping. The unwrapped text must still parse as one JSON object and still pass the caller's full validator, so the wrong-object danger the strict protocol guards against cannot return through this door.

### 3. A final refusal carries a bounded preview of the reply

The thrown message appends the model's own beginning (`reply starts: "…"`, bounded, JSON-stringified, or "the reply is empty" when the content is an empty string), and the detail carries `attempts` and the same preview fields. This mirrors "a non-JSON success body names its cause" and is what made the live diagnosis require a transcript dive instead of a glance. The preview is the model's own output shown to the operator in the local transcript; page content treated as data stays data, and this changes nothing about what may influence execution.

### 4. Terminal semantics after the second refusal (unchanged)

- `INVALID_RESPONSE` on the step decision → `error` / `invalid_decision`, nothing dispatched, no step fabricated.
- `MISSING_VALUE` on `TYPE_TEXT` → `blocked` / `missing_value`, nothing typed.
- `INVALID_URL` on `NAVIGATE` → `error` / `text_model_error`, nothing navigated.
- Memory calls (plan, revision, stall) → swallowed as today; the previous memory stays; the run continues.
- Completion check → the done outcome stands with the failure recorded and completion unverified.

## Risks / Trade-offs

- **[One extra call on the refusal path]** → refusals are rare and each is one bounded request; the alternative was a dead run.
- **[A model that repeats the identical refusal wastes the retry]** → bounded at one; the enriched message makes the repetition diagnosable.
- **[The correction turn re-sends the image on the retry]** → keeps the visual context the correction may need; the failure path is rare enough that the extra tokens are the right trade.
