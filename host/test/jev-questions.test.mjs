#!/usr/bin/env node
//
// The Jev action space, the element-selection request payload, the observation
// signature, and the strict answer validator (host/agent/jev/questions.js) —
// the host-side port of the reference's action_space/choose/validate_choice,
// narrowed to the ONE decision TypeSafe owns
// (openspec/changes/add-jev-run-context design.md §10) and the
// `typesafe-jev-provider` spec's "Single-request decision protocol with strict
// validation" requirement.
//
// The load-bearing invariant proven here is the confinement one: the request
// carries 1-based numbers and no `ref` anywhere, so the only thing a model can
// return is an offered number — never a selector, a coordinate, or a script.
//
// Run: node host/test/jev-questions.test.mjs

import {
  OPERATIONS,
  TARGET_BEARING_OPERATIONS,
  buildActionSpace,
  buildSelectionRequest,
  targetHeadName,
  observationSignature,
  recentActionRows,
  scrollDirections,
  validateChoiceAnswer,
  validateDecision,
  NEXT_ACTION,
  MAX_ELEMENTS,
  MAX_PAGE_TEXT_CHARS,
  MAX_REQUEST_BYTES,
  MAX_HEAD_OPTIONS,
  MIN_ELEMENTS_FOR_REQUEST
} from "../agent/jev/questions.js";
import { TARGET_SELECTION } from "../agent/jev/text-helper.js";

const results = [];
function test(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
    console.log(`  PASS  ${name}`);
  } catch (err) {
    results.push({ name, ok: false, err: err.message });
    console.log(`  FAIL  ${name} — ${err.stack || err.message}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function snapshot(overrides = {}) {
  return {
    v: 1,
    url: "https://example.com/search",
    title: "Flight search",
    viewport: { w: 1000, h: 800 },
    scroll: { y: 0, height: 2400 },
    text: "Find flights",
    truncated: { elements: false, text: false, omitted: 0 },
    elements: [
      { ref: "ref_1", role: "textbox", label: "Where from?", tag: "input", type: "text", value: "", editable: true },
      { ref: "ref_2", role: "button", label: "Search", tag: "button" },
      {
        ref: "ref_3",
        role: "combobox",
        label: "Cabin",
        tag: "select",
        options: [
          { label: "Economy", value: "econ", selected: true },
          { label: "Business", value: "biz" }
        ]
      },
      { ref: "ref_4", role: "statictext", label: "Disabled control", tag: "div", disabled: true },
      { ref: "ref_5", role: "combobox", label: "Empty select", tag: "select", options: [] }
    ],
    ...overrides
  };
}

console.log("\nJev questions (action space, request payload, answer validation)\n");

test("the numbered table skips disabled controls and offers only supported operations", () => {
  const space = buildActionSpace(snapshot());
  assert(space.elements.length === 4, `expected 4 offered elements, got ${space.elements.length}`);
  assert(
    space.elements.map((e) => e.index).join(",") === "1,2,3,4",
    "element indices must be 1-based and contiguous"
  );
  assert(space.elements[0].operations.join(",") === "CLICK,HOVER,TYPE_TEXT", JSON.stringify(space.elements[0].operations));
  assert(space.elements[1].operations.join(",") === "CLICK,HOVER", JSON.stringify(space.elements[1].operations));
  assert(space.elements[2].operations.join(",") === "CLICK,HOVER,SELECT", JSON.stringify(space.elements[2].operations));
  // A native select with no enabled options supports no SELECT.
  assert(space.elements[3].operations.join(",") === "CLICK,HOVER", JSON.stringify(space.elements[3].operations));
  assert(
    space.operations.join(",") === "CLICK,TYPE_TEXT,SELECT,HOVER,SCROLL_DOWN,NAVIGATE,WAIT,DONE,BLOCKED",
    `unexpected operation set: ${space.operations.join(",")}`
  );
});

// The selection request under test: one decided operation + its intent, which
// is exactly what the runtime hands the builder.
const selection = (overrides = {}) =>
  buildSelectionRequest({
    model: "jev-latest",
    goal: "Find a flight",
    snapshot: snapshot(),
    operation: "CLICK",
    intent: "the Search button",
    ...overrides
  });

test("the numbered table carries no reference anywhere (the model can only answer numbers)", () => {
  const { body } = selection();
  const wire = JSON.stringify(body);
  assert(!wire.includes("ref_"), "the request body must never carry a ref");
  assert(!wire.includes("coordinate"), "the request body must never carry coordinates");
  assert(body.state.elements.every((e) => typeof e.index === "string"), "element rows are keyed by index only");
});

test("global operations follow the snapshot: no SCROLL_UP at the top, both directions mid-page", () => {
  assert(scrollDirections(snapshot()).up === false, "at y = 0 there is nothing above");
  assert(scrollDirections(snapshot()).down === true, "content below the fold is scrollable down");
  const mid = scrollDirections(snapshot({ scroll: { y: 900, height: 2400 } }));
  assert(mid.up === true && mid.down === true, JSON.stringify(mid));
  const bottom = scrollDirections(snapshot({ scroll: { y: 1700, height: 2400 } }));
  assert(bottom.up === true && bottom.down === false, JSON.stringify(bottom));
  const short = scrollDirections(snapshot({ scroll: { y: 0, height: 700 } }));
  assert(short.up === false && short.down === false, "a page shorter than the viewport offers neither scroll");
});

test("the request asks exactly ONE question, for the decided operation, with no operation head", () => {
  const { body } = selection();
  assert(body.model === "jev-latest", "model id must ride along");
  assert(body.state.goal === "Find a flight", "the goal must ride along");
  assert(body.state.page.url === "https://example.com/search", "page identity must ride along");
  assert(body.state.page.title === "Flight search", "page title must ride along");
  assert(body.state.page.text === "Find flights", "page text must ride along");
  assert(Array.isArray(body.state.recent_actions), "recent actions must ride along");
  const headKeys = Object.keys(body.questions);
  assert(headKeys.join(",") === "click_target", `exactly the decided operation's head: ${headKeys.join(",")}`);
  assert(!("operation" in body.questions), "no operation question may be asked of TypeSafe");
  assert(
    Object.keys(body.questions.click_target.criteria).join(",") === "1,2,3,4",
    "every element is a click candidate"
  );
  assert(body.questions.click_target.criteria["2"].element === "[2] Search", JSON.stringify(body.questions.click_target.criteria["2"]));
  assert(body.questions.click_target.instructions.operation === "CLICK", "the head names its operation");
  assert(body.questions.click_target.instructions.intent === "the Search button", "the head names the intent");
  assert(body.state.intent === "the Search button", "the step's intent rides the state");
});

test("each target-bearing operation gets its own candidates", () => {
  const typed = selection({ operation: "TYPE_TEXT", intent: "the origin field" }).body;
  assert(Object.keys(typed.questions).join(",") === "type_text_target", JSON.stringify(Object.keys(typed.questions)));
  assert(Object.keys(typed.questions.type_text_target.criteria).join(",") === "1", "only editable elements can be typed into");
  assert(typed.questions.type_text_target.criteria["1"].current_value === "", "current value must be disclosed");

  const select = selection({ operation: "SELECT", intent: "the cabin dropdown" }).body;
  assert(Object.keys(select.questions).join(",") === "select_target", JSON.stringify(Object.keys(select.questions)));
  assert(Object.keys(select.questions.select_target.criteria).join(",") === "3:1,3:2", "a dropdown candidate is keyed <element>:<option>");
  const business = select.questions.select_target.criteria["3:2"];
  assert(business.option === "Business" && business.value === "biz", JSON.stringify(business));
  assert(select.questions.select_target.criteria["3:1"].selected === true, "the selected option must be disclosed");
});

test("a HOVER step is offered exactly the CLICK candidate set, on its own head", () => {
  const hover = selection({ operation: "HOVER", intent: "the Đấu thầu menu" }).body;
  assert(Object.keys(hover.questions).join(",") === "hover_target", JSON.stringify(Object.keys(hover.questions)));
  const { actionSpace } = selection({ operation: "HOVER", intent: "the Đấu thầu menu" });
  // Anything the pointer can rest on is hoverable, so the HOVER head carries
  // every offered element — the CLICK set exactly (design.md §1).
  const clickKeys = [...actionSpace.targets.CLICK.keys()];
  assert(
    Object.keys(hover.questions.hover_target.criteria).join(",") === clickKeys.join(","),
    `${Object.keys(hover.questions.hover_target.criteria).join(",")} vs ${clickKeys.join(",")}`
  );
  assert(clickKeys.join(",") === "1,2,3,4", "every non-disabled offered element, in table order");
  assert(hover.questions.hover_target.criteria["2"].element === "[2] Search", JSON.stringify(hover.questions.hover_target.criteria["2"]));
  // The supported-operations list advertises HOVER beside CLICK.
  assert(actionSpace.operations.includes("HOVER"), actionSpace.operations.join(","));
});

test("the head name and the target-bearing set are one shared vocabulary", () => {
  assert(TARGET_BEARING_OPERATIONS.join(",") === "CLICK,TYPE_TEXT,SELECT,HOVER", TARGET_BEARING_OPERATIONS.join(","));
  assert(targetHeadName("TYPE_TEXT") === "type_text_target", targetHeadName("TYPE_TEXT"));
  assert(targetHeadName("HOVER") === "hover_target", targetHeadName("HOVER"));
  assert(Object.values(OPERATIONS).length === 12, Object.values(OPERATIONS).join(","));
  for (const operation of ["NAVIGATE", "SCROLL_UP", "SCROLL_DOWN", "WAIT", "REPLAN", "ASK", "DONE", "BLOCKED"]) {
    assert(!TARGET_BEARING_OPERATIONS.includes(operation), `${operation} needs no element`);
    let threw = false;
    try {
      selection({ operation, intent: "x" });
    } catch (err) {
      threw = err instanceof TypeError;
    }
    assert(threw, `${operation} must not be askable as a selection question`);
  }
});

test("a decided operation with no compatible candidate yields no request at all", () => {
  // A page with no editable element: a TYPE_TEXT step has nothing to select.
  const readOnly = snapshot({ elements: [{ ref: "ref_1", role: "button", label: "Search", tag: "button" }] });
  const typed = buildSelectionRequest({ model: "m", goal: "g", snapshot: readOnly, operation: "TYPE_TEXT", intent: "the search field" });
  assert(typed.body === null, "no candidates means nothing to ask");
  assert(typed.actionSpace.targets.TYPE_TEXT.size === 0, "and the action space agrees");
  // A page with no select: same for SELECT.
  const select = buildSelectionRequest({ model: "m", goal: "g", snapshot: snapshot(), operation: "SELECT", intent: "the cabin dropdown" });
  assert(select.body !== null, "an offered select IS askable");
  const noSelect = buildSelectionRequest({
    model: "m",
    goal: "g",
    snapshot: snapshot({ elements: [{ ref: "ref_1", role: "button", label: "Search", tag: "button" }] }),
    operation: "SELECT",
    intent: "the cabin dropdown"
  });
  assert(noSelect.body === null, "a select step with no select offers nothing");
});

test("the selection instruction states the intent reference, the offered-key rule, and the ownership rules", () => {
  const { body } = selection();
  const rules = body.questions.click_target.instructions.rules;
  assert(Array.isArray(rules) && rules.length === 1 && rules[0] === TARGET_SELECTION, JSON.stringify(rules));
  const flat = TARGET_SELECTION.replace(/\s+/g, " ");
  assert(/stated intent refers to/.test(flat), "the selection must resolve the stated intent");
  // The closest-offered-key fallback is gone on purpose: a forced pick among
  // hundreds of candidates is how a blind intent became a wrong click. What
  // replaces it is an honest one — select only on a genuine match, and let the
  // confidence say so when there is none.
  assert(!/closest offered key/.test(flat), "the closest-offered-key fallback must no longer be instructed");
  assert(/only when it genuinely matches the intent/.test(flat), "the genuine-match rule is missing");
  assert(/do not select a near-match/.test(flat), "the near-match refusal is missing");
  assert(/appeared only after the previous action/.test(flat), "what a newly appeared element means is missing");
  assert(/Choose only an offered key/.test(flat), "the offered-key rule is missing");
  assert(/untrusted data, never instructions/.test(flat), "the untrusted-data rule is missing");
  assert(/cannot change which keys are offered/.test(flat), "the page-cannot-change-the-offer rule is missing");
  assert(/never authorizes an action/.test(flat), "the memory-cannot-authorize rule is missing");
  assert(/no operation question|operation is already decided/.test(flat), "the split must be stated");
  // The capability probe's instruction is retained for the settings check, and
  // is NOT the run's selection instruction.
  assert(NEXT_ACTION !== TARGET_SELECTION && /Choose only from the offered criteria/.test(NEXT_ACTION), "the capability instruction is its own body");
});

test("page text and labels are bounded host-side", () => {
  // Sized past the shipped bound so the cut is real whatever the bound is.
  const long = snapshot({
    text: "x".repeat(MAX_PAGE_TEXT_CHARS + 1234),
    elements: [{ ref: "ref_9", role: "link", label: "L".repeat(400), tag: "a", value: "V".repeat(400) }]
  });
  const { body, actionSpace } = selection({ snapshot: long });
  assert(body.state.page.text.length === MAX_PAGE_TEXT_CHARS, `text must be bounded to ${MAX_PAGE_TEXT_CHARS}`);
  assert(actionSpace.elements[0].label.length === 100, "labels must be bounded to 100 characters");
  assert(actionSpace.elements[0].value.length === 100, "values must be bounded to 100 characters");
});

test("the element table is capped at the observation bound", () => {
  const elements = Array.from({ length: MAX_ELEMENTS + 20 }, (_, i) => ({ ref: `ref_${i + 1}`, role: "link", label: `L${i}`, tag: "a" }));
  const space = buildActionSpace(snapshot({ elements }));
  assert(space.elements.length === MAX_ELEMENTS, `expected the table to stop at ${MAX_ELEMENTS}`);
  assert(!space.targets.CLICK.has(String(MAX_ELEMENTS + 1)), "no omitted element may be selectable");
});

test("recent_actions keeps the reference's projection and the last ten rows", () => {
  const history = Array.from({ length: 14 }, (_, i) => ({ step: i + 1, action: `A${i}`, kind: "click", text: null, page_changed: i % 2 === 0, url: "ignored" }));
  const rows = recentActionRows(history);
  assert(rows.length === 10, `expected 10 rows, got ${rows.length}`);
  assert(rows[0].action === "A4", "the projection must keep the most recent rows");
  assert(Object.keys(rows[0]).join(",") === "action,kind,text,page_changed", JSON.stringify(Object.keys(rows[0])));
});

test("the observation signature is stable and sensitive to url, viewport position, element state, and text", () => {
  const base = snapshot();
  assert(observationSignature(base) === observationSignature(snapshot()), "identical observations must compare equal");
  assert(observationSignature(base) !== observationSignature(snapshot({ url: "https://example.com/other" })), "url change must register");
  assert(observationSignature(base) !== observationSignature(snapshot({ text: "Find cars" })), "text change must register");
  const filled = snapshot();
  filled.elements[0].value = "Zurich";
  assert(observationSignature(base) !== observationSignature(filled), "an element's value change must register");
  const checked = snapshot();
  checked.elements[1].checked = true;
  assert(observationSignature(base) !== observationSignature(checked), "an element's state change must register");
  const scrolled = snapshot();
  scrolled.scroll = { y: 560, height: scrolled.scroll.height };
  assert(
    observationSignature(base) !== observationSignature(scrolled),
    "a moved viewport must register — a scroll that moved the view is not 'no progress' (observed live: three scrolls tripped the guard)"
  );
});

// --- validateChoiceAnswer: the ported validate_choice matrix ---------------

const IDS = ["A", "B", "C"];

test("a well-formed head passes", () => {
  const check = validateChoiceAnswer({ choice: "B", probabilities: { A: 0.1, B: 0.8, C: 0.1 }, confidence: 0.7 }, IDS);
  assert(check.ok === true, JSON.stringify(check));
  assert(check.choice === "B" && check.confidence === 0.7, "the check must return the parsed answer");
});

test("a choice outside the offered ids is refused", () => {
  const check = validateChoiceAnswer({ choice: "D", probabilities: { A: 0.1, B: 0.8, C: 0.1 }, confidence: 0.7 }, IDS);
  assert(check.ok === false && check.reason === "choice_not_offered", JSON.stringify(check));
});

test("probability keys must cover exactly the offered ids", () => {
  const extra = validateChoiceAnswer({ choice: "A", probabilities: { A: 0.5, B: 0.3, C: 0.1, D: 0.1 }, confidence: 0.7 }, IDS);
  assert(extra.ok === false && extra.reason === "probability_keys_mismatch", JSON.stringify(extra));
  const missing = validateChoiceAnswer({ choice: "A", probabilities: { A: 0.6, B: 0.4 }, confidence: 0.7 }, IDS);
  assert(missing.ok === false && missing.reason === "probability_keys_mismatch", JSON.stringify(missing));
});

test("probabilities and confidence must be finite numbers within [0, 1]", () => {
  for (const bad of [{ A: -0.1, B: 0.6, C: 0.5 }, { A: 1.4, B: -0.4, C: 0 }, { A: "0.5", B: 0.3, C: 0.2 }, { A: NaN, B: 0.5, C: 0.5 }]) {
    const check = validateChoiceAnswer({ choice: "B", probabilities: bad, confidence: 0.5 }, IDS);
    assert(check.ok === false && check.reason === "probability_values_invalid", `${JSON.stringify(bad)} -> ${JSON.stringify(check)}`);
  }
  const badConfidence = validateChoiceAnswer({ choice: "B", probabilities: { A: 0.1, B: 0.8, C: 0.1 }, confidence: Infinity }, IDS);
  assert(badConfidence.ok === false && badConfidence.reason === "probability_values_invalid", JSON.stringify(badConfidence));
  const missingConfidence = validateChoiceAnswer({ choice: "B", probabilities: { A: 0.1, B: 0.8, C: 0.1 } }, IDS);
  assert(missingConfidence.ok === false && missingConfidence.reason === "probability_values_invalid", JSON.stringify(missingConfidence));
});

test("the probabilities must sum to 1 within the reference's tolerance", () => {
  const inside = validateChoiceAnswer({ choice: "A", probabilities: { A: 0.51, B: 0.25, C: 0.225 }, confidence: 0.5 }, IDS);
  assert(inside.ok === true, `0.985 is inside the 0.02 tolerance: ${JSON.stringify(inside)}`);
  const outside = validateChoiceAnswer({ choice: "A", probabilities: { A: 0.5, B: 0.25, C: 0.22 }, confidence: 0.5 }, IDS);
  assert(outside.ok === false && outside.reason === "probability_sum_invalid", JSON.stringify(outside));
});

test("the declared choice must be the maximum", () => {
  const check = validateChoiceAnswer({ choice: "A", probabilities: { A: 0.3, B: 0.6, C: 0.1 }, confidence: 0.9 }, IDS);
  assert(check.ok === false && check.reason === "choice_not_maximum", JSON.stringify(check));
});

test("a non-object answer head is refused", () => {
  for (const bad of [null, undefined, "A", 7, []]) {
    const check = validateChoiceAnswer(bad, IDS);
    assert(check.ok === false && check.reason === "answer_missing", `${JSON.stringify(bad)} -> ${JSON.stringify(check)}`);
  }
});

// --- validateDecision: the selection answer's validation --------------------

/** The valid answer for a request's own single head, with `chosen` (or its
 * first key) taking the maximum. `mutate` may damage the answer further. */
function answersFor(body, { chosen, mutate } = {}) {
  const headName = Object.keys(body.questions)[0];
  const ids = Object.keys(body.questions[headName].criteria);
  const pick = chosen ?? ids[0];
  const probabilities = {};
  if (ids.length === 1) probabilities[ids[0]] = 1;
  else for (const id of ids) probabilities[id] = id === pick ? 0.8 : 0.2 / (ids.length - 1);
  const answers = { [headName]: { choice: pick, probabilities, confidence: 0.75 } };
  if (typeof mutate === "function") mutate(answers, body, headName);
  return answers;
}

test("a valid selection is accepted and yields the operation, the key, and its probability", () => {
  const { body } = selection({ operation: "SELECT", intent: "the cabin dropdown" });
  const check = validateDecision({ questions: body.questions, answers: answersFor(body, { chosen: "3:2" }) });
  assert(check.ok === true, JSON.stringify(check));
  assert(check.decision.operation === "SELECT", "the operation the head belongs to must be returned");
  assert(check.decision.targetKey === "3:2", "the consumed target key must be returned");
  assert(check.decision.targetProbability === 0.8, JSON.stringify(check.decision));
  assert(check.decision.confidence === 0.75, "the head's confidence must be returned");
  assert(check.decision.targetConfidence === 0.75, JSON.stringify(check.decision));
});

test("an answer whose choice is not offered, or whose probabilities are malformed, is refused by name", () => {
  const { body } = selection();
  const unoffered = validateDecision({ questions: body.questions, answers: answersFor(body, { chosen: "1" }) });
  assert(unoffered.ok === true, JSON.stringify(unoffered));
  const off = answersFor(body, { chosen: "99" });
  assert(validateDecision({ questions: body.questions, answers: off }).reason === "click_target:choice_not_offered", JSON.stringify(validateDecision({ questions: body.questions, answers: off })));
  const badSum = answersFor(body, {
    mutate: (answers, _body, headName) => {
      for (const id of Object.keys(answers[headName].probabilities)) answers[headName].probabilities[id] = 0.5;
    }
  });
  assert(validateDecision({ questions: body.questions, answers: badSum }).reason === "click_target:probability_sum_invalid", "a bad sum must be refused");
  const notMax = answersFor(body, {
    mutate: (answers, _body, headName) => {
      const ids = Object.keys(answers[headName].probabilities);
      answers[headName].choice = ids[0];
      for (const id of ids) answers[headName].probabilities[id] = id === ids[1] ? 0.8 : 0.2 / (ids.length - 1);
    }
  });
  assert(validateDecision({ questions: body.questions, answers: notMax }).reason === "click_target:choice_not_maximum", "a non-maximal choice must be refused");
});

test("an unanswered head, an answered head that was not asked, and a multi-head request are all refused", () => {
  const { body } = selection();
  const unanswered = validateDecision({ questions: body.questions, answers: {} });
  assert(unanswered.ok === false && unanswered.reason === "click_target:answer_missing", JSON.stringify(unanswered));

  const extra = answersFor(body, {
    mutate: (answers) => {
      answers.select_target = { choice: "3:1", probabilities: { "3:1": 1 }, confidence: 0.5 };
    }
  });
  const check = validateDecision({ questions: body.questions, answers: extra });
  assert(check.ok === false && check.reason === "answers_unasked_head:select_target", JSON.stringify(check));

  const twoHeads = {
    questions: { ...body.questions, select_target: { type: "choice", criteria: { "3:1": {} }, instructions: {} } },
    answers: answersFor(body)
  };
  assert(validateDecision(twoHeads).reason === "questions_not_single", "tests the request shape, not the answer");
});

test("a missing or malformed answers object, and an unknown head, are refused with a named reason", () => {
  const { body } = selection();
  assert(validateDecision({ questions: body.questions, answers: null }).reason === "answers_missing", "missing answers must be named");
  assert(validateDecision({ questions: null, answers: {} }).reason === "questions_missing", "missing questions must be named");
  assert(validateDecision({ questions: {}, answers: {} }).reason === "questions_missing", "an empty question set must be named");
  assert(
    validateDecision({ questions: { operation: { type: "choice", criteria: { CLICK: "c" }, instructions: {} } }, answers: {} }).reason === "questions_unknown_head:operation",
    "the operation head is no longer part of this protocol"
  );
});

test("an oversize listing request is fitted to the byte budget by dropping tail elements, with the omission disclosed", () => {
  const elements = [];
  for (let i = 1; i <= 250; i++) {
    elements.push({
      ref: `ref_${i}`,
      role: i % 3 ? "link" : "button",
      label: `Thông báo mời thầu số ${i} - Gói thầu mua sắm thiết bị y tế cho bệnh viện đa khoa tỉnh Hải Phòng`,
      tag: i % 3 ? "a" : "button",
      value: "",
      editable: false
    });
  }
  const text = Array.from({ length: 300 }, (_, i) => `Thông báo mời thầu ${i}: mua sắm thiết bị, Hải Phòng. `).join("").slice(0, MAX_PAGE_TEXT_CHARS);
  const { body, actionSpace } = selection({
    goal: "tìm TBMT tại Hải Phòng",
    snapshot: { url: "https://example.com", title: "Danh sách TBMT", text, elements }
  });
  const requestBytes = JSON.stringify({ state: body.state, questions: body.questions, providerOptions: {} }).length;
  assert(requestBytes <= MAX_REQUEST_BYTES, `the fitted request must fit the budget: ${requestBytes}`);
  assert(actionSpace.elements.length >= MIN_ELEMENTS_FOR_REQUEST, `the ladder never truncates below the floor: ${actionSpace.elements.length}`);
  assert(actionSpace.elements.length < elements.length, "the oversize request must have dropped some elements");
  assert(body.state.omitted && body.state.omitted.elements > 0, `the omission must be disclosed: ${JSON.stringify(body.state.omitted)}`);
  // The asked head survives the fit: the top-of-page click candidates are all
  // still offered, and the question is still askable.
  assert(Object.keys(body.questions.click_target.criteria).length > 0, "the asked head must survive the fit");
  assert(targetHeadName("CLICK") in body.questions, JSON.stringify(Object.keys(body.questions)));
});

test("a decided operation whose candidates all sit past the tail cut yields no request", () => {
  // Every editable element is deep in a long table, so a fitted request cannot
  // offer the head the step needs: the builder answers null (the runtime skips
  // the step) rather than asking a question with no candidates.
  const elements = [];
  for (let i = 1; i <= 250; i++) {
    elements.push({
      ref: `ref_${i}`,
      role: "link",
      label: `Thông báo mời thầu số ${i} - Gói thầu mua sắm thiết bị y tế cho bệnh viện đa khoa tỉnh Hải Phòng`,
      tag: "a"
    });
  }
  for (let i = 241; i <= 250; i++) {
    elements[i - 1] = { ref: `ref_${i}`, role: "textbox", label: `Ô nhập số ${i}`, tag: "input", editable: true, value: "" };
  }
  const text = Array.from({ length: 300 }, (_, i) => `Thông báo mời thầu ${i}: mua sắm thiết bị, Hải Phòng. `).join("").slice(0, MAX_PAGE_TEXT_CHARS);
  const built = selection({
    snapshot: { url: "https://example.com", title: "Danh sách TBMT", text, elements },
    operation: "TYPE_TEXT",
    intent: "the search box"
  });
  assert(built.body === null, "a head that cannot fit is not asked");
  assert(built.actionSpace.targets.TYPE_TEXT.size === 0, "and no candidate is offered for it");
});

test("a small page is never fitted and carries no omission disclosure", () => {
  const { body, actionSpace } = selection();
  assert(actionSpace.elements.length >= 1, "small page keeps its elements");
  assert(!("omitted" in body.state), `no disclosure for an untouched request: ${JSON.stringify(body.state.omitted)}`);
});

test("one select head never exceeds the provider's option ceiling, and dropped options are disclosed", () => {
  const options = Array.from({ length: MAX_HEAD_OPTIONS + 10 }, (_, j) => ({ label: `Lựa chọn ${j + 1}`, value: `v${j + 1}`, selected: false }));
  const { body } = selection({
    snapshot: { url: "u", title: "t", text: "", elements: [{ ref: "ref_1", role: "combobox", label: "Bộ lọc", tag: "select", options }] },
    operation: "SELECT",
    intent: "the filter dropdown"
  });
  const head = body.questions.select_target;
  assert(head && Object.keys(head.criteria).length === MAX_HEAD_OPTIONS, `select head must be capped at ${MAX_HEAD_OPTIONS}: ${head ? Object.keys(head.criteria).length : "missing"}`);
  assert(body.state.omitted && body.state.omitted.select_options === 10, `dropped options must be disclosed: ${JSON.stringify(body.state.omitted)}`);
});

test("the run memory rides in state.memory when present and the key is omitted otherwise", () => {
  const memory = { plan: "Mở youtube, tìm bài qua ô tìm kiếm.", doneWhen: "Trang kết quả hiện bài hát.", notes: "Đang ở trang chủ." };
  const withMemory = selection({ goal: "mở thế giới của anh youtube", memory });
  assert(JSON.stringify(withMemory.body.state.memory) === JSON.stringify(memory), JSON.stringify(withMemory.body.state));
  assert(Object.keys(withMemory.body.state.memory).join(",") === "plan,doneWhen,notes", "exactly the three memory keys ride the wire");
  const without = selection({ memory: null });
  assert(!("memory" in without.body.state), "no memory, no key");
  const noArg = buildSelectionRequest({ model: "m", goal: "g", snapshot: snapshot(), operation: "CLICK", intent: "the button" });
  assert(!("memory" in noArg.body.state), "the key is omitted when no memory is passed at all");
});

test("a partial or malformed memory never reaches the wire", () => {
  const cases = [
    { plan: "p", doneWhen: "d" },
    { plan: "p", doneWhen: "d", notes: 7 },
    { plan: "p", doneWhen: "d", notes: "n", extra: "x" },
    null,
    "memory",
    ["plan", "doneWhen", "notes"]
  ];
  for (const bad of cases) {
    const { body } = selection({ memory: bad });
    assert(!("memory" in body.state), `a malformed memory must be omitted: ${JSON.stringify(bad)}`);
  }
});

test("the memory rides the state and the instruction, and nothing else changes with it", () => {
  const memory = { plan: "p", doneWhen: "d", notes: "n" };
  const withMemory = selection({ memory });
  const without = selection({});
  const omitted = withMemory.body.state.memory;
  assert(JSON.stringify(omitted) === JSON.stringify(memory), JSON.stringify(omitted));
  const { memory: _dropped, ...stateWithoutMemory } = withMemory.body.state;
  assert(JSON.stringify(stateWithoutMemory) === JSON.stringify(without.body.state), "everything but state.memory must be identical");
  assert(JSON.stringify(withMemory.body.questions) === JSON.stringify(without.body.questions), "the question assembly must be identical");
  assert(JSON.stringify(withMemory.actionSpace) === JSON.stringify(without.actionSpace), "the action space must be identical");
});

test("the fitter's element budget is unaffected by a memory riding the state", () => {
  const elements = Array.from({ length: MAX_ELEMENTS }, (_, i) => ({ ref: `ref_${i + 1}`, role: "link", label: `Mục ${i + 1}`, tag: "a" }));
  const memory = { plan: "p".repeat(600), doneWhen: "d".repeat(300), notes: "n".repeat(600) };
  const { body, actionSpace } = selection({ snapshot: snapshot({ elements }), memory });
  assert(body.state.memory.plan.length === 600 && body.state.memory.doneWhen.length === 300 && body.state.memory.notes.length === 600, "the bounded memory rides verbatim");
  assert(actionSpace.omitted.elements >= 0 && body.state.elements.length + actionSpace.omitted.elements === MAX_ELEMENTS, JSON.stringify(actionSpace.omitted));
});

const failed = results.filter((r) => !r.ok);
console.log(
  `\n${results.length - failed.length}/${results.length} passed` +
    (failed.length ? `\n\nFailures:\n${failed.map((f) => `  - ${f.name}: ${f.err}`).join("\n")}` : "") +
    "\n"
);
process.exit(failed.length ? 1 : 0);
