// Task 9.5 (design.md section 8): application-owned ask-the-user SDK tool.
//
// Registered alongside the existing browser tools via the same tool()/
// createSdkMcpServer() pattern host/agent/tools/adapter.js already uses for
// all 26 browser tools — deliberately NOT the SDK's built-in
// AskUserQuestion tool (see design.md section 8's two cited reasons).
//
// Input: one question, a short header, and 2-4 pre-written answer options
// (mirroring the built-in tool's own well-designed shape, without adopting
// its unverified wiring). Handler emits a sequenced question_request stream
// event, awaits the panel's matching question_answer (or a bounded 5-minute
// timeout — the same TTL as approvals), and resolves with the user's chosen
// option(s) as PLAIN tool-result content. The SDK sees an ordinary
// CallToolResult, nothing more. This grants the run NO authority: the answer
// is data the model can read and act on in its next turn, exactly like a
// read_page result — never a PermissionResult, never consulted by canUseTool,
// and never substitutes for the approval card.

import crypto from "node:crypto";
import { z } from "zod";

// 5 minutes — matches approvals.js's defaultTtlMs exactly so the
// ask-the-user abandonment discipline is identical to the approval gate.
const QUESTION_TIMEOUT_MS = 5 * 60_000;

/**
 * Build the ask-the-user SDK tool.
 *
 * @param {object} deps
 * @param {import("../session/run.js").Run} deps.run - the active run; emit()
 *   pushes the question_request stream event into the same sequenced-event
 *   transcript the panel rebuilds from on reconnect.
 * @param {import("../policy/can-use-tool.js").RequestIdTracker} deps.requestIdTracker
 *   - the companion's _pendingQuestions tracker, so _handleQuestionAnswer (the
 *   wire-side question_answer handler in companion.js) can resolve the Promise
 *   the handler below awaits.
 * @param {number} [deps.timeoutMs] - override for tests (default: 5 minutes)
 * @param {() => number} [deps.now] - injectable Date.now for tests
 * @param {() => string} [deps.requestIdMint] - injectable requestId factory
 *   for tests
 * @returns {object} the SDK tool() result, suitable for inclusion in a
 *   createSdkMcpServer() tools array alongside the browser tools.
 */
/** The single source of truth for this tool's registered name. Exported
 * because a tool the SDK server registers is NOT automatically visible to the
 * model: host/agent/tools/query-options.js has to list the same name in its
 * `tools`/`allowedTools` allowlists, and those two facts drifting apart is what
 * left ask_user registered-but-uncallable. Anything that registers this tool
 * must pass this constant along to buildIsolatedOptions(). */
export const ASK_USER_TOOL_NAME = "ask_user";

export function buildAskUserTool({ run, requestIdTracker, timeoutMs = QUESTION_TIMEOUT_MS, now = Date.now, requestIdMint }) {
  if (!run) throw new Error("buildAskUserTool requires a run");
  if (!requestIdTracker) throw new Error("buildAskUserTool requires requestIdTracker");

  // The tool's input schema: one question, a short header, and 2-4 options.
  // Mirrors sdk-tools.d.ts:1026's shape (AskUserQuestionInput) without
  // adopting the built-in tool's unverified wiring.
  const paramShape = {
    type: "object",
    properties: {
      question: { type: "string" },
      header: { type: "string" },
      options: {
        type: "array",
        items: {
          type: "object",
          properties: {
            label: { type: "string" },
            description: { type: "string" }
          }
        }
      },
      multiSelect: { type: "boolean" }
    },
    required: ["question", "header", "options"]
  };

  const toolName = ASK_USER_TOOL_NAME;
  const toolDescription =
    "Ask the user a multiple-choice question. Use when the model genuinely needs the user's input to proceed " +
    "(e.g. clarifying an ambiguous request, choosing between approaches). The question and options MUST be " +
    "pre-written by the model — the user simply picks from the 2-4 provided options. The user's answer is " +
    "ordinary data: it grants no authority, never substitutes for the send/submit approval card, and is " +
    "treated exactly like a read_page result for the next turn.";

  // Lazy import of tool() — same pattern adapter.js uses.
  return null; // placeholder; built below
}

/**
 * Create the ask-the-user SDK tool using the same tool() factory the browser
 * tools use. This is the real entry point; buildAskUserTool above stays as
 * the documented interface for testing.
 */
export async function createAskUserTool({ run, requestIdTracker, timeoutMs = QUESTION_TIMEOUT_MS, now = Date.now, requestIdMint, toolFactory }) {
  if (!run) throw new Error("createAskUserTool requires a run");
  if (!requestIdTracker) throw new Error("createAskUserTool requires requestIdTracker");

  // Allow for an injectable tool() factory — tests use a fake SDK with no
  // real tool(), so they pass a stub. Production code lets this fall
  // through to a lazy dynamic import, the same pattern adapter.js uses.
  let tool;
  if (typeof toolFactory === "function") {
    tool = toolFactory;
  } else {
    const sdk = await import("@anthropic-ai/claude-agent-sdk");
    tool = sdk.tool;
  }

  const paramShape = {
    question: z.string().describe("The question to ask the user."),
    header: z.string().describe("A short, human-readable header for the question card."),
    options: z
      .array(
        z.object({
          label: z.string().describe("The label shown on the option button."),
          description: z.string().optional().describe("A short description of what this option means.")
        })
      )
      .min(2)
      .max(4)
      .describe("2-4 pre-written answer options the user can choose from."),
    multiSelect: z
      .boolean()
      .optional()
      .describe("When true, the user may select multiple options.")
  };

  const toolDescription =
    "Ask the user a multiple-choice question. Use when the model genuinely needs the user's input to proceed " +
    "(e.g. clarifying an ambiguous request, choosing between approaches). The question and options MUST be " +
    "pre-written by the model — the user simply picks from the 2-4 provided options. The user's answer is " +
    "ordinary data: it grants no authority, never substitutes for the send/submit approval card, and is " +
    "treated exactly like a read_page result for the next turn.";

  return tool(ASK_USER_TOOL_NAME, toolDescription, paramShape, async (args) => {
    const input = args ?? {};

    // Validate: 2-4 options required.
    const options = Array.isArray(input.options) ? input.options : [];
    if (options.length < 2 || options.length > 4) {
      return {
        content: [{ type: "text", text: "Error: ask_user requires 2-4 options." }],
        isError: true
      };
    }

    // Mint a requestId correlating the question_request and the panel's answer.
    const requestId = requestIdMint
      ? requestIdMint()
      : `q_${now()}_${crypto.randomBytes(8).toString("hex")}`;

    // Emit a sequenced question_request stream event — same TranscriptStore
    // path as approval_request, so it survives a reconnect.
    run.emit({
      type: "question_request",
      requestId,
      question: String(input.question || ""),
      header: String(input.header || ""),
      options: options.map((o) => ({
        label: String(o.label || ""),
        description: String(o.description || "")
      })),
      multiSelect: !!input.multiSelect,
      ts: now()
    });

    // Await the panel's matching question_answer or the bounded timeout.
    const answer = await new Promise((resolve) => {
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        requestIdTracker.take(requestId);
        resolve(null); // timeout — resolved with an explicit tool-error below
      }, timeoutMs);

      requestIdTracker.set(requestId, (decision) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(decision);
      });
    });

    if (answer == null) {
      // Timeout: explicit tool-error result, never a hang.
      return {
        content: [
          {
            type: "text",
            text: `Quá thời gian chờ câu trả lời (${Math.round(timeoutMs / 1000)} giây). Người dùng chưa trả lời câu hỏi.`
          }
        ],
        isError: true
      };
    }

    // The user's chosen option(s) as plain tool-result content. The SDK
    // sees an ordinary CallToolResult, nothing more. Let's render the answer:
    const chosenOptions = Array.isArray(answer.answer) ? answer.answer : [answer.answer].filter(Boolean);
    if (chosenOptions.length === 0) {
      return {
        content: [{ type: "text", text: "Người dùng không chọn tùy chọn nào." }],
        isError: true
      };
    }

    const summary = chosenOptions.length === 1 ? chosenOptions[0] : chosenOptions.join(", ");
    return {
      content: [{ type: "text", text: `Người dùng đã chọn: ${summary}` }],
      isError: false
    };
  });
}

export { QUESTION_TIMEOUT_MS };
