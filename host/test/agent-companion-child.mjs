#!/usr/bin/env node
//
// Test-only harness: runs one real companion (host/agent/companion.js's
// createRealCompanion()) as its own OS process, driven purely by IPC
// messages from a parent test. Used by agent-pipe-isolation.test.mjs to
// prove two companion processes, each given a different OCIC_PIPE, never
// share a tool-runtime.js module instance or cross-talk on each other's
// bridge — the group-1 ESM module-caching finding
// (reports/01-sdk-gate-evidence.md) applied to the real companion shape.
//
// Deliberately does NOT set OCIC_COMPANION_CHILD, so importing
// host/agent/companion.js here never triggers its production
// runAsForkedChild() side effect — this harness drives createRealCompanion()
// directly instead.

import { createRealCompanion } from "../agent/companion.js";

const core = await createRealCompanion();

process.on("message", async (msg) => {
  if (msg && msg.cmd === "call") {
    try {
      const { result, resultUnknown } = await core.toolBridge.call(msg.tool, msg.args || {}, msg.meta || {});
      process.send({ id: msg.id, ok: true, result, resultUnknown });
    } catch (err) {
      process.send({ id: msg.id, ok: false, error: String(err && err.message) });
    }
  }
});

process.send({ ready: true, pipe: process.env.OCIC_PIPE });
