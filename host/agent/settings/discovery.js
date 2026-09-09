// Optional, paginated model discovery against the endpoint's Anthropic
// models API (design.md decision 4 / task 4.3).
//
// GET /v1/models?limit=&after_id= -> { data: [{id, display_name, ...}], has_more, last_id }
// (https://platform.claude.com/docs/en/api/typescript/models)
//
// "Unsupported discovery leaves manual models untouched" (spec, "Provider has
// no model listing"): a 404 here means the endpoint simply doesn't implement
// this API, which is not a compatibility failure — the caller keeps whatever
// manual models it already had. Any other failure (auth, rate limit,
// network) is a real, actionable error and is thrown rather than silently
// swallowed into "unsupported", so the UI can show the actual cause instead
// of a misleading "no models" result.

import { authenticatedFetch } from "./http-client.js";
import { ProviderError } from "./errors.js";

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGES = 50; // hard cap: a misbehaving/looping `has_more` must not hang discovery forever

function classifyStatus(status, body) {
  if (status === 401 || status === 403) {
    return new ProviderError("AUTH_ERROR", `discovery request rejected (HTTP ${status})`, { detail: { status, body } });
  }
  if (status === 429) {
    return new ProviderError("RATE_LIMIT_ERROR", "discovery request rate limited (HTTP 429)", { detail: { status, body } });
  }
  return new ProviderError("NETWORK_ERROR", `discovery request failed (HTTP ${status})`, { detail: { status, body } });
}

/**
 * @param {{ baseUrl: string, apiKey: string, fetchImpl?: typeof fetch, pageSize?: number, signal?: AbortSignal }} opts
 * @returns {Promise<{ supported: true, models: Array<{id:string,label:string}> } | { supported: false, reason: string }>}
 * @throws {ProviderError} for auth/rate-limit/network failures (real errors, not "unsupported")
 */
export async function discoverModels(opts) {
  const { baseUrl, apiKey, fetchImpl, pageSize = DEFAULT_PAGE_SIZE, signal } = opts;

  const models = [];
  let afterId;
  let pages = 0;

  for (;;) {
    pages++;
    if (pages > MAX_PAGES) {
      throw new ProviderError("NETWORK_ERROR", `model discovery exceeded ${MAX_PAGES} pages without terminating (has_more never became false)`);
    }

    const query = new URLSearchParams({ limit: String(pageSize) });
    if (afterId) query.set("after_id", afterId);

    const response = await authenticatedFetch(baseUrl, `/v1/models?${query}`, { apiKey, fetchImpl, signal });

    if (response.status === 404) {
      return { supported: false, reason: "the endpoint does not implement the Anthropic models listing API (HTTP 404)" };
    }
    if (!response.ok) {
      let body;
      try {
        body = await response.text();
      } catch {}
      throw classifyStatus(response.status, body);
    }

    let payload;
    try {
      payload = await response.json();
    } catch (err) {
      throw new ProviderError("PROTOCOL_ERROR", "model listing response was not valid JSON — endpoint is not Anthropic-Messages-API compatible", {
        cause: err
      });
    }
    if (!payload || !Array.isArray(payload.data)) {
      throw new ProviderError("PROTOCOL_ERROR", 'model listing response is missing a "data" array — endpoint is not Anthropic-Messages-API compatible');
    }

    for (const entry of payload.data) {
      if (!entry || typeof entry.id !== "string" || !entry.id.trim()) continue;
      const id = entry.id.trim();
      const label = typeof entry.display_name === "string" && entry.display_name.trim() ? entry.display_name.trim() : id;
      models.push({ id, label });
    }

    if (!payload.has_more) break;
    afterId = payload.last_id || (payload.data.length ? payload.data[payload.data.length - 1].id : undefined);
    if (!afterId) break; // no cursor to continue with; stop rather than loop forever
  }

  return { supported: true, models };
}
