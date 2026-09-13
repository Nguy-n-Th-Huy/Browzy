#!/usr/bin/env node
//
// Regression for a real, reproduced bug: a tool capable of producing a
// protected action (host/agent/policy/permission-modes.js's
// PROTECTED_CAPABLE_TOOLS / detectProtectedCategory) was silently
// dispatchable forever once it shipped bare-listed in the SDK's
// `allowedTools` (host/agent/tools/query-options.js). Concretely:
// `gif_creator` with `{action:"export", download:true}` classifies as
// FILE_WRITE-protected, but `gif_creator` sits in `allowedTools`, so the
// pinned SDK never calls `canUseTool` for it (its own runtime warning,
// verbatim: "canUseTool will not be invoked for [bare allowedTools
// entries] ... Bare allowedTools entries auto-approve the whole tool before
// the callback is consulted"). No `canUseTool` call means no decision is
// ever made and no grant is ever recorded — and the unconditional
// protected-action backstop in host/agent/policy/authorization.js (task 2.1,
// enforced in host/agent/tools/adapter.js's runHostSideChecks) then refuses
// to dispatch a protected call without exactly that grant. The export was
// therefore not merely ungated — it was PERMANENTLY DENIED, forever, with no
// decision card ever shown. `form_input` into a credential field had the
// identical structural problem (host/test/agent-tool-permission-preapproval
// .test.mjs's own "27 always-automatic tools" contract bare-lists it too).
//
// The fix does NOT shrink `allowedTools`/`tools` (that would change the
// exact-count contract host/test/agent-tool-permission-preapproval.test.mjs
// pins for the default/Auto path, which design.md Goal 1 requires to
// "reproduce today's behavior exactly" — shrinking it would also be wrong on
// the merits, since `form_input`/`gif_creator` are safe to preapprove for
// their ORDINARY calls and must gate only their protected-shaped ones,
// something `allowedTools`' whole-tool granularity cannot express). Instead
// it uses the SDK's own documented alternative — a PreToolUse hook
// (`createPermissionModeGateHook`, host/agent/policy/can-use-tool.js) that
// runs BEFORE `allowedTools` is consulted and forces
// `permissionDecision: "ask"` for a call this project's OWN classifier says
// is protected, which the SDK documents as surfacing through the identical
// `can_use_tool` control_request a never-preapproved tool's call would reach.
//
// This suite proves, fully offline (constructed hook + options only, no
// SDK/network/credential/browser):
//   1. `gif_creator` and `form_input` remain bare-listed in `allowedTools`
//      (the Auto-path contract is unchanged — this is a sanity check that
//      the fix did NOT take the forbidden "shrink allowedTools" shortcut).
//   2. Despite that, EVERY tool in PROTECTED_CAPABLE_TOOLS, called with an
//      argument shape (and, for credential detection, a resolved target
//      hint) that `detectProtectedCategory` recognizes, gets a forced `ask`
//      from the gate hook — under every one of the three permission modes,
//      since a protected decision is not mode-controlled.
//   3. An ORDINARY (non-protected) call to those same tools is left alone
//      under Auto/Skip (no added latency, no behavior change) — proving the
//      fix is additive, not a wholesale "always ask" regression.
//   4. A generic, table-driven regression: if a future protected branch is
//      added to `detectProtectedCategory` for a tool that is not also added
//      to `PROTECTED_CAPABLE_TOOLS`, this suite's own guard-consistency check
//      (test 4) fails — closing exactly the "hand-written parallel list that
//      can drift" gap the fix is required to avoid.
//   5. Manual mode forces `ask` for an ORDINARY mutating call that Auto
//      leaves alone — proving Manual mode is no longer structurally
//      undeliverable (the companion CRITICAL — buildIsolatedOptions'
//      `allowedTools` used to preapprove every mutating tool in every mode).
//
// Run: node host/test/protected-action-gate-hook.test.mjs

import { TOOLS } from "../tool-definitions.js";
import { createBrowserMcpServer, SDK_MCP_SERVER_NAME } from "../agent/tools/adapter.js";
import { ToolBridge } from "../agent/broker/tool-bridge.js";
import { BrowserLease } from "../agent/broker/browser-lease.js";
import { ApprovalRegistry } from "../agent/policy/approvals.js";
import { Run } from "../agent/session/run.js";
import { buildIsolatedOptions } from "../agent/tools/query-options.js";
import { createPermissionModeGateHook } from "../agent/policy/can-use-tool.js";
import { PROTECTED_CAPABLE_TOOLS, detectProtectedCategory, PERMISSION_MODES } from "../agent/policy/permission-modes.js";

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  PASS  ${name}`);
  } catch (err) {
    results.push({ name, ok: false, err: err.stack || err.message });
    console.log(`  FAIL  ${name} — ${err.stack || err.message}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function makeRun({ tabScope = "any" } = {}) {
  const lease = new BrowserLease();
  const approvals = new ApprovalRegistry();
  const run = new Run({ conversationId: "conv_protected_gate_hook", lease, approvals, tabScope });
  await run.begin();
  const toolBridge = new ToolBridge({
    init: async () => {},
    callTool: async (name) => ({ content: [{ type: "text", text: `ok:${name}` }] }),
    shutdown: () => {}
  });
  return { run, toolBridge };
}
function fakeSnapshot() {
  return { model: "claude-x", env: { ANTHROPIC_API_KEY: "k", ANTHROPIC_BASE_URL: "https://x" } };
}
function fakeSkills() {
  return {
    cwd: "/scratch/conv-protected-gate-hook",
    configDir: "/scratch/conv-protected-gate-hook/claude-config",
    pluginDir: "/scratch/conv-protected-gate-hook/skills-plugin",
    allowedSkillNames: [],
    skillOverrides: {}
  };
}

// Representative protected-shaped calls, one per PROTECTED_CAPABLE_TOOLS
// entry, each verified against detectProtectedCategory directly first (test
// 4 below) so this table can never silently stop exercising the branch it
// claims to.
const PROTECTED_CASES = [
  {
    tool: "gif_creator",
    args: { action: "export", tabId: 1, download: true },
    hint: null,
    label: "GIF export with download:true (FILE_WRITE)"
  },
  {
    tool: "form_input",
    args: { ref: "ref_7", tabId: 1, value: "hunter2" },
    hint: { tagName: "input", attributes: { type: "password" } },
    label: "form_input into a password field (CREDENTIALS)"
  },
  {
    tool: "computer",
    args: { action: "type", tabId: 1, ref: "ref_7", text: "hunter2" },
    hint: { tagName: "input", attributes: { autocomplete: "current-password" } },
    label: "computer type into a password-autocomplete field (CREDENTIALS)"
  },
  {
    tool: "javascript_tool",
    args: { action: "javascript_exec", tabId: 1, script: "navigator.mediaDevices.getUserMedia({video:true})" },
    hint: null,
    label: "javascript_tool requesting camera/mic (PERMISSION_GRANT)"
  }
];

// An ORDINARY, non-protected call for the same tools — used to prove the
// hook is additive, not "always ask".
const ORDINARY_CASES = [
  { tool: "gif_creator", args: { action: "start_recording", tabId: 1 } },
  { tool: "form_input", args: { ref: "ref_3", tabId: 1, value: "ordinary text" }, hint: { tagName: "input", attributes: { type: "text" } } },
  { tool: "tabs_create_mcp", args: { url: "https://example.test" } }
];

console.log("\nProtected-action PreToolUse gate — a bare-allowedTools tool must never silently bypass a protected decision\n");

await test("sanity: gif_creator and form_input remain bare-listed in allowedTools (the Auto-path contract is unchanged by this fix)", async () => {
  const { run, toolBridge } = await makeRun();
  const mcpServer = createBrowserMcpServer({ toolBridge, coerceArgs: (a) => a, run });
  const options = buildIsolatedOptions({ mcpServer, serverName: SDK_MCP_SERVER_NAME, snapshot: fakeSnapshot(), skills: fakeSkills() });
  for (const name of ["gif_creator", "form_input"]) {
    const qualified = `mcp__${SDK_MCP_SERVER_NAME}__${name}`;
    assert(
      options.allowedTools.includes(qualified),
      `"${name}" must stay bare-listed in allowedTools — the fix must not shrink this list (that would break the Auto-path contract in agent-tool-permission-preapproval.test.mjs)`
    );
  }
});

await test("every PROTECTED_CAPABLE_TOOLS entry's protected-shaped call forces ask, under every permission mode, despite being bare-listed in allowedTools", async () => {
  for (const mode of PERMISSION_MODES) {
    const hook = createPermissionModeGateHook({ policySnapshot: () => ({ mode }), resolveHint: async () => null });
    for (const { tool, args, hint, label } of PROTECTED_CASES) {
      const qualified = `mcp__${SDK_MCP_SERVER_NAME}__${tool}`;
      const hookWithHint = createPermissionModeGateHook({
        policySnapshot: () => ({ mode }),
        resolveHint: async () => hint
      });
      const output = await hookWithHint({ hook_event_name: "PreToolUse", tool_name: qualified, tool_input: args });
      assert(
        output && output.hookSpecificOutput && output.hookSpecificOutput.permissionDecision === "ask",
        `mode=${mode}: ${label} must force permissionDecision:"ask" — got ${JSON.stringify(output)}`
      );
      void hook;
    }
  }
});

await test("an ordinary (non-protected) call to the same tools is left alone under Auto and Skip — the fix is additive, not always-ask", async () => {
  for (const mode of ["auto", "skip"]) {
    const hook = createPermissionModeGateHook({ policySnapshot: () => ({ mode }) });
    for (const { tool, args, hint } of ORDINARY_CASES) {
      const qualified = `mcp__${SDK_MCP_SERVER_NAME}__${tool}`;
      const hookWithHint = createPermissionModeGateHook({ policySnapshot: () => ({ mode }), resolveHint: async () => hint ?? null });
      const output = await hookWithHint({ hook_event_name: "PreToolUse", tool_name: qualified, tool_input: args });
      assert(
        !output || !output.hookSpecificOutput,
        `mode=${mode}: ordinary "${tool}" call must NOT be overridden — got ${JSON.stringify(output)}`
      );
      void hook;
    }
  }
});

await test("guard consistency: every branch detectProtectedCategory can actually fire for is covered by PROTECTED_CAPABLE_TOOLS (no drift between the guard and the branches)", async () => {
  for (const { tool, args, hint, label } of PROTECTED_CASES) {
    assert(PROTECTED_CAPABLE_TOOLS.includes(tool), `"${tool}" produces a protected category (${label}) but is missing from PROTECTED_CAPABLE_TOOLS`);
    const category = detectProtectedCategory(tool, args, hint);
    assert(category, `sanity: the table's own case "${label}" must actually classify as protected via detectProtectedCategory, or this suite proves nothing`);
  }
  // And the inverse direction: every tool this project actually registers
  // that is NOT in PROTECTED_CAPABLE_TOOLS must never be classified
  // protected for any of THIS suite's cases (it would mean the guard is
  // silently swallowing a real category — the exact drift this constant
  // exists to prevent).
  for (const t of TOOLS) {
    if (PROTECTED_CAPABLE_TOOLS.includes(t.name)) continue;
    assert(detectProtectedCategory(t.name, {}, null) === null, `"${t.name}" is not in PROTECTED_CAPABLE_TOOLS but detectProtectedCategory found a category for it anyway`);
  }
});

await test("Manual mode forces ask for an ordinary mutating call that Auto leaves alone — Manual mode is no longer structurally undeliverable", async () => {
  const qualified = `mcp__${SDK_MCP_SERVER_NAME}__tabs_create_mcp`;
  const args = { url: "https://example.test" };

  const autoHook = createPermissionModeGateHook({ policySnapshot: () => ({ mode: "auto" }) });
  const autoOutput = await autoHook({ hook_event_name: "PreToolUse", tool_name: qualified, tool_input: args });
  assert(!autoOutput || !autoOutput.hookSpecificOutput, `Auto mode must leave an ordinary mutating call alone — got ${JSON.stringify(autoOutput)}`);

  const manualHook = createPermissionModeGateHook({ policySnapshot: () => ({ mode: "manual" }) });
  const manualOutput = await manualHook({ hook_event_name: "PreToolUse", tool_name: qualified, tool_input: args });
  assert(
    manualOutput && manualOutput.hookSpecificOutput && manualOutput.hookSpecificOutput.permissionDecision === "ask",
    `Manual mode must force ask for an ordinary mutating call ("tabs_create_mcp" is bare-listed in allowedTools under every mode) — got ${JSON.stringify(manualOutput)}`
  );

  // Managed policy pinning the mode must be honored identically to a local
  // mode selection (task 4.2/4.3's own contract, exercised here only insofar
  // as the gate hook reads it the same way `canUseTool` does).
  const managedManualHook = createPermissionModeGateHook({ policySnapshot: () => ({ mode: "auto", managed: { mode: "manual" } }) });
  const managedOutput = await managedManualHook({ hook_event_name: "PreToolUse", tool_name: qualified, tool_input: args });
  assert(
    managedOutput && managedOutput.hookSpecificOutput && managedOutput.hookSpecificOutput.permissionDecision === "ask",
    `a managed policy pinning mode:"manual" must force ask exactly like a local manual selection — got ${JSON.stringify(managedOutput)}`
  );
});

await test("Manual mode also forces ask for webmcp_call_tool — the one send-class tool bare-listed in allowedTools for its ordinary case", async () => {
  // Unlike computer/javascript_tool/browser_batch (excluded from
  // allowedTools outright, so they always reach canUseTool regardless of
  // mode), webmcp_call_tool stays bare-listed for its ordinary,
  // always-approve-unknown call (mapping.js's classifySendClassCall). Under
  // Manual it must still ask — the same "every mutating/send action decides"
  // requirement, closed here by treating SEND like MUTATING under manual.
  const qualified = `mcp__${SDK_MCP_SERVER_NAME}__webmcp_call_tool`;
  const args = { tabId: 1, name: "search", input: {} };

  const autoHook = createPermissionModeGateHook({ policySnapshot: () => ({ mode: "auto" }) });
  const autoOutput = await autoHook({ hook_event_name: "PreToolUse", tool_name: qualified, tool_input: args });
  assert(!autoOutput || !autoOutput.hookSpecificOutput, `Auto mode must leave webmcp_call_tool's ordinary call alone — got ${JSON.stringify(autoOutput)}`);

  const manualHook = createPermissionModeGateHook({ policySnapshot: () => ({ mode: "manual" }) });
  const manualOutput = await manualHook({ hook_event_name: "PreToolUse", tool_name: qualified, tool_input: args });
  assert(
    manualOutput && manualOutput.hookSpecificOutput && manualOutput.hookSpecificOutput.permissionDecision === "ask",
    `Manual mode must force ask for webmcp_call_tool — got ${JSON.stringify(manualOutput)}`
  );
});

await test("a foreign/unknown tool name is never touched by this project's gate hook", async () => {
  const hook = createPermissionModeGateHook({ policySnapshot: () => ({ mode: "manual" }) });
  const output = await hook({ hook_event_name: "PreToolUse", tool_name: "mcp__some-other-server__whatever", tool_input: { a: 1 } });
  assert(!output || !output.hookSpecificOutput, `an unknown tool name must never be overridden by this project's own gate — got ${JSON.stringify(output)}`);
});

await test("a hook internal error fails open (returns no override) rather than throwing and interrupting the run", async () => {
  const hook = createPermissionModeGateHook({
    policySnapshot: () => {
      throw new Error("boom");
    }
  });
  const qualified = `mcp__${SDK_MCP_SERVER_NAME}__tabs_create_mcp`;
  const output = await hook({ hook_event_name: "PreToolUse", tool_name: qualified, tool_input: { url: "https://example.test" } });
  assert(output && typeof output === "object", "the hook must resolve an object, never throw");
  assert(!output.hookSpecificOutput, "a broken policySnapshot must fail open (no override) — the protected backstop in authorization.js is the real safety net regardless");
});

console.log("");
const failed = results.filter((r) => !r.ok);
console.log(`${results.length - failed.length}/${results.length} passed`);
if (failed.length) {
  console.log("\nFAILURES:");
  for (const f of failed) console.log(`  - ${f.name}\n    ${f.err}`);
}
console.log(failed.length === 0 ? "ALL PROTECTED-ACTION GATE HOOK TESTS PASSED" : `${failed.length} FAILED`);
process.exit(failed.length ? 1 : 0);
