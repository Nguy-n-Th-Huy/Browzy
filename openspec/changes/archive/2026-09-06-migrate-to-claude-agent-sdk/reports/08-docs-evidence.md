# Task 8.3 — Documentation evidence report

Scope: `openspec/changes/migrate-to-claude-agent-sdk` task 8.3. Files owned
and edited: `README.md`, the "Next steps" guidance text in `install.sh` and
`install.ps1` (registration logic, path handling, and ID derivation were not
touched — verified by diff review before finishing), `tasks.md` (8.3
checkbox only). `docs/**` was inspected (`docs/img/`,
`docs/imitation-learning-alignment.html`) and needed no change: the HTML file
documents the recorder's design and does not describe the SDK/side-panel
work in scope here, and `docs/img/` holds only referenced screenshots.
`extension/**` and `host/**` were read-only (for verification of claims made
below), never edited, per this task's scope boundary.

## Method

Every claim below traces to one of: an evidence report already produced by
this change (`reports/01` through `reports/10`), a direct read of the actual
source file named, or a command run in this session and shown inline. Where
a design-intended capability is not yet implemented, the README says so
explicitly rather than describing it as shipped — see "What was deliberately
NOT claimed" below.

## README.md — substantive claims and their evidence

| Claim (README section) | Evidence source |
|---|---|
| Registry has 26 tools, not 21 (multiple locations, plus the "What's Different" and "Available Tools" tables) | `reports/06-registry-baseline.md` ("Live registry has 26 entries..."); independently re-verified this session: `grep -c 'name: "' host/tool-definitions.js` → 26 |
| 19 of the 26 have a named official-extension equivalent (marked ✓/✗ in the tools table); 7 have none (blank Parity column) | README's own pre-existing "Available Tools" table (unmodified rows, only the header/legend text and the count-correction intro were edited this session); cross-checked against `reports/06-registry-baseline.md`'s per-tool table |
| `gif_creator`, `shortcuts_list`, `shortcuts_execute` are currently unimplemented stubs returning a fixed "not supported"/"not yet implemented" text regardless of arguments, despite fully declared schemas | `reports/06-registry-baseline.md`: "Three entries ... are currently unimplemented stubs in this build — their handlers return a fixed 'not yet implemented' / 'not supported' text string regardless of arguments, even though their input schemas are fully declared and validated." |
| The side panel runs the Claude Agent SDK in a local native companion, started automatically by native messaging, no user-run MCP server | `reports/03-companion-evidence.md` (companion supervision in `native-host.js`); `reports/01-sdk-gate-evidence.md` gate 1.2 (in-process SDK MCP tools, no user MCP registration) |
| No Claude account, subscription, or OAuth needed for the side panel — API-key mode only | `reports/01-sdk-gate-evidence.md` gate 1.6 and `reports/09-live-gate-evidence.md` ("no Claude account, subscription, OAuth token, or official extension was used or referenced anywhere in the isolated `options`/`env` objects, confirmed against real, non-placeholder values") |
| Side panel exists and works today for streaming chat, model selection, connection/error states, send/stop, conversation history, recording list/attach/start/stop, screenshot-verified at 320/400/480px light/dark | `reports/05-panel-evidence.md`, `reports/05-visual-system.md`; `tasks.md` 5.0–5.4 (all ticked `[x]`) |
| Side panel does NOT yet have: automatic current-page binding, visible on-page cursor/action timeline, Settings > Skills UI / slash picker | `tasks.md` 5.5–5.13 (all unticked, "NOT STARTED"), `reports/10-task-reconciliation.md`'s group-5 table; `reports/07-skills-evidence.md` / `reports/04-settings-ui-evidence.md` confirm no Settings > Skills page exists yet |
| Skills catalog/import/dispatch-authorization logic exists and is wired into the same isolated `query()` options a side-panel run uses, but has no Settings UI yet | `reports/07-skills-evidence.md` ("Task 7.2 SDK-facing wiring — closed" addendum); `tasks.md` 7.2 ticked, 7.3 unticked with "NOT STARTED ... no page exists yet" |
| Provider settings: Base URL normalization rules, `x-api-key`-only auth (never Bearer), per-machine OS credential store, no cross-machine sync, offline save vs. tested-required run, key-replacement/deletion behavior | `reports/04-settings-evidence.md` (full url/http-client/profile/secret-store detail); `reports/04-settings-ui-evidence.md` (Settings UI) |
| Provider compatibility matrix: streaming, tool use, vision, model discovery all pass for `claude-opus-5`/`claude-sonnet-5` against a real gateway | `reports/09-live-gate-evidence.md` ("Capability matrix (both configured models, real endpoint)") |
| Quirk: model discovery can return a mixed-vendor catalog | `reports/09-live-gate-evidence.md` ("a 31-entry mixed-vendor catalog") |
| Quirk: a response can include a `thinking` block before `text` | `reports/09-live-gate-evidence.md` ("Real message streams include `thinking` and `redacted_thinking` content blocks preceding `tool_use`/`text`") |
| Quirk: a tested gateway reports "model not found" as a retried HTTP 503, not the documented 404 | `reports/09-live-gate-evidence.md` ("Real finding: this gateway reports 'model not found' as a retried 5xx, not the documented 404") — raw `fetch` trace included in that report |
| Bearer-only gateways are explicitly out of scope; `x-api-key` is the only auth path sent | `reports/04-settings-evidence.md` ("API-key header semantics ... never sends `Authorization: Bearer` under any circumstance") |
| TOOL_ERROR/VISION_ERROR (a model declining a tool / rejecting an image) verified only against a scripted fixture, not a live model | `reports/04-settings-evidence.md` and `reports/09-live-gate-evidence.md`, both stating this explicitly rather than claiming it live-verified |
| Node v18+ required; SDK pin `@anthropic-ai/claude-agent-sdk@0.3.263`; `--legacy-peer-deps` required due to SDK's `zod@^4` peer vs. project's existing `zod@^3` | `host/package.json` (`"@anthropic-ai/claude-agent-sdk": "0.3.263"`, `"zod": "^3.23.8"`); `reports/01-sdk-gate-evidence.md` ("ERESOLVE ... peer zod@^4.0.0 ... Adopted: `npm install --legacy-peer-deps`"); Node engine requirement confirmed this session by reading `host/node_modules/@anthropic-ai/claude-agent-sdk/package.json`'s `"engines": {"node": ">=18.0.0"}` |
| The keyed build's derived extension ID is `ihljfjgoakmoemkdondoaadegpmibimh`, permanent across reload/restart/relocation, same for every browser | `reports/02-packaging-evidence.md` ("Derived extension id (deterministic, same for every browser): ihljfjgoakmoemkdondoaadegpmibimh", independently cross-checked with `openssl`) |
| One-time migration: old unkeyed builds had a random per-browser ID; export/import via `extension/settings-migration/`; secrets never exported, must be re-entered; host-side recordings keep their paths | `reports/02-packaging-evidence.md` (2.3 section) |
| Both installers derive the ID automatically (no extension-ID argument), are idempotent, and back up any registration they replace | `reports/02-packaging-evidence.md` (2.2, 2.4 test matrix); confirmed this session by reading the current `install.sh`/`install.ps1` source directly |
| Diagnostics: ID mismatch (`identity.js verify`), wrong path, runtime unavailable (60s startup budget), protocol mismatch (fails closed on unknown version), disconnected browser (`HOST_DROPPED_ERROR` vs `NO_BRIDGE_ERROR`) | `reports/02-packaging-evidence.md` (identity verify CLI); `host/agent/protocol.js` line 153 (`reason: "unsupported_version"`, read directly this session); `host/tool-runtime.js` lines 46/52 (`HOST_DROPPED_ERROR`/`NO_BRIDGE_ERROR` constants, read directly this session); design.md section 3 (60-second startup budget requirement) |
| Rollback: use the external-MCP path or stop opening the panel; installers back up replaced registrations (`.bak` / `.registry-backup.reg`) for restore | `reports/02-packaging-evidence.md` ("Backup on changed registration" test case, both installers); design.md Migration Plan step 5 ("Rollback selects the legacy entry point and restores product registration backup") |
| Recorder reachable via a labeled panel control (History screen) or the existing Options page; separate OpenAI transcription credential | `reports/05-panel-evidence.md` ("Recording moves to a labeled 'Bắt đầu ghi'/'Dừng ghi âm' control in the panel's History screen"); `extension/manifest.json`'s `options_page` (read this session, now `settings/settings.html`) and `extension/settings/settings.html`'s `#nav-recorder` row (read this session) confirming the Options entry point now routes through Settings to a "Recorder" nav item |
| External MCP path is unchanged, fully supported, requires no side-panel setup or provider API key of its own, and arbitrates the shared browser lease with the SDK path via an explicit busy error rather than silent interference | design.md section 5d; `reports/03-companion-evidence.md` (`NativeLeaseGuard`, "a real end-to-end test proves an SDK run excludes a concurrent legacy client with a retryable busy error") |
| Both installers' "Next steps" now describe the SDK-first flow first, with external MCP as an explicitly labeled optional/legacy entry point, and no longer suggest visiting a third-party site (`reddit.com`) as the first test | Direct diff of `install.sh`/`install.ps1` in this session (see "Installer changes" below) |
| "26 registry tools" / stub-labeling / no-blanket-parity corrections | This session's own edits, cross-checked against `reports/06-registry-baseline.md` line by line before writing |

## What was deliberately NOT claimed

- **No "100% feature & performance parity" claim.** The README previously
  carried this exact phrase in its subtitle. It is removed and replaced with
  a specific, itemized comparison (26-tool registry count, plus the
  benchmark's own stated result and caveats) and a new "What this is not"
  section stating plainly that "parity" in this document always means a
  named, evidenced comparison, never a blanket guarantee — matching
  design.md section 0's "Product parity means the specified user flows...,
  not an unsupported guarantee of every proprietary feature."
- **No claim of Anthropic affiliation or endorsement.** An explicit
  disclaimer was added near the top of the README ("Independent project. Not
  affiliated with, endorsed by, or sponsored by Anthropic.") and the tool
  table's "Parity" language was reworded to "this project's own interface
  comparison — not an Anthropic-verified or endorsed comparison."
- **No claim that the side panel has been benchmarked.** The existing
  benchmark (`benchmark/writeup/writeup.md`) covers the external-MCP path
  only, against one model, on one 12-task suite. The README says this
  explicitly in three places (the "What's Different" table, right after the
  benchmark section, and in "What this is not") rather than letting the
  benchmark's framing imply it also covers the newer side panel.
- **No claim that current-page auto-binding, the visible cursor/action
  timeline, or a Settings > Skills UI exist.** `tasks.md` groups 5.5–5.13 and
  7.3 are unticked with "NOT STARTED" annotations in
  `reports/10-task-reconciliation.md`; the README's "Side panel status"
  section lists each of these as still in development, with a one-line
  reason grounded in the same evidence.
- **No claim that gate 1.3/1.6's browser-control legs are proven live.**
  `reports/01-sdk-gate-evidence.md` and `reports/10-task-reconciliation.md`
  are explicit that the DOM/navigate/form-fill/click chain and full
  current-page-analysis/browser-control journey are harnessed (fake
  extension), not proven against a real Chrome/Edge/Brave install — the
  README's Verification section asks the reader to confirm this themselves
  ("ask it to read the current tab") rather than asserting it works from
  documentation alone.
- **No claim that this gateway's finding (503-for-model-not-found,
  mixed-vendor catalog) generalizes to every Anthropic-compatible gateway.**
  Each quirk in "Provider compatibility" is phrased as "a tested gateway" /
  "one tested gateway", not "gateways in general".
- **No claim that Bearer-token gateways work.** Stated as explicitly out of
  initial scope, matching design.md section 4 ("Bearer-only gateways are out
  of initial scope; they must not be made to work by silently changing
  API-key semantics").
- **No claim that `TOOL_ERROR`/`VISION_ERROR` have been observed live.**
  Both `reports/04-settings-evidence.md` and `reports/09-live-gate-evidence.md`
  disclose that the two live-tested models complied fully with every request,
  so these two error codes remain verified only against a scripted fixture —
  the README repeats this distinction rather than smoothing it into "all
  error codes verified live."
- **No claim that macOS/Linux secret-store adapters have been exercised.**
  The README's Prerequisites/Provider settings text does not assert these
  work end-to-end; `reports/04-settings-evidence.md` states they are
  implemented but BLOCKED for execution on this Windows-only session.
- **No removal of, or edit to, any user's MCP registration or entry point.**
  The external-MCP path's own instructions (`claude mcp add ...`,
  `install.sh`/`install.ps1` registration logic) are unchanged in substance —
  only the surrounding narrative/ordering and the installers' post-install
  "Next steps" text changed.

## Installer changes ("Next steps" guidance only)

Both `install.sh` and `install.ps1` previously printed, as their only
post-install guidance:

```
2. Add the MCP server to Claude Code:
   claude mcp add open-claude-in-chrome -- node "<path>"
3. Start a new Claude Code session and test:
   Ask Claude: "Navigate to reddit.com and take a screenshot"
```

This directly contradicted the change's premise (no terminal, no Claude Code,
no manual MCP registration required for daily use) and pointed the very
first test at a real third-party website. Both scripts now print, in order:

1. Restart the browser (unchanged).
2. **Recommended**: open the side panel, open its Settings (or right-click →
   Options), enter Base URL/API key/model, click Test connection, then type a
   message — explicitly labeled as needing no terminal.
3. **Optional legacy entry point**: the unchanged `claude mcp add ...` command
   (still verbatim, so scripts/docs referencing it are unaffected), followed
   by a first-test suggestion using `example.com` (an IANA-reserved domain
   reserved for exactly this kind of illustrative example — no account
   creation, no tracking, and not on the official extension's blocklist)
   instead of `reddit.com`.

Verified in this session: `grep -n "reddit.com" install.sh install.ps1` →
no matches. `grep -n "claude mcp add" install.sh install.ps1` → present,
unchanged argument shape, now under an explicitly labeled "Optional legacy
entry point" step. No line touching extension-ID derivation, registry/path
writes, or backup logic was changed — confirmed by reviewing the diff: only
the `Write-Host`/`echo` lines inside each script's existing "Next steps"
footer block were edited.

## Regression check

No code file was edited by this task (README.md, install.sh/install.ps1
guidance text, and this report are documentation-only changes). No test
suite exercises README prose or the printed installer text, so there is no
applicable automated regression check beyond the manual `grep` verifications
above and a visual read-through of the rendered README structure (anchor
links cross-checked against every heading they target — see the file's own
table of contents links).
