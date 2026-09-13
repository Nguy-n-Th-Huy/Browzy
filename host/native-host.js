#!/usr/bin/env node

// Native Messaging Host for Browzy in Chrome extension.
// Launched by Chrome when the extension calls connectNative().
// Bridges between Chrome native messaging (stdin/stdout, 4-byte LE length prefix
// + JSON) and the Claude Code sessions attached to the bridge it owns.

import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  getPipePath,
  ensureSocketDir,
  clearStaleSocket,
  secureSocket
} from "./endpoint.js";
import { NativeLeaseGuard, busyErrorMessage } from "./agent/broker/native-lease.js";
import {
  validateHello,
  versionMismatchEnvelope,
  helloAckEnvelope,
  wrapAgentMessage,
  unwrapAgentMessage,
  makeEnvelope,
  AGENT_MESSAGE_TYPES
} from "./agent/protocol.js";
import { listWorkflows, getWorkflow } from "./agent/skills/workflows-store.js";
import { matchWorkflowToContext, hostOfUrl } from "./agent/skills/workflows-match.js";
import { validateShortcutsExecuteCompat } from "./agent/skills/workflows-mcp.js";
import {
  HEARTBEAT_TTL_MS,
  HANDOFF_TIMEOUT_MS,
  writeHeartbeat,
  heartbeatPath,
  readBrowsers,
  findBrowser,
  readHandoff,
  writeHandoff,
  clearHandoff
} from "./browser-registry.js";

// --- Native messaging protocol (Chrome <-> this process) ---

function readNativeMessage(buffer) {
  const messages = [];
  let offset = 0;
  while (offset + 4 <= buffer.length) {
    const len = buffer.readUInt32LE(offset);
    if (offset + 4 + len > buffer.length) break;
    const json = buffer.subarray(offset + 4, offset + 4 + len).toString("utf-8");
    try {
      messages.push(JSON.parse(json));
    } catch (e) {
      // skip malformed
    }
    offset += 4 + len;
  }
  return { messages, remainder: buffer.subarray(offset) };
}

function writeNativeMessage(obj) {
  const json = JSON.stringify(obj);
  const buf = Buffer.from(json, "utf-8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(buf.length, 0);
  process.stdout.write(Buffer.concat([header, buf]));
}

// --- Who owns the bridge ---
//
// Exactly one process has to own the rendezvous, because native messaging gives
// the extension exactly one host, and every Claude Code session on the machine
// has to reach that one browser through it. The only real question is WHICH
// process owns it.
//
// It used to be whichever MCP server bound :18765 first — an ordinary Claude
// Code session, picked for no reason but boot order, holding the browser link
// on behalf of every other session on the box. That made the link's lifetime an
// accident: it ended when an unrelated session exited, and a stale server left
// behind by a session that died days ago was just as eligible to win the race
// as a live one (#36, #41).
//
// This process is the principled owner. Chrome starts it when the extension
// connects and kills it when the extension goes away, so its lifetime already
// IS the browser link's lifetime — and the extension already supervises it,
// reconnecting 250ms after onDisconnect (background.js). Owning the rendezvous
// here deletes the election entirely and demotes a leaked MCP server to
// harmless: it holds nothing anyone else needs.

const PIPE_PATH = getPipePath();

let lastExtensionTraffic = Date.now();
let heartbeatsSeen = 0;

// MCP servers connect to us and are multiplexed onto the single native
// messaging channel to the extension.
const clients = new Map(); // clientId -> socket
const clientRequestMap = new Map(); // prefixed id -> { clientId, originalId }
let clientIdCounter = 0;

// The single companion-wide browser lease (design.md decision 1/5d): whoever
// tags a tool_request with a runId first gets exclusive dispatch until they
// release, their socket drops, or the lease expires. Nobody sends a runId
// today except the companion (host/agent/companion.js via host/tool-runtime.js's
// callTool meta parameter), so legacy MCP clients that never opt in are
// completely unaffected until an SDK run actually exists — see
// host/agent/broker/native-lease.js for the full rationale.
const leaseGuard = new NativeLeaseGuard();

// --- Companion (SDK session runtime) supervision ---
//
// Exactly one companion child per active bridge (design.md decision 1: "at
// most one companion for the active bridge... A child supervisor handles
// clean shutdown."). This process — the one already elected owner of the
// rendezvous — is the natural supervisor: its lifetime already IS the
// bridge's lifetime, so the companion's lifetime can simply follow it.
const COMPANION_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "agent", "companion.js");
const MAX_COMPANION_RESTARTS = 5;
let companionChild = null;
let companionRestartCount = 0;
let companionRestartTimer = null;
let companionStopped = false;

function startCompanion() {
  if (companionStopped || companionChild) return;
  try {
    companionChild = fork(COMPANION_PATH, [], {
      env: {
        ...process.env,
        OCIC_PIPE: PIPE_PATH,
        OCIC_COMPANION_CHILD: "1",
        // A companion is a direct, tightly-coupled fork of this exact
        // process, so there is no ambiguity to wait out — a short liveness
        // window (parent-watch.js's default is tuned for loosely-coupled MCP
        // clients) bounds how long a companion can linger after this process
        // is hard-killed instead of exiting cleanly through stopCompanion().
        OCIC_PARENT_CHECK_MS: process.env.OCIC_PARENT_CHECK_MS || "2000"
      },
      stdio: ["ignore", "ignore", "pipe", "ipc"]
    });
  } catch (e) {
    process.stderr.write(`companion spawn failed: ${String(e && e.message)}\n`);
    scheduleCompanionRestart();
    return;
  }
  companionChild.stderr?.on("data", (c) => process.stderr.write(`[companion] ${c}`));
  companionChild.on("message", (msg) => {
    // Companion -> extension agent envelopes (stream events, snapshots,
    // token batches, chunked binary parts, hello_ack).
    const envelope = unwrapAgentMessage(msg);
    if (envelope) writeNativeMessage(wrapAgentMessage(envelope));
  });
  companionChild.on("exit", (code, signal) => {
    process.stderr.write(`companion exited (code=${code} signal=${signal})\n`);
    companionChild = null;
    if (!companionStopped) scheduleCompanionRestart();
  });
}

function scheduleCompanionRestart() {
  if (companionRestartTimer || companionStopped) return;
  if (++companionRestartCount > MAX_COMPANION_RESTARTS) {
    process.stderr.write(`companion crash-looped ${companionRestartCount} times; giving up automatic restart.\n`);
    return;
  }
  const delayMs = 1000 * Math.min(30, companionRestartCount * 2);
  companionRestartTimer = setTimeout(() => {
    companionRestartTimer = null;
    startCompanion();
  }, delayMs);
}

function stopCompanion() {
  companionStopped = true;
  if (companionRestartTimer) {
    clearTimeout(companionRestartTimer);
    companionRestartTimer = null;
  }
  if (companionChild) {
    try {
      companionChild.kill();
    } catch {}
    companionChild = null;
  }
}

// Route one versioned agent-protocol envelope arriving from the extension
// (sidepanel, via background.js) to the companion, handling the hello/version
// handshake here so an unsupported version fails closed WITHOUT ever
// reaching (or needing to start) a companion at all.
function handleAgentMessageFromExtension(envelope) {
  if (envelope.type === AGENT_MESSAGE_TYPES.HELLO) {
    const result = validateHello(envelope);
    if (!result.ok) {
      writeNativeMessage(wrapAgentMessage(versionMismatchEnvelope(result.reason, { requested: result.requested })));
      return;
    }
    startCompanion();
    if (companionChild) {
      try {
        companionChild.send(wrapAgentMessage(envelope));
        return;
      } catch {}
    }
    // Spawn just kicked off (or failed transiently): ack minimally so the
    // panel does not wait past its own timeout; the companion resumes
    // handling once it (re)connects.
    writeNativeMessage(wrapAgentMessage(helloAckEnvelope({ companionStarting: true })));
    return;
  }
  if (!companionChild) {
    writeNativeMessage(
      wrapAgentMessage(
        makeEnvelope(AGENT_MESSAGE_TYPES.ERROR, { reason: "companion_unavailable", inReplyTo: envelope.type })
      )
    );
    return;
  }
  try {
    companionChild.send(wrapAgentMessage(envelope));
  } catch {}
}

const RETRY_MS = 1500;
const REJECTED_RETRY_MS = 15000;
// A peer that has connected but not yet said what it is. A real client sends
// `client_hello` immediately, so silence past this window is not one.
const CLASSIFY_MS = 500;

function onIncomingConnection(socket) {
  // An accepted socket is unclassified until its first line arrives, and until
  // then nothing downstream has attached an 'error' listener. In Node an
  // unhandled 'error' is a thrown exception, so a peer that vanishes in that
  // window — a client MCP process killed mid-handshake, which is routine —
  // would take the host down, and with it every session's browser link. This is
  // the same failure that cost the primary its life in c0a09a2.
  socket.on("error", () => socket.destroy());

  let buffer = Buffer.alloc(0);
  let classified = false;

  const classifyTimer = setTimeout(() => {
    if (!classified) {
      classified = true;
      socket.destroy();
    }
  }, CLASSIFY_MS);
  socket.on("close", () => clearTimeout(classifyTimer));

  socket.on("data", function onEarlyData(chunk) {
    if (classified) return;
    buffer = Buffer.concat([buffer, chunk]);
    const idx = buffer.indexOf(10);
    if (idx === -1) return;

    const firstLine = buffer.subarray(0, idx).toString("utf-8").trim();
    const rest = buffer.subarray(idx + 1);
    let msg = null;
    try {
      msg = JSON.parse(firstLine);
    } catch {}

    classified = true;
    clearTimeout(classifyTimer);
    socket.removeListener("data", onEarlyData);

    if (msg && msg.type === "client_hello") {
      attachClient(socket, rest);
      return;
    }
    socket.destroy();
  });
}

const pipeServer = net.createServer(onIncomingConnection);

// How long we keep probing quickly before settling into the slow lane. Prompt
// probing also keeps directed handoffs (select_browser) snappy for a browser
// started moments ago; backing off to 15s immediately would make any
// ownership change land mostly by luck.
const FAST_CLAIM_WINDOW_MS = 40_000;
const claimingSince = Date.now();
async function claimPipe() {
  // A directed handoff manages the pipe explicitly; background retries must
  // not rebind mid-handoff (the select flow restores the posture after).
  if (handoffActive) return;
  ensureSocketDir();
  await clearStaleSocket(PIPE_PATH);
  const onErr = (err) => {
    if (err.code === "EADDRINUSE") {
      // Another browser's host holds the bridge for this user. Probe often at
      // first so a hand-off is picked up promptly, then drop to the slow lane
      // so two idle browsers are not polling each other forever.
      setOwnsBridge(false);
      const fast = Date.now() - claimingSince < FAST_CLAIM_WINDOW_MS;
      setTimeout(claimPipe, fast ? RETRY_MS : REJECTED_RETRY_MS);
      return;
    }
    if (err.code === "ERR_SERVER_ALREADY_LISTEN") return; // this host holds it
    process.stderr.write(`Bridge listen failed: ${err.message}\n`);
    setTimeout(claimPipe, RETRY_MS);
  };
  pipeServer.once("error", onErr);
  pipeServer.listen(PIPE_PATH, () => {
    pipeServer.removeListener("error", onErr);
    process.stderr.write(`Native host owns the bridge at ${PIPE_PATH}\n`);
    setOwnsBridge(true);
    // Initialize the companion and its local catalogs now, on ordinary
    // browser startup — not deferred to the first agent hello — per
    // design.md decision 2: "extension startup calls native messaging, which
    // starts the host and supervised companion automatically... Initialize
    // connection and local catalogs without sending a paid model prompt."
    startCompanion();
  });
}

function attachClient(socket, initialBuffer) {
  const clientId = String(++clientIdCounter);
  clients.set(clientId, socket);
  process.stderr.write(`MCP client ${clientId} attached (${clients.size} total)\n`);
  socket.write(JSON.stringify({ type: "client_ack", clientId }) + "\n");

  let buffer = initialBuffer;

  function pump() {
    let idx;
    while ((idx = buffer.indexOf(10)) !== -1) {
      const line = buffer.subarray(0, idx).toString("utf-8").trim();
      buffer = buffer.subarray(idx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.type === "lease_release" && msg.runId) {
          leaseGuard.release(msg.runId);
          continue;
        }
        if (msg.type === "tool_request" && msg.id) {
          // Arbitrate the single companion-wide browser lease before this
          // request ever reaches the extension (design.md decision 5d).
          // Requests that never opt into the lease protocol (no runId) are
          // unaffected as long as nobody else holds the lease — see
          // host/agent/broker/native-lease.js.
          const decision = leaseGuard.check({ clientId, runId: msg.runId, conversationId: msg.conversationId });
          if (!decision.allow) {
            socket.write(
              JSON.stringify({
                id: msg.id,
                type: "tool_error",
                error: busyErrorMessage(decision.heldBy),
                busy: true
              }) + "\n"
            );
            continue;
          }
          // Namespace the id so concurrent sessions cannot collide, and so a
          // response can be routed back to the one client that asked.
          const prefixedId = `h${clientId}_${msg.id}`;
          clientRequestMap.set(prefixedId, { clientId, originalId: msg.id });
          writeNativeMessage({ ...msg, id: prefixedId });
        }
      } catch {
        // skip malformed
      }
    }
  }

  pump();
  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    pump();
  });
  socket.on("close", () => {
    clients.delete(clientId);
    for (const [prefixedId, info] of clientRequestMap) {
      if (info.clientId === clientId) clientRequestMap.delete(prefixedId);
    }
    // Connection loss releases whatever lease this client held (design.md:
    // "Connection loss releases its lease while preserving unknown outcomes
    // of already dispatched actions.") — the already-dispatched-action
    // wording is host/tool-runtime.js's HOST_DROPPED_ERROR concern, not this
    // process's; this is only the ownership half.
    leaseGuard.releaseForClient(clientId);
    process.stderr.write(`MCP client ${clientId} detached (${clients.size} left)\n`);
  });
}

// Route one extension-originated message to whoever is waiting for it.
function routeFromExtension(msg) {
  // Liveness ping from the service worker. Nothing downstream needs it, but
  // its rhythm is what the deaf-extension watchdog below keys off.
  if (msg.type === "heartbeat") {
    heartbeatsSeen++;
    return;
  }
  if (msg.type === "recording_complete") {
    // Unsolicited: any attached session may be the one holding the Claude
    // channel, so every client gets a copy.
    const line = JSON.stringify(msg) + "\n";
    for (const socket of clients.values()) {
      try {
        if (!socket.destroyed) socket.write(line);
      } catch {}
    }
    // Also push it into the supervised companion (task 6.3: route recorder
    // completion to companion sessions). The recording is already durably on
    // disk by this point (handleSaveRecording ran before the extension ever
    // sent this event) and every legacy MCP client above already got its
    // copy independently of this — this is purely the SDK-path leg, and its
    // absence (companion not started, or crash-looped past its restart
    // budget) never blocks or fails the save/legacy-notify paths above.
    // Start-on-demand mirrors handleAgentMessageFromExtension's own
    // startCompanion() call for the same reason: ordinary browser startup
    // already starts it (claimPipe()), so this only matters for the brief
    // window before that finishes.
    startCompanion();
    if (companionChild) {
      try {
        companionChild.send(
          wrapAgentMessage(
            makeEnvelope(AGENT_MESSAGE_TYPES.RECORDING_COMPLETE, {
              recording_id: String(msg.recording_id ?? ""),
              path: String(msg.path ?? ""),
              schema: String(msg.schema ?? "v0"),
              summary: typeof msg.summary === "string" ? msg.summary : "",
              transcript_status: String(msg.transcript_status ?? "ok")
            })
          )
        );
      } catch {}
    }
    return;
  }
  if (msg.id && clientRequestMap.has(msg.id)) {
    const { clientId, originalId } = clientRequestMap.get(msg.id);
    clientRequestMap.delete(msg.id);
    const socket = clients.get(clientId);
    try {
      if (socket && !socket.destroyed) {
        socket.write(JSON.stringify({ ...msg, id: originalId }) + "\n");
      }
    } catch {}
  }
  // Anything else: the client that asked is gone, or we never issued this id.
}

// --- Recording bundle write ---
// The recorder saves the trace to disk here, in the native host, instead of
// via chrome.downloads — the browser download path shows an OS save dialog on
// some setups, and this also lets us write to a stable location the coding
// agent can open. Returns the absolute directory so the extension can notify
// Claude Code with a real path.
// Audits live beside recordings but in their own tree: they answer "what did
// this agent session do", not "how is a task performed", and they are written
// on a checkpoint rather than at the end, so a session can be reviewed while
// its tabs are still open.
function handleSaveAudit(msg) {
  try {
    const dir = path.join(
      os.homedir(),
      ".config",
      "browzy-in-chrome",
      "audits",
      String(msg.session_id || "unknown")
    );
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "audit.json"), JSON.stringify(msg.payload ?? {}, null, 2));
  } catch (e) {
    process.stderr.write(`save_audit failed: ${String(e && e.message)}\n`);
  }
}

function handleSaveRecording(msg) {
  try {
    const dir = path.join(
      os.homedir(),
      ".config",
      "browzy-in-chrome",
      "recordings",
      String(msg.recording_id || "unknown")
    );
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "trace.json"),
      JSON.stringify(msg.trace ?? {}, null, 2)
    );
    // Ship the schema descriptor alongside so the agent knows how to read it.
    if (typeof msg.schema_md === "string" && msg.schema_md) {
      fs.writeFileSync(path.join(dir, `SCHEMA_${msg.schema || "v0"}.md`), msg.schema_md);
    }
    writeNativeMessage({
      type: "recording_saved",
      recording_id: msg.recording_id,
      path: dir,
      ok: true
    });
  } catch (e) {
    writeNativeMessage({
      type: "recording_saved",
      recording_id: msg.recording_id,
      ok: false,
      error: String(e && e.message)
    });
  }
}

// Write one slice of a recording's audio into audio/NNN.webm. Arrives in
// ~768KB slices (base64 over native messaging) with append=false on the first
// slice of each segment. This is the artifact that makes a failed transcript
// recoverable, so it is written before transcription is even attempted.
function handleSaveAudio(msg) {
  try {
    const rel = String(msg.name || "").replace(/\\/g, "/");
    // Contain the write to the bundle: no absolute paths, no traversal.
    if (rel.startsWith("/") || rel.split("/").includes("..")) return;
    const base = path.join(
      os.homedir(),
      ".config",
      "browzy-in-chrome",
      "recordings",
      String(msg.recording_id || "unknown")
    );
    const file = path.join(base, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const buf = Buffer.from(String(msg.b64 || ""), "base64");
    if (msg.append) fs.appendFileSync(file, buf);
    else fs.writeFileSync(file, buf);
  } catch {
    // best-effort: the trace is already on disk
  }
}

// Write one 240p frame into the recording's images/ dir. Fire-and-forget:
// the reference is already in the trace, so a dropped frame just means the
// agent finds no file at that ref.
function handleSaveScreenshot(msg) {
  try {
    const dir = path.join(
      os.homedir(),
      ".config",
      "browzy-in-chrome",
      "recordings",
      String(msg.recording_id || "unknown"),
      "images"
    );
    fs.mkdirSync(dir, { recursive: true });
    const b64 = String(msg.dataUrl || "").replace(/^data:image\/\w+;base64,/, "");
    if (b64) fs.writeFileSync(path.join(dir, String(msg.name)), Buffer.from(b64, "base64"));
  } catch {
    // best-effort
  }
}

// Write a full screenshot to a stable, user-visible location
// (~/.config/browzy-in-chrome/screenshots/<timestamp>.jpg) so Claude Code
// can open the absolute path. Unlike save_screenshot (fire-and-forget), this
// replies with the written path so the caller can report it to the agent.
function handleSaveScreenshotToDisk(msg) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = path.join(
    os.homedir(),
    ".config",
    "browzy-in-chrome",
    "screenshots"
  );
  try {
    fs.mkdirSync(dir, { recursive: true });
    const b64 = String(msg.dataUrl || "").replace(/^data:image\/\w+;base64,/, "");
    if (!b64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) throw new Error("empty or malformed image data");
    const file = path.join(dir, `${timestamp}.jpg`);
    fs.writeFileSync(file, Buffer.from(b64, "base64"));
    writeNativeMessage({ type: "screenshot_saved", id: msg.id, path: file, ok: true });
  } catch (e) {
    writeNativeMessage({ type: "screenshot_saved", id: msg.id, ok: false, error: String(e && e.message) });
  }
}

// Stage an in-memory screenshot as a real temp file so the extension can
// attach it to a file input via CDP DOM.setFileInputFiles. The extension holds
// screenshots as base64 in a Map (never on disk), but setFileInputFiles needs
// a path, so we materialize the bytes here and return the absolute path.
// Reply is keyed by msg.id so the extension can correlate it to its request.
function handleWriteTempFile(msg) {
  const reply = (payload) => writeNativeMessage({ id: msg.id, type: "temp_file_written", ...payload });
  try {
    const dir = path.join(os.homedir(), ".config", "browzy-in-chrome", "tmp");
    fs.mkdirSync(dir, { recursive: true });
    // Sanitize the requested name: no path separators, no traversal.
    const name = String(msg.filename || "upload.png").replace(/[^\w.\-]/g, "_");
    const file = path.join(dir, `${Date.now()}_${name}`);
    const b64 = String(msg.dataUrl || "").replace(/^data:[^;]+;base64,/, "");
    if (!b64) return reply({ ok: false, error: "no data" });
    fs.writeFileSync(file, Buffer.from(b64, "base64"));
    // Best-effort GC: staged uploads have a "<epoch>_<name>" prefix; prune only
    // files WE staged (that prefix) and only those older than a day, so we never
    // delete anything another process put in the shared tmp dir. Cap the scan
    // so a giant directory can't stall this request.
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    try {
      let scanned = 0;
      for (const f of fs.readdirSync(dir)) {
        if (!/^\d+_/.test(f)) continue; // not ours
        if (++scanned > 200) break; // bound the sync scan
        const p = path.join(dir, f);
        if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p);
      }
    } catch { /* best-effort */ }
    reply({ ok: true, result: file });
  } catch (e) {
    reply({ ok: false, error: String(e && e.message) });
  }
}
// --- Shortcuts (extension-side handlers' companion contract) ---
// The registry's shortcuts_list/shortcuts_execute operations run their
// handlers in the extension, but the shortcut inventory lives here, beside
// the workflow registry that owns it. These two requests resolve and
// describe; execution of tool-kind steps happens in the extension against
// the run's own tab scope (see background.js). Replies use result envelopes
// ({ ok }) rather than transport errors, so the extension can distinguish
// "unknown shortcut" from "the companion is unreachable".
function shortcutPublicForm(w) {
  return {
    shortcutId: w.id,
    command: w.id,
    name: w.name || w.id,
    description: w.description || "",
    version: w.version,
    isWorkflow: true
  };
}

function handleShortcutsList(msg) {
  const reply = (payload) => writeNativeMessage({ id: msg.id, type: "shortcuts_listed", ...payload });
  try {
    const host = typeof msg.url === "string" && msg.url ? hostOfUrl(msg.url) : null;
    const found = [];
    for (const w of listWorkflows({ enabledOnly: true })) {
      const m = matchWorkflowToContext(w, host ? { host } : {});
      if (m.match) found.push(shortcutPublicForm(w));
    }
    reply({ ok: true, result: { shortcuts: found } });
  } catch (e) {
    reply({ ok: false, error: String(e && e.message) });
  }
}

function handleShortcutsExecute(msg) {
  const reply = (payload) => writeNativeMessage({ id: msg.id, type: "shortcut_executed", ...payload });
  const decision = validateShortcutsExecuteCompat({ tabId: msg.tabId, shortcutId: msg.shortcutId, command: msg.command });
  if (!decision.ok) {
    reply({ ok: true, result: { ok: false, code: decision.code, message: decision.message } });
    return;
  }
  try {
    const host = typeof msg.url === "string" && msg.url ? hostOfUrl(msg.url) : null;
    const candidates = listWorkflows({ enabledOnly: true });
    let workflow =
      (decision.shortcutId && candidates.find((w) => w.id === decision.shortcutId)) ||
      (decision.command && candidates.find((w) => w.id === decision.command)) ||
      null;
    if (!workflow && decision.shortcutId) {
      // Fall back to any version, enabled or not, so a disabled workflow
      // reports "disabled" rather than "not found".
      workflow = getWorkflow(decision.shortcutId) || (decision.command ? getWorkflow(decision.command) : null);
    }
    if (!workflow) {
      reply({
        ok: true,
        result: { ok: false, code: "SHORTCUT_NOT_FOUND", message: `Unknown shortcut "${decision.target}". List available shortcuts with shortcuts_list.` }
      });
      return;
    }
    if (workflow.enabled === false) {
      reply({
        ok: true,
        result: { ok: false, code: "SHORTCUT_DISABLED", message: `Shortcut "${workflow.id}" is disabled.` }
      });
      return;
    }
    const m = matchWorkflowToContext(workflow, host ? { host } : {});
    if (!m.match) {
      reply({
        ok: true,
        result: { ok: false, code: "SHORTCUT_CONTEXT_MISMATCH", message: `Shortcut "${workflow.id}" does not apply here (${m.reason}).` }
      });
      return;
    }
    reply({
      ok: true,
      result: {
        ok: true,
        definition: {
          id: workflow.id,
          version: workflow.version,
          name: workflow.name || workflow.id,
          description: workflow.description || "",
          steps: Array.isArray(workflow.steps) ? workflow.steps : []
        }
      }
    });
  } catch (e) {
    reply({ ok: false, error: String(e && e.message) });
  }
}

// Save an encoded GIF to the same stable, user-visible tree screenshots use
// (~/.config/browzy-in-chrome/screenshots/<name>.gif) so the agent can open
// the absolute path. Reply is keyed by msg.id for nativeRequest().
function handleSaveGifToDisk(msg) {
  const reply = (payload) => writeNativeMessage({ id: msg.id, type: "gif_saved", ...payload });
  try {
    const dir = path.join(os.homedir(), ".config", "browzy-in-chrome", "screenshots");
    fs.mkdirSync(dir, { recursive: true });
    const name = String(msg.filename || `recording-${Date.now()}.gif`).replace(/[^\w.\-]/g, "_");
    const finalName = name.toLowerCase().endsWith(".gif") ? name : `${name}.gif`;
    const b64 = String(msg.dataUrl || "").replace(/^data:image\/\w+;base64,/, "");
    if (!b64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) throw new Error("empty or malformed image data");
    const file = path.join(dir, finalName);
    fs.writeFileSync(file, Buffer.from(b64, "base64"));
    reply({ ok: true, result: file });
  } catch (e) {
    reply({ ok: false, error: String(e && e.message) });
  }
}

// --- Main: bridge stdin (from extension) <-> the attached MCP clients ---

let stdinBuffer = Buffer.alloc(0);
// --- Attached-browser registry (list_connected_browsers / select_browser) ---
// Each browser runs its own host process, so this process knows exactly one
// browser: the one whose extension said hello. It publishes a heartbeat file
// (see host/browser-registry.js); enumeration reads every live heartbeat.
// A directed handoff moves pipe ownership — the thing MCP traffic follows —
// from this host to the target's: this side yields and waits for the
// target's confirmation file, the target's accept loop (below) claims and
// confirms. No fixed waiting period stands in for the outcome anywhere.
let myBrowser = null;
let ownsBridge = false;
let handoffActive = false;

function refreshOwnHeartbeat() {
  if (!myBrowser) return;
  try {
    writeHeartbeat(myBrowser, process.pid, ownsBridge);
  } catch {}
}

function setOwnsBridge(v) {
  ownsBridge = !!v;
  refreshOwnHeartbeat();
}

function setBrowserIdentity(name) {
  myBrowser = String(name).trim().slice(0, 64) || null;
  refreshOwnHeartbeat();
}

// Standing claim posture after a handoff ends: if this process holds the
// pipe, nothing needs doing; otherwise re-enter the ordinary claim loop so
// background probing resumes (a future handoff back depends on it).
function restoreClaimPosture() {
  try {
    if (!pipeServer.listening) claimPipe();
  } catch {}
}

// One-shot bridge claim for the handoff paths. Unlike claimPipe() it reports
// instead of rescheduling, and it never consults handoffActive — both the
// yielding side (reclaim) and the accepting side call it while active.
function tryClaimBridge() {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    try {
      ensureSocketDir();
    } catch {
      done(false);
      return;
    }
    clearStaleSocket(PIPE_PATH).then(() => {
      const onErr = () => {
        pipeServer.removeListener("error", onErr);
        pipeServer.removeListener("listening", onListen);
        setOwnsBridge(false);
        done(false);
      };
      const onListen = () => {
        pipeServer.removeListener("error", onErr);
        pipeServer.removeListener("listening", onListen);
        setOwnsBridge(true);
        try {
          startCompanion();
        } catch {}
        done(true);
      };
      pipeServer.once("error", onErr);
      pipeServer.once("listening", onListen);
      try {
        pipeServer.listen(PIPE_PATH);
      } catch {
        pipeServer.removeListener("error", onErr);
        pipeServer.removeListener("listening", onListen);
        done(false);
      }
    }).catch(() => done(false));
  });
}

function closePipeServer() {
  return new Promise((resolve) => {
    try {
      if (!pipeServer.listening) {
        resolve();
        return;
      }
      const timer = setTimeout(resolve, 2000);
      pipeServer.close(() => {
        clearTimeout(timer);
        resolve();
      });
    } catch {
      resolve();
    }
  });
}

function destroyClientSockets() {
  for (const socket of clients.values()) {
    try {
      socket.destroy();
    } catch {}
  }
}

function waitForHandoffDone(pollMs, timeoutMs) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const poll = () => {
      let h = null;
      try {
        h = readHandoff();
      } catch {}
      if (h && (h.status === "done" || h.status === "failed")) {
        resolve(h);
        return;
      }
      if (Date.now() >= deadline) {
        resolve(null);
        return;
      }
      setTimeout(poll, pollMs);
    };
    poll();
  });
}

function handleListBrowsers(msg) {
  const reply = (payload) => writeNativeMessage({ id: msg.id, type: "browsers_listed", ...payload });
  try {
    reply({ ok: true, result: { browsers: readBrowsers() } });
  } catch (e) {
    reply({ ok: false, error: String(e && e.message) });
  }
}

async function handleSelectBrowser(msg) {
  const reply = (payload) => writeNativeMessage({ id: msg.id, type: "browser_selected", ...payload });
  const fail = (error) => reply({ ok: true, result: { ok: false, error, stillDriving: myBrowser } });
  const target = String((msg && msg.browser) || "").trim();
  if (!target) {
    fail("select_browser requires 'browser' (a name from list_connected_browsers).");
    return;
  }
  let browsers = [];
  try {
    browsers = readBrowsers();
  } catch (e) {
    fail(`could not read attached browsers: ${String(e && e.message)}`);
    return;
  }
  const hit = findBrowser(browsers, target);
  if (!hit) {
    const names = browsers.map((b) => b.browser).join(", ") || "none";
    fail(`Unknown browser "${target}". Attached: ${names}.`);
    return;
  }
  if (myBrowser && hit.browser.toLowerCase() === myBrowser.toLowerCase()) {
    reply({ ok: true, result: { ok: true, noTransfer: true, driver: myBrowser } });
    return;
  }
  // Directed handoff: publish the request, yield the pipe, and wait for the
  // target's confirmation — reporting only what actually happened.
  handoffActive = true;
  try {
    writeHandoff({ target: hit.browser, from: myBrowser, status: "requested" });
    setOwnsBridge(false);
    await closePipeServer();
    destroyClientSockets();
    const done = await waitForHandoffDone(500, HANDOFF_TIMEOUT_MS);
    if (done && done.status === "done") {
      clearHandoff();
      reply({ ok: true, result: { ok: true, newDriver: done.newDriver || hit.browser } });
      return;
    }
    const problem = (done && done.error) || "the selected browser did not take over in time";
    try {
      writeHandoff({ target: hit.browser, from: myBrowser, status: "expired" });
    } catch {}
    await tryClaimBridge();
    fail(`${problem}. ${myBrowser || "This browser"} is still driving automation.`);
  } finally {
    handoffActive = false;
    restoreClaimPosture();
  }
}

// Accept loop: pick up handoff requests addressed to this browser and claim
// the bridge for them, confirming through the handoff file. Stands down the
// moment the request leaves the requested state (the requester moved on).
setInterval(async () => {
  if (!myBrowser || handoffActive) return;
  let h = null;
  try {
    h = readHandoff();
  } catch {
    return;
  }
  if (!h || h.status !== "requested" || !h.target) return;
  if (String(h.target).toLowerCase() !== myBrowser.toLowerCase()) return;
  handoffActive = true;
  try {
    const deadline = Date.now() + 12_000;
    let acquired = false;
    while (Date.now() < deadline) {
      let current = null;
      try {
        current = readHandoff();
      } catch {}
      if (!current || current.status !== "requested") break;
      if (await tryClaimBridge()) {
        acquired = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
    if (acquired) {
      writeHandoff({ target: h.target, from: h.from || null, status: "done", newDriver: myBrowser });
    } else if (current && current.status === "requested") {
      try {
        writeHandoff({ target: h.target, from: h.from || null, status: "failed", error: "the selected browser did not take over in time" });
      } catch {}
    }
  } finally {
    handoffActive = false;
    restoreClaimPosture();
  }
}, 1500).unref();

process.stdin.on("data", (chunk) => {
  lastExtensionTraffic = Date.now();
  stdinBuffer = Buffer.concat([stdinBuffer, chunk]);
  const { messages, remainder } = readNativeMessage(stdinBuffer);
  stdinBuffer = remainder;

  for (const msg of messages) {
    // Handle recording saves locally (write to disk + reply); don't forward.
    if (msg && msg.type === "save_recording") {
      handleSaveRecording(msg);
      continue;
    }
    if (msg && msg.type === "save_audit") {
      handleSaveAudit(msg);
      continue;
    }
    if (msg && msg.type === "save_screenshot") {
      handleSaveScreenshot(msg);
      continue;
    }
    if (msg && msg.type === "save_screenshot_to_disk") {
      handleSaveScreenshotToDisk(msg);
      continue;
    }
    if (msg && msg.type === "save_audio") {
      handleSaveAudio(msg);
      continue;
    }
    if (msg && msg.type === "write_temp_file") {
      handleWriteTempFile(msg);
      continue;
    }
    if (msg && msg.type === "shortcuts_list") {
      handleShortcutsList(msg);
      continue;
    }
    if (msg && msg.type === "shortcuts_execute") {
      handleShortcutsExecute(msg);
      continue;
    }
    if (msg && msg.type === "hello" && typeof msg.browser === "string" && msg.browser) {
      setBrowserIdentity(msg.browser);
      continue;
    }
    if (msg && msg.type === "list_browsers") {
      handleListBrowsers(msg);
      continue;
    }
    if (msg && msg.type === "select_browser") {
      handleSelectBrowser(msg);
      continue;
    }
    if (msg && msg.type === "save_gif_to_disk") {
      handleSaveGifToDisk(msg);
      continue;
    }
    if (msg && msg.type === "agent_msg") {
      const envelope = unwrapAgentMessage(msg);
      if (envelope) handleAgentMessageFromExtension(envelope);
      continue;
    }
    // Everything else is a reply for a waiting MCP client; route it by id.
    routeFromExtension(msg);
  }
});

process.stdin.on("end", () => {
  recordExit(`extension disconnected (clients: ${clients.size})`);
  // This browser is gone: drop its heartbeat so the next enumeration does
  // not list it (stale files are pruned on read anyway — this just avoids
  // the ghost window).
  try {
    if (myBrowser) fs.unlinkSync(heartbeatPath(myBrowser, process.pid));
  } catch {}
  // Extension disconnected. Drop the bridge immediately rather than lingering:
  // with no extension there is no browser link to own, and holding the pipe
  // would stop the host Chrome spawns next from claiming it.
  for (const socket of clients.values()) {
    try {
      socket.destroy();
    } catch {}
  }
  try {
    pipeServer.close();
  } catch {}
  stopCompanion();
  process.exit(0);
});

// --- Deaf-extension watchdog ---
//
// The worst failure this bridge has is not dying, it is going deaf: still
// holding the rendezvous, still accepting connections, never answering. Nothing
// recovers from that on its own, because every mechanism we have keys off the
// owner being GONE. Dying is the recoverable state — Chrome notices, respawns
// us, and clients reconnect — so if we cannot reach the extension any more, the
// useful thing to do is stop existing.
//
// The signal is already there: background.js posts a heartbeat every ~15s. Long
// silence means the service worker is wedged or gone.
//
// Armed only after we have actually seen heartbeats. An extension too old to
// send them would otherwise look permanently deaf, and we would exit-loop —
// which is why this is safe to ship ahead of any extension change.
const SILENCE_LIMIT_MS = Number(process.env.OCIC_SILENCE_LIMIT_MS) || 60_000;

// Chrome owns this process's stderr and throws it away, so when the host exits
// there is no way to find out why — which made a host that was cycling every 12
// minutes impossible to explain from the outside. Leave a breadcrumb on disk
// instead. One line, truncated, never grows without bound.
function recordExit(reason) {
  try {
    const file = path.join(os.homedir(), ".config", "browzy-in-chrome", "host-exits.log");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const line = `${new Date().toISOString()} pid=${process.pid} ${reason}\n`;
    let prev = "";
    try {
      prev = fs.readFileSync(file, "utf-8");
    } catch {}
    // Keep the last ~200 lines; a cycling host would otherwise write forever.
    const kept = (prev + line).split("\n").slice(-200).join("\n");
    fs.writeFileSync(file, kept);
  } catch {}
}

setInterval(() => {
  refreshOwnHeartbeat();
  if (heartbeatsSeen < 2) return; // never saw a heartbeat: not our signal to use
  const silentFor = Date.now() - lastExtensionTraffic;
  if (silentFor < SILENCE_LIMIT_MS) return;
  const reason =
    `watchdog: no word from the extension for ${Math.round(silentFor / 1000)}s ` +
    `(heartbeats seen: ${heartbeatsSeen}, clients: ${clients.size})`;
  process.stderr.write(`${reason} — exiting so a fresh host can take the bridge.\n`);
  recordExit(reason);
  stopCompanion();
  process.exit(0);
}, 15_000).unref();

// A direct signal (rather than stdin EOF) is a less common but real way this
// process ends — e.g. an explicit stop during development/ops. Give the
// companion the same clean-shutdown chance stdin-EOF already gets, instead
// of leaving it to its own 2s parent-liveness fallback.
function handleTermSignal(sig) {
  recordExit(`received ${sig}`);
  stopCompanion();
  try {
    pipeServer.close();
  } catch {}
  process.exit(0);
}
process.on("SIGTERM", () => handleTermSignal("SIGTERM"));
process.on("SIGINT", () => handleTermSignal("SIGINT"));

claimPipe();
