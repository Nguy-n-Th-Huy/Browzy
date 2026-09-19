// Application-owned `page_snapshots` SDK tool: save what a page showed, keep
// it, and compare a later capture against it.
//
// Built on the create_document/ask_user shape — tool() from the SDK, registered
// on the same in-process MCP server as the browser tools, emitting a sequenced
// stream event and returning an ordinary CallToolResult. It grants the run NO
// filesystem authority: the model supplies a name and the DATA it already read
// from the page (with `page_snapshot`, `get_page_text`, `read_page`, or
// `javascript_tool`), and every path, filename and URL hash is chosen host-side
// by SnapshotStore. This tool never reads the page — extraction stays with the
// tools the run already has, so there is exactly one extractor in the system
// rather than a second one that drifts.
//
// The five actions are one tool rather than five: they share one store, one
// binding to the run's conversation, and one place where the arguments are
// validated, and a separate registration per action would multiply the
// registered-but-invisible trap (see PAGE_SNAPSHOTS_TOOL_NAME) five times.
//
// Errors are returned as `isError` text naming a reason, never thrown at the
// model: every guard in the store rejects explicitly (oversize fields, an
// unusable name, a missing URL, an unreadable file) and the reason has to
// travel back so the model can adapt instead of retrying blindly.

import { DocumentStore, DocumentLimitError } from "../documents/store.js";
import { diffFields } from "../snapshots/diff.js";
import { markdownReport, jsonReport } from "../snapshots/report.js";
import { SnapshotError, SnapshotStore } from "../snapshots/store.js";

/** Single source of truth for this tool's registered name.
 *
 * A tool the SDK server registers is NOT automatically visible to the model:
 * host/agent/tools/query-options.js has to receive the same name through
 * `extraToolNames`, and those two facts drifting apart is exactly what once
 * left ask_user registered-but-uncallable. Anything registering this tool must
 * pass this constant along to buildIsolatedOptions(). */
export const PAGE_SNAPSHOTS_TOOL_NAME = "page_snapshots";

const TOOL_DESCRIPTION =
  "Save what a page showed, and compare a later capture against it. " +
  "Actions: `save` stores the fields you read from the current page (supply name, url, title, and the fields " +
  "you extracted — this tool never reads the page itself); `list` shows stored snapshots (optional `url` and " +
  "`namePattern` filters); `get` returns one stored snapshot in full; `delete` removes one; `compare` diffs two " +
  "stored snapshots (baseline vs current) and returns the changes as JSON and markdown, and by default also " +
  "saves the markdown as a document card in this conversation. Reference a snapshot by `name` + `url`, or by its " +
  "absolute `path`. The host chooses every path and filename; names are slugified host-side. Use this to monitor " +
  "a page over time: save a baseline now, `compare` against it on a later visit.";

const REF_DESCRIPTION = "A stored snapshot: its `name` together with its page `url`, or its absolute `path`.";

/**
 * Create the tool.
 *
 * @param {object} deps
 * @param {import("../session/run.js").Run} deps.run - the active run; emit()
 *   pushes snapshot_saved / snapshot_compared into the same sequenced
 *   transcript the panel rebuilds from on reconnect.
 * @param {string} deps.conversationId - the conversation a comparison report
 *   may be filed under (bound here, never taken from tool args).
 * @param {SnapshotStore} [deps.store] - injectable for tests
 * @param {object} [deps.reportStore] - the DocumentStore the markdown report is
 *   written through; injectable for tests. Same store `create_document` uses —
 *   the snapshot feature deliberately owns no second report pipeline.
 * @param {Function} [deps.toolFactory] - injectable tool() for tests
 * @param {() => number} [deps.now] - injectable clock for tests
 */
export async function createPageSnapshotsTool({
  run,
  conversationId,
  store,
  reportStore,
  toolFactory,
  now = Date.now
}) {
  if (!run) throw new Error("createPageSnapshotsTool requires a run");
  if (!conversationId) throw new Error("createPageSnapshotsTool requires a conversationId");

  let tool;
  if (typeof toolFactory === "function") {
    tool = toolFactory;
  } else {
    const sdk = await import("@anthropic-ai/claude-agent-sdk");
    tool = sdk.tool;
  }
  const { z } = await import("zod");
  // The tool's clock is the store's clock: a run that injects `now` (tests, and
  // anything that needs a reproducible capture time) must not end up with a
  // host-minted timestamp from a different source than the events it emits.
  const snapshots = store || new SnapshotStore({ now });
  const reports = reportStore || new DocumentStore();

  const refShape = z.object({
    name: z.string().optional().describe("The snapshot's name, as shown by `list`."),
    url: z.string().optional().describe("The page URL the snapshot was captured from."),
    path: z.string().optional().describe("The snapshot file's absolute path, as returned by `save` or `list`.")
  });

  const paramShape = {
    action: z.enum(["save", "list", "get", "delete", "compare"]).describe("Which snapshot operation to run."),
    name: z
      .string()
      .optional()
      .describe("`save`: the name for this capture (slugified host-side); `get`/`delete`: which snapshot to address."),
    url: z
      .string()
      .optional()
      .describe("`save`: the page's URL (required); `list`: only snapshots of this URL; `get`/`delete`: with `name`."),
    title: z.string().optional().describe("`save`: the page title, verbatim."),
    fields: z
      .record(z.any())
      .optional()
      .describe("`save`: the fields you read from the page, as a JSON object. Required — this tool does not read the page."),
    viewport: z.string().optional().describe("`save`: the viewport the capture was made at, when known."),
    namePattern: z.string().optional().describe("`list`: a name filter — a substring, or a glob with * and ?."),
    path: z.string().optional().describe("`get`/`delete`: the snapshot file's absolute path, instead of name + url."),
    baseline: refShape.optional().describe("`compare`: the earlier snapshot to compare from."),
    current: refShape.optional().describe("`compare`: the newer snapshot to compare against the baseline."),
    writeReport: z
      .boolean()
      .optional()
      .describe(
        "`compare`: also save the markdown report as a document card in this conversation. Defaults to true; " +
          "a failure to write the card never fails the comparison."
      )
  };

  const textResult = (text) => ({ content: [{ type: "text", text }], isError: false });
  const errorResult = (text) => ({ content: [{ type: "text", text: `Error: ${text}` }], isError: true });

  /** Every rejection travels back as a named reason; nothing is thrown at the model. */
  const failure = (action, err) => {
    const reason = err instanceof SnapshotError ? err.reason : "unexpected_error";
    return errorResult(`${action} failed (${reason}): ${err.message}`);
  };

  function save(input) {
    const record = snapshots.save({
      name: input.name,
      url: input.url,
      title: input.title,
      fields: input.fields,
      metadata: {
        runId: run.runId ?? null,
        conversationId,
        viewport: typeof input.viewport === "string" ? input.viewport : null
      }
    });
    run.emit({
      type: "snapshot_saved",
      name: record.name,
      url: record.url,
      timestamp: record.timestamp,
      path: record.path,
      ts: now()
    });
    return textResult(
      `Saved snapshot "${record.name}" (captured ${record.timestamp}) at ${record.path}. ` +
        `Compare a later capture against it with action "compare" and baseline { name: ${JSON.stringify(record.name)}, ` +
        `url: ${JSON.stringify(record.url)} }.`
    );
  }

  function list(input) {
    const url = typeof input.url === "string" && input.url.trim() ? input.url : null;
    const namePattern = typeof input.namePattern === "string" && input.namePattern.trim() ? input.namePattern : null;
    const entries = snapshots.list({ url, namePattern });
    const readable = entries.filter((entry) => entry.valid);
    const unreadable = entries.filter((entry) => !entry.valid);
    const filters = [
      url ? `url=${JSON.stringify(url)}` : null,
      namePattern ? `namePattern=${JSON.stringify(namePattern)}` : null
    ].filter(Boolean);
    const header =
      `${readable.length} snapshot${readable.length === 1 ? "" : "s"}` +
      (unreadable.length ? `, ${unreadable.length} unreadable` : "") +
      (filters.length ? ` (filter: ${filters.join(", ")})` : "") +
      ":";
    if (!entries.length) return textResult(`${header} none stored.`);
    const lines = entries.map((entry) => {
      if (!entry.valid) return `- [invalid: ${entry.reason}] ${entry.path}${entry.detail ? ` — ${entry.detail}` : ""}`;
      const title = entry.title ? ` "${entry.title}"` : "";
      return `- ${JSON.stringify(entry.name)} · ${entry.timestamp} · ${entry.url}${title} · ${entry.path} (${entry.size} bytes)`;
    });
    return textResult([header, ...lines].join("\n"));
  }

  function get(input) {
    const record = snapshots.read({ name: input.name, url: input.url, path: input.path });
    return textResult(`Snapshot ${JSON.stringify(record.name)} (${record.path}):\n${JSON.stringify(record, null, 2)}`);
  }

  function remove(input) {
    // Deliberately no pre-read: a snapshot whose JSON is corrupt is exactly the
    // file an operator needs to be able to delete, so deletion resolves the
    // reference and unlinks it without parsing the record.
    const result = snapshots.remove({ name: input.name, url: input.url, path: input.path });
    return textResult(
      `Deleted snapshot ${JSON.stringify(input.name || input.path)} at ${result.path}.` +
        (result.pruned ? " Its URL directory was empty and is now removed." : "")
    );
  }

  /** Load one side of a comparison, naming WHICH side failed and why. */
  function loadSide(ref, side) {
    if (!ref || typeof ref !== "object") {
      throw new SnapshotError(`missing_${side}`, `the ${side} snapshot reference is required (name + url, or path)`);
    }
    try {
      return snapshots.read({ name: ref.name, url: ref.url, path: ref.path });
    } catch (err) {
      if (err instanceof SnapshotError) {
        throw new SnapshotError(`${side}_${err.reason}`, `the ${side} snapshot could not be loaded — ${err.message}`);
      }
      throw err;
    }
  }

  async function compare(input) {
    const baseline = loadSide(input.baseline, "baseline");
    const current = loadSide(input.current, "current");
    const diff = diffFields(baseline.fields ?? {}, current.fields ?? {});
    const generatedAt = new Date(now()).toISOString();
    const json = jsonReport({ baseline, current, diff, generatedAt });
    const markdown = markdownReport({ baseline, current, diff, generatedAt });

    let documentNote;
    if (input.writeReport !== false) {
      const title = `Snapshot comparison: ${baseline.name} → ${current.name}`;
      try {
        const doc = await reports.write({
          conversationId,
          title,
          format: "md",
          content: markdown,
          runId: run.runId ?? null
        });
        json.document = { documentId: doc.documentId, title: doc.title, fileName: doc.fileName, format: doc.format };
        documentNote =
          `The markdown report is also saved as the document "${doc.title}" (${doc.documentId}) — the user can ` +
          `open or download it from the conversation. Do not repeat the report's full text in your reply.`;
      } catch (err) {
        // The comparison is done and correct; only the card failed. Saying so is
        // better than failing a comparison the operator asked for.
        const reason = err instanceof DocumentLimitError ? err.reason : "write_failed";
        json.document = { error: reason, detail: err.message };
        documentNote =
          `The markdown report could NOT be saved as a document (${reason}: ${err.message}). ` +
          `The comparison itself is complete and returned below.`;
      }
    }

    run.emit({
      type: "snapshot_compared",
      baseline: { name: baseline.name, url: baseline.url, timestamp: baseline.timestamp, path: baseline.path },
      current: { name: current.name, url: current.url, timestamp: current.timestamp, path: current.path },
      summary: json.summary,
      documentId: json.document?.documentId ?? null,
      ts: now()
    });

    const summaryLine =
      json.summary.total === 0
        ? "No changes detected — both captures carry identical field data."
        : `${json.summary.total} difference(s): ${json.summary.added} added, ${json.summary.removed} removed, ` +
          `${json.summary.changed} changed, ${json.summary.reordered} reordered.`;
    return textResult(
      [
        `Comparison of baseline ${JSON.stringify(baseline.name)} (${baseline.timestamp}) against current ` +
          `${JSON.stringify(current.name)} (${current.timestamp}):`,
        summaryLine,
        documentNote,
        "",
        "--- markdown report ---",
        markdown,
        "--- json report ---",
        JSON.stringify(json, null, 2)
      ]
        .filter((part) => part !== undefined)
        .join("\n")
    );
  }

  return tool(PAGE_SNAPSHOTS_TOOL_NAME, TOOL_DESCRIPTION, paramShape, async (args) => {
    const input = args ?? {};
    try {
      switch (input.action) {
        case "save":
          return save(input);
        case "list":
          return list(input);
        case "get":
          return get(input);
        case "delete":
          return remove(input);
        case "compare":
          return await compare(input);
        default:
          return errorResult(
            `unknown action ${JSON.stringify(input.action)}; expected one of save, list, get, delete, compare.`
          );
      }
    } catch (err) {
      return failure(String(input.action || "page_snapshots"), err);
    }
  });
}
