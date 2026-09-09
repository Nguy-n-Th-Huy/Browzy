#!/usr/bin/env node
//
// The bound page-context channel (design.md section 5 / 5b): proves the
// deviation is fixed at the layer that actually reaches the SDK.
//
// Before this fix, extension/sidepanel/context-binding.js composed a
// `<bound_page_context>` block directly into the wire `prompt` string,
// because neither host/agent/companion.js nor host/agent/tools/
// query-options.js exposed a separate context/system-prompt hook. That
// contradicted design.md section 5 ("User messages and page/tool content
// remain distinctly typed") and 5b ("structured trusted metadata").
//
// This suite proves, against the REAL host/agent/companion.js and
// host/agent/tools/query-options.js (no live SDK, browser, or credential —
// `sdk` and `profileProvider` are injected fakes, same pattern as
// host/test/agent-skills-wiring.test.mjs):
//   1. A `start` envelope's `context` field (the panel's structured
//      trusted-metadata object) reaches the constructed `query()` options as
//      a DISTINCTLY TYPED field (`options.systemPrompt`), never mixed into
//      `prompt`.
//   2. The `prompt` the SDK actually receives is EXACTLY the user's own
//      literal text — nothing prepended, nothing appended.
//   3. `renderPageContextSystemPrompt()`/`buildIsolatedOptions()` still
//      escalate to the imperative live-extraction instruction when the
//      panel's metadata says `mustRead: true` (the Vietnamese acceptance
//      fixture path), and this reaches the model on `systemPrompt`, not
//      `prompt`.
//   4. No page context on the envelope -> no `systemPrompt` option at all
//      (byte-identical to this channel's absence — no regression for every
//      existing START call across the suite that never sends `context`).
//
// Run: node host/test/agent-context-channel.test.mjs

import { CompanionCore } from "../agent/companion.js";
import { TranscriptStore } from "../agent/storage/transcript-store.js";
import { BrowserLease } from "../agent/broker/browser-lease.js";
import { ApprovalRegistry } from "../agent/policy/approvals.js";
import { SessionManager } from "../agent/session/manager.js";
import { ToolBridge } from "../agent/broker/tool-bridge.js";
import { AGENT_MESSAGE_TYPES, makeEnvelope } from "../agent/protocol.js";
import { buildIsolatedOptions, renderPageContextSystemPrompt } from "../agent/tools/query-options.js";

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  PASS  ${name}`);
  } catch (err) {
    results.push({ name, ok: false, err: err.stack || err.message });
    console.log(`  FAIL  ${name} — ${err.stack || err.message}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function fakeProfileProvider() {
  return {
    async snapshotForRun(profileId, modelId) {
      return {
        model: modelId || "claude-fake-model",
        env: { ANTHROPIC_BASE_URL: "https://example.invalid", ANTHROPIC_API_KEY: "fake-key" },
        revision: 1,
        profileId: profileId || "default"
      };
    }
  };
}

// Records every query() call's {prompt, options}; yields one message then completes.
function recordingSdk() {
  const calls = [];
  const sdk = {
    async *query({ prompt, options }) {
      calls.push({ prompt, options });
      yield { type: "assistant", text: "ok" };
    }
  };
  return { sdk, calls };
}

function buildCore({ sdk, profileProvider } = {}) {
  const store = new TranscriptStore();
  const lease = new BrowserLease();
  const approvals = new ApprovalRegistry();
  const sessionManager = new SessionManager({ store, lease, approvals });
  const toolBridge = new ToolBridge({
    init: async () => {},
    callTool: async (name) => ({ content: [{ type: "text", text: `fake:${name}` }] }),
    shutdown: () => {}
  });
  return new CompanionCore({
    toolBridge,
    sessionManager,
    lease,
    coerceArgs: (a) => a,
    sdk: sdk || recordingSdk().sdk,
    profileProvider: profileProvider || fakeProfileProvider()
  });
}

async function waitForEvent(core, conversationId, predicate, { timeoutMs = 3000 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const snap = core.sessionManager.snapshotSince(conversationId, 0);
    const found = snap.events.find(predicate);
    if (found) return found;
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error("timed out waiting for expected event");
}

console.log("\nBound page-context channel (design.md section 5 / 5b)\n");

// --- Unit tests: renderPageContextSystemPrompt() / buildIsolatedOptions() -----

await test("renderPageContextSystemPrompt() returns null when no context is bound", () => {
  assert(renderPageContextSystemPrompt(null) === null, "no context -> no systemPrompt text");
  assert(renderPageContextSystemPrompt(undefined) === null, "undefined context -> no systemPrompt text");
});

await test("renderPageContextSystemPrompt() renders the exact bound tabId/url/title, labeled as non-content", () => {
  const text = renderPageContextSystemPrompt({
    tabId: 42,
    url: "https://vnexpress.net/a",
    title: "Kinh tế quý III",
    hostname: "vnexpress.net",
    revision: 3,
    boundAt: 1000,
    restricted: false,
    pinned: false,
    mustRead: false
  });
  assert(text.includes('tab_id="42"'), "the exact bound tabId must appear");
  assert(text.includes("https://vnexpress.net/a"), "the exact bound URL must appear");
  assert(text.includes("NOT page content"), "metadata must be explicitly labeled as non-content");
  assert(!text.includes("You MUST call"), "an unrelated (mustRead:false) context must get the SOFT instruction");
});

await test("renderPageContextSystemPrompt() escalates to the imperative live-extraction instruction when mustRead is true", () => {
  const text = renderPageContextSystemPrompt({
    tabId: 7,
    url: "https://example.com/article",
    title: "Article",
    hostname: "example.com",
    revision: 1,
    boundAt: Date.now(),
    restricted: false,
    pinned: false,
    mustRead: true
  });
  assert(/Call get_page_text or read_page/.test(text), "mustRead:true must produce the live-extraction instruction");
  assert(text.includes("tab_id=7"), "the imperative instruction must name the exact bound tabId");
  assert(text.includes("metadata alone"), "must explicitly say metadata alone does not count as reading");
});

await test("renderPageContextSystemPrompt() flags a restricted page without ever implying it was read", () => {
  const text = renderPageContextSystemPrompt({
    tabId: 9,
    url: "chrome://settings",
    title: "Settings",
    hostname: null,
    revision: 1,
    boundAt: Date.now(),
    restricted: true,
    pinned: false,
    mustRead: false
  });
  assert(/get_page_text\/read_page will refuse/.test(text), "a restricted page must be flagged, not silently sent for extraction");
});

await test("buildIsolatedOptions(): no pageContext -> no bound-page-context block (the workflow guidance is a separate, unconditional block)", () => {
  const options = buildIsolatedOptions({
    mcpServer: { fake: "server" },
    serverName: "srv",
    snapshot: { model: "claude-x", env: { ANTHROPIC_API_KEY: "k", ANTHROPIC_BASE_URL: "https://x" } },
    skills: { cwd: "/scratch/conv-1", configDir: "/scratch/conv-1/claude-config", pluginDir: "/scratch/conv-1/skills-plugin", allowedSkillNames: [], skillOverrides: {} }
  });
  // The systemPrompt field itself is always present now — it carries the
  // unconditional browsing-workflow guidance, which every run needs and which
  // has nothing to do with a bound page. What must never appear without a
  // bound context is THIS channel: the page-context block and its tab id.
  assert(!options.systemPrompt.prompt.includes("<bound_page_context"), "omitting pageContext must never introduce a bound-page-context block");
  assert(!/tab_id=/.test(options.systemPrompt.prompt), "and never a tab id the caller did not bind");
  assert(options.systemPrompt.prompt.includes("## Tab context and session startup"), "the browser-automation instructions are still attached — a run with no bound page still has to know how to drive the browser");
});

await test("buildIsolatedOptions(): a bound pageContext becomes options.systemPrompt as a DISTINCT field — never options.prompt/options.text", () => {
  const options = buildIsolatedOptions({
    mcpServer: { fake: "server" },
    serverName: "srv",
    snapshot: { model: "claude-x", env: { ANTHROPIC_API_KEY: "k", ANTHROPIC_BASE_URL: "https://x" } },
    skills: { cwd: "/scratch/conv-1", configDir: "/scratch/conv-1/claude-config", pluginDir: "/scratch/conv-1/skills-plugin", allowedSkillNames: [], skillOverrides: {} },
    pageContext: {
      tabId: 42,
      url: "https://vnexpress.net/a",
      title: "Bài viết",
      hostname: "vnexpress.net",
      revision: 1,
      boundAt: Date.now(),
      restricted: false,
      pinned: false,
      mustRead: true
    }
  });
  assert(options.systemPrompt && options.systemPrompt.type === "custom", "pageContext must render into a custom systemPrompt (sdk.d.ts Options.systemPrompt)");
  assert(options.systemPrompt.prompt.includes('tab_id="42"'), "the systemPrompt text must carry the exact bound tabId");
  assert(!("prompt" in options), "buildIsolatedOptions must never itself carry a `prompt` field — the run's prompt stays a separate call argument");
});

// --- Full CompanionCore flow: `start` envelope -> real query() call --------

await test("a `context` field on `start` reaches query()'s options.systemPrompt; the SDK's `prompt` is EXACTLY the user's literal text", async () => {
  const { sdk, calls } = recordingSdk();
  const core = buildCore({ sdk });
  await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.HELLO, {}));
  const { conversationId } = await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.NEW, {}));

  await core.handleEnvelope(
    makeEnvelope(AGENT_MESSAGE_TYPES.START, {
      conversationId,
      tabScope: [42],
      prompt: "đọc bài viết này và phân tích",
      context: {
        tabId: 42,
        url: "https://vnexpress.net/a",
        title: "Bài viết",
        hostname: "vnexpress.net",
        revision: 1,
        boundAt: Date.now(),
        restricted: false,
        pinned: false,
        mustRead: true
      }
    })
  );
  await waitForEvent(core, conversationId, (e) => e.type === "run_done");

  assert(calls.length === 1, "exactly one query() call was made");
  assert(calls[0].prompt === "đọc bài viết này và phân tích", "the SDK's `prompt` must be EXACTLY the user's literal text — no bound-context markup mixed in");
  assert(!calls[0].prompt.includes("tab_id"), "the SDK's `prompt` must never contain any bound-context markup");
  assert(calls[0].options.systemPrompt && calls[0].options.systemPrompt.type === "custom", "the bound context must reach query() options as systemPrompt — a distinctly typed field from `prompt`");
  assert(calls[0].options.systemPrompt.prompt.includes('tab_id="42"'), "the systemPrompt text must carry the exact bound tabId");
  assert(/Call get_page_text or read_page/.test(calls[0].options.systemPrompt.prompt), "mustRead:true metadata must escalate to the live-extraction instruction, on systemPrompt not prompt");
});

await test("a `start` with no `context` field produces no bound-page-context block (existing calls are unaffected)", async () => {
  const { sdk, calls } = recordingSdk();
  const core = buildCore({ sdk });
  await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.HELLO, {}));
  const { conversationId } = await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.NEW, {}));

  await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.START, { conversationId, prompt: "what is the capital of France?" }));
  await waitForEvent(core, conversationId, (e) => e.type === "run_done");

  assert(calls.length === 1, "exactly one query() call was made");
  assert(calls[0].prompt === "what is the capital of France?", "prompt is exactly the user's text");
  assert(!calls[0].options.systemPrompt.prompt.includes("<bound_page_context"), "no context field on start -> no bound-page-context block");
  assert(calls[0].options.systemPrompt.prompt.includes("## Tab context and session startup"), "...while the unconditional browser-automation instructions are still there");
});

await test("two consecutive runs bound to different tabs never cross-contaminate each other's systemPrompt", async () => {
  const { sdk, calls } = recordingSdk();
  const core = buildCore({ sdk });
  await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.HELLO, {}));
  const { conversationId: conv1 } = await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.NEW, {}));

  await core.handleEnvelope(
    makeEnvelope(AGENT_MESSAGE_TYPES.START, {
      conversationId: conv1,
      prompt: "đọc bài này",
      context: { tabId: 1, url: "https://a.example/", title: "A", hostname: "a.example", revision: 1, boundAt: Date.now(), mustRead: true }
    })
  );
  await waitForEvent(core, conv1, (e) => e.type === "run_done");

  const { conversationId: conv2 } = await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.NEW, {}));
  await core.handleEnvelope(
    makeEnvelope(AGENT_MESSAGE_TYPES.START, {
      conversationId: conv2,
      prompt: "đọc bài này",
      context: { tabId: 2, url: "https://b.example/", title: "B", hostname: "b.example", revision: 1, boundAt: Date.now(), mustRead: true }
    })
  );
  await waitForEvent(core, conv2, (e) => e.type === "run_done");

  assert(calls.length === 2, "two runs made two query() calls");
  assert(calls[0].prompt === "đọc bài này" && calls[1].prompt === "đọc bài này", "both prompts are the identical literal user text");
  assert(calls[0].options.systemPrompt.prompt.includes("https://a.example/") && !calls[0].options.systemPrompt.prompt.includes("https://b.example/"), "first run's systemPrompt is bound only to A");
  assert(calls[1].options.systemPrompt.prompt.includes("https://b.example/") && !calls[1].options.systemPrompt.prompt.includes("https://a.example/"), "second run's systemPrompt is bound only to B");
});

// --- A current-page request still drives the live-extraction instruction;
// an unrelated message does not (metadata alone never counts as reading) ---

await test("a current-page-referencing request reaches query() with the imperative live-extraction instruction naming the run's own bound/scoped tabId", async () => {
  // This is the mechanism that "still drives real live extraction" (task
  // requirement 3): the model decides whether to actually call
  // get_page_text/read_page (that part is inherently model behavior, not
  // scriptable without a live SDK — see reports/05-context-binding-evidence.md's
  // own "behavior itself depends on the model, as designed" note), but the
  // CODE-SIDE guarantee this task owns is that the imperative instruction
  // (a) is present, (b) names the EXACT tabId the run is scoped to
  // (tabScope: [42], the same value passed on `start`), and (c) explicitly
  // states metadata alone does not count as reading — all on the SDK's
  // systemPrompt channel, never the user's own prompt text.
  const { sdk, calls } = recordingSdk();
  const core = buildCore({ sdk });
  await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.HELLO, {}));
  const { conversationId } = await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.NEW, {}));

  await core.handleEnvelope(
    makeEnvelope(AGENT_MESSAGE_TYPES.START, {
      conversationId,
      tabScope: [42],
      prompt: "đọc bài viết này và phân tích",
      context: { tabId: 42, url: "https://vnexpress.net/a", title: "Bài viết", hostname: "vnexpress.net", revision: 1, boundAt: Date.now(), mustRead: true }
    })
  );
  await waitForEvent(core, conversationId, (e) => e.type === "run_done");

  assert(calls.length === 1, "one query() call was made");
  const sp = calls[0].options.systemPrompt.prompt;
  assert(/Call get_page_text or read_page/.test(sp), "a current-page request must still produce the live-extraction instruction");
  assert(sp.includes("tab_id=42"), "the instruction must name the exact tabId the run is scoped to");
  assert(sp.includes("metadata alone"), "must explicitly say metadata alone does not count as reading");
});

await test("an unrelated (non-current-page) request gets only the conditional instruction, never the imperative one", async () => {
  const { sdk, calls } = recordingSdk();
  const core = buildCore({ sdk });
  await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.HELLO, {}));
  const { conversationId } = await core.handleEnvelope(makeEnvelope(AGENT_MESSAGE_TYPES.NEW, {}));

  await core.handleEnvelope(
    makeEnvelope(AGENT_MESSAGE_TYPES.START, {
      conversationId,
      tabScope: [42],
      prompt: "hôm nay thời tiết thế nào?",
      context: { tabId: 42, url: "https://vnexpress.net/a", title: "Bài viết", hostname: "vnexpress.net", revision: 1, boundAt: Date.now(), mustRead: false }
    })
  );
  await waitForEvent(core, conversationId, (e) => e.type === "run_done");

  const sp = calls[0].options.systemPrompt.prompt;
  assert(!/You MUST call/.test(sp), "an unrelated message must never get the imperative instruction");
  // The conditional branch was narrowed to name what actually requires a read —
  // being asked something ABOUT the page's content — because the older wording
  // ("concerns this page") pulled in every question that merely happened to be
  // asked while a page was bound.
  assert(
    /If the user is asking you to tell them something ABOUT this page's content/.test(sp),
    "an unrelated message still gets the soft, conditional instruction"
  );
});

const failed = results.filter((r) => !r.ok);
console.log(
  `\n${results.length - failed.length}/${results.length} passed` +
    (failed.length ? `\n\nFailures:\n${failed.map((f) => `  - ${f.name}: ${f.err}`).join("\n")}` : "") +
    "\n"
);
process.exit(failed.length ? 1 : 0);
