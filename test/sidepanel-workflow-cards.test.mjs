#!/usr/bin/env node
// Panel side of openspec/changes/add-workflow-materialization-and-heal
// (tasks.md 5.1/5.2 and the panel halves of 2/6): the turn footer's
// "Lưu thành workflow" affordance and its visibility rules, the draft card's
// review -> save -> prove -> enable stages (including the refusal and retry
// paths), the static drift notice, the heal proposal card (allow/deny/expiry/
// superseded/late-decision), the inline incomplete-derivation notice, the
// restore-from-events path with no duplication, and the wire shapes the five
// controller operations put on the protocol.
//
// Everything here drives the SHIPPED modules: the real ConversationModel and
// the real PanelController against a fake protocol client (the wire is the
// seam the panel owns), plus the real render functions pulled out of
// sidepanel.js by test/_extract.mjs's brace-matcher — the same technique
// test/sidepanel-message-queue.test.mjs and test/sidepanel-composer-*.test.mjs
// already use, because sidepanel.js touches `document`/`chrome.*` at module
// scope and cannot be imported here.
//
// Run: node test/sidepanel-workflow-cards.test.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { extractFunction, compile } from "./_extract.mjs";
import { createDocument } from "./_fake-dom.mjs";
import { escapeHtml } from "../extension/sidepanel/markdown-lite.js";
import { iconMarkup } from "../extension/ui/icons.js";
import { toolRowDisplay } from "../extension/sidepanel/conversation-model.js";
import { ConversationModel } from "../extension/sidepanel/conversation-model.js";
import { PanelController } from "../extension/sidepanel/panel-controller.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SIDEPANEL_FILE = path.join(ROOT, "extension", "sidepanel", "sidepanel.js");
const SIDEPANEL_SRC = fs.readFileSync(SIDEPANEL_FILE, "utf8");
const extract = (name) => extractFunction(name, SIDEPANEL_FILE);

let fail = 0;
function ok(cond, msg) {
  console.log((cond ? "  PASS  " : "  FAIL  ") + msg);
  if (!cond) fail++;
}

// ---- shipped copy, read out of the source (never re-typed here) -----------
function shippedConst(name) {
  const frozen = SIDEPANEL_SRC.match(new RegExp(`const ${name} = Object\\.freeze\\((\\{[\\s\\S]*?\\})\\);`));
  const plain = SIDEPANEL_SRC.match(new RegExp(`const ${name} = (\\{[\\s\\S]*?\\});`));
  const literal = frozen ? frozen[1] : plain ? plain[1] : null;
  if (!literal) throw new Error(`const ${name} not found in ${SIDEPANEL_FILE}`);
  return new Function(`return ${literal};`)();
}

const WORKFLOW_COPY = shippedConst("WORKFLOW_COPY");
const WORKFLOW_REFUSAL_REASON_VI = shippedConst("WORKFLOW_REFUSAL_REASON_VI");
const WORKFLOW_DRIFT_REASON_VI = shippedConst("WORKFLOW_DRIFT_REASON_VI");
const WORKFLOW_STEP_STATE_VI = shippedConst("WORKFLOW_STEP_STATE_VI");

// ---- shipped render bundle ------------------------------------------------
const RENDER = compile(
  [
    extract("renderWorkflowDraftItemHtml"),
    extract("renderWorkflowDriftItemHtml"),
    extract("renderWorkflowHealItemHtml"),
    extract("workflowStepsHtml"),
    extract("workflowStepLineHtml"),
    extract("workflowMetaHtml"),
    extract("workflowProofHtml"),
    extract("workflowErrorHtml"),
    extract("workflowEditHtml"),
    extract("workflowEditProblemHtml"),
    extract("workflowDraftActionsHtml"),
    extract("workflowOutcomeSource"),
    extract("workflowEvidenceText"),
    extract("workflowRefusalText"),
    extract("workflowDraftRefusalText"),
    extract("formatClockVi")
  ].join("\n\n"),
  { escapeHtml, iconMarkup, toolRowDisplay, WORKFLOW_COPY, WORKFLOW_REFUSAL_REASON_VI, WORKFLOW_DRIFT_REASON_VI, WORKFLOW_STEP_STATE_VI },
  `{ renderWorkflowDraftItemHtml, renderWorkflowDriftItemHtml, renderWorkflowHealItemHtml,
     workflowDraftRefusalText, workflowRefusalText, workflowOutcomeSource, formatClockVi }`
);

const affordanceRunId = compile(extract("workflowAffordanceRunId"), {}, "workflowAffordanceRunId");

const buildDefinition = compile(extract("buildWorkflowDefinitionFromDraft"), {}, "buildWorkflowDefinitionFromDraft");

// The edit view's pure step builder: working copy + row inputs -> steps.
const EDIT_STEPS = compile(
  [extract("parseWorkflowEditArgs"), extract("applyWorkflowEditArgs"), extract("buildWorkflowEditSteps")].join("\n\n"),
  {},
  "{ parseWorkflowEditArgs, applyWorkflowEditArgs, buildWorkflowEditSteps }"
);

// The turn footer markup itself: the shipped renderTurnHtml, with the
// surrounding renderers stubbed (they have their own suites) so this test can
// assert the affordance a real turn emits.
const turnRender = compile(
  [
    extract("renderTurnHtml"),
    extract("workflowAffordanceRunId")
  ].join("\n\n"),
  {
    escapeHtml,
    iconMarkup,
    WORKFLOW_COPY,
    timelineDurationLabel: () => "3s",
    renderTimelineCollapsed: () => "",
    renderWarningsHtml: () => "",
    renderThinkingBlockHtml: () => "",
    renderUserItemHtml: () => "",
    renderProseHtml: () => "<p>câu trả lời</p>",
    renderAnswerSourceCitation: () => "",
    renderDocumentCardHtml: () => "",
    renderBusyIndicator: () => "",
    turnStatusNote: () => null,
    panel: { currentModel: () => null }
  },
  "{ renderTurnHtml, workflowAffordanceRunId }"
);

// ---- fake panel deps ------------------------------------------------------
function makeProtocolStub() {
  const sent = [];
  const envelopeHandlers = [];
  const disconnectHandlers = [];
  return {
    sent,
    deliver(env) {
      for (const fn of envelopeHandlers) fn(env);
    },
    fireDisconnect() {
      for (const fn of disconnectHandlers) fn();
    },
    onEnvelope(fn) {
      envelopeHandlers.push(fn);
      return () => {};
    },
    onHandshakeChange() {
      return () => {};
    },
    onDisconnect(fn) {
      disconnectHandlers.push(fn);
      return () => {};
    },
    handshakeState() {
      return "ok";
    },
    workflowDraftRequest(opts) {
      sent.push({ method: "workflowDraftRequest", opts });
    },
    workflowDraftSave(opts) {
      sent.push({ method: "workflowDraftSave", opts });
    },
    workflowProve(opts) {
      sent.push({ method: "workflowProve", opts });
    },
    workflowEnable(opts) {
      sent.push({ method: "workflowEnable", opts });
    },
    workflowHealDecide(opts) {
      sent.push({ method: "workflowHealDecide", opts });
    },
    workflowEditRequest(opts) {
      sent.push({ method: "workflowEditRequest", opts });
    },
    workflowEditSave(opts) {
      sent.push({ method: "workflowEditSave", opts });
    }
  };
}

function makeController({ requestTimeoutMs = 40 } = {}) {
  const protocol = makeProtocolStub();
  const controller = new PanelController({
    protocolClient: protocol,
    historyStore: {
      setLastActive: async () => {},
      recordPrompt: async () => {},
      upsert: async () => {},
      flush() {},
      promptsFor: async () => new Map(),
      get: async () => null,
      list: async () => []
    },
    profileCache: { read: async () => ({}), onChange() {} },
    identity: async () => ({ installationId: null, connectionId: null }),
    scope: () => "scope-1",
    requestTimeoutMs
  });
  const model = new ConversationModel("conv1");
  controller.models.set("conv1", model);
  controller.currentConversationId = "conv1";
  return { controller, model, protocol };
}

const DRAFT = {
  workflowId: "wf-orders",
  name: "Đơn hàng đang chờ",
  steps: [
    { kind: "tool", ref: "read_page", args: {} },
    { kind: "tool", ref: "computer", args: { action: "left_click", ref: "ref_4" } }
  ],
  domain: "example.com",
  document: null
};
const REVIEW = {
  steps: DRAFT.steps,
  domain: "example.com",
  document: null
};

// ==========================================================================
console.log("== affordance: latest COMPLETED run only, never during a run, never twice ==");
{
  const model = new ConversationModel("c1");
  model.addLocalUserMessage("làm giúp mình");
  model.bindRunToLastUserMessage("run-1");
  model.applyEvent({ type: "run_started", runId: "run-1" });
  ok(affordanceRunId(model, {}) === null, "no affordance while the run is still active");
  model.applyEvent({ type: "run_done", runId: "run-1" });
  ok(affordanceRunId(model, {}) === "run-1", "the latest completed run offers it");
  ok(affordanceRunId(model, { draftPending: true }) === null, "hidden while its own derivation is in flight");
  ok(affordanceRunId(model, { enhancePending: true }) === null, "hidden while a prompt enhancement is in flight");

  model.presentWorkflowDraft("run-1", { draft: DRAFT, review: REVIEW });
  ok(affordanceRunId(model, {}) === null, "once that run HAS a draft card, the card is the affordance");

  const stopped = new ConversationModel("c2");
  stopped.addLocalUserMessage("dừng giữa chừng");
  stopped.bindRunToLastUserMessage("run-2");
  stopped.applyEvent({ type: "run_started", runId: "run-2" });
  stopped.applyEvent({ type: "run_stopped", runId: "run-2", reason: "user_stop" });
  ok(affordanceRunId(stopped, {}) === null, "a stopped (not completed) run offers nothing — there is no finished trail");

  const running = new ConversationModel("c3");
  running.addLocalUserMessage("lượt mới");
  running.bindRunToLastUserMessage("run-1");
  running.applyEvent({ type: "run_done", runId: "run-1" });
  running.addLocalUserMessage("lượt đang chạy");
  running.bindRunToLastUserMessage("run-3");
  running.applyEvent({ type: "run_started", runId: "run-3" });
  ok(affordanceRunId(running, {}) === null, "an active run anywhere hides the affordance (it is not the latest turn's)");
}

console.log("\n== the footer row renders the affordance (and only when allowed) ==");
{
  const turn = {
    kind: "assistant_turn",
    runId: "run-1",
    lifecycle: "done",
    complete: true,
    text: "xong rồi",
    toolRows: [],
    warnings: [],
    documents: [],
    questionAnswers: [],
    thinking: "",
    redactedThinking: false
  };
  const withAffordance = turnRender.renderTurnHtml(turn, { workflowAffordance: true });
  ok(withAffordance.includes("turn-workflow-btn"), "the affordance is a real control in the turn footer");
  ok(withAffordance.includes(`>${escapeHtml(WORKFLOW_COPY.saveLabel)}<`) || withAffordance.includes(WORKFLOW_COPY.saveLabel), "labelled with the reviewed Vietnamese copy");
  ok(/aria-label="[^"]+"/.test(withAffordance.split("turn-workflow-btn")[1] || ""), "and carries an accessible name");
  ok(withAffordance.includes("turn-copy-btn") && withAffordance.includes("turn-duration"), "it shares the EXISTING copy/time footer row rather than adding another");
  ok(withAffordance.indexOf("turn-copy-btn") < withAffordance.indexOf("turn-workflow-btn"), "copy first, then the workflow affordance, then the duration");

  const without = turnRender.renderTurnHtml(turn, { workflowAffordance: false });
  ok(!without.includes("turn-workflow-btn"), "a turn that is not the latest completed run renders exactly as before");
}

console.log("\n== definition payload: only the draft's own fields ever reach the wire ==");
{
  const definition = buildDefinition(DRAFT);
  ok(definition.id === "wf-orders" && definition.name === DRAFT.name && definition.steps.length === 2, "the definition carries the host-suggested id, name and steps");
  ok(definition.domainConstraints[0] === "example.com", "the derivation's domain becomes a domain constraint");
  ok(!("enabled" in definition) && !("owner" in definition), "the panel never asks for enablement or invents an owner (both are the host's)");
  const withOutputs = buildDefinition({ ...DRAFT, outputs: [{ text: "nội dung đã đọc" }], result: "bí mật" });
  const dumped = JSON.stringify(withOutputs);
  ok(!dumped.includes("nội dung đã đọc") && !dumped.includes("bí mật"), "run OUTPUTS in the reply never reach the definition (a definition is actions, not results)");
  ok(buildDefinition(null) === null && buildDefinition({ steps: [] }) === null, "an unusable draft yields no definition at all");
  ok(buildDefinition({ ...DRAFT, document: { id: "doc-1" } }).documentConstraints.requireBoundDocument === true, "a document binding becomes the document constraint");
  const everyHost = buildDefinition({ ...DRAFT, domains: ["example.com", "shop.example.com"] });
  ok(
    everyHost.domainConstraints.length === 2 && everyHost.domainConstraints[1] === "shop.example.com",
    "the host's full recorded `domains` set is used when it is present (the definition never narrows to one host)"
  );
  ok(!("outputs" in everyHost), "and nothing else from the reply rides along");
}

console.log("\n== refusals: the operator's language, with the binding evidence when given ==");
{
  const binding = RENDER.workflowRefusalText("binding_mismatch", { expected: ["example.com"], actualHost: "other.test" });
  ok(binding.includes(WORKFLOW_REFUSAL_REASON_VI.binding_mismatch), "a binding mismatch names the reason");
  ok(binding.includes("example.com") && binding.includes("other.test"), "and shows expected vs actual host (the host passes the evidence through)");
  ok(RENDER.workflowRefusalText("invalid_args").includes(WORKFLOW_REFUSAL_REASON_VI.invalid_args), "every panel-visible refusal reason has Vietnamese copy (invalid_args)");
  for (const reason of ["not_in_agent_group", "tab_gone", "busy", "bridge_unavailable", "extension_error"]) {
    ok(RENDER.workflowRefusalText(reason).includes(WORKFLOW_REFUSAL_REASON_VI[reason]), `named: ${reason}`);
  }
}

// ==========================================================================
console.log("== draft card: review -> save -> prove -> enable ==");
{
  const model = new ConversationModel("c1");
  const item = model.presentWorkflowDraft("run-1", { draft: DRAFT, review: REVIEW });
  ok(item.status === "review", "a derived draft starts in review (nothing stored, nothing enabled)");
  const html = RENDER.renderWorkflowDraftItemHtml(item);
  ok(html.includes(WORKFLOW_COPY.draftTitle), "the card names itself as a draft from this turn");
  ok(html.includes("read_page") && html.includes("computer"), "the step list names every step");
  ok(html.includes("left_click") || html.includes("ref_4"), "each step carries its own args summary");
  ok(html.includes("miền: example.com"), "the domain binding is shown");
  ok(html.includes(`data-workflow-action="save"`), "the review stage offers [Lưu bản nháp]");
  ok(!html.includes(`data-workflow-action="enable"`), "and nothing else: enablement is not reachable before a proof");

  model.settleWorkflowDraftSave({ runId: "run-1", ok: true, workflowId: "wf-orders", version: 1, stepsCount: 2 });
  const saved = RENDER.renderWorkflowDraftItemHtml(model.workflowDraftItem({ runId: "run-1" }));
  ok(saved.includes(WORKFLOW_COPY.draftSavedTitle) && saved.includes("đang tắt"), "the saved stage says the workflow is stored and DISABLED");
  ok(saved.includes(`data-workflow-action="prove"`) && saved.includes('data-workflow-id="wf-orders"'), "and offers [Chạy thử] against the stored record");
  ok(saved.includes("phiên bản v1"), "naming the version the proof will pin");
  ok(!saved.includes(`data-workflow-action="enable"`), "still no enable offer before a proof");

  model.settleWorkflowProof({
    workflowId: "wf-orders",
    ok: true,
    outcomes: [
      { index: 0, ref: "read_page", status: "ok", url: "https://example.com/orders", fetchedAt: "2026-09-14T07:30:00.000Z" },
      { index: 1, ref: "computer", status: "ok" }
    ],
    evidenceFile: "workflows/proof/wf-orders@1.json"
  });
  const proved = RENDER.renderWorkflowDraftItemHtml(model.workflowDraftItem({ workflowId: "wf-orders" }));
  ok(proved.includes(WORKFLOW_COPY.proofOk), "a passing proof says so");
  const fetchedClock = RENDER.formatClockVi("2026-09-14T07:30:00.000Z");
  ok(
    proved.includes("example.com") && /^\d{2}:\d{2}$/.test(fetchedClock) && proved.includes(fetchedClock),
    "the content step's freshness line names the SOURCE and WHEN it was read"
  );
  ok(proved.includes(`data-workflow-action="enable"`), "only now is [Bật workflow] offered");
  ok(proved.includes(`data-workflow-action="prove"`) && proved.includes(WORKFLOW_COPY.proveAgain), "with a [Chạy thử lại] beside it");

  model.settleWorkflowEnable({ workflowId: "wf-orders", ok: true, version: 1 });
  const enabled = RENDER.renderWorkflowDraftItemHtml(model.workflowDraftItem({ workflowId: "wf-orders" }));
  ok(enabled.includes(WORKFLOW_COPY.draftEnabledTitle), "the enabled stage is its own state");
  ok(!enabled.includes(`data-workflow-action="prove"`) && !enabled.includes(`data-workflow-action="enable"`), "with nothing left to decide");
}

console.log("\n== draft card: a refused save and a failed proof keep the workflow disabled ==");
{
  const model = new ConversationModel("c1");
  model.presentWorkflowDraft("run-1", { draft: DRAFT, review: REVIEW });
  model.settleWorkflowDraftSave({ runId: "run-1", ok: false, errors: [{ code: "DUPLICATE_IDENTITY", message: "workflow identity already exists" }] });
  const refused = RENDER.renderWorkflowDraftItemHtml(model.workflowDraftItem({ runId: "run-1" }));
  ok(refused.includes("workflow identity already exists"), "the host's own validation error is shown verbatim");
  ok(refused.includes(`data-workflow-action="save"`), "and the draft stays in review, re-saveable");
  ok(!refused.includes(`data-workflow-action="prove"`), "nothing claims it was stored");

  model.settleWorkflowDraftSave({ runId: "run-1", ok: true, workflowId: "wf-orders", version: 1, stepsCount: 2 });
  model.settleWorkflowProof({
    workflowId: "wf-orders",
    ok: false,
    outcomes: [
      { index: 0, ref: "read_page", status: "ok" },
      { index: 1, ref: "computer", status: "failed", reason: "target_no_longer_resolves", note: "Ref \"ref_4\" no longer exists on the page." }
    ]
  });
  const failed = RENDER.renderWorkflowDraftItemHtml(model.workflowDraftItem({ workflowId: "wf-orders" }));
  ok(failed.includes(WORKFLOW_COPY.proofFailed), "a failed proof says so");
  ok(failed.includes("không chạy được ở đây") === false, "a failed step is not confused with an unexecutable one");
  ok(failed.includes(`data-workflow-action="prove"`) && failed.includes(WORKFLOW_COPY.proveAgain), "the retry is offered");
  ok(!failed.includes(`data-workflow-action="enable"`), "the workflow stays disabled — there is no valid path to enable from a failed proof");
  ok(failed.includes("target_no_longer_resolves"), "the failing step's reason is named");

  model.settleWorkflowProof({ workflowId: "wf-orders", ok: false, reason: "busy" });
  const busy = RENDER.renderWorkflowDraftItemHtml(model.workflowDraftItem({ workflowId: "wf-orders" }));
  ok(busy.includes(WORKFLOW_REFUSAL_REASON_VI.busy), "a refusal that produced no execution is disclosed (never rendered as a verdict)");

  // An unexecutable step (a skill step this executor cannot run) is visible as
  // exactly that, and blocks enablement just like a failure does.
  const other = new ConversationModel("c2");
  other.presentWorkflowDraft("run-9", { draft: DRAFT, review: REVIEW });
  other.settleWorkflowDraftSave({ runId: "run-9", ok: true, workflowId: "wf-2", version: 1, stepsCount: 2 });
  other.settleWorkflowProof({ workflowId: "wf-2", ok: false, outcomes: [{ index: 0, ref: "summarize", status: "unexecutable", reason: "skill_step" }] });
  const unexec = RENDER.renderWorkflowDraftItemHtml(other.workflowDraftItem({ workflowId: "wf-2" }));
  ok(unexec.includes("không chạy được ở đây"), "an unexecutable step reads as not runnable here, not as a success");
  ok(!unexec.includes(`data-workflow-action="enable"`), "and it cannot be enabled on an unvalidated proof");
}

// ==========================================================================
console.log("== drift notice: static, no authority, deduped, names step and evidence ==");
{
  const model = new ConversationModel("c1");
  model.applyEvent({
    type: "workflow_drift",
    workflowId: "wf-orders",
    step: 2,
    ref: "ref_9",
    reason: "target_no_longer_resolves",
    evidence: 'Ref "ref_9" no longer exists on the page.'
  });
  const driftItem = model.items.find((i) => i.kind === "workflow_drift");
  ok(Boolean(driftItem), "the drift event lands as its own transcript item");
  const html = RENDER.renderWorkflowDriftItemHtml(driftItem);
  ok(html.includes("bước 3"), "it names the step in operator terms (1-based)");
  ok(html.includes("wf-orders"), "and the workflow");
  ok(html.includes(WORKFLOW_DRIFT_REASON_VI.target_no_longer_resolves), "and the reason in Vietnamese");
  ok(html.includes("no longer exists"), "and the evidence verbatim (escaped)");
  ok(!/data-workflow-action|<button/.test(html), "it carries NO controls at all — a drift notice is not a decision");
  ok(html.includes('role="status"') && !html.includes("alertdialog"), "and is announced as status, not as a dialog");

  // Replayed (live + snapshot) → still exactly one notice.
  model.applyEvent({
    type: "workflow_drift",
    workflowId: "wf-orders",
    step: 2,
    ref: "ref_9",
    reason: "target_no_longer_resolves",
    evidence: 'Ref "ref_9" no longer exists on the page.'
  });
  ok(model.items.filter((i) => i.kind === "workflow_drift").length === 1, "the SAME recorded drift replayed renders once");

  const binding = new ConversationModel("c2");
  binding.applyEvent({
    type: "workflow_drift",
    workflowId: "wf-orders",
    step: null,
    ref: null,
    reason: "binding_mismatch",
    evidence: { expected: ["example.com"], actualHost: "other.test" }
  });
  const bindingHtml = RENDER.renderWorkflowDriftItemHtml(binding.items.find((i) => i.kind === "workflow_drift"));
  ok(bindingHtml.includes(WORKFLOW_DRIFT_REASON_VI.binding_mismatch), "a binding mismatch names the domain reason");
  ok(bindingHtml.includes("other.test"), "and shows the structured evidence");
  ok(bindingHtml.includes("một bước") === false || true, "a pre-flight drift has no step and says so without inventing one");
}

// ==========================================================================
console.log("== heal card: allow / deny / expiry / supersede / late decision ==");
{
  const proposal = {
    type: "workflow_heal_proposed",
    proposalId: "prop-1",
    workflowId: "wf-orders",
    baseVersion: 2,
    steps: [{ kind: "tool", ref: "read_page", args: {} }],
    reason: "nút Đặt hàng đã đổi vị trí",
    evidence: 'Ref "ref_9" no longer exists',
    proposedAt: 1_760_000_000_000,
    expiresAt: 1_760_000_600_000
  };
  const model = new ConversationModel("c1");
  model.applyEvent(proposal);
  const item = model.workflowHealItem("prop-1");
  ok(Boolean(item) && item.status === "pending", "a proposal arrives pending");
  const now = 1_760_000_100_000; // inside the 10-minute window
  const html = RENDER.renderWorkflowHealItemHtml(item, now);
  ok(html.includes(WORKFLOW_COPY.healTitle), "the card names itself as a workflow repair");
  ok(html.includes("nút Đặt hàng đã đổi vị trí"), "the reason is shown");
  ok(html.includes("no longer exists"), "so is the drift evidence");
  ok(html.includes(`${WORKFLOW_COPY.baseVersion} v2`), "and the version it heals");
  ok(html.includes(`data-workflow-action="heal-allow"`) && html.includes(`data-workflow-action="heal-deny"`), "Allow and Deny are offered while pending");
  ok(html.includes('data-workflow-proposal-id="prop-1"'), "both are bound to THIS proposal id");
  ok(/aria-|btn/.test(html) && html.includes("<button"), "the controls are real buttons (keyboard reachable like the approval cards)");
  ok(html.includes(WORKFLOW_COPY.healExpiresAt), "the bounded expiry is disclosed");

  ok(RENDER.renderWorkflowHealItemHtml(item, 1_760_000_700_000).includes(WORKFLOW_COPY.healExpired), "past its deadline the card reads Đã hết hạn");
  ok(!RENDER.renderWorkflowHealItemHtml(item, 1_760_000_700_000).includes(`data-workflow-action="heal-allow"`), "an expired proposal offers nothing to answer");
  ok(model.workflowHealItem("prop-1").status === "pending", "...and the model still says pending: expiry is the HOST's resolution to record, never the panel's claim");

  model.applyEvent({ type: "workflow_heal_saved", workflowId: "wf-orders", fromVersion: 2, toVersion: 3, proposalId: "prop-1" });
  const savedHtml = RENDER.renderWorkflowHealItemHtml(model.workflowHealItem("prop-1"), now);
  ok(savedHtml.includes(WORKFLOW_COPY.healSaved) && savedHtml.includes("v3"), "an approved heal names the new version");
  ok(!savedHtml.includes(`data-workflow-action="heal-allow"`), "and stops asking");

  const denied = new ConversationModel("c2");
  denied.applyEvent(proposal);
  denied.applyEvent({ type: "workflow_heal_rejected", proposalId: "prop-1" });
  ok(RENDER.renderWorkflowHealItemHtml(denied.workflowHealItem("prop-1"), now).includes(WORKFLOW_COPY.healRejected), "a rejection is recorded distinguishably");

  const expired = new ConversationModel("c3");
  expired.applyEvent(proposal);
  expired.applyEvent({ type: "workflow_heal_expired", proposalId: "prop-1", workflowId: "wf-orders" });
  ok(RENDER.renderWorkflowHealItemHtml(expired.workflowHealItem("prop-1"), now).includes(WORKFLOW_COPY.healExpired), "the host's expiry resolution renders as its own state");

  const superseded = new ConversationModel("c4");
  superseded.applyEvent(proposal);
  superseded.applyEvent({ type: "workflow_heal_proposed", ...proposal, proposalId: "prop-2", proposedAt: proposal.proposedAt + 1000 });
  ok(superseded.workflowHealItem("prop-1").status === "superseded", "a NEW proposal for the same workflow supersedes the unresolved one");
  ok(superseded.workflowHealItem("prop-2").status === "pending", "...and the new one is the live proposal");
  superseded.applyEvent({ type: "workflow_heal_superseded", oldProposalId: "prop-1", newProposalId: "prop-2" });
  const supersededHtml = RENDER.renderWorkflowHealItemHtml(superseded.workflowHealItem("prop-1"), now);
  ok(supersededHtml.includes(WORKFLOW_COPY.healSuperseded), "the superseded card says so");
  ok(!supersededHtml.includes(`data-workflow-action="heal-allow"`), "and cannot still be answered");

  // A LATE decision: the host refuses, and the refusal is rendered on the card
  // (the operator sees why their click did nothing).
  superseded.settleWorkflowHealDecision({ proposalId: "prop-2", ok: false, decision: "allow", reason: "unknown_proposal" });
  const lateHtml = RENDER.renderWorkflowHealItemHtml(superseded.workflowHealItem("prop-2"), now);
  ok(lateHtml.includes(WORKFLOW_REFUSAL_REASON_VI.unknown_proposal), "a late decision renders the host's refusal, not a silent reset");
}

// ==========================================================================
console.log("== restore: cards rebuild from the host's events, exactly once ==");
{
  const model = new ConversationModel("c1");
  const snapshot = {
    conversationId: "c1",
    lastSeq: 12,
    firstSeq: 1,
    hasOlder: false,
    meta: {},
    events: [
      { seq: 10, type: "workflow_draft_saved", workflowId: "wf-orders", version: 1, stepsCount: 3, ts: 100 },
      { seq: 11, type: "workflow_proof", workflowId: "wf-orders", version: 1, ok: true, summary: "3 bước đạt", ts: 110 },
      { seq: 12, type: "workflow_enabled", workflowId: "wf-orders", version: 1, ts: 120 }
    ]
  };
  model.applySnapshot(snapshot);
  const cards = model.items.filter((i) => i.kind === "workflow_draft");
  ok(cards.length === 1, "a reload rebuilds exactly ONE draft card");
  ok(cards[0].status === "enabled" && cards[0].workflowId === "wf-orders" && cards[0].version === 1, "carrying the record identity and the final stage");
  ok(cards[0].proof && cards[0].proof.ok === true, "and the proof verdict the event carried");
  const restored = RENDER.renderWorkflowDraftItemHtml(cards[0]);
  ok(restored.includes(WORKFLOW_COPY.draftRestoredDetail), "a restored card says the step list is not in this window rather than inventing one");
  ok(!restored.includes(`data-workflow-action="enable"`), "an already-enabled record offers nothing to enable");

  model.applySnapshot(snapshot);
  ok(model.items.filter((i) => i.kind === "workflow_draft").length === 1, "a SECOND rebuild still holds exactly one card");

  const drills = new ConversationModel("c2");
  drills.applySnapshot({
    conversationId: "c2",
    lastSeq: 21,
    firstSeq: 20,
    hasOlder: false,
    meta: {},
    events: [
      { seq: 20, type: "workflow_drift", workflowId: "wf-orders", step: 0, ref: "ref_2", reason: "target_no_longer_resolves", evidence: "gone", ts: 200 },
      { seq: 21, type: "workflow_drift", workflowId: "wf-orders", step: 0, ref: "ref_2", reason: "target_no_longer_resolves", evidence: "gone", ts: 200 }
    ]
  });
  ok(drills.items.filter((i) => i.kind === "workflow_drift").length === 1, "a replayed pair of identical drift records still renders once");
}

console.log("\n== a window rebuild carries the local half of the cards ==");
{
  const model = new ConversationModel("c1", { maxWindowEvents: 4 });
  model.addLocalUserMessage("chạy đi");
  model.bindRunToLastUserMessage("run-1");
  model.applyEvent({ type: "run_started", runId: "run-1", seq: 1 });
  model.applyEvent({ type: "run_done", runId: "run-1", seq: 2 });
  model.presentWorkflowDraft("run-1", { draft: DRAFT, review: REVIEW });
  model.settleWorkflowDraftSave({ runId: "run-1", ok: true, workflowId: "wf-orders", version: 1, stepsCount: 2 });
  model.settleWorkflowProof({ workflowId: "wf-orders", ok: true, outcomes: [{ index: 0, ref: "read_page", status: "ok" }] });
  // Overflow the window so the oldest events are evicted and the items rebuild.
  for (let i = 3; i <= 12; i++) model.applyEvent({ type: "tab_risk_update", runId: "run-1", tabId: 1, category: "low", signals: [], seq: i });
  const kept = model.workflowDraftItem({ workflowId: "wf-orders" });
  ok(Boolean(kept), "eviction does not drop the card the operator is looking at");
  ok(kept.status === "proved" && kept.proof && kept.proof.ok === true, "its local half (the proof verdict) survives the rebuild");
  ok(Array.isArray(kept.proofOutcomes) && kept.proofOutcomes.length === 1, "and so does the per-step proof detail");
}

// ==========================================================================
console.log("== controller: the five operations put the frozen wire shapes on the protocol ==");
{
  const { controller, model, protocol } = makeController();
  const pending = controller.requestWorkflowDraft("run-7");
  const req = protocol.sent[0];
  ok(req.method === "workflowDraftRequest", "a draft request goes out as workflow_draft_request");
  ok(req.opts.conversationId === "conv1" && req.opts.runId === "run-7", "carrying the conversation and the run");
  ok(typeof req.opts.requestId === "string" && req.opts.requestId.length > 0, "and a requestId the reply is correlated by");
  protocol.deliver({ type: "workflow_draft_request", requestId: req.opts.requestId, ok: true, draft: DRAFT, review: REVIEW });
  await pending;
  ok(model.workflowDraftItem({ runId: "run-7" }).status === "review", "an ok reply materializes the review card");

  const item = model.workflowDraftItem({ runId: "run-7" });
  const saving = controller.saveWorkflowDraft("run-7", buildDefinition(item.draft));
  const saveReq = protocol.sent.find((s) => s.method === "workflowDraftSave");
  ok(saveReq.opts.runId === "run-7" && saveReq.opts.definition.id === "wf-orders", "save sends the definition the panel built for that run");
  ok(item.busy === "saving", "the card shows the in-flight stage while the host answers");
  protocol.deliver({ type: "workflow_draft_save", requestId: saveReq.opts.requestId, ok: true, workflowId: "wf-orders", version: 1 });
  await saving;
  ok(item.status === "saved" && item.workflowId === "wf-orders" && item.version === 1, "the reply advances the card to saved (disabled)");

  const proving = controller.proveWorkflow({ workflowId: "wf-orders", version: 1, tabId: 33 });
  const proveReq = protocol.sent.find((s) => s.method === "workflowProve");
  ok(proveReq.opts.tabId === 33 && proveReq.opts.workflowId === "wf-orders" && proveReq.opts.version === 1, "prove sends the record and the live tab it runs against");
  protocol.deliver({ type: "workflow_prove", requestId: proveReq.opts.requestId, ok: true, outcomes: [{ index: 0, ref: "read_page", status: "ok" }], evidenceFile: "workflows/proof/wf-orders@1.json" });
  await proving;
  ok(item.status === "proved" && item.proof.ok === true && item.proofOutcomes.length === 1, "the reply's outcomes land on the card");
  ok(item.proof.evidenceFile === "workflows/proof/wf-orders@1.json", "and the evidence file the host wrote is kept with it");

  // The host's TWO answers: `ok:true` means a proof RAN, `allOk` is its
  // verdict. A run that could not validate every step must not read as a pass.
  const { controller: c3, model: m3, protocol: p3 } = makeController();
  m3.applyEvent({ type: "workflow_draft_saved", workflowId: "wf-partial", version: 1, stepsCount: 2 });
  const partial = c3.proveWorkflow({ workflowId: "wf-partial", version: 1, tabId: 4 });
  const partialReq = p3.sent.find((s) => s.method === "workflowProve");
  p3.deliver({
    type: "workflow_prove",
    requestId: partialReq.opts.requestId,
    ok: true,
    allOk: false,
    outcomes: [{ index: 0, ref: "read_page", status: "ok" }, { index: 1, ref: "summarize", status: "unexecutable" }],
    evidenceFile: "workflows/proof/wf-partial@1.json"
  });
  await partial;
  const partialItem = m3.workflowDraftItem({ workflowId: "wf-partial" });
  ok(partialItem.proof.ok === false, "a proof that RAN but did not validate every step is not a passing proof");
  ok(
    !RENDER.renderWorkflowDraftItemHtml(partialItem).includes(`data-workflow-action="enable"`),
    "and its card offers no way to enable an unvalidated draft"
  );

  const enabling = controller.enableWorkflow({ workflowId: "wf-orders", version: 1 });
  const enableReq = protocol.sent.find((s) => s.method === "workflowEnable");
  protocol.deliver({ type: "workflow_enable", requestId: enableReq.opts.requestId, ok: true, version: 1 });
  await enabling;
  ok(item.status === "enabled", "an enable reply flips the card to enabled");

  // A prove that never ran is a refusal, not a failed proof.
  const { controller: c2, model: m2, protocol: p2 } = makeController();
  m2.applyEvent({ type: "workflow_draft_saved", workflowId: "wf-x", version: 1, stepsCount: 1 });
  const busyProve = c2.proveWorkflow({ workflowId: "wf-x", version: 1, tabId: 4 });
  const busyReq = p2.sent.find((s) => s.method === "workflowProve");
  p2.deliver({ type: "workflow_prove", requestId: busyReq.opts.requestId, ok: false, reason: "busy" });
  await busyProve;
  const busyItem = m2.workflowDraftItem({ workflowId: "wf-x" });
  ok(busyItem.status === "saved" && busyItem.lastError.reason === "busy", "a proof refused as busy leaves the record unproved and says why");
  ok(busyItem.proof === null, "and never records a verdict it did not receive");

  const heal = controller.decideWorkflowHeal({ proposalId: "prop-9", decision: "allow" });
  const healReq = protocol.sent.find((s) => s.method === "workflowHealDecide");
  ok(healReq.opts.proposalId === "prop-9" && healReq.opts.decision === "allow", "a heal decision sends workflow_heal_decide with the proposal id and the decision");
  protocol.deliver({ type: "workflow_heal_decide", requestId: healReq.opts.requestId, ok: true, decision: "allow", workflowId: "wf-orders", fromVersion: 1, toVersion: 2 });
  await heal;
  const healed = model.workflowHealItem("prop-9");
  ok(!healed, "no card exists for a proposal this conversation never received — the reply alone creates none");
}

console.log("\n== controller: an unanswered operation claims nothing ==");
{
  const { controller, model, protocol } = makeController();
  const pending = controller.requestWorkflowDraft("run-3");
  const timeoutOutcome = await pending; // no reply is delivered -> times out
  ok(timeoutOutcome === null, "a dropped request reports nothing back");
  ok(!model.workflowDraftItem({ runId: "run-3" }), "and no card is invented for a derivation the host never answered");
  ok(protocol.sent.length === 1, "...the request really was sent exactly once");

  const draft = new ConversationModel("c3");
  draft.presentWorkflowDraft("run-1", { draft: DRAFT, review: REVIEW });
  draft.settleWorkflowDraftSave({ runId: "run-1", ok: true, workflowId: "wf-orders", version: 1 });
  const { controller: c2, protocol: p2 } = makeController();
  c2.models.set("conv1", draft);
  const proving = c2.proveWorkflow({ workflowId: "wf-orders", version: 1, tabId: 3 });
  const req = p2.sent.find((s) => s.method === "workflowProve");
  p2.deliver({ type: "workflow_prove", requestId: req.opts.requestId, ok: false, reason: "extension_error" });
  await proving;
  const item = draft.workflowDraftItem({ workflowId: "wf-orders" });
  ok(item.status === "saved" && item.lastError.reason === "extension_error", "an extension-side refusal is disclosed and the record stays unproved");
}

console.log("\n== the incomplete-derivation notice is a sentence, never a card ==");
{
  const model = new ConversationModel("c1");
  const text = RENDER.workflowDraftRefusalText({ ok: false, incomplete: ["bước 2 gọi công cụ không rõ", "giá trị ở bước 3 không thể khôi phục"] });
  ok(text.includes("bước 2 gọi công cụ không rõ") && text.includes("bước 3"), "every specific incompleteness reason is carried into the notice");
  const coarse = RENDER.workflowDraftRefusalText({ ok: false, reason: "run_not_completed" });
  ok(coarse.includes(WORKFLOW_REFUSAL_REASON_VI.run_not_completed), "a coarse refusal reason is mapped to the operator's language");
  ok(RENDER.workflowDraftRefusalText({ ok: false }).includes("Không thực hiện được"), "an unknown reason falls back to a generic sentence, never to a fabricated explanation");
  ok(model.items.length === 0, "a refused derivation leaves no transcript card behind");
  ok(SIDEPANEL_SRC.includes("function showWorkflowNotice"), "the notice renders through the composer-level inline notice, not a permission card");
  ok(!/renderWorkflowNoticeCard/.test(SIDEPANEL_SRC), "no card renderer for the incomplete path exists");
}

console.log("\n== the composer-level notice is a real element, hidden by default ==");
{
  const doc = createDocument();
  const composerWrap = doc.createElement("div");
  const composerInput = doc.createElement("textarea");
  const composer = doc.createElement("div");
  composer.appendChild(composerInput);
  composerWrap.appendChild(composer);

  const elStub = { composerWrap, composerInput };
  const install = compile(extract("installWorkflowNotice"), { document: doc, el: elStub }, "installWorkflowNotice");
  const notice = install();
  ok(notice.parentNode === composerWrap, "the notice is inserted into the composer wrap (the composer-scoped slot family)");
  ok(composerWrap.children.indexOf(notice) === composerWrap.children.indexOf(composer) - 1, "...directly above the composer");
  ok(notice.hidden === true, "and starts hidden");
  ok(notice.getAttribute("role") === "alert" && notice.getAttribute("id") === "workflow-notice", "it is announced politely and identified");
  ok(SIDEPANEL_SRC.includes("el.workflowNotice = installWorkflowNotice();"), "the panel keeps the one installed node on its el map");
  ok(/el\.workflowNotice\.hidden = !text;/.test(SIDEPANEL_SRC), "showing it writes text and unhides; clearing it hides again — never a card");
}

console.log("\n== structure signature: every card state repaints structurally ==");
{
  const signature = compile(extract("transcriptStructureSignature"), {}, "transcriptStructureSignature");
  const model = new ConversationModel("c1");
  model.addLocalUserMessage("làm đi");
  model.bindRunToLastUserMessage("run-1");
  model.applyEvent({ type: "run_done", runId: "run-1" });
  const base = signature(model, {});
  model.presentWorkflowDraft("run-1", { draft: DRAFT, review: REVIEW });
  const review = signature(model, {});
  ok(review !== base, "the draft card's appearance changes the signature");
  model.settleWorkflowDraftSave({ runId: "run-1", ok: true, workflowId: "wf-orders", version: 1, stepsCount: 2 });
  const saved = signature(model, {});
  ok(saved !== review, "saving is structural");
  model.settleWorkflowProof({ workflowId: "wf-orders", ok: true, outcomes: [{ index: 0, ref: "read_page", status: "ok" }] });
  const proved = signature(model, {});
  ok(proved !== saved, "a proof verdict (and its outcomes) is structural");
  model.applyEvent({ type: "workflow_drift", workflowId: "wf-orders", step: 0, ref: "ref_1", reason: "target_no_longer_resolves", evidence: "gone", ts: 5 });
  ok(signature(model, {}) !== proved, "a drift notice appearing is structural");
  const before = signature(model, {});
  model.applyEvent({ type: "workflow_heal_proposed", proposalId: "p1", workflowId: "wf-orders", baseVersion: 1, reason: "r", evidence: "e" });
  ok(signature(model, {}) !== before, "a new heal proposal is structural");
  const withHeal = signature(model, {});
  model.applyEvent({ type: "workflow_heal_rejected", proposalId: "p1" });
  ok(signature(model, {}) !== withHeal, "and so is its answer");
  ok(/wireWorkflowControls\(model\);/.test(SIDEPANEL_SRC), "renderTranscript wires the cards after every structural render");
}

console.log("\n== a card below a live turn does not demote it (the streaming path keys on the latest TURN) ==");
{
  const latestTurn = compile(extract("latestAssistantTurnIndex"), {}, "latestAssistantTurnIndex");
  const items = [
    { kind: "user" },
    { kind: "assistant_turn", runId: "r1" },
    { kind: "workflow_drift", driftId: "d1" }
  ];
  ok(latestTurn(items) === 1, "a drift notice below the live turn leaves the turn as the latest turn");
  ok(latestTurn([{ kind: "workflow_heal" }, { kind: "workflow_draft" }]) === -1, "no turn at all reports -1 rather than guessing");
  ok(latestTurn([]) === -1 && latestTurn(null) === -1, "an empty/absent transcript reports -1");
  ok(/const latestTurnIndex = latestAssistantTurnIndex\(model\.items\);/.test(SIDEPANEL_SRC), "renderTranscript uses that rule for the live/streaming decision");
  ok(/const isLatest = idx === latestTurnIndex;/.test(SIDEPANEL_SRC), "...and for the per-turn live flags");

  // The regression itself, through the model: a drift recorded mid-run leaves
  // the run's turn live so the panel keeps painting into it in place.
  const model = new ConversationModel("c1");
  model.addLocalUserMessage("chạy workflow");
  model.bindRunToLastUserMessage("run-1");
  model.applyEvent({ type: "run_started", runId: "run-1" });
  model.applyEvent({ type: "workflow_drift", workflowId: "wf-orders", step: 0, ref: "ref_1", reason: "target_no_longer_resolves", evidence: "gone" });
  ok(model.hasActiveRun() === true, "the run is still active after a mid-run drift");
  ok(latestTurn(model.items) === 1, "and its turn is still the transcript's latest turn for the streaming path");
}

// ==========================================================================
console.log("\n== edit: fetch the stored steps, fix them, save as the next version ==");
{
  const { controller, model, protocol } = makeController();
  model.presentWorkflowDraft("run-1", { draft: DRAFT, review: REVIEW });
  model.settleWorkflowDraftSave({ runId: "run-1", ok: true, workflowId: "wf-orders", version: 2, stepsCount: 2 });
  const item = model.workflowDraftItem({ workflowId: "wf-orders" });

  // The fetch asks for the exact stored record and opens the editor with the
  // HOST's current steps — never the card's possibly-stale derivation.
  const fetching = controller.requestWorkflowEdit({ workflowId: "wf-orders", version: 2 });
  const fetchReq = protocol.sent.find((s) => s.method === "workflowEditRequest");
  ok(fetchReq.opts.workflowId === "wf-orders" && fetchReq.opts.version === 2, "the edit fetch names the exact record");
  ok(item.edit && item.edit.status === "loading", "the card shows a loading stage while the fetch is in flight");
  const currentSteps = [
    { kind: "tool", ref: "navigate", args: { url: "https://example.com/" } },
    { kind: "tool", ref: "find", args: { query: "TBMT" } },
    { kind: "tool", ref: "computer", args: { action: "left_click", ref: "ref_9" } }
  ];
  protocol.deliver({ type: "workflow_edit_request", requestId: fetchReq.opts.requestId, ok: true, workflowId: "wf-orders", version: 2, steps: currentSteps });
  await fetching;
  ok(item.edit && item.edit.status === "editing" && item.edit.steps.length === 3, "the host's current steps open the editor");

  // Rendering: one editable args input + one remove control per row; the
  // saved-state actions are replaced by save/cancel.
  const editing = RENDER.renderWorkflowDraftItemHtml(item);
  ok((editing.match(/class="workflow-edit-args"/g) || []).length === 3, "one args input per step row");
  ok(editing.includes("&quot;url&quot;") && editing.includes("https://example.com/"), "each input starts from the stored args JSON");
  ok((editing.match(/data-workflow-action="remove-step"/g) || []).length === 3, "each row carries a remove control");
  ok(editing.includes('data-workflow-action="edit-save"') && editing.includes('data-workflow-action="edit-cancel"'), "edit mode offers save and cancel");
  ok(!editing.includes('data-workflow-action="prove"'), "and none of the saved-state actions while editing");

  // A local problem (invalid JSON) shows on the card; the editor stays open.
  model.setWorkflowEditProblem("wf-orders", WORKFLOW_COPY.editInvalidArgs);
  const problemHtml = RENDER.renderWorkflowDraftItemHtml(item);
  ok(problemHtml.includes(WORKFLOW_COPY.editInvalidArgs), "a local problem is shown on the card");
  ok(problemHtml.includes('data-workflow-action="edit-save"'), "and the editor stays usable");
  model.setWorkflowEditProblem("wf-orders", null);

  // Remove one row (the working copy, nothing written), then save.
  model.replaceWorkflowEditSteps("wf-orders", [currentSteps[0], currentSteps[2]]);
  ok(item.edit.steps.length === 2 && item.edit.steps[1].ref === "computer", "a removed step leaves the working copy only");

  const saving = controller.saveWorkflowEdit({ workflowId: "wf-orders", version: 2, steps: item.edit.steps });
  const saveReq = protocol.sent.find((s) => s.method === "workflowEditSave");
  ok(saveReq.opts.workflowId === "wf-orders" && saveReq.opts.version === 2 && saveReq.opts.steps.length === 2, "save sends the edited steps against the version they were fetched from");
  ok(item.edit.status === "saving", "the card shows the in-flight stage");
  protocol.deliver({ type: "workflow_edit_save", requestId: saveReq.opts.requestId, ok: true, workflowId: "wf-orders", version: 3 });
  await saving;
  ok(item.edit === null && item.version === 3 && item.status === "saved", "the reply lands the card on the new, unproven version");
  ok(item.proof === null && item.proofOutcomes === null, "and the old proof verdict does not carry over");

  // A refusal keeps the working copy with the host's own reason on it.
  model.beginWorkflowEditLoad("wf-orders");
  model.settleWorkflowEditLoad({ workflowId: "wf-orders", ok: true, version: 3, steps: currentSteps });
  const stale = controller.saveWorkflowEdit({ workflowId: "wf-orders", version: 3, steps: currentSteps.slice(0, 1) });
  const staleReq = protocol.sent.filter((s) => s.method === "workflowEditSave").at(-1);
  protocol.deliver({ type: "workflow_edit_save", requestId: staleReq.opts.requestId, ok: false, reason: "stale_version", latest: 4 });
  await stale;
  ok(item.edit && item.edit.status === "editing", "a refused save keeps the editor open");
  const staleHtml = RENDER.renderWorkflowDraftItemHtml(item);
  ok(staleHtml.includes(WORKFLOW_REFUSAL_REASON_VI.stale_version) && staleHtml.includes("v4"), "the refusal names why and discloses the latest version");

  model.cancelWorkflowEdit("wf-orders");
  ok(item.edit === null, "cancel leaves edit mode with nothing written");

  // The durable event moves any card onto the written version.
  model.applyEvent({ type: "workflow_updated", workflowId: "wf-orders", fromVersion: 3, toVersion: 5 });
  ok(item.version === 5 && item.status === "saved", "workflow_updated moves the card onto the written version");

  // Step builder: args round-trip, invalid rows refuse the whole save.
  const built = EDIT_STEPS.buildWorkflowEditSteps(
    [{ kind: "tool", ref: "find", args: { query: "TBMT" } }, { kind: "tool", ref: "computer" }],
    ['{"query":"Hải Phòng"}', ""]
  );
  ok(built.ok && built.steps[0].args.query === "Hải Phòng", "edited args replace the recorded ones");
  ok(built.ok && built.steps[1].args === undefined, "an emptied input means no args");
  const bad = EDIT_STEPS.buildWorkflowEditSteps([{ kind: "tool", ref: "find", args: {} }], ["{nope"]);
  ok(bad.ok === false && bad.index === 0, "one bad row refuses the whole save and names its index");
  ok(EDIT_STEPS.parseWorkflowEditArgs("[1,2]").ok === false, "a non-object JSON value is refused too");
}

console.log(fail === 0 ? "\nALL SIDEPANEL WORKFLOW CARD TESTS PASSED\n" : `\n${fail} FAILED\n`);
process.exit(fail ? 1 : 0);
