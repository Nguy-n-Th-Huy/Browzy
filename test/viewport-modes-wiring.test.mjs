#!/usr/bin/env node
//
// Wiring tests for the viewport-mode background pieces (extension/background.js,
// design.md add-page-viewport-modes Decisions 6-8/11/12), run against the
// SHIPPED function bodies through test/_extract.mjs with a fake chrome.debugger
// — no real browser involved. Covers: the CDP command order applyViewportMode
// issues per mode, that Fit runs the clear form of the same four commands,
// that a failed apply leaves the tab fully cleared rather than half emulated,
// that the tab-removed/debugger-detach listeners drop the tab's entry, and
// that resize_window's result names an emulated tab's mode, and that the
// scale-below-1 coordinate note (Decision 11) is shared by resize_window and
// the screenshot action via viewportScaleAgentNote() — present for ANY mode
// (pc, mobile or tablet) drawn below scale 1, absent for Fit and for a mode
// wide enough to draw at scale 1.
//
// Root-cause fix for the panel-close resize race (live-reported bug: closing
// the panel with a device mode active left the tab emulated at the old mode
// even though the panel's own state said Fit): a per-tab operation queue
// (viewportOpQueue) and generation counter (viewportGenerationByTab) now
// serialise every apply/clear for one tab and let a stale re-apply turn
// itself into a no-op right before it would send a CDP command. The three
// "root-cause fix" scenarios near the end of this file exercise that
// directly, using mkCdp's state.cdpHooks (a one-shot, per-method hook that
// can block a specific command on a manually-released promise) to force a
// deterministic interleaving between a re-apply and a clear/pick that races
// it, rather than depending on incidental microtask scheduling order.
//
// Panel-close cleanup (design.md Decision 7) is exercised against
// onViewportPanelBind(instanceId, tabId) / onViewportPanelDisconnected(instanceId)
// directly, using plain instanceId strings — never a MessageSender/port.sender
// object with a `documentId` field. That field is deliberately absent from
// every fake here: real Chrome does not reliably populate
// MessageSender.documentId for a side-panel/extension-page sender, which is
// exactly the live-Chrome bug this rewrite covers (the previous version of
// this suite passed only because its fake senders carried a documentId the
// real panel never does). The instanceId itself now comes from the panel's
// own dedicated "browzy-viewport" port (extension/sidepanel/sidepanel.js's
// VIEWPORT_PANEL_INSTANCE_ID, registered on connect) — background.js's own
// port-handling glue (chrome.runtime.onConnect) is not itself under test
// here, only the pure functions it calls, the same boundary the rest of this
// suite already draws around applyViewportMode/clearViewportMode.
//
// Run: node test/viewport-modes-wiring.test.mjs

import { extractFunction, extractMethod } from "./_extract.mjs";

let failed = 0;
function ok(cond, msg) {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${msg}`);
  if (!cond) failed++;
}

// A manually-resolvable promise, used with mkCdp's state.cdpHooks (below) to
// force a deterministic interleaving between two concurrent operations
// instead of depending on incidental microtask scheduling order.
function deferred() {
  let resolve;
  const promise = new Promise((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

// Mirrors extension/background.js's own constants — the same small-constant
// duplication test/screenshot-scale.test.mjs already uses for
// MODEL_IMAGE_MAX_EDGE, kept here rather than importing background.js as a
// module (it is a service worker script with no exports; see _extract.mjs's
// own header).
const VIEWPORT_MODES = Object.freeze({
  mobile: Object.freeze({ width: 390, deviceScaleFactor: 3 }),
  tablet: Object.freeze({ width: 768, deviceScaleFactor: 2 }),
  pc: Object.freeze({ width: 1280, deviceScaleFactor: 0 }),
});
const VIEWPORT_UA_FALLBACK_MAJOR = 131;
const VIEWPORT_MODE_STORAGE_KEY = "viewport_mode_by_tab_v1";
const RESTRICTED_URL_PATTERN =
  /^(chrome|chrome-extension|brave|edge|about|devtools|view-source):|^https:\/\/(chrome\.google\.com\/webstore|chromewebstore\.google\.com|microsoftedge\.microsoft\.com\/addons)/i;

function mkState() {
  return {
    tabs: [{ id: 1, url: "https://example.com", windowId: 10, width: 1020, height: 780 }],
    winWidth: 1200,
    winHeight: 800,
    innerWidth: 390,
    calls: [],
    broadcasts: [],
    session: {},
    failMethod: null,
    failed: false,
  };
}

function mkChrome(state) {
  return {
    tabs: {
      get: async (id) => {
        const t = state.tabs.find((t) => t.id === id);
        if (!t) throw new Error("no such tab");
        // Hook for the panel-close/poll-race tests below: lets a test mutate
        // viewportModeByTab/attachedTabs WHILE this call is "in flight", the
        // same way a concurrent debugger.onDetach, tabs.onRemoved or
        // onViewportPanelDisconnected would during the real await.
        if (typeof state.onTabsGet === "function") await state.onTabsGet(id);
        return { ...t };
      },
      reload: async () => {},
    },
    windows: {
      get: async (id) => ({ id, state: "normal", width: state.winWidth, height: state.winHeight, left: 0, top: 0 }),
      update: async (id, o) => {
        if (typeof o.width === "number") state.winWidth = o.width;
        if (typeof o.height === "number") state.winHeight = o.height;
      },
    },
    storage: {
      session: {
        get: async () => ({}),
        set: async (v) => {
          Object.assign(state.session, v);
        },
      },
    },
    runtime: {
      sendMessage: async (msg) => {
        state.broadcasts.push(msg);
      },
    },
  };
}

// A fake `cdp(tabId, method, params)` — the exact call shape
// applyViewportMode/runViewportClearCommands/verifyViewportApplied/resize_window
// make — standing in for the real cdp()+ensureAttached() CDP round trip so
// only THIS task's own command-ordering/clear/failure logic is under test.
// Records every call (even one about to throw), which is what lets the
// "clear on failure" scenario below see the whole sequence. Calls
// `ensureAttached(tabId)` first, exactly like the real `cdp()` does
// (extension/background.js) — this is what makes the "the debugger is NOT
// re-attached" assertion in the detach race test below a REAL assertion
// rather than a vacuous one: without this, the fake would never simulate
// the actual re-attach side effect the production bug depends on, and that
// assertion would pass even against the un-fixed code.
function mkCdp(state, ensureAttached) {
  return async (tabId, method, params) => {
    await ensureAttached(tabId);
    // Deterministic interleaving control for the race tests below: a test
    // can register a ONE-SHOT hook per CDP method via state.cdpHooks[method].
    // The hook runs (and is deleted) before the call is recorded, and
    // whatever promise it returns is awaited before this call resolves —
    // letting a test block a specific command exactly at the moment a real
    // chrome.debugger.sendCommand would still be in flight, and control
    // precisely when it is released, rather than guessing at microtask
    // scheduling.
    const hook = state.cdpHooks && state.cdpHooks[method];
    if (hook) {
      delete state.cdpHooks[method];
      await hook();
    }
    state.calls.push({ tabId, method, params });
    if (state.failMethod === method && !state.failed) {
      state.failed = true;
      throw new Error(`boom:${method}`);
    }
    if (method === "Runtime.evaluate") {
      if (params && params.expression === "innerWidth") return { result: { value: state.innerWidth } };
      return { result: { value: JSON.stringify([state.innerWidth, 800]) } };
    }
    return {};
  };
}

function build(state) {
  const chrome = mkChrome(state);
  // Mirrors the real ensureAttached's own bookkeeping (it records the tab in
  // attachedTabs as part of attaching — see extension/background.js) rather
  // than being a pure no-op, so applyViewportMode's own attachedTabs.has()
  // checks (added by the per-tab serialisation fix) see a truthful
  // just-attached tab on an ordinary first apply, the same way real Chrome
  // would. Tests that need to simulate a detach still do so explicitly via
  // attachedTabs.delete(tabId) (directly, or through the onTabsGet hook),
  // and a subsequent CDP call through the fake `cdp` below (which itself
  // calls this, like the real cdp() does) re-attaches it right back — this
  // is what makes the detach race test's "not re-attached" assertion real.
  const ensureAttached = async (tabId) => {
    if (!attachedTabs.has(tabId)) attachedTabs.set(tabId, {});
  };
  const cdp = mkCdp(state, ensureAttached);
  const getChromeMajorVersion = () => 131;
  const ensureViewportPolling = () => {};
  const isInGroup = async () => true;
  const sleep = () => Promise.resolve();
  const dbg = () => {};
  const viewportModeByTab = new Map();
  // Stands in for the real chrome.debugger attachment bookkeeping (the real
  // attachedTabs is populated by ensureAttached, which is stubbed to a no-op
  // above) — tests set/delete entries directly to simulate the debugger
  // being attached or having detached.
  const attachedTabs = new Map();
  const viewportBoundTabByInstanceId = new Map();
  let viewportPollTimer = null;
  // Root-cause fix for the panel-close resize race (design.md Decision
  // 6/7/8): the per-tab generation counter and operation queue that
  // serialise every apply/clear for a tab and let a stale re-apply turn
  // itself into a no-op. See extension/background.js's own comment above
  // viewportModeByTab for the full explanation.
  const viewportGenerationByTab = new Map();
  const viewportOpQueue = new Map();
  const viewportLatestResultByTab = new Map();

  const src = [
    extractFunction("coercePositiveNumber"),
    extractFunction("viewportModeParams"),
    extractFunction("persistViewportModes"),
    extractFunction("setViewportEntry"),
    extractFunction("broadcastViewportMode"),
    extractFunction("viewportScaleAgentNote"),
    extractFunction("runViewportClearCommands"),
    extractFunction("bumpViewportGeneration"),
    extractFunction("currentViewportGeneration"),
    extractFunction("queueViewportOp"),
    extractFunction("clearViewportMode"),
    extractFunction("verifyViewportApplied"),
    extractFunction("applyViewportMode"),
    extractFunction("viewportPollTick"),
    extractFunction("reapplyEmulatedTabsInWindow"),
    extractFunction("onViewportPanelBind"),
    extractFunction("onViewportPanelDisconnected"),
    extractFunction("onViewportTabRemoved"),
    extractFunction("onViewportDebuggerDetach"),
    `const H_resize_window = { ${extractMethod("resize_window")} };`,
  ].join("\n\n");

  const mk = new Function(
    "chrome", "cdp", "ensureAttached", "getChromeMajorVersion", "ensureViewportPolling",
    "isInGroup", "sleep", "dbg", "viewportModeByTab", "attachedTabs", "viewportBoundTabByInstanceId", "viewportPollTimer",
    "viewportGenerationByTab", "viewportOpQueue", "viewportLatestResultByTab",
    "RESTRICTED_URL_PATTERN", "VIEWPORT_MODES", "VIEWPORT_UA_FALLBACK_MAJOR", "VIEWPORT_MODE_STORAGE_KEY",
    src + `
      return {
        applyViewportMode, clearViewportMode, runViewportClearCommands, verifyViewportApplied,
        setViewportEntry, onViewportTabRemoved, onViewportDebuggerDetach, viewportModeParams,
        viewportScaleAgentNote, viewportPollTick, reapplyEmulatedTabsInWindow,
        onViewportPanelBind, onViewportPanelDisconnected,
        bumpViewportGeneration, currentViewportGeneration,
        resize_window: H_resize_window.resize_window,
        viewportModeByTab, attachedTabs, viewportBoundTabByInstanceId,
        viewportGenerationByTab, viewportOpQueue, viewportLatestResultByTab,
      };
    `
  );
  return mk(
    chrome, cdp, ensureAttached, getChromeMajorVersion, ensureViewportPolling,
    isInGroup, sleep, dbg, viewportModeByTab, attachedTabs, viewportBoundTabByInstanceId, viewportPollTimer,
    viewportGenerationByTab, viewportOpQueue, viewportLatestResultByTab,
    RESTRICTED_URL_PATTERN, VIEWPORT_MODES, VIEWPORT_UA_FALLBACK_MAJOR, VIEWPORT_MODE_STORAGE_KEY
  );
}

console.log("\napplying a mode issues the four commands in Decision 6's order, then verifies\n");

let state = mkState();
let W = build(state);
state.calls = [];
let res = await W.applyViewportMode(1, "mobile");
ok(res.ok === true && res.mode === "mobile", `apply succeeds (got ${JSON.stringify(res)})`);
{
  const methods = state.calls.map((c) => c.method);
  ok(
    methods[0] === "Emulation.setDeviceMetricsOverride" &&
      methods[1] === "Emulation.setTouchEmulationEnabled" &&
      methods[2] === "Emulation.setEmitTouchEventsForMouse" &&
      methods[3] === "Emulation.setUserAgentOverride",
    `apply order: setDeviceMetricsOverride, setTouchEmulationEnabled, setEmitTouchEventsForMouse, setUserAgentOverride (got ${methods.slice(0, 4).join(", ")})`
  );
  ok(methods[4] === "Runtime.evaluate", "apply verifies innerWidth against what it just set (Decision 12)");
}
ok(W.viewportModeByTab.get(1) && W.viewportModeByTab.get(1).mode === "mobile", "the tab's entry records the applied mode");
ok(W.viewportModeByTab.get(1).overridden === false, "not overridden when the page reports the width Browzy just set");

console.log("\nFit runs the clear/disable forms of the same four commands\n");

state.calls = [];
res = await W.applyViewportMode(1, "fit");
ok(res.ok === true && res.mode === "fit", "fit succeeds");
{
  const methods = state.calls.map((c) => c.method);
  ok(
    methods.join(",") ===
      [
        "Emulation.clearDeviceMetricsOverride",
        "Emulation.setTouchEmulationEnabled",
        "Emulation.setEmitTouchEventsForMouse",
        "Emulation.setUserAgentOverride",
      ].join(","),
    `fit order: clearDeviceMetricsOverride, setTouchEmulationEnabled, setEmitTouchEventsForMouse, setUserAgentOverride (got ${methods.join(", ")})`
  );
}
ok(!W.viewportModeByTab.has(1), "fit drops the tab's entry");

console.log("\na failed command mid-apply leaves the tab fully cleared, not half emulated\n");

state.calls = [];
state.failMethod = "Emulation.setTouchEmulationEnabled";
state.failed = false;
res = await W.applyViewportMode(1, "tablet");
ok(res.ok === false && res.reason === "apply_failed", `apply reports the failure (got ${JSON.stringify(res)})`);
ok(!W.viewportModeByTab.has(1), "no entry is left behind after a failed apply");
{
  const methods = state.calls.map((c) => c.method);
  ok(methods[0] === "Emulation.setDeviceMetricsOverride" && methods[1] === "Emulation.setTouchEmulationEnabled",
    "apply got as far as the command that failed");
  ok(
    methods.slice(2).join(",") ===
      [
        "Emulation.clearDeviceMetricsOverride",
        "Emulation.setTouchEmulationEnabled",
        "Emulation.setEmitTouchEventsForMouse",
        "Emulation.setUserAgentOverride",
      ].join(","),
    `the failure runs the FULL clear afterward (got ${methods.slice(2).join(", ")})`
  );
}
state.failMethod = null;
state.failed = false;

console.log("\nrestricted pages are refused with a reason\n");

state.tabs.push({ id: 2, url: "chrome://settings", windowId: 10, width: 1000, height: 700 });
res = await W.applyViewportMode(2, "mobile");
ok(res.ok === false && res.reason === "restricted_page", `restricted page refused (got ${JSON.stringify(res)})`);
ok(!W.viewportModeByTab.has(2), "no entry recorded for a refused tab");

console.log("\nthe entry is dropped on tabs.onRemoved and on debugger.onDetach\n");

await W.applyViewportMode(1, "pc");
ok(W.viewportModeByTab.has(1), "set up: tab 1 is emulated");
W.onViewportTabRemoved(1);
ok(!W.viewportModeByTab.has(1), "tabs.onRemoved drops the entry");

await W.applyViewportMode(1, "mobile");
ok(W.viewportModeByTab.has(1), "set up again: tab 1 is emulated");
state.broadcasts = [];
W.onViewportDebuggerDetach({ tabId: 1 });
ok(!W.viewportModeByTab.has(1), "debugger.onDetach drops the entry");
ok(
  state.broadcasts.some((b) => b.type === "viewport_mode_changed" && b.tabId === 1 && b.mode === "fit"),
  `debugger.onDetach broadcasts the tab back to fit (got ${JSON.stringify(state.broadcasts)})`
);

console.log("\nresize_window names an emulated tab's mode\n");

await W.applyViewportMode(1, "mobile");
let rw = await W.resize_window({ width: 500, height: 800, tabId: 1 });
let text = rw.content[0].text;
ok(text.includes('emulating "mobile"') && text.includes("390px"), `resize_window notes the emulation (got: ${text})`);

await W.applyViewportMode(1, "fit");
rw = await W.resize_window({ width: 500, height: 800, tabId: 1 });
text = rw.content[0].text;
ok(!text.includes("emulating"), `no emulation note once the tab is back to fit (got: ${text})`);

console.log(
  "\nscale-below-1 coordinate note (Decision 11) is shared by resize_window and the " +
    "screenshot action via viewportScaleAgentNote() — present for ANY mode below scale 1, absent in Fit\n"
);

// Tab 1 is 1020px wide (mkState()), so PC's 1280px layout draws at scale
// 1020/1280 ≈ 0.797 — below 1, which is exactly the case the note must cover.
await W.applyViewportMode(1, "pc");
ok(W.viewportModeByTab.get(1).scale < 1, `set up: tab 1's PC scale is below 1 (got ${W.viewportModeByTab.get(1).scale})`);

// This is the exact function the screenshot action's `computer` handler calls
// to build its own note (extension/background.js, the "screenshot" case) —
// background.js is a service-worker script with no exports, so the shared
// wording source is verified here directly rather than through the much
// larger `computer` method, the same testing boundary test/screenshot-scale
// .test.mjs and test/screenshot-annotation.test.mjs already draw around
// takeScreenshot() rather than the whole switch statement.
let pcNote = W.viewportScaleAgentNote(1);
ok(
  pcNote.includes('emulating "pc"') && pcNote.includes("1280px") && pcNote.includes("0.80") && pcNote.includes("not yet verified"),
  `viewportScaleAgentNote names the mode, the 1280px width, the scale and the unverified-coordinates caveat (got: ${pcNote})`
);

rw = await W.resize_window({ width: 500, height: 800, tabId: 1 });
text = rw.content[0].text;
ok(
  text.includes('emulating "pc"') && text.includes("1280px") && text.includes("not yet verified"),
  `resize_window's note carries the same PC-scale coordinate caveat (got: ${text})`
);

await W.applyViewportMode(1, "fit");
ok(W.viewportScaleAgentNote(1) === "", `viewportScaleAgentNote is empty once the tab is back to Fit (got: "${W.viewportScaleAgentNote(1)}")`);
rw = await W.resize_window({ width: 500, height: 800, tabId: 1 });
text = rw.content[0].text;
ok(!text.includes("not yet verified"), `resize_window's note carries no coordinate caveat in Fit (got: ${text})`);

// Tab 1 is 1020px wide — wider than mobile's own 390px layout — so Mobile
// here draws at scale 1 and carries no note. The note is not mode-specific
// (Decision 11's generalisation): it is keyed on scale alone.
await W.applyViewportMode(1, "mobile");
ok(W.viewportModeByTab.get(1).scale === 1, `set up: tab 1's mobile scale is 1 at this tab width (got ${W.viewportModeByTab.get(1).scale})`);
ok(W.viewportScaleAgentNote(1) === "", `viewportScaleAgentNote is empty once a mode's scale reaches 1, even mobile (got: "${W.viewportScaleAgentNote(1)}")`);

// A tab wide enough that PC's own layout needs no scaling (scale reaches 1)
// carries no unverified-coordinate risk either.
state.tabs.push({ id: 3, url: "https://example.com", windowId: 10, width: 1600, height: 900 });
await W.applyViewportMode(3, "pc");
ok(W.viewportModeByTab.get(3).scale === 1, `set up: tab 3's PC scale is 1 (got ${W.viewportModeByTab.get(3).scale})`);
ok(W.viewportScaleAgentNote(3) === "", `viewportScaleAgentNote is empty once PC's scale reaches 1 (got: "${W.viewportScaleAgentNote(3)}")`);

console.log(
  "\ngeneralised: Mobile/Tablet in a tab NARROWER than the device width also get the note, not just PC\n"
);

// design.md Decision 11's generalisation (task 4): a narrow tab now scales
// Mobile/Tablet down exactly like PC already scaled down, so they carry the
// same unverified-coordinate note once their own scale drops below 1.
state.tabs.push({ id: 4, url: "https://example.com", windowId: 10, width: 300, height: 600 });
await W.applyViewportMode(4, "mobile");
ok(W.viewportModeByTab.get(4).scale < 1, `set up: tab 4's mobile scale is below 1 at 300px wide (got ${W.viewportModeByTab.get(4).scale})`);
let mobileNote = W.viewportScaleAgentNote(4);
ok(
  mobileNote.includes('emulating "mobile"') && mobileNote.includes("390px") && mobileNote.includes("not yet verified"),
  `viewportScaleAgentNote names mobile (not just pc) once its own scale drops below 1 (got: ${mobileNote})`
);

state.tabs.push({ id: 5, url: "https://example.com", windowId: 10, width: 600, height: 700 });
await W.applyViewportMode(5, "tablet");
ok(W.viewportModeByTab.get(5).scale < 1, `set up: tab 5's tablet scale is below 1 at 600px wide (got ${W.viewportModeByTab.get(5).scale})`);
let tabletNote = W.viewportScaleAgentNote(5);
ok(
  tabletNote.includes('emulating "tablet"') && tabletNote.includes("768px") && tabletNote.includes("not yet verified"),
  `viewportScaleAgentNote names tablet (not just pc) once its own scale drops below 1 (got: ${tabletNote})`
);

await W.applyViewportMode(1, "fit");

console.log(
  "\nfake \"browzy-viewport\" port: onMessage/onDisconnect/postMessage, deliberately with NO documentId anywhere\n" +
    "(real Chrome does not reliably populate MessageSender.documentId for a side-panel sender — the live-Chrome bug this covers)\n"
);

// A minimal chrome.runtime.Port stand-in. Deliberately carries no `.sender`/
// `documentId` field at all: real Chrome's Port for a side-panel connection
// does have a `.sender`, but its `documentId` is not reliably populated, so
// this fake omits the field entirely rather than modelling a value that
// would make the test too generous (exactly what the PREVIOUS version of
// this suite got wrong — its fake senders always carried a documentId the
// real panel never does, which is why it passed while real Chrome broke).
class FakeViewportPort {
  constructor() {
    this._msgListeners = [];
    this._discListeners = [];
    this.postedMessages = [];
  }
  postMessage(msg) {
    this.postedMessages.push(msg);
  }
  onMessage = { addListener: (fn) => this._msgListeners.push(fn) };
  onDisconnect = { addListener: (fn) => this._discListeners.push(fn) };
  // Test-only helpers standing in for what real Chrome delivers to the
  // listeners registered above.
  emitMessage(msg) {
    for (const fn of this._msgListeners) fn(msg);
  }
  async disconnect() {
    await Promise.all(this._discListeners.map((fn) => fn()));
  }
}

// Mirrors background.js's own chrome.runtime.onConnect listener for the
// "browzy-viewport" port (background.js, right after onViewportPanelDisconnected):
// register whatever instanceId the panel announces as its first message, and
// on disconnect run onViewportPanelDisconnected with the instanceId THIS
// exact port registered. Kept local to this file, the same small-glue
// duplication this suite's own VIEWPORT_MODES/RESTRICTED_URL_PATTERN already
// use (background.js is a service-worker script with no exports, and this
// onConnect listener is not itself a named top-level function extractFunction()
// can pull out) — the actual business logic it calls (onViewportPanelBind /
// onViewportPanelDisconnected) IS extracted from the shipped source, above.
function connectFakeViewportPort(W, port) {
  let instanceId = null;
  port.onMessage.addListener((msg) => {
    if (msg && msg.type === "register" && typeof msg.instanceId === "string" && msg.instanceId) {
      instanceId = msg.instanceId;
    }
  });
  port.onDisconnect.addListener(() => W.onViewportPanelDisconnected(instanceId));
}

console.log(
  "\na viewport mode does not outlive the panel that set it: its dedicated port disconnecting clears it via the same path as picking Vừa cửa sổ\n"
);

state = mkState();
W = build(state);
const portA = new FakeViewportPort();
connectFakeViewportPort(W, portA);
portA.emitMessage({ type: "register", instanceId: "panel-A" }); // the panel's own first message on this port, on connect
W.onViewportPanelBind("panel-A", 1); // panel A binds to tab 1, exactly like sidepanel.js's syncAdoptedTabGroup/panel_bind_tab on boot
res = await W.applyViewportMode(1, "tablet", "panel-A"); // the exact setBy viewport_mode_set's handler passes, tagged with the panel's own instanceId
ok(res.ok === true, "panel A picks Tablet for tab 1");
ok(W.viewportModeByTab.get(1).setBy === "panel-A", "the entry records which panel's viewport_mode_set instanceId set it");

state.calls = [];
state.broadcasts = [];
await portA.disconnect(); // the panel closed, or reloaded into a fresh document — its port disconnects
ok(!W.viewportModeByTab.has(1), "the tab returns to fit when the setting port disconnects (or reloads)");
{
  const methods = state.calls.map((c) => c.method);
  ok(
    methods.join(",") ===
      [
        "Emulation.clearDeviceMetricsOverride",
        "Emulation.setTouchEmulationEnabled",
        "Emulation.setEmitTouchEventsForMouse",
        "Emulation.setUserAgentOverride",
      ].join(","),
    `panel-close cleanup runs the SAME clear path as picking Vừa cửa sổ (clearViewportMode) — never a bare device-mode reset (got ${methods.join(", ")})`
  );
}
ok(
  state.broadcasts.some((b) => b.type === "viewport_mode_changed" && b.tabId === 1 && b.mode === "fit"),
  `viewport_mode_changed still fires on panel-close clear (got ${JSON.stringify(state.broadcasts)})`
);

console.log("\ndisconnecting a port that registered no instanceId, or set no mode, or a tab with no entry, is a no-op\n");

state = mkState();
W = build(state);
state.calls = [];
const portUnregistered = new FakeViewportPort();
connectFakeViewportPort(W, portUnregistered);
await portUnregistered.disconnect(); // never sent {type:"register", ...} before disconnecting
ok(state.calls.length === 0, "a port that never registered an instanceId is a safe no-op");
await W.onViewportPanelDisconnected("nobody-set-anything");
ok(state.calls.length === 0, "no CDP command is issued when the disconnecting instanceId owned nothing");
await W.onViewportPanelDisconnected(null);
await W.onViewportPanelDisconnected(undefined);
ok(state.calls.length === 0, "a null/undefined instanceId is a safe no-op");

console.log(
  "\nexception: a mode stays in force when another LIVE port is still bound to the same tab\n"
);

state = mkState();
W = build(state);
const portX = new FakeViewportPort();
const portY = new FakeViewportPort();
connectFakeViewportPort(W, portX);
connectFakeViewportPort(W, portY);
portX.emitMessage({ type: "register", instanceId: "panel-X" });
portY.emitMessage({ type: "register", instanceId: "panel-Y" });
W.onViewportPanelBind("panel-X", 1);
W.onViewportPanelBind("panel-Y", 1); // a second panel (e.g. another browser window) is ALSO bound to tab 1, via its own live port
res = await W.applyViewportMode(1, "mobile", "panel-X");
ok(res.ok === true, "panel X picks Di động for tab 1");

state.calls = [];
state.broadcasts = [];
await portX.disconnect(); // panel X's port disconnects — panel Y's port is still open and bound to tab 1
ok(W.viewportModeByTab.has(1), "the mode stays in force: panel Y's port is still live and bound to tab 1");
ok(W.viewportModeByTab.get(1).mode === "mobile", "the mode itself is unchanged");
ok(state.calls.length === 0, "no clear command is issued while another live port owns the tab");
ok(state.broadcasts.length === 0, "no broadcast fires since nothing actually changed");

// Panel Y's port disconnecting too, later, does NOT retroactively clear tab 1
// — Y never set the mode (entry.setBy is still panel-X), so Y's own
// disconnect has nothing that belongs to it to clear. This matches Decision
// 7 literally: only the panel that SET a mode can end its lifetime. A
// non-owning port's disconnect is a no-op.
state.calls = [];
state.broadcasts = [];
await portY.disconnect();
ok(W.viewportModeByTab.has(1), "a non-owning port's later disconnect does not clear a mode it never set");
ok(state.calls.length === 0, "no CDP command is issued by a non-owning port's disconnect");
await W.applyViewportMode(1, "fit");

console.log(
  "\npoll tick (500ms) and onBoundsChanged re-apply: the chrome.tabs.get await is a race window — " +
    "an entry cleared/replaced or a debugger detached mid-await must not be resurrected/re-attached\n"
);

// Case A: the entry vanishes mid-await — e.g. the operator clicked Cancel on
// the debugging bar (chrome.debugger.onDetach), or the panel that set it
// closed (onViewportPanelDisconnected). The tab's reported height also
// changed (Cancel makes the infobar vanish, which resizes the content area),
// which is exactly what would make the OLD code re-apply and re-attach.
state = mkState();
W = build(state);
await W.applyViewportMode(1, "tablet");
W.attachedTabs.set(1, {});
ok(W.viewportModeByTab.has(1) && W.attachedTabs.has(1), "set up: tab 1 is emulated and attached");
state.tabs[0].height = 500; // the infobar vanishing changed the tab's content height
state.calls = [];
state.onTabsGet = async (id) => {
  if (id !== 1) return;
  W.viewportModeByTab.delete(1); // cleared by whatever fired during this await
  W.attachedTabs.delete(1); // ...and the debugger session is gone too
};
await W.viewportPollTick();
state.onTabsGet = null;
ok(
  state.calls.length === 0,
  `poll tick issues no CDP command (no re-apply, no re-attach) for a tab whose entry vanished mid-await (got ${JSON.stringify(state.calls)})`
);

// Case B: the entry is still present, but the debugger is no longer attached
// (chrome.debugger.onDetach beat this tick to it) — must not re-attach.
state = mkState();
W = build(state);
await W.applyViewportMode(1, "tablet");
W.attachedTabs.set(1, {});
state.tabs[0].height = 500;
state.calls = [];
state.onTabsGet = async (id) => {
  if (id !== 1) return;
  W.attachedTabs.delete(1); // detached elsewhere; the entry itself is untouched
};
await W.viewportPollTick();
state.onTabsGet = null;
ok(
  state.calls.length === 0,
  `poll tick issues no CDP command for a tab that is no longer attached (got ${JSON.stringify(state.calls)})`
);

// Sanity: with no race at all, the poll tick still re-applies on a genuine
// content-size change — the guard must not swallow the ordinary case.
state = mkState();
W = build(state);
await W.applyViewportMode(1, "tablet");
W.attachedTabs.set(1, {});
state.tabs[0].height = 500;
state.calls = [];
await W.viewportPollTick();
ok(state.calls.length > 0, `a genuine size change with no race still re-applies (got ${JSON.stringify(state.calls)})`);
ok(
  W.viewportModeByTab.get(1) && W.viewportModeByTab.get(1).tabHeight === 500,
  "the entry now reflects the re-applied (correct) size"
);

console.log("\nreapplyEmulatedTabsInWindow (onBoundsChanged) carries the identical race guard\n");

state = mkState();
W = build(state);
await W.applyViewportMode(1, "pc");
W.attachedTabs.set(1, {});
state.calls = [];
state.onTabsGet = async (id) => {
  if (id !== 1) return;
  W.viewportModeByTab.delete(1);
  W.attachedTabs.delete(1);
};
await W.reapplyEmulatedTabsInWindow(10);
state.onTabsGet = null;
ok(
  state.calls.length === 0,
  `onBoundsChanged re-apply issues no CDP command for a tab whose entry vanished mid-await (got ${JSON.stringify(state.calls)})`
);

state = mkState();
W = build(state);
await W.applyViewportMode(1, "pc");
W.attachedTabs.set(1, {});
state.calls = [];
state.onTabsGet = async (id) => {
  if (id !== 1) return;
  W.attachedTabs.delete(1);
};
await W.reapplyEmulatedTabsInWindow(10);
state.onTabsGet = null;
ok(
  state.calls.length === 0,
  `onBoundsChanged re-apply issues no CDP command for a tab that is no longer attached (got ${JSON.stringify(state.calls)})`
);

console.log(
  "\n[root-cause fix] a poll-tick re-apply racing a panel-disconnect clear: the CDP sequence ends " +
    "with the clear, no setDeviceMetricsOverride follows it, and the entry stays absent\n" +
    "(reproduces the live-reported bug: closing the panel widens the tab AND disconnects its port " +
    "at the same moment, which used to let the poll tick's guard pass before the clear had dropped " +
    "the entry, racing its CDP commands against the clear's)\n"
);

state = mkState();
W = build(state);
const portRace = new FakeViewportPort();
connectFakeViewportPort(W, portRace);
portRace.emitMessage({ type: "register", instanceId: "panel-race" });
W.onViewportPanelBind("panel-race", 1);
await W.applyViewportMode(1, "tablet", "panel-race");
ok(W.viewportModeByTab.has(1) && W.attachedTabs.has(1), "set up: tab 1 is emulated (tablet) by panel-race");

// Closing the panel widens the tab (Chrome grows it back to full width the
// instant the side panel goes away) — this is what makes the poll tick
// decide to re-apply.
state.tabs[0].width = 1280;
state.calls = [];
state.broadcasts = [];

// Force the exact live ordering: the re-apply is already mid-flight, blocked
// on its own first CDP command, when the panel's port disconnects.
const reachedA = deferred();
const gateA = deferred();
state.cdpHooks = {
  "Emulation.setDeviceMetricsOverride": () => {
    reachedA.resolve();
    return gateA.promise;
  },
};

const pollPromiseA = W.viewportPollTick();
await reachedA.promise; // the re-apply is now blocked on its own setDeviceMetricsOverride
const disconnectPromiseA = portRace.disconnect(); // NOT awaited to completion yet — its own clear is queued behind the still-blocked re-apply
gateA.resolve(); // release the re-apply's blocked command
await pollPromiseA;
await disconnectPromiseA;

{
  const methods = state.calls.map((c) => c.method);
  ok(!W.viewportModeByTab.has(1), `the entry stays absent once the race settles (got ${JSON.stringify(W.viewportModeByTab.get(1))})`);
  const firstClearIdx = methods.indexOf("Emulation.clearDeviceMetricsOverride");
  ok(firstClearIdx !== -1, `a clear ran (got ${methods.join(", ")})`);
  ok(
    methods.slice(firstClearIdx).indexOf("Emulation.setDeviceMetricsOverride") === -1,
    `no setDeviceMetricsOverride is ever recorded once the clear starts (got ${methods.join(", ")})`
  );
}

console.log(
  "\n[root-cause fix] two rapid operator picks: the final state equals the second pick, and its own " +
    "CDP commands land back-to-back, never interleaved with the first pick's\n"
);

state = mkState();
W = build(state);
state.calls = [];

const reachedB = deferred();
const gateB = deferred();
let firstPickHookFired = false;
state.cdpHooks = {
  "Emulation.setDeviceMetricsOverride": () => {
    if (firstPickHookFired) return undefined; // only gate the FIRST pick's own first command
    firstPickHookFired = true;
    reachedB.resolve();
    return gateB.promise;
  },
};

const pick1 = W.applyViewportMode(1, "mobile"); // operator picks Mobile
await reachedB.promise; // pick 1 is blocked mid-flight on its own first command
const pick2 = W.applyViewportMode(1, "pc"); // operator immediately changes their mind to PC
gateB.resolve(); // release pick 1
const [res1B, res2B] = await Promise.all([pick1, pick2]);

ok(res2B.ok === true && res2B.mode === "pc", `the second pick succeeds (got ${JSON.stringify(res2B)})`);
// The superseded FIRST pick must NOT resolve to {ok:false} — viewport_mode_set's
// handler pipes this straight into the panel, which toasts an error on any
// `!ok`, and the operator changing their mind between two fast picks is not
// an error. It chains to whatever superseded it (viewportLatestResultByTab)
// and so reports the SAME truthful outcome as the second, winning pick.
ok(
  res1B.ok === true && res1B.mode === "pc",
  `the superseded first pick quietly resolves to the SAME outcome as the pick that superseded it, never a bare failure (got ${JSON.stringify(res1B)})`
);
ok(
  W.viewportModeByTab.get(1) && W.viewportModeByTab.get(1).mode === "pc",
  `the final state is the second pick, PC — not the first (got ${JSON.stringify(W.viewportModeByTab.get(1))})`
);
{
  const methods = state.calls.map((c) => c.method);
  const pcMetricsIdx = state.calls.findIndex(
    (c) => c.method === "Emulation.setDeviceMetricsOverride" && c.params && c.params.width === 1280
  );
  ok(pcMetricsIdx !== -1, `PC's own setDeviceMetricsOverride is recorded (got ${methods.join(", ")})`);
  const expectedTail = [
    "Emulation.setDeviceMetricsOverride",
    "Emulation.setTouchEmulationEnabled",
    "Emulation.setEmitTouchEventsForMouse",
    "Emulation.setUserAgentOverride",
    "Runtime.evaluate",
  ];
  ok(
    methods.slice(pcMetricsIdx).join(",") === expectedTail.join(","),
    `PC's own apply sequence lands back-to-back, uninterrupted by anything from the first pick ` +
      `(got ${methods.slice(pcMetricsIdx).join(", ")})`
  );
}

console.log(
  "\n[root-cause fix] a bounds re-apply (onBoundsChanged) enqueued before a Fit pick is a no-op once the Fit lands\n"
);

state = mkState();
W = build(state);
await W.applyViewportMode(1, "pc");
ok(W.viewportModeByTab.has(1) && W.attachedTabs.has(1), "set up: tab 1 is emulated (pc)");
state.calls = [];
state.broadcasts = [];

const reachedC = deferred();
const gateC = deferred();
state.cdpHooks = {
  "Emulation.setDeviceMetricsOverride": () => {
    reachedC.resolve();
    return gateC.promise;
  },
};

const reapplyPromiseC = W.reapplyEmulatedTabsInWindow(10); // the window resized; re-apply enqueued first
await reachedC.promise; // it's blocked mid-flight on its own re-apply
const fitPromiseC = W.applyViewportMode(1, "fit"); // the operator immediately picks Fit
gateC.resolve();
await Promise.all([reapplyPromiseC, fitPromiseC]);

{
  const methods = state.calls.map((c) => c.method);
  ok(!W.viewportModeByTab.has(1), `the entry stays absent: Fit wins over the stale bounds re-apply (got ${JSON.stringify(W.viewportModeByTab.get(1))})`);
  const lastClearIdx = methods.lastIndexOf("Emulation.clearDeviceMetricsOverride");
  ok(lastClearIdx !== -1, `at least one clear ran (got ${methods.join(", ")})`);
  ok(
    methods.slice(lastClearIdx).indexOf("Emulation.setDeviceMetricsOverride") === -1,
    `no setDeviceMetricsOverride follows the final clear (got ${methods.join(", ")})`
  );
}

console.log(
  "\n[root-cause fix] a device-mode pick superseded by an immediate Fit pick also chains cleanly (not just superseded-by-another-device-pick)\n"
);

state = mkState();
W = build(state);
state.calls = [];

const reachedD = deferred();
const gateD = deferred();
state.cdpHooks = {
  "Emulation.setDeviceMetricsOverride": () => {
    reachedD.resolve();
    return gateD.promise;
  },
};

const pickD = W.applyViewportMode(1, "mobile"); // operator picks Mobile
await reachedD.promise; // blocked mid-flight on its own first command
const fitPickD = W.applyViewportMode(1, "fit"); // operator immediately changes their mind to Fit
gateD.resolve();
const [resD, resFitD] = await Promise.all([pickD, fitPickD]);

ok(resFitD.ok === true && resFitD.mode === "fit", `the Fit pick succeeds (got ${JSON.stringify(resFitD)})`);
ok(
  resD.ok === true && resD.mode === "fit",
  `the superseded device-mode pick chains to the Fit clear's own outcome, never a bare failure (got ${JSON.stringify(resD)})`
);
ok(!W.viewportModeByTab.has(1), "the entry stays absent: Fit wins");

console.log(
  "\n[root-cause fix] the debugger detaching mid-flight must never be undone by re-attaching: an apply superseded by a detach reports \"detached\" and issues no further CDP command\n"
);

state = mkState();
W = build(state);
await W.applyViewportMode(1, "tablet");
W.attachedTabs.set(1, {});
ok(W.viewportModeByTab.has(1) && W.attachedTabs.has(1), "set up: tab 1 is emulated (tablet) and attached");
state.calls = [];
state.broadcasts = [];

const reachedE = deferred();
const gateE = deferred();
state.cdpHooks = {
  "Emulation.setDeviceMetricsOverride": () => {
    reachedE.resolve();
    return gateE.promise;
  },
};

const pickE = W.applyViewportMode(1, "mobile"); // operator picks Mobile
await reachedE.promise; // blocked mid-flight on its own first command

// The operator (or Chrome) dismisses the debugging bar: detach the debugger
// exactly the way the real chrome.debugger.onDetach listener does (delete
// attachedTabs FIRST, then call onViewportDebuggerDetach — see
// extension/background.js's own onDetach listener).
W.attachedTabs.delete(1);
W.onViewportDebuggerDetach({ tabId: 1 });

gateE.resolve();
const resE = await pickE;

ok(resE.ok === false && resE.reason === "detached", `the pick reports "detached", not "superseded" (got ${JSON.stringify(resE)})`);
ok(
  !W.attachedTabs.has(1),
  "the debugger is NOT re-attached by the undo path — Chrome already dropped every override when it detached, there is nothing left to clear"
);
{
  const methods = state.calls.map((c) => c.method);
  ok(
    methods.join(",") === "Emulation.setDeviceMetricsOverride",
    `only the one command already in flight when the detach landed was ever sent — no clear/undo commands follow it (got ${methods.join(", ")})`
  );
}
ok(!W.viewportModeByTab.has(1), "the entry stays absent after the detach");

console.log(
  "\n[root-cause fix] a pick superseded by a detach, then re-attached before it checks in again, resolves (never rejects with a chaining cycle) to the detach's own outcome\n"
);

// This is the scenario viewportLatestResultByTab.set(tabId, ...) in
// onViewportDebuggerDetach exists for: without it, a pick superseded
// SPECIFICALLY by a detach, that then finds the debugger re-attached again
// (any agent tool call on this tab attaches it) before it re-checks
// stillCurrent(), would see attachedTabs truthy again -> report itself
// "superseded" rather than "detached" -> and, since nothing else ever
// registered a newer "latest" for this tab, chain to itself: a promise
// resolving to itself never settles (V8 rejects it with "Chaining cycle
// detected"), which would break `.then(sendResponse)` silently. Registering
// the detach's own outcome as the tab's "latest" closes that gap.
state = mkState();
W = build(state);
await W.applyViewportMode(1, "tablet");
W.attachedTabs.set(1, {});
state.calls = [];
state.broadcasts = [];

const reachedF = deferred();
const gateF = deferred();
state.cdpHooks = {
  "Emulation.setDeviceMetricsOverride": () => {
    reachedF.resolve();
    return gateF.promise;
  },
};

const pickF = W.applyViewportMode(1, "mobile");
await reachedF.promise; // blocked mid-flight on its own first command

// Detach, then re-attach (an unrelated agent tool call on this tab) BEFORE
// releasing the blocked pick — the exact ordering that would otherwise flip
// stillAttached() back to true by the time the pick re-checks.
W.attachedTabs.delete(1);
W.onViewportDebuggerDetach({ tabId: 1 });
W.attachedTabs.set(1, {});

gateF.resolve();
let resF;
let rejected = false;
try {
  resF = await pickF;
} catch {
  rejected = true;
}

ok(!rejected, "the pick's promise settles — it does not reject with a chaining cycle");
ok(
  resF && resF.ok === false && resF.reason === "detached",
  `the pick resolves to the detach's own outcome, not its own stale re-check (got ${JSON.stringify(resF)})`
);

console.log(failed ? `\n${failed} FAILED\n` : "\nAll passed\n");
process.exit(failed ? 1 : 0);
