// Pure, dependency-free classifier for URLs the SDK's built-in `WebFetch`
// tool is about to fetch (see host/agent/tools/query-options.js's `tools`/
// `allowedTools` comments — WebFetch is available but deliberately never
// auto-approved, precisely so every WebFetch call from the primary agent
// reaches `canUseTool` (host/agent/policy/can-use-tool.js), which calls
// `classifyWebFetchUrl()` here and denies before the fetch when the verdict
// says to). Whether a `Task`-spawned subagent's own WebFetch call is routed
// through this same parent `canUseTool` callback, or reaches the SDK's
// default permission path some other way, is NOT verified here — this
// file's contract only covers calls this project's own `canUseTool` sees.
//
// LIMITATION — read this before relying on it for more than the realistic
// case: this is a NAME-based check performed on the URL string BEFORE the
// fetch happens. It has no visibility into what WebFetch does after that —
// the SDK follows redirects internally, where this code cannot see them, and
// a public hostname can resolve (via DNS) to a private address. So a public
// URL that redirects to `127.0.0.1`, or plain DNS rebinding, defeats this
// check. It stops the realistic case this project actually cares about — a
// prompt-injected agent being talked into fetching
// `http://localhost:8080/admin` or a metadata endpoint directly — and it is
// NOT a security boundary against a determined attacker who controls DNS or
// a redirect target. Do not present it as more than that anywhere in this
// codebase.

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/**
 * @param {string} host - a hostname string, already known to match IPV4_RE.
 * @returns {number[]|null} the four octets as numbers, or null if any octet
 *   is out of the valid 0-255 range (e.g. "999.1.1.1" is not a real IPv4
 *   literal and is left to the "no dot" / ordinary-hostname path instead).
 */
function parseIPv4Octets(host) {
  const m = IPV4_RE.exec(host);
  if (!m) return null;
  const octets = [m[1], m[2], m[3], m[4]].map(Number);
  if (octets.some((n) => n > 255)) return null;
  return octets;
}

/** 127.0.0.0/8 */
function isLoopbackIPv4(octets) {
  return octets[0] === 127;
}

/** 0.0.0.0 exactly (the unspecified/"any" address, also used to reach the host from inside a container). */
function isUnspecifiedIPv4(octets) {
  return octets[0] === 0 && octets[1] === 0 && octets[2] === 0 && octets[3] === 0;
}

/** 10.0.0.0/8, 172.16.0.0/12 (172.16 through 172.31 ONLY, not 172.32+), 192.168.0.0/16 */
function isPrivateIPv4(octets) {
  const [a, b] = octets;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

/** 169.254.0.0/16 — link-local; this is also the cloud metadata endpoint range (e.g. 169.254.169.254). */
function isLinkLocalIPv4(octets) {
  return octets[0] === 169 && octets[1] === 254;
}

/**
 * The first 16-bit group of an IPv6 literal, e.g. "fe80" out of "fe80::1".
 * `hostname` is assumed lowercase already.
 */
function firstHextet(hostname) {
  const idx = hostname.indexOf(":");
  return idx === -1 ? hostname : hostname.slice(0, idx);
}

/** ::1 exactly — the IPv6 loopback address. */
function isLoopbackIPv6(hostname) {
  return hostname === "::1";
}

/**
 * fe80::/10 — IPv6 link-local. The first 10 bits fixed to 1111111010 means
 * the first hex group is always "fe8x"-"febx" (third nibble in 8-b), so
 * checking the first three characters plus a fourth in [89ab] is exact for
 * any address actually written with a full first group.
 */
function isLinkLocalIPv6(hostname) {
  return /^fe[89ab]/i.test(firstHextet(hostname));
}

/**
 * fc00::/7 — IPv6 unique local addresses. The first 7 bits fixed to
 * 1111110 means the first byte is 0xfc or 0xfd, i.e. the first group always
 * starts with "fc" or "fd".
 */
function isUniqueLocalIPv6(hostname) {
  return /^f[cd]/i.test(firstHextet(hostname));
}

/**
 * Classify a URL WebFetch is about to be asked to fetch.
 *
 * @param {string} urlString
 * @returns {{ allowed: boolean, reason: string }} `reason` is always a
 *   human-legible explanation, whether allowed or denied.
 */
export function classifyWebFetchUrl(urlString) {
  let url;
  try {
    url = new URL(String(urlString));
  } catch {
    return { allowed: false, reason: `URL does not parse: ${urlString}` };
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { allowed: false, reason: `scheme "${url.protocol}" is not http: or https:` };
  }

  const hostname = url.hostname.toLowerCase();

  if (hostname === "localhost") {
    return { allowed: false, reason: "hostname is localhost (loopback)" };
  }

  const ipv4 = parseIPv4Octets(hostname);
  if (ipv4) {
    if (isLoopbackIPv4(ipv4)) return { allowed: false, reason: `${hostname} is a loopback address (127.0.0.0/8)` };
    if (isUnspecifiedIPv4(ipv4)) return { allowed: false, reason: `${hostname} is the unspecified address (0.0.0.0)` };
    if (isPrivateIPv4(ipv4)) return { allowed: false, reason: `${hostname} is a private-network address (RFC 1918)` };
    if (isLinkLocalIPv4(ipv4)) return { allowed: false, reason: `${hostname} is a link-local address (169.254.0.0/16, includes the cloud metadata endpoint)` };
    return { allowed: true, reason: `${hostname} is a public IPv4 address` };
  }

  if (hostname.includes(":")) {
    // An IPv6 literal. Unlike an IPv4 literal, `URL.hostname` keeps the []
    // brackets around an IPv6 host (e.g. "[::1]") — strip them before
    // checking the address itself.
    const ipv6 = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
    if (isLoopbackIPv6(ipv6)) return { allowed: false, reason: "hostname is ::1 (IPv6 loopback)" };
    if (isLinkLocalIPv6(ipv6)) return { allowed: false, reason: `${ipv6} is an IPv6 link-local address (fe80::/10)` };
    if (isUniqueLocalIPv6(ipv6)) return { allowed: false, reason: `${ipv6} is an IPv6 unique-local address (fc00::/7)` };
    return { allowed: true, reason: `${ipv6} is a public IPv6 address` };
  }

  if (hostname.endsWith(".local") || hostname.endsWith(".internal")) {
    return { allowed: false, reason: `${hostname} ends in .local or .internal (mDNS/internal-only naming)` };
  }

  if (!hostname.includes(".")) {
    return { allowed: false, reason: `${hostname} is a bare hostname with no dot (looks like an intranet name)` };
  }

  return { allowed: true, reason: `${hostname} is an ordinary public hostname` };
}

/**
 * Pull the URL out of a WebFetch call's input.
 *
 * The SDK's documented WebFetch input uses `url`, but that field name could
 * not be verified against the pinned package's own type definitions, so the
 * obvious alternate spellings are checked too. Returning "" for "no URL I can
 * read" is deliberate: `classifyWebFetchUrl("")` denies, so a shape this code
 * does not understand fails CLOSED and says so, rather than silently allowing
 * every fetch through an unrecognised field.
 *
 * @param {object} input - the tool call's arguments
 * @returns {string}
 */
export function readWebFetchUrl(input) {
  return input?.url ?? input?.URL ?? input?.Url ?? input?.uri ?? input?.URI ?? "";
}

/**
 * A `PreToolUse` hook callback that denies a WebFetch to a loopback or
 * private address.
 *
 * WHY THIS EXISTS ALONGSIDE THE canUseTool BRANCH, rather than replacing it:
 * the two sit at different points in the SDK's permission pipeline, and only
 * one of them is a boundary.
 *
 *   hooks -> deny rules -> ask rules -> permission mode -> allow rules -> canUseTool
 *
 * `canUseTool` is LAST, and the SDK's own permissions documentation states
 * that "auto-approved tools never reach canUseTool" and that for "checks that
 * must run on every tool call, use a PreToolUse hook: hooks run before every
 * other step, and a hook deny applies even in bypassPermissions mode".
 * So the canUseTool branch is correct today only because WebFetch is kept out
 * of `allowedTools` and no blanket `permissionMode` is set — two conditions a
 * future edit could quietly break. This hook does not depend on either.
 *
 * Same limitation as the classifier it calls: name-based, evaluated before the
 * request, and blind to redirects the SDK follows internally. It stops a
 * prompt-injected agent talked into fetching http://localhost:8080/admin. It
 * is not a defence against an attacker who controls DNS or a redirect target.
 *
 * @param {object} deps
 * @param {(line: string) => void} [deps.log] - optional sink for one line per
 *   denial. Also records `agent_id` when the SDK populates it, which is the
 *   only runtime evidence available that this hook fires inside a `Task`
 *   subagent — documented as implied but never stated outright.
 * @returns {Function} a HookCallback: (input, toolUseID, ctx) => Promise<object>
 */
export function createWebFetchPreToolUseHook({ log } = {}) {
  return async function webFetchPreToolUse(input) {
    // Everything is wrapped: the SDK's hooks documentation warns to "catch
    // errors inside your hook instead of letting them propagate, since an
    // unhandled exception can interrupt the agent". A throw here is NOT a
    // denial — it is a broken run — so the catch fails closed instead.
    try {
      const verdict = classifyWebFetchUrl(readWebFetchUrl(input?.tool_input));
      if (verdict.allowed) return {};
      if (log) {
        const where = input?.agent_id ? ` (subagent ${input.agent_id})` : "";
        log(`[webfetch-guard] denied${where}: ${verdict.reason}`);
      }
      return {
        hookSpecificOutput: {
          // Echoed from the input rather than hardcoded, per the SDK's own
          // example. The older `{ decision: "block", reason }` form is
          // documented as deprecated in favour of this one.
          hookEventName: input?.hook_event_name || "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: verdict.reason
        }
      };
    } catch (err) {
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: `WebFetch URL could not be checked, so it was refused: ${err && err.message}`
        }
      };
    }
  };
}
