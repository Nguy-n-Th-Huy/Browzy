## 1. GIF encoder

- [x] 1.1 Add a GIF89a writer to the offscreen document's module set: global palette construction, LZW compression, per-frame delay, and the loop block. Write it as top-level pure functions over typed arrays so `test/_extract.mjs` can pull them out of the shipped file.
- [x] 1.2 Add colour quantization that maps captured frames onto the single global palette.
- [x] 1.3 Add the click-marker draw: given a frame bitmap and a viewport position, draw the marker into that frame's pixels.
- [x] 1.4 Unit test the encoder under plain Node via the extraction convention: byte-level header/trailer structure, LZW round-trip against known input, frame delays matching requested timing, marker pixels landing at the requested position. ← (verify: tests extract from the real shipped file, not a copy; a decoded output is checked, not just byte length)

## 2. Frame capture and click correlation

- [x] 2.1 Add screencast start/stop around a caller-bounded window on the addressed tab, reusing the existing per-tab CDP attach helper. Buffer frames with their capture timestamps.
- [x] 2.2 Fail the capture with a named reason when the target's screencast is already held by another consumer, per design decision 1.
- [x] 2.3 Collect dispatched-click timestamps and viewport positions from the action-event stream for the capture window, without changing what that stream emits.
- [x] 2.4 Add the correlation function: map each click onto the frame whose capture interval contains its timestamp, dropping clicks no frame covers. Keep it pure and unit test interval containment, boundary timestamps, clicks before the first frame, and clicks after the last. ← (verify: a click outside every frame interval draws no marker and is not silently attached to the nearest frame)

## 3. `gif_creator` handler

- [x] 3.1 Replace the placeholder handler with one that rejects an out-of-scope tab before any capture begins.
- [x] 3.2 Wire capture, correlation, and encoding, and return the GIF as image data the model can see.
- [x] 3.3 Enforce the image data limit at encode time; on overflow return an error naming the limit and the achieved size, returning no partial image.
- [x] 3.4 Handle the tab closing mid-capture: return the frames captured so far together with an explicit statement that capture ended early. ← (verify: every scenario in the GIF requirement is exercised, including no-clicks, early stop, oversize, and out-of-scope)

## 4. Shortcut handlers

- [x] 4.1 Replace the `shortcuts_list` placeholder with a handler that returns the shortcuts available for the addressed tab, each carrying the identifier the execution operation accepts.
- [x] 4.2 Return an empty enumeration for a tab with no shortcuts, distinguishable in the result from a lookup failure.
- [x] 4.3 Replace the `shortcuts_execute` placeholder with a handler that runs the addressed shortcut and reports its outcome.
- [x] 4.4 Validate arguments against the contract the companion already enforces — identifier or command required, numeric tab, tab in scope — reusing the companion's error codes rather than inventing parallel ones.
- [x] 4.5 Report an unknown shortcut identifier distinguishably from a shortcut that ran and failed. ← (verify: the extension's rejections match the companion's existing argument contract and error codes; no shortcut runs on a rejected call)

## 5. `upload_image` coordinate drop

- [x] 5.1 Accept a viewport coordinate as an alternative addressing mode alongside the existing element reference.
- [x] 5.2 Reject an upload supplying neither mode, naming both.
- [x] 5.3 Keep the file-input path unchanged when a reference resolves to a file input.
- [x] 5.4 When a reference resolves to a non-file-input element, report the mismatch and name the coordinate mode, without dropping at a guessed position.
- [x] 5.5 Implement the coordinate path as a trusted CDP drag dispatch carrying the staged temp file, reusing the existing staging step.
- [x] 5.6 Report a target that does not accept the dropped image as a failure, not a successful upload.
- [x] 5.7 Add an acceptance check against a rich-text editor that exposes no file input. ← (verify: the drop is trusted, the editor actually receives the image, and the file-input path is byte-identical in behavior to before this change)

## 6. Browser enumeration and selection

- [x] 6.1 Add a native-host request that enumerates attached browser connections, identifying each and marking which one currently drives automation.
- [x] 6.2 Add the `list_connected_browsers` operation returning that enumeration.
- [x] 6.3 Add a native-host directed handoff that transfers automation to a named connection and confirms the outcome.
- [x] 6.4 Add the `select_browser` operation over that handoff, reporting completion only on host confirmation and naming the browser still driving on failure.
- [x] 6.5 Reject an unattached target before releasing anything, leaving the current connection intact.
- [x] 6.6 Report selecting the already-driving browser as needing no transfer, without dropping the connection.
- [x] 6.7 Register both operations in the tool definitions and the tab-scope/mutation classification. ← (verify: a failed or rejected selection never leaves the caller disconnected; selection outcome comes from host confirmation, never from elapsed time)

## 7. Baseline record and removal

- [x] 7.1 Add `list_connected_browsers` and `select_browser` to the enumerated post-baseline additions set.
- [x] 7.2 Add the removals set to the baseline record, with `switch_browser` naming `select_browser` as its replacement.
- [x] 7.3 Extend the baseline check so a registered operation returning a fixed message in place of its contracted effect is reported as a preservation failure naming that operation.
- [x] 7.4 Remove `switch_browser` and its release-window constant.
- [x] 7.5 Update regression fixtures that assert the previous placeholder strings to the real contracts. ← (verify: the baseline check fails on a deliberately re-stubbed operation, and accepts the removal only because the removals set names it)

## 8. Documentation

- [x] 8.1 Update the operation count and any user-facing description that names browser switching, so no shipped text still describes the removed behavior.
