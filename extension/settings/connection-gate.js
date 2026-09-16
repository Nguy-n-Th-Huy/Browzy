// Why this module exists — the settings-page defect it fixes.
//
// "Kiểm tra kết nối" (and the status card's "Kiểm tra lại") is gated on a REAL
// precondition, not a UI whim: the test runs against the DEFAULT model (the
// ChatGPT gateway binds that model — host/agent/settings/profile.js's
// requireChatgptEligible() throws NO_CREDENTIAL with "no model was requested
// and the profile has no default model"; the Anthropic path sends the same id
// to testCapability()). Disabling the control was therefore correct. Doing it
// SILENTLY was not: the one control that could satisfy the precondition lives
// in a different section ("Mô hình"), so a user staring at a dead button had
// no way to learn what the page wanted from them.
//
// Two things changed, both rooted here:
//   1. Every blocked control now reports WHY, from the same pure function —
//      the DOM layer can no longer show a disabled test button without also
//      showing its reason, and the status card's button and the provider
//      section's button can no longer disagree about whether testing is
//      possible (there is exactly one predicate, this one).
//   2. The two reasons whose fix lives in another section ("Mô hình") carry a
//      `hint` plus `jumpToModels`, which settings-app.js renders as a visible
//      line under the connection row with a link straight to that section.
//
// DOM-free on purpose, exactly like settings-controller.js and
// settings-validation.js: settings-app.js only reads the returned snapshot and
// paints it (test/settings-connection-gate.test.mjs covers every branch here,
// including the precedence between them).

export const CONNECTION_GATE_HINT_NO_MODELS =
  "Chưa có mô hình nào — kiểm tra kết nối chạy bằng mô hình mặc định, nên cần thêm một mô hình ở mục “Mô hình” bên dưới.";

export const CONNECTION_GATE_HINT_NO_DEFAULT =
  "Kiểm tra kết nối chạy bằng mô hình mặc định — chọn một mô hình ở mục “Mô hình” bên dưới.";

/** The short "why is this disabled" line per blocked reason. Only the two
 * model-related reasons get the long inline hint above (their fix is in
 * another section, so the control has to point at it); every other reason is
 * already explained by the surface standing right next to the control — the
 * ChatGPT sign-in block, the session-expired banner, or the "Chưa lưu API
 * key" status line. Even then the control itself is never silent: this title
 * travels with it. */
const BLOCKED_TITLE_VI = {
  testing: "Đang kiểm tra kết nối…",
  signed_out: "Đăng nhập ChatGPT trước khi kiểm tra kết nối.",
  session_expired: "Phiên đăng nhập ChatGPT đã hết hạn — đăng nhập lại trước khi kiểm tra kết nối.",
  no_credential: "Lưu API key trước khi kiểm tra kết nối.",
  no_models: "Thêm một mô hình trước khi kiểm tra kết nối.",
  no_default_model: "Chọn mô hình mặc định trước khi kiểm tra kết nối."
};

/**
 * Whether the connection test can run, and — when it cannot — exactly which
 * precondition is missing, in the order the user has to satisfy them: an
 * in-flight test, then the provider's own usability (a signed-in ChatGPT
 * session, or a saved API key), then a model to run against, then a default
 * one pointing at it.
 *
 * @param {{ testing: boolean, providerType: string, chatgptSessionState: string,
 *           hasCredential: boolean, models: Array<{id:string,label:string}>,
 *           defaultModelId: string|null }} state
 *   A SettingsController state snapshot (settings-controller.js's
 *   getState()) — read only, never mutated.
 * @returns {{ canTest: boolean, reason: "ok"|"testing"|"signed_out"|"session_expired"|"no_credential"|"no_models"|"no_default_model", hint: string|null, jumpToModels: boolean }}
 */
export function connectionGate(state) {
  if (state.testing) {
    // A test is already running: nothing about the configuration is wrong, so
    // no hint (and nothing to go fix) — the button reads "Đang kiểm tra…".
    return { canTest: false, reason: "testing", hint: null, jumpToModels: false };
  }

  if (state.providerType === "chatgpt") {
    // An expired session has its own banner plus its own "Đăng xuất"/sign-in
    // actions on this page; a never-signed-in profile has the sign-in block
    // right there. Naming either again as a model hint would point the user at
    // the wrong section, so the reason stands alone.
    if (state.chatgptSessionState === "session_expired") {
      return { canTest: false, reason: "session_expired", hint: null, jumpToModels: false };
    }
    if (state.chatgptSessionState !== "signed_in") {
      return { canTest: false, reason: "signed_out", hint: null, jumpToModels: false };
    }
  } else if (!state.hasCredential) {
    // Same reasoning for the API-key half: the status line above the buttons
    // ("Chưa lưu API key") names the missing piece and the key field is on the
    // same screen.
    return { canTest: false, reason: "no_credential", hint: null, jumpToModels: false };
  }

  if (state.models.length === 0) {
    return { canTest: false, reason: "no_models", hint: CONNECTION_GATE_HINT_NO_MODELS, jumpToModels: true };
  }
  if (!state.defaultModelId) {
    return { canTest: false, reason: "no_default_model", hint: CONNECTION_GATE_HINT_NO_DEFAULT, jumpToModels: true };
  }

  return { canTest: true, reason: "ok", hint: null, jumpToModels: false };
}

/**
 * The short reason line a blocked control carries as its `title` — null only
 * for "ok" (an enabled control needs no excuse).
 *
 * @param {string} reason
 * @returns {string|null}
 */
export function connectionBlockedTitle(reason) {
  return BLOCKED_TITLE_VI[reason] || null;
}
