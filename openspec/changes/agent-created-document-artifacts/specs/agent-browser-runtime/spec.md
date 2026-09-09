## ADDED Requirements

### Requirement: A run can hand the operator a named document without filesystem write authority

A run SHALL be able to produce a document for the operator through one application-owned SDK tool, `create_document`, registered the same way `ask_user` is. The built-in high-risk tools `Bash`, `Write`, `Edit` and `NotebookEdit` SHALL remain disallowed; this capability SHALL NOT widen that allowlist. The model SHALL never supply a path or a document id: the host derives the filename from the supplied title and mints the id itself, and every write SHALL land inside the calling conversation's own workspace `documents/` directory.

#### Scenario: The model asks for a report and gets a document back

- **WHEN** a run calls `create_document` with a title, a format, and markdown content
- **THEN** the host writes the file into that conversation's `documents/` directory, emits a `document_created` stream event carrying id, title, filename, format, mime type and byte length, and returns an ordinary tool result to the model

#### Scenario: A model-supplied path cannot escape the conversation workspace

- **WHEN** the title contains path separators, `..`, or an absolute path prefix
- **THEN** the host normalizes it to a bounded slug, and no file is written outside that conversation's `documents/` directory

#### Scenario: Oversized or excessive content is rejected, not truncated

- **WHEN** content exceeds the source limit, the generated file exceeds the output limit, or the conversation already holds the maximum number of documents
- **THEN** the call fails with an explicit reason and no file is written

### Requirement: Document bytes are fetched on demand, never carried on the stream

The `document_created` stream event SHALL carry metadata only. Document bytes SHALL be transferred host→panel only in response to an explicit `document_fetch` for a known document id belonging to the requesting conversation, and SHALL use the existing chunked-transport wire shape. The receiving side SHALL validate the chunk sequence — matching chunk id, ordered indices, declared total byte count, and expiry — and SHALL reject a stale, duplicated, out-of-order or truncated sequence rather than yielding a partial buffer.

#### Scenario: Reconnect replay does not re-send document bytes

- **WHEN** the panel reconnects and replays the run's stream events
- **THEN** the document card is rebuilt from metadata alone and no document bytes cross the wire until the operator opens or downloads the card

#### Scenario: A truncated chunk sequence is refused

- **WHEN** the connection drops after some chunks of a document have arrived
- **THEN** the reassembler rejects the incomplete sequence and the panel reports the fetch as failed, never presenting a partial file as the document

### Requirement: Documents live for the life of their conversation

A document SHALL remain readable for as long as its conversation exists, including across panel reloads and browser restarts, and SHALL be deleted with its conversation.

#### Scenario: A card survives a panel reload

- **WHEN** the operator reloads the side panel after a document was created
- **THEN** the card is still present in the transcript and both opening and downloading it still work

#### Scenario: A document whose file is gone degrades honestly

- **WHEN** a card's underlying file can no longer be read
- **THEN** the card renders as unavailable with a stated reason, and neither opening nor downloading throws
