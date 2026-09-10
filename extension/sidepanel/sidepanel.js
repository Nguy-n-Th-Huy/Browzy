// DOM wiring for extension/sidepanel/sidepanel.html. This is the ONLY file
// in extension/sidepanel/** that touches `document`/`chrome.tabs`/
// `chrome.runtime` directly for the main chat flow — every actual decision
// (state transitions, dedup, redaction, phase derivation) lives in the
// DOM-free modules it imports, which is what test/sidepanel-*.test.mjs
// exercises directly.

import { iconMarkup } from "../ui/icons.js";
import { ProtocolClient, MSG } from "./protocol-client.js";
import { PanelController } from "./panel-controller.js";
import { HistoryStore } from "./history-store.js";
import { ProfileCache, READINESS } from "./profile-cache.js";
import { PageContextTracker } from "./page-context.js";
import { referencesCurrentPage } from "./context-binding.js";
import { RecordingsClient, listRecordings } from "./recordings-model.js";
import { toolRowDisplay } from "./conversation-model.js";
import { RUN_PHASE, PHASE_LABEL_VI, BUSY_LABEL_VI, phaseVisualClass } from "./run-states.js";
import { renderMarkdownLite, escapeHtml } from "./markdown-lite.js";
import { createPanelSkillsClient } from "./skills-client.js";
import { buildPickerItems, filterPickerItems, parseSlashQuery, buildInvocationText } from "./skills-model.js";
import { FORMAT_LABELS as DOCUMENT_FORMAT_LABELS, EXTRACTED_PREVIEW_FORMATS, buildPreview, buildMarkdown } from "./document-viewer.js";

const $ = (id) => document.getElementById(id);

const el = {
  connectionState: $("connection-state"),
  connectionLabel: $("connection-label"),
  btnHistory: $("btn-history"),
  btnSettings: $("btn-settings"),
  panelScroll: $("panel-scroll"),
  transcript: $("transcript"),
  emptyStateSlot: $("empty-state-slot"),
  phaseAnnouncer: $("phase-announcer"),
  setupBannerSlot: $("setup-banner-slot"),
  permissionSlot: $("permission-slot"),
  questionSlot: $("question-slot"),
  contextChipRow: $("context-chip-row"),
  composerWrap: $("composer-wrap"),
  composerInput: $("composer-input"),
  btnAdd: $("btn-add"),
  addMenuWrap: $("add-menu-wrap"),
  addMenuFiles: $("add-menu-files"),
  iconAddFiles: $("icon-add-files"),
  effortTrigger: $("effort-trigger"),
  effortTriggerLabel: $("effort-trigger-label"),
  effortMenu: $("effort-menu"),
  effortMenuWrap: $("effort-menu-wrap"),
  modelTrigger: $("model-trigger"),
  modelTriggerLabel: $("model-trigger-label"),
  modelChevron: $("model-chevron"),
  modelMenu: $("model-menu"),
  modelMenuWrap: $("model-menu-wrap"),
  btnEnhance: $("btn-enhance"),
  btnSend: $("btn-send"),
  slashPicker: $("slash-picker"),
  historyView: $("history-view"),
  chatView: $("chat-view"),
  btnHistoryBack: $("btn-history-back"),
  btnNewChat: $("btn-new-chat"),
  btnHistoryNew: $("btn-history-new"),
  iconNewPlus: $("icon-new-plus"),
  conversationList: $("conversation-list"),
  recordingList: $("recording-list"),
  recorderStatusLabel: $("recorder-status-label"),
  btnToggleRecording: $("btn-toggle-recording"),
  iconMicRow: $("icon-mic-row")
};

el.btnNewChat.innerHTML = iconMarkup("plus", { size: 18, title: "Trò chuyện mới, không gắn trang nào" });
el.btnHistory.innerHTML = iconMarkup("history", { size: 18, title: "Lịch sử trò chuyện và bản ghi" });
el.btnSettings.innerHTML = iconMarkup("settings", { size: 18, title: "Cài đặt" });
el.btnHistoryBack.innerHTML = iconMarkup("chevronRight", { size: 18, title: "Quay lại cuộc trò chuyện" });
el.btnHistoryBack.style.transform = "scaleX(-1)";
el.iconNewPlus.innerHTML = iconMarkup("plus", { size: 15 });
el.btnAdd.innerHTML = iconMarkup("plus", { size: 18, title: "Thêm tệp hoặc ảnh" });
el.iconAddFiles.innerHTML = iconMarkup("attach", { size: 15 });
el.btnEnhance.innerHTML = iconMarkup("spark", { size: 18, title: "Cải thiện prompt" });
el.modelChevron.innerHTML = iconMarkup("chevronDown", { size: 14 });
el.iconMicRow.innerHTML = iconMarkup("mic", { size: 18 });

// `anchor`, when given, is an element id ALREADY present in
// extension/settings/settings.html (e.g. "btn-test-connection") — a plain
// URL fragment matching an element id makes the browser scroll it into view
// natively on navigation, with no change needed to the settings page itself
// (extension/settings/** is out of this task's scope; see renderSetupBanner()
// below for why a not-ready reason that's fixable by (re)testing links
// straight to that control instead of a generic "open settings").
function openSettings(anchor) {
  const url = chrome.runtime.getURL("settings/settings.html") + (anchor ? `#${anchor}` : "");
  chrome.tabs.create({ url });
}
el.btnSettings.addEventListener("click", () => openSettings());

const historyStore = new HistoryStore();
const profileCache = new ProfileCache();
const recordingsClient = new RecordingsClient();
const protocolClient = new ProtocolClient();
const panel = new PanelController({
  protocolClient,
  historyStore,
  profileCache,
  // Production: no separate hello from this panel — see panel-controller.js's
  // init() for why (background.js's own "ocic-agent" relay already performs
  // the real hello and replays current handshake state to a late-connecting
  // port).
  identity: async () => ({})
});

let pageContext = null;

async function currentWindowId() {
  try {
    const win = await chrome.windows.getCurrent();
    return win.id;
  } catch {
    return null;
  }
}

// ---- rendering -------------------------------------------------------

// What the connection pill says when the handshake failed for a reason the
// operator can actually act on. "Lỗi kết nối" is true but useless here: it
// describes a symptom the operator cannot distinguish from a slow start, and
// on a machine where the companion was never installed it would sit there for
// the life of the browser. Naming the missing step is the difference between
// a dead-end and a next action.
const HANDSHAKE_LABEL_VI = Object.freeze({
  companion_not_installed: "Chưa cài companion",
  native_host_unavailable: "Companion chưa chạy",
  unsupported_version: "Companion sai phiên bản"
});

function renderConnectionState() {
  const phase = panel.currentPhase();
  const cls = phaseVisualClass(phase);
  el.connectionState.className = "connection-state" + (cls ? ` ${cls}` : "");
  // A handshake detail, when there is one, is strictly more specific than the
  // phase label — the phase only says "error".
  const detail = phase === RUN_PHASE.ERROR ? panel.protocol.handshakeDetail() : null;
  const label = (detail && HANDSHAKE_LABEL_VI[detail]) || PHASE_LABEL_VI[phase] || phase;
  el.connectionLabel.textContent = label;
  el.connectionState.title =
    detail === "companion_not_installed"
      ? "Máy này chưa đăng ký native messaging host. Chạy install.ps1 (Windows) hoặc ./install.sh (macOS/Linux) trong thư mục dự án, rồi tải lại extension."
      : "";
}

// Vietnamese labels for the three capability-test sub-checks (matches
// extension/settings/settings-app.js's own `capability-detail` pill labels
// — "text"/"tool"/"vision" — kept as a small local mapping rather than an
// import so this module stays decoupled from extension/settings/**, which
// is out of scope for this task).
const CAPABILITY_LABEL_VI = { text: "văn bản", tool: "công cụ", vision: "hình ảnh" };

function settingsButton(label) {
  const btn = document.createElement("button");
  btn.className = "btn btn-secondary btn-sm";
  btn.type = "button";
  btn.textContent = label || "Mở cài đặt";
  btn.addEventListener("click", () => openSettings());
  return btn;
}

// A "direct control that takes the user to Settings' Test connection" (task
// requirement) rather than a generic "Mở cài đặt" the user then has to hunt
// through — see openSettings()'s header comment for how the anchor works.
function testConnectionButton(label) {
  const btn = document.createElement("button");
  btn.className = "btn btn-secondary btn-sm";
  btn.type = "button";
  btn.textContent = label || "Kiểm tra kết nối";
  btn.addEventListener("click", () => openSettings("btn-test-connection"));
  return btn;
}

// Replaces the single collapsed "unconfigured" message with the six
// distinct not-ready reasons panel-controller.js's readinessState() (backed
// by profile-cache.js's deriveReadinessState()) tells apart. Running the
// assistant still requires a PASSING capability test for the CURRENT
// endpoint/model/credential in every case below except READY — a stale or
// failed test is never treated as ready.
function renderSetupBanner() {
  el.setupBannerSlot.innerHTML = "";
  const readiness = panel.readinessState();
  if (readiness.state === READINESS.READY) return;

  const div = document.createElement("div");
  div.className = "setup-banner";
  const p = document.createElement("p");
  div.appendChild(p);
  let actionBtn;

  switch (readiness.state) {
    case READINESS.PARTIAL: {
      const missingLabel = readiness.missing === "defaultModel" ? "chọn một mô hình mặc định" : "thêm ít nhất một mô hình";
      p.innerHTML = `<strong>Cấu hình chưa đầy đủ.</strong> Đã lưu Base URL/API key nhưng cần ${missingLabel} trong Cài đặt trước khi trò chuyện.`;
      actionBtn = settingsButton();
      break;
    }
    case READINESS.NO_CREDENTIAL:
      p.innerHTML = `<strong>Chưa lưu API key.</strong> Thêm API key trong Cài đặt trước khi bắt đầu trò chuyện.`;
      actionBtn = settingsButton();
      break;
    case READINESS.UNTESTED:
      p.innerHTML = `<strong>Chưa kiểm tra kết nối.</strong> Đã cấu hình đầy đủ, nhưng cần kiểm tra kết nối trước khi trò chuyện.`;
      actionBtn = testConnectionButton();
      break;
    case READINESS.STALE: {
      const reasonText =
        readiness.reason === "credential"
          ? "API key đã thay đổi kể từ lần kiểm tra gần nhất"
          : "Base URL hoặc mô hình đã thay đổi kể từ lần kiểm tra gần nhất";
      p.innerHTML = `<strong>Cần kiểm tra lại kết nối.</strong> ${reasonText} — kiểm tra lại trước khi trò chuyện.`;
      actionBtn = testConnectionButton("Kiểm tra lại kết nối");
      break;
    }
    case READINESS.TEST_FAILED: {
      const failed = Object.entries(readiness.capabilities || {})
        .filter(([, v]) => v === "fail")
        .map(([k]) => CAPABILITY_LABEL_VI[k] || k);
      const detail = failed.length ? ` (không đạt: ${failed.join(", ")})` : "";
      p.innerHTML = `<strong>Kiểm tra kết nối gần nhất thất bại${escapeHtml(detail)}.</strong> Sửa cấu hình rồi kiểm tra lại trước khi trò chuyện.`;
      actionBtn = testConnectionButton("Kiểm tra lại kết nối");
      break;
    }
    case READINESS.NOT_CONFIGURED:
    default:
      p.innerHTML = `<strong>Chưa cấu hình nhà cung cấp.</strong> Thêm Base URL, API key và chọn model trong Cài đặt để bắt đầu trò chuyện.`;
      actionBtn = settingsButton();
      break;
  }

  div.appendChild(actionBtn);
  el.setupBannerSlot.appendChild(div);
}

// Reasoning-effort levels, mirroring host/agent/protocol.js's EFFORT_LEVELS.
// The leading null is the deliberate default: it sends no effort parameter at
// all, so the model's own default applies. That is NOT the same as pinning the
// level to whatever that default happens to be today, which is why "Tự động"
// is a real choice here rather than a synonym for "High".
// The labels themselves stay in English: they are the API's own level names,
// and translating one would leave the operator guessing which level a
// provider's docs mean. The tooltips carry the explanation.
const EFFORT_CHOICES = [
  { value: null, label: "Auto", hint: "Để model tự quyết" },
  { value: "low", label: "Low", hint: "Suy luận tối thiểu, trả lời nhanh nhất" },
  { value: "medium", label: "Medium", hint: "Suy luận vừa phải" },
  { value: "high", label: "High", hint: "Suy luận sâu" },
  { value: "xhigh", label: "Xhigh", hint: "Sâu hơn High" },
  { value: "max", label: "Max", hint: "Chỉ một số model hỗ trợ" }
];
const EFFORT_STORAGE_KEY = "composerEffort";

// Chosen once and kept for the panel, the same way the model choice is: an
// effort level is a working preference, not a per-message decision, and having
// it silently reset between turns would make a run's depth unpredictable.
let selectedEffort = null;

function renderEffortMenu() {
  const current = EFFORT_CHOICES.find((c) => c.value === selectedEffort) || EFFORT_CHOICES[0];
  el.effortTriggerLabel.textContent = current.label;
  el.effortTrigger.title = current.hint;
  el.effortMenu.innerHTML = "";
  for (const choice of EFFORT_CHOICES) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "menu-item";
    btn.setAttribute("role", "menuitem");
    btn.setAttribute("aria-selected", String(choice.value === selectedEffort));
    btn.title = choice.hint;
    btn.textContent = choice.label;
    btn.addEventListener("click", () => {
      selectedEffort = choice.value;
      persistEffort();
      el.effortMenuWrap.close?.();
      renderEffortMenu();
    });
    el.effortMenu.appendChild(btn);
  }
}

function persistEffort() {
  try {
    localStorage.setItem(EFFORT_STORAGE_KEY, selectedEffort === null ? "" : selectedEffort);
  } catch {
    // Private mode, or storage refused: the choice still holds for this panel.
  }
}

function restoreEffort() {
  try {
    const stored = localStorage.getItem(EFFORT_STORAGE_KEY);
    // An empty string is the stored form of "Tự động"; an unknown value (an
    // older or newer build wrote it) falls back to it rather than being sent.
    if (stored && EFFORT_CHOICES.some((c) => c.value === stored)) selectedEffort = stored;
  } catch {}
  renderEffortMenu();
}

function renderModelMenu() {
  const models = (panel.profile && panel.profile.models) || [];
  el.modelMenu.innerHTML = "";
  if (!models.length) {
    el.modelTriggerLabel.textContent = "Chưa có model";
    const empty = document.createElement("div");
    empty.className = "field-hint";
    empty.style.padding = "8px 12px";
    empty.textContent = "Cấu hình model trong Cài đặt.";
    el.modelMenu.appendChild(empty);
    return;
  }
  const selectedId = panel._selectedModelId || (panel.profile && panel.profile.defaultModelId);
  const selected = models.find((m) => m.id === selectedId) || models[0];
  el.modelTriggerLabel.textContent = selected ? selected.label || selected.id : "Model";
  for (const m of models) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "menu-item";
    btn.setAttribute("role", "menuitem");
    btn.setAttribute("aria-selected", String(m.id === selected?.id));
    btn.textContent = m.label || m.id;
    btn.addEventListener("click", () => {
      panel._selectedModelId = m.id;
      el.modelMenuWrap.close?.();
      renderModelMenu();
    });
    el.modelMenu.appendChild(btn);
  }
}

// Set by doSend() when page-context.js's captureForSend() finds the
// authoritative live tab disagreed with what the chip was showing (design.md
// 5b: "If UI and host revisions disagree, refresh the chip before dispatch
// instead of submitting against an invisible target"). Cleared the next time
// the chip renders anything else so it never lingers past the one refresh
// it describes.
let contextStaleNotice = null;

function renderContextChip() {
  el.contextChipRow.innerHTML = "";
  if (!pageContext) return;
  const snap = pageContext.snapshot();

  if (contextStaleNotice) {
    const notice = document.createElement("div");
    notice.className = "context-stale-notice";
    notice.setAttribute("role", "status");
    notice.innerHTML = `${iconMarkup("alertTriangle", { size: 14 })}<span></span>`;
    notice.querySelector("span").textContent = contextStaleNotice;
    el.contextChipRow.appendChild(notice);
  }

  if (!snap) {
    if (pageContext.wasExplicitlyRemoved()) {
      const addBtn = document.createElement("button");
      addBtn.type = "button";
      addBtn.className = "chip chip-add-context";
      addBtn.innerHTML = `<span class="chip-icon">${iconMarkup("plus", { size: 12 })}</span><span class="chip-label">Thêm ngữ cảnh trang</span>`;
      addBtn.addEventListener("click", () => pageContext.unpin()); // unpin() re-resolves from the active tab regardless of prior pin state
      el.contextChipRow.appendChild(addBtn);
    }
    return;
  }

  const chip = document.createElement("span");
  chip.className = "chip" + (snap.restricted ? " chip-restricted" : "");
  const label = snap.hostname ? `${snap.hostname}${snap.title ? ` — ${snap.title}` : ""}` : snap.title;
  chip.innerHTML = `<span class="chip-icon">${iconMarkup(snap.restricted ? "alertTriangle" : "page", { size: 12 })}</span><span class="chip-label"></span>`;
  chip.querySelector(".chip-label").textContent = snap.restricted ? `${label || ""} — không thể đọc` : label || "";
  if (snap.restricted) chip.title = "Trang trình duyệt/nội bộ — Browzy không thể đọc nội dung trang này.";
  el.contextChipRow.appendChild(chip);

  const hasText = el.composerInput.value.trim().length > 0;
  if (!snap.restricted && hasText && referencesCurrentPage(el.composerInput.value)) {
    const hint = document.createElement("span");
    hint.className = "context-read-hint";
    hint.textContent = "Sẽ đọc trang này";
    el.contextChipRow.appendChild(hint);
  }

  const pinBtn = document.createElement("button");
  pinBtn.className = "btn-icon";
  pinBtn.style.marginLeft = "auto";
  pinBtn.setAttribute("aria-label", snap.pinned ? "Bỏ ghim ngữ cảnh trang" : "Ghim trang này");
  pinBtn.innerHTML = iconMarkup(snap.pinned ? "pinOff" : "pin", { size: 16 });
  pinBtn.addEventListener("click", () => {
    if (snap.pinned) pageContext.unpin();
    else pageContext.pinCurrent();
  });
  el.contextChipRow.appendChild(pinBtn);

  const clearBtn = document.createElement("button");
  clearBtn.className = "btn-icon";
  clearBtn.setAttribute("aria-label", "Xóa ngữ cảnh trang");
  clearBtn.innerHTML = iconMarkup("close", { size: 16 });
  clearBtn.addEventListener("click", () => pageContext.clear());
  el.contextChipRow.appendChild(clearBtn);
}

function renderPermission() {
  el.permissionSlot.innerHTML = "";
  const model = panel.currentModel();
  if (!model || !model.pendingApproval) return;
  const { action, target } = model.pendingApproval;
  const card = document.createElement("div");
  card.className = "permission-card";
  card.setAttribute("role", "alertdialog");
  card.setAttribute("aria-label", "Yêu cầu cấp quyền");
  card.innerHTML = `
    <div class="permission-card-head">
      <span class="permission-card-icon">${iconMarkup("alertTriangle", { size: 18 })}</span>
      <div>
        <p class="permission-card-title">Cần cấp quyền: ${escapeHtml(action || "")}</p>
        <p class="permission-card-detail">Hành động này nằm ngoài phạm vi đã được cho phép của cuộc trò chuyện.</p>
      </div>
    </div>
    <div class="permission-card-target"></div>
    <div class="permission-card-actions">
      <button class="btn btn-ghost btn-sm" type="button" id="__deny">Từ chối</button>
      <button class="btn btn-primary btn-sm" type="button" id="__allow">Cho phép</button>
    </div>
  `;
  card.querySelector(".permission-card-target").textContent = target ? JSON.stringify(target) : "(không có mục tiêu cụ thể)";
  card.querySelector("#__allow").addEventListener("click", () => panel.respondApproval("approve"));
  card.querySelector("#__deny").addEventListener("click", () => panel.respondApproval("deny"));
  el.permissionSlot.appendChild(card);
}

// Task 9.7: ask-the-user question card. Mirror-image of renderPermission —
// shows the question, header, and 2-4 option buttons with keyboard
// Tab/Enter/Space selection. The chosen option sends question_answer with
// the matching requestId via panel-controller.js's respondQuestion().
function renderQuestion() {
  el.questionSlot.innerHTML = "";
  const model = panel.currentModel();
  if (!model || !model.pendingQuestion) return;
  const { question, header, options, multiSelect } = model.pendingQuestion;
  const card = document.createElement("div");
  card.className = "permission-card question-card";
  card.setAttribute("role", "group");
  card.setAttribute("aria-label", header || "Câu hỏi từ trợ lý");
  card.innerHTML = `
    <div class="permission-card-head">
      <span class="permission-card-icon">${iconMarkup("helpCircle", { size: 18 })}</span>
      <div>
        <p class="permission-card-title">${escapeHtml(header || "")}</p>
        <p class="permission-card-detail">${escapeHtml(question || "")}</p>
      </div>
    </div>
    <div class="question-card-options"></div>
    <div class="permission-card-actions">
      <button class="btn btn-primary btn-sm" type="button" id="__confirm-question">Xác nhận</button>
    </div>
  `;
  const optionsContainer = card.querySelector(".question-card-options");
  const selected = new Set();

  function toggleOption(label) {
    if (multiSelect) {
      if (selected.has(label)) selected.delete(label);
      else selected.add(label);
    } else {
      selected.clear();
      selected.add(label);
      // For single-select, immediately answer on click:
      panel.respondQuestion(label);
    }
  }

  const optionButtons = [];
  for (const opt of options) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn btn-secondary btn-sm question-option";
    btn.setAttribute("role", "radio");
    btn.setAttribute("aria-checked", "false");
    btn.setAttribute("tabindex", "0");
    btn.innerHTML = `<span class="question-option-label">${escapeHtml(opt.label || "")}</span>${opt.description ? `<span class="question-option-desc">${escapeHtml(opt.description)}</span>` : ""}`;
    btn.addEventListener("click", () => {
      toggleOption(opt.label);
      if (multiSelect) {
        btn.setAttribute("aria-checked", selected.has(opt.label) ? "true" : "false");
      }
    });
    btn.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        toggleOption(opt.label);
        if (multiSelect) {
          btn.setAttribute("aria-checked", selected.has(opt.label) ? "true" : "false");
        }
      }
    });
    optionButtons.push(btn);
    optionsContainer.appendChild(btn);
  }

  // For multi-select, the confirm button sends all selected options:
  if (multiSelect) {
    card.querySelector("#__confirm-question").addEventListener("click", () => {
      if (selected.size === 0) return;
      panel.respondQuestion([...selected]);
    });
  } else {
    // Single-select answers immediately on option click; hide the confirm button
    card.querySelector("#__confirm-question").style.display = "none";
  }

  // Focus the first option so keyboard Tab/Enter works immediately:
  if (optionButtons.length > 0) optionButtons[0].focus();

  el.questionSlot.appendChild(card);
}

function toolRowHtml(row) {
  const display = toolRowDisplay(row);
  const statusPillMap = { running: "is-running", succeeded: null, failed: "is-failed", cancelled: "is-cancelled", unknown: "is-unknown" };
  const pillClass = statusPillMap[row.status];
  const durationLabel = row.endedAt && row.startedAt ? `${Math.max(0, Math.round((row.endedAt - row.startedAt) / 1000 || 0))}s` : "";
  return `
    <ui-tool-row data-status="${escapeHtml(row.status)}">
      <button class="tool-row-summary" type="button" aria-expanded="false">
        <span class="tool-row-icon"></span>
        <span class="tool-row-label">${escapeHtml(display.label)}</span>
        ${pillClass ? `<span class="status-pill ${pillClass}">${escapeHtml(statusWordVi(row.status))}</span>` : durationLabel ? `<span class="tool-row-meta">${escapeHtml(durationLabel)}</span>` : ""}
        <span class="tool-row-chevron">${iconMarkup("chevronRight", { size: 14 })}</span>
      </button>
      <div class="tool-row-detail" hidden>${escapeHtml(display.detail || "")}${row.resultSummary ? `<div>${escapeHtml(String(row.resultSummary)).slice(0, 4000)}</div>` : ""}</div>
    </ui-tool-row>`;
}

function statusWordVi(status) {
  return { running: "Đang chạy", failed: "Lỗi", cancelled: "Đã hủy", unknown: "Không rõ kết quả" }[status] || status;
}

// Skill-specific run_error reasons (host/agent/companion.js's
// _runAfterLeaseGranted(), task 7.2 — already real, already wired) mapped to
// actionable Vietnamese text for the transcript (task 7.3: "Show skill
// start/error activity ... in the transcript"). `event.detail` is already a
// specific, actionable message straight from the real
// SkillDispatchError/SkillSnapshotMismatchError thrown host-side (see
// host/agent/skills/dispatch.js) — shown verbatim rather than re-derived, so
// this never drifts from the real rejection reason.
const SKILL_ERROR_TITLES_VI = {
  slash_dispatch_rejected: "Lệnh không được thực thi",
  skills_snapshot_unavailable: "Skill trong cuộc trò chuyện này không còn khả dụng",
  skills_binding_failed: "Không thể chuẩn bị skill cho cuộc trò chuyện này"
};

function turnStatusNote(turn) {
  if (turn.lifecycle === "stopped") return { cls: "", text: "Đã dừng — câu trả lời chưa hoàn chỉnh." };
  if (turn.lifecycle === "interrupted") return { cls: "", text: "Bị gián đoạn do mất kết nối — câu trả lời chưa hoàn chỉnh." };
  if (turn.lifecycle === "error") {
    const reason = (turn.errorInfo && turn.errorInfo.reason) || "run_error";
    const detail = turn.errorInfo && turn.errorInfo.detail;
    const skillTitle = SKILL_ERROR_TITLES_VI[reason];
    const text = skillTitle
      ? `${skillTitle}${detail ? `: ${detail}` : ""}`
      : `Lỗi: ${detail || reason}`;
    return { cls: "is-error", text: escapeHtml(text) };
  }
  return null;
}

function renderTurnHtml(turn, { isLatestStreaming, busy = false, elapsedVisible = false }) {
  const note = turnStatusNote(turn);
  // The streaming cursor and the busy/working indicator are mutually
  // exclusive: the cursor means answer text IS flowing right now, the busy
  // indicator means it is NOT (before the first token, or the gap after a
  // tool). Suppress the cursor while busy so the indicator is the single
  // signal for "no text arriving".
  const cursor = isLatestStreaming && !busy ? '<span class="stream-cursor" aria-hidden="true"></span>' : "";
  // The busy indicator occupies the exact position the next answer content
  // will take: after the tool timeline and the (possibly empty / partial)
  // prose. It is removed in place -- simply not rendered -- the instant
  // answer text resumes, since rendering is a pure function of model state.
  const busyHtml = busy ? renderBusyIndicator(panel.currentModel(), { elapsedVisible }) : "";
  // Collapsed-by-default action-timeline summary row (spec
  // "Truthful action timeline and screenshot previews" /
  // adopt-panel-design-and-image-attachments task 1.2). One summary per run
  // replaces the unconditional per-action list; activating the summary
  // (click, Enter, or Space) expands it into the full ordered list. The
  // underlying events/state/thumbnails are still rendered underneath the
  // expanded view -- their data is unchanged by the visual collapse, only
  // the row's visibility toggles (its DOM exists either way so the spec's
  // "expansion state does not alter the underlying record" held both ways).
  const timelineHtml = turn.toolRows.length ? renderTimelineCollapsed(turn) : "";
  // Mid-turn ask-user answers anchored to this turn (see
  // recordQuestionAnswer): rendered as user bubbles between the tool timeline
  // and the prose, i.e. next to the tool call that asked for them. The prose
  // is cumulative and cannot be split at the answer instant, so the bubble
  // marks the tool-activity position rather than a point inside the text.
  const answersHtml = (turn.questionAnswers || []).map((a) => renderUserItemHtml({ text: a.text })).join("");
  // Source citation line (task 1.3 / spec "Structured answer with source
  // line"): when this turn actually read a page (a `get_page_text` or
  // `read_page` tool row resolved with a `resultSummary` containing the
  // structured `Title: ... / URL: ... / Captured: ...` header that
  // extension/background.js's get_page_text tool emits verbatim), the
  // answer's prose is naturally grounded in read content rather than the
  // assistant's own prose, and the panel renders one short citation line
  // naming the page's hostname and the time it was read, distinguishable from
  // the assistant's own prose by a leading page-icon and a quieter secondary-
  // text color (.answer-source-citation in sidepanel.css). Distinguished
  // visually from action-timeline rows by position (immediately after the
  // prose, before the optional turn-status-note) and by a different class.
  const citationHtml = renderAnswerSourceCitation(turn);
  // Documents this turn produced (create_document). They sit below the prose
  // and above the busy indicator, so a card appears exactly where the answer
  // that produced it ends — the same anchoring the citation line uses.
  const documentsHtml = (turn.documents || []).map(renderDocumentCardHtml).join("");
  // Per-answer footer: quiet copy icon-button plus the turn's response time
  // (reuses timelineDurationLabel, so the footer never disagrees with the
  // action-timeline summary; empty for tool-less turns where no honest
  // duration exists). No model name by design.
  const durationLabel = timelineDurationLabel(turn);
  const durationHtml = durationLabel
    ? `<span class="turn-duration">${escapeHtml(durationLabel)}</span>`
    : "";
  const copyHtml = turn.text
    ? `<div class="turn-actions"><button class="btn btn-secondary btn-sm turn-copy-btn" type="button" data-run-id="${escapeHtml(String(turn.runId ?? ""))}" title="Sao chép phản hồi" aria-label="Sao chép phản hồi">${iconMarkup("copy", { size: 14 })}</button>${durationHtml}</div>`
    : "";
  return `
    <div class="msg-row from-assistant">
      <div class="msg-assistant-body">
        ${timelineHtml}
        ${answersHtml}
        <div class="prose" style="margin-top:${turn.toolRows.length ? "12px" : "0"}">${renderMarkdownLite(turn.text)}${cursor}</div>
        ${citationHtml}
        ${documentsHtml}
        ${busyHtml}
        ${note ? `<div class="turn-status-note ${note.cls}">${note.text}</div>` : ""}
        ${copyHtml}
      </div>
    </div>`;
}

// Tasks 1.3: a one-line source citation for an answer that drew on bound/
// read page content. The source data is already on the turn's tool rows --
// extension/background.js's get_page_text handler writes a fixed `Title:`,
// `URL:`, `Source: <tag>`, `Captured:` header line list followed by a blank
// line and the extracted text; `extractResultText` keeps that as the tool row
// `resultSummary` verbatim. This helper parses that summary's header lines,
// and renders one line: `hostname · đọc lúc HH:MM` when both URL and captured
// time are present. Returns "" when the turn has no read-page tool result
// (so a non-page-grounded answer renders exactly the same as before this
// change -- spec/1.3 regression requirement), OR when the read result lacks
// the source lines (older content-script builds without capturedAt).
const READ_PAGE_TOOLS = new Set(["get_page_text", "read_page"]);

function renderAnswerSourceCitation(turn) {
  if (!turn || !turn.toolRows || !turn.toolRows.length) return "";
  for (const row of turn.toolRows) {
    if (!row || !READ_PAGE_TOOLS.has(row.toolName)) continue;
    if (!row.resultSummary || typeof row.resultSummary !== "string") continue;
    const lines = row.resultSummary.split("\n");
    const url = findHeaderLine(lines, "URL:");
    const captured = findHeaderLine(lines, "Captured:");
    if (!url) continue; // URL is the floor; captured timestamp is best-effort
    let hostname = "";
    try { hostname = new URL(url).hostname; } catch { hostname = ""; }
    let timeStr = "";
    if (captured) {
      try { timeStr = new Date(captured).toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" }); } catch { timeStr = ""; }
    }
    const citationLabel = hostname || url;
    const citationTime = timeStr ? ` · đọc lúc ${timeStr}` : "";
    // The <a> links to the source URL so a screen-reader user (or any user)
    // can verify the assistant's grounding; `rel="noreferrer noopener"`
    // avoids leaking the side-panel origin to arbitrary pages.
    return `<div class="answer-source-citation"><span class="answer-source-glyph" aria-hidden="true">${iconMarkup("link", { size: 12 })}</span><a class="answer-source-link" href="${escapeHtml(url)}" target="_blank" rel="noreferrer noopener">${escapeHtml(citationLabel)}</a><span class="answer-source-time">${escapeHtml(citationTime)}</span></div>`;
  }
  return "";
}

function findHeaderLine(lines, prefix) {
  for (const line of lines) {
    if (line.startsWith(prefix)) return line.slice(prefix.length).trim();
  }
  return "";
}

// Persisted per-run expansion state for the collapsed action-timeline
// summary row. Render is a pure function of model state EXCEPT this one
// user-driven UI fact: the same ordered set of actions is shown every time
// regardless of the row's expanded-or-collapsed state (spec
// "Expansion state does not alter the underlying record"), so reusing a
// small Map keeps an expanded row from snapping back to collapsed on the
// very next render-after-stream-tick without needing to embed the toggle
// in the model itself (which would persist into history-store/snapshot
// transport and grow the wire shape for purely visual state -- a bad fit
// for snapshot replay, exactly the kind of UI-only fact this map exists
// to keep out of the wire contract).
const timelineExpandedRuns = new Set();

function timelineDurationLabel(turn) {
  if (!turn.toolRows.length) return "";
  // Same timestamp basis this change's busy indicator elapsed-count uses
  // (turn.ts): on a live run, "now"; on a snapshot rebuild, the original
  // recorded start instant is restored (see _turnFor's ts capture verb).
  const startMs = turn.ts || 0;
  // End: the latest tool-row's `endedAt` if every row resolved, otherwise
  // the wall-clock now (the run is still streaming or has a tool in flight).
  // A turn that finished cleanly ends at its last tool row's endedAt; a
  // streaming turn reads live now; an interrupted/stopped turn already has
  // every still-running row cancelled to a terminal state via conversation-
  // model.js's run_stopped/run_interrupted handlers.
  let endMs = Date.now();
  for (const r of turn.toolRows) {
    if (r.endedAt && typeof r.endedAt === "number") endMs = Math.max(endMs, r.endedAt);
  }
  // edge: a stale turn from snapshot replay before any tool rows closed at
  // all would compute a meaningless (today - then) -- cap by start so we
  // never report a negative or absurd age:
  const durMs = Math.max(0, endMs - startMs);
  const durSec = Math.round(durMs / 1000);
  if (durSec < 60) return `${durSec}s`;
  return `${Math.floor(durSec / 60)}:${String(durSec % 60).padStart(2, "0")}`;
}

function renderTimelineCollapsed(turn) {
  const isExpanded = timelineExpandedRuns.has(turn.runId);
  const count = turn.toolRows.length;
  // "Đã dùng Browzy · N thao tác · <thời lượng>" per spec/Approval/Main mockup.
  const productLabel = "Đã dùng Browzy";
  const summaryLabel = `${productLabel} · ${count} thao tác · ${timelineDurationLabel(turn)}`;
  // The summary row is a <button> so Enter/Space activation is the browser's
  // default for free; aria-expanded and aria-controls convey the
  // expand/collapse state to assistive tech. The full ordered list is held
  // in a div[aria-hidden] that is set display:none when collapsed -- it
  // stays in the DOM so re-expansion is instant and never rebuilds the
  // underlying rows (same "expansion does not alter the record" property
  // the spec calls out both ways).
  const listHtml = turn.toolRows.map(toolRowHtml).join("");
  // NOTE: the outer wrapper is `.tool-timeline-group` (page-local class), NOT
  // the shared `.tool-timeline` from extension/ui/components.css -- that one
  // declares a left-rail guide, padding-left, and ::before rail that are
  // exactly right for the FULL ordered tool-row list (applied to `.tool-
  // timeline-list` here) but would visually run the rail through the SUMMARY
  // row above. Keeping the outer wrapper as a distinct class avoids editing
  // the shared stylesheet and is consistent with how `.slash-picker-item[
  // data-kind=...]` above is a page-local rule augmenting the shared slash
  // picker primitive.
  return `
    <div class="tool-timeline-group" data-run-id="${escapeHtml(String(turn.runId))}">
      <button class="tool-timeline-summary" type="button" aria-expanded="${isExpanded ? "true" : "false"}" aria-controls="${escapeHtml(`tl-${turn.runId}`)}">
        <span class="tool-timeline-glyph" aria-hidden="true">${iconMarkup(isExpanded ? "chevronDown" : "chevronRight", { size: 14 })}</span>
        <span class="tool-timeline-text">${escapeHtml(summaryLabel)}</span>
      </button>
      <div class="tool-timeline tool-timeline-list" id="${escapeHtml(`tl-${turn.runId}`)}" ${isExpanded ? "" : "hidden"}>${listHtml}</div>
    </div>`;
}

function renderUserItemHtml(item) {
  // Exactly which images were bound to this message at Send time, shown as
  // non-interactive thumbnails (the attachment snapshot travels with the
  // message, mirroring the page-context exact-identity binding).
  const attachments =
    item.attachments && item.attachments.length
      ? `<div class="msg-user-attachments">${item.attachments
          .map(
            (a) =>
              `<span class="msg-user-attachment" title="${escapeHtml(a.fileName || "")}">${iconMarkup("image", { size: 16 })}</span>`
          )
          .join("")}</div>`
      : "";
  return `<div class="msg-row from-user"><div class="msg-user-bubble${item.isPlaceholder ? " is-placeholder" : ""}">${escapeHtml(item.text)}</div>${attachments}</div>`;
}

function renderBusyIndicator(model, { elapsedVisible } = {}) {
  const secs = model ? model.busyElapsedSeconds() : 0;
  const showElapsed = !!elapsedVisible && secs >= 3;
  const label = BUSY_LABEL_VI;
  const elapsed = showElapsed
    ? `<span class="busy-elapsed" aria-hidden="true">${formatBusyElapsed(secs)}</span>`
    : `<span class="busy-elapsed" aria-hidden="true" hidden></span>`;
  // Decorative glyph (aria-hidden via the icon module's no-title default),
  // the label, and the elapsed count. Sized at 18px (--icon-size-md) and
  // colored via --color-accent-text -- the whole row consumes only existing
  // tokens, never a new color literal.
  return `
    <div class="busy-indicator" role="status" aria-label="${escapeHtml(label)}">
      <span class="busy-indicator-glyph" aria-hidden="true">${iconMarkup("spark", { size: 18 })}</span>
      <span class="busy-indicator-label">${escapeHtml(label)}</span>
      ${elapsed}
    </div>`;
}

function formatBusyElapsed(totalSeconds) {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  if (m === 0) return `${s}s`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

// --- Agent-created document cards -----------------------------------------
//
// A run that calls create_document produces a file, and the transcript shows
// it as a card rather than pasting the whole thing inline. The card carries
// only what the `document_created` event carried — title, format, size — and
// the bytes are fetched on demand when the operator opens or downloads it.
//
// No third-party storage is involved anywhere in this path: download writes a
// blob the panel already holds, through an <a download>, which needs no
// `downloads` permission and makes no network request.

function formatBytes(n) {
  const bytes = Number(n) || 0;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function renderDocumentCardHtml(doc) {
  const label = (DOCUMENT_FORMAT_LABELS[doc.format] || String(doc.format || "")).toUpperCase();
  const sub = `Tài liệu · ${label} · ${formatBytes(doc.byteLength)}`;
  return `<div class="doc-card" role="button" tabindex="0" data-document-id="${escapeHtml(doc.documentId)}"
      aria-label="Mở tài liệu ${escapeHtml(doc.title)}">
    <span class="doc-card-icon">${iconMarkup("fileText", { size: 20 })}</span>
    <span class="doc-card-main">
      <span class="doc-card-title">${escapeHtml(doc.title)}</span>
      <span class="doc-card-sub">${escapeHtml(sub)}</span>
    </span>
    <button class="btn-icon doc-card-download" type="button" data-download-document-id="${escapeHtml(doc.documentId)}"
      title="Tải về" aria-label="Tải tài liệu ${escapeHtml(doc.title)} về máy">${iconMarkup("download", { size: 16 })}</button>
  </div>`;
}

function wireDocumentCards() {
  for (const card of el.transcript.querySelectorAll(".doc-card")) {
    const documentId = card.getAttribute("data-document-id");
    card.addEventListener("click", (event) => {
      // The download button lives inside the card; its own handler owns the
      // click, so opening the viewer must not also fire.
      if (event.target.closest("[data-download-document-id]")) return;
      openDocumentViewer(documentId);
    });
    card.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      openDocumentViewer(documentId);
    });
  }
  for (const button of el.transcript.querySelectorAll("[data-download-document-id]")) {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      downloadDocument(button.getAttribute("data-download-document-id"));
    });
  }
}

function renderRecordingItemHtml(item) {
  const issue = item.transcriptStatus && item.transcriptStatus !== "ok";
  return `<div class="list-item"><span class="list-item-icon">${iconMarkup("mic", { size: 16 })}</span>
    <span class="list-item-main"><span class="list-item-title">Bản ghi đính kèm: ${escapeHtml(item.recordingId)}</span>
    <span class="list-item-sub">${issue ? "Tường thuật lỗi: " + escapeHtml(item.transcriptStatus) : escapeHtml(item.summary || "")}</span></span></div>`;
}

let wasNearBottom = true;
function isNearBottom() {
  const s = el.panelScroll;
  return s.scrollHeight - s.scrollTop - s.clientHeight < 80;
}

function renderTranscript() {
  const model = panel.currentModel();
  el.emptyStateSlot.innerHTML = "";
  if (!model || model.items.length === 0) {
    el.transcript.innerHTML = "";
    el.emptyStateSlot.innerHTML = emptyStateHtml();
    wireEmptyStateSuggestions();
    return;
  }
  const preserveScroll = isNearBottom();
  // The busy/working indicator belongs ONLY in the position the next answer
  // content will occupy: the most recent assistant turn. It renders there so
  // the reflow when text actually arrives replaces it in place.
  const isBusy = !!model.isBusy?.() && model.isBusy();
  const elapsedVisible = isBusy && model.busyElapsedSeconds() >= 3;
  const html = model.items
    .map((item, idx) => {
      if (item.kind === "user") return renderUserItemHtml(item);
      if (item.kind === "recording") return renderRecordingItemHtml(item);
      const isLatest = idx === model.items.length - 1;
      return renderTurnHtml(item, {
        isLatestStreaming: isLatest && (item.lifecycle === "running" || item.lifecycle === "created"),
        busy: isLatest && isBusy,
        elapsedVisible: isLatest && elapsedVisible
      });
    })
    .join("");
  el.transcript.innerHTML = html;
  wireToolRowIcons(model);
  wireThumbButtons();
  wireDocumentCards();
  wireCopyButtons(model);
  if (preserveScroll) el.panelScroll.scrollTop = el.panelScroll.scrollHeight;
  updateJumpLatest();
}

function wireToolRowIcons(model) {
  const rows = el.transcript.querySelectorAll("ui-tool-row");
  let flat = [];
  for (const item of model.items) if (item.kind === "assistant_turn") flat = flat.concat(item.toolRows);
  rows.forEach((rowEl, i) => {
    const iconSpan = rowEl.querySelector(".tool-row-icon");
    const row = flat[i];
    if (iconSpan && row) {
      const name = { running: "circleDot", succeeded: "checkCircle", failed: "xCircle", cancelled: "slashCircle", unknown: "helpCircle" }[row.status] || "circle";
      iconSpan.innerHTML = iconMarkup(name, { size: 15 });
    }
  });
  wireTimelineToggles();
}

// Per-turn collapsed-timeline-summary toggle (task 1.2). Activating the
// summary row (click, Enter, or Space) toggles the timeline between its one-
// row summary and the full ordered list, WITHOUT touching the underlying
// `turn.toolRows` data -- the list DOM persists and only its visibility
// toggles, so the spec's "expansion state does not alter the underlying
// record" holds both ways. The per-user state lives in `timelineExpandedRuns`
// (a Set keyed by runId), which is intentionally NOT in conversation-model.js:
// it is pure UI state, never persisted or replayed, so a snapshot/reconnect
// rebuilds it default-collapsed rather than replaying the operator's
// collapsed-or-expanded state at first connection.
function wireTimelineToggles() {
  const summaries = el.transcript.querySelectorAll(".tool-timeline-summary");
  summaries.forEach((btn) => {
    if (btn.dataset.wired === "1") return; // re-render preserves existing listeners via .wired sentinel
    btn.dataset.wired = "1";
    btn.addEventListener("click", () => toggleTimelineSummary(btn));
    btn.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " " || e.key === "Spacebar") {
        // The native <button> already activates on Enter/Space when focused;
        // the explicit handler exists to keep behavior identical if a future
        // refactor changes the element to a div[role=button], which would
        // otherwise silently lose keyboard toggling.
        e.preventDefault();
        toggleTimelineSummary(btn);
      }
    });
  });
  // Per-row detail toggling: each `<ui-tool-row>`'s `.tool-row-summary`
  // button flips its sibling `.tool-row-detail`'s `hidden` and the button's
  // own aria-expanded, in place. Pre-existing markup that already declared
  // aria-expanded="false" but had no listener: this is the wiring that
  // actually makes expansion work.
  const rowButtons = el.transcript.querySelectorAll(".tool-row-summary");
  rowButtons.forEach((b) => {
    if (b.dataset.wired === "1") return;
    b.dataset.wired = "1";
    b.addEventListener("click", () => {
      const detail = b.parentElement.querySelector(".tool-row-detail");
      const open = b.getAttribute("aria-expanded") === "true";
      b.setAttribute("aria-expanded", open ? "false" : "true");
      if (detail) detail.hidden = open;
    });
  });
}

function toggleTimelineSummary(btn) {
  const wrap = btn.closest(".tool-timeline-group");
  if (!wrap) return;
  const runId = wrap.dataset.runId;
  const list = wrap.querySelector(".tool-timeline-list");
  const glyph = btn.querySelector(".tool-timeline-glyph");
  const willExpand = !timelineExpandedRuns.has(runId);
  if (willExpand) timelineExpandedRuns.add(runId);
  else timelineExpandedRuns.delete(runId);
  btn.setAttribute("aria-expanded", willExpand ? "true" : "false");
  if (list) list.hidden = !willExpand;
  if (glyph) glyph.innerHTML = iconMarkup(willExpand ? "chevronDown" : "chevronRight", { size: 14 });
}

function wireThumbButtons() {
  // Screenshot preview affordance: placeholder-only in this environment
  // (no live browser to actually capture/store an image this session) —
  // see reports/05-panel-evidence.md. Intentionally not wired to a fake
  // image to avoid claiming capability this task cannot exercise for real.
}

// Clipboard write with legacy fallback (same convention as spec-ade's chat
// UI: navigator.clipboard first, document.execCommand('copy') for insecure
// contexts). Returns true when the text is on the clipboard.
async function copyTextToClipboard(text) {
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to the legacy path below.
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = typeof document.execCommand === "function" && document.execCommand("copy");
    ta.remove();
    return !!ok;
  } catch {
    return false;
  }
}

function wireCopyButtons(model) {
  // runId -> raw turn text, rebuilt on every render like wireToolRowIcons'
  // flat row list (renderTranscript replaces innerHTML wholesale, so
  // listeners are always attached fresh — no wiring sentinel needed).
  const textByRunId = new Map();
  for (const item of model.items) {
    if (item.kind === "assistant_turn" && item.runId != null && typeof item.text === "string" && item.text) {
      textByRunId.set(String(item.runId), item.text);
    }
  }
  el.transcript.querySelectorAll(".turn-copy-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const text = textByRunId.get(btn.getAttribute("data-run-id"));
      if (!text) return;
      const ok = await copyTextToClipboard(text);
      const original = btn.innerHTML;
      const originalTitle = btn.getAttribute("title");
      btn.innerHTML = iconMarkup("check", { size: 14 });
      btn.setAttribute("title", ok ? "Đã sao chép" : "Sao chép thất bại");
      btn.setAttribute("aria-label", ok ? "Đã sao chép" : "Sao chép thất bại");
      btn.disabled = true;
      setTimeout(() => {
        if (btn.isConnected) {
          btn.innerHTML = original;
          if (originalTitle != null) {
            btn.setAttribute("title", originalTitle);
            btn.setAttribute("aria-label", originalTitle);
          }
          btn.disabled = false;
        }
      }, 1500);
    });
  });
}

function emptyStateHtml() {
  return `
    <div class="empty-state">
      <div class="empty-state-icon">${iconMarkup("skills", { size: 24 })}</div>
      <h1>Chào bạn, tôi có thể giúp gì?</h1>
      <p>Tôi có thể đọc trang hiện tại và trả lời câu hỏi, hoặc điều khiển trình duyệt khi bạn cần.</p>
      <div class="suggestion-list">
        <button class="suggestion-item" type="button" data-suggest="Tóm tắt bài viết trên trang này giúp mình.">${iconMarkup("page", { size: 18 })}<span>Tóm tắt bài viết</span></button>
        <button class="suggestion-item" type="button" data-suggest="Phân tích nội dung trang này giúp mình.">${iconMarkup("search", { size: 18 })}<span>Phân tích nội dung</span></button>
      </div>
    </div>`;
}

function wireEmptyStateSuggestions() {
  el.emptyStateSlot.querySelectorAll("[data-suggest]").forEach((btn) => {
    btn.addEventListener("click", () => {
      el.composerInput.value = btn.getAttribute("data-suggest");
      el.composerInput.focus();
      autoGrow();
      updateSendEnabled();
    });
  });
}

function updateJumpLatest() {
  const existing = el.panelScroll.querySelector(".jump-latest");
  if (existing) existing.remove();
  if (isNearBottom()) return;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "btn btn-secondary btn-sm jump-latest";
  btn.textContent = "Xem tin mới nhất";
  btn.addEventListener("click", () => {
    el.panelScroll.scrollTop = el.panelScroll.scrollHeight;
  });
  el.panelScroll.appendChild(btn);
}
el.panelScroll.addEventListener("scroll", () => {
  wasNearBottom = isNearBottom();
  updateJumpLatest();
});

function announcePhase(phase) {
  // Polite live region: coarse phase changes only (spec: "without
  // announcing every token"). Streamed text itself is NOT pushed through
  // this node on every delta. "queued" announces the busy label rather than
  // PHASE_LABEL_VI's "Đang chờ lượt": entering queued is exactly the moment
  // the busy/working indicator appears, and that is what the user should
  // hear.
  const text = { queued: BUSY_LABEL_VI, streaming: "Đang phản hồi", completed: "Đã hoàn thành", stopped: "Đã dừng", error: "Có lỗi xảy ra", interrupted: "Bị gián đoạn" }[phase];
  if (text) el.phaseAnnouncer.textContent = text;
}

let lastAnnouncedPhase = null;
// Last busy/not-busy state we announced, so the busy indicator's own
// appear/disappear transitions each push exactly ONE string into the polite
// live region -- never one per animation frame, per render, or per
// elapsed-count tick. Starts null (never announced) rather than false so the
// very first render of an idle panel does not emit a spurious "responding".
let lastAnnouncedBusy = null;

function announceBusyTransitions(phase) {
  const busy = !!panel.currentModel()?.isBusy();
  if (busy === lastAnnouncedBusy) return; // no transition this render
  if (busy) {
    // Indicator appeared (queued, or streaming with no text arriving yet).
    el.phaseAnnouncer.textContent = BUSY_LABEL_VI;
  } else if (lastAnnouncedBusy === true) {
    // Indicator disappeared. If text resumed inside streaming, say so; a
    // run ending (completed/stopped/error/interrupted) gets its own phase
    // announcement from announcePhase() instead -- never both.
    if (phase === RUN_PHASE.STREAMING) {
      el.phaseAnnouncer.textContent = PHASE_LABEL_VI[RUN_PHASE.STREAMING];
    }
  }
  lastAnnouncedBusy = busy;
}

function render() {
  renderConnectionState();
  renderSetupBanner();
  renderModelMenu();
  renderContextChip();
  renderPermission();
  renderQuestion();
  renderTranscript();
  updateSendEnabled();
  const phase = panel.currentPhase();
  if (phase !== lastAnnouncedPhase) {
    announcePhase(phase);
    lastAnnouncedPhase = phase;
  }
  announceBusyTransitions(phase);
  updateSendStopButton(phase);
  syncBusyElapsedTimer();
}

// ---- busy/working indicator: elapsed-time affordance (task 6.8) ----------
// A single 1Hz timer drives the elapsed counter while (and only while) the
// indicator is actually on screen; it is the only thing in the panel that
// loops on a timer, and it never drives an announcement. The count is
// sourced solely from the current turn's recorded start timestamp (turn.ts),
// never estimated and never restarted by a tool-activity gap -- isBusy() only
// gates visibility, and visibility gaps do not touch turn.ts.
let busyElapsedTimer = null;

function paintBusyElapsed() {
  const indicator = el.transcript.querySelector(".busy-indicator");
  if (!indicator) return false; // removed in place by renderTranscript()
  const span = indicator.querySelector(".busy-elapsed");
  const model = panel.currentModel();
  if (!span || !model) return true;
  const secs = model.busyElapsedSeconds();
  if (secs < 3) {
    span.hidden = true;
    span.textContent = "";
  } else {
    span.hidden = false;
    span.textContent = formatBusyElapsed(secs);
  }
  return true;
}

function syncBusyElapsedTimer() {
  const busy = !!panel.currentModel()?.isBusy();
  if (busy) {
    if (busyElapsedTimer == null) {
      busyElapsedTimer = setInterval(() => {
        if (!paintBusyElapsed()) stopBusyElapsedTimer();
      }, 1000);
    }
  } else {
    stopBusyElapsedTimer();
  }
}

function stopBusyElapsedTimer() {
  if (busyElapsedTimer != null) {
    clearInterval(busyElapsedTimer);
    busyElapsedTimer = null;
  }
}

function updateSendStopButton(phase) {
  const running = phase === RUN_PHASE.STREAMING || phase === RUN_PHASE.QUEUED || phase === RUN_PHASE.STOPPING || phase === RUN_PHASE.WAITING_FOR_PERMISSION;
  if (running) {
    el.btnSend.className = "btn-icon is-danger-solid";
    el.btnSend.setAttribute("aria-label", "Dừng");
    el.btnSend.innerHTML = iconMarkup("stop", { size: 16 });
  } else {
    el.btnSend.className = "btn-icon";
    el.btnSend.setAttribute("aria-label", "Gửi");
    el.btnSend.innerHTML = iconMarkup("send", { size: 18 });
  }
}

// Composer prompt-enhancement in-flight state (design.md decision 6): null
// when idle, or {requestId, originalText} while an `enhance_prompt`
// `op:"generate"` is outstanding. One composer, one draft -- a second
// concurrent request has no meaning, so this is a single slot, not a map.
// Declared here (rather than down with the rest of the enhancement flow
// below) because updateSendEnabled() -- the ONE function all composer-control
// gating lives in, Send included -- reads it.
let enhanceState = null;

function updateSendEnabled() {
  const phase = panel.currentPhase();
  const running = phase === RUN_PHASE.STREAMING || phase === RUN_PHASE.QUEUED || phase === RUN_PHASE.STOPPING || phase === RUN_PHASE.WAITING_FOR_PERMISSION;
  if (running) {
    el.btnSend.disabled = false; // acts as Stop
    el.composerInput.disabled = true;
    // A run occupies the composer; enhancement never overlaps one (spec.md
    // "Prompt enhancement availability": disabled "when a run is queued,
    // streaming, stopping, or waiting for permission").
    if (el.btnEnhance) el.btnEnhance.disabled = true;
    return;
  }
  el.composerInput.disabled = false;
  const trimmed = el.composerInput.value.trim();
  const hasText = trimmed.length > 0;
  // Provider readiness no longer gates Send. A capability test that failed or
  // went stale is reported by the setup banner (renderSetupBanner) and left as
  // the user's call to act on; it never blocks typing a message and sending it.
  // While an enhancement request is in flight the composer is read-only and
  // doSend() itself bails immediately (see its own comment) -- Send is
  // html-disabled here too so its visible state agrees with what a click or
  // Enter actually does, rather than looking clickable and silently no-op'ing.
  el.btnSend.disabled = !hasText || !panel.currentConversationId || !!enhanceState;
  if (el.btnEnhance) {
    if (enhanceState) {
      // In flight: the control now acts as Cancel (spec.md "Prompt
      // enhancement in-flight and cancellation") and must stay clickable for
      // that, not html-disabled -- exactly the same "acts as Stop" pattern
      // el.btnSend.disabled = false above already uses while a run is
      // active. It cannot be reused to start a SECOND overlapping generate
      // while in this state, but that is enforced by what a click on it does
      // (doEnhance() below always cancels, never generates, while
      // enhanceState is set), not by the disabled attribute.
      el.btnEnhance.disabled = false;
    } else {
      // A slash command's literal text is what the companion dispatches on
      // (specs/agent-skills.md); rewriting it would change which skill runs,
      // so it is excluded here the same way Send itself is never gated on
      // slash text -- this is an enhancement-only rule (spec.md "Slash
      // command draft").
      const isSlashCommand = trimmed.startsWith("/");
      el.btnEnhance.disabled = !hasText || !panel.currentConversationId || isSlashCommand;
    }
  }
}

// ---- composer ----------------------------------------------------------

// Image attachment composer state — images-only (PNG/JPEG/WebP/GIF), 10MB per
// image / 4 images / 20MB per message. In-memory only, per-panel (never
// chrome.storage/logs/exports — see spec "An attachment is data ..."). Each
// entry holds {id, fileName, mimeType, byteLength, objectUrl, blob}. Byte
// transport to the companion is C1's responsibility (chunked
// user_attachment), so C2 only threads the reference snapshot through Send.
// Mirrors host/agent/protocol.js's ATTACHMENT_MIME_KINDS. The companion
// re-validates every ref, so this copy rejects early with a specific reason
// and is never the authority.
const ATTACHMENT_MIME_KINDS = {
  "image/png": "image",
  "image/jpeg": "image",
  "image/webp": "image",
  "image/gif": "image",
  "application/pdf": "document",
  "text/plain": "text",
  "text/markdown": "text",
  "text/csv": "text",
  "application/json": "text"
};
const ATTACHMENT_MIME_TYPES = new Set(Object.keys(ATTACHMENT_MIME_KINDS));
// Browsers report file.type inconsistently for text formats — .md and .csv
// commonly arrive as "" or "application/octet-stream" — so the extension is a
// fallback, never an override: a file whose declared type is already accepted
// keeps it.
const ATTACHMENT_MIME_BY_EXTENSION = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif",
  pdf: "application/pdf",
  txt: "text/plain", md: "text/markdown", markdown: "text/markdown", csv: "text/csv", json: "application/json"
};
const ATTACHMENT_ACCEPT_ATTR = Object.keys(ATTACHMENT_MIME_BY_EXTENSION).map((e) => "." + e).join(",");
const ATTACHMENT_MAX_PER_FILE_BYTES = 10 * 1024 * 1024;
const ATTACHMENT_MAX_FILES_PER_MESSAGE = 4;
const ATTACHMENT_MAX_COMBINED_BYTES = 20 * 1024 * 1024;

/** The accepted MIME type for a file, from its declared type or its name. */
function attachmentMimeOf(file) {
  const declared = file && file.type ? String(file.type).toLowerCase() : "";
  if (ATTACHMENT_MIME_TYPES.has(declared)) return declared;
  const ext = String((file && file.name) || "").toLowerCase().split(".").pop();
  return ATTACHMENT_MIME_BY_EXTENSION[ext] || declared || "";
}

let attachments = []; // array<{id, fileName, mimeType, byteLength, objectUrl, blob}>

function bytesLabel(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

function canAcceptAttachments() {
  // Gating (spec "Attachment entry points follow existing composer readiness"):
  // available exactly when the composer is otherwise able to send — same
  // condition as gating Send. No separate attachment-only error copy.
  const phase = panel.currentPhase();
  const running = phase === RUN_PHASE.STREAMING || phase === RUN_PHASE.QUEUED || phase === RUN_PHASE.STOPPING || phase === RUN_PHASE.WAITING_FOR_PERMISSION;
  if (running) return false;
  if (!panel.currentConversationId) return false;
  return true;
}

function validateAndAppendFiles(files, { from } = {}) {
  const incoming = files.filter(Boolean);
  if (incoming.length === 0) return;

  // Gating silently prevents new entry (same readiness as Send), no separate copy.
  if (!canAcceptAttachments()) return;

  // Validate each incoming file individually and collect the FIRST specific
  // rejection visible reason (three distinct messages, never generic):
  //  1) unsupported type, 2) single-image oversize, 3) would overflow
  //  combination ceiling (count or total bytes). Rejection never silently drops.
  let firstErrorType = null;
  let firstErrorDetail = "";

  const accepted = [];
  let runningTotalBytes = attachments.reduce((s, a) => s + (a.byteLength || 0), 0);
  let runningCount = attachments.length;

  for (const file of incoming) {
    const type = attachmentMimeOf(file);
    if (!ATTACHMENT_MIME_TYPES.has(type)) {
      if (!firstErrorType) {
        firstErrorType = "type";
        firstErrorDetail = file.name || file.type || "loại tệp không hỗ trợ";
      }
      continue;
    }
    const bytes = file.size || 0;
    if (bytes > ATTACHMENT_MAX_PER_FILE_BYTES) {
      if (!firstErrorType) {
        firstErrorType = "single_size";
        firstErrorDetail = `${bytesLabel(bytes)} > 10 MB`;
      }
      continue;
    }
    // Combined check is against the message that would be produced by adding
    // this and the previously-accepted-for-this-call files.
    const wouldBeCount = runningCount + accepted.length + 1;
    const wouldBeTotal = runningTotalBytes + accepted.reduce((s, a) => s + a.byteLength, 0) + bytes;
    if (wouldBeCount > ATTACHMENT_MAX_FILES_PER_MESSAGE) {
      if (!firstErrorType) {
        firstErrorType = "combined";
        firstErrorDetail = `Tối đa ${ATTACHMENT_MAX_FILES_PER_MESSAGE} tệp mỗi tin nhắn`;
      }
      continue;
    }
    if (wouldBeTotal > ATTACHMENT_MAX_COMBINED_BYTES) {
      if (!firstErrorType) {
        firstErrorType = "combined";
        firstErrorDetail = `Tối đa 20 MB mỗi tin nhắn`;
      }
      continue;
    }
    const id = (typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    const kind = ATTACHMENT_MIME_KINDS[type];
    // Only an image gets an object URL: it is what the strip renders as a
    // thumbnail. A PDF or a text file shows its filename instead, so making
    // (and later revoking) a blob URL for one would be pure bookkeeping.
    let objectUrl = "";
    if (kind === "image") {
      try {
        objectUrl = URL.createObjectURL(file);
      } catch {}
    }
    accepted.push({ id, fileName: file.name || "tệp", mimeType: type, kind, byteLength: bytes, objectUrl, blob: file });
  }

  if (firstErrorType) {
    const msgs = {
      type: `Loại tệp không được hỗ trợ: ${firstErrorDetail}. Chỉ chấp nhận PNG, JPEG, WebP, GIF, PDF, TXT, Markdown, CSV, JSON.`,
      single_size: `Tệp quá lớn: ${firstErrorDetail}. Tối đa 10 MB mỗi tệp.`,
      combined: `Đã vượt giới hạn tệp cho tin nhắn này (${firstErrorDetail}).`
    };
    showAttachmentError(msgs[firstErrorType]);
  } else {
    clearAttachmentError();
  }

  if (accepted.length) {
    attachments = attachments.concat(accepted);
    renderAttachments();
    // Eagerly sync to background store (task 3.4 / parent direction): each
    // accepted file is converted to base64 and sent as panelAttachmentAdd;
    // the background replies with a canonical id which replaces the local
    // random id so START's attachment refs match what the companion stored.
    // Failures are best-effort here — doSend will retry/upload before START.
    for (const a of accepted) {
      if (!a.blob || typeof chrome === "undefined" || !chrome.runtime || typeof chrome.runtime.sendMessage !== "function") continue;
      blobToBase64(a.blob).then((base64) =>
        chrome.runtime.sendMessage({ type: "panelAttachmentAdd", base64, mimeType: a.mimeType }).then((res) => {
          if (res && res.ok && res.id && res.id !== a.id) {
            const entry = attachments.find((x) => x.id === a.id);
            if (entry) entry.id = res.id;
            // Keep thumbnail binding stable — re-render so remove() targets new id.
            renderAttachments();
          }
        }).catch(() => {})
      ).catch(() => {});
    }
  }
  void from;
}

function renderAttachments() {
  const strip = document.getElementById("attachment-strip");
  const err = document.getElementById("attachment-error");
  // Free object URLs for removed entries on next render via previous child tracking.
  // The Blob lives on each entry; URLs are revoked on remove and on clear.

  if (!attachments.length) {
    strip.innerHTML = "";
    strip.hidden = true;
    if (!err || !err.textContent) {
      // No-op: preserve error if one is being shown alongside the new empty state.
    }
    return;
  }
  strip.hidden = false;
  strip.innerHTML = "";
  for (const a of attachments) {
    const thumb = document.createElement("div");
    thumb.className = "attachment-thumb";
    // Thumbnail image + inline textual label.
    const img = document.createElement("img");
    img.alt = a.fileName || "";
    if (a.objectUrl) img.src = a.objectUrl;
    else img.style.display = "none";
    const name = document.createElement("span");
    name.className = "attachment-thumb-name";
    name.textContent = a.fileName || "";
    name.title = `${a.fileName} · ${bytesLabel(a.byteLength)}`;
    const rm = document.createElement("button");
    rm.type = "button";
    rm.className = "attachment-thumb-remove";
    rm.setAttribute("aria-label", `Xóa ${a.fileName}`);
    rm.textContent = "×";
    rm.addEventListener("click", () => removeAttachment(a.id));
    thumb.append(img, name, rm);
    strip.appendChild(thumb);
  }
}

function removeAttachment(id) {
  const idx = attachments.findIndex((a) => a.id === id);
  if (idx < 0) return;
  const [removed] = attachments.splice(idx, 1);
  try {
    if (removed.objectUrl) URL.revokeObjectURL(removed.objectUrl);
  } catch {}
  try {
    if (typeof chrome !== "undefined" && chrome.runtime && typeof chrome.runtime.sendMessage === "function") {
      chrome.runtime.sendMessage({ type: "panelAttachmentRemove", id }).catch(() => {});
    }
  } catch {}
  clearAttachmentError();
  renderAttachments();
}

function clearAttachments() {
  for (const a of attachments) {
    try {
      if (a.objectUrl) URL.revokeObjectURL(a.objectUrl);
    } catch {}
  }
  attachments = [];
  try {
    if (typeof chrome !== "undefined" && chrome.runtime && typeof chrome.runtime.sendMessage === "function") {
      chrome.runtime.sendMessage({ type: "panelAttachmentClear" }).catch(() => {});
    }
  } catch {}
  clearAttachmentError();
  renderAttachments();
}

// The exact-message attachment snapshot doSend() binds to one outgoing run:
// references only (id/fileName/mimeType/byteLength), never the bytes — those
// travel separately through background's chunked user_attachment transport.
function snapshotAttachments() {
  // `name` is the wire field host/agent/protocol.js validates and the model
  // turn uses to label a text attachment or title a PDF; `fileName` stays for
  // the panel's own rendering. Both carry the same string, named separately so
  // renaming one never silently changes the other.
  return attachments.map((a) => ({
    id: a.id,
    fileName: a.fileName,
    name: a.fileName,
    mimeType: a.mimeType,
    byteLength: a.byteLength
  }));
}
function showAttachmentError(message) {
  const slot = document.getElementById("attachment-error");
  if (!slot) return;
  slot.textContent = String(message);
  slot.hidden = false;
}

function clearAttachmentError() {
  const slot = document.getElementById("attachment-error");
  if (!slot) return;
  slot.textContent = "";
  slot.hidden = true;
}
function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || "");
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error || new Error("FileReader failed"));
    reader.readAsDataURL(blob);
  });
}

function openAttachmentPicker() {
  const overlay = document.getElementById("attachment-picker-overlay");
  if (!overlay) return;
  const closeBtn = document.getElementById("attachment-picker-close");
  const pickInput = document.getElementById("attachment-picker-input");
  const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const modal = document.getElementById("attachment-picker-modal");
  overlay.hidden = false;
  // Ensure the file input is retriggerable after a prior cancel/repick:
  if (pickInput) pickInput.value = "";

  function close({ restoreFocus = true } = {}) {
    overlay.hidden = true;
    overlay.removeEventListener("keydown", onKeyDown);
    overlay.removeEventListener("click", onOverlayClick);
    if (closeBtn) closeBtn.removeEventListener("click", onCloseClick);
    if (pickInput) pickInput.removeEventListener("change", onPicked);
    if (modal) modal.removeEventListener("keydown", trapTab);
    if (restoreFocus && previouslyFocused && typeof previouslyFocused.focus === "function") {
      try {
        previouslyFocused.focus();
      } catch {}
    } else {
      // Fall back to the composer when an attachment-entry-path opened the modal.
      try {
        const composer = document.getElementById("composer-input");
        if (composer) composer.focus();
      } catch {}
    }
  }

  function onKeyDown(e) {
    if (e.key === "Escape") {
      e.preventDefault();
      close({ restoreFocus: true });
    }
  }
  function onOverlayClick(e) {
    if (e.target === overlay) close({ restoreFocus: true });
  }
  function onCloseClick() {
    close({ restoreFocus: true });
  }
  function onPicked() {
    const files = Array.from(pickInput.files || []);
    close({ restoreFocus: true });
    if (files.length) validateAndAppendFiles(files, { from: "picker" });
  }
  // Simple focus trap: keep linear Tab order inside the modal.
  function trapTab(e) {
    if (e.key !== "Tab") return;
    const focusables = Array.from(modal.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')).filter(
      (n) => n instanceof HTMLElement && !n.hasAttribute("hidden")
    );
    if (focusables.length === 0) {
      e.preventDefault();
      return;
    }
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  overlay.addEventListener("keydown", onKeyDown);
  overlay.addEventListener("click", onOverlayClick);
  if (closeBtn) closeBtn.addEventListener("click", onCloseClick);
  if (pickInput) pickInput.addEventListener("change", onPicked);
  if (modal) modal.addEventListener("keydown", trapTab);
  // Initial focus: pick input's label or the close button.
  try {
    if (modal) modal.focus();
    else if (closeBtn) closeBtn.focus();
  } catch {}
}

function autoGrow() {
  el.composerInput.style.height = "auto";
  // The cap lives only in CSS (max-height: min(160px, 40vh) on .composer
  // textarea) so there is one source of truth. getComputedStyle resolves
  // that min() to a concrete px value we can clamp scrollHeight against; if
  // that ever comes back non-finite (e.g. max-height: none), fall back to
  // the unclamped scrollHeight rather than reintroducing a hardcoded cap.
  const computedMax = parseFloat(getComputedStyle(el.composerInput).maxHeight);
  const cap = Number.isFinite(computedMax) ? computedMax : Infinity;
  el.composerInput.style.height = Math.min(cap, el.composerInput.scrollHeight) + "px";
}

// Slash skill picker (task 7.3 / specs/agent-skills.md "Searchable slash
// picker"). The catalog is fetched from the companion's skills list op the
// moment the panel boots and re-fetched every time the picker opens (so an
// enable/disable made in Settings > Skills while the panel stays open is
// picked up on the next "/" rather than needing a full panel reload) — see
// skills-client.js's own header for the wire-contract/scope note: until a
// host-owning session adds companion.js's `skills_list` op handler and
// background.js's relay, `listCatalog()` here rejects with a NETWORK_ERROR-
// shaped error, which this code surfaces as the picker's own honest empty
// state (never a fabricated skill list).
const skillsClient = createPanelSkillsClient();
let pickerItemsCache = []; // buildPickerItems() output from the last successful fetch
let pickerLoadFailed = false;
let pickerLoadInFlight = null;

function loadPickerCatalog() {
  if (pickerLoadInFlight) return pickerLoadInFlight; // coalesce concurrent triggers (e.g. fast typing)
  pickerLoadInFlight = (async () => {
    try {
      const catalog = await skillsClient.listCatalog();
      // The advertised-command record (repair-slash-dispatch-and-builtin-commands,
      // tasks.md 3.4) is fetched in the SAME round of loading as the skill
      // catalog above, but its own failure is caught SEPARATELY: a rejected
      // record fetch must still render the operator's skills, never blank
      // the whole picker over a built-in section that is allowed to be
      // absent (specs/agent-skills/spec.md "No advertised list yet" already
      // treats "nothing observed" as a normal state, not an error).
      let advertisedRecord = null;
      try {
        advertisedRecord = await skillsClient.getAdvertisedCommands();
      } catch {
        advertisedRecord = null;
      }
      pickerItemsCache = buildPickerItems(catalog, advertisedRecord);
      pickerLoadFailed = false;
    } catch {
      pickerItemsCache = [];
      pickerLoadFailed = true;
    } finally {
      pickerLoadInFlight = null;
    }
  })();
  return pickerLoadInFlight;
}

/** Tags each rendered `.slash-picker-item` with its `kind` ("skill" or
 * "builtin" — see skills-model.js's deriveBuiltinCommands()) via a page-local
 * data attribute + CSS rule (sidepanel.css), so built-in commands are
 * visually distinguished from skills (spec: "Built-in commands SHALL be
 * distinguished from skills") without editing the shared
 * extension/ui/behaviors.js component itself. */
function tagPickerItemKinds(items) {
  const rendered = el.slashPicker.querySelectorAll(".slash-picker-item");
  rendered.forEach((node, i) => {
    if (items[i]) node.dataset.kind = items[i].kind;
  });
}

el.slashPicker.attachToInput(el.composerInput);
el.slashPicker.addEventListener("ui-slash-select", (e) => {
  const item = e.detail;
  el.slashPicker.hide();
  if (!item) return;
  el.composerInput.value = buildInvocationText(item);
  el.composerInput.focus();
  const pos = el.composerInput.value.length;
  el.composerInput.setSelectionRange(pos, pos);
  autoGrow();
  updateSendEnabled();
});

let lastFilteredPickerItems = [];
function renderSlashPicker(query) {
  const filtered = filterPickerItems(pickerItemsCache, query);
  lastFilteredPickerItems = filtered;
  el.slashPicker.setItems(filtered);
  tagPickerItemKinds(filtered);
}

function updateSlashPicker() {
  const parsed = parseSlashQuery(el.composerInput.value);
  if (!parsed) {
    el.slashPicker.hide();
    return;
  }
  renderSlashPicker(parsed.query);
  el.slashPicker.show();
  if (!pickerLoadFailed) return;
  // Load failed earlier (or never attempted) — retry once per keystroke
  // burst rather than spamming the companion; the picker's own empty state
  // already covers "no items yet" visually while this resolves.
  loadPickerCatalog().then(() => renderSlashPicker(parseSlashQuery(el.composerInput.value)?.query ?? ""));
}

el.composerInput.addEventListener("input", () => {
  autoGrow();
  updateSendEnabled();
  updateSlashPicker();
  if (contextStaleNotice) {
    contextStaleNotice = null;
  }
  renderContextChip(); // re-evaluate the "will read this page" hint as the user types, and drop a stale notice once they act
});
el.composerInput.addEventListener("keydown", (e) => {
  // Ctrl+U: keyboard-accessible image picker. The modal traps focus, closes
  // with Escape/click-outside, restores focus to the composer on close, and
  // is styled via the same token/.card/.btn primitives. Keep this fallback:
  // Chrome may intercept Ctrl+U before this fires (reserved for "View Page
  // Source" in tab content). Design.md Decision 4 notes this risk — we still
  // honor the shortcut when the panel actually receives it.
  if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && (e.key === "u" || e.key === "U")) {
    if (!canAcceptAttachments()) return; // gated same as Send — inert when not ready
    e.preventDefault();
    openAttachmentPicker();
    return;
  }
  if (e.key === "Enter" && !e.shiftKey && !el.slashPicker.isVisible()) {
    e.preventDefault();
    doSend();
  }
});
// Ctrl+V clipboard paste while composer focused: extract an image item from
// ClipboardData when present; plain text is not an attachment.
el.composerInput.addEventListener("paste", (e) => {
  const dt = e.clipboardData;
  if (!dt || !canAcceptAttachments()) return;
  const files = [];
  if (dt.items) {
    for (const item of dt.items) {
      if (item.kind === "file" && item.type && ATTACHMENT_MIME_TYPES.has(String(item.type).toLowerCase())) {
        const f = item.getAsFile();
        if (f) files.push(f);
      }
    }
  }
  // Also handle drag-from-preview scenarios where files land in dt.files:
  if (files.length === 0 && dt.files) {
    for (const f of dt.files) {
      if (f && f.type && ATTACHMENT_MIME_TYPES.has(String(f.type).toLowerCase())) files.push(f);
    }
  }
  if (files.length === 0) return; // plain text paste: let the browser do its normal insert
  e.preventDefault();
  validateAndAppendFiles(files, { from: "paste" });
});

// Drag-and-drop onto the panel: accept dropped image Files, validate
// type/size client-side, and add to the attachment store. We listen on the
// composer wrap + transcript scroll so the whole chat view is a drop target
// without leaving the panel or navigating away.
function wireDragDrop(root) {
  if (!root) return;
  let depth = 0;
  const hasFiles = (e) => Array.from((e.dataTransfer && e.dataTransfer.types) || []).includes("Files");
  root.addEventListener("dragover", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault(); // allow drop
    if (e.dataTransfer) e.dataTransfer.dropEffect = canAcceptAttachments() ? "copy" : "none";
  });
  root.addEventListener("dragenter", (e) => {
    if (!hasFiles(e)) return;
    depth += 1;
    const composer = document.getElementById("composer");
    if (composer) composer.classList.add("is-drop-target");
  });
  root.addEventListener("dragleave", (e) => {
    if (!hasFiles(e)) return;
    depth = Math.max(0, depth - 1);
    if (depth === 0) {
      const composer = document.getElementById("composer");
      if (composer) composer.classList.remove("is-drop-target");
    }
  });
  root.addEventListener("drop", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault(); // never navigate away from the panel
    depth = 0;
    const composer = document.getElementById("composer");
    if (composer) composer.classList.remove("is-drop-target");
    if (!canAcceptAttachments()) return;
    const files = Array.from((e.dataTransfer && e.dataTransfer.files) || []);
    if (files.length) validateAndAppendFiles(files, { from: "drop" });
  });
}
wireDragDrop(el.panelScroll);
wireDragDrop(el.composerWrap || document.getElementById("composer-wrap"));

async function doSend() {
  // The composer is `readOnly` (not `disabled`) while an enhancement request
  // is in flight (design.md decision 6), so it still keeps focus and still
  // dispatches keydown -- Enter would otherwise reach here and START a run
  // against the pre-enhancement text out from under the outstanding request.
  // spec.md's "composer SHALL be read-only" requirement means dispatch is
  // blocked too, not just that typing is: bail here (covers both the Enter
  // path and a click on #btn-send, since both funnel through doSend()).
  if (enhanceState) return;
  const phase = panel.currentPhase();
  if (phase === RUN_PHASE.STREAMING || phase === RUN_PHASE.QUEUED || phase === RUN_PHASE.STOPPING || phase === RUN_PHASE.WAITING_FOR_PERMISSION) {
    panel.stop("user_stop");
    render();
    return;
  }
  const text = el.composerInput.value.trim();
  if (!text || !panel.currentConversationId) return;

  // Atomic Send-time binding (design.md 5b): re-validate the displayed
  // target against the live, authoritative browser state right now, rather
  // than trusting whatever the last listener-driven update left cached.
  let context = null;
  if (pageContext) {
    const { changed, context: fresh } = await pageContext.captureForSend();
    context = fresh;
    if (changed) {
      // The chip just got corrected to the real current target (captureForSend
      // already re-rendered it). Never dispatch against what was displayed a
      // moment ago — require an explicit second Send against the now-visible,
      // now-correct target instead.
      contextStaleNotice = "Ngữ cảnh trang đã thay đổi — đã cập nhật, nhấn Gửi lại để tiếp tục.";
      renderContextChip();
      return;
    }
  }
  contextStaleNotice = null;
  const tabScope = context && context.tabId != null ? [context.tabId] : "any";
  // Exact-message binding (spec "Composer attachment representation and message
  // binding"): snapshot the attachment list at THIS instant. That snapshot
  // travels with the START as an additive optional field; removing/adding an
  // attachment after this point never joins or leaves this run. The snapshot
  // is an array of ARTIFACT REFERENCES (id/mimeType/byteLength), never bytes —
  // bytes cross the wire via background's user_attachment chunk transport.
  const attachmentRefs = snapshotAttachments();
  const attachmentsSnapshot = attachments.slice();
  // Upload bytes to background's panelAttachmentStore before START, so the
  // companion can resolve them at model-turn construction. If background is
  // unavailable (tests/native host not connected), proceed with START anyway —
  // the companion will produce an explicit run error rather than silent text-only.
  // Ensure any attachment not yet synced by the eager validateAndAppendFiles path
  if (attachmentsSnapshot.length) {
    let uploadFailed = false;
    let uploadError = "";
    const hasChromeRuntime = typeof chrome !== "undefined" && chrome.runtime && typeof chrome.runtime.sendMessage === "function";
    for (const a of attachmentsSnapshot) {
      if (!a.blob) continue;
      const liveBefore = attachments.find((x) => x.blob === a.blob);
      if (liveBefore && liveBefore.id !== a.id) {
        a.id = liveBefore.id;
        const idx = attachmentsSnapshot.indexOf(a);
        if (idx >= 0 && attachmentRefs[idx]) attachmentRefs[idx].id = a.id;
        continue;
      }
      if (!hasChromeRuntime) continue;
      try {
        const base64 = await blobToBase64(a.blob);
        const res = await chrome.runtime.sendMessage({ type: "panelAttachmentAdd", id: a.id, base64, mimeType: a.mimeType });
        if (!res || res.ok !== true) {
          uploadFailed = true;
          uploadError = (res && (res.reason || res.error)) ? String(res.reason || res.error) : "Không thể tải ảnh đính kèm";
          break;
        }
        if (res.id && res.id !== a.id) {
          a.id = res.id;
          const live = attachments.find((x) => x.blob === a.blob);
          if (live) live.id = res.id;
          const idx2 = attachmentsSnapshot.indexOf(a);
          if (idx2 >= 0 && attachmentRefs[idx2]) attachmentRefs[idx2].id = res.id;
        }
      } catch (err) {
        uploadFailed = true;
        uploadError = err && err.message ? String(err.message) : "Không thể đọc ảnh đính kèm";
        break;
      }
    }
    if (uploadFailed) {
      showAttachmentError(uploadError);
      return;
    }
    if (attachmentRefs.length && hasChromeRuntime) {
      try {
        const attachmentIds = attachmentRefs.map((r) => r.id);
        const flushRes = await chrome.runtime.sendMessage({ type: "panelAttachmentSend", conversationId: panel.currentConversationId, attachmentIds });
        if (!flushRes || flushRes.ok !== true) {
          const reason = flushRes && (flushRes.reason || flushRes.error) ? String(flushRes.reason || flushRes.error) : "Không thể gửi ảnh tới agent";
          const detail = flushRes && Array.isArray(flushRes.failed) && flushRes.failed.length ? `: ${flushRes.failed.join(", ")}` : "";
          showAttachmentError(reason + detail);
          return;
        }
        const sent = Array.isArray(flushRes.sent) ? flushRes.sent : (Array.isArray(flushRes.results) ? flushRes.results.filter(r=>r.ok).map(r=>r.id) : []);
        if (sent.length !== attachmentRefs.length) {
          const missing = attachmentRefs.map(r=>r.id).filter(id => !sent.includes(id));
          showAttachmentError(`Ảnh chưa lưu được: ${missing.join(", ")}`);
          return;
        }
      } catch (err) {
        showAttachmentError(err && err.message ? String(err.message) : "Không thể gửi ảnh tới agent");
        return;
      }
    }
  }
  el.composerInput.value = "";
  autoGrow();
  clearAttachments();
  await panel.sendMessage(text, {
    tabScope,
    modelId: panel._selectedModelId,
    pageContext: context,
    attachments: attachmentRefs,
    effort: selectedEffort
  });
  render();
}
el.btnSend.addEventListener("click", doSend);

// ---- composer prompt enhancement (openspec/changes/add-composer-enhance-prompt) ----
//
// `enhanceState` (declared above updateSendEnabled()) is the single source of
// truth for "is a request in flight" -- doEnhance(), the reply handler below,
// and updateSendEnabled() all read/write that one slot, never a parallel flag.

function newEnhanceRequestId() {
  return typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Idle -> busy, or busy -> idle presentation for #btn-enhance. Mirrors
 * updateSendStopButton()'s icon/aria-label swap for Send/Stop above. */
function updateEnhanceButtonPresentation() {
  if (!el.btnEnhance) return;
  if (enhanceState) {
    el.btnEnhance.classList.add("is-busy");
    el.btnEnhance.setAttribute("aria-label", "Hủy cải thiện prompt");
    el.btnEnhance.innerHTML = iconMarkup("stop", { size: 16 });
  } else {
    el.btnEnhance.classList.remove("is-busy");
    el.btnEnhance.setAttribute("aria-label", "Cải thiện prompt");
    el.btnEnhance.innerHTML = iconMarkup("spark", { size: 18, title: "Cải thiện prompt" });
  }
}

/** Every exit path (success, cancel, error, unsupported companion,
 * disconnect) funnels through here except the success path itself (which
 * commits the rewritten text instead of the original -- see
 * handleEnhanceEnvelope()'s ok:true branch below). Restores the exact
 * pre-request text, clears busy state, and — only when a failure reason is
 * given — surfaces it through the composer's existing alert slot (spec.md
 * "Enhancement fails": "shown to the operator as a distinguishable message,
 * never as a silent no-op"). A silent cancel passes no message on purpose:
 * the operator asked for exactly this outcome. */
function restoreEnhanceState({ message } = {}) {
  if (!enhanceState) return;
  const { originalText } = enhanceState;
  enhanceState = null;
  el.composerInput.readOnly = false;
  el.composerInput.removeAttribute("aria-busy");
  el.composerInput.value = originalText;
  autoGrow();
  updateEnhanceButtonPresentation();
  updateSendEnabled();
  if (message) showAttachmentError(message);
}

/** The ok:true path: commit the rewritten text through the browser's own
 * text-insertion path (focus -> select -> execCommand("insertText")) so the
 * replacement lands on the native undo stack and Ctrl+Z restores the
 * pre-enhancement draft -- design.md decision 6, spec.md "Undo restores the
 * draft". This is why no separate Revert control exists. execCommand is
 * deprecated but still the only DOM API that joins the browser's own undo
 * history from script; the plain-assignment fallback below still lands the
 * correct text (just without native undo) if a future browser removes it. */
function commitEnhancedText(text) {
  enhanceState = null;
  el.composerInput.readOnly = false;
  el.composerInput.removeAttribute("aria-busy");
  el.composerInput.focus();
  el.composerInput.select();
  let applied = false;
  try {
    applied = typeof document.execCommand === "function" && document.execCommand("insertText", false, text);
  } catch {
    applied = false;
  }
  if (!applied) el.composerInput.value = text;
  autoGrow();
  updateEnhanceButtonPresentation();
  updateSendEnabled();
}

/** The companion's reply to enhance_prompt, plus the one ERROR shape a
 * companion that has never heard of this message type answers with
 * (protocol.js's handleEnvelope() default: branch). Any reply whose
 * requestId does not match the current state — including every reply that
 * arrives after a cancel already restored the composer locally — is dropped
 * (spec.md "Operator cancels": "any reply that arrives afterwards for that
 * request is ignored"). */
function handleEnhanceEnvelope(env) {
  if (!enhanceState) return;
  if (env.type === MSG.ENHANCE_PROMPT) {
    if (env.requestId !== enhanceState.requestId) return; // stale reply, ignored
    if (env.ok) {
      const text = env.result && typeof env.result.text === "string" ? env.result.text : "";
      if (!text.trim()) {
        // Defense in depth: the companion already classifies an empty/
        // whitespace-only rewrite as its own failure (EMPTY_RESULT), so this
        // should never actually fire -- but the composer must never be
        // replaced with nothing regardless of which side would have caught it.
        restoreEnhanceState({ message: "Không nhận được nội dung cải thiện từ companion." });
        return;
      }
      commitEnhancedText(text);
      return;
    }
    const message = (env.error && env.error.message) || "Không thể cải thiện prompt.";
    restoreEnhanceState({ message });
    return;
  }
  if (env.type === MSG.ERROR && env.reason === "unknown_message_type" && env.inReplyTo === MSG.ENHANCE_PROMPT) {
    restoreEnhanceState({ message: "Companion cần được cập nhật để hỗ trợ cải thiện prompt." });
  }
}
protocolClient.onEnvelope(handleEnhanceEnvelope);
protocolClient.onDisconnect(() => {
  if (enhanceState) restoreEnhanceState({ message: "Mất kết nối với companion — đã khôi phục bản nháp." });
});

function doEnhance() {
  if (enhanceState) {
    // In flight: this control now acts as Cancel (design.md decision 6).
    // Restore immediately, locally -- do not wait for any reply. Any reply
    // that lands afterwards (the cancel's own ack, or the aborted generate's
    // CANCELLED failure) is dropped by handleEnhanceEnvelope() above because
    // enhanceState is already null by the time it arrives.
    const { requestId } = enhanceState;
    restoreEnhanceState();
    protocolClient.enhancePrompt({ requestId, op: "cancel" });
    return;
  }
  if (el.btnEnhance.disabled) return; // defensive: a disabled button should never dispatch a click anyway
  const originalText = el.composerInput.value;
  const requestId = newEnhanceRequestId();
  enhanceState = { requestId, originalText };
  el.composerInput.readOnly = true;
  el.composerInput.setAttribute("aria-busy", "true");
  updateEnhanceButtonPresentation();
  updateSendEnabled();
  protocolClient.enhancePrompt({
    requestId,
    op: "generate",
    prompt: originalText,
    // Same sources panel-controller.js's sendMessage() uses for START, so the
    // rewrite is produced by the exact provider/model the turn will run
    // against (design.md decision 1).
    profileId: panel.profile && panel.profile.profileId,
    modelId: panel._selectedModelId || (panel.profile && panel.profile.defaultModelId)
  });
}
el.btnEnhance.addEventListener("click", doEnhance);

// The "+" menu's one item opens the same picker Ctrl+U does — one entry point
// implemented once, so the two can never diverge.
el.addMenuFiles.addEventListener("click", () => {
  el.addMenuWrap.close?.();
  if (!canAcceptAttachments()) return; // gated exactly as Send and Ctrl+U are
  openAttachmentPicker();
});
restoreEffort();
// ---- history / recordings view ------------------------------------------

function showHistoryView() {
  el.chatView.style.display = "none";
  el.historyView.hidden = false;
  refreshHistoryView();
}
function showChatView() {
  el.historyView.hidden = true;
  el.chatView.style.display = "flex";
  render();
}
el.btnHistory.addEventListener("click", showHistoryView);
el.btnHistoryBack.addEventListener("click", showChatView);
// Starting a new chat from the panel is the OPERATOR acting, so it gets an
// operator's tab: a fresh one OUTSIDE the assistant's tab group. Only tabs the
// assistant itself opens (background.js adopts those into the group) belong
// inside it. Chrome does not inherit the group for an opener-less
// tabs.create(), but a window whose active tab is grouped can still land the
// new tab in that group, so ungroup explicitly when it does.
async function openOperatorTab() {
  if (typeof chrome === "undefined" || !chrome.tabs || typeof chrome.tabs.create !== "function") return;
  try {
    const tab = await chrome.tabs.create({ active: true });
    if (tab && tab.groupId != null && tab.groupId !== -1 && chrome.tabs.ungroup) {
      await chrome.tabs.ungroup([tab.id]);
    }
  } catch {
    // No tab to open (window closing, API unavailable) — the new conversation
    // itself still starts; the tab is a convenience, never a precondition.
  }
}

// A new conversation that starts with NO page bound, unlike the one in the
// history header (which opens a fresh operator tab and lets the tracker bind
// it). Two different needs: that one is "start somewhere new", this one is
// "start with nothing attached" — asking a question that has nothing to do
// with whatever page happens to be open, without the panel quietly handing the
// model that page's URL and title. clear() is what the chip's own X already
// does, so the resulting state is one the operator can already reach and
// recognise; it just stops being a two-step chore.
el.btnNewChat.addEventListener("click", async () => {
  await panel.startNewConversation();
  if (pageContext) pageContext.clear();
  showChatView();
});

el.btnHistoryNew.addEventListener("click", async () => {
  await panel.startNewConversation();
  await openOperatorTab();
  showChatView();
});

async function refreshHistoryView() {
  const conversations = await historyStore.list();
  el.conversationList.innerHTML = "";
  if (!conversations.length) {
    el.conversationList.innerHTML = `<p class="field-hint">Chưa có cuộc trò chuyện nào.</p>`;
  }
  for (const c of conversations) {
    const row = document.createElement("div");
    row.className = "list-item";
    if (c.conversationId === panel.currentConversationId) row.setAttribute("aria-current", "true");
    row.innerHTML = `
      <span class="list-item-icon">${iconMarkup("page", { size: 18 })}</span>
      <span class="list-item-main">
        <span class="list-item-title"></span>
        <span class="list-item-sub"></span>
      </span>
      ${c.interrupted ? `<span class="status-pill is-unknown">Bị gián đoạn</span>` : ""}
      <button class="btn-icon" data-act="open" aria-label="Mở lại cuộc trò chuyện">${iconMarkup("externalLink", { size: 16 })}</button>
      <button class="btn-icon" data-act="delete" aria-label="Xóa cuộc trò chuyện">${iconMarkup("trash", { size: 16 })}</button>
    `;
    row.querySelector(".list-item-title").textContent = c.title || "Cuộc trò chuyện";
    row.querySelector(".list-item-sub").textContent = new Date(c.updatedAt || c.createdAt || Date.now()).toLocaleString("vi-VN") + (c.hostname ? ` · ${c.hostname}` : "");
    row.querySelector('[data-act="open"]').addEventListener("click", async () => {
      await panel.reopenConversation(c.conversationId);
      showChatView();
    });
    row.querySelector('[data-act="delete"]').addEventListener("click", async () => {
      const confirmed = window.confirm(
        `Xóa cuộc trò chuyện "${c.title || c.conversationId}" khỏi danh sách này trên thiết bị này? ` +
          `Thao tác này chỉ xóa khỏi danh sách trên trình duyệt này — không đảm bảo xóa dữ liệu đã lưu trên máy chủ companion.`
      );
      if (!confirmed) return;
      await panel.deleteConversationLocally(c.conversationId);
      refreshHistoryView();
    });
    el.conversationList.appendChild(row);
  }

  await refreshRecordingsStatus();
  const recordings = await listRecordings();
  el.recordingList.innerHTML = "";
  for (const r of recordings) {
    const row = document.createElement("div");
    row.className = "list-item";
    row.innerHTML = `
      <span class="list-item-icon">${iconMarkup("mic", { size: 18 })}</span>
      <span class="list-item-main">
        <span class="list-item-title"></span>
        <span class="list-item-sub"></span>
      </span>
      <button class="btn btn-secondary btn-sm" type="button">Đính kèm</button>`;
    row.querySelector(".list-item-title").textContent = r.title;
    row.querySelector(".list-item-sub").textContent = r.durationLabel + (r.hasNarrationIssue ? " · lỗi tường thuật" : "") + (r.hostname ? ` · ${r.hostname}` : "");
    row.querySelector("button").addEventListener("click", async () => {
      await recordingsClient.attach(r);
      window.alert(
        "Đã gửi bản ghi để đính kèm. Bản ghi chỉ thực sự gắn vào cuộc trò chuyện này nếu cuộc trò chuyện đang giữ quyền điều khiển trình duyệt tại thời điểm này."
      );
    });
    el.recordingList.appendChild(row);
  }
}

async function refreshRecordingsStatus() {
  const status = await recordingsClient.status();
  el.recorderStatusLabel.textContent = status.unavailable
    ? "Không thể kết nối tới phần ghi âm."
    : status.active
      ? "Đang ghi âm…"
      : "Chưa ghi âm.";
  el.btnToggleRecording.textContent = status.active ? "Dừng ghi âm" : "Bắt đầu ghi";
  el.btnToggleRecording.disabled = !!status.busy;
}
el.btnToggleRecording.addEventListener("click", async () => {
  el.btnToggleRecording.disabled = true;
  await recordingsClient.toggle();
  await refreshRecordingsStatus();
  el.btnToggleRecording.disabled = false;
});

// ---- boot ---------------------------------------------------------------

// Tell the service worker which of the operator's tabs the panel is bound to,
// so it can be shown inside the agent tab group. This fires on every context
// change including the first one at startup, so simply opening the panel on a
// page is enough — no message needs to be sent for the tab to appear grouped.
//
// Adoption is presentation, not permission: background.js keeps an adopted tab
// borrowed (read-only, invisible to legacy MCP clients) and restores its
// previous group when the panel moves on. Failures here are deliberately
// silent — grouping is a convenience, and losing it must never block chatting.
let adoptedContextTabId = null;
function syncAdoptedTabGroup() {
  const snap = pageContext?.snapshot();
  // A tab the operator opened themselves — New Tab, a browser page, an
  // extension page — is none of the assistant's business: leave it where it
  // is and keep whatever page was already adopted. Only a real content page
  // the panel is bound to is worth showing inside the group, and `restricted`
  // is already exactly that distinction (page-context.js's RESTRICTED_URL_PATTERN,
  // which matches chrome://newtab, about:blank and friends). Doing nothing
  // here also avoids churning the group every time the operator glances at
  // another tab and comes back.
  if (!snap || snap.removed || snap.restricted) return;
  const tabId = snap.tabId;
  if (tabId === adoptedContextTabId) return;
  const previousTabId = adoptedContextTabId;
  adoptedContextTabId = tabId;
  try {
    chrome.runtime.sendMessage({ type: "panel_bind_tab", tabId, previousTabId }, () => {
      void chrome.runtime.lastError; // never surface: see note above
    });
  } catch {
    // sendMessage can throw if the worker is mid-restart; the next context
    // change re-syncs, so there is nothing useful to do here.
  }
}

async function boot() {
  panel.onUpdate(render);
  const windowId = await currentWindowId();
  pageContext = new PageContextTracker({ windowId });
  pageContext.onChange(() => {
    contextStaleNotice = null;
    renderContextChip();
    syncAdoptedTabGroup();
  });
  await pageContext.start();
  loadPickerCatalog(); // fire-and-forget: first "/" press already has this resolved (or the picker's own empty state covers the not-yet-loaded gap)
  await panel.init();
  // Resumes the conversation the operator was last looking at (persisted via
  // history-store.js's `setLastActive()`, updated by every one of
  // panel-controller.js's active-conversation transitions through its
  // `_setCurrentConversationId()` setter), falling back to a new conversation
  // when there is nothing restorable — see restoreOrStartConversation()'s own
  // header comment for the full restorable/fallback contract. Replaces the
  // old unconditional `if (!panel.currentConversationId) startNewConversation()`
  // check, which is what discarded the operator's place on every panel
  // reopen and browser restart.
  await panel.restoreOrStartConversation();
  render();
}

const bootPromise = boot();

// Debug/QA hook only — no production code path reads this. Exposes the
// controller instance (and, for task 5.8's context-chip states, the page-
// context tracker + a re-render trigger) so a local visual-QA harness (see
// extension/sidepanel/_qa_harness*.js, deleted before this task ships — not
// part of the shipped extension) can drive real sendMessage/stop/
// reopenConversation/pin/unpin/clear calls without duplicating this file's
// own wiring. Harmless: neither object holds credentials or secrets, only
// the same conversation/page-context state already visible in the DOM. Set
// once boot() actually assigns `pageContext` (it starts out null), not at
// module-eval time — boot() is fire-and-forget async.
if (typeof window !== "undefined") {
  window.__browzyPanelDebug = panel;
  window.__browzyRenderDebug = render;
  bootPromise.then(() => {
    window.__browzyPageContextDebug = pageContext;
  });
  // Same debug-only, no-production-code-path convention as the hooks above
  // — lets this task's own visual-QA screenshot capture force slash-picker
  // states (populated/filtered/long-description) without a live companion
  // (see the "Environment constraint" this task's brief documents).
  window.__browzySkillsPickerDebug = {
    setCatalog(catalog) {
      pickerItemsCache = buildPickerItems(catalog);
      pickerLoadFailed = false;
    },
    open(query = "") {
      el.composerInput.value = "/" + query;
      renderSlashPicker(query);
      el.slashPicker.show();
    },
    close() {
      el.slashPicker.hide();
    }
  };
}

// ===================== Document detail viewer ==============================
//
// The two-tab modal a document card opens. Preview renders the document;
// Markdown shows its source, or — for a binary format — the text, tables or
// slide outline extracted from it, so the content stays readable, copyable and
// searchable in every format.
//
// The safety rule this implements: only markdown-lite output, which escapes
// every character before formatting, is inserted into the panel's own DOM.
// Everything a converter produces as HTML goes into an <iframe sandbox srcdoc>
// with neither allow-scripts nor allow-same-origin, so a <script> or an
// onerror attribute inside a document is inert and cannot reach the panel,
// chrome.*, or storage.

const docViewer = {
  documentId: null,
  meta: null,
  bytes: null,
  tab: "preview",
  lastFocused: null,
  // Aborts an in-flight PDF render when the operator closes the viewer or
  // switches tabs mid-way through a long document.
  renderAbort: null
};

function documentViewerElements() {
  return {
    overlay: $("document-viewer-overlay"),
    modal: $("document-viewer-modal"),
    icon: $("document-viewer-icon"),
    title: $("document-viewer-title"),
    sub: $("document-viewer-sub"),
    note: $("document-viewer-note"),
    body: $("document-viewer-body"),
    tabPreview: $("document-tab-preview"),
    tabMarkdown: $("document-tab-markdown"),
    download: $("document-viewer-download"),
    close: $("document-viewer-close")
  };
}

/** Metadata for a document id, read from the current conversation's turns. */
function findDocumentMeta(documentId) {
  const model = panel.currentModel();
  if (!model) return null;
  for (const item of model.items) {
    for (const doc of item.documents || []) {
      if (doc.documentId === documentId) return doc;
    }
  }
  return null;
}

async function openDocumentViewer(documentId) {
  const meta = findDocumentMeta(documentId);
  if (!meta) return;
  const ui = documentViewerElements();

  docViewer.documentId = documentId;
  docViewer.meta = meta;
  docViewer.bytes = null;
  docViewer.tab = "preview";
  docViewer.lastFocused = document.activeElement;

  ui.icon.innerHTML = iconMarkup("fileText", { size: 20 });
  ui.download.innerHTML = iconMarkup("download", { size: 16 });
  ui.close.innerHTML = iconMarkup("close", { size: 16 });
  ui.title.textContent = meta.title;
  const label = (DOCUMENT_FORMAT_LABELS[meta.format] || meta.format || "").toUpperCase();
  ui.sub.textContent = `${meta.fileName} · ${label} · ${formatBytes(meta.byteLength)}`;
  setDocumentViewerTab("preview");
  ui.body.textContent = "Đang tải tài liệu…";
  ui.body.className = "document-viewer-body doc-viewer-status";
  ui.overlay.hidden = false;
  ui.modal.focus();

  const result = await panel.fetchDocument(documentId);
  // The operator may have closed the viewer, or opened another document, while
  // the bytes were in flight — render only if this is still the open document.
  if (docViewer.documentId !== documentId) return;
  if (!result.found) {
    showDocumentUnavailable(result.reason);
    return;
  }
  docViewer.bytes = result.bytes;
  renderDocumentTab();
}

function closeDocumentViewer() {
  const ui = documentViewerElements();
  if (docViewer.renderAbort) docViewer.renderAbort.abort();
  docViewer.renderAbort = null;
  docViewer.documentId = null;
  docViewer.meta = null;
  docViewer.bytes = null;
  ui.body.innerHTML = "";
  ui.overlay.hidden = true;
  if (docViewer.lastFocused && docViewer.lastFocused.focus) docViewer.lastFocused.focus();
  docViewer.lastFocused = null;
}

function setDocumentViewerTab(tab) {
  const ui = documentViewerElements();
  docViewer.tab = tab;
  ui.tabPreview.classList.toggle("is-active", tab === "preview");
  ui.tabMarkdown.classList.toggle("is-active", tab === "markdown");
  ui.tabPreview.setAttribute("aria-selected", tab === "preview" ? "true" : "false");
  ui.tabMarkdown.setAttribute("aria-selected", tab === "markdown" ? "true" : "false");

  const extracted = tab === "preview" && docViewer.meta && EXTRACTED_PREVIEW_FORMATS.has(docViewer.meta.format);
  ui.note.hidden = !extracted;
  if (extracted) {
    ui.note.textContent =
      "Bản xem trước của PowerPoint là nội dung trích xuất (tiêu đề và ý từng slide), không phải bản dựng hình đầy đủ.";
  }
}

function showDocumentUnavailable(reason) {
  const ui = documentViewerElements();
  ui.body.className = "document-viewer-body doc-viewer-status";
  ui.body.textContent = `Không mở được tài liệu: ${reason || "không rõ nguyên nhân"}.`;
}

async function renderDocumentTab() {
  const ui = documentViewerElements();
  const meta = docViewer.meta;
  const bytes = docViewer.bytes;
  if (!meta || !bytes) return;

  if (docViewer.renderAbort) docViewer.renderAbort.abort();
  docViewer.renderAbort = new AbortController();
  const { signal } = docViewer.renderAbort;
  const documentId = docViewer.documentId;
  const tab = docViewer.tab;

  ui.body.className = "document-viewer-body doc-viewer-status";
  ui.body.textContent = "Đang dựng nội dung…";

  const dark =
    document.documentElement.getAttribute("data-theme") === "dark" ||
    (!document.documentElement.hasAttribute("data-theme") && matchMedia("(prefers-color-scheme: dark)").matches);

  const view =
    tab === "preview"
      ? await buildPreview(meta.format, bytes, { title: meta.title, dark })
      : await buildMarkdown(meta.format, bytes, { title: meta.title });

  // Same staleness guard as the fetch: a slow conversion must not paint over
  // whatever the operator switched to in the meantime.
  if (signal.aborted || docViewer.documentId !== documentId || docViewer.tab !== tab) return;

  ui.body.className = "document-viewer-body";
  ui.body.innerHTML = "";
  paintDocumentView(ui.body, view, signal);
}

function paintDocumentView(container, view, signal) {
  switch (view.kind) {
    case "markdown": {
      // The one representation allowed into the panel's own DOM: every
      // character of it was escaped before any formatting was applied.
      const prose = document.createElement("div");
      prose.className = "prose";
      prose.innerHTML = renderMarkdownLite(view.text);
      container.appendChild(prose);
      break;
    }
    case "text": {
      const pre = document.createElement("pre");
      pre.className = "doc-plain";
      pre.textContent = view.text;
      container.appendChild(pre);
      break;
    }
    case "table": {
      container.appendChild(buildDocumentTable(view.header, view.rows));
      break;
    }
    case "html": {
      // Untrusted by definition. No allow-scripts, no allow-same-origin: the
      // frame cannot run code, cannot reach this document, and cannot read
      // extension storage.
      //
      // `sandbox` stops scripts; it does NOT stop the network, and this
      // extension holds <all_urls>. A document carrying an <img> pointed at an
      // attacker would beacon on preview. The rendered document carries its own
      // policy meta (viewers/ooxml.js, and the host's html generator); this
      // attribute is the second lock on the same door, for the case of a
      // document that arrived with a head this panel did not write.
      const frame = document.createElement("iframe");
      frame.className = "doc-frame";
      frame.setAttribute("sandbox", "");
      frame.setAttribute("csp", "default-src 'none'; style-src 'unsafe-inline'; img-src data:");
      frame.setAttribute("referrerpolicy", "no-referrer");
      frame.srcdoc = view.html;
      container.appendChild(frame);
      break;
    }
    case "pdf": {
      const status = document.createElement("div");
      status.className = "doc-viewer-status";
      status.textContent = "Đang dựng trang PDF…";
      container.appendChild(status);
      import("./viewers/pdf-viewer.js")
        .then(({ renderPdfPages }) =>
          renderPdfPages(view.bytes, container, { width: Math.max(280, container.clientWidth - 24), signal })
        )
        .then(() => status.remove())
        .catch((err) => {
          status.textContent = `Không dựng được PDF: ${err.message}`;
        });
      break;
    }
    case "unavailable":
    default: {
      const status = document.createElement("div");
      status.className = "doc-viewer-status";
      status.textContent = `Không hiển thị được: ${view.reason || "định dạng không hỗ trợ"}.`;
      container.appendChild(status);
      break;
    }
  }
}

function buildDocumentTable(header, rows) {
  const table = document.createElement("table");
  table.className = "doc-table";
  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  for (const cell of header) {
    const th = document.createElement("th");
    th.textContent = cell;
    headRow.appendChild(th);
  }
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  for (const row of rows) {
    const tr = document.createElement("tr");
    for (let i = 0; i < header.length; i += 1) {
      const td = document.createElement("td");
      td.textContent = row[i] ?? "";
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  return table;
}

/**
 * Save a document to the operator's machine.
 *
 * A blob URL plus `<a download>`: no `downloads` permission, no network
 * request, and nothing leaves the machine. The URL is revoked right after the
 * click so the bytes are not pinned in memory by the object URL registry.
 */
async function downloadDocument(documentId) {
  const meta = findDocumentMeta(documentId);
  if (!meta) return;
  const result = await panel.fetchDocument(documentId);
  if (!result.found) {
    showDocumentUnavailable(result.reason);
    return;
  }
  const blob = new Blob([result.bytes], { type: meta.mimeType || "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = meta.fileName || "document";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function wireDocumentViewer() {
  const ui = documentViewerElements();
  if (!ui.overlay) return;
  ui.close.addEventListener("click", closeDocumentViewer);
  ui.download.addEventListener("click", () => {
    if (docViewer.documentId) downloadDocument(docViewer.documentId);
  });
  ui.tabPreview.addEventListener("click", () => {
    if (docViewer.tab === "preview") return;
    setDocumentViewerTab("preview");
    renderDocumentTab();
  });
  ui.tabMarkdown.addEventListener("click", () => {
    if (docViewer.tab === "markdown") return;
    setDocumentViewerTab("markdown");
    renderDocumentTab();
  });
  // Clicking the scrim closes; clicking inside the modal does not.
  ui.overlay.addEventListener("click", (event) => {
    if (event.target === ui.overlay) closeDocumentViewer();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !ui.overlay.hidden) {
      event.preventDefault();
      closeDocumentViewer();
    }
  });
}

wireDocumentViewer();
