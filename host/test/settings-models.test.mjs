#!/usr/bin/env node
//
// Manual model catalog validation (host/agent/settings/models.js).
//
// Run: node host/test/settings-models.test.mjs

import { validateModels, tryValidateModels } from "../agent/settings/models.js";

const results = [];
function check(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
    console.log(`  PASS  ${name}`);
  } catch (err) {
    results.push({ name, ok: false, err: err.message });
    console.log(`  FAIL  ${name} — ${err.message}\n${err.stack}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

console.log("\nManual model catalog validation\n");

check("an empty list with no default is valid (initial state — never guess a model)", () => {
  const { models, defaultModelId } = validateModels([], null);
  assert(models.length === 0);
  assert(defaultModelId === null);
});

check("rejects a nonempty default paired with an empty list", () => {
  let threw = false;
  try {
    validateModels([], "claude-x");
  } catch (err) {
    threw = true;
    assert(err.code === "INVALID_MODELS");
  }
  assert(threw);
});

check("accepts a well-formed list with a valid default, preserving explicit order", () => {
  const input = [
    { id: "claude-b", label: "Claude B" },
    { id: "claude-a", label: "Claude A" }
  ];
  const { models, defaultModelId } = validateModels(input, "claude-a");
  assert(models.length === 2);
  assert(models[0].id === "claude-b", "order must be preserved, not sorted");
  assert(defaultModelId === "claude-a");
});

check("trims surrounding whitespace on id and label", () => {
  const { models, defaultModelId } = validateModels([{ id: "  claude-x  ", label: "  Claude X  " }], "  claude-x  ");
  assert(models[0].id === "claude-x", JSON.stringify(models));
  assert(models[0].label === "Claude X");
  assert(defaultModelId === "claude-x");
});

check("rejects a duplicate model id", () => {
  let threw = false;
  try {
    validateModels(
      [
        { id: "claude-x", label: "A" },
        { id: "claude-x", label: "B" }
      ],
      "claude-x"
    );
  } catch (err) {
    threw = true;
    assert(/duplicate/i.test(err.message), err.message);
  }
  assert(threw);
});

check("model IDs are case-sensitive (not deduplicated across case)", () => {
  const { models } = validateModels(
    [
      { id: "Claude-X", label: "A" },
      { id: "claude-x", label: "B" }
    ],
    "Claude-X"
  );
  assert(models.length === 2, "different-case ids must both survive");
});

check("rejects an empty model id", () => {
  let threw = false;
  try {
    validateModels([{ id: "   ", label: "A" }], "x");
  } catch (err) {
    threw = true;
    assert(/empty id/i.test(err.message), err.message);
  }
  assert(threw);
});

check("rejects an empty label", () => {
  let threw = false;
  try {
    validateModels([{ id: "claude-x", label: "   " }], "claude-x");
  } catch (err) {
    threw = true;
    assert(/empty label/i.test(err.message), err.message);
  }
  assert(threw);
});

check("rejects a default that does not reference a real entry", () => {
  let threw = false;
  try {
    validateModels([{ id: "claude-x", label: "X" }], "claude-does-not-exist");
  } catch (err) {
    threw = true;
    assert(/does not reference/i.test(err.message), err.message);
  }
  assert(threw);
});

check("rejects a missing default when the list is nonempty", () => {
  let threw = false;
  try {
    validateModels([{ id: "claude-x", label: "X" }], null);
  } catch (err) {
    threw = true;
    assert(/default model is required/i.test(err.message), err.message);
  }
  assert(threw);
});

check("rejects a non-array models value", () => {
  let threw = false;
  try {
    validateModels("not-an-array", null);
  } catch (err) {
    threw = true;
  }
  assert(threw);
});

check("tryValidateModels returns a structured, non-throwing failure", () => {
  const result = tryValidateModels([{ id: "x", label: "X" }, { id: "x", label: "Y" }], "x");
  assert(result.ok === false);
  assert(typeof result.error === "string");
});

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed\n`);
if (failed.length > 0) process.exitCode = 1;
