#!/usr/bin/env node
//
// Dispatch-authorization tests (tasks.md group 7, task 7.2's application
// half): assertSlashDispatchAllowed() and the resume-snapshot check.
//
// The core security property under test: SDK-discovered metadata is not
// itself an authorization list. assertSlashDispatchAllowed() must reject an
// unknown, disabled, or non-user-invocable command using ONLY the caller's
// own bound catalogSnapshot array - never re-deriving trust from anything
// the SDK might discover on disk.
//
// Run: node host/test/skills-dispatch.test.mjs

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const INDEX_URL = new URL("../agent/skills/index.js", import.meta.url).href;

// design.md decision 9: buildSessionSkills()'s allowedSkillNames/skillOverrides
// keys are now plugin-qualified. Imported per-test alongside the other named
// exports (this file uses a dynamic import(INDEX_URL) throughout), so this
// helper just needs the constant's value, fetched once here.
const { SESSION_SKILLS_PLUGIN_NAME } = await import(INDEX_URL);
const Q = (name) => `${SESSION_SKILLS_PLUGIN_NAME}:${name}`;

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  PASS  ${name}`);
  } catch (err) {
    results.push({ name, ok: false, err: err.stack || err.message });
    console.log(`  FAIL  ${name} — ${err.message}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function freshHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocic-skills-dispatch-"));
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

function makeSkillDir(root, frontmatter, extra = {}) {
  fs.mkdirSync(root, { recursive: true });
  writeFixture(root, { "SKILL.md": `${frontmatter}\n# Body\n`, ...extra });
  return root;
}

async function assertThrowsCode(fn, ErrorClass, expectedCode) {
  try {
    fn();
  } catch (err) {
    if (!(err instanceof ErrorClass)) {
      throw new Error(`expected ${ErrorClass.name}, got ${err.constructor.name}: ${err.message}`);
    }
    if (expectedCode && err.code !== expectedCode) {
      throw new Error(`expected code ${expectedCode}, got ${err.code}: ${err.message}`);
    }
    return;
  }
  throw new Error(`expected ${ErrorClass.name}${expectedCode ? ` (${expectedCode})` : ""} to be thrown`);
}

console.log("\nSkills dispatch authorization (task 7.2)\n");

const sampleSnapshot = [
  { name: "enabled-skill", enabled: true, userInvocable: true, unsupportedCapabilities: [] },
  { name: "disabled-skill", enabled: false, userInvocable: true, unsupportedCapabilities: [] },
  { name: "hidden-skill", enabled: true, userInvocable: false, unsupportedCapabilities: [] },
  { name: "risky-skill", enabled: true, userInvocable: true, unsupportedCapabilities: ["Bash"] }
];

await check("rejects an unknown command not present in the bound snapshot", async () => {
  freshHome();
  const { assertSlashDispatchAllowed, SkillDispatchError } = await import(INDEX_URL);
  await assertThrowsCode(() => assertSlashDispatchAllowed("/does-not-exist", sampleSnapshot), SkillDispatchError, "UNKNOWN_COMMAND");
});

await check("rejects a disabled command, even though its metadata is otherwise valid", async () => {
  freshHome();
  const { assertSlashDispatchAllowed, SkillDispatchError } = await import(INDEX_URL);
  await assertThrowsCode(() => assertSlashDispatchAllowed("/disabled-skill", sampleSnapshot), SkillDispatchError, "DISABLED");
});

await check("rejects an enabled but non-user-invocable command on explicit slash dispatch", async () => {
  freshHome();
  const { assertSlashDispatchAllowed, SkillDispatchError } = await import(INDEX_URL);
  await assertThrowsCode(
    () => assertSlashDispatchAllowed("/hidden-skill", sampleSnapshot),
    SkillDispatchError,
    "NOT_USER_INVOCABLE"
  );
});

await check("rejects a command flagged with an unsupported capability", async () => {
  freshHome();
  const { assertSlashDispatchAllowed, SkillDispatchError } = await import(INDEX_URL);
  await assertThrowsCode(
    () => assertSlashDispatchAllowed("/risky-skill", sampleSnapshot),
    SkillDispatchError,
    "UNSUPPORTED_CAPABILITY"
  );
});

await check("allows an enabled, user-invocable command and normalizes leading slash + arguments", async () => {
  freshHome();
  const { assertSlashDispatchAllowed } = await import(INDEX_URL);
  const entry = assertSlashDispatchAllowed("/enabled-skill do the task please", sampleSnapshot);
  assert(entry.name === "enabled-skill", "did not resolve to the right entry");

  const entry2 = assertSlashDispatchAllowed("enabled-skill", sampleSnapshot); // no leading slash
  assert(entry2.name === "enabled-skill", "must tolerate a missing leading slash");
});

await check("empty or missing command name is rejected, not silently allowed", async () => {
  freshHome();
  const { assertSlashDispatchAllowed, SkillDispatchError } = await import(INDEX_URL);
  await assertThrowsCode(() => assertSlashDispatchAllowed("", sampleSnapshot), SkillDispatchError, "UNKNOWN_COMMAND");
  await assertThrowsCode(() => assertSlashDispatchAllowed("/", sampleSnapshot), SkillDispatchError, "UNKNOWN_COMMAND");
});

await check("a hidden automatic-only skill materializes for the model but is rejected on explicit dispatch", async () => {
  // userInvocable/modelInvocable are product-owned catalog flags, not
  // SKILL.md frontmatter (reconciled against the pinned SDK - see
  // reports/07-skills-evidence.md: @anthropic-ai/claude-agent-sdk@0.3.263
  // defines no "user-invocable"/"disable-model-invocation" frontmatter
  // field). They are set here via setInvocationFlags(), the same way a
  // future Settings > Skills UI would.
  freshHome();
  const src = fs.mkdtempSync(path.join(os.tmpdir(), "ocic-skills-hidden-src-"));
  makeSkillDir(src, "---\nname: auto-only-skill\ndescription: Automatic use only, not shown in a picker.\n---\n");

  const {
    importSkill,
    enableSkill,
    setInvocationFlags,
    buildSessionSkills,
    assertSlashDispatchAllowed,
    SkillDispatchError
  } = await import(INDEX_URL);
  const record = await importSkill(src);
  assert(record.userInvocable === true, "a fresh import must default to user-invocable");
  assert(record.modelInvocable === true, "a fresh import must default to model-invocable");

  const updated = setInvocationFlags("auto-only-skill", { userInvocable: false, modelInvocable: true });
  assert(updated.userInvocable === false, "setInvocationFlags must persist userInvocable: false");
  assert(updated.modelInvocable === true, "setInvocationFlags must leave modelInvocable untouched when not passed");
  enableSkill("auto-only-skill");

  const run = fs.mkdtempSync(path.join(os.tmpdir(), "ocic-skills-hidden-run-"));
  const built = await buildSessionSkills(run);
  assert(
    built.allowedSkillNames.includes(Q("auto-only-skill")),
    "an enabled hidden skill must still be materialized for automatic invocation, plugin-qualified"
  );
  // No SDK skillOverrides value expresses "hidden from the user, kept for
  // the model" (see capabilities.js's toSkillOverrideValue doc) - "on" is
  // the documented, deliberate fallback. The real enforcement for the
  // user-facing side is assertSlashDispatchAllowed() below, not this value.
  assert(
    built.skillOverrides[Q("auto-only-skill")] === "on",
    `expected the documented fallback "on", got ${built.skillOverrides[Q("auto-only-skill")]}`
  );

  // Design.md: "a non-user-invocable skill must be rejected on explicit
  // slash dispatch" - even though the SDK could discover it on disk.
  await assertThrowsCode(
    () => assertSlashDispatchAllowed("/auto-only-skill", built.catalogSnapshot),
    SkillDispatchError,
    "NOT_USER_INVOCABLE"
  );
});

await check("toSkillOverrideValue matches the pinned SDK's skillOverrides values exactly where one exists", async () => {
  freshHome();
  const { toSkillOverrideValue } = await import(INDEX_URL);
  assert(toSkillOverrideValue(true, true) === "on", "userInvocable+modelInvocable must map to \"on\"");
  assert(toSkillOverrideValue(false, false) === "off", "neither invocable must map to \"off\"");
  assert(
    toSkillOverrideValue(true, false) === "user-invocable-only",
    "explicit-only (user yes, model no) must map to \"user-invocable-only\" (sdk.d.ts:5979: \"hides it from the model but keeps /name\")"
  );
  assert(
    toSkillOverrideValue(false, true) === "on",
    "hidden-automatic (user no, model yes) has no SDK equivalent - documented fallback is \"on\""
  );
});

await check("buildSessionSkills emits the correct skillOverrides for an explicit-only (model-hidden) skill", async () => {
  freshHome();
  const src = fs.mkdtempSync(path.join(os.tmpdir(), "ocic-skills-explicit-src-"));
  makeSkillDir(src, "---\nname: explicit-only-skill\ndescription: User must type it; the model must never auto-run it.\n---\n");

  const { importSkill, enableSkill, setInvocationFlags, buildSessionSkills, assertSlashDispatchAllowed } = await import(
    INDEX_URL
  );
  await importSkill(src);
  setInvocationFlags("explicit-only-skill", { userInvocable: true, modelInvocable: false });
  enableSkill("explicit-only-skill");

  const run = fs.mkdtempSync(path.join(os.tmpdir(), "ocic-skills-explicit-run-"));
  const built = await buildSessionSkills(run);
  assert(built.skillOverrides[Q("explicit-only-skill")] === "user-invocable-only", "expected the exact SDK-matching value");

  const entry = assertSlashDispatchAllowed("/explicit-only-skill", built.catalogSnapshot); // must not throw
  assert(entry.name === "explicit-only-skill", "explicit user dispatch must still be allowed");
});

await check("buildSessionSkills emits \"off\" for a skill enabled but invocable by neither surface", async () => {
  freshHome();
  const src = fs.mkdtempSync(path.join(os.tmpdir(), "ocic-skills-off-src-"));
  makeSkillDir(src, "---\nname: dormant-skill\ndescription: Enabled but neither user nor model may invoke it yet.\n---\n");

  const { importSkill, enableSkill, setInvocationFlags, buildSessionSkills } = await import(INDEX_URL);
  await importSkill(src);
  setInvocationFlags("dormant-skill", { userInvocable: false, modelInvocable: false });
  enableSkill("dormant-skill");

  const run = fs.mkdtempSync(path.join(os.tmpdir(), "ocic-skills-off-run-"));
  const built = await buildSessionSkills(run);
  assert(built.skillOverrides[Q("dormant-skill")] === "off", "expected the exact SDK-matching value");
});

await check("assertResumeSnapshotAvailable passes for an unchanged bound snapshot", async () => {
  freshHome();
  const src = fs.mkdtempSync(path.join(os.tmpdir(), "ocic-skills-resume-src-"));
  makeSkillDir(src, "---\nname: resume-skill\ndescription: Resume check.\n---\n");

  const { importSkill, enableSkill, buildSessionSkills, assertResumeSnapshotAvailable } = await import(INDEX_URL);
  await importSkill(src);
  enableSkill("resume-skill");
  const run = fs.mkdtempSync(path.join(os.tmpdir(), "ocic-skills-resume-run-"));
  const built = await buildSessionSkills(run);

  await assertResumeSnapshotAvailable(built.catalogSnapshot); // must not throw
});

await check("assertResumeSnapshotAvailable reports a disabled skill and requires a new conversation", async () => {
  freshHome();
  const src = fs.mkdtempSync(path.join(os.tmpdir(), "ocic-skills-resume-src-"));
  makeSkillDir(src, "---\nname: resume-skill\ndescription: Resume check.\n---\n");

  const {
    importSkill,
    enableSkill,
    disableSkill,
    buildSessionSkills,
    assertResumeSnapshotAvailable,
    SkillSnapshotMismatchError
  } = await import(INDEX_URL);
  await importSkill(src);
  enableSkill("resume-skill");
  const run = fs.mkdtempSync(path.join(os.tmpdir(), "ocic-skills-resume-run-"));
  const built = await buildSessionSkills(run);

  disableSkill("resume-skill");

  let mismatch;
  try {
    await assertResumeSnapshotAvailable(built.catalogSnapshot);
  } catch (err) {
    mismatch = err;
  }
  assert(mismatch instanceof SkillSnapshotMismatchError, "expected a SkillSnapshotMismatchError");
  assert(mismatch.details.mismatches[0].reason === "disabled", `unexpected reason: ${JSON.stringify(mismatch.details)}`);
});

await check("assertResumeSnapshotAvailable reports a changed (refreshed) skill", async () => {
  freshHome();
  const src = fs.mkdtempSync(path.join(os.tmpdir(), "ocic-skills-resume-src-"));
  makeSkillDir(src, "---\nname: resume-skill\ndescription: v1.\n---\n", { "resource.txt": "v1" });

  const { importSkill, enableSkill, refreshSkill, buildSessionSkills, assertResumeSnapshotAvailable, SkillSnapshotMismatchError } =
    await import(INDEX_URL);
  await importSkill(src);
  enableSkill("resume-skill");
  const run = fs.mkdtempSync(path.join(os.tmpdir(), "ocic-skills-resume-run-"));
  const built = await buildSessionSkills(run);

  writeFixture(src, { "resource.txt": "v2" });
  await refreshSkill("resume-skill");

  let mismatch;
  try {
    await assertResumeSnapshotAvailable(built.catalogSnapshot);
  } catch (err) {
    mismatch = err;
  }
  assert(mismatch instanceof SkillSnapshotMismatchError, "expected a SkillSnapshotMismatchError");
  assert(mismatch.details.mismatches[0].reason === "changed", `unexpected reason: ${JSON.stringify(mismatch.details)}`);
});

await check("assertResumeSnapshotAvailable reports a removed skill", async () => {
  freshHome();
  const src = fs.mkdtempSync(path.join(os.tmpdir(), "ocic-skills-resume-src-"));
  makeSkillDir(src, "---\nname: resume-skill\ndescription: Resume check.\n---\n");

  const { importSkill, enableSkill, removeSkill, buildSessionSkills, assertResumeSnapshotAvailable, SkillSnapshotMismatchError } =
    await import(INDEX_URL);
  await importSkill(src);
  enableSkill("resume-skill");
  const run = fs.mkdtempSync(path.join(os.tmpdir(), "ocic-skills-resume-run-"));
  const built = await buildSessionSkills(run);

  removeSkill("resume-skill");

  let mismatch;
  try {
    await assertResumeSnapshotAvailable(built.catalogSnapshot);
  } catch (err) {
    mismatch = err;
  }
  assert(mismatch instanceof SkillSnapshotMismatchError, "expected a SkillSnapshotMismatchError");
  assert(mismatch.details.mismatches[0].reason === "removed", `unexpected reason: ${JSON.stringify(mismatch.details)}`);
});

const failed = results.filter((r) => !r.ok);
console.log(
  `\n${results.length - failed.length}/${results.length} passed` +
    (failed.length ? `\n\nFailures:\n${failed.map((f) => `  - ${f.name}: ${f.err}`).join("\n")}` : "") +
    "\n"
);
process.exit(failed.length ? 1 : 0);
