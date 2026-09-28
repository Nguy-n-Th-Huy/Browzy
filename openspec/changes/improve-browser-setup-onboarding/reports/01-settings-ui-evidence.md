# Settings setup surface — UI evidence (this change's captures)

Change: `improve-browser-setup-onboarding`. Covers the settings page after the
change (`extension/settings/settings.html`, `settings-app.js`) and the same page
before it, so the two can be compared on the same harness at the same state.

## Environment

| | |
|---|---|
| Date | 2026-09-28 |
| Platform | darwin arm64 (macOS 25.6.0) |
| Browser | Google Chrome 153.0.8010.53, `--headless=new` |
| Node.js | v22 (for the test suites quoted below, not for the captures) |
| Harness | `design-review/screens/settings-live.html`, served from the repo root over `python3 -m http.server` |
| "Before" build | a pristine `git worktree` of `origin/master` (1b40e14), same harness file |

## Method, and what is real in these captures

There is no companion process and no installed extension in this session, so the
page cannot be opened straight from disk: `settings-app.js` touches `document`
at import time and reads the profile over `chrome.runtime`. The harness supplies
a `chrome.runtime.sendMessage` double that answers `get_profile` with a fixed
profile for the state under capture.

Everything else is shipped code, not a restatement of it: the harness fetches
`extension/settings/settings.html` and injects its `.panel-shell` and its own
page-local `<style>` verbatim, loads the real shared stylesheets
(`extension/ui/tokens.css`, `base.css`, `components.css`, `prose.css`), imports
the real `theme.js`, `behaviors.js` and `settings-app.js` module graph from the
tree under capture, and then drives disclosure by clicking the real toggles.

The harness **fails loudly** rather than silently: if `settings-app.js` did not
load, or if `?state=` names something it does not know, it paints a red
`#harness-error` banner at the top of the page. This is not decoration — the
first run of this harness had a wrong module path, and the pages it produced
were pictures of unstyled markup that still passed a "does this look like a
render" check. Every capture below was re-taken after that fix, and the driver
rejects any image containing that banner's colour in its top 40 rows.

Reproduce (from the repo root, with the harness committed as shown):

```bash
python3 -m http.server 8866
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless=new --disable-gpu --hide-scrollbars --no-first-run \
  --user-data-dir=/tmp/chrome-shots --window-size=400,800 \
  --virtual-time-budget=4000 --screenshot=out.png \
  "http://localhost:8866/openspec/changes/improve-browser-setup-onboarding/design-review/screens/settings-live.html?state=fresh"
```

`?state=` is `fresh | credential | models | passed | chatgpt | jev | loaderror`;
`?theme=` is `light | dark`; `?sections=` is `default | open | closed`; and
`?scrollTo=<element id>` centres a named control, which is how the two
"where does Save actually live" captures are framed identically before and after.

## Measurements

Same harness, same state, same 400 px-wide panel, measured in the page (not
eyeballed from the images):

| State | Before (master) | After (this change) |
|---|---|---|
| `fresh` — new user, nothing configured | content **2878 px**; **0** collapsible sections; the Jev browser-tools block always rendered, **1042 px** of it, starting 955 px down; `Lưu` at **2046 px** from the top | content **1389 px** (−52 %); **5** collapsible sections; Jev in its own closed section; `Lưu` at **1008 px** (−51 %) |
| `passed` — configured profile, nothing left to do | content **2717 px**; **0** collapsible sections; Jev always rendered; `Lưu` at 1750 px | content **757 px** (−72 %) — **the whole page fits in one 800 px viewport**, with all five headings, their state labels and the setup card still on screen |

Both "after" figures are the page's own default for that state, not a staged
one: for `passed`, every section defaults closed because each one's step is
done; for `fresh`, the provider section is open because it is the next step.

## Captures

All in `design-review/captures/`, named `<view>-<width>-<theme>.jpg` like the
archived captures of `migrate-to-claude-agent-sdk`.

| Capture | State | What it shows |
|---|---|---|
| `settings-fresh-400-light.jpg` | `fresh` | The setup card naming the three steps with the next one marked, then the provider section open and the four other sections closed. The default first-run view. |
| `settings-fresh-400-dark.jpg` | `fresh`, dark | The same, on the dark token set. |
| `settings-untested-400-light.jpg` | `passed` | A configured profile: provider and model steps marked `Xong`, the connection step carrying `Chưa xác nhận` rather than a claim that the test never ran. |
| `settings-collapsed-400-light.jpg` | `passed`, all sections closed | The page as a returning user leaves it — every section a heading with its state label. |
| `settings-all-open-400-light.jpg` | `fresh`, all sections forced open, centred on `#section-other` | Nothing was removed to make the collapsed view short: the two sections that are *never* open by default (Skills & tiện ích, Sao lưu) hold exactly the content they held before. |
| `settings-save-400-light.jpg` | `fresh`, centred on `#btn-save` | `Lưu` / `Kiểm tra kết nối` with the provider fields above them — no advanced configuration in between. |
| `settings-chatgpt-400-light.jpg` | `chatgpt` | The ChatGPT half: sign-in actions, the unofficial-backend disclosure, and the ChatGPT-specific test disclosure. |
| `settings-loaderror-400-light.jpg` | `loaderror` | The companion cannot be read: the card names the dependency and no step list is offered, since none of the steps can be carried out yet. |
| `settings-jev-400-light.jpg` | `jev`, all sections open, centred on `#jevtools-fields` | The Jev browser-tools block where it now lives — its own section, after the provider connection row. |
| `settings-320-light.jpg` | `fresh`, 320 px | The narrow layout: the nav scrolls inside itself and the page body does not scroll horizontally. |
| `settings-before-fresh-400-light.jpg` | `fresh` (before) | The old page: first-run banner, status card whose line puts the model list in the wrong section, and one uninterrupted scroll. |
| `settings-before-save-400-light.jpg` | `fresh`, centred on `#btn-save` (before) | The same framing as `settings-save-400-light.jpg`: `Lưu` sitting below the optional Jev block. |
| `settings-before-jev-400-light.jpg` | `fresh`, centred on `#jevtools-fields` (before) | The same framing as `settings-jev-400-light.jpg`: the Jev block inline in the provider group. |

## Self-check of the captures themselves

Every image above is verified, not assumed — a capture that is a picture of a
page that failed to render still looks like a page.

| Check | Result |
|---|---|
| Dimensions | all 13 are 400 × 800, except `settings-320-light` at 320 × 800 |
| Real render, not a flat frame | 1 135 – 7 555 distinct colours per image |
| Harness failure banner absent | 0 banner pixels in the top 40 rows of every image (the driver rejects a capture that has them) |
| The dark capture is actually dark | mean luma **28.8** for `settings-fresh-400-dark` against 238 – 244 for every light capture |
| No two captures are the same picture | one duplicate was found and fixed: `settings-all-open-400-light` was framed identically to `settings-fresh-400-light` (the sections it opens all sit below the fold), so it is now framed on the sections that are never open by default |
| The `scrollTo` framing actually ran | the three `before` captures are no longer byte-identical, and each differs from its unframed sibling; a framing that does not run would produce a copy of the top-of-page view |

Two of these checks exist because this harness got them wrong first. The module
path was wrong on the first attempt (every capture was unstyled markup), and the
`scrollTo` framing silently did nothing on the second (three "before" images
byte-identical to each other). Both are the reason the harness now fails loudly
and the driver refuses the image.

## Limits of this evidence

- **The side panel is not captured here.** `sidepanel.js` boots against the whole
  `chrome.*` surface (`runtime.connect`, `storage`, `tabs`, `sidePanel`) and this
  repository has no stand-alone panel harness, so its pre-setup state is
  verified by running the shipped `emptyStateHtml`/`deriveSetupInput` in Node
  with injected dependencies (`test/sidepanel-setup-walkthrough.test.mjs`), not
  by a picture. That is a real gap in what a reviewer can see, and it is stated
  rather than papered over.
- **These are viewport captures, not full-page ones.** Chrome's new headless
  mode has no full-page screenshot flag, so the "how long is the page" claim is
  made by the measured pixel heights above, not by the images. The two
  `scrollTo`-framed pairs exist so the before/after comparison shows the same
  control in the same position rather than two different scroll offsets.
- **369 px of the 400 px captures is the page's own `max-width: 640px`
  container**, so the images are of the narrow layout. `settings-fresh-400-*`
  and `settings-320-light.jpg` between them cover the widths this panel is
  actually used at; the 640 px layout is the same layout with longer lines.