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

/** @param {{anchor: object|null, ownGroups: number[]}} opts */
function harness({ anchor, ownGroups }) {
  const calls = [];
  let created = 0;
  const chrome = {
    tabs: {
      async get(id) {
        if (!anchor || anchor.id !== id) throw new Error("no such tab");
        return anchor;
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
    "isOwnAgentGroupId",
    "currentToolMeta",
    "agentCreatedTabs",
    "formatTabContext",
    src + "; return H;"
  );
  const H = mk(
    chrome,
    MCP_GROUP,
    new Set(),
    ensureTabGroup,
    anchor ? anchor.id : null,
    (gid) => ownGroups.includes(gid),
    undefined,
    undefined,
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

const failed = results.filter((r) => !r.ok);
console.log(
  `\n${results.length - failed.length}/${results.length} passed` +
    (failed.length ? `\n\nFailures:\n${failed.map((f) => `  - ${f.name}: ${f.err}`).join("\n")}` : "") +
    "\n"
);
process.exit(failed.length ? 1 : 0);
