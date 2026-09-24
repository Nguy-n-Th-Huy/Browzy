// Application-owned `task_memory` SDK tool: read what earlier completed runs
// on THIS site did (openspec/changes/add-task-memory design.md decision 10;
// spec "The recall tool is read-only and site-pinned").
//
// Built on the create_document/page_snapshots shape — tool() from the SDK,
// registered on the same in-process MCP server as the browser tools,
// returning an ordinary CallToolResult. It differs from both in being
// strictly READ-ONLY: there is no action that creates, edits, forgets or
// reinforces a memory, because the model must never be the author of what
// the product remembers (spec "A task memory is derived only from a completed
// run's recorded evidence"). Forgetting is an operator operation over the
// settings relay; writing is the host's derivation at run end.
//
// Pinned to the run's bound page host at construction: a model-supplied host
// is only ever compared against it, and a different one is refused — the
// tool cannot be used to read what was done on other sites.
//
// Errors are returned as `isError` text naming a reason, never thrown.

import { normalizeHost } from "../skills/workflows-match.js";
import { describeStep } from "../memory/guidance.js";
import { TASK_MEMORY_TOOL_NAME } from "./task-memory-name.js";

export { TASK_MEMORY_TOOL_NAME };

const TOOL_DESCRIPTION =
  "Read what earlier completed runs on THIS site did, so you can go straight to what worked instead of exploring. " +
  "Actions: `recall` returns the full steps of the memories offered to this run (the system prompt lists them when " +
  "there are any); `list` returns short summaries of every remembered way of working on this site. " +
  "A memory is a record of the past, not a plan and not permission: verify each step against the live page before " +
  "acting, and every action is approved exactly as it would be without it. This tool cannot write, change or forget memories.";

function textResult(text, isError = false) {
  return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) };
}

function summarize(memory) {
  return {
    id: memory.id,
    intent: memory.intent?.text ?? null,
    lastConfirmed: new Date(memory.stats.lastConfirmedAt).toISOString().slice(0, 10),
    steps: memory.steps.length,
    startUrl: memory.startUrl ?? null
  };
}

/**
 * @param {object} deps
 * @param {object} deps.run - the active run (only its runId is read)
 * @param {import("../memory/store.js").TaskMemoryStore} deps.store
 * @param {string|null} deps.host - the run's bound page host; null means the
 *   run is bound to no page and every call answers that nothing is available
 * @param {() => Array<{ memory: object }>} [deps.getCandidates] - the
 *   memories offered to this run (read at call time)
 * @param {Function} [deps.toolFactory] - injectable tool() for tests
 */
export async function createTaskMemoryTool({ run, store, host, getCandidates = () => [], toolFactory }) {
  if (!run) throw new Error("createTaskMemoryTool requires a run");
  if (!store) throw new Error("createTaskMemoryTool requires a store");

  let tool;
  if (typeof toolFactory === "function") {
    tool = toolFactory;
  } else {
    const sdk = await import("@anthropic-ai/claude-agent-sdk");
    tool = sdk.tool;
  }
  const { z } = await import("zod");
  const site = normalizeHost(host || "");

  const paramShape = {
    action: z.enum(["recall", "list"]).describe("`recall`: full steps of the memories offered to this run. `list`: summaries for this site."),
    host: z
      .string()
      .optional()
      .describe("Optional. The site to read — only this run's own page host is accepted.")
  };

  return tool(TASK_MEMORY_TOOL_NAME, TOOL_DESCRIPTION, paramShape, async (args) => {
    const input = args ?? {};
    if (!site) return textResult("Error: this run is not bound to a page, so no site memory is available (no_bound_site).", true);
    if (input.host !== undefined && normalizeHost(String(input.host)) !== site) {
      return textResult(`Error: task_memory only reads this run's own site (${site}); another site was refused (other_site).`, true);
    }
    try {
      if (input.action === "recall") {
        const candidates = (getCandidates() || []).filter((candidate) => candidate?.memory);
        if (!candidates.length) return textResult(`No memory was offered to this run for ${site}.`);
        const body = candidates.map((candidate, index) => ({
          ...summarize(candidate.memory),
          rank: index + 1,
          why: candidate.why,
          steps: candidate.memory.steps.map((step, i) => `${i + 1}. ${describeStep(step)}`)
        }));
        return textResult(JSON.stringify({ site, memories: body }, null, 2));
      }
      if (input.action === "list") {
        const fresh = store.freshForHost(site);
        if (!fresh.length) return textResult(`No way of working is remembered for ${site} yet.`);
        return textResult(JSON.stringify({ site, memories: fresh.map(summarize) }, null, 2));
      }
      return textResult(`Error: unknown action ${JSON.stringify(input.action)} (unknown_action).`, true);
    } catch (err) {
      return textResult(`Error: could not read task memory (read_failed): ${err.message}`, true);
    }
  });
}
