// Harness panel logic: key (memory only) + task -> loop.js -> background tools.
// Opens via chrome-extension://<id>/agent/panel.html in a tab.
import { createAgentLoop } from "./loop.js";
import { CIC_BETAS, cicHarnessTools } from "./cic-tools.js";
import { renderSystemPrompt } from "./cic-prompt.js";

const $ = (id) => document.getElementById(id);
const logEl = $("log");
let agentTabId = null;
let lastRun = null; // { task, model, startedAt, events, transcript } for download

function line(cls, text) {
  const div = document.createElement("div");
  if (cls) div.className = cls;
  div.textContent = text;
  logEl.appendChild(div);
  logEl.scrollTop = logEl.scrollHeight;
}

function showImage(b64, mediaType = "image/png") {
  const img = document.createElement("img");
  img.src = `data:${mediaType};base64,${b64}`;
  logEl.appendChild(img);
  logEl.scrollTop = logEl.scrollHeight;
}

async function callTool(tool, args) {
  const res = await chrome.runtime.sendMessage({ type: "browzy_agent_tool", tool, args });
  if (!res) throw new Error("background không trả lời (reload extension thử).");
  if (!res.ok) throw new Error(res.error || "tool failed");
  return res.result;
}

$("key").value = sessionStorage.getItem("browzy_harness_key") || "";
$("key").addEventListener("input", (e) => sessionStorage.setItem("browzy_harness_key", e.target.value));

$("btn-prep").addEventListener("click", async () => {
  try {
    line("", "Đang chuẩn bị tab agent...");
    // Reuse the registry's own tab maker so the tab lands in the agent group
    // (computer/navigate refuse tabs outside it).
    const r = await callTool("tabs_create_mcp", { createIfEmpty: true });
    const m = JSON.stringify(r).match(/"id"\s*:\s*(\d+)/);
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    agentTabId = (m && Number(m[1])) || (tab && tab.id) || null;
    line("ok", "Tab agent sẵn sàng (tabId=" + agentTabId + "). Giờ nhập task và Chạy.");
  } catch (e) {
    line("err", "Chuẩn bị tab thất bại: " + e.message);
  }
});

$("btn-run").addEventListener("click", async () => {
  const apiKey = $("key").value.trim();
  const model = $("model").value.trim();
  const task = $("task").value.trim();
  if (!apiKey) return line("err", "Thiếu API key.");
  if (!task) return line("err", "Nhập task đã.");
  if (!agentTabId) {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    agentTabId = tab && tab.id;
  }
  if (!agentTabId) return line("err", "Bấm 'Chuẩn bị tab' trước.");
  $("btn-run").disabled = true;
  try {
    line("", "▶ " + task);
    const loop = createAgentLoop({
      apiKey,
      model,
      systemPrompt: renderSystemPrompt({ modelName: model, platform: "Windows" }),
      tools: cicHarnessTools(),
      betas: CIC_BETAS,
      executeTool: async (name, input) => {
        if (name !== "computer" && name !== "navigate" && name !== "read_page" && name !== "browser_batch" && name !== "find") {
          throw new Error("tool không hỗ trợ trong harness: " + name);
        }
        if (name === "browser_batch") {
          // Batch items inherit the working tab; stamp it on each step.
          const actions = (input.actions || []).map((a) => ({
            name: a.name,
            input: { ...(a.input || {}), tabId: a.input && a.input.tabId ? a.input.tabId : agentTabId },
          }));
          const result = await callTool(name, { actions });
          return result && result.content ? result.content : result;
        }
        const result = await callTool(name, { ...input, tabId: agentTabId });
        return result && result.content ? result.content : result;
      },
      onEvent: (e) => {
        lastRun.events.push({ t: Date.now(), ...e });
        if (e.type === "text" && e.text) line("", e.text);
        else if (e.type === "tool_start") line("tool", `⚙ ${e.name}(${summarize(e.input)})`);
        else if (e.type === "tool_end" && !e.ok) line("err", "  ↳ lỗi: " + e.error);
        else if (e.type === "done") line("ok", "■ xong (" + e.stopReason + ")");
      },
    });
    lastRun = { task, model, startedAt: new Date().toISOString(), events: [], transcript: null };
    // NOTE: lastRun reset AFTER loop creation so onEvent above appends into
    // a fresh array — events fired during run() land in lastRun.events.
    const { transcript } = await loop.run([{ role: "user", content: task }]);
    lastRun.transcript = transcript;
    // Surface the last screenshot if the final turn carried one.
    for (const m of transcript) {
      for (const b of (m.content || [])) {
        if (b && b.type === "image" && b.source && b.source.data) {
          showImage(b.source.data, b.source.media_type);
        }
      }
    }
  } catch (e) {
    line("err", "Dừng vì lỗi: " + (e.code ? `[${e.code}] ` : "") + e.message);
  } finally {
    $("btn-run").disabled = false;
  }
});

function summarize(input) {
  try {
    const s = JSON.stringify(input);
    return s.length > 160 ? s.slice(0, 160) + "…" : s;
  } catch {
    return "?";
  }
}

$("btn-dl").addEventListener("click", () => {
  if (!lastRun || !lastRun.events.length) return line("err", "Chưa có run nào để tải.");
  // Strip image payloads — the event/tool names are what matters, and base64
  // screenshots would bloat the file past chat limits.
  const slim = JSON.parse(JSON.stringify(lastRun, (k, v) =>
    (k === "data" && typeof v === "string" && v.length > 200 ? "<image-bytes>" : v)));
  const blob = new Blob([JSON.stringify(slim, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "harness-run-" + Date.now() + ".json";
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  line("ok", "Đã tải log. Gửi file cho Rhys đọc.");
});
