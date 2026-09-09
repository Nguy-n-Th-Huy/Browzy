// Base URL normalization and validation (design.md decision 4).
//
// A profile's Base URL is "an origin with optional gateway prefix". This
// module is the single place that decides whether a user-entered string is
// an acceptable Base URL, and — when it is — what canonical string gets
// stored and used for every downstream call (discovery, capability test,
// `snapshotForRun`'s ANTHROPIC_BASE_URL).
//
// Rules (see specs/agent-settings/spec.md, "Invalid or partial profile"):
//   - must parse as an absolute URL
//   - no userinfo (`user:pass@host`)
//   - no query string
//   - no fragment
//   - HTTPS required, EXCEPT plain HTTP to an explicit loopback host
//     (localhost / 127.0.0.1 / ::1) — the documented allowance for local
//     development gateways
//   - trailing slash is normalized away
//   - a terminal `/v1` path segment is stripped: ANTHROPIC_BASE_URL is the
//     prefix the SDK itself appends `/v1/...` to, so storing a Base URL that
//     already ends in `/v1` would double it (`/v1/v1/messages`) the moment
//     any client (this module's own discovery/capability-test HTTP calls,
//     or the SDK's own transport) appends the version segment itself.

export class InvalidBaseUrlError extends Error {
  /**
   * @param {string} reason
   * @param {string} input
   */
  constructor(reason, input) {
    super(reason);
    this.name = "InvalidBaseUrlError";
    this.code = "INVALID_BASE_URL";
    this.input = input;
  }
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/**
 * @param {string} hostname (URL#hostname — already lowercase, brackets
 *   stripped for IPv6 by the URL parser)
 * @returns {boolean}
 */
function isLoopbackHost(hostname) {
  return LOOPBACK_HOSTS.has(hostname) || hostname === "0.0.0.0";
}

/**
 * Validate and normalize a user-entered Base URL.
 *
 * @param {string} raw
 * @returns {{ normalized: string, isLoopbackHttp: boolean }}
 * @throws {InvalidBaseUrlError}
 */
export function normalizeBaseUrl(raw) {
  if (typeof raw !== "string" || !raw.trim()) {
    throw new InvalidBaseUrlError("Base URL is required", raw);
  }
  const trimmed = raw.trim();

  let url;
  try {
    url = new URL(trimmed);
  } catch {
    throw new InvalidBaseUrlError("Base URL is not a valid absolute URL", raw);
  }

  if (url.username || url.password) {
    throw new InvalidBaseUrlError("Base URL must not contain userinfo (a username or password)", raw);
  }
  if (url.search) {
    throw new InvalidBaseUrlError("Base URL must not contain a query string", raw);
  }
  if (url.hash) {
    throw new InvalidBaseUrlError("Base URL must not contain a fragment", raw);
  }

  const isLoopbackHttp = url.protocol === "http:" && isLoopbackHost(url.hostname);
  if (url.protocol !== "https:" && !isLoopbackHttp) {
    throw new InvalidBaseUrlError(
      "Base URL must use HTTPS (plain HTTP is only allowed for an explicit localhost/127.0.0.1 development endpoint)",
      raw
    );
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new InvalidBaseUrlError(`unsupported URL scheme "${url.protocol}"`, raw);
  }

  // Strip a trailing slash, then strip a single terminal "/v1" segment so
  // callers that append "/v1/..." themselves never produce "/v1/v1/...".
  let pathname = url.pathname.replace(/\/+$/, "");
  if (pathname === "/v1") {
    pathname = "";
  } else if (pathname.endsWith("/v1")) {
    pathname = pathname.slice(0, -"/v1".length);
  }

  const port = url.port ? `:${url.port}` : "";
  const normalized = `${url.protocol}//${url.hostname}${port}${pathname}`;

  return { normalized, isLoopbackHttp };
}

/**
 * @param {string} raw
 * @returns {{ ok: true, normalized: string } | { ok: false, error: string }}
 *   Non-throwing wrapper for UI-facing field validation.
 */
export function tryNormalizeBaseUrl(raw) {
  try {
    const { normalized } = normalizeBaseUrl(raw);
    return { ok: true, normalized };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/** The documented initial default (design.md decision 4). */
export const DEFAULT_BASE_URL = "https://api.anthropic.com";
