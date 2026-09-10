// Task 7.4 / redesign-settings-typed-only-skills task 3.6:
// extension/settings/skills-controller.js state-machine tests — deterministic,
// fully scripted (no real filesystem, no companion, no `document`/`window`
// reference anywhere in this file — the controller stays DOM-free, and this
// suite running to completion under plain Node is the proof), mirrors
// test/settings-ui-controller.test.mjs's convention. Real filesystem-backed
// coverage (actual author/edit/duplicate/traversal/symlink/
// unsupported-capability behavior from host/agent/skills/**, including a
// record that entered the catalog through the removed folder-import path)
// lives in test/settings-ui-skills-real-catalog.test.mjs — this file's job is
// the combinatorial state-machine/error-taxonomy/UI-state matrix, fast and
// deterministic.
//
// redesign-settings-typed-only-skills removed the folder-import surface
// (setImportDraft/importFromDraft, client.importSkill/refreshSkill) and added
// the typed edit/duplicate read-back (loadForEdit/loadForDuplicate, backed by
// client.readSkillSource) plus in-page confirmation state for both an
// unsaved-draft guard and skill removal.
//
// Run: node test/settings-ui-skills-controller.test.mjs
import { SkillsController } from "../extension/settings/skills-controller.js";

let fail = 0;
const ok = (c, m) => {
  console.log((c ? "  PASS " : "  FAIL ") + m);
  if (!c) fail++;
};

function makeSkill(overrides = {}) {
  return {
    name: "tom-tat-trang",
    description: "Tóm tắt nội dung trang hiện tại.",
    source: "/home/user/skills/tom-tat-trang",
    snapshotId: "tom-tat-trang",
    hash: "abc123",
    version: "1.0.0",
    enabled: false,
    userInvocable: true,
    modelInvocable: true,
    unsupportedCapabilities: [],
    importedAt: 1000,
    updatedAt: 1000,
    // Read-back-only fields (not part of a real catalog record — see
    // manage.js's listCatalog() — but convenient here to script what
    // readSkillSource() below returns for this fixture).
    body: "# Hướng dẫn\n\nLàm việc gì đó.\n",
    allowedTools: [],
    ...overrides
  };
}

function scriptedClient(initial = []) {
  let catalog = initial.map((s) => ({ ...s }));
  const calls = [];
  const scripts = { readSkillSource: null, authorSkill: null, enableSkill: null };
  const client = {
    async listCatalog() {
      calls.push({ op: "listCatalog" });
      return catalog.map((s) => ({ ...s }));
    },
    async readSkillSource(name) {
      calls.push({ op: "readSkillSource", name });
      if (scripts.readSkillSource) return scripts.readSkillSource(name);
      const existing = catalog.find((s) => s.name === name);
      if (!existing) throw Object.assign(new Error(`no skill "${name}"`), { code: "NOT_FOUND" });
      return {
        name: existing.name,
        description: existing.description,
        body: existing.body,
        allowedTools: existing.allowedTools,
        userInvocable: existing.userInvocable,
        modelInvocable: existing.modelInvocable
      };
    },
    async authorSkill(fields) {
      calls.push({ op: "authorSkill", fields });
      if (scripts.authorSkill) return scripts.authorSkill(fields);
      const existingIdx = catalog.findIndex((s) => s.name === fields.name);
      const record = makeSkill({
        name: fields.name,
        description: fields.description,
        body: fields.body,
        source: `/authored/${fields.name}`,
        userInvocable: fields.userInvocable !== false,
        modelInvocable: fields.modelInvocable !== false,
        updatedAt: Date.now()
      });
      if (existingIdx === -1) catalog.push(record);
      else catalog[existingIdx] = record;
      return { ...record };
    },
    async enableSkill(name) {
      calls.push({ op: "enableSkill", name });
      if (scripts.enableSkill) return scripts.enableSkill(name);
      const existing = catalog.find((s) => s.name === name);
      if (!existing) throw Object.assign(new Error(`no skill "${name}"`), { code: "NOT_FOUND" });
      existing.enabled = true;
      return { ...existing };
    },
    async disableSkill(name) {
      calls.push({ op: "disableSkill", name });
      const existing = catalog.find((s) => s.name === name);
      if (!existing) throw Object.assign(new Error(`no skill "${name}"`), { code: "NOT_FOUND" });
      existing.enabled = false;
      return { ...existing };
    },
    async removeSkill(name) {
      calls.push({ op: "removeSkill", name });
      catalog = catalog.filter((s) => s.name !== name);
      return true;
    },
    async setInvocationFlags(name, flags) {
      calls.push({ op: "setInvocationFlags", name, flags });
      const existing = catalog.find((s) => s.name === name);
      Object.assign(existing, flags);
      return { ...existing };
    }
  };
  return { client, calls, scripts, getCatalog: () => catalog };
}

console.log("== init / list rendering ==");
{
  const { client } = scriptedClient([makeSkill()]);
  const controller = new SkillsController(client);
  const updates = [];
  controller.onChange = (s) => updates.push(s);
  await controller.init();
  ok(controller.state.loaded === true, "loaded flips true after init");
  ok(controller.state.skills.length === 1 && controller.state.skills[0].name === "tom-tat-trang", "catalog loaded into state");
  ok(updates.length >= 2, "onChange fired at least once before and once after the load (loading state observable)");
}

console.log("== list load failure surfaces a banner, never a silent empty list ==");
{
  const client = { listCatalog: async () => { throw Object.assign(new Error("boom"), { code: "NETWORK_ERROR" }); } };
  const controller = new SkillsController(client);
  await controller.init();
  ok(controller.state.loaded === true, "loaded still flips true even on failure");
  ok(controller.state.banner && controller.state.banner.kind === "error", "a load failure produces an error banner");
  ok(controller.state.loadError && controller.state.loadError.code === "NETWORK_ERROR", "loadError code preserved");
}

console.log("== no folder-import surface remains on the controller ==");
{
  const { client } = scriptedClient([]);
  const controller = new SkillsController(client);
  ok(
    typeof controller.setImportDraft !== "function" &&
      typeof controller.importFromDraft !== "function" &&
      typeof controller.refreshSkill !== "function" &&
      controller.state.importDraft === undefined &&
      controller.state.importing === undefined,
    "setImportDraft()/importFromDraft()/refreshSkill() and importDraft/importing state are gone"
  );
}

console.log("== author: incomplete form is rejected client-side, before any call, with per-field errors ==");
for (const draft of [
  { name: "", description: "d", body: "b", missing: "name" },
  { name: "n", description: "   ", body: "b", missing: "description" },
  { name: "n", description: "d", body: "", missing: "body" }
]) {
  const { client, calls } = scriptedClient([]);
  const controller = new SkillsController(client);
  await controller.init();
  controller.setAuthorField("name", draft.name);
  controller.setAuthorField("description", draft.description);
  controller.setAuthorField("body", draft.body);
  const result = await controller.authorFromDraft();
  ok(result.ok === false, `incomplete draft ${JSON.stringify(draft)} is rejected before any call`);
  ok(!calls.some((c) => c.op === "authorSkill"), "authorSkill was never called for an incomplete draft");
  ok(!!controller.state.fieldErrors[draft.missing], `fieldErrors.${draft.missing} is set for a missing ${draft.missing}`);
}

console.log("== author: success re-lists the catalog and resets the draft, editingName and dirty flag ==");
{
  const { client, calls } = scriptedClient([]);
  const controller = new SkillsController(client);
  await controller.init();
  controller.setAuthorField("name", "typed-skill");
  controller.setAuthorField("description", "Một skill được gõ trực tiếp.");
  controller.setAuthorField("body", "# Hướng dẫn\n\nLàm việc gì đó.\n");
  controller.setAuthorField("allowedTools", "Read, Skill");
  controller.setAuthorField("modelInvocable", false);
  ok(controller.state.dirty === true, "draft is dirty after typing");
  const result = await controller.authorFromDraft();
  ok(result.ok === true, "author succeeds");
  ok(controller.state.authorDraft.name === "" && controller.state.authorDraft.body === "", "draft reset to empty after a successful author");
  ok(controller.state.authorDraft.userInvocable === true && controller.state.authorDraft.modelInvocable === true, "draft flags reset to their defaults too");
  ok(controller.state.editingName === null, "editingName cleared after a successful submit");
  ok(controller.state.dirty === false, "dirty cleared after a successful submit");
  ok(controller.state.skills.some((s) => s.name === "typed-skill"), "new authored skill appears in state.skills");
  ok(controller.state.banner && controller.state.banner.kind === "success" && controller.state.banner.title === "Đã tạo skill", "a first-time author submit banners as CREATED, not updated");
  ok(calls.filter((c) => c.op === "listCatalog").length >= 2, "catalog re-listed from the host after authoring, never assumed locally");
  const authorCall = calls.find((c) => c.op === "authorSkill");
  ok(
    authorCall.fields.allowedTools === "Read, Skill" && authorCall.fields.modelInvocable === false,
    "the full draft (allowedTools, invocation flags) is forwarded to the client"
  );
}

console.log("== author: re-submitting an already-listed name banners as UPDATED, never as a fresh CREATE ==");
{
  const { client } = scriptedClient([makeSkill({ name: "typed-skill", description: "Original." })]);
  const controller = new SkillsController(client);
  await controller.init();
  controller.setAuthorField("name", "typed-skill");
  controller.setAuthorField("description", "Edited version.");
  controller.setAuthorField("body", "# v2\n");
  const result = await controller.authorFromDraft();
  ok(result.ok === true, "edit submit succeeds");
  ok(
    controller.state.banner && controller.state.banner.kind === "success" && controller.state.banner.title === "Đã cập nhật skill",
    `re-submitting an existing name must banner as UPDATED, not CREATED — got ${JSON.stringify(controller.state.banner)}`
  );
}

console.log("== author: invalid name / duplicate name / traversal all produce an actionable banner, a field error, and DO NOT touch state.skills ==");
for (const code of ["INVALID_NAME", "DUPLICATE_NAME", "PATH_TRAVERSAL"]) {
  const { client } = scriptedClient([makeSkill()]);
  client.authorSkill = async () => {
    throw Object.assign(new Error(`rejected: ${code}`), { code });
  };
  const controller = new SkillsController(client);
  await controller.init();
  const before = controller.getState().skills.length;
  controller.setAuthorField("name", "bad-or-dup");
  controller.setAuthorField("description", "desc");
  controller.setAuthorField("body", "body");
  const result = await controller.authorFromDraft();
  ok(result.ok === false && result.code === code, `author rejection for ${code} is reported, not swallowed`);
  ok(controller.state.banner && controller.state.banner.kind === "error" && controller.state.banner.code === code, `${code} produces an error banner with the right code`);
  ok(controller.state.skills.length === before, `${code}: existing catalog is unchanged on a rejected author submit`);
  ok(controller.state.authoring === false, "authoring flag cleared after failure");
  ok(controller.state.authorDraft.name === "bad-or-dup", "draft is preserved (not reset) on failure so the operator doesn't retype it");
  ok(controller.state.fieldErrors.name, `${code} sets fieldErrors.name so the DOM layer can mark the name control aria-invalid`);
}

console.log("== author: editing a legacy (folder-imported) record in place surfaces a SPECIFIC, actionable message on DUPLICATE_NAME, not the generic one ==");
{
  const { client } = scriptedClient([makeSkill({ name: "legacy-skill", source: "/home/user/skills/legacy-skill" })]);
  client.readSkillSource = async (name) => ({
    name,
    description: "A legacy folder-imported skill.",
    body: "# legacy\n",
    allowedTools: [],
    userInvocable: true,
    modelInvocable: true
  });
  client.authorSkill = async () => {
    // Exactly what host/agent/skills/author.js actually raises for this
    // case (see skills-controller.js's own header on why): the record's
    // `source` is outside authoredSkillsRoot(), so isOwnAuthoredSource()
    // returns false and the DUPLICATE_NAME guard fires.
    throw Object.assign(new Error('A skill named "legacy-skill" is already imported from a different source'), { code: "DUPLICATE_NAME" });
  };
  const controller = new SkillsController(client);
  await controller.init();
  const loaded = await controller.loadForEdit("legacy-skill");
  ok(loaded.ok === true && controller.state.editingName === "legacy-skill", "loadForEdit() succeeds and binds editingName even for a legacy record");
  const result = await controller.authorFromDraft();
  ok(result.ok === false && result.code === "DUPLICATE_NAME", "the save still fails (a known, reported limitation — author.js is unmodified by this change)");
  ok(
    controller.state.banner.title === "Không thể lưu đè" && /Nhân bản/.test(controller.state.banner.message),
    `an in-place edit's DUPLICATE_NAME gets the specific "cannot overwrite, use Nhân bản" message, not the generic duplicate-name one — got ${JSON.stringify(controller.state.banner)}`
  );
}

console.log("== loadForEdit: seeds the form with the read-back and binds editingName ==");
{
  const { client, calls } = scriptedClient([makeSkill({ name: "edit-me", description: "Original desc.", body: "# original\n", allowedTools: ["Read"] })]);
  const controller = new SkillsController(client);
  await controller.init();
  const result = await controller.loadForEdit("edit-me");
  ok(result.ok === true, "loadForEdit succeeds");
  ok(calls.some((c) => c.op === "readSkillSource" && c.name === "edit-me"), "loadForEdit calls readSkillSource with the skill's own name");
  ok(controller.state.authorDraft.name === "edit-me", "draft name seeded with the SAME name (in-place edit)");
  ok(controller.state.authorDraft.description === "Original desc.", "draft description seeded from the read-back");
  ok(controller.state.authorDraft.body === "# original\n", "draft body seeded from the read-back");
  ok(controller.state.authorDraft.allowedTools === "Read", "array allowedTools joined into the comma-separated text field");
  ok(controller.state.editingName === "edit-me", "editingName bound to the loaded skill's name");
  ok(controller.state.dirty === false, "a freshly loaded draft is not dirty");
}

console.log("== loadForDuplicate: seeds a name that is not taken, editingName stays null ==");
{
  const { client } = scriptedClient([makeSkill({ name: "dup-me", description: "Original.", body: "# body\n" })]);
  const controller = new SkillsController(client);
  await controller.init();
  const result = await controller.loadForDuplicate("dup-me");
  ok(result.ok === true, "loadForDuplicate succeeds");
  ok(controller.state.authorDraft.name === "dup-me-copy", "draft name seeded as <name>-copy");
  ok(controller.state.editingName === null, "editingName stays null — duplicate must CREATE, never overwrite the source");
}

console.log("== loadForDuplicate: increments the suffix when -copy is already taken ==");
{
  const { client } = scriptedClient([
    makeSkill({ name: "dup-me", body: "# body\n" }),
    makeSkill({ name: "dup-me-copy", body: "# body\n" }),
    makeSkill({ name: "dup-me-copy-2", body: "# body\n" })
  ]);
  const controller = new SkillsController(client);
  await controller.init();
  await controller.loadForDuplicate("dup-me");
  ok(controller.state.authorDraft.name === "dup-me-copy-3", `expected dup-me-copy-3, got ${controller.state.authorDraft.name}`);
}

console.log("== loadForDuplicate: truncates the base rather than exceeding the 64-character name limit ==");
{
  const longName = "a".repeat(64);
  const { client } = scriptedClient([makeSkill({ name: longName, body: "# body\n" })]);
  const controller = new SkillsController(client);
  await controller.init();
  await controller.loadForDuplicate(longName);
  ok(controller.state.authorDraft.name.length <= 64, `derived duplicate name must not exceed 64 chars, got ${controller.state.authorDraft.name.length}`);
  ok(controller.state.authorDraft.name.endsWith("-copy"), `truncation must preserve the suffix, got ${controller.state.authorDraft.name}`);
}

console.log("== unsaved-draft guard: loadForEdit/loadForDuplicate over a dirty draft parks the request instead of overwriting it ==");
{
  const { client, calls } = scriptedClient([makeSkill({ name: "target-skill", body: "# body\n" })]);
  const controller = new SkillsController(client);
  await controller.init();
  controller.setAuthorField("name", "unsaved-draft-name");
  ok(controller.state.dirty === true, "draft is dirty after typing");
  const result = await controller.loadForEdit("target-skill");
  ok(result.ok === false && result.needsConfirmation === true, "a dirty draft parks the load instead of proceeding");
  ok(controller.state.authorDraft.name === "unsaved-draft-name", "the dirty draft is left completely untouched");
  ok(controller.state.pendingLoad && controller.state.pendingLoad.sourceName === "target-skill", "pendingLoad records the parked request");
  ok(!calls.some((c) => c.op === "readSkillSource"), "readSkillSource is never called while the load is parked");

  const confirmed = await controller.confirmPendingLoad();
  ok(confirmed.ok === true, "confirmPendingLoad() proceeds with the parked request");
  ok(controller.state.authorDraft.name === "target-skill", "the draft is now overwritten with the confirmed load");
  ok(controller.state.pendingLoad === null, "pendingLoad cleared after confirming");
}

console.log("== unsaved-draft guard: cancelPendingLoad() leaves the draft untouched ==");
{
  const { client } = scriptedClient([makeSkill({ name: "target-skill", body: "# body\n" })]);
  const controller = new SkillsController(client);
  await controller.init();
  controller.setAuthorField("name", "unsaved-draft-name");
  await controller.loadForEdit("target-skill");
  controller.cancelPendingLoad();
  ok(controller.state.pendingLoad === null, "pendingLoad cleared after cancelling");
  ok(controller.state.authorDraft.name === "unsaved-draft-name", "the original dirty draft is still exactly what the operator typed");
}

console.log("== discardDraft: resets the draft, editingName, dirty flag and any pending load ==");
{
  const { client } = scriptedClient([makeSkill({ name: "edit-me", body: "# body\n" })]);
  const controller = new SkillsController(client);
  await controller.init();
  await controller.loadForEdit("edit-me");
  controller.setAuthorField("description", "typed something else");
  controller.discardDraft();
  ok(controller.state.authorDraft.name === "" && controller.state.authorDraft.description === "", "draft reset to empty");
  ok(controller.state.editingName === null, "editingName cleared");
  ok(controller.state.dirty === false, "dirty cleared");
  ok(Object.keys(controller.state.fieldErrors).length === 0, "fieldErrors cleared");
}

console.log("== enable: unsupported-capability skill is rejected, never silently enabled ==");
{
  const { client } = scriptedClient([makeSkill({ name: "needs-shell", enabled: false, unsupportedCapabilities: ["Bash"] })]);
  client.enableSkill = async () => {
    throw Object.assign(new Error('Skill "needs-shell" requires capabilities this assistant does not support (Bash) and cannot be enabled.'), {
      code: "UNSUPPORTED_CAPABILITY"
    });
  };
  const controller = new SkillsController(client);
  await controller.init();
  const result = await controller.setEnabled("needs-shell", true);
  ok(result.ok === false && result.code === "UNSUPPORTED_CAPABILITY", "enabling an unsupported-capability skill is rejected");
  ok(controller.state.skills.find((s) => s.name === "needs-shell").enabled === false, "the skill's enabled flag in state is NEVER flipped true on a rejected enable");
  ok(controller.state.banner && controller.state.banner.code === "UNSUPPORTED_CAPABILITY", "an actionable banner is shown — never a silent no-op that could be mistaken for success");
}

console.log("== enable / disable: pending per-row busy state set and cleared ==");
{
  const { client } = scriptedClient([makeSkill({ enabled: false })]);
  const controller = new SkillsController(client);
  await controller.init();
  const pendingDuring = [];
  controller.onChange = (s) => pendingDuring.push(s.pending["tom-tat-trang"]);
  await controller.setEnabled("tom-tat-trang", true);
  ok(pendingDuring.includes("enabling"), "pending state observable as \"enabling\" during the call");
  ok(controller.state.pending["tom-tat-trang"] === undefined, "pending cleared after completion");
  ok(controller.state.skills[0].enabled === true, "enabled flag flipped true on success");
}

console.log("== removal confirmation: request/cancel/confirm transitions (design.md D5 — controller state, never window.confirm()) ==");
{
  const { client, calls } = scriptedClient([makeSkill()]);
  const controller = new SkillsController(client);
  await controller.init();

  controller.requestRemoval("tom-tat-trang");
  ok(controller.state.pendingRemoval === "tom-tat-trang", "requestRemoval sets pendingRemoval");
  ok(!calls.some((c) => c.op === "removeSkill"), "requesting removal does not itself remove anything");

  controller.cancelRemoval();
  ok(controller.state.pendingRemoval === null, "cancelRemoval clears pendingRemoval");
  ok(controller.state.skills.length === 1, "cancelling leaves the catalog untouched");

  controller.requestRemoval("tom-tat-trang");
  const result = await controller.confirmRemoval();
  ok(result.ok === true, "confirmRemoval performs the removal");
  ok(controller.state.pendingRemoval === null, "pendingRemoval cleared after confirming");
  ok(controller.state.skills.length === 0, "the skill is actually removed after confirmRemoval");
}

console.log("== removal confirmation: confirming a removal for a skill currently loaded in the form clears editingName ==");
{
  const { client } = scriptedClient([makeSkill({ name: "edit-me", body: "# body\n" })]);
  const controller = new SkillsController(client);
  await controller.init();
  await controller.loadForEdit("edit-me");
  ok(controller.state.editingName === "edit-me", "editingName bound after loadForEdit");
  controller.requestRemoval("edit-me");
  await controller.confirmRemoval();
  ok(controller.state.editingName === null, "editingName cleared once the record it referred to no longer exists");
}

console.log("== remove: banner clarifies the source folder is untouched ==");
{
  const { client } = scriptedClient([makeSkill()]);
  const controller = new SkillsController(client);
  await controller.init();
  const result = await controller.removeSkill("tom-tat-trang");
  ok(result.ok === true, "remove succeeds");
  ok(controller.state.skills.length === 0, "removed skill no longer in state.skills");
  ok(/không.*(bị xóa|thay đổi)|source|nguồn/i.test(controller.state.banner.message), "banner explicitly states the original source is untouched");
}

console.log("== remove: failure leaves the catalog untouched ==");
{
  const { client } = scriptedClient([makeSkill()]);
  client.removeSkill = async () => {
    throw Object.assign(new Error("boom"), { code: "NOT_FOUND" });
  };
  const controller = new SkillsController(client);
  await controller.init();
  const result = await controller.removeSkill("tom-tat-trang");
  ok(result.ok === false, "remove failure reported");
  ok(controller.state.skills.length === 1, "catalog unchanged on a failed remove");
}

console.log(fail === 0 ? "\nALL SETTINGS-UI SKILLS CONTROLLER TESTS PASSED" : `\n${fail} FAILED`);
process.exit(fail ? 1 : 0);
