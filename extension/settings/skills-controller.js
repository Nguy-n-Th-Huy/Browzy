// DOM-agnostic Settings > Skills state machine (design.md section 7 / task
// 7.3), following the same convention as settings-controller.js (task 4.4):
// no `document`/`chrome` reference, so it is directly testable from plain
// Node (test/settings-ui-skills-controller.test.mjs) against a fake or
// real-library-wrapping client. extension/settings/skills-app.js is the
// thin, screenshot-verified DOM binding layer.
//
// State shape mirrors the catalog record host/agent/skills/manage.js's
// listCatalog() returns (name, description, source, snapshotId, hash,
// version, enabled, userInvocable, modelInvocable, unsupportedCapabilities,
// importedAt, updatedAt) — this controller never invents fields the host
// catalog does not already have.

import { describeErrorCode } from "./errors-ui.js";

// The typed-authoring form's fields — exactly the payload
// host/agent/skills/author.js's authorSkill() accepts (name, description,
// body, userInvocable, modelInvocable, allowedTools). No "Kit"/"Màu sắc"/
// "Thẻ" fields: this project's SKILL.md schema has no such concepts (see
// author.js's own header) — a field that maps to nothing is worse than no
// field at all, so none is offered here.
function emptyAuthorDraft() {
  return {
    name: "",
    description: "",
    body: "",
    allowedTools: "", // comma-separated text field; author.js splits it
    userInvocable: true,
    modelInvocable: true
  };
}

function emptyState() {
  return {
    loaded: false,
    loadError: null,
    skills: [], // catalog records, in the order the host returned them
    importDraft: "", // the folder-path text field (see file header on why a
    // Chrome extension page cannot resolve an arbitrary native filesystem
    // path from a <input type="file"> picker alone — see skills-app.js)
    importing: false,
    authorDraft: emptyAuthorDraft(), // the typed-skill form fields
    authoring: false, // busy flag while a skills_author call is in flight
    banner: null, // { kind: "error"|"info"|"success", title, message, action, code }
    pending: {} // name -> "refreshing"|"removing"|"enabling"|"disabling" (per-row busy state)
  };
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

export class SkillsController {
  /**
   * @param {ReturnType<import("./skills-client.js").createSkillsClient>} client
   * @param {{ onChange?: (state: object) => void }} [opts]
   */
  constructor(client, opts = {}) {
    this.client = client;
    this.onChange = opts.onChange || null;
    this.state = emptyState();
  }

  getState() {
    return deepClone(this.state);
  }

  _notify() {
    if (this.onChange) this.onChange(this.getState());
  }

  _setPending(name, value) {
    if (value) this.state.pending[name] = value;
    else delete this.state.pending[name];
  }

  _bannerFromError(err) {
    return { kind: "error", code: err.code, ...describeErrorCode(err.code) };
  }

  async init() {
    this.state = emptyState();
    this._notify();
    try {
      const skills = await this.client.listCatalog();
      this.state.skills = Array.isArray(skills) ? skills : [];
      this.state.loaded = true;
    } catch (err) {
      this.state.loaded = true;
      this.state.loadError = { code: err.code || "NETWORK_ERROR", message: err.message };
      this.state.banner = this._bannerFromError(err);
    }
    this._notify();
    return this.getState();
  }

  async refreshList() {
    try {
      const skills = await this.client.listCatalog();
      this.state.skills = Array.isArray(skills) ? skills : [];
      this.state.loadError = null;
    } catch (err) {
      this.state.loadError = { code: err.code || "NETWORK_ERROR", message: err.message };
      this.state.banner = this._bannerFromError(err);
    }
    this._notify();
  }

  setImportDraft(value) {
    this.state.importDraft = value;
    this._notify();
  }

  /**
   * Imports whatever folder path the user picked/typed. No implicit
   * scanning of any other directory ever happens — this is the ONLY way a
   * folder is ever read (design.md section 7: "A folder picker can select a
   * personal or project skill directory; no implicit scanning of all
   * home/project configuration occurs").
   */
  async importFromDraft() {
    const sourceDir = this.state.importDraft.trim();
    if (!sourceDir) {
      this.state.banner = { kind: "error", title: "Chưa chọn thư mục", message: "Nhập hoặc chọn đường dẫn thư mục skill trước.", action: "" };
      this._notify();
      return { ok: false };
    }
    this.state.importing = true;
    this.state.banner = null;
    this._notify();
    try {
      const record = await this.client.importSkill(sourceDir);
      // Never assume the new entry's position — the host is the source of
      // truth for catalog order (defends against a concurrent import from
      // elsewhere landing between this call's send and its reply).
      await this.refreshList();
      this.state.importing = false;
      this.state.importDraft = "";
      this.state.banner = {
        kind: "success",
        title: "Đã nhập skill",
        message: `Đã nhập "${record.name}". Bật skill này để dùng trong cuộc trò chuyện.`,
        action: ""
      };
      this._notify();
      return { ok: true, record };
    } catch (err) {
      this.state.importing = false;
      this.state.banner = this._bannerFromError(err);
      this._notify();
      return { ok: false, error: err.message, code: err.code };
    }
  }

  setAuthorField(field, value) {
    this.state.authorDraft = { ...this.state.authorDraft, [field]: value };
    this._notify();
  }

  /**
   * Submits the typed-skill form. Composing and writing SKILL.md, and every
   * validation rule (name pattern, non-empty description) beyond the bare
   * "did you fill in the required fields at all" check below, live entirely
   * host-side in host/agent/skills/author.js — this controller never
   * duplicates that logic, it only forwards the draft and turns whatever
   * the host decides into the same actionable banner every other op here
   * already produces.
   */
  async authorFromDraft() {
    const draft = this.state.authorDraft;
    const name = (draft.name || "").trim();
    const description = (draft.description || "").trim();
    const body = (draft.body || "").trim();
    if (!name || !description || !body) {
      this.state.banner = {
        kind: "error",
        title: "Thiếu thông tin",
        message: "Nhập đủ Tên, Mô tả và Nội dung (Markdown) trước khi tạo skill.",
        action: ""
      };
      this._notify();
      return { ok: false };
    }
    // Captured BEFORE the call: re-submitting the same name is a deliberate
    // edit (host/agent/skills/author.js rewrites that skill's own SKILL.md
    // and refreshes it in place — see that module's header), not a second
    // creation. Telling the two apart here means an operator who forgot a
    // same-named authored skill already existed sees "Đã cập nhật", not a
    // misleading "Đã tạo", when their old body/invocation flags just got
    // overwritten by this submit.
    const isEdit = this.state.skills.some((s) => s.name === name);
    this.state.authoring = true;
    this.state.banner = null;
    this._notify();
    try {
      const record = await this.client.authorSkill({
        name,
        description,
        body: draft.body,
        userInvocable: draft.userInvocable,
        modelInvocable: draft.modelInvocable,
        allowedTools: draft.allowedTools
      });
      // Same "never assume the new entry's position/shape locally" rule
      // importFromDraft() already follows — the host is the source of truth.
      await this.refreshList();
      this.state.authoring = false;
      this.state.authorDraft = emptyAuthorDraft();
      this.state.banner = isEdit
        ? {
            kind: "success",
            title: "Đã cập nhật skill",
            message: `Đã ghi đè nội dung của "${record.name}" bằng bản vừa sửa.`,
            action: ""
          }
        : {
            kind: "success",
            title: "Đã tạo skill",
            message: `Đã tạo "${record.name}". Bật skill này để dùng trong cuộc trò chuyện.`,
            action: ""
          };
      this._notify();
      return { ok: true, record };
    } catch (err) {
      this.state.authoring = false;
      this.state.banner = this._bannerFromError(err);
      this._notify();
      return { ok: false, error: err.message, code: err.code };
    }
  }

  async setEnabled(name, enabled) {
    this._setPending(name, enabled ? "enabling" : "disabling");
    this.state.banner = null;
    this._notify();
    try {
      const updated = enabled ? await this.client.enableSkill(name) : await this.client.disableSkill(name);
      const idx = this.state.skills.findIndex((s) => s.name === name);
      if (idx !== -1) this.state.skills[idx] = updated;
      this._setPending(name, null);
      this._notify();
      return { ok: true };
    } catch (err) {
      this._setPending(name, null);
      // enable() throwing SkillCapabilityError/UNSUPPORTED_CAPABILITY is the
      // "never silently enable shell access" gate (design.md section 7) —
      // surfaced here as an actionable banner, never a silent no-op that
      // could be mistaken for success.
      this.state.banner = this._bannerFromError(err);
      this._notify();
      return { ok: false, error: err.message, code: err.code };
    }
  }

  async refreshSkill(name) {
    this._setPending(name, "refreshing");
    this.state.banner = null;
    this._notify();
    try {
      const updated = await this.client.refreshSkill(name);
      const idx = this.state.skills.findIndex((s) => s.name === name);
      if (idx !== -1) this.state.skills[idx] = updated;
      this._setPending(name, null);
      this.state.banner = { kind: "success", title: "Đã nạp lại", message: `Đã cập nhật "${name}" từ thư mục nguồn.`, action: "" };
      this._notify();
      return { ok: true };
    } catch (err) {
      this._setPending(name, null);
      this.state.banner = this._bannerFromError(err);
      this._notify();
      return { ok: false, error: err.message, code: err.code };
    }
  }

  /** Removes the app's imported copy only — never the user's original
   * source folder (design.md section 7: "Removing a skill never deletes its
   * original source directory"; host/agent/skills/manage.js's removeSkill()
   * only ever touches the snapshot store). */
  async removeSkill(name) {
    this._setPending(name, "removing");
    this.state.banner = null;
    this._notify();
    try {
      await this.client.removeSkill(name);
      this.state.skills = this.state.skills.filter((s) => s.name !== name);
      this._setPending(name, null);
      this.state.banner = {
        kind: "info",
        title: "Đã gỡ bỏ",
        message: `Đã gỡ bản sao "${name}" khỏi ứng dụng. Thư mục nguồn gốc không bị thay đổi.`,
        action: ""
      };
      this._notify();
      return { ok: true };
    } catch (err) {
      this._setPending(name, null);
      this.state.banner = this._bannerFromError(err);
      this._notify();
      return { ok: false, error: err.message, code: err.code };
    }
  }

  async setInvocationFlags(name, flags) {
    try {
      const updated = await this.client.setInvocationFlags(name, flags);
      const idx = this.state.skills.findIndex((s) => s.name === name);
      if (idx !== -1) this.state.skills[idx] = updated;
      this._notify();
      return { ok: true };
    } catch (err) {
      this.state.banner = this._bannerFromError(err);
      this._notify();
      return { ok: false, error: err.message, code: err.code };
    }
  }
}
