// TaskMemoryStore — the durable half of task memory
// (openspec/changes/add-task-memory design.md decisions 2, 3, 7 and 8).
//
// One JSON file per memory under `<agent root>/memory/<host-hash>/<id>.json`.
// A memory is keyed by SITE, not conversation: the whole point is that a
// repeat of a task, in a later conversation, finds what the earlier one did.
//
// What this module guarantees, and what it deliberately does not:
//
//   - Guards REJECT, never truncate (spec "Bounded per-user storage with
//     rejecting guards"). A too-large entry, too many steps or an overlong
//     intent is refused with the bound named; nothing partial is written.
//     Shortening a request into a summary is intent.js's job, done before a
//     record ever reaches here.
//   - A memory carries no authority, and the schema makes that structural:
//     a key that reads like one (approve / remember / scope / allow / grant /
//     permission…) is rejected on write, the same discipline the workflow
//     schema applies to auto-approve fields — so a future edit cannot quietly
//     smuggle an allowance into what is only advice.
//   - Writes are atomic (temp file + rename): a crash mid-write leaves the
//     previous file or none, never a half-written memory that later reads as
//     corruption.
//   - A repeat of the same task does not pile up copies. A write whose intent
//     and step sequence both match an entry already stored for the host
//     (≥ 80 % each) REPLACES that entry — keeping its usage history, marking
//     it fresh — which is also how a stale memory is re-confirmed (spec
//     "Reinforcement, staleness and confirmation").
//   - Caps evict: at most MAX_PER_HOST per site and MAX_TOTAL overall, stale
//     entries first, then the least recently confirmed.
//   - Readers tolerate unknown keys; a corrupt file lists as invalid with its
//     reason and never fails a listing; an absent root lists as empty.
//
// This module never decides WHAT to remember (derive.js does, from recorded
// evidence only) or WHEN to recall (recall.js does); it only keeps records.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { normalizeHost } from "../skills/workflows-match.js";
import { assertSafeId, ensureDir, memoryHostDir, memoryRoot } from "../storage/paths.js";
import { MAX_INTENT_CHARS, MAX_INTENT_TOKENS, tokenOverlap } from "./intent.js";

export const TASK_MEMORY_SCHEMA_VERSION = 1;
export const MAX_MEMORY_BYTES = 64 * 1024;
export const MAX_STEPS = 40;
export const MAX_PER_HOST = 20;
export const MAX_TOTAL = 400;
/** Both the intent overlap and the step-sequence similarity a new memory must
 *  reach against a stored one for the new one to REPLACE it. */
export const SUPERSEDE_THRESHOLD = 0.8;

export const MEMORY_STATES = Object.freeze({ FRESH: "fresh", STALE: "stale" });

const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const MAX_URL_CHARS = 2048;
const MAX_REASON_CHARS = 300;
const MAX_HOST_CHARS = 253;
// Keys that would read as authority if a memory ever carried them. Matched on
// the record's own structural keys (top level, intent, outcome, provenance,
// stats, and each step's own keys) — not inside a step's recorded tool
// arguments, which are the tool's vocabulary, not the memory's.
const AUTHORITY_KEY_PATTERN =
  /^(approve|approved|approval|approvals|autoapprove|remember|remembered|scope|scopes|allow|allowed|allowance|grant|grants|granted|permission|permissions|authorize|authorized|authorization)$/i;

export class TaskMemoryError extends Error {
  /**
   * @param {string} reason - a stable machine-readable reason
   * @param {string} message
   */
  constructor(reason, message) {
    super(message);
    this.name = "TaskMemoryError";
    this.reason = reason;
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

/** The path segment for a host: a stable hash, never the host itself. */
export function hostHash(host) {
  const normalized = normalizeHost(host);
  if (!normalized) throw new TaskMemoryError("invalid_host", `invalid host: ${JSON.stringify(host)}`);
  return crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 32);
}

/** A host-minted memory id — never taken from a caller or a model. */
export function newMemoryId(now = Date.now()) {
  return `mem_${Math.floor(now).toString(36)}_${crypto.randomBytes(5).toString("hex")}`;
}

function rejectAuthorityKeys(object, where) {
  if (!isPlainObject(object)) return;
  for (const key of Object.keys(object)) {
    if (AUTHORITY_KEY_PATTERN.test(key)) {
      throw new TaskMemoryError("authority_key", `a task memory cannot carry an authority key: "${where}${key}"`);
    }
  }
}

/**
 * Validate one record's shape and bounds. Throws TaskMemoryError naming the
 * first violation; returns the record untouched when it is valid.
 *
 * @param {object} record
 * @returns {object}
 */
export function validateMemoryRecord(record) {
  const fail = (reason, message) => {
    throw new TaskMemoryError(reason, message);
  };
  if (!isPlainObject(record)) fail("invalid_record", "a task memory must be a JSON object");
  rejectAuthorityKeys(record, "");
  if (record.schemaVersion !== TASK_MEMORY_SCHEMA_VERSION) {
    fail("unsupported_schema", `unsupported task memory schema version: ${JSON.stringify(record.schemaVersion)}`);
  }
  try {
    assertSafeId(record.id, "memory id");
  } catch (err) {
    fail("invalid_id", err.message);
  }
  if (typeof record.host !== "string" || !normalizeHost(record.host) || record.host.length > MAX_HOST_CHARS) {
    fail("invalid_host", "a task memory needs its site host");
  }

  const intent = record.intent;
  if (!isPlainObject(intent)) fail("invalid_intent", "a task memory needs an intent object");
  rejectAuthorityKeys(intent, "intent.");
  if (intent.text !== null && typeof intent.text !== "string") fail("invalid_intent", "intent.text must be a string or null");
  if (typeof intent.text === "string" && intent.text.length > MAX_INTENT_CHARS) {
    fail("intent_too_long", `intent.text is ${intent.text.length} characters; the bound is ${MAX_INTENT_CHARS}`);
  }
  if (!Array.isArray(intent.tokens) || intent.tokens.some((token) => typeof token !== "string" || !token)) {
    fail("invalid_intent", "intent.tokens must be an array of non-empty strings");
  }
  if (intent.tokens.length > MAX_INTENT_TOKENS) {
    fail("intent_too_long", `intent.tokens has ${intent.tokens.length} tokens; the bound is ${MAX_INTENT_TOKENS}`);
  }

  if (record.startUrl !== null && record.startUrl !== undefined) {
    if (typeof record.startUrl !== "string" || !/^https?:\/\//i.test(record.startUrl) || record.startUrl.length > MAX_URL_CHARS) {
      fail("invalid_start_url", "startUrl must be an http(s) URL within its bound, or null");
    }
  }

  if (!Array.isArray(record.steps) || !record.steps.length) fail("no_steps", "a task memory needs at least one step");
  if (record.steps.length > MAX_STEPS) {
    fail("too_many_steps", `the memory has ${record.steps.length} steps; the bound is ${MAX_STEPS}`);
  }
  record.steps.forEach((step, index) => {
    const where = `steps[${index}]`;
    if (!isPlainObject(step)) fail("invalid_step", `${where} is not an object`);
    rejectAuthorityKeys(step, `${where}.`);
    if (!Number.isInteger(step.index) || step.index < 1) fail("invalid_step", `${where}.index must be a positive integer`);
    if (typeof step.tool !== "string" || !TOOL_NAME_PATTERN.test(step.tool)) fail("invalid_step", `${where}.tool is not a tool name`);
    if (step.action !== undefined && (typeof step.action !== "string" || step.action.length > 40)) {
      fail("invalid_step", `${where}.action must be a short string`);
    }
    if (step.omitted === true) {
      if (typeof step.reason !== "string" || !step.reason || step.reason.length > MAX_REASON_CHARS) {
        fail("invalid_step", `${where} is omitted but its reason is missing or too long`);
      }
    } else if (!isPlainObject(step.args)) {
      fail("invalid_step", `${where}.args must be an object`);
    }
    if (step.target !== undefined) {
      const target = step.target;
      if (!isPlainObject(target) || typeof target.name !== "string" || !target.name || target.name.length > 200) {
        fail("invalid_step", `${where}.target must carry a name of 1-200 characters`);
      }
      if (target.role !== undefined && (typeof target.role !== "string" || target.role.length > 40)) {
        fail("invalid_step", `${where}.target.role must be a short string`);
      }
    }
    if (step.host !== null && step.host !== undefined && (typeof step.host !== "string" || step.host.length > MAX_HOST_CHARS)) {
      fail("invalid_step", `${where}.host must be a host string or null`);
    }
  });

  const outcome = record.outcome;
  if (!isPlainObject(outcome) || outcome.status !== "completed") fail("invalid_outcome", "a task memory records a completed run only");
  rejectAuthorityKeys(outcome, "outcome.");
  if (!Number.isInteger(outcome.actionCount) || outcome.actionCount < 0) fail("invalid_outcome", "outcome.actionCount must be a count");
  if (outcome.durationMs !== null && !(Number.isInteger(outcome.durationMs) && outcome.durationMs >= 0)) {
    fail("invalid_outcome", "outcome.durationMs must be a non-negative integer or null");
  }

  const provenance = record.provenance;
  if (!isPlainObject(provenance)) fail("invalid_provenance", "a task memory needs its provenance");
  rejectAuthorityKeys(provenance, "provenance.");
  try {
    assertSafeId(provenance.conversationId, "provenance.conversationId");
  } catch (err) {
    fail("invalid_provenance", err.message);
  }
  if (typeof provenance.runId !== "string" || !provenance.runId) fail("invalid_provenance", "provenance.runId is required");
  if (!isFiniteNumber(provenance.completedAt)) fail("invalid_provenance", "provenance.completedAt must be a timestamp");
  if (!Number.isInteger(provenance.deriveVersion)) fail("invalid_provenance", "provenance.deriveVersion must be an integer");

  const stats = record.stats;
  if (!isPlainObject(stats)) fail("invalid_stats", "a task memory needs its usage statistics");
  rejectAuthorityKeys(stats, "stats.");
  if (!Number.isInteger(stats.useCount) || stats.useCount < 0) fail("invalid_stats", "stats.useCount must be a count");
  if (stats.lastUsedAt !== null && !isFiniteNumber(stats.lastUsedAt)) fail("invalid_stats", "stats.lastUsedAt must be a timestamp or null");
  if (!isFiniteNumber(stats.lastConfirmedAt)) fail("invalid_stats", "stats.lastConfirmedAt must be a timestamp");
  if (stats.state !== MEMORY_STATES.FRESH && stats.state !== MEMORY_STATES.STALE) fail("invalid_stats", "stats.state must be fresh or stale");

  const bytes = Buffer.byteLength(JSON.stringify(record), "utf8");
  if (bytes > MAX_MEMORY_BYTES) fail("too_large", `the memory is ${bytes} bytes; the bound is ${MAX_MEMORY_BYTES}`);
  return record;
}

/** Similarity of two step sequences by tool (+action): LCS / longer length. */
export function stepSequenceSimilarity(a, b) {
  const seq = (steps) => (Array.isArray(steps) ? steps.map((step) => `${step?.tool ?? ""}:${step?.action ?? ""}`) : []);
  const x = seq(a);
  const y = seq(b);
  if (!x.length || !y.length) return 0;
  const dp = Array.from({ length: x.length + 1 }, () => new Array(y.length + 1).fill(0));
  for (let i = 1; i <= x.length; i += 1) {
    for (let j = 1; j <= y.length; j += 1) {
      dp[i][j] = x[i - 1] === y[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp[x.length][y.length] / Math.max(x.length, y.length);
}

/** Eviction order: stale before fresh, then the least recently confirmed. */
function evictionOrder(a, b) {
  const staleA = a.stats.state === MEMORY_STATES.STALE ? 0 : 1;
  const staleB = b.stats.state === MEMORY_STATES.STALE ? 0 : 1;
  if (staleA !== staleB) return staleA - staleB;
  if (a.stats.lastConfirmedAt !== b.stats.lastConfirmedAt) return a.stats.lastConfirmedAt - b.stats.lastConfirmedAt;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Listing order: most recently confirmed first. */
function recencyOrder(a, b) {
  if (a.stats.lastConfirmedAt !== b.stats.lastConfirmedAt) return b.stats.lastConfirmedAt - a.stats.lastConfirmedAt;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export class TaskMemoryStore {
  /**
   * @param {{ now?: () => number, limits?: { maxPerHost?: number, maxTotal?: number } }} [opts]
   */
  constructor({ now = Date.now, limits = {} } = {}) {
    this._now = now;
    this.maxPerHost = Number.isInteger(limits.maxPerHost) ? limits.maxPerHost : MAX_PER_HOST;
    this.maxTotal = Number.isInteger(limits.maxTotal) ? limits.maxTotal : MAX_TOTAL;
  }

  // --- reading ------------------------------------------------------------

  _readFile(filePath) {
    let text;
    try {
      text = fs.readFileSync(filePath, "utf8");
    } catch (err) {
      return { ok: false, file: filePath, reason: `unreadable: ${err.code || err.message}` };
    }
    let record;
    try {
      record = JSON.parse(text);
    } catch {
      return { ok: false, file: filePath, reason: "invalid JSON" };
    }
    try {
      validateMemoryRecord(record);
    } catch (err) {
      return { ok: false, file: filePath, reason: err.message };
    }
    return { ok: true, file: filePath, bytes: Buffer.byteLength(text, "utf8"), memory: record };
  }

  _hostDirs() {
    let names;
    try {
      names = fs.readdirSync(memoryRoot(), { withFileTypes: true });
    } catch {
      return [];
    }
    return names.filter((entry) => entry.isDirectory()).map((entry) => path.join(memoryRoot(), entry.name));
  }

  _entriesIn(dir) {
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch {
      return [];
    }
    return names.filter((name) => name.endsWith(".json")).map((name) => this._readFile(path.join(dir, name)));
  }

  /**
   * Every entry stored for one site — valid ones newest-confirmed first, then
   * invalid ones with their reason.
   *
   * @param {string} host
   * @returns {Array<{ok: true, memory: object, file: string, bytes: number} | {ok: false, file: string, reason: string}>}
   */
  listForHost(host) {
    let dir;
    try {
      dir = memoryHostDir(hostHash(host));
    } catch {
      return [];
    }
    return this._sortEntries(this._entriesIn(dir));
  }

  /** Every entry for every site, in the same order as listForHost(). */
  listAll() {
    return this._sortEntries(this._hostDirs().flatMap((dir) => this._entriesIn(dir)));
  }

  _sortEntries(entries) {
    const valid = entries.filter((entry) => entry.ok).sort((a, b) => recencyOrder(a.memory, b.memory));
    const invalid = entries.filter((entry) => !entry.ok);
    return [...valid, ...invalid];
  }

  /** The fresh, valid memories for one site — what recall may offer. */
  freshForHost(host) {
    return this.listForHost(host)
      .filter((entry) => entry.ok && entry.memory.stats.state === MEMORY_STATES.FRESH)
      .map((entry) => entry.memory);
  }

  _locate(id) {
    try {
      assertSafeId(id, "memory id");
    } catch {
      return null;
    }
    for (const dir of this._hostDirs()) {
      const filePath = path.join(dir, `${id}.json`);
      if (fs.existsSync(filePath)) return filePath;
    }
    return null;
  }

  /** One memory by id, or null when absent or unreadable. */
  get(id) {
    const filePath = this._locate(id);
    if (!filePath) return null;
    const entry = this._readFile(filePath);
    return entry.ok ? entry.memory : null;
  }

  // --- writing ------------------------------------------------------------

  _writeAtomic(record) {
    validateMemoryRecord(record);
    const dir = memoryHostDir(hostHash(record.host));
    ensureDir(memoryRoot());
    ensureDir(dir);
    const filePath = path.join(dir, `${record.id}.json`);
    const tmp = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(record, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, filePath);
    } catch (err) {
      try {
        fs.rmSync(tmp, { force: true });
      } catch {}
      throw new TaskMemoryError("write_failed", `could not write the task memory: ${err.code || err.message}`);
    }
    return filePath;
  }

  /**
   * Store one derived memory. Replaces a stored entry for the same site whose
   * intent and step sequence both match at least SUPERSEDE_THRESHOLD (keeping
   * its usage history and marking it fresh), then enforces the caps.
   *
   * @param {object} record - a record as derive.js produces it
   * @returns {{ memory: object, replacedId: string|null, evicted: string[] }}
   */
  write(record) {
    validateMemoryRecord(record);
    const host = normalizeHost(record.host);
    const stored = this.listForHost(host).filter((entry) => entry.ok).map((entry) => entry.memory);
    const match = stored.find(
      (memory) =>
        memory.id !== record.id &&
        tokenOverlap(memory.intent.tokens, record.intent.tokens) >= SUPERSEDE_THRESHOLD &&
        stepSequenceSimilarity(memory.steps, record.steps) >= SUPERSEDE_THRESHOLD
    );
    let next = { ...record, host };
    if (match) {
      next = {
        ...next,
        id: match.id,
        stats: {
          useCount: match.stats.useCount,
          lastUsedAt: match.stats.lastUsedAt,
          lastConfirmedAt: record.stats.lastConfirmedAt,
          state: MEMORY_STATES.FRESH
        }
      };
    }
    this._writeAtomic(next);
    const evicted = this._enforceCaps(host, next.id);
    return { memory: next, replacedId: match ? match.id : null, evicted };
  }

  _enforceCaps(host, keepId) {
    const evicted = [];
    const removeFile = (memory) => {
      const filePath = this._locate(memory.id);
      if (filePath) {
        fs.rmSync(filePath, { force: true });
        evicted.push(memory.id);
      }
    };
    const perHost = this.listForHost(host).filter((entry) => entry.ok).map((entry) => entry.memory);
    if (perHost.length > this.maxPerHost) {
      const candidates = perHost.filter((memory) => memory.id !== keepId).sort(evictionOrder);
      for (const memory of candidates.slice(0, perHost.length - this.maxPerHost)) removeFile(memory);
    }
    const all = this.listAll().filter((entry) => entry.ok).map((entry) => entry.memory);
    if (all.length > this.maxTotal) {
      const candidates = all.filter((memory) => memory.id !== keepId).sort(evictionOrder);
      for (const memory of candidates.slice(0, all.length - this.maxTotal)) removeFile(memory);
    }
    this._pruneEmptyDirs();
    return evicted;
  }

  _update(id, mutate) {
    const filePath = this._locate(id);
    if (!filePath) return null;
    const entry = this._readFile(filePath);
    if (!entry.ok) return null;
    const next = mutate(entry.memory);
    this._writeAtomic(next);
    return next;
  }

  /**
   * A run that was offered this memory has ended. `confirmed: true` (the run
   * completed) marks it fresh and confirmed now.
   */
  reinforce(id, { usedAt = this._now(), confirmed = false } = {}) {
    return this._update(id, (memory) => ({
      ...memory,
      stats: {
        ...memory.stats,
        useCount: memory.stats.useCount + 1,
        lastUsedAt: usedAt,
        ...(confirmed ? { lastConfirmedAt: usedAt, state: MEMORY_STATES.FRESH, staleReason: undefined } : {})
      }
    }));
  }

  /** A run that was offered this memory failed on its site. */
  markStale(id, reason) {
    return this._update(id, (memory) => ({
      ...memory,
      stats: {
        ...memory.stats,
        state: MEMORY_STATES.STALE,
        staleReason: String(reason || "contradicted").slice(0, MAX_REASON_CHARS)
      }
    }));
  }

  // --- forgetting ---------------------------------------------------------

  _pruneEmptyDirs() {
    for (const dir of this._hostDirs()) {
      try {
        if (!fs.readdirSync(dir).length) fs.rmdirSync(dir);
      } catch {}
    }
  }

  /** Forget one memory. @returns {boolean} whether it existed */
  forget(id) {
    const filePath = this._locate(id);
    if (!filePath) return false;
    fs.rmSync(filePath, { force: true });
    this._pruneEmptyDirs();
    return true;
  }

  /** Forget every memory for one site. @returns {number} how many */
  forgetHost(host) {
    let dir;
    try {
      dir = memoryHostDir(hostHash(host));
    } catch {
      return 0;
    }
    const count = this._entriesIn(dir).length;
    fs.rmSync(dir, { recursive: true, force: true });
    return count;
  }

  /** Forget every memory. Settings are not memories and are kept. */
  forgetAll() {
    let count = 0;
    for (const dir of this._hostDirs()) {
      count += this._entriesIn(dir).length;
      fs.rmSync(dir, { recursive: true, force: true });
    }
    return count;
  }

  /**
   * Forget every memory a conversation produced (conversation deletion).
   * Throws when a file cannot be removed, so the caller can report the
   * deletion as failed rather than claim it.
   */
  forgetByConversation(conversationId) {
    let count = 0;
    for (const dir of this._hostDirs()) {
      for (const entry of this._entriesIn(dir)) {
        if (!entry.ok || entry.memory.provenance.conversationId !== conversationId) continue;
        try {
          fs.rmSync(entry.file, { force: true });
        } catch (err) {
          throw new TaskMemoryError("forget_failed", `could not forget memory ${entry.memory.id}: ${err.code || err.message}`);
        }
        count += 1;
      }
    }
    this._pruneEmptyDirs();
    return count;
  }
}
