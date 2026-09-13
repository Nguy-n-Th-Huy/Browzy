## ADDED Requirements

### Requirement: GIF export produces a real recording of the controlled tab
The GIF export operation SHALL capture the agent-controlled tab over a caller-bounded interval and return an animated GIF as image data the model can see. Each click the runtime dispatched during the capture window SHALL be marked in the frame covering that click's timestamp, at the click's own viewport position. The operation SHALL NOT return a textual placeholder in place of image data, and SHALL NOT mark a click the runtime did not dispatch.

#### Scenario: Recording a short interaction
- **WHEN** an authorized task requests a GIF of its tab and clicks two controls during the capture window
- **THEN** the result carries animated GIF image data whose frames span the requested window, and a click marker appears at each of the two clicked positions in the frames covering their timestamps

#### Scenario: No clicks during capture
- **WHEN** a GIF is requested over a window in which the runtime dispatches no click
- **THEN** the result carries animated GIF image data with no click markers drawn

#### Scenario: Capture exceeds the size limit
- **WHEN** the encoded GIF would exceed the runtime's image data limit
- **THEN** the operation returns an error naming the limit and the achieved size, and returns no partial or truncated image

#### Scenario: Tab closes mid-capture
- **WHEN** the captured tab closes before the requested window elapses
- **THEN** the operation returns the frames captured up to that point together with an explicit statement that capture ended early, and does not report the requested duration as achieved

#### Scenario: Capture target is out of scope
- **WHEN** a GIF is requested for a tab outside the run's authorized tab scope
- **THEN** the operation is rejected before any capture begins, naming the scope violation

### Requirement: Shortcut listing and execution act on real shortcuts
The shortcut listing operation SHALL return the shortcuts actually available for the addressed tab, and the shortcut execution operation SHALL execute an addressed shortcut and report its outcome. Neither operation SHALL report a fixed "not supported" result. Arguments SHALL be validated against the same contract the companion enforces: an identifier or a command name is required, and the addressed tab must be numeric and within the run's tab scope.

#### Scenario: Listing available shortcuts
- **WHEN** a task lists shortcuts for a tab in its scope
- **THEN** the result enumerates the shortcuts available for that tab, each with the identifier accepted by the execution operation

#### Scenario: No shortcuts available
- **WHEN** a task lists shortcuts for a tab that has none
- **THEN** the result is an empty enumeration, distinguishable from a failure to look them up

#### Scenario: Executing a shortcut
- **WHEN** a task executes a shortcut by an identifier the listing returned for that tab
- **THEN** the shortcut runs against that tab and the result reports its outcome

#### Scenario: Execution without an identifier or command
- **WHEN** a shortcut execution omits both the identifier and the command name
- **THEN** the operation is rejected with an invalid-arguments error naming the missing field, and no shortcut runs

#### Scenario: Execution against an unknown shortcut
- **WHEN** a shortcut execution names an identifier that does not exist for the addressed tab
- **THEN** the operation reports that the shortcut was not found, and is distinguishable from a shortcut that ran and failed

### Requirement: Image upload reaches targets that expose no file input
The image upload operation SHALL deliver a stored image to a target that accepts dropped image data at a viewport position, in addition to the existing element-reference path for file inputs. When the caller addresses an element reference that resolves to a file input, the operation SHALL keep using the file-input path unchanged. When the caller supplies a viewport coordinate, the operation SHALL deliver the image as a drop at that coordinate. The operation SHALL NOT silently fall back between the two paths.

#### Scenario: Dropping an image into a rich-text editor
- **WHEN** a task uploads a stored image at a viewport coordinate inside an editor that exposes no file input
- **THEN** the editor receives the image as dropped image data at that coordinate, and the result reports the delivery

#### Scenario: File input still uses the element-reference path
- **WHEN** a task uploads a stored image addressing an element reference that resolves to a file input
- **THEN** the image is attached to that file input, with the behavior and result unchanged from before this change

#### Scenario: Neither a coordinate nor a reference is supplied
- **WHEN** an upload supplies neither a viewport coordinate nor an element reference
- **THEN** the operation is rejected naming both accepted addressing modes, and nothing is uploaded

#### Scenario: Reference resolves to a non-file-input element
- **WHEN** an upload addresses an element reference that resolves to an element which is not a file input
- **THEN** the operation reports that the reference is not a file input and names the coordinate mode as the alternative, rather than dropping at a guessed position

#### Scenario: The target rejects the drop
- **WHEN** the image is dropped at a coordinate whose target does not accept dropped image data
- **THEN** the operation reports that the target did not accept the image, and does not report a successful upload

#### Scenario: Unknown image identifier
- **WHEN** an upload names a stored image that does not exist
- **THEN** the operation reports the image as not found and instructs the caller to capture one first

### Requirement: Connected browsers are enumerable and selectable by name
The runtime SHALL expose an operation that enumerates the browsers currently attached to the local companion, identifying each one and marking which of them currently drives automation. It SHALL expose a second operation that transfers automation to a named browser from that enumeration and reports the outcome of the transfer. Selection SHALL NOT depend on a fixed waiting period, and SHALL NOT report success on the basis of elapsed time alone.

#### Scenario: Listing attached browsers
- **WHEN** a task enumerates connected browsers while two browsers are attached to the companion
- **THEN** the result lists both, each identified distinctly, with exactly one marked as currently driving automation

#### Scenario: Only one browser is attached
- **WHEN** a task enumerates connected browsers while only the current browser is attached
- **THEN** the result lists that one browser, marked as currently driving automation

#### Scenario: Selecting another attached browser
- **WHEN** a task selects a browser from the enumeration other than the current one
- **THEN** automation transfers to that browser and the operation reports the transfer as completed, with the newly selected browser identified in the result

#### Scenario: Selecting a browser that is not attached
- **WHEN** a task selects a browser that the enumeration did not list
- **THEN** the operation is rejected naming the unknown target, automation stays where it was, and the current browser's connection is not dropped

#### Scenario: The selected browser does not take over
- **WHEN** a selected browser fails to take over automation
- **THEN** the operation reports the transfer as failed and names the browser still driving automation, rather than reporting success or leaving the outcome unstated

#### Scenario: Selecting the browser already driving automation
- **WHEN** a task selects the browser that is already driving automation
- **THEN** the operation reports that no transfer was needed and does not drop the connection

## MODIFIED Requirements

### Requirement: Preserve the browser capability baseline
The assistant SHALL preserve the legacy operations that constitute the baseline tool registry, sandboxed execute-code behavior, and narrated recording access. Operations added to the registry after that baseline SHALL be tracked as a separate, explicitly enumerated set, so that an addition is never indistinguishable from the loss of a preserved operation. Operations removed from the baseline SHALL be tracked as an explicitly enumerated set naming the operation that replaces each one, so that a removal is never indistinguishable from a loss. Legacy operation names containing `mcp` SHALL remain internal compatibility aliases only. Preservation SHALL be measured by outputs and browser side effects, not an unverified claim of official Claude in Chrome parity, and not by an operation's presence in the registry: a registered operation whose result is a fixed message in place of its contracted effect SHALL be reported as a preservation failure.

#### Scenario: Representative browser workflow
- **WHEN** an authorized task creates a tab, navigates, reads the page, fills a form, clicks, captures a screenshot, and closes its tab
- **THEN** each operation returns its result, the screenshot is available as an image to the model, and no unrelated tab is modified

#### Scenario: Extended operations
- **WHEN** regression fixtures exercise console/network inspection, page JavaScript, GIF export, resize, shortcuts, focus, uploads, configuration, diagnostics, browser enumeration and selection, recording retranscription, and sandboxed multi-action execution
- **THEN** results and browser side effects match the existing executor contracts, including existing errors and data limits

#### Scenario: Baseline operation missing from the registry
- **WHEN** any baseline operation is absent from the live registry and is not named in the enumerated set of removals
- **THEN** the discrepancy is reported as a preservation failure naming the missing operation

#### Scenario: Registered operation that performs no work
- **WHEN** a baseline operation is present in the registry but returns a fixed message instead of performing its contracted effect
- **THEN** the discrepancy is reported as a preservation failure naming that operation, and the operation's registry presence does not satisfy the baseline

#### Scenario: Operation added after the baseline
- **WHEN** the live registry contains an operation outside the baseline operations
- **THEN** that operation is accepted only if it appears in the enumerated set of post-baseline additions, and any operation in neither set is reported as an unaccounted-for discrepancy

#### Scenario: Operation removed from the baseline
- **WHEN** a baseline operation is absent from the live registry and is named in the enumerated set of removals
- **THEN** the absence is accepted, and the record names the operation that replaces it
