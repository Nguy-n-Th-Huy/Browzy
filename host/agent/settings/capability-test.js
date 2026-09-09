// Bounded synthetic capability test (design.md decision 4 / task 4.3).
//
// Verifies, with synthetic content only (never real tab content), that the
// configured endpoint/model can complete three things a real conversation
// will need: streaming text, a structured tool round trip, and image input.
// Each is reported separately so a text-only gateway can be identified as
// such instead of being reported as fully compatible.
//
// This runs the REAL `@anthropic-ai/claude-agent-sdk` `query()` against the
// configured Base URL — the same wire protocol
// (`POST {baseUrl}/v1/messages`, Anthropic Messages API SSE) the product's
// real sessions will use — rather than a hand-rolled HTTP client, so a pass
// here is evidence the actual SDK transport is compatible, not just that a
// bespoke test client can talk to the endpoint.
//
// Budgets (spec): up to 60s for the runtime to cold-start (observed as the
// `system`/`init` message — see reports/04-settings-evidence.md for the
// empirical trace of what the bundled CLI actually sends), then a 30s
// provider-test deadline for the rest, max 3 turns per sub-test. The SDK's
// own HTTP transport retries almost every error (401, 429, connection
// refused — all observed empirically) with slow, growing backoff, which
// would blow past a 30-second budget by itself; this module does not wait
// for that exhaustion. It classifies the FIRST retry/error signal it sees on
// the message stream and aborts immediately, which is both faster and more
// deterministic than waiting out the SDK's own retry policy.

import { ProviderError } from "./errors.js";
import { recordAdvertisedCommands } from "./advertised-commands.js";

const DEFAULT_STARTUP_BUDGET_MS = 60_000;
const DEFAULT_TEST_BUDGET_MS = 30_000;
const MAX_TURNS_PER_SUBTEST = 3;

// Synthetic vision probe: a 128x128 8-bit truecolour PNG holding a solid red
// circle on a white ground. Deliberately not a 1x1 pixel. An image that small
// is rejected outright by some gateways' upstreams — observed as an unretried
// 5xx carrying no usable body — which reported a perfectly working vision
// endpoint as broken. It also depicts nothing describable, so a gateway that
// silently drops image blocks and answers from the text alone could never be
// told apart from one that honours them. A recognisable shape in a named
// colour makes the model's own answer the evidence that the image arrived.
const VISION_PROBE_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAIAAAACACAIAAABMXPacAAABjklEQVR42u3d0XHDMAxEQbTi/ptJR8mkg4xD+Qhgb9yA3n5aIuvboisJAAAwAAAMAAADAMAAADAAAAwAAAMAwAAAMAC/+3q9/vgDEIjeFKNGRm+EUUvSX8tQq9JfyFAL01/FUGvTX8JQy9PHGUr9rEGpnzUo6bMMpX7WoNTPGpT6WYNSP2tQ6mcNAAwFmFT/UYNSP2tQ6mcNAMwCmF3/CQMAgwA21D9uAGAKwJ76Zw0AjADYVv+gAYD+ADvrnzIAAAAAgMYAm+sfMQAAAACArgDq/98AAAAAAAAAAAAAAAAAAAAAAAAAAAAAHQAY+D8AAAAAqwG8lgIAAAAAqwG8ng5gPYBPlACsB/CZKoD1AI4qALAewHE1ANYDOLIsD+DQvjyAYysBrAdwdHEewOHdeQDH1+cBXOCQB3CFSR6gC8OHg7jGKlnfRW7h+q4yTKbPA9zAEH9819kC+DjDVY/sSnMAD2Nc/oC3A7yH0eihOgGMHAAAAAwAAAMAwAAAMAAADAAAAwDAAAAwAADswf0A0xGkPHDYPpMAAAAASUVORK5CYII=";

// What the probe image depicts. The vision sub-test requires both to appear in
// the reply: an endpoint that accepts the image block but discards it cannot
// produce either, because nothing in the prompt text names them.
const VISION_PROBE_EXPECTED = [/\bred\b/i, /\bcircles?\b/i];

const PROTOCOL_ERROR_PATTERN = /malformed response|StreamNoEventsError|not a Message|proxy or gateway|no_events/i;

/**
 * Map the SDK's own error surfacing onto the taxonomy. Two distinct shapes
 * were observed empirically (see reports/04-settings-evidence.md) and both
 * feed this same function:
 *   - a `system`/`api_retry` message's `error_status`/`error` (401/429/
 *     connection-refused all retry this way), or
 *   - a terminal `result` message with `is_error: true` — some failures
 *     (403, 404 model-not-found, a non-Anthropic-shaped 200 response) are
 *     NOT retried; they synthesize a `result` with `subtype: "success"` but
 *     `is_error: true`, `api_error_status`, and a human-readable `result`
 *     string, immediately followed by the generator throwing.
 * `message` (the human-readable text) is checked first because a
 * protocol-incompatible endpoint sometimes reports no usable status code at
 * all — the message is the only distinguishing signal in that case.
 *
 * A THIRD shape was found empirically against a real live gateway (see
 * reports/09-live-gate-evidence.md): a request for a model id the gateway
 * doesn't recognize came back as an HTTP 503 with a JSON body
 * `{"error":{"code":"model_not_found", ...}}` — i.e. a *retried* 5xx, not the
 * unretried 404 the two shapes above assume. The bundled CLI's own
 * `system`/`api_retry` message only ever surfaces `{ error_status, error }`
 * (here: `503`, `"server_error"`) — it does not forward the upstream
 * response body, so the specific `model_not_found` reason is unrecoverable
 * from this module without bypassing the SDK transport entirely (a design
 * this module deliberately avoids — see the file header). `classifySdkError`
 * therefore still returns `NETWORK_ERROR` for a >=500 status rather than
 * guessing `MODEL_UNAVAILABLE_ERROR` from a generic status code alone, but
 * says so explicitly in the message instead of asserting a cause it cannot
 * verify — see the `status >= 500` branch below.
 *
 * @param {{ status?: number|null, error?: string, message?: string }} info
 * @returns {ProviderError}
 */
function classifySdkError(info) {
  const { status, error, message } = info;
  if (message && PROTOCOL_ERROR_PATTERN.test(message)) {
    return new ProviderError("PROTOCOL_ERROR", `endpoint does not speak the Anthropic Messages API: ${message}`, { detail: info });
  }
  if (status === 401 || status === 403 || error === "authentication_failed") {
    return new ProviderError("AUTH_ERROR", `authentication rejected (HTTP ${status ?? "n/a"})`, { detail: info });
  }
  if (status === 404 || error === "model_not_found") {
    return new ProviderError("MODEL_UNAVAILABLE_ERROR", `model or route not found (HTTP ${status ?? "n/a"})`, { detail: info });
  }
  if (status === 429 || error === "rate_limit" || error === "rate_limit_error") {
    return new ProviderError("RATE_LIMIT_ERROR", "rate limited (HTTP 429)", { detail: info });
  }
  if (typeof status === "number" && status >= 500) {
    return new ProviderError(
      "NETWORK_ERROR",
      `provider server error (HTTP ${status}); note: some gateways report an unrecognized model id as a 5xx rather than 404 — this may also mean the requested model is not available on this endpoint, not only a transient server/network fault`,
      { detail: info }
    );
  }
  if (!status && (error === "unknown" || !error)) {
    return new ProviderError("NETWORK_ERROR", `network/TLS failure: ${message || "connection failed"}`, { detail: info });
  }
  return new ProviderError("NETWORK_ERROR", `unclassified provider error: ${message || error || "unknown"}`, { detail: info });
}

/**
 * Run one bounded synthetic sub-test through `query()`, classifying the
 * outcome from the live message stream.
 *
 * @param {object} params
 * @param {import("@anthropic-ai/claude-agent-sdk").query} params.queryImpl
 * @param {string|AsyncIterable<any>} params.prompt
 * @param {ReturnType<import("@anthropic-ai/claude-agent-sdk").createSdkMcpServer>} [params.mcpServer]
 * @param {string[]} [params.tools]
 * @param {string} params.baseUrl
 * @param {string} params.apiKey
 * @param {string} params.modelId
 * @param {number} params.deadlineAt epoch ms — hard abort point shared across sub-tests
 * @param {number} params.startupBudgetMs
 * @param {(msg: any) => void} [params.onMessage] test hook: observe every raw SDK message
 * @returns {Promise<{ ok: true, sawToolUse: boolean, text: string } | { ok: false, error: ProviderError }>}
 */
async function runSubTest(params) {
  const { queryImpl, prompt, mcpServer, tools = [], baseUrl, apiKey, modelId, deadlineAt, startupBudgetMs, onMessage } = params;

  const abortController = new AbortController();
  const remainingMs = Math.max(0, deadlineAt - Date.now());
  const timer = setTimeout(() => abortController.abort(), remainingMs);

  const env = {
    PATH: process.env.PATH || process.env.Path || "",
    ...(process.platform === "win32" ? { SystemRoot: process.env.SystemRoot || "" } : {}),
    ANTHROPIC_BASE_URL: baseUrl,
    ANTHROPIC_API_KEY: apiKey
  };

  const options = {
    abortController,
    model: modelId,
    mcpServers: mcpServer ? { "capability-test": mcpServer } : {},
    strictMcpConfig: true,
    settingSources: [],
    tools,
    permissionMode: "bypassPermissions", // safe: only the harmless in-process fixture tool below is ever offered
    maxTurns: MAX_TURNS_PER_SUBTEST,
    env
  };

  let sawInit = false;
  let sawToolUse = false;
  let text = "";
  let lastApiErrorType = null;
  const initDeadline = Date.now() + startupBudgetMs;

  try {
    for await (const msg of queryImpl({ prompt, options })) {
      onMessage && onMessage(msg);

      if (msg.type === "system" && msg.subtype === "init") {
        sawInit = true;
        // design.md decision 4 / tasks.md 2.3: the Settings connection test
        // is one of the two places this product ever starts a real
        // query(), so it is one of the two places the advertised
        // slash-command list is captured — this is normally how a fresh
        // install gets its first record, before any conversation has run.
        // Strictly observational: a persistence failure must never fail
        // the connection test, so it is swallowed exactly like tasks.md
        // 2.2's companion.js capture point.
        if (Array.isArray(msg.slash_commands)) {
          try {
            recordAdvertisedCommands({ commands: msg.slash_commands, terminalCommands: msg.terminal_slash_commands });
          } catch {
            // Observation only — never surfaced as a capability-test failure.
          }
        }
        continue;
      }
      if (!sawInit && Date.now() > initDeadline) {
        abortController.abort();
        return { ok: false, error: new ProviderError("STARTUP_ERROR", "runtime did not report cold-start completion within the startup budget") };
      }
      if (msg.type === "system" && msg.subtype === "api_retry") {
        const classified = classifySdkError({ status: msg.error_status ?? null, error: msg.error, message: msg.error });
        abortController.abort();
        return { ok: false, error: classified };
      }
      if (msg.type === "assistant" && Array.isArray(msg.message?.content)) {
        if (msg.is_api_error_message) lastApiErrorType = msg.error || lastApiErrorType;
        for (const block of msg.message.content) {
          if (block.type === "tool_use") sawToolUse = true;
          if (block.type === "text" && typeof block.text === "string") text += block.text;
        }
      }
      if (msg.type === "result") {
        // A "success" subtype is not, by itself, proof of success: some
        // failures (observed empirically for 403/404 — see
        // reports/04-settings-evidence.md) surface as a `result` message
        // with `subtype: "success"` but `is_error: true` and an
        // `api_error_status`, immediately followed by the generator
        // throwing. `is_error`/`api_error_status` are the authoritative
        // signal, not `subtype` alone.
        if (msg.is_error || typeof msg.api_error_status === "number") {
          const classified = classifySdkError({ status: msg.api_error_status ?? null, error: lastApiErrorType, message: msg.result });
          return { ok: false, error: classified };
        }
        if (msg.subtype === "success") {
          return { ok: true, sawToolUse, text };
        }
        return {
          ok: false,
          error: new ProviderError("NETWORK_ERROR", `run ended without success (subtype=${msg.subtype})`, { detail: msg })
        };
      }
    }
    // Generator ended without a terminal result/error signal.
    return { ok: false, error: new ProviderError("TIMEOUT_ERROR", "provider test deadline exceeded with no classifiable response") };
  } catch (err) {
    if (err && (err.name === "AbortError" || /abort/i.test(err.message || ""))) {
      return { ok: false, error: new ProviderError("TIMEOUT_ERROR", "provider test deadline exceeded", { cause: err }) };
    }
    const message = err && err.message ? err.message : String(err);
    if (PROTOCOL_ERROR_PATTERN.test(message)) {
      return { ok: false, error: new ProviderError("PROTOCOL_ERROR", `endpoint does not speak the Anthropic Messages API: ${message}`, { cause: err }) };
    }
    return { ok: false, error: new ProviderError("NETWORK_ERROR", message, { cause: err }) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Build the harmless fixture tool used for the tool-round-trip sub-test.
 * Takes no arguments and has no side effects — safe to auto-approve.
 * @param {{ tool: typeof import("@anthropic-ai/claude-agent-sdk").tool,
 *           createSdkMcpServer: typeof import("@anthropic-ai/claude-agent-sdk").createSdkMcpServer,
 *           z: typeof import("zod") }} sdk
 */
function buildFixtureToolServer({ tool, createSdkMcpServer, z }) {
  const fixtureTool = tool(
    "settings_capability_ping",
    "Synthetic, harmless fixture tool used only to verify the endpoint can complete a structured tool round trip. Takes no arguments and has no effect.",
    {},
    async () => ({ content: [{ type: "text", text: "pong" }] })
  );
  return createSdkMcpServer({ name: "capability-test", version: "1.0.0", tools: [fixtureTool] });
}

/**
 * Run the full three-part bounded capability test.
 *
 * @param {object} params
 * @param {string} params.baseUrl normalized base URL
 * @param {string} params.apiKey
 * @param {string} params.modelId
 * @param {{ query: Function, tool: Function, createSdkMcpServer: Function }} params.sdk
 *   the `@anthropic-ai/claude-agent-sdk` exports (injected so tests can point
 *   this at a fixture endpoint with the real SDK without any product code
 *   depending on a specific import path beyond this module).
 * @param {typeof import("zod")} params.z
 * @param {number} [params.startupBudgetMs]
 * @param {number} [params.testBudgetMs]
 * @param {(msg: any) => void} [params.onMessage]
 * @returns {Promise<{
 *   status: "pass" | "fail",
 *   capabilities: { text: "pass"|"fail"|"not_run", tool: "pass"|"fail"|"not_run", vision: "pass"|"fail"|"not_run" },
 *   errors: Record<string, { code: string, message: string }>,
 *   timestamp: string
 * }>}
 */
export async function runCapabilityTest(params) {
  const {
    baseUrl,
    apiKey,
    modelId,
    sdk,
    z,
    startupBudgetMs = DEFAULT_STARTUP_BUDGET_MS,
    testBudgetMs = DEFAULT_TEST_BUDGET_MS,
    onMessage
  } = params;

  const deadlineAt = Date.now() + startupBudgetMs + testBudgetMs;
  const capabilities = { text: "not_run", tool: "not_run", vision: "not_run" };
  const errors = {};
  let endpointBroken = false;

  const common = { queryImpl: sdk.query, baseUrl, apiKey, modelId, deadlineAt, startupBudgetMs, onMessage };

  // 1. Streaming text.
  const textResult = await runSubTest({ ...common, prompt: "Reply with one short, friendly sentence." });
  if (textResult.ok) {
    capabilities.text = "pass";
  } else {
    capabilities.text = "fail";
    errors.text = { code: textResult.error.code, message: textResult.error.message };
    endpointBroken = true; // an endpoint-level failure (auth/network/protocol/etc.) blocks every other sub-test
  }

  // 2. Fixture tool round trip.
  if (!endpointBroken) {
    const mcpServer = buildFixtureToolServer({ tool: sdk.tool, createSdkMcpServer: sdk.createSdkMcpServer, z });
    const toolResult = await runSubTest({
      ...common,
      prompt: "Call the settings_capability_ping tool now, then briefly acknowledge its result.",
      mcpServer,
      tools: ["mcp__capability-test__settings_capability_ping"]
    });
    if (toolResult.ok && toolResult.sawToolUse) {
      capabilities.tool = "pass";
    } else if (toolResult.ok && !toolResult.sawToolUse) {
      capabilities.tool = "fail";
      errors.tool = { code: "TOOL_ERROR", message: "the model completed the turn without ever calling the fixture tool" };
    } else {
      capabilities.tool = "fail";
      errors.tool = { code: toolResult.error.code, message: toolResult.error.message };
      if (toolResult.error.code !== "TOOL_ERROR") endpointBroken = true;
    }
  }

  // 3. Image recognition.
  if (!endpointBroken) {
    async function* visionPrompt() {
      yield {
        type: "user",
        message: {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: "image/png", data: VISION_PROBE_PNG_BASE64 } },
            { type: "text", text: "Name the single colour and the single shape in this image, in two words." }
          ]
        },
        parent_tool_use_id: null
      };
    }
    const visionResult = await runSubTest({ ...common, prompt: visionPrompt() });
    if (visionResult.ok && VISION_PROBE_EXPECTED.every((pattern) => pattern.test(visionResult.text))) {
      capabilities.vision = "pass";
    } else if (visionResult.ok) {
      // The turn completed, so the endpoint accepted the request — but the
      // reply does not describe the probe image. A gateway that strips image
      // blocks and forwards only the text answers exactly like this, so this
      // is a vision failure, not a pass.
      capabilities.vision = "fail";
      errors.vision = {
        code: "VISION_ERROR",
        message: `image input was accepted but not seen: expected the reply to identify a red circle, got ${JSON.stringify(visionResult.text.trim().slice(0, 200))}`
      };
    } else {
      capabilities.vision = "fail";
      errors.vision =
        visionResult.error.code === "PROTOCOL_ERROR" || visionResult.error.code === "NETWORK_ERROR"
          ? { code: visionResult.error.code, message: visionResult.error.message }
          : { code: "VISION_ERROR", message: `image input was rejected or not completed: ${visionResult.error.message}` };
    }
  }

  const status = capabilities.text === "pass" && capabilities.tool === "pass" && capabilities.vision === "pass" ? "pass" : "fail";
  return { status, capabilities, errors, timestamp: new Date().toISOString() };
}

export { classifySdkError, VISION_PROBE_PNG_BASE64, VISION_PROBE_EXPECTED };
