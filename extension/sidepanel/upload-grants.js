// Upload-grant bookkeeping for the side panel (host/agent/protocol.js's
// upload_grant), kept free of the DOM so the state machine — what the panel
// may claim, and when it must stop claiming it — is testable on its own.
//
// Rules this module exists to enforce:
//   - a path counts as shared ONLY after the COMPANION confirmed it (never
//     optimistically), so the strip can never promise a capability the run
//     will then refuse;
//   - grants are per conversation and in memory on BOTH ends, so a dropped
//     connection clears them here too — a restarted companion no longer holds
//     them (see companion.js's _uploadGrantsByConversation);
//   - a reply for a request this panel does not have outstanding changes
//     nothing (a duplicated, stale, or foreign reply is inert).

/**
 * @returns {object} the panel's own upload-grant state machine.
 */
export function createUploadGrantState() {
  const byConversation = new Map(); // conversationId -> Set<absolutePath>
  const requests = new Map(); // requestId -> { conversationId, op }
  let pickPending = false;

  return {
    /** Confirmed paths for one conversation, in insertion order. */
    pathsFor(conversationId) {
      const set = conversationId ? byConversation.get(conversationId) : null;
      return set ? [...set] : [];
    },

    isPickPending() {
      return pickPending;
    },
    beginPick() {
      pickPending = true;
    },
    endPick() {
      pickPending = false;
    },

    /** Remember one in-flight request so its reply can be attributed. */
    noteRequest(requestId, info) {
      requests.set(requestId, info);
    },
    forgetRequest(requestId) {
      requests.delete(requestId);
    },

    /**
     * Apply one `upload_grant` reply.
     * @param {object} env - the envelope as received.
     * @returns {null | {conversationId: string, granted: string[], revoked: string[],
     *   skipped: Array<{path: string, reason: string}>, error: string|null}} the
     *   structured outcome for the caller to render — or null when this reply
     *   is not one of ours (wrong type, or no matching outstanding request).
     */
    applyReply(env) {
      if (!env || env.type !== "upload_grant" || typeof env.requestId !== "string") return null;
      const pending = requests.get(env.requestId);
      if (!pending) return null;
      requests.delete(env.requestId);
      const conversationId = pending.conversationId;
      if (env.ok !== true || !env.result) {
        const detail = env.error && env.error.message ? env.error.message : env.reason || "companion từ chối";
        return { conversationId, granted: [], revoked: [], skipped: [], error: detail };
      }
      const set = byConversation.get(conversationId) || new Set();
      const granted = Array.isArray(env.result.granted) ? env.result.granted.filter((p) => typeof p === "string") : [];
      const revoked = Array.isArray(env.result.revoked) ? env.result.revoked.filter((p) => typeof p === "string") : [];
      for (const p of granted) set.add(p);
      for (const p of revoked) set.delete(p);
      if (set.size) byConversation.set(conversationId, set);
      else byConversation.delete(conversationId);
      const skipped = Array.isArray(env.result.skipped)
        ? env.result.skipped.filter((s) => s && typeof s.path === "string")
        : [];
      return { conversationId, granted, revoked, skipped, error: null };
    },

    /** A dropped connection means the companion may have restarted and its
     *  grants are gone: stop claiming every one of them. */
    clearAll() {
      byConversation.clear();
      requests.clear();
      pickPending = false;
    },

    hasAny() {
      return byConversation.size > 0;
    }
  };
}
