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
// schemas, only how a call is DESCRIBED to a human.

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
  // Application-owned tools, registered alongside the browser tools on the
  // same in-process MCP server (host/agent/tools/**). They are not browser
  // actions, but they arrive on the same tool-call path and would otherwise
  // show their raw wire names in the timeline.
  create_document: "Đã tạo tài liệu",
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
  mouse_move: "Đã di chuyển con trỏ"
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
