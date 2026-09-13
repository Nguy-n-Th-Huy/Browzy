## ADDED Requirements

### Requirement: The permission mode is visible and changeable from the panel
The panel SHALL display the active permission mode wherever a run can act, and SHALL let the user change it between Manual, Auto, and Skip. When administrator-managed policy pins the mode, the control SHALL show the pinned mode as administrator-controlled and SHALL NOT allow a local change. Changing the mode SHALL take effect for actions decided after the change, and SHALL invalidate any outstanding decision card rather than reinterpreting it under the new mode.

#### Scenario: Reading and changing the mode
- **WHEN** the user opens the panel while a run can act
- **THEN** the active mode is visible, and selecting a different mode applies it to subsequently decided actions

#### Scenario: Administrator-pinned mode
- **WHEN** managed policy pins the mode
- **THEN** the control shows that mode as administrator-controlled and offers no local change

#### Scenario: Mode change clears an outstanding card
- **WHEN** the user changes the mode while a decision card is outstanding
- **THEN** the card is invalidated and cleared, and a late answer to it is rejected rather than applied under either mode

### Requirement: Approved sites are listed and revocable from a management surface
The product SHALL provide a surface listing every site with a remembered permission decision, showing each site's origin, the action class it covers, whether it is an allowance or a denial, and when it was recorded. The user SHALL be able to revoke any single entry or every entry from that surface. Entries placed by administrator-managed policy SHALL be listed as administrator-controlled and SHALL NOT be locally revocable. The surface SHALL state that protected actions are never remembered.

#### Scenario: Listing remembered sites
- **WHEN** the user opens the approved-sites surface with remembered decisions present
- **THEN** each entry is listed with its origin, action class, allowance or denial, and the time it was recorded

#### Scenario: Revoking a single site
- **WHEN** the user revokes one entry
- **THEN** that entry is removed and the remaining entries are unchanged

#### Scenario: Revoking everything
- **WHEN** the user revokes all entries
- **THEN** the list is empty and the surface states that no site has a remembered decision

#### Scenario: An administrator entry cannot be revoked here
- **WHEN** the list contains an entry placed by managed policy
- **THEN** that entry is marked administrator-controlled and offers no revoke control, while locally created entries remain revocable

#### Scenario: Empty state
- **WHEN** the user opens the surface with no remembered decisions
- **THEN** it states that no site has a remembered decision, rather than showing an empty list with no explanation

### Requirement: Warnings are shown separately from decision requests
The panel SHALL display injection findings and tab risk categories as warnings that carry no allow or deny control and suspend nothing. A warning SHALL be visually and semantically distinct from a decision card. Where a decision card is shown for an action on a tab carrying a finding or an elevated risk category, the card SHALL display that context alongside the request. Matched injected text SHALL be displayed as quoted data, never rendered as instructions or as panel-authored copy.

#### Scenario: A finding appears as a warning
- **WHEN** the probe records a finding for content a run read
- **THEN** the panel shows it as a warning with no allow or deny control, and no run is suspended by it

#### Scenario: Risk context on a decision card
- **WHEN** a decision card is shown for an action on a tab with an elevated risk category
- **THEN** the card displays that category and its contributing signals alongside the action and target, and the decision controls remain those of the card

#### Scenario: Injected text is quoted, not rendered
- **WHEN** a warning displays matched injected text
- **THEN** the text appears as quoted data, and any markup or instruction inside it is not rendered or acted on

## MODIFIED Requirements

### Requirement: Send/submit approval card
When a run's tool call requires a user decision under the active permission mode, the panel SHALL display a card naming the concrete action and its target, with explicit Allow and Deny controls, bound to that run and to that exact action/target. The card SHALL NOT appear for any call the active mode resolves without a decision, nor for a call resolved by a remembered per-site decision. For a call classified as protected, the card SHALL name the protected category that applies and SHALL state that the decision cannot be remembered. For any other card, the panel SHALL offer remembering the decision for that origin and action class, and SHALL record an entry only when the user asks for it. Under Auto, reading, extracting text, screenshots, scrolling, hovering, navigation clicks, typing, filling forms, opening/closing agent-created tabs, and in-scope page script execution SHALL continue with no card. An outstanding card SHALL be invalidated and removed from view on Stop, on a browser or tab scope change, on a permission mode change, or on replacement or deletion of the active credential, without waiting for the user to respond first.

#### Scenario: Send-class action requests a decision
- **WHEN** the mode is Auto and a run attempts to submit a form or click a send/submit/pay/confirm control
- **THEN** the panel shows an approval card naming that exact action and its target, execution pauses, and the run reports a waiting-for-permission state until the user answers

#### Scenario: Approval card invalidated by scope change
- **WHEN** the user stops the run, switches the bound browser/tab, changes the permission mode, or replaces or deletes the active credential while a card is outstanding
- **THEN** the card is invalidated and cleared from the panel, and any late answer to it is rejected rather than silently applied

#### Scenario: A protected action names its category and cannot be remembered
- **WHEN** a run attempts a protected action
- **THEN** the card names the protected category that applies, offers no option to remember the decision, and appears whichever mode is active

#### Scenario: Remembering a decision
- **WHEN** the user allows a non-protected action and asks for the decision to be remembered
- **THEN** an entry is recorded for that origin and action class, and it appears on the approved-sites surface

#### Scenario: No card for a remembered decision
- **WHEN** a call matches a remembered allowance for its origin and action class
- **THEN** no card appears, and the timeline records that a remembered decision resolved it rather than showing an unanswered request
