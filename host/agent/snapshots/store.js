// Durable page snapshots: one JSON file per capture, under the companion's
// own user-data tree, keyed by a hash of the page URL.
//
// Why files and not a database: a snapshot is meant to be human-browsable —
// the operator (or a later run, or a support session) can open it, diff it,
// copy it off the machine. Why not per-conversation: the whole point of the
// capability is monitoring a page over days, so the baseline captured last
// week must stay reachable from a run that never saw the conversation that
// captured it. Why the host owns every path: a run supplies a NAME and the
// DATA it read; the directory, the URL hash and the filename are minted here
// (design.md decisions 1-2), so no caller-supplied string can ever become a
// path segment.
//
// Storage layout (paths.js owns the root):
//
//   <agent root>/snapshots/<url-hash>/<name-slug>-<file-timestamp>.json
//
// `<url-hash>` is sha256 of the normalized URL (scheme + host + path + sorted
// query parameters), so the same page always lands in the same directory and
// two different pages never share one. `<file-timestamp>` is the host-minted
// capture time rendered filesystem-safe (`:`/`.` become `-`).
//
// RECORD SHAPE — stable, documented, and read by a later version of this
// module and by the diff/report pair:
//
//   {
//     "url":       string,   // the page URL, exactly as supplied
//     "title":     string,   // the page title, exactly as supplied ("" when unknown)
//     "name":      string,   // the caller's snapshot name, verbatim (never the slug)
//     "timestamp": string,   // ISO 8601 UTC, host-minted at capture time
//     "fields":    object,   // the caller-supplied page fields, pure JSON
//     "metadata":  object    // capture context: { runId, conversationId,
//                            //   viewport, urlHash } — every key optional
//   }
//
// Readers tolerate unknown extra top-level keys and never treat a missing
// optional metadata key as corruption: this shape may grow, and a snapshot
// written by an older build has to stay loadable and comparable.
//
// Every guard below REJECTS rather than truncates (the same discipline as
// documents/store.js): a snapshot silently missing half the fields it claims
// to hold would be worse than a failed save, because the operator would
// compare against a baseline that never existed.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ensureDir, snapshotUrlDir, snapshotsRoot } from "../storage/paths.js";

// Guards (all reject-not-truncate).
export const MAX_FIELDS_BYTES = 2 * 1024 * 1024; // mirrors documents/store.js's MAX_SOURCE_BYTES
export const MAX_NAME_LENGTH = 120;
export const MAX_TITLE_LENGTH = 300;
export const MAX_SNAPSHOTS_PER_URL = 200;
const MAX_SLUG_LENGTH = 80;
// A same-millisecond collision is resolved by advancing the minted capture
// time by a millisecond, so the documented filename shape always holds; past
// this many attempts the save is refused rather than allowed to overwrite.
const MAX_COLLISION_STEPS = 1000;

export class SnapshotError extends Error {
  constructor(reason, message) {
    super(message);
    this.name = "SnapshotError";
    this.reason = reason;
  }
}

/**
 * The URL identity a snapshot directory is keyed by: scheme + host + path with
 * query parameters sorted. Fragments and parameter ORDER are deliberately not
 * part of it — `?b=2&a=1` and `?a=1&b=2` are the same page state, and a
 * trailing `#section` is the same page.
 *
 * @throws {SnapshotError} missing_url / invalid_url (never a filesystem error)
 */
export function normalizeUrl(url) {
  if (typeof url !== "string" || !url.trim()) {
    throw new SnapshotError("missing_url", "a page URL is required to identify the snapshot");
  }
  let parsed;
  try {
    parsed = new URL(url.trim());
  } catch {
    throw new SnapshotError("invalid_url", `not a parseable URL: ${JSON.stringify(url.trim().slice(0, 200))}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new SnapshotError("invalid_url", `only http(s) pages can be snapshotted, not ${JSON.stringify(parsed.protocol)}`);
  }
  const params = [...parsed.searchParams.entries()].sort((a, b) => {
    if (a[0] !== b[0]) return a[0] < b[0] ? -1 : 1;
    if (a[1] === b[1]) return 0;
    return a[1] < b[1] ? -1 : 1;
  });
  const query = params.map(([key, value]) => `${key}=${value}`).join("&");
  return `${parsed.protocol}//${parsed.host}${parsed.pathname}${query ? `?${query}` : ""}`;
}

/** sha256 (hex) of the normalized URL — a directory name, never a path from a caller. */
export function urlHash(url) {
  return crypto.createHash("sha256").update(normalizeUrl(url), "utf8").digest("hex");
}

/**
 * Filesystem-safe slug derived from a snapshot name. Same bounded,
 * ASCII-only discipline as documents/store.js's slugifyTitle: the real name
 * is preserved verbatim in the record and is what listings show, so nothing
 * readable is lost by being strict here. A name the slug alphabet cannot
 * represent at all (CJK, emoji) falls back to "snapshot" — the timestamp is
 * what makes captures distinguishable.
 */
export function slugifyName(name) {
  const normalized = String(name ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[đĐ]/g, "d")
    .toLowerCase();
  const slug = normalized
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/g, "");
  return slug || "snapshot";
}

function assertUsableName(name) {
  if (typeof name !== "string" || !name.trim()) {
    throw new SnapshotError("empty_name", `a snapshot name is required, got ${JSON.stringify(name)?.slice(0, 80)}`);
  }
  const raw = name.trim();
  if (raw.length > MAX_NAME_LENGTH) {
    throw new SnapshotError(
      "name_too_long",
      `the snapshot name is ${raw.length} characters, over the ${MAX_NAME_LENGTH}-character limit: ${JSON.stringify(raw.slice(0, 80))}`
    );
  }
  if (/[/\\\u0000]/.test(raw) || raw.includes("..")) {
    throw new SnapshotError(
      "unsafe_name",
      `the snapshot name must not contain path separators or traversal sequences: ${JSON.stringify(raw)}`
    );
  }
  if (!slugifyName(raw).trim()) {
    throw new SnapshotError("unusable_name", `the snapshot name has no usable filename characters: ${JSON.stringify(raw)}`);
  }
  return { name: raw, slug: slugifyName(raw) };
}

/**
 * Every value reachable from `fields` must be pure JSON — a snapshot is
 * written with JSON.stringify and read back with JSON.parse, so anything the
 * serializer would silently drop (undefined, a function), silently coerce
 * (Date, NaN, Infinity) or refuse (BigInt, a cycle) is rejected HERE, naming
 * the field path, rather than disappearing between save and compare.
 */
function assertJsonValue(value, fieldPath, seen) {
  if (value === null) return;
  const type = typeof value;
  if (type === "string" || type === "boolean") return;
  if (type === "number") {
    if (!Number.isFinite(value)) {
      throw new SnapshotError("fields_not_serializable", `the field ${JSON.stringify(fieldPath)} is ${value}, which is not JSON`);
    }
    return;
  }
  if (type !== "object") {
    throw new SnapshotError(
      "fields_not_serializable",
      `the field ${JSON.stringify(fieldPath)} is a ${type}, which JSON cannot carry`
    );
  }
  if (seen.has(value)) {
    throw new SnapshotError("fields_not_serializable", `the field ${JSON.stringify(fieldPath)} is part of a circular structure`);
  }
  const proto = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && proto !== Object.prototype && proto !== null) {
    throw new SnapshotError(
      "fields_not_serializable",
      `the field ${JSON.stringify(fieldPath)} is a ${value?.constructor?.name || "non-plain"} object, which JSON would silently rewrite`
    );
  }
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertJsonValue(item, `${fieldPath}[${index}]`, seen));
  } else {
    for (const key of Object.keys(value)) {
      assertJsonValue(value[key], fieldPath ? `${fieldPath}.${key}` : key, seen);
    }
  }
  seen.delete(value);
}

/** Validate the caller-supplied fields as a bounded, pure-JSON object. */
function assertUsableFields(fields) {
  if (fields === null || typeof fields !== "object" || Array.isArray(fields)) {
    throw new SnapshotError(
      "invalid_fields",
      `fields must be a plain JSON object of the values read from the page, got ${
        Array.isArray(fields) ? "an array" : JSON.stringify(fields)?.slice(0, 80)
      }`
    );
  }
  assertJsonValue(fields, "", new Set());
  let text;
  try {
    text = JSON.stringify(fields);
  } catch (err) {
    throw new SnapshotError("fields_not_serializable", `fields could not be serialized as JSON: ${err.message}`);
  }
  const bytes = Buffer.byteLength(text ?? "", "utf8");
  if (bytes > MAX_FIELDS_BYTES) {
    throw new SnapshotError(
      "fields_too_large",
      `fields are ${bytes} bytes, over the ${MAX_FIELDS_BYTES}-byte limit — save fewer fields rather than a truncated snapshot`
    );
  }
  // The round trip guarantees the record holds exactly what a reader parses
  // back: no key order games, no values JSON would have rewritten.
  return JSON.parse(text);
}

/** ISO 8601 UTC → a filename-safe rendering (Windows forbids `:` and `\`). */
function fileTimestamp(iso) {
  return iso.replace(/[:.]/g, "-");
}

export class SnapshotStore {
  /**
   * @param {object} [deps]
   * @param {() => number} [deps.now] - injectable clock for tests; the capture
   *   timestamp is always host-minted, never supplied by a caller
   */
  constructor({ now = Date.now } = {}) {
    this._now = now;
  }

  /** The directory a URL's snapshots live in. */
  dir(url) {
    return snapshotUrlDir(urlHash(url));
  }

  /**
   * Write one snapshot. Sync on purpose: there is no async work in the path
   * (no rendering, no network) and every guard must have thrown before a byte
   * is written.
   *
   * @param {object} input
   * @param {string} input.name - the operator-facing name (slugified host-side)
   * @param {string} input.url - the page the fields were read from
   * @param {string} [input.title] - the page title
   * @param {object} input.fields - the fields the run extracted
   * @param {object} [input.metadata] - capture context (runId, conversationId, viewport)
   * @returns {object} the stored record, plus `path`, `fileName` and `size`
   */
  save({ name, url, title = "", fields, metadata = {} } = {}) {
    const { name: cleanName, slug } = assertUsableName(name);
    const cleanFields = assertUsableFields(fields);
    const normalizedHash = urlHash(url);
    if (typeof title === "string" && title.length > MAX_TITLE_LENGTH) {
      throw new SnapshotError(
        "title_too_long",
        `the page title is ${title.length} characters, over the ${MAX_TITLE_LENGTH}-character limit`
      );
    }
    const cleanTitle = typeof title === "string" ? title : "";

    const dir = snapshotUrlDir(normalizedHash);
    this._assertRoomForOneMore(dir);

    const record = {
      url: String(url).trim(),
      title: cleanTitle,
      name: cleanName,
      timestamp: new Date(this._now()).toISOString(),
      fields: cleanFields,
      metadata: { ...(metadata && typeof metadata === "object" ? metadata : {}), urlHash: normalizedHash }
    };

    let file = null;
    let filePath = null;
    for (let step = 0; step <= MAX_COLLISION_STEPS; step += 1) {
      // A same-millisecond second capture would otherwise overwrite the first;
      // advancing the HOST-minted capture time keeps the documented filename
      // shape and never destroys an earlier snapshot.
      const candidateTimestamp = new Date(Date.parse(record.timestamp) + step).toISOString();
      const candidatePath = path.join(dir, `${slug}-${fileTimestamp(candidateTimestamp)}.json`);
      if (!fs.existsSync(candidatePath)) {
        file = candidateTimestamp;
        filePath = candidatePath;
        break;
      }
    }
    if (!filePath) {
      throw new SnapshotError(
        "name_collision",
        `could not find a free filename for "${cleanName}" after ${MAX_COLLISION_STEPS} attempts`
      );
    }
    record.timestamp = file;

    const bytes = Buffer.from(JSON.stringify(record, null, 2), "utf8");
    try {
      ensureDir(dir);
      // `wx`: refuse to overwrite even if the existence check above raced.
      fs.writeFileSync(filePath, bytes, { flag: "wx" });
    } catch (err) {
      throw new SnapshotError(
        "storage_failed",
        `could not write the snapshot ${JSON.stringify(path.basename(filePath))}: ${err.message}`
      );
    }

    return { ...record, path: filePath, fileName: path.basename(filePath), size: bytes.length };
  }

  /**
   * Every stored snapshot, newest first. Tolerant by contract: an absent root
   * lists as empty, and a file that cannot be read or parsed is returned as an
   * entry marked invalid with its reason instead of being hidden or failing
   * the whole listing.
   *
   * @param {object} [filter]
   * @param {string} [filter.url] - only snapshots of this page (exact URL identity)
   * @param {string} [filter.namePattern] - substring, or a glob when it carries `*`/`?`,
   *   matched against the snapshot name and its filename
   */
  list({ url = null, namePattern = null } = {}) {
    const root = snapshotsRoot();
    let urlDirs;
    try {
      urlDirs = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      return []; // absent root: empty, never an error
    }
    const wantedHash = url ? urlHash(url) : null;
    const pattern = typeof namePattern === "string" && namePattern.trim() ? namePattern.trim() : null;
    const matchesPattern = pattern ? buildNameMatcher(pattern) : null;

    const entries = [];
    for (const dirent of urlDirs) {
      if (!dirent.isDirectory()) continue;
      if (wantedHash && dirent.name !== wantedHash) continue;
      const dir = path.join(root, dirent.name);
      let names;
      try {
        names = fs.readdirSync(dir);
      } catch (err) {
        entries.push({ valid: false, fileName: null, path: dir, reason: "unreadable", detail: err.message });
        continue;
      }
      for (const fileName of names) {
        if (!fileName.endsWith(".json")) continue;
        entries.push(this._describe(path.join(dir, fileName), fileName));
      }
    }

    const filtered = pattern
      ? entries.filter((entry) => {
          // An unreadable file cannot be ruled in or out, so it stays visible
          // (marked invalid) rather than being filtered away silently.
          if (!entry.valid) return true;
          return [entry.name, entry.fileName].some(
            (candidate) => typeof candidate === "string" && matchesPattern(candidate)
          );
        })
      : entries;

    filtered.sort((a, b) => {
      const at = a.timestamp || "";
      const bt = b.timestamp || "";
      if (at !== bt) return at < bt ? 1 : -1; // newest first; invalid (no timestamp) last
      return String(b.fileName).localeCompare(String(a.fileName));
    });
    return filtered;
  }

  /**
   * Load one snapshot, by name + URL or by absolute path.
   *
   * @param {object} ref
   * @param {string} [ref.name] - with `url`: the snapshot's name (newest capture wins)
   * @param {string} [ref.url]
   * @param {string} [ref.path] - an absolute path inside the snapshots root
   * @returns {object} the full record, plus `path`, `fileName` and `size`
   * @throws {SnapshotError} not_found / unreadable / invalid_json / unsafe_path
   */
  read(ref = {}) {
    const filePath = this._resolve(ref);
    return this._load(filePath);
  }

  /**
   * Delete one snapshot (same references as read) and prune its URL directory
   * once the last file under it is gone. Touches exactly one file.
   *
   * @returns {{removed: true, path: string, pruned: boolean}}
   */
  remove(ref = {}) {
    const filePath = this._resolve(ref);
    const dir = path.dirname(filePath);
    try {
      fs.unlinkSync(filePath);
    } catch (err) {
      throw new SnapshotError("delete_failed", `could not delete ${JSON.stringify(path.basename(filePath))}: ${err.message}`);
    }
    let pruned = false;
    try {
      fs.rmdirSync(dir); // fails with ENOTEMPTY while siblings remain — that is the answer we want
      pruned = true;
    } catch {
      // A directory that cannot be pruned is harmless; the file is gone, which
      // is what the caller asked for.
    }
    return { removed: true, path: filePath, pruned };
  }

  // --- internals ----------------------------------------------------------

  _assertRoomForOneMore(dir) {
    let count = 0;
    try {
      count = fs.readdirSync(dir).filter((n) => n.endsWith(".json")).length;
    } catch {
      return; // no directory yet: nothing to bound
    }
    if (count >= MAX_SNAPSHOTS_PER_URL) {
      throw new SnapshotError(
        "too_many_snapshots",
        `${path.basename(dir)} already holds ${MAX_SNAPSHOTS_PER_URL} snapshots — delete the stale ones before capturing more`
      );
    }
  }

  _describe(filePath, fileName) {
    let text;
    try {
      text = fs.readFileSync(filePath, "utf8");
    } catch (err) {
      return { valid: false, fileName, path: filePath, reason: "unreadable", detail: err.message };
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      return { valid: false, fileName, path: filePath, reason: "invalid_json", detail: err.message };
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { valid: false, fileName, path: filePath, reason: "invalid_json", detail: "the file is not a JSON object" };
    }
    return {
      valid: true,
      name: typeof parsed.name === "string" ? parsed.name : null,
      url: typeof parsed.url === "string" ? parsed.url : null,
      title: typeof parsed.title === "string" ? parsed.title : null,
      timestamp: typeof parsed.timestamp === "string" ? parsed.timestamp : null,
      path: filePath,
      fileName,
      size: Buffer.byteLength(text, "utf8")
    };
  }

  _load(filePath) {
    let text;
    try {
      text = fs.readFileSync(filePath, "utf8");
    } catch (err) {
      throw new SnapshotError("unreadable", `could not read ${JSON.stringify(filePath)}: ${err.message}`);
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      throw new SnapshotError("invalid_json", `${JSON.stringify(filePath)} is not valid JSON: ${err.message}`);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new SnapshotError("invalid_json", `${JSON.stringify(filePath)} does not hold a snapshot record`);
    }
    // Unknown top-level keys are carried through untouched: a record written
    // by a newer build must stay loadable by an older one.
    return { ...parsed, path: filePath, fileName: path.basename(filePath), size: Buffer.byteLength(text, "utf8") };
  }

  /** Resolve a caller reference to a file path inside the snapshots root, only. */
  _resolve({ name = null, url = null, path: refPath = null } = {}) {
    if (refPath != null) {
      if (typeof refPath !== "string" || !refPath.trim()) {
        throw new SnapshotError("invalid_ref", "the snapshot path must be a non-empty string");
      }
      const resolved = path.resolve(refPath.trim());
      if (!this._insideRoot(resolved)) {
        throw new SnapshotError("unsafe_path", `${JSON.stringify(refPath)} is outside the snapshots root`);
      }
      if (!fs.existsSync(resolved)) {
        throw new SnapshotError("not_found", `no snapshot file at ${JSON.stringify(resolved)}`);
      }
      return resolved;
    }

    if (url == null) throw new SnapshotError("missing_url", "a snapshot reference needs a URL (with a name) or a path");
    const dir = snapshotUrlDir(urlHash(url));
    if (name == null) throw new SnapshotError("missing_name", "a snapshot reference by URL also needs its name");
    const { slug } = assertUsableName(name);
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch {
      throw new SnapshotError("not_found", `no snapshots stored for ${JSON.stringify(String(url).trim())}`);
    }
    const candidates = names.filter((n) => n.endsWith(".json") && n.startsWith(`${slug}-`)).sort();
    if (!candidates.length) {
      throw new SnapshotError("not_found", `no snapshot named ${JSON.stringify(name)} for ${JSON.stringify(String(url).trim())}`);
    }
    // Several captures may share a name; the newest (greatest filename, whose
    // timestamp sorts lexicographically) is the one a bare name+url means.
    return path.join(dir, candidates[candidates.length - 1]);
  }

  _insideRoot(resolved) {
    const root = path.resolve(snapshotsRoot());
    const rel = path.relative(root, resolved);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return false;
    const parts = rel.split(path.sep);
    // Exactly <url-hash>/<file>.json — a get/delete must never address a file
    // from a different part of the agent tree that happens to sit under root.
    return parts.length === 2 && parts[1].endsWith(".json") && parts[0] !== "." && parts[0] !== "..";
  }
}

/** Substring by default; a glob when the pattern carries `*` or `?`. */
function buildNameMatcher(pattern) {
  const isGlob = /[*?]/.test(pattern);
  if (!isGlob) {
    const needle = pattern.toLowerCase();
    return (fileName) => fileName.toLowerCase().includes(needle);
  }
  const expression = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  const re = new RegExp(`^${expression}$`, "i");
  return (fileName) => re.test(fileName);
}
