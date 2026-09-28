#!/usr/bin/env node
// setup-walkthrough.js — the one ordered statement of what setup still needs,
// shared by the settings page and the side panel.
//
// The defect this covers: neither surface said which setup step was next, and
// one of them said the opposite. The panel's empty state claimed "Sẵn sàng
// trên trang này" and offered three example requests whose submission the send
// path refuses while the profile is incomplete (sidepanel.js:2850-2872 called
// unconditionally at :2576-2579); the settings page restated the same three
// preconditions twice, once incorrectly ("ở mục Nhà cung cấp bên dưới" for the
// model list, settings-app.js:478).
//
// The last section is the property that keeps this module honest: the step
// order it states MUST be the order the product already enforces
// (connection-gate.js:64-88). The two are given the same input and must agree
// about which step comes first, so a future divergence fails here rather than
// shipping a walkthrough that contradicts the gate sitting next to it.
//
// Run: node test/setup-walkthrough.test.mjs

import { SETUP_STEP, STEP_STATE, deriveSetupSteps } from "../extension/setup-walkthrough.js";
import { connectionGate } from "../extension/settings/connection-gate.js";

let fail = 0;
const ok = (cond, msg) => {
  console.log((cond ? "  PASS " : "  FAIL ") + msg);
  if (!cond) fail++;
};

// A SettingsController snapshot (settings-controller.js's emptyState()) in its
// healthy shape; each row overrides only what it is about.
const baseInput = (overrides = {}) => ({
  companion: null,
  providerType: "anthropic",
  hasCredential: true,
  chatgptSessionState: "signed_out",
  models: [{ id: "m1", label: "M1" }],
  defaultModelId: "m1",
  connectionStatus: null,
  busy: {},
  ...overrides
});

const keys = (result) => result.steps.map((s) => s.key);
const stateOf = (result, key) => result.steps.find((s) => s.key === key)?.state;

console.log("\n== which steps exist, in what order, and which is next ==");
{
  const rows = [
    {
      name: "fresh profile: nothing configured, no companion evidence",
      input: baseInput({ hasCredential: false, models: [], defaultModelId: null }),
      expect: {
        keys: [SETUP_STEP.PROVIDER, SETUP_STEP.MODELS, SETUP_STEP.CONNECTION],
        states: [STEP_STATE.TODO, STEP_STATE.TODO, STEP_STATE.TODO],
        currentKey: SETUP_STEP.PROVIDER,
        ready: false
      }
    },
    {
      name: "credential saved, model list still empty",
      input: baseInput({ models: [], defaultModelId: null }),
      expect: {
        keys: [SETUP_STEP.PROVIDER, SETUP_STEP.MODELS, SETUP_STEP.CONNECTION],
        states: [STEP_STATE.DONE, STEP_STATE.TODO, STEP_STATE.TODO],
        currentKey: SETUP_STEP.MODELS,
        ready: false
      }
    },
    {
      name: "models present but no default chosen",
      input: baseInput({ defaultModelId: null }),
      expect: {
        states: [STEP_STATE.DONE, STEP_STATE.TODO, STEP_STATE.TODO],
        currentKey: SETUP_STEP.MODELS,
        ready: false
      }
    },
    {
      name: "configured but never tested",
      input: baseInput(),
      expect: {
        states: [STEP_STATE.DONE, STEP_STATE.DONE, STEP_STATE.TODO],
        currentKey: SETUP_STEP.CONNECTION,
        ready: false
      }
    },
    {
      name: "test passed -> ready",
      input: baseInput({ connectionStatus: { status: "pass" } }),
      expect: {
        states: [STEP_STATE.DONE, STEP_STATE.DONE, STEP_STATE.DONE],
        currentKey: null,
        ready: true
      }
    },
    {
      name: "test failed -> the connection step is the next one, not done",
      input: baseInput({ connectionStatus: { status: "fail" } }),
      expect: {
        states: [STEP_STATE.DONE, STEP_STATE.DONE, STEP_STATE.TODO],
        currentKey: SETUP_STEP.CONNECTION,
        ready: false
      }
    },
    {
      name: "a `chatgpt` profile that is signed out needs the sign-in, not an API key",
      input: baseInput({ providerType: "chatgpt", hasCredential: false, chatgptSessionState: "signed_out" }),
      expect: { currentKey: SETUP_STEP.PROVIDER, ready: false }
    },
    {
      name: "a `chatgpt` profile with an expired session is not done either",
      input: baseInput({ providerType: "chatgpt", hasCredential: true, chatgptSessionState: "session_expired" }),
      expect: { currentKey: SETUP_STEP.PROVIDER, ready: false }
    },
    {
      name: "a signed-in `chatgpt` profile satisfies the provider step from the session alone",
      input: baseInput({ providerType: "chatgpt", hasCredential: false, chatgptSessionState: "signed_in" }),
      expect: { states: [STEP_STATE.DONE, STEP_STATE.DONE, STEP_STATE.TODO], currentKey: SETUP_STEP.CONNECTION }
    }
  ];

  for (const row of rows) {
    const result = deriveSetupSteps(row.input);
    if (row.expect.keys) {
      ok(
        JSON.stringify(keys(result)) === JSON.stringify(row.expect.keys),
        `${row.name} — step order is ${row.expect.keys.join(" -> ")}`
      );
    }
    if (row.expect.states) {
      const actual = result.steps.map((s) => s.state);
      ok(
        JSON.stringify(actual) === JSON.stringify(row.expect.states),
        `${row.name} — step states are ${row.expect.states.join(", ")}`
      );
    }
    if ("currentKey" in row.expect) {
      ok(result.currentKey === row.expect.currentKey, `${row.name} — next step is ${row.expect.currentKey}`);
    }
    if ("ready" in row.expect) {
      ok(result.ready === row.expect.ready, `${row.name} — ready === ${row.expect.ready}`);
    }
  }
}

console.log("\n== an action in flight is neither done nor outstanding ==");
{
  const rows = [
    { name: "saving a credential", busy: { saving: true }, key: SETUP_STEP.PROVIDER },
    { name: "signing out", busy: { signingOut: true }, key: SETUP_STEP.PROVIDER },
    { name: "signing in", busy: { signingIn: true }, key: SETUP_STEP.PROVIDER },
    { name: "switching provider type", busy: { switchingProviderType: true }, key: SETUP_STEP.PROVIDER },
    { name: "discovering models", busy: { discovering: true }, key: SETUP_STEP.MODELS },
    { name: "running the connection test", busy: { testing: true }, key: SETUP_STEP.CONNECTION }
  ];
  const resting = deriveSetupSteps(baseInput({ hasCredential: false, models: [], defaultModelId: null }));
  for (const row of rows) {
    const result = deriveSetupSteps(baseInput({ hasCredential: false, models: [], defaultModelId: null, busy: row.busy }));
    ok(stateOf(result, row.key) === STEP_STATE.PENDING, `${row.name} — its own step is pending`);
    ok(
      stateOf(result, row.key) !== STEP_STATE.DONE,
      `${row.name} — a step in flight is never reported as satisfied`
    );
    const others = keys(result)
      .filter((key) => key !== row.key)
      .map((key) => stateOf(result, key));
    ok(
      others.every((state, index) => state === resting.steps.filter((s) => s.key !== row.key)[index].state),
      `${row.name} — no other step changed state`
    );
  }
  // The connection test's own controller state marks testing without the page's
  // `testing` flag being set on this snapshot; both must read as pending.
  const viaStatus = deriveSetupSteps(baseInput({ connectionStatus: { status: "testing" } }));
  ok(stateOf(viaStatus, SETUP_STEP.CONNECTION) === STEP_STATE.PENDING, "connectionStatus 'testing' also reads as pending");
}

console.log("\n== the companion: known-broken leads, unknown never claims, broken vetoes ready ==");
{
  const withCompanion = (companion) => deriveSetupSteps(baseInput({ connectionStatus: { status: "pass" }, companion }));

  for (const detail of ["companion_not_installed", "native_host_unavailable", "unsupported_version"]) {
    const result = withCompanion(detail);
    ok(result.steps[0].key === SETUP_STEP.COMPANION, `${detail} — the companion step leads`);
    ok(result.currentKey === SETUP_STEP.COMPANION, `${detail} — the companion is the next step`);
    ok(result.ready === false, `${detail} — an otherwise complete profile is NOT ready`);
  }

  for (const known of [null, "ok", undefined]) {
    const result = withCompanion(known);
    ok(
      !result.steps.some((s) => s.key === SETUP_STEP.COMPANION),
      `${JSON.stringify(known)} — no companion step is invented when there is no evidence`
    );
    ok(result.ready === true, `${JSON.stringify(known)} — a complete profile stays ready`);
  }

  const unknown = withCompanion("something_new_from_a_future_companion");
  ok(unknown.steps[0]?.key === SETUP_STEP.COMPANION, "an unrecognised non-ok detail still leads the list");
  ok(/Chạy lại installer/.test(unknown.steps[0].detail), "an unrecognised detail falls back to an actionable line");

  const installLine = deriveSetupSteps(baseInput({ companion: "companion_not_installed" })).steps[0].detail;
  ok(/install\.sh|install\.ps1/.test(installLine), "the 'not installed' step states the command that fixes it");
  ok(installLine.includes("tải lại extension"), "…and the reload that makes it take effect");
}

console.log("\n== the order it states IS the order the product enforces ==");
{
  // `connectionGate()` decides whether the test may run and, when it may not,
  // names the first unsatisfied precondition. The walkthrough must name the
  // same one. Two independent functions, one answer.
  const gateReasonToStep = {
    no_credential: SETUP_STEP.PROVIDER,
    signed_out: SETUP_STEP.PROVIDER,
    session_expired: SETUP_STEP.PROVIDER,
    no_models: SETUP_STEP.MODELS,
    no_default_model: SETUP_STEP.MODELS
  };

  const rows = [
    baseInput({ hasCredential: false, models: [], defaultModelId: null }),
    baseInput({ models: [], defaultModelId: null }),
    baseInput({ defaultModelId: null }),
    baseInput(),
    baseInput({ connectionStatus: { status: "pass" } }),
    baseInput({ hasCredential: false }),
    baseInput({ models: [{ id: "a" }, { id: "b" }], defaultModelId: "b" }),
    baseInput({ providerType: "chatgpt", chatgptSessionState: "signed_out" }),
    baseInput({ providerType: "chatgpt", chatgptSessionState: "session_expired", hasCredential: true }),
    baseInput({ providerType: "chatgpt", chatgptSessionState: "signed_in", hasCredential: false })
  ];

  for (const input of rows) {
    // connectionGate reads the controller snapshot verbatim; the walkthrough's
    // provider half reads the same fields under the same rule.
    const gate = connectionGate({
      testing: Boolean(input.busy?.testing),
      providerType: input.providerType,
      chatgptSessionState: input.chatgptSessionState,
      hasCredential: input.hasCredential,
      models: input.models,
      defaultModelId: input.defaultModelId
    });
    const result = deriveSetupSteps(input);
    const expectedBase = gateReasonToStep[gate.reason] || null;
    const label = `gate says "${gate.reason}"`;

    if (gate.reason === "ok") {
      ok(
        result.currentKey !== SETUP_STEP.PROVIDER && result.currentKey !== SETUP_STEP.MODELS,
        `${label} — the walkthrough does not also claim the provider or models are unmet`
      );
    } else if (gate.reason === "testing") {
      ok(stateOf(result, SETUP_STEP.CONNECTION) === STEP_STATE.PENDING, `${label} — the connection step reads as pending`);
    } else {
      ok(result.currentKey === expectedBase, `${label} — the walkthrough's next step is ${expectedBase}`);
    }
  }
}

console.log("\n== defensive: a partial or empty snapshot never throws ==");
{
  for (const input of [undefined, {}, { models: null }, { connectionStatus: null }, { busy: null }]) {
    let threw = null;
    let result = null;
    try {
      result = deriveSetupSteps(input);
    } catch (err) {
      threw = err;
    }
    ok(!threw, `deriveSetupSteps(${JSON.stringify(input)}) does not throw`);
    ok(
      result && result.steps.length === 3 && result.ready === false,
      `deriveSetupSteps(${JSON.stringify(input)}) reports the three profile steps as unmet`
    );
  }
}

console.log(fail === 0 ? "\nALL SETUP-WALKTHROUGH TESTS PASSED\n" : `\n${fail} FAILED\n`);
process.exit(fail ? 1 : 0);
