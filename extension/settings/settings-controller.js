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
// every other field here, the settings page's key `<input>` is deliberately
// left UNCONTROLLED by controller state. `save(secretInput)` takes the raw
// value as a plain function argument, read live from the DOM by
// settings-app.js at the moment Save is clicked, so it is never broadcast
// through `onChange`/`getState()` on every keystroke the way a controlled
// field would. The only place a raw key value is EVER held by this class is
// `#pendingSecretForRetry`, a true private class field (never enumerable,
// never included in `getState()`'s plain-object snapshot, never logged). It
// exists only to let an explicit, user-confirmed memory-only retry proceed
// after a SECURE_STORAGE_UNAVAILABLE failure without forcing the user to
// retype the key they just submitted; it is cleared (`= null`) after every
// save attempt's outcome, on `init()`/`switchProfile()`, and on
// `removeCredential()`.

import { validateBaseUrl, validateModelsList, DEFAULT_BASE_URL } from "./settings-validation.js";
import { describeErrorCode } from "./errors-ui.js";

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

    fieldErrors: { baseUrl: null, models: null },
    banner: null, // { kind: "error"|"info"|"success", title, message, action, code }
    connectionStatus: null, // { status: "testing"|"pass"|"fail", capabilities, errors, timestamp, modelId, textOnly }

    isFirstRun: false
  };
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
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
    s.defaultModelId = profile.defaultModelId;
    s.hasCredential = Boolean(profile.hasCredential);
    s.memoryOnlyCredential = Boolean(profile.memoryOnlyCredential);
    s.secretBackend = profile.secretBackend || null;
    s.providerType = profile.providerType || "anthropic";
    s.chatgptAccount = profile.chatgptAccount || null;
    s.chatgptSessionState = profile.chatgptSessionState || "signed_out";
    // A chatgpt profile whose session expired host-side (auth.js's refresh
    // saw `invalid_grant`/`refresh_token_reused` → recordChatgptSessionExpired)
    // has no other way to tell the user from a cold load: the side panel shows
    // its own banner, but the settings page must surface it too
    // (add-chatgpt-subscription-provider, tasks.md 5.3's "SESSION_EXPIRED
    // banner"). Set only when nothing more specific is already being shown —
    // every caller below assigns its own banner AFTER _applyProfile, so this
    // never clobbers a just-performed action's result.
    if (
      s.providerType === "chatgpt" &&
      s.chatgptSessionState === "session_expired" &&
      !s.banner
    ) {
      s.banner = { kind: "error", code: "SESSION_EXPIRED", ...describeErrorCode("SESSION_EXPIRED") };
    }
    // First-run is about whether a WORKING configuration exists yet (no
    // credential and no model to run against), independent of whether the
    // user already typed a non-default Base URL — see
    // test/settings-ui-controller.test.mjs "profile switching" for why
    // tying this to the default Base URL specifically was wrong: a partially
    // configured profile (custom endpoint, no key/model yet) is still
    // first-run onboarding, not a "returning user" state.
    s.isFirstRun = !s.hasCredential && s.models.length === 0;

    // ChatGPT usage (add-chatgpt-usage-check design.md decision 6): a
    // signed-in `chatgpt` profile starts one read; every other state clears
    // the block instead, because no read is ever issued for it (specs
    // "ChatGPT usage display" — not signed in / expired reads nothing). The
    // read happens once per profile application, never on a timer;
    // refreshUsage() de-duplicates against a read already in flight, so a
    // profile application arriving mid-read does not double the request.
    if (s.providerType === "chatgpt" && s.chatgptSessionState === "signed_in") {
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

  /** Switch between `anthropic` and `chatgpt`. Never touches the model list
   * or (for `chatgpt`) a previously signed-in account — switching back and
   * forth is nondestructive (mirrors host/agent/settings/profile.js's own
   * setProviderType() doc comment). */
  async setProviderType(providerType) {
    if (providerType !== "anthropic" && providerType !== "chatgpt") {
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

  /** True for the one state that has a usage block to read: a signed-in
   * `chatgpt` profile. An `anthropic` profile, a signed-out one, and a
   * session-expired one all read nothing (specs "ChatGPT usage display"). */
  _usageReadable() {
    return this.state.providerType === "chatgpt" && this.state.chatgptSessionState === "signed_in";
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
   *   user did not type a new key this time. */
  async save(secretInput) {
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

    this.state.fieldErrors.baseUrl = null;
    this.state.fieldErrors.models = null;
    this.state.saving = true;
    this.state.banner = null;
    this._notify();

    try {
      const saved = await this.client.saveProfile(this.state.profileId, {
        baseUrl: urlResult.normalized,
        models: modelsResult.models,
        defaultModelId: modelsResult.defaultModelId
      });
      this._applyProfile(saved);

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

      this.state.saving = false;
      if (!this.state.banner) {
        this.state.banner = { kind: "success", title: "Đã lưu", message: "Đã lưu cài đặt.", action: "" };
      }
      this._notify();
      return { ok: true };
    } catch (err) {
      this.state.saving = false;
      this.state.banner = { kind: "error", code: err.code, ...describeErrorCode(err.code) };
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
   * `memoryOnly: true`. */
  async confirmMemoryOnlyCredential() {
    if (!this.#pendingSecretForRetry) {
      return { ok: false, error: "no pending credential to retry" };
    }
    const secretToSend = this.#pendingSecretForRetry;
    this.#pendingSecretForRetry = null;
    this.state.pendingMemoryOnlyOffer = false;
    this.state.memoryOnlyOfferKind = null;
    this._notify();
    try {
      const result = await this.client.setCredential(this.state.profileId, secretToSend, { memoryOnly: true });
      this.state.hasCredential = true;
      this.state.memoryOnlyCredential = true;
      this.state.secretBackend = result.backend;
      this.state.connectionStatus = null;
      this.state.banner = { kind: "success", title: "Đã lưu (chỉ trong bộ nhớ)", message: "Khóa sẽ mất khi companion khởi động lại.", action: "" };
      this._notify();
      return { ok: true };
    } catch (err) {
      this.state.banner = { kind: "error", code: err.code, ...describeErrorCode(err.code) };
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

  /** The "not usable yet" banner for the CURRENT provider type — NO_CREDENTIAL
   * ("enter an API key") is only ever correct for an `anthropic` profile. A
   * `chatgpt` profile's missing credential means "sign in with ChatGPT", and a
   * session that expired host-side says so explicitly (specs/agent-settings
   * "ChatGPT profile not signed in"; tasks.md 5.3's SESSION_EXPIRED banner).
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
    this.state.testing = true;
    this.state.connectionStatus = { status: "testing", modelId: model };
    this.state.banner = null;
    this._notify();
    try {
      const result = await this.client.testCapability(this.state.profileId, model);
      const textOnly = result.capabilities.text === "pass" && (result.capabilities.tool !== "pass" || result.capabilities.vision !== "pass");
      this.state.connectionStatus = { ...result, modelId: model, textOnly };
      if (result.status !== "pass") {
        const firstFailedCode = Object.values(result.errors)[0]?.code;
        this.state.banner = firstFailedCode
          ? { kind: "error", code: firstFailedCode, ...describeErrorCode(firstFailedCode) }
          : { kind: "error", title: "Kiểm tra thất bại", message: "Điểm cuối không vượt qua kiểm tra khả năng.", action: "" };
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
