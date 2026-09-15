#!/usr/bin/env node
//
// User-mediated upload grants (protocol.js's upload_grant): the operator's own
// file picker is the ONLY thing that can put a local path into a run's
// RunUploadAllowlist, and that grant is what lets file_upload reach a page
// (host/agent/policy/authorization.js).
//
// Proven against the REAL host/agent/companion.js (fake sdk/profileProvider,
// scratch OCIC_AGENT_HOME — the same harness agent-context-channel.test.mjs
// uses):
//   1. A grant is validated against the real filesystem before it is accepted;
//      a missing path or a directory is REPORTED as skipped, never silently
//      granted.
//   2. The next run of that conversation carries the granted path into
//      query()'s systemPrompt (the model must know the exact path to pass to
//      file_upload).
//   3. That same run's allowlist authorizes file_upload for the granted path —
//      and still refuses every other path, in full.
//   4. A revoke removes both the prompt entry and the authorization.
//   5. Deleting the conversation drops its grants (nothing outlives it in a
//      long-lived companion process).
//
// Run: node host/test/agent-upload-grants.test.mjs

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { CompanionCore } from "../agent/companion.js";
import { TranscriptStore } from "../agent/storage/transcript-store.js";
import { BrowserLease } from "../agent/broker/browser-lease.js";
import { ApprovalRegistry } from "../agent/policy/approvals.js";
import { SessionManager } from "../agent/session/manager.js";
import { ToolBridge } from "../agent/broker/tool-bridge.js";
import { authorizeToolCall } from "../agent/policy/authorization.js";
import {
  AGENT_MESSAGE_TYPES,
  makeEnvelope,
  validateUploadGrantPaths,
  UPLOAD_GRANT_MAX_PATHS
} from "../agent/protocol.js";
import { renderUploadGrantsSystemPrompt } from "../agent/tools/query-options.js";

const scratchHome = fs.mkdtempSync(path.join(os.tmpdir(), "ocic-upload-grants-"));
process.env.OCIC_AGENT_HOME = scratchHome;

const results = [];
async function test(name, fn) {
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

// --- fixtures ---------------------------------------------------------------

const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "ocic-upload-fixtures-"));
const goodFile = path.join(fixtureDir, "report.pdf");
const otherFile = path.join(fixtureDir, "never-shared.txt");
const aDirectory = path.join(fixtureDir, "a-directory");
const missingPath = path.join(fixtureDir, "does-not-exist.bin");
fs.writeFileSync(goodFile, "pdf-ish bytes");
fs.writeFileSync(otherFile, "not shared");
fs.mkdirSync(aDirectory);

function fakeProfileProvider() {
  return {
    async snapshotForRun(profileId, modelId) {
      return {
        model: modelId || "claude-fake-model",
        env: { ANTHROPIC_BASE_URL: "https://example.invalid", ANTHROPIC_API_KEY: "fake-key" },
        revision: 1,
        profileId: profileId || "default"
      };
    }
  };
}

/** Records every query() call; onQuery() runs while the run is still live. */
function recordingSdk({ onQuery } = {}) {
  const calls = [];
  const sdk = {
    async *query({ prompt, options }) {
      calls.push({ prompt, options });
      if (onQuery) onQuery();
      yield { type: "assistant", text: "ok" };
    }
  };
  return { sdk, calls };
}

function buildCore({ sdk } = {}) {
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
    sdk: sdk || recordingSdk().sdk,
    profileProvider: fakeProfileProvider()
  });
}

async function waitForEvent(core, conversationId, predicate, { timeoutMs = 3000 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const snap = core.sessionManager.snapshotSince(conversationId, 0);
    const found = snap.events.find(predicate);
    if (found) return found;
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error("timed out waiting for expected event");
}

/** A fresh, handshaked core plus its first conversation. */
async function newConversationCore({ sdk } = {}) {
  const core = buildCore({ sdk });
  await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.HELLO, {}));
  const { conversationId } = await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.NEW, {}));
  return { core, conversationId };
}

/** Send one grant/revoke and return the companion's reply. */
function grant(core, conversationId, { op = "grant", paths, requestId = `req_${Math.random().toString(36).slice(2, 8)}` }) {
  return core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.UPLOAD_GRANT, { conversationId, op, paths, requestId }));
}

/** The authorizeToolCall context a live run's handler side would build. */
function uploadContext(uploadAllowlist, paths) {
  return {
    toolName: "file_upload",
    args: { paths, ref: "ref_1", tabId: 7 },
    runState: "running",
    leaseHeldByThisRun: true,
    tabScope: "any",
    uploadAllowlist,
    knownToolNames: new Set(["file_upload"])
  };
}

function refusalFor(fn) {
  try {
    fn();
  } catch (e) {
    return e;
  }
  return null;
}

console.log("\nUpload grants: wire validation and the system-prompt section\n");

await test("validateUploadGrantPaths accepts absolute POSIX/Windows/UNC paths and rejects everything else", () => {
  assert(validateUploadGrantPaths(["/home/me/a.txt"]).ok === true, "POSIX absolute path");
  assert(validateUploadGrantPaths(["C:\\\\Users\\\\me\\\\a.txt"]).ok === true, "Windows drive path");
  assert(validateUploadGrantPaths(["\\\\\\\\server\\\\share\\\\a.txt"]).ok === true, "UNC path");
  for (const bad of [[], null, "not-an-array", [123], [""], ["relative.txt"], ["./x"], ["C:relative"]]) {
    assert(validateUploadGrantPaths(bad).ok === false, `must reject ${JSON.stringify(bad)}`);
  }
  const many = Array.from({ length: UPLOAD_GRANT_MAX_PATHS + 1 }, (_, i) => `/tmp/f${i}`);
  assert(validateUploadGrantPaths(many).ok === false, "an unbounded list is rejected before any filesystem work");
});

await test("renderUploadGrantsSystemPrompt is null with no grants, and names each path when there are some", () => {
  assert(renderUploadGrantsSystemPrompt(null) === null, "no grants -> no section at all");
  assert(renderUploadGrantsSystemPrompt([]) === null, "an empty list is the same as none");
  const text = renderUploadGrantsSystemPrompt([goodFile]);
  assert(/## Files the user shared for upload/.test(text), "the section heading");
  assert(text.includes(goodFile), "the exact path the model must pass to file_upload");
});

console.log("\nUpload grants: companion behaviour\n");

await test("a grant is checked against the real filesystem; good paths are granted, others are reported skipped", async () => {
  const { core, conversationId } = await newConversationCore();
  const reply = await grant(core, conversationId, { paths: [goodFile, missingPath, aDirectory] });

  assert(reply.ok === true && reply.result, `expected a successful reply, got ${JSON.stringify(reply)}`);
  assert(reply.result.granted.length === 1 && reply.result.granted[0] === goodFile, "the existing file is granted");
  const byPath = new Map(reply.result.skipped.map((s) => [s.path, s.reason]));
  assert(byPath.get(missingPath) === "not_found", `missing path reason: ${JSON.stringify(reply.result.skipped)}`);
  assert(byPath.get(aDirectory) === "not_a_file", `directory reason: ${JSON.stringify(reply.result.skipped)}`);
});

await test("the granted path reaches the next run's systemPrompt — and the skipped ones do not", async () => {
  const { sdk, calls } = recordingSdk();
  const { core, conversationId } = await newConversationCore({ sdk });
  await grant(core, conversationId, { paths: [goodFile, missingPath] });

  await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.START, { conversationId, prompt: "upload it" }));
  await waitForEvent(core, conversationId, (e) => e.type === "run_done");

  const prompt = calls[0].options.systemPrompt.prompt;
  assert(prompt.includes("## Files the user shared for upload"), "the section is present");
  assert(prompt.includes(goodFile), "the granted path is named");
  assert(!prompt.includes(missingPath), "a path that was never granted is not advertised to the model");
});

await test("file_upload is authorized for the granted path in that run — and refused in full for any other", async () => {
  let liveRun = null;
  const { sdk } = recordingSdk({
    onQuery: () => {
      liveRun = holder.core.sessionManager.activeRun(holder.conversationId);
    }
  });
  const holder = await newConversationCore({ sdk });
  await grant(holder.core, holder.conversationId, { paths: [goodFile] });

  await holder.core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.START, { conversationId: holder.conversationId, prompt: "go" }));
  await waitForEvent(holder.core, holder.conversationId, (e) => e.type === "run_done");
  assert(liveRun, "the run was captured while it was live");

  authorizeToolCall(uploadContext(liveRun.uploadAllowlist, [goodFile])); // must not throw

  const single = refusalFor(() => authorizeToolCall(uploadContext(liveRun.uploadAllowlist, [otherFile])));
  assert(single && single.reason === "path_not_allowlisted", `an unshared path must be refused, got ${single && single.reason}`);

  const mixed = refusalFor(() => authorizeToolCall(uploadContext(liveRun.uploadAllowlist, [goodFile, otherFile])));
  assert(mixed && mixed.reason === "path_not_allowlisted", "a mixed call is refused IN FULL, never partially dispatched");
});

await test("revoking removes both the prompt entry and the authorization", async () => {
  let liveRun = null;
  const { sdk, calls } = recordingSdk({ onQuery: () => { liveRun = holder.core.sessionManager.activeRun(holder.conversationId); } });
  const holder = await newConversationCore({ sdk });

  await grant(holder.core, holder.conversationId, { paths: [goodFile] });
  const revoked = await grant(holder.core, holder.conversationId, { op: "revoke", paths: [goodFile] });
  assert(revoked.ok === true && revoked.result.revoked.length === 1, `expected a revoke confirmation, got ${JSON.stringify(revoked)}`);

  await holder.core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.START, { conversationId: holder.conversationId, prompt: "again" }));
  await waitForEvent(holder.core, holder.conversationId, (e) => e.type === "run_done");

  assert(!calls[0].options.systemPrompt.prompt.includes("## Files the user shared for upload"), "a fully revoked conversation advertises no shared files");
  const refusal = refusalFor(() => authorizeToolCall(uploadContext(liveRun.uploadAllowlist, [goodFile])));
  assert(refusal && refusal.reason === "path_not_allowlisted", `a revoked path must be refused again, got ${refusal && refusal.reason}`);
});

await test("malformed grants and unknown conversations are refused with a reason — never silently accepted", async () => {
  const { core, conversationId } = await newConversationCore();

  const badOp = await grant(core, conversationId, { op: "delete", paths: [goodFile] });
  assert(badOp.ok === false && badOp.error.code === "PROTOCOL_ERROR", "an unknown op is refused");

  const relative = await grant(core, conversationId, { paths: ["relative.txt"] });
  assert(relative.ok === false && relative.error.code === "PROTOCOL_ERROR", "a relative path is refused before any filesystem work");

  const unknown = await grant(core, "conv_that_never_existed", { paths: [goodFile] });
  assert(unknown.ok === false && unknown.error.code === "NOT_FOUND", "an unknown conversation is refused");
});

await test("deleting the conversation drops its grants with it", async () => {
  const { core, conversationId } = await newConversationCore();
  await grant(core, conversationId, { paths: [goodFile] });
  assert(core._uploadGrantsByConversation.has(conversationId), "the grant is held while the conversation lives");

  await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.DELETE_CONVERSATION, { conversationId }));
  assert(!core._uploadGrantsByConversation.has(conversationId), "and it is gone with the conversation");
});

fs.rmSync(scratchHome, { recursive: true, force: true });
fs.rmSync(fixtureDir, { recursive: true, force: true });

const failed = results.filter((r) => !r.ok);
console.log(
  `\n${results.length - failed.length}/${results.length} passed` +
    (failed.length ? `\n\nFailures:\n${failed.map((f) => `  - ${f.name}: ${f.err}`).join("\n")}` : "") +
    "\n"
);
process.exit(failed.length ? 1 : 0);
