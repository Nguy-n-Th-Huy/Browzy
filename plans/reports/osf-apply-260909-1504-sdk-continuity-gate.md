# Group-0 investigatory gate — evidence report

Change: `upgrade-agent-reliability-and-workflows`, tasks.md group 0 (tasks 0.1–0.4).

Scope of this session: investigation only. No product code was touched. Files
created: `host/agent/spike/gates/gate-0.2-sdk-continuity.mjs` (the fixture/gate
script) and this report. `tasks.md` 0.1–0.4 were checked off; nothing else in
`tasks.md` was touched.

This report reflects the gate script's state **after** a pre-completion
review pass caught and fixed one real correctness bug (G1's turn-2 evidence
was scoped to the whole call log, not just turn 2's own requests — fixed) and
added two further real, empirical findings the first pass had left
un-investigated (G3b: cwd does not gate `resume`; the session-storage
real-home-directory side effect below). G8 was also strengthened from a
structural-presence observation to a direct arithmetic proof. All fixture-only
gates were re-run after every fix; only G9 (the one real-money call) was not
re-run, to avoid a second unnecessary real charge — its already-captured
evidence is unaffected by any of these fixes.

## Environment

| | |
|---|---|
| `@anthropic-ai/claude-agent-sdk` | 0.3.263 (pinned, `host/package.json`) |
| Node.js | v24.19.0 |
| Platform | win32 x64 (Windows 11) |
| Fixture used for zero-cost gates | `host/agent/settings/testing/fixture-anthropic-server.mjs` (existing, shared, in-process, no real network) |
| Real gateway used for the one paid gate | The operator's already-configured default profile (`host/agent/settings/profile.js`), model `claude-opus-5`, resolved via `snapshotForRun()` — never a raw env var |

Reproduce:
```
cd host
node agent/spike/gates/gate-0.2-sdk-continuity.mjs          # zero cost, all gates except G9
node agent/spike/gates/gate-0.2-sdk-continuity.mjs --live   # adds G9, exactly one real provider call
```

This file is deliberately **not** under `host/test/*.test.mjs`: that glob is
run unconditionally by `.github/workflows/publish-host.yml` on every publish
tag and must exit 0. G6 below reports a genuine, reproducible FAIL for one
specific narrow assertion (not a flake), and G9 needs a live credential to add
anything — neither should silently gate the publish pipeline. This mirrors the
already-established convention in this repo: the prior SDK-migration change's
own investigatory gates live at `host/agent/spike/gates/gate-1.*.mjs`, not in
`host/test/`.

## 0.1 — Source and typing baseline (current behavior, before this change)

- **`host/agent/companion.js`**: builds an isolated `query()` `Options` object
  once per turn via `buildIsolatedOptions()` (`host/agent/tools/query-options.js`,
  called at `companion.js:1369` and `:1434`) and calls `sdk.query()` fresh each
  time (`companion.js:1447`). No SDK-level `resume`/`persistSession`/
  `forkSession`/`maxTurns`/`maxBudgetUsd` option is passed anywhere today.
- **`host/agent/tools/query-options.js`**: its own header comment states the
  current contract explicitly (line ~202-204): *"this project calls `query()`
  once per run (see companion.js's `_runQuery`), never SDK-level
  `resume`/`continue`."* `buildIsolatedOptions()` returns `{ abortController,
  model, mcpServers, strictMcpConfig: true, settingSources: [], cwd:
  skills.cwd, plugins: [...], tools: [...], allowedTools: [...] }` — no
  `resume`, `persistSession`, `forkSession`, `maxTurns`, or `maxBudgetUsd` key
  exists in the object it builds today. `cwd` is always `skills.cwd`, the
  session's materialized skills-workspace directory (see below), not an
  independently chosen conversation cwd.
- **`host/agent/session/manager.js`**: `resumeConversation()` (confirmed by
  direct read) only replays the durable transcript snapshot and marks any
  run that was active at last-known state as `interrupted` — it does **not**
  call the SDK's `resume` and does **not** invoke `query()` at all. This
  matches design.md's framing exactly: "the current companion persists
  transcript events and UI snapshots, but `SessionManager.resumeConversation()`
  only restores display state."
- **`host/agent/tools/mapping.js`**: exports `isSendClassCall(legacyToolName,
  args, targetHint)` (line 355) plus `isMutatingCall`, borrowed-tab
  authorization helpers, and the friendly/legacy name mapping. `targetHint` is
  already an accepted third parameter today but `can-use-tool.js`'s call site
  (`host/agent/policy/can-use-tool.js:107`) calls
  `isSendClassCall(toolName, args)` — **no third argument is passed**,
  confirming design.md decision 3's framing that target-resolution evidence is
  not yet threaded into classification.
- **`host/agent/policy/can-use-tool.js`**: `createCanUseTool({ run, approvals,
  requestIdTracker, now })` is the factory; the actual send-class branch is
  at line 107 as above.
- **`extension/sidepanel/page-context.js`**: exists as the extension-side page
  context module (located; current identity model is tab+URL+local revision,
  consistent with design.md's framing — no browser-observable document-token
  mechanism yet).
- **`host/agent/storage/pending-recordings.js`**: `PendingRecordingsStore`
  stores a **reference only** (recordingId, existing on-disk path, schema
  version, transcript status, optional summary) — confirmed by direct read.
  No conversation-targeted acknowledgement protocol and no SDK-readable
  model-input delivery path exist yet (matches design.md decision 5's gap
  framing).
- **Settings/profile modules** (`host/agent/settings/`): `profile.js`,
  `profile-store.js`, `profile-schema.js`, `capability-test.js`,
  `discovery.js`, `models.js`, `http-client.js`, `url.js`, `atomic-store.js`,
  `errors.js`, `paths.js`, `advertised-commands.js` all exist. A real,
  already-configured profile exists on this machine
  (`loadProfile()` → `hasCredential: true`, `defaultModelId: "claude-opus-5"`,
  `secretBackend: "windows-credential-manager"` — booleans/ids only, no secret
  value read or printed).
- **`shortcuts_execute`** (`host/tool-definitions.js:455-475`, exact current
  schema): `{ tabId: z.number() (required), shortcutId: z.string().optional(),
  command: z.string().optional() }` — asynchronous, starts execution and
  returns immediately, no `version`/`parameters` field. This matches design.md
  decision 8's framing ("`shortcuts_execute` currently accepts `tabId`,
  optional `shortcutId`, or `command` and is asynchronous rather than a
  parameterized/versioned workflow runner") verbatim against the real file.

### 0.1 addition — current session-schema-identity inputs (post skills-plugin change)

`host/agent/skills/session-workspace.js` (read directly, current state, **not**
the state design.md's decision 9 supersedes) materializes each session's
approved skills as a **local plugin directory**, not a bare skills folder:

- Directory shape: `${sessionWorkspaceDir}/skills-plugin/` (fixed subdirectory
  name — `pluginDir = path.join(sessionWorkspaceDir, "skills-plugin")`),
  containing `.claude-plugin/plugin.json` (written by `writePluginManifest()`)
  and a `skills/` subdirectory (`skillsDir = path.join(pluginDir, "skills")`).
- The plugin's own `name` is **fixed and application-owned** — never derived
  per conversation/run (the file's own comment: "NEVER derived per
  conversation/run. A per-run name would make the qualified canonical name...").
- Loaded via the SDK's `plugins` option
  (`plugins: [{ type: "local", path: skills.pluginDir, skipMcpDiscovery: true
  }]`, `query-options.js:627`), **not** by widening `settingSources` (which
  stays `[]` — decision 7's `settingSources: ['project']` alternative was
  tried and rejected after a real `query()` proved it walks the entire
  ancestor directory tree with no repo-root gating; see
  `plans/reports/blocker-260909-0712-project-settingsource-walkup-leak.md`).
- Skill names in `allowedSkillNames` are **plugin-qualified**:
  `"<plugin-name>:<skill-name>"` (`qualifiedSkillName()`), confirmed
  empirically against a real `query()` run by (already-existing, untracked)
  `host/test/skills-plugin-scope-verification.test.mjs` per the source
  comment. The on-disk directory name for each skill stays bare (unqualified)
  — qualification is purely an SDK-facing naming fact supplied by the
  plugin's own manifest `name`, not a filesystem rename.

**Concrete session-schema-identity inputs a resume-compatibility check
(tasks.md 2.1/2.4) must compare, as they exist right now:**
1. `cwd` — the session's skills workspace directory (`skills.cwd`,
   `buildIsolatedOptions()`'s required `skills.cwd` param).
2. The materialized plugin directory identity — `skills.pluginDir`
   (`.../skills-plugin/`) and its fixed plugin `name`.
3. `allowedSkillNames` in **plugin-qualified form**
   (`"<plugin-name>:<skill-name>"`), not bare skill names.
4. `skillOverrides`, keyed by the **same qualified name** (the file's own
   comment: "a mismatch here [bare vs qualified] ... but qualifying it keeps
   the override's intent effective").
5. `settingSources: []` (unchanged, untouched by the plugin mechanism).

Any future resume-compatibility comparison (tasks.md 2.4: "reject incompatible
... cwd/session identity") must diff against this exact shape — a plain
"skills list" comparison would miss the plugin-qualification and
fixed-plugin-directory facts above.

## 0.2 — SDK fixture: per-item PASS/FAIL

All gates below ran against the **installed** `@anthropic-ai/claude-agent-sdk`
0.3.263 — the real bundled Claude Code CLI subprocess, not a re-implementation.
Every gate except G9 hit only the local in-process fixture server (zero real
network, zero cost). G9 made exactly **one** real call to the operator's
already-configured gateway. Two gates beyond the task's original list were
added during this session — G3b and a third (unnumbered) finding below — both
because the first pass's evidence surfaced a genuine question the task's own
scope ("cwd/session persistence") already named but had not yet tested.

| Gate | Assertion | Status | Real cost |
|---|---|---|---|
| G1 | `resume` restores prior model context in a second turn, and does **not** replay a tool call | **PASS** | $0 |
| G2 | Missing/unknown `resume` session id fails **explicitly**, never silently | **PASS** | $0 |
| G3 | `persistSession: false` prevents a later resume of that session | **PASS** | $0 |
| G3b | `cwd` is part of session identity for resume (mismatched `cwd` rejected) | **FAIL** (real finding, see below) | $0 |
| G4 | `forkSession: true` creates an independent branch; original stays resumable | **PASS** | $0 |
| G5 | `abortController.abort()` actually terminates the run; no completed result | **PASS** | $0 |
| G6 | `maxTurns` caps a **paced, multi-message streaming-input** conversation | **FAIL** (real finding, see below) | $0 |
| G6b | `maxTurns` caps an **internal multi-round tool loop within one top-level turn** | **PASS** | $0 |
| G7 | `maxBudgetUsd` stops the query at the cap, `subtype: 'error_max_budget_usd'` | **PASS** | $0 |
| G8 | `modelUsage` vs aggregate `usage` (subagent inclusion/exclusion) | **PASS** (arithmetic proof, see below) | $0 |
| G9 | Real gateway `costBasis` / usage/cost semantics | **PASS** | **$0.00428** (real, single call) |
| G10 | A resumed session's cost/usage totals start fresh (not cumulative) | **PASS** | $0 |

### Evidence detail

**G1** — turn 1 registered a real SDK tool (`tool()` + `createSdkMcpServer()`,
same mechanism `host/agent/tools/adapter.js` uses for real browser tools),
asked the model to call it, and it was invoked exactly once. Turn 2 resumed
the same `session_id` (still identical after resume, as expected for a plain
resume) with the tool **still registered** but with a plain-text scenario.
**Corrected during review** (an initial version of this check filtered the
fixture's *entire* call log for turn-1's text, which trivially matched
because turn 1's own requests already contain it — proving nothing about
turn 2): the fixed check snapshots the call-log length immediately before
turn 2's `query()`, isolates only the request(s) turn 2 itself made, parses
each one's `messages` array, and requires turn-1's exact user text to appear
as an actual prior message entry. Result: turn 2 made exactly 1 wire request,
and that request's `messages` array contained turn 1's "Remember the number
42..." as a prior entry — real proof the CLI reconstructed prior conversation
history into the new request ("resume restores prior model context") — while
the tool handler's invocation count stayed at 1 across both turns (delta 0,
unaffected by the fix) — proof resume does **not** re-invoke ("replay") a
tool call. This is the strongest available offline proxy for "no
browser-action replay": browser tools are registered through the identical
SDK tool mechanism.

**G2** — `resume` with a bogus UUID **threw synchronously from the async
iteration**: `Error: Claude Code returned an error result: No conversation
found with session ID: 00000000-...`. A separate direct capture of the
underlying `result` message (before the terminal exception) showed
`subtype: "error_during_execution"`, `is_error: true`, and `errors: ["No
conversation found with session ID: ..."]` — i.e. the SDK surfaces this as
**both** a normal error-result message **and** a subsequent thrown terminal
exception once the CLI subprocess exits. Never silent, never a fresh session
substituted without signal.

**G3** — identical explicit-failure shape as G2 when resuming a session
started with `persistSession: false`.

**G3b — a second genuine, load-bearing finding.** Directly tests whether
`cwd` gates `resume` the way `tasks.md` 2.1/2.4's "cwd/session schema
identity" input assumes. Turn 1 ran under a fresh scratch `cwd` A. A sanity
resume under the **same** `cwd` A succeeded (same `session_id` — confirms the
harness itself is trustworthy). A resume of the **exact same `session_id`**
under a **different** scratch `cwd` B **also succeeded** —
`subtype: "success"`, `is_error: false`, no error of any kind — rather than
failing the way G2's genuinely-unknown-session case did. **This means the
SDK/CLI's own session lookup for `--resume=<id>` is not scoped by the calling
process's `cwd` the way this gate initially assumed** (on-disk session
storage is laid out under `<CLAUDE_CONFIG_DIR>/projects/<encoded-cwd>/`, but
`--resume` apparently locates the session by id without requiring the
invoking `cwd` to match the encoded directory it was originally written
under). **Concrete implication for tasks.md 2.1/2.4**: the SDK will not
reject a cwd-mismatched resume on the application's behalf — any
"cwd/session schema identity" compatibility check (0.1 addition's list above)
must be enforced entirely at the **application** layer (comparing the stored
`cwd`/plugin-directory/qualified-skill-name fields against the current
session's own values before ever calling `resume`), never assumed to be
covered by the SDK's own lookup.

**G4** — `forkSession: true` against an existing `resume` produced a
**different** `session_id`; the **original** `session_id` was independently
resumable again afterward with its own `session_id` preserved — fork is a
true branch, not a mutation of the source session.

**G5** — reused the identical, already-verified technique from the archived
`migrate-to-claude-agent-sdk` change's gate 1.5 (`http://127.0.0.1:1`,
unreachable by construction, so no live provider is ever contactable even if
the abort races a retry): `abortController.abort()` at ~300ms produced
`controller.signal.aborted === true`, a **thrown** `Error: Operation aborted`,
and no `result` message — cancellation is real, no synthesized/partial
success is fabricated. Measured latency abort→settle: ~7.0s (same CLI
retry/backoff bound the archived gate measured), reconfirmed here.

**G6 / G6b — the one genuine, load-bearing finding.** A paced,
one-user-message-at-a-time streaming-input session (`prompt: AsyncIterable`,
each message sent only after the **previous** turn's `result` was actually
observed — deliberately not "close together", since sdk.d.ts documents that
messages sent close together coalesce into a single turn, which a first,
naive all-at-once version of this test empirically hit and had to be fixed)
ran 5 genuinely separate turns against `maxTurns: 2` — **all 5 completed with
`subtype: "success"`, each individually reporting `num_turns: 1`, and
`maxTurns` never intervened.** This is not a harness bug: the *identical*
paced-streaming harness/options shape correctly and immediately triggers
`subtype: "error_max_budget_usd"` in G7 below (same mechanism, different
limit). A second, deliberately different construction — a **single** static
string prompt with one real SDK tool wired to a dedicated local server that
*always* answers with a fresh `tool_use` for the same tool regardless of
prior `tool_result`s (forcing a genuine internal multi-round tool loop within
one top-level turn) — **did** stop correctly at `maxTurns: 3`:
`subtype: "error_max_turns"`, `num_turns: 4`, thrown terminal error `Reached
maximum number of turns (3)`, tool handler invoked exactly 3 times (bounded).

**Conclusion for design.md decision 4, sharpened**: sdk.d.ts:1769-1771's own
definition of `maxTurns` ("Maximum number of conversation turns before the
query stops. A turn consists of a user message and assistant response.") does
**not** match the observed behavior for a paced, multi-message
streaming-input session — observed `maxTurns` behaves as a **per-user-send,
internal agentic-loop cap** (G6b: it correctly bounds how many
`tool_use`/`tool_result` rounds happen while answering *one* top-level user
message), and that internal counter appears to **reset on each new streamed
user send** (G6: 5 separately-paced sends, each individually completing in
exactly 1 internal round, never accumulated toward the cap). `maxTurns`
reliably caps the internal multi-round tool-loop pattern this product's
`companion.js` actually uses today (**one `query()` call per run**, with any
number of tool rounds inside it — see 0.1 above). It does **not**, in this
configuration, cap a long-lived streaming-input session's separately-paced
conversational turns. This is exactly why design.md decision 4 already
specifies a **local** wall-clock/model-turn admission counter as the
authoritative enforcement mechanism and treats SDK
`maxTurns`/`maxBudgetUsd` as advisory/best-effort on top of it ("do not claim
a local tool counter controls SDK calls" is the mirror-image caution) — this
finding is a concrete, empirical reason that local counter must stay
authoritative for any future streaming/resumed multi-turn design, not a
reason to distrust `maxTurns` for the single-query-per-run pattern in use
today.

### A third real finding: session storage writes to the operator's real home directory unless redirected

With **no** `HOME`/`USERPROFILE`/`CLAUDE_CONFIG_DIR` key in the isolated
`env` object passed to `query()` — the exact same env shape
`host/agent/tools/query-options.js`'s production `buildIsolatedOptions()`
builds today (`PATH`/`SystemRoot`/`ANTHROPIC_BASE_URL`/`ANTHROPIC_API_KEY`
only) — the bundled CLI subprocess still resolved a config directory: it fell
back to the OS home dir (confirmed by reading the installed
`sdk.mjs`: `process.env.CLAUDE_CONFIG_DIR ?? path.join(homedir(), ".claude")`).
**This session's first runs (before this was caught) wrote real session
`.jsonl` files into the operator's actual `~/.claude/projects/<encoded-cwd>/`**,
interleaved with their own genuine Claude Code CLI session history —
confirmed directly: `~/.claude/projects/D--Dev-www-open-claude-in-chrome-host/`
existed with hundreds of `.jsonl` files (631 at the time of this check,
predominantly pre-dating this session — the archived SDK-migration change's
own earlier live gate runs used the identical env shape and would have
accumulated there too) and its most-recently-modified timestamp matched this
session's own run times exactly.

**Fix applied**: every `query()` call in this gate now sets
`CLAUDE_CONFIG_DIR` (a real, honored env var — confirmed in `sdk.mjs`) to a
fresh `os.tmpdir()`-scoped scratch directory, created once per gate-script
run and deleted in a `finally` block at the end. All gates were re-run after
this fix and behave identically (see the per-gate evidence above, all
captured post-fix) — **except G9**, whose one real, already-spent $0.00428
call ran *before* this fix was applied and is not re-run (to avoid a second
unnecessary real charge); that one specific real-gateway session file was
therefore also written under the operator's real `~/.claude/projects/` before
the fix landed.

**Real, load-bearing implication for design.md decision 1/2**: if any future
group adopts SDK-level `resume` in production, `companion.js` must set
`CLAUDE_CONFIG_DIR` (or an equivalent) to an application-owned directory
(e.g. under the existing `OCIC_AGENT_HOME` tree) — otherwise every resumable
session this product creates writes into the *operator's own* Claude Code CLI
history directory, mixing this product's session data with the operator's
unrelated interactive CLI sessions and creating an unbounded, ungoverned
on-disk footprint outside this project's existing storage conventions
(`host/agent/storage/paths.js`'s `agentRoot()`). This was not previously
flagged in design.md and is a concrete new input for whichever group
implements SDK-level session persistence.

**G7** — `maxTurns: 20`, `maxBudgetUsd: 0.0000001` (far below any real
per-turn cost), model set to a real recognized id (`claude-3-5-haiku-latest`)
so the CLI's built-in price table has a row to match even though
`ANTHROPIC_BASE_URL` points at the local fixture (price-table lookup is by
model-id string, independent of endpoint reachability — confirmed by the
returned `costBasis: "list"`). Stopped after turn 1:
`subtype: "error_max_budget_usd"`, `total_cost_usd: 0.000016`, thrown
terminal error `Reached maximum budget ($1e-7)`. Zero real network calls (all
against the local fixture). **Real, load-bearing detail for group 5**: the
cap was checked **after** turn 1 completed, not before admission — that
turn's actual cost (0.000016) is ~160x the configured cap (0.0000001).
`maxBudgetUsd` stops the *next* turn from starting; it does not prevent the
turn that crosses it mid-flight. This is exactly proposal.md's already-named
"in-flight overrun" concern, now with a real measured multiple.

**G8 — strengthened during review with an exact arithmetic proof, not just
field presence.** The shared fixture server emits a **fixed** usage per SSE
response (`input_tokens: 5, output_tokens: 3`, hard-coded in
`sendSuccessSse()`), so dividing any reported total by that constant recovers
exactly how many model responses each field counted. With `Task` enabled and
invoked: **3 real `/v1/messages` wire calls were made** (confirmed by
diffing the fixture's own call log immediately before/after this query), but
aggregate `usage.input_tokens = 10` (÷5 = **2** calls) while
`modelUsage["fixture-model"].inputTokens = 15` (÷5 = **3** calls). **This is
a direct, per-call-counted empirical confirmation that `modelUsage` counted
exactly one more model call than aggregate `usage` did for the identical
`query()` call** — the missing call is the Task subagent's own model
invocation, arithmetically isolated, not merely inferred from the typings'
prose. This closes the task's "confirm the subagent exclusion empirically"
instruction directly (sdk.d.ts:4970 "MAIN AGENT LOOP ONLY — excludes Task
subagent..."; sdk.d.ts:4974 modelUsage covers "main loop, Task subagents,
sidechains, and internal calls" — both now independently re-derived, not
just quoted).

**G9 — the only real-money gate, run exactly once.** Resolved the credential
exclusively through `host/agent/settings/profile.js`'s `snapshotForRun()`
(the real production path — never a raw env var; ambient-env-leak check
passed first), single prompt `"Reply with exactly one word: pong"`,
`maxTurns: 1`, against the operator's actual configured gateway and model
(`claude-opus-5`). Result: `subtype: "success"`, `total_cost_usd: 0.00428`
(**real dollar cost, SDK estimate — not a billing statement**),
`usage: {input_tokens: 746, output_tokens: 22, ...}` (main-loop-only, per
sdk.d.ts:4970), `modelUsage: {"claude-opus-5": {costBasis: "list", costUSD:
0.00428}}`. This closes the "real-gateway usage/cost semantics, costBasis"
sub-item the task flagged as something a fixture server cannot answer.
**Total real spend this session: $0.00428, one call.**

**G10** — an initial paced 3-turn streaming session accumulated
`total_cost_usd: 0.000048`; resuming that session for one further turn
produced `total_cost_usd: 0.000016` — strictly **less** than the prior
cumulative total, confirming "resumed sessions start fresh" (sdk.d.ts:4966,
4974) rather than continuing to accumulate across the resume boundary.

### What a fixture server structurally cannot answer (marked accordingly, not asserted)

- Real-gateway `costBasis`/pricing beyond what a single `list`-basis
  `claude-opus-5` call showed (G9). A `managed` costBasis (org
  managed-settings pricing) is **not reachable** in this isolated harness by
  design — `settingSources: []` deliberately never reads org-level managed
  settings, so this is an intentional consequence of the isolation contract
  design.md itself requires, not a gap in this gate.
- A live browser tool call's *real* replay/no-replay behavior end to end
  (G1 only proxies this with an in-process SDK tool handler counting
  invocations — the identical mechanism real browser tools use, but no live
  Chrome/extension was attached in this session). This matches the archived
  SDK-migration gate's own, still-open "live browser" gap and is unaffected
  by this session.

## 0.3 — Gate decision

| Stop condition (tasks.md 0.3) | Verdict |
|---|---|
| SDK resume cannot preserve model context without browser-action replay | **PASS** (does not hold) — G1: context restored on the wire; tool handler invocation count delta = 0 across resume |
| Missing sessions are not explicit | **PASS** (does not hold) — G2, G3: both a thrown terminal error and (where captured before the throw) an explicit `is_error: true` result with a specific message; never a silent fresh session |
| Budget/usage semantics cannot be observed | **PASS** (does not hold) — G6b, G7, G8, G9, G10 all produced real, captured observations, including one real-dollar gateway call (G9) |

**Overall verdict: PASS — the gate is cleared. No stop condition holds.**

G6's finding (paced streaming-input turns are not capped by `maxTurns` the
way a single query's internal tool loop is, per G6b) and G3b's finding (`cwd`
does not gate `resume`, so tasks.md 2.1/2.4's compatibility check cannot rely
on the SDK to reject a mismatch) are both real, precise,
worth-carrying-forward nuances for later groups — neither is one of the three
literal stop conditions (in both cases the semantics genuinely **were**
observed; they simply differ from what a naive reading of design.md's
existing text might assume). G6 directly validates design.md decision 4's
existing plan to keep a **local** turn/wall-clock admission counter
authoritative rather than relying on SDK `maxTurns` alone; G3b is new
information design.md decision 2 did not yet have. No
transcript prompt replay was added anywhere in this session, and no hard
dollar ceiling was promised anywhere in this report — `total_cost_usd` is
labeled an SDK estimate throughout, per sdk.d.ts:4966.

## 0.4 — Repository verification baseline

- **Test commands**: root `test/README.md` documents `for t in test/*.test.mjs;
  do node "$t" || break; done` for the extension/humanize suite (3 files).
  `host/` has no equivalent README; the full-suite convention for
  `host/test/` (48 `*.test.mjs` files today) is instead codified in
  `.github/workflows/publish-host.yml`'s `test` job: `for f in
  host/test/*.test.mjs; do node "$f"; done` with `set -e` (every file must
  exit 0).
- **Host test-script limits**: `host/package.json`'s `"test"` script runs
  only **3 of the 48** files in `host/test/` (`endpoint.test.mjs`,
  `parent-watch.test.mjs`, `ownership.test.mjs`) — `npm test` inside `host/`
  is **not** the full suite; CI's explicit glob loop (above) is what actually
  exercises everything. This is why this session's gate script was
  deliberately placed **outside** `host/test/*.test.mjs`, under
  `host/agent/spike/gates/` (see the file's own header comment) — inside
  `host/test/`, CI's `set -e` loop would have made G6's genuine, reproducible
  FAIL (and any future `--live`-gated exercise of G9) block every future
  publish.
- **No-root-package assumption**: confirmed — `ls package.json` at the repo
  root fails (no such file); only `host/package.json` exists.
  Ran the existing, in-scope `host/` regression subset after this session's
  changes to confirm nothing was disturbed: `node host/test/endpoint.test.mjs`
  (7/7), `node host/test/parent-watch.test.mjs` (3/3), `node
  host/test/ownership.test.mjs` (12/12) — all passing, unchanged.
- **Live browser requirements**: none of this group's gates required or used
  a live Chrome/extension — every browser-action-replay proxy in G1 used an
  in-process SDK tool handler, the same registration mechanism real browser
  tools use, per the task's own instruction to prefer the fixture wherever an
  assertion can be observed without a real provider/browser.
- **Gateway requirements**: only G9 required a live, credentialed gateway; it
  resolved one from the operator's own already-configured profile via the
  production `snapshotForRun()` path and made exactly one real call.
- **Secret-free evidence storage**: confirmed by direct grep of the full
  `--live` run's captured log for API-key/bearer/authorization patterns —
  zero matches beyond this file's own placeholder fixture key literals
  (`sk-ant-fixture-...`, `sk-ant-gate-...`, `sk-ant-spike-...`, none of which
  are real). This report and the gate script contain no credential value,
  consistent with that check.

## Real cost incurred this session

**$0.00428**, exactly one real API call (G9), against the operator's own
already-configured profile/gateway. Every other gate ran at $0 against the
local in-process fixture server.

## Assertions left UNOBSERVED (and why)

- **`managed` costBasis** (org managed-settings pricing): structurally
  unreachable inside this project's deliberately isolated `settingSources: []`
  harness — an intentional consequence of the isolation contract every later
  group also inherits, not a gap to close.
- **Live-browser tool-call replay** (as opposed to the in-process SDK-tool
  proxy G1 used): no live Chrome/extension was attached in this session,
  matching the still-open gap already tracked by the archived
  `migrate-to-claude-agent-sdk` change's own gate 1.3/1.6.
