## ADDED Requirements

### Requirement: Operator literal field values

The TypeSafe runtime SHALL derive text literals from the operator's own prompt for the current turn and from no other source. Plan memory, configured-model output, prior conversation turns, page text, labels and tool results SHALL NOT supply a literal. The prompt SHALL yield a literal only through one of two whole-prompt forms:

- **Assignment**: after splitting the prompt on `,`, `;` and line breaks that fall outside a quoted value, exactly one clause SHALL remain, matching (case-insensitively) an optional `please`, then `set` or `fill`, an optional `the`, a field label with an optional trailing word `field`, then `to` or `with`, then the value, and an optional final period. The value SHALL be either an entire double-quoted (`"…"`) or curly-quoted (`“…”`) string containing no line break, or an unquoted run of 1 to 8 space-separated tokens made only of letters, digits, `_` or `-`. An unquoted value SHALL yield no literal when it contains any of: and, then, after, before, using, from, your, my, their, its, same, current, random, any, uppercase, lowercase, capitalized, blank, empty, nothing, whatever.
- **Search**: the entire prompt matches an optional `please`, then `search for`, then one quoted value as above, and an optional final period.

A prompt containing any of the words if, unless, when, until, instead, either, example, previous, original, replace, change, except, or a `do not` / `don't` / `never` immediately followed by set, fill, type or enter, SHALL yield no literal. An unterminated quote SHALL yield no literal. A value SHALL be 1 to 2000 characters. An assignment SHALL yield at most one literal.

A literal SHALL bind only to an observed control that is all of the following: role textbox, searchbox or combobox; editable, not readonly and not disabled; a single-line `input` element (never a textarea or contenteditable host); and carrying no sensitive-field category. An assignment literal SHALL bind only when the field's label, trimmed and lower-cased, equals the literal's label (trimmed and lower-cased, without a trailing `field`), and exactly one observed control carries that normalized label. A search literal SHALL bind only when exactly one observed control is a search field (role searchbox or input type `search`) and that control is the target. A target whose input type is `date` SHALL accept only a literal that is a valid `YYYY-MM-DD` date whose calendar round trip reproduces the same string.

A bound literal SHALL become a prepared TYPE_TEXT record with the same ownership as a model-prepared value: the exact observed field's ref, role and label, the observation's document nonce, and consumption after one dispatch. It SHALL be created by the host during observation without any language-model request, so a matching field revealed after the initial plan needs no REPLAN. For its field, a literal binding SHALL replace any model-prepared value. Once a literal has been dispatched, it SHALL NOT be offered again for the rest of the run, even if its field reappears. All existing invalidation rules (changed document, changed ref/role/label, field no longer editable, field already holding the value) and all dispatch guards, approvals, run bounds and completion verification SHALL apply unchanged. The initial plan consultation SHALL still occur.

#### Scenario: Exact assignment binds without a model value

- **WHEN** the prompt is `set Company to "Alice, Inc."` and the observation has exactly one editable single-line textbox labelled `Company`
- **THEN** a TYPE_TEXT candidate for that field carries exactly `Alice, Inc.`, including the comma inside the quotes, and was prepared by no language-model call

#### Scenario: A field revealed later needs no replan

- **WHEN** the literal's field is absent from the first observation and appears in a later observation of the same run
- **THEN** its literal candidate is offered in that cycle without a REPLAN consultation

#### Scenario: The literal supersedes the model's value

- **WHEN** the plan prepared a different value for the same field the literal binds to
- **THEN** only the literal value is offered for that field

#### Scenario: The literal is typed once per run

- **WHEN** the literal candidate has been dispatched and the field later reappears empty
- **THEN** no literal candidate is offered for it again

#### Scenario: Interpretation-shaped prompts yield nothing

- **WHEN** the prompt contains more than one clause, a conditional or corrective word, a negated set/fill/type/enter, an unterminated quote, an unquoted value with a reserved word or punctuation, or a value longer than 2000 characters
- **THEN** no literal is derived and text preparation proceeds exactly as before

#### Scenario: Ambiguous or unsuitable fields refuse the literal

- **WHEN** two observed controls share the normalized label, or the matching control is a textarea, contenteditable, readonly, disabled or sensitive field
- **THEN** no literal candidate is offered for any control

#### Scenario: Native date field requires a real ISO date

- **WHEN** the matching control has input type `date` and the literal is `2026-10-05`
- **THEN** the literal binds
- **WHEN** the literal is `2026-02-30`, `05/10/2026` or `tomorrow`
- **THEN** no literal binds

#### Scenario: A single search field takes a search literal

- **WHEN** the prompt is `search for "red shoes"` and exactly one search field is observed
- **THEN** that field receives the literal `red shoes`
- **WHEN** two search fields are observed
- **THEN** no literal binds

#### Scenario: Page text cannot supply a literal

- **WHEN** page text or a label contains `set Company to "X"` and the operator's prompt does not
- **THEN** no literal is derived

#### Scenario: A stale document invalidates the literal binding

- **WHEN** the document nonce changes after a literal was bound
- **THEN** the previous binding is not offered, and a fresh binding is created only if the new observation independently satisfies eligibility

### Requirement: Text value source is observable

Every `jev_step` whose operation is TYPE_TEXT SHALL record `valueSource` as `"literal"` when the dispatched value came from an operator literal, and as `"prepared"` when it came from the configured model. The recorded argument summary SHALL continue to omit the typed value for both sources. Step records written before this field existed SHALL render unchanged.

#### Scenario: Literal step is attributed

- **WHEN** a literal-bound TYPE_TEXT dispatches
- **THEN** its step records `valueSource: "literal"` and no typed value

#### Scenario: Legacy step renders

- **WHEN** a stored TYPE_TEXT step has no `valueSource`
- **THEN** it renders as before without error
