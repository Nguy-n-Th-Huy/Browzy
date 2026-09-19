## Why

Browzy drives the user's real browser. When a page shows credentials, card numbers, or account data — a bank page, a checkout, an admin console — every screenshot and every read (`read_page`, `get_page_text`) carries those values into the model's context and into the transcript. The user can do nothing about it from inside the workflow: the values are simply on the page, and the agent looking at the page is the leak.

The Orca reference (stablyai/orca, this change's study source) solves the same problem from the other side. Its in-app browser exposes a direct per-tab `evaluate` (`src/main/browser/cdp-page-commands.ts` → CDP `Runtime.evaluate`), and its grab pipeline treats sensitive values as first-class: a curated secret-pattern list (`src/shared/browser-grab-types.ts`'s `GRAB_SECRET_PATTERNS`) redacts secret-bearing values in the guest script, the main process re-validates the payload as defense in depth, and URLs are stripped of query strings/fragments so tokens cannot ride along. Its token discipline — precise patterns, never broad words like "state" or "code" — is what keeps the redaction from degrading ordinary pages, and it is carried into this change.

This change adds the missing piece to Browzy: a page operation that masks sensitive information on the DOM before the agent looks. One call, and the screenshot shows dots, the reads return placeholders, the layout is unchanged, and nothing about form values or submissions is touched.

## What Changes

- New registry tool `mask_sensitive_info` (`action: mask|unmask`, `tabId`, optional `selectors`), executed through the content script exactly like the existing read tools.
- Built-in detection: password fields (`type="password"`, `autocomplete` current-password/new-password), payment inputs (cc-number/cc-csc/cc-exp*), one-time-code fields, and name/id/placeholder/aria-label/label matches against a curated token list — Orca's `GRAB_SECRET_PATTERNS` plus payment/identity/bank additions — matched with whole-split-token equality for short words ("ssn" never fires inside "classname") and compacted-field matching for joined forms ("card_number" and "cardNumber" both reach "cardnumber"). Broad words ("state", "code", "auth", "token" alone) are deliberately excluded.
- Masking mechanics: matched form controls render as dots via `-webkit-text-security` plus a dashed outline; matched non-control elements have their text nodes replaced with a `••••••` placeholder whose originals are kept in memory for unmask. No input's `value` property is ever written, no events are dispatched, layout is preserved.
- Read-path honesty: `read_page` renders a masked control's live value as the dot placeholder; `get_page_text` cannot leak masked text (text nodes already replaced) and clones of masked textareas are masked too.
- Reversible: `unmask` restores replaced text and clears all mask attributes/styles. Current document only — a navigation starts unmasked.
- Classification: `mask_sensitive_info` is read-only for the borrowed-tab gate (it is the protective counterpart of a read — precisely where it must be usable on the bound page), not send-class, and takes no script source.
- Record `mask_sensitive_info` in the enumerated post-baseline additions; regenerate the registry baseline fixture.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `agent-browser-runtime`: gains a requirement for the masking operation itself; a requirement that masked content stays masked through the read and capture paths; and a requirement that masking is not a capability grant (no script source, not send-class, read-only classification).

## Impact

- `host/tool-definitions.js` — new `mask_sensitive_info` schema; header counts 30 → 31.
- `extension/content.js` — the mask module: descriptor matcher, apply/unmask, two message handlers, read-path integration in `generateAccessibilityTree` and `getPageText`'s `cleanText`.
- `extension/background.js` — the handler (same shape as `get_page_text`); `SHORTCUT_TAB_SCOPED_TOOLS`.
- `host/agent/tools/mapping.js` — read-only classification; `TAB_TARGET_ARG_KEYS`.
- `host/agent/policy/authorization.js` — `TAB_ARG_KEYS`.
- `extension/events/action-events.js`, `extension/sidepanel/tool-labels.js`, `extension/agent/cic-prompt.js` — action classification, Vietnamese label, prompt documentation.
- `test/registry-baseline.test.mjs` + `test/fixtures/registry-baseline.json` — bookkeeping and regenerated snapshot.
- `extension/background.js` is a service worker — reload required.
