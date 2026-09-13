## Why

Browzy's browser runtime already exposes a broad tool registry, but the side panel still feels less capable than Claude in Chrome because page context, action visibility, streaming, recovery, and guided workflows are incomplete. This change closes the highest-impact parity gaps while preserving Browzy's provider flexibility and explicit permission model.

## What Changes

- Automatically bind the side panel to the active tab, with pin/remove controls and stale-document detection.
- Expand the side-panel tool surface using the shared registry and curated permission labels.
- Add live page cursor, current-action status, screenshot previews, and an action timeline.
- Implement streamed model output, cancellation, adaptive limits, and safe retry/backoff.
- Add built-in slash workflows for summarization, research, extraction, and form filling.
- Harden local file upload with chooser/session grants.
- Correct GIF capability metadata and stale documentation; add end-to-end coverage.
- Improve approval cards, domain-sensitive warnings, onboarding, and recovery guidance.

## Capabilities

### New Capabilities
- `side-panel-page-context`: Active-tab binding, page context chips, pinning, and document identity.
- `side-panel-action-visibility`: Live cursor overlay, action timeline, screenshots, and run controls.
- `side-panel-agent-runtime`: Full curated browser tools, streaming, cancellation, retry, and adaptive budgets.
- `side-panel-workflows`: Built-in slash commands and safe workflow dispatch.
- `secure-file-upload`: User-mediated file grants scoped to a conversation and run.

### Modified Capabilities
- `browser-assistant-panel`: Change panel behavior to expose active page context, richer tools, approvals, and progress states.
- `agent-browser-runtime`: Change runtime requirements for streaming, cancellation, recovery, and shared tool parity.
- `design-mode-picker`: Change picker requirements to include approved built-in workflows.

## Impact

Affected areas include `extension/sidepanel`, `extension/agent`, `extension/background.js`, `extension/overlay`, `host/agent`, shared tool definitions and mappings, settings/permissions UI, recorder/timeline storage, tests, and README/spec documentation. No provider API contract changes are required beyond consuming streamed Messages API responses.
