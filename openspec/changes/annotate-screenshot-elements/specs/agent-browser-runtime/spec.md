## ADDED Requirements

### Requirement: A screenshot can carry the actionable identity of what it shows

The screenshot action SHALL accept a request to annotate the capture. An annotated capture SHALL outline each interactive element in the viewport and label it with the same element reference the page-reading operations return for that element, so a reference read off the image can be passed straight to a click, a form fill, or a scroll-to without any further lookup.

Labels SHALL NOT introduce a second identifier scheme. A reference shown on an annotated capture SHALL be the reference that already identifies that element, and SHALL resolve, scroll into view and hit-test at dispatch exactly as a reference obtained from a page read does.

An unannotated capture SHALL be unchanged by this capability.

#### Scenario: Acting on what the picture shows

- **WHEN** an annotated screenshot is taken and a labelled reference from it is used as the target of a click
- **THEN** the click resolves that element, scrolls it into view and hit-tests it exactly as if the reference had come from a page read

#### Scenario: The same element from two routes

- **WHEN** an element appears both in a page read and on an annotated capture
- **THEN** the reference shown in each is the same, and either can be used interchangeably

#### Scenario: Annotation not requested

- **WHEN** a screenshot is taken without requesting annotation
- **THEN** the image contains no outlines or labels and is identical to what the same capture produced before this capability existed

### Requirement: Annotation is transient and never becomes page content

The annotation SHALL exist only for the duration of the capture and SHALL be removed afterwards, including when the capture fails. It SHALL NOT appear in any page-reading result, SHALL NOT be assigned element references of its own, and SHALL NOT be annotated by a subsequent capture.

The page SHALL be left as it was found: no element moved, resized, restyled, or scrolled as a consequence of annotating.

#### Scenario: Reading the page after an annotated capture

- **WHEN** the page is read after an annotated screenshot
- **THEN** no outline, label or container introduced by the annotation appears in the result

#### Scenario: Two annotated captures in a row

- **WHEN** a second annotated screenshot is taken
- **THEN** the previous annotation has already been removed, and nothing from it is outlined or labelled as if it were page content

#### Scenario: The capture fails

- **WHEN** the capture errors or times out after the annotation was drawn
- **THEN** the annotation is still removed and the page is left as it was found

#### Scenario: Page layout is untouched

- **WHEN** a page is annotated and the annotation is removed
- **THEN** no element has changed position, size or scroll offset as a result

### Requirement: Labels stay legible when the capture is scaled

When a capture is reduced in size, labels SHALL remain readable in the returned image. A label SHALL NOT be rendered so small that the reference it carries cannot be read back from the image the assistant receives.

#### Scenario: Annotated capture at reduced scale

- **WHEN** an annotated screenshot is requested at a reduced scale
- **THEN** the labels in the returned image are still readable as references

#### Scenario: A small target

- **WHEN** an interactive element is smaller than its own label
- **THEN** the label is placed so it remains readable and identifiable as belonging to that element
