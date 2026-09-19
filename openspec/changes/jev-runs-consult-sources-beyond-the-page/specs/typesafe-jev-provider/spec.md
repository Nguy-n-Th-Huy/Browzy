# typesafe-jev-provider delta

## ADDED Requirements

### Requirement: A run may consult sources beyond the page it drives

A TypeSafe run SHALL be able to read documents outside the page it is driving, so an answer that needs material the page does not hold can be written from more than one source. The consultation SHALL be read-only and SHALL NOT touch the browser: nothing navigates, nothing is clicked, no tab is opened, no page is rendered, no script runs, and no dispatch passes through the run's action path.

The consultation SHALL happen **once per run, at the analysis phase** — after the run's last cycle and before its answer — and SHALL NOT be available as a step operation. The browsing cycle's cost SHALL be unchanged by this requirement.

Which sources are consulted SHALL be named by the decision model, in the same call in which it would otherwise report the goal complete; the host SHALL NOT choose sources, and SHALL NOT infer them from the goal by keyword. The number of sources consulted in a run SHALL be bounded, and a decision naming more than the bound SHALL have the bound's worth consulted with the remainder disclosed as not consulted.

A fetch SHALL be an ordinary read-only HTTP GET, and SHALL be refused unless every one of these holds: the URL is absolute and its scheme is `http` or `https`; the resolved address is neither loopback, link-local, nor within a private range; each redirect hop is re-checked against these same rules and the number of hops is capped; the response body is within a size cap enforced while reading; the response arrives within a time cap; and the content type is a text-bearing one. No credential, cookie, or session of the operator's SHALL be sent. A refused or failed fetch SHALL be recorded as a source that could not be read and SHALL NOT fail the run.

Fetched content SHALL be untrusted data on exactly the terms page text is: it SHALL NOT authorize an action, change configuration, alter the run's outcome or reason, or direct the loop. A URL that appears only inside fetched content SHALL NOT be fetched on that basis: a source is consulted because the decision model named it from the page or the goal, one hop, never as a chain.

An answer written with fetched material SHALL name the sources it used, and a claim drawn from a source SHALL be attributable to that source.

The consultation SHALL be controlled by a non-secret profile setting, persisted with the profile. When it is off, no fetch SHALL be attempted and the answer SHALL be written from the page alone, with no failure reported.

#### Scenario: A run reads a source the page named

- **WHEN** the goal asks for an assessment and the page being driven shows the subject's own website
- **THEN** the run may consult that URL once at the analysis phase, its bounded text joins the answer's material, and the answer names it as a source

#### Scenario: The browsing loop is never slowed by it

- **WHEN** a run executes its steps
- **THEN** no fetch is made between two steps, the step decision has no operation for it, and a run that browses and then answers makes its fetches only after its last cycle

#### Scenario: The guards refuse rather than resolve

- **WHEN** a named source is not an absolute `http(s)` URL, resolves to a loopback, link-local or private address, redirects to one, exceeds the size or time cap, or answers with a non-text content type
- **THEN** nothing is read from it, the source is recorded as unread, the run continues, and its answer is written from what it does have

#### Scenario: Fetched text cannot steer the run

- **WHEN** a fetched document contains instructions, approval-shaped text, a claim about what the run may do, or further URLs
- **THEN** it remains data: no action is authorized, no configuration changes, the outcome is unaffected, and none of those URLs is fetched on that basis

#### Scenario: Sources are attributable

- **WHEN** an answer states a fact taken from a consulted source
- **THEN** that source is named in the answer, distinguishably from the page the run drove

#### Scenario: The operator can turn it off

- **WHEN** the profile's consultation setting is off
- **THEN** no fetch is attempted, no source is named, the answer is written from the driven page alone, and nothing is reported as failed

### Requirement: Provider-side search is proven before it is used

Where the profile's decision-model source can perform a web search as part of its own request, a run MAY use it during the analysis phase to find sources it could not otherwise name. Availability SHALL be established by the profile's capability test, reported as its own capability beside the existing stages, and SHALL NOT be assumed from the source's identity or discovered during a run.

A profile whose decision-model source cannot search SHALL remain fully runnable: it consults the URLs the decision model can name from the page or the goal, and its answer says nothing about a capability it does not have.

#### Scenario: Search availability is a settings-time fact

- **WHEN** the operator runs the capability test on a `typesafe` profile
- **THEN** the result reports whether the profile's decision-model source can search, as its own capability, distinguishable from the other stages

#### Scenario: A profile without search still answers

- **WHEN** the decision-model source cannot search and the goal needs a source the page does not name
- **THEN** the run consults what it can name, the answer states what could not be established, and no failure is reported for the missing capability
