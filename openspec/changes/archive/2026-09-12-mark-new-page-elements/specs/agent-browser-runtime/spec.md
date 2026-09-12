## ADDED Requirements

### Requirement: A page read distinguishes elements that appeared since the previous read

A read of the live page SHALL mark each element that was first seen after the previous read of the same document, and SHALL leave unmarked every element that was already present at that previous read. The marking SHALL be visible in the returned text and SHALL NOT change an element's reference, so a marked element is acted on exactly as any other.

The read SHALL state what the marker means, so its meaning does not depend on the reader having been told separately.

#### Scenario: A control reveals new elements

- **WHEN** an action causes the page to render elements that were not there before — a suggestion list after typing, an expanded panel, a dropdown's options — and the page is read again
- **THEN** those elements are marked as newly appeared, and elements that were already on the page are not

#### Scenario: Nothing changed between reads

- **WHEN** the page is read twice with nothing appearing in between
- **THEN** the second read marks nothing

#### Scenario: Acting on a marked element

- **WHEN** a marked element is used as the target of a click, a form fill, or a scroll
- **THEN** it behaves exactly as an unmarked element with the same reference, including resolution, scroll-into-view and hit-testing

### Requirement: The distinction resets when the document identity changes

Marking SHALL be relative to the current document. When the document identity changes — a navigation, or a client-side route change in a single-page application — the record of what was previously seen SHALL be discarded, and the first read after that change SHALL mark nothing.

#### Scenario: After a navigation

- **WHEN** the tab navigates and the new page is read
- **THEN** nothing is marked, because every element is new and marking all of them would carry no information

#### Scenario: After a client-side route change

- **WHEN** a single-page application changes route without reloading the document, and the page is read
- **THEN** nothing is marked, on the same terms as a full navigation

#### Scenario: First read of a document

- **WHEN** a document is read for the first time
- **THEN** nothing is marked, because there is no previous read to be new relative to
