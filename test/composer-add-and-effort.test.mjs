#!/usr/bin/env node
// The two composer controls: the "+" that attaches files, and the effort
// picker that says how hard the model should think about the turn.
//
// Neither can be exercised end to end without a real panel, so this holds the
// seams that would break silently:
//
//  - The panel's accepted-type table must agree with host/agent/protocol.js's.
//    A drift there does not throw — the composer accepts a file the companion
//    then rejects mid-send, or refuses one that would have worked.
//  - The file picker's `accept` attribute must actually offer every accepted
//    type. A PDF the composer would take but the OS dialog hides is a feature
//    nobody can reach.
//  - `effort` must travel as an ABSENT field when no level is chosen. Sending
//    an explicit null, or defaulting it to "high", both silently change how
//    every turn runs.
//
// Run: node test/composer-add-and-effort.test.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ATTACHMENT_MIME_TYPES, EFFORT_LEVELS } from "../host/agent/protocol.js";
import { ProtocolClient } from "../extension/sidepanel/protocol-client.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

let fail = 0;
const ok = (cond, msg) => {
  console.log((cond ? "  PASS  " : "  FAIL  ") + msg);
  if (!cond) fail++;
};

const panelJs = read("extension/sidepanel/sidepanel.js");
const panelHtml = read("extension/sidepanel/sidepanel.html");

console.log("\n== the panel's accepted types agree with the companion's ==");
{
  // The panel keeps its own copy so it can reject early with a specific
  // reason; the companion re-validates and stays the authority. The copy is
  // only useful while it matches.
  const block = panelJs.match(/const ATTACHMENT_MIME_KINDS = \{([\s\S]*?)\};/);
  ok(Boolean(block), "the panel declares an ATTACHMENT_MIME_KINDS table");
  const panelTypes = [...block[1].matchAll(/"([^"]+)":\s*"(image|document|text)"/g)].map((m) => m[1]);
  for (const mime of ATTACHMENT_MIME_TYPES) {
    ok(panelTypes.includes(mime), `the panel accepts ${mime}, as the companion does`);
  }
  ok(
    panelTypes.length === ATTACHMENT_MIME_TYPES.length,
    "and accepts nothing the companion would reject mid-send"
  );
}

console.log("\n== the file picker offers every accepted type ==");
{
  const accepts = [...panelHtml.matchAll(/<input[^>]*type="file"[^>]*accept="([^"]+)"/g)].map((m) => m[1]);
  ok(accepts.length === 2, "both file inputs (composer and the Ctrl+U modal) declare an accept list");
  ok(accepts[0] === accepts[1], "and both offer the same one — a file reachable one way is reachable the other");
  // Extensions rather than MIME types: browsers report .md/.csv inconsistently,
  // and a MIME accept list hides those files in the OS dialog entirely.
  for (const ext of ["png", "jpg", "webp", "gif", "pdf", "txt", "md", "csv", "json"]) {
    ok(accepts[0].split(",").includes("." + ext), `.${ext} is offered in the picker`);
  }
}

console.log("\n== the + button and its menu ==");
ok(/id="btn-add"/.test(panelHtml), "the composer has a + button");
ok(/id="add-menu-files"/.test(panelHtml), "whose menu has an add-files item");
ok(
  panelJs.includes("el.addMenuFiles.addEventListener"),
  "that item is wired in JS, not via an inline handler (the panel's CSP forbids one)"
);
ok(
  panelJs.includes("if (!canAcceptAttachments()) return; // gated exactly as Send and Ctrl+U are"),
  "and is gated on the same readiness as Send, so it cannot attach into a running turn"
);
{
  // Both entry points must land on the same picker; two implementations would
  // drift.
  const opens = [...panelJs.matchAll(/openAttachmentPicker\(\);/g)];
  ok(opens.length === 2, "the + item and Ctrl+U both open the one picker implementation");
}

console.log("\n== the effort picker ==");
{
  const block = panelJs.match(/const EFFORT_CHOICES = \[([\s\S]*?)\];/);
  ok(Boolean(block), "the panel declares an EFFORT_CHOICES list");
  const values = [...block[1].matchAll(/value: (null|"[a-z]+")/g)].map((m) => m[1].replace(/"/g, ""));
  ok(values[0] === "null", "whose first entry is the no-level default, so it is what an unconfigured panel sends");
  for (const level of EFFORT_LEVELS) {
    ok(values.includes(level), `${level} is offered, matching the companion's EFFORT_LEVELS`);
  }
  ok(
    values.length === EFFORT_LEVELS.length + 1,
    "and nothing else is offered — a level the companion rejects would fail the turn, not degrade it"
  );
}
ok(
  panelJs.includes("let selectedEffort = null;"),
  "the panel starts with no level chosen rather than assuming today's default"
);
ok(
  panelJs.includes("effort: selectedEffort"),
  "and the chosen level is passed to sendMessage with the turn"
);

console.log("\n== the wire: absent means absent ==");
{
  // ProtocolClient posts through its transport's port, so the seam is the
  // port itself. The payload is spread flat onto the envelope, not nested.
  const sent = [];
  const client = new ProtocolClient({});
  client._port = { postMessage: (msg) => sent.push(msg.envelope) };
  const base = { conversationId: "c1", profileId: "p1", modelId: "m1", tabScope: "any", prompt: "hi", context: null };

  client.start({ ...base });
  ok(!("effort" in sent[0]), "no level chosen → the START envelope carries no effort field at all");

  client.start({ ...base, effort: null });
  ok(!("effort" in sent[1]), "an explicit null is not written onto the wire either");

  client.start({ ...base, effort: "xhigh" });
  ok(sent[2].effort === "xhigh", "a chosen level travels verbatim");
}

console.log("\n== attachment refs carry the filename ==");
ok(
  /name: a\.fileName/.test(panelJs),
  "snapshotAttachments sends `name`, which the companion validates and the turn uses to label a text file or title a PDF"
);

console.log(fail === 0 ? "\nALL COMPOSER ADD/EFFORT TESTS PASSED\n" : `\n${fail} FAILED\n`);
process.exit(fail ? 1 : 0);
