> **ARCHIVE NOTE (2026-09-10) — archived with manual verification NOT run.**
>
> This change was archived by an explicit operator decision while **task group 6 (manual in-browser verification) had not been run**. Its three checkboxes are deliberately left unticked, and the observed `via:` value in the change report is deliberately left blank. Neither is an oversight.
>
> **No end-to-end invocation of `webmcp_call_tool` has ever executed in a real browser.** CI has no Chrome, so this path cannot be automated.
>
> **Why that matters here specifically:** in this very change, the **automated test suite passed in full while `executeTool` was completely broken**. Two defects — the wrong argument shape passed to `executeTool`, and `safeSchema()` returning `{}` for a string-form `inputSchema` — were surfaced only by measurement against a real Chrome 152 (recorded in `plans/reports/webmcp-chrome152-executetool-evidence-260910-0956.md`); the implementing session's own tests were green throughout. The current test layer therefore does **not** catch this class of defect, and task group 6 is the only thing that does.
>
> **How to run it when someone can:** enable `chrome://flags/#enable-webmcp-testing`, restart Chrome, load the unpacked extension, serve `test/fixtures/webmcp/index.html` over HTTP and open it, then call `webmcp_list_tools` followed by `webmcp_call_tool` and record the observed `via:` value.

## Why

Browzy's browser registry can only do what the extension itself implements: click, type, read, navigate. When a site knows how to do something better than a generic DOM agent can — search its own catalog, apply a filter, submit a booking — the agent still has to fake it through pixels and selectors. WebMCP (`document.modelContext`, W3C WebML CG, in Chrome origin trial 149–156) lets a page publish those operations as callable, schema-described tools. Consuming them turns a class of brittle multi-step DOM automation into a single typed call.

This is deliberately an early, experimental bet: the API is behind an origin trial that expires 2026-11-16, and on most pages it will simply be absent. The value is that Browzy is ready the day a site enrolls, and that readiness costs two registry tools and one content-script pair.

## What Changes

- **New**: a MAIN-world content script that detects `document.modelContext` on the top frame and reports the page's registered tools to the service worker. Absent API is the normal case and MUST be silent — no error, no throw, no console noise.
- **New**: a per-tab table of page-declared tools in the service worker, invalidated on navigation and tab close.
- **New**: exactly two registry tools, `webmcp_list_tools` and `webmcp_call_tool`. Both reach the side panel and the external MCP path automatically, because `host/agent/tools/adapter.js` and `host/codemode/server-*.js` build from the `TOOLS` array generically.
- **New**: runtime dual-path execution with a stated preference — `document.modelContext.executeTool()` when Chrome exposes it, falling back to callbacks captured by wrapping `registerTool`. Every call result names the path it took.
- **Modified**: `openspec/specs/agent-browser-runtime/spec.md` asserts a preserved baseline of "all 26 operations". The registry becomes 26 preserved + 2 additions; the preservation requirement must state that split rather than a bare count.
- **Modified**: `test/registry-baseline.test.mjs` and `README.md` carry the same 26-count claim and must be corrected without weakening what they assert.
- **Not changing**: `host/tool-runtime.js`, `host/mcp-server.js`, `host/codemode/server-*.js`. The external-MCP path stays byte-identical, as README promises.
- **Not changing**: `minimum_chrome_version`, and neither existing `content_scripts` entry.

Not a breaking change. Every existing tool keeps its name, schema, and behavior.

## Capabilities

### New Capabilities
- `webmcp-page-tools`: discovering tools a web page registers via `document.modelContext`, tracking them per tab, exposing them to the agent as two registry tools, and executing them through the preferred consent-bearing path when available.

### Modified Capabilities
- `agent-browser-runtime`: the "Preserve the browser capability baseline" requirement currently fixes the registry at 26 operations. It must distinguish the 26 preserved legacy operations from post-baseline additions, so that adding a tool is not indistinguishable from losing one.

## Impact

**Extension**
- `extension/manifest.json` — one new `content_scripts` entry with `"world": "MAIN"`. The two existing entries, including the recorder's load-bearing `all_frames: true` / `document_start` entry, stay untouched.
- `extension/webmcp/` (new) — MAIN-world detector plus ISOLATED-world relay. MAIN world cannot use `chrome.*`, so the pair communicates over namespaced `window.postMessage`.
- `extension/background.js` — per-tab tool table, its `chrome.tabs.onUpdated` / `onRemoved` invalidation, and two handlers appended to `toolHandlers`.

**Host**
- `host/tool-definitions.js` — two entries appended to `TOOLS`. Nothing else in `host/` changes.

**Tests**
- `test/registry-baseline.test.mjs` — count and provenance corrected.
- New unit test for the two handlers, using the existing `test/_extract.mjs` extraction pattern.
- New fixture page under `test/fixtures/webmcp/` for manual verification.

**Docs**
- `README.md` — an experimental-status entry naming the origin-trial dependency and its expiry, and corrected tool counts.

**Dependencies**
- `webmcp-types` (dev-only, for accurate type shapes). No runtime dependency added.

**Constraints carried into implementation**
- Tool names, descriptions, and results are supplied by the visited page. They are untrusted input and must be labelled as page-supplied everywhere they surface to the agent.
- CI has no Chrome. The end-to-end path cannot be covered by an automated test, and the change report must say so rather than imply coverage that does not exist.
