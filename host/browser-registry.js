// Attached-browser registry for list_connected_browsers / select_browser.
//
// Every browser runs its OWN native-host process (Chrome spawns one per
// extension connection), so no single process ever sees two browsers —
// except through this directory. Each host writes a heartbeat file naming
// the browser its extension reported in the hello message, and refreshes it
// on a timer; enumeration reads the live ones and prunes the stale. The
// directed handoff in native-host.js coordinates through the handoff file
// beside them.
//
// Root honors OCIC_AGENT_HOME like the skills catalog
// (host/agent/skills/paths.js), so tests isolate with a temp dir:
//   <root>/browsers/<sanitized>-<pid>.json   one heartbeat per host process
//   <root>/browsers/_handoff.json            at most one handoff at a time
//
// Pure filesystem helpers plus tiny JSON shapes — no sockets, no chrome.* —
// so host/test exercises this module directly with a temp root.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const HEARTBEAT_TTL_MS = 45_000;
export const HANDOFF_TIMEOUT_MS = 18_000;
export const HANDOFF_FRESH_MS = 30_000;

export function registryRoot() {
  if (process.env.OCIC_AGENT_HOME) return process.env.OCIC_AGENT_HOME;
  return path.join(os.homedir(), ".config", "browzy-in-chrome");
}

export function browsersDir(root = registryRoot()) {
  return path.join(root, "browsers");
}

export function handoffPath(root = registryRoot()) {
  return path.join(browsersDir(root), "_handoff.json");
}

export function sanitizeBrowserName(name) {
  const clean = String(name || "unknown").replace(/[^\w\-]+/g, "_").slice(0, 32);
  return clean || "unknown";
}

export function heartbeatPath(browser, pid, root = registryRoot()) {
  return path.join(browsersDir(root), `${sanitizeBrowserName(browser)}-${pid}.json`);
}

export function writeHeartbeat(browser, pid, ownsBridge, root = registryRoot()) {
  const dir = browsersDir(root);
  fs.mkdirSync(dir, { recursive: true });
  const file = heartbeatPath(browser, pid, root);
  fs.writeFileSync(
    file,
    JSON.stringify({ browser: String(browser), pid, ownsBridge: !!ownsBridge, at: Date.now() })
  );
  return file;
}

function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

// Live heartbeats, freshest first. Stale files are deleted as they are found
// (best-effort: a dead host's file must not haunt the enumeration).
export function readBrowsers(now = Date.now(), root = registryRoot()) {
  const dir = browsersDir(root);
  let files = [];
  try {
    files = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const live = [];
  for (const f of files) {
    if (f === "_handoff.json" || !f.endsWith(".json")) continue;
    const file = path.join(dir, f);
    const entry = readJsonFile(file);
    if (
      !entry ||
      typeof entry.browser !== "string" ||
      typeof entry.at !== "number" ||
      now - entry.at > HEARTBEAT_TTL_MS
    ) {
      try {
        fs.unlinkSync(file);
      } catch {}
      continue;
    }
    live.push({ browser: entry.browser, pid: entry.pid ?? null, driving: entry.ownsBridge === true, at: entry.at });
  }
  live.sort((a, b) => b.at - a.at);
  return live;
}

export function findBrowser(browsers, name) {
  const want = String(name || "").trim().toLowerCase();
  if (!want) return null;
  return browsers.find((b) => b.browser.toLowerCase() === want) || null;
}

export function readHandoff(now = Date.now(), root = registryRoot()) {
  const h = readJsonFile(handoffPath(root));
  if (!h || typeof h !== "object") return null;
  if (typeof h.at !== "number" || now - h.at > HANDOFF_FRESH_MS) return null;
  return h;
}

export function writeHandoff(obj, root = registryRoot()) {
  const dir = browsersDir(root);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(handoffPath(root), JSON.stringify({ ...obj, at: Date.now() }));
}

export function clearHandoff(root = registryRoot()) {
  try {
    fs.unlinkSync(handoffPath(root));
  } catch {}
}
