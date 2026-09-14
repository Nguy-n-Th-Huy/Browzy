## ADDED Requirements

### Requirement: Interactive steps use replayable targets
A workflow definition derived from a run SHALL aim its interactive steps (clicks, form entries) at the target element's stable identity — its role and accessible name as the run recorded them — rather than at a snapshot reference (`ref_N`), which is meaningful only inside the document that minted it. The identity SHALL be taken only from identities the run itself recorded; a reference with no recorded identity SHALL be preserved as recorded, never guessed at, and SHALL NOT block the draft. A run's tool results SHALL be read only for element-identity evidence — a search result's reference line, or a click result's description of the element that received that click — and a label that looks credential-bearing SHALL NOT be frozen into a definition.

#### Scenario: A later run re-resolves the recorded target
- **WHEN** a stored workflow containing an interactive step executes in a new session, where the document that minted the step's original reference no longer exists
- **THEN** the step re-resolves its recorded identity against the live page and acts on the element that matches it (role preferred, name compared after whitespace normalization)

#### Scenario: The target genuinely changed on the site
- **WHEN** the recorded identity no longer matches any element on the live page
- **THEN** the run ends with a drift outcome naming the step and the identity it aimed at — never a click at a guessed location, and never a bare success

#### Scenario: No identity was recorded for a reference
- **WHEN** a recorded step carries a reference whose identity never appeared in the run's recorded results
- **THEN** the step is stored exactly as recorded — no identity is invented for it, and its replay fails honestly (as drift) rather than clicking a guess

### Requirement: A replay begins on the page the run began on
A workflow derived from a run SHALL begin its steps by returning to the page the run started on when the run's own trail recorded that page — the URL its own first tab listing named — and the trail does not already navigate. That starting URL SHALL be part of the definition's recorded evidence, its host SHALL be part of the definition's domain binding, and no starting page SHALL be invented for a run whose trail records none.

#### Scenario: Running from a different page state
- **WHEN** a stored workflow derived from a run that began on page A is executed while the browser sits elsewhere on the same site (for example, on the previous run's results page)
- **THEN** the execution navigates to page A first and then proceeds with the recorded steps, instead of mis-aiming them at whatever is currently on screen
