// Design-mode element picker — openspec/changes/add-design-mode-element-picker
// (design.md D1-D9). Lets the OPERATOR point at a single element on the bound
// page and hand its picture, markup and resolved styling to the composer.
// The opposite data direction from extension/overlay/pointer-overlay.js (page
// -> panel, not agent -> page), a different lifetime (a brief operator-driven
// mode, not the run's duration), and never mounted for the vast majority of
// runs — so it is its own file rather than a mode inside that one (design.md
// D1). Do NOT edit pointer-overlay.js from this file's change; it is owned by
// a separate in-flight change.
//
// WHY THIS IS A CLASSIC (non-module) SCRIPT, NOT AN ES MODULE: exactly the
// same two reasons pointer-overlay.js's own header states, verified again
// here rather than assumed: extension/manifest.json declares no
// `web_accessible_resources`, so Chrome forbids a dynamic `import()` from a
// content script; and this file is written as one IIFE with named top-level
// function declarations so `test/_extract.mjs`'s brace-matching extractor can
// pull each pure function out of THIS REAL SHIPPED FILE and unit-test it in
// plain Node, with no bundler, no second copy of the logic, and no browser.
// Injected the same way `OVERLAY_SCRIPT_FILES` is in extension/background.js
// (`chrome.scripting.executeScript({ target:{tabId}, files:[...] })`).
//
// SECTIONS BELOW:
//   1. Pure functions (no chrome.*, no DOM) — the style filter (design.md
//      D4's fixed property list), markup truncation (design.md D5's 32 KB
//      ceiling), and the rect-to-region conversion the existing clipped-
//      capture path (background.js's takeScreenshot/normalizeCropRegion,
//      UNMODIFIED — design.md D6) consumes.
//   2. sanitizeClone(el) (design.md D3) — touches the DOM (clone + walk),
//      but never the network, never chrome.*: sanitizes a CLONE, so the live
//      element and the live page are never touched or serialized directly.
//   3. Interaction + lifecycle — highlight box, capture-phase listeners,
//      teardown, and the chrome.runtime message wiring to background.js.

(function () {
  // Same reasoning as pointer-overlay.js's own disposer (see that file's long
  // comment): a plain "already loaded, bail" guard survives an extension
  // reload but not a page reload's teardown of the *previous* copy's
  // listeners, so disposing the old context first handles both a live
  // double-injection (background retries once on failed delivery — see
  // sendPickerMessage in background.js) and a dead predecessor left behind by
  // an extension reload.
  try {
    if (typeof window.__browzyPickerDispose === "function") window.__browzyPickerDispose();
  } catch (e) {
    // Old context already invalidated — nothing to tear down.
  }

  // === 1. Pure functions ===================================================

  // design.md D5: markup over this many UTF-8 bytes is truncated, and the
  // record states that it was. Named once here so the test asserts against
  // the SAME constant the code truncates with, rather than a copied literal.
  var MARKUP_CEILING_BYTES = 32 * 1024;

  // design.md D4: the fixed, named set of computed-style properties a
  // selection transmits — never the full ~340-property dump getComputedStyle
  // exposes, which is mostly browser defaults and would bury the handful of
  // values that actually describe the element's appearance.
  var STYLE_PROPERTIES = [
    // Box
    "display", "position", "width", "height", "padding", "margin", "box-sizing", "overflow",
    // Flex/grid
    "flex-direction", "flex-wrap", "justify-content", "align-items", "gap",
    "grid-template-columns", "grid-template-rows",
    // Type
    "font-family", "font-size", "font-weight", "line-height", "letter-spacing",
    "text-align", "text-transform", "color",
    // Surface
    "background-color", "background-image", "border", "border-radius", "box-shadow", "opacity",
    // Layering
    "z-index", "transform"
  ];

  /** design.md D4: read exactly STYLE_PROPERTIES off `computedStyle` (anything
   * with a `getPropertyValue(prop)` method — a real CSSComputedStyleDeclaration
   * in the browser, a plain fake in tests). Every listed key is always present
   * in the output, even when the browser reports it empty — that emptiness IS
   * D5's "list identity", so a later reader can tell "not set" from "never
   * asked about". A property outside STYLE_PROPERTIES never appears at all. */
  function filterStyles(computedStyle) {
    var out = {};
    for (var i = 0; i < STYLE_PROPERTIES.length; i++) {
      var prop = STYLE_PROPERTIES[i];
      var value = "";
      try {
        value = computedStyle && typeof computedStyle.getPropertyValue === "function"
          ? computedStyle.getPropertyValue(prop)
          : "";
      } catch (e) {
        value = "";
      }
      out[prop] = value === null || value === undefined ? "" : String(value);
    }
    return out;
  }

  /** UTF-8 byte length of a string — markup routinely carries multi-byte text
   * (Vietnamese, emoji, ...), so measuring `.length` (UTF-16 code units)
   * against a byte ceiling would let real payloads through over-budget. */
  function utf8ByteLength(str) {
    return new TextEncoder().encode(str).length;
  }

  /** design.md D5: truncate `markup` to at most `ceilingBytes` UTF-8 bytes,
   * cutting at a tag boundary where possible so the result never ends
   * mid-tag (a dangling `<div cla` is both unreadable and, if anything ever
   * re-parsed it, ambiguous). Returns `{markup, truncated, ceilingBytes}` —
   * `truncated` and the ceiling travel WITH the record (spec: "truncation
   * SHALL never be silent").
   *
   * Approach: slice by UTF-16 code units down to at most `ceilingBytes`
   * characters (a safe upper bound, since every UTF-16 code unit is at least
   * one UTF-8 byte), then shrink one character at a time until the UTF-8
   * encoding actually fits, then back up to the last complete `>` so the
   * result never ends inside an open tag or attribute. */
  function truncateMarkup(markup, ceilingBytes) {
    var ceiling = typeof ceilingBytes === "number" && ceilingBytes > 0 ? ceilingBytes : MARKUP_CEILING_BYTES;
    var text = typeof markup === "string" ? markup : "";
    if (utf8ByteLength(text) <= ceiling) {
      return { markup: text, truncated: false, ceilingBytes: ceiling };
    }
    var slice = text.slice(0, Math.min(text.length, ceiling));
    while (slice.length > 0 && utf8ByteLength(slice) > ceiling) {
      slice = slice.slice(0, slice.length - 1);
    }
    var lastGt = slice.lastIndexOf(">");
    if (lastGt === -1) {
      slice = ""; // not even one complete tag fits within the ceiling
    } else if (lastGt < slice.length - 1) {
      slice = slice.slice(0, lastGt + 1);
    }
    return { markup: slice, truncated: true, ceilingBytes: ceiling };
  }

  /** design.md D6: turn a bounding rect (CSS-pixel, viewport-relative — the
   * exact space `getBoundingClientRect()` and `position:fixed` share) into
   * the `[x0,y0,x1,y1]` region background.js's OWN normalizeCropRegion()
   * already consumes unchanged. Also reports whether the rect extends past
   * the viewport on any edge — normalizeCropRegion() clamps to the viewport
   * internally, so a taller-than-viewport element is captured as its visible
   * part only (design.md D6's stated consequence); this flag is what lets
   * the record say so rather than leaving it implicit. */
  function rectToRegion(rect, viewportWidth, viewportHeight) {
    var left = rect && typeof rect.left === "number" ? rect.left : 0;
    var top = rect && typeof rect.top === "number" ? rect.top : 0;
    var right = rect && typeof rect.right === "number" ? rect.right : left;
    var bottom = rect && typeof rect.bottom === "number" ? rect.bottom : top;
    var vw = typeof viewportWidth === "number" ? viewportWidth : 0;
    var vh = typeof viewportHeight === "number" ? viewportHeight : 0;
    var clipped = left < 0 || top < 0 || right > vw || bottom > vh;
    return { region: [left, top, right, bottom], clipped: clipped };
  }

  /** A short, human-recognizable descriptor for the picked element — spec:
   * "The record SHALL identify which element it describes in a form the
   * operator can recognize before sending." Prefers an id, then the first
   * class, then the bare tag name; never throws on an element missing
   * getAttribute (defensive against a hostile/unusual node). */
  function describeSelector(el) {
    if (!el) return "";
    var tag = el.tagName ? String(el.tagName).toLowerCase() : "";
    var getAttr = typeof el.getAttribute === "function" ? el.getAttribute.bind(el) : null;
    var id = getAttr ? getAttr("id") : null;
    if (id) return tag + "#" + id;
    var cls = getAttr ? getAttr("class") : null;
    if (cls) {
      var first = String(cls).trim().split(/\s+/)[0];
      if (first) return tag + "." + first;
    }
    return tag;
  }

  // === 2. Sanitization (design.md D3) ======================================

  function tagNameOf(node) {
    return node && node.tagName ? String(node.tagName).toUpperCase() : "";
  }

  function attrOf(node, name) {
    return node && typeof node.getAttribute === "function" ? String(node.getAttribute(name) || "").toLowerCase() : "";
  }

  function isPasswordInput(node) {
    return tagNameOf(node) === "INPUT" && attrOf(node, "type") === "password";
  }

  /** design.md D3: strip the CURRENT VALUE of a form control on the clone —
   * both the live property (what the operator actually typed/checked/
   * selected) and any `value`/`checked`/`selected` attribute the clone
   * inherited from the live element's initial HTML. Structural attributes
   * (type, name, id, class, placeholder, for, aria-anything, role, disabled,
   * required, and so on) are never touched here — nothing on this path
   * removes them. NOTE: do not write an `aria-` wildcard with a star and a
   * slash in a block comment; that sequence closes the comment early and
   * turns the rest of this file into a syntax error. */
  function stripValueLike(node) {
    var tag = tagNameOf(node);
    if (tag === "INPUT") {
      var type = attrOf(node, "type");
      if (type === "checkbox" || type === "radio") {
        try { node.checked = false; } catch (e) {}
        try { node.removeAttribute("checked"); } catch (e) {}
      } else {
        try { node.value = ""; } catch (e) {}
        try { node.removeAttribute("value"); } catch (e) {}
      }
    } else if (tag === "TEXTAREA") {
      try { node.value = ""; } catch (e) {}
      try { node.textContent = ""; } catch (e) {}
    } else if (tag === "OPTION") {
      try { node.selected = false; } catch (e) {}
      try { node.removeAttribute("selected"); } catch (e) {}
    }
  }

  /** design.md D3's second removal rule: "The entire subtree of any element
   * inside a password input's containing control." Read literally: stripping
   * the input's OWN `value` (stripValueLike, above) is not enough, because a
   * password-styled widget can mirror what was typed into a SIBLING node
   * (a "show password" toggle, a masked-character display) that carries no
   * `value` attribute at all and so would survive a value-only strip. The
   * containing control is taken as the password input's immediate parent;
   * every OTHER child of that parent is removed outright (not merely
   * text-blanked) — structurally, so nothing it might carry, as an
   * attribute or as text content, can reach the serialized markup. The
   * password input itself is kept (its structural attributes are still
   * useful, per D3's preserved list) with its value already stripped above.
   * A sibling password input (two password fields sharing one parent) is
   * left alone here so cleaning one never undoes another's own cleaning. */
  function stripPasswordContainerSiblings(passwordInput) {
    var container = passwordInput.parentNode;
    if (!container || !container.children) return;
    var kids = Array.prototype.slice.call(container.children);
    for (var i = 0; i < kids.length; i++) {
      var kid = kids[i];
      if (kid === passwordInput) continue;
      if (isPasswordInput(kid)) continue;
      if (typeof container.removeChild === "function") {
        try { container.removeChild(kid); } catch (e) {}
      }
    }
  }

  function stripSubtree(node) {
    if (!node) return;
    stripValueLike(node);
    if (isPasswordInput(node)) stripPasswordContainerSiblings(node);
    var kids = node.children ? Array.prototype.slice.call(node.children) : [];
    for (var i = 0; i < kids.length; i++) stripSubtree(kids[i]);
  }

  /** design.md D3: clone FIRST, strip the clone, serialize the clone — never
   * the live element. `el.cloneNode(true)` never mutates the page, so a
   * value observed for stripping was never actually removed from what the
   * operator sees; only the detached copy that becomes the transmitted
   * markup is touched. */
  function sanitizeClone(el) {
    var clone = el.cloneNode(true);
    stripSubtree(clone);
    return clone;
  }

  // === 3. Interaction + lifecycle (design.md D2, D9) =======================

  // design.md D2: every listener here is added AND removed with this exact
  // same options object — teardown symmetry (task 3.5) depends on the two
  // sides matching, not just being "equivalent".
  var PICKER_LISTENER_OPTS = { capture: true, passive: false };
  var HIGHLIGHT_Z_INDEX = "2147483647";

  var active = false;
  var highlightEl = null;
  var lastHighlightTarget = null;

  function createHighlight() {
    if (highlightEl) return;
    highlightEl = document.createElement("div");
    highlightEl.setAttribute("data-browzy-picker-highlight", "1");
    var s = highlightEl.style;
    s.position = "fixed";
    // design.md D2: pointer-events:none so the highlight itself can never
    // become the element under the pointer (it would otherwise shadow the
    // real page element on every mousemove once drawn over it).
    s.pointerEvents = "none";
    s.zIndex = HIGHLIGHT_Z_INDEX;
    s.boxSizing = "border-box";
    s.border = "2px solid #7c5cff";
    s.background = "rgba(124,92,255,0.16)";
    s.borderRadius = "2px";
    s.left = "0px";
    s.top = "0px";
    s.width = "0px";
    s.height = "0px";
    s.display = "none";
    s.transition = "none";
    (document.documentElement || document.body).appendChild(highlightEl);
  }

  function positionHighlight(el) {
    if (!highlightEl || !el || typeof el.getBoundingClientRect !== "function") return;
    var r = el.getBoundingClientRect();
    var s = highlightEl.style;
    s.left = r.left + "px";
    s.top = r.top + "px";
    s.width = r.width + "px";
    s.height = r.height + "px";
    s.display = "block";
  }

  function removeHighlight() {
    if (highlightEl && highlightEl.parentNode) {
      try { highlightEl.parentNode.removeChild(highlightEl); } catch (e) {}
    }
    highlightEl = null;
  }

  function onMouseMove(evt) {
    if (!active) return;
    // design.md D2: the candidate element is the event TARGET of a
    // capture-phase mousemove — never document.elementFromPoint() polled on
    // a timer (that re-queries on a schedule the pointer does not follow and
    // costs a layout read per tick on a page that is already busy).
    var target = evt.target;
    if (target === lastHighlightTarget) return;
    lastHighlightTarget = target;
    positionHighlight(target);
  }

  function onClick(evt) {
    if (!active) return;
    // design.md D2: capture-phase, preventDefault + stopPropagation, so the
    // click SELECTS rather than activating a link or submitting a form.
    evt.preventDefault();
    evt.stopPropagation();
    selectElement(evt.target);
  }

  function onKeydown(evt) {
    if (!active) return;
    if (evt.key !== "Escape") return;
    // design.md D2: capture-phase, so a page that swallows keydown on
    // bubble cannot trap the operator in the mode.
    evt.preventDefault();
    evt.stopPropagation();
    cancelPicking("escape");
  }

  function attachListeners() {
    window.addEventListener("mousemove", onMouseMove, PICKER_LISTENER_OPTS);
    window.addEventListener("click", onClick, PICKER_LISTENER_OPTS);
    window.addEventListener("keydown", onKeydown, PICKER_LISTENER_OPTS);
  }

  function detachListeners() {
    window.removeEventListener("mousemove", onMouseMove, PICKER_LISTENER_OPTS);
    window.removeEventListener("click", onClick, PICKER_LISTENER_OPTS);
    window.removeEventListener("keydown", onKeydown, PICKER_LISTENER_OPTS);
  }

  /** design.md D2/task 3.3: every exit route (selection, Escape, a second
   * activation, teardown requested by background on a bound-page change)
   * funnels through this one function, which removes every listener with
   * the SAME options object it was added with, plus the highlight node —
   * this symmetry is what the spec's "the page receives events exactly as
   * before" requirement rests on. */
  function teardown() {
    if (!active) return;
    detachListeners();
    removeHighlight();
    active = false;
    lastHighlightTarget = null;
  }

  function activate() {
    active = true;
    lastHighlightTarget = null;
    createHighlight();
    attachListeners();
  }

  function selectElement(target) {
    if (!target || typeof target.getBoundingClientRect !== "function") {
      teardown();
      return;
    }
    // design.md D6: the rect is read in the SAME frame as the selection, so
    // a reflow immediately afterward cannot shift what is captured relative
    // to what was highlighted.
    var rect = target.getBoundingClientRect();
    var computed = typeof window.getComputedStyle === "function" ? window.getComputedStyle(target) : null;
    var styles = filterStyles(computed);
    var rawMarkup = "";
    try {
      rawMarkup = sanitizeClone(target).outerHTML || "";
    } catch (e) {
      rawMarkup = "";
    }
    var trunc = truncateMarkup(rawMarkup, MARKUP_CEILING_BYTES);
    var regionInfo = rectToRegion(rect, window.innerWidth, window.innerHeight);
    var record = {
      selector: describeSelector(target),
      tagName: target.tagName ? String(target.tagName).toLowerCase() : "",
      markup: trunc.markup,
      markupTruncated: trunc.truncated,
      markupCeilingBytes: trunc.ceilingBytes,
      styles: styles,
      rectClipped: regionInfo.clipped
    };
    // Teardown BEFORE sending: the highlight node must already be gone from
    // the page before background.js's takeScreenshot() captures it (that
    // path settles two paint frames — see its own comment — which is why
    // removing the node here, synchronously, before the async message even
    // leaves this script, is enough).
    teardown();
    try {
      chrome.runtime.sendMessage({ type: "design_mode_selection", record: record, region: regionInfo.region });
    } catch (e) {
      // Extension context gone (navigation mid-selection, reload, ...) —
      // nothing to select into any more.
    }
  }

  function cancelPicking(reason) {
    var wasActive = active;
    teardown();
    if (!wasActive) return;
    try {
      chrome.runtime.sendMessage({ type: "design_mode_ended", reason: reason });
    } catch (e) {}
  }

  /** background.js's message contract (design.md D1, task 4.2): flat
   * snake_case types on the one chrome.runtime channel, matching
   * panel_bind_tab/tool_request's own convention. Only design_mode_start
   * (activate) and design_mode_stop (cancel, or a bound-page change) are
   * ever sent TO this script — design_mode_selection/design_mode_ended are
   * sent FROM it and answered by no branch here. Any other message type is
   * ignored WITHOUT calling sendResponse, so this listener can never be
   * mistaken for pointer-overlay.js's own onOverlayMessage listener (whose
   * ack shape — `{ok:true}` from a REAL overlay message — background.js's
   * isOverlayAck() specifically checks for; answering an unrelated message
   * here would fake that ack). */
  function handleMessage(msg, sender, sendResponse) {
    if (!msg || typeof msg.type !== "string" || msg.type.slice(0, 12) !== "design_mode_") return;
    if (msg.type === "design_mode_start") {
      // Idempotent re-arm: a second design_mode_start (background retried
      // delivery after a failed first attempt, or re-injected after a
      // navigation) tears down any stale state before arming fresh, rather
      // than layering a second set of listeners over the first.
      teardown();
      activate();
      sendResponse({ ok: true });
      return;
    }
    if (msg.type === "design_mode_stop") {
      teardown();
      sendResponse({ ok: true });
      return;
    }
  }

  chrome.runtime.onMessage.addListener(handleMessage);

  window.__browzyPickerDispose = function () {
    teardown();
    try { chrome.runtime.onMessage.removeListener(handleMessage); } catch (e) {}
  };
})();
