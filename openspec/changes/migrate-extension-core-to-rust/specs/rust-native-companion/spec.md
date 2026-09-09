## Purpose

Provide a native Rust companion that manages browser connectivity and application state while preserving official SDK behavior and provider-key-only operation.

## ADDED Requirements

### Requirement: Automatic native and SDK lifecycle
Browser startup after one-time setup SHALL launch the Rust host and its supervised official SDK adapter without user terminal commands, Rust installation or Claude product login. Model execution SHALL remain in the official SDK.

#### Scenario: Clean startup
- **WHEN** a configured user opens a supported browser with no Claude login state
- **THEN** the native host and SDK adapter become ready automatically and permit configured provider-key chat, browser tools and skills

### Requirement: Validated bounded communication
Communication SHALL validate framing, versions, payload bounds and request identity before dispatch, with no credentials in logs or command arguments. Unknown versions and malformed or oversized messages SHALL not execute browser actions.

#### Scenario: Corrupt or mismatched peer
- **WHEN** a peer sends an invalid length, malformed message or incompatible version
- **THEN** the connection fails with a diagnostic, bounded memory use and no action dispatch

### Requirement: Honest interruption
Stop, browser loss and adapter death SHALL settle pending requests, remove active cursor state and prevent new dispatch. A sent request with no confirmed result SHALL remain unknown and SHALL not be replayed on restart.

#### Scenario: Adapter crashes after a click
- **WHEN** a click was dispatched and the adapter exits before confirmation
- **THEN** the run is interrupted with unknown outcome, and restarting the adapter does not repeat the click

### Requirement: Preserved protected user state
Settings, skill snapshots, recording data and SDK session references SHALL remain usable after migration. Secrets SHALL stay in the OS credential store or explicit memory-only mode, never plaintext migration files.

#### Scenario: Credential store unavailable
- **WHEN** existing credentials cannot be accessed
- **THEN** the user receives a re-entry or memory-only option without a Claude-login fallback or plaintext credential export
