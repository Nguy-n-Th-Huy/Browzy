## ADDED Requirements

### Requirement: Sequential batched execution in one call

The registry SHALL expose an operation that takes an ordered list of tool calls and executes them sequentially in a single call, returning each item's result in order. Items SHALL execute one after another, never concurrently. A batch SHALL NOT contain another batch.

Each item SHALL be executed through the same code path, and subject to the same tab-scope and restricted-page checks, as that tool invoked on its own. Batching SHALL NOT give an item any capability it would not have standing alone.

#### Scenario: A predictable sequence

- **WHEN** a batch of a click on a reference, a typed string, and a screenshot is submitted
- **THEN** the three run in that order in one call, and the results come back in that order

#### Scenario: An item that would be refused on its own

- **WHEN** a batch contains an item naming a tab outside the caller's scope, or a restricted page
- **THEN** that item is refused exactly as it would be standing alone

#### Scenario: Nesting

- **WHEN** a batch contains a batch
- **THEN** it is rejected

### Requirement: A batch stops as soon as its assumptions no longer hold

Execution SHALL stop, and the response SHALL say which item it stopped at and why, when any of the following occurs: an item returns an error; the page URL differs after an item from before it; the focused element differs after an item from before it.

Items after the stop SHALL NOT execute. The response SHALL report the results of the items that did run, so a partial batch is never mistaken for a failed one or a complete one.

#### Scenario: An item errors

- **WHEN** an item returns an error
- **THEN** the remaining items do not run, and the response identifies the failing item and carries the results of those that ran

#### Scenario: A click navigates

- **WHEN** an item causes the page URL to change
- **THEN** the batch stops after that item, because every later item was written against a page that is no longer displayed

#### Scenario: Focus moves unexpectedly

- **WHEN** the focused element after an item is not the one that was focused before it
- **THEN** the batch stops after that item, because a subsequent typed string would reach a different control than intended

#### Scenario: Nothing disturbs the sequence

- **WHEN** no item errors, the URL is unchanged, and focus is unchanged throughout
- **THEN** every item runs and every result is returned

### Requirement: Coordinates inside a batch refer to the pre-batch view

Coordinates written in a batch's items SHALL be interpreted in the coordinate space of the most recent screenshot taken before the batch began, because no screenshot produced during the batch has reached the caller. The operation's description SHALL state this.

#### Scenario: A coordinate after an earlier item moved the page

- **WHEN** an item scrolls or expands the page and a later item in the same batch uses a coordinate
- **THEN** that coordinate is still interpreted against the pre-batch screenshot, and the caller has been told this is how it behaves

### Requirement: Batching is not a route around the send/submit-class gate

An item that classifies as send/submit-class SHALL NOT execute inside a batch. A batch containing such an item SHALL be rejected before any item executes, identifying the offending item and stating that it must be issued as its own call.

Classification SHALL use the same classifier that gates a standalone call, so the set of actions requiring the user's decision is identical whether or not a batch was involved. No approval token issued for a batch SHALL authorize a send-class action inside it.

#### Scenario: A batch containing a submit

- **WHEN** a batch contains an item whose target resolves to a submit, send, pay, or confirm control
- **THEN** the whole batch is rejected before anything runs, and the response names that item and says it must be issued on its own

#### Scenario: A batch containing a submit-activating key with no resolvable target

- **WHEN** a batch contains a key press that may activate a focused submit control and the target cannot be resolved
- **THEN** the batch is rejected on the same terms, because that call requires the user's decision

#### Scenario: Approval cannot be inherited

- **WHEN** a batch is authorized to run
- **THEN** that authorization covers only the non-send-class items it contains, and no send-class action becomes executable because it was nested inside an approved batch

#### Scenario: The same action outside a batch

- **WHEN** an action rejected inside a batch is issued as its own call
- **THEN** it is classified and gated exactly as it was before this capability existed
