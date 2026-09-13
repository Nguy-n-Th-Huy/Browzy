// Table-driven BASELINE coverage for every entry in the tool registry
// (host/tool-definitions.js), captured before the Claude Agent SDK migration.
//
// Scope: openspec/changes/migrate-to-claude-agent-sdk task 6.1, BASELINE HALF
// ONLY. Design section 6 ("Regression and migration boundaries") calls for a
// "table-driven fixture suite from all 26 current registry entries" recording
// "baseline before extraction" so post-migration results can be diffed
// against it. This file IS that baseline capture. The "26" above is quoted
// verbatim from that archived change's own design.md and describes the
// registry AS IT STOOD FOR THAT MIGRATION — it is not this file's live count
// today. openspec/changes/consume-webmcp-page-tools later added two more
// entries on top of that preserved baseline; see DESIGN_DOC_TOOL_LIST and
// POST_BASELINE_ADDITIONS below for how this suite tracks the two counts
// separately rather than editing this historical quote to a new number.
//
// It deliberately does NOT implement the second half of 6.1 (mapping
// friendly SDK-facing operations to preserved executor contracts, or the
// borrowed-tab scope extension from design section 5b) — that depends on the
// SDK adapter from task group 3, which does not exist yet in this repo.
//
// It also does not attempt any live browser round trip (no browser or native
// host connection is available offline). Everything here is derived from:
//   - the registry declarations in host/tool-definitions.js (imported live,
//     never hand-copied, so an added/removed/changed entry is caught), and
//   - the shipped handler source in extension/background.js, read the same
//     way test/handlers.test.mjs does (via test/_extract.mjs's brace-matching
//     extractor) so this exercises the real implementation, not a paraphrase.
// Anything that would require an actual browser round trip (real screenshot
// bytes, real tab side effects) is out of scope here and belongs to task 6.4.
//
// The committed snapshot at test/fixtures/registry-baseline.json is the
// "before" record. This suite compares the LIVE registry against that
// snapshot on every run, so any future schema drift — an entry added,
// removed, or its argument/result contract changed — fails loudly with a
// readable diff instead of silently passing.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TOOLS, toolInputJsonSchema } from "../host/tool-definitions.js";
import { extractMethod, BACKGROUND } from "./_extract.mjs";
import { _mutationClassificationCoverage } from "../host/agent/tools/mapping.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_PATH = path.join(__dirname, "fixtures", "registry-baseline.json");

let fail = 0;
const ok = (c, m) => { console.log((c ? "  PASS " : "  FAIL ") + m); if (!c) fail++; };

// --- small local extraction helpers -----------------------------------------
// (Deliberately not added to the shared test/_extract.mjs: that file is a
// dependency of other in-flight test suites and this task's scope is
// additive-only. These two helpers are only needed here, to read the
// CONFIG_SCHEMA object literal — extractMethod already covers every tool
// handler by name.)

function matchBraces(src, from) {
  let depth = 0;
  let i = src.indexOf("{", from);
  for (let k = i; k < src.length; k++) {
    if (src[k] === "{") depth++;
    else if (src[k] === "}") {
      depth--;
      if (depth === 0) return k + 1;
    }
  }
  throw new Error("unbalanced braces from index " + from);
}

/** Source text of a top-level `const NAME = { ... };` object literal. */
function extractConstObjectSource(name, file = BACKGROUND) {
  const src = fs.readFileSync(file, "utf8");
  const i = src.indexOf(`const ${name} = {`);
  if (i === -1) throw new Error(`const ${name} not found in ${file}`);
  const braceStart = src.indexOf("{", i);
  const end = matchBraces(src, i);
  return src.slice(braceStart, end);
}

/** Top-level `key:` identifiers directly inside an object literal's source
 * (skips nested objects/arrays and string contents, so a word like "token"
 * appearing inside a description STRING is never mistaken for a config key). */
function topLevelKeys(objectSource) {
  const keys = [];
  let depth = 0;
  let inString = null;
  for (let i = 0; i < objectSource.length; i++) {
    const c = objectSource[i];
    if (inString) {
      if (c === "\\") { i++; continue; }
      if (c === inString) inString = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { inString = c; continue; }
    if (c === "{" || c === "[" || c === "(") { depth++; continue; }
    if (c === "}" || c === "]" || c === ")") { depth--; continue; }
    if (depth === 1) {
      const m = /^([A-Za-z_$][A-Za-z0-9_$]*)\s*:/.exec(objectSource.slice(i));
      if (m) { keys.push(m[1]); i += m[0].length - 1; }
    }
  }
  return keys;
}

/** Does this tool's shipped handler body declare an MCP image content block? */
function handlerProducesImage(toolName) {
  const body = extractMethod(toolName);
  return /type:\s*["']image["']/.test(body);
}

/** Is this tool's shipped handler currently a stub (unimplemented in this
 * build), as opposed to a real implementation? Baseline must record this
 * truthfully — a stub today must still read as a stub in the "before"
 * snapshot, not be assumed-implemented. */
function handlerIsStub(toolName) {
  const body = extractMethod(toolName);
  return /not (yet )?implemented|not supported/i.test(body);
}

// =============================================================================
// 1. Enumerate the registry PROGRAMMATICALLY (imported, never hand-copied)
// =============================================================================

console.log("== Registry enumeration (host/tool-definitions.js, imported live) ==");
const liveNames = TOOLS.map((t) => t.name);
console.log(`  Live registry has ${TOOLS.length} entries: ${liveNames.join(", ")}`);

// design.md's "Repository findings" section asserts these exact 26 names as
// the authoritative preservation inventory. Quoting that list here is a
// cross-check against the design doc, NOT the source of truth for the
// suite — the source of truth is the `TOOLS` import above. If this list and
// the live registry ever disagree, that is exactly the discrepancy this task
// was asked to surface.
const DESIGN_DOC_TOOL_LIST = [
  "tabs_context_mcp", "tabs_create_mcp", "debug_timings", "tabs_close_mcp", "navigate",
  "computer", "find", "form_input", "get_page_text", "gif_creator", "javascript_tool",
  "read_console_messages", "read_network_requests", "read_page", "resize_window",
  "shortcuts_list", "shortcuts_execute", "switch_browser", "update_plan", "debug",
  "get_config", "set_config", "set_tab_focus", "upload_image", "retranscribe_recording",
  "file_upload"
];

// Tools added to the registry AFTER the archived migrate-to-claude-agent-sdk
// baseline above, tracked as their own explicitly-enumerated set rather than
// folded into DESIGN_DOC_TOOL_LIST — that list quotes an ARCHIVED change's
// design.md verbatim and never named these; amending it to include them would
// misrepresent what that archived document actually said (and would make a
// genuine future regression — a preserved tool quietly dropped —
// indistinguishable from an intentional addition). Added by
// openspec/changes/consume-webmcp-page-tools (see that change's design.md
// decision 5), openspec/changes/add-browser-batch-tool, and
// openspec/changes/implement-stubbed-browser-tools (list_connected_browsers
// plus select_browser); NOT part of the 26-operation preservation baseline —
// openspec/specs/agent-browser-runtime's "Preserve the browser capability
// baseline" requirement is what calls for tracking additions this way.
const POST_BASELINE_ADDITIONS = [
  "webmcp_list_tools",
  "webmcp_call_tool",
  "browser_batch",
  "list_connected_browsers",
  "select_browser"
];

// Operations removed from the baseline, each naming its replacement, so a
// removal stays distinguishable from a loss. Added by
// openspec/changes/implement-stubbed-browser-tools (switch_browser's blind
// timed release replaced by select_browser's confirmed handoff).
const REMOVED_BASELINE_OPERATIONS = [{ name: "switch_browser", replacedBy: "select_browser" }];
const removedNames = new Set(REMOVED_BASELINE_OPERATIONS.map((r) => r.name));

const missingFromLive = DESIGN_DOC_TOOL_LIST.filter((n) => !liveNames.includes(n));
const extraInLive = liveNames.filter((n) => !DESIGN_DOC_TOOL_LIST.includes(n));
const unexplainedMissing = missingFromLive.filter((n) => !removedNames.has(n));

ok(
  TOOLS.length === DESIGN_DOC_TOOL_LIST.length + POST_BASELINE_ADDITIONS.length - REMOVED_BASELINE_OPERATIONS.length,
  `live registry has exactly ${DESIGN_DOC_TOOL_LIST.length} preserved-baseline + ${POST_BASELINE_ADDITIONS.length} post-baseline - ${REMOVED_BASELINE_OPERATIONS.length} removed ` +
    `entries (${DESIGN_DOC_TOOL_LIST.length + POST_BASELINE_ADDITIONS.length - REMOVED_BASELINE_OPERATIONS.length} total) — actual: ${TOOLS.length}`
);
ok(
  unexplainedMissing.length === 0,
  unexplainedMissing.length === 0
    ? "every tool design.md lists is present in the live registry or named in the removals set"
    : `DISCREPANCY: design.md lists tools missing from the live registry: ${unexplainedMissing.join(", ")}`
);
for (const r of REMOVED_BASELINE_OPERATIONS) {
  ok(
    !liveNames.includes(r.name) && liveNames.includes(r.replacedBy),
    `removal recorded: '${r.name}' is absent and its replacement '${r.replacedBy}' is present`
  );
}
// extraInLive must equal POST_BASELINE_ADDITIONS EXACTLY, in both
// directions — not merely "extras are permitted". An unaccounted-for extra
// (a tool nobody documented) and a documented addition gone missing (a
// preserved-looking tool quietly dropped by rename or removal) are both
// real discrepancies, and this must fail loudly on either.
const extraInLiveSet = new Set(extraInLive);
const postBaselineSet = new Set(POST_BASELINE_ADDITIONS);
const unaccountedExtras = extraInLive.filter((n) => !postBaselineSet.has(n));
const postBaselineMissing = POST_BASELINE_ADDITIONS.filter((n) => !extraInLiveSet.has(n));
ok(
  unaccountedExtras.length === 0 && postBaselineMissing.length === 0,
  unaccountedExtras.length === 0 && postBaselineMissing.length === 0
    ? `every tool in the live registry beyond design.md's list is exactly the enumerated post-baseline set: ${POST_BASELINE_ADDITIONS.join(", ")}`
    : [
        unaccountedExtras.length
          ? `DISCREPANCY: live registry has unaccounted-for tool(s) beyond design.md's list and POST_BASELINE_ADDITIONS: ${unaccountedExtras.join(", ")}`
          : null,
        postBaselineMissing.length
          ? `DISCREPANCY: POST_BASELINE_ADDITIONS lists tool(s) missing from the live registry: ${postBaselineMissing.join(", ")}`
          : null
      ]
        .filter(Boolean)
        .join("; ")
);

const namesSet = new Set(liveNames);
ok(namesSet.size === liveNames.length, "no duplicate tool names in the live registry");

// Previously (migrate-to-claude-agent-sdk): host/tool-definitions.js's own
// top-of-file comment said "The 25 browzy-in-chrome tool definitions..."
// while the array actually held 26 — a discrepancy that change reported
// here (and in reports/06-registry-baseline.md) rather than fixed, since
// that file was out of scope for it. openspec/changes/consume-webmcp-
// page-tools owns host/tool-definitions.js (it appends the two entries
// POST_BASELINE_ADDITIONS names above) and corrected that header comment in
// the same pass — it now names both the 26-preserved and 2-added counts, so
// this is a resolved-history note, not a live discrepancy: verified below.
ok(
  TOOLS.length === DESIGN_DOC_TOOL_LIST.length + POST_BASELINE_ADDITIONS.length - REMOVED_BASELINE_OPERATIONS.length,
  TOOLS.length === DESIGN_DOC_TOOL_LIST.length + POST_BASELINE_ADDITIONS.length - REMOVED_BASELINE_OPERATIONS.length
    ? `host/tool-definitions.js's header count (${DESIGN_DOC_TOOL_LIST.length} preserved + ${POST_BASELINE_ADDITIONS.length} post-baseline - ${REMOVED_BASELINE_OPERATIONS.length} removed) now matches the live array`
    : `DISCREPANCY: host/tool-definitions.js's header claims ${DESIGN_DOC_TOOL_LIST.length} preserved + ${POST_BASELINE_ADDITIONS.length} post-baseline - ${REMOVED_BASELINE_OPERATIONS.length} removed entries but the live array has ${TOOLS.length}`
);

// =============================================================================
// 1b. Read-only/mutating classification coverage (add-permission-modes-and-
//     threat-signals task 1.5)
// =============================================================================
//
// mapping.js's isMutatingCall() fail-safe-defaults an unrecognized tool name
// to MUTATING rather than throwing or reporting a gap — the right behavior
// for a caller that just wants a conservative answer, but it means a tool
// appended to TOOLS without a matching READ_ONLY_LEGACY_TOOLS/
// MUTATING_LEGACY_TOOLS entry classifies silently (as mutating) instead of
// failing loudly. host/test/permission-modes.test.mjs already proves the
// CURRENT two sets have no gap against the CURRENT registry; it cannot catch
// a FUTURE registry addition landing with no matching classification entry,
// because nothing there re-runs when tool-definitions.js changes without
// mapping.js also changing. This suite already re-imports TOOLS live on
// every run (see the registry enumeration above), so it is the right place
// to close that gap: assert every live tool name is accounted for by
// EXACTLY one of the two classification sets, or is "computer" (classified
// per-action, not by name, per mapping.js's own comment on
// _mutationClassificationCoverage()).
console.log("== read-only/mutating classification coverage (mapping.js) ==");
{
  const { readOnly, mutating } = _mutationClassificationCoverage();
  const unclassified = liveNames.filter((n) => n !== "computer" && !readOnly.has(n) && !mutating.has(n));
  const doubleClassified = liveNames.filter((n) => readOnly.has(n) && mutating.has(n));
  ok(
    unclassified.length === 0,
    unclassified.length === 0
      ? `every one of the live registry's ${liveNames.length} tools is covered by READ_ONLY_LEGACY_TOOLS, MUTATING_LEGACY_TOOLS, or is "computer"`
      : `DISCREPANCY: tool(s) added to the registry with no read-only/mutating classification entry in host/agent/tools/mapping.js: ${unclassified.join(", ")}`
  );
  ok(
    doubleClassified.length === 0,
    doubleClassified.length === 0
      ? "no tool is listed in both the read-only and mutating classification sets"
      : `DISCREPANCY: tool(s) listed in BOTH classification sets (ambiguous): ${doubleClassified.join(", ")}`
  );
}

// =============================================================================
// 2 & 4. Table-driven baseline snapshot: current contract for every entry
// =============================================================================

function buildLiveSnapshot() {
  return TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: toolInputJsonSchema(t),
    resultShape: {
      producesImage: handlerProducesImage(t.name),
      currentlyStub: handlerIsStub(t.name)
    }
  })).sort((a, b) => a.name.localeCompare(b.name));
}

const live = buildLiveSnapshot();

let snapshot;
try {
  snapshot = JSON.parse(fs.readFileSync(SNAPSHOT_PATH, "utf8"));
} catch (err) {
  ok(false, `could not read committed snapshot at ${SNAPSHOT_PATH}: ${err.message}`);
  snapshot = [];
}

console.log(`\n== Table-driven baseline: live registry vs committed snapshot (${SNAPSHOT_PATH}) ==`);
const liveByName = new Map(live.map((e) => [e.name, e]));
const snapByName = new Map(snapshot.map((e) => [e.name, e]));
const allNames = [...new Set([...liveByName.keys(), ...snapByName.keys()])].sort();

for (const name of allNames) {
  const liveEntry = liveByName.get(name);
  const snapEntry = snapByName.get(name);
  if (!liveEntry) {
    ok(false, `${name}: present in committed snapshot but MISSING from the live registry (entry removed — regenerate the snapshot if intentional)`);
    continue;
  }
  if (!snapEntry) {
    ok(false, `${name}: present in the live registry but MISSING from the committed snapshot (entry added — regenerate the snapshot)`);
    continue;
  }
  const liveJson = JSON.stringify(liveEntry);
  const snapJson = JSON.stringify(snapEntry);
  if (liveJson === snapJson) {
    const argCount = Object.keys(liveEntry.inputSchema.properties || {}).length;
    const reqCount = (liveEntry.inputSchema.required || []).length;
    const shape = `${reqCount} required / ${argCount - reqCount} optional arg(s)` +
      (liveEntry.resultShape.producesImage ? ", declares image output" : "") +
      (liveEntry.resultShape.currentlyStub ? ", currently a stub handler" : "");
    ok(true, `${name}: matches baseline snapshot (${shape})`);
  } else {
    ok(false, `${name}: DRIFTED from baseline snapshot`);
    console.log(`    expected: ${snapJson}`);
    console.log(`    actual:   ${liveJson}`);
  }
}

// =============================================================================
// 3. Design section 6 preservation properties
// =============================================================================

console.log("\n== Preservation properties (design.md section 6) ==");

// Legacy names containing "mcp" remain present as internal compatibility
// aliases. Filtered from the PRESERVED-baseline names only (DESIGN_DOC_TOOL_
// LIST), not raw liveNames — POST_BASELINE_ADDITIONS' "webmcp_*" names also
// contain the substring "mcp" (they are named after the WebMCP protocol, not
// after this legacy alias convention) and are not compatibility aliases, so
// counting them here would misreport what this check actually found.
const legacyMcpNames = DESIGN_DOC_TOOL_LIST.filter((n) => liveNames.includes(n) && n.includes("mcp"));
ok(
  legacyMcpNames.length > 0,
  `at least one legacy 'mcp'-suffixed compatibility alias is present: ${legacyMcpNames.join(", ")}`
);
for (const n of ["tabs_context_mcp", "tabs_create_mcp", "tabs_close_mcp"]) {
  ok(namesSet.has(n), `legacy alias '${n}' present in the registry`);
}

// Screenshot-producing operations declare image output, so screenshots
// survive migration as real image content blocks, not flattened to text.
ok(
  handlerProducesImage("computer"),
  "computer handler declares MCP image content (screenshot/zoom/scroll actions)"
);
ok(
  handlerProducesImage("upload_image") === false,
  "upload_image handler does not itself emit image content (it consumes a previously captured screenshot — baseline fact, not a defect)"
);
// openspec/changes/implement-stubbed-browser-tools implemented the three
// operations the snapshot used to record as stubs. The assertions below pin
// the real contracts; the "no registered-but-inert operation" check after
// them is what fails loudly if any baseline operation is ever re-stubbed.
ok(
  handlerIsStub("gif_creator") === false,
  "gif_creator is a real implementation (returns GIF image data, not a placeholder)"
);
ok(
  handlerProducesImage("gif_creator") === true,
  "gif_creator handler declares MCP image content (the exported GIF)"
);
ok(
  handlerIsStub("shortcuts_list") === false && handlerIsStub("shortcuts_execute") === false,
  "shortcuts_list/shortcuts_execute are real implementations (backed by the companion's workflow registry)"
);
for (const name of DESIGN_DOC_TOOL_LIST) {
  if (removedNames.has(name) || !liveNames.includes(name)) continue;
  ok(
    handlerIsStub(name) === false,
    `baseline operation '${name}' performs its contracted effect (registered-but-inert operations fail here)`
  );
}

// get_config/set_config expose browser configuration keys only — never a
// provider-credential key (ANTHROPIC_API_KEY, base URL, bearer token, etc).
const configSchemaSource = extractConstObjectSource("CONFIG_SCHEMA");
const configKeys = topLevelKeys(configSchemaSource);
ok(configKeys.length > 0, `CONFIG_SCHEMA declares recognized settings: ${configKeys.join(", ")}`);
const CREDENTIAL_LOOKING_KEY = /key|token|secret|credential|password|bearer|anthropic|auth\b/i;
const suspiciousKeys = configKeys.filter((k) => CREDENTIAL_LOOKING_KEY.test(k));
ok(
  suspiciousKeys.length === 0,
  suspiciousKeys.length === 0
    ? "no provider-credential-shaped key is reachable through get_config/set_config"
    : `DISCREPANCY: get_config/set_config expose credential-shaped key(s): ${suspiciousKeys.join(", ")}`
);

// =============================================================================

console.log(fail === 0 ? "\nALL REGISTRY BASELINE TESTS PASSED" : `\n${fail} FAILED`);
process.exit(fail ? 1 : 0);
