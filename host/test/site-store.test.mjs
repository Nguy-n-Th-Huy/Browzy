// Unit tests for host/agent/policy/site-store.js: origin scoping,
// action-class scoping, revocation, malformed-file tolerance, and the
// import-graph guard proving entries can only be created from the explicit
// user-decision channel (task 3.4).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  readSiteStore,
  matchSiteEntry,
  recordSiteEntry,
  revokeSiteEntry,
  revokeAllSiteEntries
} from "../agent/policy/site-store.js";

let fail = 0;
const ok = (c, m) => { console.log((c ? "  PASS " : "  FAIL ") + m); if (!c) fail++; };

const root = fs.mkdtempSync(path.join(os.tmpdir(), "browzy-sites-test-"));
process.env.OCIC_AGENT_HOME = root;

console.log("== record and match ==");
{
  recordSiteEntry({ origin: "https://example.com/", actionClass: "mutating", decision: "allow" }, root);
  const entries = readSiteStore(root);
  ok(entries.length === 1 && entries[0].origin === "https://example.com", "origin normalizes to its origin form");
  ok(entries[0].source === "local" && typeof entries[0].at === "string", "entry carries source and time");
  ok(matchSiteEntry(entries, "https://example.com/other", "mutating")?.decision === "allow", "same origin matches");
}

console.log("== scoping: origin and action class ==");
{
  const entries = readSiteStore(root);
  ok(matchSiteEntry(entries, "https://sub.example.com/", "mutating") === null, "no match across a different subdomain");
  ok(matchSiteEntry(entries, "https://example.com/", "send") === null, "no match across a different action class");
  ok(matchSiteEntry(entries, "http://example.com/", "mutating") === null, "no match across a different scheme");
  ok(matchSiteEntry(entries, "not a url", "mutating") === null, "an unparseable origin never matches");
}

console.log("== protected actions are never storable ==");
{
  let threw = null;
  try {
    recordSiteEntry({ origin: "https://example.com/", actionClass: "protected", decision: "allow" }, root);
  } catch (e) {
    threw = e;
  }
  ok(!!threw, "recording a protected entry throws");
}

console.log("== revocation ==");
{
  recordSiteEntry({ origin: "https://example.com/", actionClass: "send", decision: "deny" }, root);
  ok(revokeSiteEntry("https://example.com/", "send", root) === 1, "single entry revokes");
  ok(matchSiteEntry(readSiteStore(root), "https://example.com/", "send") === null, "revoked entry no longer matches");
  ok(matchSiteEntry(readSiteStore(root), "https://example.com/", "mutating")?.decision === "allow", "other classes on the origin are unaffected");
  ok(revokeAllSiteEntries(root) === 1, "revoke-all reports the count");
  ok(readSiteStore(root).length === 0, "store empty after revoke-all");
  ok(revokeSiteEntry("https://example.com/", "mutating", root) === 0, "revoking absent entries is a no-op");
}

console.log("== malformed store file ==");
{
  const file = path.join(root, "permissions", "sites.json");
  fs.writeFileSync(file, "not json{{{");
  ok(readSiteStore(root).length === 0, "a corrupt file reads back empty, never throws");
  fs.writeFileSync(file, JSON.stringify([{ origin: "https://x.test", actionClass: "protected", decision: "allow" }]));
  ok(readSiteStore(root).length === 0, "a protected entry smuggled into the file is filtered on read");
}

console.log("== import graph: entries originate only from the decision channel ==");
{
  // Static check: recordSiteEntry must be imported only by the decision
  // resolution path (can-use-tool.js) and tests — never by page-content,
  // skill, or tool modules that untrusted text could reach.
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const hits = [];
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir, { withFileTypes: true })) {
      if (name.name === "node_modules" || name.name === ".git") continue;
      const p = path.join(dir, name.name);
      if (name.isDirectory()) {
        if (!p.includes("openspec") && !p.includes("REAL") && !p.includes("benchmark")) walk(p);
      } else if (/\.(js|mjs)$/.test(name.name) && !p.endsWith("site-store.js") && !p.endsWith("site-store.test.mjs")) {
        const src = fs.readFileSync(p, "utf8");
        if (src.includes("recordSiteEntry")) hits.push(path.relative(repo, p));
      }
    }
  };
  walk(path.join(repo, "host"));
  walk(path.join(repo, "extension"));
  ok(
    hits.length === 0 || hits.every((h) => h.includes("can-use-tool.js")),
    hits.length ? `recordSiteEntry reachable only from can-use-tool.js (found: ${hits.join(", ")})` : "no production importer yet — wire it only in can-use-tool.js"
  );
}

fs.rmSync(root, { recursive: true, force: true });
console.log(fail === 0 ? "\nALL SITE STORE TESTS PASSED" : `\n${fail} FAILED`);
process.exit(fail ? 1 : 0);
