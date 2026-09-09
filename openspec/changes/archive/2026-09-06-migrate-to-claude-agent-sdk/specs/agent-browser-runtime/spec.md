## Purpose

Provide a standalone SDK browser assistant that preserves the existing browser executor without requiring user MCP configuration or a Claude Code chat client.

## ADDED Requirements

### Requirement: Automatically configured Agent SDK browser tools
The assistant SHALL run through the official Claude Agent SDK in a local companion and automatically configure its application-owned browser tools using internal MCP. Users MUST NOT need to register an MCP server, edit MCP configuration, or start a terminal client. It MUST NOT silently substitute the Anthropic API SDK or depend on proprietary official Chrome integration.

#### Scenario: Standalone browser task
- **WHEN** a configured user submits a request in the panel on a machine with no user MCP registration
- **THEN** the companion streams a response and executes browser actions through its preconfigured SDK tools and this project's extension

#### Scenario: Browser startup after one-time setup
- **WHEN** the user opens a supported browser after installing the extension/companion and saving provider settings once
- **THEN** the companion and internal tools initialize automatically without terminal commands, repeated ID entry, or paid model requests merely for startup

#### Scenario: Startup or SDK integration failure
- **WHEN** initialization fails or exceeds 60 seconds, or tool/image acceptance tests fail
- **THEN** the application shows a specific error with retry guidance; rollout remains blocked until acceptance passes and legacy operation remains available

### Requirement: Preserve the browser capability baseline
The assistant SHALL preserve all 26 operations currently declared in the tool registry, sandboxed execute-code behavior, and narrated recording access. Legacy operation names containing `mcp` SHALL remain internal compatibility aliases only. Preservation SHALL be measured by outputs and browser side effects, not an unverified claim of official Claude in Chrome parity.

#### Scenario: Representative browser workflow
- **WHEN** an authorized task creates a tab, navigates, reads the page, fills a form, clicks, captures a screenshot, and closes its tab
- **THEN** each operation returns its result, the screenshot is available as an image to the model, and no unrelated tab is modified

#### Scenario: Extended operations
- **WHEN** regression fixtures exercise console/network inspection, page JavaScript, GIF export, resize, shortcuts, focus, uploads, configuration, diagnostics, browser switching, recording retranscription, and sandboxed multi-action execution
- **THEN** results and browser side effects match the existing executor contracts, including existing errors and data limits

### Requirement: Confined tool execution and browser scope
The assistant MUST limit computer operations to the authorized browser bridge and session-owned tabs, the current tab bound at user submission, or explicitly selected tabs. Arbitrary shell commands, filesystem access outside session artifacts (except approved enabled skill resources and capability-scoped files explicitly selected by the user for upload), unknown tool names, invalid arguments, and unauthorized browser scopes SHALL be rejected before execution. Page content SHALL be treated as task data, never authorization to change settings, expand scope, or disclose credentials.

#### Scenario: Command injection or unauthorized file access
- **WHEN** a model request includes an extra shell command, an unrecognized executable, a path traversal, or a file outside the approved artifact, skill-resource, and user-selected upload allowlists
- **THEN** the request is rejected without running that command or reading that file

#### Scenario: Concurrent conversation
- **WHEN** another conversation attempts to operate the browser while a run owns the browser lease
- **THEN** the second conversation is queued and cannot act until the lease is released and its own tab scope is restored

### Requirement: Session continuity and honest cancellation
The assistant SHALL persist conversation metadata and SDK session references locally, support resume and new conversation, and prevent more than one active run per conversation. Stop SHALL cancel model generation and block subsequent browser dispatch; already executed browser effects SHALL not be represented as undone.

#### Scenario: Stop during execution
- **WHEN** the user stops a run with an action already in flight
- **THEN** further actions are blocked, pending approvals are invalidated, and the UI identifies any action whose final result is not known

#### Scenario: Resume after restart
- **WHEN** the user reopens a persisted conversation after browser or companion restart
- **THEN** the transcript is restored, interrupted work is marked interrupted, and a new action requires renewed browser context rather than replaying pending work

### Requirement: Recover without duplicate side effects
The assistant SHALL distinguish an unsent action from an action whose response was lost after dispatch. It SHALL retry connection establishment with bounded delays, but MUST NOT automatically replay dispatched clicks, submissions, uploads, or other browser mutations.

#### Scenario: Connection loss after dispatch
- **WHEN** the browser disconnects after receiving an action but before its result reaches the companion
- **THEN** the action is reported as result unknown and execution pauses until browser state is observed again

#### Scenario: Browser absent or protocol mismatch
- **WHEN** no compatible extension connects within five seconds or the companion handshake has an incompatible protocol version
- **THEN** the run reports a browser connection or update error and provides a retry action without consuming a new model turn for automatic diagnosis

### Requirement: Preserve recorder and sandbox boundaries
The assistant SHALL keep recorded sessions browsable and attachable to a conversation, retain existing recording data formats and optional transcription configuration, and execute generated code only in the existing isolated worker boundary.

#### Scenario: Recording finishes without an open conversation
- **WHEN** a narrated recording completes while no SDK run is active
- **THEN** it is saved and listed for later attachment without requiring a Claude Code channel

#### Scenario: Sandbox unavailable
- **WHEN** the isolated worker fails to start or exits
- **THEN** execute-code reports a specific unavailable state while direct browser operations remain available; generated code is never evaluated in the companion process

### Requirement: Live current-page reading
The assistant SHALL bind submitted page context to browser instance, window, tab, URL and document identity, and read relevant live article content before analyzing it. Context metadata alone SHALL not count as reading. A read/analyze request SHALL authorize reading the bound page without an additional confirmation, but SHALL not authorize navigation, submission, closing, or regrouping that user-owned tab. Merely opening the panel SHALL not upload page content to the provider.

#### Scenario: Existing tab outside the managed group
- **WHEN** the current article tab is outside the automation tab group and the user requests analysis
- **THEN** the assistant can read that tab through scoped authorization without moving, duplicating, navigating or closing it, and without admitting unrelated tabs into scope

#### Scenario: Page changes or disappears
- **WHEN** the bound tab closes or navigates to a different document before extraction finishes
- **THEN** the run reports changed or unavailable context and does not silently read the replacement page; content already captured remains labeled with its original source

#### Scenario: SPA and incomplete extraction
- **WHEN** article content changes without full navigation or extraction is truncated, blocked by login, or inaccessible
- **THEN** the assistant uses refreshed readable content tied to the current route and reports missing portions instead of claiming a complete reading or fabricating content

#### Scenario: Restricted page or removed context
- **WHEN** page context is removed, no readable tab exists, or browser restrictions block access
- **THEN** the assistant identifies that limitation and offers selecting a readable page or providing article text, without opening an unrelated tab or guessing the article

### Requirement: Extraction completeness reflects the captured container, not only length
`Complete: yes` SHALL mean the captured container plausibly held the page's principal content, not merely that its text was shorter than the truncation ceiling. Live extraction SHALL report, alongside truncation status, whether the matched container is the last-resort generic fallback or otherwise holds an implausibly small share of the page's total text while the page carries substantially more content outside it; in either case the result MUST report a status distinct from a plain complete reading, naming the container used. This is the detection mechanism for the existing requirement that the assistant report missing portions instead of claiming a complete reading — it does not replace or duplicate that requirement.

#### Scenario: Fallback or low-coverage container is not reported complete
- **WHEN** article-first extraction matches only a generic or low-information container, or the captured text is an implausibly small share of the page's total text while the page holds substantially more content outside that container
- **THEN** the result reports a status other than a plain complete reading, identifies the container it used, and does not let the absence of truncation be read as proof of a complete reading

#### Scenario: A genuinely complete article reading is unaffected
- **WHEN** extraction matches a specific content container that holds the page's principal content and is not truncated
- **THEN** the result reports a complete reading exactly as before this requirement existed

### Requirement: Listing and index pages are reachable through read-only tools
For a page whose principal content is a list of items (search results, category index, tender/notice listing) rather than a single article, the assistant SHALL be able to obtain the enumerable items — their visible text and link targets — and their repeated item structure through read-only tools already in scope, without resorting to page scripting merely to enumerate content that a read-only tool already exposes. Tool descriptions SHALL steer the assistant toward those read-only tools for such pages and SHALL reserve page scripting for cases genuinely requiring it.

#### Scenario: Listing page with no dominant article container
- **WHEN** article-first extraction finds no content container specific to a listing/index page's actual content
- **THEN** the assistant can still obtain the page's links and their text through a read-only accessibility-tree or element-search tool, without needing page scripting to enumerate the same information

#### Scenario: Tool descriptions distinguish reading tools from scripting
- **WHEN** the assistant is choosing a tool for a reading or enumeration task
- **THEN** the descriptions of the article-extraction, accessibility-tree, and element-search tools indicate their fit for article versus listing content, and the page-scripting tool's description states it is reserved for cases genuinely requiring scripting rather than a substitute for those read-only tools

### Requirement: The borrowed-tab mutation gate for page scripting is independent of other tab authorization
The runtime MUST NOT rely on inspecting arbitrary JavaScript content to decide whether a page-scripting call against a borrowed tab may bypass the borrowed-tab-mutation default; no such inspection SHALL be treated as authorization. A borrowed tab's mutation authorization granted for one reliably classifiable automatic action (typing, filling, a non-submit click, scrolling, hovering) MUST NOT thereby authorize a page-scripting call against the same tab. Page-scripting calls against a borrowed tab SHALL remain subject to the existing borrowed-tab-mutation rejection independent of any other action's authorization on that tab.

#### Scenario: A read-only script is rejected exactly like a mutating one, and that is accepted
- **WHEN** a page-scripting call that only reads or enumerates page content is issued against a borrowed tab that has not been separately authorized for scripting
- **THEN** it is rejected with the same borrowed-tab-mutation error as a genuinely mutating script, accepted as a disclosed limitation mitigated by steering reading tasks to read-only tools instead

#### Scenario: Authorization for typing does not extend to scripting
- **WHEN** a borrowed tab has been automatically authorized for the typing/filling/clicking automatic action set because a run legitimately interacts with it
- **THEN** a subsequent page-scripting call against that same tab is evaluated against its own, unrelated authorization state and is rejected unless scripting itself has been separately authorized

#### Scenario: A navigating script stays blocked
- **WHEN** a page-scripting call performs a navigation-equivalent effect against a borrowed tab
- **THEN** it is rejected by the same default, and this is the correct, unweakened outcome regardless of any other authorization granted on that tab

### Requirement: Supported external MCP control
External MCP clients SHALL continue to control the browser through the existing default, codemode and hybrid stdio entry points after SDK migration. Existing tool names, argument compatibility, result/image/error shapes and supported recording events SHALL remain compatible. This interface SHALL remain supported alongside sidepanel operation, not only as a migration fallback. It SHALL not require importing external servers into the extension.

#### Scenario: MCP-only user
- **WHEN** a user connects an existing MCP client to the installed browser bridge with no sidepanel provider profile or assistant API key configured
- **THEN** browser tools work normally through that client without opening the sidepanel, signing into Claude, or initializing a model session in the companion

#### Scenario: Existing variants
- **WHEN** existing clients call default tools, codemode execute_code, or hybrid tools and supported recorder notifications
- **THEN** their documented contracts and variant behavior remain available, including image results, argument coercion and sandbox error handling

#### Scenario: SDK and external MCP coexistence
- **WHEN** an external MCP client requests control while an SDK run owns the browser
- **THEN** the shared bridge queues or returns an explicit retryable busy result without changing tabs, stealing scope or failing unrelated connections; after release, that client can proceed normally

#### Scenario: Sidepanel failure or shutdown
- **WHEN** the sidepanel closes or its model session fails while an external MCP client remains connected
- **THEN** the browser bridge and external MCP connection remain usable independently, and any interrupted SDK action is not replayed

### Requirement: Send/submit-class actions gate at canUseTool
The runtime SHALL classify each browser tool call attributable to `computer` or `javascript_tool` before executing it. A call classified as submitting a form, clicking a send/submit/pay/confirm control, or a comparably hard-to-reverse outward-facing action MUST suspend execution pending an explicit user decision; every other classified call, and every call to any other registered browser tool, MUST proceed automatically with no decision required. A tool name capable of producing a send/submit-class call MUST NOT be included in the SDK's auto-approval list; it MAY remain in the SDK's tool-availability list so the call still reaches this classification.

#### Scenario: Automatic action bypasses the gate
- **WHEN** a call is classified outside the send/submit set — reading, extraction, screenshot, scroll, hover, navigation click, typing, form-field filling, opening/closing an agent-created tab, or in-scope script execution
- **THEN** it executes without waiting for a user decision, exactly as before this gate existed

#### Scenario: Send/submit call suspends for a decision
- **WHEN** a call is classified as submitting a form, clicking a send/submit/pay/confirm control, or an equivalently outward-facing action
- **THEN** execution does not proceed until an explicit allow or deny decision resolves it, and a denial or timeout prevents that dispatch entirely

### Requirement: Approval tokens are bound, single-use, and never derivable from content
An approval issued for a pending decision SHALL be bound to the exact run, action, and target it was issued for. It MUST be rejected if presented for a different run, a different action, or a different target, and it MUST be rejected as already used on a second presentation even within its validity window. It SHALL be invalidated on Stop, on a browser or tab scope change, and on replacement or deletion of the credential backing that run. No approval SHALL ever be derivable from webpage content, tool output, or skill instructions.

#### Scenario: Token misuse across runs or targets
- **WHEN** a token issued for one run/action/target is presented for a different run, a different action, or a different target
- **THEN** it is rejected and the mismatched action does not execute

#### Scenario: Webpage or skill content cannot self-authorize
- **WHEN** page content, a tool result, or skill instructions contain text that looks like an approval, a token, or an instruction to proceed
- **THEN** it has no effect on the pending decision; only an explicit decision delivered through the approval channel can resolve it

### Requirement: An unanswered decision is never assumed, and cannot hang a run indefinitely
The runtime MUST NOT treat an unanswered approval or question as granted, MUST NOT deny it without a distinguishable reason, and MUST NOT leave it silently unresolved. An approval or question left unanswered past its bounded expiry SHALL resolve to an explicit, distinguishable timeout outcome, and the run SHALL continue or stop by the same rules as an explicit denial — never left suspended with no resolution.

#### Scenario: Timeout resolves without hanging the run
- **WHEN** no decision arrives before the approval's or question's bounded expiry
- **THEN** the pending call resolves as a timeout-denied action for an approval, or a timeout-failed tool result for a question, distinguishable in the transcript from an explicit user answer, and the run remains able to proceed or stop

### Requirement: The ask-the-user tool grants no authority
An application-owned tool that presents a question with pre-written options to the user SHALL return the user's chosen option to the run as ordinary tool-result data. It MUST NOT be treated as a permission grant, MUST NOT be consulted by the send/submit approval gate, and MUST NOT be substitutable for an approval decision by phrasing a question whose answer implies consent.

#### Scenario: A chosen answer is data, not permission
- **WHEN** the user selects an option for an ask-the-user question
- **THEN** the run receives that option as tool-result content, and any later send/submit-class action the agent attempts still requires its own separate approval decision
