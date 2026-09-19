// DOM-agnostic settings-page state machine (design.md decision 4 / task 4.4).
//
// Kept free of any `document`/`chrome` reference on purpose so it can be
// exercised directly from plain Node tests (test/settings-ui-*.test.mjs)
// against a fake or real-wrapping companion client, the same way this
// project already tests extension/humanize/*'s pure planners and
// extension/background.js's handlers via extraction (test/handlers.test.mjs)
// — here the "extraction" is simply: don't couple logic to the DOM in the
// first place. `extension/settings/settings-app.js` is the thin, untested-by-
// design DOM binding layer; visual correctness there is verified by the real
// captured screenshots per the visual-acceptance protocol already
// established in reports/05-visual-system.md, not by a DOM-diffing test.
//
// Secret handling (spec "Secret isolation" — the headline assertion this
// whole module is built around): the raw API key is NEVER mirrored into
// `this.state` at all (not even transiently while the user types) — unlike
// every other field here, the settings page's key `<input>`s are deliberately
// left UNCONTROLLED by controller state. `save(secretInput, typesafeSecrets)`
// takes the raw values as plain function arguments, read live from the DOM by
// settings-app.js at the moment Save is clicked, so they are never broadcast
// through `onChange`/`getState()` on every keystroke the way a controlled
// field would. That is all three keys of the page — the Anthropic one
// (`secretInput`) and the two a `typesafe` profile uses (`typesafeSecrets`,
// add-typesafe-jev-provider task 5.5) — on one rule, with the same clearing
// behavior in the DOM layer. The only place a raw key value is EVER held by
// this class is `#pendingSecretForRetry`, a true private class field (never
// enumerable, never included in `getState()`'s plain-object snapshot, never
// logged). It holds either the Anthropic key string or a `typesafe` profile's
// `{ typesafeApiKey, textModelApiKey }` pair, and exists only to let an
// explicit, user-confirmed memory-only retry proceed after a
// SECURE_STORAGE_UNAVAILABLE failure without forcing the user to retype the
// key(s) they just submitted; it is cleared (`= null`) after every save
// attempt's outcome, on `init()`/`switchProfile()`, and on
// `removeCredential()`/`removeTypesafeKey()`.

import { validateBaseUrl, validateModelsList, validateTextModelBaseUrl, DEFAULT_BASE_URL } from "./settings-validation.js";
import { describeErrorCode, typesafeStageLabel } from "./errors-ui.js";

const DEFAULT_PROFILE_ID = "default";

// ChatGPT sign-in status poll interval (design.md decision 7 / tasks.md
// 5.3): "poll status every 1 s while pending". A plain constant, not a
// magic number repeated at each call site below.
const CHATGPT_SIGNIN_POLL_MS = 1000;

/** A fresh, idle sign-in sub-state — used both for the initial state and to
 * reset back to "nothing in flight" after every terminal outcome (signed in,
 * failed, or cancelled). Kept as its own small factory so every reset site
 * below produces the exact same shape (never a half-cleared previous one). */
function emptySignInState() {
  return {
    phase: "idle", // idle | starting_browser | starting_device | pending_browser | pending_device | cancelling
    signInId: null,
    authUrl: null,
    userCode: null,
    verificationUrl: null,
    expiresAt: null, // epoch ms
    error: null // { code, message } — set only on a "failed" outcome, cleared on the next attempt
  };
}

function emptyState(profileId) {
  return {
    profileId,
    loaded: false,
    loadError: null,

    baseUrl: DEFAULT_BASE_URL,
    baseUrlDraft: DEFAULT_BASE_URL,
    models: [],
    defaultModelId: null,

    hasCredential: false,
    memoryOnlyCredential: false,
    secretBackend: null,
    pendingMemoryOnlyOffer: false, // true only while awaiting an explicit memory-only confirmation
    // Which half of the page the outstanding offer belongs to: "credential"
    // (the API-key save path) or "sign_in" (a ChatGPT sign-in that failed
    // with SECURE_STORAGE_UNAVAILABLE). The DOM layer labels and wires the
    // confirm button from this — the two confirmations are different
    // operations (retry the save vs. re-run the sign-in flow with
    // `memoryOnly: true`). null when no offer is outstanding.
    memoryOnlyOfferKind: null,

    // Provider type (add-chatgpt-subscription-provider design.md decisions
    // 3/5/7). `chatgptAccount`/`chatgptSessionState` mirror
    // host/agent/settings/profile.js's loadProfile() fields verbatim; see
    // _applyProfile() below. `signIn` is this controller's OWN transient
    // state for an in-progress ChatGPT sign-in — it is never part of the
    // stored profile and never survives init()/switchProfile().
    providerType: "anthropic",
    chatgptAccount: null,
    chatgptSessionState: "signed_out",
    switchingProviderType: false,
    signingOut: false,
    signIn: emptySignInState(),
    // TypeSafe / Jev provider (add-typesafe-jev-provider task 5.5). The five
    // non-secret fields this page receives from
    // host/agent/settings/profile.js's loadProfile() for a `typesafe` profile:
    // the text-model base URL and model ID (draft + saved, exactly like
    // `baseUrl`/`baseUrlDraft` above), the two has-key booleans, and the Jev
    // source choice. The key VALUES are never readable — they live in the OS
    // credential store and come back from the companion as booleans only (see
    // settings-client.js's wire contract), which is why the key inputs stay
    // uncontrolled like the Anthropic one (file header).
    textModelBaseUrl: "",
    textModelBaseUrlDraft: "",
    textModelId: "",
    textModelIdDraft: "",
    hasTypesafeKey: false,
    hasTextModelKey: false,
    // The Jev source ("typesafe" | "vercel"). The literal pair is hand-synced
    // from profile-schema.js's TYPESAFE_SOURCES for the same reason the panel
    // hand-syncs protocol literals: the extension cannot import a host
    // module. An unrecognized stored value loads as the default in
    // _applyProfile; setTypesafeSource() refuses anything else.
    typesafeSource: "typesafe",
    // The decision-model source (task 3.6) and its own two fields — the
    // pair `anthropic` uses (base URL + the profile's existing Anthropic
    // key, reused verbatim through #key-input/hasCredential below rather
    // than a new op) and the model ID both `anthropic` and `chatgpt` need
    // (host/agent/settings/profile.js's setTypesafeConfig() requires a
    // nonempty typesafeDecisionModelId for either non-openai source). The
    // literal triple is hand-synced from profile-schema.js's
    // TYPESAFE_DECISION_SOURCES for the same reason typesafeSource above is.
    // `openai` is the documented default; the openai case keeps using the
    // text-model fields above rather than these two.
    typesafeDecisionSource: "openai",
    decisionBaseUrl: "",
    decisionBaseUrlDraft: "",
    decisionModelId: "",
    decisionModelIdDraft: "",
    // The screenshot toggle (add-jev-run-screenshots task 3.2; design.md
    // decision 4): whether a run captures the bound tab once per cycle and
    // attaches it to the configured model's step decision. A non-secret
    // profile field persisted by save() through set_typesafe_config, enabled
    // by default — an absent field (a profile stored before the toggle
    // existed, or a companion that predates it) loads as enabled, which is
    // the documented default, so the initial state here is that same `true`.
    sendScreenshots: true,
    // The consult-sources toggle (jev-runs-consult-sources-beyond-the-page
    // task 5.2; specs/agent-settings "The TypeSafe provider discloses and
    // controls source consultation"): whether a run may fetch, read-only, at
    // most 3 URLs it saw on the driven page or that the goal named. A
    // non-secret profile field persisted by save() through
    // set_typesafe_config, enabled by default — an absent field (a profile
    // stored before the toggle existed, or a companion that predates it)
    // loads as enabled, the documented default
    // (host/agent/settings/profile-schema.js's resolveConsultSources()), so
    // the initial state here is that same `true`.
    consultSources: true,
    // ChatGPT account usage (add-chatgpt-usage-check design.md decision 6).
    // Display-only: `usage` is the companion's display-shaped result (the
    // exact six-key reply — see settings-client.js's wire contract) and is
    // never written back to the profile, to extension storage, or to a
    // mirror. `status` drives the block's loading/ready/error rendering; a
    // profile that is not signed in never leaves "idle" because no read is
    // ever issued for it (see refreshUsage()).
    usage: { status: "idle", usage: null, error: null },

    saving: false,
    testing: false,
    discovering: false,
    removingCredential: false,

    fieldErrors: { baseUrl: null, models: null, textModelBaseUrl: null, textModelId: null, decisionBaseUrl: null, decisionModelId: null },
    banner: null, // { kind: "error"|"info"|"success", title, message, action, code }
    connectionStatus: null, // { status: "testing"|"pass"|"fail", capabilities, errors, timestamp, modelId, textOnly }

    isFirstRun: false
  };
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

// --- TypeSafe source facts and copy (add-typesafe-endpoint-field) ----------
//
// A `typesafe` profile's endpoint IS `profile.baseUrl`, defaulted per Jev
// source and remapped on a source change only while it is still a KNOWN
// default (host/agent/settings/profile.js's endpointForProviderSwitch /
// setTypesafeConfig). The two documented endpoints below are hand-synced from
// profile-schema.js's DEFAULT_TYPESAFE_BASE_URL /
// DEFAULT_TYPESAFE_GATEWAY_BASE_URL, for the same reason the source literals
// in `emptyState()` are: the extension page cannot import a host module. The
// page mirrors that rule in the endpoint draft (see `setTypesafeSource`) and
// names the selected source on every source-dependent surface of the TypeSafe
// block — the endpoint field, the key field, and the key's remove action — all
// of which read this one table.
//
// It lives here rather than in settings-app.js because that file touches
// `document` at module scope and cannot be imported by the plain-Node suites
// (file header): these are the strings the tests pin, and the source-name
// derivation they all share.
const TYPESAFE_SOURCE_COPY = Object.freeze({
  typesafe: Object.freeze({
    endpointDefault: "https://api.typesafe.ai",
    endpointLabel: "Điểm cuối Jev — TypeSafe API",
    endpointHint: "Mặc định của TypeSafe API là https://api.typesafe.ai. Khi đổi nguồn, điểm cuối chỉ được đặt lại nếu nó vẫn đang là mặc định; điểm cuối bạn tự nhập (gateway riêng, proxy) được giữ nguyên.",
    keyLabel: "API key TypeSafe",
    keyRemoveLabel: "Xóa key TypeSafe"
  }),
  vercel: Object.freeze({
    endpointDefault: "https://ai-gateway.vercel.sh",
    endpointLabel: "Điểm cuối Jev — Vercel AI Gateway",
    endpointHint: "Mặc định của Vercel AI Gateway là https://ai-gateway.vercel.sh. Khi đổi nguồn, điểm cuối chỉ được đặt lại nếu nó vẫn đang là mặc định; điểm cuối bạn tự nhập (gateway riêng, proxy) được giữ nguyên.",
    keyLabel: "API key Vercel AI Gateway",
    keyRemoveLabel: "Xóa key Vercel AI Gateway"
  }),
  // OpenRouter (task 2.3): its decision route lives under `/api/alpha/`
  // (host/agent/jev/client.js), so this is the one source the settings page
  // must label alpha wherever it is selected — the endpoint hint and the
  // provider's own disclosure both name it, matching the spec sentence "A
  // source published as alpha SHALL be labeled as such where it is selected."
  openrouter: Object.freeze({
    endpointDefault: "https://openrouter.ai",
    endpointLabel: "Điểm cuối Jev — OpenRouter (alpha)",
    endpointHint: "Mặc định của OpenRouter là https://openrouter.ai. OpenRouter công bố tuyến quyết định dưới /api/alpha/, nên giao thức có thể thay đổi giữa các bản cập nhật. Khi đổi nguồn, điểm cuối chỉ được đặt lại nếu nó vẫn đang là mặc định; điểm cuối bạn tự nhập (gateway riêng, proxy) được giữ nguyên.",
    keyLabel: "API key OpenRouter",
    keyRemoveLabel: "Xóa key OpenRouter"
  })
});

/** The two documented endpoints in one place: what the page's source-change
 * rule treats as "still a known default, safe to move". */
const KNOWN_TYPESAFE_ENDPOINTS = new Set(
  Object.values(TYPESAFE_SOURCE_COPY).map((entry) => entry.endpointDefault)
);

/** The copy and documented endpoint for one Jev source. An unknown source
 * falls back to the documented default source, matching
 * `resolveTypesafeSource()` host-side — state.typesafeSource can never hold
 * one anyway (_applyProfile coerces, setTypesafeSource refuses). */
export function typesafeSourceCopy(source) {
  if (source === "vercel") return TYPESAFE_SOURCE_COPY.vercel;
  if (source === "openrouter") return TYPESAFE_SOURCE_COPY.openrouter;
  return TYPESAFE_SOURCE_COPY.typesafe;
}

// --- Decision-model source facts and copy (task 3.6) -----------------------
//
// A `typesafe` profile's DECISION model (the one that plans, decides every
// step, revises memory and judges completion — Jev only ever answers the
// element-selection question) comes from one of three sources, hand-synced
// from profile-schema.js's TYPESAFE_DECISION_SOURCES for the same reason the
// Jev source literals above are: the extension page cannot import a host
// module. `openai` is the documented default (a profile saved before this
// choice existed loads as `openai` with its text-model fields unchanged), and
// the picker shows only the selected source's own fields
// (specs/typesafe-jev-provider "Provider type and configuration surface").
const TYPESAFE_DECISION_SOURCE_COPY = Object.freeze({
  openai: Object.freeze({
    optionLabel: "Mô hình văn bản (tương thích OpenAI)",
    // The phrase the disclosure/test-disclosure builders below splice in —
    // "mô hình văn bản" is the exact phrase existing tests
    // (test/settings-connection-gate.test.mjs, test/settings-ui-controller.
    // test.mjs) already pin for this, the documented default, source.
    targetName: "điểm cuối mô hình văn bản bạn cấu hình"
  }),
  anthropic: Object.freeze({
    optionLabel: "Điểm cuối & khóa Anthropic",
    targetName: "điểm cuối Anthropic bạn cấu hình"
  }),
  chatgpt: Object.freeze({
    optionLabel: "Tài khoản ChatGPT (qua companion)",
    targetName: "gói đăng ký ChatGPT của bạn, qua cổng cục bộ của companion"
  })
});

/** The copy for one decision-model source. An unrecognized value falls back
 * to the documented default (`openai`), matching
 * `resolveTypesafeDecisionSource()` host-side. */
export function typesafeDecisionSourceCopy(source) {
  if (source === "anthropic") return TYPESAFE_DECISION_SOURCE_COPY.anthropic;
  if (source === "chatgpt") return TYPESAFE_DECISION_SOURCE_COPY.chatgpt;
  return TYPESAFE_DECISION_SOURCE_COPY.openai;
}

/** The provider's own disclosure (specs/agent-settings "TypeSafe disclosure
 * names what is sent where"): names TypeSafe (the element-selection wire)
 * and, separately, the selected decision-model source — the operator's
 * Anthropic endpoint, their ChatGPT subscription through the local gateway,
 * or the configured text-model endpoint. */
export function typesafeDisclosureText(decisionSource) {
  const { targetName } = typesafeDecisionSourceCopy(decisionSource);
  return (
    `Chạy qua nhà cung cấp này gửi các yêu cầu chọn phần tử có cấu trúc tới TypeSafe và, tới ${targetName}: ` +
    "kế hoạch ngữ cảnh, từng quyết định bước (kèm ảnh chụp màn hình khi bật, giá trị văn bản và URL khi cần), " +
    "cập nhật ngữ cảnh, kiểm tra hoàn thành, gỡ bế tắc. Hai dịch vụ tính phí (hoặc giới hạn sử dụng) riêng theo điều khoản của từng dịch vụ."
  );
}

/** The connection test's own disclosure (specs/agent-settings "Explicit
 * compatibility and connection testing": "for a typesafe profile that it
 * calls both the TypeSafe endpoint and the selected decision-model source").
 * The ChatGPT source reads differently on purpose — it counts against the
 * subscription's usage limit, not an API bill. */
export function typesafeTestDisclosureText(decisionSource) {
  if (decisionSource === "chatgpt") {
    return (
      "Kiểm tra kết nối gửi một yêu cầu nhỏ tới TypeSafe, và tính vào giới hạn sử dụng của tài khoản ChatGPT cho mô hình quyết định " +
      "— trong đó có một yêu cầu mang ảnh nhỏ để chứng minh mô hình nhận được nội dung hình ảnh."
    );
  }
  const { targetName } = typesafeDecisionSourceCopy(decisionSource);
  return (
    `Kiểm tra kết nối gửi một yêu cầu nhỏ tới cả TypeSafe và ${targetName} ` +
    "— trong đó có một yêu cầu mang ảnh nhỏ để chứng minh mô hình nhận được nội dung hình ảnh — và có thể phát sinh chi phí API ở cả hai dịch vụ."
  );
}

/** Whether `value` is one of the two documented endpoints — judged on the
 * NORMALIZED form, the string a Save would actually send (validateBaseUrl),
 * so a trailing slash or a terminal `/v1` cannot make the page and the host
 * disagree about whether the endpoint is still a known default. */
function isKnownTypesafeEndpoint(value) {
  if (typeof value !== "string") return false;
  const result = validateBaseUrl(value);
  return result.ok && KNOWN_TYPESAFE_ENDPOINTS.has(result.normalized);
}

export class SettingsController {
  /** @type {string|null} true private class field — never enumerable, never
   * included by JSON.stringify(this) or getState(); see file header. */
  #pendingSecretForRetry = null;

  /** @type {"browser"|"device"|null} which ChatGPT sign-in flow a pending
   * memory-only offer would retry. Private for the same reason as
   * `#pendingSecretForRetry` above: it is transient UI bookkeeping, not
   * profile state. */
  #pendingSignInFlow = null;

  /** Monotonic tag for the newest ChatGPT usage read (add-chatgpt-usage-check).
   * A response whose tag is no longer current — a newer read replaced it, or
   * `init()` reset the page — is discarded rather than written into state.
   * Private for the same reason as the fields above: transient bookkeeping,
   * never part of the state snapshot. */
  #usageReadTag = 0;

  /**
   * @param {ReturnType<import("./settings-client.js").createSettingsClient>} client
   * @param {{ profileId?: string, onChange?: (state: object) => void,
   *   setIntervalFn?: Function, clearIntervalFn?: Function, pollIntervalMs?: number,
   *   now?: () => number }} [opts]
   *   `setIntervalFn`/`clearIntervalFn` default to the real timer globals —
   *   overridable so a test can drive the ChatGPT sign-in poll deterministically
   *   without a real 1-second wait (this module has no `document`/`chrome`
   *   reference; see file header — timers are the one platform primitive it
   *   does need, so they are injectable the same way host/agent/chatgpt/auth.js
   *   injects its own clock/network dependencies). `now` serves the same
   *   purpose for the usage block: it turns a reply's relative
   *   `resetAfterSeconds` into the absolute reset moment the DOM layer counts
   *   down to, so that moment is deterministic under test.
   */
  constructor(client, opts = {}) {
    this.client = client;
    this.onChange = opts.onChange || null;
    this.state = emptyState(opts.profileId || DEFAULT_PROFILE_ID);
    this.#pendingSecretForRetry = null;
    this._setIntervalFn = opts.setIntervalFn || ((fn, ms) => setInterval(fn, ms));
    this._clearIntervalFn = opts.clearIntervalFn || ((id) => clearInterval(id));
    this._pollIntervalMs = opts.pollIntervalMs || CHATGPT_SIGNIN_POLL_MS;
    this._pollTimer = null;
    this._now = opts.now || (() => Date.now());
    // The one usage read currently in flight, or null — see refreshUsage().
    this._usageInFlight = null;
  }

  getState() {
    return deepClone(this.state);
  }

  _notify() {
    if (this.onChange) this.onChange(this.getState());
  }

  _applyProfile(profile) {
    const s = this.state;
    s.loaded = true;
    s.loadError = null;
    s.baseUrl = profile.baseUrl;
    s.baseUrlDraft = profile.baseUrl;
    s.models = profile.models.map((m) => ({ ...m }));
    // A nonempty model list with no default is a state the HOST forbids:
    // host/agent/settings/models.js's validateModels() requires "a default
    // model is required when the model list is nonempty". A profile that
    // nevertheless arrives that way (written before that rule, or hand-edited
    // on disk) used to render as a permanently dead "Kiểm tra kết nối" —
    // nothing on this page could choose a default for an already-loaded list.
    // Adopt the first model, exactly the promotion removeModel() already
    // performs locally when the current default is removed; local state only
    // (no host write), so it persists on the next Save like every other
    // model-list edit made here.
    s.defaultModelId = profile.defaultModelId || (s.models.length ? s.models[0].id : null);
    s.hasCredential = Boolean(profile.hasCredential);
    s.memoryOnlyCredential = Boolean(profile.memoryOnlyCredential);
    s.secretBackend = profile.secretBackend || null;
    s.providerType = profile.providerType || "anthropic";
    s.chatgptAccount = profile.chatgptAccount || null;
    s.chatgptSessionState = profile.chatgptSessionState || "signed_out";
    // TypeSafe / Jev provider (add-typesafe-jev-provider task 5.5): the
    // text-model fields and the two has-key booleans, taken verbatim from the
    // companion's secret-free profile. Absent (an anthropic/chatgpt profile,
    // or one saved before this provider existed) means empty/false, never a
    // stale value carried over from a previously displayed profile — this
    // runs on a fresh state after every init()/switchProfile(), but also
    // after setProviderType()/save() replies, where it must overwrite
    // whatever the previous provider type left behind.
    s.textModelBaseUrl = typeof profile.textModelBaseUrl === "string" ? profile.textModelBaseUrl : "";
    s.textModelBaseUrlDraft = s.textModelBaseUrl;
    s.textModelId = typeof profile.textModelId === "string" ? profile.textModelId : "";
    s.textModelIdDraft = s.textModelId;
    s.hasTypesafeKey = Boolean(profile.hasTypesafeKey);
    s.hasTextModelKey = Boolean(profile.hasTextModelKey);
    s.typesafeSource =
      profile.typesafeSource === "vercel" ? "vercel" : profile.typesafeSource === "openrouter" ? "openrouter" : "typesafe";
    // The decision-model source (task 3.6) and its own two non-secret
    // fields. Absent (a profile saved before the choice existed, or an
    // anthropic/chatgpt profile, which never sets them) loads as the
    // documented `openai` default with empty drafts — resolveTypesafeDecisionSource()'s
    // host-side rule, mirrored here for the same reason every other TypeSafe
    // default is.
    s.typesafeDecisionSource =
      profile.typesafeDecisionSource === "anthropic" || profile.typesafeDecisionSource === "chatgpt"
        ? profile.typesafeDecisionSource
        : "openai";
    s.decisionBaseUrl = typeof profile.typesafeDecisionBaseUrl === "string" ? profile.typesafeDecisionBaseUrl : "";
    s.decisionBaseUrlDraft = s.decisionBaseUrl;
    s.decisionModelId = typeof profile.typesafeDecisionModelId === "string" ? profile.typesafeDecisionModelId : "";
    s.decisionModelIdDraft = s.decisionModelId;
    // The screenshot toggle (add-jev-run-screenshots task 3.2). The companion
    // resolves the default and sends a boolean, but an ABSENT field — a
    // profile stored before the toggle existed, or a companion older than the
    // setting — loads as enabled, which is the documented default (design.md
    // decision 4: "a profile stored before the field existed loads as
    // enabled"). Only an explicit `false` disables it.
    s.sendScreenshots = profile.sendScreenshots === undefined ? true : Boolean(profile.sendScreenshots);
    // The consult-sources toggle (jev-runs-consult-sources-beyond-the-page
    // task 5.2). Same rule as the screenshot toggle above: an ABSENT field —
    // a profile stored before the toggle existed, or a companion older than
    // the setting — loads as enabled, the documented default. Only an
    // explicit `false` disables it.
    s.consultSources = profile.consultSources === undefined ? true : Boolean(profile.consultSources);
    // A chatgpt profile whose session expired host-side (auth.js's refresh
    // saw `invalid_grant`/`refresh_token_reused` → recordChatgptSessionExpired)
    // has no other way to tell the user from a cold load: the side panel shows
    // its own banner, but the settings page must surface it too
    // (add-chatgpt-subscription-provider, tasks.md 5.3's "SESSION_EXPIRED
    // banner"). Set only when nothing more specific is already being shown —
    // every caller below assigns its own banner AFTER _applyProfile, so this
    // never clobbers a just-performed action's result.
    // A typesafe profile whose decision-model source is `chatgpt` reuses the
    // exact same sign-in state (task 3.6: "the same sign-in, account, usage,
    // and sign-out controls a chatgpt profile exposes"), so an expired
    // session needs the same banner here too.
    const chatgptFieldsShown = s.providerType === "chatgpt" || (s.providerType === "typesafe" && s.typesafeDecisionSource === "chatgpt");
    if (chatgptFieldsShown && s.chatgptSessionState === "session_expired" && !s.banner) {
      s.banner = { kind: "error", code: "SESSION_EXPIRED", ...describeErrorCode("SESSION_EXPIRED") };
    }
    // First-run is about whether a WORKING configuration exists yet (no
    // credential and no model to run against), independent of whether the
    // user already typed a non-default Base URL — see
    // test/settings-ui-controller.test.mjs "profile switching" for why
    // tying this to the default Base URL specifically was wrong: a partially
    // configured profile (custom endpoint, no key/model yet) is still
    // first-run onboarding, not a "returning user" state. A `typesafe`
    // profile's credential is the PAIR of keys, so one saved half is still a
    // first run (add-typesafe-jev-provider task 5.5).
    const providerConfigured = s.providerType === "typesafe"
      ? s.hasTypesafeKey && this._typesafeDecisionSourceConfigured(s)
      : s.hasCredential;
    s.isFirstRun = !providerConfigured && s.models.length === 0;

    // ChatGPT usage (add-chatgpt-usage-check design.md decision 6): a
    // signed-in `chatgpt` profile starts one read; every other state clears
    // the block instead, because no read is ever issued for it (specs
    // "ChatGPT usage display" — not signed in / expired reads nothing). The
    // read happens once per profile application, never on a timer;
    // refreshUsage() de-duplicates against a read already in flight, so a
    // profile application arriving mid-read does not double the request. A
    // typesafe profile whose decision-model source is `chatgpt` reads the
    // same block for the same reason it shares every other ChatGPT control
    // (task 3.6) — see _usageReadable() below, which this mirrors.
    if (this._usageReadable()) {
      this.refreshUsage();
    } else {
      s.usage = { status: "idle", usage: null, error: null };
    }
  }

  /** Load (or reload) the profile from the companion. Also used for the
   * "profile switching" scenario: switching `profileId` starts completely
   * fresh — no field, pending key, banner or connection status survives
   * from a different profile. */
  async init(profileId) {
    this._stopSignInPolling();
    if (profileId !== undefined) {
      this.state = emptyState(profileId);
    } else {
      const pid = this.state.profileId;
      this.state = emptyState(pid);
    }
    this.#pendingSecretForRetry = null;
    this.#pendingSignInFlow = null;
    // Any read issued for the state being replaced is now stale — its tag no
    // longer matches, so whatever it resolves with is discarded rather than
    // landing on this page (see _usageStale()).
    this.#usageReadTag += 1;
    this._usageInFlight = null;
    this._notify();
    try {
      const profile = await this.client.getProfile(this.state.profileId);
      if (profile) {
        this._applyProfile(profile);
      } else {
        this.state.loaded = true;
        this.state.isFirstRun = true;
      }
    } catch (err) {
      this.state.loaded = true;
      this.state.loadError = { code: err.code || "NETWORK_ERROR", message: err.message };
      this.state.banner = { kind: "error", code: err.code, ...describeErrorCode(err.code) };
    }
    this._notify();
    return this.getState();
  }

  /** Alias documenting the "profile switching" test intent explicitly. */
  async switchProfile(profileId) {
    return this.init(profileId);
  }

  // --- Provider type & ChatGPT sign-in (add-chatgpt-subscription-provider) -
  //
  // Model list editing (addModel/editModel/removeModel/reorderModel/
  // setDefaultModel below) and save() are unchanged for either provider type
  // — only the credential half differs: an `anthropic` profile's credential
  // is the API key handled by save()/removeCredential() above; a `chatgpt`
  // profile's credential is the OAuth session handled entirely by the
  // methods below, and setCredential/removeCredential are never called for
  // it.

  /** Switch between `anthropic`, `chatgpt`, and `typesafe`. Never touches the
   * model list or (for `chatgpt`) a previously signed-in account — switching
   * back and forth is nondestructive (mirrors host/agent/settings/profile.js's
   * own setProviderType() doc comment, which also seeds the TypeSafe endpoint
   * and, for an empty list, the provider's documented `jev-latest` entry). */
  async setProviderType(providerType) {
    if (providerType !== "anthropic" && providerType !== "chatgpt" && providerType !== "typesafe") {
      return { ok: false, error: `unknown provider type: ${providerType}` };
    }
    if (providerType === this.state.providerType) return { ok: true };
    this._stopSignInPolling();
    this.state.signIn = emptySignInState();
    this.state.switchingProviderType = true;
    this.state.banner = null;
    this._notify();
    try {
      const profile = await this.client.setProviderType(this.state.profileId, providerType);
      this._applyProfile(profile);
      // A credential (or lack of one) recorded under the OTHER provider type
      // says nothing about this one's readiness — the prior connection
      // result is no longer meaningful once the provider type itself changed.
      this.state.connectionStatus = null;
      this.state.switchingProviderType = false;
      this._notify();
      return { ok: true };
    } catch (err) {
      this.state.switchingProviderType = false;
      this.state.banner = { kind: "error", code: err.code, ...describeErrorCode(err.code, { op: "set_provider_type" }) };
      this._notify();
      return { ok: false, error: err.message, code: err.code };
    }
  }

  _startSignInPolling() {
    this._stopSignInPolling();
    this._pollTimer = this._setIntervalFn(() => this._pollSignInStatus(), this._pollIntervalMs);
  }

  _stopSignInPolling() {
    if (this._pollTimer !== null) {
      this._clearIntervalFn(this._pollTimer);
      this._pollTimer = null;
    }
  }

  /** Called by the DOM layer (settings-app.js) on `visibilitychange`/`pagehide`
   * — "stops ... when the page is hidden/unloaded" (tasks.md 5.3). Never
   * cancels the sign-in itself, only this page's own polling of it: the
   * companion keeps the sign-in alive, so returning to the tab can resume
   * watching it (see resumeSignInPolling() below). */
  pauseSignInPolling() {
    this._stopSignInPolling();
  }

  /** Called by the DOM layer when the page becomes visible again. A no-op
   * unless a sign-in is actually still pending — never resurrects a sign-in
   * that already reached a terminal state while the page was hidden. */
  resumeSignInPolling() {
    if (this._pollTimer !== null) return;
    if (this.state.signIn.phase === "pending_browser" || this.state.signIn.phase === "pending_device") {
      this._pollSignInStatus();
      this._startSignInPolling();
    }
  }

  /** One poll tick: never throws, never lets a transient poll failure
   * abandon a sign-in the user may be actively completing in another tab —
   * only a definitive "signed_in"/"failed" reply from the companion ends the
   * poll loop. */
  async _pollSignInStatus() {
    const signInId = this.state.signIn.signInId;
    if (!signInId) {
      this._stopSignInPolling();
      return;
    }
    let status;
    try {
      status = await this.client.chatgptSignInStatus(signInId);
    } catch {
      return; // transient — keep polling, do not tear down the pending UI
    }
    if (!status || status.state === "pending") return;

    this._stopSignInPolling();
    if (status.state === "signed_in") {
      this.state.signIn = emptySignInState();
      try {
        const profile = await this.client.getProfile(this.state.profileId);
        if (profile) this._applyProfile(profile);
      } catch {
        // The sign-in itself already succeeded host-side even if this
        // supplemental refresh fails; the next init()/switchProfile() (or a
        // manual reload) will pick up the full profile.
      }
      this.state.connectionStatus = null;
      this.state.banner = {
        kind: "success",
        title: "Đã đăng nhập ChatGPT",
        message: status.account && status.account.email ? `Đã đăng nhập với ${status.account.email}.` : "Đã đăng nhập ChatGPT.",
        action: ""
      };
      this._notify();
      return;
    }
    // state === "failed"
    // Which flow the user was in when it failed — needed before the sign-in
    // sub-state is replaced below, and only used for the memory-only offer.
    const failedFlow = this.state.signIn.phase === "pending_device" ? "device" : "browser";
    this.state.signIn = { ...emptySignInState(), error: { code: status.code, message: status.message } };
    if (status.code === "SECURE_STORAGE_UNAVAILABLE") {
      // specs/agent-settings "Secret isolation": "If secure storage is
      // unavailable, persistence SHALL fail explicitly and a clearly labeled
      // memory-only mode SHALL be offered." The banner below IS the explicit
      // failure; this is the offer. Confirming it re-runs the SAME flow with
      // `memoryOnly: true` (host/agent/chatgpt/auth.js already supports that
      // end to end — it then never writes the refresh credential to the OS
      // store and records the backend as "memory").
      this.#pendingSignInFlow = failedFlow;
      this.state.pendingMemoryOnlyOffer = true;
      this.state.memoryOnlyOfferKind = "sign_in";
    }
    this.state.banner = { kind: "error", code: status.code, ...describeErrorCode(status.code, { op: "chatgpt_sign_in_status" }) };
    this._notify();
  }

  /** Start the "Sign in with ChatGPT" (browser) flow. Returns `authUrl` so
   * the DOM layer can open it with `chrome.tabs.create` (tasks.md 5.3) —
   * this controller has no `chrome` reference of its own (file header).
   * `memoryOnly: true` is passed ONLY by confirmMemoryOnlySignIn() below —
   * the user's explicit choice of the memory-only mode offered after a
   * SECURE_STORAGE_UNAVAILABLE failure; an ordinary call passes no options. */
  async startBrowserSignIn({ memoryOnly = false } = {}) {
    if (this.state.signIn.phase !== "idle") return { ok: false, error: "a sign-in is already in progress" };
    this.state.signIn = { ...emptySignInState(), phase: "starting_browser" };
    this.state.banner = null;
    this._notify();
    try {
      const { signInId, authUrl } = await this.client.chatgptSignInStart(
        this.state.profileId,
        memoryOnly ? { memoryOnly: true } : undefined
      );
      this.state.signIn = { ...emptySignInState(), phase: "pending_browser", signInId, authUrl };
      this._notify();
      this._startSignInPolling();
      return { ok: true, signInId, authUrl };
    } catch (err) {
      this.state.signIn = emptySignInState();
      this.state.banner = { kind: "error", code: err.code, ...describeErrorCode(err.code, { op: "chatgpt_sign_in_start" }) };
      this._notify();
      return { ok: false, error: err.message, code: err.code };
    }
  }

  /** Start the "Use a code instead" (device-code) flow. `memoryOnly` has the
   * same meaning as in startBrowserSignIn() above. */
  async startDeviceSignIn({ memoryOnly = false } = {}) {
    if (this.state.signIn.phase !== "idle") return { ok: false, error: "a sign-in is already in progress" };
    this.state.signIn = { ...emptySignInState(), phase: "starting_device" };
    this.state.banner = null;
    this._notify();
    try {
      const { signInId, userCode, verificationUrl, expiresAt } = await this.client.chatgptDeviceStart(
        this.state.profileId,
        memoryOnly ? { memoryOnly: true } : undefined
      );
      this.state.signIn = { ...emptySignInState(), phase: "pending_device", signInId, userCode, verificationUrl, expiresAt };
      this._notify();
      this._startSignInPolling();
      return { ok: true, signInId, userCode, verificationUrl, expiresAt };
    } catch (err) {
      this.state.signIn = emptySignInState();
      this.state.banner = { kind: "error", code: err.code, ...describeErrorCode(err.code, { op: "chatgpt_device_start" }) };
      this._notify();
      return { ok: false, error: err.message, code: err.code };
    }
  }

  /** Cancel a pending sign-in (either flow). Best-effort on the wire: the
   * sign-in is discarded from THIS page's state regardless of whether the
   * companion's own cancel round-trip succeeds — an already-gone or already-
   * terminal signInId on the companion side is not a reason to leave the
   * settings page showing a pending state the user just asked to cancel. */
  async cancelSignIn() {
    const signInId = this.state.signIn.signInId;
    this._stopSignInPolling();
    if (!signInId) {
      this.state.signIn = emptySignInState();
      this._notify();
      return { ok: true };
    }
    this.state.signIn.phase = "cancelling";
    this._notify();
    try {
      await this.client.chatgptSignInCancel(signInId);
    } catch {
      // Discarded locally regardless — see doc comment above.
    }
    this.state.signIn = emptySignInState();
    this.state.banner = { kind: "info", code: "SIGN_IN_CANCELLED", ...describeErrorCode("SIGN_IN_CANCELLED", { op: "chatgpt_sign_in_cancel" }) };
    this._notify();
    return { ok: true };
  }

  /** Sign out of the currently signed-in ChatGPT account. */
  async signOut() {
    this.state.signingOut = true;
    this._notify();
    try {
      const profile = await this.client.chatgptSignOut(this.state.profileId);
      this._applyProfile(profile);
      this.state.connectionStatus = null;
      this.state.signingOut = false;
      this.state.banner = { kind: "info", title: "Đã đăng xuất ChatGPT", message: "Cần đăng nhập lại trước khi dùng trợ lý.", action: "" };
      this._notify();
      return { ok: true };
    } catch (err) {
      this.state.signingOut = false;
      this.state.banner = { kind: "error", code: err.code, ...describeErrorCode(err.code, { op: "chatgpt_sign_out" }) };
      this._notify();
      return { ok: false, error: err.message, code: err.code };
    }
  }

  // --- ChatGPT account usage (add-chatgpt-usage-check) --------------------
  //
  // Read-only and display-only: nothing here is written back to the profile,
  // to extension storage, or to a mirror, and nothing polls on a timer. A
  // read happens for exactly two reasons — a signed-in `chatgpt` profile just
  // loaded (see _applyProfile()), or the user activated refresh. `state.usage`
  // holds the companion's display-shaped result (the six-key reply documented
  // in settings-client.js's wire contract — never a token, never an account
  // identity) plus this block's own loading/error state.

  /** True for the two states that have a usage block to read: a signed-in
   * `chatgpt` profile, and a `typesafe` profile whose decision-model source
   * is `chatgpt` (task 3.6 — it reuses the same sign-in/account/usage/
   * sign-out controls a `chatgpt` profile exposes, usage block included). An
   * `anthropic` profile, a signed-out one, and a session-expired one all read
   * nothing (specs "ChatGPT usage display"). */
  _usageReadable() {
    const s = this.state;
    const chatgptFieldsShown = s.providerType === "chatgpt" || (s.providerType === "typesafe" && s.typesafeDecisionSource === "chatgpt");
    return chatgptFieldsShown && s.chatgptSessionState === "signed_in";
  }

  /** The active decision-model source's own key/session presence — key-only,
   * mirroring the prior `hasTypesafeKey && hasTextModelKey` predicate's
   * shape (task 3.6): `openai` needs its saved text-model key, `anthropic`
   * needs the profile's own saved Anthropic key (reused verbatim — see
   * #key-input below), and `chatgpt` needs a completed sign-in. Used only for
   * `isFirstRun`; save()/testConnection() validate the full field shape
   * separately (validateDecisionSourceFields()/_notUsableBanner()). */
  _typesafeDecisionSourceConfigured(s) {
    if (s.typesafeDecisionSource === "anthropic") return Boolean(s.hasCredential);
    if (s.typesafeDecisionSource === "chatgpt") return s.chatgptSessionState === "signed_in";
    return Boolean(s.hasTextModelKey);
  }

  /**
   * Read the account's usage through the companion and land it in
   * `state.usage`.
   *
   * Returns the in-flight read's own promise when one is already running for
   * the displayed profile, so a load-time read and an immediate explicit
   * refresh cost exactly one request between them. A read issued for a
   * profile that is no longer displayed (a late response after a profile
   * switch, or after `init()` reset the page) is discarded rather than
   * written into state.
   *
   * @returns {Promise<{ ok: boolean, usage?: object, code?: string,
   *   error?: string, stale?: boolean }>} never rejects.
   */
  refreshUsage() {
    if (!this._usageReadable()) {
      return Promise.resolve({ ok: false, error: "usage is only read for a signed-in ChatGPT profile" });
    }
    const profileId = this.state.profileId;
    // De-duplicate only while the block is genuinely mid-read: once an
    // outcome has landed (ready or error), a new call is a new read — which
    // is what makes an explicit refresh after a failure re-attempt, and keeps
    // a second read from racing the first.
    if (
      this.state.usage.status === "loading" &&
      this._usageInFlight &&
      this._usageInFlight.profileId === profileId
    ) {
      return this._usageInFlight.promise;
    }
    const tag = ++this.#usageReadTag;
    const entry = { profileId, promise: null };
    this.state.usage = { status: "loading", usage: null, error: null };
    this._notify();
    entry.promise = this._readUsage(profileId, tag).finally(() => {
      if (this._usageInFlight === entry) this._usageInFlight = null;
    });
    this._usageInFlight = entry;
    return entry.promise;
  }

  /** One usage read's outcome -> state transition. Never throws: every
   * failure becomes the block's own `error` state. A SESSION_EXPIRED failure
   * additionally mirrors the profile transition the companion just recorded
   * (the same one the gateway records for an expired session), so the page
   * shows its usual session-expired state and sign-in action rather than a
   * usage block it can no longer read; the account mirror itself is left as
   * it was. */
  async _readUsage(profileId, tag) {
    try {
      const result = await this.client.chatgptUsage(profileId);
      if (this._usageStale(profileId, tag)) return { ok: false, stale: true };
      this.state.usage = { status: "ready", usage: this._withResetMoments(result), error: null };
      this._notify();
      return { ok: true, usage: this.state.usage.usage };
    } catch (err) {
      if (this._usageStale(profileId, tag)) return { ok: false, stale: true };
      const code = err.code || "NETWORK_ERROR";
      this.state.usage = { status: "error", usage: null, error: { code, message: err.message } };
      if (code === "SESSION_EXPIRED") {
        this.state.chatgptSessionState = "session_expired";
        this.state.banner = { kind: "error", code, ...describeErrorCode(code) };
      }
      this._notify();
      return { ok: false, error: err.message, code };
    }
  }

  /** A response is stale — and therefore discarded — when a newer read (or a
   * profile reset) has taken its place, or when the displayed profile is no
   * longer the one the read was issued for. Same guard as the capability
   * result's. */
  _usageStale(profileId, tag) {
    return tag !== this.#usageReadTag || this.state.profileId !== profileId;
  }

  /** Give each present window the ABSOLUTE reset moment the DOM layer counts
   * down to (design.md decision 6), so the countdown needs no controller
   * ticking and stays deterministic under test. The moment is
   * `now() + resetAfterSeconds * 1000`; the backend's own `resetAt` is used
   * only when the window carries no relative value at all (an unusable
   * `resetAt` then yields null, and the block shows the percent without a
   * countdown rather than a wrong clock time). Windows are copied, never
   * mutated in place — the reply object the client resolved with is left
   * untouched — and no other reply field is altered. */
  _withResetMoments(result) {
    if (!result || typeof result !== "object") return result;
    const fetchedAt = this._now();
    const project = (window) => {
      if (!window || typeof window !== "object") return null;
      const resetAfterSeconds = typeof window.resetAfterSeconds === "number" ? window.resetAfterSeconds : null;
      const resetAtMs = resetAfterSeconds !== null
        ? fetchedAt + resetAfterSeconds * 1000
        : typeof window.resetAt === "number"
          ? window.resetAt
          : null;
      return { ...window, resetAtMs };
    };
    return { ...result, primary: project(result.primary), secondary: project(result.secondary) };
  }

  // --- Base URL -----------------------------------------------------------

  setBaseUrlDraft(value) {
    this.state.baseUrlDraft = value;
    this.state.fieldErrors.baseUrl = null;
    this._notify();
  }

  /** Validate the draft without saving; used for live field feedback. */
  validateBaseUrlField() {
    const result = validateBaseUrl(this.state.baseUrlDraft);
    this.state.fieldErrors.baseUrl = result.ok ? null : result.error;
    this._notify();
    return result;
  }

  // --- TypeSafe text-model fields (add-typesafe-jev-provider task 5.5) ----
  //
  // The non-secret half of a `typesafe` profile. Both fields have the same
  // draft/saved split as the Base URL above (an uncontrolled render must not
  // fight the input the user is typing in), and both are validated with the
  // shared helpers rather than a third set of rules: the base URL through
  // settings-validation.js's validateTextModelBaseUrl (which, unlike
  // validateBaseUrl, PRESERVES a terminal /v1 — the companion's text helper
  // POSTs to `{baseUrl}/chat/completions`), the model ID through the same
  // nonempty/trimmed rule the model catalog uses.

  setTextModelBaseUrlDraft(value) {
    this.state.textModelBaseUrlDraft = value;
    this.state.fieldErrors.textModelBaseUrl = null;
    this._notify();
  }

  /** Validate the draft without saving; used for live field feedback. */
  validateTextModelBaseUrlField() {
    const result = validateTextModelBaseUrl(this.state.textModelBaseUrlDraft);
    this.state.fieldErrors.textModelBaseUrl = result.ok ? null : result.error;
    this._notify();
    return result;
  }

  setTextModelIdDraft(value) {
    this.state.textModelIdDraft = value;
    this.state.fieldErrors.textModelId = null;
    this._notify();
  }

  /** The text-model model ID's own rule: a nonempty, trimmed string. The
   * companion's text helper sends it verbatim as the request's `model`, so
   * there is nothing here to normalize beyond whitespace (the same treatment
   * settings-validation.js's model catalog gives every provider model ID). */
  _validateTextModelIdDraft() {
    const trimmed = typeof this.state.textModelIdDraft === "string" ? this.state.textModelIdDraft.trim() : "";
    return trimmed
      ? { ok: true, normalized: trimmed }
      : { ok: false, error: "model ID của mô hình văn bản không được để trống" };
  }

  /** The Jev source select ("typesafe" | "vercel"). Local state like every
   * other field on this page; save() persists it through the
   * set_typesafe_config op.
   *
   * Changing it ALSO mirrors the host's own endpoint rule in the draft
   * (add-typesafe-endpoint-field design.md decision 2): a source change moves
   * the endpoint to the new source's documented default only while the draft
   * is still a KNOWN default, and leaves any other value untouched —
   * exactly what profile.js's setTypesafeConfig does to the stored endpoint
   * when the source changes. The page shows what a Save will persist, so the
   * endpoint field can never display one value while the profile ends up with
   * another. Unknown values are refused here, so the state the select renders
   * from can never hold one. */
  setTypesafeSource(source) {
    if (source !== "typesafe" && source !== "vercel" && source !== "openrouter") {
      return { ok: false, error: `unknown TypeSafe source: ${source}` };
    }
    if (source !== this.state.typesafeSource && isKnownTypesafeEndpoint(this.state.baseUrlDraft)) {
      this.state.baseUrlDraft = typesafeSourceCopy(source).endpointDefault;
      this.state.fieldErrors.baseUrl = null;
    }
    this.state.typesafeSource = source;
    this._notify();
    return { ok: true };
  }

  /** The screenshot toggle (add-jev-run-screenshots task 3.2). Local state
   * like the Jev source above: save() is the only writer, and it persists the
   * value through the same `set_typesafe_config` op (the field is profile
   * state, not a per-conversation switch). No validation can fail here — the
   * DOM layer feeds it a checkbox's boolean, and every value is coerced to
   * the profile's own boolean type so nothing else can ride into the field. */
  setSendScreenshots(enabled) {
    this.state.sendScreenshots = Boolean(enabled);
    this._notify();
    return { ok: true };
  }

  /** The consult-sources toggle (jev-runs-consult-sources-beyond-the-page
   * task 5.2). Local state exactly like setSendScreenshots() above: save() is
   * the only writer, and it persists the value through the same
   * `set_typesafe_config` op. No validation can fail here — the DOM layer
   * feeds it a checkbox's boolean, and every value is coerced to the
   * profile's own boolean type so nothing else can ride into the field. */
  setConsultSources(enabled) {
    this.state.consultSources = Boolean(enabled);
    this._notify();
    return { ok: true };
  }

  /** Both text-model fields at once, as save()/testConnection() need them.
   * @returns {{ ok: true, baseUrl: string, modelId: string } | { ok: false, error: string, field: "textModelBaseUrl"|"textModelId" }} */
  validateTextModelFields() {
    const urlResult = validateTextModelBaseUrl(this.state.textModelBaseUrlDraft);
    if (!urlResult.ok) {
      return { ok: false, error: urlResult.error, field: "textModelBaseUrl" };
    }
    const idResult = this._validateTextModelIdDraft();
    if (!idResult.ok) {
      return { ok: false, error: idResult.error, field: "textModelId" };
    }
    return { ok: true, baseUrl: urlResult.normalized, modelId: idResult.normalized };
  }

  // --- Decision-model source & its own fields (task 3.6) ------------------
  //
  // A `typesafe` profile's decision model — the one that plans, decides
  // every step, revises memory and judges completion — comes from one of
  // three sources. Only the SELECTED source's fields are shown, validated,
  // and sent; a deselected source's stored configuration is left alone (see
  // validateDecisionSourceFields() below, and save()'s use of its `payload`).
  //
  // The `anthropic` source's key is NOT a new field: it is the profile's
  // EXISTING Anthropic credential — the same #key-input/setCredential/
  // removeCredential/hasCredential surface an `anthropic` profile uses
  // (specs/agent-settings "Editable provider profile": "for anthropic, a
  // base URL and a write-only key with replace/remove actions" — the key
  // half is the pre-existing one, only the base URL and the picker are new).
  // The `chatgpt` source reuses the entire existing sign-in/account/usage/
  // sign-out block (#chatgpt-fields) rather than building a second one — see
  // _usageReadable()/settings-app.js's renderProvider().

  /** Switch the decision-model source. Local state like the Jev source above
   * (setTypesafeSource) — save() is the only writer. Does not touch any
   * field's draft: switching away and back must show exactly what was there
   * before (specs/typesafe-jev-provider "Switching source does not discard
   * configuration"), and the drafts already hold whatever _applyProfile last
   * loaded or the user last typed. */
  setTypesafeDecisionSource(source) {
    if (source !== "openai" && source !== "anthropic" && source !== "chatgpt") {
      return { ok: false, error: `unknown decision-model source: ${source}` };
    }
    this.state.typesafeDecisionSource = source;
    // A field error from the PREVIOUSLY selected source must not linger on a
    // field the page no longer shows.
    this.state.fieldErrors.textModelBaseUrl = null;
    this.state.fieldErrors.textModelId = null;
    this.state.fieldErrors.decisionBaseUrl = null;
    this.state.fieldErrors.decisionModelId = null;
    this._notify();
    return { ok: true };
  }

  setDecisionBaseUrlDraft(value) {
    this.state.decisionBaseUrlDraft = value;
    this.state.fieldErrors.decisionBaseUrl = null;
    this._notify();
  }

  /** Validate the draft without saving; used for live field feedback. Same
   * rule the Anthropic Base URL field uses (validateBaseUrl) — this is
   * another Anthropic-standard endpoint, not the OpenAI-compatible text
   * model's, whose terminal `/v1` must be preserved instead. */
  validateDecisionBaseUrlField() {
    const result = validateBaseUrl(this.state.decisionBaseUrlDraft);
    this.state.fieldErrors.decisionBaseUrl = result.ok ? null : result.error;
    this._notify();
    return result;
  }

  setDecisionModelIdDraft(value) {
    this.state.decisionModelIdDraft = value;
    this.state.fieldErrors.decisionModelId = null;
    this._notify();
  }

  /** The decision model's own model ID rule — nonempty, trimmed, exactly
   * like the text-model model ID's own rule above. Required for BOTH the
   * `anthropic` and `chatgpt` sources (host/agent/settings/profile.js's
   * setTypesafeConfig(): "the decision model's model ID must be a nonempty
   * model id" whenever the source is not `openai`). */
  _validateDecisionModelIdDraft() {
    const trimmed = typeof this.state.decisionModelIdDraft === "string" ? this.state.decisionModelIdDraft.trim() : "";
    return trimmed
      ? { ok: true, normalized: trimmed }
      : { ok: false, error: "model ID của mô hình quyết định không được để trống" };
  }

  /** Validate the ACTIVE decision-model source's own required fields and
   * build exactly the `set_typesafe_config` payload fragment for it — the
   * single place that decides which of textModelBaseUrl/textModelId/
   * decisionSource/decisionBaseUrl/decisionModelId travel on a Save, so a
   * deselected source's fields are never sent (and therefore never
   * overwrite what the companion already has stored for it — specs/
   * typesafe-jev-provider "Switching source does not discard configuration").
   * @returns {{ok:true, payload: object} | {ok:false, error:string, field:string}}
   */
  validateDecisionSourceFields() {
    const source = this.state.typesafeDecisionSource;
    if (source === "anthropic") {
      const urlResult = validateBaseUrl(this.state.decisionBaseUrlDraft);
      if (!urlResult.ok) return { ok: false, error: urlResult.error, field: "decisionBaseUrl" };
      const idResult = this._validateDecisionModelIdDraft();
      if (!idResult.ok) return { ok: false, error: idResult.error, field: "decisionModelId" };
      return { ok: true, payload: { decisionSource: "anthropic", decisionBaseUrl: urlResult.normalized, decisionModelId: idResult.normalized } };
    }
    if (source === "chatgpt") {
      const idResult = this._validateDecisionModelIdDraft();
      if (!idResult.ok) return { ok: false, error: idResult.error, field: "decisionModelId" };
      return { ok: true, payload: { decisionSource: "chatgpt", decisionModelId: idResult.normalized } };
    }
    const textResult = this.validateTextModelFields();
    if (!textResult.ok) return textResult;
    return { ok: true, payload: { decisionSource: "openai", textModelBaseUrl: textResult.baseUrl, textModelId: textResult.modelId } };
  }

  // --- Model catalog (local, unsaved-until-Save; see file header) --------

  addModel({ id, label }) {
    const trimmedId = typeof id === "string" ? id.trim() : "";
    const trimmedLabel = typeof label === "string" ? label.trim() : "";
    if (!trimmedId) {
      this.state.fieldErrors.models = "model ID không được để trống";
      this._notify();
      return { ok: false, error: this.state.fieldErrors.models };
    }
    if (this.state.models.some((m) => m.id === trimmedId)) {
      this.state.fieldErrors.models = `ID mô hình "${trimmedId}" đã tồn tại`;
      this._notify();
      return { ok: false, error: this.state.fieldErrors.models };
    }
    this.state.models.push({ id: trimmedId, label: trimmedLabel || trimmedId });
    if (!this.state.defaultModelId) this.state.defaultModelId = trimmedId;
    this.state.fieldErrors.models = null;
    this._notify();
    return { ok: true };
  }

  editModel(index, patch) {
    const model = this.state.models[index];
    if (!model) return { ok: false, error: "model index out of range" };
    const nextId = patch.id !== undefined ? String(patch.id).trim() : model.id;
    const nextLabel = patch.label !== undefined ? String(patch.label).trim() : model.label;
    if (!nextId) {
      this.state.fieldErrors.models = "model ID không được để trống";
      this._notify();
      return { ok: false, error: this.state.fieldErrors.models };
    }
    if (nextId !== model.id && this.state.models.some((m, i) => i !== index && m.id === nextId)) {
      this.state.fieldErrors.models = `ID mô hình "${nextId}" đã tồn tại`;
      this._notify();
      return { ok: false, error: this.state.fieldErrors.models };
    }
    const wasDefault = this.state.defaultModelId === model.id;
    model.id = nextId;
    model.label = nextLabel || nextId;
    if (wasDefault) this.state.defaultModelId = nextId;
    this.state.fieldErrors.models = null;
    this._notify();
    return { ok: true };
  }

  removeModel(index) {
    const model = this.state.models[index];
    if (!model) return { ok: false, error: "model index out of range" };
    const wasDefault = this.state.defaultModelId === model.id;
    this.state.models.splice(index, 1);
    if (wasDefault) {
      this.state.defaultModelId = this.state.models.length ? this.state.models[0].id : null;
    }
    this._notify();
    return { ok: true };
  }

  reorderModel(fromIndex, toIndex) {
    const models = this.state.models;
    if (fromIndex < 0 || fromIndex >= models.length || toIndex < 0 || toIndex >= models.length) {
      return { ok: false, error: "index out of range" };
    }
    const [moved] = models.splice(fromIndex, 1);
    models.splice(toIndex, 0, moved);
    this._notify();
    return { ok: true };
  }

  setDefaultModel(id) {
    if (!this.state.models.some((m) => m.id === id)) {
      return { ok: false, error: `model "${id}" is not in the list` };
    }
    this.state.defaultModelId = id;
    this._notify();
    return { ok: true };
  }

  // Note: there is no "discard the key input" method here. The key `<input>`
  // is uncontrolled (see file header) — clearing its DOM value is
  // settings-app.js's job, not this class's. `cancelMemoryOnlyOffer()` below
  // is the one credential-related discard this class owns.

  // --- Save -----------------------------------------------------------------

  /** Validate + persist the non-secret profile, plus the pending credential
   * (if any). Never requires network for the profile half (host guarantee;
   * see reports/04-settings-evidence.md, "Saving allowed offline").
   *
   * @param {string} [secretInput] the raw key value read LIVE from the DOM
   *   input at the moment Save was clicked (settings-app.js's job) — never
   *   stored on `this.state` before or after this call. Omit/empty when the
   *   user did not type a new key this time.
   * @param {{ typesafeApiKey?: string, textModelApiKey?: string }} [typesafeSecrets]
   *   the two raw TypeSafe key values, read LIVE from their own DOM inputs at
   *   the same moment and handled exactly like `secretInput` above: a bare
   *   argument, never assigned to `this.state`, only ever sent. Read only for
   *   a `typesafe` profile; an omitted/empty half keeps whatever the companion
   *   already stores for it (see settings-client.js's wire contract).
   *   Defaulted rather than positional on purpose: the second argument is not
   *   another handle on the profile — the no-conversation-leak assertion
   *   "save() takes at most one parameter" (test/settings-ui-no-conversation-
   *   leak.test.mjs) stays literally true (`Function#length` is 1 with a
   *   default) and there is still no way to pass a conversation through here. */
  async save(secretInput, typesafeSecrets = {}) {
    const urlResult = validateBaseUrl(this.state.baseUrlDraft);
    if (!urlResult.ok) {
      this.state.fieldErrors.baseUrl = urlResult.error;
      this.state.banner = { kind: "error", code: "INVALID_BASE_URL", ...describeErrorCode("INVALID_BASE_URL") };
      this._notify();
      return { ok: false, error: urlResult.error };
    }
    const modelsResult = validateModelsList(this.state.models, this.state.defaultModelId);
    if (!modelsResult.ok) {
      this.state.fieldErrors.models = modelsResult.error;
      this.state.banner = { kind: "error", code: "INVALID_MODELS", ...describeErrorCode("INVALID_MODELS") };
      this._notify();
      return { ok: false, error: modelsResult.error };
    }

    // TypeSafe / Jev provider: the text-model fields are part of this profile's
    // required configuration (specs/agent-settings "TypeSafe text-model fields
    // are required" — "saving and testing are blocked with a field-level
    // error"). Validated before anything is sent, exactly like the two blocks
    // above, so an invalid pair never reaches the companion and never leaves
    // the page looking saved. Which provider the user was looking at when they
    // clicked Save governs every branch below — captured once, because the
    // replies that land mid-save replace the whole state.
    const isTypesafe = this.state.providerType === "typesafe";
    // The Jev source and the screenshot toggle are captured here, with
    // everything else the ops below send: the saveProfile reply lands
    // mid-save and replaces the whole state (see the comment above), so
    // reading them after that reply would silently revert a toggle or source
    // the user just changed to whatever the companion still has stored.
    const pendingTypesafeSource = this.state.typesafeSource;
    const pendingSendScreenshots = this.state.sendScreenshots;
    const pendingConsultSources = this.state.consultSources;
    // Only the ACTIVE decision-model source's fields are validated and sent
    // (task 3.6; specs/typesafe-jev-provider "Switching source does not
    // discard configuration") — validateDecisionSourceFields() branches on
    // `typesafeDecisionSource` and builds exactly that source's payload
    // fragment; a deselected source's own fields never ride this call.
    let decisionFields = null;
    if (isTypesafe) {
      decisionFields = this.validateDecisionSourceFields();
      if (!decisionFields.ok) {
        this.state.fieldErrors.textModelBaseUrl = null;
        this.state.fieldErrors.textModelId = null;
        this.state.fieldErrors.decisionBaseUrl = null;
        this.state.fieldErrors.decisionModelId = null;
        this.state.fieldErrors[decisionFields.field] = decisionFields.error;
        this.state.banner = {
          kind: "error",
          title: "Cấu hình mô hình quyết định chưa hợp lệ",
          message: decisionFields.error,
          action: "Sửa cấu hình mô hình quyết định ở mục Nhà cung cấp, rồi bấm Lưu lại."
        };
        this._notify();
        return { ok: false, error: decisionFields.error };
      }
      this.state.fieldErrors.textModelBaseUrl = null;
      this.state.fieldErrors.textModelId = null;
      this.state.fieldErrors.decisionBaseUrl = null;
      this.state.fieldErrors.decisionModelId = null;
    }

    this.state.fieldErrors.baseUrl = null;
    this.state.fieldErrors.models = null;
    this.state.saving = true;
    this.state.banner = null;
    this._notify();

    // Which op a failure came from, for the error copy below. Only the two
    // TypeSafe ops need it (a companion that predates the provider answers
    // them with its own unknown-op PROTOCOL_ERROR, which reads as "update the
    // companion" — see errors-ui.js's TYPESAFE_OPS); it is recorded rather
    // than inferred, so it stays right whichever half fails.
    let inFlightOp = null;
    try {
      inFlightOp = "save_profile";
      const saved = await this.client.saveProfile(this.state.profileId, {
        baseUrl: urlResult.normalized,
        models: modelsResult.models,
        defaultModelId: modelsResult.defaultModelId
      });
      this._applyProfile(saved);

      // TypeSafe half, part 1: the non-secret text-model configuration. Its
      // own op (design.md decision 9) and its own reply shape — the updated
      // secret-free profile — which is applied so the page shows exactly what
      // the companion now holds (including a base URL the companion
      // normalized differently).
      if (decisionFields) {
        inFlightOp = "set_typesafe_config";
        const config = await this.client.setTypesafeConfig(this.state.profileId, {
          // The endpoint is deliberately NOT sent, even though the page now
          // shows it (add-typesafe-endpoint-field): the endpoint IS
          // `profile.baseUrl`, which saveProfile above just persisted from the
          // same draft, and the rule this op applies — move a still-known-
          // default endpoint to the selected source's default, leave any other
          // one alone — is mirrored in that draft by setTypesafeSource().
          // Sending it here too would make one value have two writers.
          typesafeSource: pendingTypesafeSource,
          // The screenshot toggle rides the same non-secret config op
          // (add-jev-run-screenshots task 3.2): the host persists it on the
          // profile, and its reply — applied just below — echoes the stored
          // value back, so the page ends up showing exactly what a run will do.
          sendScreenshots: pendingSendScreenshots,
          // The consult-sources toggle rides the same non-secret config op
          // (jev-runs-consult-sources-beyond-the-page task 5.2): the host
          // persists it on the profile, and its reply — applied just below —
          // echoes the stored value back, so the page ends up showing exactly
          // what a run will do.
          consultSources: pendingConsultSources,
          // Only the active decision-model source's own fields
          // (decisionSource plus textModelBaseUrl/textModelId OR
          // decisionBaseUrl/decisionModelId, whichever it built) — see
          // validateDecisionSourceFields()'s doc comment.
          ...decisionFields.payload
        });
        this._applyProfile(config);
      }

      // Credential half — only touched if the caller actually passed a
      // freshly-typed value. `secretInput` is a bare function argument, never
      // assigned to `this.state` at any point (see file header) — so there is
      // no "clear it from state" step needed here at all, unlike the
      // rejected earlier design this replaced.
      if (secretInput) {
        const secretToSend = secretInput;
        try {
          const result = await this.client.setCredential(this.state.profileId, secretToSend, { memoryOnly: false });
          this.state.hasCredential = true;
          this.state.memoryOnlyCredential = result.backend === "memory";
          this.state.secretBackend = result.backend;
          this.state.connectionStatus = null; // credential changed -> prior results invalidated (host-side truth)
          this.#pendingSecretForRetry = null;
          this.state.pendingMemoryOnlyOffer = false;
          this.state.memoryOnlyOfferKind = null;
        } catch (err) {
          if (err.code === "SECURE_STORAGE_UNAVAILABLE") {
            // Retained ONLY in the private field, only for this explicit,
            // user-visible offer — never re-shown in any field/state.
            this.#pendingSecretForRetry = secretToSend;
            this.state.pendingMemoryOnlyOffer = true;
            this.state.memoryOnlyOfferKind = "credential";
            this.state.banner = { kind: "error", code: err.code, ...describeErrorCode(err.code) };
          } else {
            this.#pendingSecretForRetry = null;
            this.state.pendingMemoryOnlyOffer = false;
            this.state.memoryOnlyOfferKind = null;
            this.state.banner = { kind: "error", code: err.code, ...describeErrorCode(err.code) };
          }
        }
      }

      // TypeSafe half, part 2: the two write-only keys. Sent as ONE op
      // (they share one merged secret host-side), only when the caller
      // actually typed at least one of them, and only with the halves they
      // typed: an OMITTED key keeps the stored value, while an explicit ""
      // REMOVES it (see settings-client.js's wire contract). An untouched
      // input is therefore left out of the payload entirely — sending its ""
      // would silently delete a key the user never asked to remove, and the
      // only removal path is each field's own "Xóa key" action. The reply is
      // booleans plus the storage backend; nothing key-shaped comes back.
      if (isTypesafe) {
        const typedTypesafeKey = typeof typesafeSecrets.typesafeApiKey === "string" ? typesafeSecrets.typesafeApiKey.trim() : "";
        const typedTextModelKey = typeof typesafeSecrets.textModelApiKey === "string" ? typesafeSecrets.textModelApiKey.trim() : "";
        const keys = {};
        if (typedTypesafeKey) keys.typesafeApiKey = typedTypesafeKey;
        if (typedTextModelKey) keys.textModelApiKey = typedTextModelKey;
        if (typedTypesafeKey || typedTextModelKey) {
          try {
            const result = await this.client.setTypesafeCredentials(this.state.profileId, keys);
            this.state.hasTypesafeKey = Boolean(result.hasTypesafeKey);
            this.state.hasTextModelKey = Boolean(result.hasTextModelKey);
            this.state.hasCredential = Boolean(result.hasTypesafeKey && result.hasTextModelKey);
            this.state.memoryOnlyCredential = result.backend === "memory";
            this.state.secretBackend = result.backend;
            // Any key change invalidates a previously recorded capability
            // result host-side; the page must not keep showing the old pass.
            this.state.connectionStatus = null;
            this.#pendingSecretForRetry = null;
            this.state.pendingMemoryOnlyOffer = false;
            this.state.memoryOnlyOfferKind = null;
          } catch (err) {
            if (err.code === "SECURE_STORAGE_UNAVAILABLE") {
              // Same explicit, labeled memory-only offer as the API-key path
              // above (specs/agent-settings "Secret isolation"), carrying the
              // pair rather than one string.
              this.#pendingSecretForRetry = keys;
              this.state.pendingMemoryOnlyOffer = true;
              this.state.memoryOnlyOfferKind = "typesafe_credentials";
              this.state.banner = { kind: "error", code: err.code, ...describeErrorCode(err.code) };
            } else {
              this.#pendingSecretForRetry = null;
              this.state.pendingMemoryOnlyOffer = false;
              this.state.memoryOnlyOfferKind = null;
              this.state.banner = { kind: "error", code: err.code, ...describeErrorCode(err.code, { op: "set_typesafe_credentials" }) };
            }
          }
        }
      }

      this.state.saving = false;
      if (!this.state.banner) {
        this.state.banner = { kind: "success", title: "Đã lưu", message: "Đã lưu cài đặt.", action: "" };
      }
      this._notify();
      return { ok: true };
    } catch (err) {
      this.state.saving = false;
      // `inFlightOp` is set for every call this half makes, so the copy that
      // reaches the user describes the failure that actually happened. Only
      // the two TypeSafe ops change the copy (see errors-ui.js's
      // TYPESAFE_OPS); everything else reads exactly as it always has.
      this.state.banner = { kind: "error", code: err.code, ...describeErrorCode(err.code, { op: inFlightOp }) };
      this._notify();
      return { ok: false, error: err.message, code: err.code };
    }
  }

  /** Explicit, user-confirmed retry of a ChatGPT sign-in that failed because
   * no OS credential store is available — re-runs the SAME flow the user was
   * in, now with `memoryOnly: true`, so host/agent/chatgpt/auth.js holds the
   * refresh credential in the companion's memory only and never writes it to
   * the OS store (specs/agent-settings "Secret isolation"). This is the
   * ChatGPT counterpart of confirmMemoryOnlyCredential() below; the DOM
   * layer picks between the two by `state.memoryOnlyOfferKind`.
   * @returns {Promise<{ ok: boolean, authUrl?: string, signInId?: string, userCode?: string, verificationUrl?: string, expiresAt?: number, error?: string }>}
   *   the retry's own result — a browser retry returns a NEW `authUrl` the
   *   DOM layer must open, exactly like startBrowserSignIn(). */
  async confirmMemoryOnlySignIn() {
    const flow = this.#pendingSignInFlow;
    if (!flow) {
      return { ok: false, error: "no pending ChatGPT sign-in to retry" };
    }
    this.#pendingSignInFlow = null;
    this.state.pendingMemoryOnlyOffer = false;
    this.state.memoryOnlyOfferKind = null;
    this._notify();
    return flow === "device" ? this.startDeviceSignIn({ memoryOnly: true }) : this.startBrowserSignIn({ memoryOnly: true });
  }

  /** Explicit, user-confirmed retry after a SECURE_STORAGE_UNAVAILABLE
   * offer — the only path that ever persists a credential with
   * `memoryOnly: true`. Two shapes reach the private field: a bare string (an
   * Anthropic API key) and `{ typesafeApiKey, textModelApiKey }` (the two
   * TypeSafe keys, offered as one because they share one merged secret
   * host-side). Which one is pending is decided by its own type, not by
   * `state.providerType` — a provider switch mid-offer must not send the
   * wrong shape to the wrong op. */
  async confirmMemoryOnlyCredential() {
    if (!this.#pendingSecretForRetry) {
      return { ok: false, error: "no pending credential to retry" };
    }
    const pending = this.#pendingSecretForRetry;
    const isTypesafePair = typeof pending === "object";
    this.#pendingSecretForRetry = null;
    this.state.pendingMemoryOnlyOffer = false;
    this.state.memoryOnlyOfferKind = null;
    this._notify();
    try {
      if (isTypesafePair) {
        const result = await this.client.setTypesafeCredentials(this.state.profileId, pending, { memoryOnly: true });
        this.state.hasTypesafeKey = Boolean(result.hasTypesafeKey);
        this.state.hasTextModelKey = Boolean(result.hasTextModelKey);
        this.state.hasCredential = Boolean(result.hasTypesafeKey && result.hasTextModelKey);
        this.state.memoryOnlyCredential = true;
        this.state.secretBackend = result.backend;
        this.state.connectionStatus = null;
        this.state.banner = { kind: "success", title: "Đã lưu (chỉ trong bộ nhớ)", message: "Khóa sẽ mất khi companion khởi động lại.", action: "" };
        this._notify();
        return { ok: true };
      }
      const result = await this.client.setCredential(this.state.profileId, pending, { memoryOnly: true });
      this.state.hasCredential = true;
      this.state.memoryOnlyCredential = true;
      this.state.secretBackend = result.backend;
      this.state.connectionStatus = null;
      this.state.banner = { kind: "success", title: "Đã lưu (chỉ trong bộ nhớ)", message: "Khóa sẽ mất khi companion khởi động lại.", action: "" };
      this._notify();
      return { ok: true };
    } catch (err) {
      this.state.banner = { kind: "error", code: err.code, ...describeErrorCode(err.code, isTypesafePair ? { op: "set_typesafe_credentials" } : undefined) };
      this._notify();
      return { ok: false, error: err.message };
    }
  }

  cancelMemoryOnlyOffer() {
    this.#pendingSecretForRetry = null;
    this.#pendingSignInFlow = null;
    this.state.pendingMemoryOnlyOffer = false;
    this.state.memoryOnlyOfferKind = null;
    this._notify();
  }

  async removeCredential() {
    this.state.removingCredential = true;
    this._notify();
    try {
      await this.client.removeCredential(this.state.profileId);
      this.state.hasCredential = false;
      this.state.memoryOnlyCredential = false;
      this.state.secretBackend = null;
      this.state.connectionStatus = null;
      this.#pendingSecretForRetry = null;
      this.state.pendingMemoryOnlyOffer = false;
      this.state.memoryOnlyOfferKind = null;
      this.state.banner = { kind: "info", title: "Đã xóa API key", message: "Cần nhập lại API key trước khi dùng trợ lý.", action: "" };
      this.state.removingCredential = false;
      this._notify();
      return { ok: true };
    } catch (err) {
      this.state.removingCredential = false;
      this.state.banner = { kind: "error", code: err.code, ...describeErrorCode(err.code) };
      this._notify();
      return { ok: false, error: err.message };
    }
  }

  // --- Connection test --------------------------------------------------

  /** Remove ONE half of a `typesafe` profile's stored keys — the "remove"
   * action each write-only key field carries (specs/agent-settings "Editable
   * provider profile"). An explicit empty string is the wire's removal signal
   * (see settings-client.js's wire contract); the other half is omitted, so
   * it keeps its stored value. The reply's booleans then drive the page, so a
   * removal that the companion refused cannot leave the UI claiming the key
   * is gone.
   *
   * @param {"typesafe"|"textModel"} which
   */
  async removeTypesafeKey(which) {
    const field = which === "textModel" ? "textModelApiKey" : "typesafeApiKey";
    const flag = which === "textModel" ? "hasTextModelKey" : "hasTypesafeKey";
    this.state.removingCredential = true;
    this._notify();
    try {
      const result = await this.client.setTypesafeCredentials(this.state.profileId, { [field]: "" });
      this.state.hasTypesafeKey = Boolean(result.hasTypesafeKey);
      this.state.hasTextModelKey = Boolean(result.hasTextModelKey);
      this.state.hasCredential = Boolean(result.hasTypesafeKey && result.hasTextModelKey);
      // With both halves gone there is no stored credential left to describe,
      // so the storage-backend fields are cleared exactly as
      // removeCredential() clears them for the Anthropic key (one half still
      // stored keeps them: they describe the store that half lives in).
      if (!this.state.hasTypesafeKey && !this.state.hasTextModelKey) {
        this.state.memoryOnlyCredential = false;
        this.state.secretBackend = null;
      }
      this.state.connectionStatus = null; // credential changed -> prior results invalidated (host-side truth)
      this.#pendingSecretForRetry = null;
      this.state.pendingMemoryOnlyOffer = false;
      this.state.memoryOnlyOfferKind = null;
      this.state.banner = {
        kind: "info",
        title: which === "textModel" ? "Đã xóa API key mô hình văn bản" : "Đã xóa API key TypeSafe",
        message: "Cần nhập lại API key trước khi kiểm tra kết nối.",
        action: ""
      };
      this.state.removingCredential = false;
      this._notify();
      return { ok: true, [flag]: false };
    } catch (err) {
      this.state.removingCredential = false;
      this.state.banner = { kind: "error", code: err.code, ...describeErrorCode(err.code, { op: "set_typesafe_credentials" }) };
      this._notify();
      return { ok: false, error: err.message, code: err.code };
    }
  }

  /** The "not usable yet" banner for the CURRENT provider type — NO_CREDENTIAL
   * ("enter an API key") is only ever correct for an `anthropic` profile. A
   * `chatgpt` profile's missing credential means "sign in with ChatGPT", and a
   * session that expired host-side says so explicitly (specs/agent-settings
   * "ChatGPT profile not signed in"; tasks.md 5.3's SESSION_EXPIRED banner). A
   * `typesafe` profile needs three things, each named separately
   * (add-typesafe-jev-provider task 5.5; specs/agent-settings "TypeSafe
   * text-model fields are required"): both saved keys and a valid text-model
   * base URL + model ID. A config problem also lands on its own field, so the
   * page shows the error next to the field to fix rather than only in a
   * banner.
   * @returns {{ kind: string, code?: string, title?: string, message?: string, action?: string }|null}
   *   null when the profile IS usable (caller proceeds), otherwise the banner
   *   to show and return a failure with. */
  _notUsableBanner() {
    if (this.state.providerType === "chatgpt") {
      if (this.state.chatgptSessionState === "session_expired") {
        return { kind: "error", code: "SESSION_EXPIRED", ...describeErrorCode("SESSION_EXPIRED") };
      }
      if (this.state.chatgptSessionState === "signed_in") return null;
      return {
        kind: "error",
        title: "Chưa đăng nhập ChatGPT",
        message: "Đăng nhập với tài khoản ChatGPT trước khi dùng thao tác này.",
        action: "Bấm \"Đăng nhập với ChatGPT\" ở mục Nhà cung cấp phía trên."
      };
    }
    if (this.state.providerType === "typesafe") {
      if (!this.state.hasTypesafeKey) {
        return {
          kind: "error",
          title: "Chưa lưu API key TypeSafe",
          message: "Lưu API key TypeSafe trước khi dùng thao tác này.",
          action: "Nhập API key TypeSafe ở mục Nhà cung cấp rồi bấm Lưu."
        };
      }
      // Only the SELECTED decision-model source's own credential is required
      // (task 3.6; specs/typesafe-jev-provider "Only the selected decision-
      // model source is required") — the other two sources' stored
      // configuration is left untouched and unchecked.
      const source = this.state.typesafeDecisionSource;
      if (source === "openai" && !this.state.hasTextModelKey) {
        return {
          kind: "error",
          title: "Chưa lưu API key mô hình văn bản",
          message: "Lưu API key của mô hình văn bản trước khi dùng thao tác này.",
          action: "Nhập API key mô hình văn bản ở mục Nhà cung cấp rồi bấm Lưu."
        };
      }
      if (source === "anthropic" && !this.state.hasCredential) {
        return {
          kind: "error",
          title: "Chưa lưu API key Anthropic",
          message: "Lưu API key Anthropic cho mô hình quyết định trước khi dùng thao tác này.",
          action: "Nhập API key Anthropic ở mục Nhà cung cấp rồi bấm Lưu."
        };
      }
      if (source === "chatgpt") {
        if (this.state.chatgptSessionState === "session_expired") {
          return { kind: "error", code: "SESSION_EXPIRED", ...describeErrorCode("SESSION_EXPIRED") };
        }
        if (this.state.chatgptSessionState !== "signed_in") {
          return {
            kind: "error",
            title: "Chưa đăng nhập ChatGPT",
            message: "Đăng nhập với tài khoản ChatGPT (mô hình quyết định) trước khi dùng thao tác này.",
            action: "Bấm \"Đăng nhập với ChatGPT\" ở mục Nhà cung cấp phía trên."
          };
        }
      }
      const fields = this.validateDecisionSourceFields();
      if (!fields.ok) {
        this.state.fieldErrors[fields.field] = fields.error;
        return {
          kind: "error",
          title: "Cấu hình mô hình quyết định chưa hợp lệ",
          message: fields.error,
          action: "Sửa cấu hình mô hình quyết định ở mục Nhà cung cấp, rồi bấm Lưu."
        };
      }
      return null;
    }
    if (!this.state.hasCredential) {
      return { kind: "error", code: "NO_CREDENTIAL", ...describeErrorCode("NO_CREDENTIAL") };
    }
    return null;
  }

  async testConnection(modelId) {
    const model = modelId || this.state.defaultModelId;
    if (!model) {
      this.state.banner = { kind: "error", title: "Chưa chọn mô hình", message: "Thêm ít nhất một mô hình và đặt mặc định trước khi kiểm tra.", action: "" };
      this._notify();
      return { ok: false };
    }
    const notUsable = this._notUsableBanner();
    if (notUsable) {
      this.state.banner = notUsable;
      this._notify();
      return { ok: false };
    }
    // A `typesafe` capability test reports three stages: the two gating
    // services (the TypeSafe structured question and the text-model
    // completion) and — separately reported, never gating — the `image`
    // stage, which asks the same text-model endpoint to accept image content
    // (add-jev-run-screenshots task 3.2; design.md decision 5). `status` is
    // decided by the two gating stages alone, so a model that rejects the
    // capture still leaves the profile runnable; the page's job is to say so
    // and point at the two ways out (a vision-capable model, or the
    // screenshot toggle). The shape is otherwise the same
    // `{ status, capabilities, errors, timestamp }`, so only the keys read
    // below differ — `textOnly` has no meaning here (there is no tool/vision
    // stage to be missing) and every failure names the stage it came from.
    const isTypesafe = this.state.providerType === "typesafe";
    this.state.testing = true;
    this.state.connectionStatus = { status: "testing", modelId: model };
    this.state.banner = null;
    this._notify();
    try {
      const result = await this.client.testCapability(this.state.profileId, model);
      const textOnly = !isTypesafe && result.capabilities.text === "pass" && (result.capabilities.tool !== "pass" || result.capabilities.vision !== "pass");
      this.state.connectionStatus = { ...result, modelId: model, textOnly };
      if (result.status !== "pass") {
        const stages = Object.keys(result.errors || {});
        const firstFailedStage = stages[0];
        const firstFailedCode = result.errors[firstFailedStage]?.code;
        const stageLabel = isTypesafe ? typesafeStageLabel(firstFailedStage) : null;
        this.state.banner = firstFailedCode
          ? { kind: "error", code: firstFailedCode, stage: isTypesafe ? firstFailedStage : undefined, ...describeErrorCode(firstFailedCode, isTypesafe ? { stage: firstFailedStage } : undefined) }
          : {
              kind: "error",
              title: stageLabel ? `Kiểm tra thất bại ở ${stageLabel}` : "Kiểm tra thất bại",
              message: "Điểm cuối không vượt qua kiểm tra khả năng.",
              action: ""
            };
      } else if (isTypesafe) {
        // Gating stages passed. The image stage is reported separately and
        // never gates runnability (design.md decision 5) — but a failure there
        // is exactly the condition the screenshot toggle exists for, so it is
        // surfaced as its own non-alarm banner instead of being swallowed by a
        // plain success line. The same rule holds in the other direction: a
        // reply with NO verdict for the stage (a stored result recorded before
        // the stage existed, or an older companion that predates it) must not
        // be reported as "all three passed" — the pills already render that
        // state as "hình ảnh: chưa kiểm tra", so the banner must say the same
        // thing rather than contradict the page's own detail line.
        const imageVerdict = result.capabilities ? result.capabilities.image : undefined;
        const imageFailed = imageVerdict === "fail" || Boolean(result.errors && result.errors.image);
        this.state.banner = imageFailed
          ? {
              kind: "info",
              code: result.errors && result.errors.image ? result.errors.image.code : "VISION_ERROR",
              stage: "image",
              title: "Đã kiểm tra kết nối — giai đoạn “hình ảnh” không đạt",
              message: "Hai dịch vụ bắt buộc đều phản hồi (TypeSafe và mô hình văn bản), nhưng mô hình văn bản không nhận nội dung hình ảnh, nên ảnh chụp màn hình sẽ không gửi được. Hồ sơ vẫn chạy được.",
              action: "Chọn một mô hình văn bản nhận được hình ảnh, hoặc tắt “Gửi ảnh chụp màn hình cho mô hình quyết định” ở mục Nhà cung cấp để mọi yêu cầu chỉ còn văn bản."
            }
          : imageVerdict === "pass"
            ? { kind: "success", title: "Đã kiểm tra kết nối", message: "Cả ba giai đoạn đều đạt: TypeSafe (câu hỏi có cấu trúc), mô hình văn bản và hình ảnh.", action: "" }
            : {
                kind: "success",
                title: "Đã kiểm tra kết nối",
                message: "Hai giai đoạn bắt buộc đều đạt: TypeSafe (câu hỏi có cấu trúc) và mô hình văn bản. Giai đoạn “hình ảnh” chưa kiểm tra trên companion này, nên chưa xác nhận được ảnh chụp màn hình.",
                action: "Bấm “Kiểm tra kết nối” lại để chạy giai đoạn “hình ảnh”."
              };
      } else {
        this.state.banner = { kind: "success", title: "Đã kiểm tra kết nối", message: "Điểm cuối tương thích đầy đủ (văn bản, công cụ, hình ảnh).", action: "" };
      }
      this.state.testing = false;
      this._notify();
      return { ok: result.status === "pass" };
    } catch (err) {
      this.state.connectionStatus = { status: "fail", modelId: model, capabilities: {}, errors: { connection: { code: err.code, message: err.message } } };
      this.state.banner = { kind: "error", code: err.code, ...describeErrorCode(err.code) };
      this.state.testing = false;
      this._notify();
      return { ok: false, error: err.message, code: err.code };
    }
  }

  // --- Discovery ----------------------------------------------------------

  async discoverModels() {
    const notUsable = this._notUsableBanner();
    if (notUsable) {
      this.state.banner = notUsable;
      this._notify();
      return { ok: false };
    }
    this.state.discovering = true;
    this.state.banner = null;
    this._notify();
    try {
      const result = await this.client.discoverModels(this.state.profileId);
      if (!result.supported) {
        this.state.banner = {
          kind: "info",
          title: "Không hỗ trợ tìm mô hình tự động",
          message: result.reason || "Điểm cuối không hỗ trợ API liệt kê mô hình.",
          action: "Danh sách mô hình thủ công hiện tại vẫn được giữ nguyên."
        };
        this.state.discovering = false;
        this._notify();
        return { ok: true, supported: false };
      }
      // Merge favoring any local, not-yet-saved edit/addition (see file
      // header on why discovery must never clobber in-progress edits).
      const byId = new Map(this.state.models.map((m) => [m.id, m]));
      let addedCount = 0;
      for (const discovered of result.models) {
        if (!byId.has(discovered.id)) {
          byId.set(discovered.id, discovered);
          addedCount++;
        }
      }
      this.state.models = [...byId.values()];
      if (!this.state.defaultModelId && this.state.models.length) {
        this.state.defaultModelId = this.state.models[0].id;
      }
      this.state.banner = {
        kind: "success",
        title: "Đã tìm mô hình",
        message: `Tìm thấy ${result.models.length} mô hình (${addedCount} mới được thêm vào danh sách).`,
        action: ""
      };
      this.state.discovering = false;
      this._notify();
      return { ok: true, supported: true, addedCount };
    } catch (err) {
      this.state.banner = { kind: "error", code: err.code, ...describeErrorCode(err.code) };
      this.state.discovering = false;
      this._notify();
      return { ok: false, error: err.message, code: err.code };
    }
  }

  // --- Export / import (surfaces the task 2.3 module; see settings-app.js) -

  async exportProfile() {
    return this.client.exportProfile(this.state.profileId);
  }

  /** Apply an imported NON-SECRET profile document. Never touches the
   * credential — spec: "imported settings require a separate credential
   * entry". */
  async importProfile(imported) {
    if (!imported || typeof imported !== "object") {
      this.state.banner = { kind: "error", title: "Tệp không hợp lệ", message: "Không đọc được tệp cài đặt đã xuất.", action: "" };
      this._notify();
      return { ok: false };
    }
    this.state.baseUrlDraft = typeof imported.baseUrl === "string" ? imported.baseUrl : this.state.baseUrlDraft;
    this.state.models = Array.isArray(imported.models) ? imported.models.map((m) => ({ ...m })) : this.state.models;
    this.state.defaultModelId = imported.defaultModelId ?? this.state.defaultModelId;
    // The exported document is the companion's secret-free profile, so a
    // `typesafe` profile's text-model fields ride in it too — staged the same
    // way the Base URL above is (as drafts, applied only by the next Save).
    if (typeof imported.textModelBaseUrl === "string") {
      this.state.textModelBaseUrlDraft = imported.textModelBaseUrl;
    }
    if (typeof imported.textModelId === "string") {
      this.state.textModelIdDraft = imported.textModelId;
    }
    // The decision-model source and its own two fields (task 3.6) ride the
    // same secret-free document, staged as drafts the same way — only the
    // next Save writes them back.
    if (imported.typesafeDecisionSource === "anthropic" || imported.typesafeDecisionSource === "chatgpt" || imported.typesafeDecisionSource === "openai") {
      this.state.typesafeDecisionSource = imported.typesafeDecisionSource;
    }
    if (typeof imported.typesafeDecisionBaseUrl === "string") {
      this.state.decisionBaseUrlDraft = imported.typesafeDecisionBaseUrl;
    }
    if (typeof imported.typesafeDecisionModelId === "string") {
      this.state.decisionModelIdDraft = imported.typesafeDecisionModelId;
    }
    // The screenshot toggle rides the same secret-free document
    // (add-jev-run-screenshots task 3.2); staged like the fields above, so the
    // next Save — and only it — writes it back.
    if (typeof imported.sendScreenshots === "boolean") {
      this.state.sendScreenshots = imported.sendScreenshots;
    }
    // The consult-sources toggle rides the same secret-free document
    // (jev-runs-consult-sources-beyond-the-page task 5.2); staged like the
    // field above, so the next Save — and only it — writes it back.
    if (typeof imported.consultSources === "boolean") {
      this.state.consultSources = imported.consultSources;
    }
    this.state.banner = {
      kind: "info",
      title: "Đã nhập cài đặt (chưa lưu)",
      message: "Tệp xuất không chứa khóa bí mật. Xem lại rồi bấm Lưu; cần nhập lại API key.",
      action: ""
    };
    this._notify();
    return { ok: true };
  }
}

export { DEFAULT_PROFILE_ID };
