#!/usr/bin/env node
//
// Tests for the "type a skill into a form" authoring path
// (host/agent/skills/author.js) — a second way to get a skill into the
// catalog alongside the existing folder-import path
// (host/test/skills-catalog.test.mjs), sharing the SAME underlying
// importSkill()/refreshSkill() pipeline rather than a parallel one. Covers:
//   - an authored skill is written to a host-owned folder, imported, and
//     appears in the catalog exactly like a folder-imported one;
//   - an invalid name is rejected before anything is written to disk;
//   - an empty description is rejected, also before any write;
//   - the composed SKILL.md round-trips through the REAL frontmatter parser
//     (parseFrontmatter) — not a re-implementation of it;
//   - re-saving an authored skill's form (the chosen edit semantics — see
//     author.js's header) rewrites its own SKILL.md and refreshes in place,
//     while authoring a name already imported from a DIFFERENT source still
//     raises the normal DUPLICATE_NAME error;
//   - the companion wire op (skills_author) added to companion.js answers
//     the same contract end-to-end.
//
// Run: node host/test/agent-skills-author.test.mjs

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { CompanionCore } from "../agent/companion.js";
import { TranscriptStore } from "../agent/storage/transcript-store.js";
import { BrowserLease } from "../agent/broker/browser-lease.js";
import { ApprovalRegistry } from "../agent/policy/approvals.js";
import { SessionManager } from "../agent/session/manager.js";
import { ToolBridge } from "../agent/broker/tool-bridge.js";
import { AGENT_MESSAGE_TYPES, PROTOCOL_VERSION } from "../agent/protocol.js";

const INDEX_URL = new URL("../agent/skills/index.js", import.meta.url).href;

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocic-skills-author-"));
  process.env.OCIC_AGENT_HOME = dir;
  return dir;
}

async function assertRejects(fn, expectedCode) {
  try {
    await fn();
  } catch (err) {
    if (expectedCode && err.code !== expectedCode) {
      throw new Error(`expected error code ${expectedCode}, got ${err.code}: ${err.message}`);
    }
    return err;
  }
  throw new Error(`expected a rejection${expectedCode ? ` with code ${expectedCode}` : ""}, but the call succeeded`);
}

function listDirRecursive(root) {
  const out = [];
  if (!fs.existsSync(root)) return out;
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      out.push(full);
      if (entry.isDirectory()) walk(full);
    }
  };
  walk(root);
  return out;
}

console.log("\nSkills authoring form (typed skill, not folder import)\n");

await check("authored skill is written under skillsRoot()/authored, imported, and appears in the catalog like a folder import", async () => {
  freshHome();
  const { authorSkill, listCatalog, isAuthoredSkillRecord } = await import(INDEX_URL);

  const record = await authorSkill({
    name: "authored-demo",
    description: "A hand-typed demo skill.",
    body: "# Authored demo\n\nDo the thing.\n"
  });

  assert(record.name === "authored-demo", `unexpected name: ${record.name}`);
  assert(record.description === "A hand-typed demo skill.", `unexpected description: ${record.description}`);
  assert(record.enabled === false, "a freshly authored skill starts disabled, exactly like a folder import");
  assert(typeof record.hash === "string" && record.hash.startsWith("sha256:"), `bad hash: ${record.hash}`);
  assert(record.userInvocable === true && record.modelInvocable === true, "default invocation flags match import.js's own defaults");
  assert(isAuthoredSkillRecord(record) === true, "isAuthoredSkillRecord() recognizes its own record");

  const catalog = await listCatalog();
  const fromCatalog = catalog.find((s) => s.name === "authored-demo");
  assert(fromCatalog, "authored skill must be present via listCatalog(), same surface a folder import uses");
  assert(fromCatalog.source === record.source, "catalog record source matches what authorSkill() returned");

  const manifestPath = path.join(record.source, "SKILL.md");
  assert(fs.existsSync(manifestPath), `SKILL.md must exist at the authored skill's own source folder: ${manifestPath}`);
});

await check("an invalid name is rejected before anything is written to disk", async () => {
  const home = freshHome();
  const { authorSkill, authoredSkillsRoot } = await import(INDEX_URL);

  const before = listDirRecursive(authoredSkillsRoot());
  // INVALID_NAME (author.js's own, form-specific code), NOT import.js's
  // generic INVALID_METADATA — the operator typed into a "Tên skill" field,
  // there is no folder to point at (see errors-ui.js's distinct message).
  await assertRejects(
    () => authorSkill({ name: "not a valid name!", description: "desc", body: "body text" }),
    "INVALID_NAME"
  );
  const after = listDirRecursive(authoredSkillsRoot());
  assert(after.length === before.length, `an invalid name must not create/modify anything under authoredSkillsRoot() (before=${before.length}, after=${after.length})`);

  // A traversal-shaped name gets its own distinct, more specific code.
  await assertRejects(
    () => authorSkill({ name: "../escape", description: "desc", body: "body text" }),
    "PATH_TRAVERSAL"
  );
  const afterTraversal = listDirRecursive(authoredSkillsRoot());
  assert(afterTraversal.length === before.length, "a path-traversal name must not write anything to disk either");
  void home;
});

await check("an empty description is rejected before anything is written to disk", async () => {
  const { authorSkill, authoredSkillsRoot } = await import(INDEX_URL);
  freshHome();

  const before = listDirRecursive(authoredSkillsRoot());
  await assertRejects(
    () => authorSkill({ name: "no-description-skill", description: "   ", body: "body text" }),
    "INVALID_METADATA"
  );
  const after = listDirRecursive(authoredSkillsRoot());
  assert(after.length === before.length, "an empty/whitespace-only description must not write anything to disk");

  await assertRejects(
    () => authorSkill({ name: "no-description-skill-2", description: undefined, body: "body text" }),
    "INVALID_METADATA"
  );
});

await check("an empty body is rejected before anything is written to disk", async () => {
  const { authorSkill, authoredSkillsRoot } = await import(INDEX_URL);
  freshHome();

  const before = listDirRecursive(authoredSkillsRoot());
  await assertRejects(
    () => authorSkill({ name: "no-body-skill", description: "Has a description.", body: "   " }),
    "INVALID_METADATA"
  );
  const after = listDirRecursive(authoredSkillsRoot());
  assert(after.length === before.length, "an empty body must not write anything to disk");
});

await check("the composed SKILL.md round-trips through the real frontmatter parser, including tricky description text", async () => {
  const { authorSkill } = await import(INDEX_URL);
  const { parseFrontmatter, validateSkillName, validateDescription } = await import(
    new URL("../agent/skills/frontmatter.js", import.meta.url).href
  );
  freshHome();

  // "true" and a leading "[" are exactly the two shapes parseScalar() would
  // otherwise misread as a YAML-ish boolean/list if the composer ever wrote
  // an unquoted scalar — proves the description is safely quoted.
  const tricky = 'true — [not a list] and has "quotes" inside';
  const record = await authorSkill({
    name: "roundtrip-skill",
    description: tricky,
    body: "# Roundtrip\n\nBody text with **markdown**.\n",
    allowedTools: ["Read", " Skill "]
  });

  const raw = fs.readFileSync(path.join(record.source, "SKILL.md"), "utf-8");
  const meta = parseFrontmatter(raw);
  assert(validateSkillName(meta.name) === "roundtrip-skill", `name did not round-trip: ${meta.name}`);
  assert(validateDescription(meta.description) === tricky, `description did not round-trip exactly: ${JSON.stringify(meta.description)}`);
  assert(Array.isArray(meta["allowed-tools"]), `allowed-tools must parse back as an array: ${JSON.stringify(meta["allowed-tools"])}`);
  assert(
    meta["allowed-tools"].map((s) => s.trim()).join(",") === "Read,Skill",
    `allowed-tools did not round-trip: ${JSON.stringify(meta["allowed-tools"])}`
  );
  assert(raw.includes("Body text with **markdown**."), "Markdown body must be preserved verbatim below the frontmatter block");
});

await check("re-saving the form for an authored skill rewrites its own SKILL.md and refreshes in place (no DUPLICATE_NAME)", async () => {
  const { authorSkill, listCatalog } = await import(INDEX_URL);
  freshHome();

  const first = await authorSkill({
    name: "editable-skill",
    description: "First version.",
    body: "# v1\n",
    userInvocable: true,
    modelInvocable: true
  });
  assert(first.description === "First version.", "first save recorded");

  const second = await authorSkill({
    name: "editable-skill",
    description: "Second, edited version.",
    body: "# v2\n\nMore detail this time.\n",
    userInvocable: false,
    modelInvocable: true
  });
  assert(second.description === "Second, edited version.", `edit must overwrite description, got ${second.description}`);
  assert(second.source === first.source, "editing must reuse the exact same authored source folder, not create a new one");
  assert(second.userInvocable === false, "invocation flags from the edited form must be applied");

  const raw = fs.readFileSync(path.join(second.source, "SKILL.md"), "utf-8");
  assert(raw.includes("More detail this time."), "on-disk SKILL.md must contain the edited body");
  assert(!raw.includes("# v1"), "on-disk SKILL.md must no longer contain the original body");

  const catalog = await listCatalog();
  assert(catalog.filter((s) => s.name === "editable-skill").length === 1, "editing must not create a second catalog entry");
});

await check("authoring a name already imported from a DIFFERENT source is rejected as DUPLICATE_NAME, catalog untouched", async () => {
  const { authorSkill, importSkill, listCatalog } = await import(INDEX_URL);
  freshHome();

  const folderSrc = fs.mkdtempSync(path.join(os.tmpdir(), "ocic-skills-author-foldersrc-"));
  fs.writeFileSync(
    path.join(folderSrc, "SKILL.md"),
    "---\nname: shared-name-skill\ndescription: Imported from a real folder.\n---\n\nBody.\n"
  );
  await importSkill(folderSrc);

  await assertRejects(
    () =>
      authorSkill({
        name: "shared-name-skill",
        description: "Trying to author over an existing folder-imported skill.",
        body: "# Should not land\n"
      }),
    "DUPLICATE_NAME"
  );

  const catalog = await listCatalog();
  const record = catalog.find((s) => s.name === "shared-name-skill");
  assert(record && record.description === "Imported from a real folder.", "the original folder-imported record must be completely untouched");
});

await check("companion wire op skills_author answers the same contract end-to-end", async () => {
  const agentHome = fs.mkdtempSync(path.join(os.tmpdir(), "ocic-skills-author-agent-"));
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "ocic-skills-author-config-"));
  process.env.OCIC_AGENT_HOME = agentHome;
  process.env.OCIC_AGENT_CONFIG_DIR = configDir;

  const store = new TranscriptStore();
  const lease = new BrowserLease();
  const approvals = new ApprovalRegistry();
  const sessionManager = new SessionManager({ store, lease, approvals });
  const toolBridge = new ToolBridge({
    init: async () => {},
    callTool: async (name) => ({ content: [{ type: "text", text: `fake:${name}` }] }),
    shutdown: () => {}
  });
  const core = new CompanionCore({
    toolBridge,
    sessionManager,
    lease,
    coerceArgs: (a) => a,
    sdk: { async *query() { yield { type: "assistant", text: "ok" }; } },
    profileProvider: {
      async snapshotForRun() {
        return { model: "claude-fake-model", env: {}, revision: 1, profileId: "default" };
      }
    }
  });

  const envelope = (op, payload = {}) => ({
    v: PROTOCOL_VERSION,
    type: AGENT_MESSAGE_TYPES.AGENT_SETTINGS,
    requestId: "req_author_1",
    op,
    ...payload
  });

  const authorReply = await core.handleEnvelope(
    envelope("skills_author", {
      name: "wire-author-skill",
      description: "Authored through the companion wire op.",
      body: "# Wire test\n",
      userInvocable: true,
      modelInvocable: false,
      allowedTools: "Read"
    })
  );
  assert(authorReply.type === AGENT_MESSAGE_TYPES.AGENT_SETTINGS, "reply must be agent_settings-shaped");
  assert(authorReply.ok === true, `skills_author must succeed: ${JSON.stringify(authorReply.error)}`);
  assert(authorReply.result.name === "wire-author-skill", "result carries the new record");
  assert(authorReply.result.modelInvocable === false, "invocation flags forwarded through the wire op");

  const listReply = await core.handleEnvelope(envelope("skills_list"));
  assert(
    listReply.ok === true && listReply.result.some((s) => s.name === "wire-author-skill"),
    "the authored skill must show up via skills_list too"
  );

  const badReply = await core.handleEnvelope(
    envelope("skills_author", { name: "bad name!", description: "x", body: "y" })
  );
  assert(badReply.ok === false && badReply.error.code === "INVALID_NAME", `invalid name over the wire must fail with INVALID_NAME, got ${JSON.stringify(badReply.error)}`);
});

const failed = results.filter((r) => !r.ok);
console.log(
  `\n${results.length - failed.length}/${results.length} passed` +
    (failed.length ? `\n\nFailures:\n${failed.map((f) => `  - ${f.name}: ${f.err}`).join("\n")}` : "") +
    "\n"
);
process.exit(failed.length ? 1 : 0);
