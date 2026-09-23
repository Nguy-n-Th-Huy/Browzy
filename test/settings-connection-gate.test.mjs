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
    },
    // The removed standalone `typesafe` provider type no longer has a branch
    // in the gate at all — a stray `providerType: "typesafe"` snapshot (a
    // stale value the host would migrate away on load) falls through to the
    // same `!hasCredential` check every non-chatgpt provider type uses.
    {
      name: "a stray providerType: \"typesafe\" snapshot is judged like any other non-chatgpt profile, never a special case",
      state: baseState({ providerType: "typesafe" }),
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
  const REASONS = [
    "testing", "signed_out", "session_expired", "no_credential", "no_models", "no_default_model"
  ];
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

  // Jev browser tools (jev-tools-reuse-primary-provider). One thing this
  // seam is the only place to prove: the transport key input is uncontrolled
  // like #key-input (no render path may ever write a value into it — that
  // would put a raw key back into the DOM from state).
  const providerRenderBody = appJs.slice(
    appJs.indexOf("function renderProvider(state, gate) {"),
    appJs.indexOf("function renderModels(state) {")
  );
  ok(
    providerRenderBody.length > 0 && !/jevtools-transport-key-input/.test(providerRenderBody),
    "renderProvider never touches the jev-tools transport key input (jev-tools-reuse-primary-provider) — it stays uncontrolled, like #key-input"
  );
  // jev-tools-reuse-primary-provider: the "Jev browser tools" section on an
  // anthropic/chatgpt profile has its own write-only transport key input
  // (#jevtools-transport-key-input) — the ONLY key input it has, since the
  // section collects no text-model fields at all. Same uncontrolled-secret-
  // input rule: renderProvider never touches it (asserted above), and its
  // own Save handler reads it exactly once and clears it exactly once.
  ok(
    (appJs.match(/jevToolsTransportKeyInput\.value/g) || []).length === 2,
    "the jev-tools transport key input is read once and cleared once in its own Save handler (2 references: .value read + clear)"
  );
  // The page's main #btn-save handler also reads and clears this same input,
  // through its own distinctly-named local (jevToolsTransportKeyInputMain,
  // per the comment above it) so the main Save button persists a key typed
  // in the Jev browser-tools section too. That local is invisible to the
  // regex above (it ends in "Main", not ".value" directly), so this seam
  // needs its own count-and-order proof: read once, cleared once, and the
  // clear happens before controller.save( is invoked so a raw key is never
  // left sitting once that async call is in flight.
  ok(
    (appJs.match(/jevToolsTransportKeyInputMain\.value/g) || []).length === 2,
    "the main Save handler's own local for this same input is also read once and cleared once (2 references: .value read + clear)"
  );
  const btnSaveStart = appJs.indexOf('$("btn-save").addEventListener("click", async () => {');
  const btnSaveBody = appJs.slice(
    btnSaveStart,
    appJs.indexOf('$("btn-discover-models").addEventListener(', btnSaveStart)
  );
  ok(
    btnSaveBody.length > 0 && btnSaveBody.indexOf('jevToolsTransportKeyInputMain.value = ""') < btnSaveBody.indexOf("controller.save("),
    "the clear happens before controller.save( is called in the main Save handler"
  );
  // The removed standalone `typesafe` provider type no longer has a radio, a
  // BETA badge, or its own `#typesafe-fields`/`#test-disclosure-typesafe`
  // blocks anywhere in the shipped markup.
  ok(!/id="provider-type-typesafe"/.test(html), "settings.html no longer offers the removed standalone provider type's radio");
  ok(!/id="typesafe-fields"/.test(html), "its removed field block is gone entirely");
  ok(!/id="test-disclosure-typesafe"/.test(html), "its removed test disclosure is gone entirely");
  ok(!/beta-badge/.test(html), "the beta badge that only labeled the removed provider type is gone entirely");
  ok((html.match(/<input type="radio" name="provider-type"/g) || []).length === 2,
    "the provider-type picker now offers exactly two radios — anthropic and chatgpt");

  // The endpoint field: unchanged for the two remaining provider types — one
  // input for one `profile.baseUrl` value, hidden only for `chatgpt`.
  ok(/id="provider-baseurl-item"/.test(html) && !/id="anthropic-baseurl-item"/.test(html),
    "the endpoint field group ships under a provider-neutral id");
  ok((html.match(/id="base-url"/g) || []).length === 1, "exactly one endpoint input exists");
  ok(/id="base-url-label"/.test(html) && /id="base-url-hint"/.test(html),
    "its label and hint are addressable");
  ok(/\$\("provider-baseurl-item"\)\.hidden = isChatgpt;/.test(appJs),
    "it is hidden only for chatgpt");
  ok(/const showAnthropicKey = !isChatgpt;/.test(appJs),
    "the Anthropic key field's visibility is now the simple two-provider predicate, with no decision-source branch");
  ok(/\$\("anthropic-key-item"\)\.hidden = !showAnthropicKey;/.test(appJs),
    "and the field itself is driven by that one predicate, not a second copy");

  // The Jev-tools transport section reuses the same typesafeSourceCopy table
  // (jev-tools-settings-on-llm-profiles) — the removed provider type's own
  // decision-source picker/select is gone, but this table and its consumer
  // still ship.
  ok(/const sourceCopy = typesafeSourceCopy\(state\.typesafeSource\);/.test(appJs) &&
     /\$\("jevtools-transport-source-select"\)\.value = state\.typesafeSource;/.test(appJs),
    "the source table is derived once from the same state the jev-tools transport select renders");
  ok(!/typesafe-source-select|decision-source-select/.test(html),
    "the removed standalone provider's own Jev-source and decision-source selects are gone from the markup");
}

console.log("\n== OpenRouter Jev source (task 2.3): ships alongside TypeSafe API and the Vercel gateway ==");
{
  const html = read("extension/settings/settings.html");
  ok(/<option value="openrouter">OpenRouter \(alpha\)<\/option>/.test(html),
    "the Jev source select offers OpenRouter, labeled alpha right on the option");
  // The removed standalone provider's own Jev-source select is gone; the
  // Jev browser-tools transport select (jev-tools-settings-on-llm-profiles)
  // is now the only surface offering these three sources.
  const transportSelectBody = html.slice(
    html.indexOf('id="jevtools-transport-source-select"'),
    html.indexOf("</select>", html.indexOf('id="jevtools-transport-source-select"'))
  );
  ok((transportSelectBody.match(/<option value="(typesafe|vercel|openrouter)">/g) || []).length === 3,
    "exactly the three known Jev sources are offered in the Jev-tools transport select — no stray fourth option");
}

console.log(fail === 0 ? "\nALL SETTINGS CONNECTION GATE TESTS PASSED" : `\n${fail} FAILED`);
process.exit(fail ? 1 : 0);
