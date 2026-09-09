// PDF -> rendered pages (Preview) and extracted text (Markdown), on pdf.js.
//
// pdf.js is the one viewer library actually vendored: a PDF is a page
// description language, not a document tree, and nothing short of a real
// implementation renders one. The build used is the `legacy` one, verified to
// contain no `eval(` and no `new Function(` — the two things Manifest V3's
// content security policy refuses.
//
// Both the module and its worker are loaded from `extension/vendor/`; the
// worker path must be set explicitly because pdf.js otherwise resolves it
// against a CDN, which the extension's CSP blocks and which would put the
// operator's document on someone else's network path.

let pdfjsPromise = null;

function loadPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import("../../vendor/pdf.min.mjs").then((pdfjs) => {
      pdfjs.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("vendor/pdf.worker.min.mjs");
      return pdfjs;
    });
  }
  return pdfjsPromise;
}

/**
 * Load one document, returning both the proxy and the loading task.
 *
 * The task, not the document proxy, owns teardown: `PDFDocumentProxy` has no
 * `destroy()` in pdf.js 6 — calling one throws and leaves the worker holding
 * the document forever, which is exactly what a first pass here did.
 *
 * `bytes` is copied because pdf.js transfers the buffer it is given to its
 * worker, which detaches it — and the same bytes are still needed by the
 * download button and by the other tab.
 */
async function openDocument(bytes) {
  const pdfjs = await loadPdfjs();
  const task = pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false, useSystemFonts: true });
  const doc = await task.promise;
  return { doc, task };
}

/**
 * Render every page into canvases appended to `container`.
 *
 * @param {Uint8Array} bytes
 * @param {HTMLElement} container
 * @param {{width?: number, signal?: AbortSignal}} [opts] - `width` is the CSS
 *   width available; pages are scaled to it. `signal` aborts a long render
 *   when the operator closes the viewer mid-way.
 */
export async function renderPdfPages(bytes, container, { width = 640, signal } = {}) {
  const { doc, task } = await openDocument(bytes);
  try {
    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
      if (signal && signal.aborted) return;
      const page = await doc.getPage(pageNumber);
      const unscaled = page.getViewport({ scale: 1 });
      // Render at the device pixel ratio so text is sharp on a HiDPI screen,
      // then let CSS scale the canvas back down to its layout size.
      const scale = width / unscaled.width;
      const ratio = Math.min(self.devicePixelRatio || 1, 2);
      const viewport = page.getViewport({ scale: scale * ratio });

      const canvas = document.createElement("canvas");
      canvas.className = "doc-pdf-page";
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      canvas.style.width = `${Math.floor(viewport.width / ratio)}px`;
      canvas.style.height = `${Math.floor(viewport.height / ratio)}px`;
      container.appendChild(canvas);

      await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
      page.cleanup();
    }
  } finally {
    task.destroy();
  }
}

/**
 * The document's text, one markdown section per page.
 *
 * pdf.js returns positioned text items, not lines: a PDF has no concept of a
 * paragraph. Items are grouped by their baseline so the extraction reads as
 * lines rather than as one unbroken string.
 */
export async function pdfToText(bytes) {
  const { doc, task } = await openDocument(bytes);
  try {
    const pages = [];
    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
      const page = await doc.getPage(pageNumber);
      const content = await page.getTextContent();
      const lines = [];
      let currentY = null;
      let current = [];
      for (const item of content.items) {
        if (typeof item.str !== "string") continue;
        const y = item.transform ? Math.round(item.transform[5]) : 0;
        // A new baseline more than a couple of points away starts a new line;
        // small jitter within a line must not split it.
        if (currentY === null || Math.abs(y - currentY) <= 2) {
          current.push(item.str);
          currentY = currentY === null ? y : currentY;
        } else {
          lines.push(current.join("").trim());
          current = [item.str];
          currentY = y;
        }
        if (item.hasEOL) {
          lines.push(current.join("").trim());
          current = [];
          currentY = null;
        }
      }
      if (current.length) lines.push(current.join("").trim());
      page.cleanup();
      pages.push(`## Trang ${pageNumber}\n\n${lines.filter(Boolean).join("\n")}`);
    }
    return pages.join("\n\n");
  } finally {
    task.destroy();
  }
}
