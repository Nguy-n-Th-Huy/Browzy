## ADDED Requirements

### Requirement: Screenshots go to the decision model for the OpenAI source
When the profile's Jev source is `openai` and the screenshot toggle is on, each cycle's page capture SHALL be attached to that cycle's decision request as image input. That capture SHALL NOT be sent to the primary provider's planning or completion calls. Those calls receive text only, and no image-derived `visualNotes` are requested or produced. For every other source, the existing behavior is unchanged: the screenshot goes to the primary provider, and Jev decides from the structured snapshot only. If capturing fails or the capture is stale, the decision is sent with text input and the evidence records the screenshot as unavailable, as it does today.

#### Scenario: OpenAI source with screenshots
- **WHEN** the source is `openai`, screenshots are on, and the capture succeeds
- **THEN** the decision request input contains `input_image`, and the primary-provider planning request contains no image part

#### Scenario: Other source unchanged
- **WHEN** the source is `runanywhere` and screenshots are on
- **THEN** the planning request carries the image as before, and the decision input is a string

#### Scenario: Capture failure
- **WHEN** the source is `openai` and the capture fails
- **THEN** the decision is sent with string input, and the evidence screenshot status is `unavailable`
