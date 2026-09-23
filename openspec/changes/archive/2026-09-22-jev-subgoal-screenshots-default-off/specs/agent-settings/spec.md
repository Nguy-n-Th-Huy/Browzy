## ADDED Requirements

### Requirement: Jev browser-tools screenshot capture defaults off with an opt-in toggle

A `browser_subgoal` sub-run started from an `anthropic`/`chatgpt` profile SHALL NOT capture a screenshot for its planning/content model by default. This SHALL be controlled by a dedicated Jev-tools screenshot toggle that is off by default and is independent of the profile's primary/`typesafe` screenshot setting. The "Jev browser tools" settings section SHALL expose this toggle (unchecked by default), persisted through the existing configuration envelope. Enabling it SHALL re-enable screenshot capture for the sub-run's planning consultation; disabling or leaving it unset SHALL keep the sub-run text-only. Jev's action selection SHALL be unchanged in either state (it never receives the screenshot), and the read-only `extract_page` tool SHALL be unaffected. The standalone `typesafe` profile's own screenshot toggle SHALL be unchanged.

#### Scenario: A new profile runs subgoals without screenshots

- **WHEN** an `anthropic`/`chatgpt` profile has the Jev browser tools configured and the Jev-tools screenshot toggle unset
- **THEN** a `browser_subgoal` sub-run captures no screenshot, and Jev still selects actions from the structured page state

#### Scenario: The toggle re-enables screenshots

- **WHEN** the user checks the Jev-tools "Gửi ảnh chụp màn hình" toggle and saves
- **THEN** the value persists through the existing envelope and a subsequent `browser_subgoal` sub-run captures a screenshot for its planning consultation

#### Scenario: The toggle is separate from the primary/typesafe setting

- **WHEN** the Jev-tools screenshot toggle is changed on an `anthropic`/`chatgpt` profile
- **THEN** the profile's primary configuration and the standalone `typesafe` screenshot setting are unchanged

#### Scenario: extract_page is unaffected

- **WHEN** the Jev-tools screenshot toggle is off
- **THEN** `extract_page` still functions (it captures no screenshot regardless of this toggle)
