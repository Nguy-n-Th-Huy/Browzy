#!/usr/bin/env node
// The ChatGPT settings surface must keep an explicit sign-out reachable in
// every state that still has a bound account: signed in AND session-expired
// (agent-settings spec: the ChatGPT settings surface contains "A 'Sign out'
// action" — an expired session still names an account the operator may want
// to disown or replace before signing in again).
//
// Found missing for the session-expired state on 2026-09-14 by a live-panel
// pass on the maintainer's machine; pinned here at the source level because
// settings-app.js touches `document`/`chrome.*` at module scope and cannot be
// imported into a plain-Node test (the same constraint
// test/composer-textarea-scroll.test.mjs documents for sidepanel.js).
//
// Run: node test/settings-chatgpt-signout.test.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

let fail = 0;
const ok = (cond, msg) => {
  console.log((cond ? "  PASS  " : "  FAIL  ") + msg);
  if (!cond) fail++;
};

const html = read("extension/settings/settings.html");
const js = read("extension/settings/settings-app.js");

console.log("\n== HTML: both bound-account states carry a sign-out control ==");
{
  ok(
    /id="btn-chatgpt-signout"[\s\S]{0,80}?Đăng xuất<\/button>/.test(html),
    "the signed-in surface keeps its Đăng xuất control"
  );
  const idx = html.indexOf('id="chatgpt-session-expired-actions"');
  ok(idx >= 0, "the session-expired actions block exists");
  const span = idx >= 0 ? html.slice(idx, idx + 800) : "";
  ok(
    span.includes('id="btn-chatgpt-signout-expired"') && span.includes(">Đăng xuất</button>"),
    "the session-expired surface also offers Đăng xuất (the gap this test pins)"
  );
  ok(span.includes('id="btn-chatgpt-signin-again"'), "…alongside the existing Đăng nhập lại");
  ok(!/onclick=/.test(span), "no inline handler in the expired block (CSP discipline)");
}

console.log("\n== JS: one shared handler, one shared state update ==");
{
  ok(
    /const confirmThenSignOut = async \(\) => \{[\s\S]*?confirm\("Đăng xuất khỏi ChatGPT\?[\s\S]*?await controller\.signOut\(\);/.test(js),
    "a single handler confirms and signs out through the controller"
  );
  ok(
    js.includes('$("btn-chatgpt-signout").addEventListener("click", confirmThenSignOut)'),
    "the signed-in control uses the shared handler"
  );
  ok(
    js.includes('$("btn-chatgpt-signout-expired").addEventListener("click", confirmThenSignOut)'),
    "the session-expired control uses the SAME handler"
  );
  ok(
    (js.match(/addEventListener\("click", confirmThenSignOut\)/g) || []).length === 2,
    "exactly the two sign-out controls share it — no divergent path"
  );
  ok(
    /for \(const id of \["btn-chatgpt-signout", "btn-chatgpt-signout-expired"\]\) \{/.test(js),
    "renderChatgptFields updates both controls in one place"
  );
  ok(
    js.includes('state.signingOut ? "Đang đăng xuất…" : "Đăng xuất"'),
    "the busy/ready label is shared, so the two states cannot drift"
  );
}

console.log(fail === 0 ? "\nALL SETTINGS CHATGPT SIGN-OUT TESTS PASSED\n" : `\n${fail} FAILED\n`);
process.exit(fail ? 1 : 0);
