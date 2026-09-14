#!/usr/bin/env node
// Extension side of openspec/changes/add-workflow-materialization-and-heal
// (tasks.md 3.1/3.2's extension half, the prove path): the workflow_prove
// request handler, the executor's drift classification, the freshness notes on
// content-producing steps, and the ONE stable result marker the companion
// parses.
//
// Shipped code only: everything below is pulled out of extension/background.js
// by test/_extract.mjs's brace-matcher and compiled against injected
// dependencies, exactly as test/shortcut-handlers.test.mjs (the pre-existing
// suite for the same executor) already does. That suite is deliberately NOT
// modified by this change: its two-argument call must keep working, which is
// part of what the guards inside runShortcutToolSteps() are for.
//
// Run: node test/shortcut-prove-handler.test.mjs

import { extractFunction, extractMethod, compile } from "./_extract.mjs";

let fail = 0;
const ok = (cond, msg) => {
  console.log((cond ? "  PASS  " : "  FAIL  ") + msg);
  if (!cond) fail++;
};

// ---- shipped source, compiled once ----------------------------------------
const VALIDATORS = compile(
  [extractFunction("validateWorkflowProveArgs"), extractFunction("validateShortcutsExecuteArgs")].join("\n\n"),
  {},
  "{ validateWorkflowProveArgs, validateShortcutsExecuteArgs }"
);

const DOMAINS = compile(
  [
    extractFunction("normalizeWorkflowHost"),
    extractFunction("workflowHostOfUrl"),
    extractFunction("workflowDomainMatches"),
    extractFunction("workflowDomainPatterns"),
    extractFunction("workflowBindingCheck")
  ].join("\n\n"),
  {},
  "{ normalizeWorkflowHost, workflowHostOfUrl, workflowDomainMatches, workflowDomainPatterns, workflowBindingCheck }"
);

const CLASSIFY = compile(
  [extractFunction("shortcutDriftReason"), extractFunction("shortcutStepProducesContent"), extractFunction("shortcutResultMarkerLine")].join("\n\n"),
  {},
  "{ shortcutDriftReason, shortcutStepProducesContent, shortcutResultMarkerLine }"
);

/** Compile runShortcutToolSteps() with the same classifier helpers the module
 * itself closes over (extracted from source, so the guards inside resolve to
 * the real functions rather than to null). */
function buildExecutor({ tools, tabUrl = "https://example.com/orders" } = {}) {
  const calls = [];
  const toolHandlers = tools || {
    read_page: async (a) => {
      calls.push(["read_page", a]);
      return { content: [{ type: "text", text: "Title: Orders\nURL: https://example.com/orders" }] };
    },
    navigate: async (a) => {
      calls.push(["navigate", a]);
      return { content: [{ type: "text", text: "navigated" }] };
    },
    boom: async () => {
      calls.push(["boom", {}]);
      throw new Error("kaput");
    },
    stale_ref: async () => {
      calls.push(["stale_ref", {}]);
      return {
        content: [
          {
            type: "text",
            text: `Could not resolve ref "ref_3" to coordinates. The page may have changed — re-run read_page or find for a fresh ref.`
          }
        ]
      };
    },
    gone_ref: async () => {
      calls.push(["gone_ref", {}]);
      return {
        content: [{ type: "text", text: `Ref "ref_9" no longer exists on the page — the element was removed since it was found.` }]
      };
    }
  };
  const run = compile(
    [
      extractFunction("runShortcutToolSteps"),
      extractFunction("batchItemResultFailed"),
      extractFunction("shortcutDriftReason"),
      extractFunction("shortcutStepProducesContent"),
      extractFunction("shortcutResultMarkerLine"),
      extractFunction("workflowBindingCheck"),
      extractFunction("workflowDomainPatterns"),
      extractFunction("workflowDomainMatches"),
      extractFunction("workflowHostOfUrl"),
      extractFunction("normalizeWorkflowHost")
    ].join("\n\n"),
    {
      toolHandlers,
      SHORTCUT_TAB_SCOPED_TOOLS: new Set(["navigate", "read_page"]),
      shortcutStepTabUrl: async () => tabUrl
    },
    "{ runShortcutToolSteps }"
  ).runShortcutToolSteps;
  return { run, calls };
}

/** The marker line the companion reads: `OCIC_WORKFLOW_RESULT <json>`. */
function parseMarker(marker) {
  if (typeof marker !== "string") return null;
  const prefix = "OCIC_WORKFLOW_RESULT ";
  if (!marker.startsWith(prefix)) return null;
  const json = marker.slice(prefix.length);
  if (json.includes("\n")) return null; // the marker is ONE line, by contract
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

const def = (steps, extra = {}) => ({ id: "wf-demo", steps, ...extra });

// ==========================================================================
console.log("== workflow_prove argument validation ==");
{
  const v = VALIDATORS.validateWorkflowProveArgs;
  ok(v(null).ok === false && /arguments object/.test(v(null).message), "rejects a missing arguments object");
  ok(v({ definition: { steps: [{}] } }).ok === false && /numeric tabId/.test(v({ definition: { steps: [{}] } }).message), "requires a numeric tabId");
  ok(v({ tabId: 1 }).ok === false && /resolved workflow definition/.test(v({ tabId: 1 }).message), "requires the resolved definition");
  const empty = v({ tabId: 1, definition: { steps: [] } });
  ok(empty.ok === false && /at least one step/.test(empty.message), "requires at least one step");
  const good = v({ tabId: 7, workflowId: "wf-a", version: 3, definition: { id: "wf-a", steps: [{ kind: "tool", ref: "read_page", args: {} }] } });
  ok(good.ok === true && good.tabId === 7 && good.workflowId === "wf-a" && good.version === 3, "accepts and echoes the record identity");
  const byDefinition = v({ tabId: 7, definition: { id: "wf-b", version: 5, steps: [{ kind: "tool", ref: "read_page" }] } });
  ok(byDefinition.workflowId === "wf-b" && byDefinition.version === 5, "falls back to the definition's own id/version when the request omits them");
}

console.log("\n== domain pre-flight mirrors host/agent/skills/workflows-match.js ==");
{
  const { domainMatches, hostOfUrl, bindingCheck } = {
    domainMatches: DOMAINS.workflowDomainMatches,
    hostOfUrl: DOMAINS.workflowHostOfUrl,
    bindingCheck: DOMAINS.workflowBindingCheck
  };
  ok(hostOfUrl("https://Example.COM/orders") === "example.com", "the URL host is normalized (lowercased, no trailing dot)");
  ok(hostOfUrl("not a url") === null, "an unparseable URL yields no host");
  ok(domainMatches("example.com", "example.com") === true, "exact host match");
  ok(domainMatches("a.example.com", "*.example.com") === true, "a wildcard constraint matches a subdomain");
  ok(domainMatches("example.com", "*.example.com") === false, "a wildcard constraint does NOT match the bare domain");
  ok(domainMatches("notexample.com", "example.com") === false, "never a superstring host");
  ok(domainMatches("example.com", "*.example.com") === false && domainMatches("example.com.evil.test", "example.com") === false, "no substring matching anywhere");

  const unconstrained = bindingCheck(def([{ kind: "tool", ref: "read_page" }]), "https://other.test/x");
  ok(unconstrained.applies === false && unconstrained.ok === true, "a definition that declares no domain is never a binding mismatch");

  const match = bindingCheck(def([{ kind: "tool", ref: "read_page" }], { domainConstraints: ["example.com"] }), "https://example.com/orders");
  ok(match.applies === true && match.ok === true && match.evidence === null, "a declared domain that still matches passes");
  const mismatch = bindingCheck(def([{ kind: "tool", ref: "read_page" }], { domainConstraints: ["{domains: []}"] } && { domainConstraints: ["example.com"] }), "https://evil.test/orders");
  ok(mismatch.applies === true && mismatch.ok === false, "a declared domain that no longer matches fails");
  ok(mismatch.evidence && mismatch.evidence.expected[0] === "example.com" && mismatch.evidence.actualHost === "evil.test", "the mismatch carries its evidence (expected vs actual)");
  ok(DOMAINS.workflowDomainPatterns({ domainConstraints: { domains: ["a.test"] } })[0] === "a.test", "the {domains:[...]} shape is read too");
}

console.log("\n== step classification: drift only on evidence the site changed ==");
{
  const { shortcutDriftReason: driftReason, shortcutStepProducesContent: producesContent } = CLASSIFY;
  ok(driftReason(`Could not resolve ref "ref_3" to coordinates.`) === "target_no_longer_resolves", "an unresolvable ref is target_no_longer_resolves");
  ok(driftReason(`Ref "ref_9" no longer exists on the page.`) === "target_no_longer_resolves", "a removed element is target_no_longer_resolves");
  ok(driftReason(`Could not bring ref "ref_1" into view — it is still outside the viewport.`) === "target_no_longer_resolves", "the shipped staleness rule (could not bring into view) is kept");
  ok(
    driftReason(`Could not resolve the step target link "Tìm kiếm" — no element matching that identity exists on the page.`) === "target_no_longer_resolves",
    "a frozen target that no longer matches anything is target_no_longer_resolves (a replayed step's real drift)"
  );
  ok(
    driftReason(`Could not bring the step target combobox "Nơi thực hiện" into view — it is still outside the viewport.`) === "target_no_longer_resolves",
    "an unreachable frozen target classifies the same way"
  );
  ok(driftReason("Error: net::ERR_CONNECTION_RESET") === null, "a transport error is NOT drift");
  ok(driftReason("Tab 4 is not in the MCP group.") === null, "a scope refusal is NOT drift");
  ok(driftReason("") === null && driftReason(undefined) === null, "an empty message classifies as nothing");

  ok(producesContent("read_page", {}) === true && producesContent("get_page_text", {}) === true && producesContent("find", {}) === true, "read/find steps are content-producing");
  ok(producesContent("computer", { action: "screenshot" }) === true && producesContent("computer", { action: "zoom" }) === true, "a screenshot/zoom capture is content-producing");
  ok(producesContent("computer", { action: "left_click" }) === false && producesContent("navigate", {}) === false, "a click or navigation is not");
}

// ==========================================================================
console.log("\n== executor: a healthy run reports per-step outcomes, freshness, and outcome:\"ok\" ==");
{
  const { run, calls } = buildExecutor();
  const r = await run(def([{ kind: "tool", ref: "read_page", args: {} }, { kind: "tool", ref: "navigate", args: { url: "https://example.com/next" } }]), 42);
  ok(r.ok === true && r.outcomes.length === 2 && calls.length === 2, "both steps ran and are reported");
  const first = r.outcomes[0];
  ok(first.status === "ok" && first.index === 0 && first.ref === "read_page", "the content step's outcome is ok and indexed");
  ok(first.url === "https://example.com/orders" && typeof first.fetchedAt === "string", "a content step carries the live URL and the fetch time");
  ok(!r.outcomes[1].url && !r.outcomes[1].fetchedAt, "a non-content step carries no freshness claim");
  ok(r.finalUrl === "https://example.com/orders", "the run reports the URL it ended on");
  const marker = parseMarker(r.marker);
  ok(marker !== null, "the result carries a parseable OCIC_WORKFLOW_RESULT marker on ONE line");
  ok(marker.outcome === "ok" && !marker.drift && marker.steps.length === 2, "a healthy run's marker says ok and carries no drift object");
  ok(marker.steps[0].url === "https://example.com/orders" && marker.steps[0].fetchedAt, "the marker keeps each step's freshness evidence");
}

console.log("\n== executor: a gone target ends the run as DRIFT, naming the step ==");
{
  const { run, calls } = buildExecutor();
  const r = await run(def([{ kind: "tool", ref: "stale_ref", args: {} }, { kind: "tool", ref: "navigate", args: {} }]), 42);
  ok(r.ok === false && calls.length === 1, "the run stops at the failing step (nothing after it is attempted)");
  const bad = r.outcomes[0];
  ok(bad.status === "failed" && bad.reason === "target_no_longer_resolves", "the step is failed with the drift reason");
  ok(r.drift && r.drift.step === 0 && r.drift.ref === "stale_ref" && r.drift.reason === "target_no_longer_resolves", "the run carries a drift object naming the step and ref");
  ok(/no longer exists|Could not resolve ref/.test(String(r.drift.evidence)), "the drift carries the handler's own evidence text");
  const marker = parseMarker(r.marker);
  ok(marker && marker.outcome === "drift" && marker.drift.reason === "target_no_longer_resolves" && marker.drift.step === 0, "the marker reports drift (never ok, never a bare failure)");
  ok(marker.steps.length === 1 && marker.steps[0].status === "failed", "the marker's steps carry the failing step");

  const gone = buildExecutor();
  const r2 = await gone.run(def([{ kind: "tool", ref: "gone_ref", args: {} }]), 42);
  ok(r2.drift && r2.drift.reason === "target_no_longer_resolves", "the second shipped stale-ref wording classifies the same way");

  // The catch path (a handler that THROWS a ref-gone message) classifies too.
  const throwing = buildExecutor({
    tools: {
      boom_ref: async () => {
        throw new Error(`Could not resolve ref "ref_1" to coordinates. The page may have changed.`);
      }
    }
  });
  const r3 = await throwing.run(def([{ kind: "tool", ref: "boom_ref", args: {} }]), 42);
  ok(r3.drift && r3.drift.reason === "target_no_longer_resolves", "a thrown ref-gone error is classified as drift as well");
}

console.log("\n== executor: a transient failure stays an ordinary failure (never drift) ==");
{
  const { run } = buildExecutor();
  const r = await run(def([{ kind: "tool", ref: "read_page", args: {} }, { kind: "tool", ref: "boom", args: {} }]), 42);
  ok(r.ok === false && r.drift === null, "a transport-class failure produces NO drift object");
  ok(r.outcomes[1].status === "failed" && r.outcomes[1].reason === "transient", "the failing step is failed/transient");
  const marker = parseMarker(r.marker);
  ok(marker && marker.outcome === "failed" && !("drift" in marker), "the marker says failed and carries no drift field");
  ok(marker.steps.length === 2 && marker.steps[1].reason === "transient", "the marker's steps carry the transient reason for the companion's record");
}

console.log("\n== executor: pre-flight binding mismatch refuses before any step runs ==");
{
  const { run, calls } = buildExecutor({ tabUrl: "https://other.test/orders" });
  const r = await run(def([{ kind: "tool", ref: "read_page", args: {} }], { domainConstraints: ["example.com"] }), 42);
  ok(calls.length === 0, "nothing ran on the wrong site");
  ok(r.ok === false && r.outcomes.length === 0, "no step outcome is invented for a run that never started");
  ok(r.drift && r.drift.reason === "binding_mismatch" && r.drift.step === null, "the drift names the binding mismatch (step null: no step was reached)");
  const marker = parseMarker(r.marker);
  ok(marker && marker.outcome === "drift" && marker.drift.reason === "binding_mismatch", "the marker reports the binding mismatch as drift");
  ok(String(r.error).includes("example.com"), "the human line names the expected domain");
}

console.log("\n== executor: skill/message steps are unexecutable in a PROOF run, refused in an ordinary one ==");
{
  const { run, calls } = buildExecutor();
  const r = await run(
    def([
      { kind: "skill", ref: "summarize", args: {} },
      { kind: "message", ref: "prompt", args: {} },
      { kind: "tool", ref: "read_page", args: {} }
    ]),
    42,
    { prove: true }
  );
  ok(r.outcomes.length === 3, "every step gets an outcome in a proof run");
  ok(r.outcomes[0].status === "unexecutable" && r.outcomes[0].reason === "skill_step", "a skill step is reported unexecutable");
  ok(r.outcomes[1].status === "unexecutable" && r.outcomes[1].reason === "message_step", "a message step is reported unexecutable");
  ok(r.outcomes[2].status === "ok" && calls.length === 1, "the run CONTINUES to the tool steps it can validate");
  ok(r.ok === false, "a proof with an unexecutable step is NOT a passing proof (an unvalidated draft stays a draft)");

  const ordinary = buildExecutor();
  const r2 = await ordinary.run(def([{ kind: "skill", ref: "summarize", args: {} }]), 42);
  ok(r2.ok === false && ordinary.calls.length === 0 && /skill step/.test(r2.error), "an ordinary run still refuses a skill step before anything runs");
  ok(parseMarker(r2.marker).outcome === "failed", "the refusal's marker is an ordinary failure, not drift");

  const unknown = buildExecutor();
  const r3 = await unknown.run(def([{ kind: "tool", ref: "nope", args: {} }, { kind: "tool", ref: "read_page", args: {} }]), 42, { prove: true });
  ok(r3.outcomes[0].status === "unexecutable" && r3.outcomes[0].reason === "unknown_tool", "an unknown tool is unexecutable in a proof run");
  ok(r3.outcomes[1].status === "ok", "and the proof still validates the rest");

  const nested = buildExecutor();
  const r4 = await nested.run(def([{ kind: "tool", ref: "shortcuts_execute", args: {} }]), 42, { prove: true });
  ok(r4.outcomes[0].status === "unexecutable" && r4.outcomes[0].reason === "nested_execution", "nested execution is unexecutable in a proof run");
}

// ==========================================================================
console.log("\n== the workflow_prove handler: refusals are distinguishable, the reply is parseable JSON ==");
{
  const build = (over = {}) => {
    const deps = {
      validateWorkflowProveArgs: VALIDATORS.validateWorkflowProveArgs,
      isTabReachableForProve: over.isTabReachableForProve || (async () => true),
      chrome: over.chrome || { tabs: { get: async () => ({ id: 42, url: "https://example.com/orders" }) } },
      runShortcutToolSteps: over.runShortcutToolSteps || (async () => over.runResult)
    };
    const fn = compile(
      `const H_prove = { ${extractMethod("workflow_prove")} };`,
      deps,
      "{ H_prove }"
    ).H_prove.workflow_prove;
    return fn;
  };
  const payload = (res) => JSON.parse(res.content[0].text);

  const badArgs = payload(await build()({}));
  ok(badArgs.ok === false && badArgs.reason === "invalid_args", "malformed args are refused with their own reason");

  const outside = payload(await build({ isTabReachableForProve: async () => false })({ tabId: 9, definition: { steps: [{ kind: "tool", ref: "read_page" }] } }));
  ok(outside.ok === false && outside.reason === "not_in_agent_group", "a tab outside every group this extension owns is refused, distinguishably");

  const goneTab = payload(
    await build({ chrome: { tabs: { get: async () => { throw new Error("no tab"); } } } })({
      tabId: 9,
      definition: { steps: [{ kind: "tool", ref: "read_page" }] }
    })
  );
  ok(goneTab.ok === false && goneTab.reason === "tab_gone", "a closed tab is refused with its own reason");

  const mismatch = payload(
    await build({
      runResult: { ok: false, outcomes: [], finalUrl: "https://other.test/", drift: { step: null, ref: null, reason: "binding_mismatch", evidence: { expected: ["example.com"], actualHost: "other.test" } } }
    })({ tabId: 42, workflowId: "wf-a", version: 2, definition: { id: "wf-a", steps: [{ kind: "tool", ref: "read_page" }], domainConstraints: ["example.com"] } })
  );
  ok(mismatch.ok === false && mismatch.reason === "binding_mismatch", "the pre-flight mismatch surfaces as binding_mismatch (not a generic failure)");
  ok(mismatch.detail && mismatch.detail.actualHost === "other.test", "...carrying the evidence for the host's evidence file");

  const good = payload(
    await build({
      runResult: { ok: true, outcomes: [{ index: 0, ref: "read_page", status: "ok" }], finalUrl: "https://example.com/orders", drift: null }
    })({ tabId: 42, workflowId: "wf-a", version: 2, definition: { id: "wf-a", steps: [{ kind: "tool", ref: "read_page" }] } })
  );
  ok(good.ok === true && good.outcomes.length === 1 && good.finalUrl === "https://example.com/orders", "a passing proof reports ok with its per-step outcomes and final URL");
  ok(good.workflowId === "wf-a" && good.version === 2, "the reply echoes the exact record that was proved");
  ok(!("marker" in good) && !("busy" in good), "the prove reply is plain data (no marker line, no busy claim — busy is the host's own refusal)");

  const unvalidated = payload(
    await build({
      runResult: { ok: false, outcomes: [{ index: 0, ref: "summarize", status: "unexecutable", reason: "skill_step" }], finalUrl: "https://example.com/", drift: null }
    })({ tabId: 42, definition: { steps: [{ kind: "skill", ref: "summarize" }] } })
  );
  ok(unvalidated.ok === false, "a proof containing an unexecutable step does NOT report success");
  ok(unvalidated.outcomes[0].status === "unexecutable", "...and reports the step's own outcome rather than hiding it");
}

console.log("\n== prove reach: this extension's own groups count, the operator's own tabs never do ==");
{
  const build = (over = {}) => {
    const deps = {
      isInGroup: over.isInGroup || (async () => false),
      chrome:
        over.chrome ||
        { tabs: { get: async () => ({ id: 1, groupId: -1 }) }, tabGroups: { get: async () => ({ title: "Công việc" }) } },
      isOwnAgentGroupId: over.isOwnAgentGroupId || (() => false),
      isAgentFamilyTitle: over.isAgentFamilyTitle || (() => false),
      LEGACY_TAB_GROUP_TITLES: ["MCP Browzy", "MCP"]
    };
    return compile(
      [extractFunction("isTabInExtensionOwnedGroup"), extractFunction("isTabReachableForProve")].join("\n\n"),
      deps,
      "{ isTabReachableForProve }"
    ).isTabReachableForProve;
  };
  const grouped = { tabs: { get: async () => ({ id: 1, groupId: 9 }) }, tabGroups: { get: async () => ({ title: "Công việc" }) } };
  ok((await build({ chrome: grouped, isInGroup: async () => true })(5)) === true, "whatever isInGroup() accepts, on a GROUPED tab (a run's wire scope, an agent-created tab), is reachable");
  ok((await build()(5)) === false, "an ungrouped tab is refused");
  ok(
    (await build({ isInGroup: async () => true })(5)) === false,
    "a tab with NO group linkage is refused even when isInGroup() would accept it (a transient tracked-state tab is not a proof target)"
  );
  ok((await build({ chrome: grouped, isOwnAgentGroupId: () => true })(5)) === true, "a tab in a group this extension tracks (shared, or the panel's own solo group) is reachable");
  ok((await build({ chrome: grouped, isAgentFamilyTitle: () => true })(5)) === true, "a live 'Browzy N' family group is recognised after a worker restart");
  ok(
    (await build({
      chrome: { tabs: { get: async () => ({ id: 1, groupId: 9 }) }, tabGroups: { get: async () => ({ title: "Công việc của tôi" }) } }
    })(5)) === false,
    "a tab in the OPERATOR's own group is still refused — the panel's reach never widens to arbitrary pages"
  );
  ok((await build({ chrome: { tabs: { get: async () => { throw new Error("closed"); } } } })(5)) === false, "a closed tab is not reachable");
}

console.log("\n== proof-scoped gate: the proven tab passes ONLY while its own proof runs ==");
{
  // The live bug (2026-09-14): the prove handler admitted the panel's own
  // borrowed tab (isTabReachableForProve accepts it), but the per-tool gate
  // then refused EVERY step with "not in the MCP group" — the legacy branch
  // refuses an adopted borrowed tab by design. The proof's own steps must
  // pass while the proof runs, for that one tab, and nothing more.
  const gateDeps = (over = {}) => ({
    currentToolMeta: null,
    isTabInWireScope: (scope, id) => scope === "any" || (Array.isArray(scope) && scope.includes(id)),
    chrome: over.chrome || { tabs: { get: async () => ({ id: 7, groupId: 4 }) }, tabGroups: { get: async () => ({ title: "Browzy 2" }) } },
    tabGroupId: null,
    tabGroupTabs: new Set(),
    adoptedBorrowedTabs: over.adoptedBorrowedTabs || new Set([7]),
    extraAgentGroupIds: new Set(),
    isAgentFamilyTitle: over.isAgentFamilyTitle || (() => false),
    LEGACY_TAB_GROUP_TITLES: ["Browzy", "MCP Browzy", "MCP"],
    AGENT_TAB_GROUP_TITLE: "Browzy",
    isOwnAgentGroupId: over.isOwnAgentGroupId || (() => true),
    proveActiveTabId: over.proveActiveTabId !== undefined ? over.proveActiveTabId : null
  });
  const buildGate = (over = {}) =>
    compile(
      [extractFunction("isTabInExtensionOwnedGroup"), extractFunction("isInGroup")].join("\n\n"),
      gateDeps(over),
      "{ isInGroup }"
    ).isInGroup;

  ok((await buildGate()(7)) === false, "outside a proof, the borrowed tab is refused by the legacy gate — byte-for-byte unchanged");
  ok(
    (await buildGate({ proveActiveTabId: 7 })(7)) === true,
    "during a proof, the proven tab itself passes the per-tool gate (the live bug: every step answered 'not in the MCP group')"
  );
  ok((await buildGate({ proveActiveTabId: 7 })(8)) === false, "no other tab inherits the proof's scope");
  ok(
    (await buildGate({
      proveActiveTabId: 7,
      isOwnAgentGroupId: () => false,
      chrome: { tabs: { get: async () => ({ id: 7, groupId: 9 }) }, tabGroups: { get: async () => ({ title: "Công việc của tôi" }) } }
    })(7)) === false,
    "the scoped branch accepts only the proof's own reach — a group this extension does not own stays refused"
  );

  // Integration seam: runShortcutToolSteps sets the scope around its step
  // loop (prove mode) and its single exit funnel restores it afterwards.
  let gateRef = null;
  const probeTools = {
    async probe_step(args) {
      const reach = gateRef ? String(await gateRef(args.tabId)) : "no-gate";
      return { content: [{ type: "text", text: `reach:${reach}` }] };
    }
  };
  const S = compile(
    [
      "let proveActiveTabId = null;",
      extractFunction("isTabInExtensionOwnedGroup"),
      extractFunction("isInGroup"),
      extractFunction("runShortcutToolSteps")
    ].join("\n\n"),
    {
      currentToolMeta: null,
      isTabInWireScope: (scope, id) => scope === "any" || (Array.isArray(scope) && scope.includes(id)),
      chrome: { tabs: { get: async () => ({ id: 5, groupId: 4 }) }, tabGroups: { get: async () => ({ title: "Browzy 2" }) } },
      tabGroupId: null,
      tabGroupTabs: new Set(),
      adoptedBorrowedTabs: new Set([5]),
      extraAgentGroupIds: new Set(),
      isAgentFamilyTitle: () => false,
      LEGACY_TAB_GROUP_TITLES: ["Browzy"],
      AGENT_TAB_GROUP_TITLE: "Browzy",
      isOwnAgentGroupId: () => true,
      toolHandlers: probeTools,
      batchItemResultFailed: () => false,
      shortcutDriftReason: () => null,
      shortcutStepProducesContent: () => false,
      shortcutResultMarkerLine: () => "",
      SHORTCUT_TAB_SCOPED_TOOLS: new Set()
    },
    "{ isInGroup, runShortcutToolSteps, scope: () => proveActiveTabId }"
  );
  gateRef = S.isInGroup;
  const def = { id: "wf-scope", steps: [{ kind: "tool", ref: "probe_step", args: { tabId: 5 } }] };

  const provedRun = await S.runShortcutToolSteps(def, 5, { prove: true });
  ok(
    /step 1 \(probe_step\): ok — reach:true/.test(provedRun.lines.join("\n")),
    "during a proof the proven tab passes the gate (this is the exact refusal the live bug produced)"
  );
  ok(S.scope() === null, "the proof scope is restored when the run returns");

  const plainRun = await S.runShortcutToolSteps(def, 5, {});
  ok(/reach:false/.test(plainRun.lines.join("\n")), "outside a proof the same tab is still refused by the legacy gate");
  ok(S.scope() === null, "a non-proof run leaves no scope behind");

  const refusedRun = await S.runShortcutToolSteps({ id: "wf-x", steps: [{ kind: "tool", ref: "not_a_tool" }] }, 5, { prove: true });
  ok(refusedRun.ok === false && S.scope() === null, "a refusal path restores the scope too");
}

console.log("\n== shortcuts_execute: the marker lands exactly once, as the LAST line ==");
{
  const fakeTools = {
    read_page: async () => ({ content: [{ type: "text", text: "Title: Orders" }] })
  };
  const runShortcutToolSteps = compile(
    [
      extractFunction("runShortcutToolSteps"),
      extractFunction("batchItemResultFailed"),
      extractFunction("shortcutDriftReason"),
      extractFunction("shortcutStepProducesContent"),
      extractFunction("shortcutResultMarkerLine"),
      extractFunction("workflowBindingCheck"),
      extractFunction("workflowDomainPatterns"),
      extractFunction("workflowDomainMatches"),
      extractFunction("workflowHostOfUrl"),
      extractFunction("normalizeWorkflowHost")
    ].join("\n\n"),
    {
      toolHandlers: fakeTools,
      SHORTCUT_TAB_SCOPED_TOOLS: new Set(["read_page"]),
      shortcutStepTabUrl: async () => "https://example.com/orders"
    },
    "{ runShortcutToolSteps }"
  ).runShortcutToolSteps;
  const handler = compile(
    `const H_exec = { ${extractMethod("shortcuts_execute")} };`,
    {
      validateShortcutsExecuteArgs: VALIDATORS.validateShortcutsExecuteArgs,
      isInGroup: async () => true,
      chrome: { tabs: { get: async () => ({ id: 5, url: "https://example.com/orders" }) } },
      nativeRequest: async () => ({
        ok: true,
        definition: { id: "wf-demo", steps: [{ kind: "tool", ref: "read_page", args: {} }] }
      }),
      runShortcutToolSteps
    },
    "{ H_exec }"
  ).H_exec.shortcuts_execute;

  const res = await handler({ tabId: 5, shortcutId: "wf-demo" });
  const text = res.content[0].text;
  const lines = text.split("\n");
  const markerLines = lines.filter((l) => l.startsWith("OCIC_WORKFLOW_RESULT "));
  ok(markerLines.length === 1, "the result text carries exactly one marker line");
  ok(lines[lines.length - 1] === markerLines[0], "and it is the LAST line (what the companion reads)");
  ok(parseMarker(markerLines[0]).outcome === "ok", "the marker parses as JSON with the run's outcome");
}

console.log(fail === 0 ? "\nALL SHORTCUT PROVE HANDLER TESTS PASSED\n" : `\n${fail} FAILED\n`);
process.exit(fail ? 1 : 0);
