// Observable, content-derived signals about what a tab appears to be for.
//
// design.md decision 6 / spec "Each tab carries a risk category derived from
// observable signals": these are heuristic, best-effort, and advisory only —
// nothing here decides whether an action proceeds (see host/agent/threat/
// observe.js and tab-risk.js, which keep this entirely out of the permission
// resolver's inputs, exactly like the injection probe).

// Each entry names a category of tab purpose that this project treats as
// higher-risk to be operating an agent against unattended (credential or
// payment-detail handling), independent of and never merged with the
// decision-affecting protected-action classifier in
// host/agent/policy/permission-modes.js — that classifier answers "does this
// exact action need a decision"; this answers "what does this tab appear to
// be for", for a warning surface only.
const KEYWORD_SIGNAL_DEFS = Object.freeze([
  {
    kind: "credential_content",
    severity: "elevated",
    label: "credential-related content observed on this tab",
    regex: /\b(?:password|passcode|passphrase|social security number|\bssn\b|two-factor|2fa\s+code|verification code)\b/i
  },
  {
    kind: "payment_content",
    severity: "elevated",
    label: "payment-related content observed on this tab",
    regex: /\b(?:credit card|debit card|card number|\bcvv\b|routing number|bank account|\biban\b|wire transfer|checkout|billing address)\b/i
  }
]);

/**
 * Derive independent, observable content signals from one piece of text a
 * tool returned. Never throws for ordinary string input.
 *
 * @param {string} text
 * @returns {Array<{kind: string, severity: "elevated", label: string, matchedText: string}>}
 */
export function deriveContentSignals(text) {
  if (typeof text !== "string" || !text) return [];
  const out = [];
  for (const def of KEYWORD_SIGNAL_DEFS) {
    const match = def.regex.exec(text);
    if (match) {
      out.push({ kind: def.kind, severity: def.severity, label: def.label, matchedText: match[0] });
    }
  }
  return out;
}
