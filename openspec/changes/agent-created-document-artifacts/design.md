# Design — agent-created document artifacts

## 1. Why not the SDK's own artifact path

`sdk.d.ts` of the pinned `@anthropic-ai/claude-agent-sdk@0.3.263` exposes
`enableArtifact` / `disableArtifact` (lines 6268–6274). That tool publishes a
page to claude.ai and requires a Claude account. The extension's own manifest
description states the opposite property: "No Claude account needed. Any
Anthropic-compatible provider." The remaining file-shaped fields —
`SDKTaskNotificationMessage.output_file` (5216), staged-call
`input_files`/`output_files` (4127–4139), `file_attachments?: unknown[]` (5458)
— are subagent-task and tool-staging mechanics with no public user-facing
contract. Therefore the feature is built application-side, on the `ask_user`
pattern that already exists in this repo.

## 2. Decision: one tool, host-owned filesystem, no builtin widened

`Bash`/`Write`/`Edit`/`NotebookEdit` remain in `HIGH_RISK_BUILTINS`
(`host/agent/tools/query-options.js`). The model never names a path. It calls:

```
create_document({ title, format?, content })
```

- `title` — human title shown on the card. The **filename** is derived by the
  host: slugified title + extension. The model cannot influence the path.
- `format` — `md` (default) | `txt` | `csv` | `html` | `json` | `docx` | `xlsx`
  | `pptx` | `pdf`.
- `content` — markdown for the document formats; for `csv`/`xlsx` the model may
  pass a markdown table and the host converts it.

The host writes to `<conversation workspace>/documents/<docId>.<ext>` plus a
sibling `<docId>.json` metadata record. `docId` is host-minted
(`crypto.randomUUID()`), never model-supplied — a model-supplied id could
address another conversation's record.

**Guards** (all host-side, all rejecting rather than truncating silently):
filename slug limited to `[a-z0-9-]{1,80}`; content limited to 2 MB of source;
generated file limited to 10 MB (matches the existing attachment ceiling); at
most 50 documents per conversation.

## 3. Decision: metadata on the event, bytes on demand

`run.emit({ type: "document_created", documentId, title, fileName, format,
mimeType, byteLength })`. The bytes never ride the stream event — a 10 MB
document would blow the native-messaging message ceiling and would be paid for
on every reconnect snapshot replay, for a document the operator may never open.

The panel fetches bytes only when the operator opens or downloads a card:
`document_request { conversationId, documentId, requestId }` → host reads the
file → `chunkBuffer()` (`host/agent/broker/chunked-transport.js`, `kind:
"document_bytes"`) → the PANEL reassembles → a `Blob`.

Reassembly happens in the panel, not in `background.js`. The worker already
relays every agent envelope verbatim in both directions, including `chunk_*`,
so no worker change is needed at all; and `chrome.runtime` messaging is JSON,
so bytes assembled in the worker could not reach the panel as bytes anyway (a
`Uint8Array` sent that way arrives as an index-keyed object).

`chunked-transport.js` already implements both halves symmetrically, but the
extension side only had the **sender** (`chunkBytesForWire` in
`extension/background.js`). `extension/sidepanel/chunk-reassembler.js` is the
counterpart, mirroring the host module's validation (id match, index order,
declared total bytes, expiry) so a stale or truncated sequence is rejected
rather than yielding a corrupt blob.

## 4. Decision: Preview and Markdown exist for every format

| format | Preview tab | Markdown tab |
|---|---|---|
| md | `markdown-lite` → panel DOM (already XSS-safe) | source text |
| txt / json | `<pre>` text node | fenced source |
| csv | a table built with `createElement`/`textContent` | GFM pipe table |
| html | sandboxed iframe `srcdoc` | a DOM walk over the parsed document |
| docx | structure read with fflate + DOMParser, shown as semantic HTML in a sandboxed iframe | the same blocks, as markdown |
| xlsx | sheet tables in a sandboxed iframe | GFM pipe tables per sheet |
| pptx | per-slide title + bullets, extracted with fflate + DOMParser | the same, as a markdown outline |
| pdf | pdf.js canvas pages | pdf.js text layer, grouped by baseline, per page |

PPTX has no faithful in-browser renderer. Its Preview is an extraction, and the
UI says so — an honest limitation beats a silently lossy render.

**Untrusted-HTML rule.** Everything a converter emits is untrusted: it derives
from model output and, transitively, from page content the model quoted. Only
`markdown-lite` output — which escapes every character before formatting — goes
into the panel DOM. Every converter's HTML goes into
`<iframe sandbox srcdoc="...">` with no `allow-scripts` and no `allow-same-origin`,
so an injected `<script>` cannot run and cannot reach the panel's DOM,
`chrome.*`, or storage.

`sandbox` stops scripts but NOT the network, and this extension holds
`<all_urls>`, so a document carrying a remote image would beacon on preview.
Every rendered document therefore carries
`default-src 'none'; style-src 'unsafe-inline'; img-src data:` as a policy meta
— in the panel's preview wrapper, in the host's html generator, and injected
into the head of a document a run wrote whole — with the iframe's `csp`
attribute as a second lock. Verified in a real browser against a counting
endpoint: an unguarded control frame fetched the beacon, the guarded frame did
not.

## 5. Decision: lifetime is the conversation

Documents live in the conversation workspace. No panel-side persistence was
needed: `applySnapshot()` already performs a full rebuild of a conversation
from its persisted event stream, so a reloaded panel gets its cards back from
the replayed `document_created` events, and Download and Preview still work. Deleting the conversation deletes the
`documents/` directory. This rules out the "temp file" alternative, where a
reload leaves dead cards in the transcript.

## 6. Bundle-size handling

pdf.js (with its worker, ~1.8 MB) is the only large viewer library vendored at
all — see §7 on why mammoth and exceljs were rejected. It and `fflate` are
loaded by dynamic `import()` at the moment a document of that
format is first opened, so a session that never opens a PDF never pays for
pdf.js. The card, the modal shell, and the md/txt/csv/json/html paths carry no
vendored dependency at all.

## 7. Risks

- A vendored build that uses `eval`/`new Function` violates the MV3 CSP. Each
  vendored file is verified after copying (grep for `eval(`/`new Function`),
  never trusted from its documentation.
- npm's `xlsx` package (0.18.5) is stale and carries an unpatched
  prototype-pollution advisory; `exceljs` (MIT, 4.4.0) is used instead on the
  HOST side. On the panel side neither ships: measurement found the forbidden
  dynamic-code constructor in mammoth's browser build (7 sites) and in
  exceljs's (1), which MV3's CSP refuses, so docx/xlsx/pptx are read with
  `fflate` plus the panel's own `DOMParser` — which also removes ~1.5 MB from
  the package.
- `pptxgenjs` pulls in `image-size`, which carries a denial-of-service
  advisory in its ICNS/JXL/HEIF parsers. That parser only runs when an image is
  added to a slide, and the deck generator here is built from the run's text
  alone, so the vulnerable path is not reachable through this code. Recorded
  rather than dismissed: adding an image to a generated deck later would make
  it reachable.
- The PDF path embeds DejaVu Sans (~1.4 MB of TTF in the host package). Not
  optional: pdf-lib's standard fonts are WinAnsi and throw on the first
  Vietnamese character. Licensing is recorded in NOTICE.
- The change spans host, background, and panel. It ships in three commits
  (core path → viewers → binary generators) rather than one diff.
