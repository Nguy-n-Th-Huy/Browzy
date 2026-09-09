## Context

See proposal.md. The current repository is JavaScript: extension/background.js calls Chrome/CDP and manages tab state; host/native-host.js owns native messaging and a local pipe/socket; host/tool-runtime.js exposes browser calls; humanize modules calculate input paths; recorder/vendor modules depend on DOM and third-party JavaScript. The separate SDK change has not been implemented. Its five capability specs are prerequisites, including later additions for accountless onboarding, current-page context, cursor and action timeline.

## Goals / Non-Goals

The product is branded **Browzy**. Rust distribution, installer and diagnostics use this display name; technical identifiers remain compatible with existing native registration and external MCP clients.

Goals: Rust-owned application state and protocol core, a Rust native companion, a real Rust/WASM component inside the extension, stable distribution and preserved product behavior.

Non-goals: 100% Rust/no JavaScript; replacing the official Claude Agent SDK with an unofficial Rust client; removing the SDK runtime dependency; a Tauri desktop app replacing the browser extension; rewriting rrweb/vendor libraries; rewriting generated page JavaScript or the isolated workerd sandbox; claiming speed or security gains solely from language choice. No code is implemented by this change request.

## Decisions

### 1. Hybrid architecture and ownership

Flow: HTML/CSS panel with JS rendering bindings <-> Rust/WASM application core <-> JS Chrome adapter <-> Rust native host <-> TypeScript SDK adapter <-> official Agent SDK/provider. SDK browser tool callbacks return over private IPC to the Rust host and then to the existing extension/CDP executor. Avoid cyclic initialization: host transport starts first, then SDK child; requests are correlated asynchronously rather than blocking native input processing while waiting on SDK results.

| Area | Target ownership | Retained boundary |
|---|---|---|
| Protocol models, validation and errors | crates/protocol | Generated TypeScript contracts for SDK/browser adapters |
| Page-context snapshots, run states, permissions, event reduction and deterministic input-path logic | crates/core | Chrome and DOM effects remain adapters |
| Browser application state | crates/extension-wasm using wasm-bindgen | JavaScript event registration, Chrome calls and DOM rendering |
| Host framing, connections, lifecycle, leases, settings and secret-store interface | crates/native-host | OS APIs and a supervised SDK subprocess |
| Model loop, Skill tool, session resume and internal MCP registration | host/agent/sdk-adapter | Official TypeScript SDK remains authoritative for agent execution |
| CDP commands, content-script DOM access, cursor overlay rendering, audio and recorder libraries | existing extension JS modules | Business decisions move to Rust; effects and third-party code stay JS |
| Generated code execution | existing isolated workerd service | Rust supervises lifecycle; never eval code in host/WASM |

Use one Cargo workspace with pinned toolchain/Cargo.lock, serde-compatible versioned DTOs and wasm-bindgen. Select exact crate versions during implementation after compatibility checks. Reuse a shared core rather than porting validation twice. Do not migrate all DOM rendering to a new Rust UI framework: retaining HTML/CSS rendering protects the reviewed design while Rust owns state. Generated bindings are build output, not hand-edited sources. Node/SDK versions remain pinned separately.

The WASM port must include page-context binding, run/action reducers and protocol validation, not a token demonstration function while all decisions stay in JavaScript. Native and WASM targets execute shared fixture inputs with identical decisions. Host-specific storage/secrets stay outside the WASM dependency graph.

### 2. MV3 initialization and safety

Bundle WASM and its generated JS loader inside the extension. Add only the required wasm-unsafe-eval CSP allowance for extension pages, preserving self-hosted scripts; no remote executable code, ordinary unsafe-eval, eval or inline script workaround. Register Chrome event listeners synchronously in the JS service-worker entry before asynchronous WASM initialization. Queue at most 128 initialization messages for at most 5 seconds, then fail with core-unavailable state; never dispatch a queued browser mutation automatically after a failed initialization. UI shows loading/failure and Retry without claiming ready.

Keep state transitions pure in Rust, with explicit returned effects executed by JS adapters. Store only minimal recoverable state through approved browser storage; service-worker recreation rebuilds WASM and restores context revisions but marks interrupted runs interrupted. Do not rely on permanent WASM memory or timers to keep MV3 alive. WASM traps produce an explicit interrupted run, not silent fallback to old JavaScript execution.

Use canonical viewport coordinates and existing humanization behavior. Validate number ranges, optional fields, Unicode, missing/null distinctions and image representations across Rust/JS serialization. Avoid ferrying full screenshots through the state reducer; use bounded artifact references/binary transport. Preserve document identity and borrowed-tab scope; stop/lease checks also run in native host and tool handlers, not only in a mutable page-side state store.

### 3. Native host and SDK child

Rust executable implements native-message framing on stdin/stdout, exact origin validation, local pipe/socket ownership and asynchronous pending requests. Stdout is protocol-only; diagnostics go to redacted stderr. Validate declared lengths before allocating; enforce a 1 MiB application limit on individual JSON frames in both directions and chunk larger image payloads to fit. Reject malformed/truncated frames, unsupported protocol versions and oversized chunks with bounded memory use. Validate chunk IDs, count, total size and expiry; cap a reconstructed image artifact at 32 MiB and expire incomplete transfers after 30 seconds.

The SDK adapter is a thin Node process using the official SDK and in-process MCP browser tools; it does not own a competing native host, credentials database or browser lease. Rust supplies a per-run profile snapshot and credential through a private inherited channel, never command arguments. Adapter passes required credentials to the SDK and keeps them out of logs and unrelated child environments. Retain SDK session files in their supported format; Rust stores references and product metadata rather than reimplementing SDK transcripts.

Use private inherited pipes for host-child communication and per-user ACLs for external legacy clients. Correlate run/action/request IDs and protocol versions. No public listening port. Same-user compromised processes are outside the ordinary ACL guarantee. Shutdown closes adapter/workerd children and rejects pending calls. Browser disconnect after dispatch yields unknown result and no replay. Restart adapter at most three times with 1/2/4-second backoff, then expose Retry; do not automatically resume generation or browser actions. Any current run is interrupted on adapter death.

### 4. Data and installation

Preserve extension public key/ID, native-host name and recorder data locations. Replace this product's host executable path with the Rust binary through an idempotent installer. Ship Windows x64 first with Chrome/Edge/Brave acceptance; additional OS/architecture packages are supported only after equivalent tests. Retain the legacy path on currently unverified platforms and label that limitation.

Bundle required Node, SDK adapter and compatible SDK execution runtime in the host distribution where redistribution permits. Verify dependency redistribution terms and required notices before publishing; if packaging is not permitted, document and resolve provisioning before release rather than promising a Rust-only executable. Users do not install Cargo/Rust or launch node manually. One-time registration and API settings remain necessary. First-run test uses a clean machine without Claude login or developer toolchains.

Use versioned config migration with a pre-migration backup and atomic writes. Access existing OS credential-store entries by stable application identifiers; request re-entry if unavailable, never export secrets to plaintext. Preserve recordings and skill snapshots; SDK session compatibility is checked against the pinned runtime. Keep an installation manifest with component versions and checksums. Validate all components before changing registration. A mismatch blocks start with repair instructions. Rollback restores the previous executable registration and compatible config backup without deleting post-upgrade user data; retain newer data separately if the older version cannot read it.

### 5. Acceptance and sequencing

Default sequence is SDK product change first, then this migration. Its architecture ownership supersedes the earlier Node companion design only when this Rust change is deliberately applied. The earlier product requirements remain binding. Do not modify both plans implicitly or implement duplicate systems. Before implementation, link to the exact baseline revision and copy its behavior fixtures into migration acceptance references.

Port shared protocol/core, then WASM integration, then native host and SDK IPC, then packaging. Legacy modules remain available for explicit rollback; no mid-run automatic switching. Require coverage for all current 26 tool operations plus execute_code and recorder events, and all five product capabilities. Record startup latency, idle/active memory, tool round-trip latency and bundle sizes on the same machine before/after; report measurements rather than assuming improvement. Block release on feature loss, action duplication, lost data, coordinate drift or login dependencies. Investigate a greater than 20% median regression over 20 identical warm local tool fixtures before release; exclude provider network time and document any accepted tradeoff.

## Risks / Trade-offs

- Added Rust/JS/WASM/SDK boundaries -> one versioned schema, generated bindings and cross-language golden fixtures.
- WASM startup or worker suspension -> synchronous listeners, bounded buffering and explicit state restoration.
- Native packaging grows despite Rust -> retain and disclose SDK/Node/workerd dependencies; validate complete offline-installed startup.
- FFI serialization costs or different floating-point behavior -> measured fixtures and coordinate/action parity, not language-based performance claims.
- SDK change is not implemented yet -> dependency gate; no pretending current repository already contains its planned UI/features.

## Migration Plan

1. Keep all tasks unchecked during spec creation. Establish a passing SDK-product baseline before applying this migration.
2. Prove packaged WASM loading under MV3 and Rust-host/SDK-child bidirectional tools, images and cancellation in an isolated spike.
3. Port core and companion in the ordered areas above; preserve original executor/UI effects and legacy rollback.
4. Validate clean-machine installation, all product/regression contracts, data round trips and compatibility failures.
5. Switch product registration only after validation; rollback explicitly, never replay uncertain mutations.

## Sources

- [Chrome extension CSP](https://developer.chrome.com/docs/extensions/reference/manifest/content-security-policy): packaged WebAssembly policy requirements.
- [wasm-bindgen](https://wasm-bindgen.github.io/wasm-bindgen/): Rust/WASM and JavaScript bindings; the ownership split here is a project design decision.
- [Chrome messaging](https://developer.chrome.com/docs/extensions/develop/concepts/messaging): browser-side communication boundaries.
- SDK integration sources and product requirements remain documented in `../migrate-to-claude-agent-sdk/design.md`; this change keeps that official TypeScript SDK integration rather than asserting a Rust equivalent.
