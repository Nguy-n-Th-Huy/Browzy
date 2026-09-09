// A minimal stand-in for the Chrome extension side of native messaging, used
// only to exercise the REAL host/native-host.js and REAL host/tool-runtime.js
// transport/reconnect code (connect, dispatch, disconnect-mid-flight,
// reconnect) without Chrome or a live browser attached.
//
// This is the same technique host/test/ownership.test.mjs already uses to
// test native-host.js: spawn the actual product file on a scratch pipe and
// speak Chrome's native-messaging framing (4-byte LE length + JSON) over its
// stdio, which is the entire contract the real extension has with the host.
// It is written fresh here (not imported from host/test/) to keep the spike
// self-contained, but the technique and framing are identical.
//
// IMPORTANT: this fakes only the outermost Chrome<->native-host.js edge. It
// never fabricates a DOM read, screenshot, or vision result — gates that need
// that draw a hard line to "BLOCKED: requires live browser" instead. What
// this proves is real: the actual product bridge and reconnect code paths.

import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NATIVE_HOST = path.join(HERE, "..", "..", "..", "native-host.js");

export function scratchPipe(tag) {
  return process.platform === "win32"
    ? `\\\\.\\pipe\\ocic-spike-${tag}-${process.pid}`
    : `/tmp/ocic-spike-${tag}-${process.pid}.sock`;
}

export function spawnFakeExtension(pipe) {
  const proc = spawn(process.execPath, [NATIVE_HOST], {
    env: { ...process.env, OCIC_PIPE: pipe },
    stdio: ["pipe", "pipe", "pipe"]
  });

  const handlers = [];
  const stderrLines = [];
  let buf = Buffer.alloc(0);

  proc.stdout.on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 4) {
      const len = buf.readUInt32LE(0);
      if (buf.length < 4 + len) break;
      let msg;
      try {
        msg = JSON.parse(buf.subarray(4, 4 + len).toString("utf-8"));
      } catch {
        msg = null;
      }
      buf = buf.subarray(4 + len);
      if (msg) for (const h of handlers) h(msg);
    }
  });
  proc.stderr.on("data", (c) => stderrLines.push(c.toString()));

  return {
    proc,
    stderrText: () => stderrLines.join(""),
    onMessage: (cb) => handlers.push(cb),
    send(msg) {
      const body = Buffer.from(JSON.stringify(msg), "utf-8");
      const header = Buffer.alloc(4);
      header.writeUInt32LE(body.length, 0);
      proc.stdin.write(Buffer.concat([header, body]));
    },
    // Reply to every tool_request with a canned, clearly-synthetic result
    // (never claimed as a real DOM/browser outcome) so transport plumbing —
    // id routing, sent-vs-unsent state — can be exercised end to end.
    // `shouldRespond(msg)` lets a gate simulate "request received but the
    // browser goes away before answering" by returning false for a specific
    // request without tearing down and re-spawning the whole fake extension.
    autoRespond(makeResult = (m) => ({ synthetic: true, tool: m.tool, args: m.args }), shouldRespond = () => true) {
      handlers.push((msg) => {
        if (msg.type === "tool_request" && shouldRespond(msg)) {
          this.send({ id: msg.id, result: makeResult(msg) });
        }
      });
    },
    kill: () => proc.kill(),
    // Close stdin the way Chrome does when the extension disconnects.
    disconnect: () => proc.stdin.end()
  };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
