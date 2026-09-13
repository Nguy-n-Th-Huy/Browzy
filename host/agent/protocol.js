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
