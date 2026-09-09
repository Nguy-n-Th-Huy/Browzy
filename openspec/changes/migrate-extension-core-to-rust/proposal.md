## Why

Move the extension's application core and native companion to Rust while preserving the Claude-in-Chrome-like, provider-key-only product defined in `migrate-to-claude-agent-sdk`. This is a separate specification for a hybrid Rust migration, not a claim that Chromium or the official TypeScript Agent SDK can execute an all-Rust extension directly.

## What Changes

- Preserve the approved **Browzy** user-facing brand throughout the Rust migration while retaining existing stable extension/native-host/MCP identifiers.

- Compile shared protocol, validation, page-context state and action-state logic to native Rust and WebAssembly; use the WASM core in the extension service worker and sidepanel state layer.
- Replace the native messaging bridge and application companion services with a packaged Rust executable, including lifecycle, persistence, secret-store integration and SDK-child supervision.
- Keep a small TypeScript/Node adapter for the official Claude Agent SDK and automatically configured in-process MCP tools. Keep JavaScript bindings for Chrome/CDP/DOM, HTML/CSS rendering, recorder libraries and the isolated generated-code worker.
- Preserve current-page analysis, polished UI, visible cursor, action timeline, model/provider settings, skills and no-Claude-login onboarding.
- **BREAKING**: native-host executable packaging and internal protocol versions change. Provide explicit compatibility checks, data migration and rollback; preserve the stable extension public key and external browser behavior.
- Add release packaging that supplies supported runtime dependencies without asking daily users to install Rust or run development commands.

## Capabilities

### New Capabilities

- `rust-extension-core`: packaged WASM application core, browser adapter contracts and deterministic lifecycle behavior.
- `rust-native-companion`: Rust host lifecycle, supervised SDK integration, protocol validation and protected persisted state.
- `rust-distribution-migration`: versioned installation, runtime packaging, feature-parity gates and rollback.

### Modified Capabilities

None. The five product capabilities are currently proposed in the separate active SDK change, not archived main specs. They remain mandatory acceptance dependencies and are not redefined here.

## Impact

- Proposed new areas: root Cargo workspace, `crates/protocol/`, `crates/core/`, `crates/extension-wasm/`, `crates/native-host/`, `host/agent/sdk-adapter/`, build/package scripts, compatibility fixtures and migration tests.
- Existing areas: `extension/background.js`, `extension/content.js`, `extension/humanize/`, `extension/manifest.json`, future sidepanel/settings, `host/native-host.js`, `host/tool-runtime.js`, endpoint/lifecycle helpers, installer and documentation. Third-party vendor libraries and `REAL/`, `benchmark/`, `scratch/` are excluded from rewriting.
- Dependency: implement after the SDK change establishes passing product contracts. If implemented together, explicitly reconcile ownership: Rust owns host/core; TypeScript owns the SDK adapter. Never build two competing companions. This spec does not authorize either implementation today.
- Rust is selected for shared typed logic and native lifecycle control; performance improvement is not promised without measurements. UI stays HTML/CSS/JavaScript-backed, with application state supplied by Rust/WASM.
