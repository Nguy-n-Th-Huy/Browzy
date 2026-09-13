// Unit tests for host/browser-registry.js: heartbeat publish/prune,
// enumeration order, name lookup, and the handoff file lifecycle. Runs
// against a temp OCIC_AGENT_HOME so the real user registry is untouched.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  writeHeartbeat,
  readBrowsers,
  findBrowser,
  readHandoff,
  writeHandoff,
  clearHandoff,
  sanitizeBrowserName,
  HEARTBEAT_TTL_MS
} from "../browser-registry.js";

let fail = 0;
const ok = (c, m) => { console.log((c ? "  PASS " : "  FAIL ") + m); if (!c) fail++; };

const root = fs.mkdtempSync(path.join(os.tmpdir(), "browzy-registry-test-"));
process.env.OCIC_AGENT_HOME = root;

console.log("== heartbeat publish and enumerate ==");
{
  writeHeartbeat("Brave", 111, true);
  writeHeartbeat("Edge", 222, false);
  const all = readBrowsers();
  ok(all.length === 2, `two live browsers enumerated (got ${all.length})`);
  const brave = all.find((b) => b.browser === "Brave");
  ok(brave && brave.driving === true && brave.pid === 111, "driver flag and pid survive the round trip");
  const edge = all.find((b) => b.browser === "Edge");
  ok(edge && edge.driving === false, "non-driver reads back non-driving");
}

console.log("== stale pruning and lookup ==");
{
  // A dead host's file: old timestamp, pruned on read, gone from disk.
  const dir = path.join(root, "browsers");
  const staleFile = path.join(dir, "Chrome-999.json");
  fs.writeFileSync(staleFile, JSON.stringify({ browser: "Chrome", pid: 999, ownsPipe: true, at: Date.now() - HEARTBEAT_TTL_MS - 1000 }));
  const all = readBrowsers();
  ok(!all.some((b) => b.browser === "Chrome"), "stale heartbeat pruned from the enumeration");
  ok(!fs.existsSync(staleFile), "stale heartbeat file deleted");
  ok(findBrowser(all, "brave")?.browser === "Brave", "lookup is case-insensitive");
  ok(findBrowser(all, "Opera") === null, "unknown name finds nothing");
  ok(findBrowser(all, "") === null, "empty name finds nothing");
}

console.log("== handoff lifecycle ==");
{
  ok(readHandoff() === null, "no handoff initially");
  writeHandoff({ target: "Edge", from: "Brave", status: "requested" });
  const h = readHandoff();
  ok(h && h.status === "requested" && h.target === "Edge", "request round-trips");
  writeHandoff({ target: "Edge", from: "Brave", status: "done", newDriver: "Edge" });
  ok(readHandoff().status === "done", "confirmation overwrites the request");
  clearHandoff();
  ok(readHandoff() === null, "clear removes the handoff");
  // Expired requests read back as absent so a late target stands down.
  writeHandoff({ target: "Edge", status: "requested" });
  const handoffFile = path.join(root, "browsers", "_handoff.json");
  const raw = JSON.parse(fs.readFileSync(handoffFile, "utf8"));
  raw.at = Date.now() - 120_000;
  fs.writeFileSync(handoffFile, JSON.stringify(raw));
  ok(readHandoff() === null, "an expired request reads back absent");
}

console.log("== sanitization ==");
{
  ok(sanitizeBrowserName("../../evil") === "_evil", "traversal collapses to a safe segment with no separators");
  ok(sanitizeBrowserName("") === "unknown", "empty name has a fallback");
}

fs.rmSync(root, { recursive: true, force: true });
console.log(fail === 0 ? "\nALL BROWSER REGISTRY TESTS PASSED" : `\n${fail} FAILED`);
process.exit(fail ? 1 : 0);
