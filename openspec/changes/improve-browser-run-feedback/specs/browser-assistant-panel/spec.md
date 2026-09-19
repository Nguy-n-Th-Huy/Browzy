## ADDED Requirements

### Requirement: Safe usable browser reports

The panel SHALL render safe HTTP(S) bare URLs as clickable links, preserve ordered numbering across multiline and loose items, and constrain tables within panel width. Raw HTML and fenced code SHALL remain inert.

#### Scenario: Multiline results

- **WHEN** three numbered results contain blank lines and observed links
- **THEN** numbering remains correct and links preserve their exact destination and query

#### Scenario: Hostile markup

- **WHEN** a report contains script markup, unsafe schemes or fenced URLs
- **THEN** unsafe content remains inert and fences remain code

### Requirement: Task-first reports with secondary details

Requested results and material incompleteness SHALL remain visible first. Clearly designated secondary details MAY be collapsed in keyboard-accessible disclosures. Historical freeform reports SHALL remain readable.

#### Scenario: Notice extraction

- **WHEN** the user asks for three names, codes and links
- **THEN** those fields and per-result links precede optional diagnostics and suggestions

#### Scenario: Incomplete result

- **WHEN** requested data is unavailable or the run stopped
- **THEN** that limitation is visible without expanding secondary details

### Requirement: Truthful browser run feedback

The panel SHALL show host-reported work phases, distinguish dispatched browser operations from planning/read/check activity, and associate before/after evidence with the correct executed step. Thumbnails SHALL open exact historical captures; unavailable captures SHALL be disclosed. Terminal, permission and stopping states SHALL override stale phases.

#### Scenario: Two operations and verification

- **WHEN** a run plans, types, clicks and verifies
- **THEN** it shows two browser operations and distinguishes planning and verification

#### Scenario: Capture disabled

- **WHEN** screenshot capture is disabled
- **THEN** text evidence and honest unavailability appear without enabling capture

#### Scenario: Reconnected history

- **WHEN** a restored run opens a thumbnail
- **THEN** the historical image and step association appear without recapture or duplicate operation counts
