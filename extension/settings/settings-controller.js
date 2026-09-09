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

  /**
   * @param {ReturnType<import("./settings-client.js").createSettingsClient>} client
   * @param {{ profileId?: string, onChange?: (state: object) => void }} [opts]
   */
  constructor(client, opts = {}) {
    this.client = client;
    this.onChange = opts.onChange || null;
    this.state = emptyState(opts.profileId || DEFAULT_PROFILE_ID);
    this.#pendingSecretForRetry = null;
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
    // First-run is about whether a WORKING configuration exists yet (no
    // credential and no model to run against), independent of whether the
    // user already typed a non-default Base URL — see
    // test/settings-ui-controller.test.mjs "profile switching" for why
    // tying this to the default Base URL specifically was wrong: a partially
    // configured profile (custom endpoint, no key/model yet) is still
    // first-run onboarding, not a "returning user" state.
    s.isFirstRun = !s.hasCredential && s.models.length === 0;
  }

  /** Load (or reload) the profile from the companion. Also used for the
   * "profile switching" scenario: switching `profileId` starts completely
   * fresh — no field, pending key, banner or connection status survives
   * from a different profile. */
  async init(profileId) {
    if (profileId !== undefined) {
      this.state = emptyState(profileId);
      this.#pendingSecretForRetry = null;
    } else {
      const pid = this.state.profileId;
      this.state = emptyState(pid);
      this.#pendingSecretForRetry = null;
    }
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
        } catch (err) {
          if (err.code === "SECURE_STORAGE_UNAVAILABLE") {
            // Retained ONLY in the private field, only for this explicit,
            // user-visible offer — never re-shown in any field/state.
            this.#pendingSecretForRetry = secretToSend;
            this.state.pendingMemoryOnlyOffer = true;
            this.state.banner = { kind: "error", code: err.code, ...describeErrorCode(err.code) };
          } else {
            this.#pendingSecretForRetry = null;
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
    this.state.pendingMemoryOnlyOffer = false;
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

  async testConnection(modelId) {
    const model = modelId || this.state.defaultModelId;
    if (!model) {
      this.state.banner = { kind: "error", title: "Chưa chọn mô hình", message: "Thêm ít nhất một mô hình và đặt mặc định trước khi kiểm tra.", action: "" };
      this._notify();
      return { ok: false };
    }
    if (!this.state.hasCredential) {
      this.state.banner = { kind: "error", code: "NO_CREDENTIAL", ...describeErrorCode("NO_CREDENTIAL") };
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
    if (!this.state.hasCredential) {
      this.state.banner = { kind: "error", code: "NO_CREDENTIAL", ...describeErrorCode("NO_CREDENTIAL") };
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
