#!/usr/bin/env node
// Task 6.1 (MAPPING half) — proves every one of the 26 entries recorded in
// the committed baseline (test/fixtures/registry-baseline.json,
// test/registry-baseline.test.mjs) remains reachable through the SDK path
// via host/agent/tools/mapping.js + host/agent/tools/adapter.js, that legacy
// `_mcp`-suffixed names are real, tested, bidirectional internal
// compatibility aliases (design.md decision 6), that the borrowed-tab scope
// primitives (design.md 5b) behave correctly in isolation, and the two
// non-negotiable assertions this task calls out explicitly:
//   - no dropped operation (all 26 reachable)
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
  const mcpNames = TOOLS.map((t) => t.name).filter((n) => n.includes("mcp"));
  assert(mcpNames.length === 3, `expected exactly 3 mcp-suffixed names in the live registry, got ${mcpNames.length}: ${mcpNames.join(", ")}`);
  for (const n of mcpNames) assert(FRIENDLY_TO_LEGACY[LEGACY_TO_FRIENDLY[n]] === n, `${n} must round-trip legacy -> friendly -> legacy`);
  for (const t of TOOLS) {
    if (!t.name.includes("mcp")) {
      assert(sdkFacingName(t.name) === t.name, `${t.name} has no mcp substring and must be its own SDK-facing name`);
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

console.log("\nAll 26 registry entries remain reachable through the SDK mapping (no dropped operation)\n");

await test("every one of the 26 baseline entries has a legacy executor contract reachable via sdkFacingToolDefs()", () => {
  assert(BASELINE.length === 26, `sanity: committed baseline must have 26 entries, has ${BASELINE.length}`);
  const defs = sdkFacingToolDefs();
  assert(defs.length === 26, `sdkFacingToolDefs() must produce exactly 26 entries, got ${defs.length}`);
  const byLegacyName = new Map(defs.map((d) => [d.legacyName, d]));
  for (const entry of BASELINE) {
    const def = byLegacyName.get(entry.name);
    assert(def, `baseline entry "${entry.name}" has no corresponding SDK-facing definition — DROPPED OPERATION`);
    assert(def.paramShape === TOOLS.find((t) => t.name === entry.name).paramShape, `${entry.name}'s paramShape must be the EXACT same object as the shared registry's — no schema fork`);
  }
});

await test("every one of the 26 baseline entries is registered on the real SDK server via adapterToolNames()/KNOWN_TOOL_NAMES", () => {
  const registered = new Set(adapterToolNames());
  assert(registered.size === 26, `adapter must expose exactly 26 tool names, got ${registered.size}`);
  for (const entry of BASELINE) {
    assert(registered.has(entry.name), `baseline entry "${entry.name}" is not registered on the SDK adapter — DROPPED OPERATION`);
    assert(KNOWN_TOOL_NAMES.has(entry.name), `"${entry.name}" missing from KNOWN_TOOL_NAMES (authorization.js's unknown-tool gate would wrongly reject it)`);
  }
});

await test("a real SDK tool call for every one of the 26 entries reaches the underlying legacy executor by its ORIGINAL name (not a friendly alias that would break the shared registry contract)", async () => {
  const run = await makeRun();
  const seenNames = [];
  const toolBridge = new ToolBridge({
    init: async () => {},
    callTool: async (name) => { seenNames.push(name); return { content: [{ type: "text", text: `ok:${name}` }] }; },
    shutdown: () => {}
  });
  const sdkTools = buildSdkTools({ toolBridge, coerceArgs: (a) => a, run });
  assert(sdkTools.length === 26, `expected 26 SDK tool objects, got ${sdkTools.length}`);
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
    await sdkTool.handler(args);
  }
  assert(seenNames.length === 26, `expected 26 real dispatches (one per registry entry), got ${seenNames.length}`);
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

await test("isMutatingCall(): computer is classified per-action; every other one of the 26 tools falls in exactly one of read-only/mutating", () => {
  assert(isMutatingCall("computer", { action: "screenshot" }) === false, "screenshot must be read-only");
  assert(isMutatingCall("computer", { action: "zoom" }) === false, "zoom must be read-only");
  assert(isMutatingCall("computer", { action: "scroll" }) === false, "scroll must be read-only (needed to read content beyond the viewport, design.md 5b)");
  assert(isMutatingCall("computer", { action: "left_click" }) === true, "left_click must be mutating");
  assert(isMutatingCall("computer", { action: "type" }) === true, "type must be mutating");
  assert(isMutatingCall("get_page_text") === false, "get_page_text must be read-only");
  assert(isMutatingCall("navigate") === true, "navigate must be mutating");
  assert(isMutatingCall("javascript_tool") === true, "javascript_tool (arbitrary code) must always be treated as mutating");
  assert(isMutatingCall("tabs_close_mcp") === true, "tabs_close_mcp must be mutating");

  const { readOnly, mutating } = _mutationClassificationCoverage();
  const covered = new Set([...readOnly, ...mutating, "computer"]);
  const liveNames = new Set(TOOLS.map((t) => t.name));
  assert(covered.size === 26, `classification must cover exactly 26 tools (25 explicit + computer), covers ${covered.size}`);
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
