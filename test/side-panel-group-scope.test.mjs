#!/usr/bin/env node
// Requested behaviour: the side panel should close when the operator switches
// to a tab outside the agent's own tab group, and come back inside it.
//
// Chrome has no "close the side panel" call — per-tab `setOptions({enabled})`
// is the only mechanism, and it applies the moment such a tab becomes active.
// That makes the interesting part not the closing but the ways it can lock the
// operator out of their own panel:
//
//   1. Before any run there IS no agent group. If the rule hid the panel then,
//      the extension would be unopenable — the panel is where a run starts.
//   2. Once a group exists, an ordinary tab would never show the panel again,
//      so a new conversation could only be started from inside the group. The
//      toolbar icon is the escape: clicking it ADOPTS that tab into the group,
//      rather than exempting it from the rule. A first attempt did exempt it,
//      and since clicking the icon is how the panel is normally opened, the
//      exemption covered nearly every tab and the panel never closed anywhere.
//      That is why the assertions below insist there is no exemption left.
//   3. A blank New Tab was refused adoption outright, which — once the panel
//      followed the group — made it the one place the panel could not be used.
//      An explicit click adopts it; passively browsing past one still does not.
//
// Two mechanics the click path depends on: openPanelOnActionClick must be OFF
// (with it on, Chrome swallows the click and action.onClicked never fires, so
// a disabled tab would have a dead icon), and open() must be reached without
// an intervening await, which would spend the user gesture it requires.
//
// Proven structurally against the shipped source, the same technique
// test/handlers.test.mjs and test/overlay-background-bridge.test.mjs use for
// this file: chrome.sidePanel/tabs cannot be executed offline.
//
// Run: node test/side-panel-group-scope.test.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(__dirname, "..", "extension", "background.js"), "utf8");

let failures = 0;
function ok(cond, msg) {
  console.log(`  ${cond ? "PASS" : "FAIL"} ${msg}`);
  if (!cond) failures++;
}

const syncBody = src.slice(
  src.indexOf("async function syncSidePanelForTab"),
  src.indexOf("chrome.tabs.onActivated.addListener")
);

console.log("== the panel follows the agent's tab group ==");
{
  ok(syncBody.length > 0, "syncSidePanelForTab exists");
  ok(
    /enabled = tab\.groupId === agentGroupId;/.test(syncBody),
    "membership is decided against the agent's own group id, not merely 'is grouped at all'"
  );
  ok(
    /chrome\.sidePanel\.setOptions\(options\)/.test(syncBody),
    "it uses per-tab setOptions — the only API that can close an open side panel"
  );
  ok(
    /enabled \? \{ tabId, path: SIDE_PANEL_PATH, enabled: true \} : \{ tabId, enabled: false \}/.test(syncBody),
    "enabling names the document explicitly: a tab-scoped entry does not inherit manifest default_path, so an enabled entry without a path shows nothing"
  );
  ok(
    /const SIDE_PANEL_PATH = "sidepanel\/sidepanel\.html";/.test(src),
    "that path is a named constant, so it cannot drift from manifest.json's side_panel.default_path unnoticed"
  );
  ok(
    /chrome\.tabs\.onActivated\.addListener/.test(src),
    "switching tabs re-evaluates the rule"
  );
  ok(
    /"groupId" in changeInfo/.test(src),
    "a tab whose group changes under it is re-evaluated too — adoption into the group fires no onActivated"
  );
}

console.log("== the group id survives a service-worker restart ==");
{
  const resolveBody = src.slice(src.indexOf("async function resolveAgentGroupId"), src.indexOf("async function syncSidePanelForTab"));
  ok(resolveBody.length > 0, "resolveAgentGroupId exists");
  ok(
    /chrome\.tabGroups\.query\(\{ title \}\)/.test(resolveBody),
    "it recovers the group by TITLE from live browser state — tabGroupId is service-worker memory and MV3 evicts the worker constantly, so reading it directly made the rule conclude 'no group' almost always and the panel never closed anywhere"
  );
  ok(
    /LEGACY_TAB_GROUP_TITLES/.test(resolveBody),
    "recovery accepts the legacy titles too, matching what isInGroup's own recovery already accepts"
  );
  ok(
    /return null;/.test(resolveBody),
    "an unavailable tabGroups API resolves to no group, which KEEPS the panel enabled — the rule never hides the panel on a guess"
  );
  ok(
    /const agentGroupId = await resolveAgentGroupId\(\);/.test(syncBody),
    "the sync path goes through the resolver rather than reading the module variable"
  );
  ok(
    /lastFocusedWindow: true/.test(src),
    "the active tab is re-evaluated on worker startup — a restart fires no onActivated for the tab already on screen, which is exactly when the panel looked stuck open"
  );
  ok(
    /chrome\.tabGroups\.onRemoved/.test(src),
    "the group going away re-enables the panel rather than leaving tabs disabled with no group to return to"
  );
}

console.log("== the operator can never be locked out of their own panel ==");
{
  ok(
    /if \(agentGroupId !== null\) \{/.test(syncBody),
    "with no agent group yet, every tab keeps the panel — otherwise the extension could not be opened to start the first run"
  );
  ok(
    /let enabled = true;/.test(syncBody),
    "the default is enabled; the group rule only ever narrows it"
  );
  ok(
    !/panelForcedTabs/.test(src),
    "there is no per-tab exemption competing with the group rule — an earlier version had one, and because clicking the icon is how the panel is normally opened it applied to nearly every tab and the panel never closed anywhere"
  );

  const clickBody = src.slice(
    src.indexOf("chrome.action.onClicked.addListener"),
    src.indexOf("chrome.action.onClicked.addListener") + 1600
  );
  ok(
    /adoptBorrowedTab\(tab\.id, \{ explicit: true \}\)/.test(clickBody),
    "clicking the icon adopts that tab into the group — the panel stays open there through the one rule, not an exemption from it"
  );
  ok(
    /openPanelOnActionClick: false/.test(src),
    "openPanelOnActionClick is OFF — with it on Chrome swallows the click and action.onClicked never fires, leaving a disabled tab with a dead icon"
  );
  ok(
    !/await chrome\.sidePanel\.setOptions/.test(clickBody),
    "the click handler never awaits before opening — an awaited call spends the user gesture chrome.sidePanel.open() requires"
  );
  ok(
    /chrome\.sidePanel\.open\(\{ tabId: tab\.id \}\)/.test(clickBody),
    "the icon opens a TAB-scoped panel — one opened with { windowId } is window-scoped and ignores per-tab enable/disable, which made the panel appear never to close outside the group"
  );
  const openIdx = clickBody.indexOf("chrome.sidePanel.open(");
  const adoptIdx = clickBody.indexOf("adoptBorrowedTab(");
  ok(openIdx !== -1 && adoptIdx !== -1 && openIdx < adoptIdx, "the panel is opened before the async adoption, so the gesture is spent on open() first");
}

console.log("== an explicitly chosen blank tab joins the group; a passing one does not ==");
{
  const adoptBody = src.slice(src.indexOf("async function adoptBorrowedTab"), src.indexOf("async function adoptBorrowedTab") + 1200);
  ok(
    /if \(!explicit && isBlankNewTab\(tab\)\)/.test(adoptBody),
    "the blank-tab guard is skipped only for an explicit request — opening the panel on a New Tab now works, which was the one place the group-scoped panel could not be used"
  );
  ok(
    /const explicit = !!\(opts && opts\.explicit\);/.test(adoptBody),
    "the default is non-explicit, so the passive page-context path keeps its old behaviour and Ctrl+T on the way somewhere else is still left alone"
  );
  ok(
    /panel_bind_tab/.test(src) && !/adoptBorrowedTab\(msg\.tabId, \{ explicit: true \}\)/.test(src),
    "the panel's passive page-context binding never passes explicit — only the toolbar click does"
  );
}

console.log("== the pre-existing group machinery is untouched ==");
{
  ok(
    /const AGENT_TAB_GROUP_TITLE = "Browzy";/.test(src),
    "the group title constant is unchanged"
  );
  ok(
    /async function isInGroup\(tabId\)/.test(src),
    "isInGroup, the authorization path, still exists and is not what the panel rule reuses — visibility must never become authority"
  );
  ok(
    !/isInGroup\(tabId\)/.test(syncBody),
    "the panel rule does NOT call isInGroup: that function answers 'may the agent act here', which is a different question from 'should the panel be visible here'"
  );
}

console.log(failures === 0 ? "\nALL SIDE-PANEL GROUP-SCOPE TESTS PASSED" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
