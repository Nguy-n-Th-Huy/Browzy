// A small, redirect-safe HTTP client shared by model discovery and the
// capability-test preflight.
//
// design.md decision 4 / spec requirement: "Reject cross-origin redirects for
// authenticated requests." Every request this client makes carries the
// provider credential (`x-api-key`), so every redirect is inspected before
// being followed: same-origin redirects are followed (capped, to avoid a
// redirect loop hanging a bounded test), any redirect to a different origin
// is rejected outright — the credential is never sent to the redirect
// target.
//
// This also centralizes the "x-api-key" header semantics requirement: this
// client only ever sends `x-api-key`. It never falls back to
// `Authorization: Bearer` — a Bearer-only gateway simply fails
// authentication here, which is reported as AUTH_ERROR (or, when detectable,
// a distinct incompatibility) rather than silently switched to work.

import { ProviderError, classifyNetworkError } from "./errors.js";

const MAX_REDIRECTS = 5;
const ANTHROPIC_VERSION = "2023-06-01";

/**
 * @param {string} baseUrl normalized base URL (see url.js)
 * @param {string} apiPath e.g. "/v1/models"
 * @param {{
 *   apiKey: string,
 *   method?: string,
 *   body?: unknown,
 *   headers?: Record<string,string>,
 *   signal?: AbortSignal,
 *   fetchImpl?: typeof fetch
 * }} opts
 * @returns {Promise<Response>}
 * @throws {ProviderError} REDIRECT_REJECTED for a cross-origin redirect,
 *   NETWORK_ERROR/TIMEOUT_ERROR for a transport-level failure.
 */
export async function authenticatedFetch(baseUrl, apiPath, opts) {
  const { apiKey, method = "GET", body, headers = {}, signal, fetchImpl = fetch } = opts;

  let currentUrl = new URL(apiPath, baseUrl).toString();
  const originOrigin = new URL(baseUrl).origin;

  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
    let response;
    try {
      response = await fetchImpl(currentUrl, {
        method,
        redirect: "manual",
        signal,
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": ANTHROPIC_VERSION,
          accept: "application/json",
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
          ...headers
        },
        body: body !== undefined ? JSON.stringify(body) : undefined
      });
    } catch (err) {
      if (err && err.name === "AbortError") {
        throw new ProviderError("TIMEOUT_ERROR", "request aborted (deadline exceeded)", { cause: err });
      }
      throw classifyNetworkError(err);
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) {
        // A redirect status with no Location is not a followable redirect;
        // treat the response as-is rather than guessing a target.
        return response;
      }
      let target;
      try {
        target = new URL(location, currentUrl);
      } catch {
        throw new ProviderError("NETWORK_ERROR", `redirect Location header is not a valid URL: ${location}`);
      }
      if (target.origin !== originOrigin) {
        throw new ProviderError(
          "REDIRECT_REJECTED",
          `refusing to follow a cross-origin redirect for an authenticated request (${originOrigin} -> ${target.origin})`,
          { detail: { from: originOrigin, to: target.origin } }
        );
      }
      currentUrl = target.toString();
      continue; // same-origin: follow it, credential stays scoped to this origin
    }

    return response;
  }

  throw new ProviderError("NETWORK_ERROR", `too many redirects (> ${MAX_REDIRECTS}) resolving ${apiPath}`);
}
