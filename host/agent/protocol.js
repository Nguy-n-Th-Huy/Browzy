// Versioned agent protocol shared by the native host, the companion child
// process, and (eventually) extension/background.js.
//
// Why a version handshake exists at all: the companion, the extension and the
// native host are updated independently (extension auto-updates, companion
// ships with the host installer, background.js can be mid-reload while a
// panel is open). A silent shape mismatch between them would show up as a
// confusing runtime error deep in message handling. Failing closed on an
// unrecognized version turns that into one explicit, diagnosable state.
//
// Design authority: openspec/changes/migrate-to-claude-agent-sdk/design.md
// decision 1 ("Protocol covers hello/version, start/resume, stop, permission
// decision, settings mutation/test, model discovery, recorder events, and
// sequenced stream events. Unknown versions fail closed.").

// Bump when the envelope shape or a message type's required fields change in
// a way older peers cannot safely ignore. Keep this list append-only; never
// remove a version another shipped build might still send.
export const PROTOCOL_VERSION = 1;
export const SUPPORTED_PROTOCOL_VERSIONS = Object.freeze([1]);

export function isSupportedVersion(v) {
  return SUPPORTED_PROTOCOL_VERSIONS.includes(v);
}

// --- Envelope message types -------------------------------------------
//
// "hello"/"hello_ack"/"version_mismatch" are the only messages a peer may
// send before a version has been agreed. Everything else assumes the
// handshake already succeeded.
export const AGENT_MESSAGE_TYPES = Object.freeze({
  HELLO: "hello",
  HELLO_ACK: "hello_ack",
  VERSION_MISMATCH: "version_mismatch",

  START: "start",
  RESUME: "resume",
  NEW: "new",
  STOP: "stop",

  APPROVAL_REQUEST: "approval_request",
  APPROVAL_DECISION: "approval_decision",

  // Task 9.4/9.5 (design.md section 8): application-owned ask-the-user tool
  // — a symmetric wire pair to approval_request/approval_decision. Carries
  // a `requestId` correlating the companion-pushed request and the panel's
  // answer exactly; an unknown or mismatched `requestId` is rejected.
  QUESTION_REQUEST: "question_request",
  QUESTION_ANSWER: "question_answer",

  SNAPSHOT_REQUEST: "snapshot_request",
  SNAPSHOT: "snapshot",
  STREAM_EVENT: "stream_event",
  TOKEN_BATCH: "token_batch",

  // Conversation management (task: close reports/05-panel-evidence.md's
  // "Known gaps" #1 — "No LIST_CONVERSATIONS/DELETE_CONVERSATION message
  // type"). Same request/reply-reuses-one-type convention as START/STOP
  // above (the reply carries the result fields inline rather than inventing
  // a second type name per direction), and gated behind a completed hello
  // exactly like NEW/RESUME/START/STOP/SNAPSHOT_REQUEST — see
  // CompanionCore._requireHello() in companion.js.
  LIST_CONVERSATIONS: "list_conversations",
  DELETE_CONVERSATION: "delete_conversation",

  // Presentation metadata write (openspec/changes/optimize-chat-history
  // tasks.md 1.1): the panel pushes the title it derived from the user's
  // first message and the hostname of the page a run was bound to, so the
  // host summary — not the panel's local index — is the canonical record
  // every panel lists and reconciles against. `revision`/`ifRevision` give
  // two panels editing the same conversation a conflict instead of a silent
  // last-write-wins clobber (design.md "Cross-panel races"). Same
  // request/reply-reuses-one-type convention as LIST_CONVERSATIONS above.
  // Wire shape:
  //   panel -> companion  {v, type:"update_conversation", conversationId,
  //                         title?, hostname?, pinned?, archived?,
  //                         ifRevision?}
  //   companion -> panel  {v, type:"update_conversation", conversationId,
  //                         ok:true, revision, meta}
  //   companion -> panel  {v, type:"update_conversation", conversationId,
  //                         ok:false, reason}
  UPDATE_CONVERSATION: "update_conversation",

  // Delete-all (tasks.md 1.3): "clear all locally cached history" against
  // the HOST, not just this browser profile. Reply reports the per-
  // conversation outcome so a partial sweep can never be presented as
  // success. Carries an idempotency key exactly like DELETE_CONVERSATION.
  DELETE_ALL_CONVERSATIONS: "delete_all_conversations",

  // Transcript paging (tasks.md 3.2 / design.md decision 3): one OLDER page
  // of a conversation's durable event log, selected by sequence range. A
  // snapshot reply carries the newest bounded window plus `hasOlder`; this
  // request asks for the page below `beforeSeq` so a reopening panel can
  // lazily load history without ever treating the window as the whole log.
  //   panel -> companion  {v, type:"transcript_window_request", conversationId,
  //                         beforeSeq, limit}
  //   companion -> panel  {v, type:"transcript_window", conversationId,
  //                         events, firstSeq, lastSeq, hasOlder, limit}
  TRANSCRIPT_WINDOW_REQUEST: "transcript_window_request",
  TRANSCRIPT_WINDOW: "transcript_window",

  // Settings relay (task: close reports/05-panel-evidence.md's "Known gaps"
  // #2 — "agent_settings has a client-and-relay contract but no
  // companion-side handler yet"). extension/settings/settings-client.js and
  // extension/background.js's createAgentSettingsRelay() already speak this
  // exact envelope shape (`{v, type:"agent_settings", requestId, op, ...}`
  // -> `{v, type:"agent_settings", requestId, ok, result|error}`); this
  // constant is added to the catalogue for the same reason every other
  // message type is here (isKnownMessageType(), documentation, no second
  // ad-hoc string elsewhere) even though the relay already sends the literal
  // string. Deliberately NOT gated on hello in companion.js — see
  // CompanionCore._handleAgentSettings()'s own comment for why (the settings
  // page has no conversation/session of its own; "Settings operations must
  // work with no active conversation").
  AGENT_SETTINGS: "agent_settings",

  CHUNK_BEGIN: "chunk_begin",
  CHUNK_PART: "chunk_part",
  CHUNK_END: "chunk_end",

  // Host-side action timeline (design.md decision 5c / task 5.10's host
  // half; see reports/05-action-event-schema.md, whose "What Batch 3 needs"
  // section names this exact message type). extension/events/action-events.js
  // builds one well-formed schema event per real dispatched action; this is
  // the wire envelope that carries a BATCH of those (never one native
  // message per event — "Batch token/event updates so streaming does not
  // flood native messaging" is this task's own non-negotiable) from the
  // extension into this companion's per-conversation transcript. Gated
  // behind hello like LIST_CONVERSATIONS/DELETE_CONVERSATION — a
  // conversation-scoped fact, not a bridge-level one (contrast
  // RECORDING_COMPLETE/AGENT_SETTINGS above). See companion.js's
  // _handleActionEvent() for the sanitize-then-append pipeline and
  // storage/action-timeline.js for why the wire's own redaction claim is
  // never trusted blindly.
  ACTION_EVENT: "action_event",

  // Screenshot-artifact retrieval for the timeline's preview thumbnails
  // (spec.md "Truthful action timeline and screenshot previews": "preview
  // displays that historical image rather than a fresh capture"). Request
  // carries {conversationId, artifactId}; the reply is EITHER one small
  // ACTION_ARTIFACT envelope with found:false (artifact never stored, or
  // deleted — an explicit "unavailable" state, never a substitute image) OR
  // the found artifact's bytes re-chunked through the SAME
  // broker/chunked-transport.js sequence used for ingestion, in wire-arrival
  // order (chunk_begin, chunk_part..., chunk_end) — see companion.js's
  // _handleActionArtifactRequest()'s `{ multi: [...] }` reply shape and
  // runAsForkedChild()'s handling of it. This message is never used to
  // trigger a fresh capture of the current page — reading is the ONLY
  // effect it has.
  ACTION_ARTIFACT_REQUEST: "action_artifact_request",
  ACTION_ARTIFACT: "action_artifact",

  // Document retrieval for the panel's document card (a file produced by the
  // `create_document` tool). Request carries {conversationId, documentId};
  // the reply mirrors ACTION_ARTIFACT_REQUEST exactly — EITHER one small
  // DOCUMENT envelope with found:false (never written, or its bytes are gone
  // — the "unavailable" state the card must show, never a substitute file)
  // OR the document's bytes chunked through broker/chunked-transport.js in
  // wire-arrival order. Reading is the only effect: this message never
  // creates, edits, or deletes a document.
  DOCUMENT_REQUEST: "document_request",
  DOCUMENT: "document",

  // The list of documents a conversation already holds, so a panel that
  // reloaded (or opened an older conversation) can rebuild its cards without
  // replaying the whole event stream. Request carries {conversationId}; the
  // reply carries metadata records only, never bytes.
  DOCUMENT_LIST_REQUEST: "document_list_request",
  DOCUMENT_LIST: "document_list",

  // Ack for one completed CHUNK_BEGIN/CHUNK_PART*/CHUNK_END sequence whose
  // announced purpose (its chunk_begin's `kind` field) was
  // "action_artifact" — i.e. a screenshot capture's actual bytes finishing
  // upload from the extension. Tells the sender whether the bytes were
  // actually persisted (a real disk write against a KNOWN conversation) or
  // rejected (unknown conversation, missing ids) — never silently dropped
  // with no signal either way.
  ACTION_ARTIFACT_STORED: "action_artifact_stored",

  // Ack for one completed CHUNK_BEGIN/CHUNK_PART*/CHUNK_END sequence whose
  // chunk_begin `kind` was CHUNK_KINDS.USER_ATTACHMENT — i.e. a user-composer
  // image attachment's bytes finishing upload from the panel. Same explicit
  // stored/not-stored contract as ACTION_ARTIFACT_STORED above: the panel may
  // only consider that attachment part of the sent message once it receives
  // `stored:true` (with this attachment's chunkId echoed so a panel ingesting
  // several attachments concurrently can correlate acks). A `stored:false`
  // ack, or a chunk_rejected error, must keep that attachment out of the
  // message rather than silently proceeding as text-only while implying the
  // image was included.
  USER_ATTACHMENT_STORED: "user_attachment_stored",

  // Recorder events (task 6.3, design.md decision 1: "Protocol covers
  // hello/version, ... recorder events, and sequenced stream events."). This
  // is the ONE envelope native-host.js pushes to the companion when the
  // extension's narrated recorder finishes a bundle — see
  // native-host.js's routeFromExtension() and companion.js's
  // _handleRecordingComplete(). Independent of the hello/session handshake:
  // a recording is a fact about the browser bridge, not about any one
  // conversation, so it must still be handleable "without requiring a
  // Claude Code channel" (spec) even before any panel has ever said hello —
  // but its protocol version is still validated and fails closed exactly
  // like every other envelope.
  RECORDING_COMPLETE: "recording_complete",

  // Durable half of the download-pause protected decision
  // (add-permission-modes-and-threat-signals task 2.4). background.js's
  // chrome.downloads.onCreated gate and the panel's reply to it are
  // DELIBERATELY LOCAL-only — chrome.downloads.DownloadItem carries no
  // tabId, so there is nothing for can-use-tool.js's per-call approval-token
  // binding to verify, and the whole exchange (background.js's
  // download_protected_decision / the panel's download_decision reply) never
  // reaches this protocol or the companion at all. Its OUTCOME still must
  // not be invisible to the durable conversation record the way every other
  // protected decision's outcome (a real tool_result/tool_rejected) already
  // is: this message is background.js's fire-and-forget report of what was
  // decided, sent AFTER it already resumed/cancelled the download locally
  // (this message's own success or failure changes nothing about that
  // outcome). Not gated on hello — same "conversation-scoped fact reported
  // outside the strict start/resume flow" class as ACTION_EVENT above, since
  // the conversationId is already known and carried explicitly, never
  // inferred. Wire shape:
  //   extension -> companion  {v, type:"download_decision_recorded",
  //                             conversationId, requestId,
  //                             decision:"allow"|"deny", category, filename,
  //                             url}
  //   companion -> extension  {v, type:"download_decision_recorded",
  //                             conversationId, requestId, recorded:true}
  DOWNLOAD_DECISION_RECORDED: "download_decision_recorded",

  // Composer prompt enhancement (openspec/changes/add-composer-enhance-prompt).
  // One additive request/reply pair reusing a single type name, exactly the
  // convention AGENT_SETTINGS/LIST_CONVERSATIONS/DELETE_CONVERSATION above
  // already establish for "a reply to my own request" (contrast
  // APPROVAL_REQUEST/APPROVAL_DECISION, a peer-initiated push, which needs two
  // names). Wire shape (design.md decision 1):
  //   panel -> companion  {v, type:"enhance_prompt", requestId, op:"generate",
  //                         prompt, profileId, modelId, ts}
  //   panel -> companion  {v, type:"enhance_prompt", requestId, op:"cancel", ts}
  //   companion -> panel  {v, type:"enhance_prompt", requestId, ok:true,
  //                         result:{text}, ts}
  //   companion -> panel  {v, type:"enhance_prompt", requestId, ok:false,
  //                         error:{code, message}, ts}
  // Gated behind hello (see companion.js's _handleEnhancePrompt() ->
  // _requireHello()): unlike AGENT_SETTINGS, this needs a resolved profile and
  // a negotiated version, so it is a session-scoped message like
  // NEW/START/STOP/LIST_CONVERSATIONS, not a bridge-level one.
  // Deliberately additive with NO PROTOCOL_VERSION bump, same rule the
  // LIST_CONVERSATIONS/DELETE_CONVERSATION/ACTION_EVENT entries above follow:
  // an older companion that has never heard of this type answers through the
  // existing default: branch in handleEnvelope() with
  // {type:"error", reason:"unknown_message_type", inReplyTo:"enhance_prompt"},
  // which the panel maps to an explicit "companion needs updating" state
  // rather than hanging or failing silently.
  ENHANCE_PROMPT: "enhance_prompt",

  // User-mediated upload grants (the side panel's native file picker → the
  // conversation's upload allowlist). One additive request/reply pair reusing
  // a single type name, the same convention ENHANCE_PROMPT/AGENT_SETTINGS
  // above follow. Wire shape:
  //   panel -> companion  {v, type:"upload_grant", requestId, conversationId,
  //                         op:"grant"|"revoke", paths:[absolute,...], ts}
  //   companion -> panel  {v, type:"upload_grant", requestId, conversationId,
  //                         ok:true, result:{granted:[...],
  //                         skipped:[{path, reason}], revoked:[...]}, ts}
  //   companion -> panel  {v, type:"upload_grant", requestId, ok:false,
  //                         error:{code, message}, ts}
  // The paths are ABSOLUTE filesystem paths the OPERATOR selected in a native
  // file dialog (host/pick-files.js) — never anything the model wrote. This
  // is the only thing that ever populates a run's RunUploadAllowlist
  // (host/agent/policy/authorization.js), and it confers exactly one
  // capability: attaching those files to a page's file input via
  // file_upload. Grants are conversation-scoped and applied to every run of
  // that conversation until revoked, the conversation is deleted, or the
  // companion restarts (in-memory only, honestly: nothing here is persisted).
  // Deliberately additive with NO PROTOCOL_VERSION bump: an older companion
  // answers through handleEnvelope()'s default branch with
  // {type:"error", reason:"unknown_message_type", inReplyTo:"upload_grant"},
  // which the panel surfaces as "companion needs updating" rather than
  // hanging.
  UPLOAD_GRANT: "upload_grant",

  // Recording attachment claim (upgrade-agent-reliability-and-workflows
  // tasks.md 6.1/6.3): the panel selects one IDLE conversation for one
  // finished recording and sends an idempotency key. Same additive,
  // no-version-bump convention as ENHANCE_PROMPT above: an older companion
  // answers unknown_message_type rather than hanging. Wire shape:
  //   panel -> companion  {v, type:"recording_attach", requestId,
  //                         recording_id, conversation_id, idempotency_key, ts}
  //   companion -> panel  {v, type:"recording_attach", requestId, ok:true,
  //                         result:{state}, ts}  (state: selected|attached|…)
  //   companion -> panel  {v, type:"recording_attach", requestId, ok:false,
  //                         error:{code, message}, ts}
  // The claim itself lives in host/agent/storage/recording-attachments.js;
  // this constant only names the envelope. The background.js relay and the
  // companion-side handler are outstanding wiring (recorded as residuals in
  // tasks.md 6.3/6.6), not claimed here.
  RECORDING_ATTACH: "recording_attach",

  // Message-queue operator controls (openspec/changes/add-message-queue-and-
  // steering, design.md decision 4/5 + the change's frozen wire contract).
  // Both reuse the one-type request/reply convention
  // AGENT_SETTINGS/UPDATE_CONVERSATION above already establish, are gated
  // behind hello like every other conversation-scoped operation, and are
  // additive with NO PROTOCOL_VERSION bump: an older companion answers
  // unknown_message_type rather than hanging.
  //
  // CANCEL_MESSAGE is the per-message cancel affordance the panel offers
  // while a message is still `pending`. The host answers from the entry's
  // own durable state, never from optimism: a message the next turn has
  // already claimed is refused with `already_claimed` (plus the claimed
  // state disclosed) — once claimed, the run's own Stop is the only control
  // left, exactly as the panel spec's "Cancel affordance follows the claim"
  // scenario requires. Wire shape:
  //   panel -> companion  {v, type:"cancel_message", conversationId,
  //                         messageId, requestId}
  //   companion -> panel  {v, type:"cancel_message", ok:true, messageId}
  //   companion -> panel  {v, type:"cancel_message", ok:false, reason:
  //                         "already_claimed"|"unknown_message"|
  //                         "conversation_deleted", state?}
  //
  // RESUME_QUEUE is the operator's explicit "drain the queue now" action,
  // offered when Stop paused the drain (design.md decision 5). It clears the
  // durable `queuePaused` flag and drains in submission order.
  //   panel -> companion  {v, type:"resume_queue", conversationId, requestId}
  //   companion -> panel  {v, type:"resume_queue", ok:true}
  //   companion -> panel  {v, type:"resume_queue", ok:false, reason:
  //                         "unknown_conversation"|"conversation_deleted"}
  CANCEL_MESSAGE: "cancel_message",
  RESUME_QUEUE: "resume_queue",

  // Administrator-managed permission policy channel
  // (add-permission-modes-and-threat-signals, design.md decision 7 / task
  // 4.1). The host cannot read `chrome.storage.managed` itself — the
  // extension reads it and pushes the result here, on connect and again
  // whenever managed storage changes, so the companion applies it fresh at
  // every decision rather than caching a snapshot from run start. Gated
  // behind hello like the browser-identity half of HELLO itself (this is a
  // fact about the current browser connection, not about any one
  // conversation). Wire shape:
  //   extension -> companion  {v, type:"managed_policy_snapshot",
  //                             policy: object|null, readError?: string}
  //   companion -> extension  {v, type:"managed_policy_snapshot", ok:true}
  // `policy: null` (no `readError`) means "no managed policy configured" —
  // local settings apply, exactly like an unmanaged install. `readError`
  // present means the extension could not read managed storage at all; the
  // companion falls back to local settings for DECISIONS but still reports
  // the condition as an unreadable administrator policy (never silently
  // "absent") via the `agent_settings` `get_permission_state` op's
  // `managedPolicy` field. A present-but-malformed `policy` object is
  // validated host-side (permission-modes.js's `validateManagedPolicy`) and
  // handled the same way: ignored for decisions, reported as unreadable.
  MANAGED_POLICY_SNAPSHOT: "managed_policy_snapshot",

  // Rerunnable workflows + self-healing
  // (openspec/changes/add-workflow-materialization-and-heal, the change's
  // frozen wire contract). Five additive request/reply pairs reusing one type
  // name per operation — the convention CANCEL_MESSAGE/RESUME_QUEUE above
  // establish — gated behind hello like every other conversation-scoped
  // operation, and additive with NO PROTOCOL_VERSION bump: an older companion
  // answers unknown_message_type rather than hanging (see companion.js's
  // handleEnvelope() default branch), which the panel maps to an explicit
  // "companion needs updating" state.
  //
  //   panel -> companion  {v, type:"workflow_draft_request", conversationId, runId, requestId}
  //   companion -> panel  {v, type:"workflow_draft_request", conversationId, requestId,
  //                        ok:true, draft:{workflowId, name, steps, domain, document, domains},
  //                        review:{workflowId, name, steps, domain, document, domains}}
  //   companion -> panel  {v, type:"workflow_draft_request", ..., ok:false, incomplete:[...]}
  //   companion -> panel  {v, type:"workflow_draft_request", ..., ok:false,
  //                        reason:"unknown_run"|"run_not_completed"|"no_trail"|"unknown_conversation"}
  //
  //   panel -> companion  {v, type:"workflow_draft_save", conversationId, runId, definition, requestId}
  //   companion -> panel  {v, type:"workflow_draft_save", ..., ok:true, workflowId, version}
  //   companion -> panel  {v, type:"workflow_draft_save", ..., ok:false,
  //                        reason:"invalid_definition", errors:[{code, message}]}
  //
  //   panel -> companion  {v, type:"workflow_prove", conversationId, workflowId, version?, tabId, requestId}
  //   companion -> panel  {v, type:"workflow_prove", ..., ok:true, outcomes:[...], evidenceFile}
  //   companion -> panel  {v, type:"workflow_prove", ..., ok:false,
  //                        reason:"unknown_workflow"|"unknown_conversation"|"busy"|"bridge_unavailable"|"bridge_error"|"extension_error",
  //                        detail?}
  //
  //   panel -> companion  {v, type:"workflow_enable", conversationId, workflowId, version, requestId}
  //   companion -> panel  {v, type:"workflow_enable", ..., ok:true, version}
  //   companion -> panel  {v, type:"workflow_enable", ..., ok:false, reason:"unknown_workflow"|"stale_version", latest?}
  //
  //   panel -> companion  {v, type:"workflow_heal_decide", conversationId, proposalId,
  //                        decision:"allow"|"deny", requestId}
  //   companion -> panel  {v, type:"workflow_heal_decide", ..., ok:true, decision,
  //                        workflowId?, fromVersion?, toVersion?}
  //   companion -> panel  {v, type:"workflow_heal_decide", ..., ok:false,
  //                        reason:"unknown_proposal"|"expired"|"superseded"|"stale_base"|"invalid_candidate",
  //                        state?, errors?, latest?}
  //
  // The transcript event family these operations append (stream_event
  // envelopes, panel-restorable): workflow_draft_saved, workflow_proof,
  // workflow_drift, workflow_heal_proposed, workflow_heal_saved,
  // workflow_heal_rejected, workflow_heal_expired, workflow_heal_superseded,
  // workflow_enabled, workflow_updated.
  WORKFLOW_DRAFT_REQUEST: "workflow_draft_request",
  WORKFLOW_DRAFT_SAVE: "workflow_draft_save",
  WORKFLOW_PROVE: "workflow_prove",
  WORKFLOW_ENABLE: "workflow_enable",
  WORKFLOW_HEAL_DECIDE: "workflow_heal_decide",
  WORKFLOW_EDIT_REQUEST: "workflow_edit_request",
  WORKFLOW_EDIT_SAVE: "workflow_edit_save",

  ERROR: "error"
});

const KNOWN_TYPES = new Set(Object.values(AGENT_MESSAGE_TYPES));

export function isKnownMessageType(type) {
  return KNOWN_TYPES.has(type);
}

// --- Threat-observation event types (add-permission-modes-and-threat-signals,
// design.md decisions 5/6) ---------------------------------------------
//
// These are inner `event.type` values carried inside an ordinary
// STREAM_EVENT envelope (`{v, type:"stream_event", conversationId, runId,
// event: {...}}`) — NOT new envelope/message types of their own, exactly
// like "approval_request"/"run_error"/"tool_rejected" already are (see
// host/agent/policy/can-use-tool.js and host/agent/session/run.js). Naming
// them here, rather than as magic strings scattered across
// host/agent/threat/*, gives the host and the (later) panel wave one shared
// vocabulary. Every event carrying `event: {...}` here is forwarded live and
// appended to the conversation's durable transcript the same way any other
// `run.emit(...)` call is (see companion.js's run.emit wrapping in
// runAsForkedChild) — there is no separate "outstanding request" registry
// for these the way there is for approval_request/question_request, since a
// finding or a category is a fact, never something waiting on a reply.
//
// Advisory only, structurally: nothing in host/agent/policy/can-use-tool.js
// or permission-modes.js ever reads an event of these types, and
// host/agent/threat/observe.js (the sole emitter) is never imported by
// either — see host/test/threat-advisory-only.test.mjs for the proof that a
// finding or an elevated category changes no decision outcome.
export const THREAT_EVENT_TYPES = Object.freeze({
  // Emitted once per matched pattern found in web content the agent read,
  // BEFORE that content is available for the agent to act on (the probe
  // runs on the dispatched result before it is returned from the tool
  // handler). Payload (alongside the envelope's own runId/conversationId):
  //   { tool: string, tabId: number|null, field: string, patternId: string,
  //     matchedText: string, location: { start: number, end: number } }
  // `matchedText` is the literal matched substring, carried as a plain data
  // field — never spliced into a prose/template string — so it is quoted
  // data everywhere it travels, including in the transcript, and never
  // re-enters the model's context (tasks.md 5.3). A finding never changes
  // whether the returning tool's content is delivered, and never changes a
  // permission decision (tasks.md 5.5).
  INJECTION_FINDING: "injection_finding",
  // Emitted when the probe itself could not complete for one piece of
  // returned content — distinguishable from a clean scan (tasks.md 5.4). The
  // content was still delivered to the agent and the run was not blocked.
  // Payload: { tool: string, tabId: number|null, error: string }.
  INJECTION_PROBE_FAILED: "injection_probe_failed",
  // Emitted whenever a controlled tab's risk category actually changes
  // (never on every observation — only on a real transition, so a long read
  // of an unremarkable page does not flood the stream). Payload:
  //   { tabId: number, category: "uncategorized"|"low"|"elevated",
  //     signals: Array<{kind, severity, label, ts, ...}> }
  // `signals` names every observation that currently contributes to the
  // category (tasks.md 6.1's "recording the contributing signals so they
  // can be inspected"), including an "injection_finding" kind whenever a
  // probe finding is what raised the category (tasks.md 6.4). Recomputed
  // from scratch whenever the tab's document identity changes — see
  // host/agent/threat/tab-risk.js — so a category never carries forward
  // from a document the tab has since navigated away from.
  TAB_RISK_UPDATE: "tab_risk_update"
});

// --- Jev runtime event types (add-typesafe-jev-provider design.md §8;
// extended by add-jev-run-context design.md §7) ------------------------------
//
// The inner `event.type` values a TypeSafe (Jev) run records through
// `Run.emit()` — ordinary STREAM_EVENT payloads, exactly like every event
// above, and DURABLE: none of them is in TRANSIENT_EVENT_TYPES below, so each
// is appended to the conversation's transcript and survives a panel reconnect
// and a conversation reopen (the panel's rebuild reads the stored events,
// never a live-only cache — see extension/sidepanel/
// conversation-model.js's jev cases). `host/agent/jev/runtime.js` is the only
// emitter; the panel and the transcript are the only readers — no decision
// anywhere reads them back, because they are a record of what happened, not
// an input to what happens next.
export const JEV_EVENT_TYPES = Object.freeze({
  // One per decision cycle that dispatched OR skipped an action, plus the
  // cycles that ended the run (a `DONE` claim, a `BLOCKED` decision, a
  // refused step). Payload:
  //   { step: number,
  //     operation: "CLICK"|"TYPE_TEXT"|"SELECT"|"NAVIGATE"|"SCROLL_UP"|
  //                "SCROLL_DOWN"|"WAIT"|"DONE"|"BLOCKED",
  //                               // Jev chooses the complete action when
  //                               // decisionSource === "jev"; older records
  //                               // attribute operations to the configured LLM.
  //     decisionSource?: "jev", actionKey?: string,
  //     actionProbability?: number, actionConfidence?: number,
  //     monitors?: { goalDone: { choice, probability, confidence },
  //                  stuck: { choice, probability, confidence } },
  //                               // independent advisory heads, not proof of
  //                               // completion or permission to dispatch
  //     intent?: string,          // the model's plain-language name for the
  //                               // element the step interacts with
  //                               // (CLICK/TYPE_TEXT/SELECT)
  //     target: { index, label }|null,
  //                               // the element TYPESAFE selected for it —
  //                               // the offered key ("3", or "3:2" for an
  //                               // element's second dropdown option) and its
  //                               // observed label; null when nothing was
  //                               // selected
  //     targetProbability: number|null, confidence: number|null,
  //                               // the selection's probability and confidence
  //     tool: string|null,        // the executed browser tool, null when none
  //     argsSummary: string,      // normalized dispatch summary — NEVER a
  //                               // TYPE_TEXT value (the panel renders this
  //                               // verbatim into the durable transcript);
  //                               // the value's field is carried by
  //                               // `textField`
  //     textField?: string,       // the field a TYPE_TEXT value was typed into
  //     evaluation?: string,      // the decision's own bounded reading of the
  //                               // step before it: what that step was meant
  //                               // to achieve and whether this page shows it
  //                               // did. Recorded as written, never rewritten
  //     skippedReason?: string,   // why nothing dispatched, when nothing did;
  //                               // "completion_rejected" marks a DONE claim
  //                               // the completion check disputed (recorded as
  //                               // a skip, never as a completion), and
  //                               // "target_unresolved" a well-formed step the
  //                               // observation offered no candidate for — or,
  //                               // with `targetAbstained`, one whose answer named
  //                               // no clear winner
  //     targetAbstained?: true,   // the selection answered, was validated, and
  //                               // still did not resolve: its confidence was
  //                               // below the run's floor, or its chosen
  //                               // candidate stood within the margin of the
  //                               // runner-up. `confidence`,
  //                               // `targetProbability` and
  //                               // `runnerUpProbability` carry the numbers
  //                               // that caused it, so an abstention is
  //                               // distinguishable from an empty table
  //     runnerUpProbability?: number,
  //     verification?: { achieved: true|false|null, error?: string },
  //                               // a DONE step's completion-check outcome:
  //                               // true = confirmed, false = rejected,
  //                               // null + error = the check could not be made
  //     latencies: { decisionMs: number, selectionMs?: number,
  //                  dispatchMs?: number },
  //                               // the step-decision call, the element
  //                               // selection when one was made, and the
  //                               // dispatch when one ran
  //     pageChanged: boolean|null }
  // `pageChanged` is null exactly when no observation followed the action
  // (result-unknown, stop), so the field never claims the page did not
  // change when that was not observed.
  STEP: "jev_step",
  // One per successful run-memory write (openspec/changes/add-jev-run-context
  // design.md §7): the run's plan, each context revision, and each stall
  // recovery. Payload:
  //   { index: number,          // 1-based per run — the panel's row key is
  //                             // `jev_memory_<index>`, so a reconnect
  //                             // rebuild reproduces the rows exactly
  //     kind: "plan"|"update"|"recovery",
  //     trigger: "start"|"navigated"|"cadence"|"stall"|"verification",
  //     memory: { plan: string, doneWhen: string, notes: string },
  //     latencyMs: number }
  // `kind` is what the call was (the plan, a revision, a recovery) and
  // `trigger` is what caused it. A failed advisory call records nothing.
  MEMORY: "jev_memory",
  // The operator-facing report a confirmed completion produces: one
  // model-written synthesis of what the task achieved and the results
  // visible in the final page text, grounded in that text by its own
  // instruction (never invented; the decision model itself cannot produce
  // prose). Payload:
  //   { text: string, latencyMs: number }
  // Emitted at most ONCE per run, and on every outcome — not only a confirmed
  // completion. A confirmed DONE's report comes from the completion check
  // itself, against the same view of the page its verdict used; every other
  // ending — blocked, stopped, failed, or done without a usable report —
  // produces one final report made after the outcome is decided, so it can
  // say what stopped the run rather than describe a page. Two runs produce
  // none: one that never observed anything, and one whose terminal failure is
  // that the decision model could not be reached (asking that same model
  // again would turn one provider failure into two); both disclose the
  // absence on `jev_end` instead. Durable like jev_step.
  RESULT: "jev_result",
  // The loop's terminal record, emitted on every terminal path — done,
  // blocked, stopped, or a classified failure — carrying the outcome kind,
  // the reason, and the step count the durable transcript needs to show
  // "done as decided" versus "blocked/stopped/failed" without inventing
  // anything. Payload:
  //   { outcome: "done"|"blocked"|"stopped"|"error", reason: string|null,
  //     steps: number,
  //     doneIsDecided: boolean,   // true only for outcome "done"
  //     doneVerified?: boolean,   // done outcomes only: true when the
  //                               // completion check confirmed the goal,
  //                               // false when the check could not be made
  //                               // and the outcome is the decision model's
  //                               // judgment alone
  //     summaryError?: string,
  //     hasResult: boolean }     // whether this run produced an answer at all
  // `doneIsDecided` is the disclosure requirement's carrier; `doneVerified`
  // splits that judgment into verified versus unverified, and `summaryError`
  // carries a failed completion check's message, a failed final report's
  // message, or both joined — the run's outcome is never changed by either.
  // `hasResult` is what lets a turn without an answer read as a disclosed
  // absence rather than as a blank reply.
  // needsOperator?: true marks an ASK terminal outcome. The run has ended
  // blocked; the flag does not imply suspended execution or automatic resume.
  END: "jev_end"
});

// --- Transient live-fragment event type (add-live-streaming-and-thinking) --
//
// The inner `event.type` a raw SDK partial-message event carries once the
// panel run's `query()` is built with `includePartialMessages: true` (see
// tools/query-options.js's `buildIsolatedOptions()` — the ONLY builder that
// sets it). Companion.js's `_runQuery()` pump forwards one of these per SDK
// `SDKPartialAssistantMessage`, and it reaches the panel inside the SAME
// existing envelope every other live event uses: the token batcher treats a
// fragment exactly like the `stream_message` it belongs to, so it travels as
// one entry of a `token_batch` and never as a native message of its own —
// never a new envelope type, and never a change to either envelope's shape.
// The SDK message is carried verbatim under `message`, exactly as
// `stream_message` carries a complete one:
//
//   { type: "stream_partial", message: {
//       type: "stream_event",
//       event: { type: "message_start" | "content_block_start" |
//                "content_block_delta" | "content_block_stop" |
//                "message_delta" | "message_stop", ... },
//       parent_tool_use_id: string | null,
//       uuid: string,
//       session_id: string } }
//
// TRANSIENT is the contract, and the only property a consumer may rely on:
// this is live display traffic. It is never appended to a conversation's
// durable transcript (SessionManager.startRun()'s onEvent sink drops it
// before `store.appendEvent` — the append stays the only path to a stored
// record), it carries no `seq`, and it is absent from replay, snapshot and
// every paged transcript read by construction. A distinct type rather than a
// flag on `stream_message` is what makes that separation structural: the
// sink and the batcher are the two host places that must know about it, and
// both read this constant instead of a scattered literal.
//
// Degradation is intended in both directions (design.md decision 8), not
// negotiated: a panel that does not know this type ignores it (see
// extension/sidepanel/conversation-model.js `_applyEventToItems()`, whose
// default branch ignores an unknown event type rather than failing), and a
// companion that never emits it simply never exercises the delta path.
// Additive under PROTOCOL_VERSION 1 — no version bump, because an old peer
// already tolerates an unknown inner event type, which is exactly the
// property this relies on.
export const STREAM_PARTIAL_EVENT_TYPE = "stream_partial";

// Every event type that is live-only: emitted through `Run.emit()` and
// forwarded to the panel, but never allowed to reach the durable transcript.
// A set (rather than the sink testing one literal) so a second transient
// kind can be added in one place instead of hunting every drop site.
export const TRANSIENT_EVENT_TYPES = Object.freeze([STREAM_PARTIAL_EVENT_TYPE]);

/** True when `event` is live-only traffic that must never be persisted. */
export function isTransientEvent(event) {
  return !!event && TRANSIENT_EVENT_TYPES.includes(event.type);
}

// --- Chunked-transport sequence kinds -------------------------------------
//
// The announced purpose carried in a chunk_begin envelope's `kind` field
// (mirrored onto every chunk_part of the same sequence) — companion.js's
// _handleChunkEnvelope branches on it to decide what to do with a completed
// byte sequence. Append-only like the version list above: both shipped
// extension and host builds are updated independently, so a kind a peer
// announces must never be silently reinterpreted.
export const CHUNK_KINDS = Object.freeze({
  // A screenshot capture's bytes uploaded for the action timeline's preview
  // thumbnails (persisted under the conversation's top-level artifacts dir).
  ACTION_ARTIFACT: "action_artifact",
  // A user-composer image attachment's bytes (pasted/dropped/picked),
  // uploaded before the message carrying it is considered sent; persisted
  // under the conversation's artifacts dir in a subpath DISTINCT from the
  // screenshot artifacts above, so timeline retention never sweeps user
  // bytes (see storage/paths.js's conversationAttachmentsDir).
  USER_ATTACHMENT: "user_attachment",
  // One agent-created document's bytes travelling host -> panel in reply to a
  // DOCUMENT_REQUEST. Unlike the two kinds above this direction is a READ:
  // nothing is persisted on arrival, the panel turns the reassembled buffer
  // into a Blob for the viewer or the download and drops it.
  DOCUMENT_BYTES: "document_bytes"
});

// --- START envelope's optional `attachments` field -------------------------
//
// Additive under PROTOCOL_VERSION 1 (an old peer ignores an unknown optional
// field; an old companion that never sees the chunks simply never has the
// artifacts to resolve — see companion.js's explicit attachment_unavailable
// run error, never a silent text-only send). The field is an array of
// ARTIFACT REFERENCES — never raw bytes: image bytes cross the native-
// messaging ceiling through a CHUNK_KINDS.USER_ATTACHMENT sequence, and by
// the time START is sent each referenced artifact already carries a
// stored:true ack. The user's literal `prompt` string is unchanged by an
// attachment: the model turn composes them into content blocks
// (text + image) on the companion side, see _runAfterLeaseGranted.
//
// Accepted MIME types, grouped by the content block each one becomes in the
// model turn. The grouping is the point: an attachment's type decides how it
// crosses into the conversation, and the three paths are not interchangeable.
//
//   image    → an image content block (the four types the pinned Agent SDK's
//              ImageBlockParam declares — sdk-tools.d.ts).
//   document → a base64 document content block, which the API accepts for
//              PDF only. A PDF is not an image and must never be sent as one.
//   text     → decoded UTF-8 and sent as an ordinary text block. Plain-text
//              formats have no binary block form; base64-ing them would only
//              hide the content from the model behind an encoding it would
//              have to guess at.
export const ATTACHMENT_MIME_KINDS = Object.freeze({
  "image/png": "image",
  "image/jpeg": "image",
  "image/webp": "image",
  "image/gif": "image",
  "application/pdf": "document",
  "text/plain": "text",
  "text/markdown": "text",
  "text/csv": "text",
  "application/json": "text"
});

export const ATTACHMENT_MIME_TYPES = Object.freeze(Object.keys(ATTACHMENT_MIME_KINDS));

// Descriptive only, never a path — see validateStartAttachments() below.
export const ATTACHMENT_NAME_MAX_LENGTH = 255;

/** Which content block a given accepted MIME type becomes. */
export function attachmentKind(mimeType) {
  return ATTACHMENT_MIME_KINDS[mimeType] || null;
}

// --- upload_grant payload validation (UPLOAD_GRANT above) ------------------
//
// Bounded three ways — array, count, per-path length — so a malformed or
// hostile caller cannot turn one envelope into unbounded filesystem work;
// the companion separately checks every accepted path against the real
// filesystem (exists, is a regular file) before granting anything.
export const UPLOAD_GRANT_MAX_PATHS = 32;
export const UPLOAD_GRANT_MAX_PATH_LENGTH = 4096;

/** POSIX "/...", a Windows drive form ("C:\..." / "C:/..."), or a UNC path.
 *  Deliberately shape-only: whether the path exists is the filesystem's
 *  answer, asked separately. */
function isAbsoluteUploadPath(p) {
  return p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p) || p.startsWith("\\\\");
}

/**
 * @param {unknown} paths - the envelope's `paths` field.
 * @returns {{ok: true, paths: string[]} | {ok: false, reason: string}}
 */
export function validateUploadGrantPaths(paths) {
  if (!Array.isArray(paths) || paths.length === 0) return { ok: false, reason: "malformed_paths" };
  if (paths.length > UPLOAD_GRANT_MAX_PATHS) return { ok: false, reason: "too_many_paths" };
  const out = [];
  for (const p of paths) {
    if (typeof p !== "string" || !p || p.length > UPLOAD_GRANT_MAX_PATH_LENGTH) return { ok: false, reason: "malformed_path" };
    if (!isAbsoluteUploadPath(p)) return { ok: false, reason: "not_absolute" };
    out.push(p);
  }
  return { ok: true, paths: out };
}

// START's optional `effort` field: how much reasoning the model applies to
// this turn. Exactly the named levels the pinned Agent SDK's Options.effort
// accepts (sdk.d.ts's EffortLevel). The SDK also accepts a raw integer token
// budget there; this channel deliberately does not carry one — a number is an
// internal budget with no stable meaning across models, and the panel has no
// way to present it honestly.
export const EFFORT_LEVELS = Object.freeze(["low", "medium", "high", "xhigh", "max"]);

/**
 * Validate START's optional `effort` field.
 *
 * Absent means "say nothing": the run then sends no effort parameter at all
 * and the model's own default applies, which is not the same as pinning it to
 * a level that happens to match today's default. An unrecognised value is
 * rejected rather than silently dropped, so a turn can never quietly run at a
 * different depth than the composer showed.
 *
 * @returns {{ok: true, effort: string|null} | {ok: false, reason: string}}
 */
export function validateStartEffort(value) {
  if (value === undefined || value === null) return { ok: true, effort: null };
  if (typeof value !== "string" || !EFFORT_LEVELS.includes(value)) {
    return { ok: false, reason: "effort_unsupported_level" };
  }
  return { ok: true, effort: value };
}

/**
 * Validate START's optional run-scoped usage overrides (tasks.md 5.1
 * inheritance: a run override wins per-field over the conversation policy).
 * Absent means "inherit the conversation policy untouched". Present fields
 * follow the same ranges as storage/conversation-metadata.js's
 * validateBudgetPolicy (single authority for the numbers lives there; this
 * only shapes the wire).
 *
 * @returns {{ok: true, usage: {maxTurns:number|null, maxBudgetUsd:number|null, wallClockDeadlineMs:number|null}}
 *          | {ok: false, reason: string}}
 */
export function validateStartUsage(value) {
  if (value === undefined || value === null) {
    return { ok: true, usage: { maxTurns: null, maxBudgetUsd: null, wallClockDeadlineMs: null } };
  }
  if (typeof value !== "object" || Array.isArray(value)) return { ok: false, reason: "malformed_usage" };
  const allowed = ["maxTurns", "maxBudgetUsd", "wallClockDeadlineMs"];
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) return { ok: false, reason: `malformed_usage_unknown_field:${key}` };
  }
  const out = { maxTurns: null, maxBudgetUsd: null, wallClockDeadlineMs: null };
  const { maxTurns, maxBudgetUsd, wallClockDeadlineMs } = value;
  if (maxTurns !== undefined && maxTurns !== null) {
    if (!Number.isInteger(maxTurns) || maxTurns < 1 || maxTurns > 1000) return { ok: false, reason: "malformed_usage_max_turns" };
    out.maxTurns = maxTurns;
  }
  if (maxBudgetUsd !== undefined && maxBudgetUsd !== null) {
    if (typeof maxBudgetUsd !== "number" || !Number.isFinite(maxBudgetUsd) || maxBudgetUsd < 0.01 || maxBudgetUsd > 10000) {
      return { ok: false, reason: "malformed_usage_max_budget" };
    }
    out.maxBudgetUsd = maxBudgetUsd;
  }
  if (wallClockDeadlineMs !== undefined && wallClockDeadlineMs !== null) {
    if (typeof wallClockDeadlineMs !== "number" || !Number.isFinite(wallClockDeadlineMs) || wallClockDeadlineMs < 1000 || wallClockDeadlineMs > 86400000) {
      return { ok: false, reason: "malformed_usage_wall_clock" };
    }
    out.wallClockDeadlineMs = wallClockDeadlineMs;
  }
  return { ok: true, usage: out };
}

/**
 * Validate a `recording_attach` claim envelope body (tasks.md 6.1/6.3).
 * All three fields are required non-empty strings — an unattributable claim
 * can never be deduped or owned, so it fails closed here rather than
 * reaching the store.
 *
 * @returns {{ok: true, claim: {recordingId, conversationId, idempotencyKey}} | {ok: false, reason: string}}
 */
export function validateRecordingAttach(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, reason: "malformed_recording_attach" };
  const recordingId = value.recording_id ?? value.recordingId;
  const conversationId = value.conversation_id ?? value.conversationId;
  const idempotencyKey = value.idempotency_key ?? value.idempotencyKey;
  if (typeof recordingId !== "string" || !recordingId) return { ok: false, reason: "malformed_recording_attach_id" };
  if (typeof conversationId !== "string" || !conversationId) return { ok: false, reason: "malformed_recording_attach_conversation" };
  if (typeof idempotencyKey !== "string" || !idempotencyKey) return { ok: false, reason: "malformed_recording_attach_key" };
  return { ok: true, claim: { recordingId, conversationId, idempotencyKey } };
}

/**
 * Validate START's optional `newSdkSession` field (tasks.md 2.4/2.5's
 * "explicit new context/session choice"): an explicit, user-initiated
 * request to start THIS turn as a brand-new SDK session for an already-
 * bound conversation, instead of attempting `resume` — the recovery action
 * for a conversation whose captured SDK session reference is missing,
 * failed a resume attempt, or (design.md decision 2.4) is incompatible with
 * the profile/model this Send actually resolved to. Absent/false is the
 * ordinary path (attempt resume when a compatible, ACTIVE reference
 * exists); true never replays anything from the transcript — it only skips
 * the `resume` option for this one query() call, exactly like every
 * conversation's very first turn already does.
 *
 * @returns {{ok: true, newSdkSession: boolean} | {ok: false, reason: string}}
 */
export function validateStartSessionChoice(value) {
  if (value === undefined || value === null) return { ok: true, newSdkSession: false };
  if (typeof value !== "boolean") return { ok: false, reason: "malformed_new_sdk_session" };
  return { ok: true, newSdkSession: value };
}

// --- START envelope's optional `mode` field --------------------------------
//
// openspec/changes/add-message-queue-and-steering, design.md decisions 3/7
// and the change's frozen wire contract. A Send now says what should happen
// when the conversation's run is already active:
//
//   "queue"     — the default, and the only behavior an older panel can
//                 possibly mean: file this message behind the active run and
//                 run it as the next turn, in submission order.
//   "interrupt" — "run now": attempt to cancel the active run through the
//                 EXISTING stop path (SessionManager.stopRun) so this message
//                 runs immediately. Best-effort by construction; when the
//                 stop path reports nothing to stop, the host discloses the
//                 fallback instead of pretending an interrupt happened.
//
// Additive under PROTOCOL_VERSION 1, exactly like `effort`/`attachments`/
// `elementRecord` above: an old peer never sends the field (→ "queue", which
// is what admission already did), and a companion that has never heard of it
// ignores it. A mode that is present but not one of these two literals is
// rejected at the wire boundary (reason "malformed_mode", carried on the
// ordinary ERROR envelope) rather than being silently coerced — a typo'd
// "interupt" must never silently become a queued send when the operator
// asked for run-now.
//
// The reply shapes this field decides between, so the whole queued-send
// contract is auditable in one place (all on the START type, which stays a
// request/reply-reuses-one-type like STOP/LIST_CONVERSATIONS):
//   run started (existing shape, unchanged):
//     {v, type:"start", conversationId, runId, accepted:true, queued:!wasFree}
//   queued (no runId — no run exists yet):
//     {v, type:"start", conversationId, accepted:true, queued:true,
//      entry:{messageId, mode, state:"pending", enqueuedAt}}
//   refused because the queue is full (nothing was appended):
//     {v, type:"error", reason:"queue_full", limit, conversationId}
// `idempotent:true` is added to a queued ack whose idempotencyKey already
// produced it. The message's own text never appears in any of these: it is
// durable in the `message_queued` transcript event (see
// host/agent/session/manager.js's enqueueMessage), which is what a reopen
// restores from.
export const START_MODES = Object.freeze({
  QUEUE: "queue",
  INTERRUPT: "interrupt"
});

/**
 * Validate START's optional `mode` field.
 * @returns {{ok: true, mode: string} | {ok: false, reason: string}}
 */
export function validateStartMode(value) {
  if (value === undefined || value === null) return { ok: true, mode: START_MODES.QUEUE };
  if (value === START_MODES.QUEUE || value === START_MODES.INTERRUPT) return { ok: true, mode: value };
  return { ok: false, reason: "malformed_mode" };
}

/**
 * Validate START's optional `attachments` field into normalized refs.
 * Absent/undefined is valid (no attachments); anything present must be an
 * array of {id, mimeType, byteLength} objects with a non-empty string id, an
 * accepted MIME type, and a positive integer byteLength. Id path-segment
 * safety is NOT re-derived here — storage/paths.js's assertSafeId() stays the
 * single authority at write/read time.
 * @returns {{ok: true, refs: Array<{id: string, mimeType: string, byteLength: number}>}
 *          | {ok: false, reason: string}}
 */
export function validateStartAttachments(value) {
  if (value === undefined || value === null) return { ok: true, refs: [] };
  if (!Array.isArray(value)) return { ok: false, reason: "attachments_not_an_array" };
  const refs = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, reason: "attachment_not_an_object" };
    if (typeof raw.id !== "string" || !raw.id) return { ok: false, reason: "attachment_missing_id" };
    if (!ATTACHMENT_MIME_TYPES.includes(raw.mimeType)) return { ok: false, reason: "attachment_unsupported_mime_type" };
    if (!Number.isInteger(raw.byteLength) || raw.byteLength <= 0) return { ok: false, reason: "attachment_invalid_byte_length" };
    // The original filename, optional and purely descriptive: it labels a
    // text attachment and titles a PDF so the model can tell two attached
    // files apart. It never reaches the filesystem — storage/paths.js keys
    // bytes by `id` alone — so it grants nothing and is only length-capped
    // to keep a hostile name from bloating the turn.
    if (raw.name !== undefined && raw.name !== null) {
      if (typeof raw.name !== "string") return { ok: false, reason: "attachment_invalid_name" };
      if (raw.name.length > ATTACHMENT_NAME_MAX_LENGTH) return { ok: false, reason: "attachment_name_too_long" };
    }
    refs.push({
      id: raw.id,
      mimeType: raw.mimeType,
      byteLength: raw.byteLength,
      ...(raw.name ? { name: raw.name } : {})
    });
  }
  return { ok: true, refs };
}

// --- START envelope's optional `elementRecord` field ------------------------
// openspec/changes/add-design-mode-element-picker, design.md D7: an
// operator-picked page element's markup/styles, travelling as its OWN field
// beside `attachments` — never spliced into `prompt`. Additive under
// PROTOCOL_VERSION 1: an old peer that has never heard of design mode simply
// never sends this field, and an old companion ignores it if it somehow
// arrived. Design.md D5's markup ceiling (32KB) is enforced picker-side
// (extension/overlay/element-picker.js); this validator allows a little
// slack over that so a byte-counting difference between UTF-16 code-unit
// `.length` here and the picker's own UTF-8 byte count never rejects an
// already-truncated, in-budget record.
export const ELEMENT_RECORD_MARKUP_SLACK_BYTES = 4 * 1024;
export const ELEMENT_RECORD_MARKUP_MAX_CHARS = 32 * 1024 + 4 * 1024;

/**
 * Validate START's optional `elementRecord` field.
 * @returns {{ok: true, record: object|null} | {ok: false, reason: string}}
 */
export function validateStartElementRecord(value) {
  if (value === undefined || value === null) return { ok: true, record: null };
  if (typeof value !== "object" || Array.isArray(value)) return { ok: false, reason: "malformed_element_record" };
  const { pageIdentity, selector, tagName, markup, markupTruncated, styles, rectClipped } = value;
  if (!pageIdentity || typeof pageIdentity !== "object" || Array.isArray(pageIdentity)) {
    return { ok: false, reason: "element_record_missing_page_identity" };
  }
  if (typeof pageIdentity.tabId !== "number") return { ok: false, reason: "element_record_invalid_page_identity" };
  if (typeof pageIdentity.url !== "string" || !pageIdentity.url) return { ok: false, reason: "element_record_invalid_page_identity" };
  if (typeof selector !== "string") return { ok: false, reason: "element_record_invalid_selector" };
  if (typeof tagName !== "string") return { ok: false, reason: "element_record_invalid_tag_name" };
  if (typeof markup !== "string") return { ok: false, reason: "element_record_invalid_markup" };
  if (markup.length > ELEMENT_RECORD_MARKUP_MAX_CHARS) return { ok: false, reason: "element_record_markup_too_large" };
  if (typeof markupTruncated !== "boolean") return { ok: false, reason: "element_record_invalid_markup_truncated" };
  if (typeof rectClipped !== "boolean") return { ok: false, reason: "element_record_invalid_rect_clipped" };
  if (!styles || typeof styles !== "object" || Array.isArray(styles)) return { ok: false, reason: "element_record_invalid_styles" };
  const normalizedStyles = {};
  for (const [k, v] of Object.entries(styles)) {
    if (typeof v !== "string") return { ok: false, reason: "element_record_invalid_styles" };
    normalizedStyles[k] = v;
  }
  return {
    ok: true,
    record: {
      pageIdentity: { tabId: pageIdentity.tabId, url: pageIdentity.url, doc: pageIdentity.doc ?? null },
      selector,
      tagName,
      markup,
      markupTruncated,
      styles: normalizedStyles,
      rectClipped
    }
  };
}

// --- Conversation presentation metadata (optimize-chat-history tasks.md 1.1)
//
// The panel is the only writer, but these fields end up in every panel's
// history list, so they are bounded here rather than trusted: a hostile or
// buggy panel must not be able to make the host's summaries unreadable or
// unbounded.
export const CONVERSATION_TITLE_MAX_CHARS = 200;
export const CONVERSATION_HOSTNAME_MAX_CHARS = 255;
export const IDEMPOTENCY_KEY_MAX_CHARS = 200;

/**
 * Validate an UPDATE_CONVERSATION request body. Only the fields present are
 * written; an empty patch is rejected rather than bumping the revision for
 * nothing.
 *
 * @returns {{ok: true, patch: object} | {ok: false, reason: string}}
 */
export function validateConversationUpdate(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, reason: "malformed_conversation_update" };
  const patch = {};
  if ("title" in value) {
    if (value.title !== null && typeof value.title !== "string") return { ok: false, reason: "malformed_conversation_title" };
    if (typeof value.title === "string" && value.title.length > CONVERSATION_TITLE_MAX_CHARS) return { ok: false, reason: "conversation_title_too_long" };
    patch.title = value.title;
  }
  if ("hostname" in value) {
    if (value.hostname !== null && typeof value.hostname !== "string") return { ok: false, reason: "malformed_conversation_hostname" };
    if (typeof value.hostname === "string" && value.hostname.length > CONVERSATION_HOSTNAME_MAX_CHARS) return { ok: false, reason: "conversation_hostname_too_long" };
    patch.hostname = value.hostname;
  }
  if ("pinned" in value) {
    if (typeof value.pinned !== "boolean") return { ok: false, reason: "malformed_conversation_pinned" };
    patch.pinned = value.pinned;
  }
  if ("archived" in value) {
    if (typeof value.archived !== "boolean") return { ok: false, reason: "malformed_conversation_archived" };
    patch.archived = value.archived;
  }
  if ("ifRevision" in value && value.ifRevision !== null && value.ifRevision !== undefined) {
    if (!Number.isInteger(value.ifRevision) || value.ifRevision < 0) return { ok: false, reason: "malformed_conversation_revision" };
    patch.ifRevision = value.ifRevision;
  }
  if (Object.keys(patch).length === 0) return { ok: false, reason: "empty_conversation_update" };
  return { ok: true, patch };
}

/**
 * Validate an optional idempotency key on DELETE_CONVERSATION /
 * DELETE_ALL_CONVERSATIONS (design.md decision 5). Absent is valid — an
 * older panel sends none and the operation is still idempotent by its own
 * end state; a present key must be a short non-empty string.
 *
 * @returns {{ok: true, key: string|null} | {ok: false, reason: string}}
 */
export function validateIdempotencyKey(value) {
  if (value === undefined || value === null || value === "") return { ok: true, key: null };
  if (typeof value !== "string" || value.length > IDEMPOTENCY_KEY_MAX_CHARS) return { ok: false, reason: "malformed_idempotency_key" };
  return { ok: true, key: value };
}

// --- Wire framing over native messaging ---------------------------------
//
// Native messaging already frames whole JSON objects (host/native-host.js's
// 4-byte length prefix). Agent traffic is nested one level inside that as
// `{ type: "agent_msg", envelope }` so native-host.js can tell an agent
// envelope apart from the pre-existing tool_request/heartbeat/save_* message
// types on the SAME stdin/stdout channel without touching their handling.
export const AGENT_MSG_WRAPPER = "agent_msg";

export function wrapAgentMessage(envelope) {
  return { type: AGENT_MSG_WRAPPER, envelope };
}

export function unwrapAgentMessage(msg) {
  if (!msg || msg.type !== AGENT_MSG_WRAPPER || !msg.envelope || typeof msg.envelope !== "object") {
    return null;
  }
  return msg.envelope;
}

/**
 * Build one outgoing envelope. `seq` is assigned by the sender's own
 * sequence counter (see session/events.js) — it is per-conversation stream
 * ordering, independent of the protocol version.
 */
export function makeEnvelope(type, payload = {}, opts = {}) {
  return {
    v: PROTOCOL_VERSION,
    type,
    ...payload,
    ...(opts.seq !== undefined ? { seq: opts.seq } : {}),
    ts: Date.now()
  };
}

/**
 * Validate an inbound hello. Returns either an accept result carrying the
 * negotiated version, or a fail-closed rejection reason. Never throws — the
 * caller is expected to be message-loop code that must not crash the host on
 * a malformed peer.
 */
export function validateHello(envelope) {
  if (!envelope || typeof envelope !== "object") {
    return { ok: false, reason: "malformed_hello" };
  }
  if (envelope.type !== AGENT_MESSAGE_TYPES.HELLO) {
    return { ok: false, reason: "not_a_hello" };
  }
  const v = envelope.v;
  if (typeof v !== "number" || !Number.isInteger(v)) {
    return { ok: false, reason: "missing_version" };
  }
  if (!isSupportedVersion(v)) {
    return { ok: false, reason: "unsupported_version", requested: v };
  }
  return { ok: true, version: v };
}

export function versionMismatchEnvelope(reason, extra = {}) {
  return makeEnvelope(AGENT_MESSAGE_TYPES.VERSION_MISMATCH, {
    reason,
    supported: [...SUPPORTED_PROTOCOL_VERSIONS],
    ...extra
  });
}

export function helloAckEnvelope(extra = {}) {
  return makeEnvelope(AGENT_MESSAGE_TYPES.HELLO_ACK, {
    supported: [...SUPPORTED_PROTOCOL_VERSIONS],
    ...extra
  });
}
