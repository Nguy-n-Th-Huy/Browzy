// Regression guard for the MV3 Content Security Policy the extension ships
// with (no page-level relaxation in extension/manifest.json — its default
// script-src forbids 'unsafe-inline'). Any extension page that contains an
// inline <script> (a <script> element with no `src`) or an inline
// event-handler attribute (onclick=, onload=, onchange=, ...) is silently
// broken at runtime: the browser blocks it with a CSP violation and nothing
// after it in that block ever runs. Nothing else in this suite loads these
// pages under a real CSP, so this class of bug was previously invisible —
// see openspec/changes/migrate-to-claude-agent-sdk/reports/
// 04-settings-ui-evidence.md for the settings.html/skills.html incident that
// prompted this guard (both pages used to end with an inline
// `<script type="module">` block injecting icons via iconMarkup()).
//
// Run: node test/extension-csp-no-inline-scripts.test.mjs
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = join(here, "..");
const extensionDir = join(repoRoot, "extension");

let fail = 0;
const ok = (c, m) => {
  console.log((c ? "  PASS " : "  FAIL ") + m);
  if (!c) fail++;
};

function findHtmlFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...findHtmlFiles(full));
    } else if (entry.toLowerCase().endsWith(".html")) {
      out.push(full);
    }
  }
  return out;
}

const htmlFiles = findHtmlFiles(extensionDir).sort();
ok(htmlFiles.length > 0, `found .html files under extension/ to scan (${htmlFiles.length})`);

// Matches every opening <script ...> tag so its attribute list can be
// checked for `src`. Deliberately does NOT require closing </script> pairing
// — a stray unclosed tag should still be caught, not silently skipped.
const SCRIPT_OPEN_TAG = /<script\b([^>]*)>/gi;
// Matches on<word>= preceded by a quote/whitespace so it only catches real
// HTML attributes (e.g. onclick="..."), not incidental substrings like
// "button=" or a data-* attribute name.
const EVENT_ATTR = /[\s"'](on[a-z]+)\s*=\s*["']/gi;

for (const file of htmlFiles) {
  const rel = relative(repoRoot, file).replace(/\\/g, "/");
  const html = readFileSync(file, "utf8");

  const inlineScripts = [];
  SCRIPT_OPEN_TAG.lastIndex = 0;
  let m;
  while ((m = SCRIPT_OPEN_TAG.exec(html))) {
    const attrs = m[1];
    if (!/\bsrc\s*=/i.test(attrs)) inlineScripts.push(m[0]);
  }
  ok(
    inlineScripts.length === 0,
    `${rel}: no inline <script> (element without a src attribute) — ` +
      (inlineScripts.length ? `found ${inlineScripts.length}: ${inlineScripts.join(" | ")}` : "none found")
  );

  const eventAttrs = [];
  EVENT_ATTR.lastIndex = 0;
  while ((m = EVENT_ATTR.exec(html))) {
    eventAttrs.push(m[1]);
  }
  ok(
    eventAttrs.length === 0,
    `${rel}: no inline event-handler attributes (onclick=, onload=, onchange=, ...) — ` +
      (eventAttrs.length ? `found: ${eventAttrs.join(", ")}` : "none found")
  );
}

console.log(fail === 0 ? "\nALL EXTENSION CSP GUARD TESTS PASSED" : `\n${fail} FAILED`);
process.exit(fail ? 1 : 0);
