# Design: Non-JSON Success Body Preview

## Context

- **The blind spot, found live.** `postJson` (host/agent/jev/client.js) parses a 2xx body with `response.json()`; on failure it throws `INVALID_RESPONSE` with "the provider answered HTTP 200 with a body that is not JSON; no action executed." and `detail: { status }` only. The non-2xx path, by contrast, reads the body best-effort and already carries `detail: { status, providerMessage?, body: <first 500 chars> }`. A live case — a gateway answering an unknown route with its SPA HTML — was diagnosable only by probing the endpoint; the failure itself said nothing about content type or content.
- **The shared client** serves runs, the capability test, and the text-model calls, so one change reaches every Jev wire.
- **See proposal.md** for motivation; delta: `typesafe-jev-provider` ("Single-request decision protocol with strict validation").

## Goals / Non-Goals

**Goals:**
- A non-JSON 2xx body reports its content type and a bounded preview of the body's beginning (or that the body is empty), in the message and the structured detail, keeping the `INVALID_RESPONSE` classification.

**Non-Goals:**
- No change to classification, retry policy, timeouts, the non-2xx path, or any caller; no debug/trace mode; no unbounded body capture.

## Decisions

### 1. Read the body once, bound the preview, name the type

`postJson` reads the success body as text once, then parses it; on a parse failure it throws the same `INVALID_RESPONSE` with:

- message: `the provider answered HTTP ${status} with a body that is not JSON (content-type ${contentType||"unknown"}; body starts: ${JSON.stringify(preview)}); no action executed.` — or `…; the body is empty; …` when the raw text is empty/whitespace-only;
- detail: `{ status, ...(contentType ? { contentType } : {}), ...(preview ? { bodyPreview: preview } : {}), ...(raw === "" ? { emptyBody: true } : {}) }`.

`preview` = the raw text with whitespace runs collapsed to single spaces, trimmed, capped at 120 characters (with a trailing `…` when cut). The read stays bounded by the response the caller already received — no streaming, no re-fetch; a body that cannot be read at all keeps today's message plus `{ status, bodyUnreadable: true }`.

- *Alternatives rejected*: keep the bare message (the live pain); include the full body (unbounded — the non-2xx path's 500-char detail is the precedent for a bounded slice); content type alone (a 20-character snippet of `<!doctype html>` makes the SPA case instant).

### 2. Tests carry the contract

`host/test/jev-client.test.mjs`: an HTML 200 body yields a message containing the content type and the collapsed preview (capped, `…` on overflow) and a matching detail; a JSON-parseable body is unchanged; an empty 200 body says so; an unreadable body keeps the classification. Any other suite asserting the old message text updates to the new shape (assert on substrings, not the full sentence).

## Risks / Trade-offs

- **[Error text now carries provider bytes]** → bounded to 120 collapsed characters; it is the operator's own endpoint answering; the non-2xx path already carries a 500-char slice. No credentials of ours are ever in a response body.
- **[Reading text then parsing vs `response.json()`]** → equivalent for JSON payloads: a leading BOM is stripped by both paths (UTF-8 decoding), and trailing whitespace behaves the same — verified against the host runtime, not just assumed.
