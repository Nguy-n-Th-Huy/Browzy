// Sanity checks for cic-tools.js + cic-prompt.js (no network, no chrome).
import { CIC_BETAS, COMPUTER_TOOL, NAVIGATE_TOOL, COMPUTER_ACTION_GUIDE, cicTools, cicHarnessTools } from "./cic-tools.js";
import { renderSystemPrompt } from "./cic-prompt.js";

let failures = 0;
function ok(cond, name) {
  console.log((cond ? "PASS" : "FAIL") + "  " + name);
  if (!cond) failures++;
}

ok(Array.isArray(CIC_BETAS) && CIC_BETAS.includes("computer-use-2025-01-24"), "computer-use beta pinned");
ok(COMPUTER_TOOL.type === "computer_20250124" && COMPUTER_TOOL.name === "computer", "computer tool shape");
const [c, n] = cicTools(1280, 800);
ok(c.display_width_px === 1280 && c.display_height_px === 800, "display size passthrough");
ok(n === NAVIGATE_TOOL && Array.isArray(n.input_schema.required) && n.input_schema.required.includes("url"), "navigate schema requires url");
for (const a of ["screenshot", "left_click", "type", "key", "scroll", "wait", "cursor_position"]) {
  ok(COMPUTER_ACTION_GUIDE.includes(a), "action guide mentions " + a);
}

const sys = renderSystemPrompt({ modelName: "claude-sonnet-4-5", platform: "Windows" });
ok(!sys.includes("{{"), "no unfilled template slots");
ok(sys.includes("claude-sonnet-4-5"), "model name filled");
ok(sys.includes("critical_injection_defense"), "captured prompt body present");
ok(sys.includes("You are on a Windows system"), "platform line appended");
ok(sys.includes("screenshot"), "action guide appended");

ok(typeof cicHarnessTools === "function", "curated set exported");
const four = cicHarnessTools();
ok(four.length === 7, "harness sees exactly 7 tools, got " + four.length);
ok(four.map((t) => t.name).join(",") === "computer,navigate,tabs_context,tabs_create,read_page,find,browser_batch", "curated tool order");
const batch = four.find((t) => t.name === "browser_batch");
ok(batch.input_schema.required.includes("actions"), "batch schema requires actions");
const find = four.find((t) => t.name === "find");
ok(find.input_schema.required.includes("query"), "find schema requires query");
const sys2 = renderSystemPrompt({ modelName: "m" });
ok(sys2.includes("OBSERVE once"), "efficiency discipline present");
ok(sys2.includes("find FIRST"), "find-first discipline present");

if (failures) { console.error(failures + " FAILURES"); process.exit(1); }
console.log("cic harness modules: all green");
