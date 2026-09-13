/*
 * Hand-authored outline icon set. 24x24 viewBox, stroke=currentColor,
 * round joins/caps, no fill -- a single consistent treatment so nothing
 * else in the UI needs an icon font, an SVG sprite build step, or a CDN.
 *
 * Usage:
 *   import { iconMarkup } from "../ui/icons.js";
 *   el.innerHTML = iconMarkup("send", { size: 18 });
 */

const PATHS = {
  send: '<path d="M4 12L20 4L13 20L11 13L4 12Z" /><path d="M11 13L20 4" />',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2" />',
  settings:
    '<circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.04 1.56V21a2 2 0 1 1-4 0v-.09A1.7 1.7 0 0 0 8.96 19a1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.56-1.04H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.6 8.96a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1.04-1.56V3a2 2 0 1 1 4 0v.09A1.7 1.7 0 0 0 15 4.6a1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 9a1.7 1.7 0 0 0 1.56 1.04H21a2 2 0 1 1 0 4h-.09A1.7 1.7 0 0 0 19.4 15Z" />',
  history: '<path d="M3 12a9 9 0 1 0 3-6.7" /><path d="M3 4v5h5" /><path d="M12 7v5l3.5 2" />',
  skills:
    '<path d="M9 4a2 2 0 0 1 4 0v.5a1.5 1.5 0 0 0 1.5 1.5H15a2 2 0 0 1 0 4h-.5a1.5 1.5 0 0 0 0 3H15a2 2 0 0 1 0 4h-.5A1.5 1.5 0 0 0 13 18.5V19a2 2 0 0 1-4 0v-.5A1.5 1.5 0 0 0 7.5 17H7a2 2 0 0 1 0-4h.5a1.5 1.5 0 0 0 0-3H7a2 2 0 0 1 0-4h.5A1.5 1.5 0 0 0 9 4.5Z" />',
  chevronDown: '<path d="M6 9l6 6l6-6" />',
  chevronRight: '<path d="M9 6l6 6l-6 6" />',
  close: '<path d="M6 6l12 12M18 6L6 18" />',
  pin: '<path d="M12 2l1.5 5.5L19 9l-4.5 3.5L15 18l-3-2.5L9 18l.5-5.5L5 9l5.5-1.5Z" /><path d="M12 15.5V22" />',
  pinOff: '<path d="M3 3l18 18" /><path d="M14 6.5L19 9l-4.5 3.5" /><path d="M9.2 9.2L5 9l3.7 2.9L9 15.5" /><path d="M12 15.5V22" />',
  externalLink: '<path d="M14 4h6v6" /><path d="M20 4L10 14" /><path d="M18 13v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h5" />',
  mic: '<rect x="9" y="2" width="6" height="12" rx="3" /><path d="M5 11a7 7 0 0 0 14 0" /><path d="M12 18v4" /><path d="M8 22h8" />',
  plus: '<path d="M12 5v14M5 12h14" />',
  search: '<circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" />',
  check: '<path d="M4 12l5 5L20 6" />',
  alertTriangle: '<path d="M12 3.5L22 20H2Z" /><path d="M12 9.5v5" /><circle cx="12" cy="17.5" r="0.9" fill="currentColor" stroke="none" />',
  info: '<circle cx="12" cy="12" r="9" /><path d="M12 11v6" /><circle cx="12" cy="7.7" r="0.9" fill="currentColor" stroke="none" />',
  circle: '<circle cx="12" cy="12" r="8" />',
  circleDot: '<circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="2.5" fill="currentColor" stroke="none" />',
  page: '<path d="M7 3h7l4 4v14H7Z" /><path d="M14 3v4h4" />',
  // A page with body lines: the document card's own icon, distinguishable at
  // 20px from `page` (which marks a web page read, not a produced file).
  fileText: '<path d="M6 3h8l4 4v14H6Z" /><path d="M14 3v4h4" /><path d="M9 12h6M9 15.5h6M9 8.5h2.5" />',
  download: '<path d="M12 3v11" /><path d="M8 10.5l4 4l4-4" /><path d="M4 18.5v1a1.5 1.5 0 0 0 1.5 1.5h13a1.5 1.5 0 0 0 1.5-1.5v-1" />',
  click: '<path d="M8 4v5" /><path d="M8 9l7.5 3-3.2 1.3L11 16.5Z" />',
  clock: '<circle cx="12" cy="12" r="9" /><path d="M12 7v5l3.5 2" />',
  scroll: '<rect x="6" y="3" width="12" height="18" rx="2" /><path d="M9 8h6M9 12h6M9 16h3" />',
  keyboard: '<rect x="2" y="6" width="20" height="12" rx="2" /><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10" />',
  code: '<path d="M9 18L3 12l6-6" /><path d="M15 6l6 6-6 6" />',
  camera: '<path d="M4 8h3l1.5-2h7L17 8h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1Z" /><circle cx="12" cy="13.5" r="3.5" />',
  link: '<path d="M9.5 14.5l5-5" /><path d="M13 6l1-1a3.5 3.5 0 0 1 5 5l-1 1" /><path d="M11 18l-1 1a3.5 3.5 0 0 1-5-5l1-1" />',
  sun: '<circle cx="12" cy="12" r="4.5" /><path d="M12 2v2.5M12 19.5V22M4.2 4.2l1.8 1.8M18 18l1.8 1.8M2 12h2.5M19.5 12H22M4.2 19.8L6 18M18 6l1.8-1.8" />',
  moon: '<path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a6.7 6.7 0 0 0 10.5 10.5Z" />',
  monitor: '<rect x="3" y="4" width="18" height="12" rx="1.5" /><path d="M8 20h8M12 16v4" />',
  trash: '<path d="M4 7h16" /><path d="M9 7V4h6v3" /><path d="M6 7l1 13h10l1-13" /><path d="M10 11v6M14 11v6" />',
  refresh: '<path d="M4 4v5h5" /><path d="M20 20v-5h-5" /><path d="M5.5 9A7.5 7.5 0 0 1 19 8.5" /><path d="M18.5 15a7.5 7.5 0 0 1-13.5.5" />',
  folder: '<path d="M3 6a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1Z" />',
  checkCircle: '<circle cx="12" cy="12" r="9" /><path d="M8 12.5l2.5 2.5L16 9" />',
  xCircle: '<circle cx="12" cy="12" r="9" /><path d="M9 9l6 6M15 9l-6 6" />',
  slashCircle: '<circle cx="12" cy="12" r="9" /><path d="M7 7l10 10" />',
  helpCircle: '<circle cx="12" cy="12" r="9" /><path d="M9.5 9.2a2.5 2.5 0 1 1 3.7 2.2c-.9.5-1.2 1-1.2 1.8" /><circle cx="12" cy="17" r="0.9" fill="currentColor" stroke="none" />',
  slidersHorizontal: '<path d="M4 6h9M17 6h3M4 18h3M11 18h9" /><circle cx="15" cy="6" r="2" /><circle cx="9" cy="18" r="2" />',
  browser: '<rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 8h18" /><circle cx="6" cy="6" r="0.6" fill="currentColor" stroke="none" /><circle cx="8.4" cy="6" r="0.6" fill="currentColor" stroke="none" />',
  // Composer/per-message image-attachment marker. Outline-only like every
  // other non-dot accent icon (no fill override); used at small sizes (16px
  // in the per-message transcript attachment strip and the in-composer
  // thumbnail area). Not the busy spark glyph -- a different visual contract
  // entirely.
  image: '<rect x="3" y="4" width="18" height="16" rx="2" /><circle cx="8" cy="9.5" r="1.5" /><path d="M21 16l-5-5L5 20" />',
  attach: '<path d="M17.5 8.5l-7 7a3.5 3.5 0 0 1-5-5l7.5-7.5a2.3 2.3 0 0 1 3.3 3.3l-7.2 7.2a1.1 1.1 0 0 1-1.6-1.6l6.4-6.4" />',
  // Copy-to-clipboard affordance (per-answer copy button). Outline-only like
  // the rest of the set: two overlapping rounded rectangles.
  copy: '<rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />',
  // 8-point filled starburst (busy/working indicator). Deliberate exception
  // to this set's outline convention: the whole path carries the same
  // fill="currentColor" stroke="none" override the dot accents above
  // (alertTriangle, info, circleDot, browser) already use -- the shared
  // <svg> wrapper stays fill="none" stroke="currentColor" for every icon.
  // 24x24 viewBox, 4 long points at r=9.5 on the cardinals, 4 short points
  // at r=6 on the diagonals, concave quadratic waists (control radius ~2.2)
  // between adjacent points.
  spark:
    '<path d="M12,2.5 Q12.84,9.97 16.24,7.76 Q14.03,11.16 21.5,12 Q14.03,12.84 16.24,16.24 Q12.84,14.03 12,21.5 Q11.16,14.03 7.76,16.24 Q9.97,12.84 2.5,12 Q9.97,11.16 7.76,7.76 Q11.16,9.97 12,2.5 Z" fill="currentColor" stroke="none" />',
  // Administrator-controlled marker (permission mode / approved-sites pages
  // — add-permission-modes-and-threat-signals task 7.1/7.8): a padlock.
  lock: '<rect x="5" y="10.5" width="14" height="10" rx="2" /><path d="M8 10.5V7a4 4 0 0 1 8 0v3.5" />',
  // Empty-state glyph for the approved-sites page (task 7.8).
  shield: '<path d="M12 3l7 3v6c0 4.5-3 7.5-7 9c-4-1.5-7-4.5-7-9V6Z" /><path d="M9 12l2 2l4-4" />',
};

/**
 * Return an inline <svg> markup string for the named icon.
 * @param {keyof typeof PATHS} name
 * @param {{size?: number, strokeWidth?: number, title?: string}} [opts]
 */
export function iconMarkup(name, opts = {}) {
  const size = opts.size || 18;
  const sw = opts.strokeWidth || 1.75;
  const inner = PATHS[name];
  if (!inner) {
    console.warn(`[ui/icons] unknown icon "${name}"`);
    return "";
  }
  const titleEl = opts.title ? `<title>${escapeXml(opts.title)}</title>` : "";
  return (
    `<svg class="ui-icon" width="${size}" height="${size}" viewBox="0 0 24 24" ` +
    `fill="none" stroke="currentColor" stroke-width="${sw}" ` +
    `stroke-linecap="round" stroke-linejoin="round" aria-hidden="${opts.title ? "false" : "true"}" ` +
    `role="${opts.title ? "img" : "presentation"}">${titleEl}${inner}</svg>`
  );
}

export const iconNames = Object.keys(PATHS);

function escapeXml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
