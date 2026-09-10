// Tests extension/webmcp/detect-main.js's REAL, unmodified source (compiled
// via `new Function`, never copied) against a minimal fake window/document/
// document.modelContext — the MAIN-world script that actually talks to
// Chrome's document.modelContext.executeTool(), as opposed to
// test/webmcp-handlers.test.mjs, which covers extension/background.js's
// webmcp_list_tools/webmcp_call_tool handlers with a faked per-tab table and
// does not exercise this file at all.
//
// Why this file exists: Chrome's shipped executeTool() is string-in/
// string-out and requires the LIVE RegisteredTool object from getTools() as
// its first argument (verified against Chrome's own documentation,
// developer.chrome.com/docs/ai/webmcp/imperative-api) — a divergence from
// the W3C explainer's plainer sketch that design.md Decision 1 anticipated
// and this file's executeTool branch now implements. The captured-callback
// fallback branch is the mirror image (plain object in, plain object out).
// Getting the two branches' data types crossed is the single easiest mistake
// here, so this file drives both paths end to end and asserts on the exact
// values crossing the window.postMessage boundary.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_PATH = path.join(__dirname, "..", "extension", "webmcp", "detect-main.js");
const SRC = fs.readFileSync(SRC_PATH, "utf8");

let fail = 0;
const ok = (c, m) => { console.log((c ? "  PASS " : "  FAIL ") + m); if (!c) fail++; };

// Flush both the microtask queue (Promise chains) and any pending
// setTimeout(0) work, so detect-main.js's internal getTools()/executeTool()
// promise chains have fully settled before assertions run.
function flush() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// A minimal same-document postMessage bus. Synchronous dispatch (unlike a
// real browser's queued delivery) is fine here: nothing in detect-main.js
// depends on postMessage's real task-boundary timing, only on
// `event.source === window` and the message shape.
function makeFakeWindow() {
  const listeners = [];
  const win = {
    addEventListener(type, fn) {
      if (type === "message") listeners.push(fn);
    },
    postMessage(data) {
      const event = { source: win, data };
      for (const fn of listeners.slice()) fn(event);
    }
  };
  return win;
}

// `executeTool`, when provided, is the exact spy/fake function installed as
// document.modelContext.executeTool. `stringifyInputSchema` makes getTools()
// return RegisteredTool.inputSchema as a JSON STRING rather than an object —
// matching real Chrome builds per the W3C spec's own "stringified input
// schema" serialization algorithm for getTools() (independently corroborated
// against live Chrome 150/153 builds by third-party WebMCP integration
// testing; Chrome's own documentation examples read as an object, which
// turned out to be a documentation-illustration artifact, not the real wire
// shape — see detect-main.js's safeSchema()).
function makeFakeModelContext({ executeTool, stringifyInputSchema = false } = {}) {
  const registered = new Map(); // name -> the ModelContextTool definition passed to registerTool
  const mc = {
    registerTool(toolDefinition) {
      registered.set(toolDefinition.name, toolDefinition);
      return Promise.resolve();
    },
    getTools() {
      // Deliberately a DIFFERENT object per call than the ModelContextTool
      // passed to registerTool — matching the real API, where getTools()
      // hands back its own RegisteredTool dictionary, not the registration
      // input. detect-main.js must therefore hold onto exactly the object
      // THIS function returns, not reconstruct one from a name.
      return Promise.resolve(
        Array.from(registered.values()).map((t) => ({
          name: t.name,
          title: t.name,
          description: t.description,
          inputSchema: stringifyInputSchema ? JSON.stringify(t.inputSchema) : t.inputSchema,
          origin: "https://fixture.example",
          window: {}
        }))
      );
    },
    addEventListener() {
      // toolchange is exercised by webmcp-handlers.test.mjs's design intent
      // via refresh()'s other call sites; not needed for the executeTool/
      // captured-callback data-shape assertions this file focuses on.
    }
  };
  if (executeTool) mc.executeTool = executeTool;
  return mc;
}

function run(mc, win) {
  const fn = new Function("window", "document", SRC);
  fn(win, { modelContext: mc });
}

function messagesOfKind(captured, kind) {
  return captured.filter((m) => m && m.browzy_webmcp_v1 === true && m.kind === kind);
}

console.log("== executeTool path: correct call shape and result parsing ==");
{
  const calls = [];
  const executeTool = (tool, argsJson) => {
    calls.push({ tool, argsJson });
    return Promise.resolve(JSON.stringify({ items: [], total: 0 }));
  };
  const mc = makeFakeModelContext({ executeTool });
  const win = makeFakeWindow();
  const captured = [];
  win.addEventListener("message", (e) => captured.push(e.data));

  run(mc, win);
  await flush();
  await mc.registerTool({
    name: "get_cart",
    description: "Return the current cart",
    inputSchema: { type: "object", properties: {} },
    execute: () => ({ should: "never be called on this path" })
  });
  await flush();

  win.postMessage({ browzy_webmcp_v1: true, kind: "call_request", requestId: "r1", name: "get_cart", toolArgs: { foo: "bar" } });
  await flush();

  ok(calls.length === 1, `executeTool was called exactly once (got ${calls.length})`);
  const call = calls[0];
  ok(!!call, "a call was captured");
  if (call) {
    ok(call.tool && call.tool.name === "get_cart", "first argument is a RegisteredTool-shaped object naming the right tool");
    ok(typeof call.argsJson === "string", `second argument is a STRING, not an object (got ${typeof call.argsJson})`);
    let parsedArgs;
    try { parsedArgs = JSON.parse(call.argsJson); } catch { parsedArgs = null; }
    ok(parsedArgs && parsedArgs.foo === "bar", `the JSON string round-trips back to the original toolArgs (got ${call.argsJson})`);
  }

  const results = messagesOfKind(captured, "call_result").filter((m) => m.requestId === "r1");
  ok(results.length === 1, "exactly one call_result was reported for this request");
  const result = results[0];
  ok(result && result.ok === true, "the call is reported as successful");
  ok(result && result.via === "executeTool", `via names the mediated path (got ${result && result.via})`);
  ok(
    result && result.result && result.result.items && Array.isArray(result.result.items) && result.result.total === 0,
    `executeTool's JSON-string return value was JSON.parse()d into a real object before reporting (got ${JSON.stringify(result && result.result)})`
  );

  const started = messagesOfKind(captured, "call_started").filter((m) => m.requestId === "r1");
  ok(started.length === 1 && started[0].via === "executeTool", "call_started names the path before the call resolves, honestly");
}

console.log("\n== executeTool path: a name outside the current getTools() inventory is refused without calling executeTool ==");
{
  const calls = [];
  const executeTool = (tool, argsJson) => {
    calls.push({ tool, argsJson });
    return Promise.resolve("{}");
  };
  const mc = makeFakeModelContext({ executeTool });
  const win = makeFakeWindow();
  const captured = [];
  win.addEventListener("message", (e) => captured.push(e.data));
  run(mc, win);
  await flush();

  win.postMessage({ browzy_webmcp_v1: true, kind: "call_request", requestId: "r2", name: "not_a_real_tool", toolArgs: {} });
  await flush();

  ok(calls.length === 0, "executeTool was never called for a name outside the inventory");
  const results = messagesOfKind(captured, "call_result").filter((m) => m.requestId === "r2");
  ok(results.length === 1 && results[0].ok === false, "reported as a failed call");
  ok(/not in the current getTools\(\) inventory/.test((results[0] && results[0].error) || ""), `error explains why (got: ${results[0] && results[0].error})`);
}

console.log("\n== captured-callback fallback: plain objects in, plain objects out — never JSON-stringified ==");
{
  const executeCalls = [];
  const mc = makeFakeModelContext({}); // no executeTool on this build
  const win = makeFakeWindow();
  const captured = [];
  win.addEventListener("message", (e) => captured.push(e.data));
  run(mc, win);
  await flush();

  await mc.registerTool({
    name: "search_products",
    description: "Search the catalog",
    inputSchema: { type: "object", properties: { q: { type: "string" } } },
    execute: (args) => {
      executeCalls.push(args);
      return { hits: [{ id: "p1" }], query: args.q };
    }
  });
  await flush();

  win.postMessage({ browzy_webmcp_v1: true, kind: "call_request", requestId: "r3", name: "search_products", toolArgs: { q: "keyboard" } });
  await flush();

  ok(executeCalls.length === 1, "the page's own execute callback was invoked exactly once");
  ok(
    executeCalls[0] && typeof executeCalls[0] === "object" && executeCalls[0].q === "keyboard",
    `execute() received the PLAIN toolArgs object, not a JSON string (got ${JSON.stringify(executeCalls[0])})`
  );

  const results = messagesOfKind(captured, "call_result").filter((m) => m.requestId === "r3");
  ok(results.length === 1 && results[0].ok === true, "reported as a successful call");
  ok(results[0] && results[0].via === "captured-callback", `via names the fallback path (got ${results[0] && results[0].via})`);
  ok(
    results[0] && results[0].result && results[0].result.query === "keyboard" && Array.isArray(results[0].result.hits),
    `the callback's PLAIN return object is reported unchanged, never JSON-stringified (got ${JSON.stringify(results[0] && results[0].result)})`
  );
}

console.log("\n== captured-callback fallback: an unregistered name is refused without invoking any page code ==");
{
  const executeCalls = [];
  const mc = makeFakeModelContext({});
  const win = makeFakeWindow();
  const captured = [];
  win.addEventListener("message", (e) => captured.push(e.data));
  run(mc, win);
  await flush();
  await mc.registerTool({
    name: "known_tool",
    description: "d",
    inputSchema: {},
    execute: (args) => { executeCalls.push(args); return {}; }
  });
  await flush();

  win.postMessage({ browzy_webmcp_v1: true, kind: "call_request", requestId: "r4", name: "unknown_tool", toolArgs: {} });
  await flush();

  ok(executeCalls.length === 0, "no page code was invoked for an unregistered tool name");
  const results = messagesOfKind(captured, "call_result").filter((m) => m.requestId === "r4");
  ok(results.length === 1 && results[0].ok === false, "reported as a failed call");
  ok(/is not registered on this page/.test((results[0] && results[0].error) || ""), `error explains why (got: ${results[0] && results[0].error})`);
}

console.log("\n== inputSchema string/object boundary: getTools() returning a STRINGIFIED schema is parsed, never collapsed to {} ==");
{
  // Simulates the real Chrome shape: registerTool() takes inputSchema as an
  // object (webmcp-types), but getTools() hands it back as a JSON string
  // (the W3C spec's own serialization algorithm; independently corroborated
  // against live Chrome builds — see detect-main.js's safeSchema()).
  const mc = makeFakeModelContext({ stringifyInputSchema: true });
  const win = makeFakeWindow();
  const captured = [];
  win.addEventListener("message", (e) => captured.push(e.data));
  run(mc, win);
  await flush();

  await mc.registerTool({
    name: "search_products",
    description: "Search the catalog",
    inputSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
    execute: (args) => args
  });
  await flush();

  const inventories = messagesOfKind(captured, "inventory");
  ok(inventories.length > 0, "at least one inventory report was posted");
  const latest = inventories[inventories.length - 1];
  const reported = latest && latest.tools && latest.tools.find((t) => t.name === "search_products");
  ok(!!reported, "the tool appears in the reported inventory");
  ok(
    reported && reported.inputSchema && reported.inputSchema.type === "object" && reported.inputSchema.required && reported.inputSchema.required[0] === "q",
    `a STRING inputSchema from getTools() is parsed into the real schema object, not collapsed to {} (got ${JSON.stringify(reported && reported.inputSchema)})`
  );
}

console.log("\n== inputSchema string/object boundary: malformed JSON never throws, degrades to {} ==");
{
  const mc = makeFakeModelContext({ stringifyInputSchema: true });
  // Corrupt the string AFTER registration but before getTools() is read, by
  // wrapping getTools() to return deliberately-broken JSON for this one case.
  const realGetTools = mc.getTools.bind(mc);
  mc.getTools = async () => {
    const tools = await realGetTools();
    return tools.map((t) => ({ ...t, inputSchema: "{not valid json" }));
  };
  const win = makeFakeWindow();
  const captured = [];
  win.addEventListener("message", (e) => captured.push(e.data));
  run(mc, win);
  await flush();
  await mc.registerTool({ name: "broken_schema_tool", description: "d", inputSchema: { type: "object" }, execute: (a) => a });
  await flush();

  const inventories = messagesOfKind(captured, "inventory");
  const latest = inventories[inventories.length - 1];
  const reported = latest && latest.tools && latest.tools.find((t) => t.name === "broken_schema_tool");
  ok(!!reported, "the tool still appears in the inventory despite the malformed schema");
  ok(
    reported && reported.inputSchema && typeof reported.inputSchema === "object" && Object.keys(reported.inputSchema).length === 0,
    `malformed JSON degrades to an empty object rather than throwing or leaking the raw string (got ${JSON.stringify(reported && reported.inputSchema)})`
  );
}

console.log(fail === 0 ? "\nALL WEBMCP DETECT-MAIN TESTS PASSED" : `\n${fail} FAILED`);
process.exit(fail ? 1 : 0);
