// Batches high-frequency streaming events (model token/text deltas) into
// bounded windows before they cross native messaging, per design.md decision
// 1: "Batch token updates to avoid flooding native messaging." A model can
// stream many small deltas per second; forwarding each as its own native
// message would both saturate the channel and starve the extension's
// service worker with wake-ups. Low-frequency, latency-sensitive events
// (run started/stopped, tool dispatch, approvals) are explicitly NOT
// batched — those need to reach the panel immediately.

export const DEFAULT_BATCH_WINDOW_MS = 75;

/**
 * @param {(event: object) => boolean} defaultIsBatchable
 */
export function isStreamMessageEvent(event) {
  return !!event && event.type === "stream_message";
}

export class TokenBatcher {
  /**
   * @param {object} opts
   * @param {(item: object) => void} opts.sendImmediate - called for a
   *   non-batchable event, or once per flushed batch.
   * @param {(event: object) => boolean} [opts.isBatchable]
   * @param {number} [opts.windowMs]
   */
  constructor({ sendImmediate, isBatchable = isStreamMessageEvent, windowMs = DEFAULT_BATCH_WINDOW_MS }) {
    if (typeof sendImmediate !== "function") throw new Error("TokenBatcher requires sendImmediate");
    this._sendImmediate = sendImmediate;
    this._isBatchable = isBatchable;
    this._windowMs = windowMs;
    this._buffer = [];
    this._timer = null;
  }

  push(event) {
    if (!this._isBatchable(event)) {
      // A pending batch must still be flushed FIRST so ordering is
      // preserved (a tool_rejected event must not appear to have happened
      // before the stream_message events that preceded it).
      this.flush();
      this._sendImmediate(event);
      return;
    }
    this._buffer.push(event);
    if (!this._timer) {
      this._timer = setTimeout(() => this.flush(), this._windowMs);
      if (this._timer.unref) this._timer.unref();
    }
  }

  /** Force out whatever is buffered right now (e.g. on run completion/stop, so nothing is left stranded). */
  flush() {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    if (this._buffer.length === 0) return;
    const events = this._buffer;
    this._buffer = [];
    this._sendImmediate({ type: "token_batch", events });
  }

  dispose() {
    this.flush();
  }
}
