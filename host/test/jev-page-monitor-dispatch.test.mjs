#!/usr/bin/env node

import assert from "node:assert/strict";
import http from "node:http";

import { RUN_STATES } from "../agent/session/run.js";
import { runTypesafeRun } from "../agent/jev/runtime.js";

const SNAPSHOT = {
  v: 1,
  docNonce: "monitor-test-document",
  url: "https://example.com/detail?notifyNo=NT-42&planNo=PL-7",
  title: "Detail",
  text: "A detail page",
  viewport: { w: 800, h: 600 },
  elements: []
};

function response(res, payload) {
  res.writeHead(200, { "Content-Type": "application/json", Connection: "close" });
  res.end(JSON.stringify(payload));
}

async function startModelServer() {
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const request = JSON.parse(body);
    const instruction = request.messages?.[0]?.content || "";
    const value = instruction.startsWith("Prepare")
      ? { memory: { plan: "Save the page.", doneWhen: "The page monitor baseline is saved.", notes: "" }, textValues: [], navigation: [] }
      : { report: request.messages?.[1]?.content?.includes('"outcome":"error"') ? "The page monitor save failed." : "The page monitor baseline was saved." };
    response(res, { choices: [{ message: { content: JSON.stringify(value) } }], usage: { total_tokens: 1 } });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

function harness(monitorResult) {
  const events = [];
  const calls = [];
  const run = {
    runId: "run_page_monitor",
    conversationId: "conversation_page_monitor",
    state: RUN_STATES.RUNNING,
    tabScope: "any",
    uploadAllowlist: { isAllowed: () => false },
    emit: (event) => events.push(event),
    describeRequestForWire: () => ({ runId: "run_page_monitor", conversationId: "conversation_page_monitor", tabScope: "any" }),
    leaseHeldByThisRun: () => true,
    recordResultUnknown: () => {},
    recordRejectedDispatch: () => {}
  };
  const toolBridge = {
    call: async (name, args, meta) => {
      calls.push({ name, args, meta });
      if (name === "page_snapshot") return { result: { content: [{ type: "text", text: JSON.stringify(SNAPSHOT) }] }, resultUnknown: false };
      if (name === "page_monitor") return { result: monitorResult, resultUnknown: false };
      throw new Error(`unexpected tool ${name}`);
    }
  };
  return { run, toolBridge, events, calls };
}

const model = await startModelServer();
try {
  for (const [label, monitorResult, expectedOutcome] of [
    ["saved", { content: [{ type: "text", text: JSON.stringify({ ok: true, status: "saved" }) }] }, "done"],
    ["failed", { content: [{ type: "text", text: JSON.stringify({ ok: false, status: "failed" }) }], isError: true }, "error"]
  ]) {
    const h = harness(monitorResult);
    const outcome = await runTypesafeRun({
      run: h.run,
      toolBridge: h.toolBridge,
      coerceArgs: (args) => ({ ...args, __coerced: true }),
      canUseTool: async () => ({ behavior: "allow" }),
      provider: {
        endpoint: model.url,
        apiKey: "jev-key",
        model: "jev-latest",
        goal: "Save and monitor this page with page_monitor.",
        tabId: 7,
        textModel: { baseUrl: model.url, model: "text-model", apiKey: "text-key" }
      }
    });

    const monitorCalls = h.calls.filter((call) => call.name === "page_monitor");
    assert.equal(monitorCalls.length, 1, `${label}: page_monitor must dispatch exactly once`);
    assert.deepEqual(
      { ...monitorCalls[0].args, __coerced: undefined },
      { tabId: 7, action: "save", identifier: "NT-42", url: SNAPSHOT.url, kind: "page", __coerced: undefined },
      `${label}: page_monitor receives the observed identifier and URL`
    );
    const step = h.events.find((event) => event.type === "jev_step");
    assert.equal(step?.tool, "page_monitor", `${label}: the monitor dispatch is recorded as a step`);
    assert.equal(outcome.outcome, expectedOutcome, `${label}: ${JSON.stringify(outcome)}`);
    if (label === "saved") assert.equal(outcome.doneVerified, true, "a saved baseline is verified success");
  }
} finally {
  await model.close();
}

console.log("Jev page monitor dispatch regression passed");
