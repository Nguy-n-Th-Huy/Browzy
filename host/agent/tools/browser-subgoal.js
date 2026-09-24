// jev-browser-subgoal-tool: the `browser_subgoal` SDK tool.
//
// Lets an `anthropic`/`chatgpt` run delegate ONE bounded natural-language
// interaction to a short Jev sub-run on the caller's own bound tab, sharing
// its browser lease, `toolBridge`, `coerceArgs` and `canUseTool` — never a
// new tab, never a second lease. Registered alongside the existing
// application-owned tools (ask_user, create_document, page_snapshots,
// propose_workflow_heal) via the same tool()/createSdkMcpServer() pattern
// (host/agent/tools/ask-the-user.js), and ONLY when the run's profile
// resolves complete Jev configuration (host/agent/settings/profile.js's
// `resolveJevBrowserSubgoalConfig`) — its absence is silent, the same
// WebMCP pattern this codebase already uses for an optional capability.
//
// The tool NEVER claims task completion. It returns an unverified
// checkpoint (design.md decision 4): the observed page after the sub-run,
// a bounded ordered summary of the actions Jev took (never including a
// typed value or navigated URL), and the sub-run's terminal reason. The
// caller (the driving LLM) owns final verification.

import { z } from "zod";

/** The single source of truth for this tool's registered name — see
 * ask-the-user.js's ASK_USER_TOOL_NAME for why: a tool the SDK server
 * registers is not automatically visible to the model, and this constant is
 * what companion.js passes to both `extraTools` (registration) and
 * `buildIsolatedOptions`'s `extraToolNames` (visibility). The two must move
 * together or the tool is registered but uncallable. */
export const BROWSER_SUBGOAL_TOOL_NAME = "browser_subgoal";

const TOOL_DESCRIPTION =
  "Delegate one coherent sub-task on the current page to Jev, a fast page-control selector. Describe the END STATE " +
  "you want (e.g. \"fill the search form with origin/destination/date and submit\", \"open the menu and choose " +
  "Settings\") — this MAY take several related steps, not just one click. Jev observes the live page and runs the " +
  "sequence of concrete element/action selections needed to reach that end state within its bounded budget, then " +
  "stops and returns one UNVERIFIED checkpoint: the observed page, the actions it took, and why it stopped. This is " +
  "never a claim that the goal was achieved — read the checkpoint (its observed page and action summary are the fresh view of that work) and decide the next step from it; " +
  "final verification of the overall task is always yours.";

/**
 * Shape the sub-run's raw `runTypesafeRun` result into the tool's documented
 * checkpoint contract (design.md decision 4):
 *   { status, unverified: true, subgoalId, url, title, actions[], reason, needsOperator? }
 * `status` is "checkpoint" for a Jev DONE, "error" for a start/transport/
 * decision failure the run could not recover from, and "blocked" for every
 * other bounded terminal (budget exhausted, denied approval, ASK, stale
 * observation and friends). Never a success claim beyond "checkpoint".
 *
 * @param {{ outcome: "done"|"blocked"|"stopped"|"error", reason: string|null,
 *   needsOperator?: boolean, error?: { code: string, message: string },
 *   checkpoint?: { url: string|null, title: string|null, actions: Array } }} result
 * @param {string} [subgoalId] - the id this call minted for the sub-run
 *   (spec "Subgoal steps are observable and attributed" / design.md decision
 *   6). Included unconditionally so the outer tool-call result references
 *   the same id tagging the sub-run's `jev_step`/`jev_end` records, even on
 *   a start/transport failure where no `checkpoint` came back.
 */
export function mapSubgoalCheckpoint(result, subgoalId) {
  const status = result.outcome === "done" ? "checkpoint" : result.outcome === "error" ? "error" : "blocked";
  const checkpoint = result.checkpoint || {};
  const mapped = {
    status,
    unverified: true,
    subgoalId: typeof subgoalId === "string" && subgoalId ? subgoalId : (typeof checkpoint.subgoalId === "string" ? checkpoint.subgoalId : null),
    url: typeof checkpoint.url === "string" ? checkpoint.url : null,
    title: typeof checkpoint.title === "string" ? checkpoint.title : null,
    actions: Array.isArray(checkpoint.actions) ? checkpoint.actions : [],
    reason: result.reason || (status === "error" ? (result.error?.code || "jev_error") : null)
  };
  if (result.needsOperator) mapped.needsOperator = true;
  return mapped;
}

/**
 * Create the `browser_subgoal` SDK tool using the same `tool()` factory the
 * browser tools and the other application-owned tools use.
 *
 * @param {object} deps
 * @param {import("../session/run.js").Run} deps.run - the SAME run the SDK
 *   conversation is driving; the sub-run shares its lease and tab scope.
 * @param {import("../broker/tool-bridge.js").ToolBridge} deps.toolBridge - the
 *   SAME bridge the SDK's browser tools dispatch through.
 * @param {(args: object) => object} deps.coerceArgs - the SAME argument
 *   coercion the SDK tool handlers apply.
 * @param {(toolName: string, args: object) => Promise<{behavior: string, message?: string}>} deps.canUseTool
 *   - the SAME approval gate instance the SDK run's `canUseTool` uses, so
 *   approvals, single-use grants and the pending-approval tracker are
 *   shared, never a second independently-resolved gate.
 * @param {object} deps.jevConfig - `resolveJevBrowserSubgoalConfig`'s
 *   resolved shape: `{ source, endpoint, apiKey, model, textModel,
 *   sendScreenshots, consultSources }`.
 * @param {() => (number|null)} deps.resolveTabId - resolves the outer run's
 *   currently bound tab AT CALL TIME (never cached at registration time: a
 *   conversation's bound tab can be established or change between the SDK
 *   run starting and the model actually calling this tool).
 * @param {(name: string, description: string, shape: object, handler: Function) => object} [deps.toolFactory]
 *   - injectable for tests; production dynamically imports the real SDK's
 *   `tool()`, same pattern as ask-the-user.js.
 * @param {Function} [deps.runTypesafeRunImpl] - injectable for tests;
 *   production dynamically imports the real `runTypesafeRun`.
 * @returns {Promise<object>} the SDK tool() result, suitable for inclusion
 *   in a createSdkMcpServer() tools array alongside the browser tools.
 */
export async function createBrowserSubgoalTool({
  run,
  toolBridge,
  coerceArgs,
  canUseTool,
  jevConfig,
  resolveTabId,
  toolFactory,
  runTypesafeRunImpl,
  // add-task-memory: returns this run's rendered prior-path advice (or null),
  // read fresh at call time. Optional; absent means no advice.
  getPriorPathAdvice = null
}) {
  if (!run) throw new Error("createBrowserSubgoalTool requires a run");
  if (!toolBridge) throw new Error("createBrowserSubgoalTool requires a toolBridge");
  if (typeof coerceArgs !== "function") throw new Error("createBrowserSubgoalTool requires coerceArgs");
  if (typeof canUseTool !== "function") throw new Error("createBrowserSubgoalTool requires canUseTool");
  if (!jevConfig || typeof jevConfig !== "object") throw new Error("createBrowserSubgoalTool requires a resolved jevConfig");

  let tool;
  if (typeof toolFactory === "function") {
    tool = toolFactory;
  } else {
    const sdk = await import("@anthropic-ai/claude-agent-sdk");
    tool = sdk.tool;
  }

  const paramShape = {
    goal: z
      .string()
      .min(1)
      .describe(
        "The end state Jev should reach on the current page for one coherent sub-task — a natural-language " +
          "description of the outcome, which MAY take several related steps to reach (e.g. filling a form and " +
          "submitting it). Call this tool again only at a new decision point or when a subgoal reports blocked."
      )
  };

  return tool(BROWSER_SUBGOAL_TOOL_NAME, TOOL_DESCRIPTION, paramShape, async (args) => {
    const goal = typeof args?.goal === "string" ? args.goal.trim() : "";
    if (!goal) {
      return {
        content: [{ type: "text", text: "browser_subgoal requires a non-empty `goal` string describing one bounded interaction." }],
        isError: true
      };
    }

    const tabId = typeof resolveTabId === "function" ? resolveTabId() : null;
    if (!Number.isInteger(tabId)) {
      return {
        content: [{ type: "text", text: "browser_subgoal has no bound page tab to drive; open or bind a page first." }],
        isError: true
      };
    }

    const runSubgoal = typeof runTypesafeRunImpl === "function"
      ? runTypesafeRunImpl
      : (await import("../jev/runtime.js")).runTypesafeRun;

    // Minted HERE, once per call — a plain host-generated correlation id,
    // never a secret or page-derived value — and handed to the sub-run as
    // `provider.subgoalId` so runtime.js tags its `jev_step`/`jev_end`
    // records with this SAME id (runtime.js ~391) instead of generating its
    // own untagged one. Also included in the checkpoint returned below, so
    // the outer tool-call result references those exact events (spec
    // "Subgoal steps are observable and attributed" / design.md decision 6).
    const subgoalId = `subgoal:${crypto.randomUUID()}`;

    let result;
    try {
      result = await runSubgoal({
        run,
        toolBridge,
        coerceArgs,
        canUseTool,
        provider: {
          source: jevConfig.source,
          endpoint: jevConfig.endpoint,
          apiKey: jevConfig.apiKey,
          model: jevConfig.model,
          textModel: jevConfig.textModel,
          sendScreenshots: jevConfig.sendScreenshots === true,
          subgoalId,
          // A subgoal never reaches the completion-check/report path that
          // would consult a source beyond the page it drives — subgoal mode
          // skips that path entirely (design.md decision 3) — so this stays
          // off regardless of the profile's own toggle.
          consultSources: false,
          searchSources: false,
          // The tool's own argument is the goal; the outer conversation's
          // text never is (spec "sourced from the tool's `goal` argument
          // and not from the outer conversation").
          goal,
          // Self-contained by design (design.md decision 2): a subgoal
          // carries no prior-turn transcript.
          conversation: [],
          // add-task-memory: what earlier completed runs on this site did,
          // read at call time from the outer run's recalled memory. Advice
          // for the planner only — see requestActionPlan's prior_path_advice.
          ...(typeof getPriorPathAdvice === "function" && getPriorPathAdvice() ? { priorPathAdvice: getPriorPathAdvice() } : {}),
          tabId
        },
        limits: { mode: "subgoal" }
      });
    } catch (err) {
      // A runtime bug must still answer the caller honestly rather than
      // leaving the tool call hanging.
      result = {
        outcome: "error",
        reason: "jev_runtime_failed",
        steps: 0,
        error: { code: "jev_runtime_failed", message: (err && err.message) || String(err) }
      };
    }

    const checkpoint = mapSubgoalCheckpoint(result, subgoalId);
    return {
      content: [{ type: "text", text: JSON.stringify(checkpoint) }],
      isError: result.outcome === "error"
    };
  });
}
