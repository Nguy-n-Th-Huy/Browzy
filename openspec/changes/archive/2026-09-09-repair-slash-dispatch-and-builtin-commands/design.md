## Context

See `proposal.md` — Why, and `specs/agent-skills/spec.md` for the behaviour contract.

Facts established by reading the tree, which the decisions below rest on:

- **The authorization gate already works.** `host/agent/companion.js` `_handleStart()` (~line 1277) calls `extractSlashCommand(prompt)` — which returns the whole trimmed prompt when it starts with `/` — then `assertSlashDispatchAllowed(slashCommand, skills.catalogSnapshot)`. `normalizeCommandName()` in `dispatch.js` strips the leading `/` and keeps only the first token, so it tolerates trailing arguments. A rejection emits `run_error` with `reason: "slash_dispatch_rejected"`, which the panel labels "Lệnh không được thực thi" (`sidepanel.js:544`).
- **The failure is downstream of that gate.** The only `Unknown command` string in this repo is `dispatch.js:42` (`Unknown command "/x". No imported, approved skill has this name.`). The operator's observed failure read `Unknown command: /marketing-research` and did not carry the panel's rejection label — so the gate passed and the SDK rejected.
- **Why the SDK rejects.** `session-workspace.js` copies approved snapshots to `${cwd}/.claude/skills/<name>/`, but `settingSources: []` is passed by every `query()` in the tree (`query-options.js:594`, `capability-test.js:147`, `enhance-prompt.js:147`), so the SDK never scans that tree as a command source. The `skills` option is documented in `sdk.d.ts:2097` as "a context filter, not a sandbox" — it gates what the `Skill` **tool** may reach, not what becomes a slash command. `buildIsolatedOptions()` grants `tools: ["Skill", …]`, so the `Skill` tool is available.
- **The transcript is panel-owned.** `panel-controller.js:197` calls `model.addLocalUserMessage(text)` with the operator's literal text before `protocol.start({ prompt: text })`. A companion-side transformation of the wire prompt therefore cannot alter what the operator sees.
- **The SDK publishes its command list.** `sdk.d.ts:5169` — `slash_commands: string[]` on the `system`/`init` message, with `terminal_slash_commands?: string[]` documented as the subset "bound to the local terminal (e.g. exit, statusline)" that "Phone/remote UIs should hide". `SDKCommandsChangedMessage` (`sdk.d.ts:3422`) is a mid-session push telling clients to REPLACE their cached list. Nothing in this repo reads any of these today.
- **`capability-test.js` already sees `init`.** `runSubTest()` branches on `msg.type === "system" && msg.subtype === "init"` and exposes an `onMessage` hook.
- **The settings relay is operation-agnostic.** `background.js`'s `createAgentSettingsRelay()` strips only the wrapper's `type` field and forwards any `op` verbatim; `_handleAgentSettings()` in the companion is a plain `switch` on `op`. A new read-only op needs no relay change.
- **Atomic persistence already exists.** `host/agent/settings/atomic-store.js` exports `writeJsonAtomic()` (write-temp, fsync, rename), used by the profile store.

## Goals / Non-Goals

**Goals:**

- A picker-offered skill invocation actually runs, with the isolation posture untouched.
- Built-in commands sourced from what the SDK really advertises for this operator's configuration, filtered by an application allowlist — never a hardcoded assumption.
- The operator's own words reach the model unaltered; only a fixed wrapper is added around them.

**Non-Goals:**

- Any change to `buildIsolatedOptions()`'s isolation posture beyond the one `settingSources` entry decision 7 justifies. The tool set, MCP servers, `strictMcpConfig`, `disallowedTools` and the WebFetch guard all stay exactly as they are.
- Loading the operator's own global configuration directory.
- Approving any built-in command at all (see decision 8).
- Handling `SDKCommandsChangedMessage` mid-session pushes. `init` is the one capture point this change wires; the record's shape leaves room for the push to be added later without a second mechanism.
- Making the picker's built-in section appear before the SDK has ever advertised a list. That gap is a stated limitation, not a bug to paper over with a guess.

## Decisions

### 1. Translate an authorized skill dispatch into a `Skill`-tool instruction; do not touch `settingSources`

Two ways to make `/marketing-research` run were considered.

*Rejected:* set `settingSources: ["project"]` so the SDK scans `${cwd}/.claude/` and registers the skill as a real slash command. This is the SDK's native path and would be the smaller diff, but `query-options.js`'s file header names `settingSources: []` as part of this product's isolation baseline, and widening it makes the SDK read every other `.claude` configuration in the session workspace. That is a security-boundary change, and the operator explicitly chose not to make it.

*Chosen:* after `assertSlashDispatchAllowed()` passes **and only then**, when the command names a skill, the companion replaces the wire prompt with a fixed construction before `_runQuery()`:

```
Use the "<name>" skill.

<the operator's text after the command, verbatim>
```

with the trailing block omitted entirely when the operator typed no arguments. A new exported builder in `host/agent/skills/dispatch.js` owns this — that module already owns slash-command semantics (`normalizeCommandName`, `assertSlashDispatchAllowed`), so the parsing rule lives in exactly one place. The builder is pure and unit-testable with no companion, transport, or SDK.

Three properties make this auditable rather than a silent rewrite: the wrapper is a constant, the operator's arguments are copied byte-for-byte, and the panel transcript is unaffected (`addLocalUserMessage` already ran on the literal text). The `Skill` tool is already in `tools` and the skill is already in the `skills` filter, so nothing new is granted.

The translation happens after the gate, never before — a rejected command must produce no constructed prompt and no model call.

### 2. Attachments and the translation compose without a special case

`_runQuery()` builds `buildAttachmentPrompt(prompt, attachments)` when attachments exist, otherwise passes the plain string. Because the translation replaces the `prompt` string before that branch, both paths carry the translated text with no second code path and no change to the attachment machinery.

### 3. An approved built-in passes through the gate and reaches the SDK verbatim

`assertSlashDispatchAllowed()` today throws `UNKNOWN_COMMAND` for any name absent from the skill catalog, which would reject `/cost`. It gains a second, explicitly-passed source of truth: the set of approved built-ins available for this run. A command matching that set is allowed and returned tagged as a built-in; the caller then skips the decision-1 translation and sends the operator's text unchanged, because a built-in must reach the SDK as a real slash command.

The gate keeps its precedence order — skill catalog first, then built-ins — so a skill can never be shadowed by a built-in name. The built-in set handed to the gate is itself the intersection from decision 5, so an advertised-but-unapproved command is rejected exactly like an unknown one.

### 4. Record the advertised list, persisted, captured wherever a session starts

A new small module owns one JSON document under the agent root (alongside the existing per-area stores), written through `atomic-store.js`'s `writeJsonAtomic()` — reused, not reimplemented. Shape: the advertised `commands`, the `terminalCommands` subset, and the timestamp of the observation, replacing the previous record wholesale (matching `SDKCommandsChangedMessage`'s documented "REPLACE your cached list" semantics, so adding that push later needs no new shape).

Capture points, both of which already iterate SDK messages:
- `companion.js` `_runQuery()`'s message loop — every real run.
- `capability-test.js` `runSubTest()`'s existing `system`/`init` branch — the Settings connection test.

Persisting rather than holding it in memory is deliberate: the companion restarts routinely, and an in-memory record would turn "available after the first session" into "available until the host next restarts", which is a worse and more confusing behaviour than the stated limitation.

Recording is strictly observational — a failure to write is logged and swallowed, never allowed to fail a run or a connection test.

### 5. The picker's built-ins are an intersection, computed panel-side

`skills-model.js` gains the application allowlist as a real constant — exactly `["cost"]` — replacing the empty `BUILTIN_COMMANDS`. The picker's built-in entries are:

```
advertised  −  terminalCommands  ∩  APPROVED_BUILTIN_COMMANDS
```

Computed in `skills-model.js` as a pure function beside `buildPickerItems`, so it is unit-testable and so `kind: "builtin"` tagging (which `sidepanel.css` already styles via `[data-kind="builtin"]`) keeps working unchanged. An empty or missing advertised list yields no built-ins — the honest outcome the spec requires, not a fallback guess.

The panel reads the record through a new read-only `agent_settings` op fetched alongside the existing `skills_list` call. `skills-client.js` (the panel's own small read-only transport) gains the second read; it stays read-only, and mutating the record from the panel is not offered.

Why panel-side rather than companion-side: the companion already serves the raw record, and the picker's presentation rules (what to show, how to tag it) belong with the rest of the picker's item-building logic in `skills-model.js`. The gate's own copy of the approved set (decision 3) is derived from the same constant on the host side, so the two cannot disagree about what is approved.

### 6. Tab as an accept key

Already implemented in `extension/ui/behaviors.js` in the preceding fix — Tab shares Enter's single branch, `Shift+Tab` excluded — and covered by `test/slash-picker-tab-accept.test.mjs`. It is written into the spec here because the requirement it satisfies lives in this capability and was previously unstated.

### 7. Correction: decision 1's assumption was false — the session workspace's skills must be made discoverable (SUPERSEDED by decision 9 — kept in full below; do not delete)

Decision 1 above assumed that translating an authorized dispatch into a `Skill`-tool instruction would be enough, because the skill was already in the `skills` filter and the `Skill` tool was already granted. **Live evidence disproved that assumption after implementation**, and this decision supersedes it.

From a real run's stored events (`agent/conversations/<id>/events.jsonl`):

```
tool_result  is_error: true
<tool_use_error>Unknown skill: marketing-research</tool_use_error>
```

and from the same run's `system`/`init` message:

```
cwd:    …/agent/conversations/conv_…
skills: [deep-research, design-sync, dataviz, update-config, verify, debug,
         code-review, simplify, batch, fewer-permission-prompts, doctor, loop,
         claude-api, workflow-authoring, run, run-skill-generator]
```

Sixteen entries, all of them the CLI's own bundled skills. `marketing-research` is absent although `cwd/.claude/skills/marketing-research/SKILL.md` exists on disk. The cause is the same `settingSources: []` that broke slash dispatch: per `sdk.d.ts:2076-2084`, `'project'` is what loads `.claude` from the working directory, and `[]` is "SDK isolation mode". With no source scanning `cwd/.claude`, nothing is discovered, and the `skills` option — "a context filter, not a sandbox" (`sdk.d.ts:2097`) — filters an empty set to an empty set. The imported-skill feature has therefore never worked end to end in this product; decision 1 alone converts `Unknown command: /x` into `Unknown skill: x`.

**Chosen (at the time — since disproven, see decision 9):** add `'project'` — and only `'project'` — to `settingSources` in `buildIsolatedOptions()`.

Why this is a much smaller concession than it first appears, and why it is not the "relax the boundary" option originally rejected:

- The `cwd` is not the operator's project. It is `agent/conversations/<id>/`, a directory this application creates per conversation and populates itself. Inspected on a live installation, its `.claude/` subtree contained exactly one thing: `skills/marketing-research/SKILL.md` — the snapshot `buildSessionSkills()` copied. There is no `settings.json` there, and nothing a webpage, a model, or a third party can write into it.
- `'user'` (`~/.claude/settings.json` per `sdk.d.ts:2077`) is a **separate** source and is deliberately not added. The operator's own global skill collection stays out of every run.
- `assertSlashDispatchAllowed()` remains the authorization list. Discoverability was never authorization in this design and still is not — `specs/agent-skills/spec.md`'s "Discoverable is still not authorized" scenario pins that.

**The one thing this decision does not know, and refuses to assume:** whether `'project'` resolves strictly to `cwd/.claude` or walks up toward a repository/filesystem root when `cwd` contains no project marker. If it walks up, a directory above the workspace could contribute skills, which would be a real boundary leak. This is not left to reasoning — task group 5 makes it an executable test with a sentinel skill planted in a parent directory, and the change does not ship if that sentinel appears.

`query-options.js`'s own header and inline comments currently assert `settingSources: []` as an isolation baseline. Those comments become false with this change and are corrected as part of it — a comment that contradicts the code is a defect, not documentation.

**Outcome, recorded here rather than silently rewritten:** task group 5's own sentinel test proved the open question above the worst way — see decision 9. `'project'` does walk up, with no repo-root gating at all, and this decision was reverted before shipping. Kept in full because the record of a disproven assumption, not just the corrected one, is the point: it shows exactly what was checked, what the check found, and why the next decision looks the way it does.

### 8. The approved built-in allowlist is empty

Decision 5's allowlist was `["cost"]`. The live advertised record disproves it: the SDK's `slash_commands` for this configuration contains `usage`, `context`, `compact`, `clear`, `model`, `effort`, `recap` and others, but **no `cost`**. An allowlist entry the SDK never advertises can never surface, so `["cost"]` would leave the built-in section permanently and silently empty.

The operator's decision, given that evidence, was to keep the discovery machinery and empty the allowlist rather than substitute a different command. So `APPROVED_BUILTIN_COMMANDS` becomes `[]` on both sides.

This deliberately reproduces the *effect* of the `BUILTIN_COMMANDS = []` this change set out to replace, and that is not an oversight — it is the difference between "no built-in is approved" and "there is no mechanism". The mechanism, the persisted record, and the read op all stay: they are what makes the emptiness auditable, they are what a future approval needs, and the record is useful diagnostics in its own right. Both allowlist constants carry a comment saying exactly this, so a later reader does not mistake the empty array for unfinished work.

### 9. Correction: decision 7 leaks past the session workspace — replace `settingSources: ['project']` with a per-session local plugin

Decision 7 shipped with one question deliberately left open: whether `'project'` resolves strictly to `cwd/.claude` or walks up the ancestor tree when `cwd` carries no project marker. Task 5.4's own sentinel test (a real, unmocked `query()`, a randomly-named sentinel skill one level above a temp session workspace, a second sentinel inside the workspace itself) answered it: **`'project'` walks up, with no repo-root gating at all.** A parent directory's `.claude/skills/` is discovered whether or not that parent even looks like a repository (planting a `.git` marker there made no difference — both variants leaked). See `plans/reports/blocker-260909-0712-project-settingsource-walkup-leak.md` for the full evidence and `host/test/skills-scope-verification.test.mjs` for the executable proof, now kept as the permanent regression guard for this exact fact.

**Concrete production consequence, verified independently on a live installation, not hypothetical:** a real session workspace lives at `agent/conversations/<id>/` under this application's own per-user root (`host/agent/settings/paths.js`'s `agentRoot()` — `~/.config/browzy-in-chrome/agent` when `OCIC_AGENT_HOME` is unset). Its ancestor `~/` on the machine this was verified on holds `.claude/skills/` containing **189** of the operator's own globally-installed skills. Decision 7's stated goal — "the operator's own global skill collection stays out of every run" via never enabling `'user'` — was defeated through a different door: `'project'`'s unbounded walk-up reaches the exact same global skill collection without `'user'` ever being touched. Every real conversation on this machine would have discovered and exposed all 189 of them.

**Chosen replacement:** stop trying to make the SDK's own `.claude`-tree settings discovery see the session workspace at all. Instead, materialize the session's approved skill snapshots as a **local plugin** — the same mechanism this repository already uses to ship itself as a Claude Code plugin (`host/.claude-plugin/plugin.json`) — and load it by absolute path via the SDK's separate `plugins` option (`Options.plugins: SdkPluginConfig[]`, `sdk.d.ts` ~1874/~4883: `{ type: 'local', path, skipMcpDiscovery? }`). `settingSources` stays `[]` — untouched, never widened, exactly as decision 7 wished it could stay. `plugins` is a distinct, explicit-path mechanism with no ancestor walk-up of any kind: it loads exactly the directory named, nothing above it. A real `query()` run proved this empirically (`host/test/skills-plugin-scope-verification.test.mjs`, now converted from a spike into the shipped gate): the plugin's own sentinel skill was discovered, and a sentinel planted in the same kind of parent directory that leaked under decision 7 did **not** appear.

`skipMcpDiscovery: true` is required on the plugin entry because this product owns its own MCP connections (`host/agent/tools/adapter.js`'s browser-tool server, wired through `mcpServers`/`strictMcpConfig` below) — the session-skills plugin carries no `mcpServers` of its own, but the flag is set explicitly rather than left to rely on the manifest simply omitting that field, so a future edit to the generated manifest can never silently reopen an MCP-discovery path this design does not want.

**Empirical finding, not an inference from documentation:** the spike proved that a skill loaded through a plugin gets a **plugin-qualified canonical name** — `<plugin-name>:<skill-name>` — in the real `system`/`init` message's `skills` array (observed verbatim: `ocic-scope-spike-plugin:zz-sentinel-plugin-00d256259469`), never the bare directory name. This settles a real contradiction between two doc sites in the pinned SDK's `sdk.d.ts` (~2094, implying a bare name matches, versus ~4010, documenting "the exact canonical name (e.g. `my-plugin:my-skill`) or a `:name` suffix of it") in favour of the qualified form. Two consequences follow, both implemented in `host/agent/skills/session-workspace.js` and `host/agent/skills/dispatch.js`:

- The plugin's own `name` field is a **fixed constant** (`SESSION_SKILLS_PLUGIN_NAME`, never derived per conversation) — a per-conversation plugin name would make the qualified name a moving target the dispatch translation could never predict ahead of the SDK actually reporting it.
- `buildSessionSkills()`'s `allowedSkillNames` (feeding the SDK's `skills` context-filter option) and `skillOverrides` keys now carry the qualified form; `dispatch.js`'s `buildSkillDispatchPrompt()` builds its `Use the "<name>" skill.` instruction with the same qualified name, since that is the identity the `Skill` tool actually resolves against. The application's own catalog (`catalogSnapshot`, what `assertSlashDispatchAllowed()` checks) is unaffected and stays bare — it is this application's own data, never SDK-facing, and the operator's typed `/marketing-research` is still matched against it exactly as before. `assertCanonicalSkillResourcePath()`'s directory-boundary check normalizes a qualified name back to its bare form before comparing against the physical snapshot directory name it actually copied to disk (`skill.name`, unqualified) — the boundary itself is unrelated to SDK naming and stays exactly as strong as before this change.

**The `Skill`-tool resolution question, closed empirically:** the spike's shared fixture Anthropic server hardcoded every scripted tool call's `input` to `{}`, so it could not originally prove that a real `Skill` tool_use actually *resolves* a specific plugin-qualified name end to end — only that the name is *discoverable* (present in `init`'s `skills` array). The original production failure this whole change chases was `Unknown skill: marketing-research` in a `tool_result`, not an `init` omission, so presence in `init` alone would not have been sufficient. This change extends `host/agent/settings/testing/fixture-anthropic-server.mjs` with two additive, opt-in hooks (`scriptToolUseInput`, `scriptToolUse` — both no-ops for every pre-existing consumer) that let a test script a real `Skill` tool_use's `input` and target it by name. Using them against a real, unmocked `query()` (never the pinned SDK's own `.d.ts` files, which document no schema for the `Skill` tool's input at all) established, empirically:
- The `Skill` tool's input parameter is `{ skill: "<name>" }` (discovered by trying candidate shapes and reading back the real `InputValidationError` naming the expected parameter).
- A valid name — BOTH the plugin-qualified form and, in this single-plugin/no-ambiguity scenario, the bare form — resolves and returns `"Launching skill: <name>"`.
- An invalid name returns `<tool_use_error>Unknown skill: <name></tool_use_error>` — the EXACT error string from the original production failure — confirming that the success message is a real resolution, not blind input echoing.

This closes the question this change chases: a session's plugin-materialized, plugin-qualified skill name is not merely discoverable, it is genuinely `Skill`-tool-resolvable, end to end, against a real unmocked `query()`. See `host/test/skills-plugin-scope-verification.test.mjs` for the shipped assertion built on this.

## Risks / Trade-offs

- **No built-in commands until the SDK has advertised once** → Capturing from the Settings connection test means the record normally exists by the end of first-run setup. The picker's honest behaviour before then is skills-only; the spec states this rather than hiding it.
- **The wrapper phrasing is a prompt, so the model could in principle ignore it** → With decision 9's plugin in place the skill is genuinely discovered, listed in the `skills` filter under its qualified name, and reachable through the granted `Skill` tool, so the wrapper only has to name the SDK's own intended invocation route (now the qualified name — see decision 9). (Decision 7's `settingSources: ['project']` version of this bullet was wrong in a way that mattered before that too: the wrapper could not work at all under `settingSources: []`, because the skill was never discovered — see decision 7's own evidence, kept above.)
- **`cost` may not appear in the advertised list for this configuration** → It did not. The live record advertises `usage`, `context`, `compact`, `clear`, `model`, `effort`, `recap` and others, and no `cost` — which is why decision 8 empties the allowlist. The mechanism behaved exactly as intended by refusing to offer a command the SDK never claimed.
- **The approved allowlist exists in two places (panel and host)** → Both are one named constant per side holding the same value, and a test asserts they match, so drift is caught rather than shipped. That test must keep passing with both sides empty.
- **`'project'` turns out to walk up past the session workspace** → It did. This is no longer a risk being managed — it is the resolved outcome recorded in decision 9. `settingSources` never gains `'project'` (or any entry); discovery now goes through the `plugins` option's explicit absolute path instead, which the same executable sentinel test (task group 5) proves does not walk up.
- **A future `.claude` file appearing inside the session workspace would now be loaded** → No longer applicable in the same form: `settingSources` stays `[]`, so nothing scans the workspace's `.claude` tree at all any more. `buildSessionSkills()` is the plugin directory's only writer and copies only approved snapshots; anything else appearing there is itself the defect to fix.
- **The plugin mechanism's `Skill`-tool name resolution was unverified for a specific plugin-qualified name** → Closed. The fixture server gained two additive, opt-in hooks to script a real `Skill` tool_use's input and target it by name; a real, unmocked `query()` confirmed the qualified name resolves (`"Launching skill: <name>"`) and a bogus one fails with the exact `Unknown skill: <name>` string the original production bug reported. See decision 9's closing paragraph.
- **The empty allowlist reads as unfinished work to a later maintainer** → Both constants carry a comment stating it is a deliberate approval decision taken against a real advertised list that lacked the only candidate command.
- **A stale persisted record after the operator changes provider or model** → Each new observation replaces the record wholesale, so the first session on the new configuration corrects it. A record can therefore be at most one session out of date.
- **`extractSlashCommand()` treats any leading `/` as a dispatch** → Unchanged by this design. A prompt legitimately starting with `/` (a path, say) already goes through the gate today and is rejected with an actionable message; this change does not widen or narrow that.

## Migration Plan

No wire-message type is added or changed in shape — only a new `agent_settings` op, which older companions answer with the existing `unknown op` error path and which the panel treats as "no advertised list yet" (skills-only picker). The persisted record is created on first observation; its absence is a normal state, not an error. Rollback is removing the translation, the allowlist, and the record module; the on-disk JSON becomes an orphan file that nothing reads and that is safe to delete by hand.
