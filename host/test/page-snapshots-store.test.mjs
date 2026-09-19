#!/usr/bin/env node
//
// Page snapshots: the SnapshotStore's storage layout, its guards, and its
// tolerant listing/retrieval/deletion contract.
//
// Everything here runs against the REAL modules on a scratch OCIC_AGENT_HOME —
// no live browser, no SDK. Every rejection is asserted by REASON, because the
// reasons are what the tool hands back to the model.
//
// Run: node host/test/page-snapshots-store.test.mjs
//      (the suite is also runnable as `node --test test/page-snapshots-store.test.mjs`)

import os from "node:os";
import fs from "node:fs";
import path from "node:path";

const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ocic-snapshots-"));
process.env.OCIC_AGENT_HOME = scratchRoot;

const {
  SnapshotStore,
  SnapshotError,
  urlHash,
  normalizeUrl,
  slugifyName,
  MAX_NAME_LENGTH,
  MAX_FIELDS_BYTES,
  MAX_SNAPSHOTS_PER_URL
} = await import("../agent/snapshots/store.js");
const { snapshotsRoot, snapshotUrlDir } = await import("../agent/storage/paths.js");

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  PASS  ${name}`);
  } catch (err) {
    results.push({ name, ok: false, err: err.message });
    console.log(`  FAIL  ${name} — ${err.stack || err.message}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
async function rejects(fn, reason) {
  try {
    await fn();
  } catch (err) {
    assert(err instanceof SnapshotError, `expected SnapshotError, got ${err.name}: ${err.message}`);
    assert(err.reason === reason, `expected reason ${reason}, got ${err.reason} (${err.message})`);
    return err;
  }
  throw new Error(`expected a rejection with reason ${reason}, but the call resolved`);
}

/** A clock that never repeats a millisecond, so captures sort deterministically. */
function tickingClock(base = Date.parse("2026-01-01T00:00:00.000Z")) {
  let tick = 0;
  return () => base + tick++ * 1000;
}

function jsonFilesUnder(dir) {
  const found = [];
  const walk = (current) => {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".json")) found.push(full);
    }
  };
  walk(dir);
  return found;
}

// --- URL identity ---------------------------------------------------------

await test("the URL hash is stable across parameter order and fragments, and separates pages", () => {
  assert(
    urlHash("https://Example.com/gia?b=2&a=1#section") === urlHash("https://example.com/gia?a=1&b=2"),
    "parameter order and fragment must not change a page's identity"
  );
  assert(urlHash("https://example.com/gia?a=1") !== urlHash("https://example.com/gia?a=2"), "different query, different page");
  assert(urlHash("https://example.com/gia") !== urlHash("https://example.com/gia/khac"), "different path, different page");
  assert(normalizeUrl("https://example.com:443/gia?b=2&a=1") === "https://example.com/gia?a=1&b=2", "canonical form");
  assert(/^[a-f0-9]{64}$/.test(urlHash("https://example.com/")), "the hash is a hex sha256 and nothing else");
});

await test("the slug drops diacritics and can never carry a path segment", () => {
  assert(slugifyName("Phân tích dauthau asia") === "phan-tich-dauthau-asia", "vietnamese name");
  assert(slugifyName("Đầu tư 2026") === "dau-tu-2026", "đ maps to d");
  assert(slugifyName("../../etc/passwd") === "etc-passwd", "traversal characters never survive");
  assert(slugifyName("日本語だけ") === "snapshot", "a name the slug alphabet cannot represent falls back");
  assert(slugifyName("x".repeat(400)).length <= 80, "the slug is bounded");
});

// --- save + round trip ----------------------------------------------------

await test("save() writes one JSON file under the URL directory and read() returns it", () => {
  const store = new SnapshotStore({ now: tickingClock() });
  const url = "https://vi.example.com/gia-vang";
  const record = store.save({
    name: "Giá vàng SJC",
    url,
    title: "Giá vàng hôm nay",
    fields: { buy: 89_000_000, sell: 91_000_000, rings: [1, 2, 3] },
    metadata: { runId: "run_1", conversationId: "conv_1", viewport: "1280x800" }
  });

  assert(record.path.startsWith(snapshotUrlDir(urlHash(url))), `path was outside the URL directory: ${record.path}`);
  assert(record.fileName === "gia-vang-sjc-2026-01-01T00-00-00-000Z.json", `filename was ${record.fileName}`);
  assert(record.timestamp === "2026-01-01T00:00:00.000Z", `timestamp was ${record.timestamp}`);
  assert(fs.existsSync(record.path), "the file is really on disk");
  assert(record.size > 0, "the size is reported");

  const read = store.read({ name: "Giá vàng SJC", url });
  assert(read.url === url, "url round-trips verbatim");
  assert(read.title === "Giá vàng hôm nay", "title round-trips");
  assert(read.name === "Giá vàng SJC", "the caller's name (not the slug) is what the record carries");
  assert(read.timestamp === record.timestamp, "timestamp round-trips");
  assert(read.fields.buy === 89_000_000 && read.fields.rings.length === 3, "fields round-trip");
  assert(read.metadata.runId === "run_1" && read.metadata.viewport === "1280x800", "metadata round-trips");
  assert(read.metadata.urlHash === urlHash(url), "the record is self-describing about its URL identity");
  assert(read.path === record.path, "the same file is addressed");
});

await test("several captures for one URL never overwrite each other", () => {
  const store = new SnapshotStore({ now: tickingClock() });
  const url = "https://vi.example.com/nhieu-lan";
  const first = store.save({ name: "Lần 1", url, fields: { v: 1 } });
  const second = store.save({ name: "Lần 1", url, fields: { v: 2 } });
  const third = store.save({ name: "Lần 2", url, fields: { v: 3 } });

  assert(first.path !== second.path && second.path !== third.path, "every capture is its own file");
  assert(fs.existsSync(first.path) && fs.existsSync(second.path) && fs.existsSync(third.path), "all three survive");
  assert(store.read({ name: "Lần 1", url }).fields.v === 2, "a name addresses its newest capture");
  assert(store.read({ path: first.path }).fields.v === 1, "an explicit path addresses the older one");
});

await test("captures in the same millisecond do not overwrite: the host advances its own timestamp", () => {
  const store = new SnapshotStore({ now: () => Date.parse("2026-02-02T08:00:00.000Z") });
  const url = "https://vi.example.com/cung-mot-giay";
  const first = store.save({ name: "Same", url, fields: { v: 1 } });
  const second = store.save({ name: "Same", url, fields: { v: 2 } });
  assert(first.path !== second.path, "the second capture got its own file");
  assert(Date.parse(second.timestamp) > Date.parse(first.timestamp), "the minted timestamp moved forward");
  assert(store.read({ path: first.path }).fields.v === 1, "the first capture is intact");
});

await test("a snapshot carries only the documented shape, and readers tolerate extra keys", () => {
  const store = new SnapshotStore({ now: tickingClock() });
  const url = "https://vi.example.com/hinh-dang";
  const record = store.save({ name: "Shape", url, title: "T", fields: { a: 1 } });
  const onDisk = JSON.parse(fs.readFileSync(record.path, "utf8"));
  assert(
    JSON.stringify(Object.keys(onDisk).sort()) ===
      JSON.stringify(["fields", "metadata", "name", "timestamp", "title", "url"]),
    `unexpected record keys: ${Object.keys(onDisk).join(",")}`
  );
  assert(!("path" in onDisk) && !("size" in onDisk), "reader-added fields are not baked into the file");

  // A newer build's extra top-level key must not make the record unreadable.
  const parsed = JSON.parse(fs.readFileSync(record.path, "utf8"));
  parsed.futureKey = { anything: true };
  fs.writeFileSync(record.path, JSON.stringify(parsed), "utf8");
  const read = store.read({ path: record.path });
  assert(read.futureKey?.anything === true, "unknown top-level keys survive a read");
  assert(read.fields.a === 1, "and the known fields still work");

  // A missing optional metadata key is not corruption either.
  const noMetadata = path.join(path.dirname(record.path), "gia-vang-no-metadata-2026-01-01T00-00-05-000Z.json");
  fs.writeFileSync(noMetadata, JSON.stringify({ url, title: "T", name: "NoMeta", timestamp: "2026-01-01T00:00:05.000Z", fields: { a: 2 } }));
  assert(store.read({ path: noMetadata }).fields.a === 2, "a record without metadata still loads");
});

// --- names ----------------------------------------------------------------

await test("hostile or unusable names are rejected without writing anything", async () => {
  const store = new SnapshotStore({ now: tickingClock() });
  const url = "https://vi.example.com/ten-xau";
  const before = jsonFilesUnder(snapshotsRoot()).length;

  await rejects(() => store.save({ name: "", url, fields: {} }), "empty_name");
  await rejects(() => store.save({ name: "   ", url, fields: {} }), "empty_name");
  await rejects(() => store.save({ name: undefined, url, fields: {} }), "empty_name");
  await rejects(() => store.save({ name: "../../etc/passwd", url, fields: {} }), "unsafe_name");
  await rejects(() => store.save({ name: "a/b", url, fields: {} }), "unsafe_name");
  await rejects(() => store.save({ name: "a\\b", url, fields: {} }), "unsafe_name");
  await rejects(() => store.save({ name: "..", url, fields: {} }), "unsafe_name");
  await rejects(() => store.save({ name: "x".repeat(MAX_NAME_LENGTH + 1), url, fields: {} }), "name_too_long");
  const emptyNameError = await rejects(() => store.save({ name: "", url, fields: {} }), "empty_name");
  assert(emptyNameError.message.includes("snapshot name"), `the error must name what was rejected: ${emptyNameError.message}`);
  const traversalError = await rejects(() => store.save({ name: "../../etc/passwd", url, fields: {} }), "unsafe_name");
  assert(traversalError.message.includes("../../etc/passwd"), `the rejected name must appear: ${traversalError.message}`);

  assert(jsonFilesUnder(snapshotsRoot()).length === before, "no rejected save left a file behind");
  assert(!fs.existsSync(store.dir(url)), "no rejected save created its directory");
});

// --- field guards ---------------------------------------------------------

await test("fields must be a bounded, pure-JSON object", async () => {
  const store = new SnapshotStore({ now: tickingClock() });
  const url = "https://vi.example.com/du-lieu";

  await rejects(() => store.save({ name: "n", url, fields: undefined }), "invalid_fields");
  await rejects(() => store.save({ name: "n", url, fields: null }), "invalid_fields");
  await rejects(() => store.save({ name: "n", url, fields: [1, 2] }), "invalid_fields");
  await rejects(() => store.save({ name: "n", url, fields: { a: undefined } }), "fields_not_serializable");
  await rejects(() => store.save({ name: "n", url, fields: { a: () => 1 } }), "fields_not_serializable");
  await rejects(() => store.save({ name: "n", url, fields: { a: Number.NaN } }), "fields_not_serializable");
  await rejects(() => store.save({ name: "n", url, fields: { a: new Date() } }), "fields_not_serializable");
  const cyclic = { name: "cycle" };
  cyclic.self = cyclic;
  await rejects(() => store.save({ name: "n", url, fields: cyclic }), "fields_not_serializable");

  const big = { blob: "x".repeat(MAX_FIELDS_BYTES) };
  await rejects(() => store.save({ name: "n", url, fields: big }), "fields_too_large");
  assert(!fs.existsSync(store.dir(url)), "no rejected payload left a directory behind");

  const nested = { level1: { level2: { bad: undefined } } };
  const nestedError = await rejects(() => store.save({ name: "n", url, fields: nested }), "fields_not_serializable");
  assert(nestedError.message.includes("level1.level2.bad"), `the failing field path must be named: ${nestedError.message}`);
});

await test("a URL is required and must be an http(s) page", async () => {
  const store = new SnapshotStore({ now: tickingClock() });
  await rejects(() => store.save({ name: "n", fields: {} }), "missing_url");
  await rejects(() => store.save({ name: "n", url: "", fields: {} }), "missing_url");
  await rejects(() => store.save({ name: "n", url: "not a url", fields: {} }), "invalid_url");
  await rejects(() => store.save({ name: "n", url: "file:///C:/secrets.txt", fields: {} }), "invalid_url");
});

await test("storage failure is named and leaves no partial snapshot", async () => {
  const store = new SnapshotStore({ now: tickingClock() });
  const url = "https://vi.example.com/hong-hoc";
  // A FILE where the URL's directory has to go: the mkdir cannot succeed, and
  // the failure has to travel as a named reason instead of a raw fs error.
  fs.writeFileSync(snapshotUrlDir(urlHash(url)), "not a directory", "utf8");
  await rejects(() => store.save({ name: "n", url, fields: { a: 1 } }), "storage_failed");
  assert(fs.readFileSync(snapshotUrlDir(urlHash(url)), "utf8") === "not a directory", "the blocking file is untouched");
});

// --- listing --------------------------------------------------------------

await test("list() returns every snapshot newest first", () => {
  const store = new SnapshotStore({ now: tickingClock() });
  const url = "https://vi.example.com/liet-ke";
  store.save({ name: "Cũ", url, fields: { v: 1 } });
  store.save({ name: "Mới", url, fields: { v: 2 } });
  store.save({ name: "Khác", url: "https://vi.example.com/khac", fields: { v: 3 } });

  const entries = store.list();
  const forUrl = entries.filter((entry) => entry.valid && entry.url === url);
  assert(forUrl.length === 2, `expected 2 entries for the URL, got ${forUrl.length}`);
  assert(forUrl[0].name === "Mới", "newest first");
  assert(forUrl[0].timestamp > forUrl[1].timestamp, "ordering is by the capture timestamp");
  assert(forUrl[0].path && forUrl[0].size > 0 && forUrl[0].fileName, "entries carry path, size and filename");
  assert(entries.length >= 3, "no filter returns everything");
});

await test("list() filters by URL and by name pattern, and states nothing it cannot know", () => {
  const store = new SnapshotStore({ now: tickingClock() });
  const url = "https://vi.example.com/loc";
  store.save({ name: "Giá vàng sáng", url, fields: { v: 1 } });
  store.save({ name: "Giá vàng chiều", url, fields: { v: 2 } });
  store.save({ name: "Tỷ giá", url: "https://vi.example.com/loc/ty-gia", fields: { v: 3 } });

  const byUrl = store.list({ url });
  assert(byUrl.length === 2, `URL filter returned ${byUrl.length} entries`);
  assert(byUrl.every((entry) => entry.url === url), "only that URL's snapshots");

  const bySubstring = store.list({ url, namePattern: "chiều" });
  assert(bySubstring.length === 1 && bySubstring[0].name === "Giá vàng chiều", "substring filter matched by name");

  const bySlug = store.list({ url, namePattern: "gia-vang" });
  assert(
    bySlug.length === 2 && bySlug.every((entry) => entry.name.startsWith("Giá vàng")),
    `the filename (slug) is matchable too, got ${bySlug.length}`
  );

  const byGlob = store.list({ url, namePattern: "Giá vàng*" });
  assert(byGlob.length === 2, `glob filter returned ${byGlob.length}`);

  assert(store.list({ url: "https://vi.example.com/loc-khong-co" }).length === 0, "an empty URL lists as empty");
});

await test("an absent snapshots root lists as empty, never as an error", () => {
  const previous = process.env.OCIC_AGENT_HOME;
  process.env.OCIC_AGENT_HOME = path.join(scratchRoot, "chua-ton-tai");
  try {
    assert(new SnapshotStore().list().length === 0, "no root ⇒ empty listing");
  } finally {
    process.env.OCIC_AGENT_HOME = previous;
  }
  assert(!fs.existsSync(path.join(scratchRoot, "chua-ton-tai")), "listing must not create the root");
});

await test("a corrupted snapshot file is marked invalid and does not affect the others", () => {
  const store = new SnapshotStore({ now: tickingClock() });
  const url = "https://vi.example.com/hong";
  store.save({ name: "Tốt", url, fields: { v: 1 } });
  const dir = store.dir(url);
  fs.writeFileSync(path.join(dir, "broken-2026-01-01T00-00-09-000Z.json"), "{ this is not json", "utf8");
  fs.writeFileSync(path.join(dir, "not-json-2026-01-01T00-00-10-000Z.json"), JSON.stringify([1, 2, 3]), "utf8");

  const entries = store.list({ url });
  assert(entries.length === 3, `expected 3 entries, got ${entries.length}`);
  const invalid = entries.filter((entry) => !entry.valid);
  assert(invalid.length === 2, "both bad files are reported, not hidden");
  assert(invalid.every((entry) => entry.reason === "invalid_json" && entry.path && entry.detail), "each carries its reason");
  const good = entries.filter((entry) => entry.valid);
  assert(good.length === 1 && good[0].name === "Tốt", "the readable snapshot is unaffected");
  assert(entries[entries.length - 1].valid === false, "invalid entries sort last");
});

// --- retrieval + deletion -------------------------------------------------

await test("get fails with a named reason for a missing, unreadable, or corrupted snapshot", async () => {
  const store = new SnapshotStore({ now: tickingClock() });
  const url = "https://vi.example.com/lay";
  const record = store.save({ name: "Có", url, fields: { v: 1 } });

  await rejects(() => store.read({ name: "Không có", url }), "not_found");
  await rejects(() => store.read({ name: "Có", url: "https://vi.example.com/lay-khac" }), "not_found");
  await rejects(() => store.read({ name: "Có" }), "missing_url");
  await rejects(() => store.read({ url }), "missing_name");
  await rejects(() => store.read({ path: path.join(scratchRoot, "ngoai-root.json") }), "unsafe_path");
  await rejects(() => store.read({ path: path.join(store.dir(url), "khong-ton-tai-2026-01-01T00-00-00-000Z.json") }), "not_found");
  await rejects(() => store.read({ path: record.path.replace(/\.json$/, "") + ".txt" }), "unsafe_path");
  await rejects(() => store.read({ path: 42 }), "invalid_ref");

  const broken = path.join(store.dir(url), "vo-2026-01-01T00-00-20-000Z.json");
  fs.writeFileSync(broken, "not json at all", "utf8");
  const err = await rejects(() => store.read({ path: broken }), "invalid_json");
  assert(err.message.includes("vo-2026-01-01T00-00-20-000Z.json"), `the failing file must be named: ${err.message}`);
});

await test("a path outside the snapshots root is never touched", () => {
  const store = new SnapshotStore({ now: tickingClock() });
  const outside = path.join(scratchRoot, "quan-trong.json");
  fs.writeFileSync(outside, JSON.stringify({ url: "https://x.test/", name: "out", timestamp: "2026-01-01T00:00:00.000Z", fields: {} }), "utf8");
  const sibling = path.join(snapshotsRoot(), "khong-phai-thu-muc-url.json");
  fs.writeFileSync(sibling, JSON.stringify({ anything: true }), "utf8");

  assert(fs.existsSync(outside), "the outside file exists first");
  return Promise.all([
    rejects(() => store.read({ path: outside }), "unsafe_path"),
    rejects(() => store.remove({ path: outside }), "unsafe_path"),
    rejects(() => store.read({ path: sibling }), "unsafe_path"),
    rejects(() => store.remove({ path: sibling }), "unsafe_path")
  ]).then(() => {
    assert(fs.existsSync(outside), "the outside file is untouched");
    assert(fs.existsSync(sibling), "a stray file directly under the root is not addressable");
  });
});

await test("delete removes one snapshot and prunes its directory once empty", () => {
  const store = new SnapshotStore({ now: tickingClock() });
  const url = "https://vi.example.com/xoa";
  const first = store.save({ name: "Một", url, fields: { v: 1 } });
  const second = store.save({ name: "Hai", url, fields: { v: 2 } });
  const dir = store.dir(url);

  assert(store.remove({ path: first.path }).pruned === false, "the directory still holds the sibling");
  assert(!fs.existsSync(first.path) && fs.existsSync(second.path), "exactly one file was removed");
  const last = store.remove({ name: "Hai", url });
  assert(last.pruned === true && last.path === second.path, "the emptied directory is pruned");
  assert(!fs.existsSync(dir), "the URL directory is gone");

  // A corrupted file must still be deletable — it is exactly the file an
  // operator needs to be able to remove.
  const broken = path.join(snapshotUrlDir(urlHash("https://vi.example.com/xoa-hong")));
  fs.mkdirSync(broken, { recursive: true });
  const brokenFile = path.join(broken, "hong-2026-01-01T00-00-30-000Z.json");
  fs.writeFileSync(brokenFile, "{ not json", "utf8");
  assert(store.remove({ path: brokenFile }).pruned === true, "a corrupted snapshot can be deleted");
  assert(!fs.existsSync(brokenFile), "and it is gone");
});

await test("delete fails with a named reason when the snapshot cannot be deleted", async () => {
  const store = new SnapshotStore({ now: tickingClock() });
  const url = "https://vi.example.com/xoa-loi";
  await rejects(() => store.remove({ name: "Không có", url }), "not_found");
  await rejects(() => store.remove({ path: path.join(snapshotsRoot(), "x.json") }), "unsafe_path");
});

// --- per-URL bound --------------------------------------------------------

await test("a URL directory is bounded, and the boundary rejects rather than overwrites", async () => {
  const store = new SnapshotStore({ now: tickingClock() });
  const url = "https://vi.example.com/gioi-han";
  for (let index = 0; index < MAX_SNAPSHOTS_PER_URL; index += 1) {
    store.save({ name: `n${index}`, url, fields: { index } });
  }
  const err = await rejects(() => store.save({ name: "quá nhiều", url, fields: {} }), "too_many_snapshots");
  assert(err.message.includes(String(MAX_SNAPSHOTS_PER_URL)), `the bound must be stated: ${err.message}`);
  assert(store.list({ url }).length === MAX_SNAPSHOTS_PER_URL, "nothing was overwritten or added");
});

const failed = results.filter((r) => !r.ok);
console.log(
  `\n${results.length - failed.length}/${results.length} passed` +
    (failed.length ? `\n\nFailures:\n${failed.map((f) => `  - ${f.name}: ${f.err}`).join("\n")}` : "") +
    "\n"
);
process.exit(failed.length ? 1 : 0);
