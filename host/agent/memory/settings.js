// The task-memory switch ("Ghi nhớ cách làm việc" —
// openspec/changes/add-task-memory, agent-settings delta "Task memory
// toggle"). One non-secret boolean, default ON, persisted beside the
// memories it governs at `<agent root>/memory/settings.json`.
//
// Read fresh at every run start — never cached — so a change takes effect on
// the next run and never alters one already in flight (spec scenario "Turned
// off mid-conversation"). Turning it off stops derivation and recall; it does
// not delete anything (forgetting is its own explicit operation).

import fs from "node:fs";
import path from "node:path";

import { ensureDir, memoryRoot } from "../storage/paths.js";

export const DEFAULT_TASK_MEMORY_SETTINGS = Object.freeze({ enabled: true });

function settingsFile() {
  return path.join(memoryRoot(), "settings.json");
}

/** @returns {{ enabled: boolean }} */
export function loadTaskMemorySettings() {
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsFile(), "utf8"));
    return { enabled: typeof parsed?.enabled === "boolean" ? parsed.enabled : DEFAULT_TASK_MEMORY_SETTINGS.enabled };
  } catch {
    return { ...DEFAULT_TASK_MEMORY_SETTINGS };
  }
}

/**
 * @param {{ enabled: boolean }} settings
 * @returns {{ enabled: boolean }}
 */
export function saveTaskMemorySettings(settings) {
  if (!settings || typeof settings.enabled !== "boolean") {
    throw new Error("task memory settings need a boolean `enabled`");
  }
  const next = { enabled: settings.enabled };
  ensureDir(memoryRoot());
  const file = settingsFile();
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next), { mode: 0o600 });
  fs.renameSync(tmp, file);
  return next;
}
