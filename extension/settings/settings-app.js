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
    const actions = document.createElement("div");
    actions.className = "field-row-actions";
    const confirmBtn = document.createElement("button");
    confirmBtn.className = "btn btn-secondary btn-sm";
    confirmBtn.type = "button";
    confirmBtn.textContent = "Lưu chỉ trong bộ nhớ";
    confirmBtn.addEventListener("click", () => controller.confirmMemoryOnlyCredential());
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

// design.md decision D8: reads only existing controller state
// (connectionStatus/hasCredential/defaultModelId) and never initiates a
// connection test on load — testing costs API usage and stays an explicit
// user action.
function renderStatusCard(state) {
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
  retestBtn.disabled = state.testing || !state.hasCredential || !state.defaultModelId;
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

function renderProvider(state) {
  const urlInput = $("base-url");
  if (document.activeElement !== urlInput) urlInput.value = state.baseUrlDraft;
  urlInput.setAttribute("aria-invalid", state.fieldErrors.baseUrl ? "true" : "false");
  $("base-url-error").textContent = state.fieldErrors.baseUrl || "";
  $("base-url-error").hidden = !state.fieldErrors.baseUrl;

  const keyStatus = $("key-status-text");
  keyStatus.textContent = state.hasCredential
    ? `Đã lưu API key${state.memoryOnlyCredential ? " (chỉ trong bộ nhớ)" : ""}`
    : "Chưa lưu API key";
  $("btn-remove-key").hidden = !state.hasCredential;
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
  $("btn-test-connection").disabled = state.testing || !state.hasCredential || !state.defaultModelId;
  $("btn-test-connection").textContent = state.testing ? "Đang kiểm tra…" : "Kiểm tra kết nối";
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
  renderBanner(state);
  renderStatusCard(state);
  renderProvider(state);
  renderModels(state);
}

function wireEvents() {
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
