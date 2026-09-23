## ADDED Requirements

### Requirement: Jev browser-tools configuration on LLM profiles

An `anthropic` or `chatgpt` profile SHALL be able to configure the Jev browser tools (`browser_subgoal`, `extract_page`) through a dedicated, opt-in Settings section that is separate from the profile's primary provider configuration. The section SHALL appear only for `anthropic` and `chatgpt` profiles and SHALL NOT appear for a `typesafe` profile (which configures Jev as its primary provider through its existing block). The section SHALL be additive and off by default: a profile with none of these fields entered SHALL behave exactly as before, and both tools SHALL remain absent.

The section SHALL collect, in inputs distinct from the profile's primary base URL and primary API key, exactly two groups: a text model (base URL, model id, text-model API key), which enables `extract_page`; and a Jev transport (source, endpoint hint, transport API key). The text model group ALSO serves, unchanged, as the fixed-`openai`-source decision model that `browser_subgoal` requires — there is no separate decision-model base URL/model id input, because the host's `openai` decision source reuses the same text-model base URL and model id as its decision model. Saving the text model and the transport together (with the decision source implicitly fixed to `openai`) is what additionally enables `browser_subgoal`. The UI SHALL indicate which group enables which tool. Entering these fields SHALL NOT modify the profile's primary Anthropic/ChatGPT configuration, and the standalone `typesafe` configuration path SHALL be unchanged.

Configuration SHALL be persisted through the existing config and credential envelopes, and API keys SHALL be stored in the secret store and never rendered back to the page, consistent with the existing key inputs. The host gate SHALL remain the sole authority on whether a tool is available: partial configuration SHALL leave the corresponding tool absent, and the UI SHALL NOT claim a tool is active.

#### Scenario: The section appears for an LLM profile

- **WHEN** the user views Settings for an `anthropic` or `chatgpt` profile
- **THEN** a distinct "Jev browser tools" section is shown with its own text-model and transport inputs, and copy stating that the text model also serves as the decision model for `browser_subgoal`

#### Scenario: The section is absent for a typesafe profile

- **WHEN** the user views Settings for a `typesafe` profile
- **THEN** the LLM-profile Jev-tools section is not shown, and the profile's existing Jev configuration block is unchanged

#### Scenario: Configuring the text model enables extract_page only

- **WHEN** the user fills the text-model fields (base URL, model id, key) on an `anthropic`/`chatgpt` profile and saves
- **THEN** the values persist through the existing envelopes, the key is stored in the secret store and not shown back, and the host makes `extract_page` available while `browser_subgoal` stays absent until the transport is also configured (the same text model already entered doubles as the fixed-`openai` decision model)

#### Scenario: Primary provider configuration is untouched

- **WHEN** the user enters or clears the Jev-tools fields
- **THEN** the profile's primary Anthropic/ChatGPT base URL and API key are unchanged

#### Scenario: Secrets are never rendered

- **WHEN** a saved Jev-tools key exists
- **THEN** the UI shows only a saved/clear affordance and never renders the key value
