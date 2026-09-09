# 05 — Visual system (task 5.0)

Shared visual tokens, primitives, and polished reference screens for chat,
settings, history and skills, built and visually QA'd **before** the real
`extension/sidepanel/`/`extension/settings/` exist, per design.md section 5a.

## Scope delivered

- `extension/ui/tokens.css` — color/spacing/type/radius/shadow/icon/motion
  tokens, light + dark + system + persisted-override theming, reduced motion.
- `extension/ui/base.css` — reset, body defaults, focus-visible, slim scroll.
- `extension/ui/components.css` — buttons, fields + grouped field set, card,
  menu/popover, switch, status pill, permission card, tool-activity
  timeline, slash-picker list, chip, connection-state.
- `extension/ui/prose.css` — assistant Markdown rendering (headings, lists,
  quotes, code blocks, contained table scroll, clickable source labels).
- `extension/ui/icons.js` — hand-authored 24×24 outline icon set (no
  external library), consistent stroke, `iconMarkup(name, {size, title})`.
- `extension/ui/theme.js` — system default via `prefers-color-scheme`, a
  persisted `light`/`dark` override (chrome.storage.local in an extension
  page, localStorage fallback for a plain page), and reduced-motion attr.
- `extension/ui/behaviors.js` — three light-DOM web components
  (`<ui-menu>`, `<ui-tool-row>`, `<ui-slash-picker>`) providing keyboard
  nav, positioning and expand/collapse, styled entirely by the shared CSS.
- `openspec/changes/migrate-to-claude-agent-sdk/design-review/` — 9
  standalone reference screens plus `shell.css` (panel-shell page
  scaffold local to this review, not a shared primitive) and 54 real
  captured screenshots under `design-review/captures/`.

No framework, no build step, no bundler. Everything is plain `<link>`/
`<script type="module">` files a MV3 extension page can import directly
(e.g. `<link rel="stylesheet" href="../ui/tokens.css">` from
`extension/settings/index.html`).

## Screen inventory (9 required screens × 3 widths × 2 themes = 54 captures)

All captures live in `design-review/captures/<screen>-<width>-<theme>.jpg`.

| Screen | File | 320 | 400 | 480 |
|---|---|---|---|---|
| Chat empty state (Vietnamese greeting + suggestions) | `screens/chat-empty.html` | PASS (dark+light) | PASS | PASS |
| Chat streaming (tool row + live cursor, Stop) | `screens/chat-streaming.html` | PASS | PASS | PASS |
| Chat long reply (full Markdown + jump-to-latest) | `screens/chat-long-reply.html` | PASS | PASS | PASS |
| Active tool timeline (5c states + thumbnail) | `screens/chat-active-tools.html` | PASS | PASS | PASS |
| Error state | `screens/chat-error.html` | PASS | PASS | PASS |
| Settings | `screens/settings.html` | PASS | PASS | PASS |
| History (conversations + recordings) | `screens/history.html` | PASS | PASS | PASS |
| Skills list | `screens/skills.html` | PASS | PASS | PASS |
| Slash picker | `screens/slash-picker.html` | PASS | PASS | PASS |

Every cell above is a **real screenshot taken through the browser
automation MCP** (`mcp__open-claude-in-chrome-hybrid__*`), not a mockup
description. All 54 files exist under `design-review/captures/`.

## How the screens were actually rendered (toolchain note)

**Correction (see `reports/12-navigate-scheme-fix.md`):** this was not a
`file://` limitation of the `navigate` tool. It was a bug in the tool's URL
normalization: it recognized only `http`/`https` (plus a few literal
`about:`/`chrome:`/`brave:` prefixes) and blindly prepended `https://` to
anything else, so a `file://` input — like any non-http(s) scheme — was
mangled into an unreachable host (`file:///D:/...` → `https://d/Dev/...`,
same class of corruption as the `chrome-extension://` case that
`12-navigate-scheme-fix.md` reproduces and fixes). At the time this session
ran, that bug was not yet diagnosed, so the workaround below was reasonable;
now that the root cause is fixed, `navigate` accepts `file://` URLs directly
and this workaround is no longer necessary for that purpose.

Workaround used (session-scoped, not required going forward for `file://`):
a minimal, dependency-free static file server
(`http`/`fs`/`path` only, no npm packages) bound to `127.0.0.1` only,
serving the repo root read-only, with `Cache-Control: no-store` so live
edits are always reflected. It was started/stopped for this session only
and is **not part of the deliverable** — it lived in the session scratch
directory and was torn down before finishing (`Get-NetTCPConnection
-LocalPort 4173` confirmed nothing bound afterward). To reproduce:

```bash
node <scratchpad>/qa-static-server.mjs "D:/Dev/www/open-claude-in-chrome" 4173
# then open http://127.0.0.1:4173/openspec/changes/migrate-to-claude-agent-sdk/design-review/screens/<screen>.html
```

Two more toolchain quirks were discovered and worked around, both
recorded here so a future session doesn't re-diagnose them:

1. **`resize_window` on a tab that lost OS-level selection is silently a
   no-op for layout** (Chrome does not re-layout an unselected tab; the
   tool's own response says so once you look for it). Fix: call
   `set_tab_focus` immediately before every `resize_window`.
2. A tall card using `overflow: hidden` + `border-radius` intermittently
   failed to paint content past a certain height in this environment's
   Chromium build (confirmed by comparing `getBoundingClientRect()`,
   which was always correct, against the actual screenshot pixels, which
   were not, at hit-tested points that DOM-wise were plainly visible).
   Root fix below (not a screenshot-tool limitation once traced) — see
   Defect 3.

## Token table (starting values → shipped values, with reasoning)

Design 5a's starting values are `#F7F5F2` (light canvas), `#191918` (dark
canvas), `#C4785B` (muted terracotta accent). Both survive unchanged as
`--color-canvas` and `--color-accent` in `extension/ui/tokens.css`. Two
adjustments were required for AA and are documented as code comments in
`tokens.css` itself:

1. Raw accent on the light canvas is ~3.1:1 (fails 4.5:1 for text); white
   label text on the raw accent is ~3.4:1 (fails). Rather than changing
   the accent hue, button/pill labels on an accent fill use a dedicated
   dark warm foreground (`--color-accent-fg: #201C17`), which reaches
   4.78–4.99:1 against the accent in **both** themes. A second, slightly
   darker accent variant (`--color-accent-text: #A85A3F`) is used only
   where the accent hue itself must serve as small text/links on the
   light canvas; on the dark canvas the raw accent already clears 5.18:1
   so `--color-accent-text` there is just an alias of `--color-accent`.
2. A single border color cannot be both "quiet" (design 5a bans dense
   borders) and pass 3:1 everywhere. Two tokens exist:
   `--color-border-subtle` (~1.2–1.9:1, decorative dividers/card edges
   reinforced by a background change or shadow, never the sole cue) and
   `--color-border` (≥3:1 in both themes, used for inputs, outlined
   buttons, and anything whose visibility is the only interactive cue).

| Token | Light | Dark | Purpose |
|---|---|---|---|
| `--color-canvas` | `#F7F5F2` | `#191918` | page background |
| `--color-surface` | `#FFFFFF` | `#232120` | raised: cards, composer, menus |
| `--color-surface-sunken` | `#EFEBE6` | `#121110` | inputs, code blocks |
| `--color-text` | `#23201C` | `#EDE8E1` | primary text |
| `--color-text-secondary` | `#6B6459` | `#A79E92` | muted text |
| `--color-border-subtle` | `#E4DFD8` | `#33302B` | decorative dividers |
| `--color-border` | `#93856F` | `#7C6E5C` | functional (≥3:1) borders |
| `--color-focus-ring` | `#8A4A32` | `#E3A583` | visible focus outline |
| `--color-accent` | `#C4785B` | `#C4785B` | design 5a value, unchanged |
| `--color-accent-text` | `#A85A3F` | `#C4785B` | accent as body-sized text |
| `--color-accent-fg` | `#201C17` | `#201C17` | label on accent-filled surfaces |
| `--color-status-running` | `#1D5FAE` | `#7EB6FF` | timeline/status pill |
| `--color-status-success` | `#1E7A46` | `#7FD9A6` | timeline/status pill |
| `--color-status-danger` | `#B3261E` | `#FF9A8A` | timeline/status pill, errors |
| `--color-status-warning` | `#8A5A00` | `#F0B85C` | timeline/status pill |
| `--space-*` | 4px base: 4/8/12/16/20/24/32/40/48 | | spacing scale |
| `--panel-gutter` | `clamp(12px, 3.5vw, 16px)` | | 12–16px panel gutters |
| `--font-size-body` | 15px, line-height 1.6 | | within 14–16px / 1.5–1.65 |
| `--font-sans` | system-ui/-apple-system/Segoe UI/Roboto/Noto Sans stack | | full Vietnamese coverage |
| `--font-serif` | Source Serif 4 → ui-serif/Georgia/Noto Serif → sans fallback | | headings only, restrained |
| `--radius-composer` | 16px | | |
| `--radius-md` / `--radius-sm` | 12px / 10px | | menus/cards |
| `--icon-size-*` | 16/18/20px | | consistent outline treatment |
| `--target-min` / `--target-primary` | 32px / 44px | | pointer targets |
| `--motion-duration` | 150ms (0.01ms under reduced-motion) | | opacity/color only |

Theming contract in `tokens.css`: the complete light palette lives on bare
`:root`; `@media (prefers-color-scheme: dark)` redefines only what
changes, guarded by `:root:not([data-theme="light"])`; `:root[data-theme="dark"]`
redefines the same set unconditionally so an explicit override wins in
both directions; `:root[data-theme="light"]` exists solely to satisfy
that guard. `theme.js` sets/clears `data-theme` from the persisted
preference and exposes `setThemeOverride`/`getThemeOverride`/`resolvedTheme`.

## Contrast table (WCAG 2.1 AA) — measured, not assumed

Computed with a standalone relative-luminance/contrast script (WCAG 2.1
formula), not eyeballed. AA requires ≥4.5:1 for normal text, ≥3:1 for
large text (≥18.66px semibold) and non-text UI components.

### Light theme

| Pairing | Ratio | Needs | Result |
|---|---|---|---|
| text `#23201C` / canvas `#F7F5F2` | 14.90:1 | 4.5 | PASS |
| text / surface `#FFFFFF` | 16.22:1 | 4.5 | PASS |
| text / surface-sunken `#EFEBE6` | 13.67:1 | 4.5 | PASS |
| text-secondary `#6B6459` / canvas | 5.37:1 | 4.5 | PASS |
| text-secondary / surface | 5.85:1 | 4.5 | PASS |
| accent-text `#A85A3F` / canvas | 4.60:1 | 4.5 | PASS |
| accent-text / surface | 5.00:1 | 4.5 | PASS |
| accent-fg `#201C17` / accent `#C4785B` (button label) | 4.99:1 | 4.5 | PASS |
| border `#93856F` / canvas | 3.31:1 | 3.0 | PASS |
| border / surface | 3.61:1 | 3.0 | PASS |
| border / surface-sunken | 3.04:1 | 3.0 | PASS |
| focus-ring `#8A4A32` / canvas | 6.21:1 | 3.0 | PASS |
| status-running `#1D5FAE` / canvas · surface | 5.85 · 6.36 | 4.5 | PASS |
| status-success `#1E7A46` / canvas · surface | 4.91 · 5.35 | 4.5 | PASS |
| status-danger `#B3261E` / canvas · surface | 6.01 · 6.54 | 4.5 | PASS |
| status-warning `#8A5A00` / canvas · surface | 5.45 · 5.93 | 4.5 | PASS |
| surface `#FFFFFF` (icon) / status-danger (solid Stop button) | 6.54:1 | 4.5 | PASS |
| accent raw `#C4785B` / canvas (large/non-text only) | 3.12:1 | 3.0 | PASS (large/UI only — never used for small text) |

### Dark theme

| Pairing | Ratio | Needs | Result |
|---|---|---|---|
| text `#EDE8E1` / canvas `#191918` | 14.44:1 | 4.5 | PASS |
| text / surface `#232120` | 13.15:1 | 4.5 | PASS |
| text-secondary `#A79E92` / canvas · surface | 6.66 · 6.07 | 4.5 | PASS |
| accent `#C4785B` / canvas (used directly as text/link) | 5.18:1 | 4.5 | PASS |
| accent / surface | 4.72:1 | 4.5 | PASS |
| accent-fg `#201C17` / accent (button label) | 4.99:1 | 4.5 | PASS |
| border `#7C6E5C` / canvas · surface | 3.55 · 3.24 | 3.0 | PASS |
| focus-ring `#E3A583` / canvas | 8.36:1 | 3.0 | PASS |
| status-running `#7EB6FF` / canvas · surface | 8.40 · 7.65 | 4.5 | PASS |
| status-success `#7FD9A6` / canvas · surface | 10.37 · 9.45 | 4.5 | PASS |
| status-danger `#FF9A8A` / canvas · surface | 8.58 · 7.82 | 4.5 | PASS |
| status-warning `#F0B85C` / canvas · surface | 9.82 · 8.94 | 4.5 | PASS |
| surface `#232120` (icon) / status-danger (solid Stop button) | 7.82:1 | 4.5 | PASS |

`--color-border-subtle` (light `#E4DFD8`≈1.2:1, dark `#33302B`≈1.3:1) is
**intentionally** below 3:1: it is decorative only (card edges reinforced
by a background/shadow change, list dividers next to a heavier row
background), never the sole way a user identifies an interactive
boundary or state. Every place where a border alone must carry that
meaning (inputs, outlined buttons, the connection dot's parent text)
uses `--color-border` (≥3:1) or `--color-focus-ring` (≥6:1) instead.

Vietnamese diacritics (ế ạ ữ ơ ị đ) were visually verified rendering
correctly in both the sans body font and the serif heading font across
every capture that contains Vietnamese copy (all 54) — see e.g.
`chat-empty-320-dark.jpg` ("Chào bạn, tôi có thể giúp gì?") and
`chat-long-reply-400-light.jpg`, which deliberately includes a
worst-case diacritic stress line ("đ ị ơ ữ ạ ế").

**Not verified in this pass** (disclosed rather than assumed): live
keyboard-only Tab-order traversal and a real OS-level
`prefers-reduced-motion: reduce` emulation run. The CSS mechanisms are
implemented and reviewed (media query in `tokens.css`;
`:focus-visible` outline with the contrast-verified `--color-focus-ring`
on every interactive primitive), but neither was exercised live in the
browser inside this session. `extension/sidepanel/`'s own task
(5.4/5.11) should re-verify both against the real panel.

## Defects found during visual QA, and their fixes

All of these were found by actually rendering and reviewing captures at
320/400/480px, not by reading the CSS — this is the part of 5.0 that
makes it more than a mockup dump.

1. **Composer placeholder wrapped to 2 lines and got clipped at 320px.**
   The full placeholder ("Nhắn tin, hoặc gõ / để dùng skill…") needed
   more width than the composer has left at 320px once the model
   selector and send button are accounted for (~154px available). The
   wrapped second line was hard-clipped by the panel shell's
   `overflow: hidden`, producing a visible half-cut sliver at the very
   bottom of the composer. **Fix:** shortened the placeholder to "Nhắn
   tin…" across all chat screens (the `/` hint lives in the slash-picker
   screen's own message instead), and added `overflow: hidden` directly
   on `.composer textarea` in `design-review/shell.css` as defense in
   depth so a future longer string clips inside its own rounded box
   instead of bleeding into the composer's neighbors.

2. **Jump-to-latest control positioned against the wrong containing
   block and could overlap the composer.** `.jump-latest` was
   `position: absolute` with no positioned ancestor, so it resolved
   against the initial containing block (in one clean repro, that
   evaluated to the viewport at whatever width the tab last actually
   rendered — see the tab-focus toolchain note above) rather than the
   scrollable reading area, and its `bottom: 16px` from the *whole
   panel* put it low enough to sit on top of the composer's top edge.
   **Fix:** moved the button to be the last child of `<main
   class="panel-scroll">` (which is `position: relative`) and made it
   `position: sticky; bottom: 12px` with `align-self: center` — it now
   floats within the scrollable region only, never past its bottom edge
   into the composer. (`chat-long-reply.html`, `shell.css`)

3. **Horizontal overflow (and a genuine paint bug) in the tool-activity
   timeline.** Two independent defects:
   - `.tool-row` was a flex **row** with two in-flow children
     (`.tool-row-summary`, `.tool-row-detail`) fighting over width
     (summary wanted `width: 100%`, detail wanted its natural content
     width) — the intended `.tool-row-main` wrapper that would have kept
     them stacked was never actually used in the markup. Detail content
     (e.g. the screenshot thumbnail) was squeezed to ~48px wide. **Fix:**
     changed `.tool-row` to `flex-direction: column` (its only in-flow
     children are summary and detail; the rail icon is `position:
     absolute` and unaffected) and removed the now-dead, never-used
     `.tool-row-main` rule instead of introducing markup nobody used.
   - The screenshot-thumbnail button used a fixed `width: 160px` that
     could exceed the row's available width at 320px; combined with a
     `<button>`'s form-control shrink-to-fit sizing, a first attempt at
     `width: min(160px, 100%)` on an `inline-block` button resolved
     against an indefinite containing block during shrink-to-fit and
     collapsed to icon-size. **Fix:** `display: block` (not
     `inline-block`) with `width: min(160px, 100%)` on `.tool-row-thumb`,
     so its width resolves against its real (definite) parent instead of
     its own shrink-to-fit pass; also added `overflow-x: hidden` to
     `.tool-timeline` as defense in depth (only the Markdown table is
     meant to scroll horizontally).
   Verified via `document.documentElement.scrollWidth === 320` (no page
   overflow) at every capture width afterward, and via a direct
   `getBoundingClientRect` check that the thumbnail box actually reaches
   ~160px, not ~32px.

4. **Settings connection-status row overflowed at 320px.** `.field-row`
   (`justify-content: space-between`, no wrap) held a status string plus
   three buttons (Xóa key / Kiểm tra kết nối / Lưu); at 320px their
   combined width exceeds the available ~256px, and the primary "Lưu"
   button rendered partly off the visible edge. **Fix:** `.field-row`
   now has `flex-wrap: wrap` and `min-width: 0` on its direct children;
   added a small reusable `.field-row-actions` class
   (`display:flex;flex-wrap:wrap;gap`) for any row of trailing action
   buttons, used here and for the model-catalog "Tìm mô hình / Thêm thủ
   công" row. At 320px the status now sits on its own line and the
   buttons wrap onto a second line instead of overflowing.

5. **History/settings/skills list titles didn't actually ellipsis, and
   overflowed horizontally.** `.list-item-title`/`.list-item-sub` are
   `<span>`s; `overflow: hidden; text-overflow: ellipsis; white-space:
   nowrap` has **no effect on an inline box** (only block/inline-block).
   A long model ID or conversation title therefore forced the whole row
   (and, transitively, the page) wider than 320px. **Fix:** added
   `display: block` to both rules in `design-review/shell.css`.
   Defensively added `min-width: 0` to `.chip-label` for the same class
   of bug (it happened to render correctly already because it's a flex
   item, which auto-blockifies, but it had no explicit shrink floor).

6. **A tall `overflow: hidden` + `border-radius` card silently failed to
   paint some of its own content in this environment.** After fixing
   defect 4/5, the settings "Nhà cung cấp" card (Base URL + API key +
   connection status, ~469px tall) still rendered with the bottom third
   of its content invisible — not clipped, genuinely unpainted: hit
   testing and `getBoundingClientRect()` at those coordinates correctly
   returned the expected element and text, but the screenshot pixels at
   that location showed the canvas color through. Toggling
   `.field-group`'s `overflow` between `hidden` and `visible` live
   reliably reproduced/fixed it, isolating the cause to that property on
   a container this tall. Since `.field-group-item` children are
   transparent (only the parent card has a background/border-radius),
   the `overflow: hidden` was buying nothing visually. **Fix:** removed
   `overflow: hidden` from `.field-group` entirely, with a code comment
   explaining why it's absent so a future edit doesn't reintroduce it
   without checking. Re-verified this decoupled from defect 4/5 by
   testing before and after their fixes.
   *(General caution for later work: any new `overflow: hidden` +
   `border-radius` container that can exceed a few hundred px in height
   should be spot-checked the same way — toggle `overflow` live and
   compare a screenshot, not just the DOM — before shipping it in
   `extension/sidepanel/`.)*

Every defect above was re-captured after its fix; the 54 files in
`design-review/captures/` reflect the fixed state, not the broken one.

## Visual review notes (beyond the defect log)

- Icon set: single hand-authored stroke family (1.75px, round caps/joins,
  24×24 viewBox scaled to 14–24px use sizes) — no mixing with a second
  icon style anywhere in the 9 screens.
- Spacing/hierarchy: 4px-based scale held consistently; empty state,
  cards and list rows all read as one system across screens.
- No heavy gradients, glass effects, saturated dashboard colors, or
  dense borders anywhere (the one linear-gradient, on the screenshot
  *placeholder* graphic standing in for a real captured image, is
  explicitly a stand-in and not part of the design system).
- No Anthropic branding, logo, or real-looking model ID: model IDs in
  `settings.html` are `claude-sonnet-5-20260101` /
  `claude-haiku-5-20260101` — placeholder-shaped, not copied from a real
  release.
- The "running" status is deliberately **static** (colored dot + label,
  no spinning/pulsing loop) per design 5a's ban on looping decorative
  animation — documented as a comment in `components.css` next to
  `.status-pill.is-running` so it isn't "fixed" into a spinner later
  without re-reading that constraint.
- Composer never moves as tool rows expand/collapse in any capture
  (`chat-active-tools-*`): the timeline lives in the scrollable message
  area above the fixed composer, confirmed visually at all 3 widths.
- No overlay hides the composer or its focused control in any capture
  (jump-to-latest fix above was exactly this check).
- Table (`chat-long-reply`) scrolls inside its own `.table-wrap`
  container at 320/400px; never forces the page wider — confirmed via
  `scrollWidth` checks, not just visually.

## Files touched

- `extension/ui/tokens.css`, `base.css`, `components.css`, `prose.css`,
  `icons.js`, `theme.js`, `behaviors.js` (new)
- `openspec/changes/migrate-to-claude-agent-sdk/design-review/shell.css`
  (new, review-local page scaffold)
- `openspec/changes/migrate-to-claude-agent-sdk/design-review/screens/*.html`
  (new, 9 files)
- `openspec/changes/migrate-to-claude-agent-sdk/design-review/captures/*.jpg`
  (new, 54 files)
- `openspec/changes/migrate-to-claude-agent-sdk/tasks.md` (5.0 marked done)

## Status

PASS for all 9 required screens at all 3 widths in both themes, with
every text/background/accent pairing actually used verified against
WCAG 2.1 AA (table above), six real defects found by rendering (not by
reading code) and fixed, and no known open horizontal-overflow or
composer-overlap issue at 320px. Two verification gaps are disclosed
above (live keyboard-focus traversal, live reduced-motion emulation) for
`extension/sidepanel/`'s own task to close against the real panel.
