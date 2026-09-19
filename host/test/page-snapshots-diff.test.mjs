#!/usr/bin/env node
//
// The comparison engine and both report forms: pure functions, no filesystem,
// no clock of their own.
//
// The assertions are about SEMANTICS — which path is reported, under which
// classification — because that is what the operator reads and what the JSON
// consumer programs against. A diff that reports an unchanged sibling, or
// calls a reordering N edited fields, is a false report even though nothing
// threw.
//
// Run: node host/test/page-snapshots-diff.test.mjs
//      (also runnable as `node --test test/page-snapshots-diff.test.mjs`)

const { diffFields, summarizeDiff } = await import("../agent/snapshots/diff.js");
const { jsonReport, markdownReport } = await import("../agent/snapshots/report.js");

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
function paths(list) {
  return list.map((entry) => entry.path).sort();
}

// --- classification -------------------------------------------------------

await test("identical inputs produce an empty diff", () => {
  const fields = { a: 1, nested: { b: [1, 2, { c: "x" }] }, nothing: null };
  const diff = diffFields(fields, JSON.parse(JSON.stringify(fields)));
  assert(diff.added.length === 0 && diff.removed.length === 0, "no added/removed");
  assert(diff.changed.length === 0 && diff.reordered.length === 0, "no changed/reordered");
  assert(summarizeDiff(diff).total === 0, "the summary counts zero");
});

await test("key order is not a difference", () => {
  const diff = diffFields({ a: 1, b: { x: 1, y: 2 } }, { b: { y: 2, x: 1 }, a: 1 });
  assert(summarizeDiff(diff).total === 0, `expected no differences, got ${JSON.stringify(diff)}`);
});

await test("added, removed and changed fields are classified separately", () => {
  const diff = diffFields({ kept: 1, gone: "x", moves: 5 }, { kept: 1, fresh: true, moves: 6 });
  assert(JSON.stringify(paths(diff.added)) === JSON.stringify(["fresh"]), "added");
  assert(diff.added[0].value === true, "an added field carries its value");
  assert(JSON.stringify(paths(diff.removed)) === JSON.stringify(["gone"]), "removed");
  assert(diff.removed[0].value === "x", "a removed field carries its last known value");
  assert(JSON.stringify(paths(diff.changed)) === JSON.stringify(["moves"]), "changed");
  assert(diff.changed[0].old === 5 && diff.changed[0].new === 6, "a changed field carries both values");
  assert(diff.changed[0].typeChanged === false, "same type is not a type change");
});

await test("nested changes report the full path and no unrelated sibling", () => {
  const baseline = { user: { profile: { email: "a@x.test", name: "A" } }, other: { keep: 1 } };
  const current = { user: { profile: { email: "b@x.test", name: "A" } }, other: { keep: 1 } };
  const diff = diffFields(baseline, current);
  assert(diff.changed.length === 1, `expected exactly one change, got ${JSON.stringify(diff.changed)}`);
  assert(diff.changed[0].path === "user.profile.email", `path was ${diff.changed[0].path}`);
  assert(diff.changed[0].old === "a@x.test" && diff.changed[0].new === "b@x.test", "both values");
  assert(diff.added.length === 0 && diff.removed.length === 0, "siblings are untouched");
});

await test("an added or removed nested object is reported once, at its own path", () => {
  const added = diffFields({ a: 1 }, { a: 1, extra: { deep: { x: 1 } } });
  assert(JSON.stringify(paths(added.added)) === JSON.stringify(["extra"]), "the object is one added entry");
  const removed = diffFields({ a: 1, extra: { deep: {} } }, { a: 1 });
  assert(JSON.stringify(paths(removed.removed)) === JSON.stringify(["extra"]), "the object is one removed entry");
});

await test("a null is a value: gaining or losing one is a change, not an absence", () => {
  const gained = diffFields({ a: 1 }, { a: 1, b: null });
  assert(gained.added.length === 1 && gained.added[0].path === "b" && gained.added[0].value === null, "null added");
  const lost = diffFields({ a: 1, b: null }, { a: 1 });
  assert(lost.removed.length === 1 && lost.removed[0].value === null, "null removed");
});

// --- arrays ---------------------------------------------------------------

await test("array items appended or truncated are reported as added/removed, not as changes", () => {
  const appended = diffFields({ tags: ["a", "b"] }, { tags: ["a", "b", "c"] });
  assert(JSON.stringify(paths(appended.added)) === JSON.stringify(["tags[2]"]), "appended item");
  assert(appended.added[0].value === "c", "with its value");
  assert(appended.changed.length === 0, `an append is not a change: ${JSON.stringify(appended.changed)}`);

  const truncated = diffFields({ tags: ["a", "b", "c"] }, { tags: ["a", "b"] });
  assert(JSON.stringify(paths(truncated.removed)) === JSON.stringify(["tags[2]"]), "truncated item");
  assert(truncated.changed.length === 0, "a truncation is not a change");
});

await test("an item inserted or removed in the middle is reported as exactly that", () => {
  const inserted = diffFields({ tags: ["a", "b", "c"] }, { tags: ["a", "z", "b", "c"] });
  assert(inserted.added.length === 1 && inserted.added[0].path === "tags[1]", `inserted: ${JSON.stringify(inserted)}`);
  assert(inserted.added[0].value === "z", "the inserted item's value");
  assert(inserted.changed.length === 0 && inserted.removed.length === 0, "nothing else is reported");

  const removed = diffFields({ tags: ["a", "z", "b", "c"] }, { tags: ["a", "b", "c"] });
  assert(removed.removed.length === 1 && removed.removed[0].path === "tags[1]", `removed: ${JSON.stringify(removed)}`);
  assert(removed.removed[0].value === "z", "the removed item's last known value");
  assert(removed.changed.length === 0, "nothing else is reported");
});

await test("a reordered array is reported as a reordering, never as N changed fields", () => {
  const diff = diffFields({ steps: ["a", "b", "c"] }, { steps: ["c", "a", "b"] });
  assert(diff.changed.length === 0, `a reorder must not be a change: ${JSON.stringify(diff.changed)}`);
  assert(diff.added.length === 0 && diff.removed.length === 0, "a reorder adds and removes nothing");
  assert(diff.reordered.length === 1 && diff.reordered[0].path === "steps", "one reordered entry");
  const moved = diff.reordered[0].items;
  assert(moved.length === 3, `all three items moved, got ${moved.length}`);
  const c = moved.find((item) => item.value === "c");
  assert(c && c.from === 2 && c.to === 0, `c moved 2→0, got ${JSON.stringify(c)}`);
});

await test("an unchanged array inside a changed object is not reported", () => {
  const diff = diffFields({ rows: [{ id: 1 }, { id: 2 }], total: 1 }, { rows: [{ id: 1 }, { id: 2 }], total: 2 });
  assert(diff.changed.length === 1 && diff.changed[0].path === "total", `only total changed: ${JSON.stringify(diff)}`);
});

await test("arrays of objects recurse by index, reporting the nested path", () => {
  const baseline = { items: [{ sku: "A", price: 10 }, { sku: "B", price: 20 }] };
  const current = { items: [{ sku: "A", price: 10 }, { sku: "B", price: 25 }] };
  const diff = diffFields(baseline, current);
  assert(
    JSON.stringify(paths(diff.changed)) === JSON.stringify(["items[1].price"]),
    `nested array path: ${JSON.stringify(diff.changed)}`
  );
});

await test("a deep fixture reports only the three real differences", () => {
  const baseline = {
    shop: {
      name: "Cửa hàng",
      hours: ["08:00", "12:00", "17:00"],
      products: [
        { sku: "A", stock: 3, price: { amount: 100, currency: "VND" } },
        { sku: "B", stock: 0, price: { amount: 200, currency: "VND" } }
      ]
    },
    stats: { visits: 10 }
  };
  const current = {
    shop: {
      name: "Cửa hàng",
      hours: ["17:00", "08:00", "12:00"],
      products: [
        { sku: "A", stock: 5, price: { amount: 100, currency: "VND" } },
        { sku: "B", stock: 0, price: { amount: 250, currency: "VND" } }
      ]
    },
    stats: { visits: 10, conversions: 2 }
  };
  const diff = diffFields(baseline, current);
  assert(
    JSON.stringify(paths(diff.changed)) === JSON.stringify(["shop.products[0].stock", "shop.products[1].price.amount"]),
    `changed paths: ${JSON.stringify(paths(diff.changed))}`
  );
  assert(JSON.stringify(paths(diff.reordered)) === JSON.stringify(["shop.hours"]), "the hours reorder");
  assert(JSON.stringify(paths(diff.added)) === JSON.stringify(["stats.conversions"]), "the new stat");
  assert(diff.removed.length === 0, `nothing was removed: ${JSON.stringify(diff.removed)}`);
  assert(summarizeDiff(diff).total === 4, `summary total: ${JSON.stringify(summarizeDiff(diff))}`);
});

// --- type changes ---------------------------------------------------------

await test("a JSON type change is changed, with both values and the change named", () => {
  const cases = [
    [{ v: "1" }, { v: 1 }, "string", "number"],
    [{ v: 1 }, { v: { nested: 1 } }, "number", "object"],
    [{ v: { nested: 1 } }, { v: [1] }, "object", "array"],
    [{ v: [1] }, { v: "1" }, "array", "string"],
    [{ v: null }, { v: 0 }, "null", "number"],
    [{ v: true }, { v: "true" }, "boolean", "string"]
  ];
  for (const [baseline, current, oldType, newType] of cases) {
    const diff = diffFields(baseline, current);
    assert(diff.changed.length === 1, `${JSON.stringify(baseline)} → ${JSON.stringify(current)} must be one change`);
    const entry = diff.changed[0];
    assert(entry.typeChanged === true, `typeChanged must be set for ${oldType} → ${newType}`);
    assert(entry.oldType === oldType && entry.newType === newType, `types were ${entry.oldType} → ${entry.newType}`);
    assert(entry.old === baseline.v && JSON.stringify(entry.new) === JSON.stringify(current.v), "both values are carried");
  }
});

// --- report forms ---------------------------------------------------------

const baseline = {
  name: "Giá vàng",
  url: "https://vi.example.com/gia-vang",
  title: "Giá vàng hôm nay",
  timestamp: "2026-09-01T00:00:00.000Z",
  path: "C:\\snapshots\\hash\\gia-vang-1.json",
  fields: { buy: 89, sell: 91, tags: ["a", "b"], gone: 1 }
};
const current = {
  name: "Giá vàng",
  url: "https://vi.example.com/gia-vang",
  title: "Giá vàng hôm nay",
  timestamp: "2026-09-18T00:00:00.000Z",
  path: "C:\\snapshots\\hash\\gia-vang-2.json",
  fields: { buy: 90, sell: 91, tags: ["b", "a"], fresh: true }
};

await test("the JSON report carries both identities, the summary and all diff lists", () => {
  const diff = diffFields(baseline.fields, current.fields);
  const report = jsonReport({ baseline, current, diff, generatedAt: "2026-09-18T01:00:00.000Z" });
  assert(report.kind === "page_snapshot_comparison", "the report is self-identifying");
  assert(report.generatedAt === "2026-09-18T01:00:00.000Z", "the reporting time is carried");
  assert(report.baseline.url === baseline.url && report.baseline.timestamp === baseline.timestamp, "baseline identity");
  assert(report.current.timestamp === current.timestamp, "current identity");
  assert(report.summary.added === 1 && report.summary.changed === 1 && report.summary.reordered === 1, `summary: ${JSON.stringify(report.summary)}`);
  assert(report.unchanged === false, "changes were found");
  assert(report.added[0].path === "fresh" && report.changed[0].path === "buy", "the lists carry the paths");
  assert(report.removed[0].value === 1, "the removed list carries the last known value");
  assert(report.reordered[0].items.length === 2, "the reorder carries the moved items");
  assert(JSON.parse(JSON.stringify(report)).summary.total === 4, "the report is JSON-serializable");
  assert(report.summary.removed === 1 && report.unchanged === false, "the removed list is counted too");
});

await test("the markdown report is readable: identities, summary, then the sections", () => {
  const diff = diffFields(baseline.fields, current.fields);
  const markdown = markdownReport({ baseline, current, diff, generatedAt: "2026-09-18T01:00:00.000Z" });
  assert(markdown.startsWith("# Page snapshot comparison"), "a heading opens the report");
  assert(markdown.includes(baseline.timestamp) && markdown.includes(current.timestamp), "both capture times appear");
  assert(markdown.includes(baseline.url), "the URL appears");
  assert(/\*\*4\*\* differences/.test(markdown), `the change count is stated: ${markdown}`);
  for (const section of ["## Added", "## Removed", "## Changed", "## Reordered"]) {
    assert(markdown.includes(section), `missing section ${section}`);
  }
  assert(markdown.includes("`fresh`") && markdown.includes("`buy`"), "paths appear as code spans");
  assert(markdown.includes("`89`") && markdown.includes("`90`"), "changed values appear");
  assert(markdown.includes("moved from index"), "a reorder names the positions");
});

await test("an empty diff reads as no changes, not as a failed comparison", () => {
  const diff = diffFields(baseline.fields, baseline.fields);
  const markdown = markdownReport({ baseline, current: baseline, diff, generatedAt: null });
  assert(markdown.includes("No changes detected"), `the report must say so: ${markdown}`);
  assert(!markdown.includes("## Added") && !markdown.includes("## Changed"), "empty sections are not rendered");
  const report = jsonReport({ baseline, current: baseline, diff, generatedAt: null });
  assert(report.unchanged === true && report.summary.total === 0, "the JSON form agrees");
  assert(report.added.length === 0 && report.removed.length === 0 && report.changed.length === 0, "every list is empty");
});

await test("a type change is named in the markdown report", () => {
  const diff = diffFields({ v: "1" }, { v: 1 });
  const markdown = markdownReport({ baseline, current, diff, generatedAt: null });
  assert(/type changed: string → number/.test(markdown), `the type change must be named: ${markdown}`);
});

await test("values the diff carries are rendered as JSON, never as [object Object]", () => {
  const diff = diffFields({ cfg: { a: 1 } }, { cfg: "text" });
  const markdown = markdownReport({ baseline, current, diff, generatedAt: null });
  assert(markdown.includes('`{"a":1}`') && markdown.includes('`"text"`'), `objects render as JSON: ${markdown}`);
  assert(markdown.includes("type changed: object → string"), "and the type change is named");
  assert(!markdown.includes("[object Object]"), "no default stringification leaks");
});

const failed = results.filter((r) => !r.ok);
console.log(
  `\n${results.length - failed.length}/${results.length} passed` +
    (failed.length ? `\n\nFailures:\n${failed.map((f) => `  - ${f.name}: ${f.err}`).join("\n")}` : "") +
    "\n"
);
process.exit(failed.length ? 1 : 0);
