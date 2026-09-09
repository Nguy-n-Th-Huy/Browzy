#!/usr/bin/env node
//
// The transcript must never show a raw wire tool name.
//
// The operator reported seeing `mcp__…` names where Claude in Chrome shows
// "Read page text" / "Captured page". Cause: the companion registers the
// browser tools on an in-process SDK MCP server, so calls arrive qualified
// as `mcp__<server>__<tool>`, while every label/redaction/detail rule in
// tool-labels.js is keyed by the plain registry name from
// host/tool-definitions.js — so every lookup missed and fell through to the
// raw-name fallback.
//
// Run: node test/sidepanel-tool-label-mcp-names.test.mjs

import { TOOLS } from "../host/tool-definitions.js";
import {
  baseToolName,
  humanToolLabel,
  humanToolLabelRunning,
  isSensitiveTypedInput,
  summarizeArgsForDetail
} from "../extension/sidepanel/tool-labels.js";

const SERVER = "browzy-in-chrome-browser"; // host/agent/tools/adapter.js's SDK_MCP_SERVER_NAME
const qualify = (name) => `mcp__${SERVER}__${name}`;

const results = [];
function test(name, fn) {
  try {
    fn();
    results.push({ ok: true });
    console.log(`  PASS  ${name}`);
  } catch (err) {
    results.push({ ok: false });
    console.log(`  FAIL  ${name} — ${err.message}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

console.log("\nMCP-qualified tool names in the transcript\n");

test("every registry tool gets the same label qualified or plain", () => {
  for (const t of TOOLS) {
    const plain = humanToolLabel(t.name, {});
    const qualified = humanToolLabel(qualify(t.name), {});
    assert(qualified === plain, `${t.name}: qualified label "${qualified}" must equal plain "${plain}"`);
  }
});

test("no registry tool falls through to the raw-name fallback", () => {
  for (const t of TOOLS) {
    const label = humanToolLabel(qualify(t.name), {});
    assert(!label.includes("mcp__"), `${t.name}: label leaked the wire name — "${label}"`);
    assert(!/^Đã gọi công cụ /.test(label), `${t.name}: fell through to the generic fallback — "${label}"`);
  }
});

test("the operator's exact reported names read naturally", () => {
  assert(humanToolLabel(qualify("get_page_text"), {}) === "Đã đọc nội dung trang", "get_page_text");
  assert(humanToolLabel(qualify("computer"), { action: "screenshot" }) === "Đã chụp trang", "computer/screenshot");
});

test("in-progress labels are normalized too", () => {
  assert(humanToolLabelRunning(qualify("get_page_text"), {}) === humanToolLabelRunning("get_page_text", {}), "get_page_text");
  assert(humanToolLabelRunning(qualify("navigate"), {}) === humanToolLabelRunning("navigate", {}), "navigate");
});

test("secret redaction still fires on a qualified name", () => {
  const args = { selector: "#password", text: "hunter2" };
  assert(isSensitiveTypedInput("form_input", args), "precondition: plain name is detected as sensitive");
  assert(isSensitiveTypedInput(qualify("form_input"), args), "a qualified name must not bypass redaction");
});

test("detail summaries are normalized too", () => {
  const args = { url: "https://example.com" };
  assert(summarizeArgsForDetail(qualify("navigate"), args) === summarizeArgsForDetail("navigate", args), "navigate detail");
});

test("plain and built-in names are untouched", () => {
  assert(baseToolName("get_page_text") === "get_page_text", "plain name");
  assert(baseToolName("Skill") === "Skill", "built-in");
  assert(humanToolLabel("Skill", {}).length > 0, "Skill still labelled");
});

test("a renamed server cannot reintroduce raw names", () => {
  assert(baseToolName("mcp__some-other-server__navigate") === "navigate", "server-agnostic");
  assert(humanToolLabel("mcp__some-other-server__navigate", {}) === humanToolLabel("navigate", {}), "label survives a server rename");
});

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
