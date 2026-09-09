## Context

See `proposal.md` — Why, and `specs/browser-assistant-panel/spec.md` for the behaviour contract.

The constraints that shape the approach, all verified against the tree:

- **The relay is transparent.** `extension/background.js`'s `handleAgentMessage()` observes a few envelope types (`hello_ack`, `version_mismatch`, `error`, `stream_event`, `user_attachment_stored`) and then relays *every* envelope verbatim to each `ocic-agent` port; the panel→native direction (`chrome.runtime.onConnect` handler) forwards any `{type:"agent_msg", envelope}` untouched. There is no per-type allowlist in either direction, so a new message type needs no relay change.
- **The message-type catalogue is append-only and additive.** `host/agent/protocol.js` documents `PROTOCOL_VERSION` as bumped only when "the envelope shape or a message type's required fields change in a way older peers cannot safely ignore". `LIST_CONVERSATIONS`, `DELETE_CONVERSATION`, `ACTION_EVENT` and others were all added without a bump. `CompanionCore.handleEnvelope()`'s `default:` branch answers an unrecognised type with `{type:"error", reason:"unknown_message_type", inReplyTo:<type>}`.
- **There is already a bounded, tool-free, session-free `query()` call in this codebase**: `host/agent/settings/capability-test.js`'s `runSubTest()`. It runs the real SDK with `settingSources: []`, `strictMcpConfig: true`, an explicit `maxTurns`, an isolated `env` (`PATH` + `SystemRoot` on Windows + `ANTHROPIC_BASE_URL` + `ANTHROPIC_API_KEY`), an `AbortController`, and **no `cwd`**. It reads assistant text out of `msg.message.content` text blocks and treats the terminal `result` message as authoritative, with `is_error`/`api_error_status` overriding a `subtype: "success"`.
- **`buildIsolatedOptions()` cannot be reused.** It throws unless given an `mcpServer`, a `serverName`, and a skills session with a `cwd`; it also unconditionally attaches the browser-automation system prompt, the browser tool names, the WebFetch hook, and `disallowedTools`. An enhancement call must have none of that.
- **The request/reply-under-one-type convention already exists**: `agent_settings` uses `{v, type, requestId, op, ...}` → `{v, type, requestId, ok, result|error}`, and `approval_request`/`approval_decision` and `question_request`/`question_answer` correlate by `requestId` through `RequestIdTracker`.
- **The panel's own transport** is `extension/sidepanel/protocol-client.js`, whose `MSG` map is hand-kept in sync with `AGENT_MESSAGE_TYPES` (documented there: "Do NOT add a message type here that protocol.js does not define"). Replies surface through `onEnvelope()`.
- **The composer's control gating** lives in `sidepanel.js`'s `updateSendEnabled()` / `updateSendStopButton()`, driven by `panel.currentPhase()` (`RUN_PHASE`), `panel.currentConversationId`, and the trimmed textarea value. `extension/ui/icons.js` already exports a `spark` icon.
- **Reference implementation**: `spec-ade` (`spec-ade-api/src/ai/enhance.rs`, `src/stores/enhance-prompt-store.ts`) — the `<enhanced-prompt>` envelope, the "preserve the original language" rule, and the graceful-degradation parser are ported from there. Its SSE streaming and its settings-driven provider selection are not.

## Goals / Non-Goals

**Goals:**

- One additive wire message that reuses the existing `requestId` request/reply convention, so an older companion degrades to an explicit, diagnosable state rather than a hang.
- A companion-side handler that is provably not a run: it touches neither `sessionManager` nor `lease`, and constructs its options from scratch rather than from the run builder.
- Cancellation that actually aborts the underlying model call, not just the UI.
- A text replacement whose undo is the browser's own undo stack.

**Non-Goals:**

- Streaming the rewritten prompt token-by-token into the composer. The reply is a single envelope carrying the final text. Rationale under Decisions.
- Any operator-configurable rewrite template, separate enhancement provider/model selection, or an enhancement-specific settings surface.
- Reusing the enhancement path for anything else (commit messages, titles, summaries).

## Decisions

### 1. One new message type, `enhance_prompt`, request and reply under the same name

`AGENT_MESSAGE_TYPES.ENHANCE_PROMPT = "enhance_prompt"`, appended to the catalogue in `host/agent/protocol.js` and mirrored into `MSG` in `protocol-client.js`.

Wire shape:

```
panel → companion  { v, type:"enhance_prompt", requestId, op:"generate", prompt, profileId, modelId, ts }
panel → companion  { v, type:"enhance_prompt", requestId, op:"cancel", ts }
companion → panel  { v, type:"enhance_prompt", requestId, ok:true,  result:{ text }, ts }
companion → panel  { v, type:"enhance_prompt", requestId, ok:false, error:{ code, message }, ts }
```

`modelId` is the panel's currently selected model (the same value START already carries) so the rewrite uses the model the operator picked; `profileId` comes from the same source `panel-controller.js`'s `sendMessage()` uses (`this.profile.profileId`).

*Alternatives considered.* (a) Two type names (`enhance_prompt_request` / `enhance_prompt_result`) — rejected: every existing pair in this protocol that is a *reply to my own request* reuses one name (`agent_settings`, `list_conversations`, `delete_conversation`); two names is the convention for a *peer-initiated push* (`approval_request`/`approval_decision`). (b) Riding on `agent_settings` with a new `op` — rejected: `agent_settings` is deliberately not gated on `hello` because settings work with no session; enhancement needs a resolved profile and should be gated, and overloading it would blur that.

**No `PROTOCOL_VERSION` bump.** Old companion → `unknown_message_type` error with `inReplyTo:"enhance_prompt"`; the panel maps that to the "companion needs updating" state the spec requires. Old panel + new companion is a non-event.

### 2. Gate on `hello`; do not gate on the lease or a conversation

`_handleEnhancePrompt()` starts with `_requireHello()` (like `NEW`/`START`/`STOP`) because it needs a negotiated version and a resolved profile. It deliberately does **not** call `sessionManager` or `lease` at all — that absence is what makes "enhancement is not a run" checkable by reading the handler, not merely asserted.

### 3. A dedicated `host/agent/enhance-prompt.js`, not an addition to `query-options.js`

New module owning three pure pieces plus one options builder:

- `ENHANCE_TEMPLATE` — the rewrite instruction, ported from `spec-ade`'s `DEFAULT_ENHANCE_TEMPLATE`: rewrite for clarity/specificity, preserve the operator's original language, do not execute or answer the prompt, output only the rewritten text wrapped in `<enhanced-prompt>…</enhanced-prompt>`, no preamble and no code fences.
- `buildEnhancePrompt(text)` — renders the template with the operator's text embedded inside an explicit `<user-prompt>…</user-prompt>` delimiter. Everything goes into **one user message**; no `systemPrompt` option is used. Rationale: `capability-test.js` proves the no-`systemPrompt` shape against real gateways, and a single frame keeps the "the composer text is the only input" claim trivially auditable.
- `parseEnhanced(raw)` — ported from `spec-ade`'s `parseEnhanced`: full envelope → inner text with bracketing newlines stripped; open tag only → everything after it; no tag → the whole buffer trimmed. Degrading gracefully rather than failing is deliberate: a model that omits the wrapper still produced a usable rewrite.
- `buildEnhanceOptions({ snapshot, abortController })` — modelled directly on `runSubTest()`'s options: `{ abortController, model: snapshot.model, mcpServers: {}, strictMcpConfig: true, settingSources: [], tools: [], maxTurns: 1, env }` where `env` is the same `PATH` / `SystemRoot` / `ANTHROPIC_BASE_URL` / `ANTHROPIC_API_KEY` isolation. No `cwd`, no `skills`, no `hooks`, no `canUseTool`, no `permissionMode`.

*Alternative considered.* Extending `buildIsolatedOptions()` with an "enhance mode" flag — rejected: it would add a branch that disables most of what that function exists to assemble, and every existing caller and test would inherit the risk. A separate builder keeps the run path byte-identical.

*Why a separate module rather than inlining in `companion.js`:* `companion.js` is already 1505 lines; the template and parser are pure functions that must be unit-testable without a companion, a transport, or an SDK.

### 4. Result extraction mirrors `capability-test.js`'s classification

Accumulate `text` from `assistant` messages' `text` blocks; on the terminal `result` message, treat `is_error` or a numeric `api_error_status` as failure regardless of `subtype`, and `subtype === "success"` as success. Generator ending with no terminal message is a failure, not an empty success. Errors are reported with a code the panel can distinguish; the profile-resolution failure path (`ProfileUnavailableError` from `resolveProfileSnapshot`) is reported as its own code so the spec's "no configured provider" scenario has a distinct message.

An empty or whitespace-only rewrite is a failure, not a success — the panel must never replace a draft with nothing.

### 5. Cancellation via a per-`requestId` `AbortController` map on the companion

`op:"cancel"` looks up the in-flight controller by `requestId` and aborts it; the generator's `AbortError` resolves the request as `{ok:false, error:{code:"CANCELLED"}}`. Unknown `requestId` on cancel is a no-op reply, not an error — a cancel racing a completion is normal.

A plain `Map<requestId, AbortController>` is used rather than `RequestIdTracker`: that class exists to park a *promise* the wire later resolves (approvals, questions), which is the inverse direction from this one.

### 6. Panel: single in-flight request, snapshot-and-restore, native undo

`sidepanel.js` holds one enhancement state (`{requestId, originalText}` or null) — one composer, one draft, so a second concurrent request has no meaning.

- On activate: snapshot `el.composerInput.value`, generate a `requestId`, set `readOnly = true` and `aria-busy="true"`, swap the control to its Cancel presentation, send `op:"generate"`.
- On `ok:true`: clear read-only, then commit the text via `focus()` → `select()` → `document.execCommand("insertText", false, text)` so the replacement lands on the browser's undo stack and Ctrl+Z restores the draft (this is exactly what `spec-ade` does, and it is why no Revert button is added).
- On `ok:false`, on cancel, on `unknown_message_type` with `inReplyTo:"enhance_prompt"`, and on `ProtocolClient.onDisconnect`: restore the snapshot, clear read-only, clear state, and surface the reason through the panel's existing error-presentation path.
- Any reply whose `requestId` does not match the current state is dropped.

`readOnly` (not `disabled`) is used so the text stays selectable and the field keeps focus; the run-in-progress path keeps using `disabled` exactly as today.

Gating is added inside `updateSendEnabled()` rather than in a parallel function, so the enhancement control can never disagree with Send about run phase or conversation readiness. The one extra term is the leading-`/` test: `parseSlashQuery` in `skills-model.js` only matches a picker token, so the check here is the trimmed text starting with `/` — a slash command's literal text is what the companion dispatches on, and rewriting it would change which skill runs.

### 7. Not streaming

`stream_event` is `runId`-scoped and flows through `conversation-model.js`'s transcript machinery; streaming an enhancement would either need a fake run (contradicting decision 2) or a second streaming channel. A conscious trade-off: enhancement shows a busy control for a few seconds instead of live text. The wire shape leaves room — a future `op` could stream without changing the type — and nothing about the single-reply shape has to be undone to get there.

## Risks / Trade-offs

- **Prompt injection from the draft itself** (a draft containing text that tries to redirect the rewriter) → The template states the rewriter must not execute or answer the prompt, and the draft is wrapped in an explicit `<user-prompt>` delimiter. The call has zero tools, zero MCP servers, zero skills, `maxTurns: 1`, and no browser lease, so the worst outcome is a poor rewrite the operator can undo — never an action.
- **No perceived progress on a slow provider** → The control shows a busy state and is immediately cancellable; `maxTurns: 1` bounds the call.
- **Model returns no wrapper, or commentary around it** → `parseEnhanced` degrades to the trimmed buffer; an empty result is classified as failure so the draft is never silently destroyed.
- **`protocol.js` and `protocol-client.js` drift** (the mirroring is by hand, as that file's header states) → The protocol-client test asserts the exact literal, and the companion test drives the real `CompanionCore` with the panel client's envelope.
- **Panel is left read-only if a reply never arrives** (host killed without a port disconnect) → `ProtocolClient.onDisconnect` covers the normal loss path; the manual escape is that the control stays enabled as Cancel throughout.
- **A future protocol change makes the no-bump decision wrong** → Only if `enhance_prompt`'s own required fields change; the append-only rule in `protocol.js` still governs.

## Migration Plan

No data migration, no persisted state, no settings schema change. The message type is additive and unversioned-bump; a panel newer than the companion degrades to the "companion needs updating" notice, and a companion newer than the panel simply never receives the message. Rollback is removing the control and the handler; nothing on disk needs cleaning up.
