// Report rendering for a snapshot comparison: the same comparison content in
// the two forms the capability promises — a JSON document for automation and a
// markdown document the operator can read (and, on request, keep as a card in
// the conversation through the existing document path).
//
// Both functions are pure: they take the two loaded snapshots plus the diff
// from snapshots/diff.js and return a value. Nothing here decides that a
// comparison should happen, writes a file, or knows where documents live —
// that is the tool's job (tools/page-snapshots.js) and the DocumentStore's.
//
// Section headings are the spec's own words (Added / Removed / Changed, plus
// Reordered — the diff classifies a reordered array separately from changed so
// that an array whose items merely moved is never reported as N edited fields).

import { summarizeDiff } from "./diff.js";

/** The identity a report carries for one side of the comparison. */
function identity(snapshot) {
  return {
    url: snapshot?.url ?? null,
    title: snapshot?.title ?? null,
    name: snapshot?.name ?? null,
    timestamp: snapshot?.timestamp ?? null
  };
}

/**
 * The JSON form.
 *
 * @param {object} input
 * @param {object} input.baseline - the baseline snapshot record
 * @param {object} input.current - the current snapshot record
 * @param {object} input.diff - diffFields()'s output
 * @param {string} [input.generatedAt] - ISO 8601 UTC, reporting time only
 */
export function jsonReport({ baseline, current, diff, generatedAt = null }) {
  const summary = summarizeDiff(diff);
  return {
    kind: "page_snapshot_comparison",
    generatedAt,
    baseline: identity(baseline),
    current: identity(current),
    comparison: {
      baselinePath: baseline?.path ?? null,
      currentPath: current?.path ?? null
    },
    summary,
    unchanged: summary.total === 0,
    added: diff.added,
    removed: diff.removed,
    changed: diff.changed,
    reordered: diff.reordered
  };
}

/** Render a value as an inline code span that survives backticks and newlines. */
function code(value) {
  const text = JSON.stringify(value);
  if (text === undefined) return "`undefined`";
  const longestRun = (text.match(/`+/g) || []).reduce((max, run) => Math.max(max, run.length), 0);
  const fence = "`".repeat(longestRun + 1);
  return `${fence}${text}${fence}`;
}

function sideLines(label, snapshot) {
  const identityOfSide = identity(snapshot);
  const title = identityOfSide.title ? ` — ${identityOfSide.title}` : "";
  const name = identityOfSide.name ? `"${identityOfSide.name}"` : "(unnamed)";
  return [
    `- **${label}**: ${name}${title}`,
    `  - URL: ${identityOfSide.url ?? "(unknown)"}`,
    `  - Captured: ${identityOfSide.timestamp ?? "(unknown)"}`
  ].join("\n");
}

/**
 * The markdown form: both sides' identity and capture times, the summary
 * counts, then one section per difference kind. When nothing differs it says
 * so outright — an empty report must never read like a failed comparison.
 *
 * @param {object} input - same as jsonReport()
 * @returns {string} markdown, ready to hand to DocumentStore
 */
export function markdownReport({ baseline, current, diff, generatedAt = null }) {
  const summary = summarizeDiff(diff);
  const lines = [
    "# Page snapshot comparison",
    "",
    sideLines("Baseline", baseline),
    sideLines("Current", current),
    generatedAt ? `- **Report generated**: ${generatedAt}` : null,
    "",
    "## Summary",
    "",
    summary.total === 0
      ? "No changes detected — both captures carry identical field data."
      : `**${summary.total}** difference${summary.total === 1 ? "" : "s"}: ` +
        `${summary.added} added, ${summary.removed} removed, ${summary.changed} changed, ${summary.reordered} reordered.`,
    ""
  ].filter((line) => line !== null);

  if (summary.added) {
    lines.push("## Added", "");
    for (const entry of diff.added) lines.push(`- \`${entry.path}\` = ${code(entry.value)}`);
    lines.push("");
  }
  if (summary.removed) {
    lines.push("## Removed", "");
    for (const entry of diff.removed) lines.push(`- \`${entry.path}\` — last known value ${code(entry.value)}`);
    lines.push("");
  }
  if (summary.changed) {
    lines.push("## Changed", "");
    for (const entry of diff.changed) {
      const migration = entry.typeChanged ? ` (type changed: ${entry.oldType} → ${entry.newType})` : "";
      lines.push(`- \`${entry.path}\`: ${code(entry.old)} → ${code(entry.new)}${migration}`);
    }
    lines.push("");
  }
  if (summary.reordered) {
    lines.push("## Reordered", "");
    for (const entry of diff.reordered) {
      lines.push(`- \`${entry.path}\`: same items in a different order`);
      for (const item of entry.items) {
        lines.push(`  - ${code(item.value)} moved from index ${item.from} to ${item.to}`);
      }
    }
    lines.push("");
  }

  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}
