## 1. Fix the destructive conversation-metadata migration (ships first, alone)

- [ ] 1.1 Rewrite `migrateConversationMetadata()` in `host/agent/storage/conversation-metadata.js` so an envelope of an older known version is carried forward field by field (`appProfile`, `sessionSchemaIdentity`, `permissionPolicy`, `sdkSessionRef`, `budgetPolicy`, `lifecycle`, `usageEpoch`, `migrationState`) instead of being rebuilt from scratch; only genuinely-new fields are defaulted. Keep the existing legacy `skillsBinding` backfill path for envelopes that have no `schemaVersion` at all.
- [ ] 1.2 Add `primaryAgent: null` to `initConversationMetadataEnvelope()` and bump `CONVERSATION_METADATA_SCHEMA_VERSION` to `2`.
- [ ] 1.3 Add `host/test/conversation-metadata-migration.test.mjs` proving a v1 envelope carrying a populated `sdkSessionRef`, a non-default `budgetPolicy` and a non-zero `usageEpoch` migrates to v2 with all three intact and `primaryAgent === null`; and that a legacy envelope with no `schemaVersion` still backfills exactly as before. ← (verify: run the test and confirm `sdkSessionRef` survives — without this, resume silently breaks for every existing conversation)

## 2. Agents catalog storage and validation (host)

- [ ] 2.1 Create `host/agent/agents/paths.js`: `agentsRoot()` = `<agentRoot()>/agents`, `snapshotsDir()`, `snapshotDir(name)`, `catalogFile()`, `ensureAgentsRoot()` (with `0o700` on non-Windows), and `assertSafeSegment()` re-validation at point of use — mirroring `host/agent/skills/paths.js` without importing it.
- [ ] 2.2 Create `host/agent/agents/errors.js` with named error classes/codes for validation, not-found, capability refusal and snapshot mismatch, mirroring `host/agent/skills/errors.js`.
- [ ] 2.3 Create `host/agent/agents/catalog-store.js`: `loadCatalog()`, `saveCatalog()`, `getAgentRecord()`, `upsertAgentRecord()`, `removeAgentRecord()`, using write-to-temp-then-rename, mirroring `host/agent/skills/catalog-store.js`.
- [ ] 2.4 Create `host/agent/agents/frontmatter.js`: parse `AGENT.md`-style frontmatter (`name`, `description`, `model`, `tools`, `skills`, `max-turns`) plus the markdown body as the prompt; reuse the skills catalog's `NAME_PATTERN` and traversal rejection; reject anything it cannot confidently parse with a named error identifying the field. No YAML dependency.
- [ ] 2.5 Enforce the bounded ceilings design.md's Risks section requires: a per-agent prompt byte ceiling and a maximum enabled-agent count, each rejected at import/author time with a specific error naming the limit and the actual value.
- [ ] 2.6 Add `host/test/agents-catalog-validation.test.mjs` covering: traversal in a name, a missing `name`/`description`, an empty body, an unclosed frontmatter block, an over-ceiling prompt, and an over-count enable — each rejected with no file or directory created and the catalog unchanged. ← (verify: every rejection path leaves zero filesystem residue and a byte-identical catalog file)

## 3. Import, author and lifecycle (host)

- [ ] 3.1 Create `host/agent/agents/import.js`: `importAgent(sourcePath)` / `refreshAgent(name)` that read and copy only (never execute or evaluate), hash the source, and stage-then-swap the snapshot with rollback on failure, mirroring `host/agent/skills/import.js`.
- [ ] 3.2 Create `host/agent/agents/author.js`: `authorAgent(fields)` producing a record and snapshot indistinguishable in every run-affecting field from an imported one, differing only in recorded origin.
- [ ] 3.3 Create `host/agent/agents/manage.js`: `listCatalog()` (returns every entry with its `enabled` flag), `getAgent()`, `enableAgent()`, `disableAgent()`, `removeAgent()` (deletes entry + snapshot, never the operator's source).
- [ ] 3.4 Create `host/agent/agents/index.js` as the public facade, mirroring `host/agent/skills/index.js`.
- [ ] 3.5 Add `host/test/agents-lifecycle.test.mjs` proving: an edited/deleted source file does not change the stored agent; removal deletes entry + snapshot and leaves the source untouched; an imported and an authored agent with equal fields resolve to equal effective definitions. ← (verify: snapshot immutability holds against source mutation — this is the guarantee that keeps a run reproducible)

## 4. Resolution: intersection, floor, skills, model (host)

- [ ] 4.1 Create `host/agent/agents/resolve.js` exporting a pure `resolveAgentDefinitions({ records, runAllowance, allowedSkillNames, profileModels, profileModelId })` returning `{ definitions, notices }` — no filesystem, no network, no SDK import, so it is fully testable offline.
- [ ] 4.2 Implement the tool intersection per design D2: `declared ∩ runAllowance` (or `runAllowance` when nothing is declared); every name in `declared \ runAllowance` is dropped and returned as a notice, never forwarded.
- [ ] 4.3 Implement the permission floor: every emitted definition's `disallowedTools` always contains every `HIGH_RISK_BUILTINS` entry, written by this code; a declared high-risk tool is additionally returned as a refusal notice.
- [ ] 4.4 Implement skill resolution per design D3: match declared skill names against `allowedSkillNames` by bare-name normalization, emit the qualified form, drop and report anything not in the run's approved snapshot.
- [ ] 4.5 Implement model resolution per design D4: no declaration → explicit `'inherit'`; declared and present in the profile's model list → emit it; declared and absent → `'inherit'` plus a fallback notice naming the agent, the declared model and the model used. Never cache the resolution in the catalog record.
- [ ] 4.6 Emit only the whitelisted `AgentDefinition` fields (`description`, `prompt`, `tools`, `disallowedTools`, `model`, `skills`, `maxTurns`); never `mcpServers`, `background`, `initialPrompt` or `criticalSystemReminder_EXPERIMENTAL`.
- [ ] 4.7 Add `host/test/agents-resolve.test.mjs` asserting, for a record declaring an out-of-allowance tool, a high-risk tool, an unapproved skill and an unavailable model: the emitted definition names no tool outside `runAllowance`, lists every `HIGH_RISK_BUILTINS` entry as disallowed, names no unapproved skill, uses `'inherit'`, and returns one notice per refusal. ← (verify: the permission boundary is proven by the emitted object alone, with no SDK and no model in the loop)

## 5. Wire `Options.agents` into the run (host)

- [ ] 5.1 Add an optional `agents` parameter to `buildIsolatedOptions()` in `host/agent/tools/query-options.js`; compute `runAllowance` from the same `qualifiedBrowserToolNames`/`extraToolNames` arrays the function already builds (no second derivation) and call `resolveAgentDefinitions()`.
- [ ] 5.2 Emit `Options.agents` only when at least one definition results; when there are none, the `agents` key MUST be absent from the returned options object entirely.
- [ ] 5.3 Append the selected primary agent's prompt as a third element of the existing `systemPromptText` array, after the browser-automation and page-context blocks — never replacing either.
- [ ] 5.4 Fold the emitted agent set into `buildPermissionPolicyIdentity(options)` so `assessResumeCompatibility()` treats a changed agent set as an incompatibility and starts a fresh SDK session instead of resuming under stale definitions.
- [ ] 5.5 Add `host/test/query-options-agents.test.mjs` asserting: (a) with no agents the returned options object is deep-equal to the pre-change options object and has no `agents` key; (b) with agents, `systemPrompt` still contains the browser-automation text and the page-context block; (c) the permission-policy identity changes when the agent set changes. ← (verify: (a) is the proof that this change is additive — a no-agent run must be byte-identical to today)

## 6. Companion, protocol and per-conversation selection (host)

- [ ] 6.1 Add the `agents_list`, `agents_import`, `agents_author`, `agents_refresh`, `agents_enable`, `agents_disable`, `agents_remove` and `conversation_set_agent` message kinds to `host/agent/protocol.js` validation, additively — no existing envelope shape changes.
- [ ] 6.2 Add the matching handlers to `host/agent/companion.js`'s dispatch switch, in the same shape as the existing `skills_*` cases.
- [ ] 6.3 Persist and read the conversation's `primaryAgent` through `host/agent/session/manager.js` onto the versioned metadata envelope; selecting no agent is a first-class stored state.
- [ ] 6.4 At run start, read the conversation's `primaryAgent`, load the enabled catalog, and pass records plus the profile's model list into `buildIsolatedOptions()`. A selected agent that has been disabled or removed falls back to no-agent with a notice and does not fail the run.
- [ ] 6.5 Emit the resolution notices (dropped tool, refused high-risk tool, unapproved skill, model fallback, missing selected agent) onto the run's existing event stream as notices, never as `run_error`.
- [ ] 6.6 Bind the run's definitions at run start so enabling/disabling/removing mid-run cannot alter a run already executing.
- [ ] 6.7 Add `host/test/agents-protocol.test.mjs` asserting the new kinds validate, existing envelopes are unchanged, and an unrecognized kind still yields `unknown_message_type`. ← (verify: additive-only — replay a pre-change envelope corpus and confirm identical acceptance)

## 7. Settings > Agents surface (extension)

- [ ] 7.1 Create `extension/settings/agents.html` mirroring `extension/settings/skills.html`, reachable by URL from the existing settings surface. Do NOT edit `extension/manifest.json`; if a manifest entry proves genuinely necessary, stop and surface it as a blocker.
- [ ] 7.2 Create `extension/settings/agents-client.js` (wire calls), `agents-controller.js` (state/lifecycle) and `agents-app.js` (rendering), mirroring the `skills-*` trio.
- [ ] 7.3 Render list, import, author, enable, disable, refresh and remove, showing each entry's origin, declared model, declared tools and enabled state.
- [ ] 7.4 Show every rejection with its specific reason and offending field — an invalid name, an unparseable file, a dropped tool, a refused high-risk tool, an unresolvable model, an exceeded ceiling. No silent no-ops.
- [ ] 7.5 Meet WCAG 2.1 AA contrast and full keyboard operability on every control added here. ← (verify: keyboard-only walkthrough of import → author → enable → remove, and a contrast check on every new token pairing)

## 8. Panel picker and truthful reporting (extension)

- [ ] 8.1 Create `extension/sidepanel/agents-client.js` and `agents-model.js` mirroring `skills-client.js` / `skills-model.js`.
- [ ] 8.2 Add the picker markup, styles and handlers in `extension/sidepanel/sidepanel.html`, `sidepanel.css`, `sidepanel.js` and `panel-controller.js`. Do NOT edit `extension/background.js` (it already relays agent envelopes verbatim) or `extension/sidepanel/tool-labels.js`.
- [ ] 8.3 Show the current selection inline without opening the control, in every state where a message can be composed; include an explicit "no agent" choice; when the catalog is empty, state that and offer a route to the Settings page.
- [ ] 8.4 Announce selection changes through the panel's existing polite live region, and keep the control fully keyboard-operable.
- [ ] 8.5 Render the run's agent in the transcript, and render the model-fallback and missing-agent notices from task 6.5 where the operator will see them.
- [ ] 8.6 Ensure each submitted message keeps the agent identity in effect at submission; changing the selection must not re-attribute earlier messages.
- [ ] 8.7 State the per-model (not per-agent) attribution limit on the usage surface shown alongside agents; present no per-agent cost or token figure.
- [ ] 8.8 Verify the picker at 320px panel width: visible, legible, operable, and causing no horizontal scroll of the panel body. ← (verify: 320px rendering plus a keyboard-only selection change that is announced by the live region)

## 9. Documentation and final verification

- [ ] 9.1 Add an itemized AI Agents section to `README.md` in the existing evidenced style: what an agent definition carries, which SDK fields are forwarded and which are deliberately not, that agents narrow authority and never widen it, and that usage attribution is per model rather than per agent. Do not alter the 28-tool registry claim — no registry tool is added by this change.
- [ ] 9.2 Confirm the external-MCP path is untouched: `host/tool-runtime.js`, `host/mcp-server.js` and `host/codemode/server-*.js` show no diff.
- [ ] 9.3 Confirm none of the concurrent session's files were modified: `extension/background.js`, `extension/manifest.json`, `extension/sidepanel/tool-labels.js`, `host/tool-definitions.js`, `host/agent/tools/mapping.js`, `host/package.json`, `host/npm-shrinkwrap.json`, `test/fixtures/registry-baseline.json`, `test/registry-baseline.test.mjs`, `test/registry-sdk-mapping.test.mjs`, `test/webfetch-url-guard.test.mjs`, `extension/webmcp/`, `test/fixtures/webmcp/`.
- [ ] 9.4 Run the full host test suite and the repo's `test/` suite; fix regressions in files this change owns and report — do not edit or delete — any failure originating outside them. ← (verify: full suite green except for pre-existing failures in unowned files, each named explicitly with its output)
