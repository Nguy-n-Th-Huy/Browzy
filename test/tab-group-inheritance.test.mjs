// The agent's tab group must hold only tabs the agent opened.
//
// Chrome gives a tab opened FROM a grouped tab that same group — a link the
// operator ctrl-clicks on a page the assistant is driving, a target=_blank,
// a window.open. Nothing in the tabs API says who did the clicking, so before
// this guard existed the operator's own tab silently joined the agent's group.
// That is not merely a mislabelled tab strip: isInGroup()'s legacy branch
// grants authority by group membership alone, so an inherited operator tab
// became a tab an external MCP client was allowed to drive.
//
// This exercises the SHIPPED guardInheritedTabGroup() out of
// extension/background.js (via test/_extract.mjs's brace-matching extractor),
// not a paraphrase of it.

import fs from "node:fs";
import { extractFunction, BACKGROUND } from "./_extract.mjs";

let fail = 0;
const ok = (cond, msg) => { console.log((cond ? "  PASS  " : "  FAIL  ") + msg); if (!cond) fail++; };

const BG_SRC = fs.readFileSync(BACKGROUND, "utf8");
const NEW_TAB_URL_CONST = (BG_SRC.match(/const BROWSER_NEW_TAB_URL = [^;]+;/) || [])[0];
if (!NEW_TAB_URL_CONST) throw new Error("BROWSER_NEW_TAB_URL declaration not found in background.js");
// The guard's blank-new-tab rule is the SHIPPED one, compiled in alongside it —
// not a paraphrase — so a change to either half is caught here.
const SRC = [
  NEW_TAB_URL_CONST,
  extractFunction("isBlankNewTab"),
  extractFunction("looksLikeOperatorNewTab"),
  extractFunction("guardInheritedTabGroup")
].join("\n");
const AGENT_GROUP = 7;

/**
 * Compile the shipped guard against a scripted stand-in for the module-level
 * state it closes over in background.js.
 *
 * `toolRunning` decides whether `currentToolMeta` is even declared in the
 * compiled scope, which is exactly the distinction the guard's `typeof` check
 * is written against.
 */
function build(opts) {
  const {
    tabGroupId = AGENT_GROUP,
    lastAgentTabActivityAt = 0,
    toolRunning = false,
    recoversTo,
    ungroupThrows = false,
    claimed = {},
    tabs = {}
  } = opts || {};

  const ungrouped = [];
  const tabGroupTabs = new Set(claimed.tabGroupTabs || []);
  const sdkAgentCreatedTabs = new Set(claimed.sdkAgentCreatedTabs || []);
  const adoptedBorrowedTabs = new Map((claimed.adoptedBorrowedTabs || []).map((id) => [id, -1]));
  const chrome = {
    tabs: {
      async ungroup(tabId) {
        if (ungroupThrows) throw new Error("cannot ungroup");
        ungrouped.push(tabId);
      },
      // What Chrome would report for the tab a moment after the event fired.
      // `tabs` maps tab id -> the tab record; an id absent from it stands for a
      // tab that has already closed.
      async get(tabId) {
        if (!Object.prototype.hasOwnProperty.call(tabs, tabId)) throw new Error("no such tab");
        return tabs[tabId];
      }
    }
  };

  const preamble = [
    "let tabGroupId = INITIAL_GROUP_ID;",
    "async function recoverTabGroupState() { tabGroupId = RECOVERS_TO; }",
    toolRunning ? "let currentToolMeta = { runId: 'r1' };" : ""
  ].join("\n");

  const fn = new Function(
    "chrome",
    "tabGroupTabs",
    "sdkAgentCreatedTabs",
    "adoptedBorrowedTabs",
    "INHERITED_TAB_GRACE_MS",
    "lastAgentTabActivityAt",
    "INITIAL_GROUP_ID",
    "RECOVERS_TO",
    preamble + "\n" + SRC + "\nreturn guardInheritedTabGroup;"
  )(chrome, tabGroupTabs, sdkAgentCreatedTabs, adoptedBorrowedTabs, 1500, lastAgentTabActivityAt, tabGroupId, recoversTo === undefined ? tabGroupId : recoversTo);

  return { guard: fn, ungrouped, tabGroupTabs };
}

console.log("\nAgent tab group holds only tabs the agent opened\n");

// --- The operator's tab must be evicted ----------------------------------
{
  const { guard, ungrouped, tabGroupTabs } = build({ lastAgentTabActivityAt: Date.now() - 60_000 });
  ok((await guard({ id: 42, groupId: AGENT_GROUP })) === "ungrouped", "a tab inheriting the agent group with no tool running is ungrouped");
  ok(ungrouped.length === 1 && ungrouped[0] === 42, "chrome.tabs.ungroup ran against that tab id");
  ok(!tabGroupTabs.has(42), "and it is never recorded as a group member");
}
{
  const { guard } = build({ lastAgentTabActivityAt: Date.now() - 5_000 });
  ok((await guard({ id: 45, groupId: AGENT_GROUP })) === "ungrouped", "a tab opened well after the agent stopped acting is the operator's, and is ungrouped");
}

// --- The agent's own child tab must stay ---------------------------------
{
  const { guard, ungrouped, tabGroupTabs } = build({ toolRunning: true, lastAgentTabActivityAt: 0 });
  ok((await guard({ id: 43, groupId: AGENT_GROUP, url: "https://example.com/popup" })) === "kept", "a tab inheriting the group WHILE a tool is dispatching is kept");
  ok(ungrouped.length === 0, "and is never ungrouped");
  ok(tabGroupTabs.has(43), "and is recorded as a group member");
}
{
  const { guard, ungrouped } = build({ lastAgentTabActivityAt: Date.now() - 200 });
  ok((await guard({ id: 44, groupId: AGENT_GROUP, pendingUrl: "https://example.com/popup" })) === "kept", "a popup landing a beat after the agent's click is kept (inside the grace window)");
  ok(ungrouped.length === 0, "and is never ungrouped");
}
{
  // The URL can still be uncommitted at onCreated, and the onUpdated grouping
  // event carries no URL at all — so a blank-LOOKING tab is re-read once before
  // it is judged, rather than evicted on the strength of a missing field.
  const { guard, ungrouped, tabGroupTabs } = build({
    toolRunning: true,
    tabs: { 51: { id: 51, url: "https://example.com/opened-by-the-page" } }
  });
  ok((await guard({ id: 51, groupId: AGENT_GROUP })) === "kept", "a popup whose destination had not committed yet is re-read, and kept");
  ok(ungrouped.length === 0, "and is never ungrouped");
  ok(tabGroupTabs.has(51), "and is recorded as a group member");
}

// --- Ctrl+T mid-run must NOT be swallowed (BUG-02) -----------------------
// "The agent is acting right now" is a fact about the agent, not about this
// tab. Everything the agent itself opens is already claimed before it is
// grouped, and a popup a page opened always carries its destination — so an
// empty tab appearing mid-run is the operator's, every time.
for (const [url, why] of [
  ["", "a tab so fresh it has no URL yet"],
  ["about:blank", "about:blank"],
  ["chrome://newtab/", "Chrome's new-tab page"],
  ["brave://newtab", "Brave's new-tab page"]
]) {
  const { guard, ungrouped, tabGroupTabs } = build({
    toolRunning: true,
    tabs: { 52: { id: 52, url } }
  });
  ok((await guard({ id: 52, groupId: AGENT_GROUP, url })) === "ungrouped", "Ctrl+T while a tool is dispatching is evicted — " + why);
  ok(ungrouped.length === 1 && ungrouped[0] === 52, "  ...ungroup ran against it");
  ok(!tabGroupTabs.has(52), "  ...and it is never recorded as a group member, so isInGroup() never grants an MCP client authority over it");
}
{
  // The + button beside the group: onCreated sees it ungrouped, and only the
  // later onUpdated carries the group — with no URL on the synthetic tab
  // object that listener builds.
  const { guard, ungrouped } = build({
    lastAgentTabActivityAt: Date.now() - 200,
    tabs: { 53: { id: 53, url: "chrome://newtab/" } }
  });
  ok((await guard({ id: 53, groupId: AGENT_GROUP })) === "ungrouped", "the new-tab button beside the group is evicted inside the grace window too");
  ok(ungrouped[0] === 53, "  ...and ungroup ran against it");
}

// --- A tab this extension itself put in the group is never evicted -------
// Each of ensureTabGroup / tabs_create_mcp / adoptBorrowedTab records the tab
// BEFORE calling chrome.tabs.group(), so the claim is on the books by the time
// the resulting event reaches the guard — even with no tool running, which is
// exactly the case for the panel adopting the operator's bound tab.
for (const [registry, label] of [
  ["tabGroupTabs", "a tab ensureTabGroup/tabs_create_mcp opened"],
  ["sdkAgentCreatedTabs", "a tab the SDK path created"],
  ["adoptedBorrowedTabs", "a tab the panel adopted for the operator"]
]) {
  const { guard, ungrouped } = build({ lastAgentTabActivityAt: 0, claimed: { [registry]: [60] } });
  ok((await guard({ id: 60, groupId: AGENT_GROUP })) === "kept", label + " is kept, tool running or not");
  ok(ungrouped.length === 0, "  ...and ungroup never ran for it");
}

// --- Never touch what is not ours ----------------------------------------
{
  const { guard, ungrouped } = build({ lastAgentTabActivityAt: 0 });
  ok((await guard({ id: 46, groupId: -1 })) === "ignored", "an ungrouped tab is left alone");
  ok((await guard({ id: 47, groupId: 99 })) === "ignored", "a tab in somebody else's group is left alone");
  ok((await guard(null)) === "ignored", "a missing tab is a no-op");
  ok((await guard({ groupId: AGENT_GROUP })) === "ignored", "a tab with no id is a no-op");
  ok(ungrouped.length === 0, "none of those called ungroup");
}

// --- Service-worker restart ----------------------------------------------
{
  const { guard, ungrouped } = build({ tabGroupId: null, lastAgentTabActivityAt: 0, recoversTo: AGENT_GROUP });
  ok((await guard({ id: 48, groupId: AGENT_GROUP })) === "ungrouped", "after a restart the group id is recovered first, then the operator's tab is evicted");
  ok(ungrouped[0] === 48, "and ungroup ran against it");
}
{
  const { guard, ungrouped } = build({ tabGroupId: null, lastAgentTabActivityAt: 0, recoversTo: null });
  ok((await guard({ id: 49, groupId: 5 })) === "ignored", "when recovery finds no agent group, nothing is touched");
  ok(ungrouped.length === 0, "and ungroup never ran");
}

// --- Chrome refusing the ungroup -----------------------------------------
{
  const { guard, tabGroupTabs } = build({ lastAgentTabActivityAt: 0, ungroupThrows: true });
  ok((await guard({ id: 50, groupId: AGENT_GROUP })) === "ignored", "a refused ungroup is swallowed rather than thrown out of the listener");
  ok(!tabGroupTabs.has(50), "and the tab is still not claimed as a member");
}

// --- Which grouping events count as part of opening a tab ---------------
// The new-tab button at the end of a group creates the tab FIRST and files
// it into the group a moment later, so onCreated sees an ungrouped tab and
// only the later onUpdated carries the group. That second event has to reach
// the guard — but only for a tab that genuinely just appeared, so a tab the
// operator deliberately DRAGS into the group later is left alone.
{
  const src = extractFunction("noteTabCreated") + "\n" + extractFunction("consumeRecentlyCreated");
  // Date is injected so the ageing window can be stepped rather than slept.
  const compile = (map, nowFn, returnExpr) =>
    new Function(
      "recentlyCreatedTabs",
      "NEW_TAB_GROUPING_WINDOW_MS",
      "Date",
      src + "\nreturn " + returnExpr + ";"
    )(map, 3000, { now: nowFn });

  let clock = 1_000_000;
  const api = compile(new Map(), () => clock, "{ noteTabCreated, consumeRecentlyCreated }");

  api.noteTabCreated(70);
  ok(api.consumeRecentlyCreated(70) === true, "a tab grouped right after it was created counts as part of opening it");
  ok(api.consumeRecentlyCreated(70) === false, "and that verdict is spent — one grouping event per tab is judged this way");

  api.noteTabCreated(71);
  clock += 10_000;
  ok(api.consumeRecentlyCreated(71) === false, "a tab grouped long after creation is not — that is the operator dragging it in, which is left alone");
  ok(api.consumeRecentlyCreated(72) === false, "a tab never seen being created is not judged at all");

  // The map must not grow without bound across a long browsing session.
  const map = new Map();
  const note = compile(map, () => clock, "noteTabCreated");
  note(80);
  clock += 10_000;
  note(81);
  ok(!map.has(80) && map.has(81), "recording a new tab drops entries that have aged out, so the map cannot grow unbounded");
}

// --- Ctrl+T while the panel is open -------------------------------------
// The panel binds to whatever tab is active and asks the background to adopt
// it into the group, so Ctrl+T made the operator's empty new tab the "page
// the assistant is looking at". Nothing in the guard above can catch that:
// the extension is not inheriting the tab, it is deliberately pulling it in.
// The fix is upstream of the guard — an empty tab is never a page anyone is
// working on, so adoption refuses it.
{
  const src = extractFunction("isBlankNewTab", BACKGROUND);
  const bgSrc = fs.readFileSync(BACKGROUND, "utf8");
  const constMatch = bgSrc.match(/const BROWSER_NEW_TAB_URL = [^;]+;/);
  if (!constMatch) throw new Error("BROWSER_NEW_TAB_URL declaration not found in background.js");
  const isBlankNewTab = new Function(constMatch[0] + "\n" + src + "\nreturn isBlankNewTab;")();

  for (const [url, why] of [
    ["", "a tab so fresh it has no URL yet — what onCreated sees after Ctrl+T"],
    ["about:blank", "about:blank"],
    ["chrome://newtab/", "Chrome's new-tab page"],
    ["brave://newtab", "Brave's, without the trailing slash"],
    ["edge://new-tab-page/", "Edge's, under its other name"]
  ]) {
    ok(isBlankNewTab({ url }) === true, "adoption refuses " + why);
  }
  for (const [url, why] of [
    ["https://example.com", "an ordinary page"],
    ["https://newtab.example.com/x", "a real site that merely has newtab in its host"],
    ["chrome://extensions", "a browser page that is not the new-tab page"]
  ]) {
    ok(isBlankNewTab({ url }) === false, "adoption still accepts " + why);
  }
  ok(isBlankNewTab({ pendingUrl: "https://example.com" }) === false, "a tab still loading a real URL counts by its pendingUrl");
  ok(isBlankNewTab(null) === true, "a missing tab is treated as empty rather than adopted");

  // The refusal has to be wired into adoptBorrowedTab, not merely available.
  const adoptSrc = extractFunction("adoptBorrowedTab", BACKGROUND);
  ok(
    adoptSrc.includes("if (!explicit && isBlankNewTab(tab)) return false;"),
    "adoptBorrowedTab actually consults it, and bails before touching any group"
  );
  // The exception, and its exact shape: only a request the operator made by
  // name — clicking the toolbar icon on this tab — may adopt a blank one. The
  // passive page-context path must keep refusing, or every Ctrl+T on the way
  // somewhere else would be dragged into the group.
  ok(/const explicit = !!\(opts && opts\.explicit\);/.test(adoptSrc), "the exception is opt-in per call, never a default");
  ok(
    !/\{ explicit/.test(adoptSrc.slice(0, adoptSrc.indexOf("{"))),
    "the option is read from an object rather than destructured in the signature — a brace in the parameter list breaks _extract.mjs's brace matching, which is how this very assertion reads the function"
  );
  ok(
    adoptSrc.indexOf("isBlankNewTab") < adoptSrc.indexOf("adoptedBorrowedTabs.set"),
    "and does so BEFORE recording the tab, so a refused new tab leaves no bookkeeping behind"
  );
}

console.log(fail === 0 ? "\nAll checks passed\n" : "\n" + fail + " check(s) failed\n");
process.exit(fail === 0 ? 0 : 1);
