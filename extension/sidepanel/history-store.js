// Local conversation index (spec 5.3: "new conversation, list/reopen
// conversations, explicit local history deletion").
//
// KNOWN PROTOCOL GAP (documented, not silently worked around — see
// reports/05-panel-evidence.md "Known gaps"): host/agent/protocol.js
// defines no LIST_CONVERSATIONS or DELETE_CONVERSATION message type, and
// host/agent/companion.js's handleEnvelope() has no case for either even
// though host/agent/session/manager.js has listConversations()/
// deleteConversation() methods ready to be wired to one. Both files are
// under host/** and out of this task's file ownership. In the meantime:
//   - Listing works correctly for the normal case (this extension profile
//     is the only client that ever calls NEW against its own companion —
//     exactly one companion per active bridge, see companion.js's file
//     header), because every conversationId that will ever exist was
//     created by a NEW call this store already recorded.
//   - Delete is HONEST about its limit: it removes the conversation from
//     this panel's own list immediately, but the host-side transcript file
//     is NOT guaranteed removed (no wire call exists to ask for that). The
//     UI must say so rather than imply the data is gone.
// A future task should add LIST_CONVERSATIONS/DELETE_CONVERSATION to
// protocol.js + companion.js and this module should then prefer the host's
// authoritative list over its own cache.

const STORAGE_KEY = "ocic_conversation_history_v1";

// Which conversation was active when the panel last had one open, kept under
// its own key rather than folded into the STORAGE_KEY index (see
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
// cross-scope leak this change fixes. The conversation INDEX above
// (STORAGE_KEY) is unaffected: it stays in local storage, durable across
// restarts, because which conversations exist is a different fact with a
// different lifetime than which one auto-opens.
//
// Storage shape: ONE STORAGE KEY PER SCOPE (`lastActiveStorageKey(scope)`
// below), never a single key holding a `{scope: id}` map. A shared map key
// would force every write through a read-modify-write of the WHOLE map, and
// two panel documents (two different tabs) genuinely do share one
// `chrome.storage.session` backend — both could read the same map at
// nearly the same time, each mutate only its own entry in local memory, and
// whichever `set()` lands second would silently overwrite the other's write
// with a stale copy of the map, discarding it (chrome.storage's `set()` has
// no merge/patch primitive to close that window). Giving each scope its own
// top-level key makes every write touch only that scope's own key: two tabs
// writing different scopes' entries touch different keys and can never
// collide, so `chrome.storage`'s own per-key write handling is already
// enough — no read-modify-write, and no cross-tab race, is needed at all.
const LAST_ACTIVE_KEY_PREFIX = "ocic_last_active_conversation_v1:";

function lastActiveStorageKey(scope) {
  return `${LAST_ACTIVE_KEY_PREFIX}${scope}`;
}

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

/**
 * @param {object} [deps]
 * @param {{get(keys):Promise<object>, set(obj):Promise<void>}} [deps.storage] -
 *   defaults to chrome.storage.local; injectable for tests. Backs the
 *   durable conversation index only.
 * @param {{get(keys):Promise<object>, set(obj):Promise<void>}} [deps.sessionStorage] -
 *   defaults to chrome.storage.session; injectable for tests. Backs the
 *   per-scope last-active entries (see LAST_ACTIVE_KEY_PREFIX's comment) —
 *   deliberately a SEPARATE store from `storage` above, since the two have
 *   different lifetimes.
 */
export class HistoryStore {
  constructor({ storage, sessionStorage } = {}) {
    this._storage = storage || (hasChromeStorage() ? chrome.storage.local : new MemoryStorage());
    this._sessionStorage = sessionStorage || (hasChromeSessionStorage() ? chrome.storage.session : new MemoryStorage());
  }

  async _read() {
    try {
      const result = await this._storage.get(STORAGE_KEY);
      const list = result && result[STORAGE_KEY];
      return Array.isArray(list) ? list : [];
    } catch {
      return [];
    }
  }

  async _write(list) {
    try {
      await this._storage.set({ [STORAGE_KEY]: list });
    } catch {
      /* best-effort — a persistence failure must not block using the panel */
    }
  }

  /** All known conversations, most-recently-active first. */
  async list() {
    const list = await this._read();
    return [...list].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }

  /** Record a conversation this panel just created or resumed. `title` is
   * derived by the caller (first user message, truncated). Idempotent by
   * conversationId — an existing entry is updated in place, not duplicated. */
  async upsert({ conversationId, title, hostname, updatedAt, interrupted, deletedLocally }) {
    const list = await this._read();
    const idx = list.findIndex((c) => c.conversationId === conversationId);
    const now = updatedAt ?? Date.now();
    const entry = {
      conversationId,
      title: title ?? (idx >= 0 ? list[idx].title : "Cuộc trò chuyện mới"),
      hostname: hostname ?? (idx >= 0 ? list[idx].hostname : null),
      createdAt: idx >= 0 ? list[idx].createdAt : now,
      updatedAt: now,
      interrupted: interrupted ?? (idx >= 0 ? list[idx].interrupted : false),
      deletedLocally: deletedLocally ?? (idx >= 0 ? list[idx].deletedLocally : false),
      prompts: idx >= 0 ? list[idx].prompts : {}
    };
    if (idx >= 0) list[idx] = entry;
    else list.push(entry);
    await this._write(list);
    return entry;
  }

  /** Cache this run's prompt text under its conversation, so a later
   * rebuild-from-snapshot (conversation-model.js's applySnapshot) can still
   * show what was asked even though the host does not persist it. */
  async recordPrompt(conversationId, runId, text) {
    const list = await this._read();
    const idx = list.findIndex((c) => c.conversationId === conversationId);
    if (idx < 0) return;
    list[idx].prompts = { ...(list[idx].prompts || {}), [runId]: text };
    await this._write(list);
  }

  async promptsFor(conversationId) {
    const list = await this._read();
    const entry = list.find((c) => c.conversationId === conversationId);
    return new Map(Object.entries((entry && entry.prompts) || {}));
  }

  /** Explicit local deletion (5.3), after user confirmation in the UI layer
   * — this module does not itself confirm. See the file-header note: this
   * removes the LOCAL list entry only; host-side data removal is BLOCKED on
   * a protocol addition outside this task's ownership. */
  async removeLocal(conversationId) {
    const list = await this._read();
    const next = list.filter((c) => c.conversationId !== conversationId);
    await this._write(next);
  }

  /** The conversation the operator was last looking at WITHIN `scope`, or
   * `null` if none is remembered for that scope (never had one, it was
   * deliberately forgotten via `setLastActive(scope, null)`, or `scope`
   * itself is falsy — "no identifiable scope", spec's own fallback trigger —
   * both read the same here, which is exactly what
   * panel-controller.js's startup restore wants: "no remembered id for this
   * scope" and "explicitly cleared" both fall back to starting a new
   * conversation). A falsy `scope` short-circuits before ever touching
   * storage, so a panel that cannot identify its own tab can never read
   * (and, in `setLastActive`, never write) another scope's entry.
   * Same swallow-on-failure treatment as `_read`/`_write`: a storage read
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
   * (most-recently-updated) — see design.md: `_persistHistoryEntry()` bumps
   * `updatedAt` on every stream_event/token_batch for ANY conversation this
   * controller holds, including one the operator switched away from while it
   * kept running in the background. Most-recently-updated therefore answers
   * a different question than "which conversation was the operator looking
   * at in THIS scope", and a caller of getLastActive() at startup wants the
   * latter.
   *
   * Writes ONLY this scope's own storage key (see `lastActiveStorageKey()`'s
   * comment for why this is a per-key write rather than a read-modify-write
   * of a shared map) — a concurrent write to a DIFFERENT scope's entry (two
   * panel documents, two tabs, sharing one `chrome.storage.session`) touches
   * a different key entirely and can therefore never race with or clobber
   * this one. Best-effort like every other write here: a storage failure
   * must not block using the panel. A falsy `scope` is a no-op for the same
   * "no identifiable scope never touches another scope's entry" reason
   * `getLastActive()` documents. */
  async setLastActive(scope, id) {
    if (!scope) return;
    try {
      await this._sessionStorage.set({ [lastActiveStorageKey(scope)]: id || null });
    } catch {
      /* best-effort — a persistence failure must not block using the panel */
    }
  }
}

class MemoryStorage {
  constructor() {
    this._data = {};
  }
  async get(key) {
    return key in this._data ? { [key]: this._data[key] } : {};
  }
  async set(obj) {
    Object.assign(this._data, obj);
  }
}
