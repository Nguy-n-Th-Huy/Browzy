// Independent observer over web content a tool returned to the agent.
//
// design.md decision 5 ("The injection probe is an independent observer, not
// a filter"): this module never redacts, rewrites, or withholds anything —
// it only reports what it saw. Two reasons the design gives: withholding
// would break the reading guarantees the runtime already makes, and a probe
// that alters content destroys the ability to compare what the model saw
// against what it did, which is the point of an independent observer.
//
// Matched text is returned as plain data fields (never spliced into a
// template string) so it can travel as quoted data everywhere it goes,
// including into the transcript (tasks.md 5.3) — see host/agent/threat/
// observe.js, which is the only caller that turns a finding into a
// `run.emit(...)` event, and does so with the same discipline.
//
// A probe failure (an unexpected exception while scanning one piece of
// content) is reported distinguishably from "scanned, found nothing" so the
// two are never confused (tasks.md 5.4); either way the content itself is
// never touched by this module — it only reads `result`, never returns a
// modified copy of it.

// The tools whose returned content is web/page content the agent reads and
// could act on: extracted article text, an accessibility tree, `find`'s
// element listing, a page-declared WebMCP tool's own name/description/
// result (explicitly documented in host/tool-definitions.js as untrusted,
// page-supplied content), and a browser_batch's aggregate result — the
// batch tool is what actually returns nested page content to the agent, so
// it is "the tool that returned it" for any get_page_text/read_page/find/
// webmcp_call_tool item run inside one.
export const PROBE_TOOL_NAMES = Object.freeze(
  new Set(["get_page_text", "read_page", "find", "webmcp_list_tools", "webmcp_call_tool", "browser_batch"])
);

// Bound how much of one content block is scanned so a very large page read
// (read_page's default 50000-char ceiling, or a large get_page_text capture)
// costs a bounded amount of work. Best-effort: content beyond this point is
// still delivered to the agent unchanged — only the probe's own view is
// capped.
const MAX_SCAN_CHARS = 200_000;

// Cap findings per single content block so a pathological page (the same
// phrase repeated thousands of times) cannot turn one tool result into an
// unbounded number of emitted events.
const MAX_FINDINGS_PER_SEGMENT = 25;

// Heuristic patterns for text that attempts to instruct an AI agent. This is
// a second, independent observation alongside the model's own instructed
// behavior (design.md "Non-Goals": "No model-side injection defense") — it
// is expected to have both false positives and false negatives, which is
// exactly why a finding only ever warns (tasks.md 5.5) rather than deciding
// anything. Every regex is global (for repeated matches within one block)
// and uses only bounded quantifiers to stay clear of catastrophic
// backtracking on adversarial input.
const INJECTION_PATTERNS = Object.freeze([
  {
    id: "ignore_prior_instructions",
    regex: /\bignore\s+(?:all\s+)?(?:the\s+)?(?:previous|prior|above|earlier)\s+instructions?\b/gi
  },
  {
    id: "disregard_instructions",
    regex: /\bdisregard\s+(?:your|the)\s+(?:previous\s+)?(?:instructions|system\s+prompt|guidelines|rules)\b/gi
  },
  {
    id: "new_instructions_for_agent",
    regex: /\b(?:new|updated|additional)\s+instructions?\s+(?:for|to)\s+(?:the\s+)?(?:ai|assistant|agent|model|llm|chatbot)\b/gi
  },
  {
    id: "direct_address_to_agent",
    regex: /\b(?:dear|attention|hey|note\s+to)\s+(?:ai|assistant|agent|claude|chatgpt|language\s+model|llm)\b[,:]?/gi
  },
  {
    id: "role_override",
    regex: /\byou\s+are\s+now\s+(?:a|an)\s+[a-z][a-z\s-]{0,60}\b/gi
  },
  {
    id: "imperative_directive_to_agent",
    regex: /\b(?:assistant|ai\s+agent|language\s+model)[,:]\s+(?:please\s+)?(?:do|execute|run|click|navigate|submit|approve|ignore|type|send)\b/gi
  },
  {
    id: "hidden_comment_directive",
    regex: /<!--\s*(?:ai|assistant|agent|claude|system)\b[\s\S]{0,120}?-->/gi
  },
  {
    id: "exfiltration_directive",
    regex: /\b(?:send|email|post|forward)\s+(?:this|the|all)\s+(?:data|information|contents?|conversation|credentials?)\s+to\b/gi
  },
  {
    id: "system_prompt_claim",
    regex: /\b(?:system\s*prompt|system\s*message)\s*:\s*/gi
  }
]);

/**
 * Scan one string for injection-style patterns. Never throws for ordinary
 * string input — callers that want probe-failure semantics (tasks.md 5.4)
 * wrap this in `probeToolResult` below, which is the one place a real
 * exception (e.g. a caller passing a non-string) is turned into a
 * distinguishable "failed" status.
 *
 * @param {string} text
 * @returns {Array<{patternId: string, matchedText: string, start: number, end: number}>}
 */
export function scanTextForInjection(text) {
  if (typeof text !== "string" || text.length === 0) return [];
  const capped = text.length > MAX_SCAN_CHARS ? text.slice(0, MAX_SCAN_CHARS) : text;
  const findings = [];
  for (const { id, regex } of INJECTION_PATTERNS) {
    regex.lastIndex = 0;
    let match;
    let guard = 0;
    while ((match = regex.exec(capped)) !== null) {
      findings.push({
        patternId: id,
        matchedText: match[0],
        start: match.index,
        end: match.index + match[0].length
      });
      if (regex.lastIndex === match.index) regex.lastIndex += 1; // zero-length-match guard
      if (findings.length >= MAX_FINDINGS_PER_SEGMENT) break;
      if (++guard > 10_000) break; // defensive: never loop unbounded
    }
    if (findings.length >= MAX_FINDINGS_PER_SEGMENT) break;
  }
  return findings;
}

/**
 * Pull the text segments worth scanning out of a dispatched tool's result,
 * each tagged with WHERE in the result it came from (tasks.md 5.2's "its
 * location in the content" — the field, plus the in-text offsets
 * `scanTextForInjection` returns). Read-only: never mutates or returns a
 * modified `result`.
 *
 * @returns {Array<{field: string, text: string}>}
 */
export function extractProbeSegments(result) {
  if (!result || !Array.isArray(result.content)) return [];
  const segments = [];
  result.content.forEach((block, idx) => {
    if (block && block.type === "text" && typeof block.text === "string") {
      segments.push({ field: `content[${idx}].text`, text: block.text });
    }
  });
  return segments;
}

/**
 * Probe one dispatched tool's result for agent-directed instructions.
 * Delivers no verdict that changes anything about `result` — the caller
 * (host/agent/threat/observe.js) always returns the original `result`
 * object to the agent regardless of what this reports (tasks.md 5.1/5.2:
 * "the content is still delivered to the agent").
 *
 * @param {object} opts
 * @param {string} opts.legacyToolName
 * @param {object} opts.result - the tool's dispatched result (unchanged)
 * @param {number|null} [opts.tabId]
 * @returns {{status: "skipped"|"clean"|"finding"|"failed", findings: Array, error?: string}}
 */
export function probeToolResult({ legacyToolName, result, tabId = null }) {
  if (!PROBE_TOOL_NAMES.has(legacyToolName)) return { status: "skipped", findings: [] };
  try {
    const segments = extractProbeSegments(result);
    const findings = [];
    for (const segment of segments) {
      const matches = scanTextForInjection(segment.text);
      for (const m of matches) {
        findings.push({
          tool: legacyToolName,
          tabId,
          field: segment.field,
          patternId: m.patternId,
          matchedText: m.matchedText,
          location: { start: m.start, end: m.end }
        });
      }
    }
    return findings.length ? { status: "finding", findings } : { status: "clean", findings: [] };
  } catch (err) {
    return { status: "failed", findings: [], error: String((err && err.message) || err) };
  }
}
