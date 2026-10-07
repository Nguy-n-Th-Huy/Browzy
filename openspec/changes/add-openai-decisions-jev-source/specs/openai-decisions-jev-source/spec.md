## ADDED Requirements

### Requirement: OpenAI Decisions request translation
For a profile whose Jev source is `openai`, the decision client SHALL send exactly one `POST {base}/v1/decisions` per decision cycle with `Authorization: Bearer <transport key>`. The body is `{ model, input, questions }`, with `model` taken from the profile (default `gpt-6-luna`). Each Jev head becomes one array question `{ type: "choice", name: <head>, instructions: <head rules text plus any extra instruction context as JSON>, choices: [{ value: <criterion id>, description: <criterion text> }] }`, in head order. All offered options are included, without bracketing or dropping any. A head with exactly one option is answered locally with probability 1 and is not sent. If no heads remain, no request is made.

#### Scenario: Non-runtime heads
- **WHEN** a body's heads are not the runtime `action`/`goal_done`/`stuck` protocol (for example, a capability probe)
- **THEN** one request carries one `choice` question per head, with every option

### Requirement: Factored action question
For a runtime body (heads `action`, `goal_done`, and `stuck`, where every `action` criterion is the JSON of an offered action naming its `operation`), the `action` head SHALL NOT be sent as-is. The same single request instead carries:
- an `operation` question with one choice per operation family, each described in plain language (omitted when only one family is offered);
- one `target_<OPERATION>` question for each family that offers more than one candidate, whose choices are that family's action keys, each described by the element's role, its quoted label, and `[ref]`, plus any value, option, or URL;
- the `goal_done` and `stuck` questions.

The `action` answer SHALL be recomposed as P(key) = P(operation) × P(key | operation), where a single-candidate family or a single family contributes probability 1. The choice is the maximum of that joint, and the action confidence is the chosen key's joint probability. Every offered key is covered and the joint sums to 1, so the existing `validateDecision` applies unchanged. A gap in any asked question (answer, probabilities, or confidence) is `INVALID_RESPONSE`.

#### Scenario: Element offered for CLICK and HOVER
- **WHEN** three buttons are offered for both CLICK and HOVER, along with the reserved WAIT/REPLAN/ASK/DONE actions
- **THEN** the request asks `operation`, `target_CLICK`, `target_HOVER`, `goal_done`, and `stuck`, and a CLICK at 0.9 with the "Log in" button at 0.9 yields that action with joint probability 0.81

#### Scenario: Base URL trailing slash
- **WHEN** the base is `https://api.openai.com/`
- **THEN** the URL is `https://api.openai.com/v1/decisions`

### Requirement: OpenAI Decisions text input
When no image accompanies the decision, `input` SHALL be the JSON string of the Jev `state`.

#### Scenario: Screenshots off
- **WHEN** the screenshot toggle is off
- **THEN** `input` is a string equal to `JSON.stringify(state)`

### Requirement: OpenAI Decisions image input
When an image accompanies the decision, `input` SHALL be `[{ role: "user", content: [{ type: "input_text", text: JSON.stringify(state) }, { type: "input_image", image_url: "data:<mimeType>;base64,<data>" }] }]`. Only inline base64 data URLs are sent, never http(s) URLs or file IDs.

#### Scenario: Capture attached
- **WHEN** a capture `{ data, mimeType: "image/png" }` is supplied
- **THEN** the second content part is `input_image` with `image_url` starting with `data:image/png;base64,`

### Requirement: OpenAI Decisions response mapping and validation
The client SHALL map `answers[]` to Jev answers by `name`: `choice` → `choice`, `probabilities[{value, probability}]` → a `{value: probability}` object, and `confidence` → `confidence`. The mapped answers go through the existing `validateDecision`. The answer is `INVALID_RESPONSE` and no action executes when any of these hold: `answers` is not an array; an asked head is missing; the probabilities do not cover every offered value; a probability is not a number; `confidence` is not a number. Usage is read from `json.usage` when present, and otherwise defaults to `{}`.

#### Scenario: Missing confidence
- **WHEN** the `action` answer has no numeric `confidence`
- **THEN** the call throws `JevError` code `INVALID_RESPONSE` and no confidence is derived

#### Scenario: Valid answer
- **WHEN** every head is answered with full probabilities and confidence
- **THEN** the result is `{ decision, usage, latencyMs }` in the same shape as other sources

### Requirement: OpenAI Decisions transport errors
The `openai` source SHALL use the shared `postJson` retry and error taxonomy: 401/403 → `AUTH_ERROR`; 429 → `RATE_LIMIT_ERROR` after retries; 5xx/529 → `MODEL_UNAVAILABLE_ERROR`; other non-2xx → `INVALID_RESPONSE`. The provider's message is included in the error when it is available.

#### Scenario: Unauthorized
- **WHEN** the API returns 401
- **THEN** the call throws `AUTH_ERROR` without retrying

### Requirement: OpenAI Decisions capability probe
The capability test for the `openai` source SHALL run a text-input decision probe and then an image-input decision probe that uses a small embedded PNG. The source is capable only if both succeed. If the image probe fails, the result reports the image stage.

#### Scenario: Image probe rejected
- **WHEN** the text probe succeeds and the image probe returns 400
- **THEN** the capability result fails, names the image stage, and includes the classified error code
