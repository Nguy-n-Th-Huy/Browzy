// Content script for the Browzy extension.
// Injected into every page. Provides:
// - Accessibility tree generation (read_page)
// - Element ref mapping with WeakRef (persistent across calls)
// - Form input handling
// - Page text extraction
// - Element finding by text/attributes
// - SPA route/document-identity tracking for live-extraction staleness
//   (design.md 5b / task 5.6: "Track URL/route changes and document
//   lifecycle, including SPA updates; invalidate stale element references
//   on change.")

(function () {
  // A copy of this script may already be running in this document. There are
  // two cases, and the old "already loaded -> bail" guard got the second one
  // catastrophically wrong.
  //
  //   1. A genuine double injection inside one extension lifetime (background
  //      re-injects after a sendMessage failure). The existing copy is alive
  //      and working; the new one must not add a second listener, or every
  //      message would be handled twice — setFormValue twice, a click probed
  //      twice.
  //   2. The extension was RELOADED while this page stayed open. Chrome
  //      invalidates the old copy's context: its onMessage listener is dead and
  //      receives nothing. But the flag it set lives on `window` in the
  //      isolated world, whose lifetime is the PAGE's, not the extension's.
  //
  // In case 2 the old guard saw the stale flag and returned immediately, so the
  // freshly injected copy never registered a listener — and the document was
  // left permanently without a working content script. Every read_page,
  // get_page_text, find and hit-probe then returned nothing at all, which is
  // indistinguishable from "the page has no such element". The agent is left
  // with only the CDP-level tools (screenshot, synthetic input), so it cannot
  // locate anything by name and falls back to guessing coordinates off the
  // picture — clicking, missing, nudging a few pixels, clicking again.
  //
  // Disposing rather than bailing handles both. In case 1 the disposer runs and
  // removes the live listener, and we register exactly one fresh one. In case 2
  // the old closure's `chrome.runtime` is invalidated so the call throws, we
  // swallow it, and register the listener this document has been missing.
  try {
    window.__unblockedChromeDispose?.();
  } catch {
    // Old context already invalidated — nothing to remove, which is the point.
  }
  window.__unblockedChromeLoaded = true;

  // --- Element reference map ---
  // Persistent ref IDs stored as WeakRefs so GC still works
  let refCounter = 0;
  const elementMap = {}; // refId -> WeakRef<Element>
  const reverseMap = new WeakMap(); // Element -> refId

  // High-water mark on refCounter, recorded once a read_page/find call
  // finishes reading this document. "First seen since the previous read" is
  // then just "this element's ref number is above where the counter stood
  // when that read ended" — no second copy of the tree needs to be kept and
  // diffed against the live DOM to answer that question.
  //
  // null means "no read has completed yet for this document" (see
  // bumpDocumentEpoch below, which resets it on navigation/SPA route
  // change), and is what makes the first read of a document mark nothing:
  // there is no previous read for anything to be new relative to.
  let readWatermark = null;

  // --- Document/SPA identity tracking ---
  //
  // A full page reload/navigation resets this content script for free (the
  // `window.__unblockedChromeLoaded` guard above means a fresh navigation
  // gets a brand new JS context, with `documentEpoch` back at 0 and
  // `elementMap` empty) — the real gap this closes is a Single Page App
  // that swaps its own DOM via the History API without ever reloading the
  // document, which would otherwise leave every previously-handed-out
  // element ref silently pointing at stale/detached nodes.
  let documentEpoch = 0;
  let lastKnownUrl = location.href;

  // Per-document nonce (design.md "upgrade-agent-reliability-and-workflows"
  // decision 6 / tasks.md 1.2): the content-script half of the document-
  // identity handshake extension/events/document-identity.js's
  // DocumentBindingTracker confirms against. Held on the isolated-world
  // `window` (like `__unblockedChromeLoaded` above) rather than a plain
  // closure variable so it SURVIVES a content-script re-injection (case 1/2
  // above — an extension reload while this page stays open) without
  // minting a spurious "new document" for a document that never actually
  // changed. It is still genuinely PER-DOCUMENT: the isolated world is
  // destroyed and rebuilt on every real navigation exactly like the main
  // world is (gate-1.1 G3/G4: an in-memory value is correctly LOST on tab
  // close+reopen and on a real browser restart). NEVER put this in
  // localStorage — G3/G4 both confirmed localStorage (disk-backed, per
  // origin) wrongly SURVIVES both, which would silently defeat the whole
  // mechanism. Invisible to page scripts: isolated-world `window`
  // properties are not reachable from the page's own JS realm.
  window.__unblockedChromeDocNonce = window.__unblockedChromeDocNonce || crypto.randomUUID();
  const documentNonce = window.__unblockedChromeDocNonce;

  /** Bump the document identity and invalidate every outstanding element
   * ref — real refs, not a copy: deletes each key from the SAME `elementMap`
   * `resolveRef`/`getOrAssignRef` read from, so anything already holding a
   * ref (find/read_page/computer's scroll_to/form_input) sees it vanish
   * immediately on the next resolve. */
  function bumpDocumentEpoch() {
    documentEpoch++;
    for (const k of Object.keys(elementMap)) delete elementMap[k];
    // Every element on the new document is new by definition, so marking all
    // of them would carry no information — clear the watermark rather than
    // leaving it pointing at a ref count that belonged to a document that no
    // longer exists. This is the one and only place that decides "this is a
    // different document" (both for a real navigation and for an SPA route
    // change), so resetting the watermark here — instead of a second,
    // independent URL comparison inside generateAccessibilityTree/
    // findElements — keeps that decision owned in one place.
    readWatermark = null;
    // The labels on screen name refs that were just deleted above, so leaving
    // them up would point the operator — and the assistant reading its own
    // screenshot — at identifiers nothing resolves any more, positioned for a
    // layout that is gone. They outlive a capture, not a document.
    try {
      clearAnnotation();
    } catch {}
  }

  /** Wrap history.pushState/replaceState and listen for popstate/hashchange
   * so a route change bumps document identity even though the browser never
   * reloads the document for a client-side-routed SPA. */
  function installSpaTracking() {
    const wrapHistoryMethod = (name) => {
      const original = history[name];
      if (typeof original !== "function") return;
      history[name] = function (...args) {
        const before = location.href;
        const result = original.apply(this, args);
        if (location.href !== before) {
          lastKnownUrl = location.href;
          bumpDocumentEpoch();
        }
        return result;
      };
    };
    wrapHistoryMethod("pushState");
    wrapHistoryMethod("replaceState");
    const onUrlEvent = () => {
      if (location.href !== lastKnownUrl) {
        lastKnownUrl = location.href;
        bumpDocumentEpoch();
      }
    };
    window.addEventListener("popstate", onUrlEvent);
    window.addEventListener("hashchange", onUrlEvent);
  }
  installSpaTracking();

  function getOrAssignRef(el) {
    const existing = reverseMap.get(el);
    if (existing && elementMap[existing]?.deref() === el) return existing;
    const ref = `ref_${++refCounter}`;
    elementMap[ref] = new WeakRef(el);
    reverseMap.set(el, ref);
    return ref;
  }

  function resolveRef(refId) {
    const wr = elementMap[refId];
    if (!wr) return null;
    const el = wr.deref();
    if (!el) {
      delete elementMap[refId];
      return null;
    }
    return el;
  }

  /** Parse the numeric suffix off a "ref_N" id, for comparing against
   * readWatermark. Returns -1 for anything not in that shape (should never
   * happen — every ref this script hands out is minted by getOrAssignRef
   * above) so a malformed id can never be mistaken for "new". */
  function refNumber(refId) {
    const m = /^ref_(\d+)$/.exec(refId);
    return m ? Number(m[1]) : -1;
  }

  // --- ARIA role mapping ---
  const TAG_TO_ROLE = {
    a: "link",
    button: "button",
    input: "textbox",
    textarea: "textbox",
    select: "combobox",
    img: "img",
    h1: "heading",
    h2: "heading",
    h3: "heading",
    h4: "heading",
    h5: "heading",
    h6: "heading",
    nav: "navigation",
    main: "main",
    header: "banner",
    footer: "contentinfo",
    aside: "complementary",
    form: "form",
    table: "table",
    tr: "row",
    th: "columnheader",
    td: "cell",
    ul: "list",
    ol: "list",
    li: "listitem",
    dialog: "dialog",
    details: "group",
    summary: "button",
    progress: "progressbar",
    meter: "meter",
    video: "video",
    audio: "audio",
    section: "region",
    article: "article",
  };

  function getRole(el) {
    if (el.getAttribute("role")) return el.getAttribute("role");
    const tag = el.tagName.toLowerCase();
    if (tag === "input") {
      const type = (el.type || "text").toLowerCase();
      const typeRoles = {
        checkbox: "checkbox",
        radio: "radio",
        range: "slider",
        button: "button",
        submit: "button",
        reset: "button",
        search: "searchbox",
        number: "spinbutton",
      };
      return typeRoles[type] || "textbox";
    }
    return TAG_TO_ROLE[tag] || null;
  }

  // --- Accessible name ---
  function getAccessibleName(el) {
    // Priority: aria-label > aria-labelledby > placeholder > title > alt > label > text
    const ariaLabel = el.getAttribute("aria-label");
    if (ariaLabel) return ariaLabel.trim();

    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      const names = labelledBy
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent?.trim())
        .filter(Boolean);
      if (names.length) return names.join(" ");
    }

    // A submit/button/reset input carries its label in `value` and nowhere
    // else: no text content, no placeholder, no title. Without this it has no
    // accessible name at all, so searching a form for the words written on its
    // own button — "Tìm kiếm" — returned every <label> on the form and never
    // the button, and the same query was repeated three times over.
    if (el.tagName.toLowerCase() === "input") {
      const inputType = (typeof el.type === "string" ? el.type : "").toLowerCase();
      if (["submit", "button", "reset"].includes(inputType)) {
        const value = typeof el.value === "string" ? el.value.trim() : "";
        if (value) return value;
      }
    }

    // typeof guards: a <form> (or <fieldset>) exposes its named controls as
    // properties via a [LegacyOverrideBuiltIns] named getter, so an
    // <input name="title"> makes form.title the ELEMENT, not the string —
    // and .trim() on it throws, taking down read_page/find for the whole
    // page. Same shadowing applies to placeholder and alt.
    if (typeof el.placeholder === "string" && el.placeholder) return el.placeholder.trim();
    if (typeof el.title === "string" && el.title) return el.title.trim();
    if (typeof el.alt === "string" && el.alt) return el.alt.trim();

    // Associated <label>
    if (el.id) {
      const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (label) return label.textContent.trim();
    }
    if (el.closest("label")) {
      const labelText = el.closest("label").textContent.trim();
      if (labelText) return labelText;
    }

    // Direct text content (only for leaf-ish elements)
    const tag = el.tagName.toLowerCase();
    if (["a", "button", "h1", "h2", "h3", "h4", "h5", "h6", "li", "summary", "label", "th", "td", "span"].includes(tag)) {
      const text = el.textContent?.trim();
      if (text && text.length < 200) return text;
    }

    return "";
  }

  // --- Interactivity check ---
  function isInteractive(el) {
    const tag = el.tagName.toLowerCase();
    if (["a", "button", "input", "textarea", "select", "summary", "details"].includes(tag)) return true;
    if (el.getAttribute("role") && ["button", "link", "textbox", "checkbox", "radio", "tab", "menuitem", "switch", "combobox", "slider", "spinbutton", "searchbox", "option"].includes(el.getAttribute("role"))) return true;
    if (el.tabIndex >= 0) return true;
    if (el.onclick || el.getAttribute("onclick")) return true;
    if (el.contentEditable === "true") return true;
    return false;
  }

  // --- Visibility check ---
  function isVisible(el) {
    if (el.offsetParent === null && el.tagName.toLowerCase() !== "body" && getComputedStyle(el).position !== "fixed") return false;
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") return false;
    return true;
  }

  // --- Screenshot annotation layer ---
  //
  // Draws an outline plus a label over every interactive element in the
  // viewport, so a screenshot the assistant is already looking at carries the
  // same `ref_N` identifiers find/read_page return. The label IS the existing
  // reference — no second identity is invented — so a ref read off the picture
  // resolves, scrolls into view and hit-tests through exactly the same
  // resolveRefToCoordinates path a ref from a page read does.
  //
  // Everything drawn lives in ONE container with a fixed id, pinned at the
  // maximum z-index and `pointer-events: none`. That container is excluded
  // from every walk this script performs (generateAccessibilityTree,
  // findElements, and the annotation walk itself) so its nodes can never be
  // mistaken for page content, be annotated in turn, or be handed a ref of
  // their own. Outlines and labels are SEPARATE positioned overlay nodes drawn
  // over the element's rect; the page's own elements are never mutated, so
  // removing the container restores the page exactly as it was.
  const ANNOTATION_CONTAINER_ID = "browzy-annotation-layer";
  // A capture scaled down by `scale` shrinks the label with everything else.
  // Rendering the label at `floor / scale` on the page means it comes back at
  // no less than `floor` image pixels, so the number stays readable. Capped so
  // a 0.1x capture cannot ask for an absurdly large label.
  const ANNOTATION_LABEL_FLOOR_PX = 12;
  const ANNOTATION_LABEL_MAX_PX = 120;
  // The live container, so a teardown can remove it even if a lookup by id is
  // unavailable; getElementById remains the fallback for a re-injected script
  // whose closure lost the reference but whose container is still in the DOM.
  let annotationContainer = null;

  /** The on-page font size for an annotation label, given the capture's
   * effective scale, so the label survives downscaling at the legibility
   * floor. Pure, so it is directly assertable. */
  function annotationLabelFontPx(scale) {
    const s = Number(scale);
    const effective = Number.isFinite(s) && s > 0 && s < 1 ? s : 1;
    return Math.min(
      ANNOTATION_LABEL_MAX_PX,
      Math.max(ANNOTATION_LABEL_FLOOR_PX, Math.ceil(ANNOTATION_LABEL_FLOOR_PX / effective))
    );
  }

  /** True for the annotation container and anything inside it. Walks
   * parentNode rather than relying on closest(), so the tree walk, the find
   * path and the annotation walk all agree on what counts as annotation. */
  function isAnnotationNode(el) {
    if (!el) return false;
    if (el.id === ANNOTATION_CONTAINER_ID) return true;
    for (let n = el.parentNode || el.parentElement; n; n = n.parentNode || n.parentElement) {
      if (n.id === ANNOTATION_CONTAINER_ID) return true;
    }
    return false;
  }

  /** Remove the annotation container. Safe to call when nothing was drawn. */
  function clearAnnotation() {
    const container =
      (annotationContainer && annotationContainer.parentNode && annotationContainer) ||
      (typeof document.getElementById === "function" && document.getElementById(ANNOTATION_CONTAINER_ID)) ||
      null;
    const removed = !!(container && container.parentNode);
    if (removed) container.parentNode.removeChild(container);
    annotationContainer = null;
    return { cleared: removed };
  }

  /** Draw the annotation layer. `options.scale` is the capture's effective
   * scale, folded into label sizing. Returns a small report, never throws for
   * a page-level reason (the caller wraps it so a failure can never fail a
   * capture). */
  function drawAnnotation(options = {}) {
    // Built detached and swapped in at the end — see the swap below. Clearing
    // first, as this used to, left the page with no layer at all while the
    // walk ran, and appending the container before the walk made the boxes
    // pop in one at a time on top of that. Every capture therefore flashed:
    // gone, then redrawn piece by piece. Now the page holds the previous
    // layer until the replacement is complete, so a redraw is invisible.
    const fontPx = annotationLabelFontPx(options.scale);
    const vw = window.innerWidth || 0;
    const vh = window.innerHeight || 0;

    const container = document.createElement("div");
    container.id = ANNOTATION_CONTAINER_ID;
    container.setAttribute("data-browzy-annotation", "1");
    Object.assign(container.style, {
      position: "fixed",
      left: "0",
      top: "0",
      width: "0",
      height: "0",
      margin: "0",
      padding: "0",
      border: "0",
      background: "transparent",
      zIndex: "2147483647",
      pointerEvents: "none"
    });

    let drawn = 0;

    function drawOne(el, rect) {
      // The SAME ref the element already has (or would be given by a page
      // read): labels are existing references, never a second identity.
      const ref = getOrAssignRef(el);

      const outline = document.createElement("div");
      outline.className = "browzy-annotation-outline";
      Object.assign(outline.style, {
        position: "absolute",
        left: `${Math.round(rect.left)}px`,
        top: `${Math.round(rect.top)}px`,
        width: `${Math.round(rect.width)}px`,
        height: `${Math.round(rect.height)}px`,
        boxSizing: "border-box",
        border: "2px solid #e11d48",
        borderRadius: "2px",
        background: "transparent",
        pointerEvents: "none"
      });
      container.appendChild(outline);

      const label = document.createElement("div");
      label.className = "browzy-annotation-label";
      label.textContent = ref;
      // Keep the label attached to its element and readable: sit it at the
      // element's top-left (above it when there is room), never off-viewport.
      // A target smaller than its own label still gets a readable label at the
      // same corner, so the number is identifiably its own.
      // INSIDE its own box, top-right — never floating above it.
      //
      // Placing the label above the element put it visually on top of whatever
      // sat higher up the page: the number for a text input landed on the
      // field's caption, and the number for a nav item landed on the logo
      // above it. A reader — and a model reading the picture — attaches a
      // label to the thing it overlaps, so it picked the ref of the element
      // ABOVE the one it meant, and the click went there. The label has to be
      // visibly part of the box it names, which means inside it.
      //
      // Outside is the fallback only for a target smaller than its own label,
      // where inside would cover the control entirely.
      const approxWidth = Math.ceil(ref.length * fontPx * 0.62) + 10;
      const approxHeight = fontPx + 4;
      const fitsInside = rect.width >= approxWidth + 4 && rect.height >= approxHeight + 4;
      let labelLeft;
      let labelTop;
      if (fitsInside) {
        labelLeft = Math.round(rect.right) - approxWidth - 2;
        labelTop = Math.round(rect.top) + 2;
      } else {
        // Too small to hold the label: sit it just above, and accept the
        // ambiguity for a target this size rather than hide the control.
        labelLeft = Math.round(rect.left);
        labelTop = Math.round(rect.top) - approxHeight - 2;
        if (labelTop < 0) labelTop = Math.round(rect.bottom) + 2;
      }
      if (labelLeft + approxWidth > vw) labelLeft = vw - approxWidth;
      if (labelLeft < 0) labelLeft = 0;
      if (labelTop < 0) labelTop = 0;
      Object.assign(label.style, {
        position: "absolute",
        left: `${labelLeft}px`,
        top: `${labelTop}px`,
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
        fontSize: `${fontPx}px`,
        lineHeight: "1",
        color: "#ffffff",
        background: "#e11d48",
        padding: "2px 5px",
        borderRadius: "3px",
        whiteSpace: "nowrap",
        pointerEvents: "none"
      });
      container.appendChild(label);
      drawn++;
    }

    function visit(el) {
      if (!el || el.nodeType !== 1) return;
      // Never walk into the container's own nodes — that is how a second
      // capture would draw boxes around the boxes.
      if (isAnnotationNode(el)) return;
      const tag = el.tagName.toLowerCase();
      if (["script", "style", "noscript", "template"].includes(tag)) return;

      if (isInteractive(el) && isVisible(el)) {
        const rect = el.getBoundingClientRect();
        if (
          rect.width >= 1 &&
          rect.height >= 1 &&
          rect.right > 0 &&
          rect.bottom > 0 &&
          rect.left < vw &&
          rect.top < vh
        ) {
          drawOne(el, rect);
        }
      }

      // Same shadow-DOM traversal generateAccessibilityTree uses, so a
      // control inside a shadow root is annotated too.
      if (el.shadowRoot) {
        for (const child of el.shadowRoot.children) visit(child);
      }
      for (const child of el.children) visit(child);
    }

    // Walk the page while the NEW container is still detached: nothing the
    // walk can reach belongs to it, so it cannot annotate itself, and the
    // previous layer — still in the document and still excluded by id — keeps
    // the page looking unchanged meanwhile.
    const root = document.documentElement || document.body;
    if (root) visit(root);

    // The swap, in one synchronous step so the browser paints the old layer or
    // the new one and never the gap between them.
    clearAnnotation();
    if (root) root.appendChild(container);
    annotationContainer = container;

    return { drawn, containerId: ANNOTATION_CONTAINER_ID, labelFontPx: fontPx };
  }

  // --- Accessibility tree generation ---
  function generateAccessibilityTree(options = {}) {
    const filter = options.filter || "all";
    const maxDepth = options.depth || 15;
    const maxChars = options.max_chars || 50000;
    const startRefId = options.ref_id || null;
    // Snapshot once, before any ref in this call is assigned — getOrAssignRef
    // below can advance refCounter mid-walk, and comparing against a moving
    // target would make an element marked "new" only because an earlier
    // sibling in the same walk happened to be serialized first.
    const watermarkAtStart = readWatermark;

    let output = "";
    let charCount = 0;
    let truncated = false;

    function append(text) {
      if (truncated) return false;
      if (charCount + text.length > maxChars) {
        output += text.substring(0, maxChars - charCount);
        output += "\n... (truncated)";
        truncated = true;
        return false;
      }
      output += text;
      charCount += text.length;
      return true;
    }

    function walk(el, depth, indent) {
      if (truncated) return;
      if (depth > maxDepth) return;
      if (!el || el.nodeType !== 1) return;
      // The screenshot-annotation container and everything in it is not page
      // content: a read_page taken straight after an annotated capture must
      // contain no trace of the labels.
      if (isAnnotationNode(el)) return;

      const tag = el.tagName.toLowerCase();
      // Skip invisible, script, style, svg internals
      if (["script", "style", "noscript", "template"].includes(tag)) return;

      const role = getRole(el);
      const name = getAccessibleName(el);
      const interactive = isInteractive(el);
      const visible = isVisible(el);

      // Filter: if interactive-only mode, skip non-interactive non-container elements
      const isContainer = el.children.length > 0;
      if (filter === "interactive" && !interactive && !isContainer) return;

      const shouldShow =
        (filter === "all" && (role || name)) ||
        (filter === "interactive" && interactive);

      if (shouldShow && visible) {
        const ref = getOrAssignRef(el);
        let line = `${indent}`;

        if (role) line += `${role}`;
        if (name) line += ` "${name.substring(0, 100)}"`;
        // A "*" directly before the bracket says this element's ref did not
        // exist as of the previous read of this document — refs are handed
        // out from one monotonic counter, so "new since last read" is
        // exactly "this ref's number is above the watermark recorded when
        // that read finished" (see readWatermark's definition above). The
        // ref string itself is untouched either way: still plain `ref_N`,
        // because the marker is state ABOUT the element for this rendering,
        // not part of the element's identity — it gets passed back into
        // computer/form_input verbatim and must resolve the same regardless
        // of whether it was marked.
        const isNew = watermarkAtStart !== null && refNumber(ref) > watermarkAtStart;
        line += isNew ? ` *[${ref}]` : ` [${ref}]`;

        // Extra info for specific elements
        if (tag === "a" && el.href) line += ` href="${el.href}"`;
        if (tag === "img" && el.src) line += ` src="${el.src.substring(0, 100)}"`;
        if (["input", "textarea"].includes(tag) && el.value) line += ` value="${el.value.substring(0, 100)}"`;
        if (tag === "input") line += ` type="${el.type || "text"}"`;
        if (el.getAttribute("aria-expanded")) line += ` expanded=${el.getAttribute("aria-expanded")}`;
        if (el.getAttribute("aria-checked")) line += ` checked=${el.getAttribute("aria-checked")}`;
        if (el.getAttribute("aria-selected")) line += ` selected=${el.getAttribute("aria-selected")}`;
        if (el.disabled) line += " disabled";

        // Select options
        if (tag === "select") {
          const opts = Array.from(el.options).map(
            (o) => `${o.selected ? "*" : " "}${o.value}="${o.textContent.trim()}"`
          );
          if (opts.length) line += ` options=[${opts.join(", ")}]`;
        }

        if (!append(line + "\n")) return;
      }

      // Recurse children (including shadow DOM)
      const nextIndent = shouldShow && visible ? indent + "  " : indent;
      if (el.shadowRoot) {
        for (const child of el.shadowRoot.children) {
          walk(child, depth + 1, nextIndent);
        }
      }
      for (const child of el.children) {
        walk(child, depth + 1, nextIndent);
      }
    }

    let root = document.body;
    if (startRefId) {
      const el = resolveRef(startRefId);
      if (el) root = el;
      else return `Error: ref_id "${startRefId}" not found or element was garbage collected.`;
    }

    walk(root, 0, "");
    // Recorded after the walk, not before: getOrAssignRef above assigns refs
    // LAZILY, only to elements actually serialized during this call. An
    // element that existed but had never been walked gets its first ref
    // right here, and if the watermark were set before the walk that element
    // would look new — recording it after is what keeps "new" meaning the
    // same thing between one read and the next.
    readWatermark = refCounter;
    return output;
  }

  // --- Page text extraction ---
  function getPageText() {
    const selectors = [
      "article",
      "main",
      '[class*="articleBody"]',
      '[class*="post-content"]',
      '[class*="entry-content"]',
      '[role="main"]',
      ".content",
      "#content",
    ];
    // Clean text: remove script/style content, collapse whitespace.
    // The SAME cleaning is applied to both the matched container and
    // document.body so the coverage ratio (design section 9a) compares
    // like-for-like text density.
    function cleanText(el) {
      const c = el.cloneNode(true);
      // design.md D4 (repair-overlay-mount-and-visibility): the overlay
      // host (extension/overlay/pointer-overlay.js) already lives outside
      // document.body, which keeps it out of most extraction here — this is
      // belt-and-suspenders for the fallback case where it does not
      // (createOverlayHost()'s own `doc.documentElement || doc.body`) and
      // for any future light-DOM sibling it grows.
      c.querySelectorAll("script, style, noscript, template, svg, [data-browzy-overlay], [data-browzy-annotation]").forEach((e) => e.remove());
      return c.textContent.replace(/\s+/g, " ").trim();
    }

    /** Cheap length estimate for ranking — no clone, no DOM work. */
    function textLength(el) {
      return (el.textContent || "").replace(/\s+/g, " ").trim().length;
    }

    // A container holding a share this small is not the page's content, whatever
    // its class name says.
    const MIN_CONTAINER_SHARE = 0.1;

    const bodyCleanedText = cleanText(document.body);

    // Take the RICHEST match, not the first one. The old rule stopped at
    // `document.querySelector(sel)`, so on a site whose footer carries a
    // <div class="content"> with the contact details in it, every read of every
    // page returned that footer: "Complete: partial (captured 0% of the page's
    // text)" plus thirty characters of phone number. The caller then fell back
    // to dumping the whole accessibility tree — twice per run — which is the
    // slow, invisible route this tool exists to avoid.
    let source = null;
    let bestLength = 0;
    for (const sel of selectors) {
      for (const el of document.querySelectorAll(sel)) {
        const len = textLength(el);
        if (len > bestLength) {
          bestLength = len;
          source = el;
        }
      }
    }

    // Still implausibly small (or nothing matched at all): the selector list
    // simply does not fit this page, and body is the honest answer.
    let usedBodyFallback = false;
    if (!source || bestLength < bodyCleanedText.length * MIN_CONTAINER_SHARE) {
      source = document.body;
      usedBodyFallback = true;
    }

    const title = document.title || "";
    const url = location.href;
    const tag = source.tagName.toLowerCase();

    const fullText = cleanText(source);
    // Was 100000, which no tool result can carry: one real read of a listing
    // page came back at 100,639 characters, was rejected for exceeding the
    // caller's token ceiling, and got dumped to a file — costing a whole
    // round trip and returning nothing usable. It also stays in the
    // conversation afterwards, so an oversized read is paid for again on
    // every later turn. 30000 is a generous read of an article's text while
    // leaving room for everything else in the same result; `truncated` says
    // plainly when it was not enough, and read_page/find remain the route for
    // pages whose content is structure rather than prose.
    const MAX_CHARS = 30000;
    const truncated = fullText.length > MAX_CHARS;

    // Coverage ratio (design section 9a): the matched container's cleaned
    // text length vs. document.body's cleaned text length. A container
    // that resolved through the fixed selector list yet holds an
    // implausibly small share of the page's total text is a low-confidence
    // extraction — the caller SHOULD report partial, not Complete: yes.
    // Computed for EVERY extraction, not just listing pages. A full-page
    // article container reports coverageRatio near 1.0. When the body
    // fallback was used, coverageRatio is 1.0 by definition (the body IS
    // the source) but must NEVER allow a Complete: yes — see usedBodyFallback.
    const coverageRatio =
      bodyCleanedText.length > 0
        ? fullText.length / bodyCleanedText.length
        : 1.0;

    // capturedAt/documentEpoch tie this specific extraction to a moment and
    // a document identity (design.md 5b: "Extraction returns source URL/
    // title, capture timestamp, and completeness/truncation status. Tie
    // citations/source labels to that capture."). truncated is explicit
    // rather than left for the caller to infer from length alone, so a
    // truncated read is never silently presented as complete. coverageRatio
    // and usedBodyFallback (design section 9a) let background.js report a
    // honest "partial" status instead of claiming Complete: yes when the
    // matched container held only a tiny share of the page's text.
    return JSON.stringify({
      title,
      url,
      sourceTag: tag,
      text: fullText.substring(0, MAX_CHARS),
      truncated,
      capturedAt: new Date().toISOString(),
      documentEpoch,
      coverageRatio,
      usedBodyFallback
    });
  }

  // --- Element finding ---
  // Words that carry no targeting information on their own. A query like
  // "the login button" must not be decided by "the".
  const FIND_STOPWORDS = {
    the: 1, a: 1, an: 1, of: 1, for: 1, to: 1, on: 1, in: 1, at: 1, with: 1,
    and: 1, or: 1, my: 1, this: 1, that: 1, please: 1
  };

  /** Split a natural-language query into the words worth matching on. */
  function findQueryTokens(query) {
    const seen = {};
    const tokens = [];
    // The Ḁ-ỿ range is not optional here: Vietnamese keeps ệ ộ ề ễ ậ
    // and friends in Latin Extended Additional, outside À-ɏ. Leaving
    // it out makes those letters word separators, so "điện tử" tokenizes as
    // "đi", "n", "t" — matching nothing anyone meant.
    for (const raw of String(query).toLowerCase().split(/[^a-z0-9À-ɏḀ-ỿ]+/)) {
      if (raw.length < 2 || FIND_STOPWORDS[raw] || seen[raw]) continue;
      seen[raw] = 1;
      tokens.push(raw);
    }
    return tokens;
  }

  /** How well one element answers the query. 0 means "not a match at all".
   *
   * The old rule was a single `searchable.includes(query)` — a whole-string
   * substring test. That is not what the tool promises ("find elements using
   * natural language"): "advanced search toggle" matched nothing unless those
   * three words appeared consecutively somewhere on the element, so the caller
   * got "No elements found" for an element that was plainly there, and fell
   * back to reading the whole accessibility tree to locate one button. Scoring
   * per word degrades instead: more matched words rank higher, and the
   * accessible name — the thing a person actually reads off the control —
   * counts for more than incidental body text. */
  function scoreFindMatch(tokens, fields) {
    if (tokens.length === 0) return 0;
    // An exact substring hit still wins outright: it is the strongest possible
    // evidence, and it keeps every query that worked before working the same.
    let score = fields.searchable.includes(tokens.join(" ")) ? 1000 : 0;
    let matched = 0;
    for (const t of tokens) {
      if (!fields.searchable.includes(t)) continue;
      matched++;
      score += 10;
      if (fields.name.includes(t)) score += 6;
      if (fields.role.includes(t)) score += 3;
    }
    if (matched === 0) return 0;
    // Every word accounted for is a materially better answer than a partial
    // one, so it must outrank any amount of partial evidence.
    if (matched === tokens.length) score += 100;
    // The caller is nearly always looking for something to act on.
    if (fields.interactive) score += 20;
    // On screen beats off screen, and by a wide margin. Searching a long page
    // for "Nơi thực hiện" returned twenty rows of which seventeen were
    // off-viewport `span "Tự thực hiện"` / "Tham gia thực hiện cộng đồng"
    // scattered thousands of pixels further down, matching on one shared word
    // each. They filled the whole budget, the controls actually on the screen
    // never appeared, and the agent — having asked where the field was and been
    // shown nothing it could use — abandoned the form. An element the caller
    // cannot click right now must not crowd out one it can. Deliberately a
    // ranking bonus and not a filter: sometimes the target really is below the
    // fold, and it should still be findable, just after everything visible.
    if (fields.inViewport) score += 300;
    return score;
  }

  // Controls whose own accessible name routinely says nothing about which
  // field they are. A bare <select>, a text input with only a placeholder, and
  // above all a select2 widget — which hides the real <select> off-page and
  // shows a styled <span> whose only text is a placeholder like "Tìm kiếm theo
  // tỉnh/thành sau sáp nhập". Asking find() for "Nơi thực hiện" returned the
  // <label> and never the thing to click, because no node under that control
  // contains those words anywhere.
  const FIELD_CONTROL_SELECTOR =
    "input, textarea, select, [role='combobox'], [role='listbox']," +
    " .select2-container, .select2-selection";

  /** The visible field label a control sits under, "" when there is none. */
  function fieldLabelText(el) {
    // select2 generates its span as the immediate next sibling of the real
    // <select>; that <select> is what carries the id the <label> points at.
    let owner = el;
    const container = el.closest(".select2-container");
    if (container) {
      const prev = container.previousElementSibling;
      if (prev && prev.tagName.toLowerCase() === "select") owner = prev;
    }

    if (owner.id) {
      const forLabel = document.querySelector(
        `label[for="${CSS.escape(owner.id)}"]`
      );
      const forText = forLabel?.textContent?.trim();
      if (forText) return forText;
    }

    const wrapping = owner.closest("label")?.textContent?.trim();
    if (wrapping) return wrapping;

    // No `for`, no wrapping label — the common case in hand-written Bootstrap
    // forms. Walk up looking for the label that heads this control's row.
    //
    // "The row holds exactly one label" is too strict to be useful: the
    // "Nơi thực hiện" row also carries a checkbox ("Tìm kiếm theo tỉnh/thành
    // sau sáp nhập") with a label of its own, so the count came to two and the
    // field went back to being unnamed. What actually identifies the field
    // label is position — it is the last label BEFORE the control, the
    // checkbox's label sits after it.
    let node = owner.parentElement;
    for (let depth = 0; node && depth < 4; depth++, node = node.parentElement) {
      let lastBefore = null;
      let firstAfter = null;
      for (const label of node.querySelectorAll("label, .control-label")) {
        // A label wrapping the control is that control's own text, not the
        // name of the field it belongs to.
        if (label.contains(owner)) continue;
        const precedes =
          label.compareDocumentPosition(owner) &
          Node.DOCUMENT_POSITION_FOLLOWING;
        if (precedes) lastBefore = label;
        else if (!firstAfter) firstAfter = label;
      }
      const text = (lastBefore || firstAfter)?.textContent?.trim();
      if (text && text.length <= 120) return text;
    }
    return "";
  }

  function findElements(query) {
    const tokens = findQueryTokens(query);
    // Same snapshot-before-assigning-any-ref reasoning as
    // generateAccessibilityTree's watermarkAtStart above — find and read_page
    // deliberately share this one per-document watermark (readWatermark)
    // rather than each keeping its own, so "new" means the same thing no
    // matter which tool the caller used last.
    const watermarkAtStart = readWatermark;
    const scored = [];

    // Collect all elements including those inside shadow roots
    function collectAll(root) {
      const elements = [];
      for (const el of root.querySelectorAll("*")) {
        // Annotation nodes are the assistant's own drawing, not page content;
        // find() must never report a label as a matchable element.
        if (isAnnotationNode(el)) continue;
        elements.push(el);
        if (el.shadowRoot) {
          elements.push(...collectAll(el.shadowRoot));
        }
      }
      return elements;
    }

    const all = collectAll(document);

    for (const el of all) {
      if (!isVisible(el)) continue;

      const tag = el.tagName.toLowerCase();
      if (["script", "style", "noscript", "template"].includes(tag)) continue;

      // Nothing hidden from assistive technology is a click target, and a
      // widget like select2 keeps its real <select> exactly that way: present
      // in the DOM, aria-hidden, clipped to a pixel, positioned under the span
      // the user actually sees. Returning it gave three rows all named
      // "Nơi thực hiện" at three different points with nothing to say which
      // one was real; the model stopped trusting the refs and started guessing
      // coordinates by eye, landing on the "sau sáp nhập" radio underneath.
      // One row for one control is what makes a ref worth acting on.
      const box = el.getBoundingClientRect();
      if (box.width < 2 || box.height < 2) continue;
      if (el.closest('[aria-hidden="true"]')) continue;
      // design.md D4: the overlay host itself (extension/overlay/
      // pointer-overlay.js) is attached to document.documentElement, a
      // real descendant of `document` — so collectAll()'s own
      // querySelectorAll("*") above reaches it, unlike getPageText()'s
      // document.body-rooted walk. Excluded by attribute so a `find()` call
      // never reports the overlay's own Stop/Open-panel controls as page
      // content.
      if (el.closest("[data-browzy-overlay]")) continue;

      const role = getRole(el) || "";
      let name = getAccessibleName(el) || "";
      const text = el.textContent?.trim()?.substring(0, 200) || "";

      // A control's field label is part of how a person refers to it, so it
      // belongs in what find() matches on AND in what the caller is shown —
      // otherwise the only row answering "Nơi thực hiện" is the label itself,
      // which is not something you can click.
      let fieldLabel = "";
      try {
        if (el.matches(FIELD_CONTROL_SELECTOR)) fieldLabel = fieldLabelText(el);
      } catch {}
      if (fieldLabel && !name.toLowerCase().includes(fieldLabel.toLowerCase())) {
        name = name ? `${fieldLabel}: ${name}` : fieldLabel;
      }
      // Coerce to "" unless it's really a string: a form control named
      // title/placeholder/type shadows the built-in property with an ELEMENT,
      // which would stringify to "[object HTMLInputElement]" and silently
      // pollute matching (see the typeof guards in getAccessibleName).
      const placeholder = typeof el.placeholder === "string" ? el.placeholder : "";
      const ariaLabel = el.getAttribute("aria-label") || "";
      const title = typeof el.title === "string" ? el.title : "";
      const type = typeof el.type === "string" ? el.type : "";

      const searchable = `${role} ${name} ${text} ${placeholder} ${ariaLabel} ${title} ${type} ${tag}`.toLowerCase();

      const cx = Math.round(box.x + box.width / 2);
      const cy = Math.round(box.y + box.height / 2);
      const inViewport = cx >= 0 && cy >= 0 && cx < window.innerWidth && cy < window.innerHeight;
      const score = scoreFindMatch(tokens, {
        searchable,
        name: name.toLowerCase(),
        role: role.toLowerCase(),
        interactive: isInteractive(el),
        inViewport
      });
      if (score > 0) scored.push({ el, score, role: role || tag, name: name || text.substring(0, 80) });
    }

    // Rank before capping. The old code kept the first 20 in DOCUMENT order
    // and dropped the rest, so the best match was routinely thrown away
    // because it happened to sit lower in the page than twenty weaker ones.
    scored.sort((a, b) => (b.score - a.score) || (a.name.length - b.name.length));
    const total = scored.length;

    // Collapse wrapper chains. A control is almost never one element: a link
    // sits inside two or three divs that all carry the same text, so a single
    // visible control arrived as five near-identical rows —
    //   [ref_21] link "Click để tìm kiếm nâng cao" (639, 783)
    //   [ref_22] div  "Click để tìm kiếm nâng cao" (639, 773)
    //   [ref_23] div  ... and so on
    // — and a field like "Từ khóa chính" as six (label, span, i, three divs).
    // With a 20-row budget, a handful of controls was enough to fill it
    // entirely with duplicates and push the thing actually being looked for off
    // the end. Keeping only the best-ranked element of each nested group is
    // what makes those 20 rows twenty DIFFERENT controls.
    //
    // Bounded on purpose: the containment test only runs against rows already
    // kept, so this stays ~20*N rather than N^2 over every match on the page.
    const deduped = [];
    for (const cand of scored) {
      const dup = deduped.some(
        (kept) =>
          kept.name === cand.name &&
          (kept.el.contains(cand.el) || cand.el.contains(kept.el))
      );
      if (!dup) deduped.push(cand);
      if (deduped.length >= 20) break;
    }

    // Refs are assigned only for what is actually returned — a ref handed out
    // is a live WeakRef entry, and minting hundreds per query for candidates
    // the caller never sees is pure churn in that map.
    const results = deduped.map((m) => {
      const rect = m.el.getBoundingClientRect();
      const cx = Math.round(rect.x + rect.width / 2);
      const cy = Math.round(rect.y + rect.height / 2);
      const ref = getOrAssignRef(m.el);
      return {
        ref,
        role: m.role,
        name: m.name,
        coordinates: [cx, cy],
        // A match can be scrolled out of view — inside a horizontally
        // overflowing strip, below the fold, anywhere. Its coordinates are
        // still returned (they are correct, just not currently reachable),
        // but clicking them would land on the document root instead of the
        // element. Flag it here so the caller scrolls first rather than
        // discovering the miss afterwards.
        offViewport:
          cx < 0 || cy < 0 || cx >= window.innerWidth || cy >= window.innerHeight,
        // Same "first seen since the previous read of this document" signal
        // generateAccessibilityTree renders as a "*" prefix on the line —
        // see watermarkAtStart above.
        isNew: watermarkAtStart !== null && refNumber(ref) > watermarkAtStart,
      };
    });
    // Recorded after every ref above has been assigned, not before: refs are
    // handed out lazily, only to elements actually returned in `results`, so
    // recording the watermark earlier would make this very call's own
    // results look new again on the very next read.
    readWatermark = refCounter;
    return { results, total };
  }

  // --- Form input ---

  // Find the actual input/textarea/select inside an element, traversing shadow DOM
  function findInputInside(el) {
    const tag = el.tagName.toLowerCase();
    if (["input", "textarea", "select"].includes(tag)) return el;

    // Check shadow DOM first
    const root = el.shadowRoot || el;
    const inner = root.querySelector("input, textarea, select");
    if (inner) return inner;

    // Recurse into shadow roots of children
    for (const child of root.querySelectorAll("*")) {
      if (child.shadowRoot) {
        const deep = child.shadowRoot.querySelector("input, textarea, select");
        if (deep) return deep;
      }
    }
    return null;
  }

  function setFormValue(refId, value) {
    const el = resolveRef(refId);
    if (!el) return { error: `Element ${refId} not found or was garbage collected.` };

    el.scrollIntoView({ block: "center", behavior: "instant" });

    // Resolve the actual form element (may be inside shadow DOM)
    const target = findInputInside(el) || el;
    const tag = target.tagName.toLowerCase();
    const type = (target.type || "").toLowerCase();

    if (tag === "select") {
      const opt = Array.from(target.options).find(
        (o) => o.value === String(value) || o.textContent.trim() === String(value)
      );
      if (opt) {
        target.value = opt.value;
      } else {
        target.value = String(value);
      }
    } else if (type === "checkbox" || type === "radio") {
      const shouldCheck = typeof value === "boolean" ? value : value === "true";
      if (target.checked !== shouldCheck) target.click();
      return { success: true, checked: target.checked };
    } else if (target.contentEditable === "true") {
      target.textContent = String(value);
    } else if (["input", "textarea"].includes(tag)) {
      // Use the native setter for actual input/textarea elements
      const proto = tag === "textarea" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
      if (setter) {
        setter.call(target, String(value));
      } else {
        target.value = String(value);
      }
    } else {
      // Fallback for unknown elements — try direct assignment
      try {
        target.value = String(value);
      } catch {
        return { error: `Cannot set value on <${tag}> element. No input found inside.` };
      }
    }

    // Dispatch events on the target (bubbles up through shadow DOM)
    target.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    target.dispatchEvent(new Event("change", { bubbles: true, composed: true }));

    return { success: true, value: target.value };
  }

  // --- What is actually at a point ---
  // A dispatched click lands on whatever occupies its coordinates, which is not
  // necessarily what the caller aimed at: the target may have scrolled out of
  // view, or something transparent may be sitting on top of it. The dispatch
  // succeeds either way, so without this a hit and a miss are indistinguishable
  // from the tool result. Runs in the isolated world, so it can also report the
  // ref of the element it found — the same ref space read_page/find hand out.
  function describePoint(x, y) {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const outside = x < 0 || y < 0 || x >= vw || y >= vh;
    const el = outside ? null : document.elementFromPoint(x, y);
    if (!el) return { hit: null, outside, viewport: [vw, vh] };

    // Shadow DOM: elementFromPoint stops at the host, so walk into the shadow
    // tree to name the node that will really receive the event.
    let node = el;
    for (let depth = 0; depth < 4 && node.shadowRoot; depth++) {
      const inner = node.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === node) break;
      node = inner;
    }

    const tag = node.tagName.toLowerCase();
    const attrs = {};
    for (const a of ["id", "name", "type", "role", "data-testid", "data-test", "aria-label"]) {
      const v = node.getAttribute && node.getAttribute(a);
      if (v) attrs[a] = v.length > 40 ? v.slice(0, 40) + "…" : v;
    }
    const cls =
      typeof node.className === "string" && node.className.trim()
        ? node.className.trim().split(/\s+/).slice(0, 2).join(".")
        : "";
    const text = (node.textContent || "").replace(/\s+/g, " ").trim().slice(0, 60);
    // Only report a ref the element already has; assigning a new one here would
    // grow the ref map on every click.
    const existing = reverseMap.get(node);
    const ref = existing && elementMap[existing]?.deref() === node ? existing : null;
    // Whether a click here can be a no-op a caller can't tell apart from a hit.
    // Flag it only when the point is on/inside a <label> whose associated
    // control is missing OR not natively activatable, AND no live interactive
    // element is present to receive the bubbled click. A click on a label with
    // a working control, or on a label under a real interactive ancestor, still
    // reaches a target and must not read as dead.
    //
    // The effective disabled state is deliberate: ctrl.disabled is the control's
    // own attribute, so it misses a control disabled by being inside a
    // <fieldset disabled>, while ctrl.matches(":disabled") reflects the real,
    // inheritable state. Testing :disabled (not :enabled) also matters because
    // :enabled only matches button/input/select/textarea/option — it would
    // wrongly mark non-disabled labelable elements like <meter>/<output>/
    // <progress> as non-activatable and flag a healthy label as dead.
    //
    // The hit must be resolved through the DOM, not just the direct
    // elementFromPoint result: labels usually wrap a <span>/<svg> child, so the
    // point often lands on the child, not the <label> itself.
    //
    // The ancestor selector matches only LIVE interactive elements: enabled form
    // controls, acted-on anchors, and interactive ARIA roles. Bare [role] would
    // match presentational/landmark roles like banner or presentation; bare
    // input/button would count a DISABLED control as "still gets the click".
    const labelEl = node.closest ? node.closest("label") : null;
    const ctrl = labelEl && labelEl.control;
    const noNativeActivation = !ctrl || ctrl.matches(":disabled");
    // [onclick]/[tabindex] must also exclude disabled controls: a disabled
    // control that happens to carry one still never receives the click.
    // ARIA roles are ASCII case-insensitive, so use the `i` flag. contenteditable
    // and media controls are natively interactive targets of their own.
    const interactiveAncestor = node.closest(
      "a[href],a[onclick]," +
      "button:enabled,input:enabled,textarea:enabled,select:enabled," +
      "summary," +
      "[onclick]:not(:disabled),[tabindex]:not(:disabled)," +
      "[contenteditable]:not([contenteditable=\"false\"]),audio[controls],video[controls]," +
      "[role=button i],[role=combobox i],[role=link i],[role=menuitem i],[role=menuitemradio i]," +
      "[role=menuitemcheckbox i],[role=option i],[role=radio i],[role=checkbox i],[role=tab i]," +
      "[role=switch i],[role=textbox i],[role=spinbutton i],[role=slider i],[role=listbox i]," +
      "[role=treeitem i]"
    );
    const deadLabel = !!labelEl && noNativeActivation && !interactiveAncestor;
    return {
      hit: { tag, attrs, cls, text, ref },
      // <html>/<body> means the point is over page background — nothing
      // interactive there, which is almost always a miss worth flagging.
      bare: tag === "html" || tag === "body",
      deadLabel,
      viewport: [vw, vh]
    };
  }

  // --- Is a dropdown list open right now? ---
  //
  // The single most expensive thing a click can do is succeed invisibly. A
  // click on a select2 control opens its list; the correct next move is to
  // TYPE. Clicking again closes the list and throws away everything typed into
  // it, and the response to both clicks reads the same — "Clicked at (x, y)".
  // One run spent eleven consecutive clicks alternating open/closed, never
  // typed once, and gave up. Naming the list in the click result is what turns
  // that into a visible state.
  const OPEN_LIST_SELECTOR =
    ".select2-dropdown, .select2-results, [role='listbox']," +
    " .ui-autocomplete, .tt-menu, .autocomplete-items";

  // A date picker is the same trap wearing different clothes: clicking the
  // field opens a calendar, the result reads `Clicked at (397, 364)`, and a
  // second click closes it again. One run alternated between the picker's two
  // date inputs four times without typing a single character.
  const OPEN_PICKER_SELECTOR =
    ".daterangepicker, .datepicker, .ui-datepicker, .flatpickr-calendar," +
    " .air-datepicker, .xdsoft_datetimepicker";

  /** Only elements that are on screen AND have real size are "open". */
  function isShowing(el) {
    if (!isVisible(el)) return false;
    const rect = el.getBoundingClientRect();
    return rect.width >= 2 && rect.height >= 2;
  }

  function describeOpenList() {
    for (const el of document.querySelectorAll(OPEN_LIST_SELECTOR)) {
      if (!isShowing(el)) continue;
      const options = Array.from(
        el.querySelectorAll("[role='option'], li, option")
      ).filter(isVisible).length;
      // select2 renders its search field just outside the results list, so
      // look in the whole open widget, not only inside `el`.
      const search =
        el.querySelector("input:not([type='hidden']), textarea") ||
        document.querySelector(".select2-search__field, .select2-search input");
      return {
        kind: "list",
        open: true,
        options,
        hasSearch: !!(search && isVisible(search)),
      };
    }

    for (const el of document.querySelectorAll(OPEN_PICKER_SELECTOR)) {
      if (!isShowing(el)) continue;
      const inputs = Array.from(
        el.querySelectorAll("input:not([type='hidden'])")
      ).filter(isVisible).length;
      return { kind: "datepicker", open: true, inputs };
    }

    return { open: false };
  }

  // --- Get element coordinates for ref ---
  /** The element a person would actually click to operate `el`.
   *
   * A great many real forms hide the real control and style something else in
   * its place: `<input type="radio">` parked at `left:-9999px` with a `<label>`
   * or `<span>` drawn where the user sees the button. The input is the element
   * `find`/`read_page` correctly report — it carries the accessible name — but
   * it can never be clicked, and it cannot be scrolled into view either,
   * because it is not scrolled out: it is positioned outside the page on
   * purpose. Every click on such a control failed, and the only way left was
   * guessing a coordinate over the visible part, which lands on whatever
   * wrapper happens to be there.
   *
   * A browser already solves this: clicking a `<label>` forwards activation to
   * the control it labels. So when the target itself is unreachable, aim at its
   * label — the same thing the user's own click would hit. Returns null when
   * there is no usable label, leaving the existing "not reachable" answer
   * intact rather than inventing a target. */
  function clickableProxyFor(el) {
    if (!el) return null;
    const candidates = [];
    if (el.id) {
      try {
        candidates.push(...document.querySelectorAll(`label[for="${CSS.escape(el.id)}"]`));
      } catch {}
    }
    const wrapping = el.closest ? el.closest("label") : null;
    if (wrapping) candidates.push(wrapping);
    for (const c of candidates) {
      if (!c || c === el) continue;
      const r = c.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      return c;
    }
    return null;
  }

  /** True when an ancestor's own scroll box has scrolled `el` out of sight.
   *
   * Being inside the window viewport is not the same as being visible: a
   * dropdown list, a virtualised table, any panel with `overflow: auto` keeps
   * its children at live viewport coordinates while painting only the slice
   * inside its box. Everything outside that box belongs, on screen, to whatever
   * is behind the panel. */
  function clippedByScrollAncestor(el) {
    const r = el.getBoundingClientRect();
    let node = el.parentElement;
    while (node && node !== document.body && node !== document.documentElement) {
      const style = getComputedStyle(node);
      const clips = /auto|scroll|hidden|overlay/.test(
        `${style.overflowY} ${style.overflowX}`
      );
      const scrollable =
        node.scrollHeight > node.clientHeight + 1 ||
        node.scrollWidth > node.clientWidth + 1;
      if (clips && scrollable) {
        const b = node.getBoundingClientRect();
        if (
          r.bottom <= b.top + 1 ||
          r.top >= b.bottom - 1 ||
          r.right <= b.left + 1 ||
          r.left >= b.right - 1
        ) {
          return true;
        }
      }
      node = node.parentElement;
    }
    return false;
  }

  function getRefCoordinates(refId, opts = {}) {
    let el = resolveRef(refId);
    if (!el) return null;

    // A control that is off the page rather than merely off-screen cannot be
    // scrolled to. Swap in the label that operates it BEFORE any scrolling, so
    // the scroll below brings the thing the user would click into view.
    const initialRect = el.getBoundingClientRect();
    const unreachableByGeometry =
      initialRect.width < 1 ||
      initialRect.height < 1 ||
      initialRect.right < 0 ||
      initialRect.bottom < 0 ||
      initialRect.left > document.documentElement.scrollWidth ||
      initialRect.top > document.documentElement.scrollHeight;
    let proxiedFrom = null;
    if (unreachableByGeometry) {
      const proxy = clickableProxyFor(el);
      if (proxy) {
        proxiedFrom = describeBrief(el);
        el = proxy;
      } else if (!el.isConnected || (initialRect.width < 1 && initialRect.height < 1)) {
        // A ref whose element has been removed from the document — or that
        // never had a box and has no label to stand in for it — reports an
        // all-zero rect. Falling through would compute (0,0), and (0,0) passes
        // the "inside the viewport" test, so the caller was told the click was
        // fine and it landed in the top-left corner of the page. That is how a
        // dropdown option, gone the moment its list closed, turned into a click
        // on the site header. Say it is gone instead; the caller can re-run
        // find and get a live ref.
        return {
          x: 0,
          y: 0,
          reachable: false,
          covering: null,
          scrolledFrom: null,
          proxiedFrom: null,
          detached: !el.isConnected
        };
      }
    }

    // Bring the element into view before reading its position.
    //
    // Coordinates are viewport-relative, so an element scrolled out of view has
    // coordinates that cannot be clicked at all: the dispatch lands on the
    // document root instead. That is not a reporting problem, it is a targeting
    // one — the caller named an element, and the element is reachable, it just
    // is not on screen yet. Scrolling first is what a person does, and what
    // Playwright/Puppeteer do before every click, so the click lands on what
    // was actually asked for.
    //
    // block/inline "center" (rather than the default "start") keeps the element
    // clear of sticky headers and footers, which are a common way for a
    // technically-in-viewport element to still be covered.
    let scrolledFrom = null;
    if (opts.scrollIntoView !== false) {
      const r = el.getBoundingClientRect();
      const off =
        r.left < 0 || r.top < 0 || r.right > window.innerWidth || r.bottom > window.innerHeight;
      if (!off && clippedByScrollAncestor(el)) {
        // Inside the window but scrolled out of its OWN scrolling box — a long
        // select2 result list is the standard case: the option's rect is a real
        // viewport coordinate, and the list clips it, so the point is painted by
        // whatever sits under the dropdown. Clicking it hit the form row behind
        // the list and the run gave up. "nearest" scrolls the list and nothing
        // else; centring here would scroll the window too and move (or close)
        // the very dropdown being read from.
        scrolledFrom = [Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2)];
        try {
          el.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
        } catch {
          el.scrollIntoView(false);
        }
      } else if (off) {
        // Remember where it was, so the caller can record that a scroll
        // happened. A move this large silently changing the coordinates is
        // exactly the kind of thing a debug log has to show.
        scrolledFrom = [Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2)];
        try {
          el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
        } catch {
          el.scrollIntoView(true);
        }
      }
    }

    const rect = el.getBoundingClientRect();
    const x = Math.round(rect.x + rect.width / 2);
    const y = Math.round(rect.y + rect.height / 2);
    // Report what is actually at the resulting point, so the caller learns when
    // something else (an overlay, a sticky bar) will receive the click. That
    // case is NOT auto-corrected: a person clicking there would hit the overlay
    // too, so silently clicking through it would be the unfaithful choice.
    let covering = null;
    if (x >= 0 && y >= 0 && x < window.innerWidth && y < window.innerHeight) {
      const at = document.elementFromPoint(x, y);
      if (at && at !== el && !el.contains(at) && !at.contains(el)) {
        covering = describeBrief(at);
      }
    }
    return {
      x,
      y,
      reachable: x >= 0 && y >= 0 && x < window.innerWidth && y < window.innerHeight,
      covering,
      scrolledFrom,
      // Set only when the click was redirected to a label because the control
      // itself sits outside the page. The caller reports it rather than
      // swallowing it: the agent asked for one element and a different one is
      // being clicked, even though that is exactly what a person's click does.
      proxiedFrom,
    };
  }

  function describeBrief(el) {
    const id = el.id ? `#${el.id}` : "";
    const cls =
      typeof el.className === "string" && el.className.trim()
        ? "." + el.className.trim().split(/\s+/)[0]
        : "";
    const t = (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 40);
    return `<${el.tagName.toLowerCase()}${id}${cls}>${t ? ` "${t}"` : ""}`;
  }

  // --- Message handler ---
  // Named (not inline) so the disposer at the top of this IIFE can remove it
  // when a newer copy of this script is injected into the same document.
  const onExtensionMessage = (msg, sender, sendResponse) => {
    if (msg.type === "generateAccessibilityTree") {
      const result = generateAccessibilityTree(msg.options || {});
      sendResponse({ result });
      return true;
    }

    if (msg.type === "getPageText") {
      const result = getPageText();
      sendResponse({ result });
      return true;
    }

    // Lightweight document-identity probe — url/title/epoch/nonce only, no
    // DOM text extraction — for callers that need to know whether the
    // document has changed since a prior capture without re-reading its
    // content. `docNonce` (design.md decision 6 / tasks.md 1.2) is the
    // content-script half of extension/events/document-identity.js's
    // handshake; `documentEpoch` remains the separate, pre-existing SPA
    // ref-invalidation counter (bumps on every route change, including one
    // that does not change docNonce — see this file's own comment at
    // `documentNonce`'s definition).
    if (msg.type === "getDocumentIdentity") {
      sendResponse({
        result: { url: location.href, title: document.title || "", documentEpoch, docNonce: documentNonce, readyState: document.readyState }
      });
      return true;
    }

    if (msg.type === "findElements") {
      const result = findElements(msg.query);
      sendResponse({ result });
      return true;
    }

    if (msg.type === "setFormValue") {
      const result = setFormValue(msg.ref, msg.value);
      sendResponse({ result });
      return true;
    }

    if (msg.type === "describeOpenList") {
      sendResponse({ result: describeOpenList() });
      return true;
    }

    if (msg.type === "describePoint") {
      sendResponse({ result: describePoint(msg.x, msg.y) });
      return true;
    }

    // Describe a ref as the send/submit classifier's target hint.
    //
    // The approval gate runs in the host, which cannot see the page: a `ref` in
    // a tool call is a NAME, not evidence about what will be clicked. Without
    // this, every ref-only click classified as "unresolved target" and demanded
    // the user's approval — while a bare guessed coordinate, which is strictly
    // LESS evidence, was auto-allowed as an ordinary navigation click. The safe
    // route was the gated one and the guessing route was the free one, so the
    // model learned to guess.
    //
    // Read-only and side-effect free: no scrolling, no hit-test, no mutation.
    // Deliberately NOT `getRefCoordinates` — that scrolls, and the gate must not
    // move the page while merely deciding whether to ask the user.
    if (msg.type === "describeRef") {
      const el = resolveRef(msg.ref);
      if (!el) {
        sendResponse({ result: null });
        return true;
      }
      const attributes = {};
      for (const a of ["type", "value", "name", "id", "role", "aria-label"]) {
        const v = el.getAttribute && el.getAttribute(a);
        if (v) attributes[a] = v.length > 60 ? v.slice(0, 60) : v;
      }
      sendResponse({
        result: {
          tagName: el.tagName ? el.tagName.toLowerCase() : null,
          role: getRole(el),
          accessibleName: getAccessibleName(el),
          attributes
        }
      });
      return true;
    }

    if (msg.type === "getRefCoordinates") {
      const result = getRefCoordinates(msg.ref, { scrollIntoView: msg.scrollIntoView });
      sendResponse({ result });
      return true;
    }

    // Screenshot annotation, driven from takeScreenshot()'s capture lease. The
    // draw is wrapped so no page-level failure can ever fail the capture the
    // caller actually asked for; takeScreenshot() teardown is unconditional.
    if (msg.type === "annotateElements") {
      let result;
      try {
        result = drawAnnotation({ scale: msg.scale });
      } catch (e) {
        try { clearAnnotation(); } catch {}
        result = { drawn: 0, error: String((e && e.message) || e) };
      }
      sendResponse({ result });
      return true;
    }

    if (msg.type === "clearAnnotation") {
      let result;
      try {
        result = clearAnnotation();
      } catch (e) {
        result = { cleared: false, error: String((e && e.message) || e) };
      }
      sendResponse({ result });
      return true;
    }

    // Resolve a ref in THIS (isolated) world — where resolveRef/elementMap live —
    // and stamp a DOM attribute on the element so the background page can find it
    // via CDP. CDP Runtime.evaluate runs in the page's MAIN world and cannot see
    // window.__unblockedChrome, so a main-world resolveRef always returns null;
    // the DOM is shared across worlds, so an attribute set here IS visible to CDP.
    // Used by file_upload / upload_image to reach a (possibly hidden) file input.
    if (msg.type === "markElementForUpload") {
      const el = resolveRef(msg.ref);
      if (!el) {
        sendResponse({ ok: false });
        return true;
      }
      const isFileInput =
        el.tagName &&
        el.tagName.toLowerCase() === "input" &&
        (el.type || "").toLowerCase() === "file";
      try { el.setAttribute("data-ocic-upload-target", "1"); } catch {}
      try { el.scrollIntoView({ block: "center", behavior: "instant" }); } catch {}
      sendResponse({ ok: true, isFileInput, tag: el.tagName.toLowerCase() });
      return true;
    }

    if (msg.type === "unmarkElementForUpload") {
      try {
        document
          .querySelectorAll("[data-ocic-upload-target]")
          .forEach((e) => e.removeAttribute("data-ocic-upload-target"));
      } catch {}
      sendResponse({ ok: true });
      return true;
    }

    return false;
  };
  chrome.runtime.onMessage.addListener(onExtensionMessage);
  window.__unblockedChromeDispose = function () {
    chrome.runtime.onMessage.removeListener(onExtensionMessage);
  };

  // Expose globally for executeScript fallback
  window.__unblockedChrome = {
    describePoint,
    generateAccessibilityTree,
    getPageText,
    findElements,
    setFormValue,
    getRefCoordinates,
    resolveRef,
    elementMap,
    annotateElements: drawAnnotation,
    clearAnnotation,
  };
})();
