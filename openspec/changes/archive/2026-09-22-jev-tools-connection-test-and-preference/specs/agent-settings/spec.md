## ADDED Requirements

### Requirement: Jev-tools connection test on LLM profiles

An `anthropic` or `chatgpt` profile that has configured the Jev browser tools SHALL be able to test that configuration and receive a clear success or failure result, distinct from the primary provider's connection test. The test SHALL validate the resolved Jev configuration for the profile — the text model for `extract_page`, and additionally the `openai` decision model and transport for `browser_subgoal` — reusing the existing Jev capability-test path rather than a second implementation. The result SHALL indicate which tool(s) the current configuration enables. The test SHALL never expose or log a secret, and its failure message SHALL be a bounded, host-authored classification. When the Jev tools are not configured, the affordance SHALL make that state clear rather than reporting a false success.

#### Scenario: A valid Jev config tests successfully

- **WHEN** the user has entered a working text model (and, for `browser_subgoal`, the `openai` decision model and transport) and runs the Jev-tools connection test
- **THEN** the test reports success and indicates which tool(s) the configuration enables, without showing any secret

#### Scenario: An invalid Jev key or model fails clearly

- **WHEN** the Jev text model or decision model key/endpoint is wrong
- **THEN** the test reports a bounded, host-authored failure with no secret, and does not claim the tools are available

#### Scenario: Text-model-only config enables extract_page only

- **WHEN** only the text model is configured (no decision model or transport)
- **THEN** the test indicates `extract_page` is enabled and `browser_subgoal` is not, rather than failing outright

#### Scenario: The test is separate from the primary provider test

- **WHEN** the user runs the Jev-tools connection test on a `chatgpt`/`anthropic` profile
- **THEN** it validates the Jev configuration, not the profile's primary ChatGPT/Anthropic provider, and the primary connection test is unchanged
