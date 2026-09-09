// Task 7.4: extension/settings/skills-controller.js against the REAL
// host/agent/skills/** catalog library (importSkill/refreshSkill/
// listCatalog/enableSkill/disableSkill/removeSkill), using real temp-
// directory fixtures on disk — no mocked filesystem. This is the "real
// companion" half of the pair, mirroring test/settings-ui-real-companion.test.mjs's
// own convention for host/agent/settings/profile.js: a thin adapter here
// speaks skills-client.js's exact op contract by calling straight into the
// real library (never through host/agent/companion.js or
// extension/background.js — neither has the skills_* wiring yet; see
// extension/settings/skills-client.js's own header). This proves the
// controller's behavior end-to-end against real import validation
// (duplicate names, path traversal, symlink escape, invalid metadata,
// unsupported-capability content detection) and real persistence, closing
// the gap host/test/skills-catalog.test.mjs already covers at the library
// layer by proving THIS product's UI-facing controller composes with it
// correctly too.
//
// Run: node test/settings-ui-skills-real-catalog.test.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SkillsController } from "../extension/settings/skills-controller.js";
import * as skillsLib from "../host/agent/skills/index.js";

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

// Same NTFS-junction technique host/test/skills-catalog.test.mjs uses to
// avoid needing symlink-creation privilege elevation on Windows — see that
// file's own comment for why a junction exercises the identical code path.
function createEscapingDirLink(linkPath, targetDir) {
  fs.symlinkSync(path.resolve(targetDir), linkPath, "junction");
}

/** Adapter implementing skills-client.js's op contract by calling straight
 * into the real host library. host/agent/skills/catalog-store.js reads
 * OCIC_AGENT_HOME and its catalog.json fresh from disk on every call (no
 * in-module caching — see that file), so a single imported module instance
 * safely serves every test block below even as OCIC_AGENT_HOME is reset
 * between them by freshHome(). */
async function realLibraryClient() {
  return {
    listCatalog: () => skillsLib.listCatalog(),
    importSkill: (sourceDir) => skillsLib.importSkill(sourceDir),
    refreshSkill: (name) => skillsLib.refreshSkill(name),
    authorSkill: (fields) => skillsLib.authorSkill(fields),
    enableSkill: (name) => Promise.resolve(skillsLib.enableSkill(name)),
    disableSkill: (name) => Promise.resolve(skillsLib.disableSkill(name)),
    removeSkill: (name) => Promise.resolve(skillsLib.removeSkill(name)),
    setInvocationFlags: (name, flags) => Promise.resolve(skillsLib.setInvocationFlags(name, flags))
  };
}

console.log("== real import: valid skill appears in the catalog and persists across a fresh listCatalog() call ==");
{
  const home = freshHome();
  const client = await realLibraryClient();
  const controller = new SkillsController(client);
  await controller.init();
  const srcDir = makeSkillDir(home, "src-1", { frontmatter: defaultFrontmatter("tom-tat-trang", "Tóm tắt nội dung trang.") });
  controller.setImportDraft(srcDir);
  const result = await controller.importFromDraft();
  ok(result.ok === true, "real import succeeds for a valid SKILL.md package");
  ok(controller.state.skills.length === 1 && controller.state.skills[0].name === "tom-tat-trang", "imported skill appears in controller state");
  ok(controller.state.skills[0].source === fs.realpathSync(srcDir), "recorded source is the real, canonical source folder");
  ok(controller.state.skills[0].enabled === false, "a freshly imported skill starts disabled (must be explicitly enabled)");

  // "remains available after browser restart" (spec "Import and reuse"):
  // simulate a fresh page load by constructing a brand-new controller
  // against a brand-new library import over the SAME OCIC_AGENT_HOME.
  const client2 = await realLibraryClient();
  const controller2 = new SkillsController(client2);
  await controller2.init();
  ok(controller2.state.skills.length === 1 && controller2.state.skills[0].name === "tom-tat-trang", "skill still present after a simulated restart (persisted on disk, one-time import)");
}

console.log("== real enable/disable persists and gates dispatch eligibility ==");
{
  const home = freshHome();
  const client = await realLibraryClient();
  const controller = new SkillsController(client);
  await controller.init();
  const srcDir = makeSkillDir(home, "src-2", { frontmatter: defaultFrontmatter("dien-bieu-mau") });
  controller.setImportDraft(srcDir);
  await controller.importFromDraft();
  const enableResult = await controller.setEnabled("dien-bieu-mau", true);
  ok(enableResult.ok === true, "enable succeeds for a supported skill");
  ok(controller.state.skills[0].enabled === true, "state reflects enabled:true");
  const disableResult = await controller.setEnabled("dien-bieu-mau", false);
  ok(disableResult.ok === true, "disable succeeds");
  ok(controller.state.skills[0].enabled === false, "state reflects enabled:false");
}

console.log("== real import: invalid metadata (missing SKILL.md) rejected with an actionable error, catalog unchanged ==");
{
  const home = freshHome();
  const client = await realLibraryClient();
  const controller = new SkillsController(client);
  await controller.init();
  const badDir = path.join(home, "empty-folder");
  fs.mkdirSync(badDir, { recursive: true });
  controller.setImportDraft(badDir);
  const result = await controller.importFromDraft();
  ok(result.ok === false && result.code === "INVALID_METADATA", `missing SKILL.md rejected as INVALID_METADATA — got ${result.code}`);
  ok(controller.state.skills.length === 0, "catalog remains empty after a rejected import");
  ok(/SKILL\.md|metadata/i.test(controller.state.banner.message), "banner explains what was invalid");
}

console.log("== real import: duplicate name rejected, existing catalog entry untouched ==");
{
  const home = freshHome();
  const client = await realLibraryClient();
  const controller = new SkillsController(client);
  await controller.init();
  const src1 = makeSkillDir(home, "dup-1", { frontmatter: defaultFrontmatter("so-sanh-gia", "First version.") });
  controller.setImportDraft(src1);
  await controller.importFromDraft();

  const src2 = makeSkillDir(home, "dup-2", { frontmatter: defaultFrontmatter("so-sanh-gia", "A different folder, same declared name.") });
  controller.setImportDraft(src2);
  const result = await controller.importFromDraft();
  ok(result.ok === false && result.code === "DUPLICATE_NAME", `duplicate name rejected as DUPLICATE_NAME — got ${result.code}`);
  ok(controller.state.skills.length === 1 && controller.state.skills[0].description === "First version.", "the ORIGINAL entry is unchanged by the rejected duplicate import");
}

console.log("== real import: path traversal via frontmatter name rejected ==");
{
  const home = freshHome();
  const client = await realLibraryClient();
  const controller = new SkillsController(client);
  await controller.init();
  const srcDir = makeSkillDir(home, "traversal-1", { frontmatter: defaultFrontmatter("../escape-attempt") });
  controller.setImportDraft(srcDir);
  const result = await controller.importFromDraft();
  ok(result.ok === false && result.code === "PATH_TRAVERSAL", `a ".." skill name is rejected as PATH_TRAVERSAL — got ${result.code}`);
  ok(controller.state.skills.length === 0, "catalog unchanged after a rejected traversal import");
}

console.log("== real import: symlink escaping the package root rejected ==");
{
  const home = freshHome();
  const client = await realLibraryClient();
  const controller = new SkillsController(client);
  await controller.init();
  const outsideDir = path.join(home, "outside-secret");
  fs.mkdirSync(outsideDir, { recursive: true });
  fs.writeFileSync(path.join(outsideDir, "secret.txt"), "should never be copied");
  const srcDir = makeSkillDir(home, "symlink-escape-1", { frontmatter: defaultFrontmatter("script-tu-dong") });
  createEscapingDirLink(path.join(srcDir, "escape-link"), outsideDir);
  controller.setImportDraft(srcDir);
  const result = await controller.importFromDraft();
  ok(result.ok === false && result.code === "SYMLINK_ESCAPE", `escaping link rejected as SYMLINK_ESCAPE — got ${result.code}`);
  ok(controller.state.skills.length === 0, "catalog unchanged after a rejected symlink-escape import");
}

console.log("== real import: unsupported script capability surfaces UNSUPPORTED_CAPABILITY on enable, never silently grants shell access ==");
{
  const home = freshHome();
  const client = await realLibraryClient();
  const controller = new SkillsController(client);
  await controller.init();
  const srcDir = makeSkillDir(home, "needs-script", {
    frontmatter: defaultFrontmatter("chay-script"),
    extra: { "helper.sh": "#!/bin/sh\necho hello\n" }
  });
  controller.setImportDraft(srcDir);
  const importResult = await controller.importFromDraft();
  ok(importResult.ok === true, "import itself succeeds (capability detection does not block import, only enable)");
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
  const client = await realLibraryClient();
  const controller = new SkillsController(client);
  await controller.init();
  const srcDir = makeSkillDir(home, "src-remove", { frontmatter: defaultFrontmatter("tra-cuu-lich-su") });
  controller.setImportDraft(srcDir);
  await controller.importFromDraft();
  ok(fs.existsSync(path.join(srcDir, "SKILL.md")), "sanity: source SKILL.md exists before remove");

  const removeResult = await controller.removeSkill("tra-cuu-lich-su");
  ok(removeResult.ok === true, "remove succeeds");
  ok(controller.state.skills.length === 0, "removed skill no longer listed");
  ok(fs.existsSync(path.join(srcDir, "SKILL.md")), "the ORIGINAL source folder/SKILL.md is untouched by remove");
}

console.log("== real refresh: content change from the source folder takes effect only after explicit refresh ==");
{
  const home = freshHome();
  const client = await realLibraryClient();
  const controller = new SkillsController(client);
  await controller.init();
  const srcDir = makeSkillDir(home, "src-refresh", { frontmatter: defaultFrontmatter("dien-bieu-mau", "Original description.") });
  controller.setImportDraft(srcDir);
  await controller.importFromDraft();
  ok(controller.state.skills[0].description === "Original description.", "sanity: original description recorded");

  fs.writeFileSync(path.join(srcDir, "SKILL.md"), defaultFrontmatter("dien-bieu-mau", "Updated description after edit."));
  await controller.refreshList();
  ok(controller.state.skills[0].description === "Original description.", "editing the source alone does NOT change the catalog before an explicit refresh");

  await controller.refreshSkill("dien-bieu-mau");
  ok(controller.state.skills[0].description === "Updated description after edit.", "explicit refresh picks up the source change");
}

console.log("== real author: a typed skill (no folder) appears in the catalog exactly like a folder import, and persists after a simulated restart ==");
{
  const home = freshHome();
  const client = await realLibraryClient();
  const controller = new SkillsController(client);
  await controller.init();
  void home;

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

console.log("== real author: re-submitting the form for the same authored skill edits it in place, no DUPLICATE_NAME ==");
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

  controller.setAuthorField("name", "tra-loi-nhanh");
  controller.setAuthorField("description", "Phiên bản đã sửa.");
  controller.setAuthorField("body", "# v2\n\nChi tiết hơn.\n");
  const second = await controller.authorFromDraft();
  ok(second.ok === true, `re-submitting the same authored skill's name must edit, not fail as DUPLICATE_NAME: ${JSON.stringify(second)}`);
  ok(controller.state.skills.length === 1, "editing must not create a second catalog entry");
  ok(controller.state.skills[0].description === "Phiên bản đã sửa.", "the record reflects the edited description");
}

console.log("== real author: authoring a name already imported from a folder is rejected as DUPLICATE_NAME, that entry is untouched ==");
{
  const home = freshHome();
  const client = await realLibraryClient();
  const controller = new SkillsController(client);
  await controller.init();
  const srcDir = makeSkillDir(home, "author-dup-src", { frontmatter: defaultFrontmatter("ten-trung", "Nhập từ thư mục.") });
  controller.setImportDraft(srcDir);
  await controller.importFromDraft();

  controller.setAuthorField("name", "ten-trung");
  controller.setAuthorField("description", "Đang cố ghi đè lên skill đã nhập từ thư mục.");
  controller.setAuthorField("body", "# Không nên được lưu\n");
  const result = await controller.authorFromDraft();
  ok(result.ok === false && result.code === "DUPLICATE_NAME", `authoring over a folder-imported name is rejected as DUPLICATE_NAME — got ${result.code}`);
  ok(controller.state.skills.length === 1 && controller.state.skills[0].description === "Nhập từ thư mục.", "the original folder-imported entry is completely untouched");
}

console.log(fail === 0 ? "\nALL SETTINGS-UI SKILLS REAL-CATALOG TESTS PASSED" : `\n${fail} FAILED`);
process.exit(fail ? 1 : 0);
