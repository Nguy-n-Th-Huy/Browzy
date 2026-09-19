import { escapeHtml, renderMarkdownLite } from "./markdown-lite.js";

export const PHASE_LABELS = Object.freeze({ planning: "Đang lập kế hoạch", observing: "Đang đọc kết quả", deciding: "Đang chọn bước tiếp theo", executing: "Đang thao tác", waiting: "Đang chờ trang phản hồi", verifying: "Đang kiểm chứng", reporting: "Đang tổng hợp kết quả" });

export function renderReport(turn) {
  const text = turn.text || "";
  // Only an independently verified, completed report may subordinate optional
  // diagnostics. Partial/blocked answers and legacy prose remain fully visible.
  if (turn.lifecycle !== "done" || turn.jevOutcome?.doneVerified !== true) return renderMarkdownLite(text);
  // Track code blocks before interpreting a heading. A quoted example is
  // report content, never permission to hide the rest of the answer.
  let fence = null, offset = 0, section = null;
  for (const line of text.split(/(?<=\n)/)) {
    const body = line.replace(/[\r\n]+$/, "");
    const marker = /^\s*(`{3,}|~{3,})(.*)$/.exec(body);
    if (fence) {
      if (marker && marker[1][0] === fence.char && marker[1].length >= fence.length && !marker[2].trim()) fence = null;
    } else if (marker && (marker[1][0] !== "`" || !marker[2].includes("`"))) {
      fence = { char: marker[1][0], length: marker[1].length };
    } else if (/^### (?:Chi tiết bổ sung|Additional details)[ \t]*$/.test(body)) {
      section = { start: offset, end: offset + line.length };
      break;
    }
    offset += line.length;
  }
  if (!section || !text.slice(0, section.start).trim()) return renderMarkdownLite(text);
  const main = text.slice(0, section.start);
  const secondary = text.slice(section.end);
  return `${renderMarkdownLite(main)}<details class="report-details"><summary>Chi tiết bổ sung</summary>${renderMarkdownLite(secondary)}</details>`;
}

export function timelineCounts(rows) {
  let operations = 0, activity = 0, legacy = 0;
  for (const row of rows || []) {
    if (row.jevMemory) activity++;
    else if (row.jev) {
      if (row.jev.dispatched === true) operations++;
      else if (row.jev.dispatched === false || row.jev.skippedReason || ["DONE", "REPLAN", "ASK_USER", "BLOCKED"].includes(row.jev.operation)) activity++;
      else legacy++;
    } else legacy++;
  }
  return { operations, activity, legacy };
}

export function cleanEvidence(raw) {
  if (!raw || typeof raw !== "object") return null;
  const str = (v, n) => typeof v === "string" ? v.slice(0, n) : null;
  const observation = (o) => {
    if (!o || typeof o !== "object") return { unavailableReason: "not_recorded" };
    if (o.unavailableReason) return { unavailableReason: str(o.unavailableReason, 100) };
    const s = o.screenshot || {};
    return { observedAt: Number.isFinite(o.observedAt) ? o.observedAt : null, url: str(o.url, 200), urlTruncated: o.urlTruncated === true, title: str(o.title, 160), text: str(o.text, 1000),
      target: o.target ? { ref: str(o.target.ref, 80), role: str(o.target.role, 80), label: str(o.target.label, 200), ...Object.fromEntries(["checked", "expanded", "disabled"].filter(k => typeof o.target[k] === "boolean").map(k => [k, o.target[k]])) } : null,
      screenshot: { status: ["available", "disabled", "unavailable"].includes(s.status) ? s.status : "unavailable", artifactId: str(s.artifactId, 200), reason: str(s.reason, 100) } };
  };
  return { before: observation(raw.before), after: observation(raw.after), changes: raw.changes ? Object.fromEntries(["pageChanged", "documentChanged", "targetChanged"].filter(k => typeof raw.changes[k] === "boolean").map(k => [k, raw.changes[k]])) : null };
}

export function evidenceHtml(evidence) {
  if (!evidence) return '<p class="evidence-unavailable">Bản ghi này không có bằng chứng trước/sau.</p>';
  const reasons = { disabled: "Ảnh đã tắt trong cài đặt", stopped: "Đã dừng trước khi ghi nhận", result_unknown: "Chưa xác định kết quả thao tác", observation_failed: "Không đọc được trạng thái trang", not_recorded: "Không có bản ghi", stale: "Ảnh không còn khớp trạng thái trang" };
  const parts = ["before", "after"].map((key) => {
    const o = evidence[key];
    const name = key === "before" ? "Trước thao tác" : "Sau thao tác";
    if (!o || o.unavailableReason) return `<section><strong>${name}</strong><p>${escapeHtml(reasons[o?.unavailableReason] || "Không có bằng chứng ở thời điểm này")}</p></section>`;
    const shot = o.screenshot || {};
    const image = shot.status === "available" && shot.artifactId
      ? `<button type="button" class="evidence-image-button" data-artifact-id="${escapeHtml(shot.artifactId)}">Xem ảnh đã ghi — ${name.toLowerCase()}</button><div class="evidence-image-slot" aria-live="polite"></div>`
      : `<p class="evidence-unavailable">${escapeHtml(shot.status === "disabled" ? reasons.disabled : reasons[shot.reason] || "Ảnh không khả dụng")}</p>`;
    const target = o.target ? `<p>Đối tượng: ${escapeHtml(o.target.label || o.target.ref || "")} ${escapeHtml(["checked", "expanded", "disabled"].filter(k => typeof o.target[k] === "boolean").map(k => `${k}: ${o.target[k]}`).join(", "))}</p>` : "";
    return `<section><strong>${name}</strong>${o.observedAt ? `<time>${escapeHtml(new Date(o.observedAt).toLocaleString("vi-VN"))}</time>` : ""}<p>${escapeHtml(o.title || "")}</p><p>${escapeHtml(o.url || "")}${o.urlTruncated ? "…" : ""}</p>${target}<p>${escapeHtml(o.text || "")}</p>${image}</section>`;
  });
  const changes = evidence.changes ? Object.entries(evidence.changes).map(([k,v]) => `${({pageChanged:"Trang",documentChanged:"Tài liệu",targetChanged:"Đối tượng"})[k]}: ${v ? "đã thay đổi" : "không đổi"}`).join(" · ") : "Chưa có đối chiếu thay đổi";
  return `<div class="step-evidence"><p>${escapeHtml(changes)}</p>${parts.join("")}</div>`;
}
