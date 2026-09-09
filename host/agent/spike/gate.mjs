#!/usr/bin/env node
// Single entrypoint for the SDK integration acceptance gate (tasks.md group
// 1, tasks 1.1-1.6). Runs every gate that is implementable offline for real,
// and reports every gate that genuinely needs a live browser and/or a live
// Anthropic-compatible endpoint as BLOCKED with the exact command to close
// it — it never fakes, mocks, or stubs a live result.
//
// Usage:
//   node host/agent/spike/gate.mjs            # offline gates only (default)
//   node host/agent/spike/gate.mjs --live      # also attempt live-dependent
//                                               # sub-items (still reports
//                                               # BLOCKED for anything that
//                                               # needs infra this invocation
//                                               # does not have, e.g. no
//                                               # browser attached)
//
// Each gate runs in its OWN child process (never a shared dynamic import —
// see lib/cli-runner.mjs's header comment for why: Node's ESM module cache
// is keyed by resolved file URL for the whole process, so a second gate's
// `import("../../../tool-runtime.js")` inside the SAME process would
// silently reuse the FIRST gate's already-initialized module — still bound
// to the first gate's scratch pipe. This was caught empirically while
// building this spike (gate 1.5's reconnect test hung when run in-process
// after gate 1.2, and passed once each got its own process) and is the
// reason for the extra process-per-gate plumbing here.

import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOST_ROOT = path.join(HERE, "..", "..");
const live = process.argv.includes("--live");

const GATES = [
  { file: path.join(HERE, "gates", "gate-1.2-mcp-tools.mjs"), id: "1.2" },
  { file: path.join(HERE, "gates", "gate-1.4-isolation.mjs"), id: "1.4" },
  { file: path.join(HERE, "gates", "gate-1.6-onboarding.mjs"), id: "1.6" },
  { file: path.join(HERE, "gates", "gate-1.5-cancel-reconnect.mjs"), id: "1.5" },
  { file: path.join(HERE, "gates", "gate-1.3-vision.mjs"), id: "1.3" }
];

const MARKER_START = "===GATE_RESULT_JSON_START===";
const MARKER_END = "===GATE_RESULT_JSON_END===";

function printVersions() {
  const sdkPkgPath = path.join(HOST_ROOT, "node_modules", "@anthropic-ai", "claude-agent-sdk", "package.json");
  const sdkPkg = JSON.parse(readFileSync(sdkPkgPath, "utf-8"));
  console.log("=== Gate 1.1: versions ===");
  console.log(`  @anthropic-ai/claude-agent-sdk: ${sdkPkg.version} (bundled Claude Code CLI: ${sdkPkg.claudeCodeVersion})`);
  console.log(`  node: ${process.version}`);
  console.log(`  platform: ${process.platform} ${process.arch}`);
  console.log("");
  return { sdkVersion: sdkPkg.version, claudeCodeVersion: sdkPkg.claudeCodeVersion, nodeVersion: process.version };
}

function runGateProcess(file) {
  return new Promise((resolve) => {
    const args = live ? [file, "--live"] : [file];
    const child = spawn(process.execPath, args, { cwd: HERE, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c.toString()));
    child.stderr.on("data", (c) => (stderr += c.toString()));
    const timer = setTimeout(() => {
      child.kill();
      resolve({ status: "FAIL", evidence: [], error: `gate process timed out after 60s and was killed`, stderr });
    }, 60_000);
    child.on("exit", () => {
      clearTimeout(timer);
      const startIdx = stdout.indexOf(MARKER_START);
      const endIdx = stdout.indexOf(MARKER_END);
      if (startIdx === -1 || endIdx === -1) {
        resolve({ status: "FAIL", evidence: [], error: `no result JSON found in child output.\nstdout:\n${stdout}\nstderr:\n${stderr}` });
        return;
      }
      const jsonText = stdout.slice(startIdx + MARKER_START.length, endIdx).trim();
      try {
        resolve(JSON.parse(jsonText));
      } catch (err) {
        resolve({ status: "FAIL", evidence: [], error: `could not parse gate result JSON: ${err.message}\nraw: ${jsonText}` });
      }
    });
  });
}

async function main() {
  const versions = printVersions();
  const results = [];

  for (const g of GATES) {
    console.log(`=== Gate ${g.id} ===`);
    const result = await runGateProcess(g.file);
    result.id = result.id || g.id;
    results.push(result);
    for (const line of result.evidence || []) console.log(`  ${line}`);
    if (result.gaps) for (const gline of result.gaps) console.log(`  GAP: ${gline}`);
    if (result.status === "BLOCKED" || result.status === "PASS_WITH_BLOCKED_SUBITEM") {
      if (result.blockedReason) console.log(`  BLOCKED: ${result.blockedReason}`);
      if (result.exactCommand) console.log(`  To close: ${result.exactCommand}`);
    }
    if (result.error) console.log(`  ERROR: ${result.error}`);
    console.log(`  => ${result.status}`);
    console.log("");
  }

  console.log("=== Summary ===");
  console.log(`  SDK ${versions.sdkVersion} / Node ${versions.nodeVersion}`);
  for (const r of results) {
    console.log(`  ${String(r.id).padEnd(5)} ${String(r.status).padEnd(24)} ${r.title || ""}`);
  }
  const hardFail = results.some((r) => r.status === "FAIL");
  console.log("");
  console.log(hardFail ? "RESULT: at least one gate FAILED." : "RESULT: no hard failures. See BLOCKED gates above for what needs live credentials/browser.");
  process.exitCode = hardFail ? 1 : 0;
}

main();
