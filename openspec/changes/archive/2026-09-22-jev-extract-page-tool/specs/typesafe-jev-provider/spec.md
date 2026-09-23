## MODIFIED Requirements

### Requirement: Coexistence with the existing runtimes

The TypeSafe provider SHALL be additive: `anthropic` and `chatgpt` runs, the external MCP entry points, skills, recordings, and the share of the browser lease SHALL behave exactly as before, and a TypeSafe run SHALL obey the same lease and queueing arbitration as any other run. Switching a conversation's provider identity SHALL follow the existing bound-identity rules: a conversation bound to a different provider or model requires a new conversation unless the operator explicitly starts a new context.

An `anthropic` or `chatgpt` run MAY additionally expose the `browser_subgoal` tool when, and only when, its profile also carries complete Jev configuration; this addition SHALL be the ONLY difference in those runs' behavior. A `browser_subgoal` sub-run SHALL execute on the caller run's existing browser lease and bound tab and SHALL NOT acquire a second lease or alter lease/queue arbitration. An `anthropic` or `chatgpt` run MAY additionally expose the read-only `extract_page` tool when, and only when, its profile has the Jev text model configured; this addition SHALL NOT dispatch a browser action, acquire a lease, or otherwise change the run's behavior. When neither Jev configuration nor the Jev text model is present, an `anthropic`/`chatgpt` run SHALL behave exactly as it did before these capabilities existed. The standalone `typesafe` run path SHALL be unchanged and SHALL NOT expose `browser_subgoal` or `extract_page`.

#### Scenario: Side-by-side providers

- **WHEN** a `typesafe` conversation and an `anthropic` or `chatgpt` conversation both exist
- **THEN** each runs under its own provider path, lease contention is arbitrated exactly as between two LLM conversations, and neither path's behavior is altered by the other's existence

#### Scenario: Identity mismatch is refused

- **WHEN** a conversation bound to an `anthropic` profile/model is asked to run a `typesafe` turn without a new context
- **THEN** the existing incompatible-identity outcome applies unchanged

#### Scenario: An LLM run with Jev configured gains only the tool

- **WHEN** an `anthropic`/`chatgpt` run starts on a profile that also has complete Jev configuration
- **THEN** the run behaves exactly as before except that `browser_subgoal` is available, and any subgoal it runs shares the run's single lease and bound tab

#### Scenario: An LLM run without Jev configured is unchanged

- **WHEN** an `anthropic`/`chatgpt` run starts on a profile with no Jev configuration
- **THEN** the run behaves exactly as it did before this capability existed and `browser_subgoal` is absent

#### Scenario: An LLM run with the text model configured gains extract_page

- **WHEN** an `anthropic`/`chatgpt` run starts on a profile with the Jev text model configured
- **THEN** the run behaves exactly as before except that the read-only `extract_page` tool is available, dispatching no browser action and acquiring no lease

#### Scenario: An LLM run without the text model does not offer extract_page

- **WHEN** an `anthropic`/`chatgpt` run starts on a profile with no Jev text model configured
- **THEN** `extract_page` is absent and the run behaves exactly as it did before this capability existed
