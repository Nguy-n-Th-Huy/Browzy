## Context

See proposal.md — Why. The constraints that shape the approach:

- The service worker has no DOM. Anything needing `canvas`, `Image`, or `toDataURL` must run in the offscreen document, which already owns exactly that for the recorder's thumbnail path (`extension/recorder/offscreen.js`).
- Frame capture already has two established mechanisms in this codebase: CDP `Page.captureScreenshot` (`extension/background.js:3071`, jpeg with `captureBeyondViewport:false`) and `chrome.tabs.captureVisibleTab` (`:6278`). CDP sessions are already per-tab and already established by the attach helper every tool uses.
- `extension/vendor/` carries no GIF encoder. `fflate` is DEFLATE; the GIF format requires LZW. This is a real gap, not a lookup away.
- Input is dispatched through CDP (`Input.dispatchMouseEvent`, `Input.dispatchKeyEvent`). Synthetic events created inside a content script carry `isTrusted:false`; the editors that motivate the coordinate-drop path are exactly the ones that check it.
- The extension can only ever see itself. `detectBrowser()` (`:768`) reads its own user agent. The native host is the only process with more than one browser attached to it, and it already tracks per-connection identity through the lease guard's `clientId`.
- `extension/manifest.json` declares no `web_accessible_resources`, so an injected script cannot `import()`. Code that ships into a page is a classic script, as `extension/overlay/pointer-overlay.js` documents.
- Tests extract pure functions from the real shipped file by brace matching (`test/_extract.mjs`) and run them under plain Node. No bundler, no jsdom, no browser. Logic that must be tested has to be expressible as a top-level pure function.

## Goals / Non-Goals

**Goals:**

- Each of the four operations produces its contracted effect, observable from its result rather than from an assurance.
- The GIF encoder, the frame/click correlation, and the browser registry are pure enough to unit test under the existing extraction convention.
- Browser selection reports a real outcome instead of letting a timer stand in for one.

**Non-Goals:**

- No GIF playback, editing, or storage UI. The operation returns image data; where it is displayed is the panel's concern.
- No audio, no cursor trail, no full session replay in the GIF. rrweb already covers session replay and is not part of this path.
- No change to what shortcuts exist or how the companion resolves them. This change supplies the extension-side handlers the companion's contract already expects.
- No new approval or permission behavior. These operations keep the gating they already have.
- No support for driving two browsers at once. Selection moves automation; it does not parallelize it.

## Decisions

### 1. Frame source: CDP screencast, not repeated screenshots

`Page.startScreencast` delivers frames as the compositor produces them, each with its own metadata and timestamp, and stops when told. Polling `Page.captureScreenshot` on a timer would instead sample at a rate unrelated to what the page actually did, double-charging every frame with a full round trip, and would smear the click correlation the spec requires.

Alternatives considered: `chrome.tabs.captureVisibleTab` on a timer — rejected because it is rate-limited per second, captures only the focused window, and carries no frame timestamp to correlate against; `MediaRecorder` over `tabCapture` — rejected because it produces video the model cannot read as an image and would need a decode step to become a GIF anyway.

Trade-off: a screencast is exclusive per target. If another consumer holds one, capture must fail with that reason rather than silently degrading to polling.

### 2. Encoding runs in the offscreen document

The encoder needs `canvas` to quantize frames and draw click markers. Only the offscreen document has it. It already exists for the recorder and already accepts a typed message protocol, so this adds a message kind rather than a new surface.

### 3. Write a minimal GIF89a encoder rather than vendoring one

The format needed here is narrow: one global palette, LZW-compressed frames, a loop block, per-frame delays. A focused encoder is a few hundred lines and — crucially — is expressible as top-level pure functions over typed arrays, which the `_extract.mjs` convention can test directly under Node with no browser.

Alternative considered: vendoring an existing encoder, which matches how `rrweb` and `pdf.js` arrived. Rejected for this case because every candidate ships as a worker-oriented bundle whose internals the extraction-based test convention cannot reach, leaving the encoder itself unverifiable here; and because the palette/marker interaction is the part most likely to regress, so it is the part that most needs direct tests.

Trade-off: this is encoder code we now own. It is bounded by writing a single well-specified format, and the spec's size-limit and early-stop scenarios are the acceptance surface.

### 4. Click markers correlate by timestamp, drawn at encode time

Frames carry capture timestamps; the action-event stream carries dispatched-click timestamps and viewport positions. A marker is drawn into the frame whose capture interval contains the click's timestamp. Drawing happens at encode time, over the captured pixels.

The alternative — rendering a marker into the live page so the camera catches it — was rejected because it mutates the page under capture, races the click it is meant to depict, and would be indistinguishable in the result from a page that drew its own affordance. Correlating recorded facts keeps the spec's "SHALL NOT mark a click the runtime did not dispatch" checkable.

The existing pointer overlay is a separate consumer of the same stream and is not modified.

### 5. Coordinate drop uses CDP drag dispatch with a staged file

`Input.dispatchDragEvent` produces trusted events and accepts file paths in its drag data. The staging path already exists: `upload_image` writes the stored image to a real temp file through the native host before attaching it. The coordinate path reuses that staging and changes only the delivery.

Alternative considered: constructing a `DataTransfer` in a content script and dispatching `dragenter`/`dragover`/`drop`. Rejected because those events are untrusted, and the editors this exists for reject untrusted drops — it would fail exactly where it is needed.

The two addressing modes stay disjoint per the spec: a reference that resolves to a file input uses the existing path, a coordinate uses the drop path, and neither silently becomes the other. A reference that resolves to something else reports the mismatch and names the coordinate mode rather than guessing a position.

### 6. The native host owns the browser registry

Each attached browser is already a distinct native-host connection with its own identity in the lease guard. Enumeration is a new request the host answers from the connections it holds; selection is a directed handoff the host performs and confirms.

This replaces the current design, where the extension drops its own port and infers the outcome from elapsed time. The extension cannot observe another browser, so any extension-side implementation would have to guess — which is precisely the defect being removed.

Selection reports completion when the host confirms the target took over, and reports failure naming the browser still driving otherwise. An unattached target is rejected before anything is released, so a mistyped name cannot cost the caller its working connection — this is why the spec requires that path to leave the current connection intact.

### 7. `switch_browser` is removed rather than aliased to `select_browser`

Its argument shape and its result carry no information the new pair needs, and its contract is "wait and hope". Keeping it as an alias would preserve a name whose documented behavior no longer happens. Its removal is recorded in the baseline's enumerated removals set, which is what the modified preservation requirement adds so that a removal stays distinguishable from a loss.

## Risks / Trade-offs

- **Screencast contention — another consumer holds the target's screencast** → Capture fails with that reason named. The spec has no scenario in which GIF export degrades silently, so contention surfaces as an error rather than a worse recording.
- **We now own a GIF encoder** → Scope is one format with one palette strategy, and the encoder's pure functions are unit tested directly. The size-limit and early-stop scenarios bound its output.
- **Large or long captures exceed the image data limit** → The size limit is enforced at encode time and reported with both the limit and the achieved size, so a caller can retry with a shorter window instead of receiving a truncated file.
- **Click correlation drifts if frame and event clocks diverge** → Both timestamps are read from the same browser process; correlation is by interval containment, not equality, so sub-frame skew cannot move a marker to the wrong frame. Skew large enough to matter means no frame contains the click, and no marker is drawn — which the spec permits, rather than inventing a position.
- **Trusted drag dispatch is a real input capability** → It is reachable only through an operation that already runs inside the run's tab scope and existing gating; this change adds a delivery mode, not a new entry point.
- **Removing `switch_browser` breaks any caller that names it** → Intentional and marked BREAKING. It is an internal operation with no external consumers, and the removals set makes the replacement discoverable from the baseline check itself.
- **Enumeration reveals which browsers a user has attached** → It reports only browsers already connected to this user's own companion, to a run that already drives one of them. It does not enumerate installed browsers, profiles, or anything not already attached.

## Migration Plan

1. Land enumeration and selection alongside `switch_browser`, without removing it. Nothing breaks while the new pair is exercised.
2. Move the baseline record: add `list_connected_browsers` and `select_browser` to the post-baseline additions set, add `switch_browser` to the removals set naming `select_browser` as its replacement.
3. Remove `switch_browser` and `SWITCH_RELEASE_MS`. The baseline check now accepts its absence because the removals set names it.

Rollback: steps are ordered so the removal is last and independently revertible. Reverting step 3 restores the previous operation without touching the new pair.

## Open Questions

- Default capture duration and frame rate when a caller supplies none. Both are caller-bounded per the spec and any default satisfies it; the value is tunable after measuring real captures against the size limit.
