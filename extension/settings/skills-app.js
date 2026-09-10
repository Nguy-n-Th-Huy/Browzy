// Thin DOM binding layer over skills-controller.js — same convention as
// settings-app.js (task 4.4): all decision-making lives in the DOM-free
// controller (unit tested in test/settings-ui-skills-controller.test.mjs);
// this file only renders a state snapshot into the DOM and forwards user
// events to controller methods. Visual correctness is verified by real
// captured screenshots, not a DOM test.
import { iconMarkup } from "../ui/icons.js";
import { createSkillsClient } from "./skills-client.js";
import { SkillsController } from "./skills-controller.js";

const $ = (id) => document.getElementById(id);

const client = createSkillsClient();
const controller = new SkillsController(client, { onChange: render });

// Exposed ONLY for this task's own visual-QA screenshot capture (driving the
// page through every required state without a live companion) and manual
// debugging. Carries no secret — a skill catalog record never contains one.
window.__skillsDebug = { controller, client };

// Static icon injection for markup that never re-renders (moved out of
// skills.html's former inline <script type="module"> block — MV3's default
// script-src forbids inline scripts on extension pages, so this must live
// in an externally-loaded module; see extension/sidepanel/sidepanel.js for
// the same pattern).
$("btn-back").innerHTML = iconMarkup("chevronRight", { size: 18, title: "Quay lại" });
$("btn-back").style.transform = "scaleX(-1)";
$("ic-note").innerHTML = iconMarkup("info", { size: 16 });
$("ic-plus").innerHTML = iconMarkup("plus", { size: 15 });
$("ic-empty").innerHTML = iconMarkup("skills", { size: 22 });
$("ic-empty-cta").innerHTML = iconMarkup("plus", { size: 15 });

function iconEl(name, opts) {
  const span = document.createElement("span");
  span.className = "ui-icon";
  span.innerHTML = iconMarkup(name, opts);
  return span;
}

function renderBanner(state) {
  const area = $("banner-area");
  area.innerHTML = "";
  if (!state.banner) return;
  const box = document.createElement("div");
  const kindClass = state.banner.kind === "error" ? "is-failed" : state.banner.kind === "success" ? "is-succeeded" : "is-unknown";
  box.className = "card settings-banner";
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
  area.appendChild(box);
}

// ---- Skill cards --------------------------------------------------------

function provenanceLine(skill) {
  // design.md's "Card provenance copy changes": a filesystem path is never
  // shown again (that was exactly the reach this change removes) — every
  // card says "Tự soạn · sửa lần cuối …" regardless of whether the record
  // originally entered the catalog through the now-removed folder-import
  // path or through this page. See skills-controller.js's header on why a
  // legacy folder-imported record's own `source` is never surfaced here.
  const when = skill.updatedAt || skill.importedAt;
  const dateText = when ? new Date(when).toLocaleDateString("vi-VN") : "";
  const invocation = skill.userInvocable ? `/${skill.name}` : "chỉ mô hình gọi";
  return ["Tự soạn", dateText ? `sửa lần cuối ${dateText}` : "", invocation].filter(Boolean).join(" · ");
}

function skillCardHtml(skill) {
  const hasIssue = Array.isArray(skill.unsupportedCapabilities) && skill.unsupportedCapabilities.length > 0;
  return `
    <div class="card skill-card" data-skill="${skill.name}" ${hasIssue ? 'style="border-color:var(--color-status-danger)"' : ""}>
      <div class="skill-card-head">
        <span class="list-item-icon" data-role="icon" ${hasIssue ? 'style="color:var(--color-status-danger)"' : ""}></span>
        <div class="skill-card-body">
          <p class="card-title"></p>
          <p class="card-body"></p>
          <p class="skill-card-source field-hint"></p>
          ${hasIssue ? `<p class="field-error" style="margin-top:6px" data-role="issue"><span data-role="issue-icon"></span></p>` : ""}
        </div>
        ${
          hasIssue
            ? ""
            : `<label class="switch">
                <input type="checkbox" data-role="toggle" ${skill.enabled ? "checked" : ""} aria-label="Bật/tắt skill ${skill.name}">
                <span class="switch-track"></span>
                <span class="switch-thumb"></span>
              </label>`
        }
      </div>
      <div data-role="actions-slot"></div>
    </div>`;
}

function normalActionsRow(skill, state) {
  const row = document.createElement("div");
  row.className = "skill-card-actions";
  if (!Array.isArray(skill.unsupportedCapabilities) || skill.unsupportedCapabilities.length === 0) {
    const editBtn = document.createElement("button");
    editBtn.className = "btn btn-ghost btn-sm";
    editBtn.type = "button";
    editBtn.textContent = "Sửa";
    editBtn.addEventListener("click", () => onLoadRequested("edit", skill.name));

    const dupBtn = document.createElement("button");
    dupBtn.className = "btn btn-ghost btn-sm";
    dupBtn.type = "button";
    dupBtn.appendChild(iconEl("copy", { size: 14 }));
    dupBtn.append("Nhân bản");
    dupBtn.addEventListener("click", () => onLoadRequested("duplicate", skill.name));

    row.append(editBtn, dupBtn);
  }
  const removeBtn = document.createElement("button");
  removeBtn.className = "btn btn-ghost btn-sm";
  removeBtn.type = "button";
  removeBtn.style.color = "var(--color-status-danger)";
  removeBtn.disabled = state.pending[skill.name] === "removing";
  removeBtn.appendChild(iconEl("trash", { size: 14 }));
  removeBtn.append("Gỡ bỏ");
  removeBtn.addEventListener("click", () => {
    lastRemovalInvoker = skill.name;
    controller.requestRemoval(skill.name);
  });
  row.appendChild(removeBtn);
  return row;
}

// design.md decision D5: an in-page confirmation card replaces the row of
// actions, never window.confirm() (a native modal blocks this page's event
// loop, a real hazard with async companion messages in flight).
function removalConfirmRow(skill) {
  const wrap = document.createElement("div");
  wrap.className = "skill-confirm";
  wrap.innerHTML = `
    <div class="skill-confirm-head">
      <span class="skill-confirm-icon" data-role="confirm-icon"></span>
      <span style="flex:1;min-width:0">
        <p class="skill-confirm-title">Gỡ bỏ "${skill.name}"?</p>
        <p class="skill-confirm-desc">Nội dung skill này sẽ bị xóa khỏi kho của Browzy và không khôi phục được. Các cuộc trò chuyện đang mở sẽ ngừng thấy skill ngay lập tức.</p>
      </span>
    </div>
    <div class="skill-confirm-actions">
      <button class="btn btn-ghost btn-sm" type="button" data-role="cancel">Hủy</button>
      <button class="btn" type="button" style="background:transparent;color:var(--color-status-danger);border:1px solid var(--color-status-danger)" data-role="confirm">Gỡ bỏ</button>
    </div>`;
  wrap.querySelector('[data-role="confirm-icon"]').innerHTML = iconMarkup("trash", { size: 18 });
  const cancelBtn = wrap.querySelector('[data-role="cancel"]');
  const confirmBtn = wrap.querySelector('[data-role="confirm"]');
  cancelBtn.addEventListener("click", () => controller.cancelRemoval());
  confirmBtn.addEventListener("click", () => controller.confirmRemoval());
  // Nothing else in the card may be tabbable while this is open — the
  // switch in skill-card-head is outside this row, so it is explicitly
  // disabled for the duration of the confirmation (task 4.5).
  wrap.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      controller.cancelRemoval();
    }
  });
  return wrap;
}

function wireSkillCard(cardEl, skill, state) {
  cardEl.querySelector(".card-title").textContent = skill.name;
  cardEl.querySelector(".card-body").textContent = skill.description || "";
  cardEl.querySelector(".skill-card-source").textContent = provenanceLine(skill);

  const iconEl2 = cardEl.querySelector('[data-role="icon"]');
  if (iconEl2) iconEl2.innerHTML = iconMarkup("skills", { size: 18 });

  const issue = cardEl.querySelector('[data-role="issue"]');
  if (issue) {
    const issueIcon = cardEl.querySelector('[data-role="issue-icon"]');
    if (issueIcon) issueIcon.innerHTML = iconMarkup("alertTriangle", { size: 14 });
    issue.append(
      document.createTextNode(
        `Cần quyền chưa được hỗ trợ (${skill.unsupportedCapabilities.join(", ")}); chỉ đọc tài nguyên và duyệt web được bật.`
      )
    );
  }

  const toggle = cardEl.querySelector('[data-role="toggle"]');
  const confirming = state.pendingRemoval === skill.name;
  if (toggle) {
    toggle.disabled = state.pending[skill.name] === "enabling" || state.pending[skill.name] === "disabling" || confirming;
    toggle.addEventListener("change", () => controller.setEnabled(skill.name, toggle.checked));
  }

  const slot = cardEl.querySelector('[data-role="actions-slot"]');
  slot.appendChild(confirming ? removalConfirmRow(skill) : normalActionsRow(skill, state));
}

let lastRemovalInvoker = null; // skill name whose "Gỡ bỏ" button opened the
// currently-open (or just-closed) confirmation, so focus can return to it.
let removalConfirmOpenFor = null; // skill name the confirm card is CURRENTLY
// shown for, tracked across renders so focus is moved to Cancel exactly
// once per open, never re-stolen on an unrelated re-render.

function renderList(state) {
  const list = $("skill-list");
  list.innerHTML = "";
  $("skills-empty").hidden = state.skills.length > 0;
  for (const skill of state.skills) {
    const wrap = document.createElement("div");
    wrap.innerHTML = skillCardHtml(skill);
    const cardEl = wrap.firstElementChild;
    wireSkillCard(cardEl, skill, state);
    list.appendChild(cardEl);
  }

  // Focus management for the removal-confirmation card (task 4.5): move
  // focus to Cancel the moment it opens; when it closes (cancelled OR
  // removed), return focus to the "Gỡ bỏ" button that opened it, if that
  // control still exists (it won't, after an actual removal — there is
  // nothing to return focus to in that case, and the success banner already
  // carries the outcome).
  if (state.pendingRemoval && state.pendingRemoval !== removalConfirmOpenFor) {
    removalConfirmOpenFor = state.pendingRemoval;
    const cancelBtn = list.querySelector(`[data-skill="${cssEscape(state.pendingRemoval)}"] [data-role="cancel"]`);
    if (cancelBtn) cancelBtn.focus();
  } else if (!state.pendingRemoval && removalConfirmOpenFor) {
    const closedName = removalConfirmOpenFor;
    removalConfirmOpenFor = null;
    if (lastRemovalInvoker === closedName) {
      const card = list.querySelector(`[data-skill="${cssEscape(closedName)}"]`);
      const removeBtn = card && [...card.querySelectorAll("button")].find((b) => b.textContent.trim() === "Gỡ bỏ");
      if (removeBtn) removeBtn.focus();
    }
  }
}

function cssEscape(value) {
  return window.CSS && CSS.escape ? CSS.escape(value) : value.replace(/["\\]/g, "\\$&");
}

// ---- Authoring form: Soạn/Xem trước tabs ---------------------------------

const BODY_SOFT_LIMIT = 20000;
const BODY_WARN_AT = 18000;
let lastAnnouncedBand = "normal";
let activeBodyTab = "compose";

function bandFor(len) {
  if (len >= BODY_SOFT_LIMIT) return "over";
  if (len >= BODY_WARN_AT) return "warning";
  return "normal";
}

function updateBodyCounter(body) {
  const len = body.length;
  $("author-body-counter").textContent = `${len.toLocaleString("vi-VN")} / ${BODY_SOFT_LIMIT.toLocaleString("vi-VN")} ký tự`;
  const band = bandFor(len);
  if (band !== lastAnnouncedBand) {
    const announce = $("author-body-counter-announce");
    announce.textContent =
      band === "over"
        ? "Nội dung đã vượt quá độ dài khuyến nghị."
        : band === "warning"
          ? "Nội dung sắp đạt độ dài khuyến nghị."
          : "";
    lastAnnouncedBand = band;
  }
}

function renderBodyTabs(bodyText) {
  const composeTab = $("tab-compose");
  const previewTab = $("tab-preview");
  const panel = $("author-body-panel");
  const textarea = $("author-body");
  const preview = $("author-body-preview");
  const composing = activeBodyTab === "compose";
  composeTab.setAttribute("aria-selected", String(composing));
  previewTab.setAttribute("aria-selected", String(!composing));
  composeTab.tabIndex = composing ? 0 : -1;
  previewTab.tabIndex = composing ? -1 : 0;
  panel.setAttribute("aria-labelledby", composing ? "tab-compose" : "tab-preview");
  textarea.hidden = !composing;
  preview.hidden = composing;
  // Preview reuses the project's existing prose styling on the raw
  // composed body — it is a formatting aid, not a new Markdown renderer
  // (design.md's own non-goal); textContent only, never innerHTML.
  if (!composing) preview.textContent = bodyText;
}

function activateBodyTab(tab) {
  if (activeBodyTab === tab) return;
  activeBodyTab = tab;
  renderBodyTabs($("author-body").value);
  $(tab === "compose" ? "tab-compose" : "tab-preview").focus();
}

function wireBodyTabs() {
  $("tab-compose").addEventListener("click", () => activateBodyTab("compose"));
  $("tab-preview").addEventListener("click", () => activateBodyTab("preview"));
  const tablist = $("tab-compose").parentElement;
  tablist.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    activateBodyTab(activeBodyTab === "compose" ? "preview" : "compose");
  });
}

// ---- Authoring form: field errors ----------------------------------------

function renderFieldError(inputId, errorId, message) {
  const input = $(inputId);
  const errorEl = $(errorId);
  if (message) {
    input.setAttribute("aria-invalid", "true");
    errorEl.textContent = message;
    errorEl.hidden = false;
  } else {
    input.removeAttribute("aria-invalid");
    errorEl.textContent = "";
    errorEl.hidden = true;
  }
}

// ---- Authoring form: unsaved-draft guard (design.md D3) ------------------

let pendingLoadInvoker = null; // { name, kind } of the Sửa/Nhân bản button
// that triggered a PARKED load request, so focus can return to it on cancel
// (the button itself cannot be held onto directly: renderList() rebuilds
// every card's DOM on each render, including the one this render's cancel
// click will trigger).
let pendingLoadIntent = null; // "cancel" | "confirm", set immediately before
// asking the controller to resolve a parked request, so the next render
// knows whether to return focus to the invoker (cancel) or into the
// now-loaded form (confirm).

function onLoadRequested(kind, name) {
  const action = kind === "edit" ? controller.loadForEdit(name) : controller.loadForDuplicate(name);
  action.then((result) => {
    if (result && result.needsConfirmation) pendingLoadInvoker = { name, kind };
  });
}

function renderPendingLoadConfirm(state) {
  const container = $("author-pending-load-confirm");
  if (!state.pendingLoad) {
    container.hidden = true;
    container.innerHTML = "";
    return;
  }
  const wasHidden = container.hidden;
  container.hidden = false;
  const actionLabel = state.pendingLoad.kind === "edit" ? "sửa" : "nhân bản";
  container.innerHTML = `
    <div class="skill-confirm">
      <div class="skill-confirm-head">
        <span class="skill-confirm-icon" data-role="icon"></span>
        <span style="flex:1;min-width:0">
          <p class="skill-confirm-title">Thay bản đang soạn dở?</p>
          <p class="skill-confirm-desc">Bạn đang soạn dở một skill chưa lưu. Tiếp tục để ${actionLabel} "${state.pendingLoad.sourceName}" sẽ xóa nội dung đang gõ.</p>
        </span>
      </div>
      <div class="skill-confirm-actions">
        <button class="btn btn-ghost btn-sm" type="button" data-role="cancel">Hủy</button>
        <button class="btn btn-primary btn-sm" type="button" data-role="confirm">Tiếp tục</button>
      </div>
    </div>`;
  container.querySelector('[data-role="icon"]').innerHTML = iconMarkup("alertTriangle", { size: 18 });
  const cancelBtn = container.querySelector('[data-role="cancel"]');
  container.querySelector('[data-role="confirm"]').addEventListener("click", () => {
    pendingLoadIntent = "confirm";
    controller.confirmPendingLoad();
  });
  cancelBtn.addEventListener("click", () => {
    pendingLoadIntent = "cancel";
    controller.cancelPendingLoad();
  });
  container.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      pendingLoadIntent = "cancel";
      controller.cancelPendingLoad();
    }
  });
  if (wasHidden) cancelBtn.focus();
  $("author-actions-row").hidden = true;
}

// ---- Full render -----------------------------------------------------

const AUTHOR_TEXT_FIELDS = [
  ["author-name", "name", "author-name-error"],
  ["author-description", "description", "author-description-error"],
  ["author-allowed-tools", "allowedTools", null]
];

function render(state) {
  renderBanner(state);
  renderList(state);

  const modeHint = $("author-mode-hint");
  if (state.editingName) {
    modeHint.hidden = false;
    modeHint.textContent = `Đang sửa "${state.editingName}".`;
  } else {
    modeHint.hidden = true;
  }

  for (const [id, field, errorId] of AUTHOR_TEXT_FIELDS) {
    const el = $(id);
    if (document.activeElement !== el) el.value = state.authorDraft[field];
    if (errorId) renderFieldError(id, errorId, state.fieldErrors[field]);
  }
  const bodyEl = $("author-body");
  if (document.activeElement !== bodyEl) bodyEl.value = state.authorDraft.body;
  renderFieldError("author-body", "author-body-error", state.fieldErrors.body);
  updateBodyCounter(state.authorDraft.body || "");
  renderBodyTabs(state.authorDraft.body || "");

  $("author-user-invocable").checked = !!state.authorDraft.userInvocable;
  $("author-model-invocable").checked = !!state.authorDraft.modelInvocable;

  $("btn-author").disabled = state.authoring;
  $("btn-author").textContent = "";
  const plusIcon = document.createElement("span");
  plusIcon.innerHTML = iconMarkup("plus", { size: 15 });
  const submitLabel = state.authoring ? "Đang lưu…" : state.editingName ? "Lưu thay đổi" : "Tạo skill";
  $("btn-author").append(plusIcon, submitLabel);
  $("btn-discard-draft").disabled = state.authoring;

  renderPendingLoadConfirm(state);
  if (!state.pendingLoad) {
    $("author-actions-row").hidden = false;
    // The confirmation just closed (cancel or confirm) — restore focus per
    // `pendingLoadIntent`: back to the Sửa/Nhân bản button that opened it on
    // cancel, or into the now-loaded form's first field on confirm. Looked
    // up by name rather than held as a direct element reference because
    // renderList() just rebuilt every card's DOM, including the one that
    // held the original button.
    if (pendingLoadInvoker) {
      const invoker = pendingLoadInvoker;
      const intent = pendingLoadIntent;
      pendingLoadInvoker = null;
      pendingLoadIntent = null;
      if (intent === "cancel") {
        const card = document.querySelector(`[data-skill="${cssEscape(invoker.name)}"]`);
        const label = invoker.kind === "edit" ? "Sửa" : "Nhân bản";
        const btn = card && [...card.querySelectorAll("button")].find((b) => b.textContent.trim() === label);
        if (btn) btn.focus();
      } else if (intent === "confirm") {
        $("author-name").focus();
      }
    }
  }
}

function wireEvents() {
  $("btn-back").addEventListener("click", () => {
    window.location.href = "./settings.html";
  });

  for (const [id, field] of AUTHOR_TEXT_FIELDS) {
    $(id).addEventListener("input", (e) => controller.setAuthorField(field, e.target.value));
  }
  $("author-body").addEventListener("input", (e) => controller.setAuthorField("body", e.target.value));
  $("author-user-invocable").addEventListener("change", (e) => controller.setAuthorField("userInvocable", e.target.checked));
  $("author-model-invocable").addEventListener("change", (e) => controller.setAuthorField("modelInvocable", e.target.checked));
  $("btn-author").addEventListener("click", () => controller.authorFromDraft());
  $("btn-discard-draft").addEventListener("click", () => controller.discardDraft());
  $("btn-empty-cta").addEventListener("click", () => $("author-name").focus());

  wireBodyTabs();
}

wireEvents();
controller.init();
