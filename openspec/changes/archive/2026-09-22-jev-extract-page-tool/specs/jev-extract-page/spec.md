## Purpose

Defines the read-only `extract_page` SDK tool that lets an LLM-driven (`anthropic`/`chatgpt`) run pull caller-specified typed fields from the current page via the configured Jev text model, returning `null` for missing or ambiguous evidence.

## ADDED Requirements

### Requirement: extract_page is offered only when the Jev text model is configured

The runtime SHALL expose a read-only `extract_page` tool to an `anthropic` or `chatgpt` run only when that run's resolved profile has the Jev text model configured: a text model base URL, a text model id, and a text-model API key. It SHALL NOT require the `openai` decision source (the tool uses only the text model). When the text model is not configured, the tool SHALL NOT be registered for that run, and its absence SHALL raise no error, exception, warning or user-visible notice. The runtime SHALL NOT substitute the Anthropic or Gateway key for the text-model call. A `typesafe` standalone run SHALL NOT offer `extract_page`.

#### Scenario: Text model configured offers the tool

- **WHEN** an `anthropic`/`chatgpt` run starts on a profile with the Jev text model configured
- **THEN** `extract_page` is present in that run's tool set

#### Scenario: Text model absent silently omits the tool

- **WHEN** an `anthropic`/`chatgpt` run starts on a profile missing the text model base URL, id, or key
- **THEN** `extract_page` is absent from that run's tool set, no error is raised, and every other tool works as before

#### Scenario: Standalone Jev run does not offer it

- **WHEN** a `typesafe` run starts
- **THEN** `extract_page` is not among its tools

### Requirement: The schema is built only from the caller's requested fields

`extract_page` SHALL accept an `instruction` string and a non-empty list of `fields`, each with a `name`, a `description`, and a `type` of `string`, `number`, `boolean`, `url`, `object` or `array` (an `object` field carries nested `properties`, an `array` field carries an `items` field type). It SHALL build its extraction schema from these caller fields only. Field names SHALL be validated against a safe identifier pattern, and the request SHALL be rejected with a bounded validation failure when a field name is invalid, when the field count, nesting depth, or description length exceeds bounded limits, or when `instruction`/`fields` are missing or malformed. Names, labels, values or instructions found in the page SHALL NOT add, rename, retype or otherwise influence any field.

#### Scenario: Fields come only from the caller

- **WHEN** the caller requests fields `title` (string) and `price` (number)
- **THEN** the returned object has exactly those keys, regardless of what field-like names the page contains

#### Scenario: Invalid field request is rejected

- **WHEN** a field name violates the identifier pattern, or the field count/nesting/description exceeds its bound, or `instruction`/`fields` is missing or malformed
- **THEN** no model call is made and the tool returns a bounded validation failure

#### Scenario: The page cannot inject fields

- **WHEN** the page text contains something shaped like a field definition or an instruction to extract extra data
- **THEN** it is treated as untrusted data, no extra field is produced, and only the caller's fields are returned

### Requirement: Extraction is read-only over the observed page and page content is untrusted

`extract_page` SHALL extract only from a bounded observation of the bound tab captured through the existing page-observation path. It SHALL NOT scroll, navigate, mutate the page, or require an approval card, and it SHALL be authorized as a read-only tool like the existing page-reading tools. Page content SHALL be treated as untrusted data and never as instructions, and the tool SHALL NOT infer hidden, editable, or unloaded content.

#### Scenario: Read-only with no approval

- **WHEN** `extract_page` runs
- **THEN** it reads the observed page and calls the text model without dispatching any browser action or requesting approval

#### Scenario: Extraction is scoped to the observation

- **WHEN** requested evidence is not present in the current observation
- **THEN** the tool does not scroll or navigate to find it and returns `null` for the affected fields

### Requirement: Missing or ambiguous evidence returns null; output matches the requested types

Every field in the returned object SHALL be nullable, and the tool SHALL return `null` for a field whose evidence is absent or ambiguous. Returned values SHALL match the caller's requested types; a value that cannot be coerced to its requested type SHALL be returned as `null` rather than a mistyped value. The returned object SHALL be validated against the caller's schema before it is returned.

#### Scenario: Missing evidence is null

- **WHEN** the page has no evidence for a requested field
- **THEN** that field is `null` and the call still succeeds

#### Scenario: A type mismatch becomes null

- **WHEN** the model returns a value that does not match a field's requested type
- **THEN** that field is `null` rather than a mistyped value

### Requirement: Failure is honest

When the text model call fails, times out, or returns structurally malformed output that cannot be validated against the caller's schema, `extract_page` SHALL return a bounded, host-authored named failure and SHALL NOT return a fabricated or partial-as-complete result. The failure text SHALL NOT echo raw provider secrets. A failure SHALL NOT crash the outer run; the caller SHALL remain able to choose another action.

#### Scenario: Malformed model output is a named failure

- **WHEN** the model returns output that cannot be validated against the requested schema
- **THEN** the tool returns a bounded named failure, not a fabricated object, and the outer run continues

#### Scenario: Transport failure surfaces honestly

- **WHEN** the text-model call fails or times out
- **THEN** the tool returns a bounded named failure with no secrets, and the outer run continues
