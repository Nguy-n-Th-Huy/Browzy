#!/usr/bin/env node
// repair-slash-dispatch-and-builtin-commands, tasks.md 2.6.
//
// host/agent/settings/advertised-commands.js: the persisted record of the
// slash commands the SDK itself advertised on a `system`/`init` message
// (design.md decision 4), and the pure allowlist-intersection derivation
// (design.md decision 3/5) that turns that record into the run's approved
// built-in set.
//
// Run: node test/slash-commands-record.test.mjs

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let fail = 0;
function ok(cond, msg) {
  console.log((cond ? "  PASS " : "  FAIL ") + msg);
  if (!cond) fail++;
}

function freshHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocic-slash-commands-record-"));
  process.env.OCIC_AGENT_HOME = dir;
  return dir;
}

// Each scenario re-imports via a cache-busting query string so module-level
// state (there is none here — the module is pure filesystem I/O keyed by
// OCIC_AGENT_HOME at call time, not at import time) can never leak between
// scenarios that use a different freshHome(). Kept simple: a single static
// import is safe here since agentRoot() is re-read from process.env on
// every call, not cached at import time (see the module's own agentRoot()).
const MODULE_URL = new URL("../host/agent/settings/advertised-commands.js", import.meta.url).href;
const { recordAdvertisedCommands, readAdvertisedCommands, deriveApprovedBuiltinCommands, APPROVED_BUILTIN_COMMANDS } =
  await import(MODULE_URL);

console.log("== APPROVED_BUILTIN_COMMANDS: deliberately empty (design.md decision 8 / tasks.md 5.6) ==");
{
  // The candidate was exactly "cost", but a real advertised record for this
  // operator's configuration never contained "cost" (it had usage, context,
  // compact, clear, model, effort, recap and others instead) — so the
  // allowlist was emptied rather than substituted, keeping the whole
  // discovery/approval mechanism intact but currently inert. This is a
  // deliberate approval decision, not unfinished work — see the constant's
  // own header comment in host/agent/settings/advertised-commands.js.
  ok(Array.isArray(APPROVED_BUILTIN_COMMANDS), "is an array");
  ok(APPROVED_BUILTIN_COMMANDS.length === 0, `contains nothing — got ${JSON.stringify(APPROVED_BUILTIN_COMMANDS)}`);
}

console.log("\n== readAdvertisedCommands: no file yet reads as null, not an error ==");
{
  freshHome();
  ok(readAdvertisedCommands() === null, "a brand-new agent home has no record");
}

console.log("\n== write-then-read round trip ==");
{
  freshHome();
  const written = recordAdvertisedCommands({ commands: ["cost", "compact", "clear"], terminalCommands: ["clear"] });
  ok(Array.isArray(written.commands) && written.commands.length === 3, "recordAdvertisedCommands returns the record it wrote");
  ok(typeof written.observedAt === "string" && !Number.isNaN(Date.parse(written.observedAt)), "observedAt is a real ISO timestamp");

  const read = readAdvertisedCommands();
  ok(read !== null, "the record is readable immediately after being written");
  ok(
    JSON.stringify(read.commands) === JSON.stringify(["cost", "compact", "clear"]),
    `commands round-trip exactly — got ${JSON.stringify(read.commands)}`
  );
  ok(
    JSON.stringify(read.terminalCommands) === JSON.stringify(["clear"]),
    `terminalCommands round-trip exactly — got ${JSON.stringify(read.terminalCommands)}`
  );
  ok(read.observedAt === written.observedAt, "observedAt round-trips exactly");
}

console.log("\n== a second observation replaces the record wholesale, never merges ==");
{
  freshHome();
  recordAdvertisedCommands({ commands: ["cost", "compact"], terminalCommands: ["compact"] });
  recordAdvertisedCommands({ commands: ["context"], terminalCommands: [] });

  const read = readAdvertisedCommands();
  ok(
    JSON.stringify(read.commands) === JSON.stringify(["context"]),
    `the second write's commands are the ONLY commands present — got ${JSON.stringify(read.commands)}`
  );
  ok(read.terminalCommands.length === 0, "the second write's (empty) terminalCommands replaced the first write's, not merged with it");
}

console.log("\n== survives a fresh module import (simulating a companion restart) ==");
{
  freshHome();
  const dir = process.env.OCIC_AGENT_HOME;
  recordAdvertisedCommands({ commands: ["cost"], terminalCommands: [] });

  process.env.OCIC_AGENT_HOME = dir; // unchanged — a restarted process reuses the same on-disk home
  const reimported = await import(MODULE_URL + "?restart-check=1");
  const read = reimported.readAdvertisedCommands();
  ok(read !== null && read.commands.includes("cost"), "a fresh module instance pointed at the same home still reads the previously written record");
}

console.log("\n== malformed file on disk reads as no-record, never throws ==");
{
  const dir = freshHome();
  const filePath = path.join(dir, "slash-commands.json");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, "{ this is not valid JSON");

  let threw = false;
  let result;
  try {
    result = readAdvertisedCommands();
  } catch {
    threw = true;
  }
  ok(threw === false, "reading a corrupt file does not throw");
  ok(result === null, "a corrupt file is treated exactly like no record at all");
}

console.log("\n== a record shaped without a commands array is also treated as no-record ==");
{
  const dir = freshHome();
  const filePath = path.join(dir, "slash-commands.json");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify({ notCommands: true }));
  ok(readAdvertisedCommands() === null, "valid JSON that is not a plausible record shape still reads as null");
}

console.log("\n== deriveApprovedBuiltinCommands: happy path — advertised, non-terminal, and allowlisted ==");
{
  const record = { commands: ["cost", "compact", "context"], terminalCommands: [] };
  const derived = deriveApprovedBuiltinCommands(record, ["cost"]);
  ok(JSON.stringify(derived) === JSON.stringify(["cost"]), `only the allowlisted, advertised command is approved — got ${JSON.stringify(derived)}`);
}

console.log("\n== deriveApprovedBuiltinCommands: a terminal-bound command is excluded even if advertised and allowlisted ==");
{
  const record = { commands: ["cost"], terminalCommands: ["cost"] };
  const derived = deriveApprovedBuiltinCommands(record, ["cost"]);
  ok(derived.length === 0, "a command the SDK marks terminal-bound is never offered as an approved built-in");
}

console.log("\n== deriveApprovedBuiltinCommands: an advertised, non-terminal command absent from the allowlist is excluded ==");
{
  const record = { commands: ["compact", "context"], terminalCommands: [] };
  const derived = deriveApprovedBuiltinCommands(record, ["cost"]);
  ok(derived.length === 0, "the SDK advertising a command is not itself authorization — the allowlist still governs");
}

console.log("\n== deriveApprovedBuiltinCommands: empty advertised list yields no built-ins ==");
{
  const record = { commands: [], terminalCommands: [] };
  ok(deriveApprovedBuiltinCommands(record, ["cost"]).length === 0, "nothing advertised -> nothing approved");
}

console.log("\n== deriveApprovedBuiltinCommands: empty allowlist yields no built-ins even if the SDK advertises everything ==");
{
  const record = { commands: ["cost", "compact", "context", "clear", "model"], terminalCommands: [] };
  ok(deriveApprovedBuiltinCommands(record, []).length === 0, "an empty allowlist approves nothing regardless of what is advertised");
}

console.log("\n== deriveApprovedBuiltinCommands: a null/missing record yields no built-ins, not a throw ==");
{
  ok(deriveApprovedBuiltinCommands(null, ["cost"]).length === 0, "null record -> empty, no throw");
  ok(deriveApprovedBuiltinCommands(undefined, ["cost"]).length === 0, "undefined record -> empty, no throw");
}

console.log("\n== deriveApprovedBuiltinCommands: defaults to APPROVED_BUILTIN_COMMANDS when no allowlist argument is given ==");
{
  const record = { commands: ["cost"], terminalCommands: [] };
  ok(
    JSON.stringify(deriveApprovedBuiltinCommands(record)) === JSON.stringify(Array.from(APPROVED_BUILTIN_COMMANDS)),
    "default allowlist is the module's own APPROVED_BUILTIN_COMMANDS constant"
  );
}

console.log("\n== deriveApprovedBuiltinCommands: the shipped default (empty) yields no built-ins even when the SDK advertises the one-time candidate \"cost\" ==");
{
  // design.md decision 8 / tasks.md 5.6-5.7: the mechanism (this function,
  // the record, the gate's built-in branch) all still work — it is the
  // allowlist itself that is currently empty. This must stay true with NO
  // allowlist argument passed, i.e. the actual production call shape.
  const record = { commands: ["cost", "usage", "context", "compact", "clear", "model", "effort", "recap"], terminalCommands: [] };
  ok(deriveApprovedBuiltinCommands(record).length === 0, "the real shipped default allowlist approves nothing, even though \"cost\" is advertised");
}

console.log(fail === 0 ? "\nALL SLASH COMMANDS RECORD TESTS PASSED" : `\n${fail} FAILED`);
process.exit(fail ? 1 : 0);
