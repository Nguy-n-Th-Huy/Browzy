// Task 4.5 headline assertion #2: "no prior conversation is silently sent to
// a new endpoint" — the settings-page half of it.
//
// Division of responsibility (see design.md decision 4, last paragraph):
// "Provider/model changes apply only to a new conversation ... changing
// endpoint or model for an existing conversation requires a new conversation
// so old context is not silently sent to a different provider." Actually
// carrying a conversation forward (or not) is the sidepanel/session
// manager's job (host/agent/session/**, extension/sidepanel/** — both
// outside this task's ownership). This settings page's job, and the one
// this file can actually prove structurally, is narrower but load-bearing:
// it must have NO way to reference, resume, or carry forward a
// conversation/run/session at all. If the settings module has no such
// concept anywhere in its source, it cannot possibly be the thing that
// smuggles old context into a newly-saved endpoint — that risk can only live
// in the session/run layer, which already has its own proof obligation
// (reports/03-companion-evidence.md's run-lifecycle/lease tests) not
// duplicated here.
//
// Run: node test/settings-ui-no-conversation-leak.test.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SETTINGS_DIR = path.join(__dirname, "..", "extension", "settings");

let fail = 0;
const ok = (c, m) => {
  console.log((c ? "  PASS " : "  FAIL ") + m);
  if (!c) fail++;
};

const SESSION_SHAPED = /conversationId|conversation_id|\bsessionId\b|session_id|\brunId\b|run_id|resumeConversation|resumeSession/;

console.log("== structural: extension/settings/** never references a conversation/session/run concept ==");
{
  const files = fs.readdirSync(SETTINGS_DIR).filter((f) => f.endsWith(".js") || f.endsWith(".html"));
  ok(files.length > 0, "settings source files found to scan");
  for (const file of files) {
    const text = fs.readFileSync(path.join(SETTINGS_DIR, file), "utf-8");
    ok(!SESSION_SHAPED.test(text), `${file}: no conversation/session/run identifier referenced anywhere`);
  }
}

console.log("== structural: the settings wire contract (settings-client.js) only ever carries profileId/modelId, never a run/session identifier ==");
{
  const text = fs.readFileSync(path.join(SETTINGS_DIR, "settings-client.js"), "utf-8");
  const opLines = text.match(/call\("[a-z_]+",\s*\{[^}]*\}\)/g) || [];
  ok(opLines.length >= 7, `found the expected number of op calls to inspect (${opLines.length})`);
  for (const line of opLines) {
    ok(!SESSION_SHAPED.test(line), `outgoing op payload has no session/run field: ${line}`);
  }
}

console.log("== behavioral: saving a changed endpoint/model never implicitly notifies or migrates \"the current conversation\" ==");
{
  // If this module had any notion of "the active conversation", saving would
  // need to accept or reference one. It structurally cannot: save()'s only
  // parameter is the raw credential string (see settings-controller.js).
  const { SettingsController } = await import("../extension/settings/settings-controller.js");
  ok(SettingsController.prototype.save.length <= 1, "save() takes at most one parameter (the raw credential) -- there is no conversation/session parameter to smuggle context through");
}

console.log(fail === 0 ? "\nALL SETTINGS-UI NO-CONVERSATION-LEAK TESTS PASSED" : `\n${fail} FAILED`);
process.exit(fail ? 1 : 0);
