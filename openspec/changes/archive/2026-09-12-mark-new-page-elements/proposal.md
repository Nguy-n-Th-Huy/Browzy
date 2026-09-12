## Why

The assistant's own guidance already warns, at length, about the failure this targets: refs inside a dropdown go stale the moment it closes because the list is rebuilt each time it opens, and the entry wanted in an autocomplete list is often not the first one. Both are cases where the page grew new elements in response to what the assistant just did, and the assistant has no way to tell which elements those are.

Today a second `read_page` or `find` after typing into a field returns one flat list. The freshly-rendered suggestion list is in there, indistinguishable from the rest of the page. The assistant has to infer which entries are new from their text, which is exactly the guess that ends with a click on whatever sat underneath a floating list.

browser-use marks newly-appeared interactive elements with a `*` prefix and tells the model plainly that its own previous action caused them. The same signal is cheap here, because refs are already assigned from a monotonic counter and already persist across calls.

## What Changes

- `read_page` and `find` mark elements first seen since that tab's previous read with a visible prefix.
- The marking resets whenever the document identity changes — a real navigation or an SPA route change — because after a navigation everything is new and marking all of it says nothing.
- The first read of a document marks nothing, for the same reason.
- The tool output states what the marker means, so it is self-describing rather than depending on prompt text alone.
- The browser-automation prompt explains the marker and when it is meaningful.

No change to how refs are assigned, resolved, or hit-tested. No change to any click path.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `agent-browser-runtime`: live current-page reading gains a requirement that page reads distinguish elements newly appeared since the previous read of the same document, and that the distinction resets on document identity change.

## Impact

- `extension/content.js` — `generateAccessibilityTree()` and the `find` path emit the marker; a per-document high-water mark on the existing ref counter, reset from the existing `bumpDocumentEpoch()`.
- `extension/background.js` — `read_page` and `find` handlers include the marker's meaning in the text they return.
- `host/agent/tools/query-options.js` — prompt explains the marker and its reset-on-navigation caveat.
- `host/tool-definitions.js` — `read_page` and `find` descriptions mention the marker. This changes their pinned schema text, so `test/fixtures/registry-baseline.json` must be regenerated.
- `extension/content.js` and `extension/background.js` both require an extension reload to take effect.
