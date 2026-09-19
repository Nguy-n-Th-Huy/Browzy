// page_snapshot, service-worker half (openspec/changes/add-typesafe-jev-provider,
// design.md section 2 / specs/agent-browser-runtime.md "Page snapshot
// operation").
//
// The shipped handler body is extracted from extension/background.js and run
// with its dependencies injected (the mask-sensitive-info.test.mjs pattern),
// so the checks under test are the ones that ship. What is proven here: the
// handler performs the same group + readability checks read_page performs,
// BEFORE anything reaches the tab; it forwards exactly one read message; the
// tool's text is the observation contract as JSON; and no page-mutating path
// exists in it.
import fs from "node:fs";
import { extractMethod, extractFunction, compile, BACKGROUND } from "./_extract.mjs";

let fail = 0;
const ok = (c, m) => { console.log((c ? "  PASS " : "  FAIL ") + m); if (!c) fail++; };

const bgSrc = fs.readFileSync(BACKGROUND, "utf8");
const handlerSrc = `const H = { ${extractMethod("page_snapshot")} };`;
const mkHandler = new Function(
  "isInGroup", "checkTabReadableForExtraction", "sendContentMessage",
  handlerSrc + "; return H.page_snapshot;"
);

/** A stand-in for the three dependencies the handler closes over, recording
 * the order it was asked for them. */
function makeWorld(state) {
  const order = [];
  const sends = [];
  const fn = mkHandler(
    async (tabId) => { order.push(`isInGroup:${tabId}`); return state.inGroup.includes(tabId); },
    async (tabId) => { order.push(`readable:${tabId}`); return state.restricted || null; },
    async (tabId, msg) => { order.push(`send:${tabId}`); sends.push({ tabId, msg }); return state.response; }
  );
  return { fn, order, sends };
}

const textOf = (result) => result.content[0].text;

// --- 1. Pre-dispatch checks, before anything reaches the tab ---------------
console.log("== pre-dispatch checks come first ==");
{
  const w = makeWorld({ inGroup: [], response: undefined });
  const r = await w.fn({ tabId: 5 });
  ok(/not in the MCP group/.test(textOf(r)), "an out-of-scope tab is refused");
  ok(w.order.length === 1 && w.order[0] === "isInGroup:5", `the refusal comes from the scope check alone (${JSON.stringify(w.order)})`);
  ok(w.sends.length === 0, "nothing was sent to the tab");
}
{
  const w = makeWorld({ inGroup: [], response: undefined });
  const r = await w.fn({});
  ok(/not in the MCP group/.test(textOf(r)) && w.sends.length === 0, "a call with no tabId is refused the same way, with no dispatch");
}
{
  const restricted = { content: [{ type: "text", text: "Restricted page: tab 5 (chrome://settings) ..." }] };
  const w = makeWorld({ inGroup: [5], restricted, response: undefined });
  const r = await w.fn({ tabId: 5 });
  ok(r === restricted, "a restricted/stale tab's result is returned as-is");
  ok(w.sends.length === 0, "and no read message is sent to it");
  ok(w.order.join(",") === "isInGroup:5,readable:5", `the readability check runs only after the scope check (${JSON.stringify(w.order)})`);
}

// --- 2. The read it forwards, and the text it returns --------------------
console.log("== structured unavailable observations use the real readability gate ==");
{
  const marker = "const RESTRICTED_URL_PATTERN =";
  const start = bgSrc.indexOf(marker);
  const restrictionSource = bgSrc.slice(start, bgSrc.indexOf(";", start) + 1);
  const calls = [];
  const tabs = new Map([
    [5, { id: 5, url: "chrome://newtab/" }],
    [6, { id: 6, url: "chrome://settings" }],
    [7, { id: 7, url: "about:blank" }],
    [8, { id: 8, url: "https://chromewebstore.google.com/detail/example" }],
    [9, { id: 9, url: "https://example.com/flights" }]
  ]);
  const observation = { v: 1, url: tabs.get(9).url, title: "Flights", text: "Current page", elements: [] };
  const shipped = compile([
    restrictionSource,
    extractFunction("checkTabReadableForExtraction"),
    extractFunction("batchItemResultFailed"),
    `const H = { ${extractMethod("page_snapshot")}, ${extractMethod("read_page")}, ${extractMethod("get_page_text")} };`
  ].join("\n"), {
    chrome: {
      tabs: { get: async (tabId) => {
        calls.push({ type: "tabs.get", tabId });
        if (!tabs.has(tabId)) throw new Error("No tab with this id");
        return tabs.get(tabId);
      } },
      scripting: { executeScript: async () => { throw new Error("Unavailable pages must never trigger script injection"); } }
    },
    isInGroup: async () => true,
    sendContentMessage: async (tabId, message) => {
      calls.push({ type: "content", tabId, message });
      if (tabId !== 9) throw new Error("An unavailable page must never receive a content message");
      return { result: observation };
    }
  }, "{ ...H, batchItemResultFailed }");

  for (const tabId of [5, 6, 7, 8, 404]) {
    calls.length = 0;
    const result = await shipped.page_snapshot({ tabId });
    const expectedReason = tabId === 404 ? "stale_context" : "restricted_page";
    const expectedUrl = tabs.get(tabId)?.url || null;
    const payload = JSON.parse(textOf(result));
    ok(payload.v === 1 && payload.available === false && payload.reason === expectedReason,
      `tab ${tabId}: unavailable snapshot is parseable versioned JSON with the actual refusal reason`);
    ok(payload.tabId === tabId && payload.url === expectedUrl,
      `tab ${tabId}: refusal retains the requested tab identity and actual URL, never a replacement page`);
    ok(payload.elements === undefined && payload.text === undefined && payload.title === undefined,
      `tab ${tabId}: refusal fabricates no page content or controls`);
    ok(result.isError === true && shipped.batchItemResultFailed(result) === true,
      `tab ${tabId}: generic batch/workflow classification still sees failure despite JSON text`);
    ok(calls.length === 1 && calls[0].type === "tabs.get" && calls[0].tabId === tabId,
      `tab ${tabId}: no content dispatch, injection, or active-tab fallback is attempted`);
  }

  for (const tool of ["read_page", "get_page_text"]) {
    for (const tabId of [5, 404]) {
      calls.length = 0;
      const result = await shipped[tool]({ tabId });
      const expectedPrefix = tabId === 404 ? "Stale context:" : "Restricted page:";
      ok(textOf(result).startsWith(expectedPrefix) && textOf(result).includes(`tab ${tabId}`) && result.isError === undefined,
        `${tool} tab ${tabId}: existing human-readable refusal remains unchanged`);
      ok(calls.length === 1 && calls[0].type === "tabs.get", `${tool} tab ${tabId}: refusal still precedes any page access`);
    }
  }

  calls.length = 0;
  const readable = await shipped.page_snapshot({ tabId: 9 });
  ok(JSON.stringify(JSON.parse(textOf(readable))) === JSON.stringify(observation) && readable.isError !== true,
    "a real readable page keeps its ordinary snapshot contract, without unavailable metadata");
  ok(calls.length === 2 && calls[1].type === "content" && calls[1].message.type === "pageSnapshot",
    "readable pages still send exactly one snapshot request after the same readability check");
}

console.log("== forwarding and result shape ==");
{
  const payload = {
    v: 1,
    url: "https://shop.example.com/checkout",
    title: "Thanh toán",
    viewport: { w: 1280, h: 720 },
    scroll: { y: 340, height: 5120 },
    text: "Nội dung trang",
    truncated: { elements: false, text: false, omitted: 0 },
    elements: [{
      ref: "ref_7", role: "button", label: "Đặt hàng", tag: "button", type: "",
      value: "", editable: false, readonly: false, contenteditable: false,
      disabled: false, checked: false, selected: false, expanded: false
    }, {
      ref: "ref_8", role: "combobox", label: "Tỉnh", tag: "select", type: "select-one",
      value: "HN", editable: false, readonly: false, contenteditable: false,
      disabled: false, checked: false, selected: true, expanded: false,
      options: [{ label: "Hà Nội", value: "HN", selected: true }]
    }]
  };
  const w = makeWorld({ inGroup: [11], response: { result: payload } });
  const r = await w.fn({ tabId: 11 });

  ok(w.order.join(",") === "isInGroup:11,readable:11,send:11", `scope and readability both precede the tab dispatch (${JSON.stringify(w.order)})`);
  ok(w.sends.length === 1 && w.sends[0].tabId === 11, "exactly one message goes to the requested tab");
  ok(JSON.stringify(w.sends[0].msg) === JSON.stringify({ type: "pageSnapshot" }),
    `the forwarded message is the read request and nothing else (${JSON.stringify(w.sends[0].msg)})`);

  ok(r.content.length === 1 && r.content[0].type === "text", "the tool result is a single text content item (no image, no extra items)");
  const parsed = JSON.parse(textOf(r));
  ok(JSON.stringify(parsed) === JSON.stringify(payload), "the tool's text IS the observation contract, unmodified");
  ok(parsed.elements.length === 2 && parsed.elements[1].options[0].selected === true,
    "the contract's nested fields survive the round trip");
}
{
  // An unexpected/absent answer (an older content script that never answered
  // usefully) is a named observation failure, never an empty page.
  const w = makeWorld({ inGroup: [11], response: { ok: true } });
  const r = await w.fn({ tabId: 11 });
  ok(/Could not produce a page snapshot/.test(textOf(r)), "a missing result is reported as a failed observation");
}

// --- 3. No page-mutating path -------------------------------------------
console.log("== no page-mutating path ==");
{
  const src = handlerSrc;
  const MUTATING = [
    "setFormValue", "getRefCoordinates", "describePoint", "markElementForUpload",
    "annotateElements", "Input.", "dispatchMouseEvent", "dispatchKeyEvent",
    "scrollIntoView", ".focus(", "computer", "form_input", "javascript_tool", "Runtime.evaluate"
  ];
  for (const token of MUTATING) {
    ok(!src.includes(token), `the handler never reaches for ${token}`);
  }
  ok(!/args\.(?!tabId)[a-zA-Z_]+/.test(src), "no argument other than tabId is read from the call");
}

// --- 4. Registration and routing -----------------------------------------
console.log("== registration ==");
{
  const handlersStart = bgSrc.indexOf("const toolHandlers = {");
  const nextTopLevelConst = bgSrc.indexOf("\nconst ", handlersStart);
  const handlerIndex = bgSrc.indexOf("  async page_snapshot(args) {");
  ok(handlersStart !== -1 && handlerIndex > handlersStart && handlerIndex < nextTopLevelConst,
    "page_snapshot is a method of the toolHandlers object the dispatcher looks tools up in by name");
  ok(/toolHandlers\[name\]/.test(bgSrc) && /toolHandlers\[tool\]/.test(bgSrc),
    "the dispatchers resolve handlers by tool name, so registration is the whole route");
  ok((bgSrc.match(/async page_snapshot\(args\)/g) || []).length === 1,
    "exactly one page_snapshot handler exists — no second, parallel route to the page");
}

// --- 5. Workflow/shortcut wiring -----------------------------------------
console.log("== shortcut wiring ==");
{
  const produces = compile(extractFunction("shortcutStepProducesContent"), {}, "shortcutStepProducesContent");
  ok(produces("page_snapshot", {}) === true, "a page_snapshot step is a content-producing step");
  ok(produces("navigate", {}) === false && produces("computer", { action: "left_click" }) === false,
    "and the classification still says no to a navigation and a click");

  const setSrc = /const SHORTCUT_TAB_SCOPED_TOOLS = new Set\(\[([\s\S]*?)\]\)/.exec(bgSrc);
  const names = setSrc ? setSrc[1].split(",").map((s) => s.trim().replace(/^"|"$/g, "")).filter(Boolean) : [];
  ok(names.includes("page_snapshot"), "page_snapshot is tab-scoped, so a step that omits tabId inherits the shortcut's tab");
}

// --- 6. Action-event classification --------------------------------------
// The extension-side half of the registry wiring (task 1.4): the action-event
// schema must see this operation exactly as it sees read_page, so the overlay
// and the companion timeline describe it as a read and never fabricate a
// pointer for it.
console.log("== action-event classification ==");
{
  const ae = await import("../extension/events/action-events.js");
  const classified = ae.classifyAction("page_snapshot", { tabId: 11 });
  ok(classified.type === ae.ACTION_TYPES.READ && classified.type === ae.classifyAction("read_page", {}).type,
    "page_snapshot classifies as the same read type read_page gets");
  ok(ae.isPointerCapable(classified.type) === false, "a read is never pointer-capable (no fabricated mouse movement)");
  const summary = ae.summarize("page_snapshot", { tabId: 11 });
  ok(summary.summary === "Read page snapshot", `the label is human-readable (${summary.summary})`);
  ok(summary.redaction.applied === false, "and it carries no page content of its own");
}

console.log(fail === 0 ? "\nALL PAGE-SNAPSHOT BACKGROUND TESTS PASSED" : `\n${fail} FAILED`);
process.exit(fail ? 1 : 0);
