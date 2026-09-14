// Application-owned `propose_workflow_heal` SDK tool: the one way a run can
// offer a repaired workflow definition to the operator.
//
// Why a tool and not an automatic edit: the change's core guarantee is "no
// silent rewrite" (design.md decision 5). The model may diagnose against the
// live site with its ordinary tools, but the repair it produces is DATA that
// waits for an explicit operator decision — this tool stores a proposal and
// returns; it can never save a version, enable anything, or touch the
// registry. The approval path is companion.js's `workflow_heal_decide`,
// which is the only caller of updateWorkflow for a heal.
//
// The candidate is validated HERE, with the same registry validation an
// authored or imported definition passes, so the model learns immediately
// (and precisely) when its repair would smuggle in an unsupported step kind,
// an auto-approve field, or an undeclared parameter template — instead of
// the operator meeting a card that cannot be saved.

import { getWorkflow } from "../skills/workflows-store.js";
import { validateHealCandidate } from "../skills/workflows-heal.js";

/**
 * Single source of truth for this tool's registered name.
 *
 * A tool the SDK server registers is NOT automatically visible to the model:
 * host/agent/tools/query-options.js has to receive the same name through
 * `extraToolNames`, and those two facts drifting apart is exactly what once
 * left ask_user registered-but-uncallable. Anything registering this tool
 * must pass this constant along to buildIsolatedOptions().
 */
export const PROPOSE_WORKFLOW_HEAL_TOOL_NAME = "propose_workflow_heal";

const TOOL_DESCRIPTION =
  "Propose a repaired version of a stored workflow for the operator to approve. " +
  "Use this ONLY after a workflow run has reported drift (or you have observed the live site no longer matching the stored definition) " +
  "and you have inspected the live page with ordinary tools: propose a corrected steps array, the reason, and the evidence you based it on. " +
  "This tool NEVER applies anything — it stores a proposal, the stored definition is unchanged, and the operator must explicitly approve it " +
  "before a new version is saved. Do not call it for a healthy workflow. A proposal that cannot be validated is rejected with the " +
  "validation errors, so fix the steps and propose again.";

/**
 * Create the tool.
 *
 * @param {object} deps
 * @param {import("../session/run.js").Run} deps.run - the active run; emit()
 *   pushes workflow_heal_proposed into the same sequenced transcript the
 *   panel rebuilds from on reconnect.
 * @param {import("../skills/workflows-heal.js").HealProposalStore} deps.proposals
 * @param {string} deps.conversationId - the conversation the proposal belongs
 *   to. Bound here, never taken from tool args: a model-supplied conversation
 *   id would file the proposal in someone else's review surface.
 * @param {string} [deps.owner] - the registry owner proposals are filed
 *   under; defaults to the local-operator identity the panel's own saves use.
 * @param {Function} [deps.toolFactory] - injectable tool() for tests
 * @param {() => number} [deps.now] - injectable clock for tests
 */
export async function createProposeWorkflowHealTool({
  run,
  proposals,
  conversationId,
  owner = "local-operator",
  toolFactory,
  now = Date.now
}) {
  if (!run) throw new Error("createProposeWorkflowHealTool requires a run");
  if (!proposals) throw new Error("createProposeWorkflowHealTool requires a proposals store");
  if (!conversationId) throw new Error("createProposeWorkflowHealTool requires a conversationId");

  let tool;
  if (typeof toolFactory === "function") {
    tool = toolFactory;
  } else {
    const sdk = await import("@anthropic-ai/claude-agent-sdk");
    tool = sdk.tool;
  }
  const { z } = await import("zod");

  const paramShape = {
    workflowId: z.string().describe("The stored workflow's id (the drifted one)."),
    version: z
      .number()
      .int()
      .describe("The exact stored version this repair heals (the version that drifted). Refused when it is not the current version."),
    steps: z
      .array(
        z
          .object({
            kind: z.enum(["tool", "skill", "message"]).describe("Step kind — the only kinds a workflow may contain."),
            ref: z.string().optional().describe("Tool name, skill name, or (for a message step) the message text."),
            args: z
              .record(z.any())
              .optional()
              .describe(
                "Literal step arguments. Secret values are never stored here. For computer/form_input steps, aim with a stable " +
                  "target (`target: {role, name}` — the element's identity, re-resolved against the live page on every run) instead " +
                  "of a `ref`: a ref is a document-scoped handle and is dead by the next run."
              )
          })
          .passthrough()
      )
      .describe("The complete corrected steps array (it REPLACES the stored steps)."),
    reason: z.string().describe("Why the stored definition broke — name the step and what changed on the live site."),
    evidence: z
      .union([z.string(), z.record(z.any())])
      .optional()
      .describe("What the diagnosis observed (a URL, a selector that no longer resolves, the new target's ref).")
  };

  const errorResult = (text) => ({ content: [{ type: "text", text: `Error: ${text}` }], isError: true });

  return tool(PROPOSE_WORKFLOW_HEAL_TOOL_NAME, TOOL_DESCRIPTION, paramShape, async (args) => {
    const input = args ?? {};
    const workflowId = typeof input.workflowId === "string" ? input.workflowId : "";
    if (!workflowId) return errorResult("propose_workflow_heal requires the workflowId of the drifted workflow.");

    let current = null;
    try {
      current = getWorkflow(workflowId);
    } catch (err) {
      return errorResult(`"${workflowId}" is not a valid workflow id (${err.message}).`);
    }
    if (!current) return errorResult(`no stored workflow named "${workflowId}".`);

    if (Number.isInteger(input.version) && input.version !== current.version) {
      return errorResult(
        `workflow "${workflowId}" is at version ${current.version}, not ${input.version}. ` +
          `Diagnose the CURRENT version and propose against it.`
      );
    }

    const candidate = validateHealCandidate({ current, steps: input.steps });
    if (!candidate.ok) {
      const detail = candidate.errors.map((e) => `${e.code}: ${e.message}`).join("; ");
      return errorResult(`the proposed definition was rejected by workflow validation — ${detail}`);
    }

    const { proposal, superseded, expired } = proposals.propose({
      conversationId,
      workflowId,
      owner: current.owner || owner,
      baseVersion: current.version,
      steps: candidate.steps,
      reason: typeof input.reason === "string" ? input.reason : "",
      evidence: input.evidence,
      enabled: current.enabled !== false
    });

    // Durable + live record of the review surface, in event order: an expiry
    // observed while superseding first, then the supersede, then the new
    // proposal. Every event carries the full proposal so a panel that missed
    // one (or reloaded) can restore the card from the transcript alone.
    for (const gone of Array.isArray(expired) ? expired : []) {
      run.emit({
        type: "workflow_heal_expired",
        proposalId: gone.proposalId,
        workflowId: gone.workflowId,
        expiresAt: gone.expiresAt,
        ts: now()
      });
    }
    if (superseded) {
      run.emit({
        type: "workflow_heal_superseded",
        oldProposalId: superseded.proposalId,
        newProposalId: proposal.proposalId,
        workflowId,
        ts: now()
      });
    }
    run.emit({
      type: "workflow_heal_proposed",
      proposalId: proposal.proposalId,
      workflowId: proposal.workflowId,
      baseVersion: proposal.baseVersion,
      steps: proposal.steps,
      reason: proposal.reason,
      evidence: proposal.evidence,
      proposedAt: proposal.proposedAt,
      expiresAt: proposal.expiresAt,
      ts: now()
    });

    return {
      content: [
        {
          type: "text",
          text:
            `Đã đề xuất bản sửa cho "${workflowId}" (từ bản ${proposal.baseVersion}) — mã đề xuất ${proposal.proposalId}. ` +
            `Chưa có gì được lưu: người dùng thấy thẻ đề xuất và phải bấm duyệt thì bản sửa mới thành một phiên bản mới. ` +
            `Đề xuất hết hạn sau ${Math.round((Date.parse(proposal.expiresAt) - Date.parse(proposal.proposedAt)) / 60000)} phút; ` +
            `đừng đề xuất thêm cho tới khi người dùng quyết định.`
        }
      ],
      isError: false
    };
  });
}
