#!/usr/bin/env node
// The side panel's pre-setup empty state (extension/sidepanel/sidepanel.js).
//
// The defect this covers: with nothing configured, the panel rendered
// "Sẵn sàng trên trang này" / "Chào bạn, tôi có thể giúp gì?" plus three
// example requests UNCONDITIONALLY (sidepanel.js:2850-2872 called at
// :2576-2579 with no readiness input), while the actual blocker sat in a
// one-line strip *below* it, above the composer. The three examples fill the
// composer with prompts the send path refuses while the profile is incomplete,
// so the panel's largest text claimed a readiness that had not been reached —
// on the first surface a new user ever sees.
//
// sidepanel.js touches `document`/`chrome.*` at module scope and cannot be
// imported (its own header: verified by screenshots, not a DOM-diffing test),
// so this file does what test/_extract.mjs exists for: pull the SHIPPED
// functions out by brace-matching and run them with their dependencies
// injected. Nothing here is a copy of the implementation.
//
// Run: node test/sidepanel-setup-walkthrough.test.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compile, extractFunction } from "./_extract.mjs";
import { deriveSetupSteps, SETUP_STEP } from "../extension/setup-walkthrough.js";
import { iconMarkup } from "../extension/ui/icons.js";
import { escapeHtml } from "../extension/sidepanel/markdown-lite.js";
import { READINESS } from "../extension/sidepanel/profile-cache.js";
import { RUN_PHASE } from "../extension/sidepanel/run-states.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SIDEPANEL = path.join(ROOT, "extension", "sidepanel", "sidepanel.js");
const source = fs.readFileSync(SIDEPANEL, "utf8");

let fail = 0;
const ok = (cond, msg) => {
  console.log((cond ? "  PASS " : "  FAIL ") + msg);
  if (!cond) fail++;
};

/** A flat `const name = { ... };` declaration, sliced out of the shipped
 * source. The four tables this file needs carry no nested braces, so a plain
 * brace match is exact — and it keeps the test reading the shipped values
 * instead of a restatement of them. */
function extractConstObject(name) {
  const start = source.indexOf(`const ${name} = {`);
  if (start === -1) throw new Error(`const ${name} = { not found in sidepanel.js`);
  let depth = 0;
  for (let i = source.indexOf("{", start); i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) return `${source.slice(start, i + 1)};`;
    }
  }
  throw new Error(`unbalanced braces extracting ${name}`);
}

function buildEmptyStateHtml(panel) {
  const declaration = [
    extractConstObject("SETUP_STEP_ANCHOR"),
    extractConstObject("SETUP_STEP_STATE_VI"),
    extractConstObject("SETUP_STEP_STATE_TONE"),
    extractConstObject("SETUP_STEP_LINK_VI"),
    extractFunction("deriveSetupInput", SIDEPANEL),
    extractFunction("emptyStateHtml", SIDEPANEL)
  ].join("\n");
  return compile(
    declaration,
    { deriveSetupSteps, SETUP_STEP, escapeHtml, iconMarkup, READINESS, RUN_PHASE, panel },
    "emptyStateHtml()"
  );
}

const panelFor = ({ readiness, profile = {}, handshake = null, phase = RUN_PHASE.EMPTY }) => ({
  profile,
  readinessState: () => ({ state: readiness }),
  currentPhase: () => phase,
  protocol: { handshakeDetail: () => handshake }
});

console.log("\n== not ready: the panel states the steps instead of claiming it is ready ==");
{
  const html = buildEmptyStateHtml(
    panelFor({ readiness: READINESS.NOT_CONFIGURED, profile: { providerType: "anthropic", hasCredential: false, models: [] } })
  );

  ok(!html.includes("Sẵn sàng trên trang này"), "the readiness eyebrow is not rendered");
  ok(!html.includes("Chào bạn, tôi có thể giúp gì?"), "the greeting is not rendered");
  ok(!html.includes("data-suggest"), "no example request is offered — the send path would refuse it");
  ok(html.includes("setup-walkthrough"), "the walkthrough is rendered");

  for (const title of ["Nhà cung cấp", "Mô hình", "Kiểm tra kết nối"]) {
    ok(html.includes(`>${title}<`), `the step "${title}" is named`);
  }
  ok(html.includes("Còn <strong>3 bước</strong>"), "the intro counts what is left");
  ok(html.includes("Bước tiếp theo: <strong>Nhà cung cấp</strong>"), "the intro names the next step");

  const current = html.match(/data-step="([^"]+)" aria-current="step"/);
  ok(current && current[1] === "provider", "the first unsatisfied step is marked as current");
  ok(html.includes('data-setup-anchor="section-provider"'), "the provider step links to its settings section");
  ok(html.includes('data-setup-anchor="section-models"'), "the model step links to its settings section");
  ok(html.includes('data-setup-anchor="btn-test-connection"'), "the connection step links to the test control");
}

console.log("\n== the companion is a step with instructions, not a settings link ==");
{
  const html = buildEmptyStateHtml(
    panelFor({
      readiness: READINESS.NOT_CONFIGURED,
      profile: { providerType: "anthropic", hasCredential: false, models: [] },
      handshake: "companion_not_installed",
      phase: RUN_PHASE.ERROR
    })
  );

  ok(html.includes('data-step="companion"'), "the companion is the leading step");
  ok(/install\.sh|install\.ps1/.test(html), "its detail states the command that fixes it");
  const companionRow = html.slice(html.indexOf('data-step="companion"'), html.indexOf('data-step="provider"'));
  ok(!companionRow.includes("data-setup-anchor"), "no settings link is offered for it — the fix is on the machine");
  ok(html.indexOf('data-step="companion"') < html.indexOf('data-step="provider"'), "it precedes the profile steps");
}

console.log("\n== an unknown companion state is never claimed to be missing ==");
{
  const html = buildEmptyStateHtml(
    panelFor({ readiness: READINESS.NOT_CONFIGURED, profile: { hasCredential: false, models: [] } })
  );
  ok(!html.includes('data-step="companion"'), "no companion step is invented without evidence");
  ok(!html.includes("Chưa cài companion"), "and the panel does not say the companion is missing");
}

console.log("\n== a step already satisfied is shown as satisfied, and an in-flight nobody claims done ==");
{
  const credentialOnly = buildEmptyStateHtml(
    panelFor({
      readiness: READINESS.PARTIAL,
      profile: { providerType: "anthropic", hasCredential: true, models: [], defaultModelId: null }
    })
  );
  ok(credentialOnly.includes('data-step="provider" aria-current="step"') === false, "the satisfied provider step is not the current one");
  const providerRow = credentialOnly.slice(credentialOnly.indexOf('data-step="provider"'), credentialOnly.indexOf('data-step="models"'));
  ok(providerRow.includes("Xong"), "…it is labelled Xong");
  ok(credentialOnly.includes('data-step="models" aria-current="step"'), "the model step is marked as the next one");
  ok(credentialOnly.includes("Còn <strong>2 bước</strong>"), "the count excludes the satisfied step");
}

console.log("\n== a ready profile gets exactly the surface it had before ==");
{
  const html = buildEmptyStateHtml(
    panelFor({
      readiness: READINESS.READY,
      profile: { providerType: "anthropic", hasCredential: true, models: [{ id: "m1" }], defaultModelId: "m1" }
    })
  );

  ok(html.includes("Sẵn sàng trên trang này"), "the eyebrow is back");
  ok(html.includes("Chào bạn, tôi có thể giúp gì?"), "the greeting is back");
  ok((html.match(/data-suggest="/g) || []).length === 3, "the three example requests are back");
  ok(html.includes("Tóm tắt bài viết trên trang này giúp mình."), "with their exact prompts");
  ok(!html.includes("setup-walkthrough"), "and no walkthrough is shown");
}

console.log("\n== a companion that cannot run a seemingly ready profile still blocks it ==");
{
  const html = buildEmptyStateHtml(
    panelFor({
      readiness: READINESS.READY,
      profile: { providerType: "anthropic", hasCredential: true, models: [{ id: "m1" }], defaultModelId: "m1" },
      handshake: "companion_not_installed",
      phase: RUN_PHASE.ERROR
    })
  );
  ok(!html.includes("Sẵn sàng trên trang này"), "the cached profile does not make the panel ready");
  ok(html.includes('data-step="companion" aria-current="step"'), "the companion step is what is next");
}

console.log("\n== the step order this renders is the shared module's ==");
{
  const input = { providerType: "anthropic", hasCredential: false, models: [], defaultModelId: null, connectionStatus: null, busy: {} };
  const html = buildEmptyStateHtml(panelFor({ readiness: READINESS.NOT_CONFIGURED, profile: input }));
  const rendered = [...html.matchAll(/data-step="([^"]+)"/g)].map((m) => m[1]);
  const expected = deriveSetupSteps({ ...input, companion: null }).steps.map((step) => step.key);
  ok(JSON.stringify(rendered) === JSON.stringify(expected), `the rendered order is ${expected.join(" -> ")}`);
  ok(rendered.every((key) => key !== SETUP_STEP.COMPANION), "no companion step without evidence");
}

console.log(fail === 0 ? "\nALL SIDEPANEL SETUP-WALKTHROUGH TESTS PASSED\n" : `\n${fail} FAILED\n`);
process.exit(fail ? 1 : 0);
