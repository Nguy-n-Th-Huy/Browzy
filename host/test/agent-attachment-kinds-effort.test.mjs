#!/usr/bin/env node
// Two composer-driven fields on the START envelope: what an attachment turns
// into, and how much reasoning the turn asks for.
//
// ATTACHMENT KINDS. Images already worked. A PDF and a text file do not: the
// API rejects a PDF sent as an image block, and a text file sent as any binary
// block reaches the model as base64 it would have to decode by guesswork. So
// the accepted MIME types are grouped by the content block each becomes, and
// this file holds that mapping to its promise — including that no type is
// accepted without a kind, which would otherwise fall through to the image
// branch silently.
//
// EFFORT. `Options.effort` is a real field on the pinned Agent SDK (sdk.d.ts's
// EffortLevel). The risk is not that it fails loudly but that it fails
// quietly: a turn running at a different depth than the composer showed, or an
// unset level being papered over with whatever today's default happens to be.
// Absent must therefore mean "send nothing", not "send high".
//
// Run: node host/test/agent-attachment-kinds-effort.test.mjs

import {
  ATTACHMENT_MIME_TYPES,
  ATTACHMENT_MIME_KINDS,
  ATTACHMENT_NAME_MAX_LENGTH,
  EFFORT_LEVELS,
  attachmentKind,
  validateStartAttachments,
  validateStartEffort
} from "../agent/protocol.js";
import { buildAttachmentPrompt } from "../agent/companion.js";

let fail = 0;
const ok = (cond, msg) => {
  console.log((cond ? "  PASS  " : "  FAIL  ") + msg);
  if (!cond) fail++;
};

/** Drain the single-message generator buildAttachmentPrompt() returns. */
async function blocksOf(text, attachments) {
  for await (const msg of buildAttachmentPrompt(text, attachments)) return msg.message.content;
  throw new Error("prompt generator yielded nothing");
}

console.log("\n== every accepted MIME type has a kind ==");
for (const mime of ATTACHMENT_MIME_TYPES) {
  ok(["image", "document", "text"].includes(attachmentKind(mime)), `${mime} maps to a known content-block kind`);
}
ok(attachmentKind("application/zip") === null, "an unaccepted type has no kind at all");
ok(
  Object.keys(ATTACHMENT_MIME_KINDS).length === ATTACHMENT_MIME_TYPES.length,
  "the accepted-type list is derived from the kind map, so the two cannot drift apart"
);
ok(attachmentKind("application/pdf") === "document", "a PDF is a document, never an image");
ok(attachmentKind("text/markdown") === "text", "markdown is text, never a binary block");

console.log("\n== validateStartAttachments ==");
{
  const r = validateStartAttachments([{ id: "a1", mimeType: "application/pdf", byteLength: 10, name: "hop-so.pdf" }]);
  ok(r.ok && r.refs[0].name === "hop-so.pdf", "a PDF ref with a filename is accepted and the name is carried through");
}
{
  const r = validateStartAttachments([{ id: "a1", mimeType: "text/csv", byteLength: 10 }]);
  ok(r.ok && !("name" in r.refs[0]), "the filename is optional, and its absence is not turned into an empty string");
}
{
  const r = validateStartAttachments([{ id: "a1", mimeType: "application/zip", byteLength: 10 }]);
  ok(!r.ok && r.reason === "attachment_unsupported_mime_type", "an unaccepted type is still rejected");
}
{
  const r = validateStartAttachments([{ id: "a1", mimeType: "text/plain", byteLength: 1, name: 42 }]);
  ok(!r.ok && r.reason === "attachment_invalid_name", "a non-string name is rejected rather than coerced");
}
{
  const long = "x".repeat(ATTACHMENT_NAME_MAX_LENGTH + 1);
  const r = validateStartAttachments([{ id: "a1", mimeType: "text/plain", byteLength: 1, name: long }]);
  ok(!r.ok && r.reason === "attachment_name_too_long", "an oversized name is rejected rather than bloating the turn");
}
ok(validateStartAttachments(undefined).ok, "no attachments at all is still valid");

console.log("\n== the content block each kind becomes ==");
{
  const blocks = await blocksOf("xem giúp", [
    { kind: "image", mimeType: "image/png", dataBase64: "AAA", name: null }
  ]);
  ok(blocks[0].type === "text" && blocks[0].text === "xem giúp", "the user's own text stays first, and is never rewritten");
  ok(blocks[1].type === "image", "an image becomes an image block");
  ok(blocks[1].source.media_type === "image/png" && blocks[1].source.data === "AAA", "carrying its own type and bytes");
}
{
  const blocks = await blocksOf("đọc file", [
    { kind: "document", mimeType: "application/pdf", dataBase64: "JVBER", name: "hop-dong.pdf" }
  ]);
  ok(blocks[1].type === "document", "a PDF becomes a document block, not an image block");
  ok(blocks[1].source.media_type === "application/pdf", "with the PDF media type");
  ok(blocks[1].title === "hop-dong.pdf", "and its filename as the title");
}
{
  const blocks = await blocksOf("tóm tắt", [
    { kind: "text", mimeType: "text/plain", text: "dòng một\ndòng hai", name: "ghi-chu.txt" }
  ]);
  ok(blocks[1].type === "text", "a text file becomes a text block, not base64");
  ok(blocks[1].text.includes("dòng một\ndòng hai"), "with its content readable as-is");
  ok(blocks[1].text.startsWith("Attached file: ghi-chu.txt"), "labelled with its filename, so it is not mistaken for the user's own words");
}
{
  const blocks = await blocksOf("x", [{ kind: "text", mimeType: "text/plain", text: "body", name: null }]);
  ok(blocks[1].text.startsWith("Attached file\n"), "an unnamed text attachment still says it is an attachment");
}
{
  // An attached Markdown file routinely contains fences of its own.
  const content = "before\n```js\ncode\n```\nafter";
  const blocks = await blocksOf("x", [{ kind: "text", mimeType: "text/markdown", text: content, name: "a.md" }]);
  const body = blocks[1].text;
  ok(body.includes(content), "content containing its own fence is included whole");
  ok(body.includes("````"), "and is wrapped in a longer fence so the close cannot land early");
  const tail = body.slice(body.lastIndexOf("\n") + 1);
  ok(tail === body.split("\n")[2], "the opening and closing fences are the same length");
}
{
  const blocks = await blocksOf("cả hai", [
    { kind: "image", mimeType: "image/png", dataBase64: "A", name: null },
    { kind: "document", mimeType: "application/pdf", dataBase64: "B", name: "b.pdf" },
    { kind: "text", mimeType: "text/csv", text: "a,b", name: "c.csv" }
  ]);
  ok(blocks.length === 4, "one block per attachment, after the user's text");
  ok(
    blocks[1].type === "image" && blocks[2].type === "document" && blocks[3].type === "text",
    "in attachment order, each as its own kind"
  );
}

console.log("\n== validateStartEffort ==");
for (const level of EFFORT_LEVELS) {
  const r = validateStartEffort(level);
  ok(r.ok && r.effort === level, `${level} is accepted verbatim`);
}
{
  const r = validateStartEffort(undefined);
  ok(r.ok && r.effort === null, "an absent level is valid and resolves to null — the run then sends no effort at all");
}
ok(validateStartEffort(null).ok, "an explicit null is the same as absent");
{
  const r = validateStartEffort("highest");
  ok(!r.ok && r.reason === "effort_unsupported_level", "an unrecognised level is rejected, never silently dropped to the default");
}
{
  // The SDK's own Options.effort also accepts an integer token budget. This
  // channel deliberately does not carry one: a raw budget has no stable
  // meaning across models and the composer cannot present it honestly.
  const r = validateStartEffort(2048);
  ok(!r.ok, "a numeric budget is refused on this channel, not passed through unvalidated");
}

console.log("\n== the level actually reaches the SDK's own Options.effort ==");
// Validating the field and then never forwarding it would pass every check
// above while changing nothing about how a turn runs. This drives a real
// START envelope through the real CompanionCore into a recording fake in the
// SDK's place, and reads what query() was actually handed.
{
  const { CompanionCore } = await import("../agent/companion.js");
  const { TranscriptStore } = await import("../agent/storage/transcript-store.js");
  const { BrowserLease } = await import("../agent/broker/browser-lease.js");
  const { ApprovalRegistry } = await import("../agent/policy/approvals.js");
  const { SessionManager } = await import("../agent/session/manager.js");
  const { ToolBridge } = await import("../agent/broker/tool-bridge.js");
  const { AGENT_MESSAGE_TYPES, makeEnvelope } = await import("../agent/protocol.js");

  function buildCore() {
    const calls = [];
    const store = new TranscriptStore();
    const lease = new BrowserLease();
    const approvals = new ApprovalRegistry();
    const core = new CompanionCore({
      toolBridge: new ToolBridge({
        init: async () => {},
        callTool: async (name) => ({ content: [{ type: "text", text: "fake:" + name }] }),
        shutdown: () => {}
      }),
      sessionManager: new SessionManager({ store, lease, approvals }),
      lease,
      coerceArgs: (a) => a,
      sdk: {
        async *query({ prompt, options }) {
          calls.push({ prompt, options });
          yield { type: "assistant", text: "ok" };
        }
      },
      profileProvider: {
        async snapshotForRun(profileId, modelId) {
          return {
            model: modelId || "claude-fake-model",
            env: { ANTHROPIC_BASE_URL: "https://example.invalid", ANTHROPIC_API_KEY: "fake-key" },
            revision: 1,
            profileId: profileId || "default"
          };
        }
      }
    });
    return { core, calls };
  }

  async function runOnce(startFields) {
    const { core, calls } = buildCore();
    await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.HELLO, {}));
    const { conversationId } = await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.NEW, {}));
    const reply = await core.handleEnvelope(
      makeEnvelope(AGENT_MESSAGE_TYPES.START, { conversationId, prompt: "hi", ...startFields })
    );
    const deadline = Date.now() + 3000;
    while (calls.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 15));
    return { calls, reply };
  }

  {
    const { calls } = await runOnce({ effort: "xhigh" });
    ok(calls.length === 1, "the run reached query() once");
    ok(calls[0].options.effort === "xhigh", "and the chosen level is on the options object the SDK receives");
    ok(calls[0].prompt === "hi", "while the prompt stays exactly the user's own text");
  }
  {
    const { calls } = await runOnce({});
    ok(calls.length === 1, "a run with no level chosen still reaches query()");
    ok(!("effort" in calls[0].options), "with NO effort key at all — the model's own default applies, unpinned");
  }
  {
    const { reply } = await runOnce({ effort: "turbo" });
    ok(
      Boolean(reply) && reply.type === AGENT_MESSAGE_TYPES.ERROR && reply.reason === "malformed_effort",
      "an unrecognised level fails the START outright rather than running the turn at some other depth"
    );
  }
}

console.log(fail === 0 ? "\nALL ATTACHMENT-KIND / EFFORT TESTS PASSED\n" : `\n${fail} FAILED\n`);
process.exit(fail ? 1 : 0);
