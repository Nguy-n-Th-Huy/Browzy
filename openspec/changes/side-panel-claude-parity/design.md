## Context

See proposal.md and the five capability specs. The extension already has shared registry definitions, page-context metadata, overlay primitives, recorder storage, approval gates, and a native companion; the gap is wiring these pieces consistently into the side-panel path.

## Goals / Non-Goals

**Goals:** one active/pinned tab context; registry-backed panel tools; event-streamed runs with cancellation; visual action feedback; safe built-ins and file grants; compatibility with existing MCP clients.

**Non-Goals:** changing the external MCP contract, adding arbitrary shell/filesystem access, bypassing approval policy, or introducing a vendor-specific account requirement.

## Decisions

1. **Reuse shared tool definitions and policy mapping.** The panel will derive its advertised tools from the same registry and apply the existing adapter gate. This avoids two divergent capability lists; a separate panel-only registry was rejected.
2. **Use one event envelope for text, tool, approval, cursor, and timeline events.** Background and companion will relay sequenced events, allowing replay after a panel reconnect. Ad-hoc UI polling was rejected because it loses ordering and increases latency.
3. **Bind by document identity, not URL alone.** URL, frame, and document token are checked at dispatch; a mismatch invalidates the action. URL-only binding was rejected because SPA navigations and reloads can preserve URLs.
4. **Retry only transport/model steps automatically.** Browser mutations and protected operations require a fresh model decision or approval. Blind tool retries were rejected as unsafe.
5. **Use chooser-backed upload grants.** The native host stores opaque, conversation-scoped grants and never accepts arbitrary model-supplied paths. Direct path acceptance was rejected for data-exfiltration risk.

## Risks / Trade-offs

- [Event ordering across service-worker restarts] → Persist sequence/checkpoint state and mark gaps as unavailable rather than inventing events.
- [More advertised tools increase model mistakes] → Curate descriptions, include scope in schemas, and surface policy labels in the panel.
- [SSE providers differ in framing] → Implement tolerant SSE parsing with bounded buffers and retain JSON fallback for explicitly non-streaming gateways.
- [Overlay may be blocked by page CSP] → Mount in an isolated extension layer and degrade to panel-only timeline.

## Migration Plan

Ship behind per-feature settings flags, enable page binding and streaming first, then action visibility and workflows. Preserve the legacy seven-tool fallback until registry parity passes integration tests. File grants invalidate legacy absolute-path calls after migration; show a chooser prompt instead.
