## Context

See proposal.md — Why. The constraints that shape the approach:

- `host/agent/tools/query-options.js` builds the SDK options and currently passes exactly one entry: `mcpServers: { [serverName]: mcpServer }`, this product's own browser server, keyed by the same name its `tools` list is derived from so the two cannot drift.
- `allowedTools` is not a cosmetic list. A bare entry in it causes the SDK to auto-approve that tool before `canUseTool` is consulted — the SDK says so in its own runtime warning. Anything added to `mcpServers` must therefore be a deliberate decision about `allowedTools` too, not an oversight.
- `agent-skills` already implements the catalog contract this needs: import a local package, inspect its metadata, enable or disable, remove, with import never executing anything and only enabled packages reaching a session. `agent-settings`'s "Secret isolation" already fixes where a credential may live.
- `webmcp_call_tool` is the existing precedent for calling something whose side effects are unknowable in advance. It is classified conservatively as mutating for exactly that reason, and gated additionally by the borrowed-tab mutation check.
- The in-flight `add-permission-modes-and-threat-signals` change makes an operation with no classification entry resolve to protected, adds a registry coverage check that fails on a classification gap, and adds an injection probe over returned content.
- Host settings persist through an atomic write helper; the profile store is the existing pattern for user-configured state.

## Goals / Non-Goals

**Goals:**

- A user's own MCP tools are callable in the same run as the browser tools, without giving the connector any authority the user did not grant.
- Adding a connector is inert until the user acts; enabling it is the moment anything runs.
- A connector's failure is legible as that connector's failure.
- Every boundary a connector must not cross is stated as a checkable scenario, not an assumption about well-behaved servers.

**Non-Goals:**

- No connector marketplace, discovery, registry, or auto-install. The user supplies the server.
- No change to the external MCP entry points that let someone else's client drive Browzy — that is the other direction and stays as it is.
- No relationship to WebMCP page-declared tools, which are a page's own tools and keep their own gate.
- No sharing of connectors between profiles or machines, and no export of connector configuration carrying a credential.
- No attempt to sandbox a connector's own process beyond what the operating system already enforces. The trust boundary is the user's decision to enable it, and the boundaries below are what the connector cannot cross regardless.

## Decisions

### 1. Connectors join `mcpServers`; their tools never join `allowedTools` bare

The SDK's own documented behavior is that a bare `allowedTools` entry auto-approves a tool before any permission callback runs. Preapproving a tool whose side effects are unknowable in advance would be the opposite of what a user enabling a connector is agreeing to.

So connector tools are made available through `mcpServers` and are deliberately absent from `allowedTools`, which is precisely what makes them reach the permission path instead of bypassing it. This is a decision about reachability, not a restriction added on top of one.

### 2. Classification follows the existing precedent for unknowable side effects

A connector tool is the same risk class as a page-defined tool: the implementation is not ours, and what it does is not knowable from its name. `webmcp_call_tool` is already classified conservatively for that exact reason, and connector tools are classified the same way rather than optimistically.

The companion change's rule — an unclassified operation resolves to protected — is the backstop, not the plan. A connector tool arriving with no classification would be a gap, and the decision here is to classify deliberately so the backstop never has to fire.

### 3. Namespacing is a collision rule, not a naming convention

Two things make namespacing load-bearing rather than cosmetic: a connector could advertise a tool named exactly like a browser operation, and two connectors could advertise the same name as each other.

The rule is that a browser operation always wins its own name, a connector's tool is reachable only under its namespaced name, and a collision is surfaced. A connector must not be able to make the model believe it is calling `navigate` when it is calling something else — that is an impersonation risk, not a tidiness problem.

The baseline accounting is kept separate for the same reason: the browser registry is a closed, enumerated set, and user-configured tools must not be able to fill a hole in it or appear as a discrepancy in it. A connector tool is neither a baseline operation nor an unaccounted-for addition; it is not a registry operation at all.

### 4. Adding is inert; enabling is the act

Adding a connector records configuration. Inspecting it or enabling it is what contacts it. This mirrors the skills catalog's "import SHALL never execute package scripts", and it matters more here: a connector is frequently a process to spawn or an endpoint to reach, so "added" must not mean "running".

Disabling takes effect for calls made after it, and does not rewrite results already returned — the same honesty rule the runtime already applies to actions that have already happened.

### 5. Credentials reuse the provider-credential path exactly

There is already a requirement fixing where a credential may live and what must never contain one. A connector credential is a credential; it gets the same storage, the same clearing of the raw value after submission, the same absence from diagnostics and exports, and the same explicit failure when secure storage is unavailable.

Writing a second, weaker path for "just a connector token" is how the strong one stops being true.

### 6. Failure is contained and bounded, never outstanding

A connector is a separate process or a remote endpoint, so unreachable, hung, and malformed are ordinary states rather than edge cases. Each resolves to a distinguishable outcome within a bounded time, naming the connector.

The spec deliberately separates timeout from refusal from a successful empty result. Collapsing them would leave a user unable to tell "your connector is down" from "your connector says there is nothing".

### 7. A connector's output is content, never authority

A connector returns data into the model's context. That is the same position page content occupies, and the runtime already has a rule for it: content is task data, never authorization. The spec restates it for connectors explicitly because a connector feels more trusted than a web page — the user chose it — and that feeling is exactly what an attacker who compromises or spoofs a connector would rely on.

Routing connector content through the injection probe follows from the same reasoning. It warns and never blocks, consistent with that change's decision.

## Risks / Trade-offs

- **A connector is a local process the user asked to run** → Enabling is an explicit user act on configuration the user supplied, and the catalog shows source and transport before enabling. Browzy does not discover, fetch, or install connectors.
- **A compromised or malicious connector tries to widen its reach** → Every widening path is named and closed as a scenario: settings, credentials, permission mode, remembered decisions, browser scope, enabling another connector. Its content carries no authorization, and its tools cannot take a browser operation's name.
- **Connector tools enlarge what the agent can do in one run** → They are absent from `allowedTools` by decision, classified conservatively, and subject to the same permission resolution as any other non-preapproved call.
- **A slow connector degrades every run** → Calls are bounded and resolve with a distinguishable timeout; browser tools and other connectors are unaffected by one connector's state.
- **Credential sprawl across several connectors** → All of them live in the OS credential store on the provider credential's terms, and removing a connector removes its credential.
- **Two in-flight changes interact** → This change depends on the permission work for classification and the probe. It adds no requirement that contradicts it, and its baseline-accounting requirement exists specifically so connector tools cannot disturb that change's registry checks.

## Migration Plan

1. Add the catalog and its persistence with no runtime effect: a user can add, inspect, enable, disable and remove, but nothing is passed to a run yet. Fully reversible and observable on its own.
2. Expose enabled connectors to a run through `mcpServers`, with namespacing and classification in place, and deliberately absent from `allowedTools`.
3. Add the timeline identification for connector calls.
4. Route connector content through the injection probe once that lands.

Rollback: step 2 is the only one that changes what a run can do, and reverting it returns runs to browser tools only while leaving the catalog intact.

## Open Questions

- Which transports to support first. The spec is written against connector behavior rather than a transport list, so supporting one transport initially satisfies every requirement here and adding another later changes no requirement.
