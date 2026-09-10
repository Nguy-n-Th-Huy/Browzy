#!/usr/bin/env node
//
// Tests for the `skills_read_source` companion op
// (openspec/changes/redesign-settings-typed-only-skills, design.md decision
// D2), the read-back that makes "Sửa"/"Nhân bản" possible now that
// `skills_import`/`skills_refresh` are gone from the wire. Covers:
//   - a valid read returns the composed Markdown body and the record's own
//     invocation flags (never re-derived from the file);
//   - an unknown name is rejected with NOT_FOUND before any file is opened;
//   - a traversal-shaped or separator-bearing name is rejected before any
//     file is opened (a request cannot be steered outside the catalog's own
//     storage — even a name that never matches a real record, and even a
//     tampered catalog.json whose snapshotId is traversal-shaped);
//   - a stored skill whose frontmatter carries no `allowed-tools` returns an
//     empty allowedTools array rather than throwing.
//
// Run: node host/test/agent-skills-read-source.test.mjs

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
const PATHS_URL = new URL("../agent/skills/paths.js", import.meta.url).href;

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  PASS  ${name}`);
  } catch (err) {
    results.push({ name, ok: false, err: err.stack || err.message });
    console.log(`  FAIL  ${name} — ${err.stack || err.message}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

let _reqId = 0;
function nextRequestId() {
  _reqId += 1;
  return `req_${_reqId}`;
}
function agentSettingsEnvelope(op, payload = {}, { v = PROTOCOL_VERSION, requestId = nextRequestId() } = {}) {
  return { v, type: AGENT_MESSAGE_TYPES.AGENT_SETTINGS, requestId, op, ...payload };
}

function freshHome() {
  const agentHome = fs.mkdtempSync(path.join(os.tmpdir(), "ocic-skills-readsrc-agent-"));
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "ocic-skills-readsrc-config-"));
  process.env.OCIC_AGENT_HOME = agentHome;
  process.env.OCIC_AGENT_CONFIG_DIR = configDir;
  return agentHome;
}

function buildCore() {
  const store = new TranscriptStore();
  const lease = new BrowserLease();
  const approvals = new ApprovalRegistry();
  const sessionManager = new SessionManager({ store, lease, approvals });
  const toolBridge = new ToolBridge({
    init: async () => {},
    callTool: async (name) => ({ content: [{ type: "text", text: `fake:${name}` }] }),
    shutdown: () => {}
  });
  return new CompanionCore({
    toolBridge,
    sessionManager,
    lease,
    coerceArgs: (a) => a,
    sdk: { async *query() { yield { type: "assistant", text: "ok" }; } },
    profileProvider: {
      async snapshotForRun(profileId, modelId) {
        return {
          model: modelId || "claude-fake-model",
          env: { ANTHROPIC_BASE_URL: "https://example.invalid", ANTHROPIC_API_KEY: "fake-key" },
          revision: 1,
          profileId: profileId || "default"
        };
      }
    }
  });
}

// Wraps fs.readFileSync for the duration of `fn`, recording every path read
// so a test can assert that NOTHING under the skills snapshot store was
// opened on a rejected request — the actual security property task 1.4
// checks, not merely "zero fs calls" (loading the catalog itself is
// allowed).
async function withReadSpy(fn) {
  const original = fs.readFileSync;
  const reads = [];
  fs.readFileSync = function spy(...args) {
    reads.push(String(args[0]));
    return original.apply(fs, args);
  };
  try {
    await fn();
  } finally {
    fs.readFileSync = original;
  }
  return reads;
}

console.log("\nskills_read_source companion op — read-back for edit/duplicate, never a path\n");

await test("a valid read returns the composed body and the record's own invocation flags", async () => {
  freshHome();
  const core = buildCore();
  const { authorSkill, setInvocationFlags } = await import(INDEX_URL);

  const body = "# Round trip demo\n\nStep one.\nStep two.\n";
  await authorSkill({
    name: "readsrc-demo",
    description: "A demo skill for read-back tests.",
    body,
    allowedTools: ["Read", "Bash"]
  });
  await setInvocationFlags("readsrc-demo", { userInvocable: false, modelInvocable: true });

  const reply = await core.handleEnvelope(agentSettingsEnvelope("skills_read_source", { name: "readsrc-demo" }));
  assert(reply.ok === true, `skills_read_source must succeed: ${JSON.stringify(reply.error)}`);
  assert(reply.result.name === "readsrc-demo", `unexpected name: ${reply.result.name}`);
  assert(reply.result.description === "A demo skill for read-back tests.", `unexpected description: ${reply.result.description}`);
  assert(reply.result.body.trimEnd() === body.trimEnd(), `body must round-trip byte-for-byte, got: ${JSON.stringify(reply.result.body)}`);
  assert(
    Array.isArray(reply.result.allowedTools) && reply.result.allowedTools.join(",") === "Read,Bash",
    `unexpected allowedTools: ${JSON.stringify(reply.result.allowedTools)}`
  );
  // Invocation flags must come from the CATALOG RECORD (set above via
  // setInvocationFlags), never re-derived from the file — the composed
  // SKILL.md never carried them in the first place (frontmatter.js has no
  // such field).
  assert(reply.result.userInvocable === false, "userInvocable must reflect the catalog record, not a file-derived default");
  assert(reply.result.modelInvocable === true, "modelInvocable must reflect the catalog record");
});

await test("a skill whose frontmatter has no allowed-tools returns an empty allowedTools array rather than throwing", async () => {
  freshHome();
  const core = buildCore();
  const { authorSkill } = await import(INDEX_URL);
  await authorSkill({ name: "readsrc-no-tools", description: "No allowed-tools hint.", body: "# Body\n" });

  const reply = await core.handleEnvelope(agentSettingsEnvelope("skills_read_source", { name: "readsrc-no-tools" }));
  assert(reply.ok === true, `must succeed: ${JSON.stringify(reply.error)}`);
  assert(Array.isArray(reply.result.allowedTools) && reply.result.allowedTools.length === 0, `expected an empty array, got: ${JSON.stringify(reply.result.allowedTools)}`);
});

await test("an unknown name is rejected with NOT_FOUND, and opens no file under the snapshot store", async () => {
  freshHome();
  const core = buildCore();
  const reads = await withReadSpy(async () => {
    const reply = await core.handleEnvelope(agentSettingsEnvelope("skills_read_source", { name: "does-not-exist" }));
    assert(reply.ok === false, "an unknown name must not succeed");
    assert(reply.error.code === "NOT_FOUND", `expected NOT_FOUND, got ${reply.error.code}`);
  });
  const snapshotReads = reads.filter((p) => p.includes("snapshots") || p.endsWith("SKILL.md"));
  assert(snapshotReads.length === 0, `an unknown name must never open a snapshot file, but read: ${JSON.stringify(snapshotReads)}`);
});

await test("a traversal-shaped or separator-bearing name is rejected before any file is opened", async () => {
  freshHome();
  const core = buildCore();
  for (const badName of ["../escape", "..\\escape", "a/b", "a\\b", "../../etc/passwd"]) {
    const reads = await withReadSpy(async () => {
      const reply = await core.handleEnvelope(agentSettingsEnvelope("skills_read_source", { name: badName }));
      // A traversal-shaped name never matches a real catalog record (names
      // are validated at authoring time to exclude separators/"..", see
      // frontmatter.js's NAME_PATTERN/TRAVERSAL_PATTERN), so this is
      // rejected as NOT_FOUND — the same outcome an unknown name gets, and
      // by construction never a path outside the catalog's own storage.
      assert(reply.ok === false, `a traversal-shaped name (${badName}) must not succeed`);
      assert(reply.error.code === "NOT_FOUND", `expected NOT_FOUND for ${badName}, got ${reply.error.code}`);
    });
    const snapshotReads = reads.filter((p) => p.includes("snapshots") || p.endsWith("SKILL.md"));
    assert(snapshotReads.length === 0, `${badName} must never open a snapshot file, but read: ${JSON.stringify(snapshotReads)}`);
  }
});

await test("a catalog record tampered to carry a traversal-shaped snapshotId is rejected as PATH_TRAVERSAL before any file under it is opened", async () => {
  const agentHome = freshHome();
  const core = buildCore();
  const { authorSkill } = await import(INDEX_URL);
  const { catalogFile } = await import(PATHS_URL);
  await authorSkill({ name: "readsrc-tampered", description: "Will have its snapshotId corrupted.", body: "# Body\n" });

  // Simulate an out-of-band tampered catalog.json — no library path ever
  // produces this, only a direct file edit does.
  const catalog = JSON.parse(fs.readFileSync(catalogFile(), "utf-8"));
  const rec = catalog.skills.find((s) => s.name === "readsrc-tampered");
  assert(rec, "fixture record must exist in the freshly written catalog");
  rec.snapshotId = "../../escape";
  fs.writeFileSync(catalogFile(), JSON.stringify(catalog, null, 2));

  const reads = await withReadSpy(async () => {
    const reply = await core.handleEnvelope(agentSettingsEnvelope("skills_read_source", { name: "readsrc-tampered" }));
    assert(reply.ok === false, "a tampered snapshotId must not succeed");
    assert(reply.error.code === "PATH_TRAVERSAL", `expected PATH_TRAVERSAL, got ${reply.error.code}`);
  });
  const snapshotReads = reads.filter((p) => p.includes(`${path.sep}snapshots${path.sep}`) || p.endsWith("SKILL.md"));
  assert(snapshotReads.length === 0, `a tampered snapshotId must never open any snapshot file, but read: ${JSON.stringify(snapshotReads)}`);
  void agentHome;
});

await test("a catalog record whose snapshot directory has no SKILL.md on disk is rejected as a distinct SkillPathError, not a leaked errno", async () => {
  freshHome();
  const core = buildCore();
  const { authorSkill, removeSkill } = await import(`${INDEX_URL}?t=${Date.now()}`);
  const { snapshotDir } = await import(PATHS_URL);
  const record = await authorSkill({ name: "readsrc-missing-snapshot", description: "Snapshot will be deleted out of band.", body: "# Body\n" });
  fs.rmSync(snapshotDir(record.snapshotId), { recursive: true, force: true });

  const reply = await core.handleEnvelope(agentSettingsEnvelope("skills_read_source", { name: "readsrc-missing-snapshot" }));
  assert(reply.ok === false, "a missing snapshot must not succeed");
  assert(reply.error.code === "NOT_FOUND", `expected NOT_FOUND, got ${reply.error.code}`);
  void removeSkill;
});

// --- Task 1.5: the change's security claim, enumerated from the source ---

await test("no operation _handleAgentSettings() accepts takes a filesystem path — enumerated from companion.js's own source", async () => {
  const companionSrc = fs.readFileSync(new URL("../agent/companion.js", import.meta.url), "utf-8");
  // Line endings are matched tolerantly on purpose: git normalises this
  // repo's checkout to CRLF on Windows, and a locator that hardcodes a bare
  // newline stops matching the moment that happens — silently turning this
  // whole assertion into a no-op instead of a failure anyone would notice.
  const handlerMatch = /_handleAgentSettings\(envelope\)\s*\{([\s\S]*?)\r?\n {2}\}\r?\n/.exec(companionSrc);
  assert(handlerMatch, "could not locate _handleAgentSettings()'s body in companion.js — has it moved/been renamed?");
  const body = handlerMatch[1];

  const opNames = [...body.matchAll(/case\s+"([a-z_]+)":/g)].map((m) => m[1]);
  assert(opNames.length > 5, `expected to find several op cases, found: ${JSON.stringify(opNames)}`);
  assert(!opNames.includes("skills_import"), "skills_import must not be a reachable op");
  assert(!opNames.includes("skills_refresh"), "skills_refresh must not be a reachable op");
  assert(opNames.includes("skills_read_source"), "skills_read_source must be reachable");

  const envelopeKeys = new Set([...body.matchAll(/envelope\.([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]));
  const pathShapedDenylist = ["sourceDir", "path", "dir", "folder", "file", "filePath", "sourcePath", "folderPath"];
  const hit = pathShapedDenylist.filter((k) => envelopeKeys.has(k));
  assert(hit.length === 0, `a path-shaped payload key is still read from the envelope: ${JSON.stringify(hit)} (full key set: ${JSON.stringify([...envelopeKeys])})`);
});

await test("skills_import and skills_refresh are unreachable at runtime (behavioral probe, paired with the source-level enumeration above)", async () => {
  freshHome();
  const core = buildCore();
  for (const op of ["skills_import", "skills_refresh"]) {
    const reply = await core.handleEnvelope(agentSettingsEnvelope(op, { sourceDir: "/tmp/whatever", name: "x" }));
    assert(reply.ok === false, `${op} must not succeed`);
    assert(reply.error.code === "PROTOCOL_ERROR", `${op} must fail as an unknown op, got ${reply.error.code}`);
  }
});

const failed = results.filter((r) => !r.ok);
console.log(
  `\n${results.length - failed.length}/${results.length} passed` +
    (failed.length ? `\n\nFailures:\n${failed.map((f) => `  - ${f.name}: ${f.err}`).join("\n")}` : "") +
    "\n"
);
process.exit(failed.length ? 1 : 0);
