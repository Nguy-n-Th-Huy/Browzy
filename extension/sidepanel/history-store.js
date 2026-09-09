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

function hasChromeStorage() {
  try {
    return typeof chrome !== "undefined" && !!chrome.storage && !!chrome.storage.local;
  } catch {
    return false;
  }
}

/**
 * @param {object} [deps]
 * @param {{get(keys):Promise<object>, set(obj):Promise<void>}} [deps.storage] -
 *   defaults to chrome.storage.local; injectable for tests.
 */
export class HistoryStore {
  constructor({ storage } = {}) {
    this._storage = storage || (hasChromeStorage() ? chrome.storage.local : new MemoryStorage());
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
