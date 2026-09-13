## 1. Page context
- [ ] 1.1 Connect active-tab tracker to panel lifecycle and emit URL/title/document identity.
- [ ] 1.2 Add pin/remove controls and persisted binding state.
- [ ] 1.3 Enforce stale-document checks for reads and mutations; add navigation/reload tests. ← (verify: stale actions never dispatch)

## 2. Tool parity and runtime
- [ ] 2.1 Replace the seven-tool panel whitelist with shared registry mapping and policy labels.
- [ ] 2.2 Implement tolerant SSE parsing, incremental text/tool events, and JSON fallback.
- [ ] 2.3 Add AbortController cancellation, lease release, adaptive token/iteration budgets.
- [ ] 2.4 Add bounded retry/backoff for 429/5xx/network errors; prohibit unsafe mutation retries. ← (verify: cancellation and retry integration tests)

## 3. Visual feedback
- [ ] 3.1 Relay action events to panel with sequence IDs and reconnect replay.
- [ ] 3.2 Wire pointer overlay to active tab with coordinate scaling and hide/degrade behavior.
- [ ] 3.3 Render live action cards, screenshot thumbnails, elapsed time, stop, pause, and approval controls. ← (verify: end-to-end overlay/timeline flow)

## 4. Workflows and policy
- [ ] 4.1 Define built-in slash command catalog and argument parsing.
- [ ] 4.2 Dispatch workflows through existing approval/untrusted-content gates.
- [ ] 4.3 Fix GIF capability metadata/system prompt and add GIF end-to-end coverage.

## 5. Secure uploads
- [ ] 5.1 Add chooser/session-grant protocol and panel confirmation card.
- [ ] 5.2 Enforce containment, MIME/size limits, revocation, expiry, and conversation deletion cleanup. ← (verify: traversal and revoked-grant tests)

## 6. UX, docs, and validation
- [ ] 6.1 Add domain-sensitive approval details and onboarding diagnostics.
- [ ] 6.2 Update README/tool comparison and remove stale unsupported claims.
- [ ] 6.3 Run unit, integration, extension parse/CSP, and manual 320/400/480px light/dark verification. ← (verify: all capability scenarios and legacy MCP compatibility)
