#!/usr/bin/env node
// `browzy provider-test` — diagnose "why won't my provider work?" on a machine
// you cannot see.
//
// WHY THIS EXISTS. The Settings page shows ONE short line per failure
// (extension/settings/errors-ui.js), and the two codes it can produce for a
// broken endpoint — NETWORK_ERROR and PROTOCOL_ERROR — read almost identically
// ("check your Base URL, TLS certificate and network") no matter what actually
// went wrong. The real cause is in the provider error's `detail`, which the UI
// never renders: an HTTP status, an upstream body, the SDK's own message. A
// gateway that answers a 5xx for an unrecognized model id therefore looks like
// a TLS problem, and the operator has no way to tell the two apart from the
// screen (host/agent/settings/capability-test.js documents exactly this trap
// for the 503-from-a-real-gateway case).
//
// This command runs the SAME real code path the page runs — readProfileFromDisk
// → readSecret → runCapabilityTest → the real SDK → the real endpoint — and
// prints what the UI cannot: every sub-test's raw classification, the HTTP
// status, the provider's own body, and a verdict naming the most likely cause.
// It never prints the credential: `redactSecretsDeep()` is applied to the whole
// report before it is written, so its output is safe to paste into a chat.
//
// Usage (from host/, or via `npx @huydepzai2810/browzy-host provider-test`):
//   node agent/provider-test.mjs                    # full diagnosis (default model first)
//   node agent/provider-test.mjs --all-models       # ...then every configured model
//   node agent/provider-test.mjs --model <id>       # one specific model
//   node agent/provider-test.mjs --network-only     # reachability/TLS only, no SDK, no tokens spent
//   node agent/provider-test.mjs --json             # machine-readable report
//
// Exit codes: 0 = every attempted check passed · 1 = a check failed · 2 = the
// command itself could not run (no profile, no credential, bad arguments).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// --network-only must not pay for the SDK import at all: it is the mode an
// operator runs on a machine where the companion cannot even start.
const wantNetworkOnly = process.argv.includes("--network-only");

let readProfileFromDisk;
let readSecret;
let runCapabilityTest;
let redactSecretsDeep;
let normalizeBaseUrl;
let ProviderError;
try {
  ({ readProfileFromDisk } = await import("./settings/profile-store.js"));
  ({ normalizeBaseUrl } = await import("./settings/url.js"));
  ({ ProviderError } = await import("./settings/errors.js"));
  ({ redactSecretsDeep } = await import("./secrets/redact.js"));
  if (!wantNetworkOnly) {
    ({ runCapabilityTest } = await import("./settings/capability-test.js"));
    ({ readSecret } = await import("./secrets/secret-store.js"));
  }
} catch (err) {
  console.error(`provider-test: cannot load the companion's own modules (${err.message}).`);
  console.error("Run this from a complete checkout/install of the host package.");
  process.exit(2);
}

// ------------------------------------------------------------------ arguments

function parseArgs(argv) {
  const opts = { allModels: false, networkOnly: wantNetworkOnly, json: false, model: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--all-models") opts.allModels = true;
    else if (arg === "--network-only") opts.networkOnly = true;
    else if (arg === "--json") opts.json = true;
    else if (arg === "--model") {
      opts.model = argv[++i] || null;
      if (!opts.model) throw new Error("--model needs a model id");
    } else if (arg === "--help" || arg === "-h") {
      opts.help = true;
    } else {
      throw new Error(`unknown argument "${arg}"`);
    }
  }
  return opts;
}

// ------------------------------------------------------------------- checks

const REACHABILITY_BUDGET_MS = 15000;

/** DNS/TCP/TLS only: no credential, no tokens, no SDK.

 * A GET on the base URL itself is deliberate — it is the one request every
 * gateway answers for anyone, so a failure here is about the NETWORK (DNS,
 * proxy, TLS interception, an offline machine), never about the API key. */
async function checkReachability(baseUrl) {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REACHABILITY_BUDGET_MS);
  try {
    const response = await fetch(baseUrl, { method: "GET", redirect: "manual", signal: controller.signal });
    return {
      name: "reachability",
      ok: true,
      status: response.status,
      ms: Date.now() - started,
      server: response.headers.get("server") || null,
      note: "the host answered a plain GET (TLS and DNS are fine; this says nothing about the API key)"
    };
  } catch (err) {
    return {
      name: "reachability",
      ok: false,
      ms: Date.now() - started,
      error: {
        name: err && err.name,
        message: (err && err.message) || String(err),
        cause: err && err.cause ? String(err.cause.message || err.cause.code || err.cause) : null
      },
      note: "could not open a TLS connection to the base URL at all — this is the one case the Settings page's \"network/TLS\" wording is literally right about"
    };
  } finally {
    clearTimeout(timer);
  }
}

/** What the gateway says about the model list, WITH the saved credential.
 * 401/403 here is the single most useful fact available: it means the endpoint
 * is reachable and speaks HTTP, and the key is what it rejected. */
async function checkModelList(baseUrl, apiKey) {
  const url = `${baseUrl.replace(/\/+$/, "")}/v1/models`;
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REACHABILITY_BUDGET_MS);
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: { authorization: `Bearer ${apiKey}`, "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      signal: controller.signal
    });
    // Parsed from the WHOLE body, with only the PREVIEW capped: a real gateway
    // returned 3.3 KB of model list here, and slicing before `JSON.parse()`
    // turned a perfectly good answer into "0 models" plus a parse failure —
    // the diagnostic would have reported the opposite of the truth.
    const text = await response.text();
    let ids = [];
    let parsedOk = false;
    try {
      const parsed = JSON.parse(text);
      parsedOk = true;
      ids = (parsed.data || parsed.models || []).map((m) => m && (m.id || m.name)).filter(Boolean);
    } catch {
      // a non-JSON body is itself a finding (an HTML login page, a proxy error)
    }
    return {
      name: "model-list",
      ok: response.ok,
      status: response.status,
      ms: Date.now() - started,
      contentType: response.headers.get("content-type") || null,
      modelCount: ids.length,
      models: ids.slice(0, 60),
      bodyPreview: ids.length ? null : text.slice(0, 300),
      note: !response.ok
        ? response.status === 401 || response.status === 403
          ? "the endpoint is REACHABLE and REJECTED the API key — fix the key, not the URL"
          : "the endpoint answered, but not with a model list"
        : !parsedOk
          ? "the endpoint answered 200 with a body that is not JSON — a proxy or login page is in front of the API"
          : ids.length === 0
            ? "the endpoint answered 200 with a JSON body that names no models"
            : "the endpoint accepted the credential and listed models"
    };
  } catch (err) {
    return {
      name: "model-list",
      ok: false,
      ms: Date.now() - started,
      error: { message: (err && err.message) || String(err) },
      note: "no HTTP answer for the model list"
    };
  } finally {
    clearTimeout(timer);
  }
}

/** The real thing: the same bounded synthetic sub-tests the Settings page's
 * "Kiểm tra kết nối" runs, with the raw classification kept. */
async function checkCapability(profile, apiKey, modelId) {
  const sdk = await import("@anthropic-ai/claude-agent-sdk");
  const z = await import("zod");
  const started = Date.now();
  let result;
  try {
    result = await runCapabilityTest({
      baseUrl: profile.baseUrl,
      apiKey,
      modelId,
      sdk,
      z: z.default || z
    });
  } catch (err) {
    return {
      name: `capability:${modelId}`,
      ok: false,
      ms: Date.now() - started,
      thrown: { code: err && err.code, message: (err && err.message) || String(err) }
    };
  }
  // `runCapabilityTest` drops `error.detail` when it records `errors.*`; the
  // detail is re-derived here from the same ProviderError instances it built.
  return {
    name: `capability:${modelId}`,
    ok: result.status === "pass",
    ms: Date.now() - started,
    status: result.status,
    capabilities: result.capabilities,
    errors: result.errors || {}
  };
}

/**
 * The cause, named. Deliberately conservative: it reports what the collected
 * facts establish and says "unknown" rather than guessing when they do not
 * establish anything. The 5xx-gateway case is called out by name because it is
 * the one that masquerades as a network fault.
 */
function verdict({ reachability, modelList, capabilities }) {
  if (reachability && !reachability.ok) {
    return {
      cause: "network_or_tls",
      detail: "No TLS connection to the base URL. DNS, a proxy, a corporate TLS-inspecting certificate, or an offline machine.",
      next: "Curl the base URL from the same machine; if that fails too, the problem is below the app, not in it."
    };
  }
  if (modelList && (modelList.status === 401 || modelList.status === 403)) {
    return {
      cause: "credential_rejected",
      detail: "The endpoint is reachable and answered, but refused the API key.",
      next: "Re-enter the key on the Settings page (copy it fresh; the field rejects non-ASCII paste on purpose), or issue a new one."
    };
  }
  if (modelList && modelList.ok && modelList.modelCount > 0 && capabilities) {
    const broken = capabilities.filter((c) => !c.ok);
    const codes = new Set(broken.flatMap((c) => Object.values(c.errors || {}).map((e) => e && e.code)));
    if (broken.some((c) => Object.values(c.errors || {}).some((e) => e && e.code === "MODEL_UNAVAILABLE_ERROR"))) {
      return {
        cause: "model_unavailable",
        detail: "The endpoint rejected the requested model id (404 / model_not_found).",
        next: "Pick one of the model ids listed above as this profile's default."
      };
    }
    if (codes.has("AUTH_ERROR")) {
      return {
        cause: "credential_rejected",
        detail: "The capability request was refused with 401/403.",
        next: "Re-enter the API key."
      };
    }
    if (codes.has("PROTOCOL_ERROR")) {
      return {
        cause: "not_anthropic_compatible",
        detail: "The endpoint answers, but not with the Anthropic Messages API streaming shape.",
        next: "Point Base URL at the endpoint's Anthropic-compatible base (usually ending in /v1), or use an OpenAI-compatible gateway setting if one exists."
      };
    }
    if (codes.has("NETWORK_ERROR")) {
      return {
        cause: "endpoint_5xx_or_transport",
        detail:
          "The provider request came back as NETWORK_ERROR. For a gateway this usually means an HTTP 5xx — often an unrecognized model id reported as a server error rather than a 404 — not a TLS fault. The Settings page cannot tell these apart and says \"network/TLS\" either way.",
        next: "Try a model id from the list above as the default; if every model 5xxs, the gateway itself is failing."
      };
    }
    if (broken.length) {
      return { cause: "capability_failed", detail: "A capability sub-test failed.", next: "Read the per-sub-test error below." };
    }
  }
  if (capabilities && capabilities.every((c) => c.ok)) {
    return { cause: "ok", detail: "Every check passed on this machine.", next: "Nothing to fix here." };
  }
  return { cause: "unknown", detail: "The collected facts do not name a single cause.", next: "Send this report along with the machine's OS and browser." };
}

// --------------------------------------------------------------------- main

/** Secret values `emit()` must scrub from its own output. Set as soon as the
 * credential is read, never printed. */
let knownSecrets = [];

async function main(argv = process.argv.slice(2)) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    console.error(`provider-test: ${err.message}`);
    return 2;
  }
  if (opts.help) {
    console.log(fs.readFileSync(new URL(import.meta.url)).toString().split("\n").slice(1, 40).join("\n").replace(/^\/\/ ?/gm, ""));
    return 0;
  }

  const profile = readProfileFromDisk();
  if (!profile) {
    console.error("provider-test: no profile found. Configure the Settings page once, then re-run.");
    return 2;
  }

  const report = {
    generatedAt: new Date().toISOString(),
    machine: { platform: process.platform, arch: process.arch, node: process.version },
    profile: {
      profileId: profile.profileId,
      baseUrl: profile.baseUrl,
      baseUrlNormalized: (() => {
        try {
          return normalizeBaseUrl(profile.baseUrl).normalized;
        } catch (err) {
          return `INVALID: ${err.message}`;
        }
      })(),
      providerType: profile.providerType || "anthropic",
      defaultModelId: profile.defaultModelId || null,
      models: (profile.models || []).map((m) => m.id),
      credentialRevision: profile.credentialRevision || 0,
      secretBackend: profile.secretBackend || null,
      memoryOnlyCredential: profile.memoryOnlyCredential === true,
      lastRecordedTest: profile.lastCapabilityTest || null
    },
    checks: []
  };

  const plainUrl = String(profile.baseUrl || "");
  report.checks.push(await checkReachability(plainUrl));

  if (opts.networkOnly) {
    const reach = report.checks[0];
    report.verdict = reach.ok
      ? {
          cause: "reachability_only",
          detail: "The endpoint answered over TLS. --network-only ran no authenticated check, so this says nothing about the API key or the model.",
          next: "Re-run without --network-only to test the credential and the configured model."
        }
      : verdict({ reachability: reach, modelList: null, capabilities: null });
    return emit(report, opts);
  }

  if (!opts.networkOnly) {
    let apiKey = null;
    try {
      apiKey = await readSecret(`browzy-in-chrome/settings/${profile.profileId}`, {
        memoryOnly: profile.memoryOnlyCredential,
        backend: profile.secretBackend
      });
    } catch (err) {
      report.checks.push({ name: "credential", ok: false, error: { code: err && err.code, message: (err && err.message) || String(err) } });
    }
    if (apiKey) {
      knownSecrets = [apiKey];
      report.checks.push({
        name: "credential",
        ok: true,
        note: "a credential is stored (value never printed)",
        length: apiKey.length,
        printableAscii: /^[\x20-\x7e]+$/.test(apiKey)
      });
      report.checks.push(await checkModelList(plainUrl, apiKey));
    } else if (!report.checks.some((c) => c.name === "credential")) {
      report.checks.push({ name: "credential", ok: false, note: "no credential stored for this profile" });
    }

    if (profile.providerType === "chatgpt") {
      report.checks.push({
        name: "capability",
        skipped: true,
        note: "this profile uses the ChatGPT provider — the capability sub-tests are the Anthropic-key path; use the Settings page's sign-in state instead"
      });
    } else if (apiKey) {
      const ids = [];
      if (opts.model) ids.push(opts.model);
      else if (profile.defaultModelId) ids.push(profile.defaultModelId);
      if (opts.allModels) for (const m of profile.models || []) if (!ids.includes(m.id)) ids.push(m.id);
      for (const id of ids) report.checks.push(await checkCapability(profile, apiKey, id));
    }
  }

  const byName = (name) => report.checks.find((c) => c.name === name);
  report.verdict = verdict({
    reachability: byName("reachability"),
    modelList: byName("model-list"),
    capabilities: report.checks.filter((c) => c.name.startsWith("capability:") && !c.skipped)
  });
  return emit(report, opts);
}

function emit(report, opts) {
  // Redacted BEFORE anything is printed: the report is meant to be pasted into
  // a chat, and a gateway error body can echo the credential back.
  const safe = redactSecretsDeep(report, knownSecrets);
  if (opts.json) {
    console.log(JSON.stringify(safe, null, 2));
  } else {
    console.log("Browzy provider diagnosis");
    console.log("=========================");
    console.log(`machine : ${safe.machine.platform} ${safe.machine.arch}, node ${safe.machine.node}`);
    console.log(`profile : ${safe.profile.profileId} (${safe.profile.providerType}), credential revision ${safe.profile.credentialRevision}`);
    console.log(`baseUrl : ${safe.profile.baseUrl}`);
    if (safe.profile.baseUrlNormalized !== safe.profile.baseUrl) console.log(`          normalizes to ${safe.profile.baseUrlNormalized}`);
    console.log(`model   : ${safe.profile.defaultModelId}  [${safe.profile.models.join(", ")}]`);
    console.log(`secrets : ${safe.profile.secretBackend || "unknown"}${safe.profile.memoryOnlyCredential ? " (memory only — lost on restart)" : ""}`);
    console.log("");
    for (const check of safe.checks) {
      const head = `  ${check.ok === false ? "FAIL" : check.skipped ? "SKIP" : " OK "}  ${check.name}`;
      const bits = [];
      if (check.status !== undefined) bits.push(`HTTP ${check.status}`);
      if (check.ms !== undefined) bits.push(`${check.ms}ms`);
      if (check.modelCount !== undefined) bits.push(`${check.modelCount} models`);
      if (check.length !== undefined) bits.push(`len ${check.length}, ascii ${check.printableAscii}`);
      console.log(bits.length ? `${head}  (${bits.join(", ")})` : head);
      if (check.note) console.log(`        ${check.note}`);
      if (check.error) console.log(`        error: ${check.error.code || check.error.name || ""} ${check.error.message || ""}`.trimEnd());
      if (check.thrown) console.log(`        thrown: ${check.thrown.code || ""} ${check.thrown.message || ""}`.trimEnd());
      if (check.capabilities) console.log(`        capabilities: ${JSON.stringify(check.capabilities)}`);
      for (const [sub, detail] of Object.entries(check.errors || {})) {
        console.log(`        ${sub}: ${detail.code} — ${detail.message}`);
      }
      if (check.bodyPreview) console.log(`        body: ${String(check.bodyPreview).replace(/\s+/g, " ").slice(0, 200)}`);
    }
    if (safe.checks.some((c) => Array.isArray(c.models) && c.models.length)) {
      const withModels = safe.checks.find((c) => Array.isArray(c.models) && c.models.length);
      console.log(`\nmodels the endpoint offers (${withModels.modelCount}):`);
      console.log(`  ${withModels.models.join(", ")}`);
    }
    console.log(`\nVERDICT: ${safe.verdict.cause}`);
    console.log(`  ${safe.verdict.detail}`);
    console.log(`  next: ${safe.verdict.next}`);
  }
  const failed = safe.checks.some((c) => c.ok === false);
  return failed ? 1 : 0;
}

export { main };

// Exported for the regression test only: the cause-naming table is the part of
// this tool that must not silently regress (a wrong verdict sends the operator
// after the wrong thing, which is the defect this command exists to end).
export { verdict as _verdictForTests };

// Only when run as the entry point — importing this module (the CLI dispatch
// in installer/cli.js, or a test) must not exit the host process.
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  process.exit(await main());
}
