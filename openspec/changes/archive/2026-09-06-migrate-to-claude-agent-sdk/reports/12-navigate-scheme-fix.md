# navigate URL-scheme corruption — root cause, live reproduction, and fix

This report documents a live, user-reproduced bug in the `navigate` tool's
URL normalization: any input whose scheme was not `http`/`https` (plus a
short, hard-coded list of literal `about:`/`chrome:`/`brave:` prefixes) was
silently corrupted before being handed to `chrome.tabs.update()`.

## The bug, as reproduced live

Calling `navigate` with:

```
chrome-extension://ihljfjgoakmoemkdondoaadegpmibimh/sidepanel/sidepanel.html
```

produced this result string and this actual browser navigation (verified in
Brave):

```
Navigated to https://chrome-extension//ihljfjgoakmoemkdondoaadegpmibimh/sidepanel/sidepanel.html
```

The tab then showed Chrome's `DNS_PROBE_POSSIBLE` — "chrome-extension's DNS
address could not be found" — because the URL that was actually navigated to
is not the extension page at all; it is a bogus `https://` URL whose "host"
is the literal string `chrome-extension`.

## Root cause

`extension/background.js`'s `navigate` handler (`toolHandlers.navigate`)
normalized the incoming URL like this (pre-fix):

```js
let targetUrl = url;
// Strip any malformed protocol prefix before normalizing
if (!targetUrl.match(/^https?:\/\//i) && !targetUrl.startsWith("about:") && !targetUrl.startsWith("chrome:") && !targetUrl.startsWith("brave:")) {
  // Remove any partial/broken protocol prefix (e.g., "hps://", "http:/", "ht://")
  targetUrl = targetUrl.replace(/^[a-z]{1,5}:\/+/i, "");
  targetUrl = "https://" + targetUrl;
}
```

This implements the tool's documented "can be provided with or without
protocol (defaults to `https://`)" behavior (`host/tool-definitions.js`'s
`navigate.paramShape.url` description — read, not modified, per this task's
scope) by testing for `http`/`https` only, with three more schemes
hard-coded as exceptions. Any other scheme — `chrome-extension:`, `file:`,
`data:`, `blob:`, `view-source:`, and any future custom scheme — falls into
the `else` branch and gets `"https://"` blindly prepended.

For `chrome-extension://<id>/...`, the "strip a malformed prefix" regex
(`/^[a-z]{1,5}:\/+/i`) does not even match (the scheme token `chrome-extension`
is 16 characters and contains a hyphen, so it can't satisfy `[a-z]{1,5}`), so
the string is left untouched and `"https://"` is prepended directly:

```
"https://" + "chrome-extension://ihljfjgoakmoemkdondoaadegpmibimh/sidepanel/sidepanel.html"
= "https://chrome-extension://ihljfjgoakmoemkdondoaadegpmibimh/sidepanel/sidepanel.html"
```

That string is then run through `new URL(...)` purely as an existing
validation step (`try { new URL(targetUrl) } catch { ... }`) before being
passed to `chrome.tabs.update()`. The WHATWG URL parser treats
`https://chrome-extension:...` as `scheme=https`, and inside the authority
component reads `chrome-extension:` as `host=chrome-extension` with an empty
port (the `:` is the host/port separator), discarding the rest of the
authority text and folding the remaining `//ihljfjgoakmoemkdondoaadegpmibimh/
sidepanel/sidepanel.html` into the path — which is exactly the reported
`https://chrome-extension//ihljfjgoakmoemkdondoaadegpmibimh/sidepanel/
sidepanel.html`. Confirmed directly in Node:

```js
> new URL("https://chrome-extension://ihljfjgoakmoemkdondoaadegpmibimh/sidepanel/sidepanel.html").href
'https://chrome-extension//ihljfjgoakmoemkdondoaadegpmibimh/sidepanel/sidepanel.html'
```

byte-for-byte the string from the live bug report — confirming the exact
mechanism, not just a plausible one.

**This also explains a previously mis-recorded finding.**
`reports/05-visual-system.md` documented "The `navigate` tool cannot open a
`file://` URL" as if it were an inherent limitation, and built a local static
HTTP server workaround around it. It was never a limitation of `file://`
specifically — it is this exact same bug (`file://` is just another
non-http(s) scheme that fell into the same blind-prepend branch). That report
has been corrected in place to point here.

## The fix

`extension/background.js`: replaced the http(s)-plus-three-literals test with
a new helper, `hasUrlScheme(input)`, and the normalization now reads:

```js
if (!hasUrlScheme(targetUrl)) {
  targetUrl = "https://" + targetUrl;
}
```

`hasUrlScheme()` does real scheme-grammar parsing (RFC 3986:
`scheme = ALPHA *( ALPHA / DIGIT / "+" / "-" / "." )`), not a `"://"`
substring check:

```js
const KNOWN_NON_SLASH_SCHEMES = new Set(["about", "data", "blob", "javascript", "mailto", "view-source"]);
function hasUrlScheme(input) {
  const m = /^([a-zA-Z][a-zA-Z\d+\-.]*):(.*)$/s.exec(input);
  if (!m) return false;
  const [, scheme, rest] = m;
  if (rest.startsWith("//")) return true;
  return KNOWN_NON_SLASH_SCHEMES.has(scheme.toLowerCase());
}
```

The one genuine ambiguity in that grammar is that a bare `host:port` (e.g.
`example.com:8080/path`) is *syntactically* indistinguishable from
`scheme:opaque-data` — `new URL("example.com:8080/path")` itself parses this
as `protocol: "example.com:"`, which is why `hasUrlScheme()` cannot simply
delegate to `new URL().protocol`. It resolves the ambiguity the way a
browser's own URL-bar heuristics do:

- A scheme written in **authority form** (`scheme://...`) is unambiguous —
  nothing that isn't a real scheme is followed by `//` in ordinary input —
  so it is always accepted. This is what makes `chrome-extension://`,
  `file://`, `http(s)://`, `ftp://`, `chrome://`, `brave://`, and any future
  browser/extension scheme pass through untouched, generically, with no
  per-scheme hard-coding.
- A scheme **not** in authority form is only accepted when it is one of a
  small set of well-known non-slash browser schemes (`about:`, `data:`,
  `blob:`, `javascript:`, `mailto:`, `view-source:`). Anything else without
  `//` — including `example.com:8080/path` and `localhost:3000` — is treated
  as scheme-less and still gets `https://` prepended, exactly as before.

Everything downstream of the scheme decision is unchanged: the existing
`try { new URL(targetUrl) } catch { return "Invalid URL..." }` validation
still runs before `chrome.tabs.update()`, and `back`/`forward` handling was
not touched at all.

### A deliberate, narrower behavior change: no more protocol-typo "recovery"

The pre-fix code also tried to recover from *typos* of `http(s)://` (its
comment: `"Remove any partial/broken protocol prefix (e.g., "hps://",
"http:/", "ht://")"`) by stripping any short (1-5 letter) scheme-looking
prefix before prepending `https://`. That heuristic — "if I don't recognize
this scheme, assume it's a broken `https`" — is the same category of guess
that caused this bug (chrome-extension wasn't recognized either, and got the
same treatment). Keeping it would mean `hps://example.com` and
`chrome-extension://<id>/...` are handled by the same "not sure, coerce to
https" logic that just produced a DNS failure from a real, valid input.

Per the task's stated principle ("a scheme that the browser or the extension
refuses should still be refused, just with an honest error instead of a
corrupted URL and a DNS failure"), `hps://example.com` is now left untouched
and passed to `chrome.tabs.update()`, which will reject it as an unsupported
protocol — an honest, immediate error instead of a silently wrong
`https://` guess. No test in this repo exercised the typo-recovery behavior
(confirmed by search — `grep -rn "hps://\|malformed protocol" test/
host/test/` before this change had no hits beyond the removed comment
itself), and `host/tool-definitions.js`'s tool description never documented
it as a guaranteed behavior.

## Security note

This is a normalization-only change. No tab-scope, group-membership, or
authorization check was touched — `isInGroup(tabId)` still gates the handler
before any URL logic runs, exactly as before. No new capability is granted:
passing a scheme through unmangled does not make Chrome (or this extension)
accept anything it previously refused; it only stops the tool from silently
rewriting a valid input into a different, broken one. If a scheme genuinely
needs a browser-level opt-in to load via `chrome.tabs.update()` (e.g. some
`file://` access policies), that is unchanged by this fix and is not
addressed here — it would surface as Chrome's own error for that navigation,
not as a new grant introduced by this change.

## Files changed

- `extension/background.js` — added `hasUrlScheme()` (module-level helper,
  placed immediately before `const toolHandlers = {`) and replaced the
  `navigate` handler's scheme test with a call to it. `back`/`forward`
  handling is byte-for-byte unchanged.
- `openspec/changes/migrate-to-claude-agent-sdk/reports/05-visual-system.md`
  — corrected the "`navigate` tool cannot open a `file://` URL" claim to
  point at this report and the real root cause.
- `test/navigate-url-scheme.test.mjs` (new) — see below.

## Tests

New: `test/navigate-url-scheme.test.mjs`, run against the shipped source via
`test/_extract.mjs`'s brace-matching extractor (not a paraphrase):

- A table-driven check of `hasUrlScheme()` proving pass-through (`true`) for
  `chrome-extension://` (the exact live-bug input), `file:///`, `file://` with
  an authority, `about:blank`, `data:`, `blob:`, `view-source:`, `http://`,
  `https://`, and `chrome://`/`brave://` (now handled generically, no longer
  needing their old literal special-cases) — and scheme-less (`false`) for a
  bare host/path, a bare host, `example.com:8080/path` (the host:port
  ambiguity case), `localhost:3000`, and a bare subdomain host.
- An end-to-end check of the real `navigate()` handler (mocked
  `chrome.tabs.*`) asserting the *exact* URL string passed to
  `chrome.tabs.update()`: the live bug's exact input
  (`chrome-extension://ihljfjgoakmoemkdondoaadegpmibimh/sidepanel/
  sidepanel.html`) is passed through unchanged and is explicitly asserted to
  NOT equal the corrupted `https://chrome-extension//...` string; `file:///`,
  `about:blank`, `data:`, and `view-source:` pass through unchanged;
  `example.com:8080/path` and `example.com/path` still get `https://`
  prepended.
- `back`/`forward` unchanged: asserts `chrome.tabs.goBack`/`goForward` are
  called with the tab id and that `chrome.tabs.update` is never called for
  those inputs (the mock throws if it is).

Full suite results:

- `node test/navigate-url-scheme.test.mjs` — all tests pass.
- `node test/registry-baseline.test.mjs` — passes unchanged; `navigate`'s
  registry entry (`host/tool-definitions.js`) was not touched, so the
  committed `test/fixtures/registry-baseline.json` snapshot still matches
  (this fix is entirely inside `extension/background.js`'s handler body, not
  the tool's declared schema).
- Every suite in `test/*.test.mjs` (37 files, run individually with
  `node <file>`): all pass.
- Every suite in `host/test/*.test.mjs` (39 files, run individually with
  `node <file>`): all pass, no failures observed (including
  `settings-live.test.mjs`, which self-skips without
  `OCIC_RUN_LIVE_PROVIDER_TESTS=1`) — this fix is confined to
  `extension/background.js` and does not touch anything under `host/`.
