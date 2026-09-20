## MODIFIED Requirements

### Requirement: Monitors advise guarded control flow

The Jev request SHALL include independently answered action, goal_done and stuck Choice heads over the same bounded state. A positive completion judgment or DONE choice SHALL trigger LLM verification rather than successful termination. REPLAN and stuck SHALL use bounded planning consultation. A positive stuck judgment SHALL withhold an executable selected action at most once per plan revision: once a stuck judgment has produced a revised plan and no action has been dispatched under that revision, a further positive stuck judgment SHALL NOT withhold the action the same decision selected. An explicitly selected REPLAN operation SHALL always consult planning, unaffected by that bound. ASK SHALL surface the existing blocked/operator-needed state. Every control choice SHALL remain subject to run bounds.

#### Scenario: Monitor thinks the goal is done

- **WHEN** goal_done is positive even though the action head selects a mutation
- **THEN** completion is checked before mutation and success requires verification

#### Scenario: Replans never progress

- **WHEN** repeated REPLAN or stuck judgments produce no executed progress
- **THEN** the bounded run ends blocked with a named reason rather than resetting its budgets

#### Scenario: Operator help is required

- **WHEN** Jev selects ASK
- **THEN** the run records blocked and needsOperator and presents the need for user input without claiming an implemented pause/resume channel

#### Scenario: Stuck repeats after the plan was already revised

- **WHEN** a positive stuck judgment has already produced a revised plan, no action has been dispatched under that revision, and the next decision again reports stuck while selecting an executable action
- **THEN** the selected action is dispatched rather than withheld for another identical planning consultation

#### Scenario: The wrong page is the reason for being stuck

- **WHEN** the observed page cannot advance the goal and every cycle selects a prepared navigation to the site the goal names while reporting stuck
- **THEN** the run navigates to that site instead of ending on a spent planning budget without having left the page

### Requirement: Jev selects complete fresh actions

The TypeSafe runtime SHALL build complete host-owned action candidates from each fresh observation and ask Jev to select an offered action key. Each key SHALL resolve to exactly one operation, current target and prepared payload where required. Routine decisions SHALL NOT require a configured-language-model NEXT_STEP request or a prose-to-target reconstruction. A selected NAVIGATE action carries no observed target and its destination is independent of the observed page, so its dispatch SHALL require only that its prepared record is still unconsumed and that the destination differs from the current page; movement elsewhere on the observed page SHALL NOT invalidate it, and a pre-dispatch capture that no longer matches the observation SHALL be recorded as unavailable evidence rather than cancelling the navigation.

#### Scenario: Multiple actions under one plan

- **WHEN** the prepared plan contains enough information for multiple routine actions
- **THEN** each cycle observes and consults Jev, executing validated offered actions without a language-model step request

#### Scenario: A target appears after hover

- **WHEN** HOVER reveals a new menu item
- **THEN** the next observation creates new candidates including the item without reusing prior target indices

#### Scenario: State changes during decision

- **WHEN** refreshed state no longer matches the selected target's relevant identity or state
- **THEN** no action is dispatched from the stale key and a fresh cycle rebuilds candidates

#### Scenario: The page moves under a selected navigation

- **WHEN** NAVIGATE is selected and the observed page's text, elements or document change before dispatch while the prepared record remains unconsumed
- **THEN** the navigation is dispatched to its prepared destination rather than skipped as a stale observation

#### Scenario: A prepared navigation was already spent

- **WHEN** NAVIGATE is selected from a prepared record that a previous dispatch consumed, or whose destination equals the current page
- **THEN** no navigation is dispatched from that record and a fresh cycle rebuilds candidates
