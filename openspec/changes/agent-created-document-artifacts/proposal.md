## Why

The agent can produce a long, structured result (an audit, a report, a data table) but the panel has only one place to put it: the message stream. Long output is unreadable inline, cannot be saved, and is lost to scrollback. Claude in Chrome solves this with a document card in the transcript — "Phan tich dauthau asia · Document · MD" — that opens a detail view and can be downloaded; its card routes to Google Drive, which this project deliberately does not want (no third-party account, no upload of the operator's work).

The Claude Agent SDK ships no vendor-neutral primitive for this. Its `enableArtifact` option publishes to claude.ai and needs a Claude account, contradicting this extension's stated property ("No Claude account needed. Any Anthropic-compatible provider"); `output_files`/`output_file`/`file_attachments` in `sdk.d.ts` are subagent-task and staging-lane mechanics, not a user-facing file channel. Evidence: `plans/reports/research-260910-0025-agent-document-artifacts.md`.

## What Changes

- New application-owned SDK tool `create_document({ title, format, content })` registered the same way `ask_user` is (`extraTools` + `extraToolNames`). It does NOT relax the security boundary: `Bash`/`Write`/`Edit`/`NotebookEdit` stay in `HIGH_RISK_BUILTINS`. The tool writes only into the conversation's own workspace under `documents/`, with a normalized filename (no path segments, no `..`, bounded length), a bounded size, and a bounded document count per conversation.
- Formats: `md` (default), `txt`, `csv`, `html`, `json` are written directly with no dependency. `docx`, `xlsx`, `pptx`, `pdf` are generated on the host from the model's markdown/structured content via `docx`, `exceljs`, `pptxgenjs`, `pdf-lib`.
- New stream event `document_created` carrying id, title, filename, format, mimeType, byteLength — never the bytes. The transcript renders a document card (icon, title, `Document · MD`, a Download control) in place of the Drive dropdown.
- Clicking the card opens a detail modal with two tabs, **Preview** and **Markdown**, for every format. Preview renders the document; Markdown shows the markdown source, or for a binary format the extracted markdown equivalent. Download writes the real bytes via an `<a download>` blob URL — no `downloads` permission, no network, no Drive.
- Bytes travel host→panel on demand over the existing chunk wire shape
(`host/agent/broker/chunked-transport.js`), which had no extension-side
reassembler; one is added in the PANEL as the symmetric counterpart of the
existing extension-side `chunkBytesForWire`. `background.js` needs no change:
it already relays every agent envelope verbatim in both directions.
- Documents live for the life of the conversation: stored in the conversation workspace, re-openable after a panel reload (a reconnect replays the conversation's event stream, so the cards come back with it), removed when the conversation is deleted.
- Rendering libraries are vendored (precedent: rrweb), but only two: pdf.js and `fflate`. mammoth and exceljs were measured and rejected — their browser builds use the dynamic-code constructor MV3's CSP refuses — so Word, Excel and PowerPoint are read with fflate plus the panel's own DOMParser. Any HTML a converter produces is untrusted content, rendered inside a sandboxed iframe carrying `default-src 'none'`, never injected into the panel DOM; only `markdown-lite` output reaches the panel DOM.

## Capabilities

### New Capabilities

- Agent-created document artifacts: a run can hand the operator a named file, shown as a card in the transcript, viewable in two representations and downloadable locally.

### Modified Capabilities

- `agent-browser-runtime`: gains one application-owned tool, one stream event, one panel→host fetch request, and a per-conversation document store — without widening the built-in tool allowlist.
- `browser-assistant-panel`: the transcript gains a document card; the panel gains a document detail modal with Preview/Markdown tabs and local download.

## Impact

- Host: `host/agent/tools/create-document.js` (new), `host/agent/documents/store.js` (new), `host/agent/documents/render/*.js` (new generators), registration in `host/agent/companion.js`, tool-name allowlist in `host/agent/tools/query-options.js`, a `document_request` wire handler, `host/package.json` dependencies (`docx`, `exceljs`, `pptxgenjs`, `pdf-lib`, plus `@pdf-lib/fontkit` and `dejavu-fonts-ttf` — the PDF standard fonts are WinAnsi and cannot encode Vietnamese at all).
- Extension: chunk reassembler and fetch client under `extension/sidepanel/`; `document_created` item in `conversation-model.js`; card + modal in `sidepanel.js` / `sidepanel.html` / `sidepanel.css`; per-format viewers in `extension/sidepanel/viewers/`; Vietnamese labels in `tool-labels.js`; pdf.js and `fflate` vendored.
- Tests: new unit suites for filename/size normalization, the document store, each generator's magic bytes, the reassembler, and the conversation-model item. Existing suites stay green.
- Out of scope: editing a document after creation, syncing to any cloud service, sharing links, and any change to `HIGH_RISK_BUILTINS`.
