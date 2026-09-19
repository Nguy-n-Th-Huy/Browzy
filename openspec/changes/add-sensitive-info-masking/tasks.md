## 1. Schema and registry bookkeeping

- [x] 1.1 Add `mask_sensitive_info` to `TOOLS` in `host/tool-definitions.js` (`action: mask|unmask`, `tabId`, optional `selectors`); update the header counts to 31/6 and name this change.
- [x] 1.2 Add `mask_sensitive_info` to `POST_BASELINE_ADDITIONS` in `test/registry-baseline.test.mjs` with provenance, and regenerate `test/fixtures/registry-baseline.json`. ← (verify: `node test/_regen-baseline.mjs` wrote 31 entries; the fixture diff is exactly one added entry, `+37` lines, no removals; `registry-baseline` suite green)

## 2. Content-script mask module (`extension/content.js`)

- [x] 2.1 `maskCategoryForDescriptor(desc)`: pure, self-contained tables; `type=password` and sensitive `autocomplete` short-circuit; short tokens match whole split tokens; phrase tokens match compacted fields; broad words excluded. ← (verify: 30/30 matcher checks incl. the false-positive set "classname"/"spinner"/"state"/"code"/"auth"/"token")
- [x] 2.2 `maskSensitiveInfo(options)`: phase 1 over `input, textarea` by descriptor; phase 2 over caller `selectors` plus descendant controls; budgets (300 elements / 200 text nodes / 50 inner controls); receipt with counts by category, `already`, `invalidSelectors`, `capped`.
- [x] 2.3 Mechanics: `data-browzy-masked` attribute + single style element (dashed outline, caret suppression, `-webkit-text-security: disc` for controls); text nodes under non-control matches replaced with `••••••`, originals kept in memory.
- [x] 2.4 `unmaskSensitiveInfo()`: restore replaced text, remove every mask attribute (including strays), drop the style element. ← (verify: live check — `restored: 5`, card text restored byte-exact, every attribute null, style element gone, and getPageText showed the real text again)
- [x] 2.5 Message handlers `maskSensitiveInfo` / `unmaskSensitiveInfo`; export both on `window.__unblockedChrome`; header "Provides" note.
- [x] 2.6 Read-path integration: `generateAccessibilityTree` renders a masked control's value as the dot placeholder; `getPageText`'s `cleanText` masks a cloned masked textarea. ← (verify: live check — the tree carried `value="••••••"` and never the real card value; page text carried placeholders, never the real card text or the textarea's note)

## 3. Executor and policy

- [x] 3.1 `extension/background.js`: `mask_sensitive_info` handler mirroring `get_page_text`'s structure (group check, restricted-page check, `sendContentMessage`), with receipts for mask/unmask/no-match/error; add to `SHORTCUT_TAB_SCOPED_TOOLS`. ← (verify: 14/14 handler checks — scope refusal before any message, restricted pass-through, message shapes, receipts, error path)
- [x] 3.2 `host/agent/tools/mapping.js`: `mask_sensitive_info` in `READ_ONLY_LEGACY_TOOLS` (with the D4 rationale comment), in `TAB_TARGET_ARG_KEYS`, and update the exhaustive-classification comment to 31/6.
- [x] 3.3 `host/agent/policy/authorization.js`: `TAB_ARG_KEYS` entry.
- [x] 3.4 `extension/events/action-events.js`: `classifyAction` → `OTHER`; `summarize` case ("Mask sensitive info on the page" / "Unmask …").
- [x] 3.5 `extension/sidepanel/tool-labels.js`: Vietnamese label; `extension/agent/cic-prompt.js`: `MASK_SENSITIVE_INFO TOOL` section in `<available_tools>`. ← (verify: tool-label suite 8/8, incl. "no registry tool falls through to the raw-name fallback")

## 4. Tests

- [x] 4.1 New `test/mask-sensitive-info.test.mjs`: matcher table, handler wiring, structural pins on the read-path integration — 52 checks green.
- [x] 4.2 `node test/registry-baseline.test.mjs` passes with the regenerated fixture; classification coverage confirms all 31 tools classified with no gap and no overlap.
- [x] 4.3 Existing suites re-run: handlers ✓, action-events schema+emission ✓, extension-scripts-parse 8/8 ✓, extraction-honesty 8/8 ✓, new-element-marking ✓, borrowed-tab scope 11/11 ✓ + live-extraction 12/12 ✓, send-class-classifier 15/15 ✓, tool-label 8/8 ✓, host permission-modes ✓, agent-tool-adapter 6/6 ✓, secrets-redaction 4/4 ✓. Registry-count bookkeeping updated deliberately (never silently) in: `test/registry-sdk-mapping.test.mjs` (26+5−1 → 26+6−1, plus one added `mask_sensitive_info` read-only assertion), `test/webfetch-url-guard.test.mjs`, `host/test/agent-tool-permission-preapproval.test.mjs` (5/5 after: 31 total, 27 always-automatic), `host/test/external-mcp-launch-contracts.test.mjs` (13/13 after). Full `test/*.test.mjs` sweep: only the three pre-existing reds remain — `overlay-background-bridge`, `overlay-pointer`, `side-panel-group-scope` — each re-verified red on a stashed pristine HEAD before this change (not caused here).
- [x] 4.4 Live check (real Chromium, content.js injected into a fixture page with a chrome shim): mask returned `masked: 5` (password×2 / payment / otp / explicit); the screenshot shows dots in dashed outlines and the replaced text, with the control field left unmasked; `pwValueUnchanged: true`; read_page/get_page_text returned masked forms; a second mask was idempotent (`already: 5`); unmask returned `restored: 5` and every read path showed the real content again. Screenshot: `D:/Dev/_refs/mask-e2e/mask-shot.png` (scratch, not committed).
