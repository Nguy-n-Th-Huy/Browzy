// Unit tests for dedupeMirroredImageData() in
// host/agent/storage/transcript-store.js. Plain Node, no filesystem.
import { dedupeMirroredImageData } from "../agent/storage/transcript-store.js";

let fail = 0;
const ok = (c, m) => { console.log((c ? "  PASS " : "  FAIL ") + m); if (!c) fail++; };

const IMG = "A".repeat(4096);
const OTHER = "B".repeat(4096);

const build = (contentData, mirrorData) => ({
  seq: 1,
  type: "stream_message",
  message: {
    message: {
      content: [{ type: "tool_result", content: contentData.map((d) => ({ type: "image", source: { media_type: "image/gif", data: d } })) }]
    },
    tool_use_result: mirrorData.map((d) => ({ type: "image", source: { media_type: "image/gif", data: d } }))
  }
});

console.log("== the duplicate copy is dropped ==");
{
  const ev = build([IMG], [IMG]);
  const out = dedupeMirroredImageData(ev);
  const mirror = out.message.tool_use_result[0];
  ok(mirror.source.data === undefined, "mirror no longer carries the payload");
  ok(mirror.source.data_in === "message.content", "mirror names where the bytes live");
  ok(mirror.source.media_type === "image/gif", "every other source field survives");
  ok(out.message.message.content[0].content[0].source.data === IMG, "the copy in content is untouched");
  ok(JSON.stringify(out).length < JSON.stringify(ev).length / 1.8, "the written line is roughly halved");
}

console.log("== a payload that is NOT a duplicate is kept ==");
{
  const ev = build([IMG], [OTHER]);
  const out = dedupeMirroredImageData(ev);
  ok(out.message.tool_use_result[0].source.data === OTHER, "an unmatched payload is left exactly as it was");
}

console.log("== mixed: one duplicate, one not ==");
{
  const ev = build([IMG], [IMG, OTHER]);
  const out = dedupeMirroredImageData(ev);
  ok(out.message.tool_use_result[0].source.data === undefined, "the duplicate is dropped");
  ok(out.message.tool_use_result[1].source.data === OTHER, "the unique one is kept");
}

console.log("== the input event is never mutated ==");
{
  const ev = build([IMG], [IMG]);
  const before = JSON.stringify(ev);
  dedupeMirroredImageData(ev);
  ok(JSON.stringify(ev) === before, "caller's event is unchanged, so the live panel still gets the payload");
}

console.log("== shapes that carry nothing to dedupe ==");
{
  ok(dedupeMirroredImageData({ type: "run_created" }).type === "run_created", "an event with no message passes through");
  const noMirror = { message: { message: { content: [] } } };
  ok(dedupeMirroredImageData(noMirror) === noMirror, "no mirror array -> same object back");
  const textOnly = { message: { message: { content: [{ type: "text", text: "hi" }] }, tool_use_result: [{ type: "text" }] } };
  ok(dedupeMirroredImageData(textOnly) === textOnly, "no image data anywhere -> same object back");
  const emptyContent = { message: { message: { content: [{ content: [] }] }, tool_use_result: [{ source: { data: IMG } }] } };
  ok(dedupeMirroredImageData(emptyContent) === emptyContent, "mirror payload with nothing in content is not touched");
}

if (fail) { console.error(fail + " FAILURES"); process.exit(1); }
console.log("\nALL TRANSCRIPT DEDUPE TESTS PASSED");
