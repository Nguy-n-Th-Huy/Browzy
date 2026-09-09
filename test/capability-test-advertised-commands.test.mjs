#!/usr/bin/env node
// repair-slash-dispatch-and-builtin-commands, tasks.md 2.3 / specs/agent-skills/spec.md
// "Recorded from a connection test": host/agent/settings/capability-test.js's
// `runSubTest()` must persist the SDK's advertised slash-command list the
// moment it observes a `system`/`init` message — the Settings connection
// test is one of the two real places this product ever starts a `query()`,
// and normally the FIRST one an installation ever runs, so this is how a
// fresh install gets its first record before any conversation has run.
//
// Deliberately does NOT spawn the real bundled CLI (host/test/settings-capability-test.test.mjs
// already covers the real-SDK/real-fixture-server path for the capability
// test's own classification logic) — a fake `sdk.query()` async generator is
// enough to prove THIS specific wiring, and keeps this file fast and fully
// isolated (a real-CLI run's own init message would otherwise write into
// this machine's real per-user config directory, since capability-test.js's
// existing test file sets no OCIC_AGENT_HOME).
//
// Run: node test/capability-test-advertised-commands.test.mjs

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runCapabilityTest } from "../host/agent/settings/capability-test.js";
import { readAdvertisedCommands } from "../host/agent/settings/advertised-commands.js";

let fail = 0;
function ok(cond, msg) {
  console.log((cond ? "  PASS " : "  FAIL ") + msg);
  if (!cond) fail++;
}

function freshHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocic-capability-test-advertised-"));
  process.env.OCIC_AGENT_HOME = dir;
  return dir;
}

// Ends the capability test after sub-test 1 (endpointBroken=true skips the
// tool/vision sub-tests) so this fake never needs to satisfy the
// fixture-tool-round-trip or vision sub-test's own message shapes — only
// the init branch under test needs a real message.
function fakeSdk(messages) {
  return {
    async *query() {
      for (const m of messages) yield m;
    }
  };
}

console.log("== the connection test's init message is recorded before the run completes/fails ==");
{
  freshHome();
  ok(readAdvertisedCommands() === null, "nothing recorded yet in this fresh home");

  const sdk = fakeSdk([
    { type: "system", subtype: "init", slash_commands: ["cost", "compact", "clear"], terminal_slash_commands: ["clear"] },
    { type: "result", subtype: "success", is_error: true, api_error_status: 500, result: "synthetic endpoint failure" }
  ]);

  const result = await runCapabilityTest({
    baseUrl: "https://example.invalid",
    apiKey: "fake-key",
    modelId: "fake-model",
    sdk,
    z: undefined, // never reached: the synthetic failure below short-circuits before the tool sub-test would need it
    startupBudgetMs: 5_000,
    testBudgetMs: 5_000
  });
  ok(result.status === "fail", "the synthetic endpoint failure is still classified as a failed capability test");

  const record = readAdvertisedCommands();
  ok(record !== null, "the advertised-command record exists after the connection test, even though the test itself FAILED");
  ok(
    JSON.stringify(record.commands) === JSON.stringify(["cost", "compact", "clear"]),
    `the exact slash_commands from the init message were recorded — got ${JSON.stringify(record.commands)}`
  );
  ok(
    JSON.stringify(record.terminalCommands) === JSON.stringify(["clear"]),
    `terminal_slash_commands was recorded as terminalCommands — got ${JSON.stringify(record.terminalCommands)}`
  );
}

console.log("\n== an init message carrying no slash_commands field records nothing (never throws) ==");
{
  freshHome();
  const sdk = fakeSdk([
    { type: "system", subtype: "init" }, // older/bare init shape, no slash_commands at all
    { type: "result", subtype: "success", is_error: true, api_error_status: 500, result: "synthetic endpoint failure" }
  ]);
  const result = await runCapabilityTest({
    baseUrl: "https://example.invalid",
    apiKey: "fake-key",
    modelId: "fake-model",
    sdk,
    z: undefined,
    startupBudgetMs: 5_000,
    testBudgetMs: 5_000
  });
  ok(result.status === "fail", "still classifies the synthetic failure correctly");
  ok(readAdvertisedCommands() === null, "no record is written when the init message carries no slash_commands array");
}

console.log("\n== tasks.md 2.3's own swallow-on-failure rule: a record write failure never fails the connection test ==");
{
  // Same surgical, real write-failure trigger as
  // test/companion-advertised-commands-op.test.mjs's tasks.md 2.2 coverage:
  // pre-create the exact "slash-commands.json" path as a directory, so
  // writeJsonAtomic()'s final rename fails while agentRoot() itself (and
  // therefore everything else under it) stays a completely normal,
  // writable directory.
  const agentHome = freshHome();
  fs.mkdirSync(path.join(agentHome, "slash-commands.json"));

  // Same synthetic-failure message shape as the first scenario above
  // (endpointBroken=true stops runCapabilityTest after sub-test 1, so this
  // fake needs no working tool/createSdkMcpServer — only sub-test 1's own
  // init-branch recording call is under test here).
  const sdk = fakeSdk([
    { type: "system", subtype: "init", slash_commands: ["cost"], terminal_slash_commands: [] },
    { type: "result", subtype: "success", is_error: true, api_error_status: 500, result: "synthetic endpoint failure" }
  ]);
  let threw = null;
  let result;
  try {
    result = await runCapabilityTest({
      baseUrl: "https://example.invalid",
      apiKey: "fake-key",
      modelId: "fake-model",
      sdk,
      z: undefined,
      startupBudgetMs: 5_000,
      testBudgetMs: 5_000
    });
  } catch (err) {
    threw = err;
  }
  ok(threw === null, `runCapabilityTest() must not throw because of the record write failure underneath it — got ${threw && threw.message}`);
  ok(result && result.status === "fail", "the connection test still resolves and classifies the (unrelated, synthetic) endpoint failure normally");
}

console.log(fail === 0 ? "\nALL CAPABILITY-TEST ADVERTISED-COMMANDS TESTS PASSED" : `\n${fail} FAILED`);
process.exit(fail ? 1 : 0);
