// Wires the injection probe and the per-tab risk category into one call per
// dispatched tool result. The single entry point host/agent/tools/adapter.js
// calls, right after a tool result comes back from the browser and before
// that result is returned to the agent (tasks.md 5.1: "before that content
// is available for the agent to act on").
//
// Advisory only, end to end (design.md decisions 5 and 6): this module never
// returns a modified result, never throws past its own boundary, and never
// touches anything the permission resolver reads. It only calls `run.emit`
// (the same run-event channel `approval_request`/`run_error`/`tool_rejected`
// already use — see host/agent/session/run.js's `emit()` and companion.js's
// forwarding of every `run.emit` call as a sequenced `stream_event`, which is
// also what appends it to the durable per-conversation transcript).
//
// Matched injected text is carried here as a plain object field
// (`matchedText`) on every event — never interpolated into a template
// string — so it stays quoted data both in the emitted event and in the
// transcript it is appended to (tasks.md 5.3).

import { THREAT_EVENT_TYPES } from "../protocol.js";
import { PROBE_TOOL_NAMES, probeToolResult, extractProbeSegments } from "./injection-probe.js";
import { deriveContentSignals } from "./content-signals.js";

function extractTabId(legacyToolName, args) {
  if (legacyToolName === "browser_batch") {
    const actions = Array.isArray(args?.actions) ? args.actions : [];
    const first = actions.find((a) => typeof a?.input?.tabId === "number");
    return first ? first.input.tabId : null;
  }
  return typeof args?.tabId === "number" ? args.tabId : null;
}

// get_page_text's handler prefixes its extracted text with a small header
// (extension/background.js's get_page_text: "Title: ...\nURL: ...\n...") —
// design.md 5b's "Extraction returns source URL/title". Reused here,
// read-only, purely to learn the tab's current URL for document-identity
// purposes; never parsed for anything else and never fed back to the agent.
function extractUrlFromHeader(text) {
  if (typeof text !== "string") return null;
  const match = /^URL:\s*(.+)$/m.exec(text);
  return match ? match[1].trim() : null;
}

function emitTabRiskIfChanged(run, tabId, changed, state) {
  if (!changed) return;
  run.emit({
    type: THREAT_EVENT_TYPES.TAB_RISK_UPDATE,
    tabId,
    category: state.category,
    signals: state.signals
  });
}

/**
 * Observe one dispatched tool's result. Called for EVERY tool (not only the
 * content-returning ones) so `navigate` can reset a tab's document identity
 * even though `navigate` itself returns no page content to probe.
 *
 * @param {object} opts
 * @param {import("../session/run.js").Run} opts.run
 * @param {string} opts.legacyToolName
 * @param {object} opts.args - coerced tool arguments
 * @param {object} opts.result - the dispatched result, returned to the agent
 *   UNCHANGED regardless of anything this function does (tasks.md 5.2).
 * @param {import("./tab-risk.js").TabRiskRegistry} opts.tabRiskRegistry
 */
export function observeToolResult({ run, legacyToolName, args, result, tabRiskRegistry }) {
  if (!run || !tabRiskRegistry) return;
  const tabId = extractTabId(legacyToolName, args);

  // `navigate` is the one explicit, unambiguous document-identity reset
  // point available at this layer (design.md decision 6) — always applied,
  // even for a tool this module otherwise never probes.
  if (legacyToolName === "navigate" && tabId != null) {
    const targetUrl = typeof args?.url === "string" ? args.url : null;
    const { changed, state } = tabRiskRegistry.observeDocument(tabId, targetUrl, { forceReset: true });
    emitTabRiskIfChanged(run, tabId, changed, state);
  }

  if (!PROBE_TOOL_NAMES.has(legacyToolName) || tabId == null) return;

  // `probeToolResult` does its own extraction internally, inside its own
  // try/catch, so this is the ONE place an unexpected content shape (tasks.md
  // 5.4 — a probe that "cannot complete for a piece of returned content")
  // is turned into a distinguishable failure event rather than an uncaught
  // exception. When it fails, there is nothing safe left to re-extract for
  // the URL/content-signal steps below either, so this returns early —
  // `result` itself was never touched and is still returned to the agent by
  // the caller (host/agent/tools/adapter.js) regardless.
  const probe = probeToolResult({ legacyToolName, result, tabId });
  if (probe.status === "failed") {
    run.emit({ type: THREAT_EVENT_TYPES.INJECTION_PROBE_FAILED, tool: legacyToolName, tabId, error: probe.error });
    return;
  }

  // Extraction just succeeded once inside probeToolResult above, so this is
  // not expected to throw; nothing else here depends on it not throwing
  // (the content-signal loop below only ever runs on real page content).
  const segments = extractProbeSegments(result);

  // Passive document-identity refresh: get_page_text reports the tab's
  // current URL in its own header, which lets an in-page navigation the
  // agent made by clicking a link (never through the `navigate` tool) still
  // reset a stale category instead of carrying it forward onto a different
  // document (tasks.md 6.2's "do not carry the previous document's category
  // forward").
  if (legacyToolName === "get_page_text") {
    for (const segment of segments) {
      const url = extractUrlFromHeader(segment.text);
      if (url) {
        const { changed, state } = tabRiskRegistry.observeDocument(tabId, url);
        emitTabRiskIfChanged(run, tabId, changed, state);
        break;
      }
    }
  }

  if (probe.status === "finding") {
    for (const finding of probe.findings) {
      run.emit({
        type: THREAT_EVENT_TYPES.INJECTION_FINDING,
        tool: finding.tool,
        tabId: finding.tabId,
        field: finding.field,
        patternId: finding.patternId,
        matchedText: finding.matchedText,
        location: finding.location
      });
      // tasks.md 6.4: an injection finding is listed among the contributing
      // signals for the tab it came from, and raises that tab's category.
      const { changed, state } = tabRiskRegistry.recordSignal(tabId, {
        kind: "injection_finding",
        severity: "elevated",
        label: "possible agent-directed instruction found in page content",
        patternId: finding.patternId,
        matchedText: finding.matchedText,
        tool: finding.tool
      });
      emitTabRiskIfChanged(run, tabId, changed, state);
    }
  }

  // Content-derived risk signals (credential/payment-related content) are
  // independent of the injection outcome above — a clean probe can still
  // carry a payment-page signal, and vice versa. Every reviewed segment with
  // no elevated match still records a low-severity "reviewed" signal so a
  // page that was actually read reads as LOW rather than staying
  // UNCATEGORIZED forever (spec: uncategorized means insufficient signals,
  // not "nothing elevated found").
  for (const segment of segments) {
    const signals = deriveContentSignals(segment.text);
    if (signals.length === 0) {
      const { changed, state } = tabRiskRegistry.recordSignal(tabId, {
        kind: "content_reviewed",
        severity: "low",
        label: "page content reviewed; no elevated signal found",
        tool: legacyToolName
      });
      emitTabRiskIfChanged(run, tabId, changed, state);
      continue;
    }
    for (const signal of signals) {
      const { changed, state } = tabRiskRegistry.recordSignal(tabId, { ...signal, tool: legacyToolName });
      emitTabRiskIfChanged(run, tabId, changed, state);
    }
  }
}
