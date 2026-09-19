import test from "node:test";
import assert from "node:assert/strict";
import { observationEvidence, screenshotArtifact } from "../agent/jev/evidence.js";

test("durable evidence is bounded and excludes field values and raw capture data", () => {
  const snapshot = { docNonce: "doc", url: `https://example.com/${"q".repeat(500)}`, title: "t".repeat(500), text: "•".repeat(2000),
    elements: [{ ref: "field", role: "textbox", label: "Password", value: "never-persist-me", checked: false }] };
  const evidence = observationEvidence(snapshot, { ref: "field", docNonce: "doc" }, 123, { status: "disabled" });
  assert.equal(evidence.url.length, 200); assert.equal(evidence.title.length, 160); assert.equal(evidence.text.length, 1000);
  assert(evidence.urlTruncated && evidence.textTruncated); assert.equal(evidence.observedAt, 123);
  assert.equal(evidence.target.checked, false); assert(!JSON.stringify(evidence).includes("never-persist-me"));
  assert(!Object.hasOwn(evidence.target, "value"));
});

test("target evidence is scoped to its original document while same-document changes remain visible", () => {
  const target = { ref: "ref_44", docNonce: "search-doc" };
  const after = { docNonce: "results-doc", elements: [{ ref: "ref_44", label: "Download Excel", role: "button" }] };
  assert.equal(observationEvidence(after, target, 1, { status: "disabled" }).target, null);
  after.docNonce = "search-doc";
  assert.equal(observationEvidence(after, target, 2, { status: "disabled" }).target.label, "Download Excel");
  assert.equal(observationEvidence(after, { ref: "ref_44" }, 3, { status: "disabled" }).target, null);
});

test("only the canonical capture-result ID supplies a historical artifact reference", () => {
  const text = (value) => [{ type: "text", text: value }];
  assert.equal(screenshotArtifact(text("Successfully captured screenshot (1280x720, jpeg) - ID: screenshot_1789850000 — give click coordinates in this image's own pixels")), "screenshot_1789850000");
  for (const value of ["ID: screenshot_42", "Successfully captured screenshot (jpeg) - ID: ../../escape", "Successfully captured screenshot (jpeg) - ID: screenshot_42suffix"]) {
    assert.equal(screenshotArtifact(text(value)), null);
  }
});
