## ADDED Requirements

### Requirement: A keyboard command toggles the assistant panel
The extension SHALL declare a keyboard command that toggles the assistant panel for the tab the user is currently looking at: opening it when it is closed, closing it when it is open. The binding SHALL be user-rebindable through the browser's own extension-shortcut surface, and a binding the browser refuses or has already assigned SHALL leave the panel reachable by its existing controls rather than leaving the user with no way in.

#### Scenario: Opening with the keyboard
- **WHEN** the user presses the command while the panel is closed on the active tab
- **THEN** the panel opens for that tab

#### Scenario: Closing with the keyboard
- **WHEN** the user presses the command while the panel is open on the active tab
- **THEN** the panel closes for that tab

#### Scenario: The binding is unavailable
- **WHEN** the browser does not assign the suggested binding, or the user clears it
- **THEN** the panel remains reachable through its existing controls, and the shortcut surface shows the command as unbound rather than silently doing nothing

#### Scenario: Pressing the command on a page the panel cannot attach to
- **WHEN** the user presses the command on a tab where the panel cannot be shown
- **THEN** the runtime reports why rather than appearing to do nothing, and no other tab's panel state changes

### Requirement: Conversations can be listed, exported, and imported from the panel
The panel SHALL list the conversations available on this machine, and SHALL offer exporting a listed conversation to a portable bundle and importing a bundle produced elsewhere. An imported conversation SHALL be shown as imported wherever conversations are listed. Before exporting, the panel SHALL state what the bundle will contain and that it carries no credentials.

#### Scenario: Listing conversations
- **WHEN** the user opens the conversation list
- **THEN** the conversations on this machine are listed, with imported ones marked as imported

#### Scenario: Exporting from the panel
- **WHEN** the user exports a conversation from the list
- **THEN** the panel states what the bundle contains, produces the bundle, and reports where it was written

#### Scenario: Importing from the panel
- **WHEN** the user imports a bundle
- **THEN** the conversation appears in the list marked as imported and can be opened and read

#### Scenario: Import refused
- **WHEN** an import is refused because the bundle is malformed, unsupported, or conflicts with an existing conversation
- **THEN** the panel names the reason and the list is unchanged

#### Scenario: Deleting a conversation
- **WHEN** the user deletes a conversation from the list
- **THEN** it is removed from the list, and the panel states honestly whether the stored transcript was removed or only delisted here
