// Human-readable Vietnamese labels + sensitive-argument redaction for
// browser-tool activity rows (spec: "Browser actions SHALL show
// human-readable names, status, associated tab, and expandable result
// details" and "the timeline identifies the action without displaying the
// typed secret or exposing raw sensitive arguments").
//
// Kept as pure functions (name/args in, string out) so they are trivially
// unit-testable without any DOM or chrome.* dependency. The 26-tool
// preserved-baseline inventory mirrors host/tool-definitions.js's TOOLS
// (design.md's "authoritative preservation inventory"), plus the 2
// post-baseline WebMCP page-tool additions from openspec/changes/
// consume-webmcp-page-tools; this file does not change or duplicate their
// schemas, only how a call is DESCRIBED to a human. The TypeSafe Jev runtime
// (openspec/changes/add-typesafe-jev-provider, design.md §8) adds a third
// kind of row — one decision step recorded as a durable `jev_step` event
// instead of an SDK tool_use block, plus the run's terminal `jev_end` line —
// so its Vietnamese copy lives in its own section at the end of this file,
// next to the tables above.

const STATIC_LABELS_VI = {
  tabs_context_mcp: "Đã kiểm tra các tab đang mở",
  tabs_create_mcp: "Đã mở tab mới",
  debug_timings: "Đã đo thời gian thao tác",
  tabs_close_mcp: "Đã đóng tab",
  navigate: "Đã mở trang",
  find: "Đang tìm mục tiêu trên trang",
  form_input: "Đã điền biểu mẫu",
  get_page_text: "Đã đọc nội dung trang",
  gif_creator: "Đã tạo GIF minh họa",
  javascript_tool: "Đã chạy mã trên trang",
  execute_code: "Đã chạy mã",
  read_console_messages: "Đã đọc console của trang",
  read_network_requests: "Đã đọc các yêu cầu mạng",
  read_page: "Đã đọc cấu trúc trang",
  resize_window: "Đã đổi kích thước cửa sổ",
  shortcuts_list: "Đã liệt kê phím tắt",
  shortcuts_execute: "Đã thực thi phím tắt",
  list_connected_browsers: "Đã liệt kê trình duyệt",
  select_browser: "Đã chuyển trình duyệt",
  update_plan: "Đã cập nhật kế hoạch",
  debug: "Đã ghi log gỡ lỗi",
  get_config: "Đã đọc cấu hình trình duyệt",
  set_config: "Đã thay đổi cấu hình trình duyệt",
  set_tab_focus: "Đã chuyển tab",
  upload_image: "Đã tải ảnh lên",
  retranscribe_recording: "Đã chuyển lại bản ghi thành văn bản",
  file_upload: "Đã tải tệp lên",
  // openspec/changes/consume-webmcp-page-tools: post-baseline additions,
  // not part of the 26-tool preserved inventory above.
  webmcp_list_tools: "Đã kiểm tra công cụ do trang khai báo",
  webmcp_call_tool: "Đã thực thi công cụ do trang khai báo",
  // openspec/changes/add-browser-batch-tool: a batch is one tool call that
  // runs several browser actions in sequence, so it gets one activity row.
  browser_batch: "Đã chạy loạt thao tác trình duyệt",
  // openspec/changes/add-typesafe-jev-provider: the post-baseline structured
  // observation (a bounded element table plus visible page text, read-only and
  // shared by both runtimes) — distinct from read_page, whose row means the
  // older text-shaped page read.
  page_snapshot: "Đã đọc nhanh cấu trúc trang",
  // openspec/changes/add-sensitive-info-masking: a protective page transform
  // (mask/unmask), one activity row each.
  mask_sensitive_info: "Đã che thông tin nhạy cảm trên trang",
  // Application-owned tools, registered alongside the browser tools on the
  // same in-process MCP server (host/agent/tools/**). They are not browser
  // actions, but they arrive on the same tool-call path and would otherwise
  // show their raw wire names in the timeline.
  create_document: "Đã tạo tài liệu",
  // openspec/changes/add-page-snapshot-comparison: one label covers the
  // tool's five actions (save/list/get/delete/compare) — the activity row
  // reports the capture/compare, and `page_snapshots` stays distinct from the
  // `page_snapshot` read above.
  page_snapshots: "Đã lưu hoặc so sánh ảnh chụp trang",
  // page_monitor covers save/check/list/delete for a tracked page baseline —
  // one label spans all four actions, same pattern as page_snapshots above.
  page_monitor: "Đã lưu hoặc kiểm tra theo dõi trang",
  ask_user: "Đã hỏi người dùng"
};

const COMPUTER_ACTION_LABELS_VI = {
  screenshot: "Đã chụp trang",
  left_click: "Đã click",
  right_click: "Đã click chuột phải",
  double_click: "Đã click đúp",
  middle_click: "Đã click chuột giữa",
  triple_click: "Đã click ba lần",
  left_click_drag: "Đã kéo thả",
  type: "Đã nhập văn bản",
  key: "Đã nhấn phím",
  scroll: "Đã cuộn trang",
  wait: "Đã chờ",
  cursor_position: "Đã kiểm tra vị trí con trỏ",
  mouse_move: "Đã di chuyển con trỏ",
  hover: "Đã di chuột"
};

// Best-effort skill-name extraction from the SDK's built-in "Skill" tool
// call args (task 7.3: "Show skill start/error activity ... in the
// transcript"). The exact input shape of the pinned SDK's own Skill tool was
// not verified against a live query() call in this offline session (no
// credential/browser available — see reports/07-skills-ui-evidence.md), so
// this defensively checks the plausible field names rather than asserting
// one specific shape; the generic tool-row rendering (summarizeArgsForDetail)
// already shows the raw args underneath regardless, so nothing is hidden if
// none of these guesses match.
/**
 * Strip the SDK's MCP qualification from a tool name.
 *
 * The companion registers the browser tools on an in-process SDK MCP server,
 * so a call arrives as `mcp__<server>__<tool>` (e.g.
 * `mcp__browzy-in-chrome-browser__get_page_text`) while every label,
 * redaction rule and detail formatter below is keyed by the plain registry
 * name from host/tool-definitions.js. Without this the lookups all miss and
 * the operator sees the raw wire name instead of "Đã đọc nội dung trang".
 *
 * Deliberately server-agnostic: any `mcp__a__b` shape reduces to `b`, so a
 * renamed server cannot silently reintroduce raw names in the transcript.
 * A plain name (legacy path, built-ins like Skill) passes through untouched.
 */
export function baseToolName(toolName) {
  if (typeof toolName !== "string") return toolName;
  const m = toolName.match(/^mcp__[^_]+(?:_[^_]+)*?__(.+)$/);
  return m ? m[1] : toolName;
}

function skillNameFromArgs(args) {
  if (!args || typeof args !== "object") return null;
  for (const key of ["skill_name", "skillName", "name", "command"]) {
    const v = args[key];
    if (typeof v === "string" && v.trim()) return v.replace(/^\//, "").split(/\s/)[0];
  }
  return null;
}

/**
 * @param {string} toolName - the legacy/registered tool name (byte-identical
 *   registration id, see host/agent/tools/adapter.js's file header).
 * @param {object} args - the (already-coerced) call arguments.
 */
export function humanToolLabel(toolName, args) {
  toolName = baseToolName(toolName);
  if (toolName === "Skill") {
    const name = skillNameFromArgs(args);
    return name ? `Đã chạy skill: ${name}` : "Đã chạy một skill";
  }
  // `computer` has no static entry because its label depends on `action`.
  // Falling through when the action is missing or malformed would print the
  // raw tool name at the operator, so give it an honest generic label first.
  if (toolName === "computer" && !(args && typeof args.action === "string")) {
    return "Đã thao tác trên trang";
  }
  if (toolName === "computer" && args && typeof args.action === "string") {
    const specific = COMPUTER_ACTION_LABELS_VI[args.action];
    if (specific) {
      if (args.action === "wait" && args.duration != null) {
        return `Đã chờ ${args.duration} giây`;
      }
      return specific;
    }
    return `Đã thực hiện thao tác trình duyệt (${args.action})`;
  }
  return STATIC_LABELS_VI[toolName] || `Đã gọi công cụ ${toolName}`;
}

/** The "in progress" phrasing (present tense) shown while status is running. */
export function humanToolLabelRunning(toolName, args) {
  toolName = baseToolName(toolName);
  const done = humanToolLabel(toolName, args);
  if (toolName === "Skill") {
    const name = skillNameFromArgs(args);
    return name ? `Đang chạy skill: ${name}` : "Đang chạy một skill";
  }
  // Simple, deliberately narrow present-tense mapping for the handful of
  // labels that read oddly in the past tense while still running; anything
  // not listed keeps its past-tense phrasing with a "Đang" prefix removed
  // is not attempted here (over-engineering a Vietnamese tense transformer
  // is out of scope) -- the running state is already visually distinct via
  // the status pill ("Đang chạy") next to the label, so a past-tense verb
  // label plus a present-tense status pill is not misleading.
  if (toolName === "find") return "Đang tìm mục tiêu trên trang";
  if (toolName === "get_page_text" || toolName === "read_page") return "Đang đọc trang";
  if (toolName === "navigate") return "Đang mở trang";
  return done;
}

const SENSITIVE_KEY_RE = /pass|pwd|secret|token|otp|pin\b|credential|api[_-]?key/i;

/**
 * Redact a tool call's arguments for display: sensitive-looking field names
 * (password/token/secret/otp/etc.) are replaced with a fixed placeholder
 * rather than shown, regardless of tool. This is a display-only concern --
 * it never changes what is actually dispatched (host/tool-runtime.js still
 * receives the real args unchanged).
 */
export function redactArgsForDisplay(args) {
  if (!args || typeof args !== "object") return args;
  const out = {};
  for (const [key, value] of Object.entries(args)) {
    if (SENSITIVE_KEY_RE.test(key)) {
      out[key] = "••••••";
      continue;
    }
    // A `type` computer-action's typed text is itself potentially a
    // credential even when the field name is generic ("text"); the caller
    // (conversation-model.js) additionally checks the sibling action name
    // before deciding whether to redact `text`, since redacting every
    // typed string unconditionally would hide legitimate content too.
    out[key] = value;
  }
  return out;
}

/**
 * Whether this specific computer/form_input call's typed text should be
 * treated as sensitive input, independent of field naming: a `computer`
 * action of type "type" targeting a field the caller has flagged (via a
 * best-effort `is_sensitive`/`sensitive` argument some callers set, or a
 * coordinate-less password-labelled selector in form_input) is exactly the
 * "sensitive input" scenario the spec names. Absent any explicit signal,
 * text is shown -- there is no reliable way to detect "this looked like a
 * password field" from args alone without over-claiming a heuristic this
 * task cannot verify against a live page.
 */
export function isSensitiveTypedInput(toolName, args) {
  toolName = baseToolName(toolName);
  if (!args) return false;
  if (args.sensitive === true || args.is_sensitive === true) return true;
  if (toolName === "form_input" && typeof args.selector === "string" && /pass|pwd/i.test(args.selector)) return true;
  return false;
}

export function summarizeArgsForDetail(toolName, args) {
  toolName = baseToolName(toolName);
  const redacted = redactArgsForDisplay(args);
  if (isSensitiveTypedInput(toolName, args)) {
    if ("text" in redacted) redacted.text = "••••••";
    if ("value" in redacted) redacted.value = "••••••";
  }
  const entries = Object.entries(redacted || {}).filter(([, v]) => v !== undefined);
  if (!entries.length) return "";
  return entries.map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`).join(" · ");
}

// ---- TypeSafe Jev rows and outcome (openspec/changes/add-typesafe-jev-provider,
// design.md §8; extended by openspec/changes/add-jev-run-context, design.md
// §7/§8) --------------------------------------------------------------------
//
// A run driven by the structured-choice (Jev) runtime emits no SDK tool_use
// blocks: each of its steps is one durable `jev_step` event, and
// conversation-model.js stores that event's own fields verbatim on the row as
// `row.jev` (the wire shape is pinned by design.md §7 — { step, operation,
// intent?, evaluation?, target, targetProbability, confidence,
// targetAbstained?, runnerUpProbability?, tool, argsSummary, textField?,
// skippedReason?, latencies: { decisionMs, selectionMs?, dispatchMs },
// pageChanged, verification? }). Legacy records have two owners (design.md §10):
// `operation`/`intent`/`evaluation` are the configured model's step decision,
// `target`/`targetProbability`/`confidence`/`targetAbstained`/
// `runnerUpProbability` and `selectionMs` are the TypeSafe endpoint's element
// selection — `operationProbability` does not exist, because Jev is never
// asked about operations in that legacy protocol. New decisionSource:"jev"
// records carry actionProbability/actionConfidence and independent monitors.
// These functions are the
// equivalent of the label/detail pair above for that row kind, and they are
// total: every field is optional in practice (a step that dispatched nothing
// carries no `tool`, a rebuilt row may predate a field), so each one is
// included only when the event actually recorded it rather than rendered as a
// default the runtime never said.
//
// The same machinery now covers the second row family: a `jev_memory` event —
// the run's plan, a context revision, or a stall recovery — carries the
// event's own fields on `row.jevMemory` and is labelled by jevMemoryLabel()/
// jevMemoryDetail(). The terminal line and the `DONE` step both disclose the
// completion check's verdict: a done run the check confirmed reads as
// verified, a done run whose check could not be made reads as the decision
// model's judgment alone, and a blocked run whose done claims the check kept
// disputing reads as `completion_unverified` — never as a completion.
//
// The label is where the honesty rule bites: a step that dispatched nothing is
// labelled as exactly that, naming the runtime's own skip/rejection reason,
// and never borrows the past-tense phrasing of an action that ran (panel spec
// "Interrupted Jev run is shown honestly" — no unexecuted step is shown as if
// it had run).
const JEV_OPERATION_LABELS_VI = {
  CLICK: "Đã click",
  TYPE_TEXT: "Đã nhập văn bản",
  SELECT: "Đã chọn mục",
  HOVER: "Đã di chuột",
  NAVIGATE: "Đã điều hướng",
  SCROLL_UP: "Đã cuộn lên",
  SCROLL_DOWN: "Đã cuộn xuống",
  WAIT: "Đã chờ",
  REPLAN: "Yêu cầu lập lại kế hoạch",
  ASK: "Cần hỏi người dùng",
  DONE: "Đã báo hoàn thành",
  BLOCKED: "Đã báo không thể tiếp tục"
};

// The run-memory row vocabulary (add-jev-run-context design.md §7/§8): `kind`
// is what the configured model produced — the initial plan, a revision, or a
// stall recovery — and `trigger` is what made the runtime ask for it. Both are
// translated the same way every other Jev token is: an unknown token still
// gets an honest label naming it rather than a guess.
const JEV_MEMORY_KIND_LABELS_VI = {
  plan: "Kế hoạch lượt chạy",
  update: "Cập nhật ngữ cảnh",
  recovery: "Gỡ bế tắc"
};

const JEV_MEMORY_TRIGGER_LABELS_VI = {
  start: "khi bắt đầu",
  navigated: "trang đã chuyển",
  cadence: "đủ số thao tác",
  stall: "khi bế tắc",
  replan: "Jev yêu cầu lập lại kế hoạch",
  verification: "sau kiểm tra hoàn thành"
};

// Terminal outcome kinds (design.md §8; the bounded-run requirement adds the
// stopped/failed spellings the panel must label distinctly from a completion).
const JEV_OUTCOME_LABELS_VI = {
  done: "Đã xong",
  blocked: "Bị chặn",
  stopped: "Đã dừng",
  error: "Thất bại"
};

// EVERY reason the runtime can record, translated: the terminal `jev_end`
// reasons (blocked / stopped / error) and the `jev_step` reasons a cycle that
// dispatched nothing carries. The key set is checked against the runtime's own
// exported vocabulary (host/agent/jev/runtime.js's JEV_REASON_VOCABULARY) by
// test/sidepanel-conversation-model.test.mjs, so a reason the runtime gains
// without copy here — or a label left behind for a reason it no longer records
// — fails that suite instead of quietly rendering an English token (or nothing
// at all). A reason outside that vocabulary is still shown as the raw token: a
// wrong translation would be a claim the runtime never made, while the
// runtime's own identifier is at least exactly what it reported.
export const JEV_REASON_LABELS_VI = {
  // Blocked outcomes.
  model_blocked: "mô hình báo không thể tiếp tục",
  // Not a dead end: a question. The run stopped because only the operator can
  // resolve what stands in the way, and its answer ends with that question.
  needs_operator: "cần bạn quyết định hoặc xử lý tiếp — xem câu hỏi trong câu trả lời",
  no_progress: "thao tác liên tiếp không mang lại tiến triển (trang không đổi, hoặc cuộn mãi không có gì mới)",
  step_budget: "đã chạm giới hạn số thao tác",
  decision_budget: "đã chạm giới hạn số lần quyết định",
  action_denied: "người dùng đã từ chối thao tác",
  missing_value: "mô hình văn bản không xác định được giá trị cần nhập",
  completion_unverified: "kiểm tra hoàn thành chưa xác nhận hoặc không thực hiện được",
  preparation_failed: "LLM không chuẩn bị được kế hoạch và nội dung hợp lệ",
  replan_limit: "đã chạm giới hạn lập lại kế hoạch",
  stale_observation: "trang hoặc mục tiêu đã đổi sau khi quyết định — cần quan sát lại",
  replan: "Jev yêu cầu LLM lập lại kế hoạch",
  // Stopped outcome.
  stopped: "lượt chạy đã bị dừng",
  // Error outcomes.
  observation_failed: "không đọc được trạng thái trang",
  navigation_failed: "không mở được trang web",
  provider_error: "dịch vụ TypeSafe gặp lỗi",
  invalid_decision: "câu trả lời của TypeSafe không hợp lệ",
  text_model_error: "mô hình văn bản gặp lỗi",
  tool_result_unknown: "mất phản hồi sau khi thao tác đã được gửi đi",
  // Step-level reasons: a cycle whose dispatch was refused or skipped.
  done: "mô hình đã báo hoàn thành",
  completion_rejected: "kiểm tra hoàn thành chưa xác nhận — chưa tính là hoàn thành",
  target_unresolved: "mục tiêu đã chọn không còn trong không gian thao tác",
  unsupported_operation: "thao tác đã chọn không thể thực thi",
  result_unknown: "mất phản hồi sau khi thao tác đã được gửi đi",
  repeated_no_change: "lặp lại y hệt thao tác vừa không có hiệu quả — không gửi lại"
};

function jevReasonTextVi(reason) {
  if (typeof reason !== "string" || !reason) return "";
  return JEV_REASON_LABELS_VI[reason] || reason;
}

function jevOperationLabelVi(operation) {
  const token = typeof operation === "string" ? operation.trim() : "";
  if (!token) return "Đã thực hiện một thao tác";
  return JEV_OPERATION_LABELS_VI[token.toUpperCase()] || `Đã thực hiện thao tác ${token}`;
}

/** A probability/confidence exactly as recorded, at no more precision than the
 * event's own number carries (0.82 stays "0.82", 0.9134 becomes "0.913"). */
function jevNumberText(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return String(Number(value.toFixed(3)));
}

function jevMsText(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return `${Math.round(value)}ms`;
}

/** The row label for one Jev step. Legacy steps have two owners (design.md §10):
 * the configured model decided the operation (and, when the operation needs an
 * element, the intent naming it), and the TypeSafe endpoint selected the
 * element — so the label names both, and neither can read as the other's work.
 * A step that dispatched nothing keeps the explicit "nothing was sent"
 * framing and carries the runtime's reason; when it never got as far as a
 * selected element, the model's own intent is what names the element it was
 * after, so it is shown there instead. An abstained selection — one that WAS
 * received and validated but named no clear winner (`targetAbstained`) — gets
 * its own wording naming low selection confidence: it must read as a skip,
 * never as a failure, and stay visibly distinct from the plain
 * "no compatible candidate" case (panel spec "A low-confidence skip reads as
 * a skip"). */
export function jevStepLabel(jev) {
  const step = jev || {};
  const owner = step.decisionSource === "jev" ? "Jev" : "mô hình";
  const target = step.target && typeof step.target.label === "string" ? step.target.label : "";
  const intent = typeof step.intent === "string" && step.intent.trim() ? step.intent.trim() : "";
  if (step.dispatched === true && (step.actionOutcome === "unknown" || step.skippedReason === "result_unknown")) {
    return `Đã gửi thao tác ${step.operation || ""} — chưa xác định kết quả${target ? `: ${target}` : ""}`;
  }
  if (step.dispatched === true && step.actionOutcome === "failed") {
    return `Thao tác ${step.operation || ""} thất bại${target ? `: ${target}` : ""}`;
  }
  if (step.skippedReason) {
    // DONE is the run's success path and reads as the outcome it is — the
    // old phrasing ("Chưa gửi thao tác nào (quyết định DONE): mô hình đã báo
    // hoàn thành") truncated mid-word in the row and looked like a failure.
    // The "not executed" truth is already carried by the row's own status
    // chip, so the label names the decision instead. A DONE the completion
    // check confirmed says exactly that; a rejected `DONE` claim never
    // arrives here (the runtime records it as `completion_rejected`, handled
    // by the generic branch below) so it can never read as a completion.
    if (step.skippedReason === "done") {
      const verified = step.verification && typeof step.verification === "object" && step.verification.achieved === true;
      if (step.verificationTrigger === "repeated_submission") {
        return verified ? "Kiểm tra trước khi gửi lại — hoàn thành đã được xác nhận" : "Kiểm tra trước khi gửi lại — chưa xác nhận hoàn thành";
      }
      return verified ? "Quyết định DONE — hoàn thành đã được kiểm chứng" : "Quyết định DONE — mô hình báo xong";
    }
    const wanted = target ? ` → Jev chọn: ${target}` : intent ? ` — ý định: ${intent}` : "";
    const decision = step.operation ? `${owner} quyết định ${step.operation}${wanted}` : "";
    // A validated-but-unresolved selection: the runtime's `target_unresolved`
    // reason is shared with "no compatible candidate at all", so the wording
    // is not borrowed from `JEV_REASON_LABELS_VI` here — it is its own
    // sentence naming low selection confidence, kept under the neutral "Bỏ
    // qua" (skipped) framing rather than "Chưa gửi thao tác nào" so the two
    // cases never render the same text.
    if (step.skippedReason === "target_unresolved" && step.targetAbstained === true) {
      const head = decision ? `Bỏ qua bước (${decision})` : "Bỏ qua bước";
      return `${head}: độ tin cậy chọn ${step.decisionSource === "jev" ? "hành động" : "mục tiêu"} thấp, Jev không đủ chắc chắn nên không chọn`;
    }
    const reason = jevReasonTextVi(step.skippedReason);
    const head = decision ? `Chưa gửi thao tác nào (${decision})` : "Chưa gửi thao tác nào";
    return reason ? `${head}: ${reason}` : head;
  }
  const base = jevOperationLabelVi(step.operation);
  const decided = `${base} (${owner} quyết định)`;
  return target ? `${decided} — Jev chọn: ${target}` : decided;
}

/** The expandable detail for one Jev step, retaining legacy attribution.
 * Decision-layer records identify Jev action scores and advisory monitors.
 * The legacy decision facts an operator
 * needs to judge it — which operation the configured model decided, the
 * intent it named, its evaluation of the step before it, the element Jev
 * selected (offered index and label) with its probability, the recorded
 * confidence, the runner-up probability an abstained selection named, the
 * executed tool and its argument summary, the text field a generated value
 * was written to, the completion check's verdict on a `DONE` step, whether the
 * page actually changed, and the per-stage latencies (the step decision, the
 * element selection when one was made, and the dispatch). Legacy records
 * carry no action probability (design.md §10).
 * Separators match summarizeArgsForDetail()'s " · " because the row detail is
 * rendered as one escaped plain-text line. */
export function jevStepDetail(jev) {
  const step = jev || {};
  const actionDecision = step.decisionSource === "jev";
  const parts = [];
  if (step.dispatched === true && step.actionOutcome === "failed") parts.push(`Lỗi thao tác: ${step.actionError?.code === "TARGET_OBSTRUCTED" ? "mục tiêu bị che khuất" : step.actionError?.message ? String(step.actionError.message).slice(0, 200) : "công cụ báo không thực hiện được"}`);
  if (Number.isInteger(step.step)) parts.push(`bước ${step.step}`);
  parts.push(`${actionDecision ? "Jev" : "mô hình"} quyết định: ${step.operation || "(không rõ)"}`);
  const intent = typeof step.intent === "string" && step.intent.trim() ? step.intent.trim() : "";
  if (intent) parts.push(`ý định: ${intent}`);
  // The decision's own bounded reading of the step before it (design.md §6):
  // what that step was meant to achieve and whether this observation shows it
  // did. Rendered the same way `intent` is — one line, present only when the
  // event actually carried it.
  const evaluation = typeof step.evaluation === "string" && step.evaluation.trim() ? step.evaluation.trim() : "";
  if (evaluation) parts.push(`đánh giá bước trước: ${evaluation}`);
  const target = step.target && typeof step.target === "object" ? step.target : null;
  // "Jev chọn" is claimed only when the selection recorded something to name:
  // a target object with neither an offered index nor a label renders nothing
  // rather than an empty attribution.
  if (target && (target.index != null || (typeof target.label === "string" && target.label))) {
    const selection = ["Jev chọn"];
    if (target.index != null) selection.push(`#${target.index}`);
    if (typeof target.label === "string" && target.label) selection.push(`nhãn: ${target.label}`);
    parts.push(selection.join(" · "));
  }
  const targetProbability = jevNumberText(step.targetProbability);
  if (targetProbability && !actionDecision) parts.push(`xác suất mục tiêu: ${targetProbability}`);
  const actionProbability = jevNumberText(step.actionProbability);
  if (actionDecision && actionProbability) parts.push(`xác suất hành động: ${actionProbability}`);
  const confidence = jevNumberText(actionDecision ? (step.actionConfidence ?? step.confidence) : step.confidence);
  if (confidence) parts.push(`độ tin cậy${actionDecision ? " hành động" : ""}: ${confidence}`);
  if (actionDecision) {
    for (const [name, label] of [["goalDone", "có thể đã đạt mục tiêu"], ["stuck", "có thể đang bế tắc"]]) {
      const monitor = step.monitors?.[name];
      const choice = monitor?.choice === "yes" ? true : monitor?.choice === "no" ? false : step[name];
      if (typeof choice === "boolean") parts.push(`Jev theo dõi ${label}: ${choice ? "có" : "không"} (tín hiệu tham khảo)`);
    }
  }
  // Only an abstained selection carries a runner-up probability at all (the
  // "no compatible candidate" skip never reaches a selection to have one), so
  // this line is itself part of what tells the two skip kinds apart.
  const runnerUpProbability = jevNumberText(step.runnerUpProbability);
  if (runnerUpProbability) parts.push(`xác suất á quân: ${runnerUpProbability}`);
  if (step.tool) {
    const args = typeof step.argsSummary === "string" ? step.argsSummary : step.argsSummary && typeof step.argsSummary === "object" ? summarizeArgsForDetail(step.tool, step.argsSummary) : "";
    parts.push(`công cụ: ${step.tool}${args ? ` · ${args}` : ""}`);
  }
  if (step.textField) parts.push(`trường văn bản: ${step.textField}`);
  if (step.skippedReason) {
    // See jevStepLabel(): the abstained case shares the runtime's
    // `target_unresolved` reason with "no compatible candidate at all", so it
    // gets its own sentence here too rather than the shared
    // `JEV_REASON_LABELS_VI` text, keeping the two skip kinds distinguishable
    // in the detail as well as the label.
    if (step.skippedReason === "target_unresolved" && step.targetAbstained === true) {
      parts.push(`không gửi thao tác: độ tin cậy chọn ${actionDecision ? "hành động" : "mục tiêu"} thấp, Jev không đủ chắc chắn nên không chọn`);
    } else {
      const reason = jevReasonTextVi(step.skippedReason);
      parts.push(reason ? `không gửi thao tác: ${reason}` : "không gửi thao tác nào");
    }
  }
  // The completion check's verdict on a `DONE` step (add-jev-run-context
  // design.md §7): confirmed, disputed (the loop continues), or the check
  // could not be made at all — the last one without claiming a verdict it
  // never reached.
  const verification = step.verification && typeof step.verification === "object" ? step.verification : null;
  if (verification) {
    if (verification.achieved === true) parts.push("kiểm tra hoàn thành: đã xác nhận");
    else if (verification.achieved === false) parts.push("kiểm tra hoàn thành: chưa xác nhận — chưa tính là hoàn thành");
    else {
      const error = typeof verification.error === "string" && verification.error ? verification.error : "";
      parts.push(`kiểm tra hoàn thành: không thực hiện được${error ? ` (${error})` : ""}`);
    }
  }
  if (typeof step.pageChanged === "boolean") {
    parts.push(step.pageChanged ? "trang đã thay đổi sau thao tác" : "trang không thay đổi sau thao tác");
  }
  // What the element selection ran against — the element table the
  // observation offered Jev, bounded as recorded: the count, what the bound
  // cut, and a sample of the offered names. This is the "what was actually on
  // offer" line an operator needs to judge a selection (and to tell "the
  // control was never offered" from "the model chose poorly").
  const observed = step.observed && typeof step.observed === "object" ? step.observed : null;
  if (observed) {
    const bits = [];
    if (Number.isFinite(observed.elements)) bits.push(`${observed.elements} phần tử`);
    const omitted = observed.omitted && typeof observed.omitted === "object" ? observed.omitted : null;
    const omittedTotal = omitted ? (Number(omitted.elements) || 0) + (Number(omitted.selectOptions) || 0) : 0;
    if (omittedTotal > 0) bits.push(`bị cắt ${omittedTotal}`);
    if (bits.length) parts.push(`quan sát: ${bits.join(", ")}`);
    if (Array.isArray(observed.sample) && observed.sample.length) {
      const sample = observed.sample.filter((s) => typeof s === "string" && s).slice(0, 8);
      if (sample.length) parts.push(`mẫu: ${sample.join(" · ")}`);
    }
  }
  const latencies = step.latencies && typeof step.latencies === "object" ? step.latencies : null;
  if (latencies) {
    const stages = [];
    const decisionMs = jevMsText(latencies.decisionMs);
    if (decisionMs) stages.push(`quyết định ${decisionMs}`);
    const selectionMs = jevMsText(latencies.selectionMs);
    if (selectionMs) stages.push(`chọn phần tử ${selectionMs}`);
    const dispatchMs = jevMsText(latencies.dispatchMs);
    if (dispatchMs) stages.push(`thực thi ${dispatchMs}`);
    if (stages.length) parts.push(`thời gian: ${stages.join(" · ")}`);
  }
  return parts.join(" · ");
}

/** The row label for one recorded run-memory event (plan, revision, or stall
 * recovery): the kind the configured model produced plus what triggered it.
 * An unmapped kind/trigger token is still named — the row always says what the
 * event actually recorded, never a default the runtime did not send. */
export function jevMemoryLabel(jevMemory) {
  const record = jevMemory || {};
  const kindToken = typeof record.kind === "string" ? record.kind.trim() : "";
  const kind = JEV_MEMORY_KIND_LABELS_VI[kindToken] || (kindToken ? `Bản ghi ngữ cảnh: ${kindToken}` : "Bản ghi ngữ cảnh");
  const triggerToken = typeof record.trigger === "string" ? record.trigger.trim() : "";
  const trigger = JEV_MEMORY_TRIGGER_LABELS_VI[triggerToken] || (triggerToken ? `lúc ${triggerToken}` : "");
  return trigger ? `${kind} — ${trigger}` : kind;
}

/** The expandable detail for one run-memory row: the model-written context
 * itself — plan, completion condition, notes — exactly as the event recorded
 * it, plus the record's own index and the call's latency. Nothing is merged,
 * summarized, or invented here: these are the run's own words. */
export function jevMemoryDetail(jevMemory) {
  const record = jevMemory || {};
  const parts = [];
  if (Number.isInteger(record.index)) parts.push(`bản ghi ${record.index}`);
  const memory = record.memory && typeof record.memory === "object" ? record.memory : null;
  if (memory) {
    if (typeof memory.plan === "string" && memory.plan) parts.push(`kế hoạch: ${memory.plan}`);
    if (typeof memory.doneWhen === "string" && memory.doneWhen) parts.push(`điều kiện hoàn thành: ${memory.doneWhen}`);
    if (typeof memory.notes === "string" && memory.notes) parts.push(`ghi chú: ${memory.notes}`);
  }
  const latencyMs = jevMsText(record.latencyMs);
  if (latencyMs) parts.push(`thời gian: ${latencyMs}`);
  return parts.join(" · ");
}

/** The run's terminal line, rendered under the turn in the panel: the outcome
 * kind, the reason the runtime gave, and the recorded step count. A `done`
 * outcome is disclosed for what it is (add-jev-run-context design.md §7/§8):
 * `doneVerified === true` reads as a completion the completion check
 * confirmed; `false` — the check could not be made — reads as the decision
 * model's judgment alone, the same disclosure a `DONE` carried before the
 * check existed. A recorded `summaryError` adds which of the two disclosed
 * failures happened — a confirmation that produced no usable report, or a
 * check that could not be made at all — as bounded Vietnamese copy; the raw
 * error text is never printed on the line. An event with no `doneVerified` at
 * all (a record from an older host, or an older transcript) keeps that older
 * rule verbatim, so a replayed record is never described as verified by a
 * field it does not carry. */
export function jevOutcomeLineVi(jev) {
  const end = jev || {};
  const outcome = typeof end.outcome === "string" ? end.outcome : "";
  const parts = [JEV_OUTCOME_LABELS_VI[outcome] || (outcome ? `Kết thúc: ${outcome}` : "Kết thúc")];
  const failedSummary = typeof end.summaryError === "string" && end.summaryError !== "";
  if (outcome === "done") {
    if (end.doneVerified === true) {
      parts.push(failedSummary ? "kiểm tra hoàn thành đã xác nhận, nhưng không tạo được báo cáo" : "kiểm tra hoàn thành đã xác nhận");
    } else if (end.doneVerified === false) {
      parts.push(
        failedSummary
          ? "theo quyết định của mô hình, chưa được kiểm chứng độc lập (không thực hiện được kiểm tra hoàn thành)"
          : "theo quyết định của mô hình, chưa được kiểm chứng độc lập"
      );
    } else if (end.doneIsDecided !== false) {
      parts.push("theo quyết định của mô hình, chưa được kiểm chứng độc lập");
    }
  }
  const reason = jevReasonTextVi(end.reason);
  if (reason) parts.push(`lý do: ${reason}`);
  // Every finished run owes the operator an answer; when one was not produced
  // the turn says so, instead of looking like a reply that happens to be
  // empty. `null` is a record from a host that predates the field.
  if (end.hasResult === false) parts.push("không tạo được câu trả lời cho lượt này");
  if (Number.isInteger(end.steps)) parts.push(`${end.steps} bước`);
  return parts.join(" · ");
}
