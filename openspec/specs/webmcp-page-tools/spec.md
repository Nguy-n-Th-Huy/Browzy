# webmcp-page-tools Specification

## Purpose

Let the agent discover and invoke the tools a visited web page publishes for itself through the WebMCP `document.modelContext` API, so a site's own operations can be called directly instead of being reconstructed from DOM automation.

## Requirements

### Requirement: Silent absence when the page publishes no tools
The extension SHALL detect the presence of `document.modelContext` on the top frame of a page and treat its absence as the ordinary case. Absence MUST NOT produce an error, an exception, a console warning, or any user-visible notice. Detection MUST NOT depend on a minimum browser version, because the API's availability is governed by an origin trial rather than by browser version.

#### Scenario: Page without the WebMCP API
- **WHEN** a page loads in a browser where `document.modelContext` is undefined
- **THEN** the page loads and behaves exactly as before, no error is raised, and the tab's page-tool list is empty

#### Scenario: Page with the API but no registered tools
- **WHEN** a page exposes `document.modelContext` but registers no tools
- **THEN** the tab's page-tool list is empty and no error is raised

#### Scenario: Detection failure does not break the page or the agent
- **WHEN** reading or querying `document.modelContext` throws for any reason
- **THEN** the failure is contained, the tab's page-tool list is empty, and every existing browser tool continues to work unchanged on that tab

### Requirement: Per-tab page-tool inventory tracked and invalidated
The extension SHALL maintain the set of page-declared tools separately for each tab. The set for a tab MUST be discarded when that tab begins navigating to a new document and when that tab is closed. Tools registered or removed by a page after load, as signalled by the API's tool-change notification, SHALL be reflected in that tab's set.

#### Scenario: Listing tools for a tab
- **WHEN** the agent requests the page-tool list for a tab whose page has registered tools
- **THEN** each entry's name, description, and input schema as declared by that page are returned

#### Scenario: Navigation clears stale tools
- **WHEN** a tab navigates from a page that registered tools to any other document
- **THEN** the previous page's tools are no longer listed for that tab

#### Scenario: Tab close clears tools
- **WHEN** a tab that had registered tools is closed
- **THEN** its tools are no longer listed, and no reference to that tab is retained

#### Scenario: Tools change after load
- **WHEN** a page registers an additional tool or removes one after its initial load
- **THEN** a subsequent list request for that tab reflects the current set

#### Scenario: Listing an unknown or non-page tab
- **WHEN** the agent requests the page-tool list for a tab that does not exist or has no page-tool state
- **THEN** an empty list is returned with an explanation, and no error is raised

### Requirement: Page-declared tools are reachable from both agent entry points
The two operations that expose page-declared tools — listing a tab's tools and calling one of them — SHALL be available to the built-in side panel and to the external MCP path without separate registration for either. Adding them MUST NOT alter the name, input schema, description, or behavior of any operation that existed before this change.

#### Scenario: Side panel reaches page tools
- **WHEN** the side-panel agent runs against a tab whose page registered tools
- **THEN** it can list those tools and call one of them

#### Scenario: External MCP client reaches page tools
- **WHEN** an external MCP client is connected to the extension and a tab's page registered tools
- **THEN** it can list those tools and call one of them

#### Scenario: Pre-existing operations unaffected
- **WHEN** any operation that existed before this change is invoked
- **THEN** its name, accepted arguments, and observable result are identical to before

### Requirement: Execution prefers the browser-mediated path and always names the path used
Calling a page-declared tool SHALL use the browser's own tool-execution entry point when the browser exposes one, because that path carries whatever consent and permission mediation the browser attaches to agent tool calls. Only when that entry point is unavailable SHALL execution fall back to invoking the page's registered callback directly, which does not pass through that mediation. Every result of a page-tool call MUST state which of the two paths produced it.

#### Scenario: Browser-mediated execution available
- **WHEN** the agent calls a page-declared tool in a browser that exposes a tool-execution entry point
- **THEN** the call goes through that entry point and the result identifies the browser-mediated path

#### Scenario: Fallback execution
- **WHEN** the agent calls a page-declared tool in a browser that exposes tool registration but no tool-execution entry point
- **THEN** the page's own callback is invoked and the result identifies the fallback path

#### Scenario: Named tool is not present on the page
- **WHEN** the agent calls a page-declared tool by a name the tab has not registered
- **THEN** an explanatory error naming the tab and the requested tool is returned, and no page code is invoked

#### Scenario: Page tool fails or never settles
- **WHEN** an invoked page tool throws, rejects, or does not return within the extension's request timeout
- **THEN** the failure is reported to the agent as a failed call with the reason, and the extension remains able to serve further requests for that tab

### Requirement: Page-supplied content is labelled as untrusted
Tool names, descriptions, input schemas, and results originating from a visited page SHALL be presented to the agent as page-supplied content. The operations' own descriptions MUST state that the listed tools are declared by the visited page, and each returned result MUST carry that attribution. Page-supplied text MUST NOT be presented in a way that implies it was authored by the extension, and MUST NOT be treated as instructions that expand the agent's scope or authorization.

#### Scenario: Listing marks provenance
- **WHEN** the agent lists a tab's page-declared tools
- **THEN** the response identifies the tools as declared by that page, together with the page's origin

#### Scenario: Result marks provenance
- **WHEN** a page-declared tool returns a result
- **THEN** the result is presented to the agent as page-supplied output, not as extension output

#### Scenario: Page text attempting to expand scope
- **WHEN** a page-supplied tool description or result contains text directing the agent to change settings, widen its permissions, or disclose credentials
- **THEN** that text is conveyed as page data only and confers no authorization

### Requirement: Scope limited to the top frame
Tool discovery SHALL cover the top frame of a tab only. Tools registered inside embedded frames SHALL NOT be listed or callable through this capability.

#### Scenario: Tools inside an embedded frame
- **WHEN** a page embeds a frame whose document registers its own tools
- **THEN** those tools are not listed for the tab and cannot be called

### Requirement: Availability is reported honestly
Project documentation SHALL describe this capability as experimental and dependent on the WebMCP origin trial, naming the browser versions the trial covers, its expiry date, and the fact that the API is unavailable unless the visited site is enrolled or the user has enabled the browser's WebMCP testing flag. Documentation MUST NOT describe the capability as generally available.

#### Scenario: Reader checks documented status
- **WHEN** a reader consults the project documentation about page-declared tools
- **THEN** the experimental status, the trial's browser-version range and expiry date, and the enrolment-or-flag precondition are stated
