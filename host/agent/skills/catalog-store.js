// Durable catalog storage: one small JSON document, written atomically.
//
// Mirrors the write-then-rename pattern host/agent/storage/transcript-store.js
// already uses for its meta.json, so a crash mid-write never leaves a
// half-written catalog.json a later read chokes on.

import fs from "node:fs";
import path from "node:path";
import { catalogFile, ensureSkillsRoot } from "./paths.js";

function atomicWriteJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}

function readJsonSafe(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return fallback;
  }
}

export function loadCatalog() {
  const data = readJsonSafe(catalogFile(), { version: 1, skills: [] });
  if (!data || !Array.isArray(data.skills)) return { version: 1, skills: [] };
  return data;
}

export function saveCatalog(catalog) {
  ensureSkillsRoot();
  atomicWriteJson(catalogFile(), { version: 1, skills: catalog.skills });
}

export function getSkillRecord(name) {
  return loadCatalog().skills.find((s) => s.name === name) || null;
}

export function upsertSkillRecord(record) {
  const catalog = loadCatalog();
  const idx = catalog.skills.findIndex((s) => s.name === record.name);
  if (idx === -1) catalog.skills.push(record);
  else catalog.skills[idx] = record;
  saveCatalog(catalog);
  return record;
}

export function removeSkillRecord(name) {
  const catalog = loadCatalog();
  catalog.skills = catalog.skills.filter((s) => s.name !== name);
  saveCatalog(catalog);
}
