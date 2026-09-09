#!/usr/bin/env node
//
// The page the operator had open at Send is the task's WORKING page, not a
// read-only reference.
//
// Reproduced live on dauthau.asia: with the bound tab read-only, the
// assistant could read it but could not follow a link on it, so it opened
// throwaway tabs beside the very page the operator had pointed it at — the
// operator saw a group holding the untouched original, a stray about:blank,
// and a third tab where the work actually happened. mapping.js's
// authorizeBorrowedTabMutation() existed for exactly this and had no caller.
//
// The grant is deliberately narrow: only the tab carried in that message's
// own context, only for that run.
//
// Run: node host/test/agent-bound-tab-authorized.test.mjs

import { BrowserLease } from "../agent/broker/browser-lease.js";
import { ApprovalRegistry } from "../agent/policy/approvals.js";
import { Run } from "../agent/session/run.js";
import {
  authorizeBorrowedTabMutation,
  isBorrowedTabMutationAuthorized,
  isBorrowedTab,
  enforceBorrowedTabScope
} from "../agent/tools/mapping.js";

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ ok: true });
    console.log(`  PASS  ${name}`);
  } catch (err) {
    results.push({ ok: false });
    console.log(`  FAIL  ${name} — ${err.stack || err.message}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const BOUND_TAB = 1300524412; // the tab from the operator's live report
const OTHER_TAB = 1300524999;

function makeRun(tabScope) {
  return new Run({
    conversationId: "conv_bound",
    lease: new BrowserLease(),
    approvals: new ApprovalRegistry(),
    tabScope
  });
}

console.log("\nBound page tab is authorized for its own run\n");

await test("navigating the bound tab is refused when it was never authorized", async () => {
  const run = makeRun([BOUND_TAB]);
  let threw = null;
  try {
    enforceBorrowedTabScope({ run, legacyToolName: "navigate", args: { tabId: BOUND_TAB, url: "https://example.com" } });
  } catch (err) {
    threw = err;
  }
  assert(threw, "an unauthorized borrowed tab must still be refused — this is the pre-existing guard");
});

await test("authorizing the bound tab lets its own run navigate it", async () => {
  const run = makeRun([BOUND_TAB]);
  authorizeBorrowedTabMutation(run, BOUND_TAB);
  assert(isBorrowedTabMutationAuthorized(run, BOUND_TAB), "the bound tab must be marked authorized");
  enforceBorrowedTabScope({ run, legacyToolName: "navigate", args: { tabId: BOUND_TAB, url: "https://dauthau.asia/thongbao/moithau/" } });
});

await test("it is still a borrowed tab — authorizing does not make it agent-created", async () => {
  const run = makeRun([BOUND_TAB]);
  authorizeBorrowedTabMutation(run, BOUND_TAB);
  assert(isBorrowedTab(run, BOUND_TAB), "an authorized bound tab stays borrowed, so cleanup never closes or regroups it");
});

await test("the grant covers only that tab, never another of the operator's", async () => {
  const run = makeRun([BOUND_TAB, OTHER_TAB]);
  authorizeBorrowedTabMutation(run, BOUND_TAB);
  assert(!isBorrowedTabMutationAuthorized(run, OTHER_TAB), "a second borrowed tab must remain unauthorized");
  let threw = null;
  try {
    enforceBorrowedTabScope({ run, legacyToolName: "navigate", args: { tabId: OTHER_TAB, url: "https://example.com" } });
  } catch (err) {
    threw = err;
  }
  assert(threw, "the unauthorized sibling tab must still be refused");
});

await test("the grant does not leak to another run", async () => {
  const authorized = makeRun([BOUND_TAB]);
  authorizeBorrowedTabMutation(authorized, BOUND_TAB);
  const laterRun = makeRun([BOUND_TAB]);
  assert(!isBorrowedTabMutationAuthorized(laterRun, BOUND_TAB), "a different run must not inherit the grant");
});

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
