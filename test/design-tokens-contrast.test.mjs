#!/usr/bin/env node
// The palette in extension/ui/tokens.css, measured rather than eyeballed.
//
// Nothing downstream hardcodes a colour: the panel, the settings screens and
// every card resolve through that one file. That is what makes a palette
// change cheap — and it is also why a single careless value there degrades
// contrast across the whole product at once, silently, with every test still
// green. This file is the thing that isn't silent.
//
// The tokens carry their measured ratios in comments. Comments drift; these
// assertions recompute the ratios from the shipped values, so a token edited
// without re-measuring fails here even if its comment still claims the old
// number.
//
// Thresholds are WCAG 2.1 AA: 4.5:1 for body-sized text, 3:1 for non-text
// boundaries (borders, focus rings, icon-only fills).
//
// Run: node test/design-tokens-contrast.test.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CSS = fs.readFileSync(path.join(ROOT, "extension", "ui", "tokens.css"), "utf8");

let fail = 0;
const ok = (cond, msg) => {
  console.log((cond ? "  PASS  " : "  FAIL  ") + msg);
  if (!cond) fail++;
};

// --- WCAG 2.1 relative luminance -----------------------------------------
const toLinear = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const luminance = ([r, g, b]) =>
  0.2126 * toLinear(r / 255) + 0.7152 * toLinear(g / 255) + 0.0722 * toLinear(b / 255);

function parseColor(value) {
  const v = String(value).trim();
  const hexMatch = v.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hexMatch) {
    let h = hexMatch[1];
    if (h.length === 3) h = h.split("").map((c) => c + c).join("");
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  }
  // rgba() is only used for tints and scrims, which are composited over an
  // unknown backdrop and therefore deliberately excluded from these checks.
  return null;
}

function ratio(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Read one theme's token values.
 *
 * The file declares light on a bare `:root`, then repeats dark twice — once
 * under a `prefers-color-scheme` media query and once under an explicit
 * `[data-theme="dark"]`. Both dark blocks must agree, or a viewer who forces
 * the theme sees different colours from one who lets the system choose;
 * that agreement is asserted below rather than assumed.
 */
function readBlock(startPattern) {
  const at = CSS.search(startPattern);
  if (at < 0) return null;
  const open = CSS.indexOf("{", at);
  let depth = 0;
  let end = open;
  for (let i = open; i < CSS.length; i++) {
    if (CSS[i] === "{") depth++;
    else if (CSS[i] === "}") {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }
  const body = CSS.slice(open + 1, end);
  const out = {};
  for (const m of body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)) out[m[1]] = m[2].trim();
  return out;
}

const light = readBlock(/^:root\s*\{/m);
const darkMedia = readBlock(/@media \(prefers-color-scheme: dark\)[\s\S]{0,120}?:root:not\(\[data-theme="light"\]\)\s*\{/);
const darkExplicit = readBlock(/^:root\[data-theme="dark"\]\s*\{/m);

console.log("\n== the file still has the three blocks this test reads ==");
ok(Boolean(light), "light values live on a bare :root");
ok(Boolean(darkMedia), "dark values live under a prefers-color-scheme media query");
ok(Boolean(darkExplicit), "and again under an explicit [data-theme=\"dark\"]");
if (!light || !darkMedia || !darkExplicit) {
  console.log("\nCannot continue without all three blocks.\n");
  process.exit(1);
}

console.log("\n== the two dark blocks agree ==");
// A viewer who forces dark and a viewer whose system is dark must get the
// same colours. Divergence here is invisible until someone reports that the
// theme toggle changes the shade.
{
  const colorKeys = Object.keys(darkMedia).filter((k) => k.startsWith("--color-"));
  const mismatched = colorKeys.filter((k) => darkMedia[k] !== darkExplicit[k]);
  ok(
    mismatched.length === 0,
    mismatched.length === 0
      ? `all ${colorKeys.length} colour tokens match between the media query and the explicit override`
      : `these differ between the two dark blocks: ${mismatched.join(", ")}`
  );
}

/** Assert one pairing, reporting the ratio it actually measured. */
function contrast(theme, name, fgToken, bgToken, min) {
  const fg = parseColor(theme[fgToken]);
  const bg = parseColor(theme[bgToken]);
  if (!fg || !bg) {
    ok(false, `${name}: could not parse ${fgToken} (${theme[fgToken]}) on ${bgToken} (${theme[bgToken]})`);
    return;
  }
  const r = ratio(fg, bg);
  ok(r >= min, `${name}: ${r.toFixed(2)}:1 (needs ${min}:1)`);
}

for (const [label, theme] of [["LIGHT", light], ["DARK", darkMedia]]) {
  console.log(`\n== ${label}: body-sized text needs 4.5:1 ==`);
  contrast(theme, "text on canvas", "--color-text", "--color-canvas", 4.5);
  contrast(theme, "text on surface", "--color-text", "--color-surface", 4.5);
  contrast(theme, "text on sunken", "--color-text", "--color-surface-sunken", 4.5);
  contrast(theme, "secondary text on canvas", "--color-text-secondary", "--color-canvas", 4.5);
  contrast(theme, "secondary text on surface", "--color-text-secondary", "--color-surface", 4.5);
  // The accent serves as link/active-nav text. In light that is a dedicated
  // darker step; in dark the authored cyan clears it directly.
  contrast(theme, "accent-as-text on canvas", "--color-accent-text", "--color-canvas", 4.5);
  contrast(theme, "accent-as-text on surface", "--color-accent-text", "--color-surface", 4.5);
  // A filled accent button's label. The light theme's value is dark, not
  // white — white reaches only 3.89:1 there.
  contrast(theme, "label on an accent fill", "--color-accent-fg", "--color-accent", 4.5);
  contrast(theme, "text-on-accent alias matches", "--color-text-on-accent", "--color-accent", 4.5);

  for (const status of ["running", "success", "danger", "warning"]) {
    contrast(theme, `status ${status} on canvas`, `--color-status-${status}`, "--color-canvas", 4.5);
    contrast(theme, `status ${status} on surface`, `--color-status-${status}`, "--color-surface", 4.5);
  }

  console.log(`\n== ${label}: non-text boundaries need 3:1 ==`);
  // Sunken is the binding constraint in both themes: a border that passes on
  // canvas can still fail against an input's own fill.
  contrast(theme, "border on canvas", "--color-border", "--color-canvas", 3);
  contrast(theme, "border on surface", "--color-border", "--color-surface", 3);
  contrast(theme, "border on sunken", "--color-border", "--color-surface-sunken", 3);
  contrast(theme, "focus ring on canvas", "--color-focus-ring", "--color-canvas", 3);
  contrast(theme, "focus ring on surface", "--color-focus-ring", "--color-surface", 3);
  contrast(theme, "accent fill on canvas", "--color-accent", "--color-canvas", 3);
}

console.log("\n== the aliases really are aliases ==");
ok(
  light["--color-text-on-accent"] === light["--color-accent-fg"],
  "light: --color-text-on-accent equals --color-accent-fg, as its comment claims"
);
ok(
  darkMedia["--color-text-on-accent"] === undefined || darkMedia["--color-text-on-accent"] === darkMedia["--color-accent-fg"],
  "dark: --color-text-on-accent is either inherited from light or equal to the dark --color-accent-fg"
);

console.log("\n== nothing downstream hardcodes a colour ==");
// This is the property that makes the palette a one-file change. If a raw
// hex appears in a consuming stylesheet, a future palette edit silently
// leaves it behind.
{
  const consumers = [
    "extension/sidepanel/sidepanel.css",
    "extension/ui/components.css",
    "extension/ui/base.css",
    "extension/ui/prose.css"
  ];
  for (const rel of consumers) {
    const text = fs.readFileSync(path.join(ROOT, rel), "utf8");
    const hexes = text.match(/#[0-9a-fA-F]{3,8}\b/g) || [];
    const rgbs = text.match(/\brgba?\(\s*\d/g) || [];
    ok(
      hexes.length === 0 && rgbs.length === 0,
      hexes.length === 0 && rgbs.length === 0
        ? `${rel} resolves every colour through a token`
        : `${rel} hardcodes ${hexes.length} hex and ${rgbs.length} rgb colour(s): ${[...hexes, ...rgbs].slice(0, 6).join(", ")}`
    );
  }
}

console.log(fail === 0 ? "\nALL DESIGN-TOKEN CONTRAST TESTS PASSED\n" : `\n${fail} FAILED\n`);
process.exit(fail ? 1 : 0);
