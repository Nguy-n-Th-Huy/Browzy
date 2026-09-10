## Context

See `proposal.md` — Why. The design-relevant current state:

- **One call site.** Every side-panel run builds its options exactly once, at `host/agent/companion.js:1616`, via `buildIsolatedOptions()` (`host/agent/tools/query-options.js:562`). There is no second path to `query()` for a run, so `Options.agents` has exactly one place to be produced.
- **The SDK field exists and is programmatic.** `Options.agents?: Record<string, AgentDefinition>` (`sdk.d.ts:1441`); `AgentDefinition` (`sdk.d.ts:38`) = `{ description, prompt, tools?, disallowedTools?, model?, mcpServers?, skills?, initialPrompt?, maxTurns?, background?, criticalSystemReminder_EXPERIMENTAL? }`. `sdk.d.ts:2129` states that `strictMcpConfig` ignores "on-disk agent frontmatter" — i.e. the runtime *does* have a disk-discovery path for agents, and this design must never open it.
- **`Task` is already live.** It is in both `tools` and `allowedTools` (`query-options.js` ~line 170), deliberately: "`Task` spawns a subagent inside this same sandboxed run (no new external capability)". Today it can only reach the SDK's built-in general-purpose subagent because no `agents` key is passed.
- **The skills catalog is a working precedent for everything the agents catalog needs**: `paths.js` (agent-home rooted layout, `assertSafeSegment` re-validation at point of use, `0o700` on non-Windows), `catalog-store.js` (write-to-temp-then-rename), `frontmatter.js` (dependency-free flat-YAML subset, `NAME_PATTERN`, reject-don't-guess), `import.js` (`stageAndSwap` with rollback), `manage.js` (enable gate that refuses unsupported capabilities), `errors.js` (named error codes), `index.js` (facade). Wire handlers `skills_*` at `companion.js:960-1003`.
- **Isolation is load-bearing and previously breached.** `settingSources: []` stays `[]` because adding `'project'` was empirically proven to walk the entire ancestor tree (`plans/reports/blocker-260909-0712-project-settingsource-walkup-leak.md`). `CLAUDE_CONFIG_DIR` is pinned per session because without it the SDK's CLI subprocess wrote into the operator's real `~/.claude`.
- **Skill names reaching the SDK are plugin-qualified**, not bare: `buildSessionSkills()` returns `allowedSkillNames` already qualified (`session-workspace.js:182`).
- **`migrateConversationMetadata()` is destructive by construction** (`conversation-metadata.js:407-424`): for any envelope whose `schemaVersion` is not the current constant, it *rebuilds from scratch*, discarding `appProfile`, `permissionPolicy`, `sdkSessionRef`, `budgetPolicy` and `usageEpoch`. Dropping `sdkSessionRef` breaks resume. This constrains how the per-conversation agent selection may be persisted.
- **A concurrent session holds uncommitted work** in `extension/background.js`, `extension/manifest.json`, `extension/sidepanel/tool-labels.js`, `host/tool-definitions.js`, `host/agent/tools/mapping.js`, `host/package.json`, `host/npm-shrinkwrap.json` and several `test/*.mjs` files. This design must reach `Options.agents` and the panel without editing any of them.

## Goals / Non-Goals

**Goals:**

- One computation, at one place, that turns the enabled catalog plus the run's own allowance into `Options.agents` — so availability and authority can never drift apart, exactly as `qualifiedBrowserToolNames` already guarantees for `tools`/`allowedTools`.
- Make the permission floor a property of *our* code, testable without a live model.
- Reuse the skills catalog's structure rather than re-deriving it, so one reviewer's understanding covers both.
- Keep a no-agent-selected run byte-identical to today's options object, so the change is provably additive.

**Non-Goals (design level, beyond the proposal's scope statement):**

- No shared module extracted from `host/agent/skills/*` for the two catalogs to share. They are deliberately parallel-but-separate, for the same stated reason `skills/paths.js` refuses to import `storage/paths.js`: a concurrent edit to one must not silently change the other. Duplication of ~40 lines of layout/atomic-write logic is the accepted price.
- No `mcpServers`, `background`, `initialPrompt` or `criticalSystemReminder_EXPERIMENTAL` on emitted definitions. `mcpServers` is the field `strictMcpConfig`'s docstring says agent definitions *can* use to introduce servers — the one field on `AgentDefinition` that is capability-widening by design — and is therefore never emitted. `background: true` is excluded by the proposal's non-goals.
- No per-agent usage attribution (see Decision 8).

## Decisions

### D1. Emit `Options.agents` inside `buildIsolatedOptions()`, from a new `agents` parameter

`buildIsolatedOptions()` gains one optional parameter, `agents` (an array of resolved catalog records plus the run's own resolution context), and emits `Options.agents` from it. Omitted or empty ⇒ the key is **absent from the options object entirely**, not present-and-empty — so a no-agent run is byte-identical to today and the "additive" claim is checkable by object comparison in a test.

The intersection (D2) is computed *here*, not in `companion.js`, because this is the only place that holds `qualifiedBrowserToolNames` and `extraToolNames` — the arrays that define what the run actually holds. Computing it anywhere else would mean re-deriving the allowance, which is precisely the drift `query-options.js`'s own header warns about ("availability and auto-approval can never drift apart because both read the one array").

*Alternative rejected:* have `companion.js` build complete `AgentDefinition` objects and pass them through opaquely. Rejected — `companion.js` does not know the qualified tool names, so it would have to import and re-run `sdkQualifiedToolNames()`, creating a second derivation of the allowance.

### D2. The tool allowance is an intersection computed by us, with a floor we write ourselves

For each enabled agent:

```
effectiveTools  = declared.length ? declared ∩ runAllowance : runAllowance
droppedTools    = declared \ runAllowance          → reported, never forwarded
disallowedTools = HIGH_RISK_BUILTINS ∪ (declared ∩ HIGH_RISK_BUILTINS)
```

where `runAllowance = qualifiedBrowserToolNames ∪ extraToolNames ∪ { WebSearch, WebFetch, Task }` — the same names this function already writes into `tools`.

Two independent reasons this is not redundant with the SDK's own behavior:

1. `AgentDefinition.tools`' docstring says "If omitted, inherits all tools from parent" — it describes *inheritance*, not intersection, and says nothing normative about a declared name the parent lacks. Relying on unstated behavior for a permission boundary is exactly the posture this project rejects elsewhere.
2. `HIGH_RISK_BUILTINS` is currently enforced by the top-level `disallowedTools`. Writing it into every agent's own `disallowedTools` as well makes the floor hold under any SDK precedence rule, including one where a definition's `tools` is read as an additive grant. Cost: one array literal per agent. Benefit: the guarantee stops depending on an SDK implementation detail.

A dropped or refused declaration is surfaced through the run's existing event stream (a notice, not a `run_error`) — the run starts, narrowed, and the operator is told. Silently narrowing would be a capability lie; failing the run would make one bad catalog entry block the product.

*Alternative rejected:* trust `AgentDefinition.tools` as declared and rely on `authorizeToolCall()` to reject at dispatch. Rejected — that is a correct *last* line of defense (and stays in force) but it turns a static, testable boundary into a runtime one, and the model would still see and attempt tools it can never use.

### D3. Skill names on an agent definition are resolved against the run's own qualified list

`AgentDefinition.skills` takes skill names. The SDK's `skills` option receives **plugin-qualified** names from `buildSessionSkills()` (`session-workspace.js:182`), not bare ones. An agent record's declared skills are therefore matched against `skills.allowedSkillNames` by bare-name comparison (the same `bareSkillName()` normalization `assertCanonicalSkillResourcePath()` already uses) and emitted in their **qualified** form. A declared skill that is not in the run's approved snapshot is dropped and reported, by the same rule as D2 — an agent must not be able to preload a skill the conversation has not approved.

### D4. Model resolution happens per run, against the active profile, and never silently substitutes

`AgentDefinition.model` accepts `'inherit'`, an alias, or a full model id. This project supports arbitrary Anthropic-compatible gateways, so no model name is universally valid. Resolution order per run:

1. No declaration ⇒ emit `model: 'inherit'` (explicitly, not by omission — `sdk.d.ts:38`'s docstring says an omitted `model` falls back to "the default subagent model when one is configured", which is a configuration this project does not control; `'inherit'` is the only value that provably means "the run's model").
2. Declared and present in the active profile's validated model list (`host/agent/settings/profile.js`'s `loadProfile()` / `host/agent/settings/named-profiles.js` — the same list Settings renders) ⇒ emit it.
3. Declared and absent ⇒ emit `'inherit'` **and** emit a stream notice naming the agent, the declared model and the model used.

Resolution is per run, never cached in the catalog record, so switching profiles re-resolves (spec scenario "Switching profiles re-resolves the declaration").

*Alternative rejected:* probe the endpoint with `testCapability()` at import time. Rejected — it costs a network round trip per import, its result is stale the moment the profile changes, and a gateway may accept a model it does not advertise. The profile's declared model list is the operator's own stated truth and is what every other surface already uses.

### D5. The agent's prompt composes; the run's system prompt is never replaced

`AgentDefinition.prompt` is a *subagent* system prompt — it does not replace `Options.systemPrompt`, which continues to carry `renderBrowserAutomationSystemPrompt()` + `renderPageContextSystemPrompt()` for the main thread. For the **primary** agent the panel selects, the agent's prompt is appended to the run's `systemPromptText` (a third element in the existing `.filter(Boolean).join("\n\n")` array), *after* the browser-automation and page-context blocks, so a prompt that contradicts them is read as an addition, not an override. The same record is also emitted into `Options.agents` so the model can delegate to it by name.

### D6. Persist the selection without breaking resume

`conversationMetadata` gains `primaryAgent: { name, boundAt } | null`. Because `migrateConversationMetadata()` currently *discards* every field when the version does not match, bumping `CONVERSATION_METADATA_SCHEMA_VERSION` to 2 as it stands would wipe `sdkSessionRef` for every existing conversation and silently break resume for all of them. The version **is** bumped to 2 — the envelope's shape genuinely changed and lying about the version is worse — and `migrateConversationMetadata()` is fixed at the same time to carry forward the v1 fields it can read (`appProfile`, `sessionSchemaIdentity`, `permissionPolicy`, `sdkSessionRef`, `budgetPolicy`, `lifecycle`, `usageEpoch`) rather than rebuilding from scratch, defaulting only genuinely-new fields. A v1→v2 migration test asserting `sdkSessionRef` survives is a required task, not an optional one.

This is a real, pre-existing latent defect this change is obliged to fix rather than route around: any future field addition would have hit it. Fixing it is in scope precisely because this change is the first to trip it.

*Alternative rejected:* store the selection outside the envelope (a sibling key on the conversation meta) to dodge the version bump. Rejected as a workaround — it leaves the destructive migration armed for the next change and splits conversation state across two homes.

### D7. `agents_*` wire messages mirror `skills_*` exactly

`agents_list | agents_import | agents_author | agents_refresh | agents_enable | agents_disable | agents_remove`, plus `conversation_set_agent` for the selection, added to `host/agent/protocol.js`'s validation and dispatched in the same `switch` shape as `companion.js:960-1003`. Purely additive: no existing envelope changes, and an older companion already answers an unrecognized kind with `unknown_message_type` (`companion.js:198-202`) — fail-closed, already implemented, nothing new needed.

### D8. Usage attribution is stated, not invented

`usage-ledger.js` already counts delegated work correctly: it diffs cumulative `modelUsage`, which includes `Task` subagents, precisely because the SDK's aggregate `usage` excludes them (its own header, citing gate-0.2 evidence G8). No change is needed for delegated consumption to be counted. But `modelUsage` is keyed by **model**, and the SDK exposes no per-agent breakdown — so per-named-agent cost cannot be derived, and this change does not derive one. Two agents on the same model are indistinguishable in the ledger. The UI states this; it does not display a plausible-looking split.

### D9. Avoiding the concurrent session's files

- **Panel wiring**: the picker lives in new `extension/sidepanel/agents-{client,model}.js` plus markup/handlers in `sidepanel.js` / `panel-controller.js` / `sidepanel.css` — none of which the other session holds. `extension/background.js` needs **no** change: it already relays every agent envelope verbatim in both directions (established by the `agent-created-document-artifacts` change, whose proposal states exactly this).
- **Settings page**: `extension/settings/agents.html` + `agents-{app,client,controller}.js` are new files. `manifest.json` is **not** edited — the Settings page is opened by URL from the existing settings surface, the same way `skills.html` is reachable, not by a new manifest entry. If implementation discovers a manifest entry is genuinely required, that is a **blocker to surface**, not a file to edit.
- **Tool labels**: no entry is added to `extension/sidepanel/tool-labels.js`. A delegated `Task` call already renders with its existing generic label; giving it an agent-specific label is deliberately deferred rather than colliding with in-flight work. This is a named, accepted cosmetic gap.
- **Registry**: no registry tool is added, so `host/tool-definitions.js`, `host/agent/tools/mapping.js` and every `registry-baseline` fixture are untouched, and the 28-tool count in `README.md` is unaffected.
- **Dependencies**: `frontmatter.js` is reused/duplicated rather than pulling in a YAML library, so `host/package.json` and `host/npm-shrinkwrap.json` need no change.

## Risks / Trade-offs

- **The SDK could apply a definition's `tools` as a grant rather than a filter** → D2's own intersection plus a per-agent `disallowedTools` floor means the boundary holds regardless; a test asserts the emitted definition never names a tool outside the run's allowance and always names every `HIGH_RISK_BUILTINS` entry as disallowed.
- **The version bump in D6 touches every existing conversation** → the migration is made non-destructive in the same task and covered by a v1→v2 test asserting `sdkSessionRef`, `budgetPolicy` and `usageEpoch` survive; without that test the change must not land.
- **Prompt injection via an imported agent file** → an agent's prompt is operator-authored content, held to the same status as an operator-authored skill: it can steer the model but it cannot widen tool allowance (D2), reach a skill the conversation has not approved (D3), change the model beyond the profile's own list (D4), or shed the browser-automation contract (D5). It is not treated as trusted authorization.
- **Catalog/skills duplication drifts over time** → accepted deliberately (Non-Goals), for the isolation reason `skills/paths.js` already documents. Mitigated by keeping file names and function names parallel so a diff between the two directories reads as a review artifact.
- **The panel gains a control in an already-dense composer at 320px** → the picker is specified as a compact control showing the current selection inline; the 320px scenario in the panel spec is a required test, not an aspiration.
- **A large catalog inflates every run's prompt** → each enabled agent's `description` and `prompt` are sent on every run. Mitigated by a bounded per-agent prompt size and a bounded enabled-agent count, enforced at import/author time with a specific error, in the same spirit as the existing bounded document/attachment ceilings.
- **`agents` interacts with `resume`** → a resumed SDK session was created with a previous `agents` map. The run-start compatibility gate (`assessResumeCompatibility`) already compares a permission-policy identity derived from the built options (`buildPermissionPolicyIdentity(options)`); the emitted agent set is folded into that identity so a changed agent set is treated as an incompatibility and starts a fresh session rather than resuming under stale definitions.

## Migration Plan

1. Ship the non-destructive `migrateConversationMetadata()` fix and the v1→v2 test **first**, independently verifiable before any agent code depends on it.
2. Ship the host catalog + resolution + `Options.agents` emission with no UI. At this point a run with an empty catalog is provably byte-identical to today.
3. Ship the Settings page, then the panel picker.
4. **Rollback**: removing the `agents` parameter from the `buildIsolatedOptions()` call site restores today's behavior for every run without touching the catalog on disk; an empty or fully-disabled catalog achieves the same without a code change.

   **The metadata bump is not cleanly reversible, and this is stated rather than glossed.** A rolled-back build still carries the *old* destructive `migrateConversationMetadata()`, which rebuilds any envelope whose version is not `1` — so it would read a v2 envelope and discard `sdkSessionRef`, costing resume for every conversation touched since the upgrade. Conversations, transcripts and usage ledgers are not lost; only SDK-session resume references are, and an unresumable conversation already has a defined behavior (it starts a fresh SDK session, `SDK_SESSION_REF_STATUS`). The mitigation is ordering, not reversal: step 1 ships alone and is verified before anything depends on it, so a rollback of steps 2-4 does not require a rollback of step 1. Rolling back step 1 itself is a deliberate, costed decision, not a routine backout.
