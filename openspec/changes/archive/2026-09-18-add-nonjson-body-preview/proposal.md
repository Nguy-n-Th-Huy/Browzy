# Proposal: Non-JSON Success Body Preview

## Why

Diagnosed live: a Jev endpoint answered HTTP 200 with an HTML page (a misrouted request falling through to a gateway's SPA), and the failure read only "HTTP 200 with a body that is not JSON" — accurate, but blind. The cause was one `curl` away instead of visible from the failure itself. The same blind spot applies to every Jev call that shares the HTTP client (runs, the capability test, text-model calls).

## What Changes

- A 2xx response body that cannot be parsed as JSON SHALL be reported with the response's **content type** and a **bounded preview of the body's beginning** (whitespace-collapsed, capped; an empty body is stated as empty), in both the failure message and its structured detail — so "an HTML page served in place of the endpoint" is obvious without probing.
- Classification, retry policy, and every other failure path are unchanged; the non-2xx path already surfaces the provider's own message (with a bounded body in its detail) and stays as it is.

## Capabilities

### New Capabilities
- (none — the change extends an existing capability)

### Modified Capabilities
- `typesafe-jev-provider`: the decision-protocol requirement's failure-attribution sentence extends to a non-JSON success body, which is reported with its content type and a bounded body preview, under the same invalid-response classification.

## Impact

- **Host**: `host/agent/jev/client.js` (the shared `postJson`: read the body once as text, parse; on failure include content type + bounded preview in the message and detail) and `host/test/jev-client.test.mjs` (plus any suite asserting the old message text).
- **Docs/specs**: the one capability delta above.
