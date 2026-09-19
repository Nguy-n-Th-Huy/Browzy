# Tasks: add-nonjson-body-preview

## 1. Client failure detail

- [x] 1.1 `host/agent/jev/client.js`: `postJson` reads the success body once as text and parses it; a non-JSON 2xx throws the same `INVALID_RESPONSE` with the content type and a bounded, whitespace-collapsed preview (≤ 120 chars, `…` when cut) in the message and `{ status, contentType?, bodyPreview?, emptyBody? }` in the detail; an empty body and an unreadable body each say so; classification, retry policy, and every other path unchanged
- [x] 1.2 Update `host/test/jev-client.test.mjs` (and any other suite asserting the old message, using substrings) for: HTML body → content type + preview in message and detail; parseable JSON unchanged; empty body stated; unreadable body keeps classification ← (verify: preview is capped and whitespace-collapsed; nothing else in the client's behavior changed)

## 2. Focused suites and validation

- [x] 2.1 `cd host && node --test test/jev-client.test.mjs test/jev-capability.test.mjs test/jev-text-helper.test.mjs test/jev-runtime.test.mjs` green; `openspec validate add-nonjson-body-preview --strict` valid ← (verify: green; only in-scope files edited)
