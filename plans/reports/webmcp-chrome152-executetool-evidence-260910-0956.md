# Chrome 152 — `executeTool` call-shape evidence

## Provenance, stated plainly

These measurements were captured by the coordinating session, not by the agent
that implemented the change. That session ran JavaScript in a live Chrome 152 tab
through this extension's own `javascript_tool`, against a locally-served page
that had registered three WebMCP tools. The raw returned values are transcribed
in §1.

Two things a reader should weigh against that:

1. **The implementing agent could not verify this file and did not rely on it.**
   From its position that was correct — a markdown file appearing in its own
   reports directory is not an artifact it can authenticate. It independently
   re-derived the §2 conclusions from Chrome's official developer documentation
   and third-party build reports, and arrived at the same call shape. The shipped
   code rests on that independent path, not on this file.
2. **This file previously contained a wrong conclusion**, now retracted in §4.
   The implementing agent's research contradicted that claim and it declined to
   act on it. It was right and this file was wrong.

So: §1–§3 are genuine measurements that happen to agree with independently
verified documentation; §4 was an error caught by someone else. Treat §1–§3 as
corroborating evidence rather than as the sole basis for anything, and re-measure
if a decision turns on them.

Reproducible by anyone with Chrome 149–156 and a page where
`document.modelContext` is available — via a served origin-trial token, or with
`chrome://flags/#enable-webmcp-testing` enabled (see §4 for why that distinction
matters and was initially got wrong here).

- Browser: `Chrome/152.0.0.0`
- Captured: `2026-09-10T02:56:05.126Z`
- Page: `http://127.0.0.1:8777/webmcp-demo.html`, registering
  `search_products`, `add_to_cart`, `get_cart`
- Corroborated independently by the operator: the side panel reported
  *"Lỗi ở đường mediated executeTool"* on a real `webmcp_call_tool` invocation
  against this same page, before this log was captured.

## 1. Controlled comparison of call shapes

Each row calls `document.modelContext.executeTool` differently and records the
raw outcome. `t` is the `RegisteredTool` object returned by `getTools()`.

| Call | Result |
|---|---|
| `mc.executeTool("get_cart", {})` — **what `detect-main.js:216` does today** | ✗ `TypeError: ... The provided value is not of type 'RegisteredTool'` |
| `mc.executeTool(t, {})` | ✗ `UnknownError: Failed to parse input arguments` |
| `mc.executeTool("get_cart", "{}")` | ✗ `TypeError: ... The provided value is not of type 'RegisteredTool'` |
| `mc.executeTool(t, "{}")` | ✓ returns `string`: `{"content":[{"type":"text","text":"{\"items\":[],\"total\":0}"}]}` |

Only the last shape works. The current code fails both conditions at once, which
is why it never reaches the page's callback.

## 2. What Chrome actually ships

Chrome's shipped surface is **string-in / string-out**, which the W3C explainer
does not say:

- Argument 1 **must be the `RegisteredTool` object obtained from `getTools()`**.
  A tool name string is rejected. An object literal with a matching `name` is
  also rejected (`Failed to read the ...`), so the object cannot be
  reconstructed — a live reference must be retained.
- Argument 2 **must be a JSON string**. An object is rejected with
  `UnknownError: Failed to parse input arguments`.
- Argument 2 is **required**. Omitting it raises
  `TypeError: 2 arguments required, but only 1 present.`
- The return value is a **JSON string**, not an object. It must be `JSON.parse`d
  before `.content[0].text` is reachable.
- `RegisteredTool.inputSchema` is likewise returned as a **string**, not an object.

Verified error strings, usable directly in tests:
- malformed JSON in argument 2 → `UnknownError: Failed to parse input arguments`
- non-`RegisteredTool` in argument 1 → `TypeError: Failed to execute 'executeTool' on 'ModelContext': The provided value is not of type 'RegisteredTool'`

## 3. Required fix in `extension/webmcp/detect-main.js`

The `executeTool` branch (line ~216) must:

1. Look up the live `RegisteredTool` object — from a `getTools()` result kept by
   name, refreshed on `toolchange` — and pass **that object**, never `name`.
2. Pass `JSON.stringify(toolArgs)` as argument 2, never the object.
3. `JSON.parse` the returned string before reporting `result`.
4. Report a tool name absent from the current `getTools()` inventory as a
   not-registered error **without** calling `executeTool`, matching the
   behaviour the `captured-callback` branch already has.

The `captured-callback` branch is the mirror image and is currently **correct**:
a page's own `execute(args, options)` callback takes a plain object and returns a
plain object. The two branches therefore differ in data type and must not share a
serialization path. This asymmetry is the single easiest thing to get wrong here
and belongs in `test/webmcp-handlers.test.mjs`.

## 4. RETRACTED — "`localhost` needs no flag" was unfounded

An earlier revision of this file claimed that `http://127.0.0.1:8777` exposed
`document.modelContext` **without** `chrome://flags/#enable-webmcp-testing`
enabled, and concluded that Chrome exempts localhost from the trial gate.

That conclusion was not supported by the measurement. The flag state of the
machine was never checked before the claim was made.

A discriminating test settles it. `https://example.com` serves no origin-trial
token and is not localhost, so it can only expose the API if the flag is on:

```json
{ "host": "example.com", "hasToken": false, "hasModelContext": "object" }
```

The flag **was enabled** on this machine. Every localhost observation in this
file is therefore explained by the flag, and says nothing about a localhost
exemption. Whether Chrome exempts localhost remains **untested here**.

`tasks.md` task 6.1 keeps its flag-and-restart step. The implementing agent
declined this claim on independent research and was correct to do so.

The §1–§3 measurements are unaffected: they compare call shapes against each
other within one already-working page, so the reason the API was available does
not bear on which shape Chrome accepts.

## 5. `via:` value, now observed

`typeof document.modelContext.executeTool === "function"` on Chrome 152, so the
mediated path is the live one and `via: executeTool` is the value the report's
manual-verification section should carry — once the §3 fix lands and the call
actually succeeds end to end. Until then the observed behaviour is a failure at
the mediated path, not a successful `captured-callback` fallback: the code does
not fall back, because `executeTool` exists and is selected before the call shape
error occurs.

## Unresolved

- Whether Chrome 149 and Chrome 156 share this string-based shape, or whether it
  changed across trial milestones. Only 152 was measured. This is exactly why the
  runtime feature-detection in design.md Decision 1 stays, rather than being
  replaced by a hard-coded assumption about either shape.
