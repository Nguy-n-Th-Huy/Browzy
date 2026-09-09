// Thin DOM binding layer over skills-controller.js — same convention as
// settings-app.js (task 4.4): all decision-making lives in the DOM-free
// controller (unit tested in test/settings-ui-skills-controller.test.mjs);
// this file only renders a state snapshot into the DOM and forwards user
// events to controller methods. Visual correctness is verified by real
// captured screenshots (reports/07-skills-ui-evidence.md), not a DOM test.
import { iconMarkup } from "../ui/icons.js";
import { createSkillsClient } from "./skills-client.js";
import { SkillsController } from "./skills-controller.js";

const $ = (id) => document.getElementById(id);

const client = createSkillsClient();
const controller = new SkillsController(client, { onChange: render });

// Exposed ONLY for this task's own visual-QA screenshot capture (driving the
// page through every required state without a live companion — see the
// "Environment constraint" this task's brief documents) and manual
// debugging. Carries no secret — a skill catalog record never contains one.
window.__skillsDebug = { controller, client };

// Static icon injection for markup that never re-renders (moved out of
// skills.html's former inline <script type="module"> block — MV3's default
// script-src forbids inline scripts on extension pages, so this must live
// in an externally-loaded module; see extension/sidepanel/sidepanel.js for
// the same pattern). Exact icon names/sizes/titles are unchanged from the
// removed inline block.
$("btn-back").innerHTML = iconMarkup("chevronRight", { size: 18, title: "Quay lại" });
$("btn-back").style.transform = "scaleX(-1)";
$("ic-folder").innerHTML = iconMarkup("folder", { size: 15 });
$("ic-plus").innerHTML = iconMarkup("plus", { size: 15 });

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

function skillCardHtml(skill) {
  const hasIssue = Array.isArray(skill.unsupportedCapabilities) && skill.unsupportedCapabilities.length > 0;
  const importedDate = skill.importedAt ? new Date(skill.importedAt).toLocaleDateString("vi-VN") : "";
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
      ${
        hasIssue
          ? ""
          : `<div class="skill-card-actions">
              <button class="btn btn-ghost btn-sm" type="button" data-role="refresh"><span data-role="refresh-icon"></span>Nạp lại</button>
              <button class="btn btn-ghost btn-sm" type="button" style="color:var(--color-status-danger)" data-role="remove"><span data-role="remove-icon"></span>Gỡ bỏ</button>
            </div>`
      }
    </div>`;
}

function wireSkillCard(cardEl, skill, state) {
  cardEl.querySelector(".card-title").textContent = skill.name;
  cardEl.querySelector(".card-body").textContent = skill.description || "";
  const sourceLine = [skill.source, skill.importedAt ? `đã nhập ${new Date(skill.importedAt).toLocaleDateString("vi-VN")}` : ""]
    .filter(Boolean)
    .join(" · ");
  cardEl.querySelector(".skill-card-source").textContent = sourceLine;

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
  if (toggle) {
    toggle.disabled = state.pending[skill.name] === "enabling" || state.pending[skill.name] === "disabling";
    toggle.addEventListener("change", () => controller.setEnabled(skill.name, toggle.checked));
  }

  const refreshBtn = cardEl.querySelector('[data-role="refresh"]');
  if (refreshBtn) {
    const refreshIcon = cardEl.querySelector('[data-role="refresh-icon"]');
    if (refreshIcon) refreshIcon.innerHTML = iconMarkup("refresh", { size: 14 });
    refreshBtn.disabled = state.pending[skill.name] === "refreshing";
    refreshBtn.textContent = state.pending[skill.name] === "refreshing" ? "Đang nạp lại…" : "";
    if (refreshIcon) refreshBtn.prepend(refreshIcon);
    if (state.pending[skill.name] !== "refreshing") refreshBtn.append("Nạp lại");
    refreshBtn.addEventListener("click", () => controller.refreshSkill(skill.name));
  }

  const removeBtn = cardEl.querySelector('[data-role="remove"]');
  if (removeBtn) {
    const removeIcon = cardEl.querySelector('[data-role="remove-icon"]');
    if (removeIcon) removeIcon.innerHTML = iconMarkup("trash", { size: 14 });
    removeBtn.disabled = state.pending[skill.name] === "removing";
    removeBtn.addEventListener("click", () => {
      if (!confirm(`Gỡ bỏ bản sao "${skill.name}" khỏi ứng dụng? Thư mục nguồn gốc sẽ KHÔNG bị xóa.`)) return;
      controller.removeSkill(skill.name);
    });
  }
}

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
}

// Text/textarea fields in the author form only get their DOM value
// overwritten when the field isn't currently focused — same rule
// import-path already follows, so a re-render triggered by, say, another
// row's toggle never clobbers what the operator is mid-typing here.
const AUTHOR_TEXT_FIELDS = [
  ["author-name", "name"],
  ["author-description", "description"],
  ["author-body", "body"],
  ["author-allowed-tools", "allowedTools"]
];

function render(state) {
  renderBanner(state);
  renderList(state);
  $("btn-import").disabled = state.importing;
  $("btn-import").textContent = "";
  const folderIcon = document.createElement("span");
  folderIcon.innerHTML = iconMarkup("folder", { size: 15 });
  $("btn-import").append(folderIcon, state.importing ? "Đang nhập…" : "Nhập thư mục");
  if (document.activeElement !== $("import-path")) $("import-path").value = state.importDraft;

  for (const [id, field] of AUTHOR_TEXT_FIELDS) {
    const el = $(id);
    if (document.activeElement !== el) el.value = state.authorDraft[field];
  }
  $("author-user-invocable").checked = !!state.authorDraft.userInvocable;
  $("author-model-invocable").checked = !!state.authorDraft.modelInvocable;
  $("btn-author").disabled = state.authoring;
  $("btn-author").textContent = "";
  const plusIcon = document.createElement("span");
  plusIcon.innerHTML = iconMarkup("plus", { size: 15 });
  $("btn-author").append(plusIcon, state.authoring ? "Đang tạo…" : "Tạo skill");
}

function wireEvents() {
  $("import-path").addEventListener("input", (e) => controller.setImportDraft(e.target.value));
  $("btn-import").addEventListener("click", () => controller.importFromDraft());
  $("btn-back").addEventListener("click", () => {
    window.location.href = "./settings.html";
  });

  for (const [id, field] of AUTHOR_TEXT_FIELDS) {
    $(id).addEventListener("input", (e) => controller.setAuthorField(field, e.target.value));
  }
  $("author-user-invocable").addEventListener("change", (e) => controller.setAuthorField("userInvocable", e.target.checked));
  $("author-model-invocable").addEventListener("change", (e) => controller.setAuthorField("modelInvocable", e.target.checked));
  $("btn-author").addEventListener("click", () => controller.authorFromDraft());
}

wireEvents();
controller.init();
