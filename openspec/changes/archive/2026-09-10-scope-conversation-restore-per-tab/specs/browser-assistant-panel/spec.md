## REMOVED Requirements

### Requirement: Last active conversation restored on reopen

**Reason**: Its restore was scoped to the browser profile, so a panel opened on a second tab was handed the first tab's conversation — contradicting the independent per-tab agent scope `side-panel-follows-active-tab` defines. Its "Remembered identity survives a browser restart" scenario is also no longer achievable: the remembered identity is now keyed by tab id and held for the browser session, matching the lifetime of the per-tab panel enablement it describes.

**Migration**: Replaced by `Last active conversation restored per panel scope` below, which keeps same-tab continuity and drops only the cross-restart and cross-tab cases. No data migration is needed — nothing is deleted, and every conversation stays listed and reopenable from the history list.

## ADDED Requirements

### Requirement: Last active conversation restored per panel scope

The panel SHALL remember which conversation is active within the scope of the tab it was opened on, and SHALL restore that conversation when a panel is reopened in that same scope. A panel opened in a scope that has no remembered conversation SHALL start a new one; it SHALL NOT adopt a conversation remembered for a different scope, because each tab the panel is explicitly opened on is an independent agent scope with its own page context and its own agent tab group. The remembered identity SHALL be updated whenever the active conversation changes — a conversation created by the operator, one reopened from the history list, or one adopted from the companion — and SHALL be cleared when the active conversation is deleted locally. The panel SHALL NOT infer the conversation to restore from recency of transcript activity, because a conversation the operator is not looking at can still receive events. The remembered identity SHALL NOT outlive the browser session, matching the lifetime of the per-tab panel enablement it is scoped to. Failure to persist or read the remembered identity SHALL NOT block the panel from opening; the panel SHALL fall back to starting a new conversation.

Restoring is about which conversation opens automatically, never about which conversations exist. Conversations SHALL remain listed and reopenable from the history list regardless of the scope they were started in or the browser session they belong to.

#### Scenario: Panel reopened after being closed

- **WHEN** the operator sends a message in a conversation, closes the side panel, and reopens it on the same tab
- **THEN** the panel reopens that same conversation with its transcript restored from the companion, and does not create a new conversation

#### Scenario: Panel reopened while a run is still in flight

- **WHEN** the operator submits a message, closes the side panel before the response completes, and reopens it on the same tab
- **THEN** the panel reopens that conversation and the run that was already in progress continues to be reflected there

#### Scenario: Panel opened on a different tab

- **WHEN** the operator opens the panel on a tab that has no conversation of its own, while another tab's conversation is active or still running
- **THEN** the panel starts a new conversation for that tab, and the other tab's conversation is neither shown nor interrupted

#### Scenario: First ever open

- **WHEN** the panel is opened and no conversation has been active in this scope during this browser session
- **THEN** the panel starts a new conversation

#### Scenario: Earlier conversations stay reachable

- **WHEN** the operator opens the history list from a panel that started a new conversation
- **THEN** conversations started in other tabs and in earlier browser sessions are still listed and can still be reopened

## MODIFIED Requirements

### Requirement: Restore falls back instead of stranding the operator

When the panel cannot restore the remembered conversation, it SHALL start a new conversation and SHALL clear the remembered identity, rather than leaving the operator in an empty conversation that cannot be used. This SHALL apply when the companion reports the conversation is unknown to it, when the request cannot be sent at all, when the conversation is absent from the panel's own conversation list or is marked deleted on this browser, and when no panel scope can be identified to restore against. The fallback SHALL apply only to restore at panel startup; a conversation the operator explicitly reopens from the history list SHALL surface the failure as an error on that conversation and SHALL NOT be silently replaced by a different conversation.

#### Scenario: Remembered conversation is unknown to the companion

- **WHEN** the panel is opened, the remembered conversation is restored, and the companion reports it does not know that conversation (for example after the agent home was wiped or the companion was reinstalled)
- **THEN** the panel starts a new usable conversation, forgets the remembered identity, and does not leave the operator on an empty conversation showing only an error

#### Scenario: Remembered conversation was deleted locally

- **WHEN** the operator deletes a conversation from the history list and later reopens the panel
- **THEN** the panel does not attempt to restore that conversation and starts a new one instead

#### Scenario: No identifiable scope

- **WHEN** the panel opens and cannot determine which tab it belongs to
- **THEN** it starts a new conversation rather than restoring one remembered for some other scope

#### Scenario: Explicit reopen of an unknown conversation is not swapped

- **WHEN** the operator reopens a conversation from the history list and the companion reports it does not know that conversation
- **THEN** the panel surfaces the failure against the conversation the operator asked for, and does not silently switch the operator to a different or newly created conversation
