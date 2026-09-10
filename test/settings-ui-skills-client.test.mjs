// Task 7.4: extension/settings/skills-client.js wire-contract tests —
// verifies the exact message shape sent to the companion and the response
// translation, without any live extension/native-messaging plumbing (none is
// available; see this task's "Environment constraint"). Mirrors
// test/settings-ui-client.test.mjs's own convention exactly. A fake
// `sendMessage` stands in for `chrome.runtime.sendMessage`; skills-client.js
// itself is the real, shipped module under test.
//
// Run: node test/settings-ui-skills-client.test.mjs
import { createSkillsClient, SkillsErrorLike } from "../extension/settings/skills-client.js";

let fail = 0;
const ok = (c, m) => {
  console.log((c ? "  PASS " : "  FAIL ") + m);
  if (!c) fail++;
};

console.log("== outgoing message shape ==");
{
  const calls = [];
  const client = createSkillsClient({
    sendMessage: async (msg) => {
      calls.push(msg);
      return { ok: true, result: { echoed: true } };
    }
  });

  await client.listCatalog();
  ok(calls[0].type === "agent_settings" && calls[0].op === "skills_list", `listCatalog sends { type: "agent_settings", op: "skills_list" } — got ${JSON.stringify(calls[0])}`);

  // skills_import/skills_refresh are gone (redesign-settings-typed-only-
  // skills, design.md decision D1) — readSkillSource() is the sole
  // read-back operation, and it takes a catalog name, never a path.
  await client.readSkillSource("tom-tat-trang");
  ok(
    calls[1].op === "skills_read_source" && calls[1].name === "tom-tat-trang" && !("sourceDir" in calls[1]) && !("path" in calls[1]),
    `readSkillSource sends { op: "skills_read_source", name } and nothing path-shaped — got ${JSON.stringify(calls[1])}`
  );

  await client.authorSkill({
    name: "tom-tat-trang",
    description: "Tóm tắt nội dung trang.",
    body: "# Hướng dẫn\n",
    userInvocable: true,
    modelInvocable: false,
    allowedTools: "Read, Skill"
  });
  ok(
    calls[2].op === "skills_author" &&
      calls[2].name === "tom-tat-trang" &&
      calls[2].description === "Tóm tắt nội dung trang." &&
      calls[2].body === "# Hướng dẫn\n" &&
      calls[2].userInvocable === true &&
      calls[2].modelInvocable === false &&
      calls[2].allowedTools === "Read, Skill",
    `authorSkill forwards the full typed-form payload — got ${JSON.stringify(calls[2])}`
  );

  await client.enableSkill("tom-tat-trang");
  ok(calls[3].op === "skills_enable" && calls[3].name === "tom-tat-trang", "enableSkill op");

  await client.disableSkill("tom-tat-trang");
  ok(calls[4].op === "skills_disable" && calls[4].name === "tom-tat-trang", "disableSkill op");

  await client.removeSkill("tom-tat-trang");
  ok(calls[5].op === "skills_remove" && calls[5].name === "tom-tat-trang", "removeSkill op");

  await client.setInvocationFlags("tom-tat-trang", { userInvocable: false, modelInvocable: true });
  ok(
    calls[6].op === "skills_set_invocation_flags" && calls[6].name === "tom-tat-trang" && calls[6].userInvocable === false && calls[6].modelInvocable === true,
    "setInvocationFlags forwards both flags"
  );

  ok(typeof client.importSkill !== "function" && typeof client.refreshSkill !== "function", "importSkill()/refreshSkill() no longer exist on the client");
}

console.log("== success response translation ==");
{
  const client = createSkillsClient({ sendMessage: async () => ({ ok: true, result: { name: "x", enabled: true } }) });
  const result = await client.listCatalog();
  ok(result && result.name === "x", "ok:true unwraps to .result");
}

console.log("== error response translation (skill-specific codes) ==");
for (const code of ["INVALID_METADATA", "INVALID_NAME", "DUPLICATE_NAME", "PATH_TRAVERSAL", "SYMLINK_ESCAPE", "UNSUPPORTED_CAPABILITY", "NOT_FOUND"]) {
  const client = createSkillsClient({ sendMessage: async () => ({ ok: false, error: { code, message: `rejected: ${code}` } }) });
  let caught = null;
  try {
    await client.readSkillSource("x");
  } catch (err) {
    caught = err;
  }
  ok(caught instanceof SkillsErrorLike && caught.code === code, `error code ${code} preserved exactly as SkillsErrorLike`);
}

console.log("== missing listener / rejected sendMessage never reports success ==");
{
  // This is the expected outcome TODAY (see skills-client.js's own header:
  // companion.js has no skills_* op handlers yet, and background.js's relay
  // is a parallel session's work) — a rejected transport call must still
  // never be silently reported as success.
  const client = createSkillsClient({
    sendMessage: async () => {
      throw new Error("Could not establish connection. Receiving end does not exist.");
    }
  });
  let caught = null;
  try {
    await client.listCatalog();
  } catch (err) {
    caught = err;
  }
  ok(caught instanceof SkillsErrorLike && caught.code === "NETWORK_ERROR", "a rejected transport call surfaces as NETWORK_ERROR, never a false pass");
}

console.log("== malformed response never reports success ==");
for (const bad of [null, undefined, "a string", 42, {}]) {
  const client = createSkillsClient({ sendMessage: async () => bad });
  let caught = null;
  try {
    await client.listCatalog();
  } catch (err) {
    caught = err;
  }
  ok(caught instanceof SkillsErrorLike, `malformed response ${JSON.stringify(bad)} throws rather than silently succeeding`);
}

console.log("== default transport: no chrome.runtime -> NETWORK_ERROR, not a hang or a crash ==");
{
  const priorChrome = globalThis.chrome;
  delete globalThis.chrome;
  const client = createSkillsClient();
  let caught = null;
  try {
    await client.listCatalog();
  } catch (err) {
    caught = err;
  }
  ok(caught instanceof SkillsErrorLike && caught.code === "NETWORK_ERROR", "no chrome.runtime available is reported, not silently swallowed");
  if (priorChrome !== undefined) globalThis.chrome = priorChrome;
}

console.log(fail === 0 ? "\nALL SETTINGS-UI SKILLS CLIENT TESTS PASSED" : `\n${fail} FAILED`);
process.exit(fail ? 1 : 0);
