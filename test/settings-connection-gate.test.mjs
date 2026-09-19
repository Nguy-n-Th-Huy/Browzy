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

// A `typesafe` profile's healthy shape (add-typesafe-jev-provider task 5.5):
// both keys saved, text-model base URL/model ID present and valid, one model
// chosen as default. Rows override exactly the one thing they are about.
const typesafeState = (overrides = {}) => baseState({
  providerType: "typesafe",
  hasCredential: true,
  hasTypesafeKey: true,
  hasTextModelKey: true,
  textModelBaseUrl: "https://api.openai.com/v1",
  textModelBaseUrlDraft: "https://api.openai.com/v1",
  textModelId: "gpt-5-mini",
  textModelIdDraft: "gpt-5-mini",
  ...overrides
});

// Decision-model source (task 3.6): a `typesafe` profile whose decision
// model comes from the operator's own Anthropic key, or their ChatGPT
// subscription, rather than the OpenAI-compatible text model above. Each
// fixture is fully configured for its own source; rows override exactly the
// one thing they are about.
const typesafeAnthropicDecisionState = (overrides = {}) => baseState({
  providerType: "typesafe",
  hasTypesafeKey: true,
  // The REUSED Anthropic credential (#key-input/hasCredential) — not a new
  // "TypeSafe" key.
  hasCredential: true,
  typesafeDecisionSource: "anthropic",
  decisionBaseUrl: "https://api.anthropic.com",
  decisionBaseUrlDraft: "https://api.anthropic.com",
  decisionModelId: "claude-sonnet-5",
  decisionModelIdDraft: "claude-sonnet-5",
  ...overrides
});

const typesafeChatgptDecisionState = (overrides = {}) => baseState({
  providerType: "typesafe",
  hasTypesafeKey: true,
  typesafeDecisionSource: "chatgpt",
  chatgptSessionState: "signed_in",
  decisionModelId: "gpt-5.5",
  decisionModelIdDraft: "gpt-5.5",
  ...overrides
});

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
    // TypeSafe / Jev provider (add-typesafe-jev-provider task 5.5; specs/
    // agent-settings "TypeSafe text-model fields are required"). A test runs
    // two requests against two services, so it needs both saved keys AND a
    // valid text-model base URL + model ID — in that order, because a key is
    // what the request authenticates with.
    {
      name: "typesafe, fully configured (both keys saved, text-model base URL + model ID valid)",
      state: typesafeState(),
      expect: { canTest: true, reason: "ok", hint: null, jumpToModels: false }
    },
    {
      name: "typesafe, no TypeSafe key yet",
      state: typesafeState({ hasTypesafeKey: false }),
      expect: { canTest: false, reason: "no_typesafe_key", hint: null, jumpToModels: false }
    },
    {
      name: "typesafe, TypeSafe key saved but no text-model key yet (the first key's success does not unlock testing)",
      state: typesafeState({ hasTextModelKey: false }),
      expect: { canTest: false, reason: "no_text_model_key", hint: null, jumpToModels: false }
    },
    {
      name: "typesafe, both keys saved but the text-model base URL is empty",
      state: typesafeState({ textModelBaseUrl: "", textModelBaseUrlDraft: "" }),
      expect: { canTest: false, reason: "no_text_model_config", hint: null, jumpToModels: false }
    },
    {
      name: "typesafe, both keys saved but the text-model base URL is not a usable URL",
      state: typesafeState({ textModelBaseUrl: "not a url at all", textModelBaseUrlDraft: "not a url at all" }),
      expect: { canTest: false, reason: "no_text_model_config", hint: null, jumpToModels: false }
    },
    {
      name: "typesafe, both keys saved but the text-model model ID is blank",
      state: typesafeState({ textModelId: "   ", textModelIdDraft: "   " }),
      expect: { canTest: false, reason: "no_text_model_config", hint: null, jumpToModels: false }
    },
    {
      name: "typesafe, an in-progress edit of the text-model base URL is judged too (the draft wins over the saved value)",
      state: typesafeState({ textModelBaseUrl: "https://api.openai.com/v1", textModelBaseUrlDraft: "ftp://nope.example.com" }),
      expect: { canTest: false, reason: "no_text_model_config", hint: null, jumpToModels: false }
    },
    {
      name: "typesafe, keys and text config fine but no model to run against (the model list still gates last)",
      state: typesafeState({ models: [], defaultModelId: null }),
      expect: { canTest: false, reason: "no_models", hint: NO_MODELS_HINT, jumpToModels: true }
    },
    {
      name: "typesafe, keys and text config fine but no default model chosen",
      state: typesafeState({ defaultModelId: null }),
      expect: { canTest: false, reason: "no_default_model", hint: NO_DEFAULT_HINT, jumpToModels: true }
    },
    // Decision-model source (task 3.6): only the SELECTED source's own
    // precondition gates the control — the other two sources' state is never
    // consulted.
    {
      name: "typesafe, decision source anthropic, fully configured",
      state: typesafeAnthropicDecisionState(),
      expect: { canTest: true, reason: "ok", hint: null, jumpToModels: false }
    },
    {
      name: "typesafe, decision source anthropic, the TypeSafe key still comes first",
      state: typesafeAnthropicDecisionState({ hasTypesafeKey: false }),
      expect: { canTest: false, reason: "no_typesafe_key", hint: null, jumpToModels: false }
    },
    {
      name: "typesafe, decision source anthropic, no Anthropic key saved yet",
      state: typesafeAnthropicDecisionState({ hasCredential: false }),
      expect: { canTest: false, reason: "no_decision_anthropic_key", hint: null, jumpToModels: false }
    },
    {
      name: "typesafe, decision source anthropic, key saved but its base URL is empty",
      state: typesafeAnthropicDecisionState({ decisionBaseUrl: "", decisionBaseUrlDraft: "" }),
      expect: { canTest: false, reason: "no_decision_config", hint: null, jumpToModels: false }
    },
    {
      name: "typesafe, decision source anthropic, key saved but its model ID is blank",
      state: typesafeAnthropicDecisionState({ decisionModelId: "   ", decisionModelIdDraft: "   " }),
      expect: { canTest: false, reason: "no_decision_config", hint: null, jumpToModels: false }
    },
    {
      name: "typesafe, decision source chatgpt, signed in and configured",
      state: typesafeChatgptDecisionState(),
      expect: { canTest: true, reason: "ok", hint: null, jumpToModels: false }
    },
    {
      name: "typesafe, decision source chatgpt, never signed in",
      state: typesafeChatgptDecisionState({ chatgptSessionState: "signed_out" }),
      expect: { canTest: false, reason: "signed_out", hint: null, jumpToModels: false }
    },
    {
      name: "typesafe, decision source chatgpt, session expired",
      state: typesafeChatgptDecisionState({ chatgptSessionState: "session_expired" }),
      expect: { canTest: false, reason: "session_expired", hint: null, jumpToModels: false }
    },
    {
      name: "typesafe, decision source chatgpt, signed in but no decision model ID chosen",
      state: typesafeChatgptDecisionState({ decisionModelId: "", decisionModelIdDraft: "" }),
      expect: { canTest: false, reason: "no_decision_config", hint: null, jumpToModels: false }
    },
    // The openai text-model fields play no part once another source is
    // selected — an incomplete/absent text-model config never blocks a
    // typesafe profile running its decisions on anthropic or chatgpt.
    {
      name: "typesafe, decision source anthropic, the (irrelevant) text-model fields are empty",
      state: typesafeAnthropicDecisionState({ textModelBaseUrl: "", textModelBaseUrlDraft: "", textModelId: "", textModelIdDraft: "" }),
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
    "testing", "signed_out", "session_expired", "no_credential", "no_typesafe_key", "no_text_model_key",
    "no_text_model_config", "no_decision_anthropic_key", "no_decision_config", "no_models", "no_default_model"
  ];
  for (const reason of REASONS) {
    const title = connectionBlockedTitle(reason);
    ok(typeof title === "string" && title.trim().length > 0, `"${reason}" has a short reason line for the disabled control`);
  }
  ok(connectionBlockedTitle("ok") === null, "an enabled control carries no excuse");
  // The long inline hint is attached only to the two reasons whose fix is in
  // another section; every other blocked reason is already explained by the
  // surface standing next to the control (the sign-in block, the expired-
  // session banner, the "Chưa lưu API key" line, the TypeSafe key/text-model
  // fields themselves).
  const stateByReason = {
    testing: baseState({ testing: true }),
    signed_out: baseState({ providerType: "chatgpt", chatgptSessionState: "signed_out" }),
    session_expired: baseState({ providerType: "chatgpt", chatgptSessionState: "session_expired" }),
    no_credential: baseState({ hasCredential: false }),
    no_typesafe_key: typesafeState({ hasTypesafeKey: false }),
    no_text_model_key: typesafeState({ hasTextModelKey: false }),
    no_text_model_config: typesafeState({ textModelId: "", textModelIdDraft: "" }),
    no_decision_anthropic_key: typesafeAnthropicDecisionState({ hasCredential: false }),
    no_decision_config: typesafeAnthropicDecisionState({ decisionModelId: "", decisionModelIdDraft: "" }),
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

  // TypeSafe / Jev provider (add-typesafe-jev-provider task 5.5). Two things
  // this seam is the only place to prove: the two new key inputs are
  // uncontrolled like #key-input (no render path may ever write a value into
  // them — that would put a raw key back into the DOM from state), and the
  // block/disclosure the requirements name actually ships.
  const providerRenderBody = appJs.slice(
    appJs.indexOf("function renderProvider(state, gate) {"),
    appJs.indexOf("function renderModels(state) {")
  );
  ok(
    providerRenderBody.length > 0 && !/typesafe-key-input|text-model-key-input/.test(providerRenderBody),
    "renderProvider never touches either TypeSafe key input — they stay uncontrolled, like #key-input"
  );
  ok(
    (appJs.match(/typesafeKeyInput\.value/g) || []).length === 2 && (appJs.match(/textModelKeyInput\.value/g) || []).length === 2,
    "each new key input is read once and cleared once, both in the Save handler (2 references each: .value read + clear)"
  );
  ok(/id="provider-type-typesafe" value="typesafe"/.test(html), "settings.html offers the third provider type");
  ok(/id="typesafe-fields" hidden/.test(html), "its field block ships hidden (revealed only for that provider type)");
  ok(
    /id="typesafe-disclosure"[\s\S]{0,600}TypeSafe[\s\S]{0,400}mô hình văn bản[\s\S]{0,200}tính phí riêng/.test(html),
    "the disclosure names both services the runs call and that they are billed separately"
  );
  ok(/id="test-disclosure-typesafe" hidden/.test(html), "the test disclosure for this provider type ships hidden too");
  ok(/id="provider-type-typesafe"[\s\S]{0,300}class="beta-badge">Beta</.test(html),
    "the provider-type choice labels Jev — ultrafast as beta (add-jev-beta-notice)");
  ok(/\.beta-badge\s*\{/.test(html), "the badge carries its own style in the page");

  // Screenshot toggle (add-jev-run-screenshots task 3.2; design.md decision
  // 4). Three things this seam is the only place to prove for a page the
  // suites cannot render: the toggle actually ships in the TYPESAFE block
  // (not somewhere another provider type would show it), it ships enabled,
  // and the DOM layer reads/writes it through the controller instead of a
  // second copy of the state.
  const typesafeBlock = html.slice(html.indexOf('id="typesafe-fields"'), html.indexOf('id="connection-state"'));
  ok(typesafeBlock.length > 0, "the TypeSafe block could be sliced out of settings.html for inspection");
  ok(/id="typesafe-beta-notice"[\s\S]{0,500}giai đoạn beta[\s\S]{0,300}có thể thay đổi giữa các bản cập nhật/.test(typesafeBlock),
    "the Jev section carries the beta notice — behavior and results may change between releases");
  ok(typesafeBlock.indexOf('id="typesafe-beta-notice"') < typesafeBlock.indexOf('id="typesafe-source-select"'),
    "...as the block's first element, ahead of the Jev-source field");
  const toggleAt = typesafeBlock.indexOf('id="send-screenshots"');
  const toggleRow = toggleAt < 0 ? "" : typesafeBlock.slice(typesafeBlock.lastIndexOf('<div class="field-row">', toggleAt), toggleAt);
  ok(toggleAt >= 0 && toggleRow.length > 0, "the screenshot toggle ships inside the TypeSafe block, in its own row");
  ok(/<input[^>]*id="send-screenshots"[^>]*checked/.test(typesafeBlock),
    "and it ships enabled by default (the documented default, including for profiles stored before it existed)");
  ok(/Gửi ảnh chụp màn hình cho mô hình quyết định/.test(toggleRow) && /hình ảnh/.test(toggleRow),
    "its label and hint name it, and say the model must accept image content");
  ok(/giai đoạn “hình ảnh”/.test(toggleRow), "the hint names the test's image stage as where that is proven");
  ok(/chỉ còn văn bản/.test(toggleRow), "and says what turning it off means (every request text-only) — the cost/privacy control");
  ok(/id="typesafe-disclosure"[\s\S]{0,800}ảnh chụp màn hình khi bật/.test(html),
    "the provider disclosure names the page capture among the requests sent to the text-model endpoint");
  ok((appJs.match(/\$\("send-screenshots"\)\.checked = state\.sendScreenshots;/g) || []).length === 1,
    "the DOM layer paints the toggle from controller state exactly once");
  ok(/controller\.setSendScreenshots\(e\.target\.checked\)/.test(appJs),
    "and the toggle's change handler goes through the controller — Save stays the only writer");
  ok(appJs.includes('["image", "hình ảnh"]'),
    "the capability pills list the image stage separately from the text-model stage (add-jev-run-screenshots)");
  ok(/chưa kiểm tra/.test(appJs), "and a result recorded before the image stage existed shows it as not yet tested");

  // The endpoint field (add-typesafe-endpoint-field). Three things this seam
  // is the only place to prove for a page the suites cannot render: it is the
  // SAME field the Anthropic Base URL always was (one input for one
  // `profile.baseUrl` value, shown for `typesafe` and hidden only for
  // `chatgpt`), a `typesafe` profile's label/placeholder/hint come from the
  // controller's own source table, and the key field's label, its status line
  // and its remove action read that same table instead of re-typing the
  // source's name.
  ok(/id="provider-baseurl-item"/.test(html) && !/id="anthropic-baseurl-item"/.test(html),
    "the endpoint field group ships under a provider-neutral id — it is no longer Anthropic-only");
  ok((html.match(/id="base-url"/g) || []).length === 1,
    "exactly one endpoint input exists, so a typesafe profile cannot get a second field for the same value");
  ok(/id="base-url-label"/.test(html) && /id="base-url-hint"/.test(html),
    "its label and hint are addressable, so a render can relabel them for the provider type showing it");
  ok(/\$\("provider-baseurl-item"\)\.hidden = isChatgpt;/.test(appJs),
    "it is hidden only for chatgpt — a typesafe profile shows it (that provider's endpoint IS profile.baseUrl)");
  // Task 3.6: the Anthropic API-key field is reused verbatim as the
  // `typesafe` profile's `anthropic` decision-model source's key, so it is no
  // longer hidden for EVERY typesafe profile — only when that source isn't
  // selected (still hidden for chatgpt outright, and for typesafe on any
  // other decision-model source).
  ok(/const showAnthropicKey = !isChatgpt && \(!isTypesafe \|\| decisionSource === "anthropic"\);/.test(appJs),
    "the field's visibility is one predicate: hidden for chatgpt, and for typesafe unless the anthropic decision source is selected");
  ok(/\$\("anthropic-key-item"\)\.hidden = !showAnthropicKey;/.test(appJs),
    "and the field itself is driven by that one predicate, not a second copy");
  ok(/const sourceCopy = typesafeSourceCopy\(state\.typesafeSource\);/.test(appJs) &&
     /\$\("typesafe-source-select"\)\.value = state\.typesafeSource;/.test(appJs),
    "the source table is derived once from the same state the source select renders");
  ok(/if \(isTypesafe\) \{\s*\$\("base-url-label"\)\.textContent = sourceCopy\.endpointLabel;/.test(appJs) &&
     /urlInput\.placeholder = sourceCopy\.endpointDefault;/.test(appJs) &&
     /\$\("base-url-hint"\)\.textContent = sourceCopy\.endpointHint;/.test(appJs),
    "the endpoint field's label, placeholder and hint all name the selected source (the placeholder IS its documented default)");
  ok(/\$\("base-url-label"\)\.textContent = ANTHROPIC_BASE_URL_LABEL;/.test(appJs) &&
     /\$\("base-url-hint"\)\.textContent = ANTHROPIC_BASE_URL_HINT;/.test(appJs),
    "and every other provider type gets the shipped Anthropic copy back, captured from the markup rather than re-typed");
  ok(/\$\("typesafe-key-label"\)\.textContent = sourceCopy\.keyLabel;/.test(appJs),
    "the key field's label names the selected source's key");
  ok(/`Chưa lưu \$\{sourceCopy\.keyLabel\}`/.test(appJs) && /`Đã lưu \$\{sourceCopy\.keyLabel\}\$\{memorySuffix\}`/.test(appJs),
    "so does its stored/not-stored status line");
  ok(/\$\("btn-remove-typesafe-key"\)\.textContent = sourceCopy\.keyRemoveLabel;/.test(appJs),
    "and so does its remove action");
  ok(/const \{ keyLabel \} = typesafeSourceCopy\(controller\.getState\(\)\.typesafeSource\);/.test(appJs) &&
     !/Xóa API key TypeSafe/.test(appJs),
    "the remove confirmation reads the same table at click time — no second, hardcoded name to point at the wrong key");
}

console.log("\n== OpenRouter Jev source (task 2.3): ships alongside TypeSafe API and the Vercel gateway ==");
{
  const html = read("extension/settings/settings.html");
  ok(/<option value="openrouter">OpenRouter \(alpha\)<\/option>/.test(html),
    "the Jev source select offers OpenRouter, labeled alpha right on the option");
  ok((html.match(/<option value="(typesafe|vercel|openrouter)">/g) || []).length === 3,
    "exactly the three known Jev sources are offered — no stray fourth option");
  const jevHint = html.slice(html.indexOf('id="typesafe-source-select"'), html.indexOf("</select>", html.indexOf('id="typesafe-source-select"')) + 20);
  ok(/OpenRouter/.test(html.slice(html.indexOf("</select>", html.indexOf('id="typesafe-source-select"')), html.indexOf("</select>", html.indexOf('id="typesafe-source-select"')) + 900)),
    "the static hint paragraph beside the select also documents OpenRouter's own key and route");
  ok(jevHint.length > 0, "the select itself could be sliced out of the markup");
}

console.log("\n== decision-model source picker (task 3.6) ==");
{
  const html = read("extension/settings/settings.html");
  const appJs = read("extension/settings/settings-app.js");
  ok(/id="decision-source-select"/.test(html), "the decision-model source picker ships in the typesafe block");
  ok(/<option value="openai">/.test(html) && /<option value="anthropic">/.test(html) && /<option value="chatgpt">/.test(html),
    "it offers exactly the three known decision-model sources");
  ok(/id="decision-anthropic-fields" hidden/.test(html), "the anthropic source's own fields ship hidden by default");
  ok(/id="decision-model-id-item" hidden/.test(html), "the shared decision-model-id field (needed by anthropic AND chatgpt) ships hidden by default");
  ok(/id="decision-base-url"/.test(html) && /id="decision-model-id"/.test(html),
    "the anthropic base URL and the decision model ID each have their own input");
  ok(/id="decision-openai-fields">/.test(html) && !/id="decision-openai-fields" hidden/.test(html),
    "the pre-existing text-model fields (the documented default source) ship visible by default, now wrapped in their own block");
  ok(html.indexOf('id="text-model-base-url"') > html.indexOf('id="decision-openai-fields"') &&
     html.indexOf('id="text-model-base-url"') < html.indexOf("</div>", html.indexOf('id="decision-openai-fields"')) + 4000,
    "the text-model fields now live inside that block rather than floating loose in the typesafe section");
  ok(/id="key-input-label"/.test(html), "the reused Anthropic key field's label is addressable, so its text can change per decision source");

  ok(/typesafeDisclosureText|typesafeTestDisclosureText/.test(appJs), "settings-app.js sources the two disclosures from the controller's per-source builders, not a static string");
  ok(/\$\("typesafe-disclosure"\)\.textContent = typesafeDisclosureText\(decisionSource\);/.test(appJs),
    "the provider disclosure is rebuilt from the selected decision-model source on every render");
  ok(/\$\("test-disclosure-typesafe"\)\.textContent = typesafeTestDisclosureText\(decisionSource\);/.test(appJs),
    "so is the connection-test disclosure");
  ok(/\$\("decision-source-select"\)\.addEventListener\("change", \(e\) => controller\.setTypesafeDecisionSource\(e\.target\.value\)\);/.test(appJs),
    "the select forwards its value to the controller, like every other field on this page");
  ok(/showChatgpt = isChatgpt \|\| \(isTypesafe && decisionSource === "chatgpt"\)/.test(appJs),
    "the reused ChatGPT sign-in/account/usage/sign-out block is shown for a typesafe profile on the chatgpt decision source too");
}

console.log(fail === 0 ? "\nALL SETTINGS CONNECTION GATE TESTS PASSED" : `\n${fail} FAILED`);
process.exit(fail ? 1 : 0);
