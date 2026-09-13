## Purpose

Lets a conversation leave the machine that produced it: exported as one portable bundle, imported elsewhere, and read or continued there without pretending the original provider session moved with it.

## ADDED Requirements

### Requirement: A conversation exports to a single portable bundle
The runtime SHALL export a named conversation as one file containing its transcript, its conversation metadata, and the artifacts that transcript references. The bundle SHALL identify the format version it was written in. Export SHALL NOT modify the conversation it exports.

#### Scenario: Exporting a conversation
- **WHEN** the user exports a conversation that has a transcript and referenced artifacts
- **THEN** a single file is produced containing the transcript, the conversation metadata, and every referenced artifact, and the conversation on disk is unchanged

#### Scenario: Exporting a conversation with no artifacts
- **WHEN** the user exports a conversation whose transcript references no artifacts
- **THEN** a valid bundle is produced carrying the transcript and metadata alone

#### Scenario: A referenced artifact is missing
- **WHEN** the transcript references an artifact that is not present on disk
- **THEN** the export completes and the bundle records that artifact as missing, so the import side can say so rather than appearing to have lost it

#### Scenario: Exporting an unknown conversation
- **WHEN** an export names a conversation that does not exist
- **THEN** the operation reports it as not found and writes no file

### Requirement: A bundle carries conversation content and never credentials
A bundle SHALL NOT contain provider credentials, API keys, provider profile settings, permission-policy settings, or any value held for authentication. This SHALL hold regardless of where such a value appears in the source conversation. The export surface SHALL state what a bundle carries before the user shares it.

#### Scenario: Credentials are absent from the bundle
- **WHEN** a conversation is exported from a profile that has a configured provider credential
- **THEN** no credential, API key, or provider profile value appears anywhere in the bundle

#### Scenario: A secret captured inside the transcript
- **WHEN** the transcript itself contains a value the runtime holds as a secret
- **THEN** it is excluded or redacted in the bundle, and the bundle records that a redaction occurred rather than silently omitting content

### Requirement: An import is readable, attributed, and never executed
Importing a bundle SHALL create a conversation whose transcript is readable and whose artifacts are available. The imported conversation SHALL be marked as imported, SHALL record which bundle it came from, and SHALL NOT be presented as having been produced on this machine. Importing SHALL NOT execute any content from the bundle, SHALL NOT dispatch browser actions, and SHALL NOT apply any setting carried in it.

#### Scenario: Importing on another machine
- **WHEN** a user imports a bundle exported elsewhere
- **THEN** the conversation appears in the conversation list marked as imported, its transcript is readable, and its artifacts open

#### Scenario: Import performs no action
- **WHEN** the imported transcript contains tool calls, approvals, or instructions
- **THEN** none of them execute, no browser action is dispatched, and no setting on this machine changes

#### Scenario: Importing a bundle that is already present
- **WHEN** a bundle is imported whose conversation identity already exists locally
- **THEN** the import is reported as a conflict naming the existing conversation, and the existing conversation is not overwritten

#### Scenario: A malformed or unreadable bundle
- **WHEN** an imported file is not a valid bundle, or its format version is not supported
- **THEN** the import is refused naming the reason, and no partial conversation is created

#### Scenario: A bundle whose artifacts do not match its transcript
- **WHEN** an imported bundle's artifacts do not match what its transcript references
- **THEN** the conversation is imported with the mismatch reported, and the missing or unexpected artifacts are identified

### Requirement: Continuing an imported conversation starts a new run
An imported conversation SHALL be continuable, and continuing it SHALL start a new run against the local provider configuration. The provider-side session reference from the exporting machine SHALL NOT be treated as resumable here, and the runtime SHALL NOT present continuation as resuming the original session.

#### Scenario: Continuing after import
- **WHEN** the user sends a message in an imported conversation
- **THEN** a new run starts against this machine's configured provider, and the transcript records that the conversation continued from an import rather than resuming the original session

#### Scenario: The original session reference is not offered
- **WHEN** an imported conversation carries a provider session reference from its origin machine
- **THEN** that reference is not used to resume, and no surface offers resuming it

#### Scenario: Continuing with no provider configured
- **WHEN** the user tries to continue an imported conversation on a machine with no provider configured
- **THEN** the transcript stays readable and the runtime reports that continuing requires a configured provider, rather than failing as though the import were damaged
