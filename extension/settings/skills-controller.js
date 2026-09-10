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
    authorDraft: emptyAuthorDraft(), // the typed-skill form fields
    authoring: false, // busy flag while a skills_author call is in flight
    editingName: null, // the catalog name a Sửa-loaded draft will overwrite;
    // null while composing fresh or while a Nhân bản-loaded draft (which
    // must create a NEW entry, never overwrite the one it was copied from)
    // is in the form.
    dirty: false, // true once the draft has any unsaved change; used to gate
    // loadForEdit()/loadForDuplicate() so a typed-but-unsaved draft is never
    // silently discarded (design.md decision D3).
    pendingLoad: null, // { sourceName, seedName, kind: "edit"|"duplicate" }
    // awaiting explicit confirmation to discard the current dirty draft.
    pendingRemoval: null, // catalog name awaiting explicit removal
    // confirmation — an in-page card's state, never window.confirm()
    // (design.md decision D5).
    banner: null, // { kind: "error"|"info"|"success", title, message, action, code }
    fieldErrors: {}, // "name"|"description"|"body" -> message; per-field
    // invalid-submission copy (task 4.6), separate from the summary banner.
    pending: {} // name -> "removing"|"enabling"|"disabling" (per-row busy state)
  };
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

// Maps a rejected authorSkill() call back to the ONE form field it concerns,
// so the DOM layer can set aria-invalid on that specific control instead of
// only showing a summary banner (task 4.6). Every code below is one
// author.js/frontmatter.js can actually throw for a well-formed (non-empty)
// submission — see author.js's own header for INVALID_NAME vs
// INVALID_METADATA. INVALID_METADATA is host-shared between the description
// and body checks (both throw that same code — see author.js), disambiguated
// here from the message text those two call sites each compose differently.
function fieldForAuthorError(err) {
  const code = err && err.code;
  if (code === "INVALID_NAME" || code === "PATH_TRAVERSAL" || code === "DUPLICATE_NAME") return "name";
  if (code === "INVALID_METADATA") {
    const msg = ((err && err.message) || "").toLowerCase();
    if (msg.includes("description")) return "description";
    if (msg.includes("body") || msg.includes("markdown")) return "body";
  }
  return null;
}

// design.md decision D3: duplicate seeds a name not present in the loaded
// catalog (`<name>-copy`, `-copy-2`, …), truncating the BASE (never the
// suffix) so the derived name never exceeds frontmatter.js's 64-character
// NAME_PATTERN limit — re-derived every iteration because "-copy-2" and
// "-copy-10" are different lengths.
const MAX_SKILL_NAME_LENGTH = 64;
function deriveDuplicateName(baseName, existingNames) {
  let n = 1;
  for (;;) {
    const suffix = n === 1 ? "-copy" : `-copy-${n}`;
    const truncatedBase = baseName.length + suffix.length > MAX_SKILL_NAME_LENGTH
      ? baseName.slice(0, Math.max(0, MAX_SKILL_NAME_LENGTH - suffix.length))
      : baseName;
    const candidate = `${truncatedBase}${suffix}`;
    if (!existingNames.has(candidate)) return candidate;
    n += 1;
  }
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

  setAuthorField(field, value) {
    this.state.authorDraft = { ...this.state.authorDraft, [field]: value };
    this.state.dirty = true;
    // Editing a field the operator was just told is invalid clears that
    // field's error immediately — the message would otherwise go stale the
    // moment they start fixing it.
    if (this.state.fieldErrors[field]) {
      const { [field]: _dropped, ...rest } = this.state.fieldErrors;
      this.state.fieldErrors = rest;
    }
    this._notify();
  }

  /** Explicit discard of whatever is currently in the authoring form —
   * clears the draft, the edit/duplicate binding, and the dirty flag. */
  discardDraft() {
    this.state.authorDraft = emptyAuthorDraft();
    this.state.editingName = null;
    this.state.dirty = false;
    this.state.pendingLoad = null;
    this.state.banner = null;
    this.state.fieldErrors = {};
    this._notify();
  }

  /**
   * Loads a stored skill's own name/description/body/allowed-tools/
   * invocation flags back into the form for in-place editing
   * (design.md decision D3, "Sửa"). Submitting afterward hits
   * authorSkill() with that same name, which author.js treats as an
   * in-place rewrite.
   */
  async loadForEdit(name) {
    return this._loadInto({ sourceName: name, seedName: name, kind: "edit" });
  }

  /**
   * Loads a stored skill's content into the form under a name that is not
   * yet taken (design.md decision D3, "Nhân bản"). Submitting afterward
   * creates a NEW catalog entry; the original is left untouched.
   */
  async loadForDuplicate(name) {
    const existingNames = new Set(this.state.skills.map((s) => s.name));
    const seedName = deriveDuplicateName(name, existingNames);
    return this._loadInto({ sourceName: name, seedName, kind: "duplicate" });
  }

  /** Guards against silently discarding an unsaved draft (design.md decision
   * D3's last paragraph): a dirty draft parks the request in `pendingLoad`
   * instead of overwriting the form immediately. */
  async _loadInto(request) {
    if (this.state.dirty) {
      this.state.pendingLoad = request;
      this._notify();
      return { ok: false, needsConfirmation: true };
    }
    return this._performLoad(request);
  }

  async _performLoad({ sourceName, seedName, kind }) {
    this.state.banner = null;
    this.state.fieldErrors = {};
    this._notify();
    try {
      const src = await this.client.readSkillSource(sourceName);
      this.state.authorDraft = {
        name: seedName,
        description: src.description || "",
        body: src.body || "",
        allowedTools: Array.isArray(src.allowedTools) ? src.allowedTools.join(", ") : src.allowedTools || "",
        userInvocable: src.userInvocable !== false,
        modelInvocable: src.modelInvocable !== false
      };
      // A duplicate always seeds a name distinct from its source, so it must
      // never carry editingName forward — submitting it must CREATE, not
      // overwrite the record it was copied from.
      this.state.editingName = kind === "edit" ? sourceName : null;
      this.state.dirty = false;
      this.state.pendingLoad = null;
      this._notify();
      return { ok: true };
    } catch (err) {
      this.state.pendingLoad = null;
      this.state.banner = this._bannerFromError(err);
      this._notify();
      return { ok: false, error: err.message, code: err.code };
    }
  }

  /** Explicit confirmation to discard the current dirty draft and proceed
   * with the parked loadForEdit()/loadForDuplicate() request. */
  async confirmPendingLoad() {
    const request = this.state.pendingLoad;
    if (!request) return { ok: false };
    return this._performLoad(request);
  }

  /** Cancels a parked load request, leaving the current draft untouched. */
  cancelPendingLoad() {
    this.state.pendingLoad = null;
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
      const fieldErrors = {};
      if (!name) fieldErrors.name = 'Bắt buộc — đặt tên để gọi thủ công bằng "/tên-skill".';
      if (!description) fieldErrors.description = "Bắt buộc — mô hình dựa vào đây để biết khi nào dùng skill.";
      if (!body) fieldErrors.body = "Bắt buộc — đây là phần hướng dẫn mô hình sẽ đọc.";
      this.state.fieldErrors = fieldErrors;
      this.state.banner = {
        kind: "error",
        title: "Thiếu thông tin",
        message: "Sửa các lỗi bên dưới để tiếp tục.",
        action: ""
      };
      this._notify();
      return { ok: false };
    }
    this.state.fieldErrors = {};
    // Captured BEFORE the call: re-submitting the same name is a deliberate
    // edit (host/agent/skills/author.js rewrites that skill's own SKILL.md
    // and refreshes it in place — see that module's header), not a second
    // creation. Telling the two apart here means an operator who forgot a
    // same-named authored skill already existed sees "Đã cập nhật", not a
    // misleading "Đã tạo", when their old body/invocation flags just got
    // overwritten by this submit.
    const isEdit = this.state.skills.some((s) => s.name === name);
    // Distinct from `isEdit` above: true only when this submit is the
    // in-place "Sửa" flow (editingName seeded by loadForEdit(), still the
    // same name). It is forwarded to the host because the name alone cannot
    // tell an edit from a creation that happens to collide with a taken
    // name — the first must overwrite, the second must be refused. A record
    // that entered the catalog through the removed folder-import path is
    // adopted on such an edit (its source is re-pointed at the app's own
    // storage); without this flag it would still be rejected as a duplicate.
    const wasEditingInPlace = this.state.editingName === name;
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
        allowedTools: draft.allowedTools,
        editing: wasEditingInPlace
      });
      // Never assume the new entry's position/shape locally — the host is
      // the source of truth for catalog order and content.
      await this.refreshList();
      this.state.authoring = false;
      this.state.authorDraft = emptyAuthorDraft();
      this.state.editingName = null;
      this.state.dirty = false;
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
      if (wasEditingInPlace && err.code === "DUPLICATE_NAME") {
        this.state.banner = {
          kind: "error",
          code: err.code,
          title: "Không thể lưu đè",
          message: `Skill "${name}" được nhập từ một thư mục trước đây nên chưa thể lưu bản sửa trực tiếp lên nó. Dùng "Nhân bản" để tạo một bản có thể chỉnh sửa, rồi gỡ bản cũ nếu muốn.`,
          action: ""
        };
        this.state.fieldErrors = {};
      } else {
        this.state.banner = this._bannerFromError(err);
        const field = fieldForAuthorError(err);
        this.state.fieldErrors = field ? { [field]: err.message } : {};
      }
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

  /** Opens the in-page removal-confirmation card for `name`
   * (design.md decision D5 — never window.confirm()). */
  requestRemoval(name) {
    this.state.pendingRemoval = name;
    this._notify();
  }

  /** Closes the in-page removal-confirmation card without removing
   * anything. */
  cancelRemoval() {
    this.state.pendingRemoval = null;
    this._notify();
  }

  /** Confirms the pending removal and performs it. */
  async confirmRemoval() {
    const name = this.state.pendingRemoval;
    if (!name) return { ok: false };
    this.state.pendingRemoval = null;
    return this.removeSkill(name);
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
      // A form mid-edit for the record just removed can no longer save "in
      // place" against anything — drop the binding so a submit creates a
      // fresh entry instead of failing against a name that no longer exists.
      if (this.state.editingName === name) this.state.editingName = null;
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
