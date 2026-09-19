// Production in-process SDK browser-tool adapter.
//
// Productionizes host/agent/spike/lib/adapter.mjs (see
// reports/01-sdk-gate-evidence.md gate 1.2, which proved the underlying
// tool()/createSdkMcpServer() wiring against real zod v3 schemas and the
// real host/tool-runtime.js dispatch path): the spike's registration loop
// was a bare passthrough with no authorization; this version adds the
// unconditional handler-side authorization design.md decision 2 requires —
// "Validate run state, arguments, browser lease, and tab scope inside each
// tool handler, even when SDK permission checks preapprove the tool" — on
// every single call, and attaches the run-identifying metadata (run id,
// conversation id, browser identity, tab scope, unique request id) task 3.4
// requires on every dispatched request.
//
// Still does not reimplement browser automation: every call still ends at
// the existing, unmodified host/tool-definitions.js schema and (via the
// injected `callTool`) host/tool-runtime.js dispatch.

import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { TOOLS } from "../../tool-definitions.js";
import {
  sdkFacingToolDefs,
  recordAgentCreatedTab,
  extractCreatedTabId
} from "./mapping.js";
import {
  runHostSideChecks,
  checkBrowserBatchHostSide,
  firstTextOf,
  verifyPreDispatchApproval
} from "./dispatch-checks.js";
import { TabRiskRegistry } from "../threat/tab-risk.js";
import { observeToolResult } from "../threat/observe.js";
import { readWorkflowDrift } from "../skills/workflows-proof.js";

export const SDK_MCP_SERVER_NAME = "browzy-in-chrome-browser";

export const KNOWN_TOOL_NAMES = new Set(TOOLS.map((t) => t.name));

// A behavior-preserving extraction: `verifyPreDispatchApproval` moved to
// ./dispatch-checks.js so the Jev runtime can call the same gate
// (openspec/changes/add-typesafe-jev-provider design.md decision 7). The
// export surface here is unchanged — same name, same signature, same
// behavior — so every existing importer keeps working untouched.
export { verifyPreDispatchApproval };

/**
 * @param {object} deps
 * @param {import("../broker/tool-bridge.js").ToolBridge} deps.toolBridge
 *   Run-scoped tool dispatch — wraps host/tool-runtime.js's callTool with the
 *   meta parameter this adapter attaches on every call, and distinguishes a
 *   real error from a lost-response "result unknown" outcome.
 * @param {(coerced: object) => object} deps.coerceArgs
 * @param {import("../session/run.js").Run} deps.run - the run this server
 *   instance is scoped to; authorization reads its live state/lease/tabScope
 *   at CALL time (not at build time), so a run stopped mid-conversation
 *   rejects a call made a second later even though the tool was built once.
 */
// Description text only (design.md 5b's current-page-default wording) —
// registration below still uses TOOLS directly, keyed by t.name, so the
// registered tool() identifier is untouched (see mapping.js's file-header
// note on why: host/test/agent-tool-adapter.test.mjs, out of this task's
// ownership, asserts byte-identical registration against TOOLS).
const SDK_DESCRIPTIONS = new Map(sdkFacingToolDefs().map((t) => [t.legacyName, t.description]));

export function buildSdkTools({ toolBridge, coerceArgs, run, tabRiskRegistry }) {
  // add-permission-modes-and-threat-signals (tasks.md groups 5/6): one
  // risk-tracking instance shared by every browser tool closure built here,
  // since they all observe the same controlled tabs. Never read by anything
  // in host/agent/policy/ (that is the property
  // host/test/threat-advisory-only.test.mjs proves); it exists solely to
  // feed the two warning-only event types this module emits.
  //
  // PRODUCTION callers must pass their own `tabRiskRegistry` that outlives a
  // single run — host/agent/companion.js holds one per conversationId (see
  // its own `_tabRiskRegistryFor()`) and passes it into every run of that
  // conversation, so a tab's category/signals survive across turns instead
  // of resetting on every new run (a CRITICAL fix: this default used to be
  // built fresh, empty, on every call — silently discarding an earlier
  // turn's findings for a tab that never navigated). The default below
  // exists ONLY for a caller with no run-spanning session of its own (a
  // standalone test, an ad hoc script) — never rely on it in production.
  const threatRegistry = tabRiskRegistry ?? new TabRiskRegistry();
  return TOOLS.map((t) =>
    tool(t.name, SDK_DESCRIPTIONS.get(t.name) ?? t.description, t.paramShape, async (args) => {
      const coerced = coerceArgs({ ...(args ?? {}) });
      if (t.name === "browser_batch") {
        const batchCheck = checkBrowserBatchHostSide({ run, args: coerced });
        if (!batchCheck.ok) return batchCheck.result;
      } else {
        const check = runHostSideChecks({
          run,
          legacyToolName: t.name,
          args: coerced,
          sendClassTool: t.name === "computer" || t.name === "javascript_tool" || t.name === "webmcp_call_tool"
        });
        if (!check.ok) return check.result;
      }
      const meta = run.describeRequestForWire();
      const { result, resultUnknown } = await toolBridge.call(t.name, coerced, meta);
      if (resultUnknown) run.recordResultUnknown?.(t.name, coerced, meta);
      // add-permission-modes-and-threat-signals (tasks.md 5.1): probe
      // returned web content BEFORE it is available for the agent to act on
      // — i.e. before this handler returns `result` below — and update the
      // dispatching tab's advisory risk category. `result` itself is never
      // touched: whatever this call observes, the exact same `result` is
      // returned to the agent afterward (tasks.md 5.2). A lost-response
      // ("result unknown") dispatch carries no real content to probe.
      if (!resultUnknown) {
        try {
          observeToolResult({ run, legacyToolName: t.name, args: coerced, result, tabRiskRegistry: threatRegistry });
        } catch {
          // Never let an observation failure affect the agent's own call —
          // the probe/category machinery is advisory-only and must not be
          // able to break dispatch. A failure INSIDE the probe's own scan is
          // already caught and reported as a distinct event by
          // probeToolResult/observeToolResult; this is only the outer
          // belt-and-suspenders guard for a bug in the observer itself.
        }
      }
      // tabs_create_mcp's own new tab is agent-created, never borrowed —
      // recorded from the real result text rather than a new wire field
      // (see mapping.js's extractCreatedTabId). Best-effort: a shape change
      // in the shipped handler's text would just mean this run's cleanup
      // guard cannot recognize that tab as its own, not a crash.
      if (t.name === "tabs_create_mcp" && !resultUnknown) {
        const createdTabId = extractCreatedTabId(result);
        if (createdTabId !== null) {
          recordAgentCreatedTab(run, createdTabId);
          // ...and admit it into this run's tab scope. Marking it
          // agent-created alone only kept the borrowed-tab read-only guard
          // off it; without this the run still failed tab_out_of_scope on
          // every call against the tab it had just been told to create.
          // Ordering matters: mark first, so the tab is never briefly
          // classified as borrowed while it is in scope.
          run.admitSessionOwnedTab?.(createdTabId);
        }
      }
      // Rerunnable workflows + self-healing
      // (add-workflow-materialization-and-heal task 3.2): a workflow whose
      // live target no longer resolves must be recorded as DRIFT so the
      // repair flow can cite the evidence later. This is the only place a
      // `shortcuts_execute` result passes through host code together with the
      // arguments that were actually dispatched — the workflow id is read
      // from THOSE captured args, never from anything the result text claims.
      // A transient failure carries no drift object in the executor's versioned
      // marker (see skills/workflows-proof.js), so ordinary failures and the
      // cancelled/stopped paths emit nothing here.
      if (t.name === "shortcuts_execute" && !resultUnknown) {
        try {
          const drift = readWorkflowDrift({
            toolName: t.name,
            args: coerced,
            resultText: firstTextOf(result)
          });
          if (drift) {
            run.emit({
              type: "workflow_drift",
              workflowId: drift.workflowId,
              step: drift.step,
              ref: drift.ref,
              reason: drift.reason,
              evidence: drift.evidence
            });
          }
        } catch {
          // Observation only — a malformed marker must never be able to
          // change the result the agent receives for its own call.
        }
      }
      return result;
    })
  );
}

export function createBrowserMcpServer(deps) {
  // Task 9.5: include the application-owned ask-the-user tool alongside the
  // browser tools on the SAME SDK MCP server. The caller (companion.js)
  // builds it via host/agent/tools/ask-the-user.js's createAskUserTool() and
  // passes it as `deps.extraTools` (an array). This keeps ask_user on the
  // same server as the browser tools so the SDK's `tools`/`allowedTools`
  // allowlist derivation (sdkQualifiedToolNames) covers it naturally.
  const browserTools = buildSdkTools(deps);
  const extraTools = Array.isArray(deps?.extraTools) ? deps.extraTools : [];
  return createSdkMcpServer({
    name: SDK_MCP_SERVER_NAME,
    version: "1.0.0",
    tools: [...browserTools, ...extraTools]
  });
}

export function adapterToolNames() {
  return TOOLS.map((t) => t.name);
}

/**
 * Every registered browser tool's fully-qualified SDK identifier
 * (`mcp__${serverName}__${toolName}`) — the exact string the SDK's `tools`
 * allowlist (host/agent/tools/query-options.js) needs to preapprove a call
 * before it ever reaches the handler-side authorization above.
 *
 * @param {string} [serverName] - defaults to SDK_MCP_SERVER_NAME; callers
 *   should always pass the same name used to key the `mcpServers` option so
 *   the two can never name two different servers.
 * @param {string[]} [toolNames] - defaults to `adapterToolNames()`, itself
 *   derived from `TOOLS` — the same array `buildSdkTools()` registers
 *   from — so the default can never drift out of sync with what is actually
 *   registered on the server. Overridable only so tests can prove that
 *   default equals the live registry rather than a hand-typed copy of it.
 */
export function sdkQualifiedToolNames(serverName = SDK_MCP_SERVER_NAME, toolNames = adapterToolNames()) {
  return toolNames.map((name) => `mcp__${serverName}__${name}`);
}

/**
 * The inverse of `sdkQualifiedToolNames()`: map whatever name the SDK hands
 * a permission callback back to the legacy tool name every classifier in
 * host/agent/tools/mapping.js keys on ("computer", "javascript_tool", ...).
 *
 * This exists because the two sides of the approval boundary see the SAME
 * call under DIFFERENT names. The tool HANDLER knows its own registered
 * legacy name (`t.name` in `buildSdkTools()`), but `Options.canUseTool`
 * receives the SDK-facing identifier, which for an MCP-served tool is the
 * fully-qualified `mcp__<server>__<tool>` form. Every classifier compares
 * against the legacy names by exact string equality
 * (`SEND_CLASS_TOOL_NAMES.includes(...)`, `legacyToolName === "computer"`),
 * so handing one a qualified name silently takes the "not a gated tool"
 * branch — the gate then auto-allows a call the handler independently
 * classifies as send-class, and the two disagree about the same bytes.
 *
 * Only a prefix whose suffix is a tool this adapter actually registers is
 * stripped, so this cannot map some other MCP server's identically-suffixed
 * tool onto this project's gate, and a name that is already legacy (or is a
 * builtin like "WebFetch") is returned untouched.
 *
 * @param {string} sdkToolName - the name as the SDK presented it.
 * @param {string[]} [toolNames] - defaults to `adapterToolNames()`, the same
 *   registry-derived array `sdkQualifiedToolNames()` uses, so the two can
 *   never disagree about which suffixes are ours.
 * @returns {string} the legacy tool name, or `sdkToolName` unchanged.
 */
export function legacyToolNameFromSdkName(sdkToolName, toolNames = adapterToolNames()) {
  if (typeof sdkToolName !== "string" || sdkToolName.length === 0) return "";
  if (toolNames.includes(sdkToolName)) return sdkToolName;
  if (!sdkToolName.startsWith("mcp__")) return sdkToolName;
  const suffix = sdkToolName.slice(sdkToolName.lastIndexOf("__") + 2);
  return toolNames.includes(suffix) ? suffix : sdkToolName;
}
