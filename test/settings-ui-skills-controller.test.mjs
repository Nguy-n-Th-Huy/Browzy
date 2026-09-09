// Task 7.4: extension/settings/skills-controller.js state-machine tests —
// deterministic, fully scripted (no real filesystem, no companion), mirrors
// test/settings-ui-controller.test.mjs's convention. Real filesystem-backed
// coverage (actual import/duplicate/traversal/symlink/unsupported-capability
// behavior from host/agent/skills/**) lives in
// test/settings-ui-skills-real-catalog.test.mjs — this file's job is the
// combinatorial state-machine/error-taxonomy/UI-state matrix, fast and
// deterministic.
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
    ...overrides
  };
}

function scriptedClient(initial = []) {
  let catalog = initial.map((s) => ({ ...s }));
  const calls = [];
  const scripts = { importSkill: null, enableSkill: null, authorSkill: null };
  const client = {
    async listCatalog() {
      calls.push({ op: "listCatalog" });
      return catalog.map((s) => ({ ...s }));
    },
    async importSkill(sourceDir) {
      calls.push({ op: "importSkill", sourceDir });
      if (scripts.importSkill) return scripts.importSkill(sourceDir);
      const record = makeSkill({ name: "new-skill", source: sourceDir });
      catalog.push(record);
      return { ...record };
    },
    async authorSkill(fields) {
      calls.push({ op: "authorSkill", fields });
      if (scripts.authorSkill) return scripts.authorSkill(fields);
      const record = makeSkill({
        name: fields.name,
        description: fields.description,
        source: `/authored/${fields.name}`,
        userInvocable: fields.userInvocable !== false,
        modelInvocable: fields.modelInvocable !== false
      });
      catalog.push(record);
      return { ...record };
    },
    async refreshSkill(name) {
      calls.push({ op: "refreshSkill", name });
      const existing = catalog.find((s) => s.name === name);
      if (!existing) throw Object.assign(new Error(`no skill "${name}"`), { code: "NOT_FOUND" });
      existing.updatedAt = Date.now();
      return { ...existing };
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

console.log("== import: no path entered ==");
{
  const { client } = scriptedClient([]);
  const controller = new SkillsController(client);
  await controller.init();
  controller.setImportDraft("   ");
  const result = await controller.importFromDraft();
  ok(result.ok === false, "empty/whitespace-only path is rejected client-side, before any call");
}

console.log("== import: success re-lists the catalog and clears the draft ==");
{
  const { client, calls } = scriptedClient([]);
  const controller = new SkillsController(client);
  await controller.init();
  controller.setImportDraft("/home/user/skills/new-skill");
  const result = await controller.importFromDraft();
  ok(result.ok === true, "import succeeds");
  ok(controller.state.importDraft === "", "draft cleared after a successful import");
  ok(controller.state.skills.some((s) => s.name === "new-skill"), "new skill appears in state.skills");
  ok(controller.state.banner && controller.state.banner.kind === "success", "success banner shown");
  ok(calls.filter((c) => c.op === "listCatalog").length >= 2, "catalog re-listed from the host after import, never assumed locally");
}

console.log("== import: invalid metadata / duplicate name / traversal / symlink escape all produce an actionable banner and DO NOT touch state.skills ==");
for (const code of ["INVALID_METADATA", "DUPLICATE_NAME", "PATH_TRAVERSAL", "SYMLINK_ESCAPE", "NOT_A_SKILL"]) {
  const { client } = scriptedClient([makeSkill()]);
  client.importSkill = async () => {
    throw Object.assign(new Error(`rejected: ${code}`), { code });
  };
  const controller = new SkillsController(client);
  await controller.init();
  const before = controller.getState().skills.length;
  controller.setImportDraft("/some/bad/path");
  const result = await controller.importFromDraft();
  ok(result.ok === false && result.code === code, `import rejection for ${code} is reported, not swallowed`);
  ok(controller.state.banner && controller.state.banner.kind === "error" && controller.state.banner.code === code, `${code} produces an error banner with the right code`);
  ok(controller.state.skills.length === before, `${code}: existing catalog is unchanged on a rejected import`);
  ok(controller.state.importing === false, "importing flag cleared after failure");
}

console.log("== author: incomplete form is rejected client-side, before any call ==");
for (const draft of [
  { name: "", description: "d", body: "b" },
  { name: "n", description: "   ", body: "b" },
  { name: "n", description: "d", body: "" }
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
}

console.log("== author: success re-lists the catalog and resets the draft ==");
{
  const { client, calls } = scriptedClient([]);
  const controller = new SkillsController(client);
  await controller.init();
  controller.setAuthorField("name", "typed-skill");
  controller.setAuthorField("description", "Một skill được gõ trực tiếp.");
  controller.setAuthorField("body", "# Hướng dẫn\n\nLàm việc gì đó.\n");
  controller.setAuthorField("allowedTools", "Read, Skill");
  controller.setAuthorField("modelInvocable", false);
  const result = await controller.authorFromDraft();
  ok(result.ok === true, "author succeeds");
  ok(controller.state.authorDraft.name === "" && controller.state.authorDraft.body === "", "draft reset to empty after a successful author");
  ok(controller.state.authorDraft.userInvocable === true && controller.state.authorDraft.modelInvocable === true, "draft flags reset to their defaults too");
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

console.log("== author: invalid name / empty description / duplicate name all produce an actionable banner and DO NOT touch state.skills ==");
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

console.log("== refresh: updates the record in place ==");
{
  const { client } = scriptedClient([makeSkill({ updatedAt: 1 })]);
  const controller = new SkillsController(client);
  await controller.init();
  const result = await controller.refreshSkill("tom-tat-trang");
  ok(result.ok === true, "refresh succeeds");
  ok(controller.state.skills[0].updatedAt > 1, "updatedAt bumped after refresh");
}

console.log("== remove: removes from state.skills, banner clarifies the source folder is untouched ==");
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
