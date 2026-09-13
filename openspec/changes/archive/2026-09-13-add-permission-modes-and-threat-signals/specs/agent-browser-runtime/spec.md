## MODIFIED Requirements

### Requirement: Send/submit-class actions gate at canUseTool
The runtime SHALL classify each browser tool call before executing it, and SHALL resolve whether it requires a user decision from that classification together with the active permission mode, any remembered per-site decision for the call's origin and action class, and any administrator-managed policy. A call classified as protected MUST suspend execution pending an explicit user decision under every mode and regardless of any remembered decision. Under Auto, a call classified as submitting a form, clicking a send/submit/pay/confirm control, or a comparably hard-to-reverse outward-facing action MUST suspend execution pending an explicit user decision, and every other classified call MUST proceed automatically. Under Manual, every call classified as mutating MUST suspend. Under Skip, only protected calls and calls a managed policy requires confirmation for MUST suspend. A call classified as read-only MUST proceed automatically under every mode. A tool name capable of producing a call that can require a decision MUST NOT be included in the SDK's auto-approval list; it MAY remain in the SDK's tool-availability list so the call still reaches this classification.

#### Scenario: Automatic action bypasses the gate
- **WHEN** the mode is Auto and a call is classified outside the send/submit and protected sets — reading, extraction, screenshot, scroll, hover, navigation click, typing, form-field filling, opening/closing an agent-created tab, or in-scope script execution
- **THEN** it executes without waiting for a user decision, exactly as before permission modes existed

#### Scenario: Send/submit call suspends for a decision
- **WHEN** the mode is Auto and a call is classified as submitting a form, clicking a send/submit/pay/confirm control, or an equivalently outward-facing action
- **THEN** execution does not proceed until an explicit allow or deny decision resolves it, and a denial or timeout prevents that dispatch entirely

#### Scenario: Manual mode suspends an ordinary mutating call
- **WHEN** the mode is Manual and a call is classified as mutating but not send/submit-class
- **THEN** execution does not proceed until an explicit decision resolves it

#### Scenario: Skip mode does not suspend a send/submit call
- **WHEN** the mode is Skip and a call is classified as send/submit-class, is not protected, and no managed policy requires confirmation for it
- **THEN** it executes without waiting for a user decision

#### Scenario: A protected call suspends under every mode
- **WHEN** a call is classified as protected
- **THEN** execution does not proceed until an explicit decision resolves it, whichever mode is active and whatever the per-site store holds

#### Scenario: A remembered decision resolves the gate without asking
- **WHEN** a call's origin and action class match a remembered allowance and the call is not protected
- **THEN** it executes without waiting for a user decision, and the transcript records that a remembered decision resolved it rather than showing an unasked question

#### Scenario: Reading is never gated
- **WHEN** a call is classified as read-only
- **THEN** it executes without waiting for a user decision under every mode
