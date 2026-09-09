#!/usr/bin/env node
// extension/sidepanel/skills-client.js wire-contract tests — no existing
// test file covered this module before repair-slash-dispatch-and-builtin-commands
// (tasks.md 3.1/3.6: "add a client test if the existing skills-client test
// file does not cover the new read"; test/settings-ui-skills-client.test.mjs
// only covers the DIFFERENT extension/settings/skills-client.js module).
// Mirrors that file's own fake-sendMessage convention exactly.
//
// Run: node test/sidepanel-skills-client.test.mjs
import { createPanelSkillsClient, SkillsErrorLike } from "../extension/sidepanel/skills-client.js";

let fail = 0;
const ok = (c, m) => {
  console.log((c ? "  PASS " : "  FAIL ") + m);
  if (!c) fail++;
};

console.log("== listCatalog: unchanged wire shape and success path ==");
{
  const calls = [];
  const client = createPanelSkillsClient({
    sendMessage: async (msg) => {
      calls.push(msg);
      return { ok: true, result: [{ name: "tom-tat-trang" }] };
    }
  });
  const result = await client.listCatalog();
  ok(calls[0].type === "agent_settings" && calls[0].op === "skills_list", `listCatalog sends {type:"agent_settings", op:"skills_list"} — got ${JSON.stringify(calls[0])}`);
  ok(Array.isArray(result) && result[0].name === "tom-tat-trang", "returns response.result on ok:true");
}

console.log("\n== getAdvertisedCommands: sends the exact op, alongside skills_list's own shape ==");
{
  const calls = [];
  const client = createPanelSkillsClient({
    sendMessage: async (msg) => {
      calls.push(msg);
      return { ok: true, result: { commands: ["cost"], terminalCommands: [], observedAt: "2026-01-01T00:00:00.000Z" } };
    }
  });
  const result = await client.getAdvertisedCommands();
  ok(
    calls[0].type === "agent_settings" && calls[0].op === "get_advertised_commands",
    `getAdvertisedCommands sends {type:"agent_settings", op:"get_advertised_commands"} — got ${JSON.stringify(calls[0])}`
  );
  ok(result.commands.includes("cost"), "returns response.result on ok:true, unmodified");
}

console.log("\n== getAdvertisedCommands: ok:true with result:null (no record observed yet) is not an error ==");
{
  const client = createPanelSkillsClient({ sendMessage: async () => ({ ok: true, result: null }) });
  const result = await client.getAdvertisedCommands();
  ok(result === null, "null result passes through as-is — a normal, honest 'nothing observed yet' state");
}

console.log("\n== getAdvertisedCommands: ok:false is translated into a SkillsErrorLike, same as listCatalog ==");
{
  const client = createPanelSkillsClient({
    sendMessage: async () => ({ ok: false, error: { code: "PROTOCOL_ERROR", message: "unknown agent_settings op" } })
  });
  let caught;
  try {
    await client.getAdvertisedCommands();
  } catch (err) {
    caught = err;
  }
  ok(caught instanceof SkillsErrorLike, "throws SkillsErrorLike on ok:false");
  ok(caught.code === "PROTOCOL_ERROR", `carries the companion's own error code — got ${caught && caught.code}`);
}

console.log("\n== getAdvertisedCommands: a rejected sendMessage (no companion) is a NETWORK_ERROR, never an unhandled rejection ==");
{
  const client = createPanelSkillsClient({
    sendMessage: async () => {
      throw new Error("Could not establish connection");
    }
  });
  let caught;
  try {
    await client.getAdvertisedCommands();
  } catch (err) {
    caught = err;
  }
  ok(caught instanceof SkillsErrorLike && caught.code === "NETWORK_ERROR", `expected a NETWORK_ERROR SkillsErrorLike — got ${caught && caught.constructor.name}/${caught && caught.code}`);
}

console.log("\n== getAdvertisedCommands: a malformed (non-object) response is a NETWORK_ERROR ==");
{
  const client = createPanelSkillsClient({ sendMessage: async () => undefined });
  let caught;
  try {
    await client.getAdvertisedCommands();
  } catch (err) {
    caught = err;
  }
  ok(caught instanceof SkillsErrorLike && caught.code === "NETWORK_ERROR", "a missing/malformed response is reported as NETWORK_ERROR, not thrown as a raw TypeError");
}

console.log("\n== the client stays read-only: no mutation method is exposed ==");
{
  const client = createPanelSkillsClient({ sendMessage: async () => ({ ok: true, result: null }) });
  ok(typeof client.listCatalog === "function", "listCatalog is exposed");
  ok(typeof client.getAdvertisedCommands === "function", "getAdvertisedCommands is exposed");
  ok(
    Object.keys(client).every((k) => k === "listCatalog" || k === "getAdvertisedCommands"),
    `no other (mutating) method is exposed — got ${Object.keys(client).join(", ")}`
  );
}

console.log(fail === 0 ? "\nALL SIDEPANEL SKILLS CLIENT TESTS PASSED" : `\n${fail} FAILED`);
process.exit(fail ? 1 : 0);
