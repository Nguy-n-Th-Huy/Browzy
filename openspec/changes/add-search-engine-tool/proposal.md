## Why

Starting a task from a web search currently costs about six model round trips: navigate to the engine, `find` the search box, click it, type, press Return, screenshot. Every one of those is a full model turn, and the sequence is identical every time.

The assistant cannot shorten it by navigating straight to a result URL, because the browser-automation prompt forbids assembling a URL to stand in for a control the user asked to be operated. That prohibition is correct and was added after a real failure: a site's query parameters are internal to it and cannot be inferred from outside, so a guessed URL loads a real-looking page that answers a different question.

The SDK's `WebSearch` builtin does not close this gap. It is executed by the API rather than the model, so a profile pointing at a custom `baseUrl` loses it entirely; and even where it is available it returns text to the model without anything happening on the user's screen, so reaching a result still costs the same browser sequence.

A general-purpose search engine is the one case where nothing has to be inferred. `https://www.google.com/search?q=…` is a fixed, verified template, not a guess. Encoding that template in a tool gives the one-call path without relaxing the prohibition anywhere else — the engine list is a closed set, so no other URL can be produced by this route.

## What Changes

- Add a `search` tool to the existing internal MCP registry: `{ query, engine, tabId }`.
- `engine` is a closed set of three: `google`, `bing`, `duckduckgo`. Any other value returns an error and navigates nowhere.
- The query is URL-encoded, substituted into that engine's fixed template, and navigated through the existing `navigate` path — no second implementation of navigation, tab-scope, or restricted-page handling.
- Record `search` in the enumerated set of post-baseline registry additions, so it is never indistinguishable from the loss of a preserved operation.
- Extend the browser-automation system prompt to say `search` covers general-purpose search engines only. The existing prohibition on assembling URLs for site controls stays exactly as written and is explicitly reaffirmed as still governing every other site.

No new MCP server. No change to `navigate`, to tab scope, or to the approval gate.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `agent-browser-runtime`: the post-baseline addition set gains `search`; a new requirement fixes the closed engine list and the reuse of the navigate path, so the tool can never become a general URL-construction route.

## Impact

- `host/tool-definitions.js` — new tool schema (zod `paramShape`, matching the file's existing style).
- `extension/background.js` — new `search` handler in `toolHandlers`, delegating to the existing navigate path.
- `host/agent/tools/query-options.js` — `renderBrowserAutomationSystemPrompt()` gains the scope statement for `search`.
- `host/agent/tools/mapping.js` — `TAB_TARGET_ARG_KEYS` entry so the borrowed-tab scope gate applies; classification as a navigating (mutating) call, consistent with `navigate`.
- `test/fixtures/registry-baseline.json` — regenerated; `test/registry-baseline.test.mjs` pins every tool's schema and its post-baseline addition list, and both fail until updated.
- `extension/background.js` is a service worker: the change has no effect until the extension is reloaded.
