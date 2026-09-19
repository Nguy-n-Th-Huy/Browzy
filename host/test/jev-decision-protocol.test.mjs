import assert from "node:assert/strict";
import test from "node:test";
import { buildDecisionRequest, validateDecision, decisionRequestBytes, MAX_REQUEST_BYTES } from "../agent/jev/questions.js";
import { requestDecision } from "../agent/jev/client.js";

const field = { ref: "ref_1", role: "textbox", label: "Email", editable: true, value: "" };
const snapshot = { docNonce: "doc-a", url: "https://example.test/", elements: [field] };
const record = { id: "p1", ref: field.ref, role: field.role, label: field.label, docNonce: snapshot.docNonce, value: "test@example.test" };
const build = (extra = {}) => buildDecisionRequest({ model: "jev", goal: "Fill email", snapshot, prepared: { textValues: [record] }, ...extra });
const answersFor = (body) => Object.fromEntries(Object.entries(body.questions).map(([name, question]) => {
  const ids = Object.keys(question.criteria);
  return [name, { choice: ids[0], probabilities: Object.fromEntries(ids.map((id, i) => [id, i === 0 ? 1 : 0])), confidence: 0.98 }];
}));

test("complete actions bind exact field and payload; controls are reserved", () => {
  const { body, candidates } = build();
  assert.deepEqual(Object.keys(body.questions), ["action", "goal_done", "stuck"]);
  const actions = [...candidates.values()];
  assert.deepEqual(actions.slice(0, 4).map((a) => a.operation), ["WAIT", "REPLAN", "ASK", "DONE"]);
  const type = actions.find((a) => a.operation === "TYPE_TEXT");
  assert.equal(type.target.ref, field.ref);
  assert.equal(type.target.docNonce, snapshot.docNonce);
  assert.equal(type.value, record.value);
  assert.equal(type.preparedId, record.id);
  assert.equal(body.state.elements[0].label, "Email");
  assert.equal(body.state.elements[0].editable, true);
  assert.equal(body.state.elements[0].value, "");
});

test("an unread blank startup offers only ASK and validated prepared navigation", () => {
  const { body, candidates } = build({ snapshot: null, prepared: { textValues: [record], navigation: [{ id: "nav", url: "https://example.test/next" }, { id: "bad", url: "javascript:alert(1)" }], visualNotes: "stale evidence" } });
  assert.deepEqual([...candidates.values()].map((action) => action.operation), ["ASK", "NAVIGATE"]);
  assert.equal(body.state.page, null);
  assert.deepEqual(body.state.page_availability, { status: "blank_start", observed: false });
  assert.deepEqual(body.state.elements, []);
  assert.equal(body.state.visual_notes, undefined);
  const readable = build({ snapshot: { ...snapshot, url: "about:blank" } });
  assert([...readable.candidates.values()].some((action) => action.operation === "WAIT"));
});

test("stale, changed, missing, readonly, satisfied and consumed bindings never produce typing", () => {
  for (const change of [{ consumed: true }, { docNonce: "other" }, { ref: "ref_2" }, { role: "button" }, { label: "Different" }]) {
    assert(![...build({ prepared: { textValues: [{ ...record, ...change }] } }).candidates.values()].some((a) => a.operation === "TYPE_TEXT"));
  }
  for (const changed of [{ ...snapshot, docNonce: undefined }, { ...snapshot, elements: [{ ...field, readonly: true }] }, { ...snapshot, elements: [{ ...field, value: record.value }] }]) {
    assert(![...build({ snapshot: changed }).candidates.values()].some((a) => a.operation === "TYPE_TEXT"));
  }
});

test("rebuild observes new hover targets and never carries prior candidate objects", () => {
  const first = build();
  const next = build({ snapshot: { ...snapshot, elements: [{ ref: "ref_9", role: "link", label: "Revealed" }] } });
  assert([...next.candidates.values()].some((a) => a.target?.ref === "ref_9"));
  assert(![...next.candidates.values()].some((a) => a.target?.ref === "ref_1"));
  assert.notEqual(first.candidates, next.candidates);
});

test("prepared identities must be nonempty strings even when malformed nonces compare equal", () => {
  for (const docNonce of ["", null, undefined, 1, true, {}, []]) {
    const built = build({ snapshot: { ...snapshot, docNonce }, prepared: { textValues: [{ ...record, docNonce }] } });
    assert(![...built.candidates.values()].some((a) => a.operation === "TYPE_TEXT"));
  }
  for (const id of ["", null, undefined, 1, true, {}, []]) {
    const built = build({ prepared: { textValues: [{ ...record, id }], navigation: [{ id, url: "https://example.test/next" }] } });
    assert(![...built.candidates.values()].some((a) => ["TYPE_TEXT", "NAVIGATE"].includes(a.operation)));
  }
});

test("native selections preserve exact option value; navigation permits only prepared http(s)", () => {
  const value = "x".repeat(160);
  const built = build({ snapshot: { ...snapshot, elements: [{ ref: "ref_s", tag: "select", value: "old", options: [{ value, label: "Long" }, { value: "bad", disabled: true }] }] }, prepared: { navigation: [{ id: "n", url: "https://example.test/next" }, { id: "bad", url: "javascript:alert(1)" }] } });
  assert.equal([...built.candidates.values()].find((a) => a.operation === "SELECT").value, value);
  assert.equal([...built.candidates.values()].filter((a) => a.operation === "NAVIGATE").length, 1);
});

test("candidate and UTF-8 budgets disclose omissions and reserve content", () => {
  const elements = Array.from({ length: 400 }, (_, i) => ({ ref: `r${i}`, tag: "select", label: "Tiếng Việt 😀".repeat(20), options: [{ value: "a", label: "A" }] }));
  const built = build({ snapshot: { ...snapshot, text: "😀".repeat(20000), elements: [field, ...elements] } });
  assert(built.candidates.size <= 250);
  assert(decisionRequestBytes(built.body) <= MAX_REQUEST_BYTES);
  assert(built.body.state.omitted.candidates > 0);
  for (const operation of ["TYPE_TEXT", "CLICK", "SELECT", "HOVER"]) assert([...built.candidates.values()].some((a) => a.operation === operation), operation);
  assert.throws(() => build({ goal: "😀".repeat(MAX_REQUEST_BYTES) }), { code: "DECISION_REQUEST_TOO_LARGE" });
});

test("state retains upstream omissions, viewport, scroll and scoped visual notes", () => {
  const page = { ...snapshot, truncated: { elements: true, omitted: 22 }, viewport: { h: 600, w: 800 }, scroll: { y: 10, height: 2000 } };
  const { body } = build({ snapshot: page, prepared: { visualNotes: "Loading indicator visible" } });
  assert.deepEqual(body.state.omitted.upstream, page.truncated);
  assert.deepEqual(body.state.page.viewport, page.viewport);
  assert.deepEqual(body.state.page.scroll, page.scroll);
  assert.equal(body.state.visual_notes, "Loading indicator visible");
});

test("verbose Vietnamese listings keep results and executed search history before optional actions", async () => {
  const text = ("Thông báo mời thầu: cung cấp thiết bị máy tính cho trường học.\n".repeat(180)).slice(0, 9800) + "\nKết quả cuối: IB2600012345, mua sắm máy tính.";
  const controls = Array.from({ length: 249 }, (_, i) => ({ ref: `result_${i}`, role: "link", tag: "a", label: "Thông báo mời thầu mua sắm thiết bị máy tính phục vụ giảng dạy tại trường học trên địa bàn tỉnh " + i }));
  const history = Array.from({ length: 10 }, (_, i) => ({ action: "CLICK", target: "Tìm kiếm", text: `Đã tìm máy tính ${i}`, outcome: "executed", page_changed: true }));
  const page = { ...snapshot, text, elements: [field, ...controls], scroll: { y: 10, height: 2000 }, viewport: { h: 600 } };
  const prepared = { textValues: [record], navigation: [{ id: "nav", url: "https://example.test/results", purpose: "Prepared destination" }] };
  const { body, candidates } = build({ snapshot: page, history, prepared });
  assert(decisionRequestBytes(body) <= MAX_REQUEST_BYTES);
  assert(candidates.size < 250, "fit optional actions rather than erasing results");
  assert.equal(body.state.page.text, text, "both first and last results remain available to independent heads");
  assert.equal(body.state.omitted.page_text_chars, 0);
  assert.equal(body.state.recent_actions.length, 10);
  assert.equal(body.state.recent_actions.at(-1).outcome, "executed");
  assert.equal(body.state.recent_actions.at(-1).text, history.at(-1).text);
  assert.equal(body.state.omitted.history, 0);
  assert.equal(body.state.omitted.candidates, page.elements.length * 2 - (candidates.size - 8));
  assert.equal(body.state.omitted.elements, page.elements.length - body.state.elements.length);
  assert.deepEqual(Object.keys(body.questions.action.criteria), [...candidates.keys()]);
  for (const op of ["WAIT", "REPLAN", "ASK", "DONE", "SCROLL_UP", "SCROLL_DOWN", "TYPE_TEXT", "NAVIGATE", "CLICK", "HOVER"]) {
    assert([...candidates.values()].some((a) => a.operation === op), op);
  }
  for (const [key, action] of candidates) {
    const offered = JSON.parse(body.questions.action.criteria[key]);
    assert.equal(offered.operation, action.operation);
    assert.equal(offered.ref, action.target?.ref);
    assert.equal(offered.value, action.value);
  }
  for (const source of ["typesafe", "vercel", "openrouter"]) {
    await requestDecision({ source, endpoint: "https://provider.test", apiKey: "test", model: "jev", body, fetchImpl: async (_url, init) => {
      assert(Buffer.byteLength(init.body, "utf8") <= MAX_REQUEST_BYTES, source);
      const sent = JSON.parse(init.body);
      assert.equal(sent.state.page.text, text, source);
      assert.equal(sent.state.recent_actions.length, 10, source);
      return new Response(JSON.stringify({ answers: answersFor(sent) }), { status: 200 });
    } });
  }
});

test("huge history can be omitted entirely and oversized client requests never reach transport", async () => {
  const built = build({ history: [{ text: "😀".repeat(40000) }] });
  assert.deepEqual(built.body.state.recent_actions, []);
  assert.equal(built.body.state.omitted.history, 1);
  const { body } = build(); body.state.goal = "x".repeat(MAX_REQUEST_BYTES);
  await assert.rejects(requestDecision({ body, fetchImpl: () => assert.fail("must not send") }), { code: "DECISION_REQUEST_TOO_LARGE" });
});

test("three heads validate independently and reject malformed monitors or extra answers", () => {
  const { body } = build();
  const good = answersFor(body);
  assert(validateDecision({ questions: body.questions, answers: good }).ok);
  for (const mutate of [
    (a) => delete a.stuck,
    (a) => a.extra = a.action,
    (a) => a.goal_done.choice = "invented",
    (a) => a.goal_done.probabilities.no = NaN,
    (a) => delete a.stuck.probabilities.no,
    (a) => a.stuck.probabilities.yes = 0.3,
    (a) => a.stuck.choice = "no",
    (a) => a.action.confidence = Infinity
  ]) {
    const answers = structuredClone(good); mutate(answers);
    assert.equal(validateDecision({ questions: body.questions, answers }).ok, false);
  }
});

for (const source of ["typesafe", "vercel", "openrouter"]) test(`${source}: client transports and validates every decision head`, async () => {
  const { body } = build();
  const fetchImpl = async (_url, init) => {
    const sent = JSON.parse(init.body);
    assert.deepEqual(Object.keys(sent.questions), ["action", "goal_done", "stuck"]);
    const answers = answersFor(sent);
    const result = { answers };
    if (source === "vercel") {
      result.providerMetadata = { typesafe: { confidence: Object.fromEntries(Object.keys(answers).map((n) => [n, answers[n].confidence])) } };
      for (const a of Object.values(answers)) delete a.confidence;
    }
    return new Response(JSON.stringify(result), { status: 200 });
  };
  const result = await requestDecision({ source, endpoint: "https://provider.test", apiKey: "test", model: "jev", body, fetchImpl });
  assert.equal(result.decision.actionKey, "a1");
  assert.equal(result.decision.goalDone, true);
  assert.equal(result.decision.stuck, true);
  assert.equal(result.decision.heads.stuck.confidence, 0.98);
  await assert.rejects(requestDecision({ source, endpoint: "https://provider.test", apiKey: "test", model: "jev", body, fetchImpl: async () => {
    const answers = answersFor(body); delete answers.goal_done;
    return new Response(JSON.stringify({ answers }), { status: 200 });
  } }), { code: "INVALID_RESPONSE" });
});
