#!/usr/bin/env node
//
// Workflow materialization: deriving a draft from a COMPLETED run's recorded
// trail (openspec/changes/add-workflow-materialization-and-heal tasks 1.1-1.3).
//
// What this pins, in the order the frozen contract states it:
//   - the trail source is the transcript's stored stream_message events (the
//     same bytes the panel replays), so arguments are REAL recorded values;
//   - the keep/exclude rule (bookkeeping tools dropped, registry tools kept);
//   - the screen: credential-shaped argument KEYS, opaque high-entropy
//     VALUES, and user-file tools become specific incompleteness reasons —
//     and neither the value nor any run OUTPUT can reach a definition;
//   - domain binding from recorded data, document binding optional;
//   - "no draft at all" outcomes: unknown run, unfinished run, no trail.
//
// Run: node host/test/workflows-materialize.test.mjs

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ocic-materialize-"));
process.env.OCIC_AGENT_HOME = scratch;

const materialize = await import("../agent/skills/workflows-materialize.js");
const schema = await import("../agent/skills/workflows-schema.js");
const run = await import("../agent/skills/workflows-run.js");
const timeline = await import("../agent/storage/action-timeline.js");

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  PASS  ${name}`);
  } catch (err) {
    results.push({ name, ok: false, err: err.message });
    console.log(`  FAIL  ${name} — ${err.message}\n${err.stack}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assertion failed");
}
function expectCode(fn, code) {
  try {
    fn();
  } catch (err) {
    if (err.code === code) return err;
    throw new Error(`expected code ${code}, got ${err.code}: ${err.message}`);
  }
  throw new Error(`expected code ${code}, but nothing threw`);
}

const RUN_ID = "run_materialize_1";

function toolUse(name, input, id) {
  return { type: "tool_use", id: id || `tu_${name}_${Math.random().toString(36).slice(2, 8)}`, name, input };
}

/** One stored assistant message event, exactly as SessionManager's sink
 *  appends it: `{type:"stream_message", message: <SDKAssistantMessage>}`. */
function assistantEvent(seq, blocks) {
  return {
    seq,
    type: "stream_message",
    runId: RUN_ID,
    conversationId: "conv_test",
    message: { type: "assistant", message: { id: `msg_${seq}`, content: blocks }, session_id: "s1" }
  };
}

/** A stored user message carrying a tool_result (what the model SAW). */
function toolResultEvent(seq, toolUseId, text) {
  return {
    seq,
    type: "stream_message",
    runId: RUN_ID,
    conversationId: "conv_test",
    message: {
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: toolUseId, content: [{ type: "text", text }] }] },
      session_id: "s1"
    }
  };
}

/** A completed run's stored trail: created → messages → done. */
function trail({ messages = [], results = [], terminal = true } = {}) {
  const events = [{ seq: 1, type: "run_created", runId: RUN_ID, conversationId: "conv_test", tabScope: "any" }];
  let seq = 2;
  for (const [index, blocks] of messages.entries()) {
    events.push(assistantEvent(seq++, blocks));
    if (results[index]) events.push(toolResultEvent(seq++, blocks[0].id, results[index]));
  }
  if (terminal) events.push({ seq: seq++, type: "run_done", runId: RUN_ID, conversationId: "conv_test" });
  return events;
}

console.log("workflows-materialize (tasks 1.1-1.3)");

await check("trail: registry tool calls become steps in order; bookkeeping tools are dropped", () => {
  const events = trail({
    messages: [
      [toolUse("update_plan", { plan: "do the thing" })],
      [toolUse("navigate", { url: "https://shop.example.com/orders", tabId: 42 })],
      [toolUse("read_page", { tabId: 42 })],
      [toolUse("read_console_messages", { tabId: 42 })],
      [toolUse("find", { query: "Invoice 2024", tabId: 42 })],
      [toolUse("tabs_close_mcp", { tabId: 42 })]
    ]
  });
  const derived = materialize.deriveRunDraft({ conversationEvents: events, runId: RUN_ID });
  assert(derived.ok === true, `derivation should succeed: ${JSON.stringify(derived)}`);
  assert(derived.draft.steps.length === 3, `expected 3 kept steps, got ${derived.draft.steps.length}`);
  assert(
    derived.draft.steps.map((s) => s.ref).join(",") === "navigate,read_page,find",
    `order must follow the trail: ${JSON.stringify(derived.draft.steps.map((s) => s.ref))}`
  );
  // Arguments are the recorded literals, with the run-scoped tabId dropped:
  // the executor injects the addressed tab, so a frozen id would pin the
  // definition to a tab that no longer exists.
  const nav = derived.draft.steps[0];
  assert(nav.kind === "tool" && nav.args.url === "https://shop.example.com/orders", "navigate url preserved verbatim");
  assert(nav.args.tabId === undefined, "run-scoped tabId must never be frozen into a step");
  assert(derived.draft.steps[2].args.query === "Invoice 2024", "literal query preserved");
});

await check("trail: subagent tool calls are read from the run's own seq window only", () => {
  const events = [
    { seq: 1, type: "run_created", runId: RUN_ID, conversationId: "conv_test" },
    // Another run's message, outside this run's window.
    {
      seq: 2,
      type: "stream_message",
      runId: "run_other",
      conversationId: "conv_test",
      message: { type: "assistant", message: { id: "m2", content: [toolUse("navigate", { url: "https://other.example.com/" })] } }
    },
    assistantEvent(3, [toolUse("read_page", {})]),
    { seq: 4, type: "run_done", runId: RUN_ID, conversationId: "conv_test" }
  ];
  const derived = materialize.deriveRunDraft({ conversationEvents: events, runId: RUN_ID, metaHostname: "shop.example.com" });
  assert(derived.ok === true, `derivation should succeed: ${JSON.stringify(derived)}`);
  assert(derived.draft.steps.length === 1 && derived.draft.steps[0].ref === "read_page", "only this run's calls");
  assert(derived.draft.domains.join(",") === "shop.example.com", "another run's hosts must not leak in");
});

await check("trail: a redelivered tool_use block is one step, not two", () => {
  const block = toolUse("find", { query: "invoice" }, "tu_same");
  const events = [
    { seq: 1, type: "run_created", runId: RUN_ID, conversationId: "conv_test" },
    { seq: 2, type: "stream_message", runId: RUN_ID, message: { type: "assistant", message: { id: "m1", content: [block] } } },
    { seq: 3, type: "stream_message", runId: RUN_ID, message: { type: "assistant", message: { id: "m1", content: [block] } } },
    { seq: 4, type: "run_done", runId: RUN_ID }
  ];
  const derived = materialize.deriveRunDraft({ conversationEvents: events, runId: RUN_ID, metaHostname: "shop.example.com" });
  assert(derived.ok === true, "derivation succeeds");
  assert(derived.draft.steps.length === 1, `one action is one step: ${JSON.stringify(derived.draft.steps)}`);
});

await check("screen: a credential-shaped argument KEY is a reason naming the key, never the value", () => {
  const secret = "hunter2-correct-horse";
  const events = trail({
    messages: [
      [toolUse("navigate", { url: "https://shop.example.com/checkout" })],
      [toolUse("form_input", { tabId: 4, ref: "e1", value: "x", password: secret })]
    ]
  });
  const derived = materialize.deriveRunDraft({ conversationEvents: events, runId: RUN_ID });
  assert(derived.ok === false, "the draft must be withheld");
  assert(Array.isArray(derived.incomplete) && derived.incomplete.length === 1, `one specific reason: ${JSON.stringify(derived.incomplete)}`);
  assert(/password/.test(derived.incomplete[0]), `the reason names the argument: ${derived.incomplete[0]}`);
  assert(!JSON.stringify(derived).includes(secret), "the secret value must never appear in the derivation output");
});

await check("screen: an opaque high-entropy value is a reason, and never a constant", () => {
  const token = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
  const entropyToken = "9f3c1a7e5b2d8046ac1f7b93de05a2c4";
  assert(materialize.looksSecretBearing(token), "a JWT is credential-shaped");
  assert(materialize.looksSecretBearing(entropyToken), "a long mixed-alphabet token is high-entropy");
  assert(!materialize.looksSecretBearing("Invoice 2024 orders"), "ordinary text is not");
  assert(!materialize.looksSecretBearing("https://shop.example.com/orders?page=2"), "an ordinary URL is not");
  const events = trail({
    messages: [
      [toolUse("navigate", { url: "https://shop.example.com/orders" })],
      [toolUse("javascript_tool", { code: `authenticate("${entropyToken}")` })]
    ]
  });
  const derived = materialize.deriveRunDraft({ conversationEvents: events, runId: RUN_ID });
  assert(derived.ok === false, "the draft must be withheld");
  assert(
    derived.incomplete.some((r) => /high-entropy/.test(r)),
    `the reason must name the shape: ${JSON.stringify(derived.incomplete)}`
  );
  assert(!JSON.stringify(derived).includes(entropyToken), "the token must never appear anywhere in the result");
});

await check("screen: run OUTPUT (tool results, assistant text, action summaries) never reaches a definition", () => {
  const outputSecret = "sk-live-abcdef0123456789abcdef0123456789";
  const messages = [[toolUse("navigate", { url: "https://shop.example.com/orders", tabId: 7 })], [toolUse("get_page_text", { tabId: 7 })]];
  const events = trail({ messages, results: [null, `Fetched at 10:31 — api key ${outputSecret}`] });
  // The assistant's own summary text is an OUTPUT too, and a third recorded
  // source (the sanitized action timeline) carries a redacted summary — all
  // three must stay out of the derivation.
  events.splice(3, 0, assistantEvent(99, [{ type: "text", text: `I found the key ${outputSecret}` }]));
  const sanitized = timeline.sanitizeActionEvent({
    schemaVersion: 1,
    kind: "complete",
    seq: 1,
    streamKey: "run:run_materialize_1:tab:7",
    runId: RUN_ID,
    conversationId: "conv_test",
    actionId: "act_1",
    tabId: 7,
    documentId: "doc_1",
    ts: Date.now(),
    action: { type: "read", tool: "get_page_text", op: "read" },
    timing: { startedAt: Date.now() },
    pointer: null,
    capture: null,
    summary: `read the page (${outputSecret})`,
    redaction: { applied: false, reason: null },
    outcome: { status: "success", detail: null }
  });
  assert(sanitized.ok === true, "the fixture action event is well formed");
  events.push({ seq: 100, type: "action_event", runId: RUN_ID, conversationId: "conv_test", event: sanitized.event });
  events.push({ seq: 101, type: "run_done", runId: RUN_ID, conversationId: "conv_test" });

  const derived = materialize.deriveRunDraft({ conversationEvents: events, runId: RUN_ID });
  const serialized = JSON.stringify(derived);
  assert(!serialized.includes(outputSecret), "no recorded output may reach the draft");
  assert(!serialized.includes("Fetched at 10:31"), "tool result text must not be consulted");
  assert(!serialized.includes("I found the key"), "assistant text must not be consulted");
  // A definition built from the draft is data only: its steps are the tool
  // call's own arguments.
  assert(derived.ok === true, "an argument-only trail still derives");
  assert(derived.draft.steps[0].args.tabId === undefined, "still no run-scoped args");
});

await check("incomplete: unresolved arguments and per-run user files are named, not guessed", () => {
  const unresolved = trail({ messages: [[{ type: "tool_use", id: "tu_x", name: "navigate" }]] });
  const derivedUnresolved = materialize.deriveRunDraft({ conversationEvents: unresolved, runId: RUN_ID });
  assert(derivedUnresolved.ok === false && /arguments could not be resolved/.test(derivedUnresolved.incomplete[0]), "unresolved args named");

  const fileStep = trail({
    messages: [
      [toolUse("navigate", { url: "https://shop.example.com/" })],
      [toolUse("file_upload", { tabId: 7, ref: "e9", path: "C:/Users/me/secret-quote.pdf" })]
    ]
  });
  const derivedFile = materialize.deriveRunDraft({ conversationEvents: fileStep, runId: RUN_ID });
  assert(derivedFile.ok === false, "a per-run file cannot be frozen");
  assert(
    derivedFile.incomplete.some((r) => /file the operator picked/.test(r)),
    `the file step's reason is specific: ${JSON.stringify(derivedFile.incomplete)}`
  );
  assert(!JSON.stringify(derivedFile).includes("secret-quote.pdf"), "the local path is not echoed");
});

await check("no draft: unknown run, unfinished run, and a bookkeeping-only trail", () => {
  const completed = trail({ messages: [[toolUse("read_page", {})]] });
  assert(materialize.deriveRunDraft({ conversationEvents: completed, runId: "run_missing" }).reason === "unknown_run", "unknown run");

  const unfinished = trail({ messages: [[toolUse("read_page", {})]], terminal: false });
  const partial = materialize.deriveRunDraft({ conversationEvents: unfinished, runId: RUN_ID });
  assert(partial.ok === false && partial.reason === "run_not_completed", `unfinished run refused: ${JSON.stringify(partial)}`);

  const onlyBookkeeping = trail({ messages: [[toolUse("update_plan", { plan: "x" })], [toolUse("read_console_messages", {})]] });
  const none = materialize.deriveRunDraft({ conversationEvents: onlyBookkeeping, runId: RUN_ID });
  assert(none.ok === false && none.reason === "no_trail", `bookkeeping alone is no trail: ${JSON.stringify(none)}`);
});

await check("domain: recorded hosts bind the draft; the recorded hostname is the fallback; neither is a reason", () => {
  const multi = trail({
    messages: [
      [toolUse("navigate", { url: "https://shop.example.com/orders" })],
      [toolUse("navigate", { url: "https://pay.example.com/checkout" })]
    ]
  });
  const derived = materialize.deriveRunDraft({ conversationEvents: multi, runId: RUN_ID });
  assert(derived.ok === true, "derivation succeeds");
  assert(derived.draft.domain === "shop.example.com", "the first recorded host binds the draft");
  assert(
    derived.draft.domains.join(",") === "shop.example.com,pay.example.com",
    "every recorded host is carried, in trail order"
  );

  const noUrl = trail({ messages: [[toolUse("read_page", {})]] });
  const fallback = materialize.deriveRunDraft({
    conversationEvents: noUrl,
    runId: RUN_ID,
    metaHostname: "Shop.Example.com"
  });
  assert(fallback.ok === true && fallback.draft.domain === "shop.example.com", "conversation hostname normalizes into the binding");

  const missing = materialize.deriveRunDraft({ conversationEvents: noUrl, runId: RUN_ID });
  assert(missing.ok === false, "no recorded host anywhere is not derivable");
  assert(
    missing.incomplete.some((r) => /no page host/.test(r)),
    `the domain gap is a specific reason: ${JSON.stringify(missing.incomplete)}`
  );
});

await check("document binding is optional for a run trail, required for a recording", () => {
  const events = trail({ messages: [[toolUse("navigate", { url: "https://shop.example.com/" })]] });
  const derived = materialize.deriveRunDraft({ conversationEvents: events, runId: RUN_ID });
  assert(derived.ok === true && derived.draft.document === null, "no recorded document binding yields a null binding, not a refusal");

  const recording = run.buildRecordingDraft({
    events: [{ kind: "tool", ref: "find", params: { query: "x" } }],
    domain: "shop.example.com",
    document: null,
    workflow: { parameterSchema: {} }
  });
  assert(recording.ok === false && recording.incomplete.some((r) => /document/.test(r)), "the recording path still requires one");
});

await check("fallback: when the messages are gone, the sanitized action timeline yields reasons, never a fabricated draft", () => {
  const sanitized = timeline.sanitizeActionEvent({
    schemaVersion: 1,
    kind: "complete",
    seq: 1,
    streamKey: "run:run_materialize_1:tab:7",
    runId: RUN_ID,
    conversationId: "conv_test",
    actionId: "act_nav",
    tabId: 7,
    documentId: "doc_1",
    ts: Date.now(),
    action: { type: "open_page", tool: "navigate", op: "navigate" },
    timing: { startedAt: Date.now() },
    pointer: null,
    capture: null,
    summary: "opened https://shop.example.com/orders?token=SECRETXYZ",
    redaction: { applied: false, reason: null },
    outcome: { status: "success", detail: null }
  });
  assert(sanitized.ok === true, "fixture action event is well formed");
  const events = [
    { seq: 1, type: "run_created", runId: RUN_ID, conversationId: "conv_test" },
    // No stream_message events at all: the transcript's messages are gone
    // (pruned window), but the durable action record survives.
    { seq: 9, type: "action_event", runId: RUN_ID, conversationId: "conv_test", event: sanitized.event },
    { seq: 10, type: "run_done", runId: RUN_ID, conversationId: "conv_test" }
  ];
  const extracted = materialize.extractRunToolCalls({ conversationEvents: events, runId: RUN_ID });
  assert(extracted.ok === true && extracted.source === "action_timeline", "the fallback is identified as such");
  assert(extracted.calls[0].name === "navigate" && extracted.calls[0].argsResolved === false, "the tool name is real, the arguments are honestly unresolved");

  const derived = materialize.deriveRunDraft({ conversationEvents: events, runId: RUN_ID });
  assert(derived.ok === false, "no draft can be derived from names alone");
  assert(
    derived.incomplete.some((r) => /arguments could not be resolved/.test(r)),
    `the reason names the gap: ${JSON.stringify(derived.incomplete)}`
  );
  assert(!JSON.stringify(derived).includes("SECRETXYZ"), "the action's summary is never consulted, not even as a value source");
});

await check("registry validation is the last gate: the draft validates, an unsupported kind cannot sneak through", () => {
  const events = trail({
    messages: [
      [toolUse("navigate", { url: "https://shop.example.com/orders" })],
      [toolUse("find", { query: "invoice" })]
    ]
  });
  const derived = materialize.deriveRunDraft({ conversationEvents: events, runId: RUN_ID });
  assert(derived.ok === true, "derivation succeeds");
  const clean = schema.validateWorkflowRecord({
    id: derived.draft.workflowId,
    owner: "local-operator",
    name: derived.draft.name,
    domainConstraints: derived.draft.domains,
    steps: derived.draft.steps
  });
  assert(clean.steps.length === 2, "the derived definition passes the registry schema unchanged");
  expectCode(
    () =>
      schema.validateWorkflowRecord({
        id: derived.draft.workflowId,
        owner: "local-operator",
        name: derived.draft.name,
        steps: [...derived.draft.steps, { kind: "shell", ref: "rm -rf /" }]
      }),
    "UNSUPPORTED_STEP"
  );
  expectCode(
    () =>
      schema.validateWorkflowRecord({
        id: derived.draft.workflowId,
        owner: "local-operator",
        name: derived.draft.name,
        steps: [{ kind: "tool", ref: "find", args: {}, autoApprove: true }]
      }),
    "AUTO_APPROVE_FORBIDDEN"
  );
});

await check("entropy screen: prose, slugs and short values stay literals", () => {
  assert(materialize.entropyBitsPerChar("aaaa") === 0, "a single repeated character carries no entropy");
  assert(!materialize.looksSecretBearing("order-2024-11-13-invoice-0042"), "an ordinary slug is not a secret");
  assert(!materialize.looksSecretBearing("my long product description here"), "prose is not a secret");
  assert(!materialize.looksSecretBearing("1234"), "a short number is not a secret");
  assert(materialize.looksSecretBearing("4111 1111 1111 1111"), "a card-shaped value is credential material");
  assert(materialize.looksSecretBearing("https://api.example.com/v1/x?access_token=abcdef123456"), "a credential-named query parameter is");
  const screened = materialize.screenTrailArgs({ query: "invoice 2024", tabId: 9, nested: { apiKey: "abcdef" } });
  assert(screened.ok === false && screened.reasons.length === 1, "the nested credential key is caught");
  assert(!JSON.stringify(screened).includes("abcdef"), "the reason never echoes the value");
});

console.log("\n== a recorded ref is frozen as a live-resolvable target, never as a dead handle ==");
{
  const FIND_RESULTS =
    'Found 54 element(s) matching "Tìm kiếm nâng cao"; showing the 20 best matches. Narrow the query if none of these is the one you want:\n\n' +
    '[ref_7] link "Click để tìm kiếm nâng cao" at (639, 783)\n' +
    '[ref_8] button "Tìm kiếm" at (443, 668)\n' +
    '[ref_9] combobox "Nơi thực hiện" at (510, 402)';

  await check("a click recorded by ref carries the element identity instead", () => {
    const events = trail({
      messages: [
        [toolUse("find", { query: "Tìm kiếm nâng cao", tabId: 42 })],
        [toolUse("computer", { action: "left_click", ref: "ref_7", tabId: 42 })]
      ],
      results: [FIND_RESULTS, "Clicked ref_7"]
    });
    const derived = materialize.deriveRunDraft({ conversationEvents: events, runId: RUN_ID, metaHostname: "dauthau.asia" });
    assert(derived.ok === true, `derivation should succeed: ${JSON.stringify(derived)}`);
    const click = derived.draft.steps[1];
    assert(click.ref === "computer", "the click step is still a computer step");
    assert(click.args.ref === undefined, `the dead handle must not be frozen: ${JSON.stringify(click.args)}`);
    assert(
      click.args.target && click.args.target.role === "link" && click.args.target.name === "Click để tìm kiếm nâng cao",
      `the element identity must be frozen in its place: ${JSON.stringify(click.args)}`
    );
    assert(click.args.action === "left_click", "the action itself is untouched");
    const clean = schema.validateWorkflowRecord({
      id: derived.draft.workflowId,
      owner: "local-operator",
      name: derived.draft.name,
      domainConstraints: derived.draft.domains,
      steps: derived.draft.steps
    });
    assert(clean.steps[1].args.target.name === "Click để tìm kiếm nâng cao", "the frozen target passes registry validation");
  });

  await check("an unmapped ref stays exactly as recorded — never guessed at", () => {
    const events = trail({
      messages: [[toolUse("computer", { action: "left_click", ref: "ref_999", tabId: 42 })]],
      results: ["Clicked ref_999"]
    });
    const derived = materialize.deriveRunDraft({ conversationEvents: events, runId: RUN_ID, metaHostname: "shop.example.com" });
    assert(derived.ok === true, `derivation should succeed: ${JSON.stringify(derived)}`);
    assert(derived.draft.steps[0].args.ref === "ref_999", "an unmapped ref is preserved as recorded");
    assert(derived.draft.steps[0].args.target === undefined, "no identity is ever invented");
  });

  await check("a form step keeps its value through the rewrite; a credential-shaped label is never frozen", () => {
    const events = trail({
      messages: [
        [toolUse("find", { query: "Nơi thực hiện", tabId: 42 })],
        [toolUse("form_input", { ref: "ref_9", value: "Hải Phòng", tabId: 42 })],
        [toolUse("find", { query: "token", tabId: 42 })],
        [toolUse("computer", { action: "left_click", ref: "ref_10", tabId: 42 })]
      ],
      results: [
        '[ref_9] combobox "Nơi thực hiện" at (510, 402)',
        "",
        '[ref_10] link "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0" at (1, 2)',
        ""
      ]
    });
    const derived = materialize.deriveRunDraft({ conversationEvents: events, runId: RUN_ID, metaHostname: "dauthau.asia" });
    assert(derived.ok === true, `derivation should succeed: ${JSON.stringify(derived)}`);
    const form = derived.draft.steps[1];
    assert(form.ref === "form_input", "the form step is kept");
    assert(form.args.value === "Hải Phòng", "the value survives the target rewrite");
    assert(
      form.args.target && form.args.target.role === "combobox" && form.args.target.name === "Nơi thực hiện",
      `the form step's identity is frozen: ${JSON.stringify(form.args)}`
    );
    assert(form.args.ref === undefined, "the form step's dead handle is dropped");
    const link = derived.draft.steps[3];
    assert(link.args.ref === "ref_10", "a credential-shaped label does not become a stored target");
    assert(link.args.target === undefined, "...so the step keeps its recorded handle instead");
  });
  await check("a ref that maps to two different elements is never frozen (ambiguous, not guessed)", () => {
    const events = trail({
      messages: [
        [toolUse("find", { query: "one", tabId: 42 })],
        [toolUse("find", { query: "two", tabId: 42 })],
        [toolUse("computer", { action: "left_click", ref: "ref_5", tabId: 42 })]
      ],
      results: ['[ref_5] link "Trang chủ" at (1, 1)', '[ref_5] button "Đăng nhập" at (2, 2)', ""]
    });
    const derived = materialize.deriveRunDraft({ conversationEvents: events, runId: RUN_ID, metaHostname: "shop.example.com" });
    assert(derived.ok === true, `derivation should succeed: ${JSON.stringify(derived)}`);
    assert(derived.draft.steps[2].args.ref === "ref_5", "an ambiguous ref keeps its recorded handle");
    assert(derived.draft.steps[2].args.target === undefined, "no identity is guessed for it");
  });

  await check("a click's own landing description is identity evidence (covers refs picked off a screenshot)", () => {
    const events = trail({
      messages: [
        [toolUse("find", { query: "Nơi thực hiện", tabId: 42 })],
        [toolUse("computer", { action: "left_click", ref: "ref_110", tabId: 42 })]
      ],
      results: [
        'Found 77 element(s) matching "Nơi thực hiện"; showing the 20 best matches.',
        'Clicked at (260, 526) — landed on <li> "Hải Phòng"'
      ]
    });
    const derived = materialize.deriveRunDraft({ conversationEvents: events, runId: RUN_ID, metaHostname: "dauthau.asia" });
    assert(derived.ok === true, `derivation should succeed: ${JSON.stringify(derived)}`);
    const click = derived.draft.steps[1];
    assert(click.args.ref === undefined, "a ref no find listing ever named is still not frozen as a handle");
    assert(
      click.args.target && click.args.target.name === "Hải Phòng" && click.args.target.role === undefined,
      `the landing description is frozen as a name-only target: ${JSON.stringify(click.args)}`
    );
  });

  await check("a landing description disambiguates a ref number reused across a navigation", () => {
    const events = trail({
      messages: [
        [toolUse("find", { query: "one", tabId: 42 })],
        [toolUse("find", { query: "two", tabId: 42 })],
        [toolUse("computer", { action: "left_click", ref: "ref_7", tabId: 42 })]
      ],
      results: [
        '[ref_7] link "Click để tìm kiếm nâng cao" at (1, 1)',
        '[ref_7] link "Quay lại tìm kiếm cơ bản" at (2, 2)',
        'Clicked at (639, 783) — landed on <strong> "Click để tìm kiếm nâng cao"'
      ]
    });
    const derived = materialize.deriveRunDraft({ conversationEvents: events, runId: RUN_ID, metaHostname: "dauthau.asia" });
    assert(derived.ok === true, `derivation should succeed: ${JSON.stringify(derived)}`);
    const click = derived.draft.steps[2];
    assert(
      click.args.target && click.args.target.name === "Click để tìm kiếm nâng cao",
      `the click's own landing wins over the ambiguous search lines: ${JSON.stringify(click.args)}`
    );
    assert(click.args.ref === undefined, "and the handle is dropped");
  });

  await check("a corroborating search role joins the landing name; a state-only landing line never becomes one", () => {
    const events = trail({
      messages: [
        [toolUse("find", { query: "nút Tìm kiếm", tabId: 42 })],
        [toolUse("computer", { action: "left_click", ref: "ref_127", tabId: 42 })],
        [toolUse("computer", { action: "left_click", ref: "ref_111", tabId: 42 })]
      ],
      results: [
        '[ref_127] button "Tìm kiếm" at (3, 3)',
        'Clicked at (347, 456) — landed on <button type=button> "Tìm kiếm"',
        'Clicked at (260, 456) — landed on <span> — a dropdown list is now OPEN with 43 option(s). Pick one of its options. Do NOT click this control again: that closes the list.'
      ]
    });
    const derived = materialize.deriveRunDraft({ conversationEvents: events, runId: RUN_ID, metaHostname: "dauthau.asia" });
    assert(derived.ok === true, `derivation should succeed: ${JSON.stringify(derived)}`);
    const corroborated = derived.draft.steps[1];
    assert(
      corroborated.args.target && corroborated.args.target.role === "button" && corroborated.args.target.name === "Tìm kiếm",
      `the search role joins a corroborated landing name: ${JSON.stringify(corroborated.args)}`
    );
    const stateOnly = derived.draft.steps[2];
    assert(stateOnly.args.ref === "ref_111", "a state-only landing line (no quoted element name) is not identity evidence");
    assert(stateOnly.args.target === undefined, "...so that ref stays as recorded");
  });

  await check("a landing on a form control is not an identity (a select's text is its option list)", () => {
    const events = trail({
      messages: [
        [toolUse("find", { query: "TBMT", tabId: 42 })],
        [toolUse("computer", { action: "left_click", ref: "ref_6", tabId: 42 })]
      ],
      results: [
        'Found 6 element(s) matching "TBMT"; showing the 4 best matches.',
        'Clicked at (159, 783) — landed on <select> "Dự án đầu tư phát triển Kế hoạch tổng thể lựa chọn nhà thầu "'
      ]
    });
    const derived = materialize.deriveRunDraft({ conversationEvents: events, runId: RUN_ID, metaHostname: "dauthau.asia" });
    assert(derived.ok === true, `derivation should succeed: ${JSON.stringify(derived)}`);
    const click = derived.draft.steps[1];
    assert(click.args.ref === "ref_6", "the select click keeps its recorded handle — no identity is claimed");
    assert(click.args.target === undefined, "its option text is never frozen as a name");
  });
}

console.log("\n== a replay starts where the run started ==");
{
  await check("the run's own first tab listing becomes a leading navigate step", () => {
    const events = trail({
      messages: [
        [toolUse("tabs_context_mcp", {})],
        [toolUse("find", { query: "TBMT", tabId: 42 })]
      ],
      results: [
        'This run\'s context already includes tab(s) [7] as the current page(s) provided for it.\n\n{"availableTabs":[{"tabId":7,"title":"DauThau.info","url":"https://dauthau.asia/"}],"tabGroupId":9}',
        'Found 3 element(s) matching "TBMT"; showing the 3 best matches.'
      ]
    });
    const derived = materialize.deriveRunDraft({ conversationEvents: events, runId: RUN_ID, metaHostname: "dauthau.asia" });
    assert(derived.ok === true, `derivation should succeed: ${JSON.stringify(derived)}`);
    const first = derived.draft.steps[0];
    assert(
      first.kind === "tool" && first.ref === "navigate" && first.args && first.args.url === "https://dauthau.asia/",
      `the replay returns to the recorded starting page first: ${JSON.stringify(first)}`
    );
    assert(derived.draft.steps.length === 3, `one synthetic step, then the recorded trail unchanged (got ${derived.draft.steps.length})`);
    assert(derived.draft.domains.includes("dauthau.asia"), "the start page's host is inside the domain binding");
  });

  await check("a trail that already navigates is left to say where it goes", () => {
    const events = trail({
      messages: [
        [toolUse("tabs_context_mcp", {})],
        [toolUse("navigate", { url: "https://shop.example.com/orders", tabId: 42 })]
      ],
      results: ['{"availableTabs":[{"tabId":7,"url":"https://shop.example.com/home"}],"tabGroupId":9}', ""]
    });
    const derived = materialize.deriveRunDraft({ conversationEvents: events, runId: RUN_ID });
    assert(derived.ok === true, `derivation should succeed: ${JSON.stringify(derived)}`);
    assert(
      derived.draft.steps.map((s) => s.ref).join(",") === "tabs_context_mcp,navigate",
      `no start-url step is inserted when the trail navigates: ${JSON.stringify(derived.draft.steps.map((s) => s.ref))}`
    );
    assert(derived.draft.steps[1].args.url === "https://shop.example.com/orders", "the recorded navigate is untouched");
  });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) {
  for (const f of failed) console.log(`  FAILED: ${f.name} — ${f.err}`);
  process.exit(1);
}
process.exit(0);
