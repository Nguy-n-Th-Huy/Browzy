## 1. Conversation list and delete

- [ ] 1.1 Add a companion handler for listing conversations over the existing message type, returning what `SessionManager.listConversations()` already produces.
- [ ] 1.2 Add a companion handler for deleting a conversation over the existing message type, reporting honestly whether the stored transcript was removed or only delisted.
- [ ] 1.3 Correct the obsolete "Known protocol gap" comment in `extension/sidepanel/history-store.js` so it no longer describes a gap that has closed, and make the panel's delete copy match what actually happens now.
- [ ] 1.4 Wire the panel's conversation list to the real handlers. ← (verify: the list reflects conversations on disk rather than only those this panel created, and delete reports the true outcome)

## 2. Keyboard command

- [ ] 2.1 Declare a `commands` entry in `extension/manifest.json` with a suggested binding and a description; the manifest currently declares none.
- [ ] 2.2 Add a `chrome.commands.onCommand` handler that toggles the panel for the active tab, calling the open path synchronously within the command event so the user-gesture requirement is satisfied.
- [ ] 2.3 Decide open-vs-close from the panel's actual state for that tab, not from a flag the extension keeps; prefer opening when the state cannot be determined without awaiting.
- [ ] 2.4 Reuse the existing close path rather than adding a second one.
- [ ] 2.5 Report a tab the panel cannot attach to instead of appearing to do nothing, and leave other tabs' panel state untouched. ← (verify: pressing the command twice returns to the starting state, and closing the panel by other means does not invert the next press)

## 3. Sandboxed code execution and recording acknowledgement on the panel path

- [ ] 3.1 Register the existing sandbox entry point as a panel-reachable operation, reusing `host/codemode/`'s sandbox rather than adding a second one.
- [ ] 3.2 Match the external MCP entry points' result, error and image shapes exactly, including sandbox failure, timeout and limit errors.
- [ ] 3.3 Widen the existing `recording_ack` handling in `extension/background.js` to accept an acknowledgement from the panel's agent as well as from the MCP server, keeping delivery recorded exactly once.
- [ ] 3.4 Give both operations explicit entries in the action classification: sandboxed code execution alongside the operations already gated for running arbitrary code, recording acknowledgement as changing no page or browser state.
- [ ] 3.5 Record both in the enumerated post-baseline additions set so the registry check accounts for them.
- [ ] 3.6 Confirm external MCP behavior for both operations is unchanged. ← (verify: the same call through an external client and through the panel produces the same result, error and image shapes; neither operation relies on an unclassified fallback)

## 4. Export

- [ ] 4.1 Define the bundle format over the existing conversation directory layout, carrying a format version, the transcript, the conversation metadata, and referenced artifacts.
- [ ] 4.2 Implement export as a read-only operation over a named conversation; exporting must not modify what it exports.
- [ ] 4.3 Exclude provider credentials, provider profile values, and permission-policy settings structurally, wherever they appear in the source.
- [ ] 4.4 Redact a transcript-level secret and record in the bundle that a redaction occurred, so redacted content is distinguishable from content that never existed.
- [ ] 4.5 Record a referenced-but-missing artifact in the bundle rather than dropping it silently.
- [ ] 4.6 Report an unknown conversation as not found and write no file.
- [ ] 4.7 State what the bundle contains, and that it carries no credentials, before producing it. ← (verify: a bundle exported from a profile with a configured credential contains no credential anywhere in it, including inside the transcript)

## 5. Import

- [ ] 5.1 Implement import: validate the bundle and its format version, then create a readable conversation with its artifacts available.
- [ ] 5.2 Mark the conversation as imported, record which bundle it came from, and surface that mark wherever conversations are listed.
- [ ] 5.3 Execute nothing from the bundle: no tool call, no browser action, no setting applied, regardless of what the transcript contains.
- [ ] 5.4 Refuse a malformed or unsupported-version bundle by name, creating no partial conversation.
- [ ] 5.5 Report a colliding conversation identity as a conflict naming the existing conversation, and never overwrite it.
- [ ] 5.6 Report an artifact set that does not match the transcript, identifying what is missing or unexpected, while still importing.
- [ ] 5.7 Add the panel's import entry point and its refusal messages. ← (verify: importing a transcript containing tool calls and approvals dispatches nothing and changes no local setting)

## 6. Continuing an imported conversation

- [ ] 6.1 Make an imported conversation continuable, starting a new run against this machine's provider configuration.
- [ ] 6.2 Do not use the bundle's provider session reference to resume, and offer resuming it nowhere.
- [ ] 6.3 Record in the transcript that the conversation continued from an import rather than resumed the original session.
- [ ] 6.4 With no provider configured, keep the transcript readable and report that continuing needs a provider, rather than presenting the import as damaged. ← (verify: no surface anywhere offers resuming the origin machine's session, and continuation is never described as a resume)

## 7. Documentation

- [ ] 7.1 Document the keyboard command, that it is rebindable, and where to rebind it.
- [ ] 7.2 Document what an exported bundle contains and what it deliberately excludes, and that an imported conversation continues as a new run rather than resuming the original session.
