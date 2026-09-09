// Recording list/attach/start/stop for the panel (spec 5.3), without any
// Claude Code / MCP channel dependency.
//
// Reads the SAME "ocic-recorder" IndexedDB database
// extension/recorder/options.js already reads (same extension origin, so
// this is a read-only, schema-compatible reuse of an existing store — not a
// new format, and extension/recorder/** itself is never touched). Start/
// stop/status go through extension/background.js's recorder state machine
// via a small set of runtime messages this task adds there for exactly this
// purpose (see background.js's "panel_*" message handlers) — the mic/
// transcription-credential setup itself stays on the existing Options page
// per the delegation ("existing recording options ... remain accessible").
//
// "Attach a past/pending recording to THIS conversation": there is no
// protocol message for a panel to force-target an arbitrary, not-currently-
// active conversation (host/agent/session/manager.js's
// activeConversationIdForRecording() always picks whichever conversation
// currently holds the shared browser lease, or persists the recording as
// pending — see its own doc comment). This module's attach() therefore
// re-sends the EXISTING "recording_complete" native message
// (extension/background.js's notifyClaude() already sends this exact shape
// on every recording stop) through a small background.js relay, which
// succeeds in attaching to the CURRENTLY OPEN conversation precisely when
// that conversation holds the active run/lease at the moment of the click —
// the same rule a fresh stop already follows. It does not fabricate a
// second protocol; it reuses the one that exists. See
// reports/05-panel-evidence.md "Known gaps" for the honest limitation this
// implies (a fully idle target conversation cannot be force-attached
// without a host-side protocol addition).

const DB_NAME = "ocic-recorder";
const DB_VERSION = 3;

export function formatDuration(ms) {
  const s = Math.max(0, Math.round((ms || 0) / 1000));
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m <= 0) return `${rem} giây`;
  return `${m} phút ${rem} giây`;
}

/** Pure formatter: raw IndexedDB "sessions" row -> display-ready summary. No
 * DB access here, so this is directly unit-testable with fixture rows. */
export function summarizeRecording(row) {
  const durationMs = (row.ended_at || 0) - (row.started_at || 0);
  const hasAudio = !!(row.audio && row.audio.size);
  const tstat = row.transcriptStatus || (row.trace && row.trace.transcript_status) || "";
  const host = (() => {
    try {
      return new URL(row.url0).host;
    } catch {
      return null;
    }
  })();
  const snippet = ((row.trace && row.trace.cognitive) || [])
    .slice(0, 2)
    .map((u) => u.text)
    .join(" ")
    .trim();
  return {
    recordingId: row.recording_id,
    title: `${row.recording_id}${snippet ? ` — ${snippet.slice(0, 40)}` : ""}`,
    durationLabel: formatDuration(durationMs),
    hasAudio,
    hasNarrationIssue: !!tstat && tstat !== "ok",
    transcriptStatus: tstat || "ok",
    hostname: host,
    path: row.path || null,
    startedAt: row.started_at || 0
  };
}

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      // Matches extension/recorder/options.js's own upgrade path exactly —
      // this module only ever reads, so it must never race the recorder's
      // own schema creation with a divergent one.
      const d = req.result;
      if (!d.objectStoreNames.contains("sessions")) d.createObjectStore("sessions", { keyPath: "recording_id" });
      if (!d.objectStoreNames.contains("events")) d.createObjectStore("events", { keyPath: "seq", autoIncrement: true });
      if (!d.objectStoreNames.contains("audio")) d.createObjectStore("audio", { keyPath: "seq", autoIncrement: true });
      if (!d.objectStoreNames.contains("cursor")) d.createObjectStore("cursor", { keyPath: "seq", autoIncrement: true });
      if (!d.objectStoreNames.contains("images")) d.createObjectStore("images", { keyPath: "seq", autoIncrement: true });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function listRecordings() {
  let db;
  try {
    db = await openDb();
  } catch {
    return [];
  }
  const rows = await new Promise((resolve) => {
    const tx = db.transaction("sessions", "readonly");
    const req = tx.objectStore("sessions").getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => resolve([]);
  });
  return rows.sort((a, b) => (b.started_at || 0) - (a.started_at || 0)).map(summarizeRecording);
}

/**
 * @param {object} [deps]
 * @param {(msg: object) => Promise<any>} [deps.sendMessage] - defaults to
 *   chrome.runtime.sendMessage; injectable for tests.
 */
export class RecordingsClient {
  constructor({ sendMessage } = {}) {
    this._send = sendMessage || ((msg) => chrome.runtime.sendMessage(msg));
  }

  /** {active, busy, recordingId, startedAt, sidePanelSupported} */
  async status() {
    try {
      return (await this._send({ __ocic: "panel_recorder_status" })) || { active: false, busy: false };
    } catch {
      return { active: false, busy: false, unavailable: true };
    }
  }

  /** Toggle start/stop, mirroring the old toolbar-click behavior exactly
   * (spec 5.1: "the old toolbar start/stop recording behavior moves into
   * the panel ... as a labeled control"). */
  async toggle() {
    return this._send({ __ocic: "panel_toggle_recording" });
  }

  async attach(recording) {
    return this._send({
      __ocic: "panel_reattach_recording",
      recording_id: recording.recordingId,
      path: recording.path || "",
      schema: "v0",
      summary: recording.title || "",
      transcript_status: recording.transcriptStatus || "ok"
    });
  }
}

// --- Recording attachment states (tasks.md 6.1/6.4, panel half) -----------
//
// The durable states live host-side
// (host/agent/storage/recording-attachments.js: selected -> attached ->
// submitted -> included|unknown|failed). These pure descriptors render each
// state distinctly so the composer can never imply the model SAW a recording
// whose content path never succeeded: `selected`/`attached` are a pending
// REFERENCE only, `submitted` is in-flight delivery, and only `included`
// means model input. `unknown`/`failed` carry the exact reason, never a
// silent absence.
//
// The targeted-attach wire (protocol.js RECORDING_ATTACH + background relay
// + companion handler + sidepanel control wiring) is outstanding — see
// tasks.md 6.3/6.6 residuals — so this module deliberately adds NO send
// method for it: a client method with no background handler would fail
// closed at runtime and read as a working path in review. The existing
// attach() above keeps its current-lease routing contract unchanged.

export const RECORDING_ATTACHMENT_UI_STATES = Object.freeze([
  "selected",
  "attached",
  "submitted",
  "included",
  "unknown",
  "failed"
]);

const ATTACHMENT_STATE_COPY = {
  selected: { label: "Đã chọn", tone: "pending", detail: "Đã chọn bản ghi cho hội thoại này. Mô hình chưa thấy nội dung — mới chỉ là tham chiếu." },
  attached: { label: "Đã gắn", tone: "pending", detail: "Bản ghi đã được xác minh và giữ chỗ. Mô hình vẫn chưa thấy nội dung." },
  submitted: { label: "Đang gửi", tone: "pending", detail: "Nội dung đang được chuyển cho mô hình ở lượt tiếp theo. Chưa xác nhận." },
  included: { label: "Đã đưa vào", tone: "ok", detail: "Mô hình đã nhận được nội dung bản ghi (đã biên tập/giới hạn theo mô tả)." },
  unknown: { label: "Không rõ", tone: "unknown", detail: "Không xác nhận được mô hình có nhận nội dung hay không. Không tính là đã đọc." },
  failed: { label: "Thất bại", tone: "error", detail: "Không thể đưa nội dung cho mô hình. Mô hình chưa thấy bản ghi này." }
};

/** Pure descriptor for one attachment state; unknown strings fail closed to `unknown`. */
export function attachmentStateInfo(state, reason = null) {
  const known = state && ATTACHMENT_STATE_COPY[state] ? state : "unknown";
  const copy = ATTACHMENT_STATE_COPY[known];
  return {
    state: known,
    label: copy.label,
    tone: copy.tone,
    detail: reason ? `${copy.detail} Lý do: ${reason}` : copy.detail
  };
}

/**
 * Validate an attach target before any wire is touched (tasks.md 6.3:
 * explicit idle-conversation targeting). Pure — the background relay that
 * will carry it is outstanding, so this validates intent, not delivery.
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
export function validateAttachTarget({ recordingId, conversationId } = {}) {
  if (typeof recordingId !== "string" || !recordingId) return { ok: false, reason: "missing_recording_id" };
  if (typeof conversationId !== "string" || !conversationId) return { ok: false, reason: "missing_conversation_id" };
  return { ok: true };
}
