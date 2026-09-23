## MODIFIED Requirements

### Requirement: extract_page is offered only when the Jev text model is configured

The runtime SHALL expose a read-only `extract_page` tool to an `anthropic` or `chatgpt` run only when that run's resolved profile has the Jev browser tools enabled, meaning the Jev transport API key for the selected transport source is saved. This is the same gate `browser_subgoal` uses, so the two tools are offered together. The extraction's text-model call SHALL use the run's own primary provider and model. For an `anthropic` run, that is the profile's endpoint and API key. For a `chatgpt` run, it is the companion's loopback gateway with the run's own gateway token. No separate text-model base URL, model id or text-model API key SHALL be required or read for these profile types, and `extract_page` itself SHALL send no request to the Jev transport. When the Jev browser tools are not enabled, the tool SHALL NOT be registered for that run, and its absence SHALL raise no error, exception, warning or user-visible notice. A `typesafe` standalone run SHALL NOT offer `extract_page`.

#### Scenario: Text model configured offers the tool

- **WHEN** an `anthropic`/`chatgpt` run starts on a profile whose Jev transport key is saved
- **THEN** `extract_page` is present in that run's tool set, and its extraction call goes to the run's primary provider and model

#### Scenario: Text model absent silently omits the tool

- **WHEN** an `anthropic`/`chatgpt` run starts on a profile with no saved Jev transport key, even if legacy text-model fields are still stored
- **THEN** `extract_page` is absent from that run's tool set, no error is raised, and every other tool works as before

#### Scenario: Standalone Jev run does not offer it

- **WHEN** a `typesafe` run starts
- **THEN** `extract_page` is not among its tools
