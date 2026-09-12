## Context

`extension/content.js` assigns refs from a monotonic counter in `getOrAssignRef()`: an element that already has a live ref keeps it, and anything else takes `ref_${++refCounter}`. Refs persist across calls for as long as the element does, held through a `WeakRef` map with a reverse `WeakMap`.

That is the whole mechanism this change needs. "First seen after the previous read" is the same statement as "its ref number is above where the counter stood when the previous read finished". No snapshot of the previous tree has to be stored or diffed.

The content script also already maintains document identity, including for client-side routing: `installSpaTracking()` wraps `pushState`/`replaceState` and listens for `popstate`/`hashchange`, calling `bumpDocumentEpoch()` when the URL actually changes. That is the reset hook.

Reference: browser-use marks new interactive elements with `*[` and its system prompt states the marker holds only "if url has not changed" (`system_prompt.md:59`) — the same caveat, arrived at independently.

## Goals / Non-Goals

**Goals**

- Tell the reader which elements the last action brought into existence.
- Cost nothing per read beyond one integer comparison per element.
- Reset correctly on both real navigation and SPA route changes.

**Non-Goals**

- Not a general DOM diff. Elements that were removed, moved, or whose text changed are not reported.
- Not a change to ref assignment, resolution, or the click path.
- Not a replacement for re-reading. A marked element can still go stale before it is used; that is still caught at dispatch by the existing resolve-and-hit-test.

## Decisions

### Decision: A high-water mark on the existing ref counter

After each `read_page` or `find` completes, record the current `refCounter` value for the document. On the next read, an element is new when its ref number exceeds the recorded value.

This is chosen over storing the previous tree and diffing it because the counter already carries the information. A stored tree would be a second source of truth about what the page contained, able to disagree with the live DOM.

One subtlety, and the reason the watermark is recorded *after* the read rather than before: `getOrAssignRef()` assigns refs lazily, during serialization. An element that existed but had never been serialized gets its first ref during this read and would look new. That is accepted and is in fact the honest reading — "new" here means *newly visible to this reader*, which is the thing the assistant needs to know. Recording the watermark after the read is what makes the statement consistent between consecutive reads.

### Decision: The marker is a prefix on the element's line, and the ref is untouched

The marker goes in the rendered line, not in the ref string. A ref is an identifier that gets passed back to `computer`, `form_input` and `upload_image`; encoding state into it would mean the same element has two names depending on when it was read.

### Decision: Reset from the existing document epoch, not from a URL comparison in the read path

`bumpDocumentEpoch()` already fires for full navigation and for SPA route changes, and is already the project's answer to "is this the same document". Clearing the watermark there keeps one owner of document identity. Comparing URLs inside the read path would be a second, weaker implementation of a question already answered.

### Decision: The read states what the marker means

The tool result carries a one-line explanation whenever anything is marked. Prompt text can drift or be truncated; a result that explains its own notation is legible to any reader. This follows what `read_page`, `get_page_text` and the hit notes already do elsewhere in this codebase.

## Risks / Trade-offs

**Lazily-assigned refs can mark an element that was present but never serialized.** Described above; accepted deliberately, and the reason "new" is defined as new-to-this-reader. The alternative — assigning refs eagerly to the whole DOM — would cost far more than the signal is worth.

**A `find` and a `read_page` share one watermark per document.** A `find` that serializes only matching elements advances the counter less than a full `read_page` would. The consequence is conservative: fewer elements are called new, never more. Preferred over keeping separate watermarks per tool, which would make "new" mean different things depending on which tool asked.

**The marker is one more thing in the output.** One character per marked line, and only on elements that are actually new. Negligible against the 50,000-character cap.

## Migration Plan

Purely additive to output text. No schema field is added or removed; no ref format changes; existing refs keep working.

`read_page` and `find` descriptions change, and `test/registry-baseline.test.mjs` pins description text, so `test/fixtures/registry-baseline.json` must be regenerated for those two entries and the diff checked to contain nothing else.

Both `extension/content.js` and `extension/background.js` require an extension reload.

## Open Questions

None.
