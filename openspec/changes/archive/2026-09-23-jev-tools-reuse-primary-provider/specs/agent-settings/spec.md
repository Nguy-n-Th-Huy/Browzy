## MODIFIED Requirements

### Requirement: Jev browser-tools configuration on LLM profiles

An `anthropic` or `chatgpt` profile SHALL be able to configure the Jev browser tools (`browser_subgoal`, `extract_page`) through a dedicated, opt-in Settings section that is separate from the profile's primary provider configuration. The section SHALL appear only for `anthropic` and `chatgpt` profiles and SHALL NOT appear for a `typesafe` profile (which configures Jev as its primary provider through its existing block). The section SHALL be additive and off by default: a profile with no Jev transport key saved SHALL behave exactly as before, and both tools SHALL remain absent.

The section SHALL NOT collect a separate text model (no text-model base URL, model id or text-model API key inputs). The tools' text/decision model is the profile's primary provider and its current model: the Anthropic-compatible endpoint and key, or the signed-in ChatGPT account. The section's copy SHALL state this. The section SHALL collect only the Jev transport, meaning the source (TypeSafe, Vercel AI Gateway, OpenRouter), an endpoint hint and the transport API key, plus the Jev-tools screenshot toggle. Saving a transport key SHALL enable both tools together. Saving the section SHALL succeed with only these fields and SHALL NOT require any text-model field. Entering these fields SHALL NOT modify the profile's primary Anthropic/ChatGPT configuration, and the standalone `typesafe` configuration path, including its own text-model fields, SHALL be unchanged. Text-model values previously stored on an `anthropic`/`chatgpt` profile SHALL be left in storage untouched and SHALL NOT be read for these profile types.

Configuration SHALL be persisted through the existing config and credential envelopes, and API keys SHALL be stored in the secret store and never rendered back to the page, consistent with the existing key inputs. The host gate SHALL remain the sole authority on whether a tool is available, and the UI SHALL NOT claim a tool is active.

#### Scenario: The section appears for an LLM profile

- **WHEN** the user views Settings for an `anthropic` or `chatgpt` profile
- **THEN** a distinct "Jev browser tools" section is shown with transport inputs and the screenshot toggle, no text-model inputs, and copy stating that the tools use the primary provider and its current model

#### Scenario: The section is absent for a typesafe profile

- **WHEN** the user views Settings for a `typesafe` profile
- **THEN** the LLM-profile Jev-tools section is not shown, and the profile's existing Jev configuration block, including its text-model fields, is unchanged

#### Scenario: Saving the transport enables both tools

- **WHEN** the user selects a transport source, enters its API key on an `anthropic`/`chatgpt` profile and saves
- **THEN** the save succeeds without any text-model field, the key is stored in the secret store and not shown back, and the host makes both `extract_page` and `browser_subgoal` available

#### Scenario: Configuring the text model enables extract_page only

- **WHEN** the user looks for a way to configure a separate text model for the Jev tools on an `anthropic`/`chatgpt` profile
- **THEN** no text-model inputs exist, and `extract_page` is never enabled on its own: it is enabled together with `browser_subgoal` by the saved transport key, using the primary provider's model

#### Scenario: Primary provider configuration is untouched

- **WHEN** the user enters or clears the Jev-tools fields
- **THEN** the profile's primary Anthropic/ChatGPT base URL, API key, sign-in and models are unchanged

#### Scenario: Secrets are never rendered

- **WHEN** a saved Jev transport key exists
- **THEN** the UI shows only a saved/clear affordance and never renders the key value

### Requirement: Jev-tools connection test on LLM profiles

An `anthropic` or `chatgpt` profile SHALL be able to test its Jev browser-tools configuration and receive a clear success or failure result, distinct from the primary provider's connection test. The test SHALL validate the text model as the profile's primary provider at its default model. For `anthropic`, that is the profile's endpoint and key. For `chatgpt`, it is the loopback gateway with a test-scoped gateway token that is revoked when the test ends, whatever the outcome. When the transport key is saved, the test SHALL also validate the Jev transport. It SHALL reuse the existing Jev capability-test path rather than a second implementation. The result SHALL indicate which tool(s) the current configuration enables: both, only when both stages pass, and neither otherwise. The test SHALL never expose or log a secret, and its failure message SHALL be a bounded, host-authored classification. When no transport key is saved, the result SHALL report "not configured" rather than a false success.

#### Scenario: A valid Jev config tests successfully

- **WHEN** the primary provider works and a working Jev transport key is saved, and the user runs the Jev-tools connection test
- **THEN** the test reports success and indicates both `extract_page` and `browser_subgoal` are enabled, without showing any secret

#### Scenario: An invalid Jev key or model fails clearly

- **WHEN** the Jev transport key is wrong, or the primary provider's model/credential is rejected
- **THEN** the test reports a bounded, host-authored failure for the failing stage with no secret, and does not claim the tools are available

#### Scenario: Text-model-only config enables extract_page only

- **WHEN** an `anthropic`/`chatgpt` profile still has legacy text-model fields stored but no Jev transport key
- **THEN** the test reports "not configured" with neither tool enabled; the legacy text-model values are ignored

#### Scenario: No transport key reports not configured

- **WHEN** no Jev transport key is saved
- **THEN** the test reports "not configured" with neither tool enabled, and makes no provider request

#### Scenario: The test is separate from the primary provider test

- **WHEN** the user runs the Jev-tools connection test on a `chatgpt`/`anthropic` profile
- **THEN** it reports under the Jev-tools section only, and the primary connection test result is unchanged

### Requirement: Jev browser-tools screenshot capture defaults off with an opt-in toggle

A `browser_subgoal` sub-run started from an `anthropic`/`chatgpt` profile SHALL NOT capture a screenshot for its planning/content model by default. This SHALL be controlled by a dedicated Jev-tools screenshot toggle that is off by default and is independent of the profile's primary/`typesafe` screenshot setting. The "Jev browser tools" settings section SHALL expose this toggle (unchecked by default), persisted through the existing configuration envelope. Enabling it SHALL re-enable screenshot capture for the sub-run's planning consultation of the primary provider's model. Disabling it or leaving it unset SHALL keep the sub-run text-only. Jev's action selection SHALL be unchanged in either state (it never receives the screenshot), and the read-only `extract_page` tool SHALL be unaffected. The standalone `typesafe` profile's own screenshot toggle SHALL be unchanged.

#### Scenario: A new profile runs subgoals without screenshots

- **WHEN** an `anthropic`/`chatgpt` profile has the Jev browser tools enabled and the Jev-tools screenshot toggle unset
- **THEN** a `browser_subgoal` sub-run captures no screenshot, and Jev still selects actions from the structured page state

#### Scenario: The toggle re-enables screenshots

- **WHEN** the user checks the Jev-tools "Gửi ảnh chụp màn hình" toggle and saves
- **THEN** the value persists through the existing envelope and a subsequent `browser_subgoal` sub-run captures a screenshot for its planning consultation

#### Scenario: The toggle is separate from the primary/typesafe setting

- **WHEN** the Jev-tools screenshot toggle is changed on an `anthropic`/`chatgpt` profile
- **THEN** the profile's primary configuration and the standalone `typesafe` screenshot setting are unchanged

#### Scenario: extract_page is unaffected

- **WHEN** the Jev-tools screenshot toggle is off
- **THEN** `extract_page` still functions (it captures no screenshot regardless of this toggle)
