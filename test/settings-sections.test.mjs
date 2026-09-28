#!/usr/bin/env node
// settings-sections.js — which settings section is open, decided outside the
// DOM.
//
// The defect this covers: the settings page is one uninterrupted scroll of
// five sections and nothing closes (settings.html:216-546), and the worst of
// it is that the optional, advanced "Jev browser tools" block
// (settings.html:367-442) sits between the fields the user must fill and the
// row holding `Lưu` / `Kiểm tra kết nối` (settings.html:443-449).
//
// Most of this module is therefore a default plus the user's own last choice —
// but one rule is NOT the user's choice, and it is the reason this logic is
// testable at all: a section holding an error must not be able to hide it. The
// last section proves the other half of that rule, that a merely-unsatisfied
// step does not seize control of the page, because the setup card that names
// the next step lives outside every section and is never collapsed.
//
// settings-app.js touches `document` at module scope and cannot be imported
// into a plain-Node test (its own header), so the cross-check at the end is
// structural: every control this module claims to own must actually exist in
// the shipped markup, or a deep link would reveal nothing.
//
// Run: node test/settings-sections.test.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  SECTION_KEYS,
  SECTION_OF_CONTROL,
  STEP_LABEL_VI,
  STEP_TONE,
  resolveSections,
  sectionDefaults,
  sectionErrors,
  sectionForControl,
  sectionStateLabel,
  setupInputFromSettingsState
} from "../extension/settings/settings-sections.js";
import { deriveSetupSteps } from "../extension/setup-walkthrough.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

let fail = 0;
const ok = (cond, msg) => {
  console.log((cond ? "  PASS " : "  FAIL ") + msg);
  if (!cond) fail++;
};

// A SettingsController snapshot (settings-controller.js's emptyState()) once
// the profile has been read; each case overrides only what it is about.
const baseState = (overrides = {}) => ({
  loaded: true,
  providerType: "anthropic",
  hasCredential: true,
  chatgptSessionState: "signed_out",
  models: [{ id: "m1", label: "M1" }],
  defaultModelId: "m1",
  connectionStatus: { status: "pass" },
  fieldErrors: { baseUrl: null, models: null },
  jevToolsTest: null,
  ...overrides
});

const openKeys = (resolved) => SECTION_KEYS.filter((key) => resolved[key]);

console.log("\n== defaults: a section opens where the work is, and closes once it is done ==");
{
  const cases = [
    {
      name: "nothing read yet — only the provider section, and no section claims anything",
      state: { loaded: false },
      expect: ["provider"]
    },
    {
      name: "fresh profile — the provider section, where the first step is",
      state: baseState({ hasCredential: false, models: [], defaultModelId: null, connectionStatus: null }),
      expect: ["provider"]
    },
    {
      name: "provider done, model list still empty — the model list opens, the provider section closes",
      state: baseState({ models: [], defaultModelId: null, connectionStatus: null }),
      expect: ["models"]
    },
    {
      name: "fully configured but never tested — no section owns the test row, the card carries that step",
      state: baseState({ connectionStatus: null }),
      expect: []
    },
    {
      name: "complete and verified — no section opens for the user",
      state: baseState(),
      expect: []
    },
    {
      name: "an opted-in Jev user with a recorded test keeps that section open",
      state: baseState({ jevToolsTest: { status: "pass" } }),
      expect: ["jevtools"]
    },
    {
      name: "a ChatGPT profile that is signed out opens the provider section",
      state: baseState({ providerType: "chatgpt", chatgptSessionState: "signed_out", hasCredential: false }),
      expect: ["provider"]
    },
    {
      name: "the navigation and backup sections never open on their own",
      state: baseState({ hasCredential: false, models: [], defaultModelId: null, connectionStatus: null }),
      expect: ["provider"]
    }
  ];

  for (const row of cases) {
    const actual = openKeys(sectionDefaults(row.state));
    ok(
      JSON.stringify(actual) === JSON.stringify(row.expect),
      `${row.name} — default open: [${row.expect.join(", ")}]`
    );
  }

  // Every section key has a default, so nothing can be left undefined.
  const defaults = sectionDefaults(baseState());
  ok(
    SECTION_KEYS.every((key) => typeof defaults[key] === "boolean"),
    "every section key has an explicit boolean default"
  );
}

console.log("\n== the user's choice wins over the default, and is the same slot a reveal writes ==");
{
  const state = baseState({ connectionStatus: null }); // provider defaults open, models closed
  ok(resolveSections(state, { provider: false }).provider === false, "an explicit close beats the default");
  ok(resolveSections(state, { models: true }).models === true, "an explicit open beats the default");
  ok(resolveSections(state, { backup: true }).backup === true, "a section that never defaults open can still be opened");
  ok(
    resolveSections(state, new Map([["models", true]])).models === true,
    "a Map works as the override store too (the DOM layer's own container)"
  );
  // Arriving by deep link and then closing the section must leave it closed:
  // the reveal and the toggle write the same slot, last write wins.
  const revealed = resolveSections(state, { models: true });
  ok(revealed.models === true, "a reveal opens its section");
  ok(
    resolveSections(state, { models: false }).models === false,
    "…and a later close is not overridden by the earlier reveal"
  );
  for (const key of SECTION_KEYS) {
    ok(
      resolveSections(state, {})[key] === sectionDefaults(state)[key],
      `${key}: no override means the derived default`
    );
  }
}

console.log("\n== an error is never hidden; an unsatisfied step is still the user's to collapse ==");
{
  const errorCases = [
    {
      name: "a failed connection test keeps the provider section open",
      state: baseState({ connectionStatus: { status: "fail" } }),
      key: "provider"
    },
    {
      name: "a base-URL field error keeps the provider section open",
      state: baseState({ connectionStatus: null, fieldErrors: { baseUrl: "Base URL không hợp lệ", models: null } }),
      key: "provider"
    },
    {
      name: "a model-list field error keeps the model section open",
      state: baseState({ fieldErrors: { baseUrl: null, models: "Danh sách mô hình không hợp lệ" } }),
      key: "models"
    },
    {
      name: "a failed Jev test keeps the Jev section open",
      state: baseState({ jevToolsTest: { status: "fail" } }),
      key: "jevtools"
    },
    {
      name: "a Jev test in flight keeps the Jev section open",
      state: baseState({ jevToolsTest: { status: "testing" } }),
      key: "jevtools"
    }
  ];

  for (const row of errorCases) {
    ok(sectionErrors(row.state)[row.key] === true, `${row.name} — it is an error`);
    const closed = resolveSections(row.state, { [row.key]: false });
    ok(closed[row.key] === true, `${row.name} — and the section is presented open anyway`);
    const revealed = resolveSections(row.state, { [row.key]: true });
    ok(revealed[row.key] === true, `${row.name} — a reveal cannot close it either`);
  }

  // The converse, which is what keeps the disclosure worth having during setup.
  const fresh = baseState({ hasCredential: false, models: [], defaultModelId: null, connectionStatus: null });
  ok(sectionErrors(fresh).provider === false, "an unsatisfied provider step is not an error");
  ok(resolveSections(fresh, { provider: false }).provider === false, "so the user may collapse it");
  ok(sectionErrors(fresh).models === false, "an empty model list is not an error");
  ok(resolveSections(fresh, { models: false }).models === false, "so the user may collapse that too");
}

console.log("\n== a control that belongs to no section resolves to none, never to a wrong one ==");
{
  ok(sectionForControl("btn-test-connection") === "provider", "the panel's deep-link target is owned by the provider section");
  ok(sectionForControl("section-models") === "models", "the gate hint's jump target is owned by the model section");
  ok(sectionForControl("btn-status-retest") === null, "the setup card's own re-test control sits outside every section");
  ok(sectionForControl("no-such-control") === null, "an unknown control opens nothing");
  ok(sectionForControl(undefined) === null, "a missing control id opens nothing");
}

console.log("\n== every mapped control id exists in the shipped markup ==");
{
  const html = read("extension/settings/settings.html");
  const missing = Object.keys(SECTION_OF_CONTROL).filter((id) => !new RegExp(`id="${id}"`).test(html));
  ok(missing.length === 0, `every mapped id is present in settings.html (missing: ${missing.join(", ") || "none"})`);
  ok(
    SECTION_KEYS.every((key) => Object.values(SECTION_OF_CONTROL).includes(key)),
    "every section in SECTION_KEYS is reachable from at least one control id"
  );
  for (const key of SECTION_KEYS) {
    ok(new RegExp(`id="section-${key}"`).test(html), `settings.html carries an id="section-${key}" anchor`);
  }
}

console.log("\n== each heading's state label comes from the same steps the card shows ==");
{
  const fresh = { loaded: true, providerType: "anthropic", hasCredential: false, models: [], defaultModelId: null, connectionStatus: null };
  const configured = { loaded: true, providerType: "anthropic", hasCredential: true, models: [{ id: "m1" }], defaultModelId: "m1", connectionStatus: null };
  const signedOutChatgpt = { loaded: true, providerType: "chatgpt", chatgptSessionState: "signed_out", models: [], defaultModelId: null };

  ok(sectionStateLabel(fresh, "provider") === "Cần làm", "a fresh profile's provider heading says Cần làm");
  ok(sectionStateLabel(configured, "provider") === "Xong", "a stored credential's provider heading says Xong");
  ok(sectionStateLabel(signedOutChatgpt, "provider") === "Cần làm", "a signed-out chatgpt profile's provider heading says Cần làm");
  ok(sectionStateLabel(fresh, "models") === "Cần làm", "an empty model list says Cần làm");
  ok(sectionStateLabel(configured, "models") === "Xong", "a chosen default model says Xong");
  ok(sectionStateLabel({ ...configured, jevToolsSendScreenshots: true }, "jevtools") === "Chưa bật", "the Jev heading says Chưa bật without a transport key");
  ok(sectionStateLabel({ ...configured, hasTypesafeKey: true }, "jevtools") === "Đã bật", "…and Đã bật with one");
  ok(sectionStateLabel(configured, "other") === "", "the navigation section carries no state");
  ok(sectionStateLabel(configured, "backup") === "", "nor does the backup section");

  // The heading and the card must not be able to disagree: the label is
  // literally the walkthrough's own state for that step.
  const derived = deriveSetupSteps(setupInputFromSettingsState(configured));
  const modelsStep = derived.steps.find((step) => step.key === "models");
  ok(sectionStateLabel(configured, "models") === STEP_LABEL_VI[modelsStep.state], "the heading's text is the step's own label");
  ok(
    Object.values(STEP_LABEL_VI).length === 3 && Object.values(STEP_TONE).length === 3,
    "every step state has both a label and a tone class"
  );
  ok(
    Object.keys(STEP_LABEL_VI).join() === Object.keys(STEP_TONE).join(),
    "the label and tone tables cover exactly the same states"
  );
}

console.log("\n== the settings page's walkthrough input never claims companion knowledge ==");
{
  const input = setupInputFromSettingsState({
    providerType: "anthropic",
    hasCredential: true,
    models: [],
    defaultModelId: null,
    connectionStatus: { status: "pass" },
    saving: true,
    discovering: true,
    testing: true,
    switchingProviderType: true,
    signingOut: true,
    signIn: { phase: "pending_device" }
  });
  ok(input.companion === null, "companion is null — this page cannot determine registration");
  ok(input.busy.saving && input.busy.discovering && input.busy.testing && input.busy.switchingProviderType && input.busy.signingOut, "each boolean flag is forwarded");
  ok(input.busy.signingIn === true, "an active sign-in phase reads as signingIn");
  const idle = setupInputFromSettingsState({ providerType: "anthropic", signIn: { phase: "idle" } });
  ok(idle.busy.signingIn === false, "an idle sign-in phase does not");
  const noSignIn = setupInputFromSettingsState({ providerType: "anthropic" });
  ok(noSignIn.busy.signingIn === false, "a missing signIn object does not throw and reads as not signing in");
  ok(deriveSetupSteps(setupInputFromSettingsState({})).steps.length === 3, "an empty state still yields the three profile steps");
}

console.log(fail === 0 ? "\nALL SETTINGS-SECTIONS TESTS PASSED\n" : `\n${fail} FAILED\n`);
process.exit(fail ? 1 : 0);
