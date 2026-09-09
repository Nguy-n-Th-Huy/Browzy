#!/usr/bin/env node
// repair-slash-dispatch-and-builtin-commands, tasks.md 2.4: CompanionCore's
// new read-only `agent_settings` op ("get_advertised_commands") that serves
// the persisted advertised-command record to the panel. Drives the REAL
// `_handleAgentSettings()` switch through `handleEnvelope()` — the same
// envelope shape/`ok(result)`/`fail(code,message)` conventions every other
// agent_settings op in that switch already follows — rather than calling
// any private method directly.
//
// Mirrors host/test/agent-skills-ops.test.mjs's own envelope-construction
// helper and "fresh OCIC_AGENT_HOME/OCIC_AGENT_CONFIG_DIR per case" isolation
// convention.
//
// Run: node test/companion-advertised-commands-op.test.mjs

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { CompanionCore } from "../host/agent/companion.js";
import { TranscriptStore } from "../host/agent/storage/transcript-store.js";
import { BrowserLease } from "../host/agent/broker/browser-lease.js";
import { ApprovalRegistry } from "../host/agent/policy/approvals.js";
import { SessionManager } from "../host/agent/session/manager.js";
import { ToolBridge } from "../host/agent/broker/tool-bridge.js";
import { AGENT_MESSAGE_TYPES, PROTOCOL_VERSION, makeEnvelope } from "../host/agent/protocol.js";
import { recordAdvertisedCommands, readAdvertisedCommands } from "../host/agent/settings/advertised-commands.js";

let fail = 0;
function ok(cond, msg) {
  console.log((cond ? "  PASS " : "  FAIL ") + msg);
  if (!cond) fail++;
}

let _reqId = 0;
function agentSettingsEnvelope(op, payload = {}, { v = PROTOCOL_VERSION, requestId = `req_${++_reqId}` } = {}) {
  return { v, type: AGENT_MESSAGE_TYPES.AGENT_SETTINGS, requestId, op, ...payload };
}

function freshHome() {
  const agentHome = fs.mkdtempSync(path.join(os.tmpdir(), "ocic-companion-advertised-agent-"));
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "ocic-companion-advertised-config-"));
  process.env.OCIC_AGENT_HOME = agentHome;
  process.env.OCIC_AGENT_CONFIG_DIR = configDir;
  return agentHome;
}

function buildCore({ sdk, profileProvider } = {}) {
  const store = new TranscriptStore();
  const lease = new BrowserLease();
  const approvals = new ApprovalRegistry();
  const sessionManager = new SessionManager({ store, lease, approvals });
  const toolBridge = new ToolBridge({ init: async () => {}, callTool: async () => ({ content: [] }), shutdown: () => {} });
  return new CompanionCore({ toolBridge, sessionManager, lease, coerceArgs: (a) => a, sdk, profileProvider });
}

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

async function main() {
  console.log("== get_advertised_commands: no record yet -> ok:true, result:null (never an error) ==");
  {
    freshHome();
    const core = buildCore();
    const reply = await core.handleEnvelope(agentSettingsEnvelope("get_advertised_commands"));
    ok(reply.type === AGENT_MESSAGE_TYPES.AGENT_SETTINGS, "replies with the agent_settings envelope type, like every other op");
    ok(reply.ok === true, "a missing record is ok:true — a normal first-run state, not a protocol error");
    ok(reply.result === null, "result is null when nothing has ever been observed");
  }

  console.log("\n== get_advertised_commands: an existing record is served verbatim ==");
  {
    freshHome();
    recordAdvertisedCommands({ commands: ["cost", "compact"], terminalCommands: ["compact"] });
    const core = buildCore();
    const reply = await core.handleEnvelope(agentSettingsEnvelope("get_advertised_commands"));
    ok(reply.ok === true, "ok:true when a record exists");
    ok(
      JSON.stringify(reply.result.commands) === JSON.stringify(["cost", "compact"]) &&
        JSON.stringify(reply.result.terminalCommands) === JSON.stringify(["compact"]),
      `the persisted record is served as-is — got ${JSON.stringify(reply.result)}`
    );
  }

  console.log("\n== get_advertised_commands: requestId is echoed, exactly like every other agent_settings op ==");
  {
    freshHome();
    const core = buildCore();
    const reply = await core.handleEnvelope(agentSettingsEnvelope("get_advertised_commands", {}, { requestId: "op-echo-check" }));
    ok(reply.requestId === "op-echo-check", "the reply carries back the same requestId the request sent");
  }

  console.log("\n== the op is read-only: it accepts no mutating fields and never writes a new record ==");
  {
    freshHome();
    const core = buildCore();
    // A malicious/careless caller sending extra fields must not be able to
    // smuggle a write through this op — it is documented read-only
    // (design.md decision 5: "mutating the record from the panel is not
    // offered").
    await core.handleEnvelope(agentSettingsEnvelope("get_advertised_commands", { commands: ["should-not-be-written"] }));
    const after = await core.handleEnvelope(agentSettingsEnvelope("get_advertised_commands"));
    ok(after.result === null, "no record was created by a get_advertised_commands call carrying extra fields");
  }

  console.log("\n== an unrecognized op is still rejected the existing way (this op did not loosen the default branch) ==");
  {
    freshHome();
    const core = buildCore();
    const reply = await core.handleEnvelope(agentSettingsEnvelope("not_a_real_op"));
    ok(reply.ok === false && reply.error.code === "PROTOCOL_ERROR", "unknown ops are still PROTOCOL_ERROR");
  }

  console.log("\n== tasks.md 2.2: an ordinary conversation run's system/init message is recorded via _runQuery()'s message loop ==");
  {
    freshHome();
    ok(readAdvertisedCommands() === null, "nothing recorded before this run");

    const sdk = {
      async *query() {
        yield { type: "system", subtype: "init", slash_commands: ["cost", "clear"], terminal_slash_commands: ["clear"] };
        yield { type: "assistant", message: { content: [{ type: "text", text: "ok" }] } };
        yield { type: "result", subtype: "success" };
      }
    };
    const core = buildCore({ sdk, profileProvider: fakeProfileProvider() });
    await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.HELLO, {}));
    const { conversationId } = await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.NEW, {}));
    await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.START, { conversationId, prompt: "hi there" }));
    await waitForEvent(core, conversationId, (e) => e.type === "run_done");

    const record = readAdvertisedCommands();
    ok(record !== null, "an ordinary (non-slash) run still observes and records the init message");
    ok(
      JSON.stringify(record.commands) === JSON.stringify(["cost", "clear"]),
      `the exact slash_commands from this run's init message were recorded — got ${JSON.stringify(record.commands)}`
    );

    // Reply picked up by the NEXT dispatch on this same companion, no
    // restart required (design.md decision 4's own point).
    const reply = await core.handleEnvelope(agentSettingsEnvelope("get_advertised_commands"));
    ok(reply.ok === true && JSON.stringify(reply.result.commands) === JSON.stringify(["cost", "clear"]), "the freshly-recorded list is immediately servable through the read-only op");
  }

  console.log("\n== tasks.md 2.2's own verify note: a record WRITE FAILURE never changes the run's outcome ==");
  {
    // A surgical, real (not mocked) write failure that hits ONLY
    // recordAdvertisedCommands()'s own file, not the rest of agentRoot():
    // pre-create the exact path writeJsonAtomic() would rename onto
    // ("slash-commands.json") as a DIRECTORY instead of the JSON file it
    // expects. mkdirSync(dir, ...) at the top of writeJsonAtomic() still
    // succeeds (agentRoot() itself is a perfectly normal directory, so
    // conversation/session storage under the SAME root is completely
    // unaffected), but the final `fs.renameSync(tempPath, filePath)` fails
    // because you cannot rename a file onto an existing directory.
    const agentHome = freshHome();
    fs.mkdirSync(path.join(agentHome, "slash-commands.json"));

    const sdk = {
      async *query() {
        yield { type: "system", subtype: "init", slash_commands: ["cost"], terminal_slash_commands: [] };
        yield { type: "assistant", message: { content: [{ type: "text", text: "ok despite the write failure" }] } };
        yield { type: "result", subtype: "success" };
      }
    };
    const core = buildCore({ sdk, profileProvider: fakeProfileProvider() });
    await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.HELLO, {}));
    const { conversationId } = await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.NEW, {}));
    await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.START, { conversationId, prompt: "hi there" }));
    const runDone = await waitForEvent(core, conversationId, (e) => e.type === "run_done");
    const runError = core.sessionManager.snapshotSince(conversationId, 0).events.find((e) => e.type === "run_error");

    ok(runDone !== undefined, "the run still completes with run_done even though the record write underneath it fails");
    ok(runError === undefined, "no run_error was emitted because of the record write failure — it is swallowed, not surfaced");
    const streamed = core.sessionManager.snapshotSince(conversationId, 0).events.filter((e) => e.type === "stream_message");
    ok(streamed.length === 3, `every SDK message (init/assistant/result) was still streamed to the panel — got ${streamed.length}`);
  }

  console.log(fail === 0 ? "\nALL COMPANION ADVERTISED-COMMANDS OP TESTS PASSED" : `\n${fail} FAILED`);
  process.exit(fail ? 1 : 0);
}

main();
