// Colour/formatting helper for the `browzy` installer CLI's output
// (install/uninstall/doctor). This is a diagnostic tool whose output gets
// pasted into bug reports, so colour is decoration only: every caller still
// writes the plain-English word ("exists", "MISSING", "Registered", ...)
// into the string, and colour just paints part of it. Stripping the escape
// codes must never remove information.
//
// `styleText` was added to node:util in Node 20.12 / 21.7 — this package's
// engines floor is Node >=18, so it must be feature-detected rather than
// statically imported (a static `import { styleText } from "node:util"`
// would throw a SyntaxError at parse time on Node 18, before any of this
// file's own fallback logic could run).
import util from "node:util";

/**
 * @param {{env?: NodeJS.ProcessEnv, isTTY?: boolean, styleText?: Function|null}} [opts]
 *   `styleText` is an injection point for tests (pass `null` to force the
 *   plain-text fallback even on a Node version that has the real function).
 */
export function createStyle(opts = {}) {
  const env = opts.env ?? process.env;
  const isTTY = opts.isTTY ?? Boolean(process.stdout && process.stdout.isTTY);
  const styleTextFn =
    "styleText" in opts ? opts.styleText : typeof util.styleText === "function" ? util.styleText : null;

  // NO_COLOR (https://no-color.org): disable when the variable is present
  // at all, regardless of its value.
  const noColorRequested = Object.prototype.hasOwnProperty.call(env, "NO_COLOR");

  const enabled = Boolean(styleTextFn) && isTTY && !noColorRequested;

  function paint(format, text) {
    if (!enabled) return text;
    try {
      return styleTextFn(format, text);
    } catch {
      return text;
    }
  }

  return {
    enabled,
    bold: (t) => paint("bold", t),
    dim: (t) => paint("dim", t),
    green: (t) => paint("green", t),
    yellow: (t) => paint("yellow", t),
    red: (t) => paint("red", t),
    cyan: (t) => paint("cyan", t),
    // Symbol + colour together, so a viewer without colour still sees a
    // distinct glyph and the plain word right after it.
    ok: (t) => paint("green", t),
    warn: (t) => paint("yellow", t),
    fail: (t) => paint(["red", "bold"], t)
  };
}

export const SYMBOL = {
  ok: "✔", // ✔
  warn: "⚠", // ⚠
  fail: "✖", // ✖
  info: "•" // •
};
