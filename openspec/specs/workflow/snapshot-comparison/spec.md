## Purpose

Compare two saved page snapshots — a baseline and a fresh capture — and report exactly what changed in the fields, both as JSON for automation and as a readable markdown report the operator can keep or download.

## ADDED Requirements

### Requirement: Snapshot comparison action

The runtime SHALL provide a `compare` action on the snapshot capability that loads two snapshots (baseline and current, each named by name + URL or by absolute path), computes a field-level diff of their `fields` objects, and returns a comparison report in both JSON and markdown in the same call. Page identity and capture timestamps of both sides SHALL appear in the report; the diff SHALL classify every difference as added (present in current only), removed (baseline only), or changed (present in both with different values, reported with the old and the new value). The action SHALL fail with a named reason identifying which side (baseline or current) could not be loaded or parsed when either cannot be read.

#### Scenario: Differences detected

- **WHEN** `compare` runs with a baseline and a current snapshot whose fields differ
- **THEN** the report lists the added fields with their values, the removed fields with their last known values, and the changed fields with both values, in JSON and in markdown

#### Scenario: No differences

- **WHEN** both snapshots carry identical field data
- **THEN** the report states that no changes were detected and every diff list is empty — never an error, never a fabricated change

#### Scenario: One side unavailable

- **WHEN** the baseline (or the current) snapshot is missing, unreadable, or invalid JSON
- **THEN** the action fails naming which side failed and with which reason, and no partial report is presented as a comparison

### Requirement: Nested field comparison

The diff SHALL recurse into nested objects and arrays and SHALL report each difference with its full path (for example `user.profile.email`, `items[2].name`). For arrays it SHALL report items added and items removed; when the same items appear in a different order it SHALL report the reordering rather than treating every position as changed. A field whose JSON type changes between the two captures (scalar to object, string to number, and so on) SHALL be reported as changed with both values and the type change named.

#### Scenario: Nested object change

- **WHEN** a nested field differs between the snapshots
- **THEN** exactly that path is reported as changed, with the old and new values, and no unrelated sibling is reported

#### Scenario: Array additions and removals

- **WHEN** the current snapshot's array carries items the baseline did not, or misses items it had
- **THEN** those items are reported as added or removed with their values, and unchanged items are not reported

#### Scenario: Reordered array

- **WHEN** an array holds the same items in a different order
- **THEN** the report names the reordering (with the affected items) instead of reporting each item as changed

#### Scenario: Type change

- **WHEN** a field's JSON type differs between the captures
- **THEN** it is reported as changed with both values and the type change named

### Requirement: Comparison report forms

The comparison report SHALL be produced in two forms in one call: a JSON document carrying both snapshots' identity (URL, title, name, timestamp), a summary count of added/removed/changed fields, and the full diff lists (path, old value, new value); and a markdown document carrying the same content in readable sections (snapshot identities, the summary, then Added / Removed / Changed sections with paths and values). When the caller asks for it, the markdown report SHALL also be written as a document through the existing document path (`create_document`'s store) so it appears in the conversation as a downloadable card — the snapshot feature SHALL NOT introduce a second report-writing pipeline.

#### Scenario: JSON report shape

- **WHEN** a comparison returns
- **THEN** its JSON form carries both sides' identity, the summary counts, and the three diff lists with paths and values

#### Scenario: Markdown report is readable

- **WHEN** the markdown form is produced
- **THEN** it opens with both snapshots' identity and timestamps, states the change counts, and presents Added / Removed / Changed sections with field paths and values

#### Scenario: Report saved as a document

- **WHEN** the caller requests the report be written to the conversation
- **THEN** the markdown report is written through the existing document path and the result names the created document, while the JSON and markdown forms are still returned inline

### Requirement: Revisit-and-compare pattern

The capability SHALL support the monitoring pattern end to end without any scheduler of its own: a run saves a snapshot as its baseline, and a later run on the same URL saves a fresh snapshot and calls `compare` against the baseline. The comparison result SHALL be the same whether the two captures came from one run or two runs, and the result SHALL carry what the caller needs to act on the change (the changed paths and values), while what to do about a change — notify, stop, capture again — SHALL remain the caller's decision, not the capability's.

#### Scenario: Baseline then revisit

- **WHEN** a first run saves a baseline snapshot for a URL, and a later run on the same URL saves a new snapshot and compares it to the baseline
- **THEN** the comparison returns the diff between the two captures identically to a comparison of any two stored snapshots

#### Scenario: Nothing changed on revisit

- **WHEN** the revisit produces identical field data
- **THEN** the comparison reports no changes, and the capability makes no claim beyond that

#### Scenario: The capability does not act on its own

- **WHEN** a comparison finds changes
- **THEN** the capability only reports them — it sends nothing, schedules nothing, and rewrites no snapshot
