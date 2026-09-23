# Page monitor

`page_monitor` stores a baseline from a loaded tab and compares a later observation against it. The rendered DOM/text snapshot of the loaded tab is read first; if that is unavailable, an observed JSON network response is used as an automatic fallback (the debugger may reload the tab once to capture it).

Use `action=save` with an identifier or response URL, `action=check` to compare a due monitor, `action=list` to inspect saved monitors, and `action=delete` with `monitorId` to remove one. Changes are reported as added, removed, and changed field paths.

The core normalizes and stores page observations independently of a particular website. Source adapters implement `matches` and `normalize`; `observedJsonSource` handles JSON responses, and `createTextSourceAdapter` provides the extension point for DOM or text observations. The MSC host rule is kept in the `mscSource` adapter only.
