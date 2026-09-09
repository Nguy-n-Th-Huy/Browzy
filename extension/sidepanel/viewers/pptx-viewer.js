// PowerPoint (.pptx) -> a title and bullets per slide.
//
// This is an EXTRACTION, and the UI says so rather than presenting it as a
// render. There is no faithful PowerPoint renderer that runs in a browser
// without shipping a layout engine: a real slide is absolute positions,
// theme-inherited fonts, masters, layouts, transforms and embedded media.
// What a reader actually needs from a generated deck — what each slide says —
// is fully recoverable from the text frames, and that is what this returns.
//
// Each `ppt/slides/slideN.xml` holds shapes (`p:sp`); a shape's text body
// (`p:txBody`) holds paragraphs (`a:p`) of runs (`a:t`). The first shape whose
// placeholder type is a title is the slide title; every other non-empty
// paragraph is a bullet, at the indent level its `lvl` attribute declares.

import { openContainer, entryText, parseXml, entryNames, descendantsNamed, attr } from "./ooxml.js";

/**
 * @returns {Promise<Array<{title: string, bullets: string[], levels: number[]}>>}
 */
export async function pptxToSlides(bytes) {
  const entries = openContainer(bytes);
  const names = entryNames(entries, /^ppt\/slides\/slide\d+\.xml$/);
  if (!names.length) throw new Error("không tìm thấy slide nào trong tệp");

  const slides = [];
  for (const name of names) {
    const xml = entryText(entries, name);
    if (!xml) continue;
    slides.push(readSlide(parseXml(xml)));
  }
  return slides;
}

function readSlide(doc) {
  let title = "";
  const bullets = [];
  const levels = [];

  for (const shape of descendantsNamed(doc.documentElement, "sp")) {
    const isTitle = shapeIsTitle(shape);
    for (const paragraph of descendantsNamed(shape, "p")) {
      const text = descendantsNamed(paragraph, "t")
        .map((t) => t.textContent || "")
        .join("")
        .trim();
      if (!text) continue;
      if (isTitle && !title) {
        title = text;
        continue;
      }
      const properties = descendantsNamed(paragraph, "pPr")[0];
      const level = properties ? Number(attr(properties, "lvl") || 0) : 0;
      bullets.push(text);
      levels.push(Number.isFinite(level) ? level : 0);
    }
  }
  // A deck whose shapes carry no title placeholder — which is what a generator
  // that draws plain text boxes produces, and what several exporters produce —
  // would otherwise show every slide as an untitled list. The first line of a
  // slide is what a reader treats as its title anyway, so promote it.
  if (!title && bullets.length) {
    title = bullets.shift();
    levels.shift();
  }
  return { title, bullets, levels };
}

function shapeIsTitle(shape) {
  for (const placeholder of descendantsNamed(shape, "ph")) {
    const type = attr(placeholder, "type");
    if (type === "title" || type === "ctrTitle") return true;
  }
  return false;
}
