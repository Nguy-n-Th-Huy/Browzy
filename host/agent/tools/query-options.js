// Isolated `query()` Options builder, productionized from
// host/agent/spike/lib/query-options.mjs (see reports/01-sdk-gate-evidence.md
// gate 1.6 for the empirically-verified isolation contract this preserves
// byte-for-byte: `env` REPLACES rather than merges with process.env,
// `settingSources: []`, `strictMcpConfig: true`, and a defense-in-depth
// `disallowedTools` list).
//
// `settingSources: []` is NOT the whole discoverability story any more
// (design.md decision 9, superseding decision 7): a session's approved
// skill snapshots are made discoverable via the SEPARATE `plugins` option
// (an explicit absolute-path load, added below in buildIsolatedOptions()),
// never by widening `settingSources`. Decision 7 tried adding `'project'`
// to `settingSources` and a real, unmocked `query()` proved it walks the
// ENTIRE ancestor directory tree with no repo-root gating at all - see
// plans/reports/blocker-260909-0712-project-settingsource-walkup-leak.md and
// host/test/skills-scope-verification.test.mjs. `settingSources` therefore
// stays `[]` here, untouched, exactly as this file's isolation baseline
// always intended; `plugins` has no ancestor walk-up of any kind (proven by
// host/test/skills-plugin-scope-verification.test.mjs) and is the ONLY
// discovery path added by this design.
//
// The one real change from the spike: credentials/model now come from the
// settings profile module (host/agent/settings/profile.js, owned by the
// parallel task-group-4 session — see its documented contract in this
// change's task-group-3 delegation) via `snapshotForRun(profileId, modelId)`,
// instead of being passed in directly by a gate script. That module does not
// exist yet in this working tree; `resolveProfileSnapshot` takes an
// injectable `profileProvider` so this file's own tests can exercise the
// full run-start path today with a local double that matches the documented
// contract exactly, while production code (host/agent/session/run.js) uses
// the default lazy dynamic import — so nothing here breaks or silently
// no-ops once group 4 lands the real module, and nothing here fails to
// import today because the import only happens when a run actually starts,
// never at module load time.
//
// Task 7.2's remaining gap (reports/10-task-reconciliation.md): this module
// used to hard-code `tools: []`, which also disabled the SDK's `Skill` tool,
// and accepted no skills-related parameter at all — the application-owned
// skills catalog (host/agent/skills/**) was fully built and tested but never
// reached a real `query()` call. Fixed by requiring a `skills` parameter
// (the caller's session binding — see host/agent/companion.js's
// `_bindSkillsForRun()`, which composes `buildSessionSkills()`'s output with
// the conversation's workspace directory): `skills.cwd` becomes the SDK
// `cwd` option (this run's own conversation workspace, never the companion
// process's own cwd shared across every conversation), `skills.pluginDir` —
// buildSessionSkills()'s materialized local plugin directory for THIS
// session — is what the SDK actually discovers, via the separate `plugins`
// option below (see its own comment; this is no longer routed through `cwd`/
// `.claude` scanning at all — see design.md decision 9), `skills.allowedSkillNames`
// becomes the `skills` allowlist option, `skills.skillOverrides` becomes the
// `skillOverrides` option, and
// `"Skill"` is added to the explicit `tools` list (sdk.d.ts's `skills` option
// docstring, around line 2088: "you do not need to add 'Skill' to
// `allowedTools` yourself when using this option" — this is about
// `allowedTools`, the SEPARATE auto-approval field described below, not the
// `tools` availability allowlist this isolation contract uses; `tools` is
// what actually gates which built-ins exist at all, per its own docstring, so
// `Skill` must be listed there explicitly for the tool to be invocable. Correction: an earlier revision of this comment
// misread that citation as calling `allowedTools` itself deprecated — it does
// not. Only passing `'Skill'` through `allowedTools` is deprecated
// (sdk.d.ts:1447, `Options.allowedTools`'s own docstring: "Note: passing
// 'Skill' here is deprecated — use the `skills` option instead"); `Skill` is
// therefore added to `tools` here but deliberately never to `allowedTools`
// below).
//
// This does NOT change the actual security boundary: per sdk.d.ts:2108's own
// docstring, `skills`/`skillOverrides` are "a context filter, not a sandbox"
// — unlisted skills are hidden from the model and rejected by the Skill tool,
// but their files remain reachable via Read/Bash if either were enabled.
// `Bash`/`Write`/`Edit`/`NotebookEdit` remain in `disallowedTools` below
// (HIGH_RISK_BUILTINS) exactly as before — filesystem writes and arbitrary
// command execution stay disabled by default, a deliberate project property.
// (`Task`, `WebSearch` and `WebFetch` were later moved OUT of
// HIGH_RISK_BUILTINS and into `tools`/`allowedTools`/`canUseTool` — see the
// comments at each of those below for the current, narrower risk story.)
// `Read` is deliberately NOT added to `tools` here — "keeping ... arbitrary
// filesystem reads ... disabled by default" (this task's own non-negotiable)
// stays true regardless of how many skills are enabled. The actual
// authorization boundary for explicit slash dispatch is
// `assertSlashDispatchAllowed()`, enforced application-side in
// host/agent/companion.js BEFORE this function (and therefore the SDK) is
// ever reached — never delegated to what the SDK's `skills` option merely
// chooses to display.
//
// Regression fixed here (first pass, incomplete — see reports/11 for the
// full history): adding `"Skill"` above made `tools` a single-built-in
// allowlist (`["Skill"]`), which — per the same `tools` docstring cited above
// ("Specify the base set of available built-in tools... `string[]` - Array
// of specific tool names") — left every browser MCP tool this adapter
// registers (`mcp__${SDK_MCP_SERVER_NAME}__read_page`, `__navigate`,
// `__computer`, etc. — see host/agent/tools/adapter.js's `buildSdkTools()`)
// outside that allowlist, so it was not even *available* to the model.
// `buildIsolatedOptions()` appended every registered browser tool's
// fully-qualified SDK name (from `sdkQualifiedToolNames()`, itself derived
// from the same `TOOLS` array `buildSdkTools()` registers from, so the two
// can never drift apart) to `tools`.
//
// That first pass was still incomplete and shipped a live regression: making
// a tool *available* via `tools` is a different axis from making it
// *auto-approved* via `allowedTools` (sdk.d.ts:1443-1449, `Options.
// allowedTools`'s own docstring: "List of tool names that are auto-allowed
// without prompting for permission... To restrict which tools are available,
// use the `tools` option instead"). With every browser tool present in
// `tools` but absent from `allowedTools`, and with no `canUseTool` callback
// and no `permissionMode` set (both still unset here), each call fell
// through to the SDK's default permission path — which prompts for
// permission and, with nothing able to answer that prompt in this headless
// companion process, denies the call. This is exactly the reproduced
// failure: "Claude requested permissions to use
// mcp__browzy-in-chrome-browser__get_page_text, but you haven't granted
// it yet" on every single browser tool call, surviving a full browser
// restart and a companion respawn, because the bug was in the `query()`
// options themselves, not stale in-memory state.
//
// The complete fix: `buildIsolatedOptions()` now also appends the identical
// `qualifiedBrowserToolNames` (the same array, from the same
// `sdkQualifiedToolNames()` call — availability and auto-approval can never
// drift apart because both read the one array) to `allowedTools`, so every
// registered browser tool is both available (`tools`) and auto-approved
// (`allowedTools`), preapproving them at the SDK layer exactly as design.md's
// SDK integration decision calls for ("SDK-managed browser tools with no
// mandatory user MCP setup"). `"Skill"` is deliberately NOT added to
// `allowedTools` — per `allowedTools`'s own docstring, "passing `'Skill'`
// here is deprecated — use the `skills` option instead", and the `skills`
// option (already wired above) documents that it already covers this
// ("you do not need to add `'Skill'` to `allowedTools` yourself when using
// this option", sdk.d.ts around line 2088).
//
// This does not relax anything: per that same design.md decision, "Validate
// run state, arguments, browser lease, and tab scope inside each tool
// handler, even when SDK permission checks preapprove the tool" —
// host/agent/tools/adapter.js's `authorizeToolCall()` and
// `enforceBorrowedTabScope()` run unconditionally on every dispatched call
// and are the real authorization boundary; SDK preapproval (both `tools` and
// `allowedTools`) only lets a legitimate call reach that boundary at all,
// without a UI permission round trip nothing in this headless companion
// process could ever answer.
//
// `permissionMode` is deliberately left unset (SDK default): setting a
// blanket mode like `bypassPermissions` would also preapprove
// `HIGH_RISK_BUILTINS` (now just `Bash`, `Write`, `Edit`, `NotebookEdit` —
// see that constant below) and anything else not explicitly disallowed — far
// broader than the browser tools plus WebSearch/Task this file actually needs
// to preapprove, and broader than WebFetch, which must NOT be blanket-
// preapproved (see its own comment below).
//
// CORRECTION — this paragraph replaces two paragraphs that used to say
// `canUseTool` was "deliberately left unset" with "no wire protocol" to the
// panel. That was true when first written and is NOT true anymore: task 9.2
// wired it up.
// `host/agent/policy/can-use-tool.js`'s `createCanUseTool({run, approvals,
// requestIdTracker, now})` IS the real `canUseTool` callback; companion.js
// builds one per run and passes it as this function's `canUseTool` parameter
// (which flows straight into `Options.canUseTool` below). It classifies each
// call via `isSendClassCall()`, auto-allows anything that isn't send-class,
// and for a send-class call emits a real `approval_request` stream event and
// awaits the panel's `approval_decision` over the native-messaging wire (or
// the registry's timeout) — this is a real interactive round trip, not a
// stub. `allowedTools` still answers every call this project intends to
// auto-approve without ever reaching `canUseTool` at all; `canUseTool` is
// the path for the calls that are deliberately NOT in `allowedTools`
// (`computer`/`javascript_tool` send-class calls, and now `WebFetch` — see
// below).

import { sdkQualifiedToolNames, legacyToolNameFromSdkName, SDK_MCP_SERVER_NAME } from "./adapter.js";
import { createWebFetchPreToolUseHook } from "../policy/webfetch-url-guard.js";

// Filesystem writes and arbitrary command execution stay disabled by
// default — that is this project's own non-negotiable, unchanged by the
// WebSearch/WebFetch/Task enablement below. `Task`, `WebFetch` and
// `WebSearch` used to be listed here too; they were moved out (added to
// `tools` below, and to `allowedTools` for WebSearch/Task) because none of
// the three opens a filesystem or shell door: `Task` spawns a subagent
// inside this same sandboxed run (no new external capability), `WebSearch`
// is read-only, and `WebFetch` is gated per-call by `canUseTool` (see the
// URL classifier wired in host/agent/policy/can-use-tool.js) rather than
// blanket-disallowed or blanket-preapproved.
const HIGH_RISK_BUILTINS = ["Bash", "Write", "Edit", "NotebookEdit"];

// --- Bound page-context channel (design.md section 5 / 5b) ---------------
//
// Deviation fixed: extension/sidepanel/context-binding.js used to compose a
// `<bound_page_context>` block directly into the wire "prompt" text, because
// neither this file nor host/agent/companion.js exposed a separate context
// or system-prompt hook. That contradicted design.md section 5 ("User
// messages and page/tool content remain distinctly typed") and 5b (the bound
// context must be supplied as "structured trusted metadata").
//
// The pinned SDK's own `Options.systemPrompt` field (see
// host/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts, `Options` type,
// around line 2237: `systemPrompt?: string | string[] | { type: 'custom',
// prompt: string | string[], snapshot?: boolean } | { type: 'preset', preset:
// 'claude_code', append?: string, excludeDynamicSections?: boolean,
// snapshot?: boolean }`) is the documented per-`query()` channel for exactly
// this: content that reaches the model OUTSIDE the user's own turn. This
// module renders the bound-context metadata (a plain data object carried
// over the wire on the `start` envelope's `context` field — see
// panel-controller.js's `sendMessage()` and companion.js's `_handleStart()`)
// into that field, using the `{ type: 'custom', prompt }` form: a bare
// string/array `systemPrompt` and an omitted `snapshot` are both
// "recording off" per the same doc block, i.e. rendered fresh on every
// `query()` call — exactly right, since each run's bound tab/URL can differ
// from the last and this project calls `query()` once per run (see
// companion.js's `_runQuery`), never SDK-level `resume`/`continue`.
//
// The actual live-extraction/scope enforcement this metadata's instruction
// text merely *reinforces* remains entirely code-side (borrowed-tab
// read-only default, stale/restricted detection in
// extension/background.js's `checkTabReadableForExtraction()`, tab-scope
// binding via `Run.tabScope`) — this text can only ever request that the
// model call get_page_text/read_page; it grants no capability and is never
// treated as authorization by itself (design.md decision 1: "Prompt
// instructions reinforce page-content distrust, while code enforces scope
// and permission decisions").

/**
 * @param {object|null} pageContext - the structured metadata object produced
 *   by extension/sidepanel/context-binding.js's `buildContextMetadata()`
 *   ({tabId, url, title, hostname, revision, boundAt, restricted, pinned,
 *   mustRead}), forwarded verbatim over the wire, or null/undefined when no
 *   page context is bound for this run.
 * @returns {string|null} the exact text to use as the SDK's per-run
 *   `systemPrompt` custom prompt, or null when there is nothing to attach
 *   (no systemPrompt option is set at all in that case — identical to this
 *   run having no bound context, exactly as before this channel existed).
 */
/**
 * The browser-automation operating instructions, ported from the ones Claude in
 * Chrome ships (its "Claude in Chrome browser automation" system prompt,
 * ccVersion 2.1.221). This project exposes the same tool surface, so parity
 * here is the point: the reference product's behaviour on a given prompt is
 * what this extension is measured against, and until now a run with no bound
 * page context reached the model with NO system prompt at all — its entire idea
 * of how to drive a browser came from the per-tool descriptions in
 * host/tool-definitions.js, which describe each tool in isolation.
 *
 * TWO SECTIONS OF THE ORIGINAL ARE DELIBERATELY NOT PORTED:
 *
 *  - "Loading deferred tools". That section exists because Claude Code defers
 *    those tools behind ToolSearch. Here every browser tool is registered up
 *    front on the run's own MCP server (see buildIsolatedOptions below), so
 *    there is nothing to load and the instruction would name a tool that does
 *    not exist in this runtime.
 *  - "GIF recording". `gif_creator` is a stub in this extension — its handler
 *    in extension/background.js returns "GIF recording is not yet implemented
 *    in this extension." Porting an instruction to ALWAYS record would make
 *    the model open every multi-step task with a call that cannot succeed.
 *    Restore this section together with a real implementation, not before.
 *
 * ONE SECTION IS ADDED that the original has no equivalent of: "Working
 * visibly on the page". This is a product requirement, not a workaround, and it
 * was reached the long way round — the history is worth keeping so it is not
 * re-litigated:
 *
 *   - The tool descriptions were ruled out as the cause: Claude in Chrome's own
 *     `computer`, `find`, `get_page_text` and `form_input` descriptions were
 *     read directly and compared against host/tool-definitions.js. They are the
 *     same text apart from trivia (`duration` capped at 10 rather than 30, the
 *     `save_to_disk` wording, and read_page truncating at a line boundary where
 *     ours raises an error).
 *   - One real divergence of ours WAS found and fixed on its own merits: the
 *     bound-page-context block below used to instruct a read before answering
 *     any request that merely "concerned" the page, including a request to
 *     operate it. It now fires only for questions about the page's content.
 *   - That fix alone did not produce the behaviour. Note also that the ported
 *     prompt above is Claude Code's browser-automation prompt, while the
 *     behaviour being matched was observed in the claude.ai app — a different
 *     surface with its own system prompt, which is not available to copy. So
 *     "same prompt, different behaviour" was never quite established.
 *
 * What remains is a genuine product requirement, stated plainly by the person
 * who owns this product: the user is watching in their own browser, and seeing
 * the work happen on the page is part of what they are asking for. A model that
 * reads the DOM and hand-assembles a result URL can be correct and still fail
 * that requirement. Hence the section. Removing it because it is "not in the
 * reference prompt" would regress a deliberate decision.
 *
 * The section names SPECIFIC mechanisms, not just an outcome, and it took two
 * passes to get them right. The first pass made screenshot-plus-coordinate the
 * only route and demoted `find` to a fallback alongside `read_page`. That was
 * wrong, and the evidence had been sitting in front of us the whole time: the
 * reference product's own action list, which the user screenshotted, opens with
 * `Finding "advanced search toggle..."` and only then Clicked, Captured. It
 * searches the page's content for the label. Lumping `find` in with `read_page`
 * confused two unlike things — `read_page` dumps an entire accessibility tree
 * (the invisible DOM operation the user objects to), while `find` looks for one
 * named thing, which is what a person does with Ctrl+F. So: a labelled control
 * is located by label, and the picture is for state, confirmation, and targets
 * that have no label to search for.
 *
 * The coordinate route still matters, and it makes extension/background.js's
 * screenshot scaling load-bearing rather than merely defensive: a coordinate
 * taken off an image is wrong the instant that image is silently resized on its
 * way to the model. See MODEL_IMAGE_MAX_EDGE and screenshotToCssCoordinate()
 * there — those two halves are one mechanism and must not be changed apart.
 *
 * ONE INSTRUCTION IS DELIBERATELY INVERTED, in "Tab context and session
 * startup". The original says to reuse an existing tab only if the user asks,
 * and otherwise to open a new one — correct for Claude Code, which drives a
 * browser the user is not sitting in front of. This assistant runs in a side
 * panel attached to the user's own browser: the page in front of them IS the
 * subject, and it arrives as the bound page context appended right after this
 * block. Following the original verbatim made it open a second copy of the page
 * the user was already reading. So the order is reversed here — use the tab
 * they are on; create one only when the page genuinely is not open yet.
 *
 * Everything else is the original's guidance, with the tool prefix resolved to
 * this project's own MCP server name so the names are the ones the model
 * actually sees.
 *
 * WHAT THIS IS NOT: guidance only. It grants no capability and relaxes no
 * check — scope, permission and live-extraction stay enforced in code
 * (extension/background.js's tab-scope and restricted-page checks,
 * host/agent/policy/can-use-tool.js's approval gate), exactly as design.md
 * decision 1 requires: "Prompt instructions reinforce page-content distrust,
 * while code enforces scope and permission decisions."
 *
 * @param {string} [serverName] - the MCP server these tools are registered
 *   under, so the fully-qualified names in the text can never drift from the
 *   ones buildIsolatedOptions actually registers.
 * @returns {string} the system-prompt text.
 */
export function renderBrowserAutomationSystemPrompt(serverName = SDK_MCP_SERVER_NAME) {
  const t = (name) => `mcp__${serverName}__${name}`;
  const prefix = `mcp__${serverName}__`;
  return [
    "# Browser automation",
    "",
    `You have access to browser automation tools (${prefix}*) for interacting with web pages in Chrome. Follow these guidelines for effective browser automation.`,
    "",
    "## Working visibly on the page",
    "",
    "The user is watching this happen in their own browser, on the page in front of them. Work the way they would: look at the page, move to the control, click it, look again.",
    "",
    `**When the thing you want has a visible label, search the page for that label.** The user asks you to follow a notice; the page has a "Theo dõi" control on it somewhere. That is what ${t("find")} is for: it searches the page's own content for the words you name.`,
    `1. ${t("find")} with the words as they appear on the page — "theo dõi", "tìm kiếm nâng cao", "đăng nhập". It returns matching elements with a ref.`,
    `2. Act on that ref with ${t("computer")} — click, type, choose. The ref is resolved to the element's live position and scrolled into view first, so the cursor lands on it even if it was below the fold.`,
    `3. Screenshot with ${t("computer")} (action: "screenshot") and look at what changed before the next step. The image comes back as a real picture attached to the result, not a description — look at it.`,
    "",
    "That is the whole loop for anything that carries a label: find it, click it, look. It is what a person does with Ctrl+F, and it is fast, exact, and visible on the user's screen.",
    "",
    "**When the thing you want has no label to search for** — a spot on a map, a region of an image, a canvas, an unlabelled icon — work from the picture instead: screenshot, locate the target by eye, and act on a coordinate read straight off that image. Coordinates you read off a screenshot are in that image's own pixels and are dispatched to the matching point on the page; you do not need to convert anything.",
    "",
    `If something is too small to identify with confidence, use ${t("computer")} with action "zoom" and a region around it to see it magnified. A zoom is a crop: its coordinates are relative to the region, not the page, so use it to identify the target and then act from a ref or a full screenshot. Never click on a guess.`,
    "",
    "Screenshot after anything that changes the page — a click that navigates or opens a panel, a typed field with suggestions, a submit. An autocomplete list has to be seen to be picked from, and the entry you want is often not the first. Never chain actions blind.",
    "",
    `**Most of those looks do not need a full-size picture.** A screenshot costs by area, and you take one after nearly every step, so that is where the user's waiting goes. Pass \`scale: 0.5\` to ${t("computer")}'s screenshot when you are checking that something happened — a panel opened, a page navigated, a field now has text in it — which is most of the time. It costs about a quarter as much and shows all of that perfectly well. Keep full size for when you actually have to READ the picture: small print, a dense table, an unlabelled icon you are about to aim at. Coordinates work the same either way; a point you read off a half-size image is dispatched to the matching point on the page, with nothing to convert.`,
    "",
    `**If a click did not do what you expected, do not nudge the coordinate and try again.** Shifting a few pixels and re-clicking is guessing, and it can repeat many times without ever landing — a radio button or checkbox is a small target and is exactly where this happens. Switch to ${t("find")} with the control's own label and act on the ref it returns; the ref is the element's real position, not an estimate.`,
    "",
    "**When the page asks for a choice that is the user's to make, ask them — do not pick for them.** Which account to act as, which of several matching records, a delivery address, a payment method: these belong to the user even when any option would technically let you continue. " +
      `Use ${t("ask_user")} with the page's own options as the answers, and act on what they choose. Picking one yourself to keep moving is the one shortcut that cannot be undone by a later screenshot.`,
    "",
    `Use ${t("get_page_text")} when you need to READ the page's text: an article, a list of results, the content the user is asking about. That is reading, not navigating — it is not how you locate a button.`,
    "",
    `Do not dump the page's accessibility tree to decide where to click. ${t("read_page")} is a last resort for a page you cannot get at any other way; it is large, slow, and turns visible work into an invisible DOM operation. Searching for a label with ${t("find")} is not that — it is the normal first move.`,
    "",
    `A rich dropdown (select2, comboboxes, anything with a search box inside it) is driven the way a person drives it: click the control to open it, type into the search field that appears, screenshot to see the filtered list, then pick the option. Do not try to set the underlying hidden <select> — the widget the user sees is built from other elements and will not update.`,
    "",
    `Pick that option with ${t("find")} and click the ref it returns. The options are real elements with their own text, so they are findable. Aiming a coordinate at one is the single most costly miss available: the open list floats on top of the rest of the form, so a few pixels off lands on whatever sits underneath, and a click outside the list closes the dropdown and discards what you just typed — leaving the page looking untouched and you with no sign of what went wrong. Refs inside a dropdown also go stale the moment it closes, so find them while it is open and use them straight away.`,
    "",
    `**If the interface route stalls, say so — do not fall back to inventing a URL.** If a control will not open, or you cannot find the field you need, take a screenshot and describe what you see, or use ${t("ask_user")} to ask how to proceed. Reporting "I clicked Advanced search and the panel did not appear" is a useful answer. Silently switching to a hand-built URL is not: it produces a page that looks like an answer to the question asked and is not one.`,
    "",
    "Do not assemble a URL to stand in for what a control would have done. A site's query parameters are internal to it and cannot be inferred from outside; a guessed URL loads a real-looking page that answers a different question, with nothing in the result to say so — and the user sees a page they never watched you fill in.",
    "",
    "**A real link found in the page is the same shortcut.** Reading the page, spotting a link whose address happens to encode the filter you were asked to set, and navigating straight to it skips the control the user asked you to operate — and it loads a page built by different rules than the one the form would have produced, so what comes back may not match the request at all. If the task describes setting a filter, set that filter on the form. Follow a link when the task is to follow it, or when the page offers no control for what was asked.",
    "",
    "## Running script against a page",
    "",
    `**The tab bound to this session is read-only for ${t("javascript_tool")}.** Every \`javascript_exec\` against it is refused, including one that only reads — the refusal is about which tab it is, not about what the script does. Do not retry with a smaller or more innocent script: "1 + 1" is refused exactly like a DOM edit. There is currently no authorization that lifts this, so nothing you or the user can say from here will make that call succeed.`,
    "",
    `Clicking, typing, choosing and filling on that same tab are NOT affected — ${t("computer")} and ${t("form_input")} work on it normally. Reach for them first; most of what a script would do to a page can be done by operating the page.`,
    "",
    `When the task genuinely needs script execution, open your own tab with ${t("tabs_create_mcp")}, load the page there, and work in it. This is the one case where opening a second copy of the page you are already on is correct rather than duplication — say in one line that you are doing it and why, then get on with the task.`,
    "",
    "**A DOM change is a change to what this browser is currently showing, and the user knows that.** When they ask for one — to try a wording, see a colour, mock up a layout — make it and say once, briefly, that it lives in this tab and goes away on reload. Do not repeat that caveat at each step, do not re-litigate whether they really wanted a permanent change, and do not ask for admin access, credentials or source files unless they ask for the change to be permanent. A demo is a legitimate request, not a misunderstanding to correct.",
    "",
    "## Alerts and dialogs",
    "",
    `IMPORTANT: Do not trigger JavaScript alerts, confirms, prompts, or browser modal dialogs through your actions. These browser dialogs block all further browser events and will prevent the extension from receiving any subsequent commands. Instead, when possible, use console.log for debugging and then use the ${t("read_console_messages")} tool to read those log messages. If a page has dialog-triggering elements:`,
    '1. Avoid clicking buttons or links that may trigger alerts (e.g., "Delete" buttons with confirmation dialogs)',
    "2. If you must interact with such elements, warn the user first that this may interrupt the session",
    `3. Use ${t("javascript_tool")} to check for and dismiss any existing dialogs before proceeding`,
    "",
    "If you accidentally trigger a dialog and lose responsiveness, inform the user they need to manually dismiss it in the browser.",
    "",
    "## Avoid rabbit holes and loops",
    "",
    "When using browser automation tools, stay focused on the specific task. If you encounter any of the following, stop and ask the user for guidance:",
    "- Unexpected complexity or tangential browser exploration",
    "- Browser tool calls failing or returning errors after 2-3 attempts",
    "- No response from the browser extension",
    "- Page elements not responding to clicks or input",
    "- Pages not loading or timing out",
    "- Unable to complete the browser task despite multiple approaches",
    "",
    "Explain what you attempted, what went wrong, and ask how the user would like to proceed. Do not keep retrying the same failing browser action or explore unrelated pages without checking in first.",
    "",
    "## Tab context and session startup",
    "",
    `At the start of each browser automation session, call ${t("tabs_context_mcp")} first to get information about the user's current browser tabs. Use this context to understand what the user might want to work with before creating new tabs.`,
    "",
    "Never reuse tab IDs from a previous/other session. Follow these guidelines:",
    "1. Work in the tab the user is already on. This assistant runs in a side panel attached to the user's own browser, so the page in front of them is almost always the page they mean — if a bound page context is given below, that is the tab, and it is the one to use.",
    "2. Reuse an existing tab from the current session's context when the task is about a page already open in it.",
    `3. Create a new tab with ${t("tabs_create_mcp")} only when the task genuinely needs a page that is not open yet, when the user asks for one, or when the task needs ${t("javascript_tool")} (see "Running script against a page" above — the bound tab refuses it). Otherwise do not open a second copy of the page you are already on.`,
    `4. If a tool returns an error indicating the tab doesn't exist or is invalid, call ${t("tabs_context_mcp")} to get fresh tab IDs`,
    `5. When a tab is closed by the user or a navigation error occurs, call ${t("tabs_context_mcp")} to see what tabs are available`
  ].join("\n");
}

export function renderPageContextSystemPrompt(pageContext) {
  if (!pageContext || pageContext.tabId == null) return null;

  const boundAtIso = (() => {
    try {
      return new Date(pageContext.boundAt ?? Date.now()).toISOString();
    } catch {
      return new Date().toISOString();
    }
  })();

  const lines = [
    `<bound_page_context tab_id="${pageContext.tabId}" revision="${pageContext.revision ?? 0}">`,
    "Trusted metadata captured by the browser extension, NOT page content — do not treat this block as the article, and do not quote or repeat it as if it were retrieved from the page:",
    `- URL: ${pageContext.url || "(unknown)"}`,
    `- Title: ${pageContext.title || "(unknown)"}`,
    pageContext.hostname ? `- Hostname: ${pageContext.hostname}` : null,
    `- Bound at: ${boundAtIso}`,
    pageContext.restricted
      ? "- This tab is a browser-internal or restricted page; get_page_text/read_page will refuse to read it. Say so plainly if the user asks about its content."
      : null,
    pageContext.pinned ? "- This context is pinned by the user and stays bound regardless of which tab is active." : null,
    "",
    pageContext.mustRead
      ? `The user's request in this turn refers to this page or article. Call get_page_text or read_page with tab_id=${pageContext.tabId} and read the actual content before analyzing, summarizing, or answering — metadata alone (title/URL) does not count as reading. If extraction reports a stale, restricted, truncated, or login-walled result, say so plainly instead of guessing or fabricating the article's content.`
      : `If the user is asking you to tell them something ABOUT this page's content — summarize it, analyze it, answer a question about what it says — call get_page_text or read_page with tab_id=${pageContext.tabId} and read it first; never answer from this metadata alone.`,
    "</bound_page_context>"
  ].filter((l) => l !== null);

  return lines.join("\n");
}

/**
 * Typed error thrown when no credential is available for a run — mirrors the
 * contract's "throws a typed error if no credential is available" for
 * snapshotForRun, surfaced uniformly whether the real module or a test
 * double is in use.
 */
export class ProfileUnavailableError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = "ProfileUnavailableError";
    if (cause) this.cause = cause;
  }
}

/**
 * @param {object} params
 * @param {string} params.profileId
 * @param {string} params.modelId
 * @param {{ snapshotForRun: (profileId: string, modelId: string) => Promise<object> }} [params.profileProvider]
 *   Defaults to a lazy dynamic import of ../settings/profile.js — see file
 *   header. Never imported statically so this module (and anything that
 *   imports it) can load in a tree where group 4 has not landed yet.
 */
export async function resolveProfileSnapshot({ profileId, modelId, profileProvider }) {
  const provider = profileProvider ?? (await import("../settings/profile.js"));
  try {
    return await provider.snapshotForRun(profileId, modelId);
  } catch (err) {
    throw new ProfileUnavailableError(
      `no credential available for profile ${JSON.stringify(profileId)} / model ${JSON.stringify(modelId)}: ${err.message}`,
      err
    );
  }
}

/**
 * @param {object} params
 * @param {object} params.mcpServer - result of createBrowserMcpServer()
 * @param {string} params.serverName
 * @param {object} params.snapshot - { model, env: { ANTHROPIC_BASE_URL, ANTHROPIC_API_KEY }, revision, profileId }
 * @param {AbortController} [params.abortController]
 * @param {object} [params.extraEnv] - explicit additional isolated env entries; never a process.env spread
 * @param {object} params.skills - this run's bound skills session, as produced by
 *   host/agent/companion.js's `_bindSkillsForRun()` (which wraps
 *   host/agent/skills/index.js's `buildSessionSkills()`):
 *   { cwd: string, pluginDir: string, configDir: string, allowedSkillNames: string[], skillOverrides: Record<string, string> }.
 *   `cwd` MUST be the session workspace directory passed to
 *   `buildSessionSkills()` - required, not optional, so a session can never
 *   silently reach query() without having gone through the
 *   catalog/materialization/binding path at all. `pluginDir` is the absolute
 *   path to that same call's materialized local plugin directory (a
 *   `.claude-plugin/plugin.json` manifest plus a `skills/` subdirectory
 *   holding the approved snapshots) - this is what makes the plugin
 *   discoverable at all (see the `plugins` option below); `allowedSkillNames`
 *   now carries each skill's plugin-qualified canonical name (design.md
 *   decision 9), not the bare name. `configDir` is that same session's own
 *   isolated Claude Code CLI config directory (`buildSessionSkills()`'s
 *   `${sessionWorkspaceDir}/claude-config/`) - also required, not optional,
 *   for the identical "never silently reach query()" reason as `cwd`: without
 *   an explicit `CLAUDE_CONFIG_DIR`, the installed SDK's bundled CLI
 *   subprocess falls back to the OPERATOR's own `~/.claude` and writes real
 *   session `.jsonl` files into their actual Claude Code CLI history (a real,
 *   reproduced isolation leak - see this change's Part A evidence report).
 * @param {object|null} [params.pageContext] - this run's bound page-context
 *   metadata, forwarded verbatim from the `start` envelope's `context` field
 *   (see this file's "Bound page-context channel" section above). Rendered
 *   into the returned options' `systemPrompt`, never into the run's `prompt`.
 * @param {Function} [params.canUseTool] - task 9.2: a `canUseTool` callback
 *   (sdk.d.ts:209-269) created per-run via
 *   `host/agent/policy/can-use-tool.js`'s `createCanUseTool()`. When passed,
 *   the SDK calls it before each tool execution for any tool that is
 *   available (`tools`) but NOT auto-approved (`allowedTools`) — that is
 *   `computer` and `javascript_tool` (removed from `allowedTools` per task
 *   9.1, for their send-class calls) and, since WebSearch/WebFetch/Task were
 *   enabled, also `WebFetch` (deliberately never added to `allowedTools` —
 *   see its own comment below — so its URL is always classified here).
 *   Every other registered browser tool, plus `WebSearch` and `Task`, is
 *   auto-approved via `allowedTools` and never triggers it. The callback
 *   never resolves `null` (which the SDK warns would block the tool
 *   indefinitely) and never waits past its documented timeout.
 * @param {string|null} [params.effort] - this run's reasoning-effort level
 *   ("low" | "medium" | "high" | "xhigh" | "max"), already validated by
 *   host/agent/protocol.js's `validateStartEffort()`. Null (the default)
 *   sends no effort parameter at all, leaving the model's own default in
 *   force — deliberately not the same as pinning it to today's default.
 * @param {string} [params.resume] - tasks.md 2.3/2.4: the SDK `session_id`
 *   this turn should resume, already gated by
 *   `SessionManager.getResumeSessionId()` (only offered when a compatible,
 *   ACTIVE reference exists — see host/agent/companion.js's
 *   `_runAfterLeaseGranted()`) — this function performs NO compatibility or
 *   staleness check of its own, it only forwards the decision already made.
 *   Omitted (undefined) means "run a fresh SDK session", identical to every
 *   call before this task existed. `persistSession` is always explicitly
 *   `true` regardless (gate-0.2's own load-bearing finding: decision 1
 *   requires "Valid sessions use resume ... No `continue` option is used as
 *   a substitute for a durable mapping" — a session that cannot be persisted
 *   could never be resumed later, defeating the entire mapping this task
 *   builds). `forkSession` is deliberately NOT wired here — tasks.md 2.3-2.5
 *   scope is resume/reject/recover, not an explicit-branch UI; decision 1
 *   reserves `forkSession` for "a deliberate branch ... an explicit
 *   new-conversation action", which is out of this task's scope.
 * @param {number|null} [params.maxTurns] - tasks.md 5.2: forwarded as the
 *   SDK's own `maxTurns` option. Honest semantics, per gate-0.2 evidence G6:
 *   this caps the SDK's internal multi-round TOOL loop within one top-level
 *   turn (reported as `error_max_turns`), NOT paced streaming-input
 *   conversation turns — the identical paced harness that triggers
 *   `error_max_budget_usd` sailed past `maxTurns: 2` untouched. The local
 *   wall-clock/model-turn admission counter (conversationMetadata.
 *   budgetPolicy) stays authoritative regardless; this is best-effort on top.
 * @param {number|null} [params.maxBudgetUsd] - tasks.md 5.2: forwarded as
 *   the SDK's own `maxBudgetUsd` option. This is the SDK's ESTIMATED
 *   query-budget stop, never a hard provider billing ceiling (gate-0.2
 *   evidence G7: the stop lands AFTER the turn that crosses the cap — a real
 *   in-flight overrun of several multiples was observed — and the figure is
 *   a cost-table estimate per `costBasis`, not a billing statement). The
 *   panel MUST label it as such; see extension/sidepanel/usage-ledger-view.js.
 * @param {string[]} [params.browserToolNames] - the legacy names of every
 *   browser tool actually registered on `mcpServer`. Defaults to
 *   `sdkQualifiedToolNames()`'s own default (host/agent/tools/adapter.js's
 *   `adapterToolNames()`, derived from `TOOLS` — the identical array
 *   `buildSdkTools()` registers from), so production never has to pass this;
 *   exposed as a parameter only so this file's own tests can prove the
 *   allowlist tracks whatever the registry actually contains, rather than a
 *   hand-typed copy that could silently drift from it. The resulting
 *   qualified names are written into BOTH the returned `tools` (availability)
 *   and `allowedTools` (auto-approval) arrays from the one computation, so
 *   the two options can never disagree about which browser tools are usable
 *   without a permission prompt.
 */
export function buildIsolatedOptions({
  mcpServer,
  serverName,
  snapshot,
  abortController,
  extraEnv = {},
  skills,
  pageContext = null,
  canUseTool,
  browserToolNames,
  extraToolNames = [],
  effort = null,
  resume,
  maxTurns = null,
  maxBudgetUsd = null
}) {
  if (!mcpServer) throw new Error("buildIsolatedOptions requires mcpServer");
  if (!serverName) throw new Error("buildIsolatedOptions requires serverName");
  if (!snapshot || !snapshot.env || !snapshot.env.ANTHROPIC_API_KEY) {
    throw new Error("buildIsolatedOptions requires a resolved profile snapshot with credentials");
  }
  if (!skills || typeof skills !== "object" || !skills.cwd) {
    throw new Error(
      "buildIsolatedOptions requires a skills session ({ cwd, configDir, allowedSkillNames, skillOverrides }) — pass the " +
        "result of host/agent/companion.js's _bindSkillsForRun() (built on buildSessionSkills())"
    );
  }
  if (!skills.configDir) {
    throw new Error(
      "buildIsolatedOptions requires skills.configDir (this session's own isolated Claude Code CLI config " +
        "directory, from buildSessionSkills()) — without it the SDK's bundled CLI subprocess falls back to the " +
        "operator's real ~/.claude and writes session history there instead of this session's own workspace"
    );
  }
  if (!skills.pluginDir) {
    // Mirrors the configDir check just above, for the identical reason: a
    // silent default (or simply passing `path: undefined` through to the
    // SDK's `plugins` option below) re-creates the exact leak this guards
    // against the first time a caller forgets to backfill it — empirically
    // confirmed via a real, unmocked query(): the SDK does not throw, it
    // silently fails to load the plugin (`plugin_errors:
    // [{type:"path-not-found", ...}]` in its own system/init message) and
    // the run completes with every approved skill for this conversation
    // invisible to the model, with no error surfaced anywhere. Failing
    // loudly here turns that silent capability loss into the same explicit,
    // already-handled `options_build_failed` run_error every other
    // buildIsolatedOptions() throw already produces (see
    // host/agent/companion.js's `_runAfterLeaseGranted()`), rather than a
    // degraded run nobody is told about.
    throw new Error(
      "buildIsolatedOptions requires skills.pluginDir (this session's own materialized local skill plugin " +
        "directory, from buildSessionSkills()) — without it the SDK's `plugins` option resolves an undefined " +
        "path and silently fails to load every approved skill for this conversation instead of throwing"
    );
  }

  // Tasks.md 5.2: SDK estimated-budget options. Validated here (fail loudly,
  // exactly like skills.cwd/configDir/pluginDir above) rather than passed
  // blindly: a zero/negative/huge cap would either no-op into an unlimited
  // run the panel showed as limited, or stop every turn immediately — both
  // silent limit lies. Omitted (null/undefined) means "no SDK cap for this
  // turn", byte-identical to every call before this task existed; the local
  // admission policy (conversationMetadata.budgetPolicy) is enforced
  // elsewhere and is unaffected either way.
  if (maxTurns !== undefined && maxTurns !== null) {
    if (!Number.isInteger(maxTurns) || maxTurns < 1 || maxTurns > 1000) {
      throw new Error(
        "buildIsolatedOptions requires maxTurns to be an integer in [1, 1000] when set — " +
          "the SDK caps its internal tool-loop rounds, not conversation turns (gate-0.2 G6)"
      );
    }
  }
  if (maxBudgetUsd !== undefined && maxBudgetUsd !== null) {
    if (typeof maxBudgetUsd !== "number" || !Number.isFinite(maxBudgetUsd) || maxBudgetUsd < 0.01 || maxBudgetUsd > 10000) {
      throw new Error(
        "buildIsolatedOptions requires maxBudgetUsd to be a finite number in [0.01, 10000] when set — " +
          "an SDK cost-table estimate stop with in-flight overrun, never a billing ceiling (gate-0.2 G7)"
      );
    }
  }

  const env = {
    PATH: process.env.PATH || process.env.Path || "",
    ...(process.platform === "win32" ? { SystemRoot: process.env.SystemRoot || "" } : {}),
    ANTHROPIC_BASE_URL: snapshot.env.ANTHROPIC_BASE_URL,
    ANTHROPIC_API_KEY: snapshot.env.ANTHROPIC_API_KEY,
    // This session's own isolated Claude Code CLI config directory (never
    // the operator's real ~/.claude) — see skills.configDir's docstring
    // above and this change's Part A evidence report for the reproduced
    // leak this closes. Placed before `...extraEnv` so an explicit test
    // double can still override it, exactly like every other fixed entry
    // here.
    CLAUDE_CONFIG_DIR: skills.configDir,
    ...extraEnv
  };

  // The browser-automation instructions are unconditional; the
  // bound-page-context block is still attached only when this run actually has
  // one (see renderPageContextSystemPrompt). The instructions are rendered
  // against THIS run's own `serverName`, so the fully-qualified tool names in
  // the text are always the ones registered a few lines below.
  const systemPromptText = [
    renderBrowserAutomationSystemPrompt(serverName),
    renderPageContextSystemPrompt(pageContext)
  ]
    .filter(Boolean)
    .join("\n\n");

  // Every registered browser tool's fully-qualified SDK name, namespaced
  // under this exact `serverName` (the same key used for `mcpServers` below)
  // — never a separately imported constant, so `tools` and `mcpServers` can
  // never name two different servers. See the file header's "Regression
  // fixed here" note for why this must be preapproved at the SDK layer, and
  // adapter.js's `authorizeToolCall()`/`enforceBorrowedTabScope()` for the
  // unconditional handler-side check this preapproval does NOT replace.
  // `browserToolNames` covers the registry (host/tool-definitions.js) only.
  // A tool registered on the SAME server from outside that registry — today
  // `ask_user`, passed to createBrowserMcpServer() as an extraTool — is
  // invisible to the model unless it is named here too: registering a tool and
  // ALLOWING a tool are separate axes (see this file's header on `tools` vs
  // `allowedTools`). That gap is exactly how ask_user shipped registered but
  // uncallable, so the model could never ask the user anything and simply
  // guessed instead. Callers pass the same constant they registered with.
  const qualifiedBrowserToolNames = [
    ...sdkQualifiedToolNames(serverName, browserToolNames),
    ...sdkQualifiedToolNames(serverName, extraToolNames)
  ];

  // Task 9.1 (design.md section 8): `computer` and `javascript_tool` are each
  // capable of producing both an always-automatic call (a non-submit click,
  // typing, scrolling, an in-scope script) AND a send/submit-class call (a
  // click on a submit control, a script that submits a form) under the
  // identical tool name. Because `allowedTools` operates at the granularity of
  // a whole tool name, keeping those two in `allowedTools` would preapprove
  // the send/submit case alongside everything else, so the SDK would never
  // call `canUseTool` for it. Removing them from `allowedTools` only — they
  // remain in `tools` for availability — routes every one of their calls
  // through `canUseTool`, where the new `isSendClassCall()` classifier decides
  // per call. Every other browser tool can never itself produce a
  // send/submit-class call per the classification, so it stays in
  // `allowedTools` unchanged, with zero added latency.
  const ALLOWED_TOOL_EXCLUDE = new Set(["computer", "javascript_tool"]);
  const autoApprovedBrowserToolNames = qualifiedBrowserToolNames.filter(
    (qname) => !ALLOWED_TOOL_EXCLUDE.has(legacyToolNameFromSdkName(qname))
  );

  return {
    abortController,
    model: snapshot.model,
    mcpServers: { [serverName]: mcpServer },
    strictMcpConfig: true,
    settingSources: [],
    cwd: skills.cwd,
    // The session's approved skill snapshots are made discoverable by
    // loading them as a LOCAL PLUGIN at an explicit absolute path
    // (design.md decision 9, superseding decision 7's `settingSources:
    // ['project']`, which a real query() proved walks the entire ancestor
    // directory tree with no repo-root gating — see
    // plans/reports/blocker-260909-0712-project-settingsource-walkup-leak.md).
    // `skills.pluginDir` is host/agent/skills/session-workspace.js's
    // `buildSessionSkills()` own materialized plugin directory for THIS
    // session — never a shared or ancestor path. `skipMcpDiscovery: true`
    // because this product owns its own MCP connections (`mcpServers`
    // above); the session-skills plugin never carries any of its own, but
    // this is stated explicitly rather than relying on the generated
    // manifest's mere omission of an `mcpServers` field.
    plugins: [{ type: "local", path: skills.pluginDir, skipMcpDiscovery: true }],
    // "Skill" plus every preapproved browser tool are the only built-ins
    // added on top of the isolated baseline — see the file header for why
    // neither weakens isolation: `Skill` is a context filter over
    // `skills`/`skillOverrides`, not authorization (the real gate for slash
    // dispatch, `assertSlashDispatchAllowed()`, already ran application-side
    // before this function was ever called), and every browser tool name
    // here still passes through `authorizeToolCall()`/
    // `enforceBorrowedTabScope()` on every single dispatch regardless of
    // this preapproval.
    // "WebSearch", "WebFetch" and "Task" are the three SDK built-ins this
    // project enables on top of the browser toolset: WebSearch (read-only
    // search) and Task (subagent spawning, still confined to this same
    // isolated run — no new external door) are also auto-approved below via
    // `allowedTools`. WebFetch is available here but deliberately NOT
    // auto-approved (see the `allowedTools` comment below) so every call is
    // gated by `canUseTool`'s URL classifier.
    tools: ["Skill", "WebSearch", "WebFetch", "Task", ...qualifiedBrowserToolNames],
    // `allowedTools` is the SEPARATE auto-approval axis (sdk.d.ts:1443-1449) —
    // without a tool's qualified name here too, the SDK's default permission
    // path prompts for it on every call and (with no `canUseTool`/UI able to
    // answer in this headless companion process) denies it, exactly the live
    // regression this fix closes. Deliberately the SAME array as `tools`
    // above (never a second derivation), so availability and auto-approval
    // can never drift apart. `"Skill"` is deliberately excluded here — per
    // `allowedTools`'s own docstring, passing `'Skill'` through it is
    // deprecated; the `skills` option below already makes it unnecessary.
    //
    // Task 9.1 additionally excludes `computer` and `javascript_tool`
    // (see autoApprovedBrowserToolNames derivation above) so their calls
    // reach `canUseTool`, where `isSendClassCall()` decides per call rather
    // than the SDK preapproving the submit case wholesale.
    // "WebSearch" and "Task" are auto-approved here too: WebSearch is
    // read-only, and Task only spawns a subagent inside this same
    // sandboxed run, so neither opens a door beyond what's already true.
    //
    // "WebFetch" is DELIBERATELY NOT included here. This looks like an
    // omission — it is not. `tools` above makes WebFetch available, but
    // leaving it out of `allowedTools` is exactly what routes every WebFetch
    // call through `canUseTool` instead of auto-approving it, and
    // `canUseTool` (host/agent/policy/can-use-tool.js) is where the
    // loopback/private-network URL guard lives (see
    // host/agent/policy/webfetch-url-guard.js). Auto-approving WebFetch here
    // would bypass that guard entirely, so do not "fix" this by adding it.
    allowedTools: [...autoApprovedBrowserToolNames, "WebSearch", "Task"],
    // The WebFetch URL guard's real boundary. `canUseTool` (above) runs LAST
    // in the SDK's permission pipeline and, per its own documentation, is
    // never reached for an auto-approved tool or under a blanket
    // `permissionMode` — so the canUseTool branch holds only while WebFetch
    // stays out of `allowedTools` and no mode is set. Hooks run FIRST, and a
    // hook deny "applies even in bypassPermissions mode", so this one keeps
    // holding even if either of those conditions is edited away later.
    // The matcher is the bare tool name, which the SDK matches exactly.
    hooks: {
      PreToolUse: [{ matcher: "WebFetch", hooks: [createWebFetchPreToolUseHook({ log: (line) => console.error(line) })] }]
    },
    skills: Array.isArray(skills.allowedSkillNames) ? [...skills.allowedSkillNames] : [],
    skillOverrides: { ...(skills.skillOverrides || {}) },
    disallowedTools: [...HIGH_RISK_BUILTINS],
    env,
    // Only set when a page context is actually bound — a run with none gets
    // no systemPrompt option at all, byte-identical to this channel's
    // absence (see "Bound page-context channel" above).
    //
    // `snapshot: false` is EXPLICIT, not merely the SDK's own default
    // (tasks.md 2.2 / design.md decision 2: "must not freeze a prior custom
    // system prompt"). sdk.d.ts's own `systemPrompt.snapshot` docstring
    // (~2192-2220): when true, "the conversation's system prompt is
    // recorded once ... and reused verbatim on every later request and
    // resume/continue, instead of being rendered fresh each time." This
    // run's systemPrompt text embeds the CURRENT bound page/document
    // context (renderPageContextSystemPrompt above) — recording it would
    // freeze a stale page identity across every future resumed turn, the
    // exact failure this decision forbids. Pinning `false` explicitly (
    // rather than relying on omission, which is today's default but is
    // itself described as "rolling out" and account-dependent) makes this
    // an intentional, tested contract instead of an incidental default that
    // a future SDK bump could silently flip.
    ...(systemPromptText ? { systemPrompt: { type: "custom", prompt: systemPromptText, snapshot: false } } : {}),
    // Only set when the panel actually chose a level. Absent means the run
    // sends no effort parameter and the model's own default applies — which
    // is deliberately not the same as pinning it to whatever that default is
    // today.
    ...(effort ? { effort } : {}),
    // Tasks.md 2.3/2.4: explicit, always-on session persistence (see this
    // parameter's own docstring above for why "always true" rather than
    // conditional on whether THIS turn happens to resume). `resume` itself
    // is only set when the caller (companion.js) actually resolved one —
    // omitted entirely otherwise, byte-identical to every call before this
    // task existed.
    persistSession: true,
    ...(resume ? { resume } : {}),
    // Tasks.md 5.2, forwarded only when actually configured (see the
    // validation above and the parameter docstrings for the exact
    // gate-0.2-verified semantics of each).
    ...(maxTurns !== undefined && maxTurns !== null ? { maxTurns } : {}),
    ...(maxBudgetUsd !== undefined && maxBudgetUsd !== null ? { maxBudgetUsd } : {}),
    // Task 9.2: only set when the caller actually wired a canUseTool
    // callback (the host runs that need the send/submit-class gate do).
    // Absent → the SDK falls back to its default permission path for any
    // tool absent from `allowedTools` — the same behavior today's tests
    // expect when they construct options without the gate.
    ...(canUseTool ? { canUseTool } : {})
  };
}

export { HIGH_RISK_BUILTINS };
