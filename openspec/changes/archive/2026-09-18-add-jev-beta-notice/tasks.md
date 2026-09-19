# Tasks: add-jev-beta-notice

## 1. The notice

- [x] 1.1 `extension/settings/settings.html`: a `Beta` badge (`<span class="beta-badge">`) beside the "Jev — ultrafast" provider-type choice, its own small style in the page's style block (existing tokens only), and a `typesafe`-only notice line (`id="typesafe-beta-notice"`) as the first element of the Jev section stating the integration is in beta and its behavior, quality, and results may change between releases — done: badge at the provider-type radio (line ~249), `.beta-badge` style from existing tokens (lines ~71-85), notice as the block's first element (line ~390) ← (verify: disclosure only, no behavior change)
- [x] 1.2 `README.md`: the provider-type paragraph and the Jev setup section name the beta status — done: `*(beta)*` on the provider list entry and a **Beta** note under the "Run it on TypeSafe (Jev)" heading ← (verify: disclosure only, no behavior change)

## 2. Tests and validation

- [x] 2.1 `test/settings-connection-gate.test.mjs`: pin the badge in the provider-type row, the notice inside the sliced TypeSafe block, and `.beta-badge` styling; keep the existing assertions green — done: three new assertions, all PASS ("the provider-type choice labels Jev — ultrafast as beta", "the Jev section carries the beta notice — behavior and results may change between releases", "the badge carries its own style in the page"), plus the notice-is-first ordering check; the whole suite stays green ← (verify: disclosure only, no behavior change)
- [x] 2.2 `node test/settings-connection-gate.test.mjs test/extension-csp-no-inline-scripts.test.mjs` green; `openspec validate add-jev-beta-notice --strict` valid — done: both suites green (plus `host`: `node --test test/settings-typesafe.test.mjs` green); validate valid ← (verify: only the owned files edited)
