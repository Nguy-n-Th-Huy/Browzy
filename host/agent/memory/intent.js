// The intent half of task memory (openspec/changes/add-task-memory design.md
// decisions 2 and 4): how an operator's request becomes the bounded summary a
// memory stores and the token bag recall compares.
//
// Deliberately plain and deterministic — no model call, no stemming library,
// no embedding: recall must give the same answer for the same inputs every
// time (spec "Recall is deterministic and bound to the site"), and a miss is
// cheap (the run explores as it always did) while a false match is bounded.
//
// Vietnamese is written in syllables and its diacritics carry meaning
// ("bàn" and "bán" are different words), so tokens keep their diacritics;
// only case and punctuation are folded. Whether folding diacritics would
// catch more unaccented requests is an open question the design records —
// task-memory-recall.test.mjs measures it rather than assuming it.

/** Longest intent summary a memory stores (spec "Memory record shape"). */
export const MAX_INTENT_CHARS = 200;
/** Largest token bag a memory stores. */
export const MAX_INTENT_TOKENS = 32;

// Words that say nothing about WHICH task was asked for: grammar, politeness,
// pronouns, and the repeat cues themselves (a repeat cue says "same as
// before", which recall reads separately through hasRepeatCue()).
const STOPWORDS = new Set([
  // Vietnamese
  "và", "của", "cho", "các", "những", "trên", "này", "đó", "là", "có", "được", "với", "từ", "một", "thì", "mà",
  "giúp", "mình", "tôi", "tớ", "hãy", "nhé", "nha", "ạ", "đi", "vào", "ra", "lên", "xuống", "bạn", "anh", "chị", "em",
  "cái", "các", "đã", "sẽ", "đang", "rồi", "cũng", "nữa", "thêm", "xem", "để", "khi", "nào", "gì", "hộ", "dùm", "giùm",
  "làm", "lại", "lần", "trước", "như", "giống", "hôm", "qua", "nãy", "vừa", "cũ",
  // English
  "the", "a", "an", "to", "of", "on", "in", "for", "and", "or", "with", "from", "this", "that", "is", "are", "be",
  "please", "me", "my", "i", "you", "it", "do", "again", "same", "last", "time", "like", "before", "previous"
]);

// Phrases that mean "do what you did last time". Matched on the normalized
// request (lowercase, single spaces), whole-phrase.
const REPEAT_CUES = [
  "làm lại",
  "như lần trước",
  "giống lần trước",
  "như hôm qua",
  "giống hôm qua",
  "như lần trước đó",
  "lặp lại",
  "chạy lại",
  "again",
  "same as last time",
  "like last time",
  "as before",
  "do it again"
];

function normalizeText(text) {
  return String(text ?? "")
    .normalize("NFC")
    .toLocaleLowerCase("vi")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The operator's request as a bounded one-line summary. Whitespace collapsed,
 * cut at the last word boundary before MAX_INTENT_CHARS with an ellipsis —
 * the store itself REJECTS anything longer, so this is the only place a
 * request is shortened, and it is shortened as a summary, never silently.
 *
 * @param {string} request
 * @returns {string|null} null for an empty request
 */
export function summarizeIntent(request) {
  const text = String(request ?? "").normalize("NFC").replace(/\s+/g, " ").trim();
  if (!text) return null;
  if (text.length <= MAX_INTENT_CHARS) return text;
  const room = MAX_INTENT_CHARS - 1; // the ellipsis
  const cut = text.slice(0, room);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > room * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/**
 * The request as a deduplicated bag of content tokens, in first-seen order.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function tokenizeIntent(text) {
  const out = [];
  const seen = new Set();
  for (const raw of normalizeText(text).split(/[^\p{L}\p{N}]+/u)) {
    if (!raw || raw.length < 2 || STOPWORDS.has(raw)) continue;
    if (seen.has(raw)) continue;
    seen.add(raw);
    out.push(raw);
    if (out.length >= MAX_INTENT_TOKENS) break;
  }
  return out;
}

/** True when the request asks, in so many words, to repeat earlier work. */
export function hasRepeatCue(text) {
  const normalized = ` ${normalizeText(text).replace(/[^\p{L}\p{N} ]+/gu, " ").replace(/\s+/g, " ")} `;
  return REPEAT_CUES.some((cue) => normalized.includes(` ${cue} `));
}

/** Jaccard similarity of two token bags (0 when either is empty). */
export function tokenOverlap(a, b) {
  const left = new Set(Array.isArray(a) ? a : []);
  const right = new Set(Array.isArray(b) ? b : []);
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;
  return shared / (left.size + right.size - shared);
}
