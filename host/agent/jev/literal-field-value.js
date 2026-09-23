// Operator literal field values (openspec/changes/jev-literal-field-values).
// The idea is ported from a sibling Jev-based extension's own
// literal-field-value.ts: a deliberately small command grammar, never an NLP
// guess, that lets the runtime type an operator-supplied value byte-for-byte
// instead of asking the configured model to paraphrase it. Nothing is
// imported from that project — this is a plain-JS reimplementation against
// Browzy's own `page_snapshot` row shape.
//
// Two pure functions, no I/O:
//   - parseOperatorLiteral(prompt): reads ONLY the operator's own prompt for
//     this turn (`provider.goal`) — never plan memory, model output, prior
//     conversation turns or page text — and yields at most one literal, from
//     one of two whole-prompt forms (an assignment or a whole-prompt search).
//     Anything conditional, corrective, multi-clause or transformation-shaped
//     yields null. Called once per run, at run start, because the prompt does
//     not change within a run.
//   - literalFieldEligible(literal, element, elements): whether one observed
//     `page_snapshot` row may receive that literal — role, editability,
//     shape, sensitivity, label/search uniqueness and (for a native date
//     input) a real calendar round trip. Runs every cycle against the CURRENT
//     observation, so a field that only appears after the first plan still
//     gets the literal without a REPLAN.
//
// spec `jev-decision-layer`, "Operator literal field values".

const normalize = (value) => String(value ?? "").trim().toLocaleLowerCase();

// Conditional instructions, examples, alternatives, corrections and a negated
// verb all require interpretation the host cannot safely automate. Tested
// against the WHOLE raw prompt (including inside a quoted value) — exactly
// the reference's own over-inclusive rule, kept deliberately narrow rather
// than trying to parse "was this word part of the instruction or the value".
const CONDITIONAL_WORDS = /\b(if|unless|when|until|instead|either|example|previous|original|replace|change|except)\b/i;
const NEGATED_VERB = /\b(?:do not|don't|never)\s+(?:set|fill|type|enter)\b/i;

// Only an entire, literal search command can bind without a field label.
const SEARCH_PATTERN = /^(?:please\s+)?search\s+for\s+(?:"([^"\n]+)"|“([^”\n]+)”)\.?$/i;

// An assignment clause, once the prompt has already been reduced to exactly
// one clause: an optional "please", "set"/"fill", an optional "the", a label
// (with an optional trailing "field"), "to"/"with", then the value and an
// optional final period.
const ASSIGNMENT_PATTERN = /^(?:please\s+)?(?:set|fill)\s+(?:the\s+)?(.+?)\s+(?:to|with)\s+(.+?)\.?$/i;
const TRAILING_FIELD_WORD = /\s+field$/i;
const QUOTED_VALUE_PATTERN = /^(?:"([^"\n]*)"|“([^”\n]*)”)$/;

// Unquoted values support simple names/identifiers only: 1 to 8
// space-separated tokens of letters, digits, `_` or `-`. Punctuation,
// workflow words, transformations and references fall through to the normal
// (model-prepared) path instead.
const UNQUOTED_VALUE_PATTERN = /^[\p{L}\p{N}_-]+(?: [\p{L}\p{N}_-]+){0,7}$/u;
const RESERVED_UNQUOTED_WORDS = /\b(and|then|after|before|using|from|your|my|their|its|same|current|random|any|uppercase|lowercase|capitalized|blank|empty|nothing|whatever)\b/i;

const MIN_VALUE_CHARS = 1;
const MAX_VALUE_CHARS = 2000;

/**
 * Split a prompt into clauses on `,`, `;` and `\n`, tracking whether the walk
 * is inside a quoted value so a separator inside the quote stays part of it.
 * `"` closes with `"`; the curly open quote `“` closes with `”`.
 * Returns `null` for an unterminated quote — the one shape this walk cannot
 * safely split at all.
 *
 * @returns {string[]|null}
 */
function splitClauses(prompt) {
  const clauses = [];
  let start = 0;
  let quote = "";
  for (let i = 0; i < prompt.length; i++) {
    const char = prompt[i];
    if (quote) {
      if (char === quote) quote = "";
    } else if (char === '"' || char === "“") {
      quote = char === "“" ? "”" : char;
    } else if (char === "," || char === ";" || char === "\n") {
      clauses.push(prompt.slice(start, i).trim());
      start = i + 1;
    }
  }
  if (quote) return null;
  clauses.push(prompt.slice(start).trim());
  return clauses;
}

/**
 * Parse the operator's own prompt for this turn into at most one literal.
 * Pure: no observation, no page, no element — that is `literalFieldEligible`'s
 * job. Called once per run because `provider.goal` never changes within one.
 *
 * @param {string|undefined} prompt - `provider.goal`, and ONLY that; plan
 *   memory, model output, conversation history and page text must never reach
 *   this function as `prompt`.
 * @returns {{ kind: "assign", label: string, value: string } |
 *   { kind: "search", value: string } | null}
 */
export function parseOperatorLiteral(prompt) {
  if (typeof prompt !== "string" || !prompt) return null;
  if (CONDITIONAL_WORDS.test(prompt) || NEGATED_VERB.test(prompt)) return null;

  const trimmed = prompt.trim();
  const search = SEARCH_PATTERN.exec(trimmed);
  if (search) {
    const value = search[1] ?? search[2];
    if (value.length >= MIN_VALUE_CHARS && value.length <= MAX_VALUE_CHARS) return { kind: "search", value };
    return null;
  }

  // Never select one assignment while ignoring later instructions or context:
  // splitting on separators OUTSIDE a quoted value must leave exactly one
  // clause, or nothing is a safe single literal to bind.
  const clauses = splitClauses(prompt);
  if (!clauses || clauses.length !== 1) return null;

  const match = ASSIGNMENT_PATTERN.exec(clauses[0]);
  if (!match) return null;
  const label = normalize(match[1].replace(TRAILING_FIELD_WORD, ""));
  if (!label) return null;

  const raw = match[2];
  const quoted = QUOTED_VALUE_PATTERN.exec(raw);
  let value;
  if (quoted) {
    value = quoted[1] ?? quoted[2];
  } else {
    if (!UNQUOTED_VALUE_PATTERN.test(raw) || RESERVED_UNQUOTED_WORDS.test(raw)) return null;
    value = raw;
  }
  if (value.length < MIN_VALUE_CHARS || value.length > MAX_VALUE_CHARS) return null;
  return { kind: "assign", label, value };
}

// The three roles a literal may ever target — the same trio the reference
// restricts to, never a button, link, checkbox or generic container.
const ELIGIBLE_ROLES = new Set(["textbox", "searchbox", "combobox"]);

/**
 * Whether an ISO `YYYY-MM-DD` string is a real calendar date: the format
 * itself, plus a UTC round trip so `2026-02-30` (no such day) is refused
 * rather than silently normalized into March.
 */
function isRealIsoDate(value) {
  if (typeof value !== "string" || !/^[1-9]\d{3}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/**
 * Whether one observed `page_snapshot` element may receive `literal` —
 * host-side eligibility, evaluated fresh against the CURRENT observation
 * every cycle (design.md decision 2/3). Uses observed row facts only: no DOM
 * access, no network, no memory of a previous cycle's decision.
 *
 * @param {{kind: "assign"|"search", label?: string, value: string}|null} literal
 * @param {object} element - one row of `snapshot.elements`
 * @param {object[]} elements - ALL observed rows of the same snapshot
 *   (uniqueness is counted over every observed control, not only the
 *   editable ones — the reference's stricter rule)
 * @returns {boolean}
 */
export function literalFieldEligible(literal, element, elements) {
  if (!literal || !element || typeof element !== "object") return false;
  if (!ELIGIBLE_ROLES.has(String(element.role ?? ""))) return false;
  if (element.editable !== true) return false;
  if (element.readonly === true) return false;
  if (element.disabled === true) return false;
  // A single-line `input` element, never a textarea or a contenteditable
  // host — both can hold text no round-trippable "one literal" model fits.
  if (String(element.tag ?? "").toLowerCase() !== "input") return false;
  if (element.contenteditable === true) return false;
  // A sensitive field always uses the existing (approved) path, never a
  // prompt-derived literal.
  if (element.sensitive != null) return false;

  const all = Array.isArray(elements) ? elements : [];
  const type = String(element.type ?? "").toLowerCase();

  if (literal.kind === "search") {
    const isSearchField = String(element.role ?? "") === "searchbox" || type === "search";
    if (!isSearchField) return false;
    const searchFields = all.filter((el) => el && (String(el.role ?? "") === "searchbox" || String(el.type ?? "").toLowerCase() === "search"));
    if (searchFields.length !== 1 || searchFields[0].ref !== element.ref) return false;
  } else if (literal.kind === "assign") {
    const label = normalize(element.label);
    if (!label || label !== literal.label) return false;
    const matches = all.filter((el) => el && normalize(el.label) === label);
    if (matches.length !== 1) return false;
  } else {
    return false;
  }

  // Native date inputs have a defined ISO value format. Never guess locale,
  // relative dates, or normalize an impossible date into another month.
  if (type === "date" && !isRealIsoDate(literal.value)) return false;

  return true;
}
