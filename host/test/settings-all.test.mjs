#!/usr/bin/env node
//
// Convenience aggregate: runs every settings-*/secrets-* suite in one
// process invocation and fails if any of them fails. Each suite also runs
// standalone (see the `node host/test/<name>.test.mjs` command at the top
// of each file); this just saves typing the whole list out.
//
// Run: node host/test/settings-all.test.mjs

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const SUITES = [
  "settings-url.test.mjs",
  "settings-models.test.mjs",
  "settings-atomic-store.test.mjs",
  "settings-http-client.test.mjs",
  "settings-profile.test.mjs",
  "settings-discovery.test.mjs",
  "settings-capability-test.test.mjs",
  "secrets-store.test.mjs",
  "secrets-redaction.test.mjs"
];

let anyFailed = false;
for (const suite of SUITES) {
  console.log(`\n=== ${suite} ===`);
  const result = spawnSync(process.execPath, [path.join(HERE, suite)], { stdio: "inherit" });
  if (result.status !== 0) anyFailed = true;
}

console.log(anyFailed ? "\nOne or more settings/secrets suites FAILED.\n" : "\nAll settings/secrets suites passed.\n");
process.exitCode = anyFailed ? 1 : 0;
