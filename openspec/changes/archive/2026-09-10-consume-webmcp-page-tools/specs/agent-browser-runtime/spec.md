## MODIFIED Requirements

### Requirement: Preserve the browser capability baseline
The assistant SHALL preserve the 26 legacy operations that constitute the baseline tool registry, sandboxed execute-code behavior, and narrated recording access. Operations added to the registry after that baseline SHALL be tracked as a separate, explicitly enumerated set, so that an addition is never indistinguishable from the loss of a preserved operation. Legacy operation names containing `mcp` SHALL remain internal compatibility aliases only. Preservation SHALL be measured by outputs and browser side effects, not an unverified claim of official Claude in Chrome parity.

#### Scenario: Representative browser workflow
- **WHEN** an authorized task creates a tab, navigates, reads the page, fills a form, clicks, captures a screenshot, and closes its tab
- **THEN** each operation returns its result, the screenshot is available as an image to the model, and no unrelated tab is modified

#### Scenario: Extended operations
- **WHEN** regression fixtures exercise console/network inspection, page JavaScript, GIF export, resize, shortcuts, focus, uploads, configuration, diagnostics, browser switching, recording retranscription, and sandboxed multi-action execution
- **THEN** results and browser side effects match the existing executor contracts, including existing errors and data limits

#### Scenario: Baseline operation missing from the registry
- **WHEN** any of the 26 baseline operations is absent from the live registry
- **THEN** the discrepancy is reported as a preservation failure naming the missing operation

#### Scenario: Operation added after the baseline
- **WHEN** the live registry contains an operation outside the 26 baseline operations
- **THEN** that operation is accepted only if it appears in the enumerated set of post-baseline additions, and any operation in neither set is reported as an unaccounted-for discrepancy
