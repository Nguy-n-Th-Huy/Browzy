#!/usr/bin/env node
// The reported bug: a fully configured, fully tested provider still showed
// "Chưa cấu hình nhà cung cấp" (unconfigured) because profile-cache.js/
// panel-controller.js collapsed every not-ready reason into one boolean.
// Real root cause (two parts, both covered here):
//
//   1. profile-cache.js's deriveReadinessState() must tell apart the six
//      distinct not-ready reasons (and READY), never treating a stale or
//      failed capability test as ready.
//   2. Even with (1) fixed, nothing ever wrote the
//      `ocic_profile_cache_v1` mirror `ProfileCache.read()` depends on —
//      see test/background-agent-settings-profile-mirror.test.mjs for that
//      half (extension/background.js's writer side).
//
// This file covers (1): profile-cache.js's pure state-discrimination logic,
// and panel-controller.js's wiring of it through a real ProfileCache against
// a fake chrome.storage.local — exactly the level sidepanel.js's own
// send-gating (`panel.hasCompleteProfile()`) and setup-banner rendering
// (`panel.readinessState()`) both read from. sidepanel.js itself is DOM-only
// glue (per its own file header, verified by screenshots, not a DOM-diffing
// test) and is checked here only structurally (regex over its source) for
// the one property that matters to this bug: a resolvable not-ready state
// links to Settings' Test connection control, not a generic "open settings".
//
// Run: node test/sidepanel-readiness-states.test.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ProfileCache, READINESS, deriveReadinessState, isProfileComplete, capabilityTestKey } from "../extension/sidepanel/profile-cache.js";
import { PanelController } from "../extension/sidepanel/panel-controller.js";
import { ProtocolClient } from "../extension/sidepanel/protocol-client.js";
import { HistoryStore } from "../extension/sidepanel/history-store.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let fail = 0;
function ok(cond, msg) {
  console.log((cond ? "  PASS " : "  FAIL ") + msg);
  if (!cond) fail++;
}

function fakeChromeStorage(seed = {}) {
  const data = { ...seed };
  return {
    async get(key) {
      return key in data ? { [key]: data[key] } : {};
    },
    async set(obj) {
      Object.assign(data, obj);
    }
  };
}

function inertProtocolClient() {
  // A ProtocolClient that never actually connects — PanelController.init()
  // is not called in these tests; only the profile side is exercised.
  return new ProtocolClient({ createTransport: () => ({ postMessage() {}, onMessage() {}, onDisconnect() {} }) });
}

async function main() {
  console.log("== deriveReadinessState: the six not-ready reasons, plus READY ==");
  {
    ok(deriveReadinessState(null).state === READINESS.NOT_CONFIGURED, "no cache at all -> not_configured");
    ok(deriveReadinessState(undefined).state === READINESS.NOT_CONFIGURED, "undefined profile -> not_configured");

    ok(
      deriveReadinessState({ profileId: "default", baseUrl: "https://x.invalid", models: [], defaultModelId: null, hasCredential: false }).state ===
        READINESS.NOT_CONFIGURED,
      "no models and no credential -> not_configured (state 1)"
    );

    ok(
      deriveReadinessState({ profileId: "default", baseUrl: "https://x.invalid", models: [], defaultModelId: null, hasCredential: true }).state ===
        READINESS.PARTIAL,
      "credential saved but no models yet -> partial, not 'nothing configured' (state 2)"
    );
    {
      const r = deriveReadinessState({ baseUrl: "https://x.invalid", models: [], defaultModelId: null, hasCredential: true });
      ok(r.missing === "models", "partial reason names the specific missing piece: models");
    }
    {
      const r = deriveReadinessState({
        baseUrl: "https://x.invalid",
        models: [{ id: "m1", label: "M1" }],
        defaultModelId: null,
        hasCredential: true
      });
      ok(r.state === READINESS.PARTIAL && r.missing === "defaultModel", "models present but no valid default model -> partial: defaultModel");
    }

    ok(
      deriveReadinessState({
        baseUrl: "https://x.invalid",
        models: [{ id: "m1", label: "M1" }],
        defaultModelId: "m1",
        hasCredential: false
      }).state === READINESS.NO_CREDENTIAL,
      "models+default present, hasCredential:false -> no_credential (state 3)"
    );

    ok(
      deriveReadinessState({
        baseUrl: "https://x.invalid",
        models: [{ id: "m1", label: "M1" }],
        defaultModelId: "m1",
        hasCredential: true,
        credentialRevision: 1,
        lastCapabilityTest: {}
      }).state === READINESS.UNTESTED,
      "credential saved, empty lastCapabilityTest map -> untested (state 4)"
    );

    {
      const key = capabilityTestKey({ baseUrl: "https://x.invalid", modelId: "m1", credentialRevision: 1 });
      const r = deriveReadinessState({
        baseUrl: "https://x.invalid",
        models: [{ id: "m1", label: "M1" }],
        defaultModelId: "m1",
        hasCredential: true,
        credentialRevision: 1,
        lastCapabilityTest: { [key]: { status: "pass", capabilities: { text: "pass", tool: "pass", vision: "pass" }, errors: {} } }
      });
      ok(r.state === READINESS.READY, "current-key entry with status pass -> ready");
      ok(isProfileComplete({ baseUrl: "https://x.invalid", models: [{ id: "m1", label: "M1" }], defaultModelId: "m1", hasCredential: true, credentialRevision: 1, lastCapabilityTest: { [key]: { status: "pass" } } }), "isProfileComplete() agrees (send-gating predicate)");
    }

    {
      const staleKey = capabilityTestKey({ baseUrl: "https://x.invalid", modelId: "m1", credentialRevision: 1 });
      const r = deriveReadinessState({
        baseUrl: "https://x.invalid",
        models: [{ id: "m1", label: "M1" }],
        defaultModelId: "m1",
        hasCredential: true,
        credentialRevision: 2, // rotated since the stored test
        lastCapabilityTest: { [staleKey]: { status: "pass", capabilities: { text: "pass", tool: "pass", vision: "pass" }, errors: {} } }
      });
      ok(r.state === READINESS.STALE, "entry exists only for an OLDER credentialRevision -> stale, not ready and not unconfigured (state 5)");
      ok(r.reason === "credential", "stale reason correctly identifies a KEY change (same endpoint/model, different credentialRevision)");
    }

    {
      const staleKey = capabilityTestKey({ baseUrl: "https://old.invalid", modelId: "m1", credentialRevision: 1 });
      const r = deriveReadinessState({
        baseUrl: "https://new.invalid", // endpoint changed since the stored test
        models: [{ id: "m1", label: "M1" }],
        defaultModelId: "m1",
        hasCredential: true,
        credentialRevision: 1,
        lastCapabilityTest: { [staleKey]: { status: "pass", capabilities: { text: "pass", tool: "pass", vision: "pass" }, errors: {} } }
      });
      ok(r.state === READINESS.STALE && r.reason === "endpoint_or_model", "an endpoint (or model) change is distinguished from a credential change");
    }

    {
      const key = capabilityTestKey({ baseUrl: "https://x.invalid", modelId: "m1", credentialRevision: 1 });
      const r = deriveReadinessState({
        baseUrl: "https://x.invalid",
        models: [{ id: "m1", label: "M1" }],
        defaultModelId: "m1",
        hasCredential: true,
        credentialRevision: 1,
        lastCapabilityTest: {
          [key]: {
            status: "fail",
            capabilities: { text: "pass", tool: "fail", vision: "not_run" },
            errors: { tool: { code: "TOOL_ERROR", message: "the model completed the turn without ever calling the fixture tool" } }
          }
        }
      });
      ok(r.state === READINESS.TEST_FAILED, "current-key entry with status fail -> test_failed, not ready (state 6)");
      ok(r.capabilities.tool === "fail" && r.capabilities.text === "pass", "which capability failed is surfaced, not just pass/fail");
    }

    ok(!isProfileComplete(null), "isProfileComplete stays false for every non-ready state (never weakened)");
  }

  console.log("== THE REPORTED BUG: reproduces the user's exact real profile shape verbatim ==");
  {
    // Taken directly from the bug report's real agent-profile.json contents,
    // reshaped only into the non-secret ocic_profile_cache_v1 mirror
    // extension/background.js's writer produces (see
    // test/background-agent-settings-profile-mirror.test.mjs for that half).
    const userProfile = {
      profileId: "default",
      baseUrl: "https://node1.viber.vn",
      models: [
        { id: "claude-opus-5", label: "Opus" },
        { id: "claude-sonnet-5", label: "Sonnet" }
      ],
      defaultModelId: "claude-sonnet-5",
      revision: 7,
      credentialRevision: 5,
      hasCredential: true,
      lastCapabilityTest: {
        [capabilityTestKey({ baseUrl: "https://node1.viber.vn", modelId: "claude-sonnet-5", credentialRevision: 4 })]: {
          status: "pass",
          capabilities: { text: "pass", tool: "pass", vision: "pass" },
          errors: {},
          timestamp: "2026-09-01T00:00:00.000Z"
        }
      }
    };

    const readiness = deriveReadinessState(userProfile);
    ok(readiness.state !== READINESS.NOT_CONFIGURED, "NEVER reported as unconfigured — every required field is actually present and saved");
    ok(readiness.state === READINESS.STALE, "reported as stale/re-test-needed: the recorded test is for credentialRevision 4, the profile is now at 5");
    ok(readiness.reason === "credential", "the specific reason is 'the API key changed', matching design.md 4's 'key replacement invalidates compatibility status'");
    ok(!isProfileComplete(userProfile), "Send stays disabled — a stale test is never treated as passing");

    console.log("== ... wired through the real ProfileCache + PanelController (what sidepanel.js actually calls) ==");
    const cache = new ProfileCache({ storage: fakeChromeStorage({ ocic_profile_cache_v1: userProfile }) });
    const panel = new PanelController({
      protocolClient: inertProtocolClient(),
      historyStore: new HistoryStore({ storage: fakeChromeStorage() }),
      profileCache: cache,
      identity: async () => ({})
    });
    panel.profile = await cache.read(); // sidepanel.js's boot() does this via panel.init(); avoided here to skip a real connect()
    ok(panel.readinessState().state === READINESS.STALE, "PanelController.readinessState() reports stale for the user's real profile");
    ok(panel.readinessState().reason === "credential", "...with the credential-changed reason preserved through the wiring");
    ok(panel.hasCompleteProfile() === false, "PanelController.hasCompleteProfile() (sidepanel.js's Send-gating predicate) is false");
  }

  console.log("== backward compatibility: the OLDER reduced mirror shape used by other existing fixtures must still work ==");
  {
    // Exactly test/sidepanel-fake-companion.test.mjs's and
    // test/sidepanel-slash-picker-dispatch.test.mjs's completeProfile() shape
    // (models/defaultModelId/revision + capabilityTest:{ok,at,credentialRevision},
    // no top-level hasCredential/credentialRevision/lastCapabilityTest) — must
    // still resolve READY, never a regression from this task's contract change.
    const legacy = {
      profileId: "default",
      baseUrl: "https://example.invalid",
      models: [{ id: "claude-fake-model", label: "Fake" }],
      defaultModelId: "claude-fake-model",
      revision: 1,
      capabilityTest: { ok: true, at: Date.now(), credentialRevision: 1 }
    };
    ok(deriveReadinessState(legacy).state === READINESS.READY, "legacy reduced shape with ok:true still resolves to ready");
    ok(isProfileComplete(legacy) === true, "isProfileComplete() still true for the legacy shape (no regression on existing test fixtures)");

    const legacyUntested = { ...legacy, capabilityTest: null };
    ok(deriveReadinessState(legacyUntested).state === READINESS.UNTESTED, "legacy shape with no capabilityTest at all -> untested, not unconfigured");

    const legacyFailed = { ...legacy, capabilityTest: { ok: false, at: Date.now(), credentialRevision: 1 } };
    ok(deriveReadinessState(legacyFailed).state === READINESS.TEST_FAILED, "legacy shape with ok:false -> test_failed, not unconfigured");
  }

  console.log("== structural: sidepanel.js links every re-testable not-ready state to Settings' Test connection control ==");
  {
    const src = fs.readFileSync(path.join(ROOT, "extension", "sidepanel", "sidepanel.js"), "utf8");
    ok(src.includes('openSettings("btn-test-connection")'), "a direct link to the real settings.html#btn-test-connection control exists");
    ok(/case READINESS\.UNTESTED:[\s\S]{0,300}?testConnectionButton\(/.test(src), "UNTESTED links to Test connection, not a generic 'open settings'");
    ok(/case READINESS\.STALE: \{[\s\S]{0,600}?testConnectionButton\(/.test(src), "STALE links to Test connection, not a generic 'open settings'");
    ok(/case READINESS\.TEST_FAILED: \{[\s\S]{0,600}?testConnectionButton\(/.test(src), "TEST_FAILED links to Test connection, not a generic 'open settings'");
    ok(/case READINESS\.NOT_CONFIGURED:[\s\S]{0,120}?default:[\s\S]{0,300}?settingsButton\(/.test(src), "NOT_CONFIGURED keeps the original generic 'open settings' action (there is nothing to test yet)");
  }

  console.log(fail === 0 ? "\nALL SIDEPANEL READINESS-STATE TESTS PASSED" : `\n${fail} FAILED`);
  process.exit(fail ? 1 : 0);
}

main();
