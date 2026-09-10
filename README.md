<h1 align="center">Browzy</h1>

<p align="center">
  <em>Official Claude in Chrome gives you 58 blocked domains and two browsers.<br/>
  <strong>Browzy gives you the whole web.</strong></em>
  <br/>
  <sub>Clean-room reimplementation of Anthropic's browser extension. No blocklist. Any Chromium browser. A 28-tool registry (26 preserved baseline + 2 experimental WebMCP page-tool operations), with the specified flows tested against a real benchmark — not a guarantee of every proprietary feature (see <a href="#what-this-is-not">What this is not</a>).</sub>
  <br/>
  <sub><em>Independent project. Not affiliated with, endorsed by, or sponsored by Anthropic.</em></sub>
</p>

<p align="center">
  <a href="#whats-different">What's different</a> ·
  <a href="#quick-start-two-ways-to-run-it">Quick start</a> ·
  <a href="#installation">Install</a> ·
  <a href="#imitation-learning-recording">Imitation learning</a> ·
  <a href="#architecture">Architecture</a> ·
  <a href="https://discord.gg/F4HBKAEbNg">Discord</a>
</p>

---

The official [Claude in Chrome](https://code.claude.com/docs/en/chrome) extension gives Claude Code full browser automation — as long as you stay within Anthropic's allowlist of "safe" sites. Browzy is a clean-room reimplementation that strips the restrictions, with a 28-tool browser registry (26 preserved baseline + 2 experimental WebMCP page-tool operations; verified programmatically — see [Available Tools](#available-tools)) and turn/latency performance that a benchmark below found statistically indistinguishable from the official extension on the tested task set — not a guarantee of matching every proprietary feature (see [What this is not](#what-this-is-not)).

**Two ways to run it.** A **built-in browser side panel**, driven by the official [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk) through a local native companion — no Claude account, no terminal, no Claude Code client, just your own Anthropic-compatible Base URL/API key/model, configured once in Settings. Or the original **external MCP** entry point, unchanged and fully supported, for driving the same extension from a Claude Code session. Both share the one browser extension and one native companion; see [Quick start](#quick-start-two-ways-to-run-it) below. The side panel is the newer, actively-developing path — some of its screens (see [Side panel status](#side-panel-status) below) are still catching up to the external-MCP path's tool coverage.

## What's Different

| | Claude in Chrome | Browzy in Chrome |
|---|---|---|
| **Domain blocklist** | 58 blocked domains across 11 categories | No blocklist. Navigate anywhere. |
| **Browser support** | Chrome and Edge only | Any Chromium browser (Chrome, Edge, Brave, Arc, Opera, Vivaldi, etc.) |
| **Source code** | Closed source | Open source (MIT) |
| **Tools** | ~21 MCP tools (Anthropic's own count; not independently verified here) | 28 registry tools (verified: `test/registry-baseline.test.mjs`) — the 26-tool preserved baseline (19 with a named official equivalent, 3 of those currently unimplemented stubs, see [Available Tools](#available-tools); 7 with no official equivalent) plus 2 experimental WebMCP page-tool operations with no official equivalent (`webmcp_list_tools`, `webmcp_call_tool`, see [WebMCP page tools](#webmcp-page-tools-experimental)), plus `execute_code` and the recording channel outside the core registry |
| **Account required** | Claude account/subscription | Side panel: none — bring your own Anthropic-compatible API key. External MCP: a Claude Code session (its own auth, unrelated to this extension) |
| **Performance** | Baseline | Statistically indistinguishable on the tested benchmark (external-MCP path, both cold — see below); the side panel has not been separately benchmarked |

## What this is not

This project is **not** endorsed by, affiliated with, or sponsored by
Anthropic, and does not claim to be. "Parity" anywhere in this document means
a specific, itemized, evidenced comparison — a named tool matching a named
official tool's interface, or a benchmark result on a stated task set — never
a blanket promise that every proprietary feature of the official Claude in
Chrome extension, or of Claude.ai/Claude Code more broadly, is reproduced
here. In particular:

- No Claude account, subscription, or official-extension feature is required
  or reproduced by the side panel — it is a separate implementation using
  your own Anthropic-compatible API credential (see [Quick
  start](#quick-start-two-ways-to-run-it)).
- Three tools (`gif_creator`, `shortcuts_list`, `shortcuts_execute`) exist in
  the registry with full schemas but are **currently unimplemented stubs**
  that return a fixed "not supported" result regardless of arguments — see
  [Available Tools](#available-tools). They are not silently claimed to work.
- The benchmark below covers the external-MCP path on one 12-task suite
  against one model; it is evidence for that specific comparison, not a
  general performance guarantee, and its own caveats (task-set saturation,
  10–20% run-to-run variance) are stated where the result is reported, not
  hidden.
- Side-panel features still in development (current-page auto-binding,
  on-page cursor/action timeline, built-in slash commands in the picker) are
  listed as such in [Side panel status](#side-panel-status), not described as
  shipped.

### Blocked Domains in the Official Extension

| Category | Blocked Sites |
|----------|--------------|
| Banking | Chase, BofA, Wells Fargo, Citibank |
| Investing/Brokerage | Schwab, Fidelity, Robinhood, E-Trade, Wealthfront, Betterment |
| Payments/Transfers | PayPal, Venmo, Cash App, Zelle, Stripe, Square, Wise, Western Union, MoneyGram, Adyen, Checkout.com |
| BNPL | Klarna, Affirm, Afterpay |
| Neobanks/Fintech | SoFi, Chime, Mercury, Brex, Ramp |
| Crypto | Coinbase, Binance, Kraken, MetaMask |
| Gambling | DraftKings, FanDuel, Bet365, Bovada, PokerStars, BetMGM, Caesars |
| Dating | Tinder, Bumble, Hinge, Match, OKCupid |
| Adult | Pornhub, XVideos, XNXX |
| News/Media | NYT, WSJ, Barron's, MarketWatch, Bloomberg, Reuters, Economist, Wired, Vogue |
| Social Media | Reddit |

Browzy has **none of these restrictions**.

## Does it actually match the official extension?

Yes — and rather than assert it, here is a benchmark. **[Read the full study →](benchmark/writeup/writeup.md)**

17 arms, each run over the same 12 held-out tasks from the
[REAL](https://github.com/agi-inc/REAL) web-agent benchmark, same model and
effort throughout (Sonnet, medium). What it found:

- **Parity, out of the box.** The official extension and this harness, both cold,
  are statistically indistinguishable: 2.04 vs 1.95 min/task and 31.4 vs 32.6
  turns, at p=0.44 and p=0.67 on a paired permutation test, with identical
  accuracy. They differ only in per-action overhead — **0.31s vs 0.12s** per
  browser action, 2.7× less.
- **A higher ceiling.** The best method in the study lands **23% fewer turns and
  15% less time** than the official extension, at 11/12 tasks passed against
  8/12. Distil prior runs into a short per-site recipe, put it in the task
  prompt, and start from a warmed-up session.
- **What actually helps.** Mounting raw prior experience on disk costs more than
  it returns (the agent spends 3.5× longer before its first browser action);
  compressing it into the prompt is what pays. Context is the dominant latency
  term at **+1.9s per turn per 100k tokens**, so more context is not free.
- **Recordings.** This harness records raw, four-track browser traces and defers
  the analysis; Claude Cowork analyses each recording at capture time and keeps
  only the result. Distilled the same way by the same model, the raw recordings
  win both regimes — **6.6 fewer turns and 6.4 fewer minutes** when the material
  has to fit in a prompt (p=0.012, p=0.008).

Caveats are in the writeup, not hidden: the task set saturates, one task's
grading is ambiguous, and repeat runs of an identical configuration vary by
10–20%, so treat single-digit differences as noise.

The benchmark above measured the external-MCP path only (Claude Code driving
the extension). The side panel has not been separately benchmarked.

## Quick start: two ways to run it

There is one browser extension and one native companion. What differs is how
you talk to them.

| | **Side panel** (recommended) | **External MCP** (legacy, still supported) |
|---|---|---|
| Client | Built into the extension's own side panel | A Claude Code session |
| Account needed | None — your own Anthropic-compatible Base URL + API key + model, entered once in Settings | A Claude Code session (its own auth, separate from this extension) |
| Runs on | The official [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk) inside a local native companion process | Claude Code's own MCP client, talking to `host/mcp-server.js` (or the codemode/hybrid variants) |
| Daily use | Open the browser, open the side panel, type. No terminal. | Start Claude Code, `/mcp` connect if needed, ask it to use the browser |
| Setup, once | Load the extension, run the installer, open Settings and enter your provider credential | Load the extension, run the installer, `claude mcp add ...` |
| Where to go | [SDK-first: browser side panel](#sdk-first-browser-side-panel-no-claude-account) | [External MCP: Claude Code (legacy)](#external-mcp-claude-code-legacy) |

Both share the same 28-tool browser registry (26 preserved + 2 experimental WebMCP page-tool operations), the same stable extension
identity, and the same one-time installer. Neither disables or removes the
other — running the installer sets both up, and which one you use day to day
is just a matter of what you open (the browser's side panel, or a Claude Code
session).

**Status.** The side panel is real and working for chat, model selection,
streaming, session history, and recording controls (see [Side panel
status](#side-panel-status)). Some pieces described in this project's design —
an automatic current-page reading chip, a visible on-page cursor with an
action timeline, and built-in slash commands in the composer's picker — are
still in development and are called out explicitly where they matter, not
promised here. The external-MCP path is the one exercised by the demo video
and the benchmark above, and is unchanged by any of this.

## Architecture

Side panel (SDK-first — no Claude Code, no manual MCP registration for daily use):

```
Side panel <--extension messaging--> background.js <--native messaging--> native-host.js
                                                                                |
                                                                     supervised companion process
                                                                                |
                                                                     Claude Agent SDK -> your configured
                                                                     Anthropic-compatible endpoint
                                                                                |
                                                                    in-process SDK MCP server
                                                                     (the same 28-tool registry)
                                                                                |
                                                                    native-host.js <--native messaging--> Extension <--> Browser
```

The companion is started automatically by native messaging the first time the
side panel needs it — nothing to launch by hand, no separate MCP registration.
It is a distinct process from the external-MCP path below, but both are
arbitrated by the same shared browser-bridge lease in `native-host.js`, so a
concurrent legacy MCP client and a side-panel run cannot silently interfere
with each other's tab actions (see `reports/03-companion-evidence.md`).

External MCP, default:

```
Claude Code <--stdio MCP--> mcp-server.js <--TCP--> native-host.js <--native messaging--> Extension <--> Browser
```

External MCP, code mode / hybrid (additive — `mcp-server.js` is reused unchanged as the upstream):

```
Claude Code <--stdio MCP--> server-{codemode,hybrid}.js
                              |  spawns + proxies via MCP
                              v
                            mcp-server.js (child) <--TCP--> native-host.js <--native messaging--> Extension <--> Browser
                              ^
                              |  HTTP tool-callback
                              |
                            workerd (wrangler dev sidecar)
                              |  Worker Loader → V8 isolate
                              v
                            sandboxed Worker runs LLM-written code
```

Components:
1. **Extension** — Manifest V3 with CDP-based browser automation (28 registry tools: 26 preserved + 2 experimental WebMCP page-tool operations), plus a side panel and settings UI
2. **Native Messaging Host** (`host/native-host.js`) — bridges the extension to either the SDK companion or an external MCP server, and arbitrates the one shared browser lease between them
3. **SDK companion** (`host/agent/`) — runs the Claude Agent SDK against your configured provider, exposing the same browser registry as in-process SDK tools; started automatically, supervised, no user-run MCP server
4. **MCP Server** (`host/mcp-server.js`, external-MCP path) — Node.js process started by Claude Code, exposes the same tools via MCP

The codemode and hybrid servers (external-MCP path only) add a `wrangler dev`
subprocess hosting a Cloudflare Worker that runs LLM-generated code in a V8
isolate. The Worker calls back to the proxy over HTTP for actual tool
execution, forwarded to the unchanged upstream `mcp-server.js`.

## Installation

One installer sets up everything both paths need: the extension's stable
identity and the native messaging host. What you do after that depends on
which path from [Quick start](#quick-start-two-ways-to-run-it) you want.

### Prerequisites

- **Node.js** v18+ (this change's SDK integration was built and tested on
  Node v24.19.0; the pinned `@anthropic-ai/claude-agent-sdk` package declares
  `>=18.0.0`)
- **Any Chromium browser** (Chrome, Edge, or Brave on Windows is this
  project's currently-tested matrix for the side panel; other Chromium
  browsers and platforms are supported for the external-MCP path as before)
- For the **side panel**: your own Anthropic-compatible Base URL, API key, and
  at least one model ID — no Claude account, subscription, or Claude Code
  install needed
- For **external MCP**: Claude Code v2.1.80+ (the recorder needs channels;
  browser automation alone works on v2.0.73+)
- For the **recorder** (either path): an OpenAI API key, used only to
  transcribe your narration — unrelated to whichever provider drives the chat

### One-time setup (do this once, for either path)

**1. Install dependencies**

```bash
npm install --prefix host --legacy-peer-deps
npm install --prefix host/codemode/worker
```

`--legacy-peer-deps` is required: the pinned Claude Agent SDK declares a
`zod@^4` peer, while this project's existing 28-tool registry depends on
`zod@^3` (via `zod-to-json-schema`, which reads zod v3's internal shape) —
bumping the shared `zod` to v4 would break that registry. The installed
zod v3 release already implements the interface the SDK actually calls, so
`--legacy-peer-deps` (skip peer-range enforcement, not the install itself) is
the correct fix, not a workaround (`reports/01-sdk-gate-evidence.md`). The
second `npm install` line is not optional either: it provisions the sandbox
that `execute_code` (external-MCP path only) runs in. Skip it and the server
falls back to fetching wrangler over the network on every cold start, which
is the most common reason `execute_code` fails to come up.

**2. Load the extension**

1. Go to `chrome://extensions` (or `brave://extensions` / `edge://extensions`)
2. Enable **Developer mode**
3. Click **Load unpacked** and select the `extension/` directory

That's it — there is no extension ID to copy. The extension ships a
persistent public manifest key, so every browser and every reload gets the
**same** derived ID (`ihljfjgoakmoemkdondoaadegpmibimh`), not a random
per-browser one. If you're upgrading from an older unpacked build that had no
`key` in its manifest, see [One-time migration from an older
build](#one-time-migration-from-an-older-unkeyed-build) before continuing.

**3. Run the installer**

```bash
./install.sh          # macOS / Linux / Windows via Git Bash, MSYS2, or Cygwin
```
```powershell
.\install.ps1          # native Windows PowerShell — no Git Bash needed
```

Both scripts are thin shims around the same cross-platform `browzy` Node CLI
(`host/agent/installer/`), so their behavior is identical on every platform.

The same CLI is published to npm, which installs the **companion only**:

```bash
npm i -g @huydepzai2810/browzy-host
browzy install                          # then browzy doctor / browzy uninstall
```

Note this does **not** save you the clone today: the npm package carries
`host/`, and step 2 above still needs a real `extension/` directory on disk to
load unpacked. If you are cloning anyway, `./install.sh` has already installed
the companion and `npm i -g` adds nothing. The npm route is what a Chrome Web
Store install will use, where the extension comes from the store and only the
companion is missing — see [docs/cai-dat.md](docs/cai-dat.md).

Neither entry point takes a positional extension-ID argument — the ID is
derived automatically from the manifest key, the same value for every
browser. Pass `--extension-id <id>` (all three entry points) to override it,
e.g. for a Chrome Web Store build (see `package-extension.sh`). All are
idempotent (rerunning with nothing changed just prints "Already up to date")
and back up any registration they replace (`reports/02-packaging-evidence.md`).
Pass `--only=chrome,edge` / `-Only chrome,edge` to register a subset. Run
`browzy doctor` any time to see what's currently registered, for which
extension id, and whether the host file it points at still exists.

**4. Restart your browser**

Close **all** windows and reopen. The browser reads native messaging host
configs on startup.

Now pick a path: [SDK-first side panel](#sdk-first-browser-side-panel-no-claude-account)
or [external MCP for Claude Code](#external-mcp-claude-code-legacy).

---

## SDK-first: browser side panel (no Claude account)

No terminal and no Claude Code client are needed from here on for daily use.

### Configure your provider

1. Open the side panel (click the toolbar icon) and click its **settings**
   icon — or right-click the extension icon → **Options** — to open
   **Settings**.
2. Enter your **Base URL** (an Anthropic-compatible endpoint — an origin, with
   an optional path prefix; `https://` is required except for an explicit
   `http://localhost`/loopback development endpoint), your **API key**, and at
   least one **model ID** (add a label if you like, and pick a default). The
   key is sent as `x-api-key`, never `Authorization: Bearer` — a Bearer-only
   gateway will not authenticate (see [Provider
   compatibility](#provider-compatibility) below).
3. Click **Test connection**. This runs one small, real, billed request
   (streamed text, a harmless tool round trip, and an image-recognition
   check) against your endpoint and model — the UI discloses that it's
   billed. Saving is allowed without testing, but the assistant will not run
   until the current endpoint/model/key combination has a passing test.
4. Optionally use **Discover models** to list what your endpoint's paginated
   `/v1/models` reports; this never overwrites models you entered manually.

Credentials are per machine: the key lives in your OS credential store
(Windows Credential Manager, macOS Keychain, or Linux Secret Service — never
extension storage, never a plaintext file), and there is deliberately no
cross-machine sync. Setting up a second machine means re-entering the Base
URL, models, and key there too. Changing the provider/model or replacing the
key only affects new conversations — a conversation already in progress keeps
using the snapshot it started with, and deleting a key cancels the runs that
depended on it.

### Use it

Open the browser and click the toolbar icon (or use the keyboard shortcut) to
open the side panel — it opens on the current tab/window, tracks whichever
tab is active while unpinned, and starts the native companion automatically
the first time it's needed (typically a few seconds; the panel shows a
specific error if startup takes longer than a minute). Type in the composer
and send. Conversation history, model selection, and recording controls
(**Bắt đầu ghi** / **Dừng ghi âm** on the panel's History screen) are all in
the panel — no `claude mcp add`, no `--dangerously-load-development-channels`,
no separate MCP server.

### Side panel status

Real and working today: streaming chat, model selection and switching,
human-readable tool activity in the transcript, connection/error states,
send/stop, conversation history (list/reopen/delete), and recording
list/attach/start/stop — all screenshot-verified at 320/400/480px in light and
dark (`reports/05-panel-evidence.md`, `reports/05-visual-system.md`) — plus
composer prompt enhancement (the "Cải thiện prompt" control next to Send).

**Documents the agent creates.** When a run produces something that is a
document in its own right — a report, an audit, a data table, a set of slides —
it calls the application-owned `create_document` tool instead of pasting the
whole thing into the transcript, and the panel shows a card
("Tên tài liệu · Tài liệu · MD · 12 KB"). Clicking it opens a viewer with two
tabs, **Xem trước** and **Markdown**, for every format; the download control
saves the real file locally. Formats: `md`, `txt`, `csv`, `html`, `json`,
`docx`, `xlsx`, `pptx`, `pdf`. Nothing is uploaded anywhere — the file lives in
that conversation's own directory and the download is a local blob, so no cloud
account and no `downloads` permission is involved. This does NOT widen the
filesystem boundary: `Bash`, `Write`, `Edit` and `NotebookEdit` stay disabled,
and the model never names a path — the host derives the filename from the title
and owns the directory.

Still in development, not yet in the shipped panel — mentioned here so this
document never promises more than what's built:

- **Automatic current-page binding.** The design calls for the panel to bind
  itself to whatever article/page is open so "summarize this" needs no URL
  and opens no new tab. That binding, its pin/remove controls, and the
  underlying read-only borrowed-tab access are not wired into the panel yet.
- **Visible on-page cursor and action timeline.** A pointer overlay on the
  controlled page and a step-by-step timeline with screenshot thumbnails are
  specified but not yet implemented in the extension.
- **Built-in slash commands in the `/` picker.** The picker offers the
  operator's enabled, user-invocable skills, and a picked invocation
  dispatches and runs. It offers no built-in commands: the application's
  approved built-in allowlist is deliberately empty, so nothing the SDK
  advertises is currently surfaced there.

**Skills are composed in the app, not imported from a folder.** Settings >
Skills is typed-only: a skill's name, description and Markdown body are
written directly into the panel, then edited or duplicated the same way — no
interface the extension can invoke accepts a filesystem path, and none reads,
copies or watches a directory the application does not own.

None of the above affects the external-MCP path, which is unrelated code and
unaffected by any of this.

## External MCP: Claude Code (legacy)

Unchanged from before this change, still fully supported, and requiring no
side-panel setup or provider API key of its own — a Claude Code session
supplies its own model/auth. Complete [One-time setup](#one-time-setup-do-this-once-for-either-path)
above first, then:

### Set your OpenAI key and enable the microphone (recorder only)

Right-click the extension icon → **Options** (this now opens the same
provider Settings page the side panel uses — `extension/manifest.json`'s
`options_page`) and click **Ghi lại thao tác (Recorder)** ("Recorder") under
"Khác" ("Other") to reach the recorder's own settings. Both of these are
required before recording, on either path:

- Paste your **OpenAI key** and click **Save & validate** (transcribes your narration).
- Click **Enable microphone** and allow the browser prompt. The recorder captures
  audio in a background page that can't show a permission prompt itself, so you
  grant mic access once here; otherwise recordings capture no voice.

### Add the server to Claude Code

The **hybrid** server exposes everything: all 28 tools directly (26 preserved + 2 experimental WebMCP page-tool operations), `execute_code`
alongside (the model picks per call), and the recording channel.

```bash
claude mcp add browzy-in-chrome-hybrid -- node /absolute/path/to/host/codemode/server-hybrid.js
```

Find the absolute path with `echo "$(pwd)/host"`.

### Launch with recording enabled

Channels are a research preview, so start Claude Code with the development flag:

```bash
claude --dangerously-load-development-channels server:browzy-in-chrome-hybrid
```

Accept the one-time prompt and keep the session open — channels inject into a
live interactive session, not `claude -p`. That's it: browser automation and
recording are both on.

## Verification

**Side panel** — open it, type a message that does not need browser access
(e.g. "what can you help me with?") and confirm you get a streamed reply with
no Claude sign-in prompt at any point. Then ask it to read the current tab
(e.g. "what page am I on?") to confirm the native companion and extension are
wired up.

**External MCP** — start a new Claude Code session and run both checks.

**1. Browser control** — confirms the extension, native host and MCP server are wired up:

```
Navigate to example.com and take a screenshot
```

`example.com` loads (an IANA-reserved domain meant for exactly this kind of
test — no account, no tracking, and it isn't on the official extension's
blocklist). No domain restriction on your own machine either.

**2. The `execute_code` sandbox** — confirms the wrangler sidecar is live:

```
In a single execute_code call: create a new tab, navigate to example.com, read
its page text, then report what the page says.
```

You should get the answer back from **one** tool call rather than a
click-screenshot-click sequence. If the first attempt reports the sandbox is
still starting, wait a few seconds and ask again — the sidecar boots in the
background and the first call can arrive before it is ready. If it never comes
up, see [Keeping `execute_code` running](#keeping-execute_code-running).

## Provider compatibility

The side panel talks to whatever endpoint you configure via the Anthropic
Messages API shape (`x-api-key`, streaming SSE) — it does not promise every
gateway that claims Anthropic compatibility actually works. What follows is
the tested matrix, not a universal claim.

**Verified live**, against a real Anthropic-compatible gateway
(`reports/09-live-gate-evidence.md`), for both `claude-opus-5` and
`claude-sonnet-5`:

| Capability | Status |
|---|---|
| `POST /v1/messages` streaming (SSE) | pass |
| Tool use (a real MCP round trip) | pass |
| Vision (image content blocks) | pass |
| `GET /v1/models` pagination | pass |

**Real quirks found while verifying this, documented rather than smoothed
over:**

- **Model discovery can return a mixed-vendor catalog.** One tested gateway's
  `/v1/models` returned 31 entries spanning several unrelated model families
  alongside the configured Claude models. Model IDs are treated as opaque,
  case-sensitive strings — never inferred from vendor-looking names, and
  discovery never overwrites a manually-entered model.
- **A response can include a `thinking` block before `text`.** Confirmed on a
  real streamed response; only `tool_use`/`text` blocks are inspected for
  compatibility checks, so this does not need special handling, but if you're
  reading raw event streams elsewhere, expect it.
- **A gateway can report "model not found" as a retried HTTP 503, not the
  documented 404.** One tested gateway's `model_not_found` reason arrives in a
  5xx response body that the underlying SDK transport does not surface to the
  caller, so it is reported as a network/server error with a message noting
  that some gateways use this shape for an unknown model — not silently
  reported as "compatible" or misattributed to a transient outage.

**Explicitly not supported (initial scope):** Bearer-token-only gateways.
This project sends `x-api-key` exclusively — it never falls back to
`Authorization: Bearer` to accommodate a gateway that requires it. A model
that declines an offered tool, or rejects an image outright, has been
exercised only against a scripted fixture server, not a live model — the two
tested live models complied fully with both requests.

## One-time migration from an older, unkeyed build

If you previously ran an unpacked build of this extension **before** it had a
`key` in `extension/manifest.json`, your browser assigned it a random ID —
different per browser/profile, and it could change on certain reloads. The
keyed build ships one persistent ID
(`ihljfjgoakmoemkdondoaadegpmibimh`) that is the same everywhere and does not
change again.

Because Chrome partitions extension storage by ID, the new extension **cannot
read the old one's `chrome.storage`/IndexedDB** — settings and recorder
session metadata do not carry over automatically. Before removing the old
extension:

1. Export its non-secret settings and recorder metadata using
   `extension/settings-migration/` (see that module's `README.md` for the
   exact console commands — this is not yet wired to a Settings button).
2. Install the new keyed build, then import what you exported.
3. **Re-enter secrets** (e.g. the OpenAI transcription key, and any provider
   API key in Settings) — secrets are deliberately never included in the
   export.

**Recordings already written to disk by the native host are unaffected** —
they keep their existing file paths under
`~/.config/browzy-in-chrome/recordings/` regardless of which extension ID
is active, since the host (not the extension) owns that storage.

## Diagnostics

If something isn't connecting, these are the distinct failure classes and
where each one is surfaced:

- **ID mismatch** — the browser-reported extension ID doesn't match what the
  manifest key derives. Check with
  `node host/agent/identity.js verify extension/manifest.json <reported-id>`
  (exits 0/1, prints the specific mismatch). A corrupt or missing manifest key
  is refused by the installers with a repair command
  (`node host/agent/generate-key.js --write-manifest`) rather than silently
  falling back to an empty or wildcard origin.
- **Wrong path** — the native messaging host manifest points at a companion
  path that moved. Rerunning `install.sh`/`install.ps1` rewrites it (and backs
  up the old registration first); see [Troubleshooting](#troubleshooting)
  below for the exact file locations per OS/browser.
- **Runtime unavailable** — the native companion never becomes reachable
  within its startup budget. The side panel shows a specific startup error
  (rather than hanging) if this exceeds 60 seconds, with a retry control.
- **Protocol mismatch** — the extension and companion speak different
  protocol versions. The versioned agent-message envelope fails closed on an
  unrecognized version rather than guessing at compatibility.
- **Disconnected browser** — a dispatched action's response never arrives
  (the extension/tab went away mid-call) is reported distinctly from a call
  that never reached the extension at all, and neither is silently retried or
  replayed — see `host/tool-runtime.js`'s `HOST_DROPPED_ERROR` (dispatched,
  no response) vs `NO_BRIDGE_ERROR` (no browser attached).

## Rollback

Both paths share the same extension and installer, so rolling back the side
panel does not require reinstalling anything: use the external-MCP path
above (`claude mcp add ...`) instead, or simply stop opening the side panel.
No conversation or recording is ever deleted by switching paths.

If a native-host registration needs to be restored to what it was before this
change, both installers back up whatever registration they replace before
overwriting it — a `.bak` file next to the previous manifest on macOS/Linux,
or a `.registry-backup.reg` file next to the installer on Windows (see
`reports/02-packaging-evidence.md`). Re-import the `.reg` file, or restore the
`.bak` file over the current one, to put the previous registration back.

## Keeping `execute_code` running

*(External-MCP path only — the side panel does not use `execute_code` or the
codemode/hybrid servers.)*

**Where it runs.** `execute_code` evaluates your JavaScript in a Cloudflare
Worker (a V8 isolate) hosted by a `workerd` sidecar that the MCP server starts
with `wrangler dev`. That sidecar is a **child process of the MCP server**,
which Claude Code itself spawns. There is no separate daemon, nothing to start
by hand, and nothing that outlives Claude Code. It binds `127.0.0.1` on a free
port, runs out of `host/codemode/worker`, and keeps its state in a per-variant,
per-PID directory under your temp dir so the codemode and hybrid servers can run
at the same time without racing each other.

**Its lifetime is the MCP server's lifetime.** It is spawned in the background
at server start so MCP startup never blocks on it (budget: 60s to boot,
typically 3–5s), and it is torn down on SIGTERM/SIGINT/exit and when Claude Code
closes the stdio pipe. So restarting or reconnecting the MCP server always gives
you a fresh sidecar.

**There is no health check and no auto-restart.** If the sidecar dies
mid-session, `execute_code` stays down until the MCP server restarts. That is
the behaviour to recognise: browser tools still work, only `execute_code` fails.

To keep it reliable:

1. **Install the worker's dependencies** ([One-time
   setup](#one-time-setup-do-this-once-for-either-path) step 1, or
   `./install.sh` / `.\install.ps1`, which do it for you). Without
   `host/codemode/worker/node_modules` the server falls back to
   `npx --yes wrangler`, which needs the network on every cold start. This is
   the single most common cause of a sandbox that "sometimes isn't there".
2. **Recover with `/mcp`** in Claude Code. Reconnecting restarts the MCP server,
   which respawns the sidecar.
3. **If that doesn't take, clear strays and reconnect:**
   ```bash
   pkill -f "server-hybrid|server-codemode"; pkill -f wrangler
   ```
4. **Confirm it's up.** The server logs `[wrangler] Ready on http://127.0.0.1:<port>`
   and then `sandbox prewarmed in <n>ms`. `pgrep -fl wrangler` should show one
   process per registered codemode/hybrid server.
5. **Expect partial degradation, not failure.** If the sandbox never comes up the
   28 passthrough tools keep working and only `execute_code` errors, so a broken
   sidecar looks like "code mode stopped working", not "the browser stopped
   working".

## Server variants

*(External-MCP path only.)* The hybrid server from [Add the server to Claude
Code](#add-the-server-to-claude-code) is the superset and the one the install
steps assume. Two leaner variants exist if you want them, and they can
coexist — register more than one.

**Default** — the 28 tools, nothing else:
```bash
claude mcp add browzy-in-chrome -- node /absolute/path/to/host/mcp-server.js
```

**Code mode** — three tools: `execute_code`, `screenshot`, `zoom`. The model writes JS that calls `chrome.*` (the typed API for all 28 tools) in a sandboxed Cloudflare Worker, collapsing multi-step flows into one round trip:
```bash
claude mcp add browzy-in-chrome-codemode -- node /absolute/path/to/host/codemode/server-codemode.js
```

Both of these carry the same sandbox as hybrid, so [Keeping `execute_code` running](#keeping-execute_code-running) applies to them too. Recording is only on the hybrid server.


## Imitation Learning (Recording)

Teach Claude Code a browser task by doing it once. The extension records an
expert rollout in two synchronized tracks — **what you did** (clicks, typing,
scrolling, resolved to durable element anchors) and **why** (your spoken
narration, transcribed) — across every tab, then hands the recording to a live
Claude Code session over a [channel](https://code.claude.com/docs/en/channels).
Claude reads the rollout and carries out the task, extrapolating to sister
tasks. Enabled by the [Installation](#installation) flow above. Full design:
[`docs/imitation-learning-alignment.html`](docs/imitation-learning-alignment.html).

Recording has its own OpenAI transcription credential, entered once in
**Options** (below), separate from whatever provider you configured in
Settings for the side panel — the two are unrelated and neither is required
to use the other.

**Which control starts it depends on your browser.** Where the side panel is
available (Chrome/Edge/Brave), the toolbar icon opens the panel, and
recording starts/stops from the panel's History screen (**Bắt đầu ghi** /
**Dừng ghi âm**) — this works whether you're chatting through the side panel
or Claude Code's external MCP. Where the side panel isn't available, clicking
the toolbar icon directly toggles recording, as described below.

### Record

1. Tell the session you're about to teach it something.
2. **Click the toolbar icon** to start (or use the panel's recording control —
   see above). The badge walks a fixed pipeline:
   `…` (booting the mic, ~2.5s) → `REC` (talk now). Clicks during `…` are
   ignored.
3. Act and narrate out loud. Hold **Alt** while clicking to demonstrate an
   action *without* it firing (override/mask mode).
4. **Click the icon again** to stop. The badge shows `…` while the recording
   is transcribed and saved — clicks are ignored until the **paste-able
   reference lands on your clipboard** and the icon shows 📋. Only then is the
   icon live again. Paste the reference into Claude Code to point it at the
   recording. (If a Claude session with the channel is connected, it's also
   notified automatically and the tooltip says so — but the clipboard copy
   happens either way.)

Recorded sessions are browsable under the extension's **Options** page (all
captured data, disclosed in layers), each with its own **Copy reference** button.

### Verify recording works

The minimum end-to-end check, the recorder's equivalent of the browser-control
check above. Do it in a session launched per [Launch with recording
enabled](#launch-with-recording-enabled).

1. In the Claude Code session, say: *"I'm going to teach you something — wait for my signal."*
2. **Click the toolbar icon** (badge shows `REC`). Navigate to any page, click a
   couple of things, and **say two or three sentences out loud** about what
   you're doing. **Click the icon again** to stop.
3. Confirm:
   - The icon shows a **📋** and the reference is on your clipboard (paste it
     anywhere to check — it points at the recording folder).
   - **Options → Recorded sessions** shows the session with events > 0,
     **utterances > 0**, a working **audio player**, a **frame count**, and your
     words under **Narration**.
   - `trace.json` and `images/` exist under
     `~/.config/browzy-in-chrome/recordings/<recording_id>/`.
   - If a channel session is connected: a `<channel … event="recording_complete" …>`
     message appears and Claude acknowledges it and reads the trace.

If utterances is 0 or there's no audio, the mic wasn't enabled — redo [Set
your OpenAI key and enable the
microphone](#set-your-openai-key-and-enable-the-microphone-recorder-only). If
nothing saved (no 📋), the native host isn't running — rerun `./install.sh` /
`.\install.ps1` and restart the browser. If no channel message appears, the
session wasn't launched with the development-channel flag (or a stale MCP
server is running — `pkill -f "server-hybrid"` and reconnect with `/mcp`).

**The real test** (beyond the minimum): one narrated rollout of a task, then a
*sister task* — same shape, different specifics — that Claude completes unaided
from the recording. That's the proof the trace teaches rather than replays.

### Status & limitations

The MCP channel, the `recording_ack` round-trip, the primary→client event
routing, the transcription + track merge, and the native-host file writes are
validated outside the browser; the in-browser capture, mic, and stop pipeline
are wired and awaiting your live pass above. Known v1 choices:

- The bundle is written by the **native host** (a Node process with filesystem access) to `~/.config/browzy-in-chrome/recordings/<id>/` — `trace.json`, `SCHEMA_v0.md`, and `images/`. No `chrome.downloads`, so no OS save dialog, and it saves whether or not Claude is connected.
- **Four tracks**: behavior (discrete actions), cursor (raw trajectory), images (240p frames captured on events, ≤1/sec), narration. All references and files are just data; the agent reads what it wants.
- The viewer keeps small copies of the audio and frames in IndexedDB (the Options page can't read the on-disk files). Long recordings accumulate; a "keep last N" cleanup is a later refinement.
- The capture layer is purpose-built (anchors + effects + heuristics), not a vendored rrweb.

## Code Mode Test Client

A self-explanatory in-browser test suite for comparing default / code-mode / hybrid behavior across the kinds of flow they each should excel at. Lives in `scratch/test-form/`.

### Serve it

```bash
cd scratch/test-form
python3 -m http.server 8765
```

Open `http://localhost:8765/`. The page is a four-challenge suite the agent works through end-to-end:

1. **Single-Screen Form** — everything visible in one screenshot. A model that captures the layout once should be able to batch all clicks + types + submit into a single round trip.
2. **Multi-Step Wizard** — three steps where step 2's fields depend on step 1's choice. Forces screenshot → action → screenshot, no batching across steps.
3. **Repeat Submissions** — the same Challenge 1 form, submitted three times with different values. Coordinates don't change; this is where pre-planned batching pays off most.
4. **Click Sequence** — a 3×3 grid plus a randomly-generated ordering. Every coordinate is visible at once; the model can batch nine sequential clicks from one screenshot.

Completion is non-ambiguous: the suite ends on a green "All Challenges Complete" banner with a per-challenge wall-clock table. A sticky progress header on every page shows the current challenge number and a ✓ for each completed one.

### Run the experiment

```
YOU MUST NOT USE THE FOLLOWING TOOLS IN ANY CAPACITY: form_input || javascript_tool

TASK:
Open http://localhost:8765/ on a new tab and complete every challenge on the page. Follow the on-page instructions until you reach the "All Challenges Complete" banner.

For the MCP use only (not any of the other ocic MCPs): browzy-in-chrome||browzy-in-chrome-codemode||browzy-in-chrome-hybrid
```

What to look for across the three MCP variants:
- Challenge 1: ratio of screenshots to actions. Default tends to look-act-look-act; code-mode/hybrid should look once then batch.
- Challenge 2: all three should look comparable — visual feedback is required between steps regardless of MCP.
- Challenge 3: this is where the gap should open. One screenshot up front, then three batched form-fills in code-mode/hybrid vs. fresh look-act loops in default.
- Challenge 4: similar. Coordinates fixed, sequence visible. Code mode batches the nine clicks; default clicks one at a time.

If the model still uses direct tools on the second submission, that's a signal the `execute_code` description needs tuning — see `host/codemode/common.js` (`buildExecuteCodeDescription`) and the per-server `EXTRA_NOTES`.

#### Results

#### Final Results Table

## Available Tools

The core browser registry (`host/tool-definitions.js`) has **28** entries,
verified programmatically (`test/registry-baseline.test.mjs`,
`reports/06-registry-baseline.md`) — the **26** preserved-baseline entries
below (every table row through `switch_browser` plus `update_plan` through
`debug_timings`) plus the **2** experimental WebMCP page-tool operations,
`webmcp_list_tools` and `webmcp_call_tool` (see [WebMCP page
tools](#webmcp-page-tools-experimental) below — they are tracked as a
separate, explicitly-enumerated addition on top of the 26-tool baseline, not
folded into that count, so a future regression there is never indistinguishable
from an intentional addition). `execute_code` (codemode/hybrid servers) and
`recording_ack` (the recording channel) sit outside that core registry and are
listed here for completeness. Both the side panel and external MCP dispatch
against the same 28-tool registry; the side panel does not yet expose
`execute_code` or `recording_ack` (those are external-MCP-only, see [Server
variants](#server-variants)).

Every tool, its purpose, and how it compares to the official Claude in Chrome
extension's documented tool set (this project's own interface comparison —
not an Anthropic-verified or endorsed comparison; see [What this is
not](#what-this-is-not)):

- **✓** — matches a named official tool's interface (same arguments, same
  kind of result) and is fully implemented here
- **✗** — present but diverges (a stub, or a capability gap — see the notes
  below the table)
- *(blank)* — a tool this project adds with no official equivalent

| Tool | Purpose | vs. official |
|------|---------|:------:|
| `tabs_context_mcp` | Get tab group context | ✓ |
| `tabs_create_mcp` | Create a new tab | ✓ |
| `tabs_close_mcp` | Close a tab | ✓ |
| `navigate` | Navigate to URL, back, forward | ✓ |
| `computer` | Mouse, keyboard, screenshot, zoom | ✓ |
| `read_page` | Accessibility tree with element refs | ✓ |
| `get_page_text` | Extract article/main text | ✓ |
| `find` | Find elements by text/attributes | ✓ |
| `form_input` | Set form values by ref | ✓ |
| `javascript_tool` | Execute JS in page context | ✓ |
| `read_console_messages` | Console output (filtered) | ✓ |
| `read_network_requests` | Network activity | ✓ |
| `resize_window` | Resize browser window | ✓ |
| `file_upload` | Attach local file(s) to a file input (by ref) | ✓ |
| `upload_image` | Attach a captured screenshot to a file input (by ref) | ✗ |
| `gif_creator` | GIF recording | ✗ |
| `shortcuts_list` | List shortcuts | ✗ |
| `shortcuts_execute` | Run a shortcut | ✗ |
| `switch_browser` | Hand off automation to another Chromium browser | ✗ |
| `execute_code` | Run sandboxed JS that drives every tool via `chrome.*` | |
| `update_plan` | Present a plan for approval | |
| `set_tab_focus` | Surface a tab: select it, optionally raise its window | |
| `get_config` | Read automation settings and the catalog of what they do | |
| `set_config` | Change a setting, globally or for one tab | |
| `recording_ack` | Confirm an imitation-learning recording event | |
| `retranscribe_recording` | Re-run transcription for a failed recording | |
| `debug` | Read what the extension actually did — the detail tool results omit | |
| `debug_timings` | Per-call timing diagnostics | |
| `webmcp_list_tools` | List tools the visited page publishes via WebMCP (experimental, see below) | |
| `webmcp_call_tool` | Call a page-published WebMCP tool (experimental, see below) | |

Notes on the divergences (✗):

- `file_upload` matches Claude in Chrome's interface (`paths`, `ref`, `tabId`) but does **not** restrict sources to session-shared paths — any absolute path on this machine is accepted.
- `upload_image` is file-input-only (target it by `ref`); Claude in Chrome additionally supports dropping an image at a `coordinate` (e.g. Google Docs).
- `gif_creator`, `shortcuts_list`, and `shortcuts_execute` are **currently
  unimplemented stubs**: their input schemas are fully declared and validated,
  but their handlers return a fixed "not yet implemented"/"not supported"
  text result regardless of arguments (`reports/06-registry-baseline.md`).
- `switch_browser` releases the shared runtime for ~15s so another browser can take over, in place of Claude in Chrome's `list_connected_browsers` / `select_browser` pair.

### WebMCP page tools (experimental)

`webmcp_list_tools` and `webmcp_call_tool` let the agent discover and call
tools that the **visited page itself** publishes through the emerging WebMCP
`document.modelContext` API (W3C WebML CG) — not a Browzy capability, a
capability a site chooses to expose about itself. This is deliberately an
early, experimental bet:

- **Origin trial, not general availability.** WebMCP is behind a Chrome
  origin trial spanning versions **149–156**, expiring **2026-11-16**. On an
  ordinary visitor's Chrome, `document.modelContext` is simply absent —
  `webmcp_list_tools` returns an empty list, silently, on essentially every
  site. It becomes available only when the visited site has enrolled in the
  trial and served a trial token, or when the browser itself has
  `chrome://flags/#enable-webmcp-testing` enabled for local testing. Do not
  read this as generally available; treat it as ready for the day a site
  enrolls, not as something that works today on the wider web.
- **Page-supplied, not extension-authored.** Every tool name, description,
  input schema, and result these two operations surface comes from the
  visited page, not from this extension. It is labelled as such everywhere it
  reaches the agent, and its text confers no authorization over anything —
  the same caution already applied to page text reached through
  `get_page_text`/`read_page`, not a new class of trust.
- **Two execution paths, always named.** A call prefers the browser's own
  `executeTool()` entry point (whatever consent/mediation Chrome attaches to
  it) when the browser exposes one, and falls back to the page's own
  registered callback (unmediated) only when it does not. Every result states
  which path served it (`via: executeTool` or `via: captured-callback`).
- **No automated coverage for the live API interaction.** CI has no Chrome.
  The two background handlers are unit-tested (`test/webmcp-handlers.test.mjs`)
  against a faked per-tab table, but the actual `document.modelContext`
  round-trip can only be verified manually, against
  `test/fixtures/webmcp/index.html`, in a Chrome build within the trial (or
  with the testing flag enabled).

## Design mode (element picker)

A composer control (next to Add and Enhance prompt) lets the **operator** —
never the agent — point at one element on the bound page and hand the
assistant its picture, markup and resolved styling in a single gesture,
instead of describing it in prose. Toggling it arms a hover highlight over
the bound tab; clicking an element selects it, `Escape` or a second toggle
cancels, and the mode always ends without capturing anything on those two
routes.

- **A selection produces a composer image plus a separate structured
  record.** The image is a screenshot clipped to the element's bounding
  rectangle, carried by the exact same attachment path (and the same MIME
  allowlist / 10 MB ceiling) as any other composer image. The markup and a
  filtered set of computed styles (`display`, `color`, `border`, and roughly
  two dozen others named once in `extension/overlay/element-picker.js` — not
  the browser's full ~340-property dump) travel as their own field on the
  outgoing message, never spliced into the operator's typed text.
- **Values are stripped in the page, before anything crosses the extension
  boundary.** The picker clones the selected element, then strips the
  current `value` of every input, the content of every textarea, and the
  selected/checked state of every option/checkbox — on the element and every
  descendant, not only the outermost node — and only THEN serializes the
  clone. A password field's containing control is stripped more
  aggressively still: nothing beside the (already-value-stripped) input
  itself survives serialization, closing the leak a value-only strip would
  miss (a mirrored "show password" character display, say).
  `data-*` attributes are kept by default (they usually carry a framework's
  own test/component hooks) — the one deliberate trade-off in this design,
  stated rather than hidden: the operator sees exactly what they picked
  before it is sent.
- **Markup is bounded and truncation is never silent.** Over 32 KB, markup is
  cut at the nearest complete tag and the outgoing record says so, with the
  ceiling that applied.
- **A picked element is bound to the page it came from.** If the bound tab or
  URL changes between picking and sending, the send is refused for that
  attempt and the operator must explicitly send again — the same posture the
  page-context chip itself already takes.
- **This is an operator input path, not a new agent capability.** Activating
  it never takes the browser lease, never passes through the send-class
  approval gate, and never widens a run's tab scope — and it is refused
  outright, before anything is injected, on a page a content script can
  never reach (`chrome://`, the extension gallery, ...) or while a run is
  actively driving that same tab.

## Humanized input

Browser automation normally dispatches input the shortest way possible: the
cursor teleports to a target, the button is pressed and released instantly, a
scroll arrives as one jump. That is efficient, and it looks nothing like a
person.

Turn `humanize` on and input is driven the way a hand drives it — curved cursor
paths with acceleration and overshoot, clicks that land off-centre with a real
press dwell, scrolls decomposed into momentum ticks, and typing with
human-shaped inter-key timing:

```
set_config({ key: "humanize", value: true })
```

Measured on an instrumented page, the same three clicks produce **3 mouse-move
events with it off and 41 with it on** (2 vs 39 distinct points) — while clicks,
mousedowns and mouseups come out identical. That is the guarantee: randomisation
changes *where inside a target* you land, *how* the cursor gets there, and
*when* — never *what happens*. Same element, same text, same scroll position.

Realism costs wall-clock, so the time affordance is a setting:

| `humanize_speed` | |
|---|---|
| `fastest` | The shape of human motion, compressed — for getting through a lot |
| `fast` *(default)* | Fewer path samples and shorter pauses |
| `natural` | Genuine human cadence |
| `relaxed` | Unhurried motion (typing stays near natural — see below) |

Every tier keeps movement before the click, real key events and identical
outcomes; faster tiers use fewer path samples and shorter pauses, never none.
Typing is scaled separately from motion, because its cost is per *character*
rather than per action: the slow tier stretches cursor movement but barely
stretches typing, since an unhurried person still types at their own speed.
For reference, `humanize` off takes ~0.2s to type 15 characters, which is the
floor imposed by CDP dispatch itself. The ceiling is deliberate too — a slower
tier measured at ~4.2s for the same text was cut, because a setting nobody
would pick is a trap rather than an option.


Settings can be scoped to one tab (`set_config({ key, value, tabId })`),
and `get_config` returns the catalog of recognised settings so the current set
is always discoverable rather than documented only here.

Note that typing emits real `keydown`/`keyup` events **regardless** of this
setting — that is parity with Claude in Chrome, which does the same, not a
humanization extra. `humanize` only changes the timing between them.

## Auditing agent sessions

Watch back what an agent did in the browser, instead of asking the session to
describe its own work. Off by default:

```js
set_config({ key: "audit_mode", value: "audit" })
```

With it on, the first action against a tab starts an [rrweb](https://rrweb.io)
DOM recording in it, and the extension stitches those into **one timeline per
Claude Code session**, under **Audits** on the options page. Press play once and
the replay runs start to finish, switching tabs on its own.

It is a *mode* rather than a flag because a later `teach` mode wants the
opposite masking default — an audit should mask what a person types, while
training data is exactly that text.

**How a session is attributed.** The native host already namespaces every
request as `h{clientId}_{id}` so replies route back to the client that asked,
and the extension echoes that id back untouched. Reading the prefix is enough to
know which Claude Code session performed an action, so two agents driving two
tabs produce two independent audits rather than one interleaved mess.

**Streams and segments.** rrweb node ids are integers scoped to a single
snapshot, so two tabs' event streams can never be concatenated — the ids would
collide and both replays would corrupt. A **stream** is therefore one recording
in one tab, living until its document does, and a **segment** is a run of
consecutive actions in one tab. Returning to a tab opens a *new* segment over
the *same* stream. Continuity is built at the timeline layer, never in the data.

A stream costs almost nothing while idle, because rrweb is event driven, but
restarting one costs a full DOM snapshot — so the policy favours keeping streams
alive: a 30-minute idle reaper and a 40MB cap exist only to stop a runaway page.
Hitting the cap marks the stream `truncated` rather than silently stopping,
since a replay that just ends looks identical to a session that ended there.

**What it does and does not capture.** Recording runs in the extension's
isolated world, so the page cannot observe it — no web API exposes content
scripts — where a main-world injection would have to patch natives and could be
spotted with a `toString` check. Canvas recording stays off: it is the one rrweb
feature touching natives (`toDataURL`/`getImageData`) that anti-fingerprinting
sweeps already watch.

The cost of that choice is real and worth knowing before relying on a replay:

| Captured | Not captured |
|---|---|
| DOM structure, text, attributes, ARIA | Video and audio content (elements and play/pause only; `blob:`/MSE sources will not replay) |
| Mutations, input, scroll, mouse | Canvas and WebGL |
| Open shadow roots, adopted stylesheets | Closed shadow roots created before recording started |
| Same-origin CSS (inlined) | Cross-origin CSS — CORS-blocked, cannot be inlined |
| | Assets behind auth or short TTLs, which are referenced by URL and re-fetched at replay |

In short it is excellent for anything marked up and blind to anything *painted*,
which is why the recorder's own image track is not replaced by it.

### Claude in Chrome tools not yet supported in Browzy in Chrome

- `browser_batch` — run several tool calls in one round trip. Browzy in Chrome instead offers `execute_code`, which runs arbitrary JS driving the same tools in one call.
- `list_connected_browsers` — enumerate attached browsers.
- `select_browser` — pick which browser drives automation.
- `upload_image` drop-at-coordinate — Browzy in Chrome's `upload_image` attaches to a file input by `ref` only.

## Updating After Code Changes

No build step. All files are plain JavaScript. After pulling or editing code:

| What changed | What to do |
|---|---|
| `extension/background.js`, `extension/content.js`, `extension/manifest.json`, `extension/sidepanel/*`, `extension/settings/*`, or `extension/recorder/*` | Reload the extension: `brave://extensions` > click the reload icon |
| `host/agent/**` (side panel / SDK companion) | Close and reopen the side panel — the companion is supervised and respawns automatically |
| `host/mcp-server.js` (external MCP) | Kill stale servers and reconnect: `pkill -f "node.*mcp-server"` then `/mcp` in Claude Code |
| `host/codemode/*.js` or `host/codemode/worker/*` (external MCP) | Kill the codemode server: `pkill -f "server-codemode\|server-hybrid"` and `pkill -f wrangler`, then `/mcp` in Claude Code |
| `host/native-host.js` | Restart the browser (close all windows, reopen) |
| `install.sh`/`install.ps1` or native host name changed | Re-run `./install.sh` / `.\install.ps1`, restart browser, re-add MCP if you use the external-MCP path |

### Quick reset (nuclear option)

If things are broken and you're not sure why:

```bash
# 1. Kill all external-MCP servers (side panel is unaffected by this)
pkill -f "node.*mcp-server"

# 2. Re-run install
./install.sh          # or: .\install.ps1

# 3. Restart browser (close all windows, reopen)

# 4. Reload extension in brave://extensions

# 5. Reconnect (side panel: just reopen it; external MCP: /mcp in Claude Code)
```

## Multiple Sessions

**External MCP**: multiple Claude Code sessions can share the same browser extension. The first session becomes the "primary" (owns the TCP port), and subsequent sessions connect as clients through the primary. All sessions can use the browser simultaneously.

If a session disconnects, kill stale servers and reconnect:

```bash
pkill -f "node.*mcp-server"
# then /mcp in each Claude Code session
```

**Side panel and external MCP together**: both are arbitrated by the same shared browser-bridge lease in `native-host.js`. Whichever one currently holds the lease keeps it; the other gets an explicit, retryable "busy" result instead of silently landing an action in the wrong place or on the wrong tab (`reports/03-companion-evidence.md`).

## Community

Questions, ideas, or something broken? **[Join the Discord](https://discord.gg/F4HBKAEbNg)** — good place to ask
before filing an issue, and where feature discussion happens.

## Troubleshooting

See also [Diagnostics](#diagnostics) above for the five distinct failure
classes (ID mismatch, wrong path, runtime unavailable, protocol mismatch,
disconnected browser) and how to tell them apart.

### Extension not connecting

1. Verify the extension is loaded and enabled
2. Check that `./install.sh` / `.\install.ps1` completed without an error (no
   extension ID to pass anymore — the installer derives it automatically; if
   it printed an "id mismatch" or "could not derive the extension id" error,
   see [Diagnostics](#diagnostics))
3. Restart the browser completely (all windows)
4. Verify the native messaging host manifest exists:
   - **Chrome (macOS)**: `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.anthropic.browzy_in_chrome.json`
   - **Brave (macOS)**: `~/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts/com.anthropic.browzy_in_chrome.json`
   - **Edge (macOS)**: `~/Library/Application Support/Microsoft Edge/NativeMessagingHosts/com.anthropic.browzy_in_chrome.json`
   - **Windows (any of the three)**: `HKCU\Software\<Vendor>\NativeMessagingHosts\com.anthropic.browzy_in_chrome` in the registry, pointing at `host\com.anthropic.browzy_in_chrome.json`

### Side panel: "Settings" won't let me use the assistant

Saving Base URL/key/models is allowed offline, but the assistant will not run
until **Test connection** passes for the exact current endpoint, model, and
key. If the test fails, its error names one of: auth, model, rate limit,
timeout, TLS/network, protocol, tool, or vision — see [Provider
compatibility](#provider-compatibility) for what each of these means and the
known gateway-specific quirks.

### Side panel: companion won't start

If the panel reports a startup error instead of connecting, the native
companion isn't reachable within its startup budget — see **Runtime
unavailable** in [Diagnostics](#diagnostics). Restarting the browser
re-triggers native messaging, which restarts the companion.

### MCP server not found (external MCP)

Use an absolute path:
```bash
claude mcp add browzy-in-chrome -- node /absolute/path/to/host/mcp-server.js
```

### "Browser extension is not connected" (external MCP)

The MCP server started but the native host hasn't connected. Try:
1. Open any webpage (wakes the service worker)
2. Check service worker logs: `chrome://extensions` > "Inspect views: service worker"
3. Verify `host/native-host-wrapper.sh` exists (macOS/Linux) or
   `host/native-host-wrapper.bat` (Windows)

### Tools fail immediately after reconnect

This used to mean a stale MCP server from an earlier session was holding the
shared port, and the fix was to `pkill` them. That is no longer possible: the
native host owns the bridge, sessions only connect to it, and a leftover
process holds nothing anyone needs.

If tools still fail, the browser side is the place to look — see "Browser
extension is not connected" above.

### Changing the rendezvous

Sessions and the native host meet on a named pipe (`\\.\pipe\browzy-in-chrome-<user>`
on Windows, a unix socket under a 0700 directory on macOS and Linux). The name
is derived from your username, so nothing needs configuring and two users on the
same machine cannot collide.

To override it — normally only useful for running an isolated second instance:
1. Create `~/.config/browzy-in-chrome/config.json`:
   ```json
   { "pipe": "/tmp/my-own-bridge.sock" }
   ```
2. Restart the browser and Claude Code

`OCIC_PIPE` does the same thing per-process, which is how the test suite stands
up a whole host + client fleet without touching a live install.

## License

MIT
