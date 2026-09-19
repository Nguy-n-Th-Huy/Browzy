# Design — add-sensitive-info-masking

## Context and goal

The agent looks at the user's real pages; some of those pages display secrets. The leak paths are exactly two: pixels (screenshots/`computer` captures) and text (`read_page`'s accessibility tree, `get_page_text`'s extraction, and any later copy of either). The goal: one operation the agent can run before a capture or a read that makes both paths carry masked content, without changing the page's behavior.

## What was studied in the Orca reference

Repository: `stablyai/orca` (shallow clone studied read-only; no code copied — patterns and discipline only).

- **Eval-injection mechanism.** `src/main/browser/cdp-page-commands.ts` exposes `evaluate(expression)` → CDP `Runtime.evaluate`, per tab, queued (`enqueueCommand`) so evaluations on one tab serialize; `src/main/browser/agent-browser-bridge-capture-commands.ts` exposes the same to the agent bridge; the CLI surface is `orca browser eval`. Browzy's equivalent mechanism already exists (`javascript_tool` → `Runtime.evaluate`); this change adds a second, special-purpose injection route through the content script — same one `read_page`/`get_page_text` use — because masking must work wherever a read works (including the borrowed/bound tab, where `javascript_tool` is deliberately refused) and must share the injection-recovery path rather than re-implement it.
- **Secret-pattern discipline.** `src/shared/browser-grab-types.ts`: `GRAB_SECRET_PATTERNS` (access_token, auth_token, api_key, client_secret, oauth_state, session_id, csrf, secret, password, passwd, x-amz-…) plus an explicit note on WHY broad words ("code", "state") are excluded — they match ordinary class names and would degrade extraction quality. That list is the base of this change's token tables.
- **Defense in depth.** Orca validates in the guest script AND re-clamps in the main process (`clampGrabPayload`), strips URL query strings/fragments, and allowlists attributes. Browzy's equivalent here is narrower by design (nothing extracted crosses a boundary in this change); the mirrored idea that survives is "the masking rules are data, evaluated the same way wherever they run, and the read paths must be honest about what masking did."
- **Injected-script craft.** `snapshot-cursor-interactive-elements.ts` injects via `Runtime.evaluate`, parks element references on a `window.__orca…` global, resolves them to backend node IDs, then deletes the global — bounded, cleaned up, and test-pinned (the grab guest scripts are pinned by SHA-256 in `grab-guest-script.test.ts`, and their redaction behavior has explicit tests such as "arm script contains secret pattern redaction").
- **What Orca does NOT do that this change does.** Orca redacts what its grab pipeline *extracts*; it does not mask the live DOM. Browzy's ask here is the other half: make the page itself — for pixels and for every later read — show masked content, reversibly, while keeping fields fillable and the layout intact.

## Decisions

### D1 — Home: `extension/content.js`, one message channel

The mask module lives in the content script, reached via two new message types (`maskSensitiveInfo` / `unmaskSensitiveInfo`) through the existing `sendContentMessage` path, with the same not-in-group and restricted-page checks every read tool has. Rationale: it must run exactly where reads run; the recovery machinery (re-inject, retry) already exists there; and the read-path integration points (`generateAccessibilityTree`, `getPageText`) are in this file, so the mask attribute's meaning is owned in one place. A separate injected file (the overlay pattern) would have needed a second channel and its own recovery for no gain — the overlay files earn their separation by being on-demand UI with their own overlay host, which masking is not.

### D2 — Mask text nodes by replacement, not by concealment

For non-control elements, the matched element's text nodes are replaced with `••••••` and their originals are kept in memory (`maskedRecords`, a plain module array — not WeakMap: unmask must enumerate them). CSS-only concealment (`color: transparent`) was rejected because `textContent` — which `getPageText` reads — would still carry the real value; replacement is what makes reads honest by construction. Absolute-positioned overlay boxes (the Playwright screenshot `mask` approach) were rejected: they need scroll/resize tracking, fight z-index, and produce fake pixels rather than a real DOM state. Bounds: 300 elements per call, 200 text nodes per element, 50 descendant controls per explicit-selector hit — a page cannot make the mask run unbounded.

### D3 — Controls keep their values; reads suppress them

A masked form control is never value-written. Clearing or stubbing `value` would break form semantics, fire framework re-renders (React controlled inputs simply put the value back), and turn a protective paint into a page mutation. Instead: `-webkit-text-security: disc` renders dots, and the AX tree renders a masked control's `value` as the same dot placeholder (integration in `generateAccessibilityTree`). `get_page_text` never reads input values as text; for `textarea` — whose value *is* its text content — the clone used by `cleanText` is masked before reading. Consequence, stated plainly: a page script or `javascript_tool` can still read the real value. This is a hygiene/leak-prevention feature for the agent's own inputs (pixels, reads), not a security boundary — same framing as Orca's grab redaction, which also does not claim to defeat page scripts.

### D4 — Read-only classification, deliberately

`mask_sensitive_info` joins `READ_ONLY_LEGACY_TOOLS` in `host/agent/tools/mapping.js`. It writes no values, dispatches no events, submits nothing, is reversible in one call, and its whole purpose is to *reduce* exposure of the page the run was handed — blocking it on a borrowed tab (where `javascript_tool` is refused) would forbid protection exactly where credentials are most likely on screen. This is a recorded decision, not an oversight: the flip to mutating is one line plus its classification comment if review disagrees. It is not send-class and carries no script source, so it never enters the approval classifier's territory.

### D5 — Token tiers

Two matching tiers, mirroring Orca's precision-over-recall stance: short tokens match a whole split token ("ssn" ≠ "classname", "pin" ≠ "spinner"), phrase tokens (≥ 6 compacted characters, plus 5-character `ccnum`/`ccexp`/`cccsc` forms) match a field's compacted alphanumerics so separators and camelCase both normalize ("card_number", "cardNumber" → "cardnumber"). Autocomplete and `type=password` short-circuit before tokens. The excluded-word list is a decision with tests: "state", "code", "auth", and bare "token" must never trigger.

### D6 — No automatic re-mask; re-apply is documented

A navigation drops everything (new document, nothing to restore — correct). A SPA re-render can detach replaced nodes or re-create fields unmasked; a MutationObserver re-scan is not part of this change. The tool description and prompt say "re-apply before the next capture" rather than pretending a persistence guarantee that does not exist. If evidence shows re-renders routinely unmask, a follow-up change owns the observer.

### D7 — The stub sweep must survive

At load and at unmask, every `[data-browzy-masked]` attribute on the document is removed — including marks whose record is gone (a re-injected script copy's leftovers) — and the style element is dropped when nothing remains. Marked-but-unrestorable text is a disclosed limitation: originals live only in the living script instance's memory.

## Unknowns and risks, named

- **Coverage of non-form sensitive content.** Displayed card numbers in plain text are only caught via explicit `selectors`. The heuristics deliberately do not scan text content for number patterns (false-positive cost on ordinary pages, and Orca's own discipline is the precedent). The tool's no-match response tells the agent exactly how to pass selectors.
- **Canvas/image text.** Invisible to any DOM approach; out of scope for every implementation of this kind.
- **Borrowed-tab classification.** D4 is the one decision most likely to be contested; it is recorded with its rationale so the contest can be resolved on the record.

## Verification

- `test/mask-sensitive-info.test.mjs`: the extracted matcher (table-driven, including the false-positive cases "classname"/"spinner"/"state"/"code"), the extracted handler (scope refusal, message shapes, receipts, error paths), and structural integration pins (the AX tree and `cleanText` carry the mask handling).
- `test/registry-baseline.test.mjs` (+ regenerated fixture): exactly one new entry, declared in `POST_BASELINE_ADDITIONS`; classification coverage green for the new name.
- Existing suites re-run unchanged (handlers, action events, extension parse, extraction honesty, borrowed-tab, new-element marking, registry-sdk-mapping) — nothing in this change may weaken them.
- Live check: content.js loaded into a real Chromium page (chrome shim), mask → screenshot shows dots/placeholders → reads return masked forms → unmask restores.
