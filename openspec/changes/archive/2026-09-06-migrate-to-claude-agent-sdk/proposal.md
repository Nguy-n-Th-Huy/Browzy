## Why

The product goal is a standalone extension with a Claude-in-Chrome-like experience that does not require a Claude account, Claude login, or Claude subscription. Users supply their own Anthropic-compatible Base URL, API key and model, then use chat, current-page understanding, visible browser control and skills inside the browser. A valid provider credential is still required; accountless here means no Claude product account, not free or unauthenticated inference.

The current project requires manual extension-ID installation and a Claude Code MCP client. Add one-time setup followed by browser-only use while retaining external MCP control as a supported alternative. This change is specification only; implementation and archive are not authorized in this request.

## What Changes

- Brand the user-facing product as **Browzy** across extension name, panel, settings, onboarding and documentation. Preserve stable technical identifiers and existing MCP launch contracts.

- Make no-Claude-account onboarding a release requirement: no Claude sign-in, subscription check, Claude session-cookie reuse, or dependency on the proprietary Claude in Chrome extension. Configure supported provider credentials directly.

- Show an agent cursor and click feedback on the controlled page, with an active-control indicator and Stop; present a truthful action timeline with screenshot thumbnails in the panel, following the latest reference images.
- Establish a polished Claude-in-Chrome-inspired visual system with light/dark themes, shared design tokens, and screenshot-based visual acceptance.
- Automatically bind the current browser page to the composer so "read this article and analyze it" reads the active article without URL entry or creating a new tab.
- Introduce a browser side panel for streaming chat, model selection, tool progress, stop, session history, and recording controls, using the attached screenshot as a layout reference only.
- Run Claude Agent SDK in a local Node companion. Configure the browser tools automatically through an in-process SDK MCP server; sidepanel users do not need to register or launch an MCP server themselves.
- Preserve the existing extension/CDP browser executor and wrap its runtime as SDK custom tools. Validate this integration in an explicit acceptance gate before migrating the product.
- Gate only sending/submitting-class browser actions behind an explicit user decision. Browser tools remain auto-approved at the SDK layer exactly as the tool-permission fix already established (`tools`/`allowedTools`, no manual per-tool grant); on top of that, submitting a form, clicking a send/submit/pay/confirm control, or a comparably hard-to-reverse outward-facing action suspends the run and shows a visible allow/deny card in the panel, bound to that run, before it executes. Every other browser action — reading, extracting text, screenshots, scrolling, hovering, navigation clicks, typing into fields, filling forms, opening/closing agent-created tabs, and page script execution already within scope — keeps running automatically with no prompt. This narrows, rather than replaces, the existing "Actions outside the task's existing authorization SHALL wait for a user decision" requirement.
- Add an application-owned ask-the-user tool the agent can call mid-task to present one question with 2-4 pre-written answer options in the panel — for example choosing among several matching tender notices instead of guessing, or confirming a value before filling a field — and continue the run using the option the user clicked. The chosen answer returns to the run as plain data, never as authorization, and it can never substitute for the send/submit approval card above.
- After one-time installation and provider setup, opening the browser automatically starts the companion and configures browser tools; no terminal, Claude Code chat client, or repeated MCP setup is required.
- Support reusable skills through the SDK and a `/` picker with names/descriptions, explicit invocation and automatic invocation of enabled skills.
- Preserve external MCP clients using the existing stdio/default/codemode/hybrid interfaces to control the same browser extension. MCP-only use requires no sidepanel setup or assistant API key; stable extension identity applies to both access paths. This does not add arbitrary MCP-server import to Settings.
- Fix extension identity independently: ship a persistent public manifest key, derive its ID automatically during installation, and retain exact native-messaging origin allowlists.
- Add Base URL, API key, editable model IDs/display names/default model, connection testing, and optional model discovery compatible with Anthropic APIs.
- Preserve existing browser operations, sandboxed code execution, and recording workflows through the new UI/runtime, with regression criteria derived from the actual tool registry rather than README parity claims.
- **BREAKING**: the default interaction moves from Claude Code plus MCP to the extension side panel plus companion. Existing external MCP entry points remain a supported interface after migration, not merely a temporary fallback; no automatic deletion or modification of user MCP configurations.
- Live testing against a real listing/index page found extraction reporting `Complete: yes` on boilerplate-only fallback content, no tool-description steering toward the read-only enumeration tools that already cover listing pages, and a page-scripting call rejected on a borrowed tab for the wrong reason (a coarse, tool-name-level mutation classifier) alongside one correctly rejected for the right reason. Extraction completeness reporting, tool-description steering, and the borrowed-tab scripting gate are specified accordingly, without weakening the borrowed-tab read-only default that this evidence also proved is working correctly.

## Capabilities

### New Capabilities

- `agent-browser-runtime`: SDK sessions, automatically configured browser tools, browser capability preservation, isolation, recovery, and migration gates.
- `stable-extension-installation`: stable extension identity and automatic native-host registration with diagnostics.
- `agent-settings`: Anthropic-compatible provider settings, secret storage, model configuration, and connection checks.
- `agent-skills`: import and enable local SKILL.md packages, native SDK invocation, and a searchable slash-command picker.
- `browser-assistant-panel`: browser-side chat, session and tool state, browser scope, and existing recorder access.

### Modified Capabilities

None. No existing OpenSpec capability specifications were present.

## Impact

- Existing areas: `extension/manifest.json`, `extension/background.js`, `extension/recorder/*`, `host/native-host.js`, `host/tool-runtime.js`, `host/tool-definitions.js`, `host/endpoint.js`, `host/parent-watch.js`, `host/codemode/common.js`, `host/codemode/worker/*`, `install.sh`, `README.md`, and relevant tests under `host/test/` and `test/`.
- New implementation areas: `host/agent/`, `extension/sidepanel/`, `extension/settings/`, native Windows installation support, and SDK integration tests. Exact file breakdown is specified in design/tasks.
- New runtime dependency: the official TypeScript Claude Agent SDK, pinned after compatibility verification. Anthropic API billing and supported gateway credentials replace a requirement to interact through a Claude Code MCP client.
- The extension still needs a native companion; the SDK is not a browser-bundled replacement for Chrome extension APIs. Windows with Chrome/Edge/Brave is the initial release verification matrix; existing POSIX installer behavior must be retained and tested where available.
- No product code, dependency changes, installed browser settings, credentials, or live website actions are part of this spec-only change.
