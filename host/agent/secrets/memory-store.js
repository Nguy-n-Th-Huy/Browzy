// Explicit memory-only credential fallback.
//
// Used only when no OS credential store is available AND the user has
// explicitly opted into memory-only mode (never a silent fallback, and never
// a plaintext-file fallback — see secret-store.js). The secret lives only in
// this process's heap for the life of the process; it is never written
// anywhere, and is gone on restart (the caller is expected to require
// re-entry, which is the honest, disclosed cost of this mode).

const store = new Map();

/**
 * @param {string} target
 * @param {string} secret
 */
export function memoryWrite(target, secret) {
  store.set(target, secret);
}

/**
 * @param {string} target
 * @returns {string|null}
 */
export function memoryRead(target) {
  return store.has(target) ? store.get(target) : null;
}

/**
 * @param {string} target
 * @returns {boolean}
 */
export function memoryDelete(target) {
  return store.delete(target);
}

/** Test-only: clear every in-memory secret. */
export function memoryClearAll() {
  store.clear();
}
