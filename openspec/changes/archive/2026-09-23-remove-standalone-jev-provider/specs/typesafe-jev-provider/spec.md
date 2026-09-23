## MODIFIED Requirements

### Requirement: Credential and configuration storage for the TypeSafe provider

The Jev transport API key used by the Jev browser tools (`browser_subgoal`, `extract_page`) on `anthropic` and `chatgpt` profiles SHALL be stored by the native companion in the OS credential store as one secret record under a per-profile target (`browzy-in-chrome/typesafe/<profileId>`), separate from the `anthropic` credential target and the `chatgpt` refresh-token target. The key SHALL never appear in extension storage, page scripts, profile files, logs, exported settings, or the SDK environment. The settings UI SHALL accept the key write-only, SHALL clear submitted raw values, and SHALL report only whether the key is saved. A secret that does not fit the OS credential store's size limit SHALL fail with the existing `SECRET_TOO_LARGE` outcome and SHALL NOT be truncated. Removing the credential SHALL bump the credential revision, cancel active runs using it, and require re-entry before another Jev transport request. A legacy text-model API key stored in the same record by an earlier version MAY remain stored, SHALL be kept when the record is migrated or rewritten, and SHALL never be read or sent anywhere.

#### Scenario: Keys never leave the companion

- **WHEN** settings are exported, diagnostics are viewed, or a run's environment is constructed
- **THEN** neither the Jev transport key nor any legacy text-model API key appears in the output

#### Scenario: Credential removal during a run

- **WHEN** the stored Jev transport key is removed while an `anthropic`/`chatgpt` run using the Jev browser tools is active
- **THEN** the run is stopped through the existing revocation path, and a later run offers the Jev browser tools only after the key is saved again

## REMOVED Requirements

### Requirement: Provider type and configuration surface

**Reason**: The standalone `typesafe` ("Jev — ultrafast") provider type is removed. The same Jev engine is reached through the Jev browser tools on `anthropic` and `chatgpt` profiles, so the second provider, its settings block and its seed model list are no longer offered.

**Migration**: A stored profile with provider type `typesafe` (including named profiles) loads as `anthropic` and is written back once: the endpoint becomes the default Anthropic Base URL, a `jev-latest` seed model list is cleared, the capability-test result is cleared, and the saved Jev transport key is kept. Operators reach Jev through the `extract_page` and `browser_subgoal` tools by saving a Jev transport key in the "Jev browser tools" section.

### Requirement: TypeSafe capability test

**Reason**: The standalone `typesafe` provider type and its run path are removed, so there is no standalone profile to test.

**Migration**: Use the Jev-tools connection test on an `anthropic`/`chatgpt` profile, which validates the primary provider's model and the saved Jev transport. Stored `typesafe` profiles migrate to `anthropic` with their capability-test result cleared.

### Requirement: Coexistence with the existing runtimes

**Reason**: With the standalone `typesafe` run path removed, there is no second runtime to coexist with; Jev runs only as the `extract_page`/`browser_subgoal` tools inside `anthropic` and `chatgpt` runs, whose gating and lease rules are defined by the `jev-browser-subgoal` and `jev-extract-page` capabilities.

**Migration**: Stored `typesafe` profiles migrate to `anthropic`, and Jev is reachable through `extract_page`/`browser_subgoal` when the profile's Jev transport key is saved.
