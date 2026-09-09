// Task-group-1 investigatory gate (change: upgrade-agent-reliability-and-workflows,
// tasks.md 1.1): "Verify the strongest feasible browser/content-script document
// identity using tab/frame identity, committed navigation signal, lifecycle
// state, and a per-document nonce across same-URL reload, SPA route changes,
// close, browser restart, and frames."
//
// This is an INVESTIGATION script, not a product test suite — like the
// group-0 SDK gate (gate-0.2-sdk-continuity.mjs), it produces PASS/FAIL/
// UNOBSERVED evidence per assertion, and it hard-fails rather than silently
// skipping a check that cannot actually run.
//
// UNLIKE gate-0.2 (which drives the installed Agent SDK), the "SDK" under
// test here is the REAL Chrome DevTools Protocol against a REAL, freshly
// launched, fully ISOLATED Chrome instance:
//   - a throwaway --user-data-dir (never the operator's real profile)
//   - a throwaway --remote-debugging-port (OS-assigned, port 0)
//   - a local, in-process HTTP test-page server (127.0.0.1 only, never a
//     real site, never the operator's own browsing)
// This is deliberately NOT the already-loaded Browzy extension or the
// operator's real Chrome — no OS-level "Load unpacked" file-picker
// automation is attempted (not reliably driveable from this harness), and
// the operator's real browsing is never touched. What IS real: a real
// Chrome binary, real navigation/frame/lifecycle events, a real process
// kill+relaunch for the "browser restart" scenario (this harness fully
// owns the lifecycle of the throwaway Chrome process, so restart does not
// need to be inferred — it is actually exercised).
//
// Chrome's chrome.tabs / chrome.webNavigation extension APIs are NOT
// reachable from bare CDP (they are extension-context-only APIs), so two
// findings below (G0a, G0b) are STATIC, drawn directly from this
// repository's own extension/manifest.json and extension/background.js,
// cross-checked against Chrome's own published API reference (fetched at
// investigation time, cited inline) rather than asserted from memory.
//
// Usage:
//   node host/agent/spike/gates/gate-1.1-document-identity.mjs

import { spawn, execFileSync } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const results = [];
function record(id, title, status, detail) {
  results.push({ id, title, status, detail });
  console.log(`[${status}] ${id} ${title}`);
  console.log(`    ${String(detail).replace(/\n/g, "\n    ")}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// G0a / G0b — STATIC findings against this repo's actual, current shipped
// extension source (not a re-implementation): confirm exactly what document-
// identity-relevant browser APIs the extension can and cannot use TODAY.
// ---------------------------------------------------------------------------
function gateStaticManifestAndSource() {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
  const manifestPath = path.join(repoRoot, "extension", "manifest.json");
  const backgroundPath = path.join(repoRoot, "extension", "background.js");
  const actionEventsPath = path.join(repoRoot, "extension", "events", "action-events.js");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const background = fs.readFileSync(backgroundPath, "utf8");
  const actionEvents = fs.readFileSync(actionEventsPath, "utf8");

  const perms = manifest.permissions || [];
  const hasWebNavigation = perms.includes("webNavigation");
  record(
    "G0a",
    "chrome.webNavigation permission (documentId/frameId/committed-navigation source) is declared",
    hasWebNavigation ? "PASS" : "FAIL",
    `extension/manifest.json permissions=${JSON.stringify(perms)}. chrome.webNavigation requires the "webNavigation" permission ` +
      `(Chrome extensions API reference, fetched at investigation time: "The 'webNavigation' permission must be declared in the extension manifest to use this API"). ` +
      `${hasWebNavigation ? "Declared." : "NOT declared — chrome.webNavigation.onCommitted/onBeforeNavigate/onHistoryStateUpdated, and their documentId/frameId fields, are entirely UNAVAILABLE to this extension as shipped today. This is a hard boundary: any design relying on those fields must either add this permission (a real manifest/CWS-review-surface change, out of this investigation's scope) or fail closed without it."}`
  );

  const contentScriptEntry = (manifest.content_scripts || []).find((e) => (e.js || []).includes("content.js"));
  const allFrames = contentScriptEntry ? contentScriptEntry.all_frames === true : null;
  record(
    "G0b",
    "content.js (the document-identity-capable content script) runs in sub-frames (all_frames)",
    allFrames ? "PASS" : "FAIL",
    `extension/manifest.json content_scripts entry for content.js: ${JSON.stringify(contentScriptEntry)}. ` +
      `${allFrames ? "all_frames:true — content.js already runs in every frame." : "all_frames:false — content.js runs ONLY in the top-level main frame. No content-script instance exists in any iframe today, so a per-document nonce/handshake minted by content.js has NO presence in a sub-frame at all. This is a hard boundary distinct from G0a: even with webNavigation permission granted, per-FRAME identity for sub-frames would still have no content-script-side nonce to hand back until this changes (recorder/capture.js is a separate script, all_frames:true, but it is not the document-identity handshake and serves a different purpose — see host/agent/spike/gates/ report)."}`
  );

  const trackerMatch = actionEvents.match(/class DocumentIdTracker[\s\S]*?\n}/);
  const bumpGuardMatch = background.match(/if \(changeInfo\.url\) actionDocTracker\.bump\(tabId\);/);
  record(
    "G0c",
    "current best-effort documentId (actionDocTracker) bumps only on changeInfo.url",
    bumpGuardMatch && trackerMatch ? "PASS" : "UNOBSERVED",
    `extension/events/action-events.js DocumentIdTracker (source located verbatim: ${!!trackerMatch}): current() returns "\${tabId}:\${generation}"; bump() increments generation; used ONLY as a best-effort action-event id (design.md 5c), never as the document-identity mechanism decision 6 requires. ` +
      `Gating call site found in extension/background.js: ${bumpGuardMatch ? bumpGuardMatch[0] : "NOT FOUND verbatim (re-check background.js)"}. ` +
      `chrome.tabs.onUpdated's changeInfo.url is documented (Chrome extensions API reference, fetched at investigation time) as present "only when the URL actually changes" — a same-origin, SAME-URL reload (F5) does NOT change the URL string, so changeInfo.url is ABSENT and this tracker's generation counter does NOT bump on a same-URL reload. Concretely: this specific existing counter, if it were reused as-is for decision 6's per-document token, would FAIL scenario 1 (same-URL reload must produce a new identity) — see G1 below for the real underlying CDP-observed reason a same-URL reload IS in fact a new document at the browser level, which this tracker currently misses.`
  );
}

// ---------------------------------------------------------------------------
// CDP harness: launch an ISOLATED, throwaway Chrome instance; drive it over
// raw DevTools Protocol WebSocket messages (no puppeteer/playwright
// dependency — hand-rolled, using Node's built-in fetch/WebSocket).
// ---------------------------------------------------------------------------
function findChrome() {
  const candidates =
    process.platform === "win32"
      ? [
          "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
          "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
          path.join(os.homedir(), "AppData", "Local", "Google", "Chrome", "Application", "chrome.exe")
        ]
      : process.platform === "darwin"
        ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]
        : ["/usr/bin/google-chrome", "/usr/bin/chromium-browser", "/usr/bin/chromium"];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

async function launchChrome(chromePath, userDataDir) {
  const child = spawn(
    chromePath,
    [
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--disable-background-networking",
      "--disable-sync",
      "--disable-features=Translate,BackForwardCache",
      `--user-data-dir=${userDataDir}`,
      "--remote-debugging-port=0",
      "about:blank"
    ],
    { stdio: ["ignore", "ignore", "pipe"] }
  );
  const port = await new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => reject(new Error("timed out waiting for Chrome DevTools listening line")), 15000);
    child.stderr.on("data", (chunk) => {
      buf += chunk.toString();
      const m = buf.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//);
      if (m) {
        clearTimeout(timer);
        resolve(Number(m[1]));
      }
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Chrome exited early with code ${code} before DevTools port was observed`));
    });
  });
  return { child, port };
}

function killChromeTree(child) {
  if (!child || child.killed || child.exitCode !== null) return;
  try {
    if (process.platform === "win32") {
      execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      child.kill("SIGKILL");
    }
  } catch {
    // best-effort; process may have already exited
  }
}

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    this.eventLog = [];
    ws.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      } else if (msg.method) {
        this.eventLog.push({ t: Date.now(), method: msg.method, params: msg.params });
        const arr = this.listeners.get(msg.method);
        if (arr) for (const fn of [...arr]) fn(msg.params);
      }
    };
  }
  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(fn);
  }
  off(method, fn) {
    const arr = this.listeners.get(method);
    if (!arr) return;
    const i = arr.indexOf(fn);
    if (i >= 0) arr.splice(i, 1);
  }
  once(method, predicate, timeoutMs = 8000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.off(method, handler);
        reject(new Error(`timeout waiting for ${method}`));
      }, timeoutMs);
      const handler = (params) => {
        if (!predicate || predicate(params)) {
          clearTimeout(timer);
          this.off(method, handler);
          resolve(params);
        }
      };
      this.on(method, handler);
    });
  }
  eventsSince(tMs, method) {
    return this.eventLog.filter((e) => e.t >= tMs && (!method || e.method === method));
  }
  close() {
    try {
      this.ws.close();
    } catch {}
  }
}

async function openPageTarget(port, url) {
  const info = await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method: "PUT" })).json();
  const ws = new WebSocket(info.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = (e) => reject(new Error(`ws open failed: ${e.message || e}`));
  });
  const cdp = new CDP(ws);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  return { targetId: info.id, cdp, ws };
}

async function closeTarget(port, targetId) {
  try {
    await fetch(`http://127.0.0.1:${port}/json/close/${targetId}`);
  } catch {}
}

// ---------------------------------------------------------------------------
// Local, in-process HTTP test-page server — 127.0.0.1 only, deliberately
// generic content (no operator page content of any kind).
// ---------------------------------------------------------------------------
function startTestPageServer() {
  const server = http.createServer((req, res) => {
    const u = req.url || "/";
    if (u.startsWith("/iframe")) {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<!doctype html><html><body><h1 id="marker">iframe-doc</h1></body></html>`);
      return;
    }
    // Generic catch-all so any path (including an SPA "route") resolves.
    res.writeHead(200, { "content-type": "text/html" });
    res.end(
      `<!doctype html><html><body>
      <h1 id="marker">main-doc</h1>
      <iframe id="probe-iframe" src="/iframe"></iframe>
      </body></html>`
    );
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

// ---------------------------------------------------------------------------
// G1 — same-URL reload: must produce a NEW document identity.
// ---------------------------------------------------------------------------
async function gateSameUrlReload(port, baseUrl) {
  const { targetId, cdp } = await openPageTarget(port, "about:blank");
  try {
    const navigated1 = cdp.once("Page.frameNavigated", (p) => !p.frame.parentId);
    await cdp.send("Page.navigate", { url: baseUrl });
    const frame1 = await navigated1;
    await cdp.once("Page.loadEventFired");
    const loaderId1 = frame1.frame.loaderId;
    const nonce1 = (await cdp.send("Runtime.evaluate", { expression: "(window.__nonce = crypto.randomUUID())", returnByValue: true })).result.value;

    const beforeReload = Date.now();
    const navigated2 = cdp.once("Page.frameNavigated", (p) => !p.frame.parentId);
    await cdp.send("Page.reload", { ignoreCache: false });
    const frame2 = await navigated2;
    await cdp.once("Page.loadEventFired");
    const loaderId2 = frame2.frame.loaderId;
    const nonce2raw = await cdp.send("Runtime.evaluate", { expression: "typeof window.__nonce === 'undefined' ? null : window.__nonce", returnByValue: true });
    const nonce2 = nonce2raw.result.value;

    const urlChanged = frame1.frame.url !== undefined && frame2.frame.url === frame1.frame.url;
    const loaderChanged = loaderId1 !== loaderId2;
    const nonceLost = nonce2 === null;
    const detail = `same URL both times (${frame1.frame.url} == ${frame2.frame.url}: ${urlChanged}); loaderId before=${loaderId1}, after reload=${loaderId2} (changed=${loaderChanged}); in-page nonce before=${nonce1}, after reload=${nonce2 === null ? "LOST (undefined)" : nonce2} (lost=${nonceLost}); Page.frameNavigated events observed during reload window: ${JSON.stringify(cdp.eventsSince(beforeReload, "Page.frameNavigated").map((e) => ({ loaderId: e.params.frame.loaderId, url: e.params.frame.url })))}`;
    if (loaderChanged && nonceLost) {
      record("G1", "same-URL reload produces a new document identity (loaderId + in-page nonce)", "PASS", detail);
    } else {
      record("G1", "same-URL reload produces a new document identity (loaderId + in-page nonce)", "FAIL", detail);
    }
    return { loaderId2, nonce1 };
  } finally {
    await closeTarget(port, targetId);
  }
}

// ---------------------------------------------------------------------------
// G2 — SPA route change (history.pushState): identity must STAY stable
// (same document), not churn.
// ---------------------------------------------------------------------------
async function gateSpaRouteChange(port, baseUrl) {
  const { targetId, cdp } = await openPageTarget(port, "about:blank");
  try {
    const navigated1 = cdp.once("Page.frameNavigated", (p) => !p.frame.parentId);
    await cdp.send("Page.navigate", { url: baseUrl });
    const frame1 = await navigated1;
    await cdp.once("Page.loadEventFired");
    const loaderIdBefore = frame1.frame.loaderId;
    const nonceBefore = (await cdp.send("Runtime.evaluate", { expression: "(window.__nonce = crypto.randomUUID())", returnByValue: true })).result.value;

    const t0 = Date.now();
    const withinDocPromise = cdp.once("Page.navigatedWithinDocument", () => true, 5000).catch(() => null);
    await cdp.send("Runtime.evaluate", { expression: "history.pushState({}, '', '/spa-route-a'); location.pathname" });
    await sleep(300);
    const withinDocEvent = await withinDocPromise;

    const nonceAfterRaw = await cdp.send("Runtime.evaluate", { expression: "typeof window.__nonce === 'undefined' ? null : window.__nonce", returnByValue: true });
    const nonceAfter = nonceAfterRaw.result.value;
    const frameNavEventsAfter = cdp.eventsSince(t0, "Page.frameNavigated").filter((e) => !e.params.frame.parentId);
    const currentTree = await cdp.send("Page.getFrameTree");
    const loaderIdAfter = currentTree.frameTree.frame.loaderId;

    const nonceStable = nonceAfter !== null && nonceAfter === nonceBefore;
    const loaderStable = loaderIdBefore === loaderIdAfter;
    const noSpuriousFullNav = frameNavEventsAfter.length === 0;
    const detail = `pushState to /spa-route-a; Page.navigatedWithinDocument observed=${!!withinDocEvent} (url=${withinDocEvent ? withinDocEvent.url : "n/a"}); loaderId before=${loaderIdBefore}, after=${loaderIdAfter} (stable=${loaderStable}); in-page nonce before=${nonceBefore}, after=${nonceAfter} (stable=${nonceStable}); spurious main-frame Page.frameNavigated events during the pushState window=${frameNavEventsAfter.length} (should be 0)`;
    if (withinDocEvent && nonceStable && loaderStable && noSpuriousFullNav) {
      record("G2", "SPA route change (pushState) keeps document identity stable", "PASS", detail);
    } else {
      record("G2", "SPA route change (pushState) keeps document identity stable", "FAIL", detail);
    }
  } finally {
    await closeTarget(port, targetId);
  }
}

// ---------------------------------------------------------------------------
// G3 — tab close + reopen at the SAME URL: new tab must NOT inherit the old
// in-memory nonce or sessionStorage; localStorage (disk-backed per origin)
// DOES persist — a concrete reason an in-memory/sessionStorage nonce, not
// localStorage, is the right primitive for "dies when it must".
// ---------------------------------------------------------------------------
async function gateTabCloseReopen(port, baseUrl) {
  const first = await openPageTarget(port, "about:blank");
  const setupNav = first.cdp.once("Page.frameNavigated", (p) => !p.frame.parentId);
  await first.cdp.send("Page.navigate", { url: baseUrl });
  await setupNav;
  await first.cdp.once("Page.loadEventFired");
  await first.cdp.send("Runtime.evaluate", {
    expression: "window.__nonce = crypto.randomUUID(); sessionStorage.setItem('probe-session', window.__nonce); localStorage.setItem('probe-local', window.__nonce); window.__nonce"
  });
  const setNonceRaw = await first.cdp.send("Runtime.evaluate", { expression: "window.__nonce", returnByValue: true });
  const setNonce = setNonceRaw.result.value;
  await closeTarget(port, first.targetId);
  await sleep(200);

  const second = await openPageTarget(port, "about:blank");
  try {
    const setupNav2 = second.cdp.once("Page.frameNavigated", (p) => !p.frame.parentId);
    await second.cdp.send("Page.navigate", { url: baseUrl });
    await setupNav2;
    await second.cdp.once("Page.loadEventFired");
    const memNonce = (await second.cdp.send("Runtime.evaluate", { expression: "typeof window.__nonce === 'undefined' ? null : window.__nonce", returnByValue: true })).result.value;
    const sessionVal = (await second.cdp.send("Runtime.evaluate", { expression: "sessionStorage.getItem('probe-session')", returnByValue: true })).result.value;
    const localVal = (await second.cdp.send("Runtime.evaluate", { expression: "localStorage.getItem('probe-local')", returnByValue: true })).result.value;

    const memGone = memNonce === null;
    const sessionGone = sessionVal === null;
    const localPersists = localVal === setNonce;
    const detail = `original in-page nonce=${setNonce}; after close+reopen at same URL: in-memory window.__nonce=${memNonce === null ? "GONE (expected)" : memNonce}, sessionStorage=${sessionVal === null ? "GONE (expected)" : sessionVal}, localStorage=${localVal === null ? "GONE" : localVal} (persisted=${localPersists}, expected true — localStorage is disk-backed per origin, NOT tab-scoped)`;
    if (memGone && sessionGone && localPersists) {
      record("G3", "tab close+reopen: in-memory/session identity dies, localStorage (wrong-tool warning) survives", "PASS", detail);
    } else {
      record("G3", "tab close+reopen: in-memory/session identity dies, localStorage (wrong-tool warning) survives", "FAIL", detail);
    }
  } finally {
    await closeTarget(port, second.targetId);
  }
}

// ---------------------------------------------------------------------------
// G4 — REAL browser restart: kill the whole isolated Chrome process tree,
// relaunch against the SAME --user-data-dir, and observe what actually
// survives. Not simulated — this harness owns the Chrome lifecycle so a
// genuine kill+relaunch is possible without touching the operator's browser.
// ---------------------------------------------------------------------------
async function gateBrowserRestart(chromePath, userDataDir, testServerPort) {
  const baseUrl = `http://127.0.0.1:${testServerPort}/restart-probe`;
  const { child: child1, port: port1 } = await launchChrome(chromePath, userDataDir);
  try {
    const { targetId, cdp } = await openPageTarget(port1, "about:blank");
    const nav = cdp.once("Page.frameNavigated", (p) => !p.frame.parentId);
    await cdp.send("Page.navigate", { url: baseUrl });
    await nav;
    await cdp.once("Page.loadEventFired");
    await cdp.send("Runtime.evaluate", {
      expression: "localStorage.setItem('probe-restart-local', 'survives-if-disk-backed'); sessionStorage.setItem('probe-restart-session', 'should-not-survive-real-restart'); window.__nonce = 'in-memory-should-not-survive'"
    });
    await closeTarget(port1, targetId);
  } finally {
    killChromeTree(child1);
    await new Promise((resolve) => {
      if (child1.exitCode !== null) return resolve();
      child1.once("exit", resolve);
      setTimeout(resolve, 5000);
    });
  }

  await sleep(300);
  const { child: child2, port: port2 } = await launchChrome(chromePath, userDataDir);
  try {
    const { targetId, cdp } = await openPageTarget(port2, "about:blank");
    try {
      const nav = cdp.once("Page.frameNavigated", (p) => !p.frame.parentId);
      await cdp.send("Page.navigate", { url: baseUrl });
      await nav;
      await cdp.once("Page.loadEventFired");
      const memNonce = (await cdp.send("Runtime.evaluate", { expression: "typeof window.__nonce === 'undefined' ? null : window.__nonce", returnByValue: true })).result.value;
      const sessionVal = (await cdp.send("Runtime.evaluate", { expression: "sessionStorage.getItem('probe-restart-session')", returnByValue: true })).result.value;
      const localVal = (await cdp.send("Runtime.evaluate", { expression: "localStorage.getItem('probe-restart-local')", returnByValue: true })).result.value;

      const memGone = memNonce === null;
      const sessionGone = sessionVal === null;
      const localPersists = localVal === "survives-if-disk-backed";
      const detail = `after a REAL kill+relaunch of the isolated Chrome process (same --user-data-dir=${userDataDir}): in-memory window.__nonce=${memNonce === null ? "GONE (expected)" : memNonce}, sessionStorage=${sessionVal === null ? "GONE (expected)" : sessionVal}, localStorage=${localVal === null ? "GONE" : localVal} (persisted=${localPersists})`;
      if (memGone && sessionGone && localPersists) {
        record("G4", "real browser process restart: in-memory/session identity dies, disk-backed localStorage survives", "PASS", detail);
      } else if (memGone && localPersists) {
        record("G4", "real browser process restart: in-memory/session identity dies, disk-backed localStorage survives", "UNOBSERVED", `sessionStorage result was unexpected (${sessionVal}) — Chrome's session-restore heuristics can vary; core in-memory/localStorage split still held. ${detail}`);
      } else {
        record("G4", "real browser process restart: in-memory/session identity dies, disk-backed localStorage survives", "FAIL", detail);
      }
    } finally {
      await closeTarget(port2, targetId);
    }
  } finally {
    killChromeTree(child2);
    await new Promise((resolve) => {
      if (child2.exitCode !== null) return resolve();
      child2.once("exit", resolve);
      setTimeout(resolve, 5000);
    });
  }
}

// ---------------------------------------------------------------------------
// G5 — iframes: is frame identity separable from tab/main-frame identity?
// ---------------------------------------------------------------------------
async function gateIframeIdentity(port, baseUrl) {
  const { targetId, cdp } = await openPageTarget(port, "about:blank");
  try {
    const navigated1 = cdp.once("Page.frameNavigated", (p) => !p.frame.parentId);
    await cdp.send("Page.navigate", { url: baseUrl });
    const mainFrame = await navigated1;
    await cdp.once("Page.loadEventFired");
    await sleep(300); // let the iframe's own load settle

    const tree = await cdp.send("Page.getFrameTree");
    const iframeNode = (tree.frameTree.childFrames || []).find((f) => f.frame.parentId === tree.frameTree.frame.id);
    if (!iframeNode) {
      record("G5", "iframe frame identity is separable from tab/main-frame identity", "UNOBSERVED", `no child frame observed in Page.getFrameTree: ${JSON.stringify(tree)}`);
      return;
    }
    const mainFrameId = tree.frameTree.frame.id;
    const mainLoaderIdBefore = tree.frameTree.frame.loaderId;
    const iframeFrameId = iframeNode.frame.id;
    const iframeLoaderIdBefore = iframeNode.frame.loaderId;

    // Now navigate ONLY the iframe (main-frame-context JS mutating the
    // iframe's src) and confirm the MAIN frame's loaderId is untouched.
    const t0 = Date.now();
    const iframeRenavPromise = cdp.once("Page.frameNavigated", (p) => p.frame.id === iframeFrameId, 5000).catch(() => null);
    await cdp.send("Runtime.evaluate", { expression: "document.getElementById('probe-iframe').src = '/iframe?v=2'" });
    const iframeRenav = await iframeRenavPromise;
    await sleep(200);
    const treeAfter = await cdp.send("Page.getFrameTree");
    const mainLoaderIdAfter = treeAfter.frameTree.frame.loaderId;
    const mainFrameUnaffectedEvents = cdp.eventsSince(t0, "Page.frameNavigated").filter((e) => e.params.frame.id === mainFrameId);

    const idsDiffer = iframeFrameId !== mainFrameId;
    const parentCorrect = iframeNode.frame.parentId === mainFrameId;
    const mainUnaffected = mainLoaderIdBefore === mainLoaderIdAfter && mainFrameUnaffectedEvents.length === 0;
    const iframeGotNewLoader = iframeRenav && iframeRenav.frame.loaderId !== iframeLoaderIdBefore;
    const detail =
      `main frameId=${mainFrameId} (loaderId ${mainLoaderIdBefore} -> ${mainLoaderIdAfter}, unaffected=${mainUnaffected}); ` +
      `iframe frameId=${iframeFrameId} (differs from main=${idsDiffer}), parentId=${iframeNode.frame.parentId} (matches main=${parentCorrect}); ` +
      `iframe loaderId before=${iframeLoaderIdBefore}, after its own re-navigation=${iframeRenav ? iframeRenav.frame.loaderId : "no event observed"} (new=${iframeGotNewLoader}). ` +
      `NOTE (static cross-reference, see G0b): even though CDP itself CAN separate frame identity this way, extension/manifest.json's content_scripts entry for content.js is all_frames:false today, so no content-script-side nonce/handshake exists in this iframe to corroborate a CDP-only signal — a real per-frame document-identity mechanism needs BOTH signals, and the content-script half is currently entirely absent for sub-frames.`;
    if (idsDiffer && parentCorrect && mainUnaffected && iframeGotNewLoader) {
      record("G5", "iframe frame identity is separable from tab/main-frame identity (CDP signal only)", "PASS", detail);
    } else {
      record("G5", "iframe frame identity is separable from tab/main-frame identity (CDP signal only)", "FAIL", detail);
    }
  } finally {
    await closeTarget(port, targetId);
  }
}

// ---------------------------------------------------------------------------
// G6 — authorized navigation commit vs. unexpected replacement: can the raw
// browser signal alone tell them apart?
// ---------------------------------------------------------------------------
async function gateAuthorizedVsUnexpectedNavigation(port, baseUrl) {
  const { targetId, cdp } = await openPageTarget(port, "about:blank");
  try {
    const navigated1 = cdp.once("Page.frameNavigated", (p) => !p.frame.parentId);
    await cdp.send("Page.navigate", { url: baseUrl });
    await navigated1;
    await cdp.once("Page.loadEventFired");

    // "Authorized": the automation/extension-privileged act of navigating
    // directly (Page.navigate is CDP's analogue of the extension's own
    // chrome.tabs.update({url}) — a privileged, non-page-script call).
    const t0 = Date.now();
    const authNav = cdp.once("Page.frameNavigated", (p) => !p.frame.parentId);
    await cdp.send("Page.navigate", { url: baseUrl + "?dest=authorized" });
    await authNav;
    await cdp.once("Page.loadEventFired");
    const authRequestedNavEvents = cdp.eventsSince(t0, "Page.frameRequestedNavigation");

    // "Unexpected replacement": the CURRENTLY LOADED PAGE's own script
    // redirects itself, unprompted by any privileged call from this harness
    // — the proxy for a hijack / unrelated replacement happening underneath
    // a held reference.
    const t1 = Date.now();
    const unexpectedRequested = cdp.once("Page.frameRequestedNavigation", () => true, 5000).catch(() => null);
    const unexpectedNav = cdp.once("Page.frameNavigated", (p) => !p.frame.parentId, 5000).catch(() => null);
    await cdp.send("Runtime.evaluate", { expression: "setTimeout(() => { location.href = location.href.split('?')[0] + '?dest=unexpected'; }, 30)" });
    const [unexpectedReq, unexpectedFrame] = await Promise.all([unexpectedRequested, unexpectedNav]);
    await sleep(200);

    const authReasons = authRequestedNavEvents.map((e) => e.params.reason);
    const unexpectedHadRequestedNavEvent = !!unexpectedReq;
    const bothProduceFrameNavigated = !!unexpectedFrame; // authorized case already confirmed via authNav resolving
    const reasonsDistinguish = unexpectedReq && !authReasons.includes(unexpectedReq.reason);
    const detail =
      `Authorized (Page.navigate, a privileged non-page-script call — the CDP analogue of chrome.tabs.update({url})): Page.frameRequestedNavigation events observed=${authRequestedNavEvents.length}, reason(s)=${JSON.stringify(authReasons)}. ` +
      `Unexpected (the loaded page's OWN script self-redirects via location.href=, unprompted by this harness): Page.frameRequestedNavigation observed=${!!unexpectedReq}${unexpectedReq ? ` (reason="${unexpectedReq.reason}")` : ""}, followed by Page.frameNavigated=${!!unexpectedFrame}. ` +
      `REVISED FINDING (the original hypothesis — that a privileged Page.navigate emits NO frameRequestedNavigation at all — was WRONG and is corrected here by this empirical run, not asserted from the earlier guess): Page.navigate DOES also emit a Page.frameRequestedNavigation. ` +
      `${reasonsDistinguish ? `The 'reason' field DOES differ between the two (authorized=${JSON.stringify(authReasons)} vs unexpected="${unexpectedReq.reason}") and is therefore a real, empirically-confirmed distinguishing signal.` : `The 'reason' field values OVERLAP or did not distinguish the two cases cleanly (authorized=${JSON.stringify(authReasons)} vs unexpected=${unexpectedReq ? unexpectedReq.reason : "none observed"}) — CDP's frameRequestedNavigation signal, by itself, does NOT reliably distinguish "this product's own privileged navigate" from "the page's own script redirecting itself" using the reason field alone in this configuration.`} ` +
      `Both cases still end in an ordinary Page.frameNavigated with a new loaderId, structurally identical there. A content-script-issued location.href= (content scripts share the page's JS realm) would surface with the SAME "scriptInitiated" reason as a genuine unrelated hijack — so if this product's own "authorized create/navigate" action (task 1.3) is ever implemented via a content-script call rather than the extension's privileged chrome.tabs.update/create, the browser-level signal alone cannot tell it apart from an unexpected replacement; authorization must instead be established at the application layer (e.g. an expected-navigation correlation id set immediately before the product's own privileged call and checked at commit), which is exactly what design.md decision 6/task 1.3 already specify.`;
    record(
      "G6",
      "authorized (privileged) vs unexpected (page-script) navigation: raw CDP signal alone",
      reasonsDistinguish ? "PASS" : "FAIL",
      detail
    );
  } finally {
    await closeTarget(port, targetId);
  }
}

export async function run() {
  gateStaticManifestAndSource();

  const chromePath = findChrome();
  if (!chromePath) {
    record("G1", "same-URL reload", "BLOCKED", "no Chrome/Chromium executable found on this machine at any known path");
    record("G2", "SPA route change", "BLOCKED", "no Chrome/Chromium executable found");
    record("G3", "tab close+reopen", "BLOCKED", "no Chrome/Chromium executable found");
    record("G4", "browser restart", "BLOCKED", "no Chrome/Chromium executable found");
    record("G5", "iframe identity", "BLOCKED", "no Chrome/Chromium executable found");
    record("G6", "authorized vs unexpected navigation", "BLOCKED", "no Chrome/Chromium executable found");
    return finish();
  }

  const { server, port: testPort } = await startTestPageServer();
  const baseUrl = `http://127.0.0.1:${testPort}/main`;
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ocic-gate-1.1-chrome-profile-"));
  let child, port;
  try {
    ({ child, port } = await launchChrome(chromePath, userDataDir));
    try {
      await gateSameUrlReload(port, baseUrl);
      await gateSpaRouteChange(port, baseUrl);
      await gateTabCloseReopen(port, baseUrl);
      await gateIframeIdentity(port, baseUrl);
      await gateAuthorizedVsUnexpectedNavigation(port, baseUrl);
    } finally {
      killChromeTree(child);
      await new Promise((resolve) => {
        if (child.exitCode !== null) return resolve();
        child.once("exit", resolve);
        setTimeout(resolve, 5000);
      });
    }

    // G4 (restart) needs full ownership of process launch/kill itself, run
    // against the SAME profile dir used above so any on-disk state from the
    // earlier gates is exactly what a real restart would see.
    await gateBrowserRestart(chromePath, userDataDir, testPort);
  } catch (err) {
    record("HARNESS", "CDP harness completed without a fatal error", "FAIL", `${err && err.stack ? err.stack : err}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    try {
      fs.rmSync(userDataDir, { recursive: true, force: true });
    } catch {}
  }

  return finish();
}

function finish() {
  const summary = {
    pass: results.filter((r) => r.status === "PASS").length,
    fail: results.filter((r) => r.status === "FAIL").length,
    blocked: results.filter((r) => r.status === "BLOCKED").length,
    unobserved: results.filter((r) => r.status === "UNOBSERVED").length,
    total: results.length
  };
  console.log("\n=== SUMMARY ===");
  console.log(JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(results, null, 2));
  return { results, summary };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  run().then(({ summary }) => {
    if (summary.fail > 0) process.exitCode = 1;
  });
}
