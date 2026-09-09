## Purpose

Provide a packaged Rust/WebAssembly extension core with predictable initialization and browser behavior matching the established assistant product.

## ADDED Requirements

### Requirement: Packaged shared extension core
The extension SHALL execute shared protocol validation, page-context binding and run/action state logic through its packaged Rust/WASM core while preserving Chrome API access and existing visual behavior through browser adapters. It SHALL not fetch executable code remotely.

#### Scenario: Current-page workflow
- **WHEN** a user submits an article-analysis request from the current page
- **THEN** the Rust-backed state layer binds the same page and produces the same authorized read behavior and visible result as the product baseline

### Requirement: Bounded initialization and recovery
Core initialization SHALL buffer only bounded events, expose loading/error state and prevent tool execution while unavailable. Worker recreation SHALL restore persisted context without replaying interrupted mutations.

#### Scenario: WASM fails to load
- **WHEN** the packaged module is missing, incompatible or traps
- **THEN** the application shows a core error and Retry, marks affected work interrupted and never silently executes a queued click through a fallback implementation

### Requirement: Cross-language behavioral consistency
Native and browser core builds SHALL agree on valid/invalid protocol inputs, Unicode text, context revisions, run transitions and action coordinates for the same fixtures.

#### Scenario: Ported input and event flow
- **WHEN** golden fixtures are evaluated by both targets
- **THEN** resulting decisions match, and the browser's cursor/timeline represent actual dispatched actions without altered targets or duplicated events
