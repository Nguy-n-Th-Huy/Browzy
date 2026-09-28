// Section disclosure for the settings page: which of the page's sections is
// open, decided once, outside the DOM.
//
// Why this module exists. The settings page is a single uninterrupted scroll
// of five sections and nothing closes (settings.html:216-546). The worst of it
// is the provider section: the optional, advanced "Jev browser tools" block
// (settings.html:367-442, ~76 lines — a four-sentence notice, two sub-groups,
// its own test and its own Save) sits BETWEEN the fields a first-run user must
// fill and the row holding `Lưu` / `Kiểm tra kết nối` (settings.html:443-449),
// so saving requires scrolling past the most advanced content on the page.
//
// Collapsing a section is the user's decision, so most of this is a DEFAULT
// plus whatever the user last chose. One thing is not the user's decision: a
// section that holds an error must not be able to hide it. That single
// precedence rule is the reason this logic is a module rather than three lines
// in the DOM layer — it is the safety property of the whole feature, and
// test/settings-sections.test.mjs proves it branch by branch.
//
// Note what is deliberately NOT a rule: a section whose setup step is merely
// unsatisfied does not force itself open. The setup card that names the next
// unmet step lives outside every section and is never collapsed
// (extension/setup-walkthrough.js builds that list), so closing a section
// cannot hide the flow — while forcing every incomplete section open would
// make the disclosure useless exactly when the page is longest.
//
// DOM-free on purpose, exactly like connection-gate.js and
// settings-validation.js: settings-app.js reads this snapshot and paints it.
// Its one import is the other pure module, extension/setup-walkthrough.js —
// the section headings report those steps' own states, so the two cannot
// describe the same step differently.
// The override slot is owned by the DOM layer (it is view state, not state any
// other component needs, and settings-controller.js's shape is pinned by its
// own test) and passed in here so the precedence stays in one testable place.

/** The page's sections, in document order. */
import { deriveSetupSteps } from "../setup-walkthrough.js";

export const SECTION_KEYS = Object.freeze(["provider", "models", "jevtools", "other", "backup"]);

/** Which section owns which control, for the reveal a deep link needs.
 *
 * Every id here is an in-page destination someone can arrive at, from
 * elsewhere in the extension or from an in-page link. The panel opens
 * `settings.html#btn-test-connection` directly (sidepanel.js:362-368) and the
 * connection gate's own hint links to `#section-models` (settings-app.js:449).
 * An id that is not in this table resolves to `null` — never to a wrong
 * section — which is what keeps the setup card's own `btn-status-retest`
 * (outside every section) from opening something unrelated. */
export const SECTION_OF_CONTROL = Object.freeze({
  "section-provider": "provider",
  "section-models": "models",
  "section-jevtools": "jevtools",
  "section-other": "other",
  "section-backup": "backup",
  "btn-test-connection": "provider",
  "btn-save": "provider",
  "base-url": "provider",
  "key-input": "provider",
  "provider-baseurl-item": "provider",
  "anthropic-key-item": "provider",
  "chatgpt-fields": "provider",
  "model-add-id": "models",
  "btn-discover-models": "models",
  "model-list": "models",
  "jevtools-transport-key-input": "jevtools",
  "jevtools-transport-source-select": "jevtools",
  "btn-save-jevtools": "jevtools",
  "nav-skills": "other",
  "nav-permissions": "other",
  "nav-memory": "other",
  "nav-recorder": "other",
  "btn-export": "backup",
  "btn-import": "backup"
});

/** The section a control id belongs to, or null when it belongs to none. */
export function sectionForControl(controlId) {
  return SECTION_OF_CONTROL[controlId] || null;
}

function providerSatisfied(state) {
  if (state.providerType === "chatgpt") return state.chatgptSessionState === "signed_in";
  return Boolean(state.hasCredential);
}

function modelsSatisfied(state) {
  const count = Array.isArray(state.models) ? state.models.length : 0;
  return count > 0 && Boolean(state.defaultModelId);
}

/**
 * The default open state, from the profile alone.
 *
 * Each section opens exactly when its own setup step is unmet, and closes once
 * it is done: the provider section while no credential (or ChatGPT session) is
 * stored, the model list once the provider is done but the list is not, and
 * the Jev section only while a Jev test is in flight or recorded (it is
 * opt-in and advanced, so it is the last thing a fresh profile needs).
 *
 * The connection test is not a section — it is a row inside the provider
 * section — so an untested-but-configured profile opens nothing: the setup
 * card carries that step and its own "Kiểm tra lại" control, and the step's
 * action reveals the provider section when the user wants the row itself.
 *
 * Before the profile has been read (`loaded === false`) nothing is known, so
 * only the provider section — the first thing a fresh profile needs either way
 * — is open, and no section claims to hold anything.
 */
export function sectionDefaults(state = {}) {
  if (!state.loaded) {
    return { provider: true, models: false, jevtools: false, other: false, backup: false };
  }
  const providerDone = providerSatisfied(state);
  return {
    provider: !providerDone,
    models: providerDone && !modelsSatisfied(state),
    jevtools: Boolean(state.jevToolsTest),
    other: false,
    backup: false
  };
}

/** Sections that must not be able to hide what they hold. Only errors count —
 * see the module header on why an unsatisfied step does not. */
export function sectionErrors(state = {}) {
  return {
    provider: state.connectionStatus?.status === "fail" || Boolean(state.fieldErrors?.baseUrl),
    models: Boolean(state.fieldErrors?.models),
    jevtools: state.jevToolsTest?.status === "fail" || state.jevToolsTest?.status === "testing",
    other: false,
    backup: false
  };
}

/** The walkthrough's input, from a SettingsController snapshot.
 *
 * `companion` is null: this page cannot determine whether the companion is
 * registered — its only evidence is a failed profile read, which the setup
 * card handles on its own. The side panel, which CAN determine it, passes the
 * handshake detail instead (sidepanel.js's own deriveSetupInput). */
export function setupInputFromSettingsState(state = {}) {
  return {
    companion: null,
    providerType: state.providerType,
    hasCredential: state.hasCredential,
    chatgptSessionState: state.chatgptSessionState,
    models: state.models,
    defaultModelId: state.defaultModelId,
    connectionStatus: state.connectionStatus,
    busy: {
      saving: state.saving,
      signingOut: state.signingOut,
      signingIn: Boolean(state.signIn && state.signIn.phase !== "idle"),
      switchingProviderType: state.switchingProviderType,
      discovering: state.discovering,
      testing: state.testing
    }
  };
}

/** Per-step progress labels, and the tone class each maps to. Text first: a
 * state is never carried by colour alone (openspec/ui-dna.md). */
export const STEP_LABEL_VI = Object.freeze({ done: "Xong", pending: "Đang làm…", todo: "Cần làm" });
export const STEP_TONE = Object.freeze({ done: "is-succeeded", pending: "is-running", todo: "is-unknown" });

/** A section heading's own state, so a collapsed section still says whether it
 * needs the user. The provider and model labels are the walkthrough's states
 * for those same steps — one source, so a heading and the setup card can never
 * describe the same step differently — and `jevtools` reports its own opt-in
 * condition, which is the only thing about it a user needs while it is closed.
 * The navigation and backup sections carry no state. */
export function sectionStateLabel(state = {}, key) {
  if (key === "jevtools") return state.hasTypesafeKey ? "Đã bật" : "Chưa bật";
  const derived = deriveSetupSteps(setupInputFromSettingsState(state));
  const step = derived.steps.find((entry) => entry.key === key);
  return step ? STEP_LABEL_VI[step.state] : "";
}

/**
 * The open state to paint: the error rule first, then whatever the user (or a
 * deep link's reveal) last chose for that section, then the derived default.
 *
 * `overrides` maps a section key to a boolean. A reveal and a manual toggle
 * write the same slot, last write wins, because that is what the user
 * expects: arriving at a section by deep link and then closing it must leave
 * it closed.
 */
export function resolveSections(state = {}, overrides = {}) {
  const defaults = sectionDefaults(state);
  const errors = sectionErrors(state);
  const readOverride = (key) => {
    const value = typeof overrides?.get === "function" ? overrides.get(key) : overrides?.[key];
    return typeof value === "boolean" ? value : null;
  };
  const resolved = {};
  for (const key of SECTION_KEYS) {
    if (errors[key]) resolved[key] = true;
    else {
      const override = readOverride(key);
      resolved[key] = override === null ? Boolean(defaults[key]) : override;
    }
  }
  return resolved;
}
