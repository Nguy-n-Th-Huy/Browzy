## 1. Baseline and integration proof

- [ ] 1.1 Establish the passing `migrate-to-claude-agent-sdk` baseline revision and acceptance fixtures; reconcile ownership explicitly if the two changes are implemented together.
- [ ] 1.2 Prove packaged Rust/WASM loads in MV3 service worker and panel under the required CSP, including worker restart and bounded initialization failure.
- [ ] 1.3 Prove Rust native messaging plus a supervised TypeScript SDK adapter can stream, call browser tools, return actual images, invoke a skill and stop without Claude login. ← (verify: SDK remains official and no hidden dependency on prior login or manual process startup)

## 2. Shared Rust core

- [ ] 2.1 Create pinned Cargo workspace and protocol/core/WASM crates, with generated adapter contracts and versioned error envelopes.
- [ ] 2.2 Port protocol validation, page-context snapshots, run/action reducers and deterministic input-path calculations to shared Rust logic.
- [ ] 2.3 Add cross-target golden fixtures for Unicode, numeric ranges, optional fields, document revisions, permission decisions, cursor coordinates and cancellation. ← (verify: native and WASM decisions match and no behavior is replaced by a superficial demo port)

## 3. Extension integration

- [ ] 3.1 Add packaged WASM loader and minimal CSP update to extension build; register JS browser listeners before initialization and implement bounded buffering/error states.
- [ ] 3.2 Connect service-worker and sidepanel state to Rust outputs while retaining Chrome/CDP, DOM, visual overlay and rendering adapters.
- [ ] 3.3 Preserve recorder/vendor and workerd boundaries; remove duplicate migrated logic only within owned modules after equivalent tests pass.
- [ ] 3.4 Verify current-page binding, borrowed-tab permissions, cursor alignment, timeline ordering, screenshot cleanliness, worker suspension and trap recovery. ← (verify: no silent JS fallback, stale scope or replayed action)

## 4. Native companion and SDK adapter

- [ ] 4.1 Implement native framing, bounded chunks, origin/version validation, user-scoped pipe/socket ownership and request correlation in crates/native-host.
- [ ] 4.2 Port companion configuration, secret-store access, leases, persistence, lifecycle and recorder event routing to Rust, preserving data identifiers.
- [ ] 4.3 Extract the minimal official SDK adapter with internal MCP tools and native Skill support; implement private IPC, credential handoff and child supervision.
- [ ] 4.4 Test malformed/truncated/oversized frames, incompatible versions, concurrent clients, child crash/backoff, stop, disconnect and unknown outcomes. ← (verify: protocol-only stdout, bounded resources, no secret logs and no duplicated mutations)

## 5. Distribution and migration

- [ ] 5.1 Build Windows x64 release components with component versions/checksums and documented pinned Rust, WASM, Node and SDK build inputs.
- [ ] 5.2 Verify redistribution terms/notices and package supported runtime dependencies; resolve provisioning before release if bundling is not permitted.
- [ ] 5.3 Update product installers to register the Rust executable without changing extension identity; implement atomic config migration, backups, compatibility checks and explicit rollback.
- [ ] 5.4 Test clean-machine installation, restart, upgrade failure, rollback, spaces/Unicode paths, unavailable secret store and preservation of recordings/skill/session data. ← (verify: users need no Rust toolchain, terminal launch or repeated extension-ID entry)

## 6. Release acceptance

- [ ] 6.1 Run the full baseline tool inventory plus execute_code/recording tests and all five SDK-product capability suites, including visual review in both themes.
- [ ] 6.2 Compare startup, memory, package size and 20-run local tool latency on the same machine; investigate regressions under the design's acceptance policy.
- [ ] 6.3 Document Rust/JS/SDK ownership, supported platform matrix, included runtime dependencies, build steps and repair/rollback without claiming all-Rust or guaranteed faster operation.
- [ ] 6.4 Permit cutover only after parity, accountless onboarding, data preservation and lifecycle gates pass. ← (verify: no edits to unrelated REAL/, benchmark/, scratch/ or vendor sources and no automatic removal of legacy/user data)
