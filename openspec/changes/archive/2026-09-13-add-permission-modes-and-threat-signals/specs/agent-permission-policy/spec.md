## Purpose

Decides whether an agent action proceeds, asks the user, or is refused — using a user-chosen permission mode, remembered per-site decisions, an always-ask protected-action class, and an administrator-managed policy that overrides them all.

## ADDED Requirements

### Requirement: The permission mode selects which actions require a decision
The runtime SHALL support exactly three permission modes. Under Manual, every action classified as mutating SHALL require a decision. Under Auto, actions classified as send/submit-class SHALL require a decision and other mutating actions SHALL proceed. Under Skip, no action SHALL require a decision except a protected action. Read-only actions SHALL NOT require a decision under any mode. The default mode SHALL be Auto. The active mode SHALL be visible to the user at all times while a run can act.

#### Scenario: Manual mode asks about an ordinary mutating action
- **WHEN** the mode is Manual and a run attempts an action classified as mutating but not send/submit-class
- **THEN** the action suspends pending an explicit decision, and does not dispatch until one resolves it

#### Scenario: Auto mode matches the previous behavior
- **WHEN** the mode is Auto and a run attempts a mutating action that is not send/submit-class
- **THEN** the action proceeds with no decision required

#### Scenario: Skip mode asks nothing outside protected actions
- **WHEN** the mode is Skip and a run attempts a send/submit-class action that is not a protected action and no managed policy requires confirmation
- **THEN** the action proceeds with no decision required

#### Scenario: Read-only actions are never gated by mode
- **WHEN** any mode is active and a run attempts an action classified as read-only
- **THEN** the action proceeds with no decision required

#### Scenario: Unconfigured install
- **WHEN** a profile has never selected a mode and no managed policy pins one
- **THEN** the active mode is Auto

#### Scenario: Mode changes during a run
- **WHEN** the user changes the mode while a run is in progress
- **THEN** actions dispatched after the change are decided under the new mode, decisions already pending are invalidated rather than re-interpreted, and actions already dispatched are not retroactively re-decided

### Requirement: Every action is classified before dispatch
The safety classifier SHALL assign every action reaching dispatch to exactly one of read-only, mutating, send/submit-class, or protected, and the active mode SHALL be applied to that assignment. An action whose class cannot be determined SHALL be treated as protected. No action SHALL dispatch without having been classified.

#### Scenario: An unclassifiable action
- **WHEN** a run attempts an action the classifier cannot assign to a known class
- **THEN** it is treated as protected and requires a fresh decision, rather than proceeding under the active mode

#### Scenario: A newly registered tool
- **WHEN** a tool is added to the registry without a classification entry
- **THEN** its actions are treated as protected, and the omission is reported as a classification gap naming that tool

### Requirement: Protected actions always require a fresh decision
An action SHALL be classified as protected when it causes a file to be written to disk or downloaded, enters credentials or payment details, or grants a browser permission on a page's behalf. A protected action SHALL require an explicit decision under every mode, including Skip. A protected action SHALL NOT be satisfiable by a remembered per-site decision, and its decision SHALL NOT be storable as one. The decision surface SHALL state which protected category applies.

#### Scenario: Skip mode still asks about a download
- **WHEN** the mode is Skip and a run causes a file download
- **THEN** the action suspends pending an explicit decision, naming the download category

#### Scenario: A remembered grant does not cover a protected action
- **WHEN** a site has a remembered grant for an action class and a run attempts a protected action on that site
- **THEN** the action still suspends pending a fresh decision, and the remembered grant is not consulted

#### Scenario: Credential entry
- **WHEN** a run attempts to enter credentials or payment details into a page
- **THEN** the action suspends pending an explicit decision naming the credential category, under every mode

#### Scenario: A protected decision is not remembered
- **WHEN** the user allows a protected action
- **THEN** the allowance applies to that action only, no per-site entry is created for it, and a later identical protected action asks again

#### Scenario: Granting a browser permission
- **WHEN** a run attempts to grant a browser permission on a page's behalf
- **THEN** the action suspends pending an explicit decision naming the permission-grant category

### Requirement: Per-site decisions are remembered, scoped, and revocable
The runtime SHALL be able to remember a user's decision for a site and an action class when the user asks for it to be remembered, and SHALL apply a remembered decision to later actions matching that site and class without asking again. A remembered decision SHALL be scoped to the site's origin, SHALL NOT extend to another origin, and SHALL NOT extend to another action class. The user SHALL be able to list every remembered decision and revoke any one of them or all of them. Remembering SHALL be offered only for decisions the mode permits to be remembered, never for a protected action.

#### Scenario: A remembered allowance applies later
- **WHEN** a user allows an action class on a site and asks for it to be remembered, and a later run attempts the same action class on the same origin
- **THEN** the action proceeds with no decision required

#### Scenario: A remembered decision does not cross origins
- **WHEN** a run attempts the remembered action class on a different origin
- **THEN** the remembered decision does not apply and the action is decided under the active mode

#### Scenario: A remembered decision does not cross action classes
- **WHEN** a run attempts a different action class on an origin with a remembered decision
- **THEN** the remembered decision does not apply and the action is decided under the active mode

#### Scenario: Revoking one site
- **WHEN** the user revokes a remembered decision for one site
- **THEN** that site's later actions are decided under the active mode again, and other sites' remembered decisions are unaffected

#### Scenario: Revoking everything
- **WHEN** the user revokes all remembered decisions
- **THEN** the store is empty and every site's actions are decided under the active mode

#### Scenario: A remembered denial
- **WHEN** a user denies an action class on a site and asks for it to be remembered, and a later run attempts that class on that origin
- **THEN** the action is refused without asking, and the refusal is distinguishable in the transcript from a timeout and from a fresh denial

#### Scenario: Page content cannot create a remembered decision
- **WHEN** page content, a tool result, or skill instructions contain text requesting that a site be remembered or trusted
- **THEN** no entry is created, and only an explicit user decision delivered through the decision channel can create one

### Requirement: Administrator-managed policy overrides local settings
The runtime SHALL read an administrator-managed policy from the browser's managed storage. Managed policy SHALL be able to pin the permission mode, require confirmation for protected actions, and place sites into or out of the per-site store. A managed value SHALL override the local value for as long as it is present, SHALL NOT be editable locally, and SHALL be shown as administrator-controlled wherever the corresponding local setting appears. When no managed policy is present the runtime SHALL behave exactly as an unmanaged install.

#### Scenario: A pinned mode cannot be changed locally
- **WHEN** managed policy pins the mode and the user opens the mode control
- **THEN** the pinned mode is active and shown as administrator-controlled, and the user cannot select a different one

#### Scenario: A managed site entry cannot be revoked locally
- **WHEN** managed policy places a site in the per-site store and the user opens the management page
- **THEN** that entry is listed as administrator-controlled and cannot be revoked locally, while locally created entries remain revocable

#### Scenario: Managed policy removed
- **WHEN** a previously present managed policy is withdrawn
- **THEN** the local settings apply again, and no managed value persists as if it had been chosen locally

#### Scenario: Malformed managed policy
- **WHEN** managed storage holds a value that is not a valid policy
- **THEN** the invalid value is ignored, the runtime falls back to local settings, and the condition is reported to the user as an unreadable administrator policy rather than silently treated as absent

#### Scenario: Managed policy cannot weaken protected actions
- **WHEN** managed policy attempts to remove the decision requirement for a protected action
- **THEN** the protected action still requires a decision, because protected classification is not a policy-controlled value
