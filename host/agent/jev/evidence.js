// Durable evidence is a bounded projection of already-masked observations.
// Never persist form values, prepared text, image bytes, or truncated URLs as
// if they were complete navigation targets.
export function observationEvidence(snapshot, target, observedAt, screenshot) {
  const url = String(snapshot?.url ?? "");
  // Refs are document-local. A replacement document can recycle the same
  // string for an unrelated control; it is not the original action target.
  const sameDocument = typeof target?.docNonce === "string" && target.docNonce.length > 0 && target.docNonce === snapshot?.docNonce;
  const element = sameDocument && snapshot?.elements?.find((entry) => entry.ref === target.ref);
  return {
    observedAt,
    url: url.slice(0, 200),
    urlTruncated: url.length > 200,
    title: String(snapshot?.title ?? "").slice(0, 160),
    text: String(snapshot?.text ?? "").slice(0, 1000),
    textTruncated: String(snapshot?.text ?? "").length > 1000,
    target: element ? { ref: String(element.ref ?? "").slice(0, 100), role: String(element.role ?? "").slice(0, 40), label: String(element.label ?? "").slice(0, 160),
      ...Object.fromEntries(["checked", "expanded", "disabled"].filter((key) => typeof element[key] === "boolean").map((key) => [key, element[key]])) } : null,
    screenshot
  };
}

export function screenshotArtifact(content) {
  const text = content.filter((block) => block?.type === "text").map((block) => block.text).join("\n");
  // This is the existing screenshot tool's canonical result ID, whose bytes
  // background.js already sends through action_artifact chunk transport.
  const match = /^Successfully captured screenshot .* - ID: (screenshot_\d+)(?=\s|$)/m.exec(text);
  return match ? match[1] : null;
}
