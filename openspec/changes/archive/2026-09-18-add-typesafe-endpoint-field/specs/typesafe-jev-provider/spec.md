## MODIFIED Requirements

### Requirement: Provider type and configuration surface

A provider profile SHALL support a third provider type, `typesafe`, alongside `anthropic` and `chatgpt`. Selecting it in Settings SHALL expose the TypeSafe credential (for the selected Jev source), the text-model configuration (base URL, model ID, credential), the profile's editable model list with exactly one default model, a screenshot toggle that is enabled by default, and an editable endpoint field for the provider's own requests — prefilled with the profile's current endpoint and labeled with the selected Jev source; it SHALL NOT expose Base URL or API-key fields for an Anthropic endpoint. Switching a profile's provider type SHALL remain nondestructive to the other fields, and SHALL reject any value that is not a known provider type.

When a `typesafe` profile's model list is empty at the moment the provider type is selected, settings SHALL seed it with the provider's documented `jev-latest` entry; an existing or user-edited list SHALL never be overwritten. The text-model base URL and text-model ID SHALL be required, nonempty settings before a run or a capability test is attempted, and SHALL be validated as a well-formed HTTPS URL (loopback HTTP permitted under the existing URL rules). The screenshot toggle SHALL persist with the profile as a non-secret setting, and a profile stored before the toggle existed SHALL load with it enabled. The endpoint SHALL be validated under the same URL rules, persisted with the profile, and used by every request the provider makes; a change of Jev source SHALL move it to the new source's documented default (`https://api.typesafe.ai` for TypeSafe API, `https://ai-gateway.vercel.sh` for Vercel AI Gateway) only while it is still a known default, and SHALL leave any other endpoint untouched — reachable for editing under its own label rather than hidden.

#### Scenario: Switching to the TypeSafe provider

- **WHEN** the user selects the `typesafe` provider type in Settings
- **THEN** the Anthropic Base URL and API-key fields are hidden, the TypeSafe credential, text-model fields, the enabled screenshot toggle, and the endpoint field carrying the profile's current endpoint are shown, and an empty model list is seeded with `jev-latest` exactly once

#### Scenario: Existing profiles are unaffected

- **WHEN** a profile of type `anthropic` or `chatgpt` is loaded or used after this change
- **THEN** its provider type, fields, credentials, capability results, and run behavior are unchanged

#### Scenario: Invalid provider type value

- **WHEN** a caller attempts to persist a provider type that is not `anthropic`, `chatgpt`, or `typesafe`
- **THEN** the change is rejected and no profile is written

#### Scenario: The screenshot toggle defaults on for existing profiles

- **WHEN** a `typesafe` profile stored before the toggle existed is loaded
- **THEN** the toggle shows enabled and its runs capture the bound tab as if it had been set

#### Scenario: The endpoint is editable

- **WHEN** the operator edits the endpoint field on a `typesafe` profile — including an endpoint carried over as a custom URL from another provider type — to a valid URL and saves
- **THEN** the profile persists it, subsequent capability tests and runs issue their provider requests against exactly that endpoint, and a source change no longer strands it
