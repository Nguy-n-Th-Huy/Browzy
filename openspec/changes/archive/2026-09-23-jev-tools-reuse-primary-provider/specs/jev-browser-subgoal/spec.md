## MODIFIED Requirements

### Requirement: The browser_subgoal tool is offered only when Jev is configured

The runtime SHALL expose a `browser_subgoal` tool to an `anthropic` or `chatgpt` run only when that run's resolved profile has the Jev transport configured, meaning the transport API key for the profile's selected Jev transport source (TypeSafe, Vercel AI Gateway or OpenRouter) is saved. The sub-run's decision and content model SHALL be the run's own primary provider and model. For an `anthropic` run, that is the profile's endpoint and API key. For a `chatgpt` run, it is the companion's loopback gateway with the run's own gateway token. No separate text-model base URL, model id or text-model API key, and no particular stored decision-model source, SHALL be required or read for these profile types. The Jev transport SHALL always use its own transport key, and the primary provider's key or gateway token SHALL NEVER be sent to the Jev transport. When the transport key is absent, the tool SHALL NOT be registered for that run, and its absence SHALL raise no error, exception, warning or user-visible notice. A `typesafe` standalone run SHALL NOT offer `browser_subgoal` (it already is a Jev run).

#### Scenario: Configured profile offers the tool

- **WHEN** an `anthropic` or `chatgpt` run starts on a profile whose Jev transport key is saved
- **THEN** `browser_subgoal` is present in that run's tool set alongside the existing browser tools, with no separate text-model configuration required

#### Scenario: Unconfigured profile silently omits the tool

- **WHEN** an `anthropic` or `chatgpt` run starts on a profile with no saved Jev transport key
- **THEN** `browser_subgoal` is absent from that run's tool set, no error is raised, and every other tool works as before

#### Scenario: A reused-key decision source does not satisfy the gate

- **WHEN** an `anthropic`/`chatgpt` profile's stored `typesafeDecisionSource` is `anthropic`, `chatgpt` or `openai`
- **THEN** that stored value has no effect on the gate: the tool is registered exactly when the transport key is saved, and the primary key or gateway token is used only for the model call, never for the Jev transport

#### Scenario: The sub-run's model is the primary provider

- **WHEN** a `browser_subgoal` sub-run on a `chatgpt` run consults its decision/content model
- **THEN** the request goes to the companion's loopback gateway for the run's own model, authorized with the run's gateway token, and no ChatGPT token or separate text-model key is used

#### Scenario: Primary credentials never reach the Jev transport

- **WHEN** a `browser_subgoal` sub-run sends a request to the Jev transport
- **THEN** that request carries only the saved Jev transport key, never the Anthropic key or the gateway token

#### Scenario: Standalone Jev run does not offer it

- **WHEN** a `typesafe` run starts
- **THEN** `browser_subgoal` is not among its tools
