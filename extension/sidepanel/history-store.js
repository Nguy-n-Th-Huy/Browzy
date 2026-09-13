// Local conversation cache + prompt echo cache for the side panel.
//
// The HOST is authoritative for which conversations exist and for their
// presentation metadata (title, hostname, pinned, archived, revision — see
// host/agent/session/manager.js's conversationSummaries()). This module is
// the browser-profile-local side of that contract:
//
//   * a versioned CACHE of host summaries, so the history list renders
//     instantly (and offline) and then reconciles against the host's
//     authoritative list (`reconcile()`);
//   * the panel's own prompt ECHO cache — the host does not persist the
//     user's prompt text, so a rebuilt transcript can only show the
//     operator's own messages from here (conversation-model.js's
//     seedLocalPrompts());
//   * retention/privacy policy for both (count/byte caps, prompt preview
//     size, TTL, archive-on-evict, raw-prompt caching toggle).
//
// STORAGE SHAPE (optimize-chat-history tasks.md 2.1). One top-level
// `chrome.storage.local` key PER CONVERSATION
// (`ocic_conversation_history_v2:<conversationId>`), never one growing list
// under a single key. Rationale, in order of importance:
//
//   1. A single list key forces every write through a read-modify-write of
//      the whole index. Two panel documents share one storage backend, so
//      that is also a lost-update race: each reads the list, mutates its own
//      row in memory, and the second `set()` clobbers the first's row with
//      its stale copy (chrome.storage has no merge/patch primitive).
//      Per-conversation keys make a write touch only the conversation that
//      actually changed.
//   2. Streaming produces updates at token-batch frequency. Those are
//      COALESCED here (in-memory Map + dirty set + one debounced flush
//      window, default 700ms) into at most one `set()` per window carrying
//      only the dirty conversations. Lifecycle facts (a brand-new
//      conversation, a delete, a run terminal, unload) flush immediately —
//      see `_scheduleFlush()`/`flush()`.
//   3. Cross-panel convergence: `chrome.storage.onChanged` keeps every
//      panel's in-memory cache in step without a full re-read, and a panel
//      never overwrites a key another panel has pending locally.
//
// MIGRATION (design.md "Migration Plan"). The previous version stored one
// array under `ocic_conversation_history_v1`. On first load that array is
// read, every entry is written under its own v2 key (prompts, createdAt and
// deletedLocally preserved), the policy/migration marker is written, and the
// legacy key is removed. An entry that cannot be resolved against the host's
// summary list is kept and marked `stale` (never silently dropped, never
// presented as a fully reopenable conversation — `reconcile()` below).

export const HISTORY_SCHEMA_VERSION = 2;
export const HISTORY_ENTRY_KEY_PREFIX = "ocic_conversation_history_v2:";
export const HISTORY_POLICY_KEY = "ocic_conversation_history_policy_v2";
const LEGACY_STORAGE_KEY = "ocic_conversation_history_v1";

// Which conversation was active when the panel last had one open, kept under
// its own key rather than folded into the index (see
// `getLastActive()`/`setLastActive()` below for why this cannot be derived
// from `list()[0]`). A separate key also means reading it at startup is one
// small get(), not a read-and-sort of the whole index.
//
// scope-conversation-restore-per-tab (design.md "Hold the remembered ids in
// session-lifetime storage, keyed by scope"): each panel scope (the tab id
// the panel booted on — see panel-controller.js's constructor and
// sidepanel.js's `boot()`) gets its OWN remembered-conversation-id entry,
// held in `chrome.storage.session` rather than `chrome.storage.local`. A tab
// id is only meaningful within the browser session that assigned it, and the
// panel's own per-tab enablement set is itself session-scoped (background.js's
// `PANEL_ENABLED_TABS_SESSION_KEY`) — sharing that lifetime is what makes it
// impossible for a numeric tab id surviving into a new session to resurrect
// an unrelated tab's conversation, which would be a worse version of the
// cross-scope leak this change fixes. The conversation INDEX above is
// unaffected: it stays in local storage, durable across restarts, because
// which conversations exist is a different fact with a different lifetime
// than which one auto-opens.
//
// Storage shape: ONE STORAGE KEY PER SCOPE (`lastActiveStorageKey(scope)`
// below), never a single key holding a `{scope: id}` map — the same
// lost-update argument as the conversation index above, and the same reason
// `forgetLastActive()`/`pruneLastActive()` below address one key at a time.
export const LAST_ACTIVE_KEY_PREFIX = "ocic_last_active_conversation_v1:";

function lastActiveStorageKey(scope) {
  return `${LAST_ACTIVE_KEY_PREFIX}${scope}`;
}

/** Every conversation-cache key, for listing/pruning. Kept exported so the
 * panel layer (which owns chrome.storage) can reason about them without
 * re-deriving the prefix. */
export function historyEntryKey(conversationId) {
  return `${HISTORY_ENTRY_KEY_PREFIX}${conversationId}`;
}

// Defaults for tasks.md 2.2 ("count/byte limits, preview caps, TTL/archive
// policy, and a privacy toggle"). Deliberately generous enough that a normal
// profile never evicts anything, but finite: `maxConversations` bounds the
// row count, `maxBytes` bounds the serialized cache, `maxPromptPreviewChars`
// bounds one prompt echo, `ttlDays` ages out untouched conversations,
// `archiveOnEvict` keeps a metadata row (dropping the prompt preview bytes)
// instead of deleting outright, and `rawPromptCaching` is the privacy switch.
export const DEFAULT_HISTORY_POLICY = Object.freeze({
  maxConversations: 1000,
  maxBytes: 2 * 1024 * 1024,
  maxPromptPreviewChars: 200,
  maxTitleChars: 200,
  ttlDays: 90,
  archiveOnEvict: true,
  rawPromptCaching: true
});

export const ORPHAN_POLICY = Object.freeze({ MARK: "mark", REMOVE: "remove" });

export const EVICTION_OUTCOME = Object.freeze({ ARCHIVED: "archived", REMOVED: "removed" });

const DEFAULT_FLUSH_DELAY_MS = 700;
const MAX_EVICTION_LOG = 50;

function hasChromeStorage() {
  try {
    return typeof chrome !== "undefined" && !!chrome.storage && !!chrome.storage.local;
  } catch {
    return false;
  }
}

function hasChromeSessionStorage() {
  try {
    return typeof chrome !== "undefined" && !!chrome.storage && !!chrome.storage.session;
  } catch {
    return false;
  }
}

function clampText(value, maxChars) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > maxChars ? trimmed.slice(0, maxChars) : trimmed;
}

/** Normalize one persisted entry, or null when it cannot be one. Old rows
 * (and a v1 migration) are the reason every field is defaulted rather than
 * trusted. */
function normalizeEntry(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const conversationId = raw.conversationId;
  if (typeof conversationId !== "string" || !conversationId) return null;
  const now = Date.now();
  const updatedAt = typeof raw.updatedAt === "number" ? raw.updatedAt : now;
  return {
    conversationId,
    title: typeof raw.title === "string" ? raw.title : null,
    hostname: typeof raw.hostname === "string" ? raw.hostname : null,
    createdAt: typeof raw.createdAt === "number" ? raw.createdAt : updatedAt,
    updatedAt,
    interrupted: raw.interrupted === true,
    deletedLocally: raw.deletedLocally === true,
    pinned: raw.pinned === true,
    archived: raw.archived === true,
    // Presentation revision the host reported for this row (0 when this
    // entry is local-only). Used for `ifRevision` guards on writes.
    revision: Number.isInteger(raw.revision) ? raw.revision : 0,
    // Local-only entry the host no longer reports (or a placeholder written
    // before the first reconcile). Never presented as fully reopenable.
    stale: raw.stale === true,
    hasActiveRun: raw.hasActiveRun === true,
    // Tri-state, deliberately NOT coerced to a boolean: `false` means the
    // conversation is KNOWN to hold nothing (no event host-side, no item in
    // the local model), so the history list hides its row, while `true` and
    // `null` (unknown — an entry from before this field existed, or a
    // companion too old to report it) both render. Coercing unknown to false
    // would hide real history behind an older companion.
    hasData: typeof raw.hasData === "boolean" ? raw.hasData : null,
    evicted: raw.evicted === true,
    evictedAt: typeof raw.evictedAt === "number" ? raw.evictedAt : null,
    previewSuppressed: raw.previewSuppressed === true,
    schemaVersion: HISTORY_SCHEMA_VERSION,
    prompts: raw.prompts && typeof raw.prompts === "object" && !Array.isArray(raw.prompts) ? { ...raw.prompts } : {}
  };
}

function entryBytes(entry) {
  try {
    return JSON.stringify(entry).length;
  } catch {
    return 0;
  }
}

function sortEntries(entries) {
  // Pinned first (that is what pinning means in the history list), then
  // most-recently-active. Stable ties by id so two entries with the same
  // timestamp cannot reorder between renders.
  return entries.sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    const byTime = (b.updatedAt || 0) - (a.updatedAt || 0);
    if (byTime !== 0) return byTime;
    return String(a.conversationId).localeCompare(String(b.conversationId));
  });
}

/**
 * @param {object} [deps]
 * @param {{get(keys):Promise<object>, set(obj):Promise<void>, remove?(keys):Promise<void>}} [deps.storage] -
 *   defaults to chrome.storage.local; injectable for tests. Backs the
 *   durable conversation cache and the retention policy.
 * @param {{get(keys):Promise<object>, set(obj):Promise<void>, remove?(keys):Promise<void>}} [deps.sessionStorage] -
 *   defaults to chrome.storage.session; injectable for tests. Backs the
 *   per-scope last-active entries (see LAST_ACTIVE_KEY_PREFIX's comment) —
 *   deliberately a SEPARATE store from `storage` above, since the two have
 *   different lifetimes.
 * @param {() => number} [deps.now]
 * @param {number} [deps.flushDelayMs] - coalescing window for streaming
 *   updates (tasks.md 2.1 wants 500–1000ms).
 * @param {object} [deps.policy] - overrides for DEFAULT_HISTORY_POLICY.
 */
export class HistoryStore {
  constructor({ storage, sessionStorage, now = Date.now, flushDelayMs = DEFAULT_FLUSH_DELAY_MS, policy } = {}) {
    this._storage = storage || (hasChromeStorage() ? chrome.storage.local : new MemoryStorage());
    this._sessionStorage = sessionStorage || (hasChromeSessionStorage() ? chrome.storage.session : new MemoryStorage());
    this._now = now;
    this._flushDelayMs = flushDelayMs;
    this._entries = new Map(); // conversationId -> normalized entry
    this._dirty = new Set(); // conversationIds with unpersisted changes
    this._removals = new Set(); // storage keys to delete on the next flush
    this._loaded = false;
    this._loadPromise = null;
    this._flushPromise = null;
    this._timer = null;
    this._policy = { ...DEFAULT_HISTORY_POLICY, ...(policy || {}) };
    this._evictionLog = [];
    this._changeHandlers = new Set();
    this._watchingStorage = false;
    this._migration = null; // {migrated, fromVersion} after the first load
  }

  // ---- loading / migration -------------------------------------------------

  async _ensureLoaded() {
    if (this._loaded) return;
    if (!this._loadPromise) {
      this._loadPromise = this._load()
        .catch(() => {
          // A storage backend that cannot be read degrades to "nothing
          // cached", never a thrown panel.
          this._migration = { migrated: false, fromVersion: null, error: true };
        })
        .finally(() => {
          this._loaded = true;
        });
    }
    await this._loadPromise;
  }

  async _storageGet(key) {
    try {
      const result = await this._storage.get(key);
      return result && typeof result === "object" ? result : {};
    } catch {
      return {};
    }
  }

  async _load() {
    const all = await this._storageGet(null);
    let sawV2 = false;
    for (const [key, value] of Object.entries(all)) {
      if (!key.startsWith(HISTORY_ENTRY_KEY_PREFIX)) continue;
      sawV2 = true;
      const entry = normalizeEntry(value);
      if (entry) this._entries.set(entry.conversationId, entry);
    }
    const storedPolicy = all[HISTORY_POLICY_KEY];
    if (storedPolicy && typeof storedPolicy === "object" && !Array.isArray(storedPolicy)) {
      this._policy = { ...this._policy, ...storedPolicy };
    }

    const legacy = all[LEGACY_STORAGE_KEY];
    const alreadyMigrated = !!(storedPolicy && storedPolicy.migratedFromV1);
    if (Array.isArray(legacy)) {
      if (!alreadyMigrated || !sawV2) {
        for (const raw of legacy) {
          const entry = normalizeEntry(raw);
          if (!entry) continue;
          // A v2 entry already written this session wins — migration only
          // fills what the v2 cache does not already know.
          if (!this._entries.has(entry.conversationId)) {
            this._entries.set(entry.conversationId, entry);
            this._dirty.add(entry.conversationId);
          }
        }
        this._migration = { migrated: true, fromVersion: 1 };
      }
      this._removals.add(LEGACY_STORAGE_KEY);
      await this._persistPolicy({ ...this._policy, migratedFromV1: true });
      await this.flushNow();
      await this._removeKeys([LEGACY_STORAGE_KEY]);
    } else if (!alreadyMigrated) {
      // No legacy data at all: still record the marker once so a later load
      // does not go looking for a v1 list that was already dealt with.
      this._policy = { ...this._policy, migratedFromV1: true };
      await this._persistPolicy(this._policy);
    }
    this._watchExternalChanges();
  }

  /** Whether the first load migrated a v1 local index. Exposed for the
   * panel's own diagnostics and tests (design.md "Migration Plan"). */
  migrationState() {
    return this._migration ? { ...this._migration } : { migrated: false, fromVersion: null };
  }

  /**
   * Keep the in-memory cache in step with writes from OTHER panel documents
   * (two tabs share one chrome.storage.local). A key this store has pending
   * locally is skipped: the local write is newer than whatever landed in
   * storage, and adopting the stored value would lose it. Absent in tests
   * and in any environment without chrome.storage — guarded, not required.
   */
  _watchExternalChanges() {
    if (this._watchingStorage) return;
    this._watchingStorage = true;
    try {
      if (typeof chrome === "undefined" || !chrome.storage || !chrome.storage.onChanged || typeof chrome.storage.onChanged.addListener !== "function") return;
      chrome.storage.onChanged.addListener((changes, areaName) => {
        if (areaName !== "local") return;
        let changed = false;
        for (const [key, change] of Object.entries(changes || {})) {
          if (key === HISTORY_POLICY_KEY) {
            if (change && change.newValue && typeof change.newValue === "object") {
              this._policy = { ...DEFAULT_HISTORY_POLICY, ...change.newValue };
              changed = true;
            }
            continue;
          }
          if (!key.startsWith(HISTORY_ENTRY_KEY_PREFIX)) continue;
          const conversationId = key.slice(HISTORY_ENTRY_KEY_PREFIX.length);
          if (this._dirty.has(conversationId)) continue;
          const entry = normalizeEntry(change && change.newValue);
          if (entry) {
            this._entries.set(conversationId, entry);
            changed = true;
          } else if (this._entries.delete(conversationId)) {
            changed = true;
          }
        }
        if (changed) this._notify({ type: "external_change", source: "storage" });
      });
    } catch {
      /* no chrome.storage in this context — nothing to watch */
    }
  }

  /** Subscribe to cache changes (local mutations, reconciles, evictions and
   * external storage changes). Returns an unsubscribe function. */
  onChange(fn) {
    this._changeHandlers.add(fn);
    return () => this._changeHandlers.delete(fn);
  }

  _notify(event) {
    for (const fn of this._changeHandlers) {
      try {
        fn(event);
      } catch {
        /* a listener must never break a cache write */
      }
    }
  }

  // ---- reads ---------------------------------------------------------------

  /** All cached conversations, pinned first then most-recently-active. */
  async list() {
    await this._ensureLoaded();
    return sortEntries([...this._entries.values()]).map((entry) => ({ ...entry, prompts: { ...entry.prompts } }));
  }

  async get(conversationId) {
    await this._ensureLoaded();
    const entry = this._entries.get(conversationId);
    return entry ? { ...entry, prompts: { ...entry.prompts } } : null;
  }

  // ---- writes --------------------------------------------------------------

  /**
   * Record or update one conversation in the cache. Title/hostname are only
   * overwritten when explicitly provided (so a host reconcile or a later
   * derive does not blank an earlier value); everything else is
   * last-write-wins.
   *
   * A BRAND-NEW conversation id flushes synchronously: creating the first
   * record of a conversation is a lifecycle fact (design.md decision 2's
   * "final synchronous best-effort flush on lifecycle events"), and it is
   * cheap because it happens once per conversation. Updates to an existing
   * entry are coalesced into the debounce window.
   */
  async upsert({ conversationId, title, hostname, updatedAt, interrupted, deletedLocally, pinned, archived, revision, stale, hasActiveRun, hasData } = {}) {
    if (typeof conversationId !== "string" || !conversationId) return null;
    await this._ensureLoaded();
    const now = this._now();
    const prev = this._entries.get(conversationId) || null;
    const entry = {
      conversationId,
      title: title != null ? clampText(title, this._policy.maxTitleChars) : prev ? prev.title : null,
      hostname: hostname != null ? clampText(hostname, 255) : prev ? prev.hostname : null,
      createdAt: prev ? prev.createdAt : typeof updatedAt === "number" ? updatedAt : now,
      updatedAt: typeof updatedAt === "number" ? updatedAt : now,
      interrupted: interrupted != null ? interrupted === true : prev ? prev.interrupted : false,
      deletedLocally: deletedLocally != null ? deletedLocally === true : prev ? prev.deletedLocally : false,
      pinned: pinned != null ? pinned === true : prev ? prev.pinned : false,
      archived: archived != null ? archived === true : prev ? prev.archived : false,
      revision: revision != null ? revision : prev ? prev.revision : 0,
      stale: stale != null ? stale === true : prev ? prev.stale : false,
      hasActiveRun: hasActiveRun != null ? hasActiveRun === true : prev ? prev.hasActiveRun : false,
      // Only an explicit boolean is a claim ("this conversation has data" /
      // "it does not"); anything else leaves what the entry already knew
      // alone, and an entry that never knew stays unknown (rendered).
      hasData: typeof hasData === "boolean" ? hasData : prev ? prev.hasData : null,
      evicted: prev ? prev.evicted : false,
      evictedAt: prev ? prev.evictedAt : null,
      previewSuppressed: prev ? prev.previewSuppressed : false,
      schemaVersion: HISTORY_SCHEMA_VERSION,
      prompts: prev ? { ...prev.prompts } : {}
    };
    this._entries.set(conversationId, entry);
    this._dirty.add(conversationId);
    if (!prev) await this.flushNow();
    else this._scheduleFlush();
    this._notify({ type: "upsert", conversationId });
    return { ...entry, prompts: { ...entry.prompts } };
  }

  /**
   * Cache this run's prompt text under its conversation, so a later
   * rebuild-from-snapshot (conversation-model.js's applySnapshot) can still
   * show what was asked even though the host does not persist it.
   *
   * The privacy toggle (`rawPromptCaching: false`) is enforced HERE, at the
   * single write point: a metadata-only entry is recorded (the conversation
   * still appears, with its title/hostname/timestamps) and
   * `previewSuppressed` marks it explicitly, but no prompt text is stored.
   */
  async recordPrompt(conversationId, runId, text) {
    if (typeof conversationId !== "string" || !conversationId || typeof runId !== "string" || !runId) return;
    await this._ensureLoaded();
    const entry = this._entries.get(conversationId);
    if (!entry) return;
    if (!this._policy.rawPromptCaching) {
      if (!entry.previewSuppressed) {
        entry.previewSuppressed = true;
        this._dirty.add(conversationId);
        this._scheduleFlush();
      }
      return;
    }
    const preview = clampText(text, this._policy.maxPromptPreviewChars);
    if (preview == null) return;
    entry.prompts[runId] = preview;
    this._dirty.add(conversationId);
    this._scheduleFlush();
  }

  async promptsFor(conversationId) {
    await this._ensureLoaded();
    const entry = this._entries.get(conversationId);
    return new Map(Object.entries((entry && entry.prompts) || {}));
  }

  /**
   * Forget one conversation locally (after the HOST confirmed its deletion —
   * see panel-controller.js's deleteConversation()). Removal is immediate,
   * never debounced: it is a lifecycle fact and a stale key must not survive
   * a confirmed delete. Idempotent; returns whether anything was there.
   */
  async remove(conversationId) {
    await this._ensureLoaded();
    const existed = this._entries.delete(conversationId);
    this._dirty.delete(conversationId);
    await this._removeKeys([historyEntryKey(conversationId)]);
    this._notify({ type: "removed", conversationId });
    return existed;
  }

  /** Clear the whole local cache ("clear all locally cached history" —
   * spec chat-history-storage "Privacy control"). */
  async clearAll() {
    await this._ensureLoaded();
    const ids = [...this._entries.keys()];
    this._entries.clear();
    this._dirty.clear();
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    await this._removeKeys(ids.map((id) => historyEntryKey(id)));
    this._notify({ type: "cleared", count: ids.length });
    return ids.length;
  }

  // ---- reconciliation against the authoritative host list ------------------

  /**
   * Merge the host's authoritative conversation summaries into the cache
   * (tasks.md 1.2, spec chat-history-lifecycle "Authoritative listing and
   * reconciliation").
   *
   *   - A conversation the host reports is present and NOT stale: host
   *     presentation fields win; the local prompt echo survives (the host
   *     does not persist prompt text at all); and `hasData` is taken from the
   *     host's summary — the panel's history list hides only conversations
   *     the host says are empty.
   *   - A local entry the host does not report is an ORPHAN. It is marked
   *     `stale: true` (default) or removed entirely
   *     (`policy.orphanPolicy === "remove"`) — never silently presented as a
   *     fully reopenable conversation. Its prompt previews are kept while it
   *     is marked, because the host record is exactly what is unavailable
   *     for it, which is the only case the spec allows local-only previews
   *     to be relied on.
   *
   * @returns {Promise<{reconciled: number, orphans: string[], removed: string[]}>}
   */
  async reconcile(summaries) {
    await this._ensureLoaded();
    const seen = new Set();
    for (const summary of summaries || []) {
      if (!summary || typeof summary.conversationId !== "string" || !summary.conversationId) continue;
      const conversationId = summary.conversationId;
      seen.add(conversationId);
      const prev = this._entries.get(conversationId) || null;
      const now = this._now();
      const entry = {
        conversationId,
        title: summary.title != null ? clampText(summary.title, this._policy.maxTitleChars) : prev ? prev.title : null,
        hostname: summary.hostname != null ? clampText(summary.hostname, 255) : prev ? prev.hostname : null,
        createdAt: typeof summary.createdAt === "number" ? summary.createdAt : prev ? prev.createdAt : now,
        updatedAt: typeof summary.updatedAt === "number" ? summary.updatedAt : prev ? prev.updatedAt : now,
        interrupted: summary.interrupted === true,
        deletedLocally: false,
        pinned: summary.pinned === true,
        archived: summary.archived === true,
        revision: Number.isInteger(summary.revision) ? summary.revision : prev ? prev.revision : 0,
        stale: false,
        hasActiveRun: summary.hasActiveRun === true,
        // The host's own answer when it carries one (a companion that speaks
        // this field). A summary WITHOUT it — an older companion — must not
        // erase what the entry already knew: an entry that was never told
        // stays `null` (unknown, rendered), one the panel's own model judged
        // keeps that judgement.
        hasData: typeof summary.hasData === "boolean" ? summary.hasData : prev ? prev.hasData : null,
        evicted: prev ? prev.evicted : false,
        evictedAt: prev ? prev.evictedAt : null,
        previewSuppressed: prev ? prev.previewSuppressed : false,
        schemaVersion: HISTORY_SCHEMA_VERSION,
        prompts: prev ? { ...prev.prompts } : {}
      };
      this._entries.set(conversationId, entry);
      this._dirty.add(conversationId);
    }

    const orphans = [];
    const removed = [];
    const removeOrphans = this._policy.orphanPolicy === ORPHAN_POLICY.REMOVE;
    for (const [conversationId, entry] of [...this._entries]) {
      if (seen.has(conversationId)) continue;
      orphans.push(conversationId);
      if (removeOrphans) {
        this._entries.delete(conversationId);
        this._dirty.delete(conversationId);
        this._removals.add(historyEntryKey(conversationId));
        removed.push(conversationId);
      } else if (!entry.stale) {
        entry.stale = true;
        this._dirty.add(conversationId);
      }
    }
    await this.flushNow();
    this._notify({ type: "reconciled", reconciled: seen.size, orphans });
    return { reconciled: seen.size, orphans, removed };
  }

  // ---- retention / privacy policy ------------------------------------------

  policy() {
    return { ...this._policy };
  }

  /**
   * The policy as PERSISTED, i.e. after the store's first load. `policy()`
   * answers from the defaults until then, so a control that has to show the
   * operator the current setting must read through here rather than assume
   * the store was already loaded by someone else.
   */
  async effectivePolicy() {
    await this._ensureLoaded();
    return this.policy();
  }

  /** Patch the retention/privacy policy. Persisted immediately (a policy
   * change is a user action, not streaming traffic). Returns the effective
   * policy. */
  async setPolicy(patch = {}) {
    await this._ensureLoaded();
    this._policy = { ...this._policy, ...patch };
    await this._persistPolicy(this._policy);
    await this._enforceRetention();
    this._notify({ type: "policy", policy: this.policy() });
    return this.policy();
  }

  /** Privacy toggle (spec chat-history-storage "Privacy control"). Disabling
   * raw prompt caching drops every cached prompt preview immediately — the
   * switch is only honest if turning it off also removes what it promised
   * not to keep. */
  async setRawPromptCachingEnabled(enabled) {
    await this._ensureLoaded();
    const next = { ...this._policy, rawPromptCaching: enabled === true };
    this._policy = next;
    if (!next.rawPromptCaching) {
      for (const entry of this._entries.values()) {
        if (Object.keys(entry.prompts).length) {
          entry.prompts = {};
          entry.previewSuppressed = true;
          this._dirty.add(entry.conversationId);
        }
      }
    }
    await this._persistPolicy(this._policy);
    await this.flushNow();
    this._notify({ type: "policy", policy: this.policy() });
    return this.policy();
  }

  async _persistPolicy(policy) {
    const record = { ...policy, schemaVersion: HISTORY_SCHEMA_VERSION, updatedAt: this._now() };
    try {
      await this._storage.set({ [HISTORY_POLICY_KEY]: record });
    } catch {
      /* best-effort — a persistence failure must not block using the panel */
    }
  }

  /**
   * Apply the retention policy over the in-memory cache (tasks.md 2.2).
   * Eligible = not pinned. TTL first, then count, then bytes; the oldest (or
   * largest, for the byte cap) eligible entry goes first. `archiveOnEvict`
   * keeps a metadata row but drops its prompt-preview bytes — that is what
   * actually reclaims space while the conversation stays visible and
   * reopenable from the host.
   *
   * @returns {Promise<Array<{conversationId: string, outcome: string}>>}
   */
  async _enforceRetention() {
    // Re-entrancy guard: retention persists its own outcome through
    // `_writeDirty()` (not `flushNow()`), so this can only be re-entered by a
    // concurrent flush — which must not run a second retention pass over
    // state the first one is still mutating.
    if (this._enforcingRetention) return [];
    this._enforcingRetention = true;
    try {
      return await this._applyRetention();
    } finally {
      this._enforcingRetention = false;
    }
  }

  async _applyRetention() {
    const policy = this._policy;
    const now = this._now();
    const evicted = new Set();
    // An entry that already took a retention hit is not eligible again:
    // archiving it repeatedly would reclaim nothing (it has no previews
    // left) while making every pass report work it did not do — and, in the
    // count branch, would keep the count "over budget" forever.
    const eligible = (entry) => !entry.pinned && !entry.hasActiveRun && !entry.evicted;

    if (policy.ttlDays > 0) {
      const ttlMs = policy.ttlDays * 24 * 60 * 60 * 1000;
      for (const entry of this._entries.values()) {
        if (!eligible(entry)) continue;
        if (now - (entry.updatedAt || 0) > ttlMs) evicted.add(entry);
      }
    }

    if (Number.isInteger(policy.maxConversations) && policy.maxConversations >= 0) {
      const over = [...this._entries.values()].filter((entry) => eligible(entry) && !evicted.has(entry));
      const overflow = over.length - policy.maxConversations;
      if (overflow > 0) {
        over.sort((a, b) => (a.updatedAt || 0) - (b.updatedAt || 0));
        for (let i = 0; i < overflow; i++) evicted.add(over[i]);
      }
    }

    if (policy.maxBytes > 0) {
      let bytes = 0;
      for (const entry of this._entries.values()) bytes += entryBytes(entry);
      if (bytes > policy.maxBytes) {
        const shrinkable = [...this._entries.values()]
          .filter((entry) => eligible(entry) && !evicted.has(entry))
          .sort((a, b) => entryBytes(b) - entryBytes(a));
        for (const entry of shrinkable) {
          if (bytes <= policy.maxBytes) break;
          bytes -= Math.max(0, entryBytes(entry) - entryBytes({ ...entry, prompts: {} }));
          evicted.add(entry);
        }
      }
    }

    const applied = [];
    for (const entry of evicted) {
      if (policy.archiveOnEvict) {
        entry.archived = true;
        entry.evicted = true;
        entry.evictedAt = now;
        entry.prompts = {};
        this._dirty.add(entry.conversationId);
        this._logEviction(entry.conversationId, EVICTION_OUTCOME.ARCHIVED);
        applied.push({ conversationId: entry.conversationId, outcome: EVICTION_OUTCOME.ARCHIVED });
      } else {
        this._entries.delete(entry.conversationId);
        this._dirty.delete(entry.conversationId);
        this._removals.add(historyEntryKey(entry.conversationId));
        this._logEviction(entry.conversationId, EVICTION_OUTCOME.REMOVED);
        applied.push({ conversationId: entry.conversationId, outcome: EVICTION_OUTCOME.REMOVED });
      }
    }
    if (applied.length) {
      await this._writeDirty();
      this._notify({ type: "retention", evicted: applied });
    }
    return applied;
  }

  _logEviction(conversationId, outcome) {
    this._evictionLog.push({ conversationId, outcome, at: this._now() });
    if (this._evictionLog.length > MAX_EVICTION_LOG) this._evictionLog.splice(0, this._evictionLog.length - MAX_EVICTION_LOG);
  }

  /** What retention has done lately — "the user can see the outcome" (spec
   * chat-history-storage "Bounded retention"). Newest first. */
  evictionReport() {
    return [...this._evictionLog].reverse();
  }

  // ---- flush ---------------------------------------------------------------

  _scheduleFlush() {
    if (this._flushDelayMs <= 0) {
      this.flush();
      return;
    }
    if (this._timer) return;
    this._timer = setTimeout(() => {
      this._timer = null;
      this.flush();
    }, this._flushDelayMs);
    if (this._timer.unref) this._timer.unref();
  }

  /** Fire-and-forget flush — the form lifecycle hooks (run terminal, unload,
   * delete) use when they cannot await. */
  flush() {
    this.flushNow().catch(() => {});
  }

  /** Awaitable flush of every dirty entry plus queued removals. Writes are
   * batched into ONE `set()` carrying only the conversations that changed;
   * this is the whole point of the per-conversation shape (tasks.md 2.1 — no
   * whole-list read-modify-write, no write per token batch). */
  async flushNow() {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    if (this._flushPromise) {
      // Serialize flushes: a second flush while one is in flight must not
      // clear the dirty set out from under it.
      await this._flushPromise;
    }
    const wrote = await this._writeDirty();
    await this._enforceRetention().catch(() => {});
    return wrote;
  }

  /** The single write path: one `set()` for the dirty conversations, one
   * `remove()` for the queued keys. Returns how many conversation rows were
   * written. */
  async _writeDirty() {
    const ids = [...this._dirty];
    const removals = [...this._removals];
    this._dirty.clear();
    this._removals.clear();
    if (!ids.length && !removals.length) return 0;
    const patch = {};
    for (const conversationId of ids) {
      const entry = this._entries.get(conversationId);
      if (entry) patch[historyEntryKey(conversationId)] = entry;
    }
    this._flushPromise = (async () => {
      try {
        if (Object.keys(patch).length) await this._storage.set(patch);
        if (removals.length) await this._removeKeys(removals);
      } catch {
        // Best-effort, but a failed write must not silently drop the change:
        // put it back so the next flush (or the unload flush) retries.
        for (const conversationId of ids) {
          if (this._entries.has(conversationId)) this._dirty.add(conversationId);
        }
        for (const key of removals) this._removals.add(key);
      }
    })();
    try {
      await this._flushPromise;
    } finally {
      this._flushPromise = null;
    }
    return ids.length;
  }

  async _removeKeys(keys) {
    if (!keys.length) return;
    if (typeof this._storage.remove !== "function") return;
    try {
      await this._storage.remove(keys);
    } catch {
      /* best-effort */
    }
  }

  // ---- last-active (unchanged shape; scope-keyed, session-lifetime) --------

  /**
   * The conversation the operator was last looking at WITHIN `scope`, or
   * `null` if none is remembered for that scope (never had one, it was
   * deliberately forgotten via `setLastActive(scope, null)`, or `scope`
   * itself is falsy — "no identifiable scope", spec's own fallback trigger —
   * both read the same here, which is exactly what panel-controller.js's
   * startup restore wants: "no remembered id for this scope" and "explicitly
   * cleared" both fall back to starting a new conversation). A falsy `scope`
   * short-circuits before ever touching storage, so a panel that cannot
   * identify its own tab can never read (and, in `setLastActive`, never
   * write) another scope's entry.
   * Same swallow-on-failure treatment as the index reads: a storage read
   * that throws resolves to `null`, never a rejection — and an absent
   * `chrome.storage.session` (this._sessionStorage falls back to its own
   * MemoryStorage in that case, see the constructor) degrades to the same
   * "nothing remembered" outcome, never an error. */
  async getLastActive(scope) {
    if (!scope) return null;
    try {
      const key = lastActiveStorageKey(scope);
      const result = await this._sessionStorage.get(key);
      const id = result && result[key];
      return typeof id === "string" && id ? id : null;
    } catch {
      return null;
    }
  }

  /** Remember (or, with `id === null`, forget) which conversation is active
   * for `scope`. Deliberately NOT derived from `list()[0]`
   * (most-recently-updated) — see design.md: `upsert()` bumps `updatedAt` on
   * every stream_event/token_batch for ANY conversation this controller
   * holds, including one the operator switched away from while it kept
   * running in the background. Most-recently-updated therefore answers a
   * different question than "which conversation was the operator looking at
   * in THIS scope", and a caller of getLastActive() at startup wants the
   * latter.
   *
   * Writes ONLY this scope's own storage key (see LAST_ACTIVE_KEY_PREFIX's
   * comment for why this is a per-key write rather than a read-modify-write
   * of a shared map). Best-effort like every other write here. A falsy
   * `scope` is a no-op for the same "no identifiable scope never touches
   * another scope's entry" reason `getLastActive()` documents. */
  async setLastActive(scope, id) {
    if (!scope) return;
    try {
      await this._sessionStorage.set({ [lastActiveStorageKey(scope)]: id || null });
    } catch {
      /* best-effort — a persistence failure must not block using the panel */
    }
  }

  /** Drop one scope's remembered conversation (tasks.md 2.3's stale-key
   * cleanup for a tab that no longer exists). */
  async forgetLastActive(scope) {
    if (!scope) return;
    try {
      const key = lastActiveStorageKey(scope);
      if (typeof this._sessionStorage.remove === "function") {
        await this._sessionStorage.remove(key);
      } else {
        await this._sessionStorage.set({ [key]: null });
      }
    } catch {
      /* best-effort */
    }
  }

  /**
   * Remove every remembered-conversation key whose scope is not in
   * `validScopes` (tasks.md 2.3: "clean stale last-active keys on tab
   * removal"). Requires a backend that can enumerate (`get(null)`) — with
   * one that cannot, there is nothing to sweep and this is a no-op.
   *
   * @param {Iterable<string>} validScopes - the scopes that still exist
   *   (sidepanel.js passes the current tab ids).
   * @returns {Promise<string[]>} the stale scopes that were removed.
   */
  async pruneLastActive(validScopes) {
    const valid = new Set([...validScopes].filter(Boolean).map(String));
    // An empty valid set means "we could not determine which tabs exist"
    // (the caller failed to enumerate), NOT "no tab exists" — sweeping on
    // that reading would delete every scope's remembered conversation.
    if (!valid.size) return [];
    let all = {};
    try {
      all = await this._sessionStorage.get(null);
    } catch {
      return [];
    }
    if (!all || typeof all !== "object") return [];
    const stale = Object.keys(all)
      .filter((key) => key.startsWith(LAST_ACTIVE_KEY_PREFIX))
      .map((key) => key.slice(LAST_ACTIVE_KEY_PREFIX.length))
      .filter((scope) => !valid.has(scope));
    if (!stale.length) return [];
    const keys = stale.map((scope) => lastActiveStorageKey(scope));
    try {
      if (typeof this._sessionStorage.remove === "function") await this._sessionStorage.remove(keys);
      else await this._sessionStorage.set(Object.fromEntries(keys.map((k) => [k, null])));
    } catch {
      return [];
    }
    return stale;
  }
}

class MemoryStorage {
  constructor() {
    this._data = {};
  }
  async get(key) {
    if (key == null) return { ...this._data };
    if (Array.isArray(key)) {
      const out = {};
      for (const k of key) if (k in this._data) out[k] = this._data[k];
      return out;
    }
    return key in this._data ? { [key]: this._data[key] } : {};
  }
  async set(obj) {
    Object.assign(this._data, obj);
  }
  async remove(keys) {
    for (const key of Array.isArray(keys) ? keys : [keys]) delete this._data[key];
  }
}
