// Generic page monitoring primitives. The background service worker owns the
// browser/CDP part; this module owns target validation, source adapters,
// normalization, comparison, and durable monitor records so those rules stay
// testable without Chrome.

export const PAGE_MONITOR_STORAGE_KEY = "browzy_page_monitors_v1";
export const DEFAULT_INTERVAL_DAYS = 7;
export const OBSERVED_JSON_SOURCE = "observed_json";
export const DOM_TEXT_SOURCE = "dom_text";
const MAX_MONITORS = 100;
const MAX_FIELDS_BYTES = 250_000;
const MONITOR_IDENTIFIER_PATTERN = /\b(?:IB|PL)\d{6,}(?:-\d+)?\b/gi;
const MONITOR_QUERY_IDENTIFIER_NAMES = new Set(["notifyno", "planno"]);

const VOLATILE_KEY = /^(?:request(?:id|time)?|trace(?:id)?|correlation(?:id)?|server(?:time)?|response(?:time)?|timestamp|page(?:number)?|pagesize|totalpages|sort(?:by)?|offset|limit)$/i;

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function stableStringify(value) {
  if (value === null) return "null";
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

function hashId(value) {
  let hash = 2166136261;
  for (const char of value) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return `page_${hash.toString(36)}`;
}

function normalizeString(value) {
  return value.trim().replace(/\s+/g, " ");
}

function normalizeMonitorIdentifier(value) {
  const text = normalizeString(String(value || "")).toUpperCase();
  if (!text || /^(?:UNDEFINED|NULL|N\/A)$/i.test(text)) return "";
  // MSC commonly renders a notice as IB...-00 while links and user requests
  // use the same notice without the display-only revision suffix.
  return text.replace(/-00$/, "");
}

function identifiersFromValue(value) {
  const text = typeof value === "string" ? value : String(value || "");
  const matches = text.match(MONITOR_IDENTIFIER_PATTERN) || [];
  return matches.map(normalizeMonitorIdentifier).filter(Boolean);
}

function queryIdentifiers(url) {
  if (!url) return [];
  try {
    const parsed = new URL(url);
    const result = [];
    for (const [name, value] of parsed.searchParams) {
      if (MONITOR_QUERY_IDENTIFIER_NAMES.has(name.toLowerCase())) result.push(...identifiersFromValue(value));
    }
    return result;
  } catch {
    return [];
  }
}

function labeledTextIdentifiers(text) {
  if (typeof text !== "string") return [];
  const result = [];
  const labels = [
    /Mã\s*TBMT\s*[:：-]?\s*([^\n|;,]+)/giu,
    /Mã\s*KHLCNT\s*[:：-]?\s*([^\n|;,]+)/giu
  ];
  for (const pattern of labels) {
    for (const match of text.matchAll(pattern)) result.push(...identifiersFromValue(match[1]));
  }
  return result;
}

export function extractMonitorIdentifiers({ identifier, url, pageUrl, pageText } = {}) {
  const all = [
    ...identifiersFromValue(identifier),
    ...queryIdentifiers(url),
    ...queryIdentifiers(pageUrl),
    ...labeledTextIdentifiers(pageText)
  ];
  return [...new Set(all)];
}

export function canonicalMonitorUrl(value) {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    for (const [name, current] of [...parsed.searchParams]) {
      if (!current || /^(?:undefined|null)$/i.test(current)) parsed.searchParams.delete(name);
    }
    parsed.search = [...parsed.searchParams]
      .sort(([leftName, leftValue], [rightName, rightValue]) => `${leftName}=${leftValue}`.localeCompare(`${rightName}=${rightValue}`))
      .map(([name, current]) => `${encodeURIComponent(name)}=${encodeURIComponent(current)}`)
      .join("&");
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return normalizeString(String(value));
  }
}

function normalizedValue(value) {
  if (typeof value === "string") return normalizeString(value);
  if (Array.isArray(value)) {
    // API result lists are commonly returned in an unstable order. Sorting
    // canonical values makes a monitor report business changes, not ordering
    // noise from the search backend.
    return value.map(normalizedValue).sort((a, b) => stableStringify(a).localeCompare(stableStringify(b)));
  }
  if (isPlainObject(value)) {
    const result = {};
    for (const key of Object.keys(value).sort()) {
      if (!VOLATILE_KEY.test(key)) result[key] = normalizedValue(value[key]);
    }
    return result;
  }
  return value;
}

function containsIdentifier(value, identifier) {
  if (!identifier) return false;
  const needle = identifier.toLowerCase();
  if (typeof value === "string") return value.toLowerCase().includes(needle);
  if (Array.isArray(value)) return value.some((item) => containsIdentifier(item, identifier));
  if (isPlainObject(value)) return Object.values(value).some((item) => containsIdentifier(item, identifier));
  return false;
}

function findSmallestMatchingRecord(value, identifier, path = "") {
  if (!identifier || (!Array.isArray(value) && !isPlainObject(value))) return null;
  const children = Array.isArray(value) ? value : Object.values(value);
  const nested = [];
  children.forEach((child, index) => {
    const childPath = Array.isArray(value) ? `${path}[${index}]` : `${path}.${Object.keys(value)[index]}`;
    const found = findSmallestMatchingRecord(child, identifier, childPath);
    if (found) nested.push(found);
  });
  if (nested.length) return nested.sort((a, b) => a.size - b.size)[0];
  if (containsIdentifier(value, identifier)) return { value, path: path || "$", size: stableStringify(value).length };
  return null;
}

export function normalizeMonitorTarget({ identifier, url, pageUrl, pageText, kind = "auto", source } = {}) {
  const cleanIdentifier = typeof identifier === "string" ? normalizeString(identifier) : "";
  const cleanUrl = typeof url === "string" ? url.trim() : "";
  const identifiers = extractMonitorIdentifiers({ identifier: cleanIdentifier, url: cleanUrl, pageUrl, pageText });
  const fallbackUrl = cleanUrl || (typeof pageUrl === "string" ? pageUrl.trim() : "");
  if (!cleanIdentifier && !fallbackUrl && !identifiers.length) throw new Error("page_monitor requires an identifier or URL");
  if (cleanIdentifier.length > 200) throw new Error("Monitor identifier is too long");
  if (fallbackUrl) {
    let parsed;
    try { parsed = new URL(fallbackUrl); } catch { throw new Error("Monitor URL is invalid"); }
    if (!/^https?:$/.test(parsed.protocol)) throw new Error("Monitor URL must use http or https");
  }
  const cleanKind = normalizeString(String(kind || "auto"));
  if (cleanKind.length > 80) throw new Error("Monitor kind is too long");
  const cleanSource = source === undefined ? null : normalizeString(String(source));
  if (cleanSource && cleanSource.length > 80) throw new Error("Monitor source is too long");
  return {
    identifier: cleanIdentifier || (identifiers[0] || null),
    identifiers,
    url: cleanUrl || fallbackUrl || null,
    canonicalUrl: canonicalMonitorUrl(cleanUrl || fallbackUrl),
    kind: cleanKind || "auto",
    source: cleanSource
  };
}

export function normalizeObservedJsonResponse(payload, target = {}) {
  let parsed = payload;
  if (typeof payload === "string") {
    try { parsed = JSON.parse(payload); } catch { throw new Error("Observed response body is not valid JSON"); }
  }
  if (parsed === null || typeof parsed !== "object") throw new Error("Observed response JSON is not an object or array");
  const match = findSmallestMatchingRecord(parsed, target.identifier, "$");
  const fields = normalizedValue(match ? match.value : parsed);
  const bytes = new TextEncoder().encode(JSON.stringify(fields)).byteLength;
  if (bytes > MAX_FIELDS_BYTES) throw new Error(`Monitor fields are ${bytes} bytes; narrow the target to one record`);
  return { fields, matchedPath: match?.path || "$" };
}

export function normalizeDomText(value) {
  const text = typeof value === "string" ? normalizeString(value) : normalizeString(String(value?.text || ""));
  if (!text) throw new Error("DOM/text source returned no text");
  return { fields: { text }, matchedPath: "$" };
}

/**
 * Create a source adapter for another page-monitor input, such as DOM/text.
 * The generic collector only needs `matches` and `normalize`; a future DOM
 * collector can provide its own records and call the same store/comparison
 * APIs without adding source-specific rules to the generic core.
 */
export function createMonitorSourceAdapter({ id, matches = () => true, normalize } = {}) {
  if (!id || typeof id !== "string") throw new Error("A monitor source adapter requires an id");
  if (typeof matches !== "function" || typeof normalize !== "function") throw new Error("A monitor source adapter requires matches and normalize functions");
  return Object.freeze({ id, matches, normalize });
}

export function createTextSourceAdapter({ id = DOM_TEXT_SOURCE, matches = () => false, normalize = normalizeDomText } = {}) {
  return createMonitorSourceAdapter({ id, matches, normalize });
}

export const observedJsonSource = createMonitorSourceAdapter({
  id: OBSERVED_JSON_SOURCE,
  normalize: normalizeObservedJsonResponse
});

export const domTextSource = createTextSourceAdapter();

// MSC is one source adapter. Its host restriction belongs here, rather than
// in the generic target/response normalization or storage code.
export const MSC_HOST = "muasamcong.mpi.gov.vn";

export function isMscUrl(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === MSC_HOST || host.endsWith(`.${MSC_HOST}`);
  } catch {
    return false;
  }
}

export const mscSource = createMonitorSourceAdapter({
  id: "msc",
  matches: (record) => isMscUrl(record?.url),
  normalize: normalizeObservedJsonResponse
});

export function getMonitorSource(target = {}) {
  if (target.source === DOM_TEXT_SOURCE) return domTextSource;
  if (target.source === mscSource.id || isMscUrl(target.url)) return mscSource;
  return observedJsonSource;
}

function valueType(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function walkDiff(oldValue, newValue, path, result) {
  const oldObject = isPlainObject(oldValue);
  const newObject = isPlainObject(newValue);
  if (oldObject && newObject) {
    const keys = new Set([...Object.keys(oldValue), ...Object.keys(newValue)]);
    for (const key of [...keys].sort()) {
      const childPath = path ? `${path}.${key}` : key;
      if (!(key in oldValue)) result.added.push({ path: childPath, value: newValue[key] });
      else if (!(key in newValue)) result.removed.push({ path: childPath, value: oldValue[key] });
      else walkDiff(oldValue[key], newValue[key], childPath, result);
    }
    return;
  }
  if (Array.isArray(oldValue) && Array.isArray(newValue)) {
    const length = Math.max(oldValue.length, newValue.length);
    for (let i = 0; i < length; i++) {
      const childPath = `${path}[${i}]`;
      if (i >= oldValue.length) result.added.push({ path: childPath, value: newValue[i] });
      else if (i >= newValue.length) result.removed.push({ path: childPath, value: oldValue[i] });
      else walkDiff(oldValue[i], newValue[i], childPath, result);
    }
    return;
  }
  if (stableStringify(oldValue) !== stableStringify(newValue)) {
    result.changed.push({ path: path || "$", old: oldValue, new: newValue, typeChanged: valueType(oldValue) !== valueType(newValue) });
  }
}

export function diffMonitorFields(baseline, current) {
  const result = { added: [], removed: [], changed: [] };
  walkDiff(baseline, current, "", result);
  return {
    ...result,
    summary: {
      added: result.added.length,
      removed: result.removed.length,
      changed: result.changed.length,
      total: result.added.length + result.removed.length + result.changed.length,
      hasChanges: result.added.length + result.removed.length + result.changed.length > 0
    }
  };
}

export function selectObservedResponse(responses, target = {}) {
  const cleanUrl = target.url ? target.url.replace(/#.*$/, "") : null;
  const identifier = target.identifier ? target.identifier.toLowerCase() : null;
  const candidates = (responses || []).filter((response) => response?.fields);
  if (!candidates.length) return null;
  return [...candidates].sort((a, b) => {
    const score = (item) => (cleanUrl && (item.url === cleanUrl || item.url.startsWith(`${cleanUrl}?`)) ? 4 : 0) + (identifier && String(item.body || "").toLowerCase().includes(identifier) ? 2 : 0);
    return score(b) - score(a) || (b.timestamp || 0) - (a.timestamp || 0);
  })[0];
}

function decodeBody(raw) {
  let body = raw?.body;
  if (raw?.base64Encoded && typeof body === "string") {
    const binary = atob(body);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    body = new TextDecoder().decode(bytes);
  }
  return body;
}

export async function collectObservedResponses(records, getBody, target = {}, source = observedJsonSource) {
  const result = [];
  for (const record of records || []) {
    if (!source.matches(record, target)) continue;
    if (target.url && record.url !== target.url && !record.url?.startsWith(`${target.url}?`)) continue;
    const body = decodeBody(await getBody(record));
    if (typeof body !== "string") continue;
    if (target.identifier && !body.toLowerCase().includes(target.identifier.toLowerCase()) && !record.url?.toLowerCase().includes(target.identifier.toLowerCase())) continue;
    try {
      const normalized = source.normalize(body, target);
      result.push({ ...record, body, source: source.id, fields: normalized.fields, matchedPath: normalized.matchedPath });
    } catch {
      // Pages make many non-JSON requests. Ignore unusable observations and
      // let the caller report that no matching source was found.
    }
  }
  return result;
}

function cleanRecord(record) {
  return JSON.parse(JSON.stringify(record));
}

function monitorTargetIdentifiers(target = {}) {
  const stored = Array.isArray(target.identifiers) ? target.identifiers : [];
  const patternIdentifiers = [
    ...stored.map(normalizeMonitorIdentifier).filter(Boolean),
    ...extractMonitorIdentifiers({ identifier: target.identifier, url: target.url })
  ];
  // Pattern extraction only recognizes known formats (e.g. MSC's IB/PL
  // notice numbers). A generic identifier-only target (no URL, no matching
  // pattern) would otherwise contribute no identifiers and no URL, leaving
  // monitorTargetKey with nothing stable to key or match on. Fall back to
  // the normalized identifier itself so it still anchors the identity key;
  // pattern-extracted identifiers take precedence when present.
  if (!patternIdentifiers.length && typeof target.identifier === "string" && target.identifier.trim()) {
    const fallback = normalizeMonitorIdentifier(target.identifier);
    if (fallback) patternIdentifiers.push(fallback);
  }
  return [...new Set(patternIdentifiers)].sort();
}

export function monitorTargetKey(target = {}) {
  const identifiers = monitorTargetIdentifiers(target);
  if (identifiers.length) return `identifiers:${identifiers.join("|")}`;
  const url = canonicalMonitorUrl(target.url || target.canonicalUrl);
  return url ? `url:${url}` : null;
}

function monitorTargetsMatch(left, right) {
  const leftIdentifiers = monitorTargetIdentifiers(left);
  const rightIdentifiers = monitorTargetIdentifiers(right);
  if (leftIdentifiers.length && rightIdentifiers.length) {
    return leftIdentifiers.some((identifier) => rightIdentifiers.includes(identifier));
  }
  return !leftIdentifiers.length && !rightIdentifiers.length && monitorTargetKey(left) === monitorTargetKey(right);
}

export class PageMonitorStore {
  constructor(storageArea) {
    this.storage = storageArea;
  }

  async _read() {
    const value = await this.storage.get(PAGE_MONITOR_STORAGE_KEY);
    return Array.isArray(value?.[PAGE_MONITOR_STORAGE_KEY]) ? value[PAGE_MONITOR_STORAGE_KEY] : [];
  }

  async _write(monitors) {
    await this.storage.set({ [PAGE_MONITOR_STORAGE_KEY]: monitors.slice(-MAX_MONITORS) });
  }

  async list() {
    return (await this._read()).map((monitor) => ({
      id: monitor.id,
      kind: monitor.kind,
      source: monitor.source || OBSERVED_JSON_SOURCE,
      identifier: monitor.target.identifier,
      url: monitor.target.url,
      identifiers: monitorTargetIdentifiers(monitor.target),
      intervalDays: monitor.intervalDays,
      createdAt: monitor.createdAt,
      lastCheckedAt: monitor.lastCheckedAt,
      dueAt: new Date(Date.parse(monitor.lastCheckedAt || monitor.baseline.capturedAt) + monitor.intervalDays * 86400000).toISOString(),
      lastResult: monitor.lastResult || null
    }));
  }

  async find({ id, target } = {}) {
    const monitors = await this._read();
    return monitors.find((monitor) => (id && monitor.id === id) || (target && monitorTargetsMatch(monitor.target, target))) || null;
  }

  async save({ target, response, intervalDays = DEFAULT_INTERVAL_DAYS, now = new Date() }) {
    if (!Number.isFinite(intervalDays) || intervalDays <= 0 || intervalDays > 365) throw new Error("intervalDays must be greater than 0 and at most 365");
    const monitors = await this._read();
    const source = response.source || target.source || OBSERVED_JSON_SOURCE;
    const identityKey = monitorTargetKey(target);
    if (!identityKey) throw new Error("page_monitor target has no stable identifier or URL");
    const existingIndex = monitors.findIndex((monitor) => monitorTargetsMatch(monitor.target, target));
    const id = existingIndex >= 0 ? monitors[existingIndex].id : hashId(identityKey);
    const createdAt = existingIndex >= 0 ? monitors[existingIndex].createdAt : now.toISOString();
    const identifiers = monitorTargetIdentifiers(target);
    const monitor = {
      id,
      kind: target.kind,
      source,
      // Keep the original target fields for display/debugging, but persist the
      // extracted aliases that make a later chat independent of URL spelling.
      target: { identifier: target.identifier, identifiers, url: target.url, canonicalUrl: canonicalMonitorUrl(target.url), source },
      intervalDays,
      createdAt,
      updatedAt: now.toISOString(),
      lastCheckedAt: null,
      lastResult: null,
      baseline: {
        capturedAt: now.toISOString(),
        sourceUrl: response.url,
        matchedPath: response.matchedPath,
        fields: cleanRecord(response.fields)
      }
    };
    if (existingIndex >= 0) monitors[existingIndex] = monitor;
    else monitors.push(monitor);
    await this._write(monitors);
    return monitor;
  }

  async recordCheck(id, result, now = new Date()) {
    const monitors = await this._read();
    const index = monitors.findIndex((monitor) => monitor.id === id);
    if (index < 0) throw new Error(`Page monitor ${id} was not found`);
    monitors[index] = { ...monitors[index], updatedAt: now.toISOString(), lastCheckedAt: now.toISOString(), lastResult: cleanRecord(result) };
    await this._write(monitors);
    return monitors[index];
  }

  async delete(id) {
    const monitors = await this._read();
    const next = monitors.filter((monitor) => monitor.id !== id);
    if (next.length === monitors.length) return false;
    await this._write(next);
    return true;
  }
}
