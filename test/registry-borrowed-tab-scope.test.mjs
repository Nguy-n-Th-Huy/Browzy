#!/usr/bin/env node
// Task 6.1's borrowed-tab-scope extension (design.md 5b) — behavioral tests
// against the REAL, SHIPPED extension/background.js source, extracted the
// same way test/handlers.test.mjs and test/registry-baseline.test.mjs
// already do (test/_extract.mjs's brace-matching extractor), never a
// paraphrase of it.
//
// Every one of the extracted pieces below (isInGroup, isTabInWireScope,
// sdkTabsContext, and the tabs_context_mcp/tabs_create_mcp/tabs_close_mcp
// handlers) is compiled ONCE into one shared closure, so mutations one call
// makes (sdkAgentCreatedTabs gaining a tab, tabGroupId being set) are
// genuinely observed by the next call — exactly like the real module, and
// exactly like test/handlers.test.mjs's own `mk(...)` pattern.
//
// Proves the acceptance matrix directly:
//   - read-only borrowed access works
//   - cleanup never closes or regroups a borrowed tab
//   - mutation without task authorization is rejected (background.js's own,
//     second, independent layer — see tabs_close_mcp's own comment; the
//     PRIMARY gate is host/agent/tools/mapping.js's enforceBorrowedTabScope,
//     covered in test/registry-sdk-mapping.test.mjs)
//   - legacy managed-group behavior is unchanged (byte-identical rejection
//     text, byte-identical control flow, when currentToolMeta is never set)
//
// Run: node test/registry-borrowed-tab-scope.test.mjs

import { extractFunction, extractMethod } from "./_extract.mjs";

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  PASS  ${name}`);
  } catch (err) {
    results.push({ name, ok: false, err: err.message });
    console.log(`  FAIL  ${name} — ${err.stack || err.message}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// --- fake chrome.* -----------------------------------------------------
// Mirrors test/handlers.test.mjs's mkChrome, extended with tabGroups.get and
// debugger.detach for tabs_close_mcp's real code path.
function mkChrome(state) {
  const calls = [];
  const rec = (name, arg) => calls.push({ name, arg });
  const chrome = {
    tabs: {
      create: async (o) => {
        rec("tabs.create", o);
        const t = { id: state.nextTabId++, windowId: o.windowId ?? state.curWin, groupId: -1 };
        state.tabs.push(t);
        return t;
      },
      group: async (o) => {
        rec("tabs.group", o);
        for (const id of o.tabIds) {
          const t = state.tabs.find((t) => t.id === id);
          if (t) t.groupId = o.groupId ?? state.groupId;
        }
        return o.groupId ?? state.groupId;
      },
      query: async (q) => {
        rec("tabs.query", q);
        if (q.groupId !== undefined) return state.tabs.filter((t) => t.groupId === q.groupId);
        return state.tabs.slice();
      },
      get: async (id) => {
        rec("tabs.get", id);
        const t = state.tabs.find((t) => t.id === id);
        if (!t) throw new Error("no tab " + id);
        return t;
      },
      remove: async (ids) => {
        rec("tabs.remove", ids);
        const arr = Array.isArray(ids) ? ids : [ids];
        state.tabs = state.tabs.filter((t) => !arr.includes(t.id));
      }
    },
    tabGroups: {
      get: async (id) => {
        if (id !== state.groupId) throw new Error("no such group");
        return { id: state.groupId, title: "MCP" };
      },
      update: async () => {}
    },
    debugger: {
      detach: async () => {}
    }
  };
  return { chrome, calls };
}

function formatTabContext(tabs) {
  return {
    content: [
      { type: "text", text: JSON.stringify({ availableTabs: tabs.map((t) => ({ tabId: t.id })) }) + "\n\nTab Context" }
    ]
  };
}

/** Compile isInGroup + isTabInWireScope + sdkTabsContext + the three
 * tabs_*_mcp handlers together, sharing ONE closure, so state genuinely
 * persists across calls within one built harness (matches the real module,
 * and test/handlers.test.mjs's own established pattern). */
function buildHarness({ initialTabs = [], groupId = null } = {}) {
  const src = [
    extractFunction("isTabInWireScope"),
    extractFunction("isInGroup"),
    extractFunction("sdkTabsContext"),
    `const H_tabs_context_mcp = { ${extractMethod("tabs_context_mcp")} };`,
    `const H_tabs_create_mcp = { ${extractMethod("tabs_create_mcp")} };`,
    `const H_tabs_close_mcp = { ${extractMethod("tabs_close_mcp")} };`,
    // Small glue, not extracted from the shipped file: lets this harness set
    // the module-level currentToolMeta the exact way handleToolRequest()
    // does (see that function's own comment in background.js), without
    // extracting handleToolRequest's unrelated logging/audit machinery too.
    `function __setMeta(m) { currentToolMeta = m; }`,
    `function __getSdkAgentCreatedTabs() { return sdkAgentCreatedTabs; }`
  ].join("\n\n");

  const state = { tabs: initialTabs.map((t) => ({ ...t })), groupId, curWin: 1, nextTabId: 1000 };
  const { chrome, calls } = mkChrome(state);

  const mk = new Function(
    "chrome",
    "tabGroupId",
    "tabGroupTabs",
    "attachedTabs",
    "sdkAgentCreatedTabs",
    "ensureTabGroup",
    "formatTabContext",
    "currentToolMeta",
    `${src}\nreturn { H_tabs_context_mcp, H_tabs_create_mcp, H_tabs_close_mcp, isInGroup, __setMeta, __getSdkAgentCreatedTabs };`
  );
  const H = mk(
    chrome,
    groupId,
    new Set(initialTabs.filter((t) => t.groupId === groupId).map((t) => t.id)),
    new Map(),
    new Set(),
    async () => {}, // ensureTabGroup: legacy-path-only branch this suite does not exercise (SDK path never calls it)
    formatTabContext,
    undefined
  );
  return { H, chrome, calls, state };
}

console.log("\nSDK path: isInGroup() uses the run's tab scope, never the Chrome tab group\n");

await test("a borrowed tab (never added to any Chrome group) is authorized under SDK-path scope", async () => {
  const { H } = buildHarness({ initialTabs: [{ id: 5, groupId: -1 }] }); // groupId -1 = not in ANY Chrome group — the real shape of a borrowed tab
  H.__setMeta({ runId: "run_1", tabScope: [5] });
  assert((await H.isInGroup(5)) === true, "a tab in the run's tabScope must be authorized even though it is not in any Chrome group");
  H.__setMeta(undefined);
});

await test("a tab outside the run's tabScope is rejected under SDK-path scope", async () => {
  const { H } = buildHarness({ initialTabs: [{ id: 5, groupId: -1 }] });
  H.__setMeta({ runId: "run_1", tabScope: [5] });
  assert((await H.isInGroup(999)) === false, "a tabId outside tabScope must be rejected");
});

await test("legacy path (no currentToolMeta) is BYTE-IDENTICAL to before: only a tab in the real Chrome group is authorized", async () => {
  const { H } = buildHarness({ initialTabs: [{ id: 5, groupId: 55 }, { id: 6, groupId: -1 }], groupId: 55 });
  assert((await H.isInGroup(5)) === true, "a tab genuinely in the Chrome group must still be authorized");
  assert((await H.isInGroup(6)) === false, "a tab NOT in the Chrome group must still be rejected — legacy behavior unaffected");
});

console.log("\nRead-only borrowed access works\n");

await test("tabs_context_mcp under SDK-path scope reports the run's own tabs (borrowed + agent-created), never touching the Chrome group", async () => {
  const { H, calls } = buildHarness({ initialTabs: [{ id: 7, groupId: -1 }] });
  H.__setMeta({ runId: "run_1", tabScope: [7] });
  const result = await H.H_tabs_context_mcp.tabs_context_mcp({});
  assert(!calls.some((c) => c.name === "tabs.group"), "reporting SDK-path context must never call chrome.tabs.group (never regroups a borrowed tab)");
  assert(/current page/.test(result.content[0].text), `must describe the borrowed tab as read-only current-page context, got: ${result.content[0].text}`);
  assert(/\[7\]/.test(result.content[0].text), "must name the actual borrowed tabId");
});

await test("tabs_context_mcp legacy path (no meta) is unchanged: reports 'No MCP tab group exists' when none does", async () => {
  const { H } = buildHarness({ initialTabs: [] });
  const result = await H.H_tabs_context_mcp.tabs_context_mcp({ createIfEmpty: false });
  assert(/No MCP tab group exists/.test(result.content[0].text), "legacy no-group message must be byte-identical to before");
});

console.log("\nAgent-created vs. borrowed tab distinction\n");

await test("tabs_create_mcp under SDK-path scope records the new tab as agent-created", async () => {
  const { H, calls } = buildHarness({ initialTabs: [] });
  H.__setMeta({ runId: "run_1", tabScope: "any" });
  const result = await H.H_tabs_create_mcp.tabs_create_mcp({});
  const m = result.content[0].text.match(/Tab ID: (\d+)/);
  assert(m, "must report the created tab's id, exactly like the legacy path");
  const newTabId = Number(m[1]);
  assert(H.__getSdkAgentCreatedTabs().has(newTabId), "the new tab must be recorded as agent-created for this run");
  assert(calls.some((c) => c.name === "tabs.create"), "must still actually create a real tab (unchanged mechanism)");
});

await test("tabs_create_mcp legacy path (no meta) records nothing in sdkAgentCreatedTabs", async () => {
  const { H } = buildHarness({ initialTabs: [] });
  await H.H_tabs_create_mcp.tabs_create_mcp({});
  assert(H.__getSdkAgentCreatedTabs().size === 0, "legacy tab creation must never populate the SDK-only agent-created-tab set");
});

console.log("\nCleanup never closes or regroups a borrowed tab\n");

await test("tabs_close_mcp REFUSES to close a borrowed tab (in scope, never created by this run)", async () => {
  const { H, calls, state } = buildHarness({ initialTabs: [{ id: 42, groupId: -1 }] }); // borrowed: pre-existing, ungrouped
  H.__setMeta({ runId: "run_1", tabScope: [42] });
  const result = await H.H_tabs_close_mcp.tabs_close_mcp({ tabId: 42 });
  assert(/Refused to close/.test(result.content[0].text), `must explicitly refuse, got: ${result.content[0].text}`);
  assert(/42/.test(result.content[0].text), "must name the exact refused tab");
  assert(!calls.some((c) => c.name === "tabs.remove"), "chrome.tabs.remove must NEVER be called for a borrowed tab");
  assert(state.tabs.some((t) => t.id === 42), "the borrowed tab must still exist afterward");
});

await test("tabs_close_mcp ALLOWS closing a tab this same run created", async () => {
  const { H, calls, state } = buildHarness({ initialTabs: [] });
  H.__setMeta({ runId: "run_1", tabScope: "any" });
  const created = await H.H_tabs_create_mcp.tabs_create_mcp({});
  const newTabId = Number(created.content[0].text.match(/Tab ID: (\d+)/)[1]);

  const result = await H.H_tabs_close_mcp.tabs_close_mcp({ tabId: newTabId });
  assert(/Closed 1 tab\(s\)/.test(result.content[0].text), `must report the close succeeded, got: ${result.content[0].text}`);
  assert(calls.some((c) => c.name === "tabs.remove" && (Array.isArray(c.arg) ? c.arg.includes(newTabId) : c.arg === newTabId)), "chrome.tabs.remove must be called for the run's own tab");
  assert(!state.tabs.some((t) => t.id === newTabId), "the agent-created tab must actually be gone afterward");
});

await test("tabs_close_mcp legacy path (no meta) is unchanged: only a tab in the real Chrome group can be closed", async () => {
  const { H, calls } = buildHarness({ initialTabs: [{ id: 5, groupId: 55 }, { id: 6, groupId: -1 }], groupId: 55 });
  const refused = await H.H_tabs_close_mcp.tabs_close_mcp({ tabId: 6 });
  assert(
    refused.content[0].text ===
      "None of the requested tabs are in the MCP group. Requested: [6]. Use tabs_context_mcp to see what is in the group.",
    `legacy rejection text must be byte-identical to before, got: ${refused.content[0].text}`
  );
  assert(!calls.some((c) => c.name === "tabs.remove"), "must not close a tab outside the legacy group");

  const ok = await H.H_tabs_close_mcp.tabs_close_mcp({ tabId: 5 });
  assert(/Closed 1 tab\(s\)/.test(ok.content[0].text), "a tab genuinely in the legacy group must still close normally");
});

console.log("\nStructural: tabs_close_mcp captures its own meta snapshot at entry (race-safety against a concurrent dispatch's currentToolMeta)\n");

await test("tabs_close_mcp's shipped source captures currentToolMeta into a local BEFORE its first internal await, and never re-reads the module-level variable inside its loop", () => {
  const src = extractMethod("tabs_close_mcp");
  const captureIdx = src.indexOf("const requestMeta = currentToolMeta;");
  assert(captureIdx !== -1, "must capture currentToolMeta into a local variable");
  // Strip `//` line comments before checking for `await` — this handler's
  // own explanatory comment (correctly) mentions "await"s in prose above the
  // capture line, which must not be mistaken for actual code.
  const codeOnly = src
    .slice(0, captureIdx)
    .split("\n")
    .map((line) => line.replace(/\/\/.*/, ""))
    .join("\n");
  assert(!/\bawait\b/.test(codeOnly), "the capture must happen before this handler's first REAL await statement — nothing may yield to the event loop first");
  // Everything after the capture point must read `requestMeta`, never
  // `currentToolMeta` again — the whole point of the local snapshot.
  const afterCapture = src.slice(captureIdx + "const requestMeta = currentToolMeta;".length);
  assert(!/[^.]currentToolMeta/.test(afterCapture), "after the initial capture, this handler must only ever read the local requestMeta, never re-read the module-level currentToolMeta");
});

const failed = results.filter((r) => !r.ok);
console.log(
  `\n${results.length - failed.length}/${results.length} passed` +
    (failed.length ? `\n\nFailures:\n${failed.map((f) => `  - ${f.name}: ${f.err}`).join("\n")}` : "") +
    "\n"
);
process.exit(failed.length ? 1 : 0);
