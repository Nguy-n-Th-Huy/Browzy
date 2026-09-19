// The comparison engine: a pure, recursive field diff between two snapshots'
// `fields` objects.
//
// Deliberately dependency-free and side-effect-free — no I/O, no clock, no
// knowledge of files or reports — so the same function can be unit-tested
// against fixtures and reused by any future caller. The report module owns
// presentation; this module owns semantics.
//
// Classification (the contract in specs/workflow/snapshot-comparison):
//   - present in current only        → `added`   { path, value }
//   - present in baseline only       → `removed` { path, value }
//   - present in both, different     → `changed` { path, old, new, typeChanged }
//   - same items, different order    → `reordered` { path, items: [{ value, from, to }] }
//
// Paths are unambiguous and addressable: objects by dotted key (`user.email`),
// arrays by index (`items[2].name`). Every object key is visited (union of both
// sides, in sorted order so the output is deterministic), never just the keys
// present on one side.

/** The JSON type of a value, with `array` and `null` named separately. */
function jsonType(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Stable serialization for identity comparison (key order never matters). */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isPlainObject(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function pathFor(base, key) {
  return base ? `${base}.${key}` : String(key);
}

function indexPathFor(base, index) {
  return `${base}[${index}]`;
}

/**
 * Compare two values at `path`, pushing every difference into `diff`.
 */
function walk(baseline, current, path, diff) {
  if (isPlainObject(baseline) && isPlainObject(current)) {
    const keys = [...new Set([...Object.keys(baseline), ...Object.keys(current)])].sort();
    for (const key of keys) {
      const childPath = pathFor(path, key);
      const inBaseline = Object.prototype.hasOwnProperty.call(baseline, key);
      const inCurrent = Object.prototype.hasOwnProperty.call(current, key);
      if (inBaseline && !inCurrent) diff.removed.push({ path: childPath, value: baseline[key] });
      else if (!inBaseline && inCurrent) diff.added.push({ path: childPath, value: current[key] });
      else walk(baseline[key], current[key], childPath, diff);
    }
    return;
  }

  if (Array.isArray(baseline) && Array.isArray(current)) {
    walkArray(baseline, current, path, diff);
    return;
  }

  if (canonical(baseline) === canonical(current)) return;

  const baselineType = jsonType(baseline);
  const currentType = jsonType(current);
  diff.changed.push({
    path,
    old: baseline,
    new: current,
    typeChanged: baselineType !== currentType,
    oldType: baselineType,
    newType: currentType
  });
}

function walkArray(baseline, current, path, diff) {
  // Same items in a different order is a reordering, not N changed positions:
  // compare the multisets first and, when they match while the order does not,
  // report only the items whose position moved.
  if (baseline.length === current.length) {
    const baselineForms = baseline.map(canonical);
    const currentForms = current.map(canonical);
    const sameMultiset = multisetEquals(baselineForms, currentForms);
    if (sameMultiset && baselineForms.some((form, index) => form !== currentForms[index])) {
      const moved = [];
      for (let index = 0; index < baseline.length; index += 1) {
        if (baselineForms[index] === currentForms[index]) continue;
        const to = currentForms.indexOf(baselineForms[index]);
        moved.push({ value: baseline[index], from: index, to });
      }
      diff.reordered.push({ path, items: moved });
      return;
    }
    if (sameMultiset) return; // identical arrays: nothing to report
  }

  // An insertion or a removal is reported as exactly that, never as a run of
  // positional changes; anything not a plain insertion/removal falls through to
  // the index walk below.
  const shift = subsequenceShift(baseline, current);
  if (shift) {
    for (const item of shift.added) diff.added.push({ path: indexPathFor(path, item.index), value: item.value });
    for (const item of shift.removed) diff.removed.push({ path: indexPathFor(path, item.index), value: item.value });
    return;
  }

  const common = Math.min(baseline.length, current.length);
  for (let index = 0; index < common; index += 1) {
    walk(baseline[index], current[index], indexPathFor(path, index), diff);
  }
  for (let index = common; index < current.length; index += 1) {
    diff.added.push({ path: indexPathFor(path, index), value: current[index] });
  }
  for (let index = common; index < baseline.length; index += 1) {
    diff.removed.push({ path: indexPathFor(path, index), value: baseline[index] });
  }
}

/**
 * The plain insertion/removal case: one array is the other plus items, in the
 * same relative order. Reports exactly the extra items (at their own indices)
 * so an item inserted in the middle does not smear a positional `changed`
 * across every entry after it — "unchanged items are not reported".
 * Returns null when the two arrays are not related that way.
 */
function subsequenceShift(baseline, current) {
  const baselineForms = baseline.map(canonical);
  const currentForms = current.map(canonical);
  if (baselineForms.length === currentForms.length) return null;
  const baselineIsShorter = baselineForms.length < currentForms.length;
  const shorter = baselineIsShorter ? baselineForms : currentForms;
  const longer = baselineIsShorter ? currentForms : baselineForms;
  const matched = new Array(longer.length).fill(false);
  let cursor = 0;
  for (let index = 0; index < longer.length && cursor < shorter.length; index += 1) {
    if (shorter[cursor] === longer[index]) {
      matched[index] = true;
      cursor += 1;
    }
  }
  if (cursor !== shorter.length) return null;
  const added = [];
  const removed = [];
  for (let index = 0; index < longer.length; index += 1) {
    if (matched[index]) continue;
    if (baselineIsShorter) added.push({ index, value: current[index] });
    else removed.push({ index, value: baseline[index] });
  }
  return { added, removed };
}

function multisetEquals(left, right) {
  const counts = new Map();
  for (const item of left) counts.set(item, (counts.get(item) || 0) + 1);
  for (const item of right) {
    const remaining = counts.get(item);
    if (!remaining) return false;
    counts.set(item, remaining - 1);
  }
  return true;
}

/**
 * Diff two snapshots' field objects.
 *
 * @param {object} baseline - the saved fields, as stored
 * @param {object} current - the fresh capture's fields
 * @returns {{added: Array, removed: Array, changed: Array, reordered: Array}}
 */
export function diffFields(baseline, current) {
  const diff = { added: [], removed: [], changed: [], reordered: [] };
  walk(baseline ?? null, current ?? null, "", diff);
  return diff;
}

/** Summary counts, plus whether anything at all differs. */
export function summarizeDiff(diff) {
  const added = diff.added.length;
  const removed = diff.removed.length;
  const changed = diff.changed.length;
  const reordered = diff.reordered.length;
  return { added, removed, changed, reordered, total: added + removed + changed + reordered };
}
