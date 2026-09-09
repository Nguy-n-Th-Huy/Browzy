## Why

The composer's slash picker offers an invocation the runtime cannot honour. Selecting `/marketing-research` from the picker inserts that exact text, the companion's application-side authorization gate approves it (the skill is imported, enabled, and user-invocable), and then the run fails with the SDK's own `Unknown command: /marketing-research`. The picker promises something the SDK never agreed to.

The cause is a mismatch between how this product loads skills and how a leading `/` is interpreted. `buildSessionSkills()` materializes approved snapshots into `${cwd}/.claude/skills/<name>/`, but every `query()` in this codebase passes `settingSources: []` (`host/agent/tools/query-options.js`), so the SDK never scans that tree as a command source. The `skills` option that *is* passed is, by the SDK's own documentation, "a context filter, not a sandbox" — it decides which skills the `Skill` tool may reach, not which names become slash commands. So a validated slash dispatch travels to the model as ordinary prompt text beginning with `/`, lands in the SDK's own slash-command namespace, and is rejected.

Separately, `BUILTIN_COMMANDS` in `extension/sidepanel/skills-model.js` is an empty placeholder, so the picker has never offered a single built-in command. The `agent-skills` spec already requires built-ins "limited to commands supported by the selected SDK version and permitted by the application", and the SDK already publishes exactly that list at runtime (`slash_commands` on the `system`/`init` message, with `terminal_slash_commands` marking the terminal-bound subset). Nothing in this codebase reads either field today.

## What Changes

- A validated slash dispatch that names a **skill** is translated by the companion, after the authorization gate passes, into an explicit instruction that drives the SDK's `Skill` tool. The panel's composer text and the conversation transcript keep the operator's literal `/name …` text; only the prompt handed to `query()` carries the translation, and the translation is a fixed, inspectable shape rather than a rewrite of the operator's words.
- The approved skill snapshots the application already copies into each conversation's session workspace become **discoverable** by the SDK, by materializing them as a **local plugin** (the same mechanism this repository already uses to ship itself as a Claude Code plugin) and loading it by absolute path through the SDK's `plugins` option, with `skipMcpDiscovery: true`. This corrects a false assumption this proposal originally made — first that translating the dispatch alone would be sufficient, and then, after that was disproven, that adding `'project'` to `settingSources` would be the fix: `'project'` was proven (task group 5's executable sentinel test) to walk up the ancestor directory tree with no repo-root gating at all, so it would have exposed every `.claude/skills/` directory above the session workspace, including the operator's own global skill collection, to every run. `settingSources` therefore stays `[]` — untouched — and discovery goes through `plugins`' explicit, non-walking path instead. The operator's own global configuration source (`'user'`) is **not** enabled — now satisfied more strongly than originally planned, since no setting source is enabled at all — and the change does not ship unless an executable test proves no directory above the session workspace contributes anything to a run.
- The application-approved built-in allowlist is **empty**. The SDK's real advertised list for this configuration contains no `cost` command, so approving it would leave the built-in section permanently and silently empty. The discovery machinery, the persisted record and the read operation all stay — what is empty is the approval, not the mechanism, and both allowlist constants say so.
- The companion records the SDK's advertised slash-command list from the `system`/`init` message, observed in **both** places this product already starts a real `query()`: a conversation run and the Settings connection test. The list is persisted so it survives a companion restart, and is served to the panel through a new read-only settings operation.
- The picker's built-in commands become the intersection of (a) what the SDK advertised at runtime, minus the terminal-bound subset, and (b) an application-approved allowlist. Nothing is hardcoded as "the SDK supports this" — a command the advertised list never mentions yields no built-in entry, honestly.
- A built-in command that passes the authorization gate reaches the SDK **untranslated** — the translation applies only to skills. The gate itself is widened to recognise an approved built-in as a legitimate dispatch target instead of rejecting it as an unknown skill.
- **BREAKING for nothing shipped**: no wire message type is removed or changed in shape; the new settings operation is additive.

**Out of scope, deliberately:**
- Enabling any `settingSources` entry, or any change to `buildIsolatedOptions()` beyond the single `plugins` entry: the browser tool set, MCP servers, `strictMcpConfig`, `disallowedTools` and the WebFetch guard all stay exactly as they are.
- Approving any built-in command. `/cost` was approved and then withdrawn once the SDK's real advertised list turned out not to contain it; `/compact`, `/context`, `/clear`, and `/model` were considered and explicitly not approved (`/clear` and `/model` duplicate panel-owned surfaces).
- Redesigning the composer or the picker's visual affordances.

**Incidental cleanup carried by this change:** the comment above `autoGrow()` in `extension/sidepanel/sidepanel.js` still cites `min(240px, 40vh)` as its illustrative cap after that cap became `min(160px, 40vh)`. The comment is now false and is corrected here.

## Capabilities

### New Capabilities

None. Slash dispatch and the picker already belong to an existing capability.

### Modified Capabilities

- `agent-skills`: the "Searchable slash picker" requirement gains the behaviour that a picker-inserted skill invocation actually runs, that Tab accepts an entry, and that built-in commands are sourced from the SDK's runtime-advertised list intersected with an application allowlist rather than from a static list. The "Disabled or unknown manual command" requirement is clarified so an approved built-in is not treated as an unknown skill.

## Impact

**Native host**
- `host/agent/skills/dispatch.js` — a builder that turns a validated skill dispatch into the `Skill`-tool instruction, naming the skill by its plugin-qualified canonical name (the form the `Skill` tool actually resolves — an empirical finding, not an assumption); the authorization gate widened to accept an approved built-in.
- `host/agent/skills/session-workspace.js` — `buildSessionSkills()` materializes the session's approved skill snapshots as a local plugin directory (a manifest plus a `skills/` subdirectory) instead of a bare `.claude/skills/` tree, and returns the plugin's absolute path alongside its existing return values. The plugin's `name` is a fixed constant, never derived per conversation.
- `host/agent/tools/query-options.js` — `buildIsolatedOptions()` gains a `plugins` entry pointing at that plugin path, with `skipMcpDiscovery: true` (this product owns its own MCP connections). `settingSources` stays `[]`, unchanged.
- New module for the advertised-command record (read/write, atomic persistence, reusing `host/agent/settings/atomic-store.js`'s `writeJsonAtomic`).
- `host/agent/companion.js` — apply the translation before `_runQuery`; observe `system`/`init` and record the advertised list; a new read-only `agent_settings` operation serving that list.
- `host/agent/settings/capability-test.js` — record the advertised list from the init message it already observes.

**Extension panel**
- `extension/sidepanel/skills-client.js` — read the advertised list.
- `extension/sidepanel/skills-model.js` — the approved allowlist and the intersection that replaces the empty `BUILTIN_COMMANDS`.
- `extension/sidepanel/sidepanel.js` — fetch the advertised list alongside the skill catalog; correct the stale `autoGrow()` comment.

**Not affected**
- `host/agent/tools/query-options.js`'s `skills`, `skillOverrides`, tool sets, MCP wiring, WebFetch guard and `settingSources` (stays `[]`) — unchanged apart from the one added `plugins` entry; comments there that asserted `settingSources: []` as the whole isolation story are corrected to also name the plugin mechanism.
- `extension/background.js` — its `agent_settings` relay is operation-agnostic and forwards any op unchanged.
- `host/agent/skills/manage.js`, `import.js` — catalog mechanics are correct as they stand and are not touched by the plugin-materialization change to `session-workspace.js`.

**Tests**
- Plain-Node tests per `test/README.md`: the dispatch translation and the widened gate; the advertised-command record's persistence and its merge/allowlist filtering; the panel's built-in intersection; a companion-level test that a picker-inserted skill invocation reaches `query()` in translated form while an approved built-in reaches it verbatim.

**Docs**
- README.md's "Side panel status" entry for the slash picker, if it claims behaviour this change alters.
