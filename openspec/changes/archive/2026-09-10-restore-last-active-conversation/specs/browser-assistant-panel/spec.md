## ADDED Requirements

### Requirement: Last active conversation restored on reopen

The panel SHALL remember which conversation is active and SHALL restore that conversation when the panel is reopened, including after the panel is closed and after the browser is restarted. The remembered identity SHALL be updated whenever the active conversation changes — a conversation created by the operator, one reopened from the history list, or one adopted from the companion — and SHALL be cleared when the active conversation is deleted locally. The panel SHALL NOT infer the conversation to restore from recency of transcript activity, because a conversation the operator is not looking at can still receive events. Failure to persist or read the remembered identity SHALL NOT block the panel from opening; the panel SHALL fall back to starting a new conversation.

#### Scenario: Panel reopened after being closed

- **WHEN** the operator sends a message in a conversation, closes the side panel, and reopens it
- **THEN** the panel reopens that same conversation with its transcript restored from the companion, and does not create a new conversation

#### Scenario: Remembered identity survives a browser restart

- **WHEN** the browser is fully closed and reopened, and the side panel is opened again
- **THEN** the panel restores the conversation that was active before the restart, with any run that was in flight shown as interrupted

#### Scenario: First ever open

- **WHEN** the panel is opened and no conversation has ever been active on this browser profile
- **THEN** the panel starts a new conversation

### Requirement: Restore falls back instead of stranding the operator

When the panel cannot restore the remembered conversation, it SHALL start a new conversation and SHALL clear the remembered identity, rather than leaving the operator in an empty conversation that cannot be used. This SHALL apply when the companion reports the conversation is unknown to it, when the request cannot be sent at all, and when the conversation is absent from the panel's own conversation list or is marked deleted on this browser. The fallback SHALL apply only to restore at panel startup; a conversation the operator explicitly reopens from the history list SHALL surface the failure as an error on that conversation and SHALL NOT be silently replaced by a different conversation.

#### Scenario: Remembered conversation is unknown to the companion

- **WHEN** the panel is opened, the remembered conversation is restored, and the companion reports it does not know that conversation (for example after the agent home was wiped or the companion was reinstalled)
- **THEN** the panel starts a new usable conversation, forgets the remembered identity, and does not leave the operator on an empty conversation showing only an error

#### Scenario: Remembered conversation was deleted locally

- **WHEN** the operator deletes a conversation from the history list and later reopens the panel
- **THEN** the panel does not attempt to restore that conversation and starts a new one instead

#### Scenario: Explicit reopen of an unknown conversation is not swapped

- **WHEN** the operator reopens a conversation from the history list and the companion reports it does not know that conversation
- **THEN** the panel surfaces the failure against the conversation the operator asked for, and does not silently switch the operator to a different or newly created conversation
