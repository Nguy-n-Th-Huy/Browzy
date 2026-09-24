// Recall: which stored memories a new run should be offered
// (openspec/changes/add-task-memory design.md decision 4; spec "Recall is
// deterministic and bound to the site").
//
// Pure and deterministic — no model call, no clock, no randomness: the same
// memories, host and request always produce the same candidates in the same
// order. Site-bound by EXACT normalized host: a workflow's domain pattern is
// an operator's declaration, and a memory has no operator to declare one, so
// there are no wildcards and nothing crosses sites. Stale memories are never
// offered.

import { normalizeHost } from "../skills/workflows-match.js";
import { hasRepeatCue, tokenOverlap, tokenizeIntent } from "./intent.js";
import { MEMORY_STATES } from "./store.js";

/** The intent overlap a memory must reach to be offered unprompted. */
export const RECALL_MIN_SCORE = 0.35;
/** Added to the score when the request asks to repeat earlier work. */
export const REPEAT_CUE_BONUS = 0.1;
/** At most this many memories are offered to one run. */
export const MAX_CANDIDATES = 3;

function byScoreThenRecency(a, b) {
  if (b.score !== a.score) return b.score - a.score;
  const recency = (b.memory.stats.lastConfirmedAt ?? 0) - (a.memory.stats.lastConfirmedAt ?? 0);
  if (recency) return recency;
  return a.memory.id < b.memory.id ? -1 : a.memory.id > b.memory.id ? 1 : 0;
}

/**
 * @param {object} input
 * @param {object[]} input.memories - stored memories (any site; filtered here)
 * @param {string} input.host - the run's bound page host
 * @param {string} input.request - the operator's text for this turn
 * @param {boolean} [input.explicitRepeat] - defaults to hasRepeatCue(request)
 * @returns {{ candidates: Array<{ memory: object, score: number, why: "intent_match"|"explicit_repeat" }> }}
 */
export function recallForRun({ memories, host, request, explicitRepeat } = {}) {
  const site = normalizeHost(host || "");
  if (!site) return { candidates: [] };
  const repeat = typeof explicitRepeat === "boolean" ? explicitRepeat : hasRepeatCue(request);
  const requestTokens = tokenizeIntent(request);

  const scored = (Array.isArray(memories) ? memories : [])
    .filter((memory) => memory && normalizeHost(memory.host || "") === site && memory.stats?.state === MEMORY_STATES.FRESH)
    .map((memory) => {
      const overlap = tokenOverlap(requestTokens, memory.intent?.tokens);
      return { memory, score: Math.min(1, Math.round((overlap + (repeat ? REPEAT_CUE_BONUS : 0)) * 1000) / 1000) };
    })
    .sort(byScoreThenRecency);

  const matched = scored
    .filter((entry) => entry.score >= RECALL_MIN_SCORE)
    .slice(0, MAX_CANDIDATES)
    .map((entry) => ({ ...entry, why: "intent_match" }));
  if (matched.length) return { candidates: matched };
  // "làm lại như lần trước" on a site with memories: offer the best one even
  // below the threshold — the operator said, in words, that this is a repeat.
  if (repeat && scored.length) return { candidates: [{ ...scored[0], why: "explicit_repeat" }] };
  return { candidates: [] };
}
