// Markdown -> PowerPoint (.pptx), using `pptxgenjs`.
//
// Slide model: every top-level heading starts a new slide, its text becomes
// the slide title, and everything until the next heading becomes that slide's
// body — bullets from list items, one bullet per paragraph otherwise. A source
// with no headings becomes a single slide titled with the document title, so a
// run that picked this format always gets an openable deck.
//
// Note on the dependency: `pptxgenjs` pulls in `image-size`, which carries a
// DoS advisory in its ICNS/JXL/HEIF parsers. That parser only runs when an
// image is added to a slide. Nothing here ever adds an image — the deck is
// built from the run's text alone — so the vulnerable path is not reachable
// through this module.

import { parseMarkdownBlocks, inlineToPlainText } from "./markdown-ast.js";

const MAX_BULLETS_PER_SLIDE = 12;

export async function markdownToPptx(source, meta = {}) {
  const PptxGenJS = (await import("pptxgenjs")).default;
  const pptx = new PptxGenJS();
  pptx.layout = "LAYOUT_16x9";
  if (meta.title) pptx.title = String(meta.title);

  // A master with a real title placeholder, so each slide's title is written
  // as <p:ph type="title"/> rather than as an anonymous text box. Without it
  // the title is structurally indistinguishable from a bullet, and any reader
  // — PowerPoint's own outline view included — loses it.
  pptx.defineSlideMaster({
    title: "BROWZY_MASTER",
    objects: [
      {
        placeholder: {
          options: { name: "title", type: "title", x: 0.5, y: 0.35, w: 9, h: 0.9, fontSize: 28, bold: true, color: "1A1A1A" },
          text: ""
        }
      }
    ]
  });

  const slides = buildSlideModel(parseMarkdownBlocks(source), meta.title);
  for (const model of slides) {
    const slide = pptx.addSlide({ masterName: "BROWZY_MASTER" });
    slide.addText(model.title, { placeholder: "title" });
    if (model.bullets.length) {
      slide.addText(
        model.bullets.map((b) => ({ text: b.text, options: { bullet: true, indentLevel: Math.min(b.depth, 4) } })),
        { x: 0.6, y: 1.4, w: 8.8, h: 4.2, fontSize: 16, color: "333333", valign: "top" }
      );
    }
  }

  // pptxgenjs resolves to a Node Buffer for outputType "nodebuffer".
  const out = await pptx.write({ outputType: "nodebuffer" });
  return Buffer.isBuffer(out) ? out : Buffer.from(out);
}

/**
 * Group blocks into slides. Exported for the generator's own tests: the
 * grouping rule is the part worth asserting, independently of pptxgenjs.
 */
export function buildSlideModel(blocks, documentTitle) {
  const slides = [];
  let current = null;

  const open = (title) => {
    current = { title: title || String(documentTitle || "Document"), bullets: [] };
    slides.push(current);
  };
  const push = (text, depth = 0) => {
    const clean = inlineToPlainText(text).trim();
    if (!clean) return;
    if (!current) open(null);
    // Overflow starts a continuation slide rather than letting text run off
    // the bottom of the layout, where the operator would never see it.
    if (current.bullets.length >= MAX_BULLETS_PER_SLIDE) {
      const continued = `${current.title} (tiếp)`;
      open(continued);
    }
    current.bullets.push({ text: clean, depth });
  };

  for (const block of blocks) {
    switch (block.type) {
      case "heading":
        if (block.level <= 2 || !current) open(inlineToPlainText(block.text));
        else push(inlineToPlainText(block.text));
        break;
      case "list":
        for (const item of block.items) push(item.text, item.depth);
        break;
      case "paragraph":
        push(block.text);
        break;
      case "table":
        // A table on a slide reads as a list of rows; a real table shape would
        // need column widths this model does not carry.
        push(block.header.map(inlineToPlainText).join(" | "));
        for (const row of block.rows) push(row.map(inlineToPlainText).join(" | "), 1);
        break;
      case "code":
        for (const line of block.text.split("\n")) push(line, 1);
        break;
      default:
        break;
    }
  }

  if (!slides.length) open(null);
  return slides;
}
