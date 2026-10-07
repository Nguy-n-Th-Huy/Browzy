## ADDED Requirements

### Requirement: OpenAI Decisions Jev transport source
The Jev transport source selector SHALL offer `openai`, labelled "OpenAI Decisions", alongside the existing sources. Selecting it sets the default base URL to `https://api.openai.com` and the default decision model to `gpt-6-luna`, and stores the transport key in the profile's settings storage just like the other sources' keys. Profile validation accepts `openai` as a stored source. A saved key enables the Jev browser tools in the same way as for other sources. The key value is never written to logs, error messages, or the panel UI after saving.

#### Scenario: Select OpenAI source
- **WHEN** the operator selects "OpenAI Decisions" and saves a key
- **THEN** the profile persists source `openai`, base `https://api.openai.com`, and model `gpt-6-luna`, and `extract_page` and `browser_subgoal` appear

#### Scenario: Custom base URL
- **WHEN** the operator enters a custom base URL for the `openai` source
- **THEN** decisions post to `<custom base>/v1/decisions`
