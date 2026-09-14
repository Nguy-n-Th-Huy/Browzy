#!/usr/bin/env node
//
// Replayable step targets: a workflow step aims with the element's STABLE
// identity (`{role, name}`) instead of a document-scoped ref handle.
//
// The live bug (2026-09-15): a saved workflow replayed on a later session
// ended `target_no_longer_resolves` at its first click. Refs live in ONE
// document's in-memory WeakRef map (content.js) — wiped by navigation, SPA
// route changes, tab close and browser restart — so a stored handle is dead
// by the next run. The fix has two halves that must stay in step, and this
// file pins the REPLAY half against the shipped sources:
//   - content.js's getTargetCoordinates: identity -> live element, strict;
//   - background.js's resolveTargetToCoordinates, computer()'s ref-then-
//     target resolution, form_input's target resolution, and the failure
//     wording that must classify as drift (`shortcutDriftReason` /
//     `batchItemResultFailed` — the proof executor's two gates).
// The RECORD half (materialize freezing identities) is covered behaviourally
// in host/test/workflows-materialize.test.mjs.
//
// Run: node test/replayable-targets.test.mjs

import fs from "node:fs";
import path from "node:path";
import { extractMethod, compile, BACKGROUND, ROOT } from "./_extract.mjs";

let fail = 0;
const ok = (cond, msg) => {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${msg}`);
  if (!cond) fail++;
};

const CONTENT = path.join(ROOT, "extension", "content.js");
const contentSrc = fs.readFileSync(CONTENT, "utf8");
const bgSrc = fs.readFileSync(BACKGROUND, "utf8");

/** extractFunction() matches braces from the FIRST `{` after the function
 *  keyword, which is a default parameter's `{}` for signatures like
 *  `(target, opts = {})` — it then returns a truncated declaration. These
 *  helpers skip the parameter list first, then brace-match the body. */
function extractFn(name, src) {
  let i = src.indexOf(`function ${name}(`);
  if (i === -1) throw new Error(`function ${name} not found`);
  if (src.slice(Math.max(0, i - 6), i) === "async ") i -= 6;
  let k = src.indexOf("(", i);
  let p = 0;
  for (; k < src.length; k++) {
    if (src[k] === "(") p++;
    else if (src[k] === ")") {
      p--;
      if (p === 0) {
        k++;
        break;
      }
    }
  }
  let depth = 0;
  for (let j = src.indexOf("{", k); j < src.length; j++) {
    if (src[j] === "{") depth++;
    else if (src[j] === "}") {
      depth--;
      if (depth === 0) return src.slice(i, j + 1);
    }
  }
  throw new Error(`unbalanced braces for ${name}`);
}

// ==========================================================================
console.log("== content.js: a frozen identity resolves to a LIVE element, strictly ==");
{
  const calls = { find: [], coords: [] };
  const page = [
    { ref: "ref_5", role: "link", name: "  Click để tìm kiếm\n   nâng cao " },
    { ref: "ref_6", role: "div", name: "Click để tìm kiếm nâng cao" }
  ];
  const getTargetCoordinates = compile(
    extractFn("getTargetCoordinates", contentSrc),
    {
      findElements: (query) => {
        calls.find.push(query);
        return { results: page, total: page.length };
      },
      getRefCoordinates: (ref, opts) => {
        calls.coords.push({ ref, opts });
        return { x: 639, y: 783, reachable: true, covering: null, scrolledFrom: null, proxiedFrom: null };
      }
    },
    "{ getTargetCoordinates }"
  ).getTargetCoordinates;

  const hit = getTargetCoordinates({ role: "link", name: "Click để tìm kiếm nâng cao" });
  ok(hit && hit.ref === "ref_5", "role+name resolves to the live element (whitespace-normalized equality)");
  ok(hit && hit.x === 639 && hit.y === 783 && hit.reachable === true, "...and carries the resolved point back");
  ok(
    calls.coords.length === 1 && calls.coords[0].ref === "ref_5" && calls.coords[0].opts.scrollIntoView === true,
    "the matched element goes through the SHIPPED getRefCoordinates (scroll into view included)"
  );

  const roleMismatch = getTargetCoordinates({ role: "button", name: "Click để tìm kiếm nâng cao" });
  ok(roleMismatch && roleMismatch.ref === "ref_5", "role is preferred, not required — a re-roled control with the same name still resolves");

  const miss = getTargetCoordinates({ role: "link", name: "Nút không tồn tại trên trang" });
  ok(miss === null, "no match is a real null — never a nearest-lookalike guess");

  calls.find.length = 0;
  ok(getTargetCoordinates({ name: "   " }) === null && calls.find.length === 0, "an empty identity never even searches");

  ok(
    /msg\.type === "getTargetCoordinates"/.test(contentSrc) &&
      /getTargetCoordinates\(\s*\{ role: msg\.role, name: msg\.name \}/.test(contentSrc),
    "the message handler is wired in the shipped listener with the role/name pair"
  );
}

// ==========================================================================
console.log("\n== background.js: computer() tries the live ref first, then the frozen target ==");
{
  const body = extractMethod("computer");
  ok(/if \(args\.ref \|\| args\.target\) \{/.test(body), "a step is aimed whenever it carries a ref or a frozen target");
  const iRef = body.indexOf("resolveRefToCoordinates(tabId, args.ref)");
  const iTarget = body.indexOf("resolveTargetToCoordinates(tabId, args.target)");
  ok(iRef !== -1 && iTarget !== -1 && iRef < iTarget, "the live ref is tried first (same-document precision), the frozen target second");
  ok(/if \(!res && args\.target\) \{/.test(body), "the target is only consulted when the ref did not resolve");
  ok(
    /Could not resolve the step target \$\{aim\} — no element matching that identity exists on the page\./.test(body),
    "a target that no longer matches fails with the drift-classified wording"
  );
  ok(/if \(aimRef && coordinate\) \{/.test(body), "hit notes key off the ref that actually resolved, from either source");

  const form = extractMethod("form_input");
  const iFormTarget = form.indexOf("resolveTargetToCoordinates(tabId, target)");
  const iFormSet = form.indexOf('type: "setFormValue"');
  ok(iFormTarget !== -1 && iFormSet !== -1 && iFormTarget < iFormSet, "form_input resolves the frozen target into a live ref BEFORE setting the value");
  ok(
    /Could not resolve the step target \$\{describeTargetText\(target\)\} — no element matching that identity exists/.test(form),
    "form_input's target miss uses the same drift-classified wording"
  );
}

// ==========================================================================
console.log("\n== the failure wording classifies as drift through BOTH executor gates ==");
{
  const driftReason = compile(extractFn("shortcutDriftReason", bgSrc), {}, "{ shortcutDriftReason }").shortcutDriftReason;
  const failed = compile(extractFn("batchItemResultFailed", bgSrc), {}, "{ batchItemResultFailed }").batchItemResultFailed;

  const missText = `Could not resolve the step target link "Tìm kiếm" — no element matching that identity exists on the page. The site has changed since this step was recorded; the workflow needs healing.`;
  const unreachableText = `Could not bring the step target combobox "Nơi thực hiện" into view — it is still outside the viewport after scrolling, so a click there would land on the page background rather than the element.`;

  ok(driftReason(missText) === "target_no_longer_resolves", "a target miss is target_no_longer_resolves (drift), not a transient failure");
  ok(driftReason(unreachableText) === "target_no_longer_resolves", "an unreachable target is drift too");
  ok(failed({ content: [{ type: "text", text: missText }] }) === true, "the executor's step gate sees the target miss as a FAILED step");
  ok(failed({ content: [{ type: "text", text: unreachableText }] }) === true, "...and the unreachable one as well");
}

// ==========================================================================
console.log("\n== resolveTargetToCoordinates: the wire message carries the identity, not a handle ==");
{
  const sent = [];
  const resolveTargetToCoordinates = compile(
    extractFn("resolveTargetToCoordinates", bgSrc),
    {
      sendContentMessage: async (tabId, msg) => {
        sent.push({ tabId, msg });
        return { result: { ref: "ref_12", x: 3, y: 4, reachable: true } };
      }
    },
    "{ resolveTargetToCoordinates }"
  ).resolveTargetToCoordinates;

  const res = await resolveTargetToCoordinates(7, { role: "link", name: "Tìm kiếm" });
  ok(res && res.ref === "ref_12", "the resolved record is returned as-is");
  ok(sent.length === 1 && sent[0].tabId === 7, "exactly one content message, to the addressed tab");
  ok(
    sent[0].msg.type === "getTargetCoordinates" && sent[0].msg.role === "link" && sent[0].msg.name === "Tìm kiếm" && sent[0].msg.scrollIntoView === true,
    "it asks by identity (role + name) and scrolls by default"
  );

  const noResp = compile(
    extractFn("resolveTargetToCoordinates", bgSrc),
    { sendContentMessage: async () => undefined },
    "{ resolveTargetToCoordinates }"
  ).resolveTargetToCoordinates;
  ok((await noResp(7, { name: "x" })) === null, "a missing answer resolves to null, never a fabricated point");
}

// ==========================================================================
console.log("\n== describeTargetText: failure texts name WHAT was aimed at ==");
{
  const describeTargetText = compile(extractFn("describeTargetText", bgSrc), {}, "{ describeTargetText }").describeTargetText;
  ok(describeTargetText({ role: "link", name: "Tìm kiếm" }) === 'link "Tìm kiếm"', "role + name reads as the element's identity");
  ok(describeTargetText({ name: "Tìm kiếm" }) === '"Tìm kiếm"', "a missing role is simply omitted");
  ok(describeTargetText(null) === '""', "junk input never throws");
}

console.log(fail ? `\n${fail} failed\n` : "\nall passed\n");
process.exit(fail ? 1 : 0);
