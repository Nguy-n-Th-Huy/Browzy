## ADDED Requirements

### Requirement: A created document appears in the transcript as a card

When a run creates a document, the transcript SHALL show a document card in place of the raw content: a file icon, the document title, a subtitle naming its kind, its format and its size, and a download control. The card SHALL be reachable and operable by keyboard, and SHALL use the panel's existing design tokens. The card SHALL NOT offer, mention, or require any third-party storage service.

#### Scenario: The agent produces a report

- **WHEN** a run creates a markdown document titled "Phan tich dauthau asia"
- **THEN** the transcript shows a card reading that title with a subtitle naming it as a document, its format (MD) and its size and a download control, and the document's full text is not dumped inline

#### Scenario: Downloading saves the real file locally

- **WHEN** the operator activates the card's download control
- **THEN** the panel fetches the document bytes, saves them through a local blob download with the document's own filename, and makes no network request and requires no additional browser permission

### Requirement: Opening a card shows the document in two representations

Activating a document card SHALL open a detail view offering exactly two tabs, **Preview** and **Markdown**, for every supported format. Preview SHALL render the document as a document. Markdown SHALL show the markdown source for text formats, or the extracted markdown equivalent for a binary format. The detail view SHALL be dismissible by Esc and SHALL return focus to the card.

#### Scenario: A markdown document opens in both tabs

- **WHEN** the operator opens a card whose format is `md`
- **THEN** Preview shows the rendered document and Markdown shows its source text

#### Scenario: A Word, Excel, PowerPoint or PDF document opens in both tabs

- **WHEN** the operator opens a card whose format is `docx`, `xlsx`, `pptx` or `pdf`
- **THEN** Preview renders that format and Markdown shows the text, tables or slide outline extracted from it

#### Scenario: A format whose preview is an extraction says so

- **WHEN** the operator previews a `pptx` document, whose preview is a structured extraction rather than a faithful render
- **THEN** the view states that limitation instead of presenting the extraction as a full render

### Requirement: Document content is never trusted as markup

Document content originates from model output and, transitively, from page content the model may have quoted. Any HTML produced while rendering a document SHALL be displayed inside a sandboxed iframe with neither script execution nor same-origin access. Only the panel's escaping markdown renderer's output SHALL be inserted into the panel's own DOM.

#### Scenario: A document containing markup renders inert

- **WHEN** a document contains a `<script>` element or an event-handler attribute
- **THEN** neither executes, and neither reaches the panel's DOM, extension APIs, or storage

#### Scenario: A document containing a remote image does not phone home

- **WHEN** a document contains a reference to a remote resource, such as an image pointed at an external host
- **THEN** no request for it leaves the browser when the document is previewed
