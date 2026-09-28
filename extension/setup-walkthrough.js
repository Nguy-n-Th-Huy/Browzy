// Why this module exists — the onboarding defect it fixes.
//
// Getting Browzy from "extension loaded" to "first answer" is a six-step
// manual procedure (docs/cai-dat.md:21-78): Node + Git + a Chromium browser,
// `git clone`, `./install.sh` to register the native messaging host,
// chrome://extensions → Load unpacked, restart the browser, and only then
// configure a provider and test it. The extension can perform none of the
// first five and cannot restart the browser. Its honest job is to say WHERE in
// that sequence the user is and WHAT the next unperformed step is.
//
// It said neither, on two surfaces at once, in different words:
//
//   - The side panel's empty state rendered the greeting "Sẵn sàng trên trang
//     này" / "Chào bạn, tôi có thể giúp gì?" plus three suggestion cards
//     UNCONDITIONALLY (extension/sidepanel/sidepanel.js:2850-2872, called at
//     :2576-2579 with no readiness input), while the actual blocker lived in a
//     one-line strip *below* it, above the composer (sidepanel.js:376-434,
//     mounted at sidepanel.html:56). The three suggestions insert prompts the
//     send path refuses while the profile is incomplete, so the panel's
//     largest text claimed a readiness that had not been reached.
//   - The settings page expressed the same facts twice — a first-run banner
//     (settings-app.js:362-371) and a status card (settings-app.js:469-513) —
//     and one of the two was wrong: the card's not-configured line told the
//     user to add models "ở mục Nhà cung cấp bên dưới" (settings-app.js:478),
//     but the model list is in the next section, "Mô hình" (settings.html:465).
//
// What the module is NOT: a second copy of the product's own rules. The
// preconditions and their order already exist and are already enforced —
// extension/settings/connection-gate.js:64-88 is the single predicate
// (testing → credential/session → models → default model → ok), and
// settings-controller.js:1315-1334 mirrors its first steps. This module reads
// the SAME state fields and states their order for the user; it never decides
// whether an action is allowed. test/setup-walkthrough.test.mjs asserts the
// two agree, so a future divergence fails a test instead of shipping.
//
// DOM-free on purpose, exactly like connection-gate.js and
// settings-validation.js: the callers are the settings page's DOM layer and
// the side panel, and both only paint the returned snapshot. That is what lets
// the two surfaces state the setup identically instead of drifting apart.
//
// One more thing the two callers do NOT share: knowledge of the companion.
// The panel's connection pill classifies chrome.runtime.lastError into
// handshake details (sidepanel.js:325-329) and can therefore know the
// companion is unregistered; the settings page can only learn of it
// indirectly, as a failed get_profile. So `companion` is an OPTIONAL input:
// the panel passes its detail, the settings page passes null, and neither has
// to pretend to know more than it does.

/** The four steps setup can be in, in the order they must be performed. */
export const SETUP_STEP = Object.freeze({
  COMPANION: "companion",
  PROVIDER: "provider",
  MODELS: "models",
  CONNECTION: "connection"
});

/** Per-step progress. `pending` exists so an action that is genuinely running
 * is never reported as either satisfied or still-to-do. */
export const STEP_STATE = Object.freeze({
  DONE: "done",
  PENDING: "pending",
  TODO: "todo"
});

/** What to do about a companion that is known to be unusable, per handshake
 * detail. The keys are the values HANDSHAKE_LABEL_VI already enumerates
 * (sidepanel.js:325-329) — this table adds the ACTION, which until now existed
 * only as the connection pill's `title` tooltip (sidepanel.js:338-340, the
 * only `install.sh` occurrence in that file). A user debugging a fresh machine
 * should not have to hover over a status dot to find the command. */
const COMPANION_FIX = Object.freeze({
  companion_not_installed: {
    title: "Cài companion",
    detail:
      "Máy này chưa đăng ký native messaging host. Chạy ./install.sh (macOS/Linux) hoặc .\\install.ps1 (Windows) trong thư mục dự án, rồi tải lại extension."
  },
  native_host_unavailable: {
    title: "Khởi động lại companion",
    detail:
      "Companion đã đăng ký nhưng chưa chạy được. Chạy node host/bin/browzy.js doctor để xem nguyên nhân, rồi mở lại trình duyệt."
  },
  unsupported_version: {
    title: "Cập nhật companion",
    detail:
      "Companion đang chạy khác phiên bản với extension. Cập nhật companion và chạy lại installer."
  }
});

const COMPANION_FIX_FALLBACK = Object.freeze({
  title: "Kết nối companion",
  detail: "Chưa thiết lập được companion trên máy này. Chạy lại installer rồi tải lại extension."
});

/** Whether the provider half of the profile is satisfied. Mirrors
 * connection-gate.js:69-77 — an `anthropic` profile needs a stored credential,
 * a `chatgpt` profile needs a live session, and the two are never conflated. */
function providerSatisfied(input) {
  if (input.providerType === "chatgpt") return input.chatgptSessionState === "signed_in";
  return Boolean(input.hasCredential);
}

/** Mirrors connection-gate.js:82-85 as one step: a model list AND a default.
 * The gate separates them so it can hint about each; the walkthrough states
 * both as one step because neither half is useful alone. */
function modelsSatisfied(input) {
  const count = Array.isArray(input.models) ? input.models.length : 0;
  return count > 0 && Boolean(input.defaultModelId);
}

/** Mirrors connection-gate.js:88. A stale or failed test is never "ready". */
function connectionSatisfied(input) {
  return input.connectionStatus?.status === "pass";
}

function step(key, title, detail, state) {
  return { key, title, detail, state };
}

/**
 * The ordered setup steps for one snapshot, plus which of them is next.
 *
 * @param {object} [input]
 * @param {string|null} [input.companion] Handshake detail, or null/`"ok"` when
 *   the caller has no evidence of a problem. The settings page always passes
 *   null; only the side panel can determine this.
 * @param {"anthropic"|"chatgpt"} [input.providerType]
 * @param {boolean} [input.hasCredential] For an `anthropic` profile.
 * @param {string} [input.chatgptSessionState] For a `chatgpt` profile.
 * @param {Array} [input.models]
 * @param {string|null} [input.defaultModelId]
 * @param {object|null} [input.connectionStatus] `{ status, textOnly }`.
 * @param {object} [input.busy] Which of the page's own actions are in flight.
 * @returns {{steps: Array<{key: string, title: string, detail: string, state: string}>,
 *            currentKey: string|null,
 *            ready: boolean}}
 */
export function deriveSetupSteps(input = {}) {
  const busy = input.busy || {};
  const steps = [];

  // The companion comes first when it is known to be broken: nothing else on
  // either surface can work until it is registered, and on the panel it is
  // also the one fact the stored profile cache cannot express (a cache mirror
  // can say "ready" about a machine whose companion was never installed).
  const companionDetail = typeof input.companion === "string" ? input.companion : null;
  const companionBroken = Boolean(companionDetail) && companionDetail !== "ok";
  if (companionBroken) {
    const fix = COMPANION_FIX[companionDetail] || COMPANION_FIX_FALLBACK;
    steps.push(step(SETUP_STEP.COMPANION, fix.title, fix.detail, STEP_STATE.TODO));
  }

  const providerDone = providerSatisfied(input);
  const providerBusy =
    Boolean(busy.saving) || Boolean(busy.signingOut) || Boolean(busy.signingIn) || Boolean(busy.switchingProviderType);
  steps.push(
    step(
      SETUP_STEP.PROVIDER,
      "Nhà cung cấp",
      input.providerType === "chatgpt"
        ? "Đăng nhập bằng tài khoản ChatGPT"
        : "Base URL và API key của nhà cung cấp",
      providerDone ? STEP_STATE.DONE : providerBusy ? STEP_STATE.PENDING : STEP_STATE.TODO
    )
  );

  const modelsDone = modelsSatisfied(input);
  steps.push(
    step(
      SETUP_STEP.MODELS,
      "Mô hình",
      "Thêm ít nhất một mô hình và chọn mô hình mặc định",
      modelsDone ? STEP_STATE.DONE : busy.discovering ? STEP_STATE.PENDING : STEP_STATE.TODO
    )
  );

  const connectionDone = connectionSatisfied(input);
  const connectionBusy = Boolean(busy.testing) || input.connectionStatus?.status === "testing";
  steps.push(
    step(
      SETUP_STEP.CONNECTION,
      "Kiểm tra kết nối",
      "Xác nhận cấu hình chạy được",
      connectionDone ? STEP_STATE.DONE : connectionBusy ? STEP_STATE.PENDING : STEP_STATE.TODO
    )
  );

  const next = steps.find((entry) => entry.state !== STEP_STATE.DONE);
  return {
    steps,
    currentKey: next ? next.key : null,
    // A broken companion is a veto, not merely the first unmet step: without
    // it a profile that looks complete cannot run anything, and the panel's
    // cached profile may still describe exactly that. The search above already
    // returns the companion as `currentKey` in that case, so this is the same
    // answer stated for the one caller that must not get it wrong.
    ready: next === undefined
  };
}
