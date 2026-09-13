// Unit tests for the upload_image coordinate-drop path
// (extension/background.js): uploadImageAtCoordinate() with injected doubles,
// plus the handler's addressing-mode validation with a mocked chrome.* API.
// Shipped code is exercised via test/_extract.mjs, never copied.
import { extractMethod, extractFunction, compile } from "./_extract.mjs";

let fail = 0;
const ok = (c, m) => { console.log((c ? "  PASS " : "  FAIL ") + m); if (!c) fail++; };

// --- uploadImageAtCoordinate --------------------------------------------------
const coordSrc = extractFunction("uploadImageAtCoordinate");

function buildCoord(overrides = {}) {
  const cdpCalls = [];
  const deps = {
    screenshotToCssCoordinate: (tabId, pair) => pair,
    nativeRequest: async () => "/tmp/staged.png",
    cdp: async (tabId, method, params) => {
      cdpCalls.push({ tabId, method, params });
      if (method === "DOM.getNodeForLocation") return overrides.node === undefined ? { backendNodeId: 7 } : overrides.node;
      if (method.startsWith("Input.dispatchDragEvent")) {
        if (overrides.dragThrows) throw new Error("drag refused");
        return {};
      }
      throw new Error(`unexpected CDP method ${method}`);
    },
    ...overrides.deps,
  };
  const fn = compile(coordSrc, deps, "{ uploadImageAtCoordinate }").uploadImageAtCoordinate;
  return { fn, cdpCalls };
}

console.log("== coordinate validation ==");
{
  const { fn } = buildCoord();
  const r = await fn(1, "img1", ["a", 10], "image.png", "base64bytes");
  ok(r.content[0].text.includes("must be [x, y] numbers"), "non-numeric coordinate rejected");
}

console.log("== preflight refusal ==");
{
  const { fn, cdpCalls } = buildCoord({ node: null });
  const r = await fn(1, "img1", [10, 20], "image.png", "base64bytes");
  ok(r.content[0].text.includes("No droppable target"), "a coordinate with no node under it refuses before dispatch");
  ok(!cdpCalls.some((c) => c.method.startsWith("Input.dispatchDragEvent")), "no drag dispatched on refusal");
}

console.log("== trusted drop delivery ==");
{
  const { fn, cdpCalls } = buildCoord();
  const r = await fn(1, "img1", [10, 20], "pic.png", "base64bytes");
  const drags = cdpCalls.filter((c) => c.method === "Input.dispatchDragEvent");
  ok(
    drags.length === 2 && drags[0].params.type === "dragEnter" && drags[1].params.type === "drop",
    "dragEnter then drop, in order"
  );
  ok(
    drags[0].params.data.files.length === 1 && drags[0].params.x === 10 && drags[0].params.y === 20,
    "the staged file travels in the drag data at the converted position"
  );
  ok(r.content[0].text.includes("Dropped pic.png (img1) at (10, 20)"), "delivery reported with position");
}

console.log("== dispatch failure ==");
{
  const { fn } = buildCoord({ dragThrows: true });
  const r = await fn(1, "img1", [10, 20], "pic.png", "base64bytes");
  ok(r.content[0].text.includes("did not accept the image"), "a refused drop reports failure, not success");
}

// --- handler addressing modes --------------------------------------------------
console.log("== handler addressing modes ==");
{
  const api = [];
  globalThis.chrome = {
    tabs: {
      get: async (id) => {
        api.push(["tabs.get", id]);
        if (id === 999) throw new Error("No tab with id");
        return { id, url: "https://example.com/" };
      },
    },
  };
  const isInGroup = async () => true;
  const screenshotStore = new Map([["img1", "base64bytes"]]);
  const ensureAttached = async () => {};
  const ensureDomain = async () => {};
  const sendContentMessage = async (tabId, msg) => {
    if (msg.type === "markElementForUpload") return { ok: true, isFileInput: false, tag: "div" };
    return { ok: true };
  };
  const inner = compile(coordSrc, {
    screenshotToCssCoordinate: (tabId, pair) => pair,
    nativeRequest: async () => "/tmp/staged.png",
    cdp: async () => ({ backendNodeId: 7 }),
  }, "{ uploadImageAtCoordinate }").uploadImageAtCoordinate;

  const src = `const H_upload_image = { ${extractMethod("upload_image")} };`;
  const mk = new Function(
    "chrome", "isInGroup", "screenshotStore", "ensureAttached", "ensureDomain",
    "sendContentMessage", "nativeRequest", "cdp", "screenshotToCssCoordinate", "uploadImageAtCoordinate",
    `${src}; return H_upload_image;`
  );
  const H = mk(
    globalThis.chrome, isInGroup, screenshotStore, ensureAttached, ensureDomain,
    sendContentMessage, async () => "/tmp/staged.png", async () => ({}),
    (tabId, pair) => pair, inner
  );

  const neither = await H.upload_image({ imageId: "img1", tabId: 1 });
  ok(neither.content[0].text.includes("'ref'") && neither.content[0].text.includes("'coordinate'"), "neither mode names both accepted modes");

  const both = await H.upload_image({ imageId: "img1", tabId: 1, ref: "ref_1", coordinate: [1, 2] });
  ok(both.content[0].text.includes("not both"), "both modes together are refused, never mixed");

  const unknown = await H.upload_image({ imageId: "nope", tabId: 1, coordinate: [1, 2] });
  ok(unknown.content[0].text.includes("not found"), "unknown image id reported before any staging");

  const mismatch = await H.upload_image({ imageId: "img1", tabId: 1, ref: "ref_1" });
  ok(
    mismatch.content[0].text.includes("not a file input") && mismatch.content[0].text.includes("coordinate"),
    "a ref resolving to a non-file-input names the coordinate mode"
  );
  delete globalThis.chrome;
}

console.log(fail === 0 ? "\nALL UPLOAD IMAGE TESTS PASSED" : `\n${fail} FAILED`);
process.exit(fail ? 1 : 0);
