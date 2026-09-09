// The 11 observable run states the panel must represent (spec:
// "Observable run states" in
// openspec/changes/migrate-to-claude-agent-sdk/specs/browser-assistant-panel/spec.md).
//
// Kept as one small, dependency-free module so both conversation-model.js
// (which computes the live phase) and any test/render code share exactly
// one list -- no second copy of the state names to drift out of sync.

export const RUN_PHASE = Object.freeze({
  EMPTY: "empty",
  CONNECTING: "connecting",
  READY: "ready",
  QUEUED: "queued",
  STREAMING: "streaming",
  WAITING_FOR_PERMISSION: "waiting-for-permission",
  STOPPING: "stopping",
  STOPPED: "stopped",
  INTERRUPTED: "interrupted",
  COMPLETED: "completed",
  ERROR: "error"
});

export const ALL_RUN_PHASES = Object.freeze(Object.values(RUN_PHASE));

export function isKnownPhase(phase) {
  return ALL_RUN_PHASES.includes(phase);
}

// Human-readable Vietnamese labels for the connection-state pill / header,
// matching the copy style already reviewed in design-review/screens/*.html.
export const PHASE_LABEL_VI = Object.freeze({
  [RUN_PHASE.EMPTY]: "Sẵn sàng",
  [RUN_PHASE.CONNECTING]: "Đang kết nối",
  [RUN_PHASE.READY]: "Sẵn sàng",
  [RUN_PHASE.QUEUED]: "Đang chờ lượt",
  [RUN_PHASE.STREAMING]: "Đang phản hồi",
  [RUN_PHASE.WAITING_FOR_PERMISSION]: "Chờ cấp quyền",
  [RUN_PHASE.STOPPING]: "Đang dừng",
  [RUN_PHASE.STOPPED]: "Đã dừng",
  [RUN_PHASE.INTERRUPTED]: "Bị gián đoạn",
  [RUN_PHASE.COMPLETED]: "Đã xong",
  [RUN_PHASE.ERROR]: "Lỗi kết nối"
});

// The busy/working indicator's own label (Section 6). Deliberately DISTINCT
// from PHASE_LABEL_VI[STREAMING] ("Đang phản hồi" = "responding") — the busy
// indicator shows precisely while NO answer text is arriving yet (queued, or
// the gap before the first token / between answer segments), so it must never
// claim a response is already flowing. "Đang xử lý…" = "working on it…".
export const BUSY_LABEL_VI = "Đang xử lý…";

// Maps a phase to the shared `.connection-state.is-*` modifier already
// defined in extension/ui/components.css (is-ready/is-connecting/is-error
// are the only three that exist there -- the panel never invents a second
// color language). STOPPED/INTERRUPTED intentionally map to "" (no
// modifier): components.css's base `.connection-dot` is already a neutral
// gray, which is the correct, distinct-from-error-or-ready treatment for
// "the run ended without completing" and needs no new shared class.
export function phaseVisualClass(phase) {
  switch (phase) {
    case RUN_PHASE.READY:
    case RUN_PHASE.EMPTY:
    case RUN_PHASE.COMPLETED:
      return "is-ready";
    case RUN_PHASE.CONNECTING:
    case RUN_PHASE.QUEUED:
    case RUN_PHASE.STREAMING:
    case RUN_PHASE.STOPPING:
    case RUN_PHASE.WAITING_FOR_PERMISSION:
      return "is-connecting";
    case RUN_PHASE.STOPPED:
    case RUN_PHASE.INTERRUPTED:
      return "";
    case RUN_PHASE.ERROR:
      return "is-error";
    default:
      return "is-connecting";
  }
}
