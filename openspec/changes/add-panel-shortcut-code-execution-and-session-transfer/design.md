## Context

See proposal.md — Why. The constraints that shape the approach:

- `extension/manifest.json` declares no `commands` key at all, so there is no existing binding convention to follow here.
- `chrome.sidePanel.open()` may only be called in direct, synchronous response to a user gesture — `extension/background.js` documents this at its own open path. A `chrome.commands` command is such a gesture; an async continuation after an `await` is not.
- The close half already exists: `extension/background.js` sets `{ enabled: false }` via `chrome.sidePanel.setOptions` and calls `chrome.sidePanel.close()` where that method is available. This change needs the binding and the toggle decision, not a new close mechanism.
- `execute_code` runs in the sandbox under `host/codemode/`, reached today only through `host/codemode/server-codemode.js` and `server-hybrid.js`. The panel's agent goes through `host/tool-definitions.js` and `host/agent/tools/adapter.js` instead, so the two paths currently expose different tool sets.
- `recording_ack` is handled in `extension/background.js` only for the case where it arrives from the MCP server.
- Conversations persist under the companion's conversation directory as `events.jsonl`, `meta.json`, and `artifacts/` (`host/agent/storage/paths.js`). `LIST_CONVERSATIONS` and `DELETE_CONVERSATION` exist in `host/agent/protocol.js` and `SessionManager` implements the methods, but `host/agent/companion.js` handles neither.
- A conversation's provider session reference (`sdkSessionRef`) is claimed per machine and per provider account. Nothing makes it meaningful on another machine.
- Host-side policy modules are pure functions over caller-supplied snapshots so every path is unit-testable without a live run; extension logic is tested by brace-extraction from the shipped file under plain Node.

## Goals / Non-Goals

**Goals:**

- One keyboard press reaches the panel and one dismisses it, without a new close mechanism.
- The panel's agent and an external MCP client see the same two operations with the same contracts.
- A conversation moves between machines as one file, and what that file can and cannot carry is decided rather than incidental.
- An imported conversation is honest about its origin and about what cannot come with it.

**Non-Goals:**

- No sync, no cloud, no automatic transfer. Export and import are explicit user actions on a file.
- No merging of two versions of the same conversation. A collision is reported, not resolved.
- No portability of provider credentials, provider profiles, or permission settings — those are machine-local by design.
- No new sandbox. `execute_code` reuses the one that already exists.
- No change to external MCP behavior. This change widens who can reach these operations, not what they do.

## Decisions

### 1. One command that toggles, decided from observed panel state

A single toggle command rather than separate open and close bindings: the user's intent is "show me the assistant" and "get it out of the way", and two bindings for one surface is a worse trade than one binding that reads state.

The state it reads must be the panel's actual state for the active tab, not a flag this extension keeps. A remembered flag drifts the moment the user closes the panel by any other means, and the first press after that drift does the opposite of what the user wanted.

The handler must call `open()` synchronously within the command event, because the gesture requirement is not satisfied after an `await`. Anything the decision needs must therefore be available without awaiting, or the open path must be taken first and corrected after — never the reverse, since a wrongly-closed panel is worse than a wrongly-opened one.

Alternative considered: `_execute_action`, the reserved command that fires the toolbar action. Rejected because the action's own behavior is already bound to opening the panel and cannot express the toggle.

### 2. The suggested binding is a suggestion, and the spec treats it as one

A suggested key can be refused: the browser may have it, another extension may hold it, or the user may clear it. The spec therefore requires the panel to stay reachable by its existing controls and the command to show as unbound, rather than assuming the binding exists. `Ctrl+E` specifically collides with a browser-level shortcut on some platforms — the suggestion is worth making, and worth not depending on.

### 3. The two added operations reuse their existing implementations

`execute_code` is exposed to the panel by registering the existing sandbox entry point in the SDK registry, not by writing a second sandbox. The spec requires matching result, error and image shapes precisely so this stays one implementation with two callers.

`recording_ack` becomes acceptable from the panel's agent by widening the existing handler's accepted source rather than adding a parallel acknowledgement path, so delivery is still recorded exactly once.

### 4. Both additions carry an explicit classification

`add-permission-modes-and-threat-signals` makes an unclassified operation resolve to protected and adds a registry coverage check that fails on a classification gap. Adding two operations without entries would therefore either break that check or silently make them protected by fallback.

Deciding rather than defaulting: `execute_code` runs arbitrary code and belongs with the operations that already gate on that basis, not with the ones that merely touch a page. `recording_ack` reports a fact back and changes no page or browser state. Both entries are explicit, and the coverage check is what keeps a future addition from slipping through unclassified.

This change depends on that one for the check to exist; it does not depend on it for the classification entries themselves.

### 5. The bundle is one file over the existing directory layout

Export reads the conversation directory as it already is and writes one file; import reverses it. No new on-disk representation for local conversations, so a bundle is a transport format, not a second source of truth.

The format carries its own version because an import on another machine may meet a bundle written by a different build. An unsupported version is refused by name rather than parsed optimistically.

### 6. Exclusion of secrets is a property of the export, not of the user's care

The spec forbids credentials in a bundle regardless of where they appear in the source, including inside the transcript. That is deliberately stronger than "the transcript happens not to contain any": a bundle is made to be sent to someone, and the moment it leaves the machine there is no recovering from a value that should not have been in it.

A redaction is recorded in the bundle so the reader can tell redacted content from content that never existed — the same honesty rule the panel's timeline already follows for sensitive input.

### 7. An imported conversation continues as a new run, and says so

The provider session reference cannot move: it belongs to the exporting machine's provider account and session. Rather than failing a resume or quietly starting something the user thinks is a resume, the spec requires that an imported conversation is continued as a new run and that no surface offers resuming the original.

This is the honest shape of the limit. Hiding it would produce exactly the class of failure the runtime's existing session-continuity requirement already forbids: work that looks continued but is not.

### 8. Closing the list/delete gap is part of this change, not a prerequisite left to someone else

Export and import operate on a conversation list the companion cannot currently produce. The message types and the manager methods both exist; only the handlers are missing. `extension/sidepanel/history-store.js` carries a long comment describing this gap and the honest degradation it chose — that comment must be corrected when the gap closes, or it becomes documentation of a state that no longer exists.

## Risks / Trade-offs

- **The toggle reads stale panel state and does the opposite of what the user wanted** → State comes from the browser for the active tab rather than a remembered flag, and the open path is preferred when the state is genuinely unknown.
- **The suggested binding collides and the user thinks the feature is broken** → The command surfaces as unbound in the browser's own shortcut page, the existing controls keep working, and the spec requires the unbound case to be visible rather than silent.
- **`execute_code` reaching the panel widens who can run sandboxed code** → It is registered with an explicit classification alongside the operations already gated for the same reason, and the permission work in the companion change is what decides whether a given call asks. The sandbox itself is unchanged.
- **A bundle is shared and carries something it should not** → Credentials and profile data are excluded structurally, transcript-level secrets are redacted with the redaction recorded, and the export surface states what the bundle contains before it is produced.
- **An import overwrites a local conversation** → A colliding identity is reported as a conflict and the existing conversation is never overwritten; merging is explicitly out of scope.
- **An imported bundle is treated as trusted content** → Import executes nothing, dispatches no browser action, and applies no setting. The imported transcript is data, exactly as page content is.
- **Two unarchived changes touch the same capability** → This change adds requirements to `agent-browser-runtime` rather than modifying its baseline requirement, which `implement-stubbed-browser-tools` already has a pending delta against. Additive deltas from the two changes do not collide at archive time.

## Migration Plan

1. Add the companion handlers for listing and deleting conversations, and correct the panel's obsolete gap comment. Nothing user-visible changes yet beyond a list that now works.
2. Add the keyboard command. Independent of everything else here.
3. Register the two operations with explicit classifications, and record them in the post-baseline additions set.
4. Add export, then import. Export first, so a bundle exists to test import against.

Rollback: the four steps are independent and revertible in any order. Reverting step 4 leaves a working list; reverting step 3 returns the registry to its current set.

## Open Questions

- The suggested key for the command. The spec requires only that a binding is suggested, is rebindable, and degrades visibly when unavailable — any suggestion satisfying that is acceptable, and the concrete key is worth choosing against the shortcuts the target browsers actually reserve.
