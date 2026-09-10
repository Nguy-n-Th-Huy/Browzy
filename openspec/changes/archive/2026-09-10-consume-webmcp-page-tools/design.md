## Context

See proposal.md — Why. This section records only the constraints that shape the approach, all verified against the repository and the WebMCP explainer rather than recalled.

**Verified API surface** (github.com/webmachinelearning/webmcp). The object is `document.modelContext` — *not* `navigator.modelContext`; the navigator alias was dropped as of Chrome 153 Dev. It exposes `registerTool(toolDefinition, options)` where the definition carries `name`, `description`, `inputSchema` (JSON Schema) and an `execute(args, options)` callback; `getTools(options)` resolving to entries with `name`, `description`, `inputSchema`, `origin`, `window`; `executeTool(tool, arguments, options)`; and a `toolchange` event. Cross-origin exposure is controlled by `exposedTo` at registration and `fromOrigins` at query time.

**Verified availability gate.** WebMCP is in a Chrome origin trial spanning versions 149–156, expiring 2026-11-16, with `chrome://flags/#enable-webmcp-testing` for local testing. Without a trial token served by the page, `document.modelContext` is `undefined` for ordinary visitors. Availability therefore does not correlate with browser version, which is why `minimum_chrome_version` (currently 116) must not move: raising it would break the existing registry on older Chromium and buy nothing.

**Verified repository facts.**
- `host/tool-runtime.js` dispatches by tool name with no per-tool knowledge — `callTool()` coerces args and `sendToExtension()` frames `{id, type:"tool_request", tool, args}`. It needs no change. An earlier assumption that it required editing was wrong.
- `host/agent/tools/adapter.js` (`TOOLS.map(...)` at both the registration and the name-listing sites) and `host/agent/tools/mapping.js` (`sdkFacingToolDefs()`, also `TOOLS.map(...)`) build generically from the array. Appending to `TOOLS` therefore reaches the side panel and the codemode/hybrid servers with no further wiring.
- `test/_extract.mjs` extracts handlers by locating the literal string `  async ${name}(args)` in `extension/background.js`. Any handler that deviates from that exact two-space-indented signature is invisible to the extractor, and `test/handlers.test.mjs` and `test/registry-baseline.test.mjs` both depend on it.
- `extension/manifest.json` declares two content scripts. The recorder entry (`recorder/capture.js`, `all_frames: true`, `document_start`) is load-bearing for imitation learning. `webNavigation` is not among the permissions.
- `openspec/specs/agent-browser-runtime/spec.md`, `test/registry-baseline.test.mjs`, and `README.md` each independently assert a 26-operation registry.

## Goals / Non-Goals

**Goals:**
- Page-declared tools reach both agent entry points through one addition to `TOOLS`, exploiting the generic build path rather than adding a parallel one.
- Correct behavior on the overwhelmingly common page where the API is absent, at negligible cost and with no observable effect.
- Honest reporting of which execution path served each call, and of what the automated tests do and do not cover.

**Non-Goals:**
- Any change to the external MCP path's wire protocol, transport, or file set. README commits to it being unchanged.
- Cross-origin iframe tools via `exposedTo` / `fromOrigins`. Top frame only; deferred.
- More than two registry operations. A richer surface (per-tool schema introspection, streaming results) is not justified before the trial's outcome is known.
- Any attempt to authenticate page-declared tools. The page is the authority on its own tools by definition.

## Decisions

### Decision 1: Runtime feature detection in a single script, not a design-time branch

The explainer describes `getTools()` and `executeTool()`, but an explainer documents the specification, not necessarily the subset a given Chrome build ships. Chrome could plausibly expose `registerTool` to page script while reserving enumeration and execution for its own agent surface.

*Alternative considered — resolve by empirical probe first, then implement one branch.* Rejected on feasibility: the probe requires flipping `chrome://flags/#enable-webmcp-testing`, which is a manual action requiring a browser restart, and `chrome://` URLs are reachable neither by the extension nor by browser automation. A one-shot probe would have blocked implementation on a manual step and, worse, would have frozen the choice against a single browser build while the trial is still moving between milestones 149 and 156.

*Chosen.* One MAIN-world script at `document_start` implements both paths and selects at runtime. This is strictly more faithful to the concern that motivated the probe — it re-decides on every page in every build — and removes the manual blocker. The probe survives as a manual verification task whose observed result is recorded in the change report.

### Decision 2: `executeTool()` is preferred, and the fallback is disclosed, not silent

When the browser exposes `executeTool()`, calls route through it. When it does not, the extension invokes the page's `execute` callback captured by wrapping `registerTool`.

These are not interchangeable. `executeTool()` passes through whatever consent and permission mediation the browser attaches to agent tool invocation during the trial; calling the captured callback bypasses that mediation entirely. Preferring the mediated path is therefore a correctness decision, not a stylistic one.

Because the two differ in what they enforce, the distinction must be visible rather than hidden behind a uniform result. Every `webmcp_call_tool` result carries an explicit `via: executeTool` or `via: captured-callback` marker, and the change report records which was observed during manual verification. Wrapping `registerTool` requires `document_start` — a wrapper installed later would miss registrations that already happened — so the single script runs at `document_start` and uses `getTools()` when available regardless.

*Addendum — the shipped `executeTool()` surface is string-in/string-out, which this explainer-derived section did not anticipate.* Chrome's own developer documentation (`developer.chrome.com/docs/ai/webmcp/imperative-api`, fetched directly during implementation, independent of any in-conversation claim) documents `executeTool(tool, inputJson, options?)`: the first argument is the live `RegisteredTool` object `getTools()` itself returned — not a tool name and not a reconstructed object literal, both of which the browser rejects as "not of type 'RegisteredTool'" — and the second argument is a JSON **string** of the input, not a plain object; the resolved value is likewise a JSON string requiring `JSON.parse()`. This is exactly the build-to-build divergence this decision's runtime feature-detection (rather than a design-time branch, see Decision 1) exists to absorb: `extension/webmcp/detect-main.js` keeps a live `name -> RegisteredTool` map refreshed from every `getTools()` result and uses it (plus `JSON.stringify`/`JSON.parse` at the boundary) only on the `executeTool` path; the `captured-callback` fallback is unaffected and still exchanges plain objects, per `webmcp-types`' `ToolExecuteCallback` signature. Not verified: whether this string-based shape holds across the full 149–156 trial range, or only at whichever build the documentation reflects — the runtime feature-detection this decision already chose means that question does not need answering before shipping.

*Second addendum — documentation-vs-build divergence found a second time, at `RegisteredTool.inputSchema`.* Chrome's developer documentation's own illustrative examples read as though `inputSchema` comes back as an object. Independent web research during implementation (third-party WebMCP integration testing verified against live Chrome 150 stable and 153 Dev builds, plus language in search results consistent with the W3C spec's own "stringified input schema" serialization step for `getTools()`) indicates the documentation's example is illustrative rather than literal: `RegisteredTool.inputSchema` is itself a JSON **string**, requiring the same `JSON.parse()` treatment as `executeTool()`'s arguments/return value above. `extension/webmcp/detect-main.js`'s `safeSchema()` accepts both an object (the shape a page's own `registerTool()` call legitimately passes) and a JSON string (the shape `getTools()` hands back), parsing the latter and degrading unparseable input to `{}` rather than throwing. The lesson generalizing from both addenda: where Chrome's own documentation and independently-verified real-build behavior disagree, this change treats the real build as authoritative and the documentation as a starting hypothesis — which is the same posture Decision 1's runtime feature-detection already takes toward the explainer itself, just extended one level further to Chrome's own docs.

### Decision 3: MAIN-world detection with an ISOLATED-world relay

`document.modelContext` is a page-context object, so it is reachable only from a MAIN-world script. MAIN-world scripts cannot use `chrome.*`. The pair is therefore: a MAIN-world script that talks to the API, and an ISOLATED-world script that owns the `chrome.runtime` connection, joined by `window.postMessage` under a namespaced marker with an `event.source === window` check.

*On what that check is worth.* It prevents cross-talk with other extension channels and with frames posting into the window. It does **not** make the tool inventory trustworthy: a page can declare whatever tools it likes, and that is not an attack but the feature's premise — the tools *are* the page's data. Trust is handled by labelling, per the spec's untrusted-content requirement, not by validating the channel.

The manifest gains one new `content_scripts` entry with `"world": "MAIN"`. The two existing entries are not touched; the recorder's entry in particular must stay byte-identical.

### Decision 4: Tab-table invalidation via `chrome.tabs`, not `chrome.webNavigation`

The per-tab table is cleared on `chrome.tabs.onUpdated` when `status === "loading"` and on `chrome.tabs.onRemoved`. `chrome.webNavigation` would give finer-grained navigation events but is not in the manifest's permissions, and acquiring a new permission for an experimental feature is a poor trade — permission prompts are a user-visible cost paid on every install. `tabs` is already held.

The service worker can be recycled, which empties the table. That is safe rather than merely tolerable: a recycled worker means a stale table would be worse than an empty one, and the MAIN-world script re-reports on its next page load. `webmcp_list_tools` returning empty is a defined, non-error outcome.

### Decision 5: Registry-baseline test gains a second, separately-sourced list

`test/registry-baseline.test.mjs` cross-checks the live registry against `DESIGN_DOC_TOOL_LIST`, a 26-name inventory quoted from the "Repository findings" section of an *archived* change's design.md. That list is a historical record of what that change committed to preserving.

*Alternative considered — append the two names to `DESIGN_DOC_TOOL_LIST` and bump the count to 28.* Rejected: that archived design.md never listed these tools, so the amended list would misrepresent its source and quietly destroy the cross-check's meaning. Relaxing the assertion to permit extras was rejected for the same reason in stronger form.

*Chosen.* `DESIGN_DOC_TOOL_LIST` and its assertions stay byte-identical. A separate `POST_BASELINE_ADDITIONS` constant, carrying its own provenance comment, enumerates the two new names. `extraInLive` is asserted to equal that set exactly — not merely to be permitted. The length assertion becomes `DESIGN_DOC_TOOL_LIST.length + POST_BASELINE_ADDITIONS.length` rather than a bare `28`, so the two lists remain the source of truth. The stale count comments at the file's line 6 and lines 157–163 are corrected in the same pass, leaving nothing in the file that misstates the count. This mirrors the spec delta in `agent-browser-runtime`, which draws the same preserved-versus-added distinction.

### Decision 6: `toolArgs`, not `args`, for the inner argument object

`webmcp_call_tool` takes the page tool's arguments as `toolArgs`. Naming it `args` would produce `args.args` at the handler and an SDK-facing description in which "args" means two different things. `coerceArgs` in `host/tool-runtime.js` only touches known top-level keys (`tabId`, `coordinate`, `start_coordinate`, `region`), so a nested object passes through untouched either way; the choice is purely about legibility, and legibility of tool descriptions is what the model reads.

### Decision 7: `webmcp_call_tool` is classified mutating, `webmcp_list_tools` is not — and both need a borrowed-tab arg-key entry (post-verify policy-gap fix)

An independent verify agent found that `webmcp_list_tools` and `webmcp_call_tool` were missing from `TAB_ARG_KEYS` in `host/agent/policy/authorization.js` and from `TAB_TARGET_ARG_KEYS` in `host/agent/tools/mapping.js`. Neither map drives whether a call is scope-checked against the run's tab list at all (that is `isInGroup()`/`authorizeToolCall`'s general tab-scope check, which still worked because it walks a different path) — they drive whether `enforceBorrowedTabScope()` runs its *second*, additive gate: a borrowed tab (one already open and bound to the run, not created by the agent) is read-only by default, and a mutating call against it needs explicit authorization from the actual user task. Without an entry in `TAB_TARGET_ARG_KEYS`, that function returns immediately for a tool name it doesn't recognize — so `webmcp_call_tool` could invoke a page-defined tool against a borrowed tab with zero authorization check, even though `javascript_tool` (the tool it is functionally closest to) has required exactly that authorization since decision 5b of this same design. This was a real gap, not a hypothetical one: it is the one case in the registry where a **page**, not the agent's own instructions, effectively chose what runs against the user's own open tab.

The fix adds both tools to both arg-key maps, keyed on `tabId` (the exact argument name both handlers destructure). That alone does nothing without also getting the mutation classification right, so:

- **`webmcp_list_tools` is read-only.** It answers strictly from the passively-maintained per-tab table populated by `extension/webmcp/relay-isolated.js` (task group 2) — no code runs on the page, no page state changes, and no page callback is invoked. This is a lookup, exactly like `get_page_text` or `read_page`, and is safe to allow against a borrowed tab with no additional authorization, matching how those other read tools already behave.
- **`webmcp_call_tool` is mutating, unconditionally, with no per-call inspection.** It invokes a callback the **page itself** defined at `registerTool()` time (task group 1) or, on the `executeTool()` fallback path, the browser's own mediated call into that same page code. Nothing here is inspectable in advance the way `computer`'s action vocabulary or even `javascript_tool`'s static-pattern check partially is: the tool's name and declared `inputSchema` are attacker-controlled page content (decision 2's "page-supplied content" framing), and its actual runtime behavior is opaque — it could read the DOM, submit a form, navigate the tab, or make a network request, and there is no reliable static signal in a `name`/`toolArgs` pair that tells the host which of those it is. Attempting to guess "this call looks read-only" from the tool's declared name or description would mean trusting exactly the untrusted input decision 2 and the extension/background.js result labelling already say never to trust. So `webmcp_call_tool` gets the same conservative, no-exceptions treatment as `javascript_tool`: always classified mutating, and — per the existing borrowed-tab authorization design — always requiring its own explicit authorization against a borrowed tab, never silently covered by an authorization already granted to `computer` or `form_input` on that same tab (mirroring `javascript_tool`'s own separate, never-auto-granted authorization flag; see `host/agent/tools/mapping.js`'s existing `authorizeJavaScriptToolBorrowedTab`/`isJavaScriptToolBorrowedTabAuthorized` pair and comments, which `webmcp_call_tool` reuses the same *shared* general-mutation flag from — it is not given a bespoke third flag, since unlike `javascript_tool` no part of this design ever proposed auto-authorizing it for anything).

No change was needed in `extension/background.js`. Reading `host/agent/tools/adapter.js`'s `buildSdkTools()` shows `enforceBorrowedTabScope()` runs unconditionally, for every registered tool, inside the SDK-side dispatch wrapper — strictly before the call is forwarded to the extension at all. A rejected borrowed-tab `webmcp_call_tool` dispatch never reaches `extension/background.js`'s `isInGroup()` check in the first place, so that check (which correctly enforces the run's general tab scope, and was never itself broken) needed no mirrored borrowed-tab logic. `adapter.js`'s `_isAutoAuthorizeEligible()` was also checked and already excludes any tool other than `form_input` and non-send-class `computer` calls from the automatic borrowed-tab authorization grant, so `webmcp_call_tool` was never at risk of being silently pre-authorized by that separate mechanism either.

## Risks / Trade-offs

- **The origin trial expires 2026-11-16 and the feature may not ship** → The cost of being wrong is bounded: two registry entries and one content-script pair, all inert when the API is absent. Documentation states the expiry so no reader mistakes this for a stable capability.
- **The fallback path bypasses browser consent mediation** → It is used only where the browser offers no mediated entry point, and every call that takes it says so in its result. The alternative — refusing to execute at all without `executeTool()` — would make the feature useless on exactly the builds where `registerTool` works, which is the situation the fallback exists for.
- **Page-supplied tool descriptions are prompt-injection surface** → Labelled as page-supplied at both the description and result level per the spec, and conveyed as data. This mitigates but does not eliminate; it is the same exposure the agent already has to page text through `get_page_text` and `read_page`, not a new class of risk.
- **CI has no Chrome, so the end-to-end path has no automated coverage** → The two background handlers are unit-tested through the existing `_extract.mjs` pattern with a faked tab table, which covers dispatch, missing-tool, and empty-table behavior. The API interaction itself is verified manually against a fixture page, and the change report states this limit explicitly rather than implying coverage that does not exist.
- **A new MAIN-world script runs on every page** → It is small, guarded by a single `typeof` check, and exits immediately when the API is absent, which is the common case. Injecting at `document_start` is required by the `registerTool` wrapper and is the same timing the recorder already uses.
- **`webmcp-types` is a new dependency** → Dev-only, used for type shapes during implementation. No runtime dependency is added and the shipped extension carries no new code from it.

## Migration Plan

Additive throughout; no migration and no data to move. Every pre-existing tool keeps its name, schema, and behavior, and the external MCP path's files are untouched.

Rollback is removal: delete the two `TOOLS` entries, the two handlers, the manifest entry, and the `extension/webmcp/` directory, then revert the test and documentation edits. Nothing outside the feature acquires a dependency on it.
