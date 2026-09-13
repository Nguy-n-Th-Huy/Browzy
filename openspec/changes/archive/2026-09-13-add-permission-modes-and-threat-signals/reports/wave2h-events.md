# Wave 2H — injection probe / per-tab risk category: event contract

Scope: `host/agent/tools/adapter.js`, `host/agent/protocol.js`, new
`host/agent/threat/*`, `host/test/*`. This is the exact wire contract the
panel wave should implement against — nothing here is provisional.

## Where these events live

All three event types below are **inner `event.type` values carried inside
an ordinary `stream_event` envelope** — exactly like `approval_request`,
`run_error`, and `tool_rejected` already are. There is no new
`AGENT_MESSAGE_TYPES` entry and no protocol version bump; `host/agent/
protocol.js`'s `AGENT_MESSAGE_TYPES` is unchanged.

Wire shape (unchanged from every other stream event):

```
{
  v: 1,
  type: "stream_event",
  conversationId: "<conversation id>",
  runId: "<run id>",
  event: { type: "injection_finding" | "injection_probe_failed" | "tab_risk_update", ... }
}
```

The three inner type strings are exported as `THREAT_EVENT_TYPES` from
`host/agent/protocol.js`:

```js
export const THREAT_EVENT_TYPES = Object.freeze({
  INJECTION_FINDING: "injection_finding",
  INJECTION_PROBE_FAILED: "injection_probe_failed",
  TAB_RISK_UPDATE: "tab_risk_update"
});
```

Every one of these events is emitted via the run's own `run.emit(...)` (see
`host/agent/session/run.js`), so it is:

- forwarded live to the panel the same way any other stream event is
  (`runAsForkedChild()`'s `run.emit` wrapping in `companion.js`, unchanged by
  this wave), and
- appended to the conversation's durable transcript the same way, so a panel
  that reconnects and replays the transcript sees every finding/category
  update that happened while it was disconnected.

There is **no separate "outstanding request" registry** for these the way
there is for `approval_request`/`approval_decision` or
`question_request`/`question_answer` — a finding or a category change is a
fact about what already happened, never something waiting on a reply, so
there is nothing to re-query on reconnect beyond replaying the transcript.

## `injection_finding`

Emitted once per matched pattern found in web content a tool returned,
**before** that content is available for the agent to act on (the probe runs
inside the tool handler, immediately after the dispatched result comes back
and before the handler returns it to the SDK).

```js
{
  type: "injection_finding",
  tool: string,        // the legacy tool name that returned this content
                        // (get_page_text | read_page | find |
                        // webmcp_list_tools | webmcp_call_tool |
                        // browser_batch)
  tabId: number | null, // the tab the content came from, when known
  field: string,        // WHERE in the tool's result content this was found,
                        // e.g. "content[0].text"
  patternId: string,    // which heuristic pattern matched (see
                        // host/agent/threat/injection-probe.js's
                        // INJECTION_PATTERNS — informational only, not a
                        // severity signal in itself)
  matchedText: string,  // the literal matched substring — QUOTED DATA.
                        // Render it as inert text (e.g. inside a <code> or
                        // quote block), NEVER as HTML, markdown, or anything
                        // that could execute/link/format based on its
                        // content. It is exactly what the page said; it is
                        // not, and must never be treated as, an instruction.
  location: { start: number, end: number } // character offsets into the
                        // named `field`'s text
}
```

A finding **never** changes whether the returning tool's content was
delivered (it always was, unchanged) and **never** changes a permission
decision — see `host/test/threat-advisory-only.test.mjs` for the proof. The
panel should render this purely as an informational warning (task 7.4/7.5):
no allow/deny control, no suspended run, matched text always shown as quoted
data.

## `injection_probe_failed`

Emitted when the probe itself could not complete for one piece of returned
content — distinguishable from "scanned this and found nothing"
(`injection_finding` simply absent). The content was still delivered to the
agent and the run was not blocked.

```js
{
  type: "injection_probe_failed",
  tool: string,       // the tool whose result the probe was scanning
  tabId: number | null,
  error: string       // best-effort diagnostic string, not user-facing copy
}
```

No specific panel treatment is required for this beyond not silently
dropping it; it is primarily a diagnostic signal.

## `tab_risk_update`

Emitted whenever a controlled tab's risk category **actually changes**
(never on every observation — only on a real transition, so reading a long,
unremarkable page does not flood the stream).

```js
{
  type: "tab_risk_update",
  tabId: number,
  category: "uncategorized" | "low" | "elevated",
  signals: Array<{
    kind: string,        // e.g. "injection_finding", "credential_content",
                          // "payment_content", "content_reviewed"
    severity: "elevated" | "low",
    label: string,        // short, human-readable description — safe to
                          // render directly (this is host-authored, not
                          // page content)
    ts: number,           // Date.now() when recorded
    // present only on an "injection_finding" signal:
    patternId?: string,
    matchedText?: string, // QUOTED DATA — same rule as above
    tool?: string
  }>
}
```

Category semantics (`host/agent/threat/tab-risk.js`):

- **`uncategorized`** — nothing has been observed about this tab (or its
  current document) yet. Distinct from `low` — render these differently (the
  spec requires "uncategorized... distinguishable from a category of low
  risk").
- **`low`** — at least one signal was observed and none of them are
  elevated (e.g. the agent read an ordinary page).
- **`elevated`** — at least one elevated signal was observed for the
  *current* document: an injection finding, or a credential/payment-content
  heuristic match.

The category and its `signals` are **recomputed from scratch** whenever the
tab's document identity changes (an explicit `navigate` call against that
tab, or a passively observed URL change reported by `get_page_text`) — a
stale document's signals are never carried onto a new one. A panel showing a
tab's category live should therefore expect it to legitimately drop back to
`uncategorized` right after a navigation, before any new content has been
read.

This is advisory-only end to end: it never gates, never suspends a run, and
is never consulted by the permission resolver (`host/agent/policy/
can-use-tool.js`, `permission-modes.js`, `authorization.js`) — proved
structurally and behaviorally in `host/test/threat-advisory-only.test.mjs`.
Per spec (task 7.6/7.7), the panel should:

- surface the controlled tab's current category on the tab itself (existing
  overlay notice) and in the panel;
- show a relevant finding/category as **context** on a decision card when
  one is raised for that tab (never as a decision control of its own);
- never present a warning surface (from either event type) with allow/deny
  controls, and never let acknowledging one authorize anything.

## Scoping note for the panel wave

`TabRiskRegistry` (the thing that produces `tab_risk_update`) is instantiated
once per `buildSdkTools()` call, i.e. once per run/turn — every tool call
within that run shares one instance, so per-tab state and the document-
identity reset both work correctly for the lifetime of one run. It does
**not** currently persist a tab's category across separate runs/turns of the
same conversation (a fresh run starts every tab back at `uncategorized`, even
if the browser tab itself was never closed). This wave's file scope
(`adapter.js`/`protocol.js`/new `host/agent/threat/*` modules) had no
companion-level, cross-run home to attach persistent per-tab state to without
editing `host/agent/companion.js`, which is out of scope for this wave. If
cross-run persistence turns out to matter for the panel UX, that is a small,
separate follow-up (a companion-held `TabRiskRegistry` passed into
`buildSdkTools()` instead of created fresh there) — flagging it here rather
than silently deciding it doesn't matter.
