#!/usr/bin/env node
// Current design (per-tab explicit enablement, matching
// openspec/specs/browser-assistant-panel/spec.md's "each tab the panel is
// explicitly opened on is an independent agent scope" / "per-tab panel
// enablement"): side panel visibility is decided per tab by whether the
// operator explicitly opened it THERE, not by tab-group membership. Chrome
// has no "close the side panel" call — per-tab `setOptions({enabled})` is the
// only mechanism, and it applies the moment such a tab becomes active.
//
//   1. `isPanelTabExplicitlyEnabled(tabId)` reads a persisted set of tab ids
//      (chrome.storage.session, survives a service-worker restart) that only
//      grows via an explicit toolbar-icon click (`markPanelTabEnabled`). A
//      tab with no record — including every tab before the first click ever
//      happens — starts DISABLED, the opposite of the old group-based
//      default-enabled rule.
//   2. That is not a lockout because the click handler never consults any
//      prior state: it unconditionally tab-scoped-enables and opens the
//      panel on whatever tab was clicked, from anywhere, then records it.
//      One click always works.
//   3. A blank New Tab stays disabled even if it were somehow marked, unless
//      it already sits in one of the agent's own tab groups — the guard
//      inside syncSidePanelForTab, not a separate adoption gate.
//
// Two mechanics the click path depends on: openPanelOnActionClick must be OFF
// (with it on, Chrome swallows the click and action.onClicked never fires, so
// a disabled tab would have a dead icon), and open() must be reached without
// an intervening await, which would spend the user gesture it requires — and
// before markPanelTabEnabled/adoptSoloAgentGroup, which run unawaited after.
//
// The older group-recovery machinery (`resolveAgentGroupId`,
// AGENT_TAB_GROUP_TITLE title-based lookup across a worker restart) is still
// live code and is tested below for what it does, but it is no longer read
// by syncSidePanelForTab — the visibility rule does not call it.
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

console.log("== the panel follows explicit per-tab enablement ==");
{
  ok(syncBody.length > 0, "syncSidePanelForTab exists");
  ok(
    /const explicit = await isPanelTabExplicitlyEnabled\(tabId\);/.test(syncBody),
    "membership is decided by the persisted explicit-open record for THIS tab, not by tab-group membership"
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
    !/resolveAgentGroupId\(\)/.test(syncBody),
    "the sync path does NOT call the group resolver at all — visibility comes solely from the explicit per-tab record, never from tab-group membership"
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
    /let enabled = explicit;/.test(syncBody),
    "the default comes straight from the persisted explicit-open record — a tab starts DISABLED unless it was explicitly opened, the opposite of the old group-default-enabled rule"
  );
  ok(
    !/panelForcedTabs/.test(src),
    "there is no per-tab exemption competing with the enablement record — an earlier version had one, and because clicking the icon is how the panel is normally opened it applied to nearly every tab and the panel never closed anywhere"
  );

  const clickBody = src.slice(
    src.indexOf("chrome.action.onClicked.addListener"),
    src.indexOf("chrome.action.onClicked.addListener") + 1700
  );
  ok(
    !/isPanelTabExplicitlyEnabled/.test(clickBody),
    "the click handler never checks the explicit-record state first — it opens unconditionally, so a tab that starts with no record (a fresh install, or one never opened here) is never locked out: one click always enables and opens it"
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
  ok(
    /markPanelTabEnabled\(tab\.id\)\.catch\(\(\) => \{\}\);/.test(clickBody) && /adoptSoloAgentGroup\(tab\.id\)\.catch\(\(\) => \{\}\);/.test(clickBody),
    "clicking the icon records this tab in the explicit-open set and gives it its own solo group — the group is no longer what grants panel visibility, the explicit record is; the group is a separate, unawaited side effect"
  );
  const openIdx = clickBody.indexOf("chrome.sidePanel.open(");
  const markIdx = clickBody.indexOf("markPanelTabEnabled(");
  const soloIdx = clickBody.indexOf("adoptSoloAgentGroup(");
  ok(
    openIdx !== -1 && markIdx !== -1 && soloIdx !== -1 && openIdx < markIdx && openIdx < soloIdx,
    "the panel is opened before markPanelTabEnabled/adoptSoloAgentGroup run, so the user gesture is spent on open() first"
  );
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
