## ADDED Requirements

### Requirement: Search reaches a general-purpose engine in one call, from a closed list

The registry SHALL expose a `search` operation that takes a query, an engine name, and a target tab, and leaves that tab on the engine's results page for the query in a single call.

The set of engines SHALL be closed and fixed in code. An engine name outside that set SHALL return an error naming the accepted values, and SHALL NOT navigate the tab anywhere. The query SHALL be URL-encoded before substitution, so a query containing spaces, `&`, `#`, `?`, or non-ASCII characters reaches the engine intact.

`search` SHALL produce a URL only by substituting the query into a fixed per-engine template. It SHALL NOT accept a URL, a URL fragment, a path, or any query parameter other than the search terms, so it cannot become a route for constructing arbitrary URLs.

Navigation, tab-scope enforcement, and restricted-page handling SHALL be the same behavior `navigate` already provides; `search` SHALL NOT introduce a second navigation path with its own rules.

#### Scenario: Search on an accepted engine

- **WHEN** an authorized task calls `search` with a query and an engine in the accepted set, against a tab in its scope
- **THEN** the tab ends on that engine's results page for that query, and the result reports which engine was searched and for what

#### Scenario: Query containing characters that are significant in a URL

- **WHEN** the query contains spaces, `&`, `#`, `?`, `+`, or non-ASCII characters
- **THEN** the engine receives the query verbatim as search terms, and none of those characters is interpreted as URL structure

#### Scenario: Engine outside the accepted set

- **WHEN** `search` is called with an engine name that is not in the accepted set
- **THEN** an error naming the accepted values is returned, and the tab is not navigated

#### Scenario: Attempt to reach an arbitrary destination through search

- **WHEN** a caller supplies a query whose text is itself a URL, or attempts to pass path or query-parameter content through `search`
- **THEN** that text is treated as search terms and encoded as such, and the tab reaches the engine's results page rather than the destination named in the text

#### Scenario: Target tab is outside the caller's scope

- **WHEN** `search` names a tab the caller is not authorized for
- **THEN** it is refused on the same terms `navigate` is refused for that tab, with no navigation performed

### Requirement: Search does not relax the prohibition on assembling URLs for site controls

The browser-automation guidance SHALL continue to forbid assembling a URL to stand in for a control the user asked to be operated, and SHALL state that `search` is confined to general-purpose search engines. Operating a site's own search box, filters, or forms SHALL remain the required route for that site.

#### Scenario: A site's own filter or search control

- **WHEN** the task is to search or filter within a particular site, and that site offers a control for it
- **THEN** the assistant operates that control rather than constructing a URL for it, and `search` is not used as a substitute

#### Scenario: The interface route stalls

- **WHEN** a site's control cannot be found or will not open
- **THEN** the assistant reports what it observed rather than falling back to a constructed URL for that site
