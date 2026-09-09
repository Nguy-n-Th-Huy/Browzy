#!/usr/bin/env node
//
// Task 10.6 (design section 9d): test that a javascript_tool call against a
// borrowed tab is rejected under every combination of prior authorization,
// after 10.1-10.4 land. Specifically:
//   1. A genuinely read-only javascript_tool call (querySelectorAll) against a
//      borrowed tab is rejected exactly like a mutating one (disclosed
//      limitation).
//   2. A navigation-equivalent javascript_tool call (window.location.href=...)
//      against the same tab stays rejected under every combination of prior
//      authorization granted on that tab (auto-authorize for computer/form_input
//      does NOT extend to javascript_tool).
//   3. The window.location.href rejection from the live evidence still occurs
//      after 10.1-10.4 land, with no path that weakens it.
//
// Run: node test/borrowed-tab-javascript-tool.test.mjs

import {
  enforceBorrowedTabScope,
  BorrowedTabMutationError,
  authorizeBorrowedTabMutation,
  authorizeJavaScriptToolBorrowedTab,
  isBorrowedTabMutationAuthorized,
  isJavaScriptToolBorrowedTabAuthorized,
  recordAgentCreatedTab
} from "../host/agent/tools/mapping.js";

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

// Minimal Run mock — WeakMap keys only need stable identity.
function makeRun({ tabScope = "any" } = {}) {
  return { tabScope };
}

function instrumentedEnforce(run, tabId, args) {
  try {
    enforceBorrowedTabScope({
      run,
      legacyToolName: "javascript_tool",
      args: { ...args, tabId }
    });
    return { rejected: false };
  } catch (err) {
    return { rejected: true, error: err };
  }
}

console.log("\nTask 10.6 — javascript_tool borrowed-tab rejection (design 9d)\n");

// --- Setup: a borrowed tab in scope but not agent-created --------------------
function freshBorrowedTabRun() {
  const run = makeRun({ tabScope: [555] }); // 555 in scope, not agent-created
  return run;
}

await test("a genuinely read-only javascript_tool call (querySelectorAll 'a' slice) against a borrowed tab is rejected", async () => {
  const run = freshBorrowedTabRun();
  const result = instrumentedEnforce(run, 555, { script: "[...document.querySelectorAll('a')].slice(0, 20)" });
  assert(result.rejected, "a read-only javascript_tool call against a borrowed tab must be rejected (disclosed limitation, per design 9d)");
  assert(result.error instanceof BorrowedTabMutationError, "the rejection must be a BorrowedTabMutationError");
});

await test("a navigation-equivalent javascript_tool call (window.location.href=...) against a borrowed tab is rejected", async () => {
  const run = freshBorrowedTabRun();
  const result = instrumentedEnforce(run, 555, { script: "window.location.href='https://dauthau.asia/thongbao/moithau/'" });
  assert(result.rejected, "a navigation javascript_tool call must be rejected");
  assert(result.error instanceof BorrowedTabMutationError, "the rejection must be a BorrowedTabMutationError");
});

// --- The load-bearing test: prior auto-authorization for computer/form_input
// does NOT also permit javascript_tool (task 10.4) -------------------------
await test("authorizing a tab for typing (computer non-submit) does NOT also permit a subsequent javascript_tool call against the same tab", async () => {
  const run = freshBorrowedTabRun();
  // Simulate the auto-authorization the adapter does for computer/form_input
  // (task 9.3: authorizeBorrowedTabMutation is called).
  authorizeBorrowedTabMutation(run, 555);
  assert(isBorrowedTabMutationAuthorized(run, 555) === true, "the tab must now be authorized for computer/form_input mutations");

  // BUT a subsequent javascript_tool call must STILL be rejected:
  const readResult = instrumentedEnforce(run, 555, { script: "document.title" });
  assert(readResult.rejected, "a read-only javascript_tool after computer auto-authorization must still be rejected");
  assert(readResult.error instanceof BorrowedTabMutationError, "must be a BorrowedTabMutationError");

  const navResult = instrumentedEnforce(run, 555, { script: "window.location.href='https://dauthau.asia/'" });
  assert(navResult.rejected, "a navigation javascript_tool after computer auto-authorization must still be rejected (THE live-evidence property)");
  assert(navResult.error instanceof BorrowedTabMutationError, "must be a BorrowedTabMutationError");
});

await test("form_input auto-authorization does NOT extend to javascript_tool on the same tab", async () => {
  const run = freshBorrowedTabRun();
  authorizeBorrowedTabMutation(run, 555);
  assert(!isJavaScriptToolBorrowedTabAuthorized(run, 555), "javascript_tool authorization must remain unset after authorizeBorrowedTabMutation");
  const result = instrumentedEnforce(run, 555, { script: "document.querySelector('form')" });
  assert(result.rejected, "a javascript_tool on a tab authorized for form_input must still be rejected");
});

await test("an explicit, separate javascript_tool authorization IS respected for that tab (ahead of any real wiring future work might add)", async () => {
  // Nothing in this change grants javascript_tool authorization automatically,
  // but the separate flag is real — verify it actually works, so the design
  // note "a future change could add one deliberately" is backed by a tested
  // mechanism.
  const run = freshBorrowedTabRun();
  authorizeJavaScriptToolBorrowedTab(run, 555);
  assert(isJavaScriptToolBorrowedTabAuthorized(run, 555) === true, "the separate js_tool flag must be independently settable");
  assert(!isBorrowedTabMutationAuthorized(run, 555), "the separate js_tool flag must NOT also set the shared computer/form_input flag");

  // With js_tool authorization, the call passes silently:
  const result = instrumentedEnforce(run, 555, { script: "document.title" });
  assert(!result.rejected, "a javascript_tool on a tab explicitly authorized for js_tool must pass the gate");
});

await test("the live-evidence rejection: window.location.href after the auto-grant for typing still fails", async () => {
  // The exact regression this task must protect: the live run did:
  //   1. Read the page (get_page_text succeeded)
  //   2. Model tried a read-only script (rejected as borrowed-tab mutation)
  //   3. Model tried window.location.href (also rejected, correctly)
  // After 10.1-10.4, auto-authorization for typing/filling (if the model
  // later types into a field) must NOT weaken step 3.
  const run = freshBorrowedTabRun();
  authorizeBorrowedTabMutation(run, 555); // simulate typing happening first
  const result = instrumentedEnforce(run, 555, { script: "window.location.href='https://dauthau.asia/thongbao/moithau/'" });
  assert(result.rejected, "the live-evidence window.location.href rejection must survive 10.1-10.4 with no path that weakens it");
  assert(/borrowed page tab/.test(result.error.message), "the rejection reason must match the live-evidence BorrowedTabMutationError text");
});

const failed = results.filter((r) => !r.ok);
console.log(
  `\n${results.length - failed.length}/${results.length} passed` +
    (failed.length ? `\n\nFailures:\n${failed.map((f) => `  - ${f.name}: ${f.err}`).join("\n")}` : "") +
    "\n"
);
process.exit(failed.length ? 1 : 0);
