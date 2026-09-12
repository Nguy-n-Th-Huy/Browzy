## 1. Tool schema

- [ ] 1.1 Add the `search` entry to `TOOLS` in `host/tool-definitions.js`: `query` (string), `engine` (enum of the three accepted names, defaulting to google), `tabId` (number). Match the file's existing zod `paramShape` style.
- [ ] 1.2 Write the description: one call to reach a general-purpose engine's results; the accepted engine names; that it is for general-purpose search only and a site's own search or filter controls must still be operated; that the query is taken as search terms, never as a URL. ← (verify: description states the closed engine set and does not invite URL construction for other sites)

## 2. Handler

- [ ] 2.1 Add the engine template map to `extension/background.js` as a single literal near the `search` handler, with a comment recording that the templates come from browser-use and are constants, not inferences.
- [ ] 2.2 Add the `search` handler to `toolHandlers`: reject an unknown engine with an error naming the accepted values and no navigation; otherwise `encodeURIComponent` the query, substitute into the template, and go through the existing navigate path rather than re-implementing navigation.
- [ ] 2.3 Return a result naming the engine and the query searched for. ← (verify: handler delegates to the existing navigate path — no second `chrome.tabs.update` call site, no duplicated scope or restricted-page logic)

## 3. Policy wiring

- [ ] 3.1 Add `search: ["tabId"]` to `TAB_TARGET_ARG_KEYS` in `host/agent/tools/mapping.js` so the borrowed-tab scope gate applies.
- [ ] 3.2 Classify `search` with the navigating/mutating calls, alongside `navigate` — not with the read-only tools. ← (verify: a borrowed tab outside scope refuses `search` exactly as it refuses `navigate`)

## 4. Prompt

- [ ] 4.1 In `renderBrowserAutomationSystemPrompt()` (`host/agent/tools/query-options.js`), state that `search` covers general-purpose search engines and is the fast route for starting from a web search.
- [ ] 4.2 Reaffirm in the same passage that a site's own search, filter, or form controls must still be operated, and leave the existing "do not assemble a URL to stand in for what a control would have done" text unchanged. ← (verify: the existing prohibition is present and unweakened; diff shows added text only)
- [ ] 4.3 Write that passage so it never mentions `WebSearch` or contrasts the two. `WebSearch` is executed by the API, so it is absent whenever the profile points at an endpoint that does not provide it — prompt text naming it would then be pointing at a tool the model does not have. `search` must read as complete on its own. ← (verify: no occurrence of `WebSearch` anywhere in the prompt text, only in code comments explaining why)

## 5. Tests

- [ ] 5.1 New `test/search-tool.test.mjs`, extracting the handler with `test/_extract.mjs`: each accepted engine produces its exact template URL; an unknown engine errors and navigates nowhere; a query with spaces, `&`, `#`, `+` and non-ASCII characters is encoded so none of it becomes URL structure; a query that looks like a URL is still encoded as search terms.
- [ ] 5.2 Add `search` to the enumerated post-baseline addition list in `test/registry-baseline.test.mjs`.
- [ ] 5.3 Regenerate `test/fixtures/registry-baseline.json` for the new tool entry, and confirm the diff adds only that entry.
- [ ] 5.4 Run `node test/search-tool.test.mjs`, `node test/registry-baseline.test.mjs`, `node test/extension-scripts-parse.test.mjs`, `node test/handlers.test.mjs`, then the full `test/*.test.mjs` sweep. ← (verify: only the two known-red files fail — `overlay-background-bridge`, `side-panel-group-scope` — and neither is touched by this change)
