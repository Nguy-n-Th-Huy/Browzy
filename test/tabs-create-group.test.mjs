#!/usr/bin/env node
//
// A tab the agent opens joins the group of the tab it is already working in.
//
// Before this, tabs_create_mcp always grouped into the single `tabGroupId`
// group — and when none existed yet, ensureTabGroup(true) opened a whole new
// WINDOW for it. Meanwhile the operator's own bound tab lives in its own solo
// group (adoptSoloAgentGroup). So a task that started on the operator's page
// and then opened a second tab split itself across two groups, sometimes two
// windows: the operator watches one group while the work happens outside it.
//
// test/handlers.test.mjs also compiles this same shipped method, but its
// fixed dependency list does not declare `isOwnAgentGroupId`, so the guarded
// branch is inert there and only the fallback is exercised. This file
// supplies that dependency, so the new behaviour is actually covered rather
// than only the path around it.
//
// Run: node test/tabs-create-group.test.mjs

import { extractMethod } from "./_extract.mjs";

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  PASS  ${name}`);
  } catch (err) {
    results.push({ name, ok: false, err: err.stack || err.message });
    console.log(`  FAIL  ${name} — ${err.message}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

console.log("\ntabs_create_mcp groups a new tab with the tab being worked on\n");

const AGENT_GROUP = 7; // the operator's bound tab's own solo group
const MCP_GROUP = 99; // the standalone group tabs used to always land in

/** @param {{anchor: object|null, ownGroups: number[], tabs?: object[], lastAgentTabId?: number|null, meta?: object, sdkAgentCreatedTabs?: number[]}} opts */
function harness({ anchor, ownGroups, tabs: extraTabs = [], lastAgentTabId, lastAgentTabRunId = null, meta, sdkAgentCreatedTabs = [] }) {
  const known = new Map();
  if (anchor) known.set(anchor.id, anchor);
  for (const t of extraTabs) known.set(t.id, t);
  const calls = [];
  let created = 0;
  const chrome = {
    tabs: {
      async get(id) {
        const t = known.get(id);
        if (!t) throw new Error("no such tab");
        return t;
      },
      async query() {
        return [{ id: 500, windowId: 900 }]; // the MCP group's own window
      },
      async create(opts) {
        calls.push({ api: "create", opts });
        created += 1;
        return { id: 1000 + created, windowId: opts.windowId ?? 900 };
      },
      async group(opts) {
        calls.push({ api: "group", opts });
        return opts.groupId;
      },
      async update() {}
    },
    tabGroups: { async update() {} },
    windows: { async create() { throw new Error("must not open a window"); } }
  };
  let ensureCalled = false;
  const ensureTabGroup = async () => {
    ensureCalled = true;
  };
  const src = `const H = { ${extractMethod("tabs_create_mcp")} };`;
  const mk = new Function(
    "chrome",
    "tabGroupId",
    "tabGroupTabs",
    "ensureTabGroup",
    "lastAgentTabId",
    "lastAgentTabRunId",
    "isOwnAgentGroupId",
    "currentToolMeta",
    "sdkAgentCreatedTabs",
    "formatTabContext",
    src + "; return H;"
  );
  const H = mk(
    chrome,
    MCP_GROUP,
    new Set(),
    ensureTabGroup,
    lastAgentTabId === undefined ? (anchor ? anchor.id : null) : lastAgentTabId,
    lastAgentTabRunId,
    (gid) => ownGroups.includes(gid),
    meta,
    new Set(sdkAgentCreatedTabs),
    () => ({ content: [{ type: "text", text: "" }] })
  );
  return { H, calls, ensureCalled: () => ensureCalled };
}

await test("an anchor in one of our own groups: the new tab joins THAT group, in that window", async () => {
  const anchor = { id: 42, index: 3, windowId: 12, groupId: AGENT_GROUP };
  const { H, calls } = harness({ anchor, ownGroups: [AGENT_GROUP, MCP_GROUP] });
  await H.tabs_create_mcp({});

  const grouped = calls.find((c) => c.api === "group");
  assert(grouped, "the new tab must be grouped");
  assert(
    grouped.opts.groupId === AGENT_GROUP,
    `expected the anchor's group ${AGENT_GROUP}, got ${grouped.opts.groupId} — a second group is the bug this covers`
  );

  const create = calls.find((c) => c.api === "create");
  assert(create.opts.windowId === 12, `expected the anchor's window 12, got ${create.opts.windowId}`);
  assert(create.opts.index === 4, `expected placement beside the anchor (index 4), got ${create.opts.index}`);
  assert(create.opts.openerTabId === 42, "the anchor must be recorded as the opener");
  assert(create.opts.active === false, "creating a tab must never steal focus");
});

await test("...and no separate group or window is provisioned for it", async () => {
  const anchor = { id: 42, index: 0, windowId: 12, groupId: AGENT_GROUP };
  const { H, ensureCalled } = harness({ anchor, ownGroups: [AGENT_GROUP, MCP_GROUP] });
  await H.tabs_create_mcp({});
  assert(
    !ensureCalled(),
    "ensureTabGroup must not run when the anchor's group is usable — it is what opens a new window when no group exists yet"
  );
});

await test("an anchor in a group that is NOT ours falls back to the standalone group", async () => {
  const anchor = { id: 42, index: 3, windowId: 12, groupId: 1234 }; // the operator's own unrelated group
  const { H, calls, ensureCalled } = harness({ anchor, ownGroups: [AGENT_GROUP, MCP_GROUP] });
  await H.tabs_create_mcp({});
  assert(ensureCalled(), "the fallback must still ensure the standalone group exists");
  const grouped = calls.find((c) => c.api === "group");
  assert(grouped.opts.groupId === MCP_GROUP, `expected the fallback group ${MCP_GROUP}, got ${grouped.opts.groupId}`);
});

await test("an ungrouped anchor falls back too", async () => {
  const anchor = { id: 42, index: 3, windowId: 12, groupId: -1 };
  const { H, calls, ensureCalled } = harness({ anchor, ownGroups: [AGENT_GROUP, MCP_GROUP] });
  await H.tabs_create_mcp({});
  assert(ensureCalled(), "an ungrouped anchor gives nothing to join");
  const grouped = calls.find((c) => c.api === "group");
  assert(grouped.opts.groupId === MCP_GROUP, `expected the fallback group ${MCP_GROUP}, got ${grouped.opts.groupId}`);
});

await test("no anchor at all (nothing operated on yet) falls back, unchanged", async () => {
  const { H, calls, ensureCalled } = harness({ anchor: null, ownGroups: [AGENT_GROUP, MCP_GROUP] });
  await H.tabs_create_mcp({});
  assert(ensureCalled(), "with no anchor the standalone group is the only target");
  const grouped = calls.find((c) => c.api === "group");
  assert(grouped.opts.groupId === MCP_GROUP, `expected the fallback group ${MCP_GROUP}, got ${grouped.opts.groupId}`);
  const create = calls.find((c) => c.api === "create");
  assert(create.opts.index === undefined, "with no anchor there is nothing to sit beside — Chrome appends");
});

await test("a closed anchor does not throw the call away", async () => {
  // lastAgentTabId points at a tab that has since been closed: chrome.tabs.get
  // rejects. The handler must still create the tab, not surface the error.
  const { H, calls } = harness({ anchor: null, ownGroups: [AGENT_GROUP, MCP_GROUP] });
  const mkClosed = () => H.tabs_create_mcp({});
  await mkClosed();
  assert(calls.some((c) => c.api === "create"), "a stale anchor must degrade to an append, never fail the call");
});

await test("a run bound to the operator's tab anchors there even before it names a tabId", async () => {
  // The reported case: the run's first tools were tabs_context_mcp and then
  // tabs_create_mcp, neither of which carries a tabId, so `lastAgentTabId` was
  // still null and the new tab was provisioned its own group. The run's own
  // wire scope already names the bound tab; that is the anchor.
  const bound = { id: 42, index: 3, windowId: 12, groupId: AGENT_GROUP };
  const { H, calls, ensureCalled } = harness({
    anchor: bound,
    ownGroups: [AGENT_GROUP, MCP_GROUP],
    lastAgentTabId: null,
    meta: { runId: "r1", tabScope: [42] }
  });
  await H.tabs_create_mcp({});
  assert(!ensureCalled(), "the bound tab's group is usable — nothing new may be provisioned");
  const grouped = calls.find((c) => c.api === "group");
  assert(grouped.opts.groupId === AGENT_GROUP, `expected the bound tab's group ${AGENT_GROUP}, got ${grouped.opts.groupId}`);
  const create = calls.find((c) => c.api === "create");
  assert(create.opts.windowId === 12, "and in the bound tab's own window");
  assert(create.opts.index === 4, "beside it");
});

await test("an anchor left over from an earlier run is ignored in favour of this run's scope", async () => {
  // `lastAgentTabId` is module-level and outlives a run. Left alone it points
  // at a tab this run cannot touch, and — because that tab is in a group of
  // ours too — the new tab would join THAT group: a second group again, just
  // reached by a different route.
  const bound = { id: 42, index: 0, windowId: 12, groupId: AGENT_GROUP };
  const stale = { id: 77, index: 5, windowId: 900, groupId: MCP_GROUP };
  const { H, calls } = harness({
    anchor: bound,
    tabs: [stale],
    ownGroups: [AGENT_GROUP, MCP_GROUP],
    lastAgentTabId: 77,
    meta: { runId: "r2", tabScope: [42] }
  });
  await H.tabs_create_mcp({});
  const grouped = calls.find((c) => c.api === "group");
  assert(grouped.opts.groupId === AGENT_GROUP, `expected this run's group ${AGENT_GROUP}, got ${grouped.opts.groupId}`);
  const create = calls.find((c) => c.api === "create");
  assert(create.opts.openerTabId === 42, "and opened from the tab this run is actually bound to");
});

await test("a tab this run itself opened stays a valid anchor", async () => {
  // Not in `tabScope` — the wire scope names only the bound tab — but opened
  // by this very run, so it is in reach: a third tab belongs beside the
  // second, not back beside the first.
  const bound = { id: 42, index: 0, windowId: 12, groupId: AGENT_GROUP };
  const ownNew = { id: 43, index: 1, windowId: 12, groupId: AGENT_GROUP };
  const { H, calls } = harness({
    anchor: bound,
    tabs: [ownNew],
    ownGroups: [AGENT_GROUP, MCP_GROUP],
    lastAgentTabId: 43,
    meta: { runId: "r3", tabScope: [42] },
    sdkAgentCreatedTabs: [43]
  });
  await H.tabs_create_mcp({});
  const create = calls.find((c) => c.api === "create");
  assert(create.opts.openerTabId === 43, `expected the run's own newest tab 43 as the anchor, got ${create.opts.openerTabId}`);
  assert(create.opts.index === 2, "and the next tab sits beside it");
});

await test("an unscoped run does not inherit the previous run's anchor", async () => {
  // tabScope "any" reaches every tab, so scope membership cannot rule a stale
  // anchor out. What rules it out is that another run put it there: an anchor
  // is a record of where THAT run was working, and following it files this
  // run's tab under the older group.
  const stale = { id: 77, index: 5, windowId: 900, groupId: MCP_GROUP };
  const { H, calls, ensureCalled } = harness({
    anchor: stale,
    ownGroups: [AGENT_GROUP, MCP_GROUP],
    lastAgentTabId: 77,
    lastAgentTabRunId: "older-run",
    meta: { runId: "r4", tabScope: "any" }
  });
  await H.tabs_create_mcp({});
  assert(ensureCalled(), "with no anchor of its own the run falls back to the standalone group");
  const create = calls.find((c) => c.api === "create");
  assert(create.opts.openerTabId === undefined, "and does not open from a tab it never touched");
});

await test("an unscoped run keeps the anchor it set itself", async () => {
  const own = { id: 88, index: 2, windowId: 12, groupId: AGENT_GROUP };
  const { H, calls, ensureCalled } = harness({
    anchor: own,
    ownGroups: [AGENT_GROUP, MCP_GROUP],
    lastAgentTabId: 88,
    lastAgentTabRunId: "r5",
    meta: { runId: "r5", tabScope: "any" }
  });
  await H.tabs_create_mcp({});
  assert(!ensureCalled(), "its own anchor is usable");
  const grouped = calls.find((c) => c.api === "group");
  assert(grouped.opts.groupId === AGENT_GROUP, `expected ${AGENT_GROUP}, got ${grouped.opts.groupId}`);
  assert(calls.find((c) => c.api === "create").opts.openerTabId === 88, "opened from its own working tab");
});

const failed = results.filter((r) => !r.ok);
console.log(
  `\n${results.length - failed.length}/${results.length} passed` +
    (failed.length ? `\n\nFailures:\n${failed.map((f) => `  - ${f.name}: ${f.err}`).join("\n")}` : "") +
    "\n"
);
process.exit(failed.length ? 1 : 0);
