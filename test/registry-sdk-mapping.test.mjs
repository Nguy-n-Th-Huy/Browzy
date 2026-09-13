#!/usr/bin/env node
// Task 6.1 (MAPPING half) — proves every one of the entries recorded in
// the committed baseline (test/fixtures/registry-baseline.json,
// test/registry-baseline.test.mjs) remains reachable through the SDK path
// via host/agent/tools/mapping.js + host/agent/tools/adapter.js, that legacy
// `_mcp`-suffixed names are real, tested, bidirectional internal
// compatibility aliases (design.md decision 6), that the borrowed-tab scope
// primitives (design.md 5b) behave correctly in isolation, and the two
// non-negotiable assertions this task calls out explicitly:
//   - no dropped operation (all entries reachable — originally 26; see
//     TOTAL_REGISTRY_COUNT below for openspec/changes/consume-webmcp-
//     page-tools' 2 post-baseline additions on top of that)
//   - no model access to provider credentials via get_config/set_config
//   - screenshots survive the SDK path as real image content, not text
//
// This is a diff/reachability suite, not a re-run of registry-baseline's own
// checks (which stay untouched, in test/registry-baseline.test.mjs, and are
// re-verified separately in reports/06-preservation-evidence.md).
//
// Run: node test/registry-sdk-mapping.test.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TOOLS } from "../host/tool-definitions.js";
import {
  FRIENDLY_TO_LEGACY,
  LEGACY_TO_FRIENDLY,
  sdkFacingName,
  legacyNameFor,
  sdkFacingDescription,
  sdkFacingToolDefs,
  isMutatingCall,
  isBorrowedTab,
  isTabInRunScope,
  isAgentCreatedTab,
  recordAgentCreatedTab,
  authorizeBorrowedTabMutation,
  isBorrowedTabMutationAuthorized,
  enforceBorrowedTabScope,
  BorrowedTabMutationError,
  extractCreatedTabId,
  normalizeApprovalArgs,
  fingerprintNormalizedArgs,
  _mutationClassificationCoverage
} from "../host/agent/tools/mapping.js";
import { buildSdkTools, adapterToolNames, KNOWN_TOOL_NAMES, createBrowserMcpServer } from "../host/agent/tools/adapter.js";
import { ToolBridge } from "../host/agent/broker/tool-bridge.js";
import { BrowserLease } from "../host/agent/broker/browser-lease.js";
import { ApprovalRegistry } from "../host/agent/policy/approvals.js";
import { Run } from "../host/agent/session/run.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_PATH = path.join(__dirname, "fixtures", "registry-baseline.json");
const BASELINE = JSON.parse(fs.readFileSync(SNAPSHOT_PATH, "utf8"));

// openspec/changes/consume-webmcp-page-tools appended 2 post-baseline
// entries (webmcp_list_tools, webmcp_call_tool),
// openspec/changes/add-browser-batch-tool appended 1 more (browser_batch),
// and openspec/changes/implement-stubbed-browser-tools appended 2 more
// (list_connected_browsers, select_browser) while removing switch_browser
// (recorded in the baseline's removals set) — see
// test/registry-baseline.test.mjs's DESIGN_DOC_TOOL_LIST/
// POST_BASELINE_ADDITIONS / REMOVED_BASELINE_OPERATIONS split, which is this
// repo's canonical source for the three counts. This file cannot import those
// constants directly (that script calls process.exit() at module scope, so
// importing it would run the whole other suite and exit this process), so the
// counts are mirrored here instead — every bare "26" this suite asserted
// before those changes is replaced with the arithmetic below.
const LEGACY_BASELINE_COUNT = 26;
const POST_BASELINE_ADDITIONS_COUNT = 5;
const REMOVED_BASELINE_COUNT = 1;
const TOTAL_REGISTRY_COUNT = LEGACY_BASELINE_COUNT + POST_BASELINE_ADDITIONS_COUNT - REMOVED_BASELINE_COUNT;

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

async function makeRun({ tabScope = "any" } = {}) {
  const lease = new BrowserLease();
  const approvals = new ApprovalRegistry();
  const run = new Run({ conversationId: "conv_mapping", lease, approvals, tabScope });
  await run.begin();
  return run;
}

console.log("\nFriendly-name mapping (design.md decision 6)\n");

await test("exactly the three '_mcp'-suffixed legacy names have a friendly alias; every other tool is its own identity", () => {
  // `.endsWith("_mcp")`, not `.includes("mcp")`: openspec/changes/
  // consume-webmcp-page-tools added "webmcp_list_tools"/"webmcp_call_tool",
  // which contain the substring "mcp" (they are named after the WebMCP
  // protocol) but do not END in "_mcp" and are not legacy compatibility
  // aliases — a substring check would misclassify them. This is a
  // tightening of what the assertion's own message already claimed to
  // check, not a weakening.
  const mcpNames = TOOLS.map((t) => t.name).filter((n) => n.endsWith("_mcp"));
  assert(mcpNames.length === 3, `expected exactly 3 '_mcp'-suffixed legacy names in the live registry, got ${mcpNames.length}: ${mcpNames.join(", ")}`);
  for (const n of mcpNames) assert(FRIENDLY_TO_LEGACY[LEGACY_TO_FRIENDLY[n]] === n, `${n} must round-trip legacy -> friendly -> legacy`);
  for (const t of TOOLS) {
    if (!t.name.endsWith("_mcp")) {
      assert(sdkFacingName(t.name) === t.name, `${t.name} does not end in _mcp and must be its own SDK-facing name`);
    }
  }
});

await test("legacyNameFor() resolves BOTH a friendly alias and an already-legacy name to the same legacy executor contract", () => {
  for (const [friendly, legacy] of Object.entries(FRIENDLY_TO_LEGACY)) {
    assert(legacyNameFor(friendly) === legacy, `legacyNameFor(${friendly}) must resolve to ${legacy}`);
    assert(legacyNameFor(legacy) === legacy, `legacyNameFor(${legacy}) (already legacy) must be idempotent`);
  }
  assert(legacyNameFor("navigate") === "navigate", "a tool with no alias must pass through unchanged");
  assert(legacyNameFor("totally_unknown_tool") === "totally_unknown_tool", "an unrecognized name passes through — unknown-tool rejection is authorization.js's job, not mapping.js's");
});

console.log(`\nAll ${TOTAL_REGISTRY_COUNT} registry entries remain reachable through the SDK mapping (no dropped operation)\n`);

await test(`every one of the ${TOTAL_REGISTRY_COUNT} registry entries has a legacy executor contract reachable via sdkFacingToolDefs()`, () => {
  assert(BASELINE.length === TOTAL_REGISTRY_COUNT, `sanity: committed baseline must have ${TOTAL_REGISTRY_COUNT} entries, has ${BASELINE.length}`);
  const defs = sdkFacingToolDefs();
  assert(defs.length === TOTAL_REGISTRY_COUNT, `sdkFacingToolDefs() must produce exactly ${TOTAL_REGISTRY_COUNT} entries, got ${defs.length}`);
  const byLegacyName = new Map(defs.map((d) => [d.legacyName, d]));
  for (const entry of BASELINE) {
    const def = byLegacyName.get(entry.name);
    assert(def, `baseline entry "${entry.name}" has no corresponding SDK-facing definition — DROPPED OPERATION`);
    assert(def.paramShape === TOOLS.find((t) => t.name === entry.name).paramShape, `${entry.name}'s paramShape must be the EXACT same object as the shared registry's — no schema fork`);
  }
});

await test(`every one of the ${TOTAL_REGISTRY_COUNT} registry entries is registered on the real SDK server via adapterToolNames()/KNOWN_TOOL_NAMES`, () => {
  const registered = new Set(adapterToolNames());
  assert(registered.size === TOTAL_REGISTRY_COUNT, `adapter must expose exactly ${TOTAL_REGISTRY_COUNT} tool names, got ${registered.size}`);
  for (const entry of BASELINE) {
    assert(registered.has(entry.name), `baseline entry "${entry.name}" is not registered on the SDK adapter — DROPPED OPERATION`);
    assert(KNOWN_TOOL_NAMES.has(entry.name), `"${entry.name}" missing from KNOWN_TOOL_NAMES (authorization.js's unknown-tool gate would wrongly reject it)`);
  }
});

await test(`a real SDK tool call for every one of the ${TOTAL_REGISTRY_COUNT} entries reaches the underlying legacy executor by its ORIGINAL name (not a friendly alias that would break the shared registry contract)`, async () => {
  const run = await makeRun();
  const seenNames = [];
  const toolBridge = new ToolBridge({
    init: async () => {},
    callTool: async (name) => { seenNames.push(name); return { content: [{ type: "text", text: `ok:${name}` }] }; },
    shutdown: () => {}
  });
  const sdkTools = buildSdkTools({ toolBridge, coerceArgs: (a) => a, run });
  assert(sdkTools.length === TOTAL_REGISTRY_COUNT, `expected ${TOTAL_REGISTRY_COUNT} SDK tool objects, got ${sdkTools.length}`);
  for (const entry of BASELINE) {
    const sdkTool = sdkTools.find((t) => t.name === entry.name);
    assert(sdkTool, `no SDK tool object for "${entry.name}"`);
    // Build a minimal valid args object from the baseline's required-field list.
    const args = {};
    if (entry.name === "computer") args.action = "screenshot";
    if (entry.name === "javascript_tool") { args.action = "javascript_exec"; args.text = "1"; }
    if (entry.name === "find") args.query = "x";
    if (entry.name === "form_input") { args.ref = "ref_1"; args.value = "x"; }
    if (entry.name === "navigate") args.url = "https://example.com";
    if (entry.name === "resize_window") { args.width = 800; args.height = 600; }
    if (entry.name === "update_plan") { args.domains = []; args.approach = []; }
    if (entry.name === "upload_image") { args.imageId = "img_1"; args.ref = "ref_1"; }
    if (entry.name === "file_upload") {
      // file_upload's existing authorization.js check (unmodified, out of
      // this task's ownership) requires a non-empty, explicitly-allowlisted
      // path — allowlist it here the same way a real upload flow would.
      const p = "/tmp/registry-sdk-mapping-fixture.txt";
      run.uploadAllowlist.allow(p);
      args.paths = [p];
      args.ref = "ref_1";
    }
    if (entry.name === "retranscribe_recording") args.recording_id = "rec_1";
    if (entry.name === "set_config") { args.key = "humanize"; args.value = true; }
    if (entry.name === "webmcp_list_tools") args.tabId = 1;
    if (entry.name === "webmcp_call_tool") {
      // Policy-gap fix: webmcp_call_tool is now correctly gated by
      // enforceBorrowedTabScope (mutating call, TAB_TARGET_ARG_KEYS) — under
      // this test's "any" tabScope, tab 1 is borrowed and unauthorized by
      // default. Authorize it explicitly, the same way file_upload above
      // allowlists its path, so this reachability test still measures
      // reachability rather than tripping the (correct) new authorization
      // requirement. The dedicated borrowed-tab rejection/authorization
      // behavior itself is covered separately below.
      // webmcp_call_tool is send-class (a page-declared tool's effect cannot
      // be bounded from outside the page), so a real dispatch needs the
      // single-use approval grant the Allow path records — and that grant
      // also lifts the borrowed-tab read-only default, exactly as it does
      // for an approved send-class `computer` call. Record one here the same
      // way file_upload above allowlists its path, so this test still
      // measures reachability rather than tripping the (correct) new
      // authorization requirement. The binding and single-use behavior of
      // that grant is covered by its own test below.
      args.tabId = 1;
      args.name = "fixture_tool";
      args.toolArgs = {};
      run.recordApprovalGrant(
        fingerprintNormalizedArgs(normalizeApprovalArgs("webmcp_call_tool", args)),
        { requestId: "registry-sdk-mapping-reachability" }
      );
    }
    await sdkTool.handler(args);
  }
  assert(seenNames.length === TOTAL_REGISTRY_COUNT, `expected ${TOTAL_REGISTRY_COUNT} real dispatches (one per registry entry), got ${seenNames.length}`);
  for (const entry of BASELINE) {
    assert(seenNames.includes(entry.name), `"${entry.name}" was never actually dispatched to the executor by its real legacy name`);
  }
});

console.log("\nSDK-facing description revision (current-page defaults, design.md 5b) never touches the shared registry\n");

await test("sdkFacingDescription() removes the 'mandate a new tab' wording for tabs_context_mcp/tabs_create_mcp without mutating host/tool-definitions.js", () => {
  const contextTool = TOOLS.find((t) => t.name === "tabs_context_mcp");
  const createTool = TOOLS.find((t) => t.name === "tabs_create_mcp");
  const originalContextDesc = contextTool.description;
  const originalCreateDesc = createTool.description;

  const sdkContextDesc = sdkFacingDescription(contextTool);
  const sdkCreateDesc = sdkFacingDescription(createTool);

  assert(/Each new conversation should create its own new tab/.test(originalContextDesc), "sanity: the original wording this task must revise is really there");
  assert(!/Each new conversation should create its own new tab/.test(sdkContextDesc), "SDK-facing description must not mandate creating a new tab");
  assert(/current page|current-page|already provided/.test(sdkContextDesc), "SDK-facing description must state a current-page default instead");

  assert(!/CRITICAL: You must get the context using tabs_context_mcp/.test(sdkCreateDesc), "SDK-facing create-tab description must not mandate the old context-first ritual");

  // The shared registry entry itself is untouched — byte-identical to what
  // test/registry-baseline.test.mjs's committed snapshot already recorded.
  assert(contextTool.description === originalContextDesc, "sdkFacingDescription() must be a pure function — it must never mutate the source TOOLS entry");
  assert(createTool.description === originalCreateDesc, "sdkFacingDescription() must be a pure function — it must never mutate the source TOOLS entry");
  const rebaseline = JSON.parse(fs.readFileSync(SNAPSHOT_PATH, "utf8"));
  const baselineContext = rebaseline.find((e) => e.name === "tabs_context_mcp");
  assert(baselineContext.description === originalContextDesc, "the committed baseline's description must still match the live registry exactly — no drift from this task's SDK-facing rewrite");
});

console.log("\nBorrowed-tab scope primitives (design.md 5b)\n");

await test("a tab in scope but not agent-created is 'borrowed'; a tab the run itself created is not", async () => {
  const run = await makeRun({ tabScope: [10, 20] });
  assert(isTabInRunScope(run, 10) === true, "tab 10 must be in this run's scope");
  assert(isBorrowedTab(run, 10) === true, "tab 10 (in scope, never created by this run) must be borrowed");
  recordAgentCreatedTab(run, 20);
  assert(isAgentCreatedTab(run, 20) === true, "tab 20 must now be recorded as agent-created");
  assert(isBorrowedTab(run, 20) === false, "tab 20 must no longer read as borrowed once agent-created");
  assert(isBorrowedTab(run, 999) === false, "a tab outside this run's scope entirely is neither borrowed nor agent-created here — authorization.js's tab-scope check already rejects it");
});

await test("'any' tabScope: any tabId not recorded as agent-created reads as borrowed", async () => {
  const run = await makeRun({ tabScope: "any" });
  assert(isTabInRunScope(run, 555) === true, "'any' scope includes every tabId");
  assert(isBorrowedTab(run, 555) === true, "an unrecorded tab under 'any' scope is borrowed by default");
  recordAgentCreatedTab(run, 555);
  assert(isBorrowedTab(run, 555) === false, "recording it as agent-created lifts the borrowed classification");
});

await test("borrowed-tab classification is per-run — two different runs never share agent-created state", async () => {
  const runA = await makeRun({ tabScope: [1] });
  const runB = await makeRun({ tabScope: [1] });
  recordAgentCreatedTab(runA, 1);
  assert(isAgentCreatedTab(runA, 1) === true, "runA must see its own recorded tab");
  assert(isAgentCreatedTab(runB, 1) === false, "runB must NOT see runA's agent-created tab — WeakMap keyed by run instance");
  assert(isBorrowedTab(runB, 1) === true, "the same tabId is still borrowed for runB");
});

await test(`isMutatingCall(): computer is classified per-action; every other one of the ${TOTAL_REGISTRY_COUNT} tools falls in exactly one of read-only/mutating`, () => {
  assert(isMutatingCall("computer", { action: "screenshot" }) === false, "screenshot must be read-only");
  assert(isMutatingCall("computer", { action: "zoom" }) === false, "zoom must be read-only");
  assert(isMutatingCall("computer", { action: "scroll" }) === false, "scroll must be read-only (needed to read content beyond the viewport, design.md 5b)");
  assert(isMutatingCall("computer", { action: "left_click" }) === true, "left_click must be mutating");
  assert(isMutatingCall("computer", { action: "type" }) === true, "type must be mutating");
  assert(isMutatingCall("get_page_text") === false, "get_page_text must be read-only");
  assert(isMutatingCall("navigate") === true, "navigate must be mutating");
  assert(isMutatingCall("javascript_tool") === true, "javascript_tool (arbitrary code) must always be treated as mutating");
  assert(isMutatingCall("tabs_close_mcp") === true, "tabs_close_mcp must be mutating");
  // openspec/changes/consume-webmcp-page-tools's two additions: list_tools
  // only reads a passively-maintained table (read-only); call_tool invokes
  // an arbitrary PAGE-DEFINED callback with unknowable-in-advance side
  // effects, classified the same conservative way as javascript_tool.
  assert(isMutatingCall("webmcp_list_tools") === false, "webmcp_list_tools (reads a passive table) must be read-only");
  assert(isMutatingCall("webmcp_call_tool") === true, "webmcp_call_tool (arbitrary page-defined effects) must always be treated as mutating");

  const { readOnly, mutating } = _mutationClassificationCoverage();
  const covered = new Set([...readOnly, ...mutating, "computer"]);
  const liveNames = new Set(TOOLS.map((t) => t.name));
  assert(
    covered.size === TOTAL_REGISTRY_COUNT,
    `classification must cover exactly ${TOTAL_REGISTRY_COUNT} tools (${TOTAL_REGISTRY_COUNT - 1} explicit + computer), covers ${covered.size}`
  );
  for (const name of liveNames) {
    assert(covered.has(name), `"${name}" is not classified as read-only, mutating, or computer — a future registry addition must not silently fall through`);
  }
});

await test("enforceBorrowedTabScope(): a mutating call against a borrowed tab is rejected with BorrowedTabMutationError", async () => {
  const run = await makeRun({ tabScope: [7] });
  let threw = null;
  try {
    enforceBorrowedTabScope({ run, legacyToolName: "navigate", args: { tabId: 7, url: "https://x" } });
  } catch (err) {
    threw = err;
  }
  assert(threw instanceof BorrowedTabMutationError, "must throw BorrowedTabMutationError for a mutation on a borrowed tab");
  assert(threw.tabId === 7, "the error must name the exact tab it rejected");
});

await test("enforceBorrowedTabScope(): a READ-ONLY call against a borrowed tab is allowed", async () => {
  const run = await makeRun({ tabScope: [7] });
  enforceBorrowedTabScope({ run, legacyToolName: "get_page_text", args: { tabId: 7 } }); // must not throw
});

await test("enforceBorrowedTabScope(): a mutating call against an AGENT-CREATED tab is allowed (it is not borrowed)", async () => {
  const run = await makeRun({ tabScope: [8] });
  recordAgentCreatedTab(run, 8);
  enforceBorrowedTabScope({ run, legacyToolName: "navigate", args: { tabId: 8, url: "https://x" } }); // must not throw
});

await test("enforceBorrowedTabScope(): mutation without task authorization is rejected; explicit authorization lifts it for that exact tab", async () => {
  const run = await makeRun({ tabScope: [9, 10] });
  let threw = null;
  try {
    enforceBorrowedTabScope({ run, legacyToolName: "form_input", args: { tabId: 9, ref: "ref_1", value: "x" } });
  } catch (err) { threw = err; }
  assert(threw instanceof BorrowedTabMutationError, "must reject without authorization");
  assert(isBorrowedTabMutationAuthorized(run, 9) === false, "must read as not-yet-authorized");

  authorizeBorrowedTabMutation(run, 9);
  assert(isBorrowedTabMutationAuthorized(run, 9) === true, "must read as authorized after the explicit call");
  enforceBorrowedTabScope({ run, legacyToolName: "form_input", args: { tabId: 9, ref: "ref_1", value: "x" } }); // must NOT throw now

  // Authorization is scoped to the exact tab — a DIFFERENT borrowed tab on the
  // same run is still rejected.
  let threw2 = null;
  try {
    enforceBorrowedTabScope({ run, legacyToolName: "form_input", args: { tabId: 10, ref: "ref_1", value: "x" } });
  } catch (err) { threw2 = err; }
  assert(threw2 instanceof BorrowedTabMutationError, "authorizing tab 9 must not silently authorize tab 10 too");
});

await test("enforceBorrowedTabScope(): webmcp_call_tool (arbitrary page-defined execution) on a borrowed tab is rejected without authorization; explicit authorization lifts it", async () => {
  // Policy-gap fix: webmcp_call_tool invokes a PAGE-DEFINED callback with
  // unknowable-in-advance side effects and is classified mutating (same
  // conservative treatment as javascript_tool). Before this fix, neither
  // authorization.js's TAB_ARG_KEYS nor mapping.js's TAB_TARGET_ARG_KEYS
  // listed webmcp_call_tool, so this gate was a silent no-op for it — a
  // page-defined tool could be invoked against a borrowed tab with no
  // authorization at all.
  const run = await makeRun({ tabScope: [21] });
  let threw = null;
  try {
    enforceBorrowedTabScope({ run, legacyToolName: "webmcp_call_tool", args: { tabId: 21, name: "fixture_tool", toolArgs: {} } });
  } catch (err) { threw = err; }
  assert(threw instanceof BorrowedTabMutationError, "webmcp_call_tool against a borrowed tab must be rejected without authorization");
  assert(threw.tabId === 21, "the error must name the exact tab it rejected");

  authorizeBorrowedTabMutation(run, 21);
  enforceBorrowedTabScope({ run, legacyToolName: "webmcp_call_tool", args: { tabId: 21, name: "fixture_tool", toolArgs: {} } }); // must NOT throw now
});

await test("enforceBorrowedTabScope(): webmcp_list_tools (read-only) on a borrowed tab is allowed with no authorization required", async () => {
  // webmcp_list_tools only reads the passively-maintained per-tab page-tool
  // table — no page or browser side effect — so it must behave exactly like
  // every other read-only tool (get_page_text, read_page) against a borrowed
  // tab: allowed unconditionally.
  const run = await makeRun({ tabScope: [22] });
  enforceBorrowedTabScope({ run, legacyToolName: "webmcp_list_tools", args: { tabId: 22 } }); // must not throw
  assert(isBorrowedTabMutationAuthorized(run, 22) === false, "a read-only call must not implicitly authorize the tab for mutation");
});

await test("the SDK adapter itself rejects an UNAPPROVED webmcp_call_tool dispatch on a borrowed tab (integration, not just the standalone gate)", async () => {
  let dispatched = false;
  const run = await makeRun({ tabScope: [23] });
  const toolBridge = new ToolBridge({
    init: async () => {},
    callTool: async () => { dispatched = true; return { content: [{ type: "text", text: "should never run" }] }; },
    shutdown: () => {}
  });
  const sdkTools = buildSdkTools({ toolBridge, coerceArgs: (a) => a, run });
  const webmcpCallTool = sdkTools.find((t) => t.name === "webmcp_call_tool");
  const result = await webmcpCallTool.handler({ tabId: 23, name: "fixture_tool", toolArgs: {} });
  assert(result.isError === true, "an unapproved webmcp_call_tool dispatch must be reported as an error result");
  // webmcp_call_tool is send-class, so the approval check runs BEFORE
  // enforceBorrowedTabScope and is what rejects here. The borrowed-tab
  // default is still enforced — it is simply no longer the first gate this
  // call can fail, because a page-declared tool cannot dispatch at all
  // without a grant for these exact arguments.
  assert(/approval/i.test(result.content[0].text), `the rejection must explain the missing approval, got: ${result.content[0].text}`);
  assert(!dispatched, "the underlying tool bridge must NEVER be reached for a rejected webmcp_call_tool dispatch");
});

await test("an approved webmcp_call_tool grant is bound to the exact page-declared tool it named, and is single-use", async () => {
  let dispatched = 0;
  const run = await makeRun({ tabScope: [23] });
  const toolBridge = new ToolBridge({
    init: async () => {},
    callTool: async () => { dispatched += 1; return { content: [{ type: "text", text: "ran" }] }; },
    shutdown: () => {}
  });
  const sdkTools = buildSdkTools({ toolBridge, coerceArgs: (a) => a, run });
  const webmcpCallTool = sdkTools.find((t) => t.name === "webmcp_call_tool");

  const approved = { tabId: 23, name: "add_to_cart", toolArgs: { productId: "p3" } };
  const grantFor = (args) => fingerprintNormalizedArgs(normalizeApprovalArgs("webmcp_call_tool", args));

  // A grant for add_to_cart must NOT satisfy a call to a different tool —
  // otherwise one Allow would authorize every page-declared tool on the page.
  run.recordApprovalGrant(grantFor(approved), { requestId: "r1" });
  const otherTool = await webmcpCallTool.handler({ tabId: 23, name: "delete_account", toolArgs: { productId: "p3" } });
  assert(otherTool.isError === true, "a grant for one page-declared tool must not authorize a different one");
  assert(dispatched === 0, "a differently-named page tool must never reach the bridge on someone else's grant");

  // Nor a different argument set for the same tool.
  const otherArgs = await webmcpCallTool.handler({ tabId: 23, name: "add_to_cart", toolArgs: { productId: "p9" } });
  assert(otherArgs.isError === true, "a grant must not authorize the same tool with different arguments");
  assert(dispatched === 0, "different arguments must never reach the bridge on someone else's grant");

  // The exact approved call goes through, and lifts the borrowed-tab default.
  const ok = await webmcpCallTool.handler({ ...approved, toolArgs: { productId: "p3" } });
  assert(!ok.isError, `the exact approved call must dispatch, got: ${ok.content?.[0]?.text}`);
  assert(dispatched === 1, "the approved call must reach the bridge exactly once");

  // Single-use: replaying it must not dispatch again.
  const replay = await webmcpCallTool.handler({ ...approved, toolArgs: { productId: "p3" } });
  assert(replay.isError === true, "an approval grant must be single-use, not replayable");
  assert(dispatched === 1, "a replayed grant must not produce a second dispatch");
});

await test("the SDK adapter allows webmcp_list_tools on the same borrowed tab (read-only default access works)", async () => {
  let dispatched = false;
  const run = await makeRun({ tabScope: [23] });
  const toolBridge = new ToolBridge({
    init: async () => {},
    callTool: async (name) => { dispatched = true; return { content: [{ type: "text", text: `page tools for ${name}` }] }; },
    shutdown: () => {}
  });
  const sdkTools = buildSdkTools({ toolBridge, coerceArgs: (a) => a, run });
  const webmcpListTools = sdkTools.find((t) => t.name === "webmcp_list_tools");
  const result = await webmcpListTools.handler({ tabId: 23 });
  assert(dispatched === true, "webmcp_list_tools on a borrowed tab must reach the executor");
  assert(!result.isError, "webmcp_list_tools on a borrowed tab must not be an error");
});

await test("the SDK adapter itself rejects a mutation on a borrowed tab (integration, not just the standalone gate)", async () => {
  let dispatched = false;
  const run = await makeRun({ tabScope: [11] });
  const toolBridge = new ToolBridge({
    init: async () => {},
    callTool: async () => { dispatched = true; return { content: [{ type: "text", text: "should never run" }] }; },
    shutdown: () => {}
  });
  const sdkTools = buildSdkTools({ toolBridge, coerceArgs: (a) => a, run });
  const navigate = sdkTools.find((t) => t.name === "navigate");
  const result = await navigate.handler({ url: "https://example.com", tabId: 11 });
  assert(result.isError === true, "a borrowed-tab mutation must be reported as an error result");
  assert(/borrowed/i.test(result.content[0].text), `the rejection must explain it is a borrowed-tab issue, got: ${result.content[0].text}`);
  assert(!dispatched, "the underlying tool bridge must NEVER be reached for a rejected borrowed-tab mutation");
});

await test("the SDK adapter allows a READ on the same borrowed tab (read-only default access works)", async () => {
  let dispatched = false;
  const run = await makeRun({ tabScope: [12] });
  const toolBridge = new ToolBridge({
    init: async () => {},
    callTool: async (name) => { dispatched = true; return { content: [{ type: "text", text: `page text for ${name}` }] }; },
    shutdown: () => {}
  });
  const sdkTools = buildSdkTools({ toolBridge, coerceArgs: (a) => a, run });
  const getPageText = sdkTools.find((t) => t.name === "get_page_text");
  const result = await getPageText.handler({ tabId: 12 });
  assert(dispatched === true, "a read on a borrowed tab must reach the executor");
  assert(!result.isError, "a read on a borrowed tab must not be an error");
});

await test("extractCreatedTabId(): parses the real tabs_create_mcp result-text shape, and returns null for anything else", () => {
  const result = { content: [{ type: "text", text: "Created new tab. Tab ID: 4242\n\n{...}" }] };
  assert(extractCreatedTabId(result) === 4242, "must extract the numeric tab id from the shipped handler's exact text shape");
  assert(extractCreatedTabId({ content: [{ type: "text", text: "no id here" }] }) === null, "must return null, not throw, when the shape does not match");
  assert(extractCreatedTabId(null) === null, "must return null for a missing result");
});

await test("a successful SDK-path create_tab (tabs_create_mcp) call records the new tab as agent-created on the run", async () => {
  const run = await makeRun({ tabScope: "any" });
  const toolBridge = new ToolBridge({
    init: async () => {},
    callTool: async () => ({ content: [{ type: "text", text: "Created new tab. Tab ID: 777\n\n{}" }] }),
    shutdown: () => {}
  });
  const sdkTools = buildSdkTools({ toolBridge, coerceArgs: (a) => a, run });
  const createTab = sdkTools.find((t) => t.name === "tabs_create_mcp");
  await createTab.handler({});
  assert(isAgentCreatedTab(run, 777) === true, "tab 777 must now be recorded as this run's own agent-created tab");
  assert(isBorrowedTab(run, 777) === false, "the run's own new tab must never read as borrowed");
});

console.log("\nNon-negotiable assertions\n");

await test("no provider-credential-shaped key is reachable through get_config/set_config via the SDK path (same CONFIG_SCHEMA the baseline already verified)", () => {
  const getConfig = TOOLS.find((t) => t.name === "get_config");
  const setConfig = TOOLS.find((t) => t.name === "set_config");
  assert(getConfig && setConfig, "sanity: both tools must exist");
  // The SDK path dispatches through the SAME shared executor
  // (extension/background.js's CONFIG_SCHEMA, verified exhaustively by
  // test/registry-baseline.test.mjs) — there is no SDK-only config surface
  // that could reintroduce a credential-shaped key. This assertion pins that
  // sdkFacingToolDefs()/buildSdkTools() do not add any new argument to
  // either tool's paramShape (which would be the only way a new key could
  // even be requested).
  const sdkGetConfig = sdkFacingToolDefs().find((t) => t.legacyName === "get_config");
  const sdkSetConfig = sdkFacingToolDefs().find((t) => t.legacyName === "set_config");
  assert(sdkGetConfig.paramShape === getConfig.paramShape, "get_config's SDK-facing paramShape must be the exact same schema object — no SDK-only fields");
  assert(sdkSetConfig.paramShape === setConfig.paramShape, "set_config's SDK-facing paramShape must be the exact same schema object — no SDK-only fields");
});

await test("screenshots survive the SDK path as REAL image content, never collapsed to text", async () => {
  const run = await makeRun({ tabScope: "any" });
  const imageBlock = { type: "image", data: "QUJD", mimeType: "image/png" };
  const toolBridge = new ToolBridge({
    init: async () => {},
    callTool: async () => ({ content: [imageBlock] }),
    shutdown: () => {}
  });
  const sdkTools = buildSdkTools({ toolBridge, coerceArgs: (a) => a, run });
  const computer = sdkTools.find((t) => t.name === "computer");
  const result = await computer.handler({ action: "screenshot", tabId: 1 });
  assert(Array.isArray(result.content) && result.content.length === 1, "result must carry exactly the one content block returned");
  assert(result.content[0].type === "image", "the SDK path must never convert an image content block into text");
  assert(result.content[0].data === "QUJD", "image bytes must be passed through byte-for-byte");
  assert(result.content[0].mimeType === "image/png", "mimeType must be preserved");
});

const failed = results.filter((r) => !r.ok);
console.log(
  `\n${results.length - failed.length}/${results.length} passed` +
    (failed.length ? `\n\nFailures:\n${failed.map((f) => `  - ${f.name}: ${f.err}`).join("\n")}` : "") +
    "\n"
);
process.exit(failed.length ? 1 : 0);
