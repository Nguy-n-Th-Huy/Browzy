## Purpose

Persist what a page showed at a point in time — the fields a run read, plus the page's identity — as a timestamped JSON snapshot an operator can list, retrieve, and later compare against a fresh capture.

## ADDED Requirements

### Requirement: Snapshot capture action

The runtime SHALL expose a snapshot capability to runs (`page_snapshots`) whose `save` action records one snapshot: the page's URL and title, the capture timestamp, the extracted `fields` the caller supplies (a plain JSON object; the tool never reads the page itself), and capture metadata (viewport when supplied, the run and conversation it came from). The snapshot SHALL be written as one JSON file under the companion's own user-data tree at `<agent root>/snapshots/<url-hash>/<name>-<timestamp>.json`, where `<url-hash>` is a stable hash of the page URL (scheme, host, path, sorted query parameters) and `<name>` is a filesystem-safe slug derived host-side from the caller's snapshot name — never a path segment taken from the caller. The action SHALL return the saved record's identifier, path, and timestamp. Guards SHALL reject (never truncate) an oversize `fields` payload, an empty or unparseable name, a missing URL, and any storage failure (permission denied, disk full), naming the reason in the error. The action SHALL NOT mutate the page or browser state, and SHALL be classified read-only for tab-scope purposes.

#### Scenario: Save a snapshot with extracted fields

- **WHEN** a run calls `page_snapshots` with action `save`, a name, the current page's URL and title, and the fields it read
- **THEN** one JSON snapshot is written under the URL's directory, and the result returns its identifier, path, and capture timestamp

#### Scenario: Several snapshots for one URL

- **WHEN** the same URL is captured more than once, with the same or different names
- **THEN** each capture is a separate file under that URL's directory, distinguishable by name and timestamp, and no earlier snapshot is overwritten

#### Scenario: Hostile or unusable name

- **WHEN** the supplied name is empty, contains path separators or traversal sequences, or exceeds its bound
- **THEN** no file is written and the error names the rejected name

#### Scenario: Storage failure

- **WHEN** the snapshot directory cannot be created or the file cannot be written
- **THEN** the action fails with the storage reason named, and no partial snapshot is left behind

### Requirement: Snapshot record shape

A stored snapshot SHALL be a single JSON object carrying at least: `url`, `title`, `name`, `timestamp` (ISO 8601 UTC), `fields` (the caller-supplied data, preserved as JSON), and `metadata` (capture context such as the run id, conversation id, and viewport when known). The record's own shape SHALL be stable and documented, so a snapshot written by one version can be read and compared by a later one; readers SHALL tolerate unknown extra top-level keys and SHALL NOT treat a missing optional metadata field as corruption.

#### Scenario: Round-trip

- **WHEN** a snapshot is saved and then retrieved
- **THEN** the retrieved record carries the same `url`, `title`, `name`, `timestamp`, and `fields` that were saved

#### Scenario: Unknown keys are tolerated

- **WHEN** a record carries extra top-level keys a reader does not know
- **THEN** the record still loads and compares, and the extra keys are ignored rather than treated as an error

### Requirement: Snapshot listing action

The runtime SHALL provide a `list` action that returns every stored snapshot, newest first, each entry carrying at least its name, URL, timestamp, file path, and size. The listing SHALL accept an optional URL filter and an optional name pattern (substring or glob). A snapshot file that is missing or unreadable SHALL appear in the listing marked invalid with its reason, never omitted silently and never causing the whole listing to fail. An absent snapshots directory SHALL list as empty, not as an error.

#### Scenario: List everything

- **WHEN** the listing action runs with no filter
- **THEN** every stored snapshot is returned, newest first, with name, URL, timestamp, path, and size

#### Scenario: Filter by URL and name

- **WHEN** the listing action runs with a URL and/or a name pattern
- **THEN** only matching snapshots are returned, and the applied filter is stated in the result

#### Scenario: Corrupted snapshot file

- **WHEN** a snapshot file cannot be parsed
- **THEN** its entry is returned marked invalid with the reason, and the remaining entries are unaffected

### Requirement: Snapshot retrieval and deletion actions

The runtime SHALL provide a `get` action that loads one snapshot by name + URL or by absolute path and returns its full record, and a `delete` action that removes one snapshot file and prunes the URL directory once it is empty. Both SHALL fail with a named reason when the snapshot does not exist, cannot be read, contains invalid JSON, or cannot be deleted; neither SHALL touch any file other than the named snapshot.

#### Scenario: Retrieve a snapshot

- **WHEN** `get` runs with a name and URL, or with an absolute path
- **THEN** the matching record is returned in full

#### Scenario: Retrieve a missing or corrupted snapshot

- **WHEN** the named snapshot does not exist or its JSON cannot be parsed
- **THEN** the action fails with a reason naming which of the two it was, and the requested identifier

#### Scenario: Delete prunes an emptied directory

- **WHEN** the last snapshot under a URL's directory is deleted
- **THEN** the file is gone and the now-empty directory is removed, with confirmation returned
