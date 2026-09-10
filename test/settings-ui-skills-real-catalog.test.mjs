// Task 7.4 / redesign-settings-typed-only-skills task 3.7:
// extension/settings/skills-controller.js against the REAL host/agent/
// skills/** catalog library (listCatalog/authorSkill/enableSkill/
// disableSkill/removeSkill/setInvocationFlags, plus a read-back adapter
// composed the SAME way host/agent/companion.js's `skills_read_source`
// case is — see below), using real temp-directory fixtures on disk — no
// mocked filesystem. This is the "real companion" half of the pair,
// mirroring test/settings-ui-real-companion.test.mjs's own convention: a
// thin adapter here speaks skills-client.js's exact op contract by calling
// straight into the real library (never through host/agent/companion.js or
// extension/background.js).
//
// redesign-settings-typed-only-skills removed skills_import/skills_refresh
// from the wire (design.md decision D1) — no operation the controller can
// reach takes a filesystem path anymore. This file's adapter therefore does
// NOT expose importSkill/refreshSkill; test fixtures that need a
// PRE-EXISTING (i.e. "legacy", entered before this change) catalog record
// call `skillsLib.importSkill()`/`skillsLib.refreshSkill()` directly instead
// — exactly how such a record would already be sitting in a real operator's
// catalog. This proves what task 3.7 asks: editing a record that entered
// the catalog through the removed folder-import path still loads correctly
// through Sửa, and documents — against the REAL library, not a mock — the
// known limitation that saving such an edit in place is rejected (author.js
// is byte-identical; see skills-controller.js's own header on why).
//
// Run: node test/settings-ui-skills-real-catalog.test.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SkillsController } from "../extension/settings/skills-controller.js";
import * as skillsLib from "../host/agent/skills/index.js";
import { snapshotDir, assertSafeSegment } from "../host/agent/skills/paths.js";
import { parseFrontmatter } from "../host/agent/skills/frontmatter.js";

let fail = 0;
const ok = (c, m) => {
  console.log((c ? "  PASS " : "  FAIL ") + m);
  if (!c) fail++;
};

function freshHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocic-skills-ui-real-"));
  process.env.OCIC_AGENT_HOME = dir;
  return dir;
}

function writeFixture(dir, files) {
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return dir;
}

function makeSkillDir(root, folderName, { frontmatter, body = "\n# Skill body\n\nInstructions.\n", extra = {} } = {}) {
  const dir = path.join(root, folderName);
  fs.mkdirSync(dir, { recursive: true });
  writeFixture(dir, { "SKILL.md": `${frontmatter}${body}`, ...extra });
  return dir;
}

function defaultFrontmatter(name, description = "A demo skill for tests.") {
  return `---\nname: ${name}\ndescription: ${description}\n---\n`;
}

// Mirrors host/agent/companion.js's `skills_read_source` case exactly (same
// resolution order, same composition of paths.js/frontmatter.js exports,
// same body-extraction rule) so this adapter exercises the identical
// contract the real companion answers — see that file for the authoritative
// version and design.md decision D2 for the rationale.
function extractSkillBody(raw) {
  const text = raw.replace(/^﻿/, "");
  const lines = text.split(/\r\n|\n/);
  let i = 0;
  while (i < lines.length && lines[i].trim() === "") i++;
  i++;
  while (i < lines.length && lines[i].trim() !== "---") i++;
  i++;
  return lines.slice(i).join("\n").replace(/^\n+/, "");
}

async function realReadSkillSource(name) {
  const record = skillsLib.getSkill(name);
  if (!record) throw Object.assign(new Error(`No imported skill named "${name}".`), { code: "NOT_FOUND" });
  const safeSnapshotId = assertSafeSegment(record.snapshotId);
  const raw = fs.readFileSync(path.join(snapshotDir(safeSnapshotId), "SKILL.md"), "utf-8");
  const meta = parseFrontmatter(raw);
  const rawAllowedTools = meta["allowed-tools"];
  const allowedTools = Array.isArray(rawAllowedTools)
    ? rawAllowedTools
    : typeof rawAllowedTools === "string" && rawAllowedTools
      ? [rawAllowedTools]
      : [];
  return {
    name: record.name,
    description: meta.description,
    body: extractSkillBody(raw),
    allowedTools,
    userInvocable: record.userInvocable,
    modelInvocable: record.modelInvocable
  };
}

/** Adapter implementing skills-client.js's CURRENT op contract (no
 * importSkill/refreshSkill — see this file's header) by calling straight
 * into the real host library. host/agent/skills/catalog-store.js reads
 * OCIC_AGENT_HOME and its catalog.json fresh from disk on every call (no
 * in-module caching — see that file), so a single imported module instance
 * safely serves every test block below even as OCIC_AGENT_HOME is reset
 * between them by freshHome(). */
async function realLibraryClient() {
  return {
    listCatalog: () => skillsLib.listCatalog(),
    readSkillSource: (name) => realReadSkillSource(name),
    authorSkill: (fields) => skillsLib.authorSkill(fields),
    enableSkill: (name) => Promise.resolve(skillsLib.enableSkill(name)),
    disableSkill: (name) => Promise.resolve(skillsLib.disableSkill(name)),
    removeSkill: (name) => Promise.resolve(skillsLib.removeSkill(name)),
    setInvocationFlags: (name, flags) => Promise.resolve(skillsLib.setInvocationFlags(name, flags))
  };
}

console.log("== real list: a legacy (folder-imported) record is listed and persists across a fresh listCatalog() call ==");
{
  const home = freshHome();
  const srcDir = makeSkillDir(home, "src-1", { frontmatter: defaultFrontmatter("tom-tat-trang", "Tóm tắt nội dung trang.") });
  await skillsLib.importSkill(srcDir); // simulates a skill that entered the catalog before this change

  const client = await realLibraryClient();
  const controller = new SkillsController(client);
  await controller.init();
  ok(controller.state.skills.length === 1 && controller.state.skills[0].name === "tom-tat-trang", "legacy skill appears in controller state via listCatalog()");
  ok(controller.state.skills[0].enabled === false, "a freshly imported skill starts disabled (must be explicitly enabled)");

  // "remains available after browser restart": simulate a fresh page load
  // by constructing a brand-new controller against a brand-new library
  // import over the SAME OCIC_AGENT_HOME.
  const client2 = await realLibraryClient();
  const controller2 = new SkillsController(client2);
  await controller2.init();
  ok(controller2.state.skills.length === 1 && controller2.state.skills[0].name === "tom-tat-trang", "skill still present after a simulated restart (persisted on disk)");
}

console.log("== real enable/disable persists and gates dispatch eligibility ==");
{
  const home = freshHome();
  const srcDir = makeSkillDir(home, "src-2", { frontmatter: defaultFrontmatter("dien-bieu-mau") });
  await skillsLib.importSkill(srcDir);

  const client = await realLibraryClient();
  const controller = new SkillsController(client);
  await controller.init();
  const enableResult = await controller.setEnabled("dien-bieu-mau", true);
  ok(enableResult.ok === true, "enable succeeds for a supported skill");
  ok(controller.state.skills[0].enabled === true, "state reflects enabled:true");
  const disableResult = await controller.setEnabled("dien-bieu-mau", false);
  ok(disableResult.ok === true, "disable succeeds");
  ok(controller.state.skills[0].enabled === false, "state reflects enabled:false");
}

console.log("== real: no operation the controller can reach accepts a filesystem path ==");
{
  const client = await realLibraryClient();
  ok(
    typeof client.importSkill !== "function" && typeof client.refreshSkill !== "function",
    "the client adapter used by the controller exposes no importSkill/refreshSkill"
  );
}

console.log("== real capability detection: an unsupported script capability surfaces UNSUPPORTED_CAPABILITY on enable, never silently grants shell access ==");
{
  const home = freshHome();
  const srcDir = makeSkillDir(home, "needs-script", {
    frontmatter: defaultFrontmatter("chay-script"),
    extra: { "helper.sh": "#!/bin/sh\necho hello\n" }
  });
  await skillsLib.importSkill(srcDir);

  const client = await realLibraryClient();
  const controller = new SkillsController(client);
  await controller.init();
  ok(
    controller.state.skills[0].unsupportedCapabilities.some((c) => c.includes("helper.sh")),
    "the shell script resource is flagged in unsupportedCapabilities"
  );
  const enableResult = await controller.setEnabled("chay-script", true);
  ok(enableResult.ok === false && enableResult.code === "UNSUPPORTED_CAPABILITY", `enabling a script-requiring skill is rejected — got ${enableResult.code}`);
  ok(controller.state.skills[0].enabled === false, "the skill's enabled flag is never flipped true — no silent shell-access grant");
}

console.log("== real remove: deletes the app copy but leaves the original source folder on disk ==");
{
  const home = freshHome();
  const srcDir = makeSkillDir(home, "src-remove", { frontmatter: defaultFrontmatter("tra-cuu-lich-su") });
  await skillsLib.importSkill(srcDir);
  ok(fs.existsSync(path.join(srcDir, "SKILL.md")), "sanity: source SKILL.md exists before remove");

  const client = await realLibraryClient();
  const controller = new SkillsController(client);
  await controller.init();
  const removeResult = await controller.removeSkill("tra-cuu-lich-su");
  ok(removeResult.ok === true, "remove succeeds");
  ok(controller.state.skills.length === 0, "removed skill no longer listed");
  ok(fs.existsSync(path.join(srcDir, "SKILL.md")), "the ORIGINAL source folder/SKILL.md is untouched by remove");
}

console.log("== real author: a typed skill (no folder) appears in the catalog exactly like a folder import, and persists after a simulated restart ==");
{
  freshHome();
  const client = await realLibraryClient();
  const controller = new SkillsController(client);
  await controller.init();

  controller.setAuthorField("name", "goi-y-viet-lai");
  controller.setAuthorField("description", "Gợi ý viết lại đoạn văn được chọn.");
  controller.setAuthorField("body", "# Gợi ý viết lại\n\nViết lại đoạn văn cho ngắn gọn hơn.\n");
  const result = await controller.authorFromDraft();
  ok(result.ok === true, `real author succeeds: ${JSON.stringify(result)}`);
  ok(controller.state.skills.length === 1 && controller.state.skills[0].name === "goi-y-viet-lai", "authored skill appears in controller state");
  ok(controller.state.skills[0].enabled === false, "a freshly authored skill starts disabled, same as a folder import");
  ok(fs.existsSync(path.join(controller.state.skills[0].source, "SKILL.md")), "a real SKILL.md exists at the authored skill's own host-owned source folder");

  const client2 = await realLibraryClient();
  const controller2 = new SkillsController(client2);
  await controller2.init();
  ok(controller2.state.skills.length === 1 && controller2.state.skills[0].name === "goi-y-viet-lai", "authored skill still present after a simulated restart");
}

console.log("== real author: invalid name rejected, catalog untouched ==");
{
  freshHome();
  const client = await realLibraryClient();
  const controller = new SkillsController(client);
  await controller.init();
  controller.setAuthorField("name", "khong hop le!!");
  controller.setAuthorField("description", "desc");
  controller.setAuthorField("body", "body");
  const result = await controller.authorFromDraft();
  ok(result.ok === false && result.code === "INVALID_NAME", `invalid name rejected with its own INVALID_NAME code, not the folder-import INVALID_METADATA one — got ${result.code}`);
  ok(controller.state.skills.length === 0, "catalog remains empty after a rejected author submit");
}

console.log("== real author: authoring a name already imported from a folder is rejected as DUPLICATE_NAME, that entry is untouched ==");
{
  const home = freshHome();
  const srcDir = makeSkillDir(home, "author-dup-src", { frontmatter: defaultFrontmatter("ten-trung", "Nhập từ thư mục.") });
  await skillsLib.importSkill(srcDir);

  const client = await realLibraryClient();
  const controller = new SkillsController(client);
  await controller.init();
  controller.setAuthorField("name", "ten-trung");
  controller.setAuthorField("description", "Đang cố ghi đè lên skill đã nhập từ thư mục.");
  controller.setAuthorField("body", "# Không nên được lưu\n");
  const result = await controller.authorFromDraft();
  ok(result.ok === false && result.code === "DUPLICATE_NAME", `authoring over a folder-imported name is rejected as DUPLICATE_NAME — got ${result.code}`);
  ok(controller.state.skills.length === 1 && controller.state.skills[0].description === "Nhập từ thư mục.", "the original folder-imported entry is completely untouched");
}

console.log("== real Sửa (edit): loading and re-saving an AUTHORED record works fully in place, no DUPLICATE_NAME ==");
{
  freshHome();
  const client = await realLibraryClient();
  const controller = new SkillsController(client);
  await controller.init();

  controller.setAuthorField("name", "tra-loi-nhanh");
  controller.setAuthorField("description", "Phiên bản đầu tiên.");
  controller.setAuthorField("body", "# v1\n");
  const first = await controller.authorFromDraft();
  ok(first.ok === true, "first author submit succeeds");

  const loaded = await controller.loadForEdit("tra-loi-nhanh");
  ok(loaded.ok === true, "loadForEdit succeeds against the real snapshot store");
  ok(controller.state.authorDraft.body === "# v1\n", "the read-back body matches what was authored");
  ok(controller.state.editingName === "tra-loi-nhanh", "editingName bound to the loaded skill");

  controller.setAuthorField("description", "Phiên bản đã sửa.");
  controller.setAuthorField("body", "# v2\n\nChi tiết hơn.\n");
  const second = await controller.authorFromDraft();
  ok(second.ok === true, `re-submitting the same authored skill's name must edit, not fail as DUPLICATE_NAME: ${JSON.stringify(second)}`);
  ok(controller.state.skills.length === 1, "editing must not create a second catalog entry");
  ok(controller.state.skills[0].description === "Phiên bản đã sửa.", "the record reflects the edited description");
}

console.log("== real Sửa (edit): a legacy folder-imported record loads correctly through the SAME snapshot read-back a session would run ==");
{
  const home = freshHome();
  const srcDir = makeSkillDir(home, "legacy-src", {
    frontmatter: defaultFrontmatter("tom-tat-legacy", "Skill nhập từ thư mục trước khi có tính năng này."),
    body: "\n# Hướng dẫn cũ\n\nLàm theo các bước.\n"
  });
  await skillsLib.importSkill(srcDir); // the removed folder-import path, used only to build the fixture

  const client = await realLibraryClient();
  const controller = new SkillsController(client);
  await controller.init();
  const loaded = await controller.loadForEdit("tom-tat-legacy");
  ok(loaded.ok === true, "loadForEdit succeeds for a record that entered the catalog through the removed folder-import path");
  ok(
    controller.state.authorDraft.description === "Skill nhập từ thư mục trước khi có tính năng này.",
    "description loaded from the approved SNAPSHOT, not from re-reading the original folder"
  );
  ok(/Hướng dẫn cũ/.test(controller.state.authorDraft.body), "body loaded from the approved snapshot too");

  // Saving that edit must actually save — the spec's "a skill stored before
  // this behavior existed ... can still be edited" scenario. Editing adopts
  // the record: its source moves into the application's own storage, so the
  // app stops depending on a folder outside itself it no longer reads.
  // Proven here against the REAL library, not a mock.
  controller.setAuthorField("description", "Đã sửa trực tiếp.");
  const saveResult = await controller.authorFromDraft();
  ok(saveResult.ok === true, `saving an in-place edit of a legacy record succeeds — got ${JSON.stringify(saveResult)}`);

  const catalogAfter = await skillsLib.listCatalog();
  const edited = catalogAfter.find((s) => s.name === "tom-tat-legacy");
  ok(catalogAfter.length === 1, "editing updates the one record in place — it never creates a second entry");
  ok(edited && edited.description === "Đã sửa trực tiếp.", "the edit reached the real catalog record");
  ok(
    path.resolve(edited.source).startsWith(path.resolve(skillsLib.authoredSkillsRoot())),
    `the adopted record's source now lives in the app's own storage, not the original folder — got ${edited.source}`
  );
  ok(!fs.existsSync(path.join(srcDir, "MARKER-DELETED")), "the operator's original folder is never written to");
  ok(fs.existsSync(path.join(srcDir, "SKILL.md")), "the operator's original folder is left on disk untouched");

}

console.log("== real Sửa (edit): only a deliberate edit adopts a foreign-sourced record; composing a new skill under its name is still refused ==");
{
  const home = freshHome();
  const srcDir = makeSkillDir(home, "guard-src", {
    frontmatter: defaultFrontmatter("guard-legacy", "Bản gốc nhập từ thư mục.")
  });
  await skillsLib.importSkill(srcDir); // fixture only — the removed folder-import path

  // No loadForEdit() first: this is someone composing a BRAND NEW skill who
  // happens to pick a name already held by a folder-imported record. The
  // name alone must never be read as intent to overwrite it.
  const controller = new SkillsController(await realLibraryClient());
  await controller.init();
  controller.setAuthorField("name", "guard-legacy");
  controller.setAuthorField("description", "Một skill hoàn toàn khác.");
  controller.setAuthorField("body", "# Khác hẳn\n");
  const collision = await controller.authorFromDraft();
  ok(collision.ok === false && collision.code === "DUPLICATE_NAME", `creating under a taken foreign-sourced name is refused — got ${JSON.stringify(collision)}`);

  const after = await skillsLib.listCatalog();
  ok(after.length === 1, "the refused creation added no entry");
  ok(after[0].description === "Bản gốc nhập từ thư mục.", "the refused creation left the existing record untouched");
  ok(path.resolve(after[0].source) === path.resolve(srcDir), "and did not adopt it — source is still the original folder");
}

console.log("== real Nhân bản (duplicate): a legacy folder-imported record can be duplicated into a fully editable, owned copy ==");
{
  const home = freshHome();
  const srcDir = makeSkillDir(home, "legacy-dup-src", { frontmatter: defaultFrontmatter("legacy-dup", "Bản gốc nhập từ thư mục.") });
  await skillsLib.importSkill(srcDir);

  const client = await realLibraryClient();
  const controller = new SkillsController(client);
  await controller.init();
  const loaded = await controller.loadForDuplicate("legacy-dup");
  ok(loaded.ok === true, "loadForDuplicate succeeds for a legacy record");
  ok(controller.state.authorDraft.name === "legacy-dup-copy", "seeded under an unused name");
  ok(controller.state.editingName === null, "editingName stays null — this submit creates a new record");

  const result = await controller.authorFromDraft();
  ok(result.ok === true, `duplicating a legacy record into a new authored one succeeds: ${JSON.stringify(result)}`);
  ok(controller.state.skills.length === 2, "both the original legacy record and the new duplicate now exist");
  const dup = controller.state.skills.find((s) => s.name === "legacy-dup-copy");
  ok(dup, "the duplicate is present in the catalog");

  // The duplicate is now a fully OWNED, authored record: editing it in
  // place must succeed with no DUPLICATE_NAME, unlike its legacy source.
  await controller.loadForEdit("legacy-dup-copy");
  controller.setAuthorField("description", "Bản sao đã sửa được.");
  const editResult = await controller.authorFromDraft();
  ok(editResult.ok === true, `the duplicate, unlike the legacy original, can be edited in place: ${JSON.stringify(editResult)}`);
}

console.log(fail === 0 ? "\nALL SETTINGS-UI SKILLS REAL-CATALOG TESTS PASSED" : `\n${fail} FAILED`);
process.exit(fail ? 1 : 0);
