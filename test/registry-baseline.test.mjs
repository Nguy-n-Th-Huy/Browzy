// Table-driven BASELINE coverage for every entry in the tool registry
// (host/tool-definitions.js), captured before the Claude Agent SDK migration.
//
// Scope: openspec/changes/migrate-to-claude-agent-sdk task 6.1, BASELINE HALF
// ONLY. Design section 6 ("Regression and migration boundaries") calls for a
// "table-driven fixture suite from all 26 current registry entries" recording
// "baseline before extraction" so post-migration results can be diffed
// against it. This file IS that baseline capture.
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

const missingFromLive = DESIGN_DOC_TOOL_LIST.filter((n) => !liveNames.includes(n));
const extraInLive = liveNames.filter((n) => !DESIGN_DOC_TOOL_LIST.includes(n));

ok(TOOLS.length === 26, `live registry has exactly 26 entries (design.md's claimed count) — actual: ${TOOLS.length}`);
ok(
  missingFromLive.length === 0,
  missingFromLive.length === 0
    ? "every tool design.md lists is present in the live registry"
    : `DISCREPANCY: design.md lists tools missing from the live registry: ${missingFromLive.join(", ")}`
);
ok(
  extraInLive.length === 0,
  extraInLive.length === 0
    ? "no live tool is absent from design.md's list"
    : `DISCREPANCY: live registry has tools design.md's list omits: ${extraInLive.join(", ")}`
);

const namesSet = new Set(liveNames);
ok(namesSet.size === liveNames.length, "no duplicate tool names in the live registry");

// The registry file's own top-of-file comment ("The 25 browzy-in-chrome
// tool definitions...") is stale relative to the actual 26-entry array below
// it. host/tool-definitions.js is out of scope for this task to edit (it is
// explicitly off-limits and owned by other in-flight work), so this is
// reported here — and in reports/06-registry-baseline.md — rather than fixed.
console.log(
  "  NOTE: host/tool-definitions.js line 1 says \"The 25 ... tool definitions\"" +
  " but the TOOLS array has 26 entries. Stale comment, out of scope to edit here."
);

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
// aliases.
const legacyMcpNames = liveNames.filter((n) => n.includes("mcp"));
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
ok(
  handlerIsStub("gif_creator") === true,
  "gif_creator is currently an unimplemented stub in this build (baseline must record this truthfully, not assume real GIF export)"
);
ok(
  handlerIsStub("shortcuts_list") === true && handlerIsStub("shortcuts_execute") === true,
  "shortcuts_list/shortcuts_execute are currently unimplemented stubs in this build"
);

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
