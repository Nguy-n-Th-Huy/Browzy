// Scoped model-readable recording delivery path (tasks.md 6.2, design.md
// decision 5): bounded, redacted, size-limited trace/transcript content
// blocks — the SEPARATE path that actually delivers recording data to the
// model. The pending-reference channel stays reference-only and MUST NOT be
// described as model delivery until THIS path succeeds and the attachment
// store records `included` with this module's evidence.
//
// Bounds: at most MAX_RECORDING_DELIVERY_EVENTS trace events and
// MAX_RECORDING_DELIVERY_BYTES of rendered text. Anything beyond is cut with
// an explicit `truncated` flag plus kept/dropped counts — never silently
// dropped, never claimed complete.
//
// Redaction: event fields whose names look like secrets (key/token/secret/
// password/cookie/authorization/credential) are replaced with "[redacted]".
// Redaction is REPORTED (redactedFields count + names) so the transcript can
// say the model saw a redacted view, not the raw trace.
//
// Ownership: the recording's owning conversation must equal the requesting
// conversation; anything else fails with `owner_mismatch` rather than
// leaking one conversation's demonstration into another.

export const MAX_RECORDING_DELIVERY_EVENTS = 60;
export const MAX_RECORDING_DELIVERY_BYTES = 8000;

const SECRET_FIELD_PATTERN = /key|token|secret|password|cookie|authori[sz]ation|credential|sessionid|api[-_]?key/i;

function redactValue(fieldName, value, redacted) {
  if (SECRET_FIELD_PATTERN.test(String(fieldName))) {
    redacted.add(String(fieldName));
    return "[redacted]";
  }
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((v, i) => redactValue(`${fieldName}[${i}]`, v, redacted));
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactValue(k, v, redacted);
    return out;
  }
  return value;
}

function renderEvent(event) {
  if (event == null) return "";
  if (typeof event === "string") return event;
  const parts = [];
  if (event.text) parts.push(String(event.text));
  else {
    if (event.action) parts.push(`action: ${event.action}`);
    if (event.url) parts.push(`url: ${event.url}`);
    if (event.detail) parts.push(`detail: ${typeof event.detail === "string" ? event.detail : JSON.stringify(event.detail)}`);
    if (!parts.length) parts.push(JSON.stringify(event));
  }
  return parts.join(" | ");
}

/**
 * Build the bounded model-readable content for one attached recording.
 *
 * @param {object} params
 * @param {string} params.recordingId
 * @param {string} params.conversationId - the requesting conversation
 * @param {string} params.ownerConversationId - the conversation that owns the claim
 * @param {Array} [params.traceEvents] - raw trace/cognitive events (may be absent)
 * @param {string} [params.transcript] - narration transcript text (may be absent)
 * @param {string} [params.summary] - short summary line
 * @param {object} [params.limits] - {maxEvents, maxBytes} overrides (tests)
 * @returns {{ok: true, blocks: Array<{type:"text", text:string}>,
 *            evidence: {channel, recordingId, eventsIncluded, eventsTotal,
 *                       truncated, redactedFields: string[], bytes}} |
 *           {ok: false, reason: string}}
 */
export function buildRecordingContentBlocks({
  recordingId,
  conversationId,
  ownerConversationId,
  traceEvents = null,
  transcript = null,
  summary = null,
  limits = {}
} = {}) {
  if (!recordingId) return { ok: false, reason: "recording_missing_id" };
  if (!conversationId || conversationId !== ownerConversationId) {
    return { ok: false, reason: "owner_mismatch" };
  }
  const events = Array.isArray(traceEvents) ? traceEvents : [];
  const hasTranscript = typeof transcript === "string" && transcript.trim().length > 0;
  if (events.length === 0 && !hasTranscript) {
    return { ok: false, reason: "recording_no_deliverable_content" };
  }
  const maxEvents = limits.maxEvents ?? MAX_RECORDING_DELIVERY_EVENTS;
  const maxBytes = limits.maxBytes ?? MAX_RECORDING_DELIVERY_BYTES;

  const redacted = new Set();
  const kept = events.slice(0, maxEvents).map((e) => redactValue("event", e, redacted));
  const lines = kept.map(renderEvent).filter((l) => l.length > 0);

  let text = `Recording ${recordingId}${summary ? ` — ${summary}` : ""} (redacted demonstrator view):\n`;
  if (hasTranscript) text += `\nNarration:\n${transcript.trim()}\n`;
  if (lines.length) text += `\nTrace (${kept.length}/${events.length} events):\n${lines.map((l, i) => `${i + 1}. ${l}`).join("\n")}\n`;
  const truncatedByEvents = events.length > kept.length;
  let truncated = truncatedByEvents;
  if (Buffer.byteLength(text, "utf8") > maxBytes) {
    // Cut on a line boundary where possible so the model never sees a
    // half-event presented as whole; the cut itself is reported.
    let cut = text.slice(0, maxBytes);
    const lastNewline = cut.lastIndexOf("\n");
    if (lastNewline > maxBytes / 2) cut = cut.slice(0, lastNewline);
    text = cut + `\n…[truncated to ${maxBytes} bytes]`;
    truncated = true;
  }
  if (redacted.size > 0) text += `\n[note: ${redacted.size} secret-like field(s) redacted: ${[...redacted].join(", ")}]`;

  return {
    ok: true,
    blocks: [{ type: "text", text }],
    evidence: {
      channel: "recording_content_blocks",
      recordingId,
      eventsIncluded: kept.length,
      eventsTotal: events.length,
      truncated,
      redactedFields: [...redacted],
      bytes: Buffer.byteLength(text, "utf8")
    }
  };
}
