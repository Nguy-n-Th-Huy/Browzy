## Why

Browzy's agent can only call tools Browzy itself ships. `host/agent/tools/query-options.js` passes a single entry to the SDK — `mcpServers: { [serverName]: mcpServer }` — this product's own browser server, and its own comment states the position plainly: "this product owns its own MCP connections". A user who already runs an MCP server for their issue tracker, their database, or their notes cannot let the assistant reach it. The work has to be copied into the browser by hand, or done somewhere else entirely.

Browzy already supports MCP in the other direction: an external client can drive the browser through the stdio entry points. That interface deliberately "SHALL not require importing external servers into the extension", and it solves a different problem — someone else's agent using Browzy's browser. It does nothing for Browzy's own agent needing someone else's tools.

The extension also already has the shape this should take. `agent-skills` lets a user import a local skill folder, inspect it, enable or disable it, and remove it, with import never executing anything and only enabled packages reaching a session. A connector catalog is the same contract applied to a different kind of capability.

## What Changes

- Settings gain a connector catalog: the user adds an MCP server, inspects the tools it advertises, enables or disables it, and removes it.
- An enabled connector's tools become callable by the panel's agent alongside the browser tools, in the same run.
- Adding a connector never starts it. A connector is contacted only when the user asks to inspect it or enables it, and only an enabled connector reaches a session.
- Connector tools are namespaced so they can never shadow, impersonate, or be mistaken for one of Browzy's own browser operations.
- Connector credentials are held by the companion in the OS credential store, on the same terms as the provider credential: never in extension storage, never in logs, never in exported settings.
- A connector that fails, hangs, or returns malformed output fails as that connector, without taking down the run or the browser tools.
- Connector tool results are treated as untrusted external content, exactly as page content is.

## Capabilities

### New Capabilities
- `agent-mcp-connectors`: the user-managed catalog of external MCP servers, how a connector is added, inspected, enabled, disabled and removed, how its tools are exposed to a run, how its credentials and failures are handled, and the boundaries it can never cross.

### Modified Capabilities
- `browser-assistant-panel`: connector tool activity appears in the action timeline identified by its connector, so a user can tell a connector's action from a browser action.

## Impact

- `host/agent/tools/query-options.js` — the `mcpServers` option gains the enabled connectors alongside this product's own server, and `allowedTools` must account for them rather than silently preapproving or silently excluding them.
- `host/agent/settings/` — connector catalog persistence, following the existing atomic-store and profile-store patterns.
- Credential storage — the existing OS credential store path used for the provider credential.
- `extension/settings/` — the catalog UI, alongside the existing skills catalog.
- `extension/sidepanel/` — timeline rendering for connector tool calls.
- `openspec/specs/browser-assistant-panel/spec.md` — the modified requirement above.
- Interaction with `add-permission-modes-and-threat-signals`: a connector tool has unknowable-in-advance side effects, the same risk class that change already classifies conservatively for page-defined tools. Connector tools need a deliberate classification, and the registry-baseline accounting must not treat a user-configured tool as an unaccounted-for registry operation.
- Interaction with the injection probe in that same change: a connector's returned content is external content and should be probed on the same terms as page content.
