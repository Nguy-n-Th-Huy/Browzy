// Reading a document that is not the page the run is driving (spec
// `typesafe-jev-provider`, "A run may consult sources beyond the page it
// drives").
//
// This is deliberately NOT a browser action. Nothing navigates, nothing is
// clicked, no tab opens, no page renders, no script runs, and no dispatch
// passes through the run's action path — so none of the run's dispatch
// discipline applies here, because there is nothing to dispatch. What this
// module does is read a public document over HTTP and hand back bounded text.
//
// Everything below is a guard, and each one closes a specific hole:
//
//   scheme      only http/https. `file:`, `data:`, `chrome-extension:` and the
//               rest are not documents on the web, and a couple of them read
//               the operator's disk.
//   address     loopback, link-local, and the private ranges are refused —
//               RESOLVED, not merely as written. The companion runs on the
//               operator's own machine, beside their router, their NAS and
//               whatever else answers on the LAN; `http://192.168.1.1/` is not
//               a source, and neither is a hostname that resolves to it.
//   redirects   capped, and EVERY hop re-checked against the same rules. A
//               public URL that 302s to 127.0.0.1 is the classic way past a
//               check performed once, at the start.
//   size        capped while reading, not after. A cap applied to a body
//               already in memory is decoration.
//   time        capped, so a slow server cannot hold a run open.
//   type        text-bearing content types only. A PDF or an image is not text
//               this path can honestly extract, and pretending otherwise puts
//               mojibake in front of the model.
//   credentials none. No cookies, no authorization, no session: the run is
//               reading a public document, not acting as the operator.
//
// What comes back is untrusted data on exactly the terms page text is. The
// caller treats it as material for an answer — it can never authorize an
// action, change configuration, alter a run's outcome, or direct the loop.

import dns from "node:dns/promises";
import net from "node:net";

export const MAX_SOURCE_BYTES = 512 * 1024;
export const MAX_SOURCE_TEXT_CHARS = 20000;
export const MAX_REDIRECTS = 3;
export const DEFAULT_FETCH_TIMEOUT_MS = 10_000;

// Content types this path can turn into text honestly. Anything else is
// refused by name rather than decoded into noise.
const TEXT_CONTENT_TYPES = [
  "text/html",
  "text/plain",
  "text/markdown",
  "application/xhtml+xml",
  "application/json",
  "application/xml",
  "text/xml"
];

/** The failure codes a caller may act on. Never a bare string. */
export const SOURCE_FETCH_CODES = Object.freeze([
  "INVALID_URL",
  "BLOCKED_ADDRESS",
  "TOO_MANY_REDIRECTS",
  "UNSUPPORTED_CONTENT",
  "TOO_LARGE",
  "TIMEOUT",
  "NETWORK_ERROR",
  "HTTP_ERROR"
]);

export class SourceFetchError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "SourceFetchError";
    this.code = code;
  }
}

/**
 * Is this literal address one the companion must never reach out to? Covers
 * loopback, link-local, the RFC1918 ranges, unique-local IPv6, and the
 * unspecified addresses. IPv4-mapped IPv6 (`::ffff:10.0.0.1`) is unwrapped
 * first, because that is the same address wearing a different hat.
 */
export function isBlockedAddress(address) {
  const raw = String(address ?? "").trim().toLowerCase();
  if (!raw) return true;
  const unmapped = raw.startsWith("::ffff:") ? raw.slice("::ffff:".length) : raw;
  const version = net.isIP(unmapped);
  if (version === 4) {
    const parts = unmapped.split(".").map((n) => Number(n));
    if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
    const [a, b] = parts;
    if (a === 0 || a === 127) return true; // unspecified, loopback
    if (a === 10) return true; // RFC1918
    if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
    if (a === 192 && b === 168) return true; // RFC1918
    if (a === 169 && b === 254) return true; // link-local (and cloud metadata)
    if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
    if (a >= 224) return true; // multicast and reserved
    return false;
  }
  if (version === 6) {
    if (unmapped === "::" || unmapped === "::1") return true; // unspecified, loopback
    if (unmapped.startsWith("fe80")) return true; // link-local
    if (unmapped.startsWith("fc") || unmapped.startsWith("fd")) return true; // unique-local
    return false;
  }
  // Not an IP literal at all: the caller resolves the hostname and checks the
  // answers. Saying "blocked" here would refuse every hostname.
  return false;
}

/**
 * Every address a hostname resolves to must be allowed — one bad answer is
 * enough to refuse, because which one the socket picks is not ours to decide.
 */
async function assertHostAllowed(hostname, resolver) {
  if (net.isIP(hostname)) {
    if (isBlockedAddress(hostname)) {
      throw new SourceFetchError("BLOCKED_ADDRESS", `the address ${hostname} is not a public one; nothing was read`);
    }
    return;
  }
  let answers;
  try {
    answers = await (resolver ?? dns.lookup)(hostname, { all: true });
  } catch (err) {
    throw new SourceFetchError("NETWORK_ERROR", `the host ${hostname} could not be resolved (${err?.message ?? String(err)})`);
  }
  const list = Array.isArray(answers) ? answers : [answers];
  if (list.length === 0) {
    throw new SourceFetchError("NETWORK_ERROR", `the host ${hostname} resolved to no address`);
  }
  for (const entry of list) {
    const address = typeof entry === "string" ? entry : entry?.address;
    if (isBlockedAddress(address)) {
      throw new SourceFetchError("BLOCKED_ADDRESS", `the host ${hostname} resolves to a non-public address; nothing was read`);
    }
  }
}

/** An absolute http(s) URL, or a named refusal. Never a guess. */
export function parseSourceUrl(raw) {
  let url;
  try {
    url = new URL(String(raw ?? "").trim());
  } catch {
    throw new SourceFetchError("INVALID_URL", `"${raw}" is not an absolute URL; nothing was read`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new SourceFetchError("INVALID_URL", `the ${url.protocol} scheme is not a document this can read; nothing was read`);
  }
  return url;
}

/** Is this response body something this path can turn into text? */
export function isTextContentType(contentType) {
  const value = String(contentType ?? "").split(";")[0].trim().toLowerCase();
  if (!value) return false;
  return TEXT_CONTENT_TYPES.includes(value);
}

/**
 * HTML to readable text, bounded. Deliberately small: script and style
 * contents go first (they are code, not prose), then tags, then entities and
 * whitespace. This is the same job `page_snapshot` does far better inside a
 * real document; here there is no DOM, and a fetched source is supporting
 * material rather than the page the run is driving.
 */
export function extractText(body, contentType) {
  const raw = String(body ?? "");
  const type = String(contentType ?? "").toLowerCase();
  const isMarkup = type.includes("html") || type.includes("xml");
  const text = isMarkup
    ? raw
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/gi, " ")
        .replace(/&amp;/gi, "&")
        .replace(/&lt;/gi, "<")
        .replace(/&gt;/gi, ">")
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, "'")
    : raw;
  return text.replace(/[ \t\r\f\v]+/g, " ").replace(/\n{3,}/g, "\n\n").trim().slice(0, MAX_SOURCE_TEXT_CHARS);
}

/**
 * Read one source. Resolves to `{url, finalUrl, title, text, bytes}`, or
 * throws a `SourceFetchError` whose code names which guard refused it.
 *
 * Redirects are followed by hand — one hop at a time, each re-checked — rather
 * than by `redirect: "follow"`, which would resolve the chain inside fetch
 * where no check can see it.
 *
 * @param {object} opts
 * @param {string} opts.url
 * @param {Function} [opts.fetchImpl] - injectable for tests
 * @param {Function} [opts.resolver] - injectable DNS lookup for tests
 * @param {number} [opts.timeoutMs]
 */
export async function fetchSource({ url, fetchImpl, resolver, timeoutMs = DEFAULT_FETCH_TIMEOUT_MS }) {
  const doFetch = fetchImpl ?? globalThis.fetch;
  if (typeof doFetch !== "function") {
    throw new SourceFetchError("NETWORK_ERROR", "no fetch implementation is available; nothing was read");
  }
  const startedUrl = parseSourceUrl(url);
  let current = startedUrl;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));

  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      await assertHostAllowed(current.hostname, resolver);
      let response;
      try {
        response = await doFetch(current.toString(), {
          method: "GET",
          redirect: "manual",
          // No credential of the operator's: this reads a public document.
          credentials: "omit",
          headers: { Accept: "text/html,text/plain;q=0.9,*/*;q=0.1" },
          signal: controller.signal
        });
      } catch (err) {
        if (err?.name === "AbortError") {
          throw new SourceFetchError("TIMEOUT", `reading ${current.host} took longer than the allowed time; nothing was read`);
        }
        throw new SourceFetchError("NETWORK_ERROR", `reading ${current.host} failed (${err?.message ?? String(err)})`);
      }

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers?.get?.("location");
        if (!location) {
          throw new SourceFetchError("HTTP_ERROR", `${current.host} answered ${response.status} without a location; nothing was read`);
        }
        if (hop === MAX_REDIRECTS) {
          throw new SourceFetchError("TOO_MANY_REDIRECTS", `${startedUrl.host} redirected more than ${MAX_REDIRECTS} times; nothing was read`);
        }
        // Resolved against the CURRENT url, then re-checked from the top of the
        // loop — a relative Location is still a new destination.
        current = parseSourceUrl(new URL(location, current).toString());
        continue;
      }

      if (!response.ok) {
        throw new SourceFetchError("HTTP_ERROR", `${current.host} answered ${response.status}; nothing was read`);
      }

      const contentType = response.headers?.get?.("content-type") ?? "";
      if (!isTextContentType(contentType)) {
        throw new SourceFetchError(
          "UNSUPPORTED_CONTENT",
          `${current.host} answered with ${contentType || "no content type"}, which is not text this can read; nothing was read`
        );
      }

      const declared = Number(response.headers?.get?.("content-length"));
      if (Number.isFinite(declared) && declared > MAX_SOURCE_BYTES) {
        throw new SourceFetchError("TOO_LARGE", `${current.host} declared ${declared} bytes, over the ${MAX_SOURCE_BYTES} limit; nothing was read`);
      }

      const body = await readBounded(response, current);
      const text = extractText(body, contentType);
      return {
        url: startedUrl.toString(),
        finalUrl: current.toString(),
        title: titleOf(body, contentType),
        text,
        bytes: Buffer.byteLength(body, "utf8")
      };
    }
    throw new SourceFetchError("TOO_MANY_REDIRECTS", `${startedUrl.host} redirected more than ${MAX_REDIRECTS} times; nothing was read`);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Read the body, stopping AT the limit rather than after it. A server that
 * declares nothing (or lies) is bounded by this, not by content-length.
 */
async function readBounded(response, current) {
  const stream = response.body;
  if (!stream || typeof stream.getReader !== "function") {
    // No stream (an injected fetch in a test, or a runtime without one): the
    // text is already in memory, so the bound is applied to it directly.
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > MAX_SOURCE_BYTES) {
      throw new SourceFetchError("TOO_LARGE", `${current.host} sent more than ${MAX_SOURCE_BYTES} bytes; nothing was read`);
    }
    return text;
  }
  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8");
  let size = 0;
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_SOURCE_BYTES) {
      try {
        await reader.cancel();
      } catch {
        // The read is already being abandoned; a cancel that fails changes
        // nothing about the refusal below.
      }
      throw new SourceFetchError("TOO_LARGE", `${current.host} sent more than ${MAX_SOURCE_BYTES} bytes; nothing was read`);
    }
    out += decoder.decode(value, { stream: true });
  }
  return out + decoder.decode();
}

/** The document's own title where it has one — a label for the operator, bounded. */
function titleOf(body, contentType) {
  if (!String(contentType ?? "").toLowerCase().includes("html")) return "";
  const match = String(body ?? "").match(/<title[^>]*>([\s\S]{0,300}?)<\/title>/i);
  return match ? match[1].replace(/\s+/g, " ").trim().slice(0, 200) : "";
}
