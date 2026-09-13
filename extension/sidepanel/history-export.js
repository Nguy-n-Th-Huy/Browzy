// Conversation export — the artifact half of spec chat-history-lifecycle
// "Organization and export": "a local Markdown or JSON artifact is produced
// containing the selected transcript and metadata".
//
// WHY THIS IS ITS OWN MODULE. `panel-controller.js` owns the I/O (paging the
// host's transcript through `transcript_window_request`) and `sidepanel.js`
// owns the download; both are untestable in plain Node. Everything between
// them — event list → messages → Markdown/JSON text — is pure, and it is the
// part the spec makes claims about (metadata present, transcript present, the
// transcript unchanged). Keeping it here means the claims are provable, and
// the panel has exactly one implementation of "what a conversation looks
// like as a document".
//
// THE TRANSCRIPT IS THE HOST'S, NOT THE PANEL'S WINDOW. The live model is
// bounded (`maxWindowEvents`, tasks.md 3.3) and a panel that had been open for
// a while holds only the newest slice of a long conversation; exporting that
// would produce a file that silently begins mid-conversation. The caller
// therefore pages the whole transcript out of the host first (see
// `PanelController.collectTranscript()`), and this module rebuilds an
// UNBOUNDED model from exactly those events — the same event→message mapping
// the live panel renders, so an export and the screen can never disagree about
// what a message is. That rebuild is read-only: nothing here writes to the
// cache, the host, or the live model, which is what "without changing its
// transcript contents" means in practice.
//
// READ-ONLY, SO NO IDEMPOTENCY KEY. design.md decision 5 pairs "delete/export"
// as host operations with idempotency keys. Delete needs one (a retried delete
// must not be a second delete); export does not, and minting one would be
// theatre — it reads pages the host already has and repeats byte-for-byte for
// an unchanged conversation. The read is still host-authoritative, which is
// the part of the decision that carries the guarantee.

import { ConversationModel } from "./conversation-model.js";

export const EXPORT_FORMAT = Object.freeze({ MARKDOWN: "md", JSON: "json" });

/** Shape version of the JSON artifact, so a later consumer can tell what it
 * is reading. Independent of the storage schema: this is an interchange
 * document, not a cache entry. */
export const EXPORT_SCHEMA_VERSION = 1;

const MIME = Object.freeze({
  [EXPORT_FORMAT.MARKDOWN]: "text/markdown;charset=utf-8",
  [EXPORT_FORMAT.JSON]: "application/json;charset=utf-8"
});

/** Longest filename slug kept from a conversation title. */
export const EXPORT_SLUG_MAX_CHARS = 60;

/** Accept what a person actually types ("md", "markdown", "json"); anything
 * else is a caller error the UI must report rather than guess at. */
export function normalizeExportFormat(value) {
  const text = String(value == null ? "" : value)
    .trim()
    .toLowerCase();
  if (text === "md" || text === "markdown") return EXPORT_FORMAT.MARKDOWN;
  if (text === "json") return EXPORT_FORMAT.JSON;
  return null;
}

/** Filename-safe, diacritic-free slug of a title. */
export function slugify(value) {
  return String(value == null ? "" : value)
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[đĐ]/g, "d")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, EXPORT_SLUG_MAX_CHARS)
    .replace(/-+$/g, "");
}

/** `browzy-<slug>-<local yyyymmdd-hhmm>.<md|json>` — sortable, unique per
 * minute, and recognisable next to the panel it came from. */
export function exportFilename(summary, { format = EXPORT_FORMAT.MARKDOWN, at = Date.now() } = {}) {
  const date = new Date(at);
  const pad = (n) => String(n).padStart(2, "0");
  const stamp = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`;
  const slug = slugify(summary && summary.title) || "cuoc-tro-chuyen";
  return `browzy-${slug}-${stamp}.${format}`;
}

function seqOf(event) {
  return event && typeof event.seq === "number" ? event.seq : 0;
}

/**
 * Rebuild the conversation's messages from a full event list, using the same
 * model the live panel renders (unbounded here: an export must not be a
 * window).
 *
 * Events are sorted ascending by `seq` first: the caller pages the newest page
 * first and walks DOWNWARD (`beforeSeq`), while the model's watermarks only
 * accept non-decreasing sequence numbers. Sorting here, rather than relying on
 * the caller's page order, is what makes "newest page first" safe — and it is
 * also why a page arriving twice cannot duplicate anything.
 *
 * @returns {{items: Array<object>, meta: object|null}}
 */
export function transcriptMessages({ conversationId, events = [], prompts = null, meta = null }) {
  const model = new ConversationModel(conversationId, { maxWindowEvents: Infinity });
  if (prompts) model.seedLocalPrompts(prompts);
  const ordered = (Array.isArray(events) ? events : []).slice().sort((a, b) => seqOf(a) - seqOf(b));
  model.applySnapshot({ conversationId, meta, lastSeq: 0, firstSeq: 0, hasOlder: false, events: ordered });
  return { items: model.items, meta: model.meta };
}

/** First stored timestamp per run, so a message's time comes from the
 * transcript rather than from whatever the rebuilding model's clock happened
 * to be (which is what made two exports of an unchanged conversation
 * different). */
export function runTimestamps(events) {
  const map = new Map();
  for (const event of Array.isArray(events) ? events : []) {
    if (!event || typeof event.runId !== "string" || typeof event.ts !== "number" || event.ts <= 0) continue;
    const current = map.get(event.runId);
    if (current == null || event.ts < current) map.set(event.runId, event.ts);
  }
  return map;
}

/** Map the model's items onto the artifact's message list. Tool activity is
 * carried as data (name + status + summary), never as rendered HTML.
 *
 * Timestamps: an assistant turn is stamped with the run's first stored event
 * time, which the host owns. A user message has NO timestamp at all — the host
 * does not persist prompt text or when it arrived, so the only value available
 * to the panel is its own clock at export time, and putting that in a document
 * that claims to be the transcript would be inventing a fact that would then
 * differ between two exports of the same conversation. */
export function artifactMessages(items, { runTimes = new Map() } = {}) {
  const messages = [];
  for (const item of Array.isArray(items) ? items : []) {
    if (!item) continue;
    if (item.kind === "user") {
      messages.push({
        role: "user",
        ts: null,
        text: item.text || "",
        // A prompt this browser profile never cached (the host does not store
        // prompt text) is exported as the placeholder it is, with the flag set,
        // rather than as an empty message that would read like a blank turn.
        complete: item.isPlaceholder !== true
      });
      continue;
    }
    if (item.kind === "assistant_turn") {
      const toolCalls = (item.toolRows || []).map((row) => ({
        name: row.toolName || "",
        status: row.status || "",
        summary: row.resultSummary || ""
      }));
      messages.push({
        role: "assistant",
        ts: runTimes.get(item.runId) ?? null,
        text: item.text || "",
        lifecycle: item.lifecycle || null,
        error: item.errorInfo ? { reason: item.errorInfo.reason, detail: item.errorInfo.detail ?? null } : null,
        toolCalls
      });
      continue;
    }
    // `recording` items and anything a future model adds: exported as-is
    // rather than dropped, so an export never quietly loses a row the
    // operator can see on screen.
    messages.push({ role: item.kind || "other", ts: runTimes.get(item.runId) ?? null, text: item.text || "", raw: true });
  }
  return messages;
}

// ------------------------------------------------------------- Markdown / JSON

function formatWhen(ts) {
  if (!ts) return null;
  const date = new Date(ts);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function markdownArtifact({ summary, messages, exportedAt, counts }) {
  const lines = [];
  lines.push(`# ${summary.title || "Cuộc trò chuyện"}`);
  lines.push("");
  lines.push("<!-- Bản xuất từ Browzy — bản ghi trên máy chủ companion, không phải bản dựng lại từ màn hình. -->");
  lines.push("");
  const meta = [
    ["Mã hội thoại", summary.conversationId],
    ["Tạo lúc", formatWhen(summary.createdAt)],
    ["Cập nhật", formatWhen(summary.updatedAt)],
    ["Trang", summary.hostname],
    ["Ghim", summary.pinned ? "có" : null],
    ["Lưu trữ", summary.archived ? "có" : null],
    ["Gián đoạn", summary.interrupted ? "có" : null],
    ["Revision", Number.isInteger(summary.revision) ? String(summary.revision) : null],
    ["Số sự kiện", String(counts.eventCount)],
    ["Số tin nhắn", String(messages.length)]
  ].filter(([, value]) => value != null && value !== "");
  for (const [label, value] of meta) lines.push(`- **${label}:** ${value}`);
  lines.push("");
  for (const message of messages) {
    lines.push(message.role === "user" ? "## Người dùng" : message.role === "assistant" ? "## Trợ lý" : `## ${message.role}`);
    lines.push("");
    if (message.text) lines.push(message.text);
    else lines.push("_(không có nội dung văn bản)_");
    if (message.complete === false) lines.push("", "_(bản lưu cục bộ không có nội dung tin nhắn này)_");
    if (message.error) {
      lines.push("", `_(lỗi: ${message.error.reason || "không rõ"}${message.error.detail ? ` — ${message.error.detail}` : ""})_`);
    }
    if (message.toolCalls && message.toolCalls.length) {
      lines.push("", `### Công cụ (${message.toolCalls.length})`, "");
      for (const call of message.toolCalls) {
        const detail = call.summary ? ` — ${call.summary}` : "";
        lines.push(`- \`${call.name}\` (${call.status || "không rõ"})${detail}`);
      }
    }
    lines.push("");
  }
  lines.push("---");
  lines.push("");
  lines.push(`_Xuất lúc ${new Date(exportedAt).toISOString()}._`);
  lines.push("");
  return lines.join("\n");
}

function jsonArtifact({ summary, messages, exportedAt, counts }) {
  return (
    JSON.stringify(
      {
        schemaVersion: EXPORT_SCHEMA_VERSION,
        exportedAt: new Date(exportedAt).toISOString(),
        exportedBy: "Browzy side panel",
        conversation: {
          conversationId: summary.conversationId || null,
          title: summary.title ?? null,
          hostname: summary.hostname ?? null,
          createdAt: summary.createdAt ?? null,
          updatedAt: summary.updatedAt ?? null,
          pinned: summary.pinned === true,
          archived: summary.archived === true,
          interrupted: summary.interrupted === true,
          revision: Number.isInteger(summary.revision) ? summary.revision : 0
        },
        transcript: {
          eventCount: counts.eventCount,
          messageCount: messages.length,
          incompleteMessages: counts.incompleteMessages,
          source: "host"
        },
        messages
      },
      null,
      2
    ) + "\n"
  );
}

/**
 * Build one export artifact. Pure: same inputs, same bytes; no I/O, no cache
 * writes, no mutation of `events`/`summary`.
 *
 * @param {object} input
 * @param {object} input.summary - the conversation's metadata (host summary)
 * @param {Array<object>} input.events - the FULL transcript, in any page order
 * @param {Map<string,string>|object} [input.prompts] - local prompt echoes
 * @param {"md"|"json"} [input.format]
 * @param {number} [input.exportedAt]
 * @returns {{format:string, filename:string, mimeType:string, content:string,
 *   eventCount:number, messageCount:number, incompleteMessages:number}}
 */
export function buildConversationArtifact({
  summary = {},
  events = [],
  prompts = null,
  format = EXPORT_FORMAT.MARKDOWN,
  exportedAt = Date.now()
} = {}) {
  const normalized = normalizeExportFormat(format);
  if (!normalized) throw new Error(`buildConversationArtifact: unknown format ${JSON.stringify(format)}`);
  const conversationId = summary.conversationId || "conversation";
  const { items } = transcriptMessages({ conversationId, events, prompts, meta: summary.meta || null });
  const messages = artifactMessages(items, { runTimes: runTimestamps(events) });
  const counts = {
    eventCount: Array.isArray(events) ? events.length : 0,
    incompleteMessages: messages.filter((message) => message.complete === false).length
  };
  const content = normalized === EXPORT_FORMAT.JSON ? jsonArtifact({ summary, messages, exportedAt, counts }) : markdownArtifact({ summary, messages, exportedAt, counts });
  return {
    format: normalized,
    filename: exportFilename(summary, { format: normalized, at: exportedAt }),
    mimeType: MIME[normalized],
    content,
    eventCount: counts.eventCount,
    messageCount: messages.length,
    incompleteMessages: counts.incompleteMessages
  };
}
