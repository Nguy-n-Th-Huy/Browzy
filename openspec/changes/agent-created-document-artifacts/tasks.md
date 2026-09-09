## 1. Host: document store and the `create_document` tool

- [x] 1.1 `host/agent/documents/store.js` — host-minted `docId`, title slugification (`[a-z0-9-]{1,80}`), per-conversation `documents/` dir under the conversation workspace, `<docId>.<ext>` + `<docId>.json` metadata pair, list/read/delete, and the four guards (2 MB source, 10 MB output, 50 docs/conversation, no path escape) ← (verified: `..`, absolute paths and unicode-only titles all normalize or reject; a rejected write leaves no file behind)
- [x] 1.2 `host/agent/tools/create-document.js` — the SDK tool on the `ask-the-user.js` shape: zod input `{ title, format?, content }`, host-side write, `run.emit({ type: "document_created", ... })`, plain `CallToolResult` back to the model, exported `CREATE_DOCUMENT_TOOL_NAME`
- [x] 1.3 Registered in `host/agent/companion.js` alongside `askUserTool` AND named in `extraToolNames` in the same call, bound to the calling conversation id rather than to anything in tool args
- [x] 1.4 Unit tests for store guards and the tool handler — `host/test/agent-documents.test.mjs`, 13/13

## 2. Bytes transport, host→panel

- [x] 2.1 Host `document_request` handler: reads the stored file, `chunkBuffer()` with `kind: "document_bytes"`, `found:false` with a reason for anything unreadable
- [x] 2.2 Chunk reassembler, placed in the PANEL (`extension/sidepanel/chunk-reassembler.js`) rather than in `background.js`: the worker already relays `chunk_*` verbatim, and `chrome.runtime` messaging is JSON, so bytes assembled in the worker could not reach the panel as bytes at all. Mirrors the host reassembler's validation ← (verified: out-of-order, duplicated, truncated and expired sequences are all rejected)
- [x] 2.3 No background change was needed — `background.js` already relays every agent envelope verbatim in both directions, so the panel speaks `document_request` and consumes the chunked reply directly
- [x] 2.4 Reassembler tested against the REAL host chunker's output, and the whole reply proven to cross the real native-messaging wire (`host/test/agent-timeline-wire.test.mjs`) ← (verified: a 1.5 MB multi-chunk round trip is byte-identical)

## 3. Panel: the document card

- [x] 3.1 `conversation-model.js` — `document_created` attaches a metadata-only card to the turn that produced it, replay-safe
- [x] 3.2 No `history-store.js` change was needed — `applySnapshot()` already rebuilds a conversation from its persisted event stream, so a reloaded panel gets its cards from the replayed `document_created` events
- [x] 3.3 Card in `sidepanel.js`/`.html`/`.css`: file icon, title, `Tài liệu · <FORMAT> · <size>` subtitle, download control; keyboard-operable, panel design tokens only
- [x] 3.4 `tool-labels.js` — Vietnamese labels for `create_document` and `ask_user`
- [x] 3.5 Download: fetch bytes → `Blob` → `<a download>` object URL, revoked after the click ← (verified: no `downloads` permission added, no network request in the path)
- [x] 3.6 Unit tests for the card item and its replay behaviour — `test/sidepanel-documents.test.mjs`

## 4. Panel: the two-tab detail viewer

- [x] 4.1 Modal shell with title, close, two tabs (Xem trước / Markdown), download, Esc and focus return
- [x] 4.2 md/txt/json/csv/html paths — markdown-lite for md, `<pre>` for txt/json, a built table for csv, sandboxed iframe for html
- [x] 4.3 Untrusted-HTML rule enforced: every converter's HTML goes into `<iframe sandbox>` with neither `allow-scripts` nor `allow-same-origin`; only markdown-lite output enters the panel DOM ← (verified in a real browser: a document containing `<script>alert(1)</script>` renders as escaped text)
- [x] 4.4 Tests for the format→representation routing table

## 5. Viewers for pdf / docx / xlsx / pptx

- [x] 5.1 Vendored `pdfjs-dist` (legacy build + worker) and `fflate`, each loaded by dynamic `import()` only when a document of that format is opened. `docx-preview`, `mammoth`, `exceljs` and `turndown` were REJECTED after measurement (see 5.2); docx/xlsx/pptx are read with fflate plus the panel's own `DOMParser`, and html→markdown with a DOM walk — which also removes ~1.5 MB from the package
- [x] 5.2 Every candidate measured against the MV3 CSP rather than trusted: fflate 0 `eval(` / 0 `new Function(`, turndown 0/0, `pdf.min.mjs` 0/0, `pdf.worker.min.mjs` 0/0, **mammoth 0/7**, **exceljs 0/1**. The two with `new Function` are not vendored, and the reason is recorded rather than the format being dropped
- [x] 5.3 Markdown tab for the binary formats: docx → block extraction → markdown; xlsx → GFM pipe tables per sheet; pptx → per-slide outline; pdf → text layer grouped by baseline, one section per page
- [x] 5.4 Every converter exercised in a REAL Chrome against fixtures produced by task 6's generators (they need `DOMParser`, which Node lacks), through a throwaway localhost harness serving the real extension modules. That run found and fixed four genuine defects: docx toggles read `w:val="false"` as ON, the docx and pdf title printed twice, pptx titles written as anonymous text boxes instead of title placeholders, and `doc.destroy()` — which pdf.js 6 does not have — hanging every PDF. All four now have regression tests

## 6. Host generators for docx / xlsx / pptx / pdf

- [x] 6.1 `docx`, `exceljs`, `pptxgenjs`, `pdf-lib`, `@pdf-lib/fontkit`, `dejavu-fonts-ttf` and `fflate` added to `host/package.json`; `npm-shrinkwrap.json` refreshed; font licensing recorded in `NOTICE`
- [x] 6.2 `host/agent/documents/render/` — markdown → docx, markdown table → xlsx, markdown outline → pptx, markdown → pdf, plus csv and html conversion so a stored file always matches its extension
- [x] 6.3 Tests assert the magic bytes and read the content back out of the containers — `PK` for the OOXML trio, `%PDF-` for pdf, and Vietnamese text surviving into each ← (verified: 17/17, including that a Unicode font is really embedded in the PDF)

## 7. Lifetime, cleanup, and acceptance

- [x] 7.1 Deleting a conversation removes its `documents/` directory with the rest of the conversation tree; a card whose file is gone reports `bytes_missing` and renders as unavailable rather than throwing
- [x] 7.2 Full suites green: every `host/test/agent-*.test.mjs` (30 files), `host` `npm test`, and every `test/sidepanel-*`, `design-tokens-contrast` and `extension-csp-no-inline-scripts` suite. `test/side-panel-group-scope.test.mjs` has 6 failures that pre-date this change (verified against a clean tree)
- [x] 7.3 Operator-run live acceptance — **accepted by the operator on 2026-09-10**, not executed by this session. What WAS executed here: the host generators against real bytes, the chunked reply across the real native-messaging wire, the whole `ProtocolClient → CompanionCore → PanelController` fetch path, and every viewer plus the preview policy in a real Chrome. What was NOT driven by hand is the assembled panel UI itself — the card, the modal and the download button in the live side panel
