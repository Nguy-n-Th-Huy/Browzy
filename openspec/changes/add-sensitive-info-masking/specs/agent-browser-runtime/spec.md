## ADDED Requirements

### Requirement: Sensitive-information masking on the page DOM

The registry SHALL expose an operation that masks sensitive information on the current page so it does not reach screenshots or page reads. It SHALL take a tab target and an action (`mask` | `unmask`) and SHALL accept optional caller-provided CSS selectors in addition to its built-in detection.

Built-in detection SHALL cover, at minimum: password fields (`type="password"`, `autocomplete` current-password/new-password), payment fields (cc-number, cc-csc, cc-exp*), one-time-code fields, and fields whose name/id/placeholder/aria-label/label matches a curated token list of credential, payment, identity, bank, and one-time-code terms. Token matching SHALL be precise enough that broad words ("state", "code", "auth", "token" alone) never trigger on ordinary page attributes.

Masking SHALL be presentational and text-level only: it MUST NOT write any input's value property, dispatch events, or alter form semantics, and layout SHALL be preserved. It SHALL be reversible via `unmask` and SHALL apply to the current document only.

#### Scenario: A login or checkout page is masked before a screenshot

- **WHEN** the agent masks a page holding a filled password field and a card-number field, then takes a screenshot
- **THEN** the screenshot shows masked fields rather than the values, and no field's value property was modified

#### Scenario: Fields the heuristics miss

- **WHEN** sensitive content is shown outside a recognizable form field and the agent passes its selector
- **THEN** the matched element's text is masked as well

#### Scenario: Unmasking restores the page

- **WHEN** the agent unmasks
- **THEN** replaced text is restored exactly and all mask attributes and styles are removed

#### Scenario: Ordinary attributes do not trigger masking

- **WHEN** a page uses id or name values containing broad words like "state" or "code" but nothing sensitive
- **THEN** those fields are not masked

### Requirement: Masked content stays masked through the read and capture paths

`read_page` SHALL render a masked form control's value as a mask placeholder rather than its live value. `get_page_text` SHALL NOT carry masked text, including a masked textarea's value. Screenshots SHALL show masked content for every element the operation masked.

#### Scenario: A read taken while masked

- **WHEN** read_page or get_page_text runs on a masked page
- **THEN** the result carries placeholders where the masked values were

### Requirement: Masking is not a capability grant

The operation SHALL take no script source and SHALL NOT be classified send/submit-class. It SHALL be classified read-only for the borrowed-tab gate: it changes no value, dispatches no events, and is reversible — the protective counterpart of a read, and precisely the class of call that must remain available on the page the run was handed.

#### Scenario: Masking a borrowed tab

- **WHEN** a run masks the bound (borrowed) page before reading it
- **THEN** the call is not rejected for borrowed-tab scope, and the registry classification coverage records it in the read-only set

#### Scenario: No script route

- **WHEN** a caller supplies arbitrary JavaScript instead of selectors
- **THEN** it is ignored — the operation's only script-like input is a list of CSS selectors, applied via querySelectorAll
