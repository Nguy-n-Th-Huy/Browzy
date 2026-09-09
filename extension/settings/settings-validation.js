// Client-side mirror of host/agent/settings/url.js and
// host/agent/settings/models.js — kept behavior-identical so the settings
// page can show instant field-level feedback without a round trip to the
// companion, per design.md decision 4 ("Invalid or partial profile: ...
// field-level errors prevent saving").
//
// This is intentionally a DUPLICATE, not a shared import: the extension page
// and the Node-side host module ship in separate bundles with no shared
// module path between them (extension pages cannot import Node's `host/`
// tree). The host module remains the single source of truth and the final
// authority — the companion re-validates on every save/testCapability call
// regardless of what this file decides, so a divergence here can only ever
// make the UI too strict or too lenient about showing an error a moment
// early, never let an actually-invalid profile reach disk unvalidated.
//
// Keep in sync with host/agent/settings/url.js and
// host/agent/settings/models.js if either changes.

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

function isLoopbackHost(hostname) {
  return LOOPBACK_HOSTS.has(hostname) || hostname === "0.0.0.0";
}

/**
 * @param {string} raw
 * @returns {{ ok: true, normalized: string, isLoopbackHttp: boolean } | { ok: false, error: string }}
 */
export function validateBaseUrl(raw) {
  if (typeof raw !== "string" || !raw.trim()) {
    return { ok: false, error: "Base URL is required" };
  }
  const trimmed = raw.trim();

  let url;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, error: "Base URL is not a valid absolute URL" };
  }

  if (url.username || url.password) {
    return { ok: false, error: "Base URL must not contain userinfo (a username or password)" };
  }
  if (url.search) {
    return { ok: false, error: "Base URL must not contain a query string" };
  }
  if (url.hash) {
    return { ok: false, error: "Base URL must not contain a fragment" };
  }

  const isLoopbackHttp = url.protocol === "http:" && isLoopbackHost(url.hostname);
  if (url.protocol !== "https:" && !isLoopbackHttp) {
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      return { ok: false, error: `unsupported URL scheme "${url.protocol}"` };
    }
    return {
      ok: false,
      error: "Base URL must use HTTPS (plain HTTP is only allowed for an explicit localhost/127.0.0.1 development endpoint)"
    };
  }

  let pathname = url.pathname.replace(/\/+$/, "");
  if (pathname === "/v1") {
    pathname = "";
  } else if (pathname.endsWith("/v1")) {
    pathname = pathname.slice(0, -"/v1".length);
  }
  const port = url.port ? `:${url.port}` : "";
  const normalized = `${url.protocol}//${url.hostname}${port}${pathname}`;

  return { ok: true, normalized, isLoopbackHttp };
}

export const DEFAULT_BASE_URL = "https://api.anthropic.com";

/**
 * @param {Array<{id:string,label:string}>} models
 * @param {string|null} defaultModelId
 * @returns {{ ok: true, models: Array<{id:string,label:string}>, defaultModelId: string|null } | { ok: false, error: string }}
 */
export function validateModelsList(models, defaultModelId) {
  if (!Array.isArray(models)) {
    return { ok: false, error: "models must be an array" };
  }
  if (models.length === 0) {
    if (defaultModelId !== null && defaultModelId !== undefined && defaultModelId !== "") {
      return { ok: false, error: "defaultModelId must be empty when the model list is empty" };
    }
    return { ok: true, models: [], defaultModelId: null };
  }

  const cleaned = [];
  const seenIds = new Set();
  for (const [index, entry] of models.entries()) {
    if (!entry || typeof entry !== "object") {
      return { ok: false, error: `model at index ${index} must be an object with id/label` };
    }
    const id = typeof entry.id === "string" ? entry.id.trim() : "";
    const label = typeof entry.label === "string" ? entry.label.trim() : "";
    if (!id) {
      return { ok: false, error: `model at index ${index} has an empty id` };
    }
    if (!label) {
      return { ok: false, error: `model "${id}" has an empty label` };
    }
    if (seenIds.has(id)) {
      return { ok: false, error: `duplicate model id "${id}"` };
    }
    seenIds.add(id);
    cleaned.push({ id, label });
  }

  const trimmedDefault = typeof defaultModelId === "string" ? defaultModelId.trim() : "";
  if (!trimmedDefault) {
    return { ok: false, error: "a default model is required when the model list is nonempty" };
  }
  if (!seenIds.has(trimmedDefault)) {
    return { ok: false, error: `default model id "${trimmedDefault}" does not reference a model in the list` };
  }

  return { ok: true, models: cleaned, defaultModelId: trimmedDefault };
}

/**
 * An API key must be plain ASCII — every provider issues one, and the HTTP
 * header it goes into cannot carry anything else.
 *
 * This is not a style rule. A key pasted from a chat message, a PDF or a web
 * page routinely arrives with a smart quote, an en dash, a non-breaking space
 * or a zero-width character embedded in it, all of which are invisible in a
 * password field. The endpoint then refuses the request, the host classifies
 * the refusal as a generic NETWORK_ERROR, and the settings page tells the
 * operator to check their Base URL, TLS certificate and network connection —
 * about a key with a curly apostrophe in it. Catching it at the point of
 * paste, and naming the character and its position, is the difference between
 * a five-second fix and an afternoon of network debugging.
 *
 * @param {string} raw
 * @returns {{ ok: true, normalized: string } | { ok: false, error: string }}
 */
export function validateApiKey(raw) {
  if (typeof raw !== "string" || !raw.trim()) {
    return { ok: false, error: "API key là bắt buộc" };
  }
  const trimmed = raw.trim();
  for (let i = 0; i < trimmed.length; i++) {
    const code = trimmed.codePointAt(i);
    // Printable ASCII only: anything below 0x20 is a control character (a
    // stray newline from a wrapped paste), anything above 0x7e is non-ASCII.
    if (code >= 0x20 && code <= 0x7e) continue;
    const hex = code.toString(16).toUpperCase().padStart(4, "0");
    return {
      ok: false,
      // Position is 1-based to match how the endpoint itself reports it.
      error:
        `API key chứa ký tự không phải ASCII ở vị trí ${i + 1} (U+${hex}). ` +
        "Thường là dấu nháy cong, gạch ngang dài, khoảng trắng không ngắt hoặc ký tự ẩn dính theo khi copy. " +
        "Hãy copy lại key từ nguồn gốc, hoặc gõ tay."
    };
  }
  return { ok: true, normalized: trimmed };
}
