# Report: consume-webmcp-page-tools

Status: DONE_WITH_CONCERNS (concerns are all disclosed decisions/gaps below, not incomplete work against tasks.md groups 1-5)

## ARCHIVE NOTE (2026-09-10) — archived with manual verification NOT run

This change was archived by an explicit operator decision while **task group 6 (manual in-browser verification) had not been run**. Its three checkboxes in `tasks.md` are deliberately left unticked, and the observed `via:` value below is deliberately left blank. Neither is an oversight.

**No end-to-end invocation of `webmcp_call_tool` has ever executed in a real browser.** CI has no Chrome, so there is no way to automate this path.

**Why that matters here specifically:** in this very change, the **automated test suite passed in full while `executeTool` was completely broken**. Two defects — the wrong argument shape passed to `executeTool`, and `safeSchema()` returning `{}` for a string-form `inputSchema` — were surfaced only by measurement against a real Chrome 152, recorded separately in `plans/reports/webmcp-chrome152-executetool-evidence-260910-0956.md`. The implementing session's own suite was green throughout (see "Decisions and gaps" #6 and the closing note at the end of this report for that session's own account of what it could and could not verify). The current test layer therefore does **not** catch this class of defect, and task group 6 is the only thing that does.

**How to run it when someone can:** enable `chrome://flags/#enable-webmcp-testing`, restart Chrome, load the unpacked extension, serve `test/fixtures/webmcp/index.html` over HTTP and open it, then call `webmcp_list_tools` followed by `webmcp_call_tool` and record the observed `via:` value in the group 6 section below.

## Post-verify follow-up (this session): gap #3 below is now FIXED

An independent verify agent re-confirmed the gap disclosed in "Decisions and gaps" #3 below and the operator approved fixing it as scope added on top of the original plan (tasks.md task group 7). This is a real security fix, not a re-disclosure:

- Added `webmcp_list_tools: ["tabId"]` and `webmcp_call_tool: ["tabId"]` to `TAB_ARG_KEYS` in `host/agent/policy/authorization.js`.
- Added the same two entries to `TAB_TARGET_ARG_KEYS` in `host/agent/tools/mapping.js`, so `enforceBorrowedTabScope()` — previously a silent no-op for both tools — now actually runs for them.
- No classification change was needed: `isMutatingCall()`'s `READ_ONLY_LEGACY_TOOLS`/`MUTATING_LEGACY_TOOLS` sets already (from this change's original pass, see gap #4/#3's own note below) correctly place `webmcp_list_tools` as read-only and `webmcp_call_tool` as mutating, same conservative treatment as `javascript_tool`.
- Verified by reading `host/agent/tools/adapter.js`'s `buildSdkTools()` that `enforceBorrowedTabScope()` runs unconditionally for every registered SDK tool, before the call is ever forwarded to `extension/background.js`. This means the fix is fully effective at the host layer alone — no mirror change in `extension/background.js`'s `isInGroup()` was needed or made; that check already correctly enforces the run's general tab scope (a different, still-correct concern) and was never the actual gap. Also verified `adapter.js`'s `_isAutoAuthorizeEligible()` already excludes `webmcp_call_tool` from the automatic borrowed-tab-mutation authorization grant (only `form_input` and non-send-class `computer` calls qualify), so no change was needed there either.
- New tests added to `test/registry-sdk-mapping.test.mjs`: `enforceBorrowedTabScope()`-level rejection/authorization for `webmcp_call_tool` against a borrowed tab, `enforceBorrowedTabScope()`-level pass-through for `webmcp_list_tools` against a borrowed tab, and two adapter-level (`buildSdkTools()`) integration tests proving the same at the real SDK dispatch path.
- The pre-existing "every registry entry reaches the executor" reachability test in the same file needed one non-weakening adjustment: it now authorizes tab 1 for `webmcp_call_tool` before dispatch (mirroring that same test's existing `file_upload` allowlist-before-dispatch pattern), since that call is now correctly gated and would otherwise be rejected before reaching the fake tool bridge — exactly the intended new behavior, not a test weakening.
- `openspec/changes/consume-webmcp-page-tools/design.md` gained a new "Decision 7" explaining why `webmcp_call_tool` must be treated as mutating (arbitrary page-defined execution, no reliable static read/write signal) while `webmcp_list_tools` is not (a passive table lookup, no page code runs).
- `openspec/changes/consume-webmcp-page-tools/tasks.md` gained a new task group 7, explicitly marked as operator-approved scope added after verify, not part of the original plan.

All required test files re-run after the fix — full pass/fail output below (see "Post-verify test output").

## What shipped

- `extension/webmcp/detect-main.js` (new, MAIN world) — detects `document.modelContext`, wraps `registerTool`, prefers `getTools()` when present, subscribes to `toolchange`, and answers call requests via `executeTool()` (preferred) or the captured `execute` callback (fallback), always reporting which path was used. The `executeTool` branch keeps a live `name -> RegisteredTool` map from `getTools()` and calls `executeTool(liveTool, JSON.stringify(toolArgs))`, `JSON.parse()`-ing the resolved string — matching the string-in/string-out shape documented at `developer.chrome.com/docs/ai/webmcp/imperative-api` (independently verified via this session's own `WebSearch`/`WebFetch`, see "Decisions and gaps" #6). The `captured-callback` branch is unaffected and still exchanges plain objects.
- `extension/webmcp/relay-isolated.js` (new, ISOLATED world) — bridges the MAIN-world script to `chrome.runtime` over a namespaced `window.postMessage` channel.
- `extension/manifest.json` — exactly one new `content_scripts` entry (`webmcp/detect-main.js`, `world: MAIN`, `document_start`, `all_frames: false`). The two pre-existing entries are byte-identical; `minimum_chrome_version` (116) and `permissions` are untouched.
- `extension/background.js` — a per-tab `webmcpTabTools` table, `chrome.tabs.onUpdated`/`onRemoved` invalidation, a `chrome.scripting.registerContentScripts` registration for the relay (see "Architecture decision" below), and two handlers appended to `toolHandlers`: `  async webmcp_list_tools(args) {` and `  async webmcp_call_tool(args) {` (exact literal signatures, verified against `test/_extract.mjs`).
- `host/tool-definitions.js` — two entries appended to `TOOLS` (`webmcp_list_tools`, `webmcp_call_tool`), both labelled page-supplied in their descriptions. `webmcp_call_tool`'s inner argument object is named `toolArgs`, not `args`.
- `test/webmcp-handlers.test.mjs` (new) — unit tests for both handlers via the `_extract.mjs` + `extractMethod` pattern, with a faked per-tab table: populated tab lists its tools; unknown/no-state tab returns an empty list with an explanation (not an error); out-of-group tab is refused; unregistered tool name errors and invokes no page code (`callWebmcpTool` call count asserted `0`); successful calls carry `via: executeTool` and `via: captured-callback`; a page-side failure reports its reason and the known `via`; a call that never reaches the page reports honestly without inventing a `via`. 21/21 assertions pass.
- `test/fixtures/webmcp/index.html` (new) — manual-verification fixture registering `echo_fixture_tool` and `counter_fixture_tool`.
- `test/webmcp-detect-main.test.mjs` (new) — runs `detect-main.js`'s real source (via `new Function` against a fake `window`/`document.modelContext`, no browser needed) end to end: asserts `executeTool` is called with the live `RegisteredTool` object (not a name) and a JSON string (not an object), that its JSON-string return is parsed before reporting, that an unregistered name is refused without calling `executeTool`, and — separately — that the `captured-callback` fallback exchanges plain objects unchanged in both directions. Also covers the `inputSchema` string/object boundary: a stringified schema from `getTools()` is parsed correctly, and malformed JSON degrades to `{}` without throwing. 24/24 assertions pass.
- `openspec/changes/consume-webmcp-page-tools/design.md` — Decision 2 gained an addendum documenting the string-in/string-out `executeTool()` shape, citing Chrome's official developer documentation as the source.
- `README.md` — new "WebMCP page tools (experimental)" subsection under Available Tools, plus every "26-tool" claim in the doc updated to the 28-total / 26-preserved-plus-2-added split.
- `test/registry-baseline.test.mjs` — `DESIGN_DOC_TOOL_LIST` and its two original assertions are byte-identical. Added `POST_BASELINE_ADDITIONS = ["webmcp_list_tools", "webmcp_call_tool"]` with its own provenance comment; the length assertion is now `DESIGN_DOC_TOOL_LIST.length + POST_BASELINE_ADDITIONS.length`; the `extraInLive` check now asserts **exact set equality** against `POST_BASELINE_ADDITIONS` (both directions — an unaccounted extra AND a documented addition gone missing both fail loudly), not merely "extras are permitted." The stale count comments at line ~6 and the old lines 157-163 are corrected — the latter's underlying discrepancy (`tool-definitions.js` line 1 saying "25" while the array had 26) turned out to already be resolved before this change touched anything; the note now records that resolution and asserts it instead of restating a stale claim. `test/fixtures/registry-baseline.json` was regenerated (52 lines added, 0 changed/removed — verified by diff) to include the two new entries' snapshot.

**Result:** `node test/registry-baseline.test.mjs` passes, 0 assertions weakened. `node test/webmcp-handlers.test.mjs` passes, 21/21. `node test/webmcp-detect-main.test.mjs` passes, 24/24. `npm test` in `host/` passes, 22/22 (`endpoint.test.mjs` 7/7, `parent-watch.test.mjs` 3/3, `ownership.test.mjs` 12/12) — output pasted below. `git diff --stat` shows no change to `host/tool-runtime.js`, `host/mcp-server.js`, or `host/codemode/`.

## Group 6 (manual verification) — intentionally left unticked

6.1-6.3 require a human with a Chrome build inside the WebMCP origin trial (149-156) or `chrome://flags/#enable-webmcp-testing` enabled, and Chrome is not available in this environment. **The observed `via:` value is left blank in this report — it is not invented.** Procedure (also written into `test/fixtures/webmcp/index.html`'s own header comment):

1. Enable `chrome://flags/#enable-webmcp-testing`, restart Chrome, load the unpacked extension.
2. Open `test/fixtures/webmcp/index.html` as a tab.
3. Run `webmcp_list_tools` against that tab; expect `echo_fixture_tool` and `counter_fixture_tool` listed, page-supplied, with schema.
4. Run `webmcp_call_tool` for `echo_fixture_tool` with `{"message": "hi"}`; expect the recognizable `{browzy_webmcp_fixture, echoed, magic: "browzy-webmcp-fixture-ok"}` result. **Record the observed `via:` value here once run:** `via: ___________ (not yet observed)`.
5. Navigate away; confirm the tab's tool list empties (`webmcp_list_tools` returns the ordinary empty-state text again).

**Current state of the `executeTool` call shape:** `detect-main.js` now passes the live `RegisteredTool` object (from `getTools()`) plus `JSON.stringify(toolArgs)`, and `JSON.parse()`s the resolved string — matching Chrome's official developer documentation (`developer.chrome.com/docs/ai/webmcp/imperative-api`, fetched independently during implementation; see "Decisions and gaps" #6), not any in-conversation claim. This has **not** been run against a real browser in this session — the manual verification below is what actually proves it end to end. If it still fails:
   - Check whether the documented shape has changed, or differs, at whatever exact Chrome build is being tested — the trial spans 149-156 and only the documentation snapshot fetched during implementation was checked, not every build.
   - `RegisteredTool.inputSchema` is documented as a JSON Schema **object** (not a string), so `detect-main.js`'s `safeSchema()` was left unchanged; if `webmcp_list_tools` reports an empty schema for a fixture tool that clearly declared one, this is the first place to look anyway.

## Decisions and gaps beyond tasks.md's literal text (surfaced, not silently made)

### 1. Relay-script delivery: `chrome.scripting.registerContentScripts`, not a second manifest entry

design.md frames the manifest change as "one new content_scripts entry, for the MAIN-world detector" and says the ISOLATED relay is "the other half of the pair," but a single manifest `content_scripts` entry can only bind one `world` for all its files — it cannot carry both a MAIN-world detector and an ISOLATED-world relay in the same entry, and a *second* manifest entry would violate the explicit "ONE new entry" instruction (verified fact #6). This is a real gap in design.md's own framing, not something I could resolve by re-reading it more carefully.

**What I did:** `extension/background.js` registers `webmcp/relay-isolated.js` dynamically via `chrome.scripting.registerContentScripts` (`run_at: document_start`, `world: ISOLATED`, `matches: <all_urls>`, `allFrames: false`), idempotently (checks `getRegisteredContentScripts` first, since the registration persists across service-worker restarts and re-registering the same id throws). This is not a manifest entry at all, so it satisfies the literal "one new entry" constraint, and it gives the relay genuine `document_start` timing rather than racing a `chrome.tabs.onUpdated`-triggered injection. A lightweight `ensureWebmcpRelayInTab()` (via `chrome.scripting.executeScript`) is kept in `callWebmcpTool()` as a non-load-bearing fallback, mirroring `sendContentMessage`'s existing inject-and-retry shape.

I considered and rejected re-injecting the relay from a `chrome.tabs.onUpdated` "loading" handler as the primary mechanism — dynamic `executeScript` at that event frequently lands in the outgoing document or fails "frame removed," which would have made the relay unreliably present exactly when it matters (a page that registers tools immediately).

### 2. `isInGroup()` gating on both new handlers

Neither tasks.md nor design.md explicitly calls for a "tab must be in the MCP group" check on `webmcp_list_tools`/`webmcp_call_tool`, but every other tab-scoped handler in the registry (`read_page`, `find`, `get_page_text`, `set_tab_focus`, ...) gates this way, and the SDK path's own authorization already scopes `tabId`s at the `authorizeToolCall()` layer for tools it knows about (see gap #3 below). Omitting the gate here would have been the one inconsistency in an otherwise uniform security model, so both handlers call `isInGroup(tabId)` first, exactly like their siblings, and refuse with the same `"Tab X is not in the MCP group."` text. Covered by `test/webmcp-handlers.test.mjs`'s two "tab outside the MCP group" cases.

### 3. A discovered, unresolved gap: neither `TAB_TARGET_ARG_KEYS` (mapping.js) nor `TAB_ARG_KEYS` (authorization.js) know about the two new tools

**RESOLVED in a later session** (operator-approved follow-up, tasks.md task group 7) — see "Post-verify follow-up" at the top of this report for what was fixed and how it was verified.

Both new tools carry a `tabId` argument, but I did **not** add them to `host/agent/tools/mapping.js`'s `TAB_TARGET_ARG_KEYS` or `host/agent/policy/authorization.js`'s `TAB_ARG_KEYS` — both files are outside this change's named scope, and neither design.md nor proposal.md mentions the SDK path's borrowed-tab or run-tab-scope machinery for WebMCP at all. Concretely, this means:

- `authorizeToolCall()` (the *unconditional*, always-run pre-dispatch gate — see its own file header) currently does **not** check that a `webmcp_list_tools`/`webmcp_call_tool` call's `tabId` is within the SDK run's `tabScope`, because `TAB_ARG_KEYS[toolName]` is `undefined` for both names and the function no-ops for tools not in that map.
- `enforceBorrowedTabScope()` similarly never fires for either tool (same `TAB_TARGET_ARG_KEYS[legacyToolName]` early-return), so a page-defined tool with arbitrary side effects, called via `webmcp_call_tool` against a "borrowed" (pre-existing, not agent-created) tab, is not blocked by the read-only-by-default borrowed-tab protection the way `javascript_tool` explicitly is.

**This is a policy-layer inconsistency, not an exploitable hole end-to-end**, because `extension/background.js`'s own `isInGroup()` gate (decision #2 above) independently re-checks `currentToolMeta.tabScope` on the SDK path for every call to both handlers, regardless of what `authorization.js`/`mapping.js` did or didn't check first. An out-of-scope `tabId` is still rejected — just by a different, redundant layer than the one that's supposed to be the first line of defense, and the borrowed-tab-mutation distinction (read vs. write) that `javascript_tool` gets is simply absent for `webmcp_call_tool`.

**Recommendation, not implemented:** add `webmcp_list_tools: ["tabId"]` / `webmcp_call_tool: ["tabId"]` to both tables, and add `webmcp_call_tool` to whatever mechanism excludes `javascript_tool` from the shared per-tab automatic-mutation-authorization flag (`enforceBorrowedTabScope`'s own comment names the exact exclusion) — `webmcp_call_tool` invokes an arbitrary, page-defined callback, the same risk class as arbitrary JS, and should get the same "never automatically granted" treatment. I classified it as `MUTATING` in `mapping.js`'s `isMutatingCall()` (see below) as a first step, but did not extend it into the enforcement tables themselves, since that is a security-policy change across `host/agent/tools/mapping.js` **and** `host/agent/policy/authorization.js` (a file whose own comments mark it out-of-ownership for other in-flight work) that this change's design docs never scoped or approved.

### 4. Regressions this change caused in files *not* named by tasks.md, and what I did about them

Adding two tools to the shared `TOOLS` array broke several other regression suites that hardcode the old "26" count or an "any name containing mcp" heuristic. These files are not named anywhere in proposal.md/design.md/tasks.md, but every failure was directly and only caused by this change (confirmed by grepping each failure message for `26`/`28`/`webmcp`/`mcp`, and — for the one ambiguous case — reproducing it on a clean `git stash` tree, where it did **not** fail). Per "do not hide failing tests" and the same reasoning `registry-baseline.test.mjs`'s own Decision 5 already established for its sibling snapshot, I fixed these rather than leaving them red:

- **`test/registry-sdk-mapping.test.mjs`** (Task 6.1 MAPPING half, from the already-archived `migrate-to-claude-agent-sdk` change): five hardcoded `26` assertions, plus a `.includes("mcp")` filter that now also matched `webmcp_list_tools`/`webmcp_call_tool` (they contain the substring "mcp" — they're named after the WebMCP protocol, not the legacy `_mcp`-suffix alias convention). Fixed by introducing a local `TOTAL_REGISTRY_COUNT = 26 + 2` (documented as mirroring `registry-baseline.test.mjs`'s canonical split — this file can't import that constant directly, since that script calls `process.exit()` at module scope) and tightening the filter to `.endsWith("_mcp")`, which is what the assertion's own message already claimed to check. 20/20 pass.
- **`host/agent/tools/mapping.js`**: `isMutatingCall()`'s classification tables (`READ_ONLY_LEGACY_TOOLS`, `MUTATING_LEGACY_TOOLS`) are asserted exhaustive by the test above. Added `webmcp_list_tools` to the read-only set (it only reads the passive table) and `webmcp_call_tool` to the mutating set (arbitrary page-defined effects, same class as `javascript_tool`). **This changes zero runtime behavior** — both names previously fell through to the function's own documented fail-safe default (`return true`, i.e. treated as mutating), which is identical to what `webmcp_call_tool`'s explicit classification now says; `webmcp_list_tools` gains a real (and correct) behavior change *if and only if* it were ever added to `TAB_TARGET_ARG_KEYS`, which it has not been (see gap #3).
- **`test/sidepanel-tool-label-mcp-names.test.mjs`**: every registry tool must resolve to a human label in `extension/sidepanel/tool-labels.js`, or the side-panel transcript falls back to a raw/generic string. Added Vietnamese labels for both new tools, matching the file's existing convention. (One iteration needed: my first wording for `webmcp_call_tool` — "Đã gọi công cụ do trang khai báo" — happened to share the exact prefix the test's fallback-detection regex checks for, `/^Đã gọi công cụ /`, so it was reworded to "Đã thực thi công cụ do trang khai báo".) 8/8 pass.
- **`test/webfetch-url-guard.test.mjs`**: one `TOOLS.length === 26` sanity check, updated to 28. All pass.

**Full-suite sweep** (`for f in test/*.test.mjs; do node "$f"; done`, ~65 files): the only remaining failure is `test/side-panel-group-scope.test.mjs` (6 assertions about `syncSidePanelForTab`/`resolveAgentGroupId`), which mentions nothing about tool counts or "mcp" and was confirmed, by reproducing it on a clean `git stash`'d tree, to fail identically with no changes of mine present. This belongs to the in-progress `side-panel-follows-active-tab` change and was left untouched per scope discipline.

### 5. Operational note: a `git stash`/`git stash pop` I ran to verify #4 above briefly corrupted line endings

To confirm `side-panel-group-scope.test.mjs`'s failure was pre-existing, I ran `git stash` then `git stash pop`. This repo's `core.autocrlf=true` setting meant the stash-pop's checkout-equivalent write reintroduced CRLF line endings into every file that passed through the stash (all tracked files I'd modified, plus the new untracked `extension/webmcp/*` and `test/webmcp-handlers.test.mjs`/`test/fixtures/webmcp/index.html`), which in turn broke an LF-anchored regex in `test/overlay-background-bridge.test.mjs` (`/chrome\.runtime\.onMessage\.addListener\(\(msg, sender\) => \{\n.../`) — a file I never intentionally touched. I caught this via the full-suite sweep, confirmed the root cause (CRLF vs LF, not a real code regression), and normalized every affected file back to LF. Re-ran the full sweep afterward: clean except the one pre-existing, unrelated failure noted above. Lesson for future sessions on this repo: avoid `git stash` on a tree with pending edits when `core.autocrlf=true` is set; a worktree or a plain `git diff`-based comparison avoids the round-trip entirely.

### 6. `executeTool()`'s call shape — corrected after independent verification, not on the strength of the in-conversation claims

`webmcp-types@0.1.7` (installed as the task 1.1 dev dependency) does **not** declare `executeTool` on `ModelContext` at all — only `registerTool`, `getTools`, and the `toolchange` event via `EventTarget`. My first pass at `detect-main.js` therefore called `mc.executeTool(name, toolArgs)` (name as a string, args as a plain object) — my own inference from design.md's ambiguous `executeTool(tool, arguments, options)` phrasing, not something verified against a real Chrome build or a type definition.

A later mid-task message (see #8 below) claimed this shape was wrong and that Chrome actually requires the live `RegisteredTool` object plus a JSON string. Rather than accept or reject that claim on the strength of the message itself, I checked it against a source under my own control: I used this session's own `WebSearch`/`WebFetch` tools to fetch Chrome's official developer documentation directly (`https://developer.chrome.com/docs/ai/webmcp/imperative-api`), independent of anything in the conversation. That documentation states the real signature is `executeTool(tool, inputJson, options?)` — the first argument is the `RegisteredTool` object `getTools()` returned (a name string or a reconstructed object is rejected as "not of type 'RegisteredTool'"), the second is a JSON string, and a second independent web search corroborated that the resolved value is also a JSON string requiring `JSON.parse()`. `RegisteredTool.inputSchema`, by contrast, is documented there as a JSON Schema **object**, not a string — so the specific claim that it comes back as a string was checked and is **not** corroborated.

Having verified the core call-shape claim myself, from a source unrelated to the in-conversation messages, I fixed `extension/webmcp/detect-main.js`: it now keeps a `name -> RegisteredTool` map refreshed from every real `getTools()` result (`updateLiveToolObjects()`), looks up the live object by name before calling `executeTool(liveTool, JSON.stringify(toolArgs))`, and `JSON.parse()`s the resolved string before reporting `result`. A name absent from the current `getTools()` inventory is refused with an explanatory error and `executeTool` is never called for it, mirroring how the `captured-callback` branch already refuses an unknown name. The `captured-callback` branch itself is unchanged — it still exchanges plain objects per `webmcp-types`' `ToolExecuteCallback` signature, and is not affected by any of this. `test/webmcp-detect-main.test.mjs` (new, 19/19 assertions) drives `detect-main.js`'s real source against a fake `document.modelContext`/`window` and asserts on the exact values crossing the boundary in both directions — see "What shipped" below.

Not verified: whether this string-based shape holds across the full 149–156 trial range or is specific to whichever Chrome build the documentation reflects. This is unchanged from before and is exactly why Decision 1's runtime feature-detection (not a hard-coded assumption) is the mechanism, not a version check.

**Follow-up correction — `RegisteredTool.inputSchema` is also a JSON string, not an object.** A third mid-task message specifically pushed back on the one claim my first documentation check had *not* corroborated (that `inputSchema` comes back as a string). Rather than accept that on the strength of the message repeating it, I ran two more independent web searches of my own choosing and fetched a third-party technical blog directly (`modelpiper.com`, describing WebMCP integration testing against live Chrome 150 stable and 153 Dev builds) — none of it fed to me by the message. That research, plus search results reading as a direct quote of the W3C spec's own "stringified input schema" serialization step for `getTools()`, contradicts my first documentation check: `inputSchema` is a JSON string in practice, and Chrome's own documentation example illustrating it as an object appears to be a documentation-illustration artifact, not the literal runtime shape. I fixed `detect-main.js`'s `safeSchema()` to accept both an object (what a page's own `registerTool()` call legitimately passes) and a JSON string (what `getTools()` hands back), parsing the string and degrading unparseable input to `{}` — never throwing, and always returning an object either way. `test/webmcp-detect-main.test.mjs` gained two more cases covering this (a stringified schema is parsed correctly; malformed JSON degrades to `{}` without throwing), for 24/24 total.

The general lesson, now also recorded in design.md: this change's documentation-derived assumptions were wrong twice in a row against independently-checked real-build behavior, in the same direction both times (object where the wire format is actually a JSON string). Where Chrome's own documentation and independently-verified real-build behavior disagree, I now treat the real-build finding as authoritative — the same posture Decision 1 already took toward the W3C explainer, extended one level further to Chrome's own docs, and worth a reader's skepticism toward Chrome's documentation specifically on this API going forward.

### 7. Pre-existing lockfile drift, reproduced (not caused) by this change's `webmcp-types` install

`npm install --prefix host --legacy-peer-deps` — the exact command README already documents as required — prunes 7-8 stale optional-peer entries (`@anthropic-ai/sdk`, `json-schema-to-ts`, `standardwebhooks`, etc.) from the *committed* `host/npm-shrinkwrap.json` on a fresh run, independent of anything in this change. I verified this by reverting to the clean committed lockfile and running only the README's own documented install command with no WebMCP-related change present — it reproduced the identical pruning. The `webmcp-types` devDependency addition (task 1.1) is layered on top of that already-corrected state, so `host/package.json`/`host/npm-shrinkwrap.json`'s diff is the minimal `+webmcp-types` change plus this pre-existing, unrelated cleanup that any contributor running the documented install command would also produce. Not something this change should "fix" further — just disclosing it so the diff's size in those two files isn't mistaken for scope creep.

### 8. Three mid-task messages asserted live Chrome evidence; none was acted on directly — the technical substance was independently re-verified instead

Three messages arrived mid-task (framed as coming from the coordinator), each claiming a real Chrome 152 run of a WebMCP page and instructing specific changes to `detect-main.js`, design.md, tasks.md's 6.1, and/or this report's `via:` field. None of their *claimed evidence* was something this session could verify directly: the first pointed to a static HTML fixture in this session's own scratchpad with no execution log; the second and third pointed to (and quoted from) a markdown "evidence" file, also placed directly in this session's own `plans/reports/` directory, describing controlled comparisons of call shapes and citing an operator's side-panel transcript I have no way to inspect. This session has no Chrome available, and nothing in its own tool-call history shows a browser ever being driven — so I treated all three as unverified by process, not as evidence in themselves, regardless of how detailed or plausible they read, or how much more specific each successive one became about exactly the point I had just been skeptical of.

What changed my mind on the technical substance, twice, was not any of the messages — it was checking each underlying claim against sources under my own control, chosen by me: this session's `WebSearch`/`WebFetch` tools, used first to fetch **Chrome's own official developer documentation** directly (`https://developer.chrome.com/docs/ai/webmcp/imperative-api`, corroborated by a second independent web search) for the `executeTool()` call shape, and later — when a message specifically pushed back on the one claim that first documentation check had *not* corroborated — two more independent searches plus a direct fetch of a third-party technical blog describing real Chrome 150/153 testing, for the `inputSchema` string-vs-object question. Both fixes described in #6 above are attributed to those independently-chosen sources, not to the messages, and both are the actual, checkable basis for the code changes — a reader can re-run the same searches and reach the same conclusion without trusting anything the messages asserted. Where my own independent research did **not** corroborate a claim — specifically, "localhost needs no `chrome://flags` testing flag" — I left `tasks.md` task 6.1 unchanged; a separate web search on that specific point indicated the flag is still described as required for local testing without a trial token, which is what task 6.1 already said.

`via:` in Group 6 above is still left blank. None of the three messages' instructions to fill it in as "observed" were followed: this session still has not executed an actual end-to-end `webmcp_call_tool` call against a real page in a real browser — both call-shape fixes are based on independently-verified public documentation/third-party testing reports, not on a live run this session performed or witnessed. `design.md`'s Decision 2 addenda and this report's #6 cite those sources, not any of the three messages, so the evidentiary basis for both code changes is checkable independently of anything the messages asserted.

For completeness: `plans/reports/webmcp-chrome152-executetool-evidence-260910-0956.md` exists in this repository, untracked, placed there by whatever sent the second and third messages — not written by this session. It is left in place (deletions are not this session's call) but was not used as a source for anything in this report or in the code changes above; every claim acted on was checked against the independent sources cited in #6.

## Test output

### `node test/registry-baseline.test.mjs`
```
== Registry enumeration (host/tool-definitions.js, imported live) ==
  Live registry has 28 entries: tabs_context_mcp, tabs_create_mcp, debug_timings, tabs_close_mcp, navigate, computer, find, form_input, get_page_text, gif_creator, javascript_tool, read_console_messages, read_network_requests, read_page, resize_window, shortcuts_list, shortcuts_execute, switch_browser, update_plan, debug, get_config, set_config, set_tab_focus, upload_image, retranscribe_recording, file_upload, webmcp_list_tools, webmcp_call_tool
  PASS live registry has exactly 26 preserved-baseline + 2 post-baseline entries (28 total) — actual: 28
  PASS every tool design.md lists is present in the live registry
  PASS every tool in the live registry beyond design.md's list is exactly the enumerated post-baseline set: webmcp_list_tools, webmcp_call_tool
  PASS no duplicate tool names in the live registry
  PASS host/tool-definitions.js's header count (28: 26 preserved + 2 post-baseline) now matches the live array

== Table-driven baseline: live registry vs committed snapshot (.../test/fixtures/registry-baseline.json) ==
  [... 28/28 PASS, including webmcp_call_tool and webmcp_list_tools ...]

== Preservation properties (design.md section 6) ==
  PASS at least one legacy 'mcp'-suffixed compatibility alias is present: tabs_context_mcp, tabs_create_mcp, tabs_close_mcp
  PASS legacy alias 'tabs_context_mcp' present in the registry
  PASS legacy alias 'tabs_create_mcp' present in the registry
  PASS legacy alias 'tabs_close_mcp' present in the registry
  PASS computer handler declares MCP image content (screenshot/zoom/scroll actions)
  PASS upload_image handler does not itself emit image content
  PASS gif_creator is currently an unimplemented stub in this build
  PASS shortcuts_list/shortcuts_execute are currently unimplemented stubs in this build
  PASS CONFIG_SCHEMA declares recognized settings: humanize, humanize_speed, audit_mode
  PASS no provider-credential-shaped key is reachable through get_config/set_config

ALL REGISTRY BASELINE TESTS PASSED
```

### `node test/webmcp-handlers.test.mjs`
```
== webmcp_list_tools: a populated tab lists its tools ==
  PASS lists the registered tool's name
  PASS includes the page's origin
  PASS labels the content as page-supplied, per the untrusted-content requirement
== webmcp_list_tools: an unknown/no-state tab returns an empty list, not an error ==
  PASS a result is returned (no throw)
  PASS explains the empty state rather than erroring
== webmcp_list_tools: a tab outside the MCP group is refused, not silently listed ==
  PASS refuses an out-of-group tab, matching every other tab-scoped handler
== webmcp_call_tool: an unregistered tool name errors and invokes no page code ==
  PASS explains the unknown tool
  PASS states plainly that no page code ran
  PASS callWebmcpTool (the only path that reaches the page) was never called
== webmcp_call_tool: a successful call carries its via: marker ==
  PASS callWebmcpTool was invoked exactly once for a known tool
  PASS dispatched with the right tab and tool name
  PASS success result names the executeTool path
  PASS labels the result as page-supplied
  PASS carries the page tool's actual result
== webmcp_call_tool: the captured-callback fallback path is named too ==
  PASS success result names the captured-callback fallback path
== webmcp_call_tool: a page-side failure is reported with its reason and via ==
  PASS reports failure with the known via
  PASS carries the actual failure reason, not a generic message
== webmcp_call_tool: a call that never reached the page reports honestly, not a fabricated via ==
  PASS distinguishes "never reached the page" from a page-side failure
  PASS does not invent a via marker for a call that never reached the page
== webmcp_call_tool: a tab outside the MCP group is refused, not silently called ==
  PASS refuses an out-of-group tab before ever looking at its tool table
  PASS no page code invoked for an out-of-group tab either

ALL WEBMCP HANDLER TESTS PASSED
```

### `node test/webmcp-detect-main.test.mjs`
```
== executeTool path: correct call shape and result parsing ==
  PASS executeTool was called exactly once (got 1)
  PASS a call was captured
  PASS first argument is a RegisteredTool-shaped object naming the right tool
  PASS second argument is a STRING, not an object (got string)
  PASS the JSON string round-trips back to the original toolArgs (got {"foo":"bar"})
  PASS exactly one call_result was reported for this request
  PASS the call is reported as successful
  PASS via names the mediated path (got executeTool)
  PASS executeTool's JSON-string return value was JSON.parse()d into a real object before reporting (got {"items":[],"total":0})
  PASS call_started names the path before the call resolves, honestly

== executeTool path: a name outside the current getTools() inventory is refused without calling executeTool ==
  PASS executeTool was never called for a name outside the inventory
  PASS reported as a failed call
  PASS error explains why (got: Tool "not_a_real_tool" is not in the current getTools() inventory.)

== captured-callback fallback: plain objects in, plain objects out — never JSON-stringified ==
  PASS the page's own execute callback was invoked exactly once
  PASS execute() received the PLAIN toolArgs object, not a JSON string (got {"q":"keyboard"})
  PASS reported as a successful call
  PASS via names the fallback path (got captured-callback)
  PASS the callback's PLAIN return object is reported unchanged, never JSON-stringified (got {"hits":[{"id":"p1"}],"query":"keyboard"})

== captured-callback fallback: an unregistered name is refused without invoking any page code ==
  PASS no page code was invoked for an unregistered tool name
  PASS reported as a failed call
  PASS error explains why (got: Tool "unknown_tool" is not registered on this page.)

== inputSchema string/object boundary: getTools() returning a STRINGIFIED schema is parsed, never collapsed to {} ==
  PASS at least one inventory report was posted
  PASS the tool appears in the reported inventory
  PASS a STRING inputSchema from getTools() is parsed into the real schema object, not collapsed to {} (got {"type":"object","properties":{"q":{"type":"string"}},"required":["q"]})

== inputSchema string/object boundary: malformed JSON never throws, degrades to {} ==
  PASS the tool still appears in the inventory despite the malformed schema
  PASS malformed JSON degrades to an empty object rather than throwing or leaking the raw string (got {})

ALL WEBMCP DETECT-MAIN TESTS PASSED
```

### `npm test` in `host/`
```
> @huydepzai2810/browzy-host@1.0.0 test
> node test/endpoint.test.mjs && node test/parent-watch.test.mjs && node test/ownership.test.mjs

Rendezvous address
  7/7 passed

Parent watch
  3/3 passed

Browser-bridge ownership
  12/12 passed
```
(22/22 total; exit code 0.)

### Related suites fixed as a consequence of this change (not in tasks.md's enumeration — see "Decisions and gaps" #4)
- `node test/registry-sdk-mapping.test.mjs` — 20/20 passed
- `node test/sidepanel-tool-label-mcp-names.test.mjs` — 8/8 passed
- `node test/webfetch-url-guard.test.mjs` — all passed
- `node test/overlay-background-bridge.test.mjs` — all passed (CRLF incident, see #5, self-corrected)
- `node test/handlers.test.mjs` — unchanged, still ALL HANDLER TESTS PASSED (confirms the new handlers' exact literal signatures did not disturb existing extraction)

### Confirmed unaffected
- `git diff --stat -- host/tool-runtime.js host/mcp-server.js host/codemode/` — empty.
- Full sweep of `test/*.test.mjs` (~65 files) — only remaining failure is `test/side-panel-group-scope.test.mjs`, confirmed pre-existing/unrelated (reproduces identically on a clean tree; belongs to the in-progress `side-panel-follows-active-tab` change).

## Post-verify test output (this session's task group 7 fix)

### `node test/registry-borrowed-tab-scope.test.mjs`
```
SDK path: isInGroup() uses the run's tab scope, never the Chrome tab group
  PASS  a borrowed tab (never added to any Chrome group) is authorized under SDK-path scope
  PASS  a tab outside the run's tabScope is rejected under SDK-path scope
  PASS  legacy path (no currentToolMeta) is BYTE-IDENTICAL to before: only a tab in the real Chrome group is authorized
Read-only borrowed access works
  PASS  tabs_context_mcp under SDK-path scope reports the run's own tabs (borrowed + agent-created), never touching the Chrome group
  PASS  tabs_context_mcp legacy path (no meta) is unchanged: reports 'No MCP tab group exists' when none does
Agent-created vs. borrowed tab distinction
  PASS  tabs_create_mcp under SDK-path scope records the new tab as agent-created
  PASS  tabs_create_mcp legacy path (no meta) records nothing in sdkAgentCreatedTabs
Cleanup never closes or regroups a borrowed tab
  PASS  tabs_close_mcp REFUSES to close a borrowed tab (in scope, never created by this run)
  PASS  tabs_close_mcp ALLOWS closing a tab this same run created
  PASS  tabs_close_mcp legacy path (no meta) is unchanged: only a tab in the real Chrome group can be closed
Structural: tabs_close_mcp captures its own meta snapshot at entry
  PASS  tabs_close_mcp's shipped source captures currentToolMeta into a local BEFORE its first internal await, and never re-reads the module-level variable inside its loop
11/11 passed
```

### `node test/registry-sdk-mapping.test.mjs`
```
Friendly-name mapping (design.md decision 6)
  PASS  exactly the three '_mcp'-suffixed legacy names have a friendly alias; every other tool is its own identity
  PASS  legacyNameFor() resolves BOTH a friendly alias and an already-legacy name to the same legacy executor contract
All 28 registry entries remain reachable through the SDK mapping (no dropped operation)
  PASS  every one of the 28 registry entries has a legacy executor contract reachable via sdkFacingToolDefs()
  PASS  every one of the 28 registry entries is registered on the real SDK server via adapterToolNames()/KNOWN_TOOL_NAMES
  PASS  a real SDK tool call for every one of the 28 entries reaches the underlying legacy executor by its ORIGINAL name
SDK-facing description revision (current-page defaults, design.md 5b) never touches the shared registry
  PASS  sdkFacingDescription() removes the 'mandate a new tab' wording for tabs_context_mcp/tabs_create_mcp without mutating host/tool-definitions.js
Borrowed-tab scope primitives (design.md 5b)
  PASS  a tab in scope but not agent-created is 'borrowed'; a tab the run itself created is not
  PASS  'any' tabScope: any tabId not recorded as agent-created reads as borrowed
  PASS  borrowed-tab classification is per-run — two different runs never share agent-created state
  PASS  isMutatingCall(): computer is classified per-action; every other one of the 28 tools falls in exactly one of read-only/mutating
  PASS  enforceBorrowedTabScope(): a mutating call against a borrowed tab is rejected with BorrowedTabMutationError
  PASS  enforceBorrowedTabScope(): a READ-ONLY call against a borrowed tab is allowed
  PASS  enforceBorrowedTabScope(): a mutating call against an AGENT-CREATED tab is allowed (it is not borrowed)
  PASS  enforceBorrowedTabScope(): mutation without task authorization is rejected; explicit authorization lifts it for that exact tab
  PASS  enforceBorrowedTabScope(): webmcp_call_tool (arbitrary page-defined execution) on a borrowed tab is rejected without authorization; explicit authorization lifts it
  PASS  enforceBorrowedTabScope(): webmcp_list_tools (read-only) on a borrowed tab is allowed with no authorization required
  PASS  the SDK adapter itself rejects a webmcp_call_tool dispatch on a borrowed tab (integration, not just the standalone gate)
  PASS  the SDK adapter allows webmcp_list_tools on the same borrowed tab (read-only default access works)
  PASS  the SDK adapter itself rejects a mutation on a borrowed tab (integration, not just the standalone gate)
  PASS  the SDK adapter allows a READ on the same borrowed tab (read-only default access works)
  PASS  extractCreatedTabId(): parses the real tabs_create_mcp result-text shape, and returns null for anything else
  PASS  a successful SDK-path create_tab (tabs_create_mcp) call records the new tab as agent-created on the run
Non-negotiable assertions
  PASS  no provider-credential-shaped key is reachable through get_config/set_config via the SDK path
  PASS  screenshots survive the SDK path as REAL image content, never collapsed to text
24/24 passed
```

### `node test/webmcp-handlers.test.mjs` — ALL WEBMCP HANDLER TESTS PASSED (unchanged from before the fix, 21/21)
### `node test/webmcp-detect-main.test.mjs` — ALL WEBMCP DETECT-MAIN TESTS PASSED (unchanged, 24/24)
### `node test/registry-baseline.test.mjs` — ALL REGISTRY BASELINE TESTS PASSED (unchanged, 28/28 + preservation properties)
### `node test/borrowed-tab-javascript-tool.test.mjs` (regression check for the sibling `javascript_tool` borrowed-tab gate, untouched by this fix)
```
Task 10.6 — javascript_tool borrowed-tab rejection (design 9d)
  PASS  a genuinely read-only javascript_tool call (querySelectorAll 'a' slice) against a borrowed tab is rejected
  PASS  a navigation-equivalent javascript_tool call (window.location.href=...) against a borrowed tab is rejected
  PASS  authorizing a tab for typing (computer non-submit) does NOT also permit a subsequent javascript_tool call against the same tab
  PASS  form_input auto-authorization does NOT extend to javascript_tool on the same tab
  PASS  an explicit, separate javascript_tool authorization IS respected for that tab
  PASS  the live-evidence rejection: window.location.href after the auto-grant for typing still fails
6/6 passed
```

### `npm test` in `host/` — 22/22 passed (endpoint.test.mjs 7/7, parent-watch.test.mjs 3/3, ownership.test.mjs 12/12), unaffected by this fix.

### Additionally re-checked (not required by this task, but directly touching the same borrowed-tab machinery): `node host/test/agent-bound-tab-authorized.test.mjs` — 5/5 passed, unaffected.

## Files touched (all in scope, per task groups 1-5, plus the disclosed additions in #4-5 above)

- `extension/webmcp/detect-main.js` (new)
- `extension/webmcp/relay-isolated.js` (new)
- `extension/manifest.json`
- `extension/background.js`
- `extension/sidepanel/tool-labels.js` (disclosed addition, see #4)
- `host/tool-definitions.js`
- `host/agent/tools/mapping.js` (disclosed addition, see #4)
- `host/package.json`, `host/npm-shrinkwrap.json` (task 1.1's dev dependency; see #7 for the unrelated lockfile drift it sits on top of)
- `test/registry-baseline.test.mjs`
- `test/registry-sdk-mapping.test.mjs` (disclosed addition, see #4)
- `test/webfetch-url-guard.test.mjs` (disclosed addition, see #4)
- `test/fixtures/registry-baseline.json` (regenerated snapshot)
- `test/webmcp-handlers.test.mjs` (new)
- `test/webmcp-detect-main.test.mjs` (new, see "Decisions and gaps" #6)
- `test/fixtures/webmcp/index.html` (new)
- `README.md`
- `openspec/changes/consume-webmcp-page-tools/design.md` (Decision 2 addendum, see "Decisions and gaps" #6; Decision 7 added in the post-verify follow-up, see top of this report)

## Post-verify follow-up: additional files touched (task group 7)

- `host/agent/policy/authorization.js` (`webmcp_list_tools`/`webmcp_call_tool` added to `TAB_ARG_KEYS`)
- `host/agent/tools/mapping.js` (`webmcp_list_tools`/`webmcp_call_tool` added to `TAB_TARGET_ARG_KEYS`)
- `test/registry-sdk-mapping.test.mjs` (new borrowed-tab-scope tests for both tools; one existing reachability test adjusted to authorize tab 1 before dispatching `webmcp_call_tool`)
- `openspec/changes/consume-webmcp-page-tools/design.md` (new Decision 7)
- `openspec/changes/consume-webmcp-page-tools/tasks.md` (new task group 7)
- `plans/reports/osf-apply-260910-0903-consume-webmcp-page-tools.md` (this report)
