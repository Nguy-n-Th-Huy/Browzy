## Purpose

Make extension-to-companion connectivity survive normal updates and restarts without asking users to copy and update extension identifiers.

## ADDED Requirements

### Requirement: Persistent extension identity
Official unpacked development builds SHALL ship one stable public extension key across releases. Normal extension reload, browser restart, and relocation of the unpacked directory SHALL preserve the resulting extension ID. Release signing material MUST NOT be committed.

#### Scenario: Reload and relocation
- **WHEN** the same keyed extension build is loaded from another directory, reloaded, or restarted in a supported browser
- **THEN** its ID remains unchanged and the existing native-host allowlist remains valid

### Requirement: Automatic exact-origin installation
The installer SHALL derive the extension ID from the supplied public manifest key without a required extension-ID argument, register the companion for selected installed browsers, and use exact native-messaging allowed origins. It SHALL support paths containing spaces and non-ASCII characters and be safe to rerun.

#### Scenario: Fresh Windows installation
- **WHEN** the user runs the supported installer with Chrome, Edge, or Brave installed
- **THEN** the user can choose the installed browser targets and register the host without copying an extension ID or adding an MCP server

#### Scenario: Missing key or unavailable runtime
- **WHEN** the supplied build has no valid public key or the required runtime cannot be found
- **THEN** installation stops with a specific repair instruction and does not write an empty or wildcard allowed-origin configuration

### Requirement: Migration and diagnostics
The installation flow SHALL detect legacy ID mismatch, missing host registration, invalid host path, and incompatible companion version as distinct states. Switching a legacy unpacked installation to the keyed build SHALL include a one-time export/import path for settings and recorder metadata owned by the old extension; it SHALL not promise automatic access to another extension ID's storage.

#### Scenario: Legacy ID changes once
- **WHEN** an existing user migrates from an unkeyed build to the stable keyed build
- **THEN** guidance explains the one-time identity transition and preserves host-side recordings, while no recurring ID edits are needed afterward

#### Scenario: Untrusted origin
- **WHEN** an extension outside the generated exact allowlist attempts to connect
- **THEN** it is denied and diagnostics do not suggest weakening the allowlist

### Requirement: Browser-only daily startup
After one-time extension installation, native-companion registration, and provider configuration, opening the browser SHALL initialize the companion and internally configured browser tools automatically. The user SHALL not need a terminal command, a separately opened Claude Code client, or repeated MCP setup. Opening the assistant panel MAY require the browser's normal user gesture.

#### Scenario: Daily use after restart
- **WHEN** the configured user closes and reopens the browser and opens the assistant panel
- **THEN** the connection initializes automatically, stored settings and enabled skills are restored, and the user can send a task without redoing installation

#### Scenario: Companion missing
- **WHEN** the extension is loaded on a machine without the required companion registration
- **THEN** the panel explains the one-time setup requirement rather than claiming that extension installation alone is sufficient

### Requirement: Stable identity shared by both access paths
External MCP clients and the built-in SDK assistant SHALL use the same stable extension identity and native registration. Selecting an access mode SHALL not require a different extension build, manual ID changes or repeated native-host registration. Initial external MCP-client server registration remains a one-time client setup action.

#### Scenario: MCP reconnect after reload
- **WHEN** a user reloads the keyed extension, restarts the browser, or switches between external MCP and sidepanel usage
- **THEN** existing native allowed origins remain valid and the external MCP client can reconnect without copying a new extension ID or rerunning ID registration
