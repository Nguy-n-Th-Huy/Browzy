// Thin DOM binding over memory-controller.js (openspec/changes/add-task-memory
// tasks.md 7.3-7.4), following permissions-app.js: all decisions live in the
// DOM-free controller; this file renders a snapshot and forwards user events.
// Every forget asks for a second click within four seconds before it runs.
import { iconMarkup } from "../ui/icons.js";
import { createMemoryClient } from "./memory-client.js";
import { MemoryController } from "./memory-controller.js";

const $ = (id) => document.getElementById(id);

const client = createMemoryClient();
const controller = new MemoryController(client, { onChange: render });

$("btn-back").innerHTML = iconMarkup("chevronRight", { size: 18, title: "Quay lại" });
$("btn-back").style.transform = "scaleX(-1)";
$("ic-empty").innerHTML = iconMarkup("history", { size: 22, title: "Chưa có gì" });

/** The key awaiting its confirming second click ("*" = forget all), or null. */
let confirming = null;
let confirmTimer = null;

function armConfirm(key) {
  confirming = key;
  clearTimeout(confirmTimer);
  confirmTimer = setTimeout(() => {
    confirming = null;
    render(controller.state);
  }, 4000);
  render(controller.state);
}

function renderBanner(state) {
  const area = $("banner-area");
  area.innerHTML = "";
  if (!state.banner) return;
  const box = document.createElement("div");
  box.className = "card";
  box.setAttribute("role", state.banner.kind === "error" ? "alert" : "status");
  const title = document.createElement("p");
  title.className = "card-title";
  title.textContent = state.banner.title || "";
  box.appendChild(title);
  if (state.banner.message) {
    const p = document.createElement("p");
    p.className = "card-body";
    p.textContent = state.banner.message;
    box.appendChild(p);
  }
  area.appendChild(box);
}

function renderSite(row, state) {
  const card = document.createElement("div");
  card.className = "site-card";
  const head = document.createElement("div");
  head.className = "site-head";
  const host = document.createElement("span");
  host.className = "site-host";
  host.textContent = row.host;
  head.appendChild(host);
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "btn btn-ghost btn-sm";
  const busy = state.forgettingHost === row.host;
  btn.textContent = busy ? "Đang quên…" : confirming === row.host ? "Bấm lần nữa để xác nhận" : "Quên trang này";
  btn.disabled = busy || state.forgettingAll;
  btn.setAttribute("aria-label", `Quên các cách làm đã nhớ trên ${row.host}`);
  btn.addEventListener("click", () => {
    if (confirming !== row.host) return armConfirm(row.host);
    confirming = null;
    controller.forgetHost(row.host);
  });
  head.appendChild(btn);
  card.appendChild(head);
  for (const memory of row.memories) {
    const item = document.createElement("div");
    item.className = "memory-row";
    const intent = document.createElement("span");
    intent.className = "memory-intent";
    intent.textContent = memory.intentLabel;
    item.appendChild(intent);
    const meta = document.createElement("span");
    meta.className = "memory-meta";
    for (const text of [memory.stepsLabel, memory.confirmedLabel, memory.usedLabel].filter(Boolean)) {
      const span = document.createElement("span");
      span.textContent = text;
      meta.appendChild(span);
    }
    const stateSpan = document.createElement("span");
    stateSpan.textContent = memory.stateLabel;
    if (memory.stale) stateSpan.className = "memory-stale";
    meta.appendChild(stateSpan);
    item.appendChild(meta);
    card.appendChild(item);
  }
  return card;
}

function render(state) {
  renderBanner(state);
  const toggle = $("memory-enabled");
  toggle.checked = state.enabled === true;
  toggle.disabled = state.settingEnabled || !state.loaded;
  toggle.setAttribute("aria-checked", String(state.enabled === true));

  const list = $("site-list");
  list.innerHTML = "";
  for (const row of controller.siteRows()) list.appendChild(renderSite(row, state));
  $("memory-empty").hidden = !controller.isEmpty();
  const invalid = $("invalid-note");
  invalid.hidden = !state.invalid;
  invalid.textContent = state.invalid ? `${state.invalid} tệp bộ nhớ không đọc được và được bỏ qua.` : "";

  const all = $("btn-forget-all");
  all.disabled = state.forgettingAll || Boolean(state.forgettingHost) || state.sites.length === 0;
  all.textContent = state.forgettingAll ? "Đang quên…" : confirming === "*" ? "Bấm lần nữa để xác nhận" : "Quên tất cả";
}

$("btn-back").addEventListener("click", () => {
  window.location.href = "./settings.html";
});
$("memory-enabled").addEventListener("change", (event) => controller.setEnabled(event.target.checked));
$("btn-forget-all").addEventListener("click", () => {
  if (confirming !== "*") return armConfirm("*");
  confirming = null;
  controller.forgetAll();
});

render(controller.state);
controller.load();
