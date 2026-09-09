#!/usr/bin/env node
//
// Catalog tests for the application-owned skill import pipeline (tasks.md
// group 7, task 7.1) against real temp-directory fixtures on disk - no
// mocked filesystem, no live SDK/model call.
//
// Each check gets its own fresh OCIC_AGENT_HOME (a scratch catalog root),
// so state from one test can never leak into another - the modules under
// test read that env var live on every call, never cached at import time.
//
// Run: node host/test/skills-catalog.test.mjs

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const INDEX_URL = new URL("../agent/skills/index.js", import.meta.url).href;

// design.md decision 9: buildSessionSkills()'s allowedSkillNames are now
// plugin-qualified canonical names.
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocic-skills-catalog-"));
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

function makeSkillDir(root, folderName, { frontmatter, body = "\n# Skill body\n\nInstructions go here.\n", extra = {} } = {}) {
  const dir = path.join(root, folderName);
  fs.mkdirSync(dir, { recursive: true });
  const files = { "SKILL.md": `${frontmatter}${body}`, ...extra };
  return writeFixture(dir, files);
}

function defaultFrontmatter(name, description = "A demo skill for tests.") {
  return `---\nname: ${name}\ndescription: ${description}\n---\n`;
}

// Creates a directory link that resolves outside `root` without requiring
// elevation on Windows: an NTFS junction (fs.symlinkSync's "junction" type)
// needs only write access to the parent directory, unlike a true symlink,
// which needs SeCreateSymbolicLinkPrivilege or Developer Mode. Node reports
// junctions via Dirent.isSymbolicLink() === true and fs.realpathSync()
// resolves them exactly like a symlink, so this exercises the same code
// path a real symlink escape would.
function createEscapingDirLink(linkPath, targetDir) {
  fs.symlinkSync(path.resolve(targetDir), linkPath, "junction");
}

function runInChildProcess(agentHome, script) {
  const res = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    env: { ...process.env, OCIC_AGENT_HOME: agentHome },
    encoding: "utf-8"
  });
  if (res.status !== 0) {
    throw new Error(`child process failed (status ${res.status}): ${res.stderr}`);
  }
  return res.stdout;
}

console.log("\nSkills catalog (task 7.1)\n");

await check("valid import + enable + survives restart (real subprocess re-read)", async () => {
  const home = freshHome();
  const src = fs.mkdtempSync(path.join(os.tmpdir(), "ocic-skills-src-"));
  makeSkillDir(src, ".", { frontmatter: defaultFrontmatter("restart-skill", "Survives a restart.") });

  const { importSkill, enableSkill, listCatalog } = await import(INDEX_URL);
  const record = await importSkill(src);
  assert(record.name === "restart-skill", `unexpected name: ${record.name}`);
  assert(record.enabled === false, "a fresh import must not be enabled by default");
  assert(typeof record.hash === "string" && record.hash.startsWith("sha256:"), `bad hash: ${record.hash}`);

  enableSkill("restart-skill");
  const afterEnable = await listCatalog();
  assert(afterEnable.find((s) => s.name === "restart-skill").enabled === true, "enable did not persist in-process");

  // Real restart proof: a brand-new Node process, importing the module
  // fresh, pointed at the same on-disk catalog root, with nothing carried
  // over in memory.
  const stdout = runInChildProcess(
    home,
    `import { listCatalog } from ${JSON.stringify(INDEX_URL)};
     const catalog = await listCatalog();
     process.stdout.write(JSON.stringify(catalog));`
  );
  const reloaded = JSON.parse(stdout);
  const entry = reloaded.find((s) => s.name === "restart-skill");
  assert(entry, "skill missing after simulated restart");
  assert(entry.enabled === true, "enabled flag did not survive restart");
  assert(entry.hash === record.hash, "hash did not survive restart");

  // The immutable snapshot itself must also be there, with the exact
  // original content, independent of what the catalog JSON claims.
  const snapshotSkillMd = path.join(home, "skills", "snapshots", "restart-skill", "SKILL.md");
  assert(fs.existsSync(snapshotSkillMd), "snapshot SKILL.md missing on disk");
  assert(
    fs.readFileSync(snapshotSkillMd, "utf-8") === fs.readFileSync(path.join(src, "SKILL.md"), "utf-8"),
    "snapshot content does not match source"
  );
});

await check("malformed metadata rejected: missing SKILL.md", async () => {
  freshHome();
  const src = fs.mkdtempSync(path.join(os.tmpdir(), "ocic-skills-src-"));
  fs.writeFileSync(path.join(src, "README.md"), "not a skill manifest");

  const { importSkill, listCatalog } = await import(`${INDEX_URL}?t=${Date.now()}-a`);
  await assertRejects(() => importSkill(src), "INVALID_METADATA");
  assert((await listCatalog()).length === 0, "catalog must remain unchanged after a rejected import");
});

await check("malformed metadata rejected: no frontmatter delimiters", async () => {
  freshHome();
  const src = fs.mkdtempSync(path.join(os.tmpdir(), "ocic-skills-src-"));
  writeFixture(src, { "SKILL.md": "name: broken\ndescription: no delimiters\n" });

  const { importSkill } = await import(`${INDEX_URL}?t=${Date.now()}-b`);
  await assertRejects(() => importSkill(src), "INVALID_METADATA");
});

await check("malformed metadata rejected: missing name", async () => {
  freshHome();
  const src = fs.mkdtempSync(path.join(os.tmpdir(), "ocic-skills-src-"));
  writeFixture(src, { "SKILL.md": "---\ndescription: has no name field\n---\nbody\n" });

  const { importSkill } = await import(`${INDEX_URL}?t=${Date.now()}-c`);
  await assertRejects(() => importSkill(src), "INVALID_METADATA");
});

await check("malformed metadata rejected: missing description", async () => {
  freshHome();
  const src = fs.mkdtempSync(path.join(os.tmpdir(), "ocic-skills-src-"));
  writeFixture(src, { "SKILL.md": "---\nname: no-description\n---\nbody\n" });

  const { importSkill } = await import(`${INDEX_URL}?t=${Date.now()}-d`);
  await assertRejects(() => importSkill(src), "INVALID_METADATA");
});

await check("malformed metadata rejected: unparseable frontmatter line", async () => {
  freshHome();
  const src = fs.mkdtempSync(path.join(os.tmpdir(), "ocic-skills-src-"));
  writeFixture(src, {
    "SKILL.md": "---\nname: nested\ndescription: ok\nnested:\n  child: value\n---\nbody\n"
  });

  const { importSkill } = await import(`${INDEX_URL}?t=${Date.now()}-e`);
  await assertRejects(() => importSkill(src), "INVALID_METADATA");
});

await check("duplicate name rejected, first import untouched", async () => {
  const home = freshHome();
  const srcA = fs.mkdtempSync(path.join(os.tmpdir(), "ocic-skills-src-a-"));
  const srcB = fs.mkdtempSync(path.join(os.tmpdir(), "ocic-skills-src-b-"));
  makeSkillDir(srcA, ".", { frontmatter: defaultFrontmatter("dup-skill", "First one.") });
  makeSkillDir(srcB, ".", { frontmatter: defaultFrontmatter("dup-skill", "Second one, should be rejected.") });

  const { importSkill, listCatalog } = await import(`${INDEX_URL}?t=${Date.now()}-f`);
  const first = await importSkill(srcA);
  await assertRejects(() => importSkill(srcB), "DUPLICATE_NAME");

  const catalog = await listCatalog();
  assert(catalog.length === 1, `expected exactly 1 catalog entry, got ${catalog.length}`);
  assert(catalog[0].source === first.source, "duplicate rejection must not overwrite the first import's record");

  const snapshotSkillMd = path.join(home, "skills", "snapshots", "dup-skill", "SKILL.md");
  assert(
    fs.readFileSync(snapshotSkillMd, "utf-8").includes("First one."),
    "duplicate rejection must not overwrite the first import's snapshot content"
  );
});

await check("path traversal via frontmatter name rejected before any write", async () => {
  const home = freshHome();
  const src = fs.mkdtempSync(path.join(os.tmpdir(), "ocic-skills-src-"));
  makeSkillDir(src, ".", { frontmatter: defaultFrontmatter("../../evil", "Traversal attempt.") });

  const { importSkill, listCatalog } = await import(`${INDEX_URL}?t=${Date.now()}-g`);
  await assertRejects(() => importSkill(src), "PATH_TRAVERSAL");
  assert((await listCatalog()).length === 0, "catalog must remain unchanged");

  // Prove the escape target was never actually written to.
  const escapeTarget = path.resolve(home, "skills", "..", "..", "evil");
  assert(!fs.existsSync(escapeTarget), "path traversal must never write outside the skills root");
});

await check("symlink escaping the package root rejected (Windows junction)", async () => {
  const home = freshHome();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "ocic-skills-outside-"));
  fs.writeFileSync(path.join(outside, "secret.txt"), "SECRET_OUTSIDE_CONTENT");

  const src = fs.mkdtempSync(path.join(os.tmpdir(), "ocic-skills-src-"));
  makeSkillDir(src, ".", { frontmatter: defaultFrontmatter("escape-skill", "Contains an escaping link.") });
  createEscapingDirLink(path.join(src, "escape"), outside);

  const { importSkill, listCatalog } = await import(`${INDEX_URL}?t=${Date.now()}-h`);
  await assertRejects(() => importSkill(src), "SYMLINK_ESCAPE");
  assert((await listCatalog()).length === 0, "catalog must remain unchanged after a rejected symlink-escape import");

  const snapshotsDir = path.join(home, "skills", "snapshots");
  if (fs.existsSync(snapshotsDir)) {
    for (const entry of fs.readdirSync(snapshotsDir)) {
      assert(!entry.startsWith("escape-skill"), "no snapshot should exist for a rejected import");
    }
  }
  // The outside secret must never have been copied anywhere under the
  // skills root.
  const found = walkForContent(home, "SECRET_OUTSIDE_CONTENT");
  assert(found.length === 0, `escaping content was copied into: ${found.join(", ")}`);
});

await check("import never executes scripts found in the package", async () => {
  freshHome();
  const canaryDir = fs.mkdtempSync(path.join(os.tmpdir(), "ocic-skills-canary-"));
  const canaryFile = path.join(canaryDir, "executed.txt");

  const src = fs.mkdtempSync(path.join(os.tmpdir(), "ocic-skills-src-"));
  // A script that, if actually executed by the import pipeline, would leave
  // an observable side effect (the canary file). It is only ever expected
  // to be copied as opaque bytes.
  const scriptContent =
    process.platform === "win32"
      ? `@echo off\r\necho executed> "${canaryFile.replace(/\\/g, "\\\\")}"\r\n`
      : `#!/bin/sh\necho executed > "${canaryFile}"\n`;
  makeSkillDir(src, ".", {
    frontmatter: defaultFrontmatter("script-skill", "Ships a script that must never run."),
    extra: { "hooks/setup.cmd": scriptContent, "hooks/setup.sh": scriptContent }
  });

  const { importSkill } = await import(`${INDEX_URL}?t=${Date.now()}-i`);
  const record = await importSkill(src);
  assert(record.name === "script-skill", "import of a script-bearing but otherwise valid package should succeed");

  assert(!fs.existsSync(canaryFile), "import must never execute a script found in the package");

  const homeNow = process.env.OCIC_AGENT_HOME;
  const copiedScript = path.join(homeNow, "skills", "snapshots", "script-skill", "hooks", "setup.sh");
  assert(fs.existsSync(copiedScript), "the script file itself should still be copied as inert content");
  assert(fs.readFileSync(copiedScript, "utf-8") === scriptContent, "copied script content must be byte-identical");

  // Content-based capability detection (independent of any "allowed-tools"
  // frontmatter, which this fixture never sets) must also have flagged the
  // shipped scripts, so this package can never be enabled either.
  assert(
    record.unsupportedCapabilities.length > 0,
    "a package that ships real scripts must be flagged even without an allowed-tools hint"
  );
});

await check("removal leaves the source directory intact", async () => {
  const home = freshHome();
  const src = fs.mkdtempSync(path.join(os.tmpdir(), "ocic-skills-src-"));
  makeSkillDir(src, ".", { frontmatter: defaultFrontmatter("removable-skill") });
  const originalSkillMd = fs.readFileSync(path.join(src, "SKILL.md"), "utf-8");

  const { importSkill, enableSkill, removeSkill, listCatalog } = await import(`${INDEX_URL}?t=${Date.now()}-j`);
  await importSkill(src);
  enableSkill("removable-skill");
  removeSkill("removable-skill");

  assert((await listCatalog()).find((s) => s.name === "removable-skill") === undefined, "removed skill still in catalog");
  assert(!fs.existsSync(path.join(home, "skills", "snapshots", "removable-skill")), "snapshot dir was not removed");

  assert(fs.existsSync(path.join(src, "SKILL.md")), "removal deleted the original source file");
  assert(fs.readFileSync(path.join(src, "SKILL.md"), "utf-8") === originalSkillMd, "source file content changed");
});

await check("refresh re-hashes and does not disturb an already-built session snapshot", async () => {
  const src = fs.mkdtempSync(path.join(os.tmpdir(), "ocic-skills-src-"));
  makeSkillDir(src, ".", {
    frontmatter: defaultFrontmatter("versioned-skill", "Version one."),
    extra: { "resource.txt": "VERSION_ONE" }
  });

  freshHome();
  const { importSkill, enableSkill, refreshSkill, buildSessionSkills } = await import(`${INDEX_URL}?t=${Date.now()}-k`);
  const v1 = await importSkill(src);
  enableSkill("versioned-skill");

  const runA = fs.mkdtempSync(path.join(os.tmpdir(), "ocic-skills-session-a-"));
  const builtA = await buildSessionSkills(runA);
  const resourceA = path.join(builtA.skillsDir, "versioned-skill", "resource.txt");
  assert(fs.readFileSync(resourceA, "utf-8") === "VERSION_ONE", "session A did not get v1 content");

  // Edit the ORIGINAL source (simulating the user editing their skill
  // folder) without calling refresh yet.
  fs.writeFileSync(path.join(src, "resource.txt"), "VERSION_TWO");
  makeSkillDir(src, ".", {
    frontmatter: defaultFrontmatter("versioned-skill", "Version two."),
    extra: { "resource.txt": "VERSION_TWO" }
  });

  const runB = fs.mkdtempSync(path.join(os.tmpdir(), "ocic-skills-session-b-"));
  const builtB = await buildSessionSkills(runB);
  const resourceB = path.join(builtB.skillsDir, "versioned-skill", "resource.txt");
  assert(
    fs.readFileSync(resourceB, "utf-8") === "VERSION_ONE",
    "a source edit must not take effect before an explicit refresh"
  );

  const v2 = await refreshSkill("versioned-skill");
  assert(v2.hash !== v1.hash, "refresh must re-hash when content changed");

  // The already-built session A workspace must be untouched by the refresh
  // that happened after it was built.
  assert(
    fs.readFileSync(resourceA, "utf-8") === "VERSION_ONE",
    "refreshing must not disturb an already-bound session's materialized snapshot"
  );

  const runC = fs.mkdtempSync(path.join(os.tmpdir(), "ocic-skills-session-c-"));
  const builtC = await buildSessionSkills(runC);
  const resourceC = path.join(builtC.skillsDir, "versioned-skill", "resource.txt");
  assert(
    fs.readFileSync(resourceC, "utf-8") === "VERSION_TWO",
    "a new conversation built after refresh must see the refreshed content"
  );
});

await check("a skill requiring an unsupported capability cannot be enabled", async () => {
  freshHome();
  const src = fs.mkdtempSync(path.join(os.tmpdir(), "ocic-skills-src-"));
  makeSkillDir(src, ".", {
    frontmatter: `---\nname: shell-skill\ndescription: Wants shell access.\nallowed-tools: [Read, Bash]\n---\n`
  });

  const { importSkill, enableSkill, listCatalog } = await import(`${INDEX_URL}?t=${Date.now()}-l`);
  const record = await importSkill(src);
  assert(record.unsupportedCapabilities.includes("Bash"), "Bash should be flagged as an unsupported capability");

  await assertRejects(() => Promise.resolve().then(() => enableSkill("shell-skill")), "UNSUPPORTED_CAPABILITY");

  const catalog = await listCatalog();
  assert(catalog.find((s) => s.name === "shell-skill").enabled === false, "must remain disabled after a rejected enable");
});

await check("a package with no tools frontmatter still imports, and still cannot obtain shell/write capability", async () => {
  // Reconciled against the pinned SDK (@anthropic-ai/claude-agent-sdk@0.3.263,
  // read directly from host/node_modules): it defines no "allowed-tools"
  // SKILL.md frontmatter field at all, so its absence must be treated as
  // normal, not as missing metadata - AND capability detection must not
  // depend on that (or any) frontmatter key being present, or a package
  // could obtain shell access simply by omitting it. This package omits
  // "allowed-tools" entirely but ships a real shell script, so the
  // content-based detector (capabilities.js's detectContentCapabilities)
  // must catch it independently.
  freshHome();
  const src = fs.mkdtempSync(path.join(os.tmpdir(), "ocic-skills-src-"));
  makeSkillDir(src, ".", {
    frontmatter: defaultFrontmatter("no-manifest-hint-skill", "No allowed-tools field at all."),
    extra: { "run.sh": "#!/bin/sh\necho hi\n" }
  });

  const { importSkill, enableSkill, listCatalog } = await import(`${INDEX_URL}?t=${Date.now()}-n`);
  const record = await importSkill(src);
  assert(record.name === "no-manifest-hint-skill", "a package with no allowed-tools field must still import successfully");
  assert(
    record.unsupportedCapabilities.some((c) => c.includes("run.sh")),
    `expected content-based detection to flag run.sh, got: ${JSON.stringify(record.unsupportedCapabilities)}`
  );

  await assertRejects(() => Promise.resolve().then(() => enableSkill("no-manifest-hint-skill")), "UNSUPPORTED_CAPABILITY");
  const catalog = await listCatalog();
  assert(
    catalog.find((s) => s.name === "no-manifest-hint-skill").enabled === false,
    "a shell-bearing package must stay disabled even with no allowed-tools frontmatter to blame"
  );
});

await check("a plain package with neither tools frontmatter nor script content imports and enables cleanly", async () => {
  freshHome();
  const src = fs.mkdtempSync(path.join(os.tmpdir(), "ocic-skills-src-"));
  makeSkillDir(src, ".", {
    frontmatter: defaultFrontmatter("plain-skill", "Ordinary instructions and a text resource, no scripts."),
    extra: { "notes.txt": "just prose, nothing executable" }
  });

  const { importSkill, enableSkill } = await import(`${INDEX_URL}?t=${Date.now()}-o`);
  const record = await importSkill(src);
  assert(record.unsupportedCapabilities.length === 0, "an ordinary package must not be flagged for anything");
  const enabled = enableSkill("plain-skill"); // must not throw
  assert(enabled.enabled === true, "an ordinary package must enable cleanly");
});

await check("canonical-path enforcement blocks reads outside the session snapshot", async () => {
  freshHome();
  const src = fs.mkdtempSync(path.join(os.tmpdir(), "ocic-skills-src-"));
  makeSkillDir(src, ".", {
    frontmatter: defaultFrontmatter("safe-skill"),
    extra: { "resource.txt": "safe content" }
  });
  const src2 = fs.mkdtempSync(path.join(os.tmpdir(), "ocic-skills-src2-"));
  makeSkillDir(src2, ".", { frontmatter: defaultFrontmatter("other-skill"), extra: { "resource.txt": "other content" } });

  const { importSkill, enableSkill, buildSessionSkills, assertCanonicalSkillResourcePath, SkillPathError } = await import(
    `${INDEX_URL}?t=${Date.now()}-m`
  );
  await importSkill(src);
  enableSkill("safe-skill");
  // "other-skill" is imported but never enabled, so it must never be
  // materialized into this session at all.
  await importSkill(src2);

  const run = fs.mkdtempSync(path.join(os.tmpdir(), "ocic-skills-session-canon-"));
  const built = await buildSessionSkills(run);
  assert(built.allowedSkillNames.includes(Q("safe-skill")), "safe-skill must be materialized, plugin-qualified");
  assert(!built.allowedSkillNames.includes(Q("other-skill")), "a disabled skill must never be materialized");
  assert(!fs.existsSync(path.join(built.skillsDir, "other-skill")), "disabled skill's directory must not exist on disk");

  const ok = assertCanonicalSkillResourcePath(built.skillsDir, built.allowedSkillNames, "safe-skill/resource.txt");
  assert(fs.readFileSync(ok, "utf-8") === "safe content", "canonical path did not resolve to the right file");

  await assertThrowsInstance(
    () => assertCanonicalSkillResourcePath(built.skillsDir, built.allowedSkillNames, "../../../etc/passwd"),
    SkillPathError
  );
  await assertThrowsInstance(
    () =>
      assertCanonicalSkillResourcePath(
        built.skillsDir,
        built.allowedSkillNames,
        path.join(built.skillsDir, "..", "..", "outside.txt")
      ),
    SkillPathError
  );
  // "other-skill" is not in this session's allowedSkillNames even though it
  // exists in the catalog - a crafted relative path naming it must still be
  // rejected.
  await assertThrowsInstance(
    () => assertCanonicalSkillResourcePath(built.skillsDir, built.allowedSkillNames, "other-skill/resource.txt"),
    SkillPathError
  );
});

function walkForContent(root, needle) {
  const hits = [];
  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isSymbolicLink()) continue; // never follow links while scanning for leaked content
      if (e.isDirectory()) walk(full);
      else if (e.isFile()) {
        try {
          if (fs.readFileSync(full, "utf-8").includes(needle)) hits.push(full);
        } catch {}
      }
    }
  }
  walk(root);
  return hits;
}

async function assertRejects(fn, expectedCode) {
  try {
    await fn();
  } catch (err) {
    if (expectedCode && err.code !== expectedCode) {
      throw new Error(`expected error code ${expectedCode}, got ${err.code}: ${err.message}`);
    }
    return;
  }
  throw new Error(`expected a rejection${expectedCode ? ` with code ${expectedCode}` : ""}, but the call succeeded`);
}

async function assertThrowsInstance(fn, ErrorClass) {
  try {
    await fn();
  } catch (err) {
    if (!(err instanceof ErrorClass)) {
      throw new Error(`expected an instance of ${ErrorClass.name}, got ${err.constructor.name}: ${err.message}`);
    }
    return;
  }
  throw new Error(`expected an instance of ${ErrorClass.name} to be thrown, but the call succeeded`);
}

const failed = results.filter((r) => !r.ok);
console.log(
  `\n${results.length - failed.length}/${results.length} passed` +
    (failed.length ? `\n\nFailures:\n${failed.map((f) => `  - ${f.name}: ${f.err}`).join("\n")}` : "") +
    "\n"
);
process.exit(failed.length ? 1 : 0);
