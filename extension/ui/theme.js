/*
 * Theme persistence: system default via prefers-color-scheme, plus a
 * persisted light/dark override that wins in both directions (see
 * tokens.css for the CSS side of this contract).
 *
 * Works in two hosts:
 *  - an extension page (settings/sidepanel), where the override is stored
 *    in chrome.storage.local so it is shared across pages;
 *  - a plain file:// reference page (design-review/), where no chrome.*
 *    APIs exist, so the override falls back to localStorage.
 *
 * No build step, no framework. Import as a module:
 *   <script type="module" src="../ui/theme.js"></script>
 * and it applies the stored theme before first paint of the caller's own
 * content (call `initTheme()` explicitly at the top of the page's own
 * module if you need the guarantee synchronously; import side effects
 * apply it as soon as this module runs).
 */

const STORAGE_KEY = "ocic_theme_override"; // "light" | "dark" | null

function hasChromeStorage() {
  try {
    return typeof chrome !== "undefined" && !!chrome.storage && !!chrome.storage.local;
  } catch {
    return false;
  }
}

async function readOverride() {
  if (hasChromeStorage()) {
    try {
      const result = await chrome.storage.local.get(STORAGE_KEY);
      return result[STORAGE_KEY] || null;
    } catch {
      return null;
    }
  }
  try {
    return window.localStorage.getItem(STORAGE_KEY) || null;
  } catch {
    return null;
  }
}

async function writeOverride(value) {
  if (hasChromeStorage()) {
    try {
      if (value) await chrome.storage.local.set({ [STORAGE_KEY]: value });
      else await chrome.storage.local.remove(STORAGE_KEY);
      return;
    } catch {
      /* fall through to localStorage as a best-effort backup */
    }
  }
  try {
    if (value) window.localStorage.setItem(STORAGE_KEY, value);
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* storage unavailable (private mode, quota) -- theme just won't persist */
  }
}

function applyThemeAttr(value) {
  const root = document.documentElement;
  if (value === "light" || value === "dark") root.setAttribute("data-theme", value);
  else root.removeAttribute("data-theme");
}

function applyReducedMotionAttr() {
  const root = document.documentElement;
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduce) root.setAttribute("data-motion", "reduce");
  else root.removeAttribute("data-motion");
}

let current = null; // cached override value

/** Apply the persisted override (or system default) immediately. */
export async function initTheme() {
  current = await readOverride();
  applyThemeAttr(current);
  applyReducedMotionAttr();
  window
    .matchMedia("(prefers-reduced-motion: reduce)")
    .addEventListener("change", applyReducedMotionAttr);

  // Cross-page sync: another open extension page changed the override.
  if (hasChromeStorage() && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && STORAGE_KEY in changes) {
        current = changes[STORAGE_KEY].newValue || null;
        applyThemeAttr(current);
        document.dispatchEvent(new CustomEvent("ocic-theme-change", { detail: { theme: current } }));
      }
    });
  } else {
    window.addEventListener("storage", (e) => {
      if (e.key === STORAGE_KEY) {
        current = e.newValue || null;
        applyThemeAttr(current);
        document.dispatchEvent(new CustomEvent("ocic-theme-change", { detail: { theme: current } }));
      }
    });
  }
  return current;
}

/** Explicitly set "light", "dark", or null (follow system). */
export async function setThemeOverride(value) {
  current = value;
  applyThemeAttr(value);
  await writeOverride(value);
  document.dispatchEvent(new CustomEvent("ocic-theme-change", { detail: { theme: value } }));
}

/** The currently active override, or null if following system. */
export function getThemeOverride() {
  return current;
}

/** Resolved theme actually in effect right now ("light" | "dark"). */
export function resolvedTheme() {
  if (current === "light" || current === "dark") return current;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function prefersReducedMotion() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

// Apply as early as possible on import so there is no flash of the wrong
// theme; initTheme() re-runs the same logic and is safe to await too.
initTheme();
