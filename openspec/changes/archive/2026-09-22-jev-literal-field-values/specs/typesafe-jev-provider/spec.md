## ADDED Requirements

### Requirement: Sensitive-field category on observed controls

Each `page_snapshot` control row SHALL carry a `sensitive` field holding the category that the extension's existing sensitive-field classifier assigns to that control (for example `password`, `payment` or `otp`), or `null` when the classifier assigns none. The classifier SHALL be the same one that sensitive-info masking uses, never a second copy. The field SHALL be additive: existing row fields and their meanings SHALL NOT change, and consumers that ignore it SHALL behave as before. Host-side literal eligibility SHALL read the category from the observed control row directly; the category SHALL NOT be sent to Jev in decision rows.

#### Scenario: A password input is classified

- **WHEN** an observed input has type `password` or autocomplete `current-password`
- **THEN** its snapshot row carries `sensitive: "password"`

#### Scenario: An ordinary field is unclassified

- **WHEN** an observed text input has no sensitive descriptor
- **THEN** its snapshot row carries `sensitive: null`
