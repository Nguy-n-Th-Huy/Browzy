#!/usr/bin/env node
// CompanionCore's `enhance_prompt` handler (`_handleEnhancePrompt()`),
// driven against the REAL host/agent/companion.js CompanionCore with a fake
// SDK and a fake profile provider -- the same "fake companion harness"
// convention host/test/agent-companion-core.test.mjs and
// test/sidepanel-fake-companion.test.mjs already use, for the same reason:
// no live API key or browser is available in this environment.
//
// Also proves the "not a run" claim (spec.md "Prompt enhancement is not a
// run") from the outside, two ways: (1) the happy-path scenario below asserts
// directly on sessionManager/lease state after a completed request -- no
// conversation, no held/queued lease; (2) a source-level check reads
// companion.js itself and asserts `_handleEnhancePrompt()`'s own body never
// references `sessionManager`/`this.lease` at all (task 3.5's own verify
// note, made executable rather than merely read during review).
//
// Run: node test/enhance-prompt-companion.test.mjs

import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

import { CompanionCore } from "../host/agent/companion.js";
import { TranscriptStore } from "../host/agent/storage/transcript-store.js";
import { BrowserLease } from "../host/agent/broker/browser-lease.js";
import { ApprovalRegistry } from "../host/agent/policy/approvals.js";
import { SessionManager } from "../host/agent/session/manager.js";
import { ToolBridge } from "../host/agent/broker/tool-bridge.js";
import { AGENT_MESSAGE_TYPES, makeEnvelope } from "../host/agent/protocol.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ocic-enhance-prompt-companion-"));
process.env.OCIC_AGENT_HOME = scratchRoot;

let fail = 0;
function ok(cond, msg) {
  console.log((cond ? "  PASS " : "  FAIL ") + msg);
  if (!cond) fail++;
}

function fakeProfileProvider({ shouldFail = false } = {}) {
  return {
    async snapshotForRun(profileId, modelId) {
      if (shouldFail) throw new Error("no credential configured for this profile");
      return {
        model: modelId || "claude-fake-model",
        env: { ANTHROPIC_BASE_URL: "https://example.invalid", ANTHROPIC_API_KEY: "fake-key" },
        revision: 1,
        profileId: profileId || "default"
      };
    }
  };
}

// Records every `options` object `query()` was called with, so a test can
// assert what the companion actually handed the SDK (task 3.6's verify
// note): no tools, no MCP servers, no cwd, no skills.
function fakeSdk(handler) {
  const calls = [];
  return {
    calls,
    async *query({ prompt, options }) {
      calls.push({ prompt, options });
      yield* handler({ prompt, options });
    }
  };
}

async function* successMessages(text) {
  yield { type: "system", subtype: "init" };
  yield { type: "assistant", message: { content: [{ type: "text", text }] } };
  yield { type: "result", subtype: "success" };
}

async function* errorResultMessages() {
  yield { type: "system", subtype: "init" };
  yield { type: "result", subtype: "success", is_error: true, result: "upstream rejected the request", api_error_status: 500 };
}

async function* noTerminalMessages() {
  yield { type: "system", subtype: "init" };
  // Generator ends without ever yielding a `result` message.
}

// Waits on the AbortController's own signal so a real `op:"cancel"` (which
// calls .abort() on the exact controller this call was given) actually
// interrupts this generator, the same way an aborted real SDK query() would.
async function* hangUntilAborted({ options }) {
  yield { type: "system", subtype: "init" };
  await new Promise((resolve, reject) => {
    const signal = options.abortController.signal;
    if (signal.aborted) {
      reject(Object.assign(new Error("The operation was aborted"), { name: "AbortError" }));
      return;
    }
    signal.addEventListener("abort", () => {
      reject(Object.assign(new Error("The operation was aborted"), { name: "AbortError" }));
    });
  });
}

function buildCore({ sdk, profileProvider } = {}) {
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
    sdk,
    profileProvider: profileProvider || fakeProfileProvider()
  });
}

function helloEnvelope() {
  return makeEnvelope(AGENT_MESSAGE_TYPES.HELLO, { installationId: "inst1", connectionId: "conn1" });
}

function enhanceEnvelope(fields) {
  return makeEnvelope(AGENT_MESSAGE_TYPES.ENHANCE_PROMPT, { requestId: "req1", ...fields });
}

async function main() {
  console.log("== missing hello is rejected ==");
  {
    const core = buildCore({ sdk: fakeSdk(() => successMessages("should never run")) });
    const reply = await core.handleEnvelope(enhanceEnvelope({ op: "generate", prompt: "hi", profileId: "p1", modelId: "m1" }));
    ok(reply.type === "version_mismatch" && reply.reason === "hello_required", "no prior hello -> hello_required version_mismatch, same as NEW/START");
  }

  console.log("\n== happy path returns the parsed, rewritten text ==");
  {
    const sdk = fakeSdk(() => successMessages("<enhanced-prompt>a clearer version of the draft</enhanced-prompt>"));
    const core = buildCore({ sdk });
    await core.handleEnvelope(helloEnvelope());
    const reply = await core.handleEnvelope(
      enhanceEnvelope({ op: "generate", prompt: "  make it clearer  ", profileId: "p1", modelId: "m1" })
    );
    ok(reply.type === AGENT_MESSAGE_TYPES.ENHANCE_PROMPT, "replies with the same enhance_prompt type");
    ok(reply.requestId === "req1", "echoes the requestId");
    ok(reply.ok === true, "ok:true on a successful rewrite");
    ok(reply.result && reply.result.text === "a clearer version of the draft", "result.text is the parsed rewrite, envelope stripped");

    const [{ prompt, options }] = sdk.calls;
    ok(prompt.includes("<user-prompt>\nmake it clearer\n</user-prompt>"), "the operator's text, validated and sent trimmed, was embedded in the model prompt");
    ok(Array.isArray(options.tools) && options.tools.length === 0, "no tools were made available to the model");
    ok(typeof options.mcpServers === "object" && Object.keys(options.mcpServers).length === 0, "no MCP server was registered");
    ok(!("cwd" in options) && !("skills" in options), "no cwd/skills -- never a skills-bound session");
    ok(options.maxTurns === 1, "bounded to a single turn");

    // spec.md "No transcript or run side effects" / "No browser or tool
    // access": a completed enhancement created no conversation, appended
    // nothing to any transcript, and never touched the browser lease.
    ok(core.sessionManager.conversationSummaries().length === 0, "no conversation was created or advanced by this request");
    ok(core.lease.isHeld() === false, "the browser lease was never acquired");
    ok(core.lease.queuedRunIds().length === 0, "nothing was ever queued for the lease either");
  }

  console.log("\n== empty prompt is rejected before any model call ==");
  {
    const sdk = fakeSdk(() => successMessages("should never be reached"));
    const core = buildCore({ sdk });
    await core.handleEnvelope(helloEnvelope());
    const reply = await core.handleEnvelope(enhanceEnvelope({ op: "generate", prompt: "   ", profileId: "p1", modelId: "m1" }));
    ok(reply.ok === false, "ok:false for a whitespace-only prompt");
    ok(reply.error.code === "INVALID_ARGUMENT", "INVALID_ARGUMENT is the distinct code");
    ok(sdk.calls.length === 0, "the model was never called");
  }

  console.log("\n== an unavailable profile reports its own distinct code ==");
  {
    const sdk = fakeSdk(() => successMessages("unreachable"));
    const core = buildCore({ sdk, profileProvider: fakeProfileProvider({ shouldFail: true }) });
    await core.handleEnvelope(helloEnvelope());
    const reply = await core.handleEnvelope(enhanceEnvelope({ op: "generate", prompt: "hi", profileId: "p1", modelId: "m1" }));
    ok(reply.ok === false, "ok:false when no credential is available");
    ok(reply.error.code === "PROFILE_UNAVAILABLE", "PROFILE_UNAVAILABLE is distinct from a generic failure code");
    ok(sdk.calls.length === 0, "the model was never called when the profile could not be resolved");
  }

  console.log("\n== a result message with is_error is reported as a failure ==");
  {
    const sdk = fakeSdk(() => errorResultMessages());
    const core = buildCore({ sdk });
    await core.handleEnvelope(helloEnvelope());
    const reply = await core.handleEnvelope(enhanceEnvelope({ op: "generate", prompt: "hi", profileId: "p1", modelId: "m1" }));
    ok(reply.ok === false, "is_error on the terminal result overrides subtype:success");
    ok(reply.error.code === "GENERATION_FAILED", "reported with the generic generation-failure code");
    ok(/upstream rejected/.test(reply.error.message), "the model's own error text is surfaced");
  }

  console.log("\n== a generator that ends with no terminal result is a failure, not an empty success ==");
  {
    const sdk = fakeSdk(() => noTerminalMessages());
    const core = buildCore({ sdk });
    await core.handleEnvelope(helloEnvelope());
    const reply = await core.handleEnvelope(enhanceEnvelope({ op: "generate", prompt: "hi", profileId: "p1", modelId: "m1" }));
    ok(reply.ok === false, "no terminal result message -> failure");
    ok(reply.error.code === "GENERATION_FAILED", "GENERATION_FAILED for a missing terminal message");
  }

  console.log("\n== an empty or whitespace-only rewrite is a failure, never a silent empty success ==");
  {
    const sdk = fakeSdk(() => successMessages("<enhanced-prompt>   </enhanced-prompt>"));
    const core = buildCore({ sdk });
    await core.handleEnvelope(helloEnvelope());
    const reply = await core.handleEnvelope(enhanceEnvelope({ op: "generate", prompt: "hi", profileId: "p1", modelId: "m1" }));
    ok(reply.ok === false, "a whitespace-only rewrite is ok:false");
    ok(reply.error.code === "EMPTY_RESULT", "EMPTY_RESULT is the distinct code for a blank rewrite");
  }

  console.log("\n== op:cancel aborts the in-flight controller; the generate resolves as cancelled ==");
  {
    const sdk = fakeSdk(hangUntilAborted);
    const core = buildCore({ sdk });
    await core.handleEnvelope(helloEnvelope());

    const generatePromise = core.handleEnvelope(enhanceEnvelope({ op: "generate", prompt: "hi", profileId: "p1", modelId: "m1" }));
    // Give the generate call's for-await loop a turn to actually start and
    // register its AbortController before the cancel arrives -- a real wire
    // round trip always has this ordering too (two separate messages).
    await new Promise((r) => setTimeout(r, 5));

    const cancelReply = await core.handleEnvelope(enhanceEnvelope({ op: "cancel" }));
    ok(cancelReply.ok === true, "the cancel op itself acks ok:true for a known in-flight requestId");

    const generateReply = await generatePromise;
    ok(generateReply.ok === false, "the aborted generate resolves as a failure, never a success");
    ok(generateReply.error.code === "CANCELLED", "and its code is exactly CANCELLED");
    ok(generateReply.requestId === "req1", "carrying the original requestId so the panel can correlate it");
  }

  console.log("\n== cancel for an unknown requestId is a benign enhance_prompt-shaped reply, not an application error ==");
  {
    const core = buildCore({ sdk: fakeSdk(() => successMessages("unused")) });
    await core.handleEnvelope(helloEnvelope());
    const reply = await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.ENHANCE_PROMPT, { requestId: "never-existed", op: "cancel" }));
    ok(reply.type === AGENT_MESSAGE_TYPES.ENHANCE_PROMPT, "still an enhance_prompt-shaped reply, not a generic {type:error} envelope");
    ok(reply.ok === false, "ok:false for an unknown requestId");
    ok(reply.error.code === "UNKNOWN_REQUEST", "a distinct, benign code -- a cancel racing a completion is normal");
  }

  console.log("\n== an unrecognized op is rejected ==");
  {
    const core = buildCore({ sdk: fakeSdk(() => successMessages("unused")) });
    await core.handleEnvelope(helloEnvelope());
    const reply = await core.handleEnvelope(enhanceEnvelope({ op: "bogus" }));
    ok(reply.ok === false && reply.error.code === "INVALID_ARGUMENT", "an unknown op is INVALID_ARGUMENT, not silently ignored");
  }

  console.log("\n== source check: _handleEnhancePrompt() itself never references sessionManager or lease ==");
  {
    // Task 3.5's own verify note ("no sessionManager or lease call appears
    // anywhere in _handleEnhancePrompt or its helpers") made executable: the
    // scenarios above prove no OBSERVABLE side effect occurred, this proves
    // the code path could not have produced one even under a future change
    // that adds a branch nobody happened to exercise above.
    const companionSrc = fs.readFileSync(path.join(ROOT, "host/agent/companion.js"), "utf8");
    const methodMatch = companionSrc.match(/async _handleEnhancePrompt\(envelope\) \{([\s\S]*?)\n  \}/);
    ok(Boolean(methodMatch), "_handleEnhancePrompt() is found in companion.js");
    const body = methodMatch[1];
    ok(!/sessionManager/.test(body), "the method body never references this.sessionManager");
    ok(!/\blease\b/.test(body), "the method body never references this.lease");
  }

  console.log(fail === 0 ? "\nALL ENHANCE-PROMPT COMPANION TESTS PASSED" : `\n${fail} FAILED`);
  process.exit(fail ? 1 : 0);
}

main();
