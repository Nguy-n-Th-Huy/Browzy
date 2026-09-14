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
import { PageContextTracker, sameIdentity } from "./page-context.js";
import { referencesCurrentPage } from "./context-binding.js";
import { RecordingsClient, listRecordings } from "./recordings-model.js";
import { HistoryListView, historyErrorText } from "./history-view.js";
import { HistoryPrivacyControls } from "./history-privacy.js";
import { normalizeExportFormat } from "./history-export.js";
import { toolRowDisplay } from "./conversation-model.js";
import { RUN_PHASE, PHASE_LABEL_VI, BUSY_LABEL_VI, phaseVisualClass, MESSAGE_QUEUE_LABEL_VI, QUEUE_FALLBACK_NOTE_VI, QUEUE_PAUSED_NOTE_VI } from "./run-states.js";
import { renderMarkdownLite, escapeHtml } from "./markdown-lite.js";
import { createPanelSkillsClient } from "./skills-client.js";
import { buildPickerItems, filterPickerItems, parseSlashQuery, buildInvocationText } from "./skills-model.js";
import { createPermissionsClient, PermissionsErrorLike } from "./permissions-client.js";
import { PERMISSION_MODES, modeLabel, modeDescription, protectedCategoryLabel } from "../ui/permission-labels.js";
import { viewWarning, viewRiskContext } from "../ui/threat-labels.js";
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
  downloadDecisionSlot: $("download-decision-slot"),
  questionSlot: $("question-slot"),
  modeTrigger: $("mode-trigger"),
  modeTriggerLabel: $("mode-trigger-label"),
  modeTriggerIcon: $("mode-trigger-icon"),
  modeMenu: $("mode-menu"),
  modeMenuWrap: $("mode-menu-wrap"),
  contextChipRow: $("context-chip-row"),
  composerWrap: $("composer-wrap"),
  composerInput: $("composer-input"),
  btnAdd: $("btn-add"),
  addMenuWrap: $("add-menu-wrap"),
  addMenuFiles: $("add-menu-files"),
  iconAddFiles: $("icon-add-files"),
  btnDesignMode: $("btn-design-mode"),
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
  btnHistoryClearAll: $("btn-history-clear-all"),
  iconNewPlus: $("icon-new-plus"),
  historyScroll: $("history-scroll"),
  conversationList: $("conversation-list"),
  historySearch: $("history-search"),
  historyFrom: $("history-from"),
  historyTo: $("history-to"),
  historyDomain: $("history-domain"),
  historyFilterSummary: $("history-filter-summary"),
  btnHistoryClearFilters: $("btn-history-clear-filters"),
  historyStatus: $("history-status"),
  historyPrivacyToggle: $("history-privacy-toggle"),
  historyRetentionOutcome: $("history-retention-outcome"),
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
// "click" (not a new icon — extension/ui/** is shared and not edited by this
// change) is the closest existing glyph to "pick an element by clicking it".
if (el.btnDesignMode) el.btnDesignMode.innerHTML = iconMarkup("click", { size: 18, title: "Chọn phần tử trên trang" });
el.btnEnhance.innerHTML = iconMarkup("spark", { size: 18, title: "Cải thiện prompt" });
el.modelChevron.innerHTML = iconMarkup("chevronDown", { size: 14 });
el.iconMicRow.innerHTML = iconMarkup("mic", { size: 18 });

// ---- message queue + steering controls (openspec/changes/
// add-message-queue-and-steering, tasks.md 6.1/6.2) ------------------------
//
// Built here rather than added to sidepanel.html/sidepanel.css, which this
// change does not own: the panel's markup and stylesheet are shared surfaces,
// while the behaviour this change adds is the panel's own. Everything below
// reuses primitives that already exist — `.btn-icon`/`.is-danger-solid` and
// `.btn.btn-sm.btn-secondary` from extension/ui/components.css,
// `.active-control-banner` from sidepanel.css — so no new visual vocabulary
// enters the panel.
//
// #btn-stop exists because Stop can no longer live on #btn-send: submitting
// now QUEUES behind the active run (panel spec "Composer remains usable while
// a run is active"), so the Send control keeps sending and the run's own
// control gets its own button (panel spec "the run's Stop remains the
// available control"). #btn-run-now is the explicit interrupt choice — the
// design deliberately leaves its placement to the implementation, and it sits
// beside Send because it is the same action, only now instead of after this
// turn. Both are hidden while no run is active, where they would mean nothing
// (an idle Send already runs immediately).
//
// A named function rather than straight-line module code so the construction
// is drivable in a plain-Node test against test/_fake-dom.mjs, the same way
// history-view.js's own element construction is (see that file's TESTABILITY
// note). It builds with createElement/textContent/setAttribute only — no
// innerHTML and no querySelector — which is exactly what that harness
// implements.
//
// Visibility is toggled through `style.display`, NOT the `hidden` attribute:
// `.btn-icon`, `.btn` and `.active-control-banner` each declare their own
// `display`, and an author class rule beats the UA's `[hidden]{display:none}`.
// The repository's convention is a matching `X[hidden]` rule per element (see
// `.attachment-error[hidden]`, `.slash-picker[hidden]` in
// extension/ui/components.css), and sidepanel.css is not this change's file —
// so the three controls carry their visibility in an inline style instead of
// depending on a rule that cannot be added here. Assigning `""` restores
// whatever the class declares (inline-flex for the buttons, flex for the
// banner).
function installQueueControls() {
  const btnStop = document.createElement("button");
  btnStop.setAttribute("type", "button");
  btnStop.setAttribute("id", "btn-stop");
  btnStop.className = "btn-icon is-danger-solid";
  btnStop.setAttribute("aria-label", "Dừng");
  btnStop.setAttribute("title", "Dừng lượt đang chạy");
  btnStop.innerHTML = iconMarkup("stop", { size: 16 });
  btnStop.style.display = "none";

  const btnRunNow = document.createElement("button");
  btnRunNow.setAttribute("type", "button");
  btnRunNow.setAttribute("id", "btn-run-now");
  btnRunNow.className = "btn btn-sm btn-secondary";
  btnRunNow.textContent = "Chạy ngay";
  btnRunNow.setAttribute("aria-label", "Chạy ngay: dừng lượt hiện tại và gửi tin nhắn này ngay");
  btnRunNow.setAttribute("title", "Dừng lượt hiện tại và gửi tin nhắn này ngay (Ctrl+Enter)");
  btnRunNow.style.display = "none";

  const actions = el.btnSend.parentNode;
  actions.insertBefore(btnStop, el.btnSend);
  actions.insertBefore(btnRunNow, btnStop);

  // The paused-drain banner (design.md decision 5): shown while the host's
  // durable `queuePaused` says the drain is stopped, carrying the ONE control
  // that clears it. Sits directly above the composer, beside the other
  // composer-scoped notices, because it is a statement about what pressing Send
  // will do next.
  const banner = document.createElement("div");
  banner.className = "active-control-banner";
  banner.setAttribute("id", "queue-paused-banner");
  banner.setAttribute("role", "status");
  banner.style.display = "none";
  const note = document.createElement("span");
  note.textContent = QUEUE_PAUSED_NOTE_VI;
  const resume = document.createElement("button");
  resume.setAttribute("type", "button");
  resume.setAttribute("id", "btn-resume-queue");
  resume.className = "btn btn-sm btn-secondary";
  resume.textContent = "Tiếp tục";
  resume.setAttribute("title", "Chạy các tin nhắn đang chờ theo thứ tự đã gửi");
  banner.appendChild(note);
  banner.appendChild(resume);
  el.composerWrap.insertBefore(banner, el.composerInput.parentNode);

  return { btnStop, btnRunNow, banner, resumeButton: resume };
}

{
  const queueControls = installQueueControls();
  el.btnStop = queueControls.btnStop;
  el.btnRunNow = queueControls.btnRunNow;
  el.queuePausedBanner = queueControls.banner;
  el.btnResumeQueue = queueControls.resumeButton;
}

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

// scope-conversation-restore-per-tab (design.md "Scope by the tab the panel
// booted on, captured once"): this panel document's own restore scope, set
// EXACTLY ONCE by `boot()` after `pageContext.start()` resolves and never
// reassigned again — see that function's own comment for why the freeze has
// to happen there rather than here (the panel's tab is not known yet at
// module-eval time, only after the tracker's first live query). `null` until
// then, which the resolver below passes straight through: `PanelController`
// treats a null scope as "no identifiable scope" (spec's own fallback
// trigger) and starts a fresh conversation rather than restoring one, which
// is exactly correct for the narrow window between module load and the
// scope actually resolving.
let panelScope = null;

const panel = new PanelController({
  protocolClient,
  historyStore,
  profileCache,
  // Production: no separate hello from this panel — see panel-controller.js's
  // init() for why (background.js's own "ocic-agent" relay already performs
  // the real hello and replays current handshake state to a late-connecting
  // port).
  identity: async () => ({}),
  // A RESOLVER, not the value itself (panel-controller.js's constructor doc):
  // `panel` is constructed here, before `boot()` has had any chance to reach
  // `pageContext.start()`, so the only thing that can be handed over at this
  // point is a closure reading the module-level `panelScope` variable boot()
  // will freeze later. Every call this controller makes reads `panelScope`
  // fresh, so once boot() assigns it, every subsequent history-store read/
  // write is correctly scoped — and because boot() never reassigns it again,
  // "read once, never re-read" holds all the way through.
  scope: () => panelScope
});

let pageContext = null;

// tasks.md 2.3: the debounced local cache and any queued presentation
// metadata must not die with the document. `pagehide` fires when the tab is
// closed AND when the side panel document itself is torn down, so this is the
// last chance to persist what the debounce window still holds.
window.addEventListener("pagehide", () => {
  try {
    panel.flushHistory();
  } catch {
    /* best-effort at unload — never block teardown */
  }
});

// Live synchronization (spec chat-history-browsing "Live synchronization"):
// another panel's write — or a delete/clear made here — updates the cache and
// the history screen re-renders if it is the visible one. Deliberately
// ignores the reconcile/upsert/retention notifications this same view's own
// `refreshHistoryView()` produces (it already re-renders from the result),
// which is what keeps the listener from re-entering the reconcile that
// notified it. `policy` is the one exception: turning raw-prompt caching off
// (here or in the other panel) drops prompt previews the list was searching
// against and flips the privacy switch, so the screen has to re-read both.
// No-op while chatting.
historyStore.onChange((event) => {
  if (el.historyView.hidden || !event) return;
  if (event.type === "external_change" || event.type === "removed" || event.type === "cleared" || event.type === "policy") {
    refreshHistoryView({ reconcile: false });
  }
});

/** Drop every remembered-conversation key whose tab no longer exists
 * (tasks.md 2.3). Best-effort by construction: an unenumerable tab list
 * leaves the keys alone (history-store.js's pruneLastActive treats an empty
 * valid set as "cannot determine", never as "nothing exists"). */
async function pruneStaleLastActiveKeys() {
  if (typeof chrome === "undefined" || !chrome.tabs || typeof chrome.tabs.query !== "function") return;
  try {
    const tabs = await chrome.tabs.query({});
    await historyStore.pruneLastActive((tabs || []).map((tab) => String(tab.id)));
  } catch {
    /* best-effort sweep */
  }
}

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
    case READINESS.CHATGPT_SIGN_IN_REQUIRED:
      p.innerHTML = `<strong>Chưa đăng nhập ChatGPT.</strong> Đăng nhập với tài khoản ChatGPT trong Cài đặt trước khi trò chuyện.`;
      actionBtn = settingsButton("Đăng nhập ChatGPT");
      break;
    case READINESS.CHATGPT_SESSION_EXPIRED:
      p.innerHTML = `<strong>Phiên ChatGPT đã hết hạn.</strong> Đăng nhập lại trong Cài đặt để tiếp tục trò chuyện.`;
      actionBtn = settingsButton("Đăng nhập lại");
      break;
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

// ---- Permission mode badge (task 7.1: "visible wherever a run can act") --
const permissionsClient = createPermissionsClient();
let permissionMode = { mode: "auto", modeSource: "local", loaded: false, syncing: false };

// Retry ladder for a failed mode load (see loadPermissionMode below). The
// live "click Auto, nothing opens" regression was TWO faults in series: the
// relay refused the op (fixed in background.js's allowlist) AND this panel
// gave up permanently after one silent failure — syncPermissionMode() only
// attempts a load once per ok handshake, so the menu stayed empty forever
// while everything else looked healthy. A failed load now surfaces on the
// trigger and schedules a backoff retry while the handshake is up; the state
// lives in ONE object so the schedule and the success path share it.
const PERMISSION_MODE_RETRY_BASE_MS = 2000;
const PERMISSION_MODE_RETRY_MAX_MS = 30000;
const permissionModeRetry = { timer: null, delayMs: PERMISSION_MODE_RETRY_BASE_MS };

function schedulePermissionModeRetry() {
  if (permissionModeRetry.timer != null) return; // one retry in flight at a time
  permissionModeRetry.timer = setTimeout(() => {
    permissionModeRetry.timer = null;
    // Only while the handshake is up — a disconnect resets the ladder (see
    // syncPermissionMode) and its fresh-handshake path owns the reload.
    if (panel.protocol.handshakeState() === "ok") loadPermissionMode();
  }, permissionModeRetry.delayMs);
  // Grow for the NEXT failure; a success resets to base (see
  // loadPermissionMode). 2s, 4s, 8s, ... capped at 30s.
  permissionModeRetry.delayMs = Math.min(permissionModeRetry.delayMs * 2, PERMISSION_MODE_RETRY_MAX_MS);
}

function renderModeMenu() {
  const managed = permissionMode.modeSource === "managed";
  el.modeTriggerLabel.textContent = modeLabel(permissionMode.mode);
  el.modeTriggerIcon.innerHTML = managed ? iconMarkup("lock", { size: 14 }) : "";
  el.modeTrigger.title = managed
    ? "Chế độ đang bị quản trị viên cố định — không thể đổi trên máy này"
    : modeDescription(permissionMode.mode);
  // Administrator-pinned: the control shows the pinned mode and offers no
  // local change (spec "Administrator-pinned mode") — disabling the trigger
  // itself (rather than emptying the menu) means there is no affordance to
  // even open a menu that could not do anything.
  el.modeTrigger.disabled = managed;
  el.modeTrigger.setAttribute("aria-disabled", String(managed));
  el.modeMenu.innerHTML = "";
  if (managed) return;
  for (const mode of PERMISSION_MODES) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "menu-item";
    btn.setAttribute("role", "menuitem");
    btn.setAttribute("aria-selected", String(mode === permissionMode.mode));
    btn.title = modeDescription(mode);
    btn.textContent = modeLabel(mode);
    btn.addEventListener("click", () => {
      el.modeMenuWrap.close?.();
      changePermissionMode(mode);
    });
    el.modeMenu.appendChild(btn);
  }
}

async function changePermissionMode(mode) {
  if (permissionMode.modeSource === "managed" || mode === permissionMode.mode) return;
  const previousMode = permissionMode.mode;
  try {
    const result = await permissionsClient.setPermissionMode(mode);
    permissionMode = { ...permissionMode, mode: result.mode, modeSource: "local" };
    renderModeMenu();
    // Task 7.2: the host invalidates every outstanding decision the instant
    // the EFFECTIVE mode changes; the panel clears its own cards to match
    // rather than waiting for that denial to round-trip back as a tool
    // result (see PanelController.invalidateAllPendingApprovals()'s own
    // comment).
    if (result.mode !== previousMode) panel.invalidateAllPendingApprovals();
  } catch (err) {
    // Task 7.1: a MANAGED_POLICY_PINNED reply must never surface as a
    // generic failure — administrator policy pinned the mode out from under
    // this control (e.g. a policy applied after the panel last loaded it);
    // re-sync to "managed" so the badge reflects reality instead of showing
    // an error toast for what is actually expected behavior.
    if (err instanceof PermissionsErrorLike && err.code === "MANAGED_POLICY_PINNED") {
      permissionMode = { ...permissionMode, modeSource: "managed" };
      renderModeMenu();
      return;
    }
    // Any other failure (network/protocol): leave the badge showing the
    // last-known mode rather than guessing; the next successful load()
    // reconciles it.
  }
}

async function loadPermissionMode() {
  if (permissionMode.syncing) return;
  permissionMode.syncing = true;
  let result;
  try {
    result = await permissionsClient.getPermissionState();
  } catch {
    // NEVER give up silently: a single transient failure used to leave the
    // badge on its static "Auto" label and the menu empty forever (the
    // "click Auto, nothing opens" regression). Surface the state on the
    // trigger and schedule a backoff retry.
    permissionMode.syncing = false;
    el.modeTrigger.title = "Không tải được chế độ cấp quyền — đang thử lại…";
    schedulePermissionModeRetry();
    return;
  }
  // Success: cancel any scheduled retry and reset the ladder for the next
  // unrelated failure. renderModeMenu() rewrites the title to the real mode
  // description, clearing any failure message above.
  permissionModeRetry.delayMs = PERMISSION_MODE_RETRY_BASE_MS;
  if (permissionModeRetry.timer != null) {
    clearTimeout(permissionModeRetry.timer);
    permissionModeRetry.timer = null;
  }
  permissionMode = { mode: result.mode, modeSource: result.modeSource, loaded: true, syncing: false };
  renderModeMenu();
}

// Called from every render() tick (cheap: a no-op once loaded and connected,
// mirroring how renderModelMenu() etc. are called unconditionally). Reloads
// on every fresh "ok" handshake so a reconnect (or a mode change made from
// the Settings > Approved sites page while this panel was open) is picked
// up rather than showing a stale badge indefinitely.
let permissionModeHandshakeSeen = false;
function syncPermissionMode() {
  const ok = panel.protocol.handshakeState() === "ok";
  if (ok && !permissionModeHandshakeSeen) {
    permissionModeHandshakeSeen = true;
    loadPermissionMode();
  } else if (!ok) {
    permissionModeHandshakeSeen = false;
    // A disconnect resets the retry ladder: the next ok handshake is a
    // fresh start, not a continuation of a grown backoff. Any pending retry
    // timer's callback is already a no-op while disconnected.
    permissionModeRetry.delayMs = PERMISSION_MODE_RETRY_BASE_MS;
  }
}

// Task 7.6: the risk-CONTEXT block for a decision card — a pure function of
// the view model extension/ui/threat-labels.js's viewRiskContext() already
// produced, so it is unit-testable in isolation exactly like
// conversation-model.js's own pure functions (see
// test/sidepanel-threat-warnings.test.mjs). Returns "" for `null` (nothing
// to show). Never a control of its own: no button/checkbox/input appears
// anywhere in the returned markup — the card's own Allow/Deny remain the
// ONLY controls (spec "the decision controls remain those of the card").
function permissionRiskContextHtml(riskContext) {
  if (!riskContext) return "";
  const signalsHtml = riskContext.signals.length
    ? `<ul class="permission-card-risk-signals">${riskContext.signals
        .map((s) => `<li>${escapeHtml(s.label || s.kind)}${s.quotedText ? `: <code>${escapeHtml(s.quotedText)}</code>` : ""}</li>`)
        .join("")}</ul>`
    : "";
  return `<div class="permission-card-risk-context" role="note">
         <p class="permission-card-risk-title">${escapeHtml(`Bối cảnh: tab này đang ở mức ${riskContext.categoryLabel}`)}</p>
         ${signalsHtml}
       </div>`;
}

function renderPermission() {
  el.permissionSlot.innerHTML = "";
  const model = panel.currentModel();
  if (!model || !model.pendingApproval) return;
  const { action, target, protectedCategory, rememberable } = model.pendingApproval;
  const card = document.createElement("div");
  card.className = "permission-card";
  card.setAttribute("role", "alertdialog");
  card.setAttribute("aria-label", "Yêu cầu cấp quyền");
  // Task 7.3: a protected decision names its category and states it cannot
  // be remembered (spec "A protected action names its category and cannot
  // be remembered"); every other card offers a "remember" checkbox instead,
  // scoped to the origin/action-class the mode already resolved this call
  // against (host/agent/policy/can-use-tool.js only honors the flag when
  // `rememberable` said so — see protocol-client.js's approvalDecision()).
  const detailText = protectedCategory
    ? `Hành động luôn cần xác nhận: ${protectedCategoryLabel(protectedCategory)}. Quyết định này KHÔNG được ghi nhớ — lần sau sẽ hỏi lại.`
    : "Hành động này nằm ngoài phạm vi đã được cho phép của cuộc trò chuyện.";
  // Task 7.6: risk CONTEXT for the tab this decision targets, if any — never
  // a control of its own (no button/checkbox lives inside this block), and
  // the card's own Allow/Deny below remain the ONLY controls on this card
  // either way (spec "the decision controls remain those of the card").
  const contextTabId = target && typeof target.tabId === "number" ? target.tabId : null;
  const riskContext = contextTabId != null ? viewRiskContext(model.getTabRisk(contextTabId)) : null;
  const riskContextHtml = permissionRiskContextHtml(riskContext);
  card.innerHTML = `
    <div class="permission-card-head">
      <span class="permission-card-icon">${iconMarkup("alertTriangle", { size: 18 })}</span>
      <div>
        <p class="permission-card-title">Cần cấp quyền: ${escapeHtml(action || "")}</p>
        <p class="permission-card-detail">${escapeHtml(detailText)}</p>
      </div>
    </div>
    <div class="permission-card-target"></div>
    ${riskContextHtml}
    ${
      !protectedCategory && rememberable
        ? `<label class="permission-card-remember" style="display:flex;align-items:center;gap:6px;font-size:var(--font-size-small)">
             <input type="checkbox" id="__remember" />
             <span>Ghi nhớ quyết định này cho trang này</span>
           </label>`
        : ""
    }
    <div class="permission-card-actions">
      <button class="btn btn-ghost btn-sm" type="button" id="__deny">Từ chối</button>
      <button class="btn btn-primary btn-sm" type="button" id="__allow">Cho phép</button>
    </div>
  `;
  card.querySelector(".permission-card-target").textContent = target ? JSON.stringify(target) : "(không có mục tiêu cụ thể)";
  const rememberBox = card.querySelector("#__remember");
  card.querySelector("#__allow").addEventListener("click", () => panel.respondApproval("approve", { remember: !!(rememberBox && rememberBox.checked) }));
  card.querySelector("#__deny").addEventListener("click", () => panel.respondApproval("deny", { remember: !!(rememberBox && rememberBox.checked) }));
  el.permissionSlot.appendChild(card);
}

// Task 2.4: the LOCAL download-pause decision card — see conversation-model.js's
// pendingDownloadDecision field comment for why this is a distinct piece of
// state from pendingApproval. Always names the "download" protected category
// and never offers a remember option (a download is always protected, never
// rememberable — same rule renderPermission() applies for a protected
// approval_request).
function renderDownloadDecision() {
  el.downloadDecisionSlot.innerHTML = "";
  const model = panel.currentModel();
  if (!model || !model.pendingDownloadDecision) return;
  const { category, filename, url } = model.pendingDownloadDecision;
  const card = document.createElement("div");
  card.className = "permission-card";
  card.setAttribute("role", "alertdialog");
  card.setAttribute("aria-label", "Yêu cầu tải tệp xuống");
  card.innerHTML = `
    <div class="permission-card-head">
      <span class="permission-card-icon">${iconMarkup("download", { size: 18 })}</span>
      <div>
        <p class="permission-card-title">Cần cấp quyền: ${escapeHtml(protectedCategoryLabel(category || "download"))}</p>
        <p class="permission-card-detail">Trợ lý vừa gây ra một lượt tải tệp xuống máy. Đã tạm dừng tải cho đến khi bạn quyết định. Quyết định này KHÔNG được ghi nhớ — lần sau sẽ hỏi lại.</p>
      </div>
    </div>
    <div class="permission-card-target"></div>
    <div class="permission-card-actions">
      <button class="btn btn-ghost btn-sm" type="button" id="__deny">Hủy tải</button>
      <button class="btn btn-primary btn-sm" type="button" id="__allow">Tiếp tục tải</button>
    </div>
  `;
  card.querySelector(".permission-card-target").textContent = filename || url || "(không rõ tệp)";
  card.querySelector("#__allow").addEventListener("click", () => panel.respondDownloadDecision("allow"));
  card.querySelector("#__deny").addEventListener("click", () => panel.respondDownloadDecision("deny"));
  el.downloadDecisionSlot.appendChild(card);
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

// Tasks 7.4/7.5: one turn-anchored warning (injection finding, probe
// failure, or tab risk update) — see extension/ui/threat-labels.js's own
// header for the QUOTED-DATA rule this function must honor. Deliberately no
// `<button>`, no `role="alertdialog"`, and no class shared with
// `.permission-card` anywhere below: a warning must be structurally and
// visually distinguishable from a decision card, and acknowledging/
// dismissing it (there is nothing to click here at all) must authorize
// nothing (spec "A warning is not an approval").
function warningRowHtml(warning) {
  const view = viewWarning(warning);
  let bodyHtml = "";
  if (view.kind === "injection_finding") {
    // `quotedText` is exactly what a web page said — escaped and inserted as
    // plain text, NEVER passed through renderMarkdownLite (which would
    // reinterpret its own `[..](..)`/`**..**` as real formatting/links).
    bodyHtml = `<div class="threat-warning-quote"><code>${escapeHtml(view.quotedText)}</code></div>`;
  } else if (view.kind === "injection_probe_failed") {
    bodyHtml = view.quotedDetail ? `<div class="threat-warning-quote"><code>${escapeHtml(view.quotedDetail)}</code></div>` : "";
  } else if (view.kind === "tab_risk_update") {
    bodyHtml = view.signals.length
      ? `<ul class="threat-warning-signals">${view.signals
          .map((s) => `<li>${escapeHtml(s.label || s.kind)}${s.quotedText ? `: <code>${escapeHtml(s.quotedText)}</code>` : ""}</li>`)
          .join("")}</ul>`
      : "";
  }
  return `
    <div class="threat-warning${view.isElevated ? " is-elevated" : ""}" role="status" data-warning-kind="${escapeHtml(view.kind)}">
      <span class="threat-warning-icon">${iconMarkup("alertTriangle", { size: 14 })}</span>
      <div class="threat-warning-body">
        <p class="threat-warning-title">${escapeHtml(view.title)}</p>
        ${bodyHtml}
      </div>
    </div>`;
}

function renderWarningsHtml(turn) {
  if (!turn.warnings || !turn.warnings.length) return "";
  return `<div class="threat-warning-list">${turn.warnings.map(warningRowHtml).join("")}</div>`;
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

// ---- Thinking block: UI-only expansion state and its markup -------------
//
// The model's own reasoning for a turn is rendered in a disclosure block
// visually subordinate to the answer (spec "Thinking is subordinate to the
// answer"). Its expansion state is pure UI state keyed by run id, exactly
// like `timelineExpandedRuns` below: never in conversation-model.js, never
// persisted, never replayed, so a snapshot/reconnect rebuild cannot resurrect
// an operator's expanded-or-collapsed choice. The difference from the
// timeline summary is the DEFAULT: expanded while reasoning is arriving
// (seeing the work is the point), collapsed once the run is no longer live.
// An explicit choice is stored as an override and wins for the rest of that
// run in either direction.
const thinkingExpandedRuns = new Map(); // runId -> explicit boolean (UI-only)

/**
 * Whether this turn's thinking block is expanded. `opts.overrides` is
 * injectable so the shipped decision is directly testable; the caller uses
 * the module Set above, whose entries only an explicit disclosure toggle
 * writes. Plain-options parameters (rather than a destructured signature) so
 * the shipped body stays readable by this repo's brace-matching test
 * extractor, the same way history-view.js stays readable by a fake DOM.
 */
function thinkingIsExpanded(turn, opts) {
  opts = opts || {};
  const overrides = opts.overrides || thinkingExpandedRuns;
  const live = !!opts.live;
  const key = String(turn && turn.runId != null ? turn.runId : "");
  if (overrides.has(key)) return overrides.get(key);
  return live;
}

/**
 * The answer body of one assistant turn. While the run is live the text is
 * painted into ONE stable `.stream-answer-text` node (design decision 6) so
 * the in-place streaming path can update it without rebuilding the
 * transcript; the moment the run is no longer live the structural renderer
 * lays the same text out through `renderMarkdownLite()`, so a finished answer
 * is formatted exactly as it was before this change.
 */
function renderProseHtml(turn, opts) {
  opts = opts || {};
  const cursor = opts.cursor || "";
  const marginTop = opts.marginTop || 0;
  const body = opts.live
    ? `<span class="stream-answer-text" data-run-id="${escapeHtml(String(turn.runId ?? ""))}">${escapeHtml(turn.text || "")}</span>`
    : renderMarkdownLite(turn.text || "");
  return `<div class="prose" style="margin-top:${marginTop}px">${body}${cursor}</div>`;
}

/**
 * The collapsible "Suy luận" block, or "" when this turn has no thinking at
 * all. A `redacted_thinking` block is represented as thinking that occurred,
 * WITHOUT content — the model never receives the block's `data`, so there is
 * nothing here to reveal or fabricate. The disclosure reuses the
 * timeline-summary vocabulary (a real <button> with aria-expanded +
 * aria-controls, and a hidden body that stays in the DOM in both states), so
 * it is keyboard-operable with an accessible name and an exposed state.
 */
function renderThinkingBlockHtml(turn, opts) {
  opts = opts || {};
  const live = !!opts.live;
  const hasContent = typeof turn.thinking === "string" && turn.thinking.length > 0;
  if (!hasContent && turn.redactedThinking !== true) return "";
  const expanded = thinkingIsExpanded(turn, { live });
  const bodyId = `think-${turn.runId}`;
  const body = hasContent
    ? escapeHtml(turn.thinking)
    : `<span class="thinking-redacted">Mô hình đã suy luận nhưng nội dung không thể hiển thị.</span>`;
  return `
    <div class="thinking-block${live ? " is-live" : ""}" data-run-id="${escapeHtml(String(turn.runId ?? ""))}">
      <button class="thinking-summary" type="button" aria-expanded="${expanded ? "true" : "false"}" aria-controls="${escapeHtml(bodyId)}">
        <span class="thinking-glyph" aria-hidden="true">${iconMarkup(expanded ? "chevronDown" : "chevronRight", { size: 14 })}</span>
        <span class="thinking-label">Suy luận</span>
      </button>
      <div class="thinking-body" id="${escapeHtml(bodyId)}"${expanded ? "" : " hidden"}>${body}</div>
    </div>`;
}

function renderTurnHtml(turn, opts) {
  opts = opts || {};
  const isLatestStreaming = !!opts.isLatestStreaming;
  const busy = !!opts.busy;
  const elapsedVisible = !!opts.elapsedVisible;
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
  // Tasks 7.4/7.5: injection findings / probe failures / tab-risk updates
  // recorded for this turn's run — plain informational warnings, positioned
  // right after the tool timeline (roughly where the tool call that
  // surfaced them ran), never mixed into the assistant's own prose.
  const warningsHtml = renderWarningsHtml(turn);
  // Model reasoning, subordinate to and above the answer (spec "Thinking is
  // subordinate to the answer"): collapsed by default once the turn is no
  // longer live, expanded while it is. A turn without thinking renders
  // exactly as before this change.
  const thinkingHtml = renderThinkingBlockHtml(turn, { live: isLatestStreaming });
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
  // "Lưu thành workflow" (this change) rides the EXISTING copy/time footer row
  // rather than adding a second one, and only on the run the visibility rule
  // named (see workflowAffordanceRunId) — quiet by construction: a ghost
  // button, secondary text weight, no accent.
  const saveWorkflowHtml = opts.workflowAffordance
    ? `<button class="btn btn-ghost btn-sm turn-workflow-btn" type="button" data-run-id="${escapeHtml(String(turn.runId ?? ""))}" title="${escapeHtml(WORKFLOW_COPY.saveHint)}" aria-label="${escapeHtml(WORKFLOW_COPY.saveLabel)}">${iconMarkup("skills", { size: 14 })}<span>${escapeHtml(WORKFLOW_COPY.saveLabel)}</span></button>`
    : "";
  const copyHtml = turn.text
    ? `<button class="btn btn-secondary btn-sm turn-copy-btn" type="button" data-run-id="${escapeHtml(String(turn.runId ?? ""))}" title="Sao chép phản hồi" aria-label="Sao chép phản hồi">${iconMarkup("copy", { size: 14 })}</button>`
    : "";
  const actionsHtml =
    copyHtml || saveWorkflowHtml
      ? `<div class="turn-actions">${copyHtml}${saveWorkflowHtml}${durationHtml}</div>`
      : "";
  return `
    <div class="msg-row from-assistant">
      <div class="msg-assistant-body">
        ${timelineHtml}
        ${warningsHtml}
        ${thinkingHtml}
        ${answersHtml}
        ${renderProseHtml(turn, { cursor, marginTop: turn.toolRows.length ? 12 : 0, live: isLatestStreaming })}
        ${citationHtml}
        ${documentsHtml}
        ${busyHtml}
        ${note ? `<div class="turn-status-note ${note.cls}">${note.text}</div>` : ""}
        ${actionsHtml}
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
    const timeStr = captured ? formatClockVi(captured) : "";
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
  return `<div class="msg-row from-user"><div class="msg-user-bubble${item.isPlaceholder ? " is-placeholder" : ""}">${escapeHtml(item.text)}</div>${attachments}${renderUserQueueStateHtml(item)}</div>`;
}

// A queued/steered message's own state, rendered with the message it describes
// (tasks.md 6.2, design.md decision 11). The chip vocabulary comes from
// run-states.js's MESSAGE_QUEUE_LABEL_VI — message-scoped, deliberately
// distinct from the run-scoped header pill — and everything here uses the
// shared `.chip` primitive from extension/ui/components.css.
//
// The cancel control appears ONLY while the message is still `pending`: once
// the next turn has claimed it there is nothing left to cancel, and the run's
// own Stop (the header-adjacent control) is what remains (panel spec "Cancel
// affordance follows the claim"). The interrupt-fallback note is disclosed on
// the message because that is where the difference is observable — the message
// still runs, just as the next turn rather than immediately (design.md
// decision 3's honesty rule).
const QUEUE_STATE_ICONS = { pending: "clock", dispatching: "circleDot", cancelled: "slashCircle", failed: "xCircle" };

function renderUserQueueStateHtml(item) {
  const label = item.queueState ? MESSAGE_QUEUE_LABEL_VI[item.queueState] : null;
  const detail = label ? queueStateDetail(item) : "";
  const parts = [];
  if (label) {
    const icon = QUEUE_STATE_ICONS[item.queueState] || "circle";
    parts.push(
      `<span class="chip"${detail ? ` title="${escapeHtml(detail)}"` : ""}>` +
        `<span class="chip-icon">${iconMarkup(icon, { size: 14 })}</span>` +
        `<span class="chip-label">${escapeHtml(label)}</span></span>`
    );
  }
  if (item.queueState === "pending" && item.messageId != null) {
    parts.push(
      `<button type="button" class="btn btn-sm btn-ghost msg-user-queue-cancel" ` +
        `data-cancel-message-id="${escapeHtml(String(item.messageId))}" ` +
        `aria-label="Hủy tin nhắn đang chờ">Hủy</button>`
    );
  }
  if (item.interruptFellBack) parts.push(`<span class="msg-user-queue-note">${escapeHtml(QUEUE_FALLBACK_NOTE_VI)}</span>`);
  if (!parts.length) return "";
  return `<div class="msg-user-queue">${parts.join("")}</div>`;
}

/** The detail line behind a message's chip, shown as its tooltip: the host's
 * own reason for a cancelled/failed message, and — for a message the operator
 * submitted with run-now — the recorded intent, which is what makes the panel
 * "reflect the interrupt attempt" even when it succeeded (panel spec "Run-now
 * while the run streams"). The failed attempt discloses itself visibly on top
 * of this, through QUEUE_FALLBACK_NOTE_VI. */
function queueStateDetail(item) {
  const parts = [];
  if (item.queueMode === "interrupt") parts.push("Bạn đã chọn Chạy ngay cho tin nhắn này");
  if (item.queueState === "cancelled") parts.push(item.queueError === "user_cancelled" ? "Bạn đã hủy tin nhắn này" : "Tin nhắn đã bị hủy");
  else if (item.queueState === "failed") {
    if (item.queueError === "queue_full") parts.push("Hàng đợi đã đầy");
    else if (item.queueError === "host_unavailable") parts.push("Mất kết nối với companion");
    else parts.push(item.queueError ? `Không chạy được: ${item.queueError}` : "Không chạy được");
  }
  return parts.join(" — ");
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

// Task 2.4: an honest record for a download background.js could not pause
// in time — reported, never presented as if it had been gated. Rendered as
// a plain transcript notice, not a decision card: there is nothing left to
// allow or deny by the time this item exists.
function renderDownloadNoticeItemHtml(item) {
  const name = item.filename || item.url || "(không rõ tệp)";
  return `<div class="list-item"><span class="list-item-icon">${iconMarkup("download", { size: 16 })}</span>
    <span class="list-item-main"><span class="list-item-title">Tải tệp đã hoàn tất trước khi kịp tạm dừng: ${escapeHtml(name)}</span>
    <span class="list-item-sub">Không thể chặn lượt tải này — được ghi nhận, không phải bị chặn.</span></span></div>`;
}

// Task 2.4: a permanent record of an already-answered download-pause
// decision (ConversationModel's "download_decision" item — see
// recordDownloadDecision()/applyEvent()'s "download_decision_recorded"
// case), so the outcome stays visible in the timeline exactly like every
// other decision's outcome, not just as a card that vanished the instant it
// was answered.
function renderDownloadDecisionItemHtml(item) {
  const name = item.filename || item.url || "(không rõ tệp)";
  const allowed = item.decision === "allow";
  return `<div class="list-item"><span class="list-item-icon">${iconMarkup("download", { size: 16 })}</span>
    <span class="list-item-main"><span class="list-item-title">${allowed ? "Đã cho phép" : "Đã từ chối"} tải tệp: ${escapeHtml(name)}</span>
    <span class="list-item-sub">Quyết định được bảo vệ (${escapeHtml(item.category || "download")}) — không thể ghi nhớ.</span></span></div>`;
}

// ===========================================================================
// Rerunnable workflows + self-healing (openspec/changes/
// add-workflow-materialization-and-heal) — panel surfaces
// ---------------------------------------------------------------------------
// Three transcript surfaces, all built from the change's frozen contract:
//
//   • the turn footer's quiet "Lưu thành workflow" affordance, on the LATEST
//     COMPLETED run only (hidden while a run is active, while a derivation is
//     in flight, and once that run already has a draft card);
//   • the draft card (item kind `workflow_draft`): review -> save -> prove ->
//     enable, every stage an explicit operator gesture, with the proof's
//     per-step outcomes and freshness notes rendered where the proof put them;
//   • the drift notice (item kind `workflow_drift`) — static, no controls and
//     no authority (a fact about a past execution, never a decision) — and the
//     heal proposal card (item kind `workflow_heal`), Allow/Deny bound to one
//     proposal id with a bounded expiry.
//
// The visual language is the panel's existing one: `.card` plus the
// `.permission-card-*` head/actions primitives and the shared `.btn` classes.
// The drift notice deliberately shares NO class with a decision card (the rule
// the threat warnings already follow), so "there is nothing to answer here" is
// visible at a glance.
const WORKFLOW_COPY = Object.freeze({
  saveLabel: "Lưu thành workflow",
  saveHint: "Lưu các bước của lượt này thành workflow để chạy lại — chỉ bật sau khi chạy thử đạt",
  draftTitle: "Workflow nháp từ lượt này",
  draftSavedTitle: "Workflow đã lưu (đang tắt)",
  draftProvedTitle: "Workflow đã chạy thử",
  draftEnabledTitle: "Workflow đã bật",
  draftDetail: "Dựng lại từ dấu vết hành động của lượt này. Workflow được lưu ở trạng thái TẮT; chỉ bật sau khi chạy thử đạt trên trang đang mở.",
  savedDetail: "Đã lưu và đang tắt. Chạy thử trên trang đang mở để kiểm chứng trước khi bật.",
  provedDetail: "Đã chạy thử trên trang đang mở.",
  enabledDetail: "Đã bật. Workflow sẽ được gợi ý khi bạn mở đúng trang.",
  draftRestoredDetail: "Đã lưu ở phiên trước — danh sách bước không còn trong cửa sổ hội thoại này; chạy thử vẫn kiểm chứng được bản đã lưu.",
  stepsHeading: "Các bước",
  noSteps: "Không có danh sách bước trong hội thoại này.",
  saveDraft: "Lưu bản nháp",
  saving: "Đang lưu…",
  prove: "Chạy thử",
  proveAgain: "Chạy thử lại",
  proving: "Đang chạy thử…",
  enable: "Bật workflow",
  cancel: "Hủy",
  proofOk: "Chạy thử đạt",
  proofFailed: "Chạy thử chưa đạt",
  freshness: "Nguồn",
  driftTitle: "Workflow bị lệch so với trang hiện tại",
  driftHint: "Hãy nhờ trợ lý xem lại trang và đề xuất bản sửa cho workflow này.",
  healTitle: "Đề xuất sửa workflow",
  healDetail: "Trợ lý đề xuất một phiên bản mới cho workflow đã lệch. Chưa có gì được ghi cho tới khi bạn đồng ý.",
  healAllow: "Lưu bản sửa",
  healDeny: "Bỏ qua",
  healDeciding: "Đang lưu…",
  healSaved: "Đã lưu phiên bản mới",
  healRejected: "Đã bỏ qua — không có gì được ghi",
  healExpired: "Đã hết hạn",
  healSuperseded: "Đã được thay thế bởi một đề xuất mới hơn",
  healExpiresAt: "Đề xuất hết hạn lúc",
  baseVersion: "Bản gốc",
  hostUnavailable: "Mất kết nối với companion — chưa thực hiện được thao tác workflow.",
  noTab: "Chưa gắn trang nào để chạy thử — hãy mở trang của workflow rồi thử lại.",
  missingDraft: "Bản nháp này không còn đủ dữ liệu để lưu — hãy yêu cầu dựng lại từ lượt chạy.",
  edit: "Sửa",
  editSave: "Lưu phiên bản mới",
  editSaving: "Đang lưu bản sửa…",
  editCancel: "Huỷ sửa",
  editLoading: "Đang tải các bước…",
  editHint: "Sửa tham số hoặc xoá bước rồi lưu — bản lưu là một phiên bản mới, bản cũ vẫn giữ nguyên và bản mới cần chạy thử lại trước khi bật.",
  editRemoveStep: "Xoá bước",
  editInvalidArgs: "Tham số không phải JSON hợp lệ — sửa lại trước khi lưu.",
  editNoSteps: "Không còn bước nào — cần ít nhất một bước để lưu."
});

// Why a derivation / proof / enable / heal answer was refused. The host names
// the reason; this maps it to the operator's language rather than showing a
// code — an unmapped code falls back to the generic sentence, never to a
// fabricated explanation.
const WORKFLOW_REFUSAL_REASON_VI = Object.freeze({
  unknown_run: "không tìm thấy lượt chạy này",
  run_not_completed: "lượt chạy chưa hoàn tất",
  no_trail: "lượt chạy không có dấu vết hành động nào để dựng lại",
  unknown_conversation: "cuộc trò chuyện không còn tồn tại",
  unknown_workflow: "không tìm thấy workflow này (có thể đã bị xoá)",
  busy: "trình duyệt đang được một lượt chạy khác sử dụng — hãy thử lại sau",
  bridge_unavailable: "chưa kết nối được tới trình duyệt",
  bridge_error: "cầu nối tới trình duyệt gặp lỗi",
  extension_error: "tiện ích trình duyệt từ chối yêu cầu",
  invalid_definition: "định nghĩa không hợp lệ",
  stale_version: "phiên bản đã cũ so với bản đang lưu",
  unknown_proposal: "đề xuất này không còn tồn tại",
  expired: "đề xuất đã hết hạn",
  superseded: "đề xuất đã được thay thế",
  stale_base: "workflow đã thay đổi kể từ khi đề xuất được tạo",
  invalid_candidate: "bản sửa không hợp lệ",
  not_in_agent_group: "tab này không thuộc nhóm của trợ lý",
  tab_gone: "tab đã đóng",
  binding_mismatch: "trang hiện tại không còn khớp miền đã ghi trong workflow",
  invalid_args: "yêu cầu không hợp lệ",
  host_unavailable: "mất kết nối với companion"
});

const WORKFLOW_DRIFT_REASON_VI = Object.freeze({
  target_no_longer_resolves: "phần tử mà bước này nhắm tới không còn tồn tại trên trang",
  binding_mismatch: "trang hiện tại không còn khớp miền đã ghi trong workflow"
});

/** One operator-facing sentence for a refusal reason the host named. When the
 * refusal carries the structured binding evidence (`expected`/`actualHost`),
 * that is named too — the operator needs to see WHICH domain mismatched, not
 * just that one did. */
function workflowRefusalText(reason, detail) {
  const known = reason && WORKFLOW_REFUSAL_REASON_VI[reason];
  const base = known ? `Không thực hiện được: ${known}.` : "Không thực hiện được thao tác workflow này.";
  const binding = detail && typeof detail === "object" ? detail : null;
  if (binding && Array.isArray(binding.expected) && binding.expected.length) {
    const expected = binding.expected.map((d) => String(d)).join(", ");
    const actual = binding.actualHost ? String(binding.actualHost) : "không xác định";
    return `${base} (miền đã ghi: ${expected}; trang hiện tại: ${actual})`;
  }
  return base;
}

/** The notice a refused derivation shows (never a card — the operator gets a
 * sentence, not a review surface for a draft that does not exist). */
function workflowDraftRefusalText(reply) {
  if (reply && Array.isArray(reply.incomplete) && reply.incomplete.length) {
    const reasons = reply.incomplete.map((r) => String(r)).filter(Boolean);
    if (reasons.length) return `Chưa dựng được workflow từ lượt này: ${reasons.join("; ")}.`;
  }
  return workflowRefusalText(reply && reply.reason);
}

/** `HH:MM` for an ISO timestamp, or "" when it cannot be read. The same
 * formatting the answer-source citation uses, so two freshness lines in one
 * transcript never disagree. */
function formatClockVi(iso) {
  try {
    return new Date(iso).toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

/** `host · HH:MM` for a step outcome that read live content (the freshness
 * evidence the spec requires on results). "" when the step carried none. */
function workflowOutcomeSource(outcome) {
  if (!outcome || typeof outcome.url !== "string" || !outcome.url) return "";
  let host = outcome.url;
  try {
    host = new URL(outcome.url).hostname || outcome.url;
  } catch {
    host = outcome.url;
  }
  const time = outcome.fetchedAt ? formatClockVi(outcome.fetchedAt) : "";
  return time ? `${host} · ${time}` : host;
}

/** Evidence from a drift event: the host's own text, or its JSON for the
 * structured (binding-mismatch) case. Rendered escaped, always. */
function workflowEvidenceText(evidence) {
  if (evidence == null) return "";
  if (typeof evidence === "string") return evidence;
  try {
    return JSON.stringify(evidence);
  } catch {
    return "";
  }
}

const WORKFLOW_STEP_STATE_VI = Object.freeze({
  ok: "đạt",
  failed: "lỗi",
  unexecutable: "không chạy được ở đây"
});

/** One step line: the step's own identity (kind + tool + args summary, through
 * the SAME summarizer the action timeline uses) plus its proof outcome, if the
 * proof reached it. `outcome` is absent for a draft that has not been proved. */
function workflowStepLineHtml(step, index, outcome) {
  const kind = step && typeof step.kind === "string" ? step.kind : "?";
  const ref = step && typeof step.ref === "string" ? step.ref : "";
  const display = ref ? toolRowDisplay({ toolName: ref, args: (step && step.args) || {}, status: "succeeded" }) : { label: kind, detail: "" };
  const stateText = outcome ? WORKFLOW_STEP_STATE_VI[outcome.status] || outcome.status : "";
  const reasonText = outcome && outcome.reason ? ` (${escapeHtml(String(outcome.reason))})` : "";
  const source = outcome ? workflowOutcomeSource(outcome) : "";
  return `<li class="workflow-step" data-step-index="${escapeHtml(String(index))}" data-step-status="${escapeHtml(String(outcome ? outcome.status : "pending"))}">
      <span class="workflow-step-index">${escapeHtml(String(index + 1))}</span>
      <span class="workflow-step-main">
        <span class="workflow-step-label">${escapeHtml(display.label)}${ref && display.label !== ref ? ` <code>${escapeHtml(ref)}</code>` : ""}</span>
        ${display.detail ? `<span class="workflow-step-detail">${escapeHtml(display.detail)}</span>` : ""}
        ${source ? `<span class="workflow-step-source">${escapeHtml(source)}</span>` : ""}
      </span>
      ${stateText ? `<span class="workflow-step-state is-${escapeHtml(String(outcome.status))}">${escapeHtml(stateText)}${reasonText}</span>` : ""}
    </li>`;
}

function workflowStepsHtml(steps, outcomes) {
  const list = Array.isArray(steps) ? steps : [];
  if (!list.length) return `<p class="workflow-card-note">${escapeHtml(WORKFLOW_COPY.noSteps)}</p>`;
  const byIndex = new Map((Array.isArray(outcomes) ? outcomes : []).map((o) => [o && o.index, o]));
  return `<p class="workflow-card-subhead">${escapeHtml(WORKFLOW_COPY.stepsHeading)}</p>
    <ul class="workflow-steps">${list.map((step, i) => workflowStepLineHtml(step, i, byIndex.get(i))).join("")}</ul>`;
}

/** Parse one edit row's args text: empty (or whitespace) means "no args"; a
 * non-object JSON value or unparseable text is a refusal — never a thrown
 * error, and never a silently dropped step. */
function parseWorkflowEditArgs(text) {
  const raw = String(text == null ? "" : text).trim();
  if (!raw) return { ok: true, args: undefined };
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return { ok: false };
  return { ok: true, args: parsed };
}

/** Merge one row's live text back into its step; the identity fields (kind,
 * ref) are the host's and stay untouched. */
function applyWorkflowEditArgs(step, text) {
  const parsed = parseWorkflowEditArgs(text);
  if (!parsed.ok) return { ok: false };
  const next = { ...(step || {}) };
  if (parsed.args === undefined) delete next.args;
  else next.args = parsed.args;
  return { ok: true, step: next };
}

/** Rebuild the steps array from the working copy plus the row inputs, in
 * order. All-or-nothing: one bad row refuses the whole save and names its
 * index, so nothing half-edited is ever sent. */
function buildWorkflowEditSteps(steps, texts) {
  const list = Array.isArray(steps) ? steps : [];
  const inputs = Array.isArray(texts) ? texts : [];
  const out = [];
  for (const [index, step] of list.entries()) {
    const merged = applyWorkflowEditArgs(step, inputs[index]);
    if (!merged.ok) return { ok: false, index };
    out.push(merged.step);
  }
  return { ok: true, steps: out };
}

/** The edit view: one row per step — identity read-only, args as editable
 * JSON, a remove control per row. Rows mirror the step list's markup so a
 * proof outcome rendered under an edited step stays visually consistent. */
function workflowEditHtml(item) {
  const edit = item.edit;
  if (!edit) return "";
  if (edit.status === "loading") return `<p class="workflow-card-note">${escapeHtml(WORKFLOW_COPY.editLoading)}</p>`;
  const steps = Array.isArray(edit.steps) ? edit.steps : [];
  const disabled = edit.status === "saving" ? "disabled" : "";
  const rows = steps
    .map((step, i) => {
      const ref = step && typeof step.ref === "string" ? step.ref : "";
      const kind = step && typeof step.kind === "string" ? step.kind : "tool";
      const argsText = step && step.args && typeof step.args === "object" ? JSON.stringify(step.args) : "";
      return `<li class="workflow-step is-edit" data-step-index="${escapeHtml(String(i))}" data-step-status="pending">
      <span class="workflow-step-index">${escapeHtml(String(i + 1))}</span>
      <span class="workflow-step-main">
        <span class="workflow-step-label"><code>${escapeHtml(ref || kind)}</code></span>
        <input class="workflow-edit-args" data-step-args="${escapeHtml(String(i))}" type="text" spellcheck="false"
          value="${escapeHtml(argsText)}" placeholder="{}" aria-label="${escapeHtml(`Tham số bước ${i + 1}`)}" ${disabled} />
      </span>
      <button class="btn btn-ghost btn-sm" type="button" data-workflow-action="remove-step"
        data-workflow-id="${escapeHtml(String(item.workflowId ?? ""))}" data-step-index="${escapeHtml(String(i))}"
        title="${escapeHtml(WORKFLOW_COPY.editRemoveStep)}" aria-label="${escapeHtml(`${WORKFLOW_COPY.editRemoveStep} ${i + 1}`)}" ${disabled}>✕</button>
    </li>`;
    })
    .join("");
  return `<p class="workflow-card-subhead">${escapeHtml(WORKFLOW_COPY.stepsHeading)}</p>
    <ul class="workflow-steps is-editing">${rows || `<li class="workflow-step"><span class="workflow-step-main">${escapeHtml(WORKFLOW_COPY.editNoSteps)}</span></li>`}</ul>
    <p class="workflow-card-note">${escapeHtml(WORKFLOW_COPY.editHint)}</p>`;
}

/** The edit view's problem line: a local refusal's own text, or the host's
 * structured refusal (schema errors first, then a named reason and the
 * current version when one was disclosed). */
function workflowEditProblemHtml(item) {
  const problem = item.edit && item.edit.problem;
  if (!problem) return "";
  const text = problem.text
    ? problem.text
    : Array.isArray(problem.errors) && problem.errors.length
      ? problem.errors
          .map((e) => (e && (e.message || e.code)) || String(e))
          .filter(Boolean)
          .join("; ")
      : `${workflowRefusalText(problem.reason || "edit_refused")}${Number.isInteger(problem.latest) ? ` (bản mới nhất: v${problem.latest})` : ""}`;
  return text ? `<p class="workflow-card-error" role="alert">${escapeHtml(text)}</p>` : "";
}

/** The card's identity/meta line: record id, version, step count, domain and
 * document binding. Every field is shown only when the host actually reported
 * it — nothing is inferred. */
function workflowMetaHtml(item) {
  const review = item.review && typeof item.review === "object" ? item.review : {};
  const draft = item.draft && typeof item.draft === "object" ? item.draft : {};
  // A domain constraint reaches this card either as the single bound `domain`
  // or as the full recorded `domains` set (the host's draft reply carries the
  // latter); both are shown, and nothing is inferred when neither is present.
  const domainOf = (v) =>
    typeof v === "string" && v.trim() ? v.trim() : Array.isArray(v) ? v.filter((d) => typeof d === "string" && d.trim()).join(", ") : "";
  const parts = [];
  if (item.workflowId) parts.push(`<code>${escapeHtml(String(item.workflowId))}</code>`);
  if (item.version != null) parts.push(`phiên bản v${escapeHtml(String(item.version))}`);
  const stepCount = Array.isArray(review.steps) ? review.steps.length : item.stepsCount;
  if (Number.isInteger(stepCount)) parts.push(`${escapeHtml(String(stepCount))} bước`);
  const domain = domainOf(review.domains) || domainOf(review.domain) || domainOf(draft.domains) || domainOf(draft.domain);
  parts.push(domain ? `miền: ${escapeHtml(domain)}` : "miền: không giới hạn");
  if (review.document) parts.push("có ràng buộc tài liệu đã gắn");
  return parts.length ? `<p class="workflow-card-meta">${parts.join(" · ")}</p>` : "";
}

function workflowProofHtml(item) {
  if (!item.proof) return "";
  const ok = item.proof.ok === true;
  // Verdict + the host's summary only: the per-step outcomes are rendered ON
  // the step list itself (renderWorkflowDraftItemHtml passes item.proofOutcomes
  // down), so a proof never shows a second, parallel copy of the same steps.
  return `<div class="workflow-proof ${ok ? "is-ok" : "is-failed"}" role="status">
      <p class="workflow-proof-verdict">${iconMarkup(ok ? "checkCircle" : "xCircle", { size: 14 })} ${escapeHtml(ok ? WORKFLOW_COPY.proofOk : WORKFLOW_COPY.proofFailed)}</p>
      ${item.proof.summary ? `<p class="workflow-card-note">${escapeHtml(String(item.proof.summary))}</p>` : ""}
    </div>`;
}

function workflowErrorHtml(item) {
  const err = item.lastError;
  if (!err) return "";
  if (err.op === "save" && Array.isArray(err.errors) && err.errors.length) {
    const lines = err.errors.map((e) => (e && (e.message || e.code)) || String(e)).filter(Boolean);
    return `<p class="workflow-card-error" role="alert">${escapeHtml(WORKFLOW_COPY.saveDraft)}: ${escapeHtml(lines.join("; "))}</p>`;
  }
  return `<p class="workflow-card-error" role="alert">${escapeHtml(workflowRefusalText(err.reason))}</p>`;
}

function workflowDraftActionsHtml(item) {
  const dismiss = `<button class="btn btn-ghost btn-sm" type="button" data-workflow-action="dismiss" data-workflow-run-id="${escapeHtml(String(item.runId ?? ""))}">${escapeHtml(WORKFLOW_COPY.cancel)}</button>`;
  if (item.edit) {
    const saving = item.edit.status === "saving";
    const ready = item.edit.status === "editing";
    return `<div class="workflow-card-actions">
        <button class="btn btn-ghost btn-sm" type="button" data-workflow-action="edit-cancel" data-workflow-id="${escapeHtml(String(item.workflowId ?? ""))}" ${saving ? "disabled" : ""}>${escapeHtml(WORKFLOW_COPY.editCancel)}</button>
        <button class="btn btn-primary btn-sm" type="button" data-workflow-action="edit-save" data-workflow-id="${escapeHtml(String(item.workflowId ?? ""))}" ${ready ? "" : "disabled"}>${escapeHtml(saving ? WORKFLOW_COPY.editSaving : WORKFLOW_COPY.editSave)}</button>
      </div>`;
  }
  if (item.status === "review") {
    const busy = item.busy === "saving";
    return `<div class="workflow-card-actions">
        ${dismiss}
        <button class="btn btn-primary btn-sm" type="button" data-workflow-action="save" data-workflow-run-id="${escapeHtml(String(item.runId ?? ""))}" ${busy ? "disabled" : ""}>${escapeHtml(busy ? WORKFLOW_COPY.saving : WORKFLOW_COPY.saveDraft)}</button>
      </div>`;
  }
  if (item.status === "saved" || item.status === "proved") {
    const proving = item.busy === "proving";
    const canEnable = item.status === "proved" && item.proof && item.proof.ok === true;
    const proveLabel = item.status === "proved" ? WORKFLOW_COPY.proveAgain : WORKFLOW_COPY.prove;
    return `<div class="workflow-card-actions">
        ${dismiss}
        <button class="btn ${canEnable ? "btn-secondary" : "btn-primary"} btn-sm" type="button" data-workflow-action="prove" data-workflow-id="${escapeHtml(String(item.workflowId ?? ""))}" ${proving ? "disabled" : ""}>${escapeHtml(proving ? WORKFLOW_COPY.proving : proveLabel)}</button>
        ${
          canEnable
            ? `<button class="btn btn-primary btn-sm" type="button" data-workflow-action="enable" data-workflow-id="${escapeHtml(String(item.workflowId ?? ""))}">${escapeHtml(WORKFLOW_COPY.enable)}</button>`
            : ""
        }
        <button class="btn btn-secondary btn-sm" type="button" data-workflow-action="edit" data-workflow-id="${escapeHtml(String(item.workflowId ?? ""))}">${escapeHtml(WORKFLOW_COPY.edit)}</button>
      </div>`;
  }
  if (item.status === "enabled") {
    return `<div class="workflow-card-actions">
        ${dismiss}
        <button class="btn btn-secondary btn-sm" type="button" data-workflow-action="edit" data-workflow-id="${escapeHtml(String(item.workflowId ?? ""))}">${escapeHtml(WORKFLOW_COPY.edit)}</button>
      </div>`;
  }
  return ""; // dismissed
}

/** The draft card. States: review (derived, not stored) -> saving -> saved
 * (disabled, awaiting proof) -> proving -> proved (proof.ok decides whether
 * enablement is offered) -> enabled. A card restored purely from events has no
 * step list (the definition lives host-side) and says so rather than showing
 * an invented one. */
function renderWorkflowDraftItemHtml(item) {
  if (!item || item.dismissed) return "";
  const title =
    item.status === "enabled"
      ? WORKFLOW_COPY.draftEnabledTitle
      : item.status === "proved"
        ? WORKFLOW_COPY.draftProvedTitle
        : item.status === "saved"
          ? WORKFLOW_COPY.draftSavedTitle
          : WORKFLOW_COPY.draftTitle;
  const detail =
    item.status === "enabled"
      ? WORKFLOW_COPY.enabledDetail
      : item.status === "proved"
        ? WORKFLOW_COPY.provedDetail
        : item.status === "saved"
          ? WORKFLOW_COPY.savedDetail
          : WORKFLOW_COPY.draftDetail;
  const steps = Array.isArray(item.review?.steps) ? item.review.steps : Array.isArray(item.draft?.steps) ? item.draft.steps : [];
  const stepsHtml = item.edit
    ? workflowEditHtml(item)
    : steps.length
      ? workflowStepsHtml(steps, Array.isArray(item.proofOutcomes) ? item.proofOutcomes : null)
      : item.status === "review"
        ? ""
        : `<p class="workflow-card-note">${escapeHtml(WORKFLOW_COPY.draftRestoredDetail)}</p>`;
  return `<div class="card workflow-card" data-workflow-kind="draft" data-workflow-status="${escapeHtml(String(item.status))}">
      <div class="permission-card-head">
        <span class="permission-card-icon">${iconMarkup("skills", { size: 18 })}</span>
        <div>
          <p class="permission-card-title">${escapeHtml(title)}</p>
          <p class="permission-card-detail">${escapeHtml(detail)}</p>
        </div>
      </div>
      ${workflowMetaHtml(item)}
      ${stepsHtml}
      ${workflowProofHtml(item)}
      ${workflowEditProblemHtml(item)}
      ${workflowErrorHtml(item)}
      ${workflowDraftActionsHtml(item)}
    </div>`;
}

/** The drift notice: a FACT about a past execution — no controls, no
 * `role="alertdialog"`, nothing to answer (spec "Drift is a distinguishable
 * execution outcome" / the change's "static, no authority" rule). */
function renderWorkflowDriftItemHtml(item) {
  if (!item) return "";
  const stepLabel = item.step != null ? `bước ${item.step + 1}` : "một bước";
  const reason = WORKFLOW_DRIFT_REASON_VI[item.reason] || "workflow không còn khớp với trang";
  const evidence = workflowEvidenceText(item.evidence);
  return `<div class="workflow-drift-note" role="status" data-workflow-kind="drift">
      <span class="workflow-drift-icon">${iconMarkup("alertTriangle", { size: 14 })}</span>
      <div class="workflow-drift-body">
        <p class="workflow-drift-title">${escapeHtml(WORKFLOW_COPY.driftTitle)}: ${escapeHtml(String(item.workflowId || "(không rõ)"))}</p>
        <p class="workflow-drift-line">${escapeHtml(`${stepLabel} — ${reason}`)}</p>
        ${evidence ? `<div class="workflow-drift-evidence"><code>${escapeHtml(evidence)}</code></div>` : ""}
        <p class="workflow-drift-hint">${escapeHtml(WORKFLOW_COPY.driftHint)}</p>
      </div>
    </div>`;
}

/** The heal proposal card: reason + evidence + base version, with Allow/Deny
 * bound to THIS proposal id, and a bounded expiry that resolves to its own
 * distinguishable state (never to "still pending"). */
function renderWorkflowHealItemHtml(item, now = Date.now()) {
  if (!item || item.dismissed) return "";
  const expired = item.status === "pending" && typeof item.expiresAt === "number" && item.expiresAt <= now;
  const status = expired ? "expired" : item.status;
  const lines = [];
  if (item.reason) lines.push(item.reason);
  const evidence = workflowEvidenceText(item.evidence);
  if (evidence) lines.push(evidence);
  const statusHtml =
    status === "saved"
      ? `<p class="workflow-card-note is-ok">${escapeHtml(`${WORKFLOW_COPY.healSaved}${item.toVersion != null ? ` (v${item.toVersion})` : ""}`)}</p>`
      : status === "rejected"
        ? `<p class="workflow-card-note">${escapeHtml(WORKFLOW_COPY.healRejected)}</p>`
        : status === "expired"
          ? `<p class="workflow-card-note">${escapeHtml(WORKFLOW_COPY.healExpired)}</p>`
          : status === "superseded"
            ? `<p class="workflow-card-note">${escapeHtml(WORKFLOW_COPY.healSuperseded)}</p>`
            : "";
  const expiryHtml =
    status === "pending" && typeof item.expiresAt === "number"
      ? `<p class="workflow-card-note">${escapeHtml(`${WORKFLOW_COPY.healExpiresAt} ${formatClockVi(new Date(item.expiresAt).toISOString())}`)}</p>`
      : "";
  const busy = item.busy === "deciding";
  const actionsHtml =
    status === "pending"
      ? `<div class="workflow-card-actions">
          <button class="btn btn-ghost btn-sm" type="button" data-workflow-action="heal-deny" data-workflow-proposal-id="${escapeHtml(String(item.proposalId))}" ${busy ? "disabled" : ""}>${escapeHtml(WORKFLOW_COPY.healDeny)}</button>
          <button class="btn btn-primary btn-sm" type="button" data-workflow-action="heal-allow" data-workflow-proposal-id="${escapeHtml(String(item.proposalId))}" ${busy ? "disabled" : ""}>${escapeHtml(busy ? WORKFLOW_COPY.healDeciding : WORKFLOW_COPY.healAllow)}</button>
        </div>`
      : "";
  return `<div class="card workflow-card workflow-heal-card" data-workflow-kind="heal" data-workflow-status="${escapeHtml(String(status))}">
      <div class="permission-card-head">
        <span class="permission-card-icon">${iconMarkup("spark", { size: 18 })}</span>
        <div>
          <p class="permission-card-title">${escapeHtml(WORKFLOW_COPY.healTitle)}</p>
          <p class="permission-card-detail">${escapeHtml(WORKFLOW_COPY.healDetail)}</p>
        </div>
      </div>
      <p class="workflow-card-meta">${escapeHtml(`${WORKFLOW_COPY.baseVersion} v${item.baseVersion != null ? item.baseVersion : "?"}`)}${item.workflowId ? ` · <code>${escapeHtml(String(item.workflowId))}</code>` : ""}</p>
      <ul class="workflow-heal-reasons">${lines.map((l) => `<li>${escapeHtml(String(l))}</li>`).join("")}</ul>
      ${workflowErrorHtml(item)}
      ${statusHtml}
      ${expiryHtml}
      ${actionsHtml}
    </div>`;
}

// ---- the composer-level notice (never a card) -----------------------------
// An incomplete derivation is a sentence about something that did NOT happen
// (no draft exists to review), so it belongs in the same inline slot family
// composer-scoped problems already use — not in a permission card, which would
// imply a decision.
function installWorkflowNotice() {
  const notice = document.createElement("div");
  notice.className = "workflow-notice";
  notice.setAttribute("id", "workflow-notice");
  notice.setAttribute("role", "alert");
  notice.hidden = true;
  el.composerWrap.insertBefore(notice, el.composerInput.parentNode);
  return notice;
}
{
  el.workflowNotice = installWorkflowNotice();
}

/** Show/replace the inline workflow notice. Never a card, never a decision. */
function showWorkflowNotice(text) {
  if (!el.workflowNotice) return;
  el.workflowNotice.textContent = text || "";
  el.workflowNotice.hidden = !text;
}
function clearWorkflowNotice() {
  showWorkflowNotice("");
}

// ---- the turn footer's affordance -----------------------------------------
// The run whose turn should offer "Lưu thành workflow", or null. Deliberately
// narrow: the LATEST turn, only once it COMPLETED (a run still going has no
// finished trail), never while a run is active or a derivation/enhancement is
// in flight, and never twice for the same run — once a draft card exists for
// it, the card is the affordance.
// Takes one plain options object (NOT a destructured parameter) so
// test/_extract.mjs's brace-matching — which lands on the first `{` after the
// function name — finds this function's actual body rather than a
// destructuring pattern in its own parameter list. The same constraint
// background.js's createAgentSettingsRelay documents.
function workflowAffordanceRunId(model, options) {
  const opts = options && typeof options === "object" ? options : {};
  if (!model || opts.draftPending === true || opts.enhancePending === true) return null;
  if (typeof model.hasActiveRun === "function" && model.hasActiveRun()) return null;
  let latest = null;
  for (let i = model.items.length - 1; i >= 0; i--) {
    if (model.items[i].kind === "assistant_turn") {
      latest = model.items[i];
      break;
    }
  }
  if (!latest || latest.complete !== true || latest.runId == null) return null;
  if (model.items.some((it) => it.kind === "workflow_draft" && String(it.runId) === String(latest.runId))) return null;
  return latest.runId;
}

/** In-flight derivation state for the affordance (module-local: it exists only
 * while a request the panel itself made is outstanding, and it dies with the
 * document on purpose). */
let workflowDraftPendingRunId = null;

/** The tab a proof runs against: the page this panel document is bound to,
 * read FRESH at click time. A cached tabId could prove a different page than
 * the one on screen, which is exactly the freshness the proof exists to
 * establish. */
function currentWorkflowTabId() {
  const snap = pageContext ? pageContext.snapshot() : null;
  return snap && typeof snap.tabId === "number" ? snap.tabId : null;
}

/** The definition payload for `workflow_draft_save`: ONLY what the derivation
 * produced. The host re-validates it with the registry's own schema and owns
 * the owner/enabled policy, so this never fabricates an owner and never asks
 * for enablement. */
function buildWorkflowDefinitionFromDraft(draft) {
  if (!draft || typeof draft !== "object") return null;
  const id = typeof draft.workflowId === "string" ? draft.workflowId : typeof draft.id === "string" ? draft.id : null;
  if (!id || !Array.isArray(draft.steps) || !draft.steps.length) return null;
  const definition = {
    id,
    name: typeof draft.name === "string" && draft.name.trim() ? draft.name.trim() : id,
    steps: draft.steps
  };
  if (typeof draft.domain === "string" && draft.domain.trim()) definition.domainConstraints = [draft.domain.trim()];
  else if (Array.isArray(draft.domain) && draft.domain.length) definition.domainConstraints = draft.domain.filter((d) => typeof d === "string");
  // The host's own draft reply may carry EVERY recorded host as `domains`
  // (rather than the single bound `domain`): when it does, the constraint list
  // is that set — the definition must not silently narrow to one host.
  if (Array.isArray(draft.domains) && draft.domains.length) {
    const domains = draft.domains.filter((d) => typeof d === "string" && d.trim());
    if (domains.length) definition.domainConstraints = domains;
  }
  if (draft.document) definition.documentConstraints = { requireBoundDocument: true };
  return definition;
}

async function requestWorkflowDraftForRun(runId) {
  if (runId == null || workflowDraftPendingRunId != null) return;
  workflowDraftPendingRunId = runId;
  clearWorkflowNotice();
  render(); // the affordance disappears while its own request is in flight
  let reply = null;
  try {
    reply = await panel.requestWorkflowDraft(runId);
  } finally {
    workflowDraftPendingRunId = null;
  }
  if (!reply) showWorkflowNotice(WORKFLOW_COPY.hostUnavailable);
  else if (reply.ok !== true) showWorkflowNotice(workflowDraftRefusalText(reply));
  render();
}

async function saveWorkflowDraftItem(item) {
  if (!item) return;
  const definition = buildWorkflowDefinitionFromDraft(item.draft);
  if (!definition) {
    showWorkflowNotice(WORKFLOW_COPY.missingDraft);
    render();
    return;
  }
  const reply = await panel.saveWorkflowDraft(item.runId, definition);
  if (!reply) showWorkflowNotice(WORKFLOW_COPY.hostUnavailable);
  render();
}

async function proveWorkflowItem(item) {
  if (!item || !item.workflowId) return;
  const tabId = currentWorkflowTabId();
  if (tabId == null) {
    showWorkflowNotice(WORKFLOW_COPY.noTab);
    render();
    return;
  }
  const reply = await panel.proveWorkflow({ workflowId: item.workflowId, version: item.version, tabId });
  if (!reply) showWorkflowNotice(WORKFLOW_COPY.hostUnavailable);
  else if (reply.ok !== true) showWorkflowNotice(workflowRefusalText(reply.reason, reply.detail));
  render();
}

async function enableWorkflowItem(item) {
  if (!item || !item.workflowId) return;
  const reply = await panel.enableWorkflow({ workflowId: item.workflowId, version: item.version });
  if (!reply) showWorkflowNotice(WORKFLOW_COPY.hostUnavailable);
  else if (reply.ok !== true) showWorkflowNotice(workflowRefusalText(reply.reason));
  render();
}

/** The live args inputs of one edit card, in row order. */
function workflowEditRowTexts(card) {
  return Array.from(card.querySelectorAll("input.workflow-edit-args")).map((input) => input.value);
}

async function openWorkflowEditItem(item) {
  if (!item || !item.workflowId) return;
  await panel.requestWorkflowEdit({ workflowId: item.workflowId, version: item.version });
  render();
}

async function saveWorkflowEditItem(item, btn, model) {
  if (!item || !item.workflowId || !item.edit || !btn) return;
  const card = btn.closest(".workflow-card");
  const collected = card ? buildWorkflowEditSteps(item.edit.steps, workflowEditRowTexts(card)) : { ok: false };
  if (!collected.ok) {
    model.setWorkflowEditProblem(item.workflowId, WORKFLOW_COPY.editInvalidArgs);
    render();
    return;
  }
  const reply = await panel.saveWorkflowEdit({ workflowId: item.workflowId, version: item.edit.version ?? item.version, steps: collected.steps });
  if (!reply) showWorkflowNotice(WORKFLOW_COPY.hostUnavailable);
  render();
}

function removeWorkflowEditRow(item, btn, model) {
  if (!item || !item.edit || !btn) return;
  const card = btn.closest(".workflow-card");
  const index = Number(btn.getAttribute("data-step-index"));
  if (!card || !Number.isInteger(index)) return;
  const collected = buildWorkflowEditSteps(item.edit.steps, workflowEditRowTexts(card));
  if (!collected.ok) {
    model.setWorkflowEditProblem(item.workflowId, WORKFLOW_COPY.editInvalidArgs);
    render();
    return;
  }
  model.replaceWorkflowEditSteps(item.workflowId, collected.steps.filter((_, i) => i !== index));
  render();
}

async function decideWorkflowHealItem(item, decision) {
  if (!item || !item.proposalId) return;
  const reply = await panel.decideWorkflowHeal({ proposalId: item.proposalId, decision });
  if (!reply) showWorkflowNotice(WORKFLOW_COPY.hostUnavailable);
  // A refusal is rendered ON the card (settleWorkflowHealDecision stores the
  // host's reason), so a late decision shows what the host actually said
  // instead of a card that quietly resets to pending.
  render();
}

/** The item a workflow card's control belongs to. Cards carry the identity
 * their buttons act on (runId while unsaved, workflowId once saved, proposalId
 * for a heal) because item ORDER is not identity: a re-render must never let a
 * click land on a different card's record. */
function workflowItemForControl(model, btn) {
  if (!model || !btn) return null;
  const proposalId = btn.getAttribute("data-workflow-proposal-id");
  if (proposalId) return model.workflowHealItem(proposalId);
  const workflowId = btn.getAttribute("data-workflow-id");
  if (workflowId) return model.workflowDraftItem({ workflowId });
  const runId = btn.getAttribute("data-workflow-run-id");
  if (runId != null && runId !== "") return model.workflowDraftItem({ runId });
  return null;
}

function wireWorkflowControls(model) {
  for (const btn of el.transcript.querySelectorAll(".turn-workflow-btn")) {
    btn.addEventListener("click", () => requestWorkflowDraftForRun(btn.getAttribute("data-run-id")));
  }
  for (const btn of el.transcript.querySelectorAll("[data-workflow-action]")) {
    btn.addEventListener("click", () => {
      const item = workflowItemForControl(model, btn);
      if (!item) return;
      const action = btn.getAttribute("data-workflow-action");
      if (action === "save") return saveWorkflowDraftItem(item);
      if (action === "prove") return proveWorkflowItem(item);
      if (action === "enable") return enableWorkflowItem(item);
      if (action === "edit") return openWorkflowEditItem(item);
      if (action === "edit-save") return saveWorkflowEditItem(item, btn, model);
      if (action === "edit-cancel") {
        model.cancelWorkflowEdit(item.workflowId);
        render();
        return;
      }
      if (action === "remove-step") return removeWorkflowEditRow(item, btn, model);
      if (action === "heal-allow") return decideWorkflowHealItem(item, "allow");
      if (action === "heal-deny") return decideWorkflowHealItem(item, "deny");
      if (action === "dismiss") {
        // Local only, and deliberately so: the durable record (the saved
        // version, the proposal's outcome) is the host's, while "stop showing
        // me this card" is the operator's — a reload rebuilds the card from
        // the host's events, which is the honest behaviour for a record that
        // still exists.
        item.dismissed = true;
        render();
      }
    });
  }
}

let wasNearBottom = true;
function isNearBottom() {
  const s = el.panelScroll;
  return s.scrollHeight - s.scrollTop - s.clientHeight < 80;
}

/**
 * Whether the transcript's scroll position should pull the next older page
 * (tasks.md 3.2's lazy older-event retrieval, driven from the UI).
 *
 * Deliberately a tiny pure predicate rather than logic inlined in the scroll
 * listener: it is the one decision of this feature that can be reasoned about
 * without a DOM, and the cost of getting it wrong is a load-per-scroll-event
 * loop or a conversation whose older history is unreachable.
 */
function shouldLoadOlderTranscript(metrics) {
  const { scrollTop = 0, hasOlder = false, loading = false, threshold = 48 } = metrics || {};
  if (!hasOlder || loading) return false;
  return scrollTop <= threshold;
}

// One older page at a time: the model cannot hold more than its window
// (tasks.md 3.3), and two concurrent pulls would race each other's
// scroll-height compensation.
let loadingOlderTranscript = false;

/**
 * Load one older transcript page and keep the reader where they were. The
 * transcript is rendered top-to-bottom, so prepending items pushes the current
 * paragraph DOWN by exactly the height that was added; adding that delta back
 * to `scrollTop` leaves the reading position visually unchanged (the archived
 * design's "preserve scroll position when reading older content"). This is the
 * same reason `renderTranscript()`'s own near-bottom snap must not run for
 * this case — being pulled to the bottom is the opposite of what the reader
 * asked for.
 */
async function loadOlderTranscript() {
  const model = panel.currentModel();
  if (!model || loadingOlderTranscript || !model.hasOlderEvents?.()) return null;
  loadingOlderTranscript = true;
  const beforeHeight = el.panelScroll.scrollHeight;
  const beforeTop = el.panelScroll.scrollTop;
  try {
    const applied = await panel.loadOlderEvents(model.conversationId);
    if (!applied) return null;
    // Everything that was on screen is now `added` pixels further down; putting
    // the reader back there leaves the reading position unchanged. A reader who
    // was already at the bottom is clamped right back to the bottom, which is
    // the auto-follow behaviour they expect.
    const added = el.panelScroll.scrollHeight - beforeHeight;
    if (added > 0) el.panelScroll.scrollTop = beforeTop + added;
    if (applied.limitReached) {
      // The window is full (tasks.md 3.3's memory budget). Say so on the
      // control instead of leaving a button that can never do anything.
      setOlderTranscriptStatus("Đã đạt giới hạn bộ nhớ hiển thị — mở lại cuộc trò chuyện để xem phần cũ hơn.");
    }
    return applied;
  } finally {
    loadingOlderTranscript = false;
  }
}

function setOlderTranscriptStatus(text) {
  olderTranscriptNotice = text ? { conversationId: panel.currentConversationId, text } : null;
  // Forced: this notice is not part of the model, so the streaming signature
  // cannot see it change; the structural renderer must lay it out.
  renderTranscript({ force: true });
}

// The "window is full" notice, scoped to the conversation it is about: opening
// a different conversation must not show a notice that was earned elsewhere.
let olderTranscriptNotice = null;

/**
 * The transcript's "older history" affordance: a control at the top of a
 * windowed conversation (the model reports `hasOlderEvents()`), which also
 * loads automatically when the reader scrolls to the very top — the two halves
 * of tasks.md 3.2 ("lazy older-event retrieval") being usable at all. Without
 * it the window is invisible: a long conversation would simply begin
 * mid-history with nothing saying so.
 */
function renderOlderTranscriptControl(model) {
  if (!model || typeof model.hasOlderEvents !== "function" || !model.hasOlderEvents()) return "";
  const notice = olderTranscriptNotice && olderTranscriptNotice.conversationId === model.conversationId ? olderTranscriptNotice.text : null;
  const note = notice ? `<span class="field-hint">${escapeHtml(notice)}</span>` : "";
  return `<div class="older-transcript"><button class="btn btn-secondary btn-sm" type="button" id="btn-older-transcript"${notice ? " disabled" : ""}>Tải lịch sử cũ hơn</button>${note}</div>`;
}

// ---- In-place streaming tail (design decision 6) ------------------------
//
// While the ONLY change since the last render is the latest turn's growing
// answer/thinking text, the transcript must not be rebuilt: a wholesale
// `innerHTML` replacement would destroy the reader's scroll offset, text
// selection and focus on every 75 ms batch, which is exactly what the spec
// forbids. `transcriptStructureSignature()` reduces everything the structural
// renderer's SHAPE depends on (item kinds and order, turn lifecycles, tool
// rows and their statuses, warnings/documents/answers, whether thinking or
// text exists at all, the busy indicator, the conversation) to one string.
// Two renders with the same signature differ only in streamed buffer CONTENT,
// so the in-place path paints the buffers into the nodes the structural
// renderer already created and leaves everything else — including the
// streaming cursor — untouched. Any structural change goes through the
// structural renderer, which stays the authority.
//
// The length of the text/thinking is deliberately NOT part of the signature;
// their EXISTENCE is, because that is what toggles the block/copy-button
// markup.
let lastStructureSignature = null;

function transcriptStructureSignature(model, opts) {
  opts = opts || {};
  const busy = !!opts.busy;
  const parts = [String(model.conversationId ?? ""), model.hasOlderEvents?.() ? "older" : "newest"];
  for (const item of model.items) {
    switch (item.kind) {
      case "user":
        // `queueState`/`interruptFellBack` are structural: a chip appearing,
        // changing, or disappearing with a cancel control must go through the
        // structural renderer, not the in-place streaming painter (which only
        // ever touches the latest turn's answer text).
        parts.push(
          `u:${item.runId ?? ""}:${item.isPlaceholder ? 1 : 0}:${(item.attachments || []).length}:${item.queueState || ""}:${item.interruptFellBack ? 1 : 0}`
        );
        break;
      case "recording":
        parts.push(`rec:${item.recordingId}:${item.transcriptStatus || ""}`);
        break;
      case "download_notice":
        parts.push(`dn:${item.outcome}:${item.filename || ""}:${item.url || ""}`);
        break;
      case "download_decision":
        parts.push(`dd:${item.requestId}:${item.decision}`);
        break;
      // Rerunnable workflows + self-healing (this change): every visible state
      // change of a card must go through the structural renderer — a card
      // appearing, a stage advancing, a proof's verdict flipping, a heal
      // proposal expiring or being answered. None of these are reachable by
      // the in-place streaming painter (which only touches the latest turn's
      // answer text).
      case "workflow_draft":
        parts.push(
          `wd:${item.runId ?? ""}:${item.workflowId ?? ""}:${item.version ?? ""}:${item.status}:${item.busy || ""}:${item.proof ? (item.proof.ok ? "ok" : "fail") : ""}:${item.proofOutcomes ? item.proofOutcomes.length : ""}:${item.dismissed ? 1 : 0}:${item.lastError ? item.lastError.reason || item.lastError.op : ""}:${(item.review?.steps || item.draft?.steps || []).length}`
        );
        break;
      case "workflow_drift":
        parts.push(`wfdrift:${item.driftId}`);
        break;
      case "workflow_heal":
        parts.push(
          `wh:${item.proposalId}:${item.status}:${item.busy || ""}:${item.decision || ""}:${item.dismissed ? 1 : 0}:${item.lastError ? item.lastError.reason || item.lastError.op : ""}:${item.expiresAt ?? ""}`
        );
        break;
      case "assistant_turn":
        parts.push([
          "t",
          String(item.runId ?? ""),
          item.lifecycle,
          item.complete ? 1 : 0,
          item.text ? 1 : 0,
          item.thinking ? 1 : 0,
          item.redactedThinking ? 1 : 0,
          (item.toolRows || []).map((r) => r.status).join("."),
          (item.warnings || []).map((w) => w.kind).join("."),
          (item.documents || []).map((d) => d.documentId).join("."),
          (item.questionAnswers || []).length
        ].join(","));
        break;
      default:
        parts.push(`x:${item.kind}`);
        break;
    }
  }
  return parts.join("|") + (busy ? "|busy" : "");
}

/** The nodes the in-place path updates: the live turn's answer span and, when
 * a thinking block exists for it, its body. Null when the transcript does not
 * currently hold this turn in its streaming shape — in which case the caller
 * falls back to the structural render. */
function streamingTailNodes() {
  const answer = el.transcript.querySelector(".prose .stream-answer-text");
  if (!answer) return null;
  const thinkingBlock = el.transcript.querySelector(".thinking-block.is-live");
  return {
    answer,
    thinking: thinkingBlock ? thinkingBlock.querySelector(".thinking-body") : null
  };
}

/**
 * Grow a streamed node's text WITHOUT replacing its children, so the text
 * node the live answer is anchored in (and any selection range inside it)
 * survives every batch — design decision 6's "appends fragments into those
 * nodes as batches arrive". When the new value is a prefix-extension of what
 * the node's single text node already holds, only the missing delta is
 * written, via `appendData()`: assigning the whole string to `data` would run
 * the DOM "replace data" algorithm over the already-visible range and collapse
 * any live selection or caret inside it, which is the defect this path exists
 * to avoid. Anything else (a supersede, a redacted body, the initial paint)
 * replaces the children, exactly as before.
 */
function setNodeTextIfChanged(node, text) {
  if (!node) return;
  const next = String(text == null ? "" : text);
  const child = node.firstChild;
  if (child && child.nodeType === 3 && typeof child.data === "string") {
    if (child.data === next) return;
    if (next.startsWith(child.data)) {
      child.appendData(next.slice(child.data.length));
      return;
    }
  }
  if (node.textContent !== next) node.textContent = next;
}

/**
 * Paint the latest turn's streamed buffers into the EXISTING nodes, in place.
 * No element is created, replaced or cleared, and the growing text is written
 * into the same text node it already occupies (`setNodeTextIfChanged`), so a
 * text selection or focused control inside the transcript, the streaming
 * cursor that sits after the growing text, and the reading position all
 * survive a batch. The thinking body is only rewritten when there IS thinking
 * content, so a redacted block's message is never wiped by an empty buffer.
 */
function paintStreamingTail(nodes, turn) {
  if (!nodes || !nodes.answer) return false;
  setNodeTextIfChanged(nodes.answer, turn.text);
  if (nodes.thinking && turn.thinking) setNodeTextIfChanged(nodes.thinking, turn.thinking);
  return true;
}

/** Index of the LATEST assistant turn in `items`, or -1. The streaming path
 * keys on this rather than on `items.length - 1`: a workflow card (a drift
 * notice the companion records mid-run, a heal proposal the assistant raises)
 * is appended as an item and legitimately sits BELOW a turn that is still
 * streaming, and treating such a card as "the latest item" would demote the
 * live turn to finished — no cursor, no in-place painting, a full rebuild per
 * token batch. Pure so the rule is testable without a DOM. */
function latestAssistantTurnIndex(items) {
  const list = Array.isArray(items) ? items : [];
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i] && list[i].kind === "assistant_turn") return i;
  }
  return -1;
}

function renderTranscript({ force = false } = {}) {
  const model = panel.currentModel();
  el.emptyStateSlot.innerHTML = "";
  if (!model || model.items.length === 0) {
    lastStructureSignature = null;
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
  const signature = transcriptStructureSignature(model, { busy: isBusy });
  // The turn the streaming path paints into: the LATEST ASSISTANT TURN, which
  // is NOT necessarily the last item — see latestAssistantTurnIndex() for why
  // (workflow cards can sit below a turn that is still streaming).
  const latestTurnIndex = latestAssistantTurnIndex(model.items);
  const latest = latestTurnIndex >= 0 ? model.items[latestTurnIndex] : null;
  if (!force && latest && signature === lastStructureSignature && latest.kind === "assistant_turn") {
    const nodes = streamingTailNodes();
    if (nodes && paintStreamingTail(nodes, latest)) {
      // Same as the structural path's near-bottom snap: a reader already at
      // the bottom follows the growing text, a reader who scrolled away is
      // left exactly where they were. No innerHTML write, no re-wiring, and
      // nothing touches the polite live region.
      if (preserveScroll) el.panelScroll.scrollTop = el.panelScroll.scrollHeight;
      updateJumpLatest();
      return;
    }
  }
  // Which turn (if any) offers "Lưu thành workflow" — computed ONCE per render,
  // not per item (see workflowAffordanceRunId for the visibility rules).
  const workflowRunId = workflowAffordanceRunId(model, {
    draftPending: workflowDraftPendingRunId != null,
    enhancePending: !!enhanceState
  });
  const html = model.items
    .map((item, idx) => {
      if (item.kind === "user") return renderUserItemHtml(item);
      if (item.kind === "recording") return renderRecordingItemHtml(item);
      if (item.kind === "download_notice") return renderDownloadNoticeItemHtml(item);
      if (item.kind === "download_decision") return renderDownloadDecisionItemHtml(item);
      // Rerunnable workflows + self-healing (this change): three card kinds,
      // rendered where the run they describe ended.
      if (item.kind === "workflow_draft") return renderWorkflowDraftItemHtml(item);
      if (item.kind === "workflow_drift") return renderWorkflowDriftItemHtml(item);
      if (item.kind === "workflow_heal") return renderWorkflowHealItemHtml(item);
      const isLatest = idx === latestTurnIndex;
      return renderTurnHtml(item, {
        isLatestStreaming: isLatest && (item.lifecycle === "running" || item.lifecycle === "created"),
        busy: isLatest && isBusy,
        elapsedVisible: isLatest && elapsedVisible,
        workflowAffordance: workflowRunId != null && String(item.runId) === String(workflowRunId)
      });
    })
    .join("");
  el.transcript.innerHTML = renderOlderTranscriptControl(model) + html;
  wireToolRowIcons(model);
  wireThinkingToggles();
  wireThumbButtons();
  wireDocumentCards();
  wireCopyButtons(model);
  wireQueuedMessageControls();
  wireWorkflowControls(model);
  el.transcript.querySelector("#btn-older-transcript")?.addEventListener("click", () => {
    loadOlderTranscript();
  });
  if (preserveScroll) el.panelScroll.scrollTop = el.panelScroll.scrollHeight;
  updateJumpLatest();
  lastStructureSignature = signature;
}

/** The per-message cancel control on a still-pending queued message. Its reply
 * is what the panel follows — an accepted cancel arrives as the durable
 * `message_cancelled` event (so a second panel sees it too), and a refusal
 * discloses the state the message actually reached — so this handler only
 * sends the request and leaves the visible state to the model. */
function wireQueuedMessageControls() {
  for (const btn of el.transcript.querySelectorAll("[data-cancel-message-id]")) {
    btn.addEventListener("click", () => {
      const raw = btn.getAttribute("data-cancel-message-id");
      const messageId = Number(raw);
      if (!Number.isFinite(messageId)) return;
      panel.cancelQueuedMessage(messageId);
    });
  }
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

// Thinking-block disclosure wiring. Same `.wired` sentinel convention as
// `wireTimelineToggles`: a structural re-render preserves the listeners, and
// the toggle mutates only DOM visibility plus the UI-only override map, never
// the model. The button is a real <button>, so Enter/Space activation is
// native; the explicit keydown handler keeps that true if the element ever
// changes. `aria-expanded` is the source of truth for which way a click
// toggles, because the value may have come from the live default rather than
// an explicit choice.
function wireThinkingToggles() {
  el.transcript.querySelectorAll(".thinking-summary").forEach((btn) => {
    if (btn.dataset.wired === "1") return;
    btn.dataset.wired = "1";
    btn.addEventListener("click", () => toggleThinkingSummary(btn));
    btn.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " " || e.key === "Spacebar") {
        e.preventDefault();
        toggleThinkingSummary(btn);
      }
    });
  });
}

function toggleThinkingSummary(btn) {
  const wrap = btn.closest(".thinking-block");
  if (!wrap) return;
  const runId = wrap.dataset.runId;
  const body = wrap.querySelector(".thinking-body");
  const glyph = btn.querySelector(".thinking-glyph");
  const willExpand = btn.getAttribute("aria-expanded") !== "true";
  thinkingExpandedRuns.set(runId, willExpand);
  btn.setAttribute("aria-expanded", willExpand ? "true" : "false");
  if (body) body.hidden = !willExpand;
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
  // Reaching the very top of a windowed conversation pulls the next older
  // page (tasks.md 3.2). The predicate is pure and the actual load is
  // re-entrancy guarded, so a scroll event storm cannot start two.
  const model = panel.currentModel();
  if (
    shouldLoadOlderTranscript({
      scrollTop: el.panelScroll.scrollTop,
      hasOlder: !!model && typeof model.hasOlderEvents === "function" && model.hasOlderEvents(),
      loading: loadingOlderTranscript
    })
  ) {
    loadOlderTranscript();
  }
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
  renderDownloadDecision();
  renderQuestion();
  syncPermissionMode();
  renderTranscript();
  updateSendEnabled();
  const phase = panel.currentPhase();
  if (phase !== lastAnnouncedPhase) {
    announcePhase(phase);
    lastAnnouncedPhase = phase;
  }
  announceBusyTransitions(phase);
  updateRunControls(phase);
  renderQueuePausedBanner();
  syncBusyElapsedTimer();
}

// The paused-drain banner (tasks.md 6.2, panel spec "Resume control after
// stop"). Driven purely by the model's `queuePaused`, which is the host's own
// durable flag restored from the snapshot and updated by the
// message_queue_paused/message_queue_resumed events — never by the panel's
// optimism about a resume it has not seen confirmed.
function renderQueuePausedBanner() {
  if (!el.queuePausedBanner) return;
  const model = panel.currentModel();
  // `display`, not `hidden`: `.active-control-banner` sets its own display (see
  // installQueueControls()).
  el.queuePausedBanner.style.display = model && model.queuePaused === true ? "" : "none";
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

// Per-phase presentation of the run's own controls (tasks.md 6.1/6.2).
//
// #btn-send is now ALWAYS Send: submitting while a run is active queues the
// message behind it, so it must never double as Stop (that was the pre-change
// behaviour this change removes). #btn-stop takes over the run's own control
// and #btn-run-now is the interrupt choice; both exist only while a run is
// active, where they mean something.
function updateRunControls(phase) {
  const running = phase === RUN_PHASE.STREAMING || phase === RUN_PHASE.QUEUED || phase === RUN_PHASE.STOPPING || phase === RUN_PHASE.WAITING_FOR_PERMISSION;
  el.btnSend.className = "btn-icon";
  el.btnSend.setAttribute("aria-label", "Gửi");
  el.btnSend.innerHTML = iconMarkup("send", { size: 18, title: "Gửi" });
  // See installQueueControls(): `display` is toggled inline because the
  // controls' own classes declare a display that would beat `[hidden]`.
  if (el.btnStop) el.btnStop.style.display = running ? "" : "none";
  if (el.btnRunNow) el.btnRunNow.style.display = running ? "" : "none";
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
    // The prompt-enhancement control keeps its own, unchanged availability
    // rule (spec.md "Prompt enhancement availability": disabled "when a run is
    // queued, streaming, stopping, or waiting for permission") -- only the SEND
    // control's enablement changes in this change. The composer stays usable,
    // so a submission is QUEUED behind the active run instead of the operator
    // having to choose between waiting and stopping it (panel spec "Composer
    // remains usable while a run is active").
    if (el.btnEnhance) el.btnEnhance.disabled = true;
  }
  // The composer itself is never disabled any more: typing a next message
  // while the current turn streams is exactly what the queue exists for.
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
  // The same expression gates the run-now control: it submits the same draft,
  // only with mode:"interrupt", so it must never look available on an empty one.
  el.btnSend.disabled = !hasText || !panel.currentConversationId || !!enhanceState;
  if (el.btnRunNow) el.btnRunNow.disabled = el.btnSend.disabled;
  if (el.btnEnhance && !running) {
    if (enhanceState) {
      // In flight: the control now acts as Cancel (spec.md "Prompt
      // enhancement in-flight and cancellation") and must stay clickable for
      // that, not html-disabled -- exactly the same "acts as" pattern
      // el.btnStop relies on while a run is active. It cannot be reused to
      // start a SECOND overlapping generate while in this state, but that is
      // enforced by what a click on it does (doEnhance() below always
      // cancels, never generates, while enhanceState is set), not by the
      // disabled attribute.
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

  if (!attachments.length && !pickedElement) {
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
  // The picked-element chip, alongside the attachment thumbnails (task 5.2).
  if (pickedElement) {
    const chip = document.createElement("div");
    chip.className = "attachment-thumb design-mode-chip";
    const icon = document.createElement("span");
    icon.className = "design-mode-chip-icon";
    icon.innerHTML = iconMarkup("click", { size: 14 });
    const name = document.createElement("span");
    name.className = "attachment-thumb-name";
    const label = `<${pickedElement.record.tagName || "el"}>` + (pickedElement.record.selector ? ` ${pickedElement.record.selector}` : "");
    name.textContent = label;
    name.title = label;
    const rm = document.createElement("button");
    rm.type = "button";
    rm.className = "attachment-thumb-remove";
    rm.setAttribute("aria-label", "Bỏ phần tử đã chọn");
    rm.textContent = "×";
    rm.addEventListener("click", () => clearPickedElement());
    chip.append(icon, name, rm);
    strip.appendChild(chip);
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

// ---- design mode (element picker) --------------------------------------
// openspec/changes/add-design-mode-element-picker. An OPERATOR input path —
// see extension/background.js's own "Design mode / element picker bridge"
// header for why it never touches the browser lease, the approval gate, or
// tab scope. This section only: toggles the composer control, relays
// activate/cancel to background, receives a picked element back, routes its
// image through the EXISTING attachment path (task 5.3), and renders the
// removable chip.

// Whether THIS panel currently believes design mode is armed on
// `designModeTabId`. Reset on every exit route (selection, ended, cancel,
// bound-page change) — mirrors element-picker.js's own `active` in spirit,
// but is this panel's OWN belief, corrected by whatever background/the
// content script actually reports back.
let designModeActive = false;
let designModeTabId = null;
// design.md D8: the page identity recorded at ACTIVATION time (the operator
// is about to point at THIS exact page) — compared again at Send against
// pageContext.captureForSend()'s live result, independently of the ordinary
// page-context chip check (design.md "why reuse rather than add a second
// mechanism").
let pendingDesignModeIdentity = null;
// { record: {selector, tagName, markup, markupTruncated, styles, rectClipped},
//   attachmentId: string|null, identity: {tabId,url,doc}|null }
let pickedElement = null;

function renderDesignModeButton() {
  if (!el.btnDesignMode) return;
  el.btnDesignMode.setAttribute("aria-pressed", designModeActive ? "true" : "false");
}

const DESIGN_MODE_REFUSAL_MESSAGES = {
  restricted_page: "Không thể chọn phần tử trên trang này (trang nội bộ trình duyệt hoặc cửa hàng tiện ích).",
  agent_driving: "Không thể chọn phần tử khi agent đang điều khiển trang này.",
  tab_unavailable: "Trang không còn khả dụng.",
  injection_failed: "Không thể kích hoạt chế độ chọn phần tử trên trang này.",
  no_tab: "Chưa có trang nào được gắn để chọn phần tử."
};

/** Ends design mode from THIS side (chip removal, bound-page change, panel
 * toggled off while active) and tells background/the content script, which
 * tears down its own listeners/highlight regardless of whether this message
 * ever arrives (a closed tab, a dead worker) — this call is fire-and-forget
 * by design, matching every other best-effort chrome.runtime.sendMessage in
 * this file. */
function cancelDesignModeIfActive() {
  if (!designModeActive) return;
  const tabId = designModeTabId;
  designModeActive = false;
  designModeTabId = null;
  pendingDesignModeIdentity = null;
  renderDesignModeButton();
  if (tabId != null && typeof chrome !== "undefined" && chrome.runtime && typeof chrome.runtime.sendMessage === "function") {
    chrome.runtime.sendMessage({ type: "design_mode_cancel", tabId }).catch(() => {});
  }
}

async function toggleDesignMode() {
  if (!canAcceptAttachments()) return; // gated exactly as Send/attach are
  if (designModeActive) {
    cancelDesignModeIfActive();
    return;
  }
  const snap = pageContext ? pageContext.snapshot() : null;
  if (!snap || snap.tabId == null) {
    showAttachmentError(DESIGN_MODE_REFUSAL_MESSAGES.no_tab);
    return;
  }
  const tabId = snap.tabId;
  designModeTabId = tabId;
  pendingDesignModeIdentity = pageContext.identityForRecord();
  let res = null;
  try {
    res = await chrome.runtime.sendMessage({ type: "design_mode_activate", tabId });
  } catch {
    res = null;
  }
  if (!res || res.ok !== true) {
    // design.md D9: both refusals are decided before the mode appears
    // active — this panel never flips `designModeActive` until background
    // has actually confirmed activation.
    designModeTabId = null;
    pendingDesignModeIdentity = null;
    showAttachmentError((res && DESIGN_MODE_REFUSAL_MESSAGES[res.reason]) || "Không thể kích hoạt chế độ chọn phần tử.");
    return;
  }
  designModeActive = true;
  clearAttachmentError();
  renderDesignModeButton();
}
if (el.btnDesignMode) el.btnDesignMode.addEventListener("click", () => { toggleDesignMode().catch(() => {}); });

function clearPickedElement() {
  if (!pickedElement) return;
  const attachmentId = pickedElement.attachmentId;
  pickedElement = null;
  if (attachmentId && attachments.some((a) => a.id === attachmentId)) removeAttachment(attachmentId); // also re-renders the strip
  else renderAttachments();
}

/** A selection arrived from background (design_mode_picked): route the
 * clipped image through the EXISTING attachment path (task 5.3) — same File
 * object shape validateAndAppendFiles() already accepts from the OS file
 * picker, so it inherits the MIME allowlist and 10 MB ceiling (and their
 * exact over-ceiling message) with no parallel logic of its own. */
async function onDesignModePicked(msg) {
  if (designModeTabId !== msg.tabId) return; // stale/foreign — a different activation already superseded this one
  designModeActive = false;
  const identity = pendingDesignModeIdentity;
  designModeTabId = null;
  pendingDesignModeIdentity = null;
  renderDesignModeButton();

  let file = null;
  try {
    const resp = await fetch(`data:${msg.image.mimeType};base64,${msg.image.base64}`);
    const blob = await resp.blob();
    file = new File([blob], `design-mode-element-${Date.now()}.jpg`, { type: msg.image.mimeType });
  } catch {
    showAttachmentError("Không thể xử lý ảnh của phần tử đã chọn.");
    return;
  }
  const beforeIds = new Set(attachments.map((a) => a.id));
  validateAndAppendFiles([file], { from: "design_mode" });
  const added = attachments.find((a) => !beforeIds.has(a.id));
  if (!added) return; // rejected by the shared ceiling/allowlist path — its own error is already shown
  pickedElement = { record: msg.record, attachmentId: added.id, identity };
  renderAttachments();
}

if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.onMessage && typeof chrome.runtime.onMessage.addListener === "function") {
  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || typeof msg.type !== "string") return;
    if (msg.type === "design_mode_picked") {
      onDesignModePicked(msg).catch(() => {});
      return;
    }
    if (msg.type === "design_mode_ended") {
      if (designModeTabId !== msg.tabId) return;
      designModeActive = false;
      designModeTabId = null;
      pendingDesignModeIdentity = null;
      renderDesignModeButton();
      if (msg.reason === "capture_failed") showAttachmentError("Không thể chụp ảnh của phần tử đã chọn.");
      return;
    }
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
  if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key === "Enter" && !el.slashPicker.isVisible()) {
    // Run now (tasks.md 6.1's keyboard access to the interrupt choice): the
    // same key that sends, with the modifier that asks for it immediately.
    // Checked before the plain Enter branch below, and carrying the same
    // slash-picker guard that branch has, so an open picker keeps owning
    // Enter rather than dispatching half-typed slash text.
    e.preventDefault();
    doSendRunNow();
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

// The mode the NEXT dispatch carries (host/agent/protocol.js's START_MODES).
// The dispatch function's own signature is deliberately parameterless: the
// shared extractor (test/_extract.mjs) brace-matches from the first `{` after
// the declarator, so a destructuring parameter would truncate the extracted
// body at its own parameter list — and an existing structural test pins the
// parameterless form verbatim. The run-now entry points therefore set this
// one-shot flag immediately before calling it, and the dispatch function
// consumes the flag synchronously before its first await; "queue" is the
// default every other path (Send, Enter) leaves in place.
// NOTE: do not spell the declarator out in a comment above it — the extractor
// finds it by the first textual match of its name and would match the comment.
let pendingSendMode = "queue";

/** Run now (tasks.md 6.1's explicit interrupt choice, shared by the run-now
 * control and Ctrl+Enter): dispatch the current draft asking the host to stop
 * the active turn and run this message immediately. With no run active the
 * host treats it as an ordinary submission, so this is safe to use any time. */
function doSendRunNow() {
  pendingSendMode = "interrupt";
  doSend();
}

async function doSend() {
  // Consumed synchronously, before the first await, so a second activation can
  // never inherit a stale interrupt intent.
  const mode = pendingSendMode;
  pendingSendMode = "queue";
  // The composer is `readOnly` (not `disabled`) while an enhancement request
  // is in flight (design.md decision 6), so it still keeps focus and still
  // dispatches keydown -- Enter would otherwise reach here and START a run
  // against the pre-enhancement text out from under the outstanding request.
  // spec.md's "composer SHALL be read-only" requirement means dispatch is
  // blocked too, not just that typing is: bail here (covers the Enter path, a
  // click on #btn-send and a click on #btn-run-now, since all three funnel
  // through doSend()).
  if (enhanceState) return;
  // A run no longer takes Send: submitting while one is active queues the
  // message behind it (or interrupts, for run-now) instead of stopping the
  // run. Stop is its own control now (#btn-stop) -- see updateRunControls().
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

  // design.md D8/tasks.md 5.5: a picked element carries its OWN recorded
  // identity, re-checked against THIS exact send — independently of the
  // ordinary page-context chip check just above, which can agree (the chip
  // itself looks unchanged) while the picked element is nonetheless stale
  // (e.g. the chip was pinned back to the original page after the pick, but
  // the pick happened on a page that is no longer what `context` reports).
  let elementRecord = null;
  if (pickedElement) {
    const sentIdentity = context ? { tabId: context.tabId, url: context.url, doc: context.doc } : null;
    if (!sameIdentity(pickedElement.identity, sentIdentity)) {
      contextStaleNotice = "Phần tử đã chọn thuộc một trang khác — đã bỏ, nhấn Gửi lại để tiếp tục.";
      clearPickedElement(); // drops both the record and its image attachment (see that function)
      renderContextChip();
      return; // never dispatch this activation — a further, explicit Send is required
    }
    elementRecord = {
      pageIdentity: pickedElement.identity,
      selector: pickedElement.record.selector,
      tagName: pickedElement.record.tagName,
      markup: pickedElement.record.markup,
      markupTruncated: pickedElement.record.markupTruncated,
      styles: pickedElement.record.styles,
      rectClipped: pickedElement.record.rectClipped
    };
  }

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
  // task 5.6: clear the picked element BEFORE clearAttachments() re-renders
  // the strip, so its chip does not draw for the instant between the two —
  // its underlying image attachment is already part of `attachmentRefs`
  // above and is cleared along with every other attachment below.
  pickedElement = null;
  clearAttachments();
  // The submission is not finished until the host has ANSWERED it: a refusal
  // (`queue_full` etc.) must leave the operator with their text and an
  // explanation, not a message that silently went nowhere (panel spec
  // "Queue-full refusal preserves the draft"). Everything below the clear
  // above is therefore only the OPTIMISTIC half of Send; the awaited outcome is
  // what decides whether it stands.
  const outcome = await panel.sendMessage(text, {
    tabScope,
    modelId: panel._selectedModelId,
    pageContext: context,
    attachments: attachmentRefs,
    elementRecord,
    effort: selectedEffort,
    mode
  });
  if (outcome && outcome.accepted === false) restoreRefusedDraft(text, outcome);
  render();
}

/**
 * The host refused this submission, so it never entered the queue and never
 * will run: the draft goes back into the composer (when the operator has not
 * already started typing something else, which must never be clobbered), and
 * the reason is shown where composer-scoped problems already appear — the same
 * alert slot attachment failures use, because it is the same kind of message:
 * this submission did not leave, and here is why. The line stays in the
 * transcript as "Không chạy được" (see ConversationModel.markSendRefused),
 * so nothing the operator typed disappears.
 */
function restoreRefusedDraft(text, outcome) {
  if (el.composerInput.value.trim().length === 0) {
    el.composerInput.value = text;
    autoGrow();
  }
  clearAttachmentError();
  showAttachmentError(sendRefusalNotice(outcome));
  updateSendEnabled();
}

function sendRefusalNotice(outcome) {
  if (outcome.reason === "queue_full") {
    const limit = Number.isInteger(outcome.limit) ? outcome.limit : null;
    return limit != null
      ? `Hàng đợi tin nhắn đã đầy (tối đa ${limit} tin đang chờ). Tin nhắn chưa được gửi.`
      : "Hàng đợi tin nhắn đã đầy. Tin nhắn chưa được gửi.";
  }
  if (outcome.reason === "malformed_mode") return "Yêu cầu gửi không hợp lệ. Tin nhắn chưa được gửi.";
  if (outcome.reason === "host_unavailable") return "Mất kết nối với companion. Tin nhắn chưa được gửi — nội dung đã được giữ lại.";
  return "Không gửi được tin nhắn. Nội dung đã được giữ lại.";
}

el.btnSend.addEventListener("click", () => doSend());
// Run now (tasks.md 6.1): the explicit interrupt. Only reachable while a run is
// active — that is the only state in which it means something different from an
// ordinary Send — and disabled on an empty draft by updateSendEnabled().
el.btnRunNow.addEventListener("click", doSendRunNow);
el.btnStop.addEventListener("click", () => {
  panel.stop("user_stop");
  render();
});
el.btnResumeQueue.addEventListener("click", () => {
  panel.resumeQueue();
});

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
 * updateRunControls()'s icon/aria-label swap for the run's own controls. */
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

// The history list itself (tasks.md 4.1-4.3). Every policy decision lives in
// history-view.js — this file only feeds it the cache, wires the toolbar and
// performs the host operations the view asks for. `container` is filled from
// scratch by the view; `scrollContainer` is the scrolling ancestor, which is
// also the element the paging/scroll-preservation logic measures.
const historyView = new HistoryListView({
  container: el.conversationList,
  scrollContainer: el.historyScroll || el.conversationList,
  document,
  actions: {
    onOpen: (entry) => openHistoryEntry(entry),
    onDelete: (entry) => deleteHistoryEntry(entry),
    onRename: (entry) => renameHistoryEntry(entry),
    onPin: (entry) => applyPresentationUpdate(entry, { pinned: !entry.pinned }),
    onArchive: (entry) => applyPresentationUpdate(entry, { archived: !entry.archived }),
    onExport: (entry) => exportHistoryEntry(entry),
    onRetry: () => refreshHistoryView(),
    // Every render (including the debounced search's, which the panel never
    // asks for) refreshes the filter summary from the report.
    onRender: () => syncHistoryFilterSummary()
  }
});

// The privacy switch and the retention outcome line (tasks.md 2.2; spec
// chat-history-storage "Privacy control" and "Bounded retention"). The store
// owns both facts; this binds the screen's controls to them — the switch
// disables raw-prompt caching (dropping already-cached previews), and the
// line reports what retention evicted so "the user can see the outcome". It
// is synced from `refreshHistoryView()` so a policy changed in another panel
// shows up here as well.
const historyPrivacy = new HistoryPrivacyControls({
  store: historyStore,
  toggle: el.historyPrivacyToggle,
  outcome: el.historyRetentionOutcome
});

// Reopening a conversation from the list (spec browser-assistant-panel
// "Reopen a conversation" / chat-history-lifecycle). The row's own "open"
// control is disabled while the conversation is stale, so an orphan can never
// be reopened into an empty transcript.
async function openHistoryEntry(entry) {
  await panel.reopenConversation(entry.conversationId);
  showChatView();
}

// Delete (tasks.md 1.3, unchanged contract): the HOST is asked first, and a
// failure is never presented as a success — the row stays and the operator is
// told why.
async function deleteHistoryEntry(entry) {
  const confirmed = window.confirm(
    `Xóa cuộc trò chuyện "${entry.title || entry.conversationId}"? ` +
      `Bản ghi hội thoại trên máy chủ companion và bản lưu cục bộ đều sẽ bị xóa.`
  );
  if (!confirmed) return;
  const result = await panel.deleteConversation(entry.conversationId);
  if (!result.ok) {
    window.alert(`Không xóa được cuộc trò chuyện: ${historyErrorText(result.reason)}. Dữ liệu vẫn còn nguyên.`);
    return;
  }
  // The store's own removal already notified this view; reconcile: false
  // re-renders from that new state instead of asking the host a second time.
  await refreshHistoryView({ reconcile: false });
}

/**
 * Rename / pin / archive (spec chat-history-lifecycle "Organization and
 * export"). One host operation behind all three: the host owns presentation
 * metadata and revisions it, so a stale edit from another panel comes back as
 * a conflict the operator is told about rather than a silent overwrite.
 */
async function applyPresentationUpdate(entry, patch) {
  const result = await panel.updateConversationPresentation(entry.conversationId, patch);
  if (!result.ok) {
    window.alert(`Không cập nhật được cuộc trò chuyện: ${historyErrorText(result.reason)}.`);
  }
  await refreshHistoryView({ reconcile: false });
}

async function renameHistoryEntry(entry) {
  const current = entry.title || "";
  const next = window.prompt("Đổi tên cuộc trò chuyện:", current);
  if (next == null) return;
  const title = next.trim();
  if (!title || title === current) return; // nothing to write — and the host rejects an empty patch
  await applyPresentationUpdate(entry, { title });
}

/**
 * Export one conversation (spec chat-history-lifecycle "Organization and
 * export"). The transcript comes from the HOST page by page
 * (panel-controller.js's exportConversation), never from this panel's bounded
 * window, and the artifact is written locally with a blob URL — no network,
 * no `downloads` permission, nothing leaves the machine (the same mechanism
 * the document viewer's download control uses).
 */
async function exportHistoryEntry(entry) {
  const choice = window.prompt('Xuất cuộc trò chuyện dưới dạng nào? Nhập "md" (Markdown) hoặc "json".', "md");
  if (choice == null) return;
  const format = normalizeExportFormat(choice);
  if (!format) {
    window.alert(`Định dạng không hợp lệ: ${historyErrorText("unknown_format")}.`);
    return;
  }
  setHistoryStatus("Đang xuất cuộc trò chuyện…");
  historyView.setBusy({ conversationId: entry.conversationId, action: "export" });
  historyView.render();
  try {
    const result = await panel.exportConversation(entry.conversationId, { format });
    if (!result.ok) {
      setHistoryStatus("");
      window.alert(`Không xuất được cuộc trò chuyện: ${historyErrorText(result.reason)}.`);
      return;
    }
    downloadTextArtifact(result);
    setHistoryStatus(`Đã xuất ${result.filename} (${result.messageCount} tin nhắn).`);
  } finally {
    historyView.setBusy(null);
    historyView.render();
  }
}

/** Save a text artifact to the operator's machine. A blob URL plus
 * `<a download>`: no `downloads` permission, no network request. The URL is
 * revoked right after the click so the bytes are not pinned by the object URL
 * registry (mirrors downloadDocument()'s own note). */
function downloadTextArtifact({ filename, mimeType, content }) {
  const blob = new Blob([content], { type: mimeType || "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename || "cuoc-tro-chuyen.md";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function setHistoryStatus(text) {
  if (!el.historyStatus) return;
  el.historyStatus.textContent = text || "";
  el.historyStatus.hidden = !text;
}

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

// tasks.md 1.3's delete-all: the HOST is asked first and the local cache is
// cleared only for a sweep it confirmed. A partial failure leaves the cache
// alone and reports what happened, so "cleared" is never claimed over a
// half-deleted host.
el.btnHistoryClearAll.addEventListener("click", async () => {
  const confirmed = window.confirm(
    "Xóa TẤT CẢ cuộc trò chuyện khỏi máy chủ companion và bản lưu cục bộ? Thao tác này không thể hoàn tác."
  );
  if (!confirmed) return;
  el.btnHistoryClearAll.disabled = true;
  const label = el.btnHistoryClearAll.textContent;
  el.btnHistoryClearAll.textContent = "Đang xóa…";
  try {
    const result = await panel.deleteAllConversations();
    if (!result.ok) {
      const failed = Array.isArray(result.failed) ? result.failed.length : 0;
      const detail = failed ? `còn ${failed} cuộc trò chuyện chưa xóa được` : historyErrorText(result.reason);
      window.alert(`Không xóa được toàn bộ: ${detail}. Danh sách cục bộ được giữ nguyên.`);
    }
  } finally {
    el.btnHistoryClearAll.disabled = false;
    el.btnHistoryClearAll.textContent = label;
    refreshHistoryView();
  }
});

/**
 * Should this cached conversation occupy a row in the history LIST?
 *
 * Only an explicit `false` hides a row — the conversation is then KNOWN to be
 * empty (no stored event on the host, no item in this panel's model for it).
 * `true` and "no opinion" both render: an entry cached before this field
 * existed, or a conversation a summary from an older companion never graded,
 * is unknown, and hiding unknown conversations would hide real history. This
 * is a DISPLAY decision only: the conversation is still in the cache and the
 * host's list, so boot restore, reopen, rename, pin, archive, export and
 * delete/delete-all all keep reachable for it.
 */
function isListableHistoryEntry(entry) {
  return !!entry && entry.hasData !== false;
}

/**
 * Load the list into the view and render it (tasks.md 1.2 + 4.1-4.3).
 *
 * tasks.md 1.2: the host's list is authoritative. Reconcile first (it also
 * marks or drops orphans), then render from the local cache — which now
 * mirrors the host. When the host does not answer, the cached list renders
 * as-is, every row it cannot vouch for is already/soon marked stale, and the
 * view says which of the three reasons it is (offline / protocol too old /
 * no answer) instead of showing an unexplained empty list.
 *
 * The list is filtered to conversations that have data BEFORE it is handed to
 * the view (see `isListableHistoryEntry()`): an empty conversation renders no
 * row, and everything downstream — the rows, the "N/M match the filter"
 * readout, the empty state, the domain options — derives from that one feed,
 * so the screen cannot disagree with itself.
 *
 * `reconcile: false` is for a re-render triggered by a cache change (the
 * onChange subscription, a local delete): the cache is already the freshest
 * thing available, and asking the host again would re-enter this method
 * through the reconcile notification.
 *
 * The render token is claimed BEFORE the awaits: a keystroke or another
 * panel's write can render a newer pass while this one is in flight, and the
 * older pass must then be discarded rather than rolling the screen back.
 */
async function refreshHistoryView({ reconcile = true, token = null } = {}) {
  const renderToken = token == null ? historyView.nextRenderToken() : token;
  let offline = false;
  let error = null;
  if (reconcile) {
    historyView.setState({ loading: true });
    historyView.render({ token: renderToken }); // first open: say "loading" instead of "empty"
    const reconciled = await panel.reconcileHistory().catch(() => null);
    if (!reconciled) ({ offline, error } = describeHistoryHostState());
  } else {
    ({ offline, error } = describeHistoryHostState());
  }
  const conversations = (await historyStore.list()).filter(isListableHistoryEntry);
  historyView.setActiveConversation(panel.currentConversationId);
  historyView.setEntries(conversations);
  historyView.setState({ loading: false, offline, error });
  syncHistoryDomainOptions();
  syncHistoryFilterSummary();
  historyView.render({ token: renderToken });

  // The privacy switch and the retention outcome live on this screen and read
  // the same store: adopt whatever policy is persisted (another panel may
  // have changed it) and show what retention did to the local cache.
  await historyPrivacy.sync();

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

/**
 * Why the host could not answer, in the two shapes the history screen shows
 * differently (tasks.md 4.3): unreachable (`offline` — the connection is not
 * up, cached rows are the local copy) versus a companion that answered and
 * cannot serve history (`error` — an outdated companion, or one that simply
 * did not answer the request in time).
 *
 * `hostHistorySupport()` is tri-state on purpose: "not proven yet" (null) is
 * NOT the same fact as "refused" (false), and only the latter is a reason to
 * tell the operator their companion needs updating.
 */
function describeHistoryHostState() {
  const handshake = panel.protocol.handshakeState();
  if (panel.hostHistorySupport() === false) return { offline: false, error: "host_protocol_unsupported" };
  if (handshake !== "ok") return { offline: true, error: null };
  return { offline: false, error: "host_unavailable" };
}

/**
 * The domain filter's options come from the cache, so a domain the operator
 * has never visited is not offered (an option that can only ever produce "no
 * matches" is a trap, not a filter). The current selection survives a refresh
 * when that domain still exists.
 */
function syncHistoryDomainOptions() {
  if (!el.historyDomain) return;
  const selected = historyView.filters().domain;
  const options = historyView.domainOptions();
  el.historyDomain.textContent = "";
  const all = document.createElement("option");
  all.value = "";
  all.textContent = "Tất cả trang";
  el.historyDomain.appendChild(all);
  for (const option of options) {
    const node = document.createElement("option");
    node.value = option.value;
    node.textContent = option.label;
    el.historyDomain.appendChild(node);
  }
  const stillOffered = options.some((option) => option.value === selected);
  el.historyDomain.value = stillOffered ? selected : "";
  if (selected && !stillOffered) {
    // The filter pointed at a domain that no longer has any conversation
    // (deleted, or evicted): drop it rather than leaving the list silently
    // filtered by something the operator can no longer see in the control.
    historyView.setDomain("");
  }
}

/** How many conversations the current filters hide — the toolbar's own
 * feedback, and the only place "filtered" is visible when rows ARE rendered. */
function syncHistoryFilterSummary() {
  if (!el.historyFilterSummary) return;
  const report = historyView.report();
  if (!historyView.hasActiveFilters()) {
    el.historyFilterSummary.textContent = "";
    return;
  }
  el.historyFilterSummary.textContent = `${report.matched}/${report.total} cuộc trò chuyện khớp bộ lọc.`;
}

// ---- history toolbar (tasks.md 4.1) --------------------------------------
//
// The search box is debounced inside the view (a burst of typing is one
// filter+render pass, and a newer keystroke cancels the pending one); the date
// and domain controls are discrete and apply immediately. Every control is
// wired here with addEventListener — never an inline handler (this panel's CSP
// forbids one).
el.historySearch?.addEventListener("input", () => {
  historyView.setQuery(el.historySearch.value);
});
el.historySearch?.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    historyView.flushQuery();
  }
});
el.historyFrom?.addEventListener("change", () => applyHistoryFilters());
el.historyTo?.addEventListener("change", () => applyHistoryFilters());
el.historyDomain?.addEventListener("change", () => applyHistoryFilters());
el.btnHistoryClearFilters?.addEventListener("click", () => {
  historyView.clearFilters();
  el.historySearch.value = "";
  el.historyFrom.value = "";
  el.historyTo.value = "";
  el.historyDomain.value = "";
  applyHistoryFilters();
});
el.historyScroll?.addEventListener("scroll", () => {
  historyView.onScroll();
});

function applyHistoryFilters() {
  historyView.setDateRange({ from: el.historyFrom ? el.historyFrom.value : null, to: el.historyTo ? el.historyTo.value : null });
  if (el.historyDomain) historyView.setDomain(el.historyDomain.value);
  historyView.render();
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
    // tasks.md 3.3/5.6: a bound-page change ends an in-progress picking
    // session and drops any already-picked element — both would otherwise
    // describe a page the panel is no longer bound to.
    cancelDesignModeIfActive();
    if (pickedElement) clearPickedElement();
  });
  await pageContext.start();
  // scope-conversation-restore-per-tab (design.md "Scope by the tab the panel
  // booted on, captured once"): resolve this panel's restore scope from
  // `pageContext`'s now-settled first query and FREEZE it into `panelScope`
  // — assigned here, exactly once, and never reassigned anywhere else in this
  // file. `pageContext.snapshot().tabId` is the tab this panel document is
  // attached to right now; capturing it into a separate variable rather than
  // reading `pageContext` again later matters because `PageContextTracker` is
  // a FOLLOWING tracker when unpinned (page-context.js: `_onActivated`
  // updates `_current` to whatever tab becomes active in the window) — a
  // later `pageContext.snapshot().tabId` read would silently drift onto
  // whatever tab the operator is glancing at, corrupting a scope this panel
  // document does not belong to (design.md's rejected "read the scope from
  // PageContextTracker on each access" alternative). A restricted/blank page
  // where the tracker resolves no usable tab (`snapshot()` returns `null`)
  // leaves `panelScope` at `null` — "no identifiable scope" — and
  // `restoreOrStartConversation()` below already starts a fresh conversation
  // for that case rather than restoring one (spec "No identifiable scope").
  const scopeSnapshot = pageContext.snapshot();
  panelScope = scopeSnapshot && scopeSnapshot.tabId != null ? scopeSnapshot.tabId : null;
  // tasks.md 2.3: a remembered last-active conversation is only meaningful
  // while its TAB exists (see history-store.js's LAST_ACTIVE_KEY_PREFIX
  // comment), and these keys live in session storage — without this sweep a
  // key would survive every tab that ever hosted a panel for the rest of the
  // browser session. Two halves: drop what is already stale now (covering
  // tabs closed while no panel was open), and drop a key the moment its own
  // tab goes away.
  await pruneStaleLastActiveKeys();
  if (typeof chrome !== "undefined" && chrome.tabs && chrome.tabs.onRemoved) {
    chrome.tabs.onRemoved.addListener((tabId) => {
      historyStore.forgetLastActive(String(tabId)).catch(() => {});
    });
  }
  loadPickerCatalog(); // fire-and-forget: first "/" press already has this resolved (or the picker's own empty state covers the not-yet-loaded gap)
  await panel.init();
  // Resumes the conversation the operator was last looking at IN THIS TAB
  // (persisted via history-store.js's scoped `setLastActive()`, updated by
  // every one of panel-controller.js's active-conversation transitions
  // through its `_setCurrentConversationId()` setter under `panelScope`
  // above), falling back to a new conversation when there is nothing
  // restorable for this scope — see restoreOrStartConversation()'s own
  // header comment for the full restorable/fallback contract. Replaces the
  // old unconditional `if (!panel.currentConversationId) startNewConversation()`
  // check, which is what discarded the operator's place on every panel
  // reopen; scoping it per tab is what stops a second tab's panel from
  // adopting the first tab's conversation instead of starting its own.
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
