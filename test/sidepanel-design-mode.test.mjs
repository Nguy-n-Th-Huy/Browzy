#!/usr/bin/env node
// Panel-side coverage for design mode (openspec/changes/add-design-mode-
// element-picker), tasks.md 5.7: the composer toggle's refusal surfacing,
// the picked-element chip's removal coupling, and the stale-identity
// refusal (design.md D8) that must fail to dispatch rather than silently
// sending an element from a page the message no longer targets.
//
// extension/sidepanel/sidepanel.js touches `document`/`chrome` at module
// load and cannot be imported directly in plain Node (the same reason every
// other test/sidepanel-*.test.mjs file either imports a smaller DOM-free
// module or — like test/composer-add-and-effort.test.mjs and
// test/composer-textarea-scroll.test.mjs — asserts structurally against the
// shipped source). This file does both: the design-mode functions that do
// NOT depend on the rest of the panel's DOM are extracted via
// test/_extract.mjs and run for real against fakes (the same technique
// test/overlay-pointer.test.mjs and test/element-picker-*.test.mjs use);
// doSend()'s own stale-identity branch — which depends on nearly every
// other panel module — is proven structurally instead, the same way
// test/action-events-emission.test.mjs proves handleToolRequest's call
// ordering without executing it.
//
// Run: node test/sidepanel-design-mode.test.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractFunction, compile } from "./_extract.mjs";
import { sameIdentity } from "../extension/sidepanel/page-context.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PANEL_FILE = path.join(ROOT, "extension", "sidepanel", "sidepanel.js");
const SRC = fs.readFileSync(PANEL_FILE, "utf8");
const PANEL_CSS = fs.readFileSync(path.join(ROOT, "extension", "sidepanel", "sidepanel.css"), "utf8");
const PANEL_HTML = fs.readFileSync(path.join(ROOT, "extension", "sidepanel", "sidepanel.html"), "utf8");

let fail = 0;
const ok = (c, m) => { console.log((c ? "  PASS " : "  FAIL ") + m); if (!c) fail++; };
const extract = (name) => extractFunction(name, PANEL_FILE);

// =============================================================================
// 1. toggleDesignMode(): both activation refusals surface their specific
//    cause, and the mode never appears active until background confirms it
//    (design.md D9).
// =============================================================================
console.log("== toggleDesignMode: activation refusals surface their specific cause ==");
function buildToggleHarness({ sendMessageImpl, snapshot }) {
  const calls = { shown: [], cleared: 0 };
  let designModeActive = false;
  let designModeTabId = null;
  let pendingDesignModeIdentity = null;
  const fakePageContext = {
    snapshot: () => snapshot,
    identityForRecord: () => ({ tabId: snapshot && snapshot.tabId, url: snapshot && snapshot.url, doc: null })
  };
  const src = [
    extract("renderDesignModeButton"),
    extract("cancelDesignModeIfActive"),
    extract("toggleDesignMode")
  ].join("\n\n");
  const H = compile(
    src,
    {
      el: { btnDesignMode: { setAttribute: () => {} } },
      DESIGN_MODE_REFUSAL_MESSAGES: (() => {
        const m = SRC.match(/const DESIGN_MODE_REFUSAL_MESSAGES = \{([\s\S]*?)\n\};/);
        return Function(`return {${m[1]}};`)();
      })(),
      canAcceptAttachments: () => true,
      pageContext: fakePageContext,
      chrome: { runtime: { sendMessage: sendMessageImpl } },
      showAttachmentError: (msg) => calls.shown.push(msg),
      clearAttachmentError: () => { calls.cleared++; },
      get designModeActive() { return designModeActive; },
      set designModeActive(v) { designModeActive = v; },
      get designModeTabId() { return designModeTabId; },
      set designModeTabId(v) { designModeTabId = v; },
      get pendingDesignModeIdentity() { return pendingDesignModeIdentity; },
      set pendingDesignModeIdentity(v) { pendingDesignModeIdentity = v; }
    },
    "({ toggleDesignMode, get designModeActive(){ return designModeActive; } })"
  );
  return { H, calls };
}

{
  const { H, calls } = buildToggleHarness({
    snapshot: { tabId: 7, url: "https://x.example/" },
    sendMessageImpl: async () => ({ ok: false, reason: "restricted_page" })
  });
  await H.toggleDesignMode();
  ok(H.designModeActive === false, "a restricted-page refusal never flips the mode active");
  ok(calls.shown.length === 1 && typeof calls.shown[0] === "string" && calls.shown[0].length > 0, "a specific message was shown");
  ok(calls.shown[0].includes("trang này"), "the restricted-page message names the page as the cause");
}
{
  const { H, calls } = buildToggleHarness({
    snapshot: { tabId: 7, url: "https://x.example/" },
    sendMessageImpl: async () => ({ ok: false, reason: "agent_driving" })
  });
  await H.toggleDesignMode();
  ok(H.designModeActive === false, "an agent-driving refusal never flips the mode active");
  ok(calls.shown.length === 1 && calls.shown[0].toLowerCase().includes("agent"), "the agent-driving message names the agent as the cause");
}
{
  // The two refusal messages must actually be DIFFERENT strings — proving
  // "surfacing their specific cause" rather than one generic failure notice.
  const r1 = await buildToggleHarness({ snapshot: { tabId: 7, url: "https://x.example/" }, sendMessageImpl: async () => ({ ok: false, reason: "restricted_page" }) });
  await r1.H.toggleDesignMode();
  const r2 = await buildToggleHarness({ snapshot: { tabId: 7, url: "https://x.example/" }, sendMessageImpl: async () => ({ ok: false, reason: "agent_driving" }) });
  await r2.H.toggleDesignMode();
  ok(r1.calls.shown[0] !== r2.calls.shown[0], "restricted_page and agent_driving surface DIFFERENT messages, not one shared string");
}
{
  const { H, calls } = buildToggleHarness({
    snapshot: { tabId: 7, url: "https://x.example/" },
    sendMessageImpl: async () => ({ ok: true })
  });
  await H.toggleDesignMode();
  ok(H.designModeActive === true, "a successful activation flips the mode active");
  ok(calls.shown.length === 0, "no error is shown on success");
}
{
  const { H } = buildToggleHarness({ snapshot: null, sendMessageImpl: async () => ({ ok: true }) });
  await H.toggleDesignMode();
  ok(H.designModeActive === false, "with no bound page at all, activation is refused locally — background is never even asked");
}

// =============================================================================
// 2. clearPickedElement(): removing the chip removes its underlying
//    attachment too, not just the record.
// =============================================================================
console.log("\n== clearPickedElement: removal drops both the record and its image attachment ==");
{
  const calls = { removed: [], rendered: 0 };
  let pickedElement = { record: { tagName: "button", selector: "#buy" }, attachmentId: "att-1", identity: { tabId: 7, url: "https://x.example/", doc: null } };
  let attachments = [{ id: "att-1" }, { id: "att-2" }];
  const H = compile(
    extract("clearPickedElement"),
    {
      get pickedElement() { return pickedElement; },
      set pickedElement(v) { pickedElement = v; },
      attachments,
      removeAttachment: (id) => calls.removed.push(id),
      renderAttachments: () => { calls.rendered++; }
    },
    "clearPickedElement"
  );
  H();
  ok(calls.removed.length === 1 && calls.removed[0] === "att-1", "removing the chip removes the SAME attachment id the pick added — not left as an orphaned image");
  // `pickedElement` is a closure variable inside the compiled function, not
  // observable by reference from here (compile() passes dependencies by
  // value, not as live bindings) — so the clear is proven behaviorally
  // instead: calling clearPickedElement() AGAIN must now hit the function's
  // own `if (!pickedElement) return;` guard and do nothing further, which is
  // only possible if the first call really nulled it out.
  H();
  ok(calls.removed.length === 1, "a second clearPickedElement() call is a no-op — the record was really cleared, not merely re-read as truthy");
}
{
  // The attachment was already removed some other way (e.g. the operator
  // removed it directly from the strip) — clearing the record must not
  // throw trying to remove it again.
  const calls = { removed: [], rendered: 0 };
  let pickedElement = { record: { tagName: "img", selector: "" }, attachmentId: "gone", identity: null };
  const attachments = [];
  const H = compile(
    extract("clearPickedElement"),
    {
      get pickedElement() { return pickedElement; },
      set pickedElement(v) { pickedElement = v; },
      attachments,
      removeAttachment: (id) => calls.removed.push(id),
      renderAttachments: () => { calls.rendered++; }
    },
    "clearPickedElement"
  );
  H();
  ok(calls.removed.length === 0, "an already-gone attachment is not asked to be removed a second time");
  ok(calls.rendered === 1, "the strip still re-renders so the chip visually disappears");
}

// =============================================================================
// 3. design.md D8: the exact identity shape doSend() compares (tabId + url +
//    doc — never the display `_revision`) actually catches a real page swap,
//    and does NOT false-positive on a cosmetic update (title/favicon only,
//    same document).
// =============================================================================
console.log("\n== design.md D8: sameIdentity() on the record shape doSend() builds ==");
{
  const pickedIdentity = { tabId: 7, url: "https://a.example/checkout", doc: { confirmed: true, docNonce: "n1", generation: 1 } };
  const sentSameDoc = { tabId: 7, url: "https://a.example/checkout", doc: { confirmed: true, docNonce: "n1", generation: 1 } };
  ok(sameIdentity(pickedIdentity, sentSameDoc), "same tab, same url, same confirmed document: identity matches");

  const sentDifferentTab = { tabId: 9, url: "https://a.example/checkout", doc: { confirmed: true, docNonce: "n1", generation: 1 } };
  ok(!sameIdentity(pickedIdentity, sentDifferentTab), "a different tab is a real retarget — must NOT match");

  const sentDifferentUrl = { tabId: 7, url: "https://a.example/cart", doc: { confirmed: true, docNonce: "n1", generation: 1 } };
  ok(!sameIdentity(pickedIdentity, sentDifferentUrl), "a different URL on the same tab is a real retarget — must NOT match");

  const sentReloaded = { tabId: 7, url: "https://a.example/checkout", doc: { confirmed: true, docNonce: "n2", generation: 1 } };
  ok(!sameIdentity(pickedIdentity, sentReloaded), "a same-URL reload (new docNonce) is a real document replacement — must NOT match, even though tabId/url alone look unchanged");

  ok(!sameIdentity(pickedIdentity, null), "no live context at all (e.g. the tab closed) never matches a recorded identity");
}

// =============================================================================
// 4. Structural: the stale-identity branch in doSend() never reaches
//    panel.sendMessage() — the correctness failure task 5.7's verify note
//    names.
// =============================================================================
console.log("\n== structural: doSend()'s stale-identity branch returns before any dispatch ==");
{
  const doSendSrc = extract("doSend");
  ok(/if \(pickedElement\) \{/.test(doSendSrc), "doSend() has a picked-element branch");
  const staleBlock = doSendSrc.match(/if \(!sameIdentity\(pickedElement\.identity, sentIdentity\)\) \{([\s\S]*?)\n\s{4}\}/);
  ok(!!staleBlock, "found the stale-identity refusal block");
  ok(staleBlock[1].includes("clearPickedElement()"), "the stale pick is dropped (record + its attachment, via clearPickedElement())");
  ok(/\breturn;\s*\/\/ never dispatch/.test(staleBlock[1]), "and the function returns — never falling through to build tabScope/attachments/panel.sendMessage for this activation");
  const returnIdx = staleBlock.index + staleBlock[0].indexOf("return;");
  const sendIdx = doSendSrc.indexOf("panel.sendMessage(");
  ok(returnIdx < sendIdx, "textually, the stale-identity return precedes the only panel.sendMessage() call in doSend()");
}
{
  ok(/pickedElement = null;\s*\n\s*clearAttachments\(\);/.test(SRC), "on a SUCCESSFUL send, the picked element is cleared alongside the ordinary attachment clear (task 5.6)");
}

// =============================================================================
// 5. Structural: the composer control is accessible and its active state is
//    not colour-only (task 5.1).
// =============================================================================
console.log("\n== structural: the composer toggle is an ordinary, accessible control ==");
ok(/<button class="btn-icon" id="btn-design-mode" type="button" aria-pressed="false" aria-label="[^"]+">/.test(PANEL_HTML),
   "an ordinary <button> with an accessible name and aria-pressed, alongside the other composer controls");
ok(/el\.btnDesignMode\.addEventListener\("click"/.test(SRC), "wired via addEventListener, not an inline handler (matches this panel's CSP)");
{
  const block = PANEL_CSS.match(/#btn-design-mode\[aria-pressed="true"\] \{([\s\S]*?)\}/);
  ok(!!block, "an active-state CSS rule exists, keyed off aria-pressed (state-driven, not a JS-toggled class alone)");
  ok(/border|background/.test(block[1]), "the active state changes border/background, not only a text/icon colour");
  const dotBlock = PANEL_CSS.match(/#btn-design-mode\[aria-pressed="true"\]::after \{([\s\S]*?)\}/);
  ok(!!dotBlock && /border-radius:\s*50%/.test(dotBlock[1]), "plus a shape (a dot) — the state is legible without relying on colour perception at all");
}

// =============================================================================
// 6. Structural: the picked-element chip renders alongside the attachment
//    thumbnails (task 5.2), and carries a recognizable descriptor.
// =============================================================================
console.log("\n== structural: the picked-element chip lives in the attachment strip and names what was picked ==");
{
  const renderSrc = extract("renderAttachments");
  ok(renderSrc.includes('strip.appendChild(chip)'), "the chip is appended to the SAME #attachment-strip the image thumbnails render into");
  ok(renderSrc.includes("pickedElement.record.tagName") && renderSrc.includes("pickedElement.record.selector"),
     "the chip's label is built from the picked element's tag and selector — recognizable before sending");
}

console.log(fail === 0 ? "\nALL SIDEPANEL DESIGN-MODE TESTS PASSED\n" : `\n${fail} FAILED\n`);
process.exit(fail ? 1 : 0);
