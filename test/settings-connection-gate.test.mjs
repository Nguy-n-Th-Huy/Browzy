#!/usr/bin/env node
// connection-gate.js — the single predicate behind BOTH test controls on the
// settings page ("Kiểm tra kết nối" in the provider section and "Kiểm tra
// lại" in the status card).
//
// The defect this covers: the controls are gated on a real precondition (the
// test runs against the DEFAULT model — host/agent/settings/profile.js's
// requireChatgptEligible(), settings-controller.js's testConnection()), but a
// blocked control said nothing about why, and the only control that could fix
// it lives in another section ("Mô hình"). Every branch below is therefore
// also a statement about what the user is shown when a control is disabled:
// either the reason stands alone (the surface next to the control already
// explains it) or it carries a hint plus the jump link to where the fix is.
//
// The last section holds the source-level seam the DOM layer cannot be unit
// tested for (settings-app.js touches `document` at module scope and is
// verified visually, per its own header): that both buttons' disabled state
// comes from this one gate and the old duplicated predicate is gone.
//
// Run: node test/settings-connection-gate.test.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connectionGate, connectionBlockedTitle } from "../extension/settings/connection-gate.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

let fail = 0;
const ok = (cond, msg) => {
  console.log((cond ? "  PASS " : "  FAIL ") + msg);
  if (!cond) fail++;
};

// A SettingsController state snapshot (settings-controller.js's emptyState())
// in its healthy shape; each row below overrides only what it is about.
const baseState = (overrides = {}) => ({
  testing: false,
  providerType: "anthropic",
  chatgptSessionState: "signed_out",
  hasCredential: true,
  models: [{ id: "m1", label: "M1" }],
  defaultModelId: "m1",
  ...overrides
});

const NO_MODELS_HINT = "Chưa có mô hình nào — kiểm tra kết nối chạy bằng mô hình mặc định, nên cần thêm một mô hình ở mục “Mô hình” bên dưới.";
const NO_DEFAULT_HINT = "Kiểm tra kết nối chạy bằng mô hình mặc định — chọn một mô hình ở mục “Mô hình” bên dưới.";

console.log("\n== every branch: what can run, and what the user is told when it cannot ==");
{
  const rows = [
    {
      name: "anthropic, key saved, one model chosen as default",
      state: baseState(),
      expect: { canTest: true, reason: "ok", hint: null, jumpToModels: false }
    },
    {
      name: "a test already in flight",
      state: baseState({ testing: true }),
      expect: { canTest: false, reason: "testing", hint: null, jumpToModels: false }
    },
    {
      name: "a test in flight while the configuration is ALSO incomplete (in-flight wins)",
      state: baseState({ testing: true, models: [], defaultModelId: null }),
      expect: { canTest: false, reason: "testing", hint: null, jumpToModels: false }
    },
    {
      name: "chatgpt, session expired, model already chosen",
      state: baseState({ providerType: "chatgpt", chatgptSessionState: "session_expired" }),
      expect: { canTest: false, reason: "session_expired", hint: null, jumpToModels: false }
    },
    {
      name: "chatgpt, session expired AND no model yet (signing in is the first thing to fix, not the model list)",
      state: baseState({ providerType: "chatgpt", chatgptSessionState: "session_expired", models: [], defaultModelId: null }),
      expect: { canTest: false, reason: "session_expired", hint: null, jumpToModels: false }
    },
    {
      name: "chatgpt, never signed in, even though a credential is still present in the profile",
      state: baseState({ providerType: "chatgpt", chatgptSessionState: "signed_out" }),
      expect: { canTest: false, reason: "signed_out", hint: null, jumpToModels: false }
    },
    {
      name: "chatgpt, signed in, model list empty",
      state: baseState({ providerType: "chatgpt", chatgptSessionState: "signed_in", hasCredential: false, models: [], defaultModelId: null }),
      expect: { canTest: false, reason: "no_models", hint: NO_MODELS_HINT, jumpToModels: true }
    },
    {
      name: "chatgpt, signed in, models present but none chosen as default",
      state: baseState({ providerType: "chatgpt", chatgptSessionState: "signed_in", hasCredential: false, defaultModelId: null }),
      expect: { canTest: false, reason: "no_default_model", hint: NO_DEFAULT_HINT, jumpToModels: true }
    },
    {
      name: "chatgpt, signed in and fully configured (no API key by design)",
      state: baseState({ providerType: "chatgpt", chatgptSessionState: "signed_in", hasCredential: false }),
      expect: { canTest: true, reason: "ok", hint: null, jumpToModels: false }
    },
    {
      name: "anthropic with no saved key, and no default model either (the key comes first)",
      state: baseState({ hasCredential: false, defaultModelId: null }),
      expect: { canTest: false, reason: "no_credential", hint: null, jumpToModels: false }
    },
    {
      name: "anthropic with an empty model list",
      state: baseState({ models: [], defaultModelId: null }),
      expect: { canTest: false, reason: "no_models", hint: NO_MODELS_HINT, jumpToModels: true }
    },
    {
      name: "anthropic with models but no default (the state the host forbids — see _applyProfile's repair)",
      state: baseState({ defaultModelId: null }),
      expect: { canTest: false, reason: "no_default_model", hint: NO_DEFAULT_HINT, jumpToModels: true }
    },
    {
      name: "a snapshot with no providerType field at all (emptyState()'s default is anthropic)",
      state: { testing: false, hasCredential: true, models: [{ id: "m1", label: "M1" }], defaultModelId: "m1" },
      expect: { canTest: true, reason: "ok", hint: null, jumpToModels: false }
    }
  ];

  for (const row of rows) {
    const gate = connectionGate(row.state);
    ok(
      gate.canTest === row.expect.canTest && gate.reason === row.expect.reason,
      `${row.name} -> ${row.expect.reason} (canTest ${row.expect.canTest})`
    );
    ok(
      gate.hint === row.expect.hint && gate.jumpToModels === row.expect.jumpToModels,
      `${row.name} -> hint ${row.expect.hint ? "shown" : "none"}, jump link ${row.expect.jumpToModels ? "shown" : "none"}`
    );
  }

  // The gate only judges what it can see on the page: a nonempty default id
  // that names no model in the list is the host's/save()'s call (it fails the
  // save-time validation), not this gate's — it must not silently disable the
  // button for a reason it cannot explain.
  const dangling = connectionGate(baseState({ defaultModelId: "ghost" }));
  ok(dangling.canTest === true && dangling.reason === "ok", "a default id absent from the list is not this gate's decision (save() validation owns it)");
}

console.log("\n== the two hints are what the page actually puts in front of the user ==");
{
  const noModels = connectionGate(baseState({ models: [], defaultModelId: null }));
  const noDefault = connectionGate(baseState({ defaultModelId: null }));
  ok(noModels.hint === NO_MODELS_HINT, "an empty list points at the “Mô hình” section and says a model has to be added there");
  ok(noDefault.hint === NO_DEFAULT_HINT, "a list with no default asks for the default to be chosen in that same section");
  ok(noModels.hint !== noDefault.hint, "the two model reasons read differently — an empty list is not 'choose the default'");
  ok(/mặc định/.test(noModels.hint) && /mặc định/.test(noDefault.hint), "both name the default-model requirement as the reason");
  ok(/“Mô hình”/.test(noModels.hint) && /“Mô hình”/.test(noDefault.hint), "both name the section the jump link goes to");
}

console.log("\n== a blocked control is never silent: every reason has a line to carry ==");
{
  const REASONS = ["testing", "signed_out", "session_expired", "no_credential", "no_models", "no_default_model"];
  for (const reason of REASONS) {
    const title = connectionBlockedTitle(reason);
    ok(typeof title === "string" && title.trim().length > 0, `"${reason}" has a short reason line for the disabled control`);
  }
  ok(connectionBlockedTitle("ok") === null, "an enabled control carries no excuse");
  // The long inline hint is attached only to the two reasons whose fix is in
  // another section; every other blocked reason is already explained by the
  // surface standing next to the control (the sign-in block, the expired-
  // session banner, the "Chưa lưu API key" line).
  const stateByReason = {
    testing: baseState({ testing: true }),
    signed_out: baseState({ providerType: "chatgpt", chatgptSessionState: "signed_out" }),
    session_expired: baseState({ providerType: "chatgpt", chatgptSessionState: "session_expired" }),
    no_credential: baseState({ hasCredential: false }),
    no_models: baseState({ models: [], defaultModelId: null }),
    no_default_model: baseState({ defaultModelId: null })
  };
  for (const reason of REASONS) {
    const expectsHint = reason === "no_models" || reason === "no_default_model";
    const gate = connectionGate(stateByReason[reason]);
    ok(gate.reason === reason, `the "${reason}" state is reached through its own path`);
    ok(
      (gate.hint !== null) === expectsHint && gate.jumpToModels === expectsHint,
      `"${reason}" ${expectsHint ? "carries the hint and its jump link" : "stands alone — the surface next to the control already explains it"}`
    );
  }
}

console.log("\n== the gate reads the snapshot and never writes to it ==");
{
  const state = baseState({ models: [], defaultModelId: null });
  const before = JSON.stringify(state);
  connectionGate(state);
  connectionGate(state);
  ok(JSON.stringify(state) === before, "two calls leave the state snapshot byte-identical");
}

console.log("\n== shipped sources: one gate behind both controls, and the old predicate is gone ==");
{
  const appJs = read("extension/settings/settings-app.js");
  const html = read("extension/settings/settings.html");
  const gateJs = read("extension/settings/connection-gate.js");

  ok((appJs.match(/\bconnectionGate\(/g) || []).length === 1, "settings-app.js calls connectionGate() exactly once per render pass — one answer for the whole page");
  const renderBody = appJs.slice(appJs.indexOf("function render(state) {"));
  const gateAt = renderBody.indexOf("const gate = connectionGate(state);");
  const statusAt = renderBody.indexOf("renderStatusCard(state, gate);");
  const providerAt = renderBody.indexOf("renderProvider(state, gate);");
  ok(
    gateAt >= 0 && gateAt < statusAt && statusAt < providerAt,
    "that one gate is computed in render() before both test-button renderers receive it"
  );
  ok(
    (appJs.match(/retestBtn\.disabled = !gate\.canTest;/g) || []).length === 1 &&
      (appJs.match(/\$\("btn-test-connection"\)\.disabled = !gate\.canTest;/g) || []).length === 1,
    "each of the two test buttons has exactly one disabled assignment, and it comes from the gate"
  );
  ok(!/!state\.defaultModelId/.test(appJs), "the old duplicated predicate (!state.defaultModelId) is gone from the DOM layer");
  ok(!/state\.testing \|\| !state\.hasCredential/.test(appJs), "and so is the rest of the old predicate — no second copy to drift");

  ok(/id="test-gate-hint" hidden><\/p>/.test(html), "settings.html ships the hint container hidden and empty (filled only by a render)");
  ok((html.match(/id="test-gate-hint"/g) || []).length === 1, "exactly one hint container exists");
  ok(/id="section-models"/.test(html), "the jump link's target section anchor exists in the page");

  ok(/aria-describedby", "test-gate-hint"/.test(appJs), "a blocked control describes itself by the hint when the hint is showing");
  ok(/connectionBlockedTitle\(gate\.reason\)/.test(appJs), "the short reason line on a blocked control comes from the gate module's own table, not from a second copy");
  ok(/hintEl\.innerHTML = ""/.test(appJs), "the hint is emptied, never left stale behind hidden");
  ok(/jump\.href = "#section-models"/.test(appJs), "the jump link points at the “Mô hình” section anchor");

  ok(/export function connectionGate\(state\)/.test(gateJs), "connection-gate.js exports the pure gate");
  ok(
    gateJs.includes(NO_MODELS_HINT) && gateJs.includes(NO_DEFAULT_HINT),
    "the two hint strings asserted above live in connection-gate.js (single copy, not re-typed in the DOM layer)"
  );
}

console.log(fail === 0 ? "\nALL SETTINGS CONNECTION GATE TESTS PASSED" : `\n${fail} FAILED`);
process.exit(fail ? 1 : 0);
