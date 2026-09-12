## Context

Browzy already has everything this needs except the tool itself. `navigate` accepts an arbitrary URL and `isDestinationAllowed` is the default allow-all, so the assistant is technically able to reach a search-results URL in one call today. What stops it is `renderBrowserAutomationSystemPrompt()`, which twice forbids assembling a URL in place of operating a control.

That prohibition is load-bearing and stays. The design question is therefore narrow: how to carve out the one case where nothing is being inferred, without widening the carve-out by accident.

Reference: browser-use solves the same problem with a `search` action holding three hardcoded engine templates (`tools/service.py:463-474`), and its own system prompt separately forbids fabricating values. The fast path and the anti-fabrication rule coexist there for exactly this reason — the templates are constants, not inferences.

## Goals / Non-Goals

**Goals**

- One model round trip for "search the web for X", down from about six.
- The set of URLs this tool can produce is closed and readable in one place.
- Reuse the existing navigation path, including its tab-scope and restricted-page behavior.

**Non-Goals**

- Not a general navigation shortcut. `navigate` already exists for that.
- Not a search-results reader. What comes back is a page; reading it is `get_page_text`/`find`/`read_page` as usual.
- Not a relaxation of the URL-assembly prohibition for any site.
- No new MCP server, no new transport, no change to the approval gate.

## Decisions

### Decision: A dedicated tool, not a prompt exception

A prompt-only carve-out ("you may construct URLs for search engines") would be cheaper — no schema, no handler, no baseline regeneration. It is rejected because a prompt exception is a judgment the model makes at run time, and it can be got wrong in both directions: too timid to use it, or generalized into "this site's parameters are guessable too", which is the exact failure the prohibition exists to prevent.

A tool makes the boundary mechanical. The engine map is the whole of what can be produced, and no wording in any prompt can widen it.

### Decision: This does not overlap with the `WebSearch` builtin, and does not depend on it

The obvious objection is that the assistant already has the SDK's `WebSearch` builtin, so a browser search tool is redundant. It is not, for two independent reasons.

**It is not always there.** `WebSearch` is executed by the API, not by the model. A profile pointing at a custom `baseUrl` — a proxy, a gateway, a third-party endpoint — keeps the model and loses the tool. `search` depends on nothing but the browser the extension is already driving, so it is the route that always works.

**It answers a different question even when both are available.** `WebSearch` returns text to the model; nothing happens on the user's screen, and no result can be clicked. Reaching a result still means opening it in the browser, which is the same sequence this change exists to collapse. The product requirement recorded in `renderBrowserAutomationSystemPrompt()` — the user is watching this happen in their own browser — is met by one of these and not the other.

The two are therefore complementary: `WebSearch` to read about something, `search` to go there and work.

No detection of `WebSearch`'s presence is built, and none is wanted. The model's tool list is already the source of truth — a tool that is not there is simply not called, with no error to handle. Once `search` exists there is always a working route, so an absent `WebSearch` costs some speed and nothing else. Probing an endpoint for builtin support would be machinery for a case that resolves itself.

The one consequence that does need care: the prompt passage for `search` must not mention `WebSearch` or position the two against each other, or it would name a tool the model may not have. `search` is described on its own terms.

### Decision: The engine list is a literal map with three entries

```
google      https://www.google.com/search?q={q}&udm=14
bing        https://www.bing.com/search?q={q}
duckduckgo  https://duckduckgo.com/?q={q}
```

Taken from browser-use, which uses these verbatim. `udm=14` selects Google's plain-results view, which is what a reading agent wants and what browser-use pins.

An unknown engine returns an error rather than falling back to a default. A silent fallback would mean the caller's stated intent (`engine: "startpage"`) produced results from somewhere else with nothing in the result to say so.

### Decision: Delegate to the existing navigate path rather than re-dispatching

The handler builds the URL and then goes through the same code `navigate` uses. It does not call `chrome.tabs.update` itself. This keeps one owner for tab-scope checks, restricted-page refusals, history handling, and the "returns once navigation is committed" contract. A second navigation implementation would drift from the first, and the drift would be invisible until one of them refused something the other allowed.

### Decision: Classified as a navigating call, like `navigate`

`search` changes what the tab is showing, so `mapping.js` classifies it with `navigate` rather than with the read-only tools, and it gets a `TAB_TARGET_ARG_KEYS` entry so the borrowed-tab scope gate applies to its `tabId`. Nothing about it is send-class, so it does not touch the approval gate.

### Decision: Encoding is `encodeURIComponent`, applied to the query only

The query is the only caller-controlled part of the URL. Encoding it before substitution is what stops a query like `a&b=c` from adding a parameter, and what makes a Vietnamese query reach the engine intact. The template around it is a constant and is never encoded or parsed.

## Risks / Trade-offs

**The model may reach for `search` when it should operate a site's control.** Mitigated by the prompt text, which states `search` covers general-purpose engines and that a site's own controls remain the required route. This is guidance, not enforcement — but the failure mode is mild (a web search instead of an on-site search, visible in the result) and far milder than the constructed-URL failure the prohibition prevents.

**Engine templates can go stale.** Google has changed result URLs before. Mitigated by keeping all three in one literal map with a comment saying where they came from; a stale template fails visibly as a wrong-looking results page, not silently.

**`udm=14` is a Google-specific parameter that could be removed upstream.** Accepted: if it stops working, the URL degrades to ordinary Google results, which is still a correct search.

## Migration Plan

None. Purely additive: a new tool name, no change to any existing tool's schema or behavior.

`test/registry-baseline.test.mjs` pins every tool's schema and the enumerated post-baseline addition list, so both the snapshot (`test/fixtures/registry-baseline.json`) and the addition list must be updated in the same change. That test failing is the intended signal that a tool was added; it is regenerated deliberately, not routed around.

The extension is a service worker — no effect until reloaded.

## Open Questions

None.
