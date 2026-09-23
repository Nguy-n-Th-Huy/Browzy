// jev-extract-page-tool: the `extract_page` SDK tool.
//
// Lets an `anthropic`/`chatgpt` run offload one bounded, read-only extraction
// to the configured Jev TEXT model: the caller names the fields and types it
// wants, the tool observes the bound tab through the SAME `page_snapshot`
// path the runtime's own observation uses (host/agent/jev/runtime.js's
// PAGE_SNAPSHOT_TOOL via `toolBridge`, no second snapshot mechanism), and the
// text model answers with exactly those keys — every field nullable, `null`
// when evidence is absent or ambiguous. Registered alongside the other
// application-owned tools (ask_user, create_document, page_snapshots,
// propose_workflow_heal, browser_subgoal) via the same tool()/
// createSdkMcpServer() pattern (host/agent/tools/ask-the-user.js), and ONLY
// when the run's profile resolves a configured Jev text model
// (host/agent/settings/profile.js's `resolveJevExtractPageConfig`) — its
// absence is silent, the same WebMCP pattern this codebase already uses for
// an optional capability.
//
// This tool NEVER mutates the page and NEVER needs an approval card: it is
// the same read-only class as `read_page`/`get_page_text`, one observation
// followed by one text-model call, nothing dispatched. The output schema is
// fixed from the CALLER's own `fields` before the model is ever asked —
// nothing on the page, and nothing in the caller's own free-text
// `instruction`, can add, rename, or widen a field (jev-extract-page-tool
// design.md decision 5 / spec "Schema built only from caller fields").

import { z } from "zod";

import { runHostSideChecks, firstTextOf } from "./dispatch-checks.js";
import { PAGE_SNAPSHOT_TOOL } from "../jev/runtime.js";

/** The single source of truth for this tool's registered name — see
 * ask-the-user.js's ASK_USER_TOOL_NAME for why: a tool the SDK server
 * registers is not automatically visible to the model, and this constant is
 * what companion.js passes to both `extraTools` (registration) and
 * `buildIsolatedOptions`'s `extraToolNames` (visibility). The two must move
 * together or the tool is registered but uncallable. */
export const EXTRACT_PAGE_TOOL_NAME = "extract_page";

const TOOL_DESCRIPTION =
  "Extract typed facts from the CURRENT page using a cheaper configured model — read-only, never scrolls, navigates, or mutates anything. " +
  "Describe what to find in `instruction`, and name the exact `fields` you want (each with a `name`, a `type` of " +
  "string/number/boolean/url/object/array, and an optional `description`; an `object` field needs `properties`, an `array` field needs " +
  "`items`). Every field comes back nullable: a value the page does not clearly show is `null`, never guessed. Only the fields you name are " +
  "ever returned — the page itself can never add or rename one.";

// --- The caller's field schema: bounded, caller-only, never page-driven ----

/** A field/property name — the ONLY identifier this tool ever uses as an
 * output key, so it must be safe to use as one without further escaping. */
export const EXTRACT_FIELD_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
export const EXTRACT_FIELD_TYPES = Object.freeze(["string", "number", "boolean", "url", "object", "array"]);
// The caller's own field count/nesting bounds (design.md decision 3): large
// enough for a real extraction task, small enough that neither the request
// nor the model's answer can grow unbounded.
export const MAX_EXTRACT_FIELDS = 20;
export const MAX_EXTRACT_NESTING_DEPTH = 3;
export const MAX_EXTRACT_DESCRIPTION_CHARS = 200;

// A named field (top-level, or an `object`'s property) carries `name`; an
// `array`'s `items` shape describes only a type, never a name of its own —
// two distinct exact-key sets, so an extra key on either shape is refused
// rather than silently ignored (the same exact-key discipline
// text-helper.js's parseMemory/parseStepDecision/parseFinalReport already
// apply to every other model-facing shape in this codebase).
const NAMED_FIELD_KEYS = new Set(["name", "type", "description", "properties", "items"]);
const UNNAMED_SHAPE_KEYS = new Set(["type", "description", "properties", "items"]);

/**
 * One field/shape's own type-specific bounds, shared by a named field and an
 * `array`'s unnamed `items` shape: an allowed `type`, a bounded optional
 * `description`, `object` requiring a non-empty bounded `properties` list
 * (each entry itself a NAMED field, validated recursively), and `array`
 * requiring an `items` shape (validated recursively as UNNAMED). Nesting is
 * bounded by refusing `object`/`array` once `depth` reaches
 * `MAX_EXTRACT_NESTING_DEPTH` — a request may nest an object inside an
 * object inside a field (3 levels) but no deeper.
 *
 * @param {unknown} shape
 * @param {number} depth - 1 for a top-level field.
 * @param {string} label - names this shape in an error message.
 * @param {Set<string>} allowedKeys
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
function validateShape(shape, depth, label, allowedKeys) {
  if (!shape || typeof shape !== "object" || Array.isArray(shape)) {
    return { ok: false, error: `${label} must be an object` };
  }
  const unknown = Object.keys(shape).filter((key) => !allowedKeys.has(key));
  if (unknown.length > 0) {
    return { ok: false, error: `${label} carries unrecognized keys ${JSON.stringify(unknown)}` };
  }
  if (typeof shape.type !== "string" || !EXTRACT_FIELD_TYPES.includes(shape.type)) {
    return { ok: false, error: `${label} has an unsupported type ${JSON.stringify(shape.type)}; must be one of ${JSON.stringify(EXTRACT_FIELD_TYPES)}` };
  }
  if (shape.description !== undefined && (typeof shape.description !== "string" || shape.description.trim() === "" || shape.description.length > MAX_EXTRACT_DESCRIPTION_CHARS)) {
    return { ok: false, error: `${label}'s description must be a nonempty string of at most ${MAX_EXTRACT_DESCRIPTION_CHARS} characters` };
  }

  if (shape.type === "object") {
    if (depth >= MAX_EXTRACT_NESTING_DEPTH) {
      return { ok: false, error: `${label} exceeds the nesting bound of ${MAX_EXTRACT_NESTING_DEPTH}` };
    }
    if (!Array.isArray(shape.properties) || shape.properties.length === 0) {
      return { ok: false, error: `${label} of type "object" requires a non-empty \`properties\` array` };
    }
    if (shape.properties.length > MAX_EXTRACT_FIELDS) {
      return { ok: false, error: `${label}'s properties has ${shape.properties.length} entries, over the ${MAX_EXTRACT_FIELDS} bound` };
    }
    const seen = new Set();
    for (const property of shape.properties) {
      if (!property || typeof property !== "object" || typeof property.name !== "string" || !EXTRACT_FIELD_NAME_PATTERN.test(property.name)) {
        return { ok: false, error: `${label}'s property name ${JSON.stringify(property && property.name)} does not match ${EXTRACT_FIELD_NAME_PATTERN}` };
      }
      if (seen.has(property.name)) {
        return { ok: false, error: `${label} has a duplicate property name "${property.name}"` };
      }
      seen.add(property.name);
      const nested = validateShape(property, depth + 1, `${label}.${property.name}`, NAMED_FIELD_KEYS);
      if (!nested.ok) return nested;
    }
  } else if (shape.properties !== undefined) {
    return { ok: false, error: `${label} is type "${shape.type}" and must not carry \`properties\`` };
  }

  if (shape.type === "array") {
    if (depth >= MAX_EXTRACT_NESTING_DEPTH) {
      return { ok: false, error: `${label} exceeds the nesting bound of ${MAX_EXTRACT_NESTING_DEPTH}` };
    }
    const nested = validateShape(shape.items, depth + 1, `${label}'s items`, UNNAMED_SHAPE_KEYS);
    if (!nested.ok) return nested;
  } else if (shape.items !== undefined) {
    return { ok: false, error: `${label} is type "${shape.type}" and must not carry \`items\`` };
  }

  return { ok: true };
}

/**
 * The caller's top-level `fields`: a non-empty array, bounded count, unique
 * names matching `EXTRACT_FIELD_NAME_PATTERN`, each validated by
 * `validateShape`. This is the ONLY place a field can be added — the model's
 * answer is never trusted to introduce one (text-helper.js's
 * `parseExtraction` builds its result by walking this exact list).
 *
 * @param {unknown} fields
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
export function validateExtractFields(fields) {
  if (!Array.isArray(fields) || fields.length === 0) {
    return { ok: false, error: "`fields` must be a non-empty array" };
  }
  if (fields.length > MAX_EXTRACT_FIELDS) {
    return { ok: false, error: `\`fields\` has ${fields.length} entries, over the ${MAX_EXTRACT_FIELDS} bound` };
  }
  const seen = new Set();
  for (const field of fields) {
    if (!field || typeof field !== "object" || typeof field.name !== "string" || !EXTRACT_FIELD_NAME_PATTERN.test(field.name)) {
      return { ok: false, error: `field name ${JSON.stringify(field && field.name)} does not match the required pattern ${EXTRACT_FIELD_NAME_PATTERN}` };
    }
    if (seen.has(field.name)) {
      return { ok: false, error: `duplicate field name "${field.name}"` };
    }
    seen.add(field.name);
    const shapeResult = validateShape(field, 1, `field "${field.name}"`, NAMED_FIELD_KEYS);
    if (!shapeResult.ok) return shapeResult;
  }
  return { ok: true };
}

// --- The bound tab's observation, via the SAME page_snapshot path ----------

/**
 * Observe the bound tab through the identical `page_snapshot` dispatch the
 * Jev runtime's own `observe()` uses (host/agent/jev/runtime.js): the same
 * host-side checks (`runHostSideChecks`, read-only — `sendClassTool: false`,
 * no approval), the same tool call, and the same "not a usable snapshot"
 * failure shapes. This tool needs no interactive element table and no
 * new-element bookkeeping (it never acts on the page), so it stops at the
 * parsed snapshot itself.
 *
 * @returns {Promise<{ ok: true, snapshot: object } | { ok: false, message: string }>}
 */
async function observeBoundTab({ run, toolBridge, coerceArgs, tabId }) {
  const args = coerceArgs({ tabId });
  const check = runHostSideChecks({ run, legacyToolName: PAGE_SNAPSHOT_TOOL, args, sendClassTool: false });
  if (!check.ok) {
    return { ok: false, message: firstTextOf(check.result) || `the host-side checks refused ${PAGE_SNAPSHOT_TOOL}` };
  }
  let call;
  try {
    call = await toolBridge.call(PAGE_SNAPSHOT_TOOL, args, run.describeRequestForWire());
  } catch (err) {
    return { ok: false, message: `page_snapshot failed: ${err?.message ?? String(err)}` };
  }
  if (call && call.resultUnknown) {
    return { ok: false, message: "page_snapshot's response was lost before it reached the host" };
  }
  const text = firstTextOf(call?.result);
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, message: `page_snapshot did not answer a JSON snapshot: ${text.slice(0, 200)}` };
  }
  if (parsed?.available === false) {
    return { ok: false, message: "the bound page is unavailable for reading" };
  }
  if (call?.result?.isError === true) {
    return { ok: false, message: "page_snapshot returned a tool error" };
  }
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.elements) || typeof parsed.url !== "string") {
    return { ok: false, message: "page_snapshot answered a shape without `url` and `elements`" };
  }
  return { ok: true, snapshot: parsed };
}

/**
 * Create the `extract_page` SDK tool using the same `tool()` factory the
 * browser tools and the other application-owned tools use.
 *
 * @param {object} deps
 * @param {import("../session/run.js").Run} deps.run - the SAME run the SDK
 *   conversation is driving; observation reuses its lease and tab scope.
 * @param {import("../broker/tool-bridge.js").ToolBridge} deps.toolBridge - the
 *   SAME bridge the SDK's browser tools dispatch through.
 * @param {(args: object) => object} deps.coerceArgs - the SAME argument
 *   coercion the SDK tool handlers apply.
 * @param {{ textModel: { kind: string, baseUrl: string, model: string, apiKey: string } }} deps.jevConfig
 *   - `resolveJevExtractPageConfig`'s resolved shape.
 * @param {() => (number|null)} deps.resolveTabId - resolves the outer run's
 *   currently bound tab AT CALL TIME (never cached at registration time —
 *   same rule browser-subgoal.js's `resolveTabId` documents).
 * @param {(name: string, description: string, shape: object, handler: Function) => object} [deps.toolFactory]
 *   - injectable for tests; production dynamically imports the real SDK's
 *   `tool()`, same pattern as ask-the-user.js.
 * @param {Function} [deps.requestPageExtractImpl] - injectable for tests;
 *   production dynamically imports the real `requestPageExtract`.
 * @returns {Promise<object>} the SDK tool() result, suitable for inclusion in
 *   a createSdkMcpServer() tools array alongside the browser tools.
 */
export async function createExtractPageTool({
  run,
  toolBridge,
  coerceArgs,
  jevConfig,
  resolveTabId,
  toolFactory,
  requestPageExtractImpl
}) {
  if (!run) throw new Error("createExtractPageTool requires a run");
  if (!toolBridge) throw new Error("createExtractPageTool requires a toolBridge");
  if (typeof coerceArgs !== "function") throw new Error("createExtractPageTool requires coerceArgs");
  if (!jevConfig || typeof jevConfig !== "object" || !jevConfig.textModel) {
    throw new Error("createExtractPageTool requires a resolved jevConfig with a textModel");
  }

  let tool;
  if (typeof toolFactory === "function") {
    tool = toolFactory;
  } else {
    const sdk = await import("@anthropic-ai/claude-agent-sdk");
    tool = sdk.tool;
  }

  const paramShape = {
    instruction: z
      .string()
      .min(1)
      .describe("What to extract from the current page, in plain language (e.g. \"the listed price and availability\")."),
    fields: z
      .array(z.record(z.any()))
      .min(1)
      .describe(
        "The exact fields to extract, each `{name, type, description?}` (type: string/number/boolean/url/object/array). " +
          "An `object` field also needs `properties` (an array of fields); an `array` field also needs `items` (one `{type, description?}` shape). " +
          "Only these named fields are ever returned; the page can never add or rename one."
      )
  };

  return tool(EXTRACT_PAGE_TOOL_NAME, TOOL_DESCRIPTION, paramShape, async (args) => {
    const instruction = typeof args?.instruction === "string" ? args.instruction.trim() : "";
    if (!instruction) {
      return {
        content: [{ type: "text", text: "extract_page requires a non-empty `instruction` string describing what to extract." }],
        isError: true
      };
    }
    const fieldsResult = validateExtractFields(args?.fields);
    if (!fieldsResult.ok) {
      return {
        content: [{ type: "text", text: `extract_page requires a valid \`fields\` schema: ${fieldsResult.error}` }],
        isError: true
      };
    }
    const fields = args.fields;

    const tabId = typeof resolveTabId === "function" ? resolveTabId() : null;
    if (!Number.isInteger(tabId)) {
      return {
        content: [{ type: "text", text: "extract_page has no bound page tab to read; open or bind a page first." }],
        isError: true
      };
    }

    const observation = await observeBoundTab({ run, toolBridge, coerceArgs, tabId });
    if (!observation.ok) {
      return {
        content: [{ type: "text", text: JSON.stringify({ ok: false, error: observation.message }) }],
        isError: true
      };
    }

    const requestPageExtract = typeof requestPageExtractImpl === "function"
      ? requestPageExtractImpl
      : (await import("../jev/text-helper.js")).requestPageExtract;

    let result;
    try {
      result = await requestPageExtract({
        textModel: jevConfig.textModel,
        instruction,
        fields,
        page: observation.snapshot
      });
    } catch (err) {
      // A JevError (transport/provider/malformed-answer) or an unexpected
      // runtime bug alike: the tool call must still answer the caller
      // honestly rather than throwing out of the handler (mirrors
      // browser_subgoal's own catch-all). `err.message` is a host-authored
      // sentence built from a bounded reply preview and this module's own
      // failureNote — never the request body or the configured key.
      return {
        content: [{ type: "text", text: JSON.stringify({ ok: false, error: (err && err.message) || String(err) }) }],
        isError: true
      };
    }

    return {
      content: [{ type: "text", text: JSON.stringify({ ok: true, fields: result.fields }) }],
      isError: false
    };
  });
}
