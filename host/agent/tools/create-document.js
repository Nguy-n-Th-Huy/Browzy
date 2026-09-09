// Application-owned `create_document` SDK tool: the one narrow path by which
// a run can hand the operator a real file.
//
// Built on exactly the shape ask-the-user.js established — tool() from the
// SDK, registered on the same in-process MCP server as the browser tools,
// emitting a sequenced stream event and returning an ordinary CallToolResult.
// It differs from ask_user in one deliberate way: it does NOT wait for the
// operator. Creating a document is not a question, and blocking the run on
// someone opening a card would turn every report into a five-minute stall.
//
// This tool grants the run NO filesystem authority. `Bash`/`Write`/`Edit`/
// `NotebookEdit` remain in HIGH_RISK_BUILTINS (query-options.js) and are
// untouched by this file. The model supplies a title, a format and content;
// the id, the directory and the filename are all chosen host-side by
// DocumentStore, which is the module that owns the safety guards (path
// containment, source/output size ceilings, per-conversation count).
//
// The emitted `document_created` event carries METADATA ONLY. Bytes are
// fetched separately, on demand, when the operator opens or downloads the
// card — a 10 MB report must not ride the event stream, where it would also
// be replayed on every reconnect for a document nobody opened.

import { DocumentStore, DocumentLimitError } from "../documents/store.js";
import { DOCUMENT_FORMATS } from "../documents/render/index.js";

/** Single source of truth for this tool's registered name.
 *
 * A tool the SDK server registers is NOT automatically visible to the model:
 * host/agent/tools/query-options.js has to receive the same name through
 * `extraToolNames`, and those two facts drifting apart is exactly what once
 * left ask_user registered-but-uncallable. Anything registering this tool
 * must pass this constant along to buildIsolatedOptions(). */
export const CREATE_DOCUMENT_TOOL_NAME = "create_document";

const FORMAT_KEYS = Object.keys(DOCUMENT_FORMATS);

const TOOL_DESCRIPTION =
  "Create a document file for the user and show it as a downloadable card in the conversation. " +
  "Use this instead of pasting long output inline whenever the result is a document in its own right: " +
  "a report, an audit, an analysis, a plan, a data table, a set of slides. " +
  "Write the content as Markdown; it is stored as-is for `md`/`txt`, and converted for the other formats " +
  "(`docx` for Word, `xlsx` for a spreadsheet — send a Markdown table, `pptx` for slides — use `# ` headings " +
  "as slide titles and bullets as slide content, `pdf`, `csv`, `html`, `json`). " +
  "The user sees a card with the title and can preview or download it. " +
  "After calling this, briefly say what the document contains — do NOT repeat its full text in your reply.";

/**
 * Create the tool.
 *
 * @param {object} deps
 * @param {import("../session/run.js").Run} deps.run - the active run; emit()
 *   pushes document_created into the same sequenced transcript the panel
 *   rebuilds from on reconnect.
 * @param {string} deps.conversationId - the conversation whose documents
 *   directory this run may write to. Bound here, never taken from tool args:
 *   a model-supplied conversation id would be a cross-conversation write.
 * @param {DocumentStore} [deps.store] - injectable for tests
 * @param {Function} [deps.toolFactory] - injectable tool() for tests
 * @param {() => number} [deps.now] - injectable clock for tests
 */
export async function createCreateDocumentTool({ run, conversationId, store, toolFactory, now = Date.now }) {
  if (!run) throw new Error("createCreateDocumentTool requires a run");
  if (!conversationId) throw new Error("createCreateDocumentTool requires a conversationId");

  let tool;
  if (typeof toolFactory === "function") {
    tool = toolFactory;
  } else {
    const sdk = await import("@anthropic-ai/claude-agent-sdk");
    tool = sdk.tool;
  }
  const { z } = await import("zod");
  const documents = store || new DocumentStore();

  const paramShape = {
    title: z.string().describe("The document's human title, shown on the card in the conversation."),
    content: z.string().describe("The document's content, written as Markdown."),
    format: z
      .enum(FORMAT_KEYS)
      .optional()
      .describe(`The file format to produce. Defaults to "md". One of: ${FORMAT_KEYS.join(", ")}.`)
  };

  return tool(CREATE_DOCUMENT_TOOL_NAME, TOOL_DESCRIPTION, paramShape, async (args) => {
    const input = args ?? {};
    const format = input.format || "md";

    let record;
    try {
      record = await documents.write({
        conversationId,
        title: input.title,
        format,
        content: input.content,
        runId: run.runId ?? null
      });
    } catch (err) {
      // Every guard rejects explicitly rather than writing a truncated file,
      // and the reason travels back to the model so it can adapt (shorten the
      // content, pick another format) instead of retrying blindly.
      const reason = err instanceof DocumentLimitError ? err.reason : "write_failed";
      return {
        content: [{ type: "text", text: `Error: could not create the document (${reason}): ${err.message}` }],
        isError: true
      };
    }

    run.emit({
      type: "document_created",
      documentId: record.documentId,
      title: record.title,
      fileName: record.fileName,
      format: record.format,
      mimeType: record.mimeType,
      byteLength: record.byteLength,
      ts: now()
    });

    return {
      content: [
        {
          type: "text",
          text:
            `Đã tạo tài liệu "${record.title}" (${DOCUMENT_FORMATS[record.format].label}, ${record.byteLength} bytes). ` +
            `Người dùng đã thấy thẻ tài liệu này trong hội thoại và có thể xem hoặc tải về. ` +
            `Đừng lặp lại toàn bộ nội dung tài liệu trong câu trả lời.`
        }
      ],
      isError: false
    };
  });
}
