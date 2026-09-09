// Credential redaction helpers (task 4.3: "no secret in storage files, logs,
// diagnostics, exports, or command-line arguments").
//
// This module never sees a secret itself in a way that lets it "unredact" —
// it only scrubs a known secret value out of arbitrary text/objects that
// might otherwise carry it (log lines, diagnostics dumps, exported
// settings). Callers pass the exact secret(s) currently in play; this never
// guesses at a secret shape (e.g. "looks like an API key") because a guess
// can both over- and under-redact.

const MASK = "[REDACTED]";

/**
 * @param {string} text
 * @param {Iterable<string>} secrets known secret values to scrub
 * @returns {string}
 */
export function redactSecretsInText(text, secrets) {
  let out = text;
  for (const secret of secrets) {
    if (!secret) continue;
    out = out.split(secret).join(MASK);
  }
  return out;
}

/**
 * Deep-clone `value`, redacting any string field that is exactly one of
 * `secrets`, or that contains one as a substring, and additionally masking
 * any object key that looks credential-shaped (belt-and-suspenders: this
 * catches an accidentally-included raw key even if the exact value wasn't
 * passed in `secrets`, e.g. a nested provider response echoing it back).
 *
 * @param {unknown} value
 * @param {Iterable<string>} secrets
 * @returns {unknown}
 */
export function redactSecretsDeep(value, secrets) {
  const secretList = [...secrets].filter(Boolean);
  const sensitiveKeyPattern = /api[_-]?key|apikey|secret|credential|authorization|x-api-key/i;

  function walk(node, keyHint) {
    if (typeof node === "string") {
      if (keyHint && sensitiveKeyPattern.test(keyHint)) return MASK;
      return redactSecretsInText(node, secretList);
    }
    if (Array.isArray(node)) return node.map((entry) => walk(entry, keyHint));
    if (node && typeof node === "object") {
      const out = {};
      for (const [key, val] of Object.entries(node)) {
        out[key] = walk(val, key);
      }
      return out;
    }
    return node;
  }

  return walk(value, undefined);
}

export { MASK as REDACTED_MASK };
