// Thin DOM binding layer over settings-controller.js. Deliberately kept
// small and declarative — all decision-making lives in the controller (unit
// tested in test/settings-ui-*.test.mjs); this file only renders a state
// snapshot into the DOM and forwards user events to controller methods.
// Visual correctness of what this file renders is verified by real captured
// screenshots (see reports/04-settings-ui-evidence.md), the same protocol
// reports/05-visual-system.md already established for this product's other
// screens — not by a DOM-diffing unit test.
import { iconMarkup } from "../ui/icons.js";
import { setThemeOverride } from "../ui/theme.js";
import { createSettingsClient } from "./settings-client.js";
import { SettingsController } from "./settings-controller.js";
import { describeErrorCode } from "./errors-ui.js";
import { connectionGate, connectionBlockedTitle } from "./connection-gate.js";

const $ = (id) => document.getElementById(id);

const client = createSettingsClient();
const controller = new SettingsController(client, { onChange: render });

// Exposed ONLY for this task's own visual-QA screenshot capture (driving the
// page through every required state without a live companion — see the
// "Environment constraint" in this task's brief) and for manual debugging.
// Carries no secret: getState() never includes a raw key (see
// settings-controller.js file header).
window.__settingsDebug = { controller, client };

// Static icon injection for markup that never re-renders (moved out of
// settings.html's former inline <script type="module"> block — MV3's
// default script-src forbids inline scripts on extension pages, so this
// must live in an externally-loaded module; see extension/sidepanel/
// sidepanel.js for the same pattern). Exact icon names/sizes/titles are
// unchanged from the removed inline block.
$("ic-theme-trigger").innerHTML = iconMarkup("monitor", { size: 18, title: "Chọn giao diện" });
$("ic-monitor").innerHTML = iconMarkup("monitor", { size: 16 });
$("ic-sun").innerHTML = iconMarkup("sun", { size: 16 });
$("ic-moon").innerHTML = iconMarkup("moon", { size: 16 });
$("ic-plus").innerHTML = iconMarkup("plus", { size: 15 });
$("ic-refresh").innerHTML = iconMarkup("refresh", { size: 15 });
$("ic-mic").innerHTML = iconMarkup("mic", { size: 18 });
$("ic-chevr").innerHTML = iconMarkup("chevronRight", { size: 16 });
$("ic-skills").innerHTML = iconMarkup("skills", { size: 18 });
$("ic-chevr-skills").innerHTML = iconMarkup("chevronRight", { size: 16 });
$("ic-permissions").innerHTML = iconMarkup("lock", { size: 18 });
$("ic-chevr-permissions").innerHTML = iconMarkup("chevronRight", { size: 16 });

// ChatGPT sign-in copy per phase (add-chatgpt-subscription-provider tasks.md
// 5.3) — kept as one small lookup so the aria-live status paragraph and any
// other place needing "what's happening right now" text stay in sync.
const CHATGPT_PHASE_STATUS_VI = {
  starting_browser: "Đang mở trang đăng nhập ChatGPT…",
  pending_browser: "Đang chờ bạn hoàn tất đăng nhập trong tab trình duyệt vừa mở…",
  starting_device: "Đang lấy mã đăng nhập…",
  pending_device: "Nhập mã bên dưới tại trang xác minh để hoàn tất đăng nhập.",
  cancelling: "Đang hủy đăng nhập…"
};

// Tracks the device code last shown, so focus is moved to it only the
// MOMENT it newly appears (tasks.md 5.5's accessibility requirement) —
// never on every re-render while it's already visible and already focused
// once, which would otherwise steal focus back from whatever the user is
// doing next (e.g. tabbing to the copy button).
let lastDeviceCodeShown = null;
let chatgptCountdownTimer = null;

function formatCountdown(expiresAt) {
  const msLeft = expiresAt - Date.now();
  if (msLeft <= 0) return "Mã đã hết hạn — bấm \"Dùng mã thay thế\" để lấy mã mới.";
  const totalSeconds = Math.floor(msLeft / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `Mã hết hạn sau ${minutes}:${String(seconds).padStart(2, "0")}`;
}

function stopChatgptCountdown() {
  if (chatgptCountdownTimer !== null) {
    clearInterval(chatgptCountdownTimer);
    chatgptCountdownTimer = null;
  }
}

/** Ticks the visible device-code expiry text once a second — a purely local
 * UI countdown, never a network call (the actual pending/expired outcome
 * still comes only from controller.js's own status poll). */
function startChatgptCountdown(expiresAt) {
  stopChatgptCountdown();
  const tick = () => {
    const el = $("chatgpt-code-expiry");
    if (el) el.textContent = formatCountdown(expiresAt);
  };
  tick();
  chatgptCountdownTimer = setInterval(tick, 1000);
}

function renderChatgptFields(state) {
  const signIn = state.signIn;
  const phase = signIn.phase;
  const isPending = phase === "pending_browser" || phase === "pending_device" || phase === "cancelling";
  const isStarting = phase === "starting_browser" || phase === "starting_device";

  $("chatgpt-status-live").textContent = CHATGPT_PHASE_STATUS_VI[phase] || "";

  const showSignedOut = phase === "idle" && state.chatgptSessionState !== "signed_in" && state.chatgptSessionState !== "session_expired";
  const showPending = isPending || isStarting;
  const showSignedIn = phase === "idle" && state.chatgptSessionState === "signed_in";
  const showExpired = phase === "idle" && state.chatgptSessionState === "session_expired";

  $("chatgpt-signed-out-actions").hidden = !showSignedOut;
  $("chatgpt-pending-actions").hidden = !showPending;
  $("chatgpt-signed-in-info").hidden = !showSignedIn;
  $("chatgpt-session-expired-actions").hidden = !showExpired;

  $("btn-chatgpt-signin-browser").disabled = isStarting;
  $("btn-chatgpt-use-code").disabled = isStarting;
  $("btn-chatgpt-signin-browser").textContent = phase === "starting_browser" ? "Đang mở…" : "Đăng nhập với ChatGPT";
  $("btn-chatgpt-use-code").textContent = phase === "starting_device" ? "Đang lấy mã…" : "Dùng mã thay thế";
  $("btn-chatgpt-cancel-signin").disabled = phase === "cancelling";
  // Both explicit sign-out controls — the signed-in surface's and the
  // session-expired surface's — share this one update, so neither state can
  // drift from the other (a profile whose session expired still has a bound
  // account the operator may want to disown; see settings.html's note).
  for (const id of ["btn-chatgpt-signout", "btn-chatgpt-signout-expired"]) {
    const btn = $(id);
    btn.disabled = state.signingOut;
    btn.textContent = state.signingOut ? "Đang đăng xuất…" : "Đăng xuất";
  }

  const deviceCodeBox = $("chatgpt-device-code-box");
  const showDeviceCode = phase === "pending_device" && Boolean(signIn.userCode);
  deviceCodeBox.hidden = !showDeviceCode;
  if (showDeviceCode) {
    $("chatgpt-device-code").value = signIn.userCode;
    $("chatgpt-verification-link").href = signIn.verificationUrl || "#";
    startChatgptCountdown(signIn.expiresAt);
    // Accessibility (tasks.md 5.5): move focus to the device code the MOMENT
    // it newly appears, never on a re-render where it was already showing.
    if (lastDeviceCodeShown !== signIn.signInId) {
      lastDeviceCodeShown = signIn.signInId;
      $("chatgpt-device-code").focus();
    }
  } else {
    stopChatgptCountdown();
    if (phase !== "pending_device") lastDeviceCodeShown = null;
  }

  if (showSignedIn && state.chatgptAccount) {
    // A memory-only sign-in (the offer accepted after SECURE_STORAGE_UNAVAILABLE)
    // looks identical to a persisted one otherwise, so it is named here —
    // the user must know the sign-in will not survive a companion restart.
    const memoryOnlySuffix = state.memoryOnlyCredential ? " · chỉ trong bộ nhớ" : "";
    $("chatgpt-account-line").textContent = `Đã đăng nhập với ${state.chatgptAccount.email} (gói ${state.chatgptAccount.planType}${memoryOnlySuffix}).`;
  } else {
    $("chatgpt-account-line").textContent = "";
  }

  // The usage block exists only for a signed-in profile (spec: "no usage block
  // content ... and no usage read" otherwise), so it is gated by the same
  // state that shows the account line above.
  renderChatgptUsage(state, showSignedIn);
}

// --- ChatGPT usage block (add-chatgpt-usage-check design.md decision 6,
// tasks.md 4.2) -----------------------------------------------------------
//
// Renders the controller's display-only `usage` state: the plan, one line per
// rate-limit window the account actually has (percent used + a countdown to
// the absolute reset moment the controller computed), a credits line only for
// an account that has credits, the limit-reached line, and the loading/error
// text (error copy comes from errors-ui.js by code — a companion that
// predates the op reads as "update the companion", never as a network
// failure). One setInterval drives every countdown in the block and is
// cleared the moment the block is hidden: no network polling, and no timer
// left ticking behind a hidden block.
let chatgptUsageTimer = null;

function stopChatgptUsageCountdown() {
  if (chatgptUsageTimer !== null) {
    clearInterval(chatgptUsageTimer);
    chatgptUsageTimer = null;
  }
}

/** A whole-label Vietnamese duration for a remaining span: seconds under a
 * minute (so the countdown visibly ticks as a reset approaches), then
 * minutes, hours, days, or weeks when it lands exactly on them. */
function formatUsageDuration(msLeft) {
  if (msLeft < 60000) return `${Math.max(1, Math.ceil(msLeft / 1000))} giây`;
  const minutes = Math.ceil(msLeft / 60000);
  if (minutes < 60) return `${minutes} phút`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const remMinutes = minutes % 60;
    return remMinutes ? `${hours} giờ ${remMinutes} phút` : `${hours} giờ`;
  }
  const days = Math.floor(hours / 24);
  if (days < 7) {
    const remHours = hours % 24;
    return remHours ? `${days} ngày ${remHours} giờ` : `${days} ngày`;
  }
  const weeks = Math.floor(days / 7);
  const remDays = days % 7;
  return remDays ? `${weeks} tuần ${remDays} ngày` : `${weeks} tuần`;
}

/** The whole reset clause, so a moment that has already passed reads as a
 * statement rather than as a broken "in -3 minutes" countdown. */
function usageResetText(msLeft) {
  return msLeft > 0 ? `đặt lại sau ${formatUsageDuration(msLeft)}` : "đã đến hạn đặt lại";
}

/** A window's own label, derived from its length — never from the plan. The
 * plural is explicit because these are Vietnamese noun phrases, not a
 * localized (plural-ruled) message catalogue. */
function usageWindowLabel(limitWindowSeconds) {
  if (typeof limitWindowSeconds !== "number" || limitWindowSeconds <= 0) return "Cửa sổ sử dụng";
  if (limitWindowSeconds % 604800 === 0) {
    const weeks = limitWindowSeconds / 604800;
    return weeks === 1 ? "Cửa sổ 1 tuần" : `Cửa sổ ${weeks} tuần`;
  }
  if (limitWindowSeconds % 86400 === 0) return `Cửa sổ ${limitWindowSeconds / 86400} ngày`;
  if (limitWindowSeconds % 3600 === 0) return `Cửa sổ ${limitWindowSeconds / 3600} giờ`;
  return `Cửa sổ ${Math.round(limitWindowSeconds / 60)} phút`;
}

function renderChatgptUsage(state, visible) {
  const block = $("chatgpt-usage-block");
  block.hidden = !visible;

  const planEl = $("chatgpt-usage-plan");
  const liveEl = $("chatgpt-usage-live");
  const windowsBox = $("chatgpt-usage-windows");
  const creditsEl = $("chatgpt-usage-credits");
  const limitEl = $("chatgpt-usage-limit");
  const refreshBtn = $("btn-chatgpt-refresh-usage");

  planEl.textContent = "";
  liveEl.textContent = "";
  windowsBox.innerHTML = "";
  creditsEl.textContent = "";
  creditsEl.hidden = true;
  limitEl.textContent = "";
  limitEl.hidden = true;

  if (!visible) {
    // Nothing in this block is visible: no countdown should keep ticking.
    stopChatgptUsageCountdown();
    return;
  }

  const usageState = state.usage || { status: "idle" };
  const isLoading = usageState.status === "loading";
  refreshBtn.disabled = isLoading;
  refreshBtn.textContent = isLoading ? "Đang đọc…" : "Làm mới";

  if (isLoading) {
    // The one line a screen reader hears while a read is running; the refresh
    // action above is disabled for exactly that span.
    liveEl.textContent = "Đang đọc mức sử dụng của tài khoản ChatGPT…";
    stopChatgptUsageCountdown();
    return;
  }

  if (usageState.status === "error" && usageState.error) {
    const copy = describeErrorCode(usageState.error.code, { op: "chatgpt_usage" });
    liveEl.textContent = [copy.title, copy.message, copy.action].filter(Boolean).join(" ");
    stopChatgptUsageCountdown();
    return;
  }

  if (usageState.status !== "ready" || !usageState.usage) {
    stopChatgptUsageCountdown();
    return;
  }

  const usage = usageState.usage;
  if (usage.planType) planEl.textContent = `Gói: ${usage.planType}`;

  let hasCountdown = false;
  for (const window of [usage.primary, usage.secondary]) {
    if (!window) continue;
    const row = document.createElement("p");
    row.className = "field-hint chatgpt-usage-window";
    const label = document.createElement("span");
    label.className = "chatgpt-usage-window-label";
    label.textContent = usageWindowLabel(window.limitWindowSeconds);
    row.appendChild(label);
    const percent = typeof window.usedPercent === "number" ? `${Math.round(window.usedPercent * 10) / 10}%` : "không rõ";
    row.appendChild(document.createTextNode(` — đã dùng ${percent}`));
    if (typeof window.resetAtMs === "number") {
      const resetEl = document.createElement("span");
      resetEl.className = "chatgpt-usage-reset";
      resetEl.dataset.resetAt = String(window.resetAtMs);
      resetEl.textContent = ` · ${usageResetText(window.resetAtMs - Date.now())}`;
      row.appendChild(resetEl);
      hasCountdown = true;
    }
    windowsBox.appendChild(row);
  }

  const credits = usage.credits;
  if (credits && credits.hasCredits) {
    const balance = credits.unlimited
      ? "không giới hạn"
      : credits.balance === null || credits.balance === undefined
        ? "không rõ số dư"
        : String(credits.balance);
    creditsEl.textContent = `Credits: ${balance}.`;
    creditsEl.hidden = false;
  }

  if (usage.limitReached) {
    limitEl.textContent = "Tài khoản đã đạt giới hạn sử dụng — mốc đặt lại ở trên cho biết khi nào dùng lại được.";
    limitEl.hidden = false;
  } else if (usage.allowed === false) {
    limitEl.textContent = "Tài khoản hiện không thể gửi yêu cầu.";
    limitEl.hidden = false;
  }

  if (hasCountdown) {
    tickChatgptUsageCountdown();
    startChatgptUsageCountdown();
  } else {
    stopChatgptUsageCountdown();
  }
}

function tickChatgptUsageCountdown() {
  for (const el of document.querySelectorAll("#chatgpt-usage-windows .chatgpt-usage-reset[data-reset-at]")) {
    el.textContent = ` · ${usageResetText(Number(el.dataset.resetAt) - Date.now())}`;
  }
}

/** Idempotent: re-renders reuse the one running interval rather than stacking
 * a second one on top of it. */
function startChatgptUsageCountdown() {
  if (chatgptUsageTimer !== null) return;
  chatgptUsageTimer = setInterval(tickChatgptUsageCountdown, 1000);
}

/** Called when the page becomes visible again — a no-op unless the block is
 * actually showing a countdown, so a hidden page can never resurrect one. */
function resumeChatgptUsageCountdown() {
  const block = $("chatgpt-usage-block");
  if (!block || block.hidden) return;
  if (!document.querySelector("#chatgpt-usage-windows [data-reset-at]")) return;
  tickChatgptUsageCountdown();
  startChatgptUsageCountdown();
}

function iconEl(name, opts) {
  const span = document.createElement("span");
  span.className = "ui-icon";
  span.innerHTML = iconMarkup(name, opts);
  return span;
}

function renderBanner(state) {
  const area = $("banner-area");
  area.innerHTML = "";
  if (state.isFirstRun && !state.banner) {
    const box = document.createElement("div");
    box.className = "card settings-banner settings-banner-info";
    box.setAttribute("role", "status");
    box.innerHTML =
      '<p class="card-title">Kết nối một nhà cung cấp tương thích Anthropic</p>' +
      '<p class="card-body">Nhập Base URL, API key và ít nhất một mô hình để bắt đầu. ' +
      "Không cần tài khoản Claude hay đăng nhập. Chi phí sử dụng phụ thuộc vào nhà cung cấp bạn cấu hình " +
      "— không có suy luận miễn phí và không phải mọi gateway đều tương thích.</p>";
    area.appendChild(box);
  }
  if (!state.banner) return;
  const box = document.createElement("div");
  const kindClass = state.banner.kind === "error" ? "is-failed" : state.banner.kind === "success" ? "is-succeeded" : "is-unknown";
  box.className = `card settings-banner`;
  box.setAttribute("role", state.banner.kind === "error" ? "alert" : "status");
  const pill = document.createElement("span");
  pill.className = `status-pill ${kindClass}`;
  pill.appendChild(iconEl(state.banner.kind === "error" ? "alertTriangle" : state.banner.kind === "success" ? "checkCircle" : "info", { size: 14 }));
  const pillText = document.createElement("span");
  pillText.textContent = state.banner.title || "";
  pill.appendChild(pillText);
  box.appendChild(pill);
  if (state.banner.message) {
    const p = document.createElement("p");
    p.className = "card-body";
    p.textContent = state.banner.message;
    box.appendChild(p);
  }
  if (state.banner.action) {
    const p = document.createElement("p");
    p.className = "field-hint";
    p.textContent = state.banner.action;
    box.appendChild(p);
  }
  if (state.pendingMemoryOnlyOffer) {
    // Two different memory-only confirmations share this offer block, told
    // apart by `state.memoryOnlyOfferKind`: retrying an API-key save
    // (anthropic) or re-running a ChatGPT sign-in that could not persist its
    // credential (specs/agent-settings "Secret isolation": "a clearly labeled
    // memory-only mode SHALL be offered"). The label names which one.
    const isSignInOffer = state.memoryOnlyOfferKind === "sign_in";
    const actions = document.createElement("div");
    actions.className = "field-row-actions";
    const confirmBtn = document.createElement("button");
    confirmBtn.className = "btn btn-secondary btn-sm";
    confirmBtn.type = "button";
    confirmBtn.textContent = isSignInOffer ? "Đăng nhập chỉ trong bộ nhớ" : "Lưu chỉ trong bộ nhớ";
    confirmBtn.addEventListener("click", async () => {
      const result = isSignInOffer ? await controller.confirmMemoryOnlySignIn() : await controller.confirmMemoryOnlyCredential();
      // A browser sign-in retry is a NEW authorization URL that must be
      // opened, exactly like the ordinary sign-in button above.
      if (isSignInOffer && result && result.ok && result.authUrl) openInNewTab(result.authUrl);
    });
    const cancelBtn = document.createElement("button");
    cancelBtn.className = "btn btn-ghost btn-sm";
    cancelBtn.type = "button";
    cancelBtn.textContent = "Hủy";
    cancelBtn.addEventListener("click", () => controller.cancelMemoryOnlyOffer());
    actions.append(confirmBtn, cancelBtn);
    box.appendChild(actions);
  }
  area.appendChild(box);
}

/** Paints the reason a blocked test control is blocked, on both test
 * controls at once (connection-gate.js owns the reasoning; this only applies
 * it). Called from renderProvider — the later of the two renderers that own a
 * test button — so one gate value drives both controls' explanation and the
 * two can never describe the page differently.
 *
 * A disabled control must never be silent: the short reason travels on the
 * control itself (`title`), and when the gate carries a hint — the two
 * reasons whose fix is in the "Mô hình" section — the full line with its jump
 * link is shown under the connection row and both controls describe
 * themselves by it (`aria-describedby`). The hint is emptied, not merely
 * hidden, so a stale explanation can never be announced by a screen reader
 * while the control is enabled. */
function renderTestGateFeedback(gate) {
  const hintEl = $("test-gate-hint");
  hintEl.innerHTML = "";
  hintEl.hidden = !gate.hint;
  if (gate.hint) {
    hintEl.appendChild(document.createTextNode(`${gate.hint} `));
    if (gate.jumpToModels) {
      const jump = document.createElement("a");
      jump.className = "settings-chip";
      jump.href = "#section-models";
      jump.textContent = "Tới mục “Mô hình”";
      hintEl.appendChild(jump);
    }
  }

  const title = gate.canTest ? null : connectionBlockedTitle(gate.reason);
  for (const id of ["btn-status-retest", "btn-test-connection"]) {
    const btn = $(id);
    if (title) btn.title = title;
    else btn.removeAttribute("title");
    if (gate.hint) btn.setAttribute("aria-describedby", "test-gate-hint");
    else btn.removeAttribute("aria-describedby");
  }
}

// design.md decision D8: reads only existing controller state
// (connectionStatus/hasCredential/defaultModelId) and never initiates a
// connection test on load — testing costs API usage and stays an explicit
// user action.
function renderStatusCard(state, gate) {
  const icon = $("status-card-icon");
  const title = $("status-card-title");
  const sub = $("status-card-sub");
  icon.className = "status-card-icon";

  let iconName = "helpCircle";
  let toneClass = "is-warn";
  let titleText = "Chưa cấu hình";
  let subText = "Nhập Base URL, API key và ít nhất một mô hình ở mục Nhà cung cấp bên dưới.";

  if (state.connectionStatus && state.connectionStatus.status === "testing") {
    iconName = "clock";
    toneClass = "is-warn";
    titleText = "Đang kiểm tra kết nối…";
    subText = "Đang gửi một yêu cầu nhỏ tới nhà cung cấp.";
  } else if (state.connectionStatus && state.connectionStatus.status === "pass") {
    iconName = "checkCircle";
    toneClass = "is-ok";
    titleText = state.connectionStatus.textOnly ? "Sẵn sàng (chỉ văn bản)" : "Sẵn sàng chạy";
    subText = "API key đã lưu trong kho bảo mật hệ điều hành · đã kiểm tra kết nối thành công.";
  } else if (state.connectionStatus && state.connectionStatus.status === "fail") {
    iconName = "xCircle";
    toneClass = "is-fail";
    titleText = "Kiểm tra kết nối thất bại";
    subText = "Xem chi tiết lỗi ở mục Nhà cung cấp bên dưới.";
  } else if (state.hasCredential) {
    iconName = "helpCircle";
    toneClass = "is-warn";
    titleText = "Đã lưu API key — chưa kiểm tra";
    subText = "Bấm Kiểm tra lại để xác nhận kết nối trước khi trò chuyện.";
  }

  icon.classList.add(toneClass);
  icon.innerHTML = iconMarkup(iconName, { size: 20 });
  title.textContent = titleText;
  sub.textContent = subText;

  const retestBtn = $("btn-status-retest");
  retestBtn.disabled = !gate.canTest;
  retestBtn.textContent = state.testing ? "Đang kiểm tra…" : "Kiểm tra lại";
}

// design.md decision D6: marks the chip nearest the top of the viewport as
// aria-current, without hijacking normal anchor activation/keyboard focus.
// IntersectionObserver over the section headings — never a scroll handler
// calling preventDefault() on a chip click.
function wireChipNav() {
  const chips = [...document.querySelectorAll(".settings-chip")];
  const sections = chips
    .map((chip) => document.getElementById(chip.dataset.section))
    .filter(Boolean);
  if (!sections.length || typeof IntersectionObserver !== "function") return;

  const setCurrent = (id) => {
    for (const chip of chips) {
      if (chip.dataset.section === id) chip.setAttribute("aria-current", "true");
      else chip.removeAttribute("aria-current");
    }
  };

  // Activating a chip marks it immediately. Waiting for the scroll to settle
  // and letting the observer notice would leave the chip the user just
  // pressed unmarked for the length of the jump — and if the target section
  // is the last one, short enough that its heading never wins the scroll
  // calculation, it would never mark at all. The click is the user stating
  // where they are; that is not something to re-derive from scroll position.
  // The anchor's own navigation is untouched — no preventDefault.
  let lockUntil = 0;
  for (const chip of chips) {
    chip.addEventListener("click", () => {
      setCurrent(chip.dataset.section);
      // The jump is asynchronous; without this the observer would fire
      // mid-flight and overwrite the choice with whatever is passing by.
      lockUntil = Date.now() + 700;
    });
  }

  if (typeof IntersectionObserver !== "function") return;

  // root MUST be the viewport (null), not `.panel-scroll`. `.panel-shell` is
  // min-height:100vh and grows with its content, so `.panel-scroll` never
  // actually scrolls or clips — the document does. Rooting the observer at a
  // non-scrolling element made every section report ratio 1 forever, so the
  // first chip won every comparison and the marker never moved off it.
  const visible = new Set();
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) visible.add(entry.target.id);
        else visible.delete(entry.target.id);
      }
      if (Date.now() < lockUntil) return;
      // The band is the top slice of the viewport below the sticky nav; the
      // LAST section to have entered it is the one being read.
      for (let i = sections.length - 1; i >= 0; i -= 1) {
        if (visible.has(sections[i].id)) {
          setCurrent(sections[i].id);
          return;
        }
      }
    },
    { root: null, rootMargin: "-64px 0px -55% 0px", threshold: 0 }
  );
  for (const section of sections) observer.observe(section);
  setCurrent(sections[0].id);
}

function renderProvider(state, gate) {
  $("provider-type-anthropic").checked = state.providerType === "anthropic";
  $("provider-type-chatgpt").checked = state.providerType === "chatgpt";
  $("provider-type-anthropic").disabled = state.switchingProviderType;
  $("provider-type-chatgpt").disabled = state.switchingProviderType;

  const isChatgpt = state.providerType === "chatgpt";
  $("anthropic-baseurl-item").hidden = isChatgpt;
  $("anthropic-key-item").hidden = isChatgpt;
  $("chatgpt-fields").hidden = !isChatgpt;
  $("test-disclosure-anthropic").hidden = isChatgpt;
  $("test-disclosure-chatgpt").hidden = !isChatgpt;
  // The saved-credential status line/remove-key button only mean something
  // for the API-key half of the page; the ChatGPT half has its own signed-
  // in/signed-out affordances below (see the final `$("key-status-text")`/
  // `$("btn-remove-key")` block further down, which also checks `isChatgpt`).
  $("key-status-text").hidden = isChatgpt;

  if (isChatgpt) {
    renderChatgptFields(state);
  } else {
    // Neither countdown may keep ticking behind a hidden ChatGPT section, and
    // the usage block is emptied rather than merely covered — leaving a
    // previous profile's windows in the DOM would let the page's own
    // visibilitychange resume a countdown for values that are no longer
    // displayed (renderChatgptUsage(state, false) stops the interval too).
    stopChatgptCountdown();
    renderChatgptUsage(state, false);
  }

  const urlInput = $("base-url");
  if (document.activeElement !== urlInput) urlInput.value = state.baseUrlDraft;
  urlInput.setAttribute("aria-invalid", state.fieldErrors.baseUrl ? "true" : "false");
  $("base-url-error").textContent = state.fieldErrors.baseUrl || "";
  $("base-url-error").hidden = !state.fieldErrors.baseUrl;

  const keyStatus = $("key-status-text");
  keyStatus.textContent = state.hasCredential
    ? `Đã lưu API key${state.memoryOnlyCredential ? " (chỉ trong bộ nhớ)" : ""}`
    : "Chưa lưu API key";
  $("btn-remove-key").hidden = isChatgpt || !state.hasCredential;
  $("btn-remove-key").disabled = state.removingCredential;

  // NOTE: the key <input> is deliberately left UNCONTROLLED — its value is
  // never read from or written back to controller state (see
  // settings-controller.js's file header on why). This render function never
  // touches its .value; only the Save handler below reads it (once, at
  // submit time) and only the Save handler ever clears it.

  const connState = $("connection-state");
  connState.className = "connection-state";
  let label = "Chưa kiểm tra kết nối";
  if (state.connectionStatus) {
    if (state.connectionStatus.status === "testing") {
      connState.classList.add("is-connecting");
      label = "Đang kiểm tra kết nối…";
    } else if (state.connectionStatus.status === "pass") {
      connState.classList.add("is-ready");
      label = state.connectionStatus.textOnly ? "Chỉ hỗ trợ văn bản" : "Đã kiểm tra kết nối";
    } else {
      connState.classList.add("is-error");
      label = "Kiểm tra kết nối thất bại";
    }
  }
  connState.innerHTML = `<span class="connection-dot"></span> ${label}`;

  const capsBox = $("capability-detail");
  capsBox.innerHTML = "";
  if (state.connectionStatus && state.connectionStatus.capabilities) {
    for (const key of ["text", "tool", "vision"]) {
      const value = state.connectionStatus.capabilities[key];
      if (!value || value === "not_run") continue;
      const pill = document.createElement("span");
      pill.className = `status-pill ${value === "pass" ? "is-succeeded" : "is-failed"}`;
      pill.textContent = `${key}: ${value}`;
      capsBox.appendChild(pill);
    }
  }

  $("btn-save").disabled = state.saving;
  $("btn-save").textContent = state.saving ? "Đang lưu…" : "Lưu";
  // Both test controls read the one gate (never a second copy of the
  // predicate — see connection-gate.js), and the last renderer paints its
  // explanation once, after both buttons exist.
  $("btn-test-connection").disabled = !gate.canTest;
  $("btn-test-connection").textContent = state.testing ? "Đang kiểm tra…" : "Kiểm tra kết nối";
  renderTestGateFeedback(gate);
}

function renderModels(state) {
  const list = $("model-list");
  list.innerHTML = "";
  state.models.forEach((model, index) => {
    const row = document.createElement("div");
    row.className = "field-group-item";
    const flex = document.createElement("div");
    flex.className = "field-row model-radio-row";

    // design.md decision D7: the "· Đặt mặc định" ghost-button affordance
    // becomes one native radio per model in a radiogroup — the platform's
    // own control for "exactly one of these", with keyboard semantics for
    // free. A visible "Mặc định" badge rides alongside so the state has a
    // carrier besides the radio's own checked appearance.
    const radioId = `model-default-${index}`;
    const radio = document.createElement("input");
    radio.type = "radio";
    radio.name = "default-model";
    radio.id = radioId;
    radio.checked = model.id === state.defaultModelId;
    radio.setAttribute("aria-label", `Đặt "${model.label || model.id}" làm mô hình mặc định`);
    radio.addEventListener("change", () => {
      if (radio.checked) controller.setDefaultModel(model.id);
    });

    const info = document.createElement("label");
    info.className = "model-row-info";
    info.setAttribute("for", radioId);
    // The human name leads; the provider's exact model ID sits under it in
    // mono. The ID is the thing that must be transcribable character for
    // character, and a proportional face makes l/1/I and 0/O ambiguous.
    // When no display name was given, `label` falls back to the ID upstream,
    // so the row degrades to the ID alone rather than repeating it twice.
    const title = document.createElement("div");
    title.className = "list-item-title";
    title.textContent = model.label || model.id;
    const sub = document.createElement("div");
    sub.className = "list-item-sub model-row-id";
    sub.textContent = model.label && model.label !== model.id ? model.id : "";
    info.append(title, sub);

    const actions = document.createElement("div");
    actions.className = "field-row-actions";

    if (model.id === state.defaultModelId) {
      const badge = document.createElement("span");
      badge.className = "model-default-badge";
      badge.textContent = "Mặc định";
      actions.appendChild(badge);
    }

    if (index > 0) {
      const upBtn = document.createElement("button");
      upBtn.className = "btn-icon";
      upBtn.type = "button";
      upBtn.setAttribute("aria-label", "Di chuyển lên");
      upBtn.appendChild(iconEl("chevronRight", { size: 16 }));
      upBtn.firstChild.style.transform = "rotate(-90deg)";
      upBtn.addEventListener("click", () => controller.reorderModel(index, index - 1));
      actions.appendChild(upBtn);
    }
    if (index < state.models.length - 1) {
      const downBtn = document.createElement("button");
      downBtn.className = "btn-icon";
      downBtn.type = "button";
      downBtn.setAttribute("aria-label", "Di chuyển xuống");
      downBtn.appendChild(iconEl("chevronRight", { size: 16 }));
      downBtn.firstChild.style.transform = "rotate(90deg)";
      downBtn.addEventListener("click", () => controller.reorderModel(index, index + 1));
      actions.appendChild(downBtn);
    }
    const removeBtn = document.createElement("button");
    removeBtn.className = "btn-icon";
    removeBtn.type = "button";
    removeBtn.setAttribute("aria-label", "Xóa mô hình");
    removeBtn.appendChild(iconEl("trash", { size: 16 }));
    removeBtn.addEventListener("click", () => controller.removeModel(index));
    actions.appendChild(removeBtn);

    flex.append(radio, info, actions);
    row.appendChild(flex);
    list.appendChild(row);
  });

  $("model-list-error").textContent = state.fieldErrors.models || "";
  $("model-list-error").hidden = !state.fieldErrors.models;
  $("btn-discover-models").disabled = state.discovering || !state.hasCredential;
  $("btn-discover-models").textContent = state.discovering ? "Đang tìm…" : "Tìm mô hình";
}

function render(state) {
  // One gate per render pass, shared by both renderers that own a test
  // control — the page has exactly one answer to "can a test run right now".
  const gate = connectionGate(state);
  renderBanner(state);
  renderStatusCard(state, gate);
  renderProvider(state, gate);
  renderModels(state);
}

/** Opens `url` in a new tab via `chrome.tabs.create` (tasks.md 5.3); falls
 * back to `window.open` only when `chrome.tabs` is unavailable (e.g. this
 * page loaded outside the extension, such as a visual-QA capture). */
function openInNewTab(url) {
  if (!url) return;
  if (typeof chrome !== "undefined" && chrome.tabs && typeof chrome.tabs.create === "function") {
    chrome.tabs.create({ url });
  } else {
    window.open(url, "_blank", "noopener");
  }
}

function wireEvents() {
  $("provider-type-anthropic").addEventListener("change", () => {
    if ($("provider-type-anthropic").checked) controller.setProviderType("anthropic");
  });
  $("provider-type-chatgpt").addEventListener("change", () => {
    if ($("provider-type-chatgpt").checked) controller.setProviderType("chatgpt");
  });

  $("btn-chatgpt-signin-browser").addEventListener("click", async () => {
    const result = await controller.startBrowserSignIn();
    if (result.ok) openInNewTab(result.authUrl);
  });
  $("btn-chatgpt-signin-again").addEventListener("click", async () => {
    const result = await controller.startBrowserSignIn();
    if (result.ok) openInNewTab(result.authUrl);
  });
  $("btn-chatgpt-use-code").addEventListener("click", () => controller.startDeviceSignIn());
  $("btn-chatgpt-cancel-signin").addEventListener("click", () => controller.cancelSignIn());
  // One handler for both sign-out controls (signed-in and session-expired):
  // the same confirmation, the same host call — never two divergent paths.
  const confirmThenSignOut = async () => {
    if (!confirm("Đăng xuất khỏi ChatGPT? Các phiên đang chạy dùng tài khoản này sẽ bị hủy.")) return;
    await controller.signOut();
  };
  $("btn-chatgpt-signout").addEventListener("click", confirmThenSignOut);
  $("btn-chatgpt-signout-expired").addEventListener("click", confirmThenSignOut);
  $("btn-chatgpt-copy-code").addEventListener("click", async () => {
    const code = $("chatgpt-device-code").value;
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
    } catch {
      // Clipboard permission denied/unavailable — the code is still visible
      // and selectable in the (readonly) input itself, so this is degraded,
      // not broken.
      $("chatgpt-device-code").select();
    }
  });

  // Usage refresh (add-chatgpt-usage-check tasks.md 4.2): the explicit,
  // user-activated read — the only usage read besides the one a signed-in
  // profile's load already performs. Never a timer.
  $("btn-chatgpt-refresh-usage").addEventListener("click", () => controller.refreshUsage());

  // Status polling stops while this page is hidden/unloaded and resumes when
  // it becomes visible again (tasks.md 5.3's "stop ... when the page is
  // hidden/unloaded"; see settings-controller.js's pauseSignInPolling()/
  // resumeSignInPolling() doc comments). The usage block's countdown is a
  // purely local timer with no network call behind it, but it is stopped the
  // same way — a hidden page has nothing to count down to.
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      controller.pauseSignInPolling();
      stopChatgptUsageCountdown();
    } else {
      controller.resumeSignInPolling();
      resumeChatgptUsageCountdown();
    }
  });
  window.addEventListener("pagehide", () => {
    controller.pauseSignInPolling();
    stopChatgptUsageCountdown();
  });

  $("base-url").addEventListener("input", (e) => controller.setBaseUrlDraft(e.target.value));
  $("base-url").addEventListener("blur", () => controller.validateBaseUrlField());

  $("btn-remove-key").addEventListener("click", async () => {
    if (!confirm("Xóa API key đã lưu? Các phiên đang chạy dùng key này sẽ bị hủy.")) return;
    await controller.removeCredential();
  });

  $("btn-test-connection").addEventListener("click", () => controller.testConnection());
  $("btn-status-retest").addEventListener("click", () => controller.testConnection());
  $("btn-save").addEventListener("click", async () => {
    const keyInput = $("key-input");
    // Trimmed, because a key is almost always arriving here from a clipboard
    // — a chat message, an email, a provider's dashboard — and a leading or
    // trailing space or newline rides along invisibly in a password field.
    // The endpoint then rejects a key the operator can see is correct, and
    // the only feedback is a 401 that blames the key itself. No provider
    // issues a key with surrounding whitespace, so there is nothing to lose
    // by removing it. The Base URL field already did this (see
    // settings-validation.js's validateBaseUrl); the key field did not.
    const secretInput = keyInput.value.trim();
    // Cleared the instant Save is clicked, before the (possibly slow) async
    // call even starts — this is the literal "clear raw credentials after
    // submission" behavior the spec requires, and it happens regardless of
    // whether the save ultimately succeeds or fails.
    keyInput.value = "";
    await controller.save(secretInput);
  });
  $("btn-discover-models").addEventListener("click", () => controller.discoverModels());

  // Manual entry is the rarer path (discovery covers most providers), so the
  // two fields stay collapsed until asked for rather than sitting open above
  // every model list. aria-expanded/aria-controls carry the state for a
  // screen reader; focus moves into the first field on open so keyboard use
  // does not require hunting for what just appeared.
  $("btn-toggle-model-add").addEventListener("click", () => {
    const form = $("model-add-form");
    const opening = form.hidden;
    form.hidden = !opening;
    $("btn-toggle-model-add").setAttribute("aria-expanded", String(opening));
    if (opening) $("model-add-id").focus();
  });

  $("model-add-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const idInput = $("model-add-id");
    const labelInput = $("model-add-label");
    const result = controller.addModel({ id: idInput.value, label: labelInput.value });
    if (result.ok) {
      idInput.value = "";
      labelInput.value = "";
      idInput.focus();
    }
  });

  $("btn-export").addEventListener("click", async () => {
    const data = await controller.exportProfile();
    const json = JSON.stringify(data, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `ocic-settings-export-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  });

  $("import-file-input").addEventListener("change", async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const text = await file.text();
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      controller.state.banner = { kind: "error", title: "Tệp không hợp lệ", message: "Tệp không phải JSON hợp lệ.", action: "" };
      render(controller.getState());
      return;
    }
    await controller.importProfile(parsed);
    e.target.value = "";
  });
  $("btn-import").addEventListener("click", () => $("import-file-input").click());

  $("nav-recorder").addEventListener("click", () => {
    window.location.href = "../recorder/options.html";
  });
  $("nav-permissions").addEventListener("click", () => {
    window.location.href = "./permissions.html";
  });
  $("nav-skills").addEventListener("click", () => {
    window.location.href = "./skills.html";
  });

  $("theme-system").addEventListener("click", () => setThemeOverride(null));
  $("theme-light").addEventListener("click", () => setThemeOverride("light"));
  $("theme-dark").addEventListener("click", () => setThemeOverride("dark"));
}

wireEvents();
wireChipNav();
controller.init();
