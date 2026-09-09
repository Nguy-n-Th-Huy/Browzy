#!/usr/bin/env node
// The composer's prompt-enhancement control (openspec/changes/
// add-composer-enhance-prompt). Same constraint as
// test/composer-add-and-effort.test.mjs: sidepanel.js touches `document`/
// `chrome.*` at module scope, so it cannot be imported into a plain-Node
// test without a browser. This holds the same class of seam that test
// already covers for Send/attachments/effort -- the exact gating
// expressions, the exact wire calls, and the exact restore/commit behavior
// -- as source-level assertions against the shipped file, so a change here
// that silently drops a branch (e.g. the in-flight-must-stay-clickable rule,
// or the stale-requestId guard) fails a test instead of only showing up in
// manual QA.
//
// Run: node test/composer-enhance-prompt.test.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

let fail = 0;
const ok = (cond, msg) => {
  console.log((cond ? "  PASS  " : "  FAIL  ") + msg);
  if (!cond) fail++;
};

const panelJs = read("extension/sidepanel/sidepanel.js");
const panelHtml = read("extension/sidepanel/sidepanel.html");
const panelCss = read("extension/sidepanel/sidepanel.css");

console.log("\n== the control exists and is positioned immediately before Send ==");
{
  const actionsStart = panelHtml.indexOf('<div class="composer-actions">');
  ok(actionsStart >= 0, "sidepanel.html has a .composer-actions block");
  const enhanceAt = panelHtml.indexOf('id="btn-enhance"', actionsStart);
  const sendAt = panelHtml.indexOf('id="btn-send"', actionsStart);
  ok(enhanceAt >= 0 && sendAt >= 0 && enhanceAt < sendAt, "#btn-enhance appears before #btn-send inside .composer-actions");
  ok(/id="btn-enhance"[^>]*aria-label="Cải thiện prompt"/.test(panelHtml), "the button carries an accessible name from the start");
  ok(/<button[^>]*id="btn-enhance"/.test(panelHtml), "it is a real <button>, reachable and operable by keyboard like Send");
}

console.log("\n== registered in the el map and rendered with the existing spark icon ==");
{
  ok(/btnEnhance:\s*\$\("btn-enhance"\)/.test(panelJs), "el.btnEnhance is registered");
  ok(/el\.btnEnhance\.innerHTML\s*=\s*iconMarkup\("spark"/.test(panelJs), "idle presentation renders the existing spark icon (no new icon added)");
}

console.log("\n== availability gating lives inside updateSendEnabled(), not a parallel function ==");
{
  const block = panelJs.match(/function updateSendEnabled\(\)\s*\{([\s\S]*?)\n\}/);
  ok(Boolean(block), "updateSendEnabled() is found");
  const body = block[1];
  ok(/if \(el\.btnEnhance\) el\.btnEnhance\.disabled = true;/.test(body), "disabled outright while a run is queued/streaming/stopping/waiting-for-permission");
  ok(/el\.btnSend\.disabled = false; \/\/ acts as Stop/.test(body), "Send's own running-state behaviour is unchanged");
  ok(/if \(enhanceState\)/.test(body) && /el\.btnEnhance\.disabled = false;/.test(body), "while its own request is in flight, the control stays enabled (acts as Cancel) rather than being disabled");
  ok(/isSlashCommand/.test(body) && /trimmed\.startsWith\("\/"\)/.test(body), "a leading '/' disables it (the dispatched slash command's literal text must never be rewritten)");
  ok(
    /el\.btnSend\.disabled = !hasText \|\| !panel\.currentConversationId \|\| !!enhanceState;/.test(body),
    "Send itself is also disabled while an enhancement is in flight, matching that doSend() bails in that state -- its visible state must never look clickable while a click would silently no-op"
  );
  ok(
    /el\.btnEnhance\.disabled = !hasText \|\| !panel\.currentConversationId \|\| isSlashCommand;/.test(body),
    "otherwise: disabled exactly on empty/whitespace draft, no conversation, or a slash command -- the same signals Send already uses, plus the slash rule"
  );
  ok(!/function updateEnhanceEnabled/.test(panelJs), "no separate/parallel gating function was introduced");
}

console.log("\n== single in-flight state, snapshot-and-restore ==");
{
  ok(/let enhanceState = null;/.test(panelJs), "one module-level slot, starting idle");
  ok(/function restoreEnhanceState\(/.test(panelJs), "a single restore helper every failure/cancel path funnels through");
  const restoreBlock = panelJs.match(/function restoreEnhanceState\([^)]*\)\s*\{([\s\S]*?)\n\}/)[1];
  ok(/el\.composerInput\.readOnly = false;/.test(restoreBlock), "restore clears read-only");
  ok(/el\.composerInput\.removeAttribute\("aria-busy"\);/.test(restoreBlock), "restore clears aria-busy");
  ok(/el\.composerInput\.value = originalText;/.test(restoreBlock), "restore puts back the EXACT pre-request text, not a placeholder");
  ok(/updateEnhanceButtonPresentation\(\);/.test(restoreBlock) && /updateSendEnabled\(\);/.test(restoreBlock), "restore re-derives both the button presentation and the gating");
}

console.log("\n== doEnhance(): idle starts a request, in-flight cancels ==");
{
  const block = panelJs.match(/function doEnhance\(\)\s*\{([\s\S]*?)\n\}/)[1];
  ok(/if \(enhanceState\)/.test(block), "branches on the current state");
  ok(/op: "cancel"/.test(block), "in-flight click sends op:cancel");
  ok(/restoreEnhanceState\(\);/.test(block), "cancel restores the composer LOCALLY and immediately -- it does not wait for a reply");
  ok(/const originalText = el\.composerInput\.value;/.test(block), "idle click snapshots the exact current composer text before anything else changes it");
  ok(/el\.composerInput\.readOnly = true;/.test(block), "idle click makes the composer read-only");
  ok(/el\.composerInput\.setAttribute\("aria-busy", "true"\);/.test(block), "idle click marks the composer busy");
  ok(/op: "generate"/.test(block), "idle click sends op:generate");
  ok(/profileId: panel\.profile && panel\.profile\.profileId/.test(block), "profileId comes from the same source panel-controller.js's sendMessage() uses");
  ok(
    /modelId: panel\._selectedModelId \|\| \(panel\.profile && panel\.profile\.defaultModelId\)/.test(block),
    "modelId is the panel's currently selected model, same as what START would carry"
  );
}
ok(/el\.btnEnhance\.addEventListener\("click", doEnhance\);/.test(panelJs), "doEnhance is wired to a real click listener, not an inline handler (CSP)");

console.log("\n== doSend() refuses to dispatch while an enhancement is in flight ==");
{
  const block = panelJs.match(/async function doSend\(\)\s*\{([\s\S]*?)\n\}/)[1];
  const guardAt = block.indexOf("if (enhanceState) return;");
  const phaseCheckAt = block.indexOf("const phase = panel.currentPhase();");
  ok(guardAt >= 0 && phaseCheckAt >= 0 && guardAt < phaseCheckAt, "the enhanceState guard runs before anything else in doSend() -- readOnly does not stop keydown, so Enter must be refused before dispatch/stop logic runs");
}

console.log("\n== the success path commits through the browser's native undo path ==");
{
  const block = panelJs.match(/function commitEnhancedText\([^)]*\)\s*\{([\s\S]*?)\n\}/)[1];
  ok(/el\.composerInput\.focus\(\);/.test(block), "focuses the composer");
  ok(/el\.composerInput\.select\(\);/.test(block), "selects the current (pre-replacement) text");
  ok(/document\.execCommand\("insertText", false, text\)/.test(block), "commits via execCommand(\"insertText\") so native Ctrl+Z restores the draft -- no separate Revert control");
  ok(/el\.composerInput\.value = text;/.test(block), "falls back to a plain assignment if execCommand is unavailable, so the text still lands");
  ok(/autoGrow\(\);/.test(block), "re-measures the composer height for the new text");
}

console.log("\n== the reply handler: stale requestId ignored, every failure path restores ==");
{
  const block = panelJs.match(/function handleEnhanceEnvelope\(env\)\s*\{([\s\S]*?)\n\}/)[1];
  ok(/if \(!enhanceState\) return;/.test(block), "no-op when nothing is in flight");
  ok(/if \(env\.requestId !== enhanceState\.requestId\) return;/.test(block), "a reply for any other requestId is dropped, not applied");
  ok(/commitEnhancedText\(text\);/.test(block), "ok:true commits the rewritten text");
  ok(/restoreEnhanceState\(\{ message \}\);/.test(block), "ok:false restores with a distinguishable message from the error");
  ok(
    /env\.reason === "unknown_message_type" && env\.inReplyTo === MSG\.ENHANCE_PROMPT/.test(block),
    "an older companion's unknown_message_type/enhance_prompt reply is recognized explicitly"
  );
  ok(/Companion cần được cập nhật/.test(block), "and mapped to an explicit 'companion needs updating' message, not a silent failure");
}
ok(/protocolClient\.onEnvelope\(handleEnhanceEnvelope\);/.test(panelJs), "the handler is actually subscribed");
{
  const disconnectBlock = panelJs.match(/protocolClient\.onDisconnect\(\(\) => \{([\s\S]*?)\n\}\);/);
  ok(Boolean(disconnectBlock), "a disconnect handler is registered for the in-flight case");
  ok(/if \(enhanceState\) restoreEnhanceState/.test(disconnectBlock[1]), "losing the companion connection while in flight restores the composer");
}

console.log("\n== busy/disabled CSS presentation reuses existing primitives ==");
{
  ok(/#btn-enhance:disabled/.test(panelCss), "a disabled rule exists for the control");
  ok(/#btn-enhance\.is-busy \.ui-icon/.test(panelCss) && /busy-spin/.test(panelCss), "the busy presentation reuses the existing busy-spin keyframe, not a new animation");
  ok(/el\.btnEnhance\.classList\.add\("is-busy"\)/.test(panelJs), "JS toggles the is-busy class the CSS above keys off of");
}

console.log(fail === 0 ? "\nALL COMPOSER ENHANCE-PROMPT TESTS PASSED\n" : `\n${fail} FAILED\n`);
process.exit(fail ? 1 : 0);
