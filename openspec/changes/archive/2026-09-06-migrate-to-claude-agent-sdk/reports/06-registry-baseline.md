# Task 6.1 (baseline half) — Registry baseline coverage evidence

Scope: `openspec/changes/migrate-to-claude-agent-sdk` task 6.1, **baseline capture
only**. This report documents `test/registry-baseline.test.mjs` and the
committed snapshot `test/fixtures/registry-baseline.json`.

**Not in this task's scope** (explicitly deferred): mapping friendly SDK-facing
operations to preserved executor contracts, and the borrowed-tab scope
extension from design section 5b. Both depend on the SDK adapter from task
group 3 (`host/agent/`), which does not exist in this repository yet. Nothing
in this report or the new test file assumes or stubs that adapter.

**Environment**: no browser or native host connection was available in this
session. Everything below is derived from static analysis of
`host/tool-definitions.js` (imported live) and `extension/background.js`
(read the same way `test/handlers.test.mjs` already does, via
`test/_extract.mjs`'s brace-matching extractor). No live browser round trip,
no real screenshot bytes, no real tab side effects — that comparison is task
6.4's job, not this one's.

## Registry count: design.md's "26" is confirmed correct

`host/tool-definitions.js` exports a `TOOLS` array with **26 entries**,
matching design.md's "Repository findings" claim exactly, both in count and
in the specific 26 names it lists.

There is one discrepancy, but it is *inside* `host/tool-definitions.js`
itself, not between the file and design.md: the file's own top-of-file
comment (line 1) reads:

```js
// The 25 open-claude-in-chrome tool definitions, extracted as data so both
```

That comment is stale — the array beneath it has 26 entries, not 25.
`host/tool-definitions.js` is explicitly out of scope for this task to edit
(listed as off-limits, and owned by concurrent in-flight work), so this is
reported here rather than fixed. The test suite prints this as a `NOTE` line
on every run so it isn't silently forgotten.

## What the suite captures, per entry

For each of the 26 registry entries, the committed snapshot
(`test/fixtures/registry-baseline.json`) records:

- **name** — the exact tool name (including legacy `_mcp`-suffixed aliases).
- **description** — the exact registry description string.
- **inputSchema** — the full JSON Schema produced by
  `toolInputJsonSchema()` (the same conversion the MCP server and codemode
  TS-API generator use), which captures every required/optional field and its
  type, including nested object/array shapes (e.g. `gif_creator`'s `options`
  object, `computer`'s `coordinate`/`region` tuples).
- **resultShape.producesImage** — whether the tool's *shipped* handler in
  `extension/background.js` contains an MCP `{ type: "image" }` content
  block, extracted via `test/_extract.mjs`'s `extractMethod()` (the same
  brace-matching extractor `test/handlers.test.mjs` already uses against the
  real source, not a paraphrase of it).
- **resultShape.currentlyStub** — whether the shipped handler is currently an
  unimplemented stub (matches `/not (yet )?implemented|not supported/i` in
  the handler body). This baseline must record the *current* truth, including
  where that truth is "not implemented" — see below.

| Tool | Required args | Optional args | Image output | Currently a stub |
|---|---|---|---|---|
| computer | action, tabId | coordinate, duration, modifiers, ref, region, repeat, scroll_direction, scroll_amount, start_coordinate, text, save_to_disk | **yes** | no |
| debug | — | limit, kind, filter, tabId, since_ms, clear | no | no |
| debug_timings | — | limit, clear | no | no |
| file_upload | paths, ref, tabId | — | no | no |
| find | query, tabId | — | no | no |
| form_input | ref, value, tabId | — | no | no |
| get_config | — | tabId | no | no |
| get_page_text | tabId | — | no | no |
| gif_creator | action, tabId | download, filename, options | no | **yes** |
| javascript_tool | action, text, tabId | — | no | no |
| navigate | url, tabId | — | no | no |
| read_console_messages | tabId | pattern, limit, onlyErrors, clear | no | no |
| read_network_requests | tabId | urlPattern, limit, clear | no | no |
| read_page | tabId | filter, depth, ref_id, max_chars | no | no |
| resize_window | width, height, tabId | — | no | no |
| retranscribe_recording | recording_id | — | no | no |
| set_config | key, value | tabId | no | no |
| set_tab_focus | tabId | focus_window | no | no |
| shortcuts_execute | tabId | shortcutId, command | no | **yes** |
| shortcuts_list | tabId | — | no | **yes** |
| switch_browser | — | — | no | no |
| tabs_close_mcp | — | tabId, tabIds | no | no |
| tabs_context_mcp | — | createIfEmpty | no | no |
| tabs_create_mcp | — | — | no | no |
| update_plan | domains, approach | — | no | no |
| upload_image | imageId, tabId, ref | filename | no | no |

Three entries (`gif_creator`, `shortcuts_list`, `shortcuts_execute`) are
**currently unimplemented stubs** in this build — their handlers return a
fixed "not yet implemented" / "not supported" text string regardless of
arguments, even though their input schemas are fully declared and validated.
The baseline records this truthfully: the "before" contract for these three
is "accepts the declared arguments, always returns a fixed not-supported
text block," not real GIF/shortcut behavior. Any future task that makes these
real must update the snapshot deliberately — this suite exists specifically
so that change is visible, not implicit.

## Design section 6 preservation properties asserted

1. **Legacy `mcp`-suffixed names remain present as internal compatibility
   aliases.** Asserted directly against the live registry: `tabs_context_mcp`,
   `tabs_create_mcp`, `tabs_close_mcp` are all present.
2. **Screenshot-producing operations declare image output.** The `computer`
   handler (covering `screenshot`, `zoom`, and the post-scroll confirmation
   capture inside `scroll`) contains `{ type: "image", ... }` content blocks
   in its shipped source. `upload_image` — which *consumes* a previously
   captured screenshot rather than producing one — correctly does **not**
   declare image output; this is recorded as a baseline fact, not treated as
   a defect.
3. **`get_config`/`set_config` expose browser configuration keys only, never
   provider credentials.** The `CONFIG_SCHEMA` object literal in
   `extension/background.js` is extracted and its top-level keys enumerated
   programmatically (not hand-copied): `humanize`, `humanize_speed`,
   `audit_mode`. None of these match a credential-shaped pattern
   (`key|token|secret|credential|password|bearer|anthropic|auth`). This is
   the concrete evidence behind design.md's "SDK-facing get_config/set_config
   may access existing browser configuration only, never provider secrets."

## How to regenerate the snapshot

The snapshot is generated from the live registry + live handler source, not
hand-maintained. If a future change intentionally adds/removes a tool or
changes its schema or result shape, regenerate
`test/fixtures/registry-baseline.json` from `host/tool-definitions.js` and
`extension/background.js` using the same extraction logic embedded in
`test/registry-baseline.test.mjs` (`buildLiveSnapshot()`), then re-run the
suite to confirm it's clean. The suite itself never writes the snapshot — it
only reads and compares, so a stale snapshot fails loudly with a readable
per-field diff instead of silently passing.

## Captured test output

```
$ node test/registry-baseline.test.mjs
== Registry enumeration (host/tool-definitions.js, imported live) ==
  Live registry has 26 entries: tabs_context_mcp, tabs_create_mcp, debug_timings, tabs_close_mcp, navigate, computer, find, form_input, get_page_text, gif_creator, javascript_tool, read_console_messages, read_network_requests, read_page, resize_window, shortcuts_list, shortcuts_execute, switch_browser, update_plan, debug, get_config, set_config, set_tab_focus, upload_image, retranscribe_recording, file_upload
  PASS live registry has exactly 26 entries (design.md's claimed count) — actual: 26
  PASS every tool design.md lists is present in the live registry
  PASS no live tool is absent from design.md's list
  PASS no duplicate tool names in the live registry
  NOTE: host/tool-definitions.js line 1 says "The 25 ... tool definitions" but the TOOLS array has 26 entries. Stale comment, out of scope to edit here.

== Table-driven baseline: live registry vs committed snapshot (.../test/fixtures/registry-baseline.json) ==
  PASS computer: matches baseline snapshot (2 required / 11 optional arg(s), declares image output)
  PASS debug: matches baseline snapshot (0 required / 6 optional arg(s))
  PASS debug_timings: matches baseline snapshot (0 required / 2 optional arg(s))
  PASS file_upload: matches baseline snapshot (3 required / 0 optional arg(s))
  PASS find: matches baseline snapshot (2 required / 0 optional arg(s))
  PASS form_input: matches baseline snapshot (3 required / 0 optional arg(s))
  PASS get_config: matches baseline snapshot (0 required / 1 optional arg(s))
  PASS get_page_text: matches baseline snapshot (1 required / 0 optional arg(s))
  PASS gif_creator: matches baseline snapshot (2 required / 3 optional arg(s), currently a stub handler)
  PASS javascript_tool: matches baseline snapshot (3 required / 0 optional arg(s))
  PASS navigate: matches baseline snapshot (2 required / 0 optional arg(s))
  PASS read_console_messages: matches baseline snapshot (1 required / 4 optional arg(s))
  PASS read_network_requests: matches baseline snapshot (1 required / 3 optional arg(s))
  PASS read_page: matches baseline snapshot (1 required / 4 optional arg(s))
  PASS resize_window: matches baseline snapshot (3 required / 0 optional arg(s))
  PASS retranscribe_recording: matches baseline snapshot (1 required / 0 optional arg(s))
  PASS set_config: matches baseline snapshot (2 required / 1 optional arg(s))
  PASS set_tab_focus: matches baseline snapshot (1 required / 1 optional arg(s))
  PASS shortcuts_execute: matches baseline snapshot (1 required / 2 optional arg(s), currently a stub handler)
  PASS shortcuts_list: matches baseline snapshot (1 required / 0 optional arg(s), currently a stub handler)
  PASS switch_browser: matches baseline snapshot (0 required / 0 optional arg(s))
  PASS tabs_close_mcp: matches baseline snapshot (0 required / 2 optional arg(s))
  PASS tabs_context_mcp: matches baseline snapshot (0 required / 1 optional arg(s))
  PASS tabs_create_mcp: matches baseline snapshot (0 required / 0 optional arg(s))
  PASS update_plan: matches baseline snapshot (2 required / 0 optional arg(s))
  PASS upload_image: matches baseline snapshot (3 required / 1 optional arg(s))

== Preservation properties (design.md section 6) ==
  PASS at least one legacy 'mcp'-suffixed compatibility alias is present: tabs_context_mcp, tabs_create_mcp, tabs_close_mcp
  PASS legacy alias 'tabs_context_mcp' present in the registry
  PASS legacy alias 'tabs_create_mcp' present in the registry
  PASS legacy alias 'tabs_close_mcp' present in the registry
  PASS computer handler declares MCP image content (screenshot/zoom/scroll actions)
  PASS upload_image handler does not itself emit image content (it consumes a previously captured screenshot — baseline fact, not a defect)
  PASS gif_creator is currently an unimplemented stub in this build (baseline must record this truthfully, not assume real GIF export)
  PASS shortcuts_list/shortcuts_execute are currently unimplemented stubs in this build
  PASS CONFIG_SCHEMA declares recognized settings: humanize, humanize_speed, audit_mode
  PASS no provider-credential-shaped key is reachable through get_config/set_config

ALL REGISTRY BASELINE TESTS PASSED
```

Drift detection was manually verified: temporarily corrupting one entry in
the committed snapshot (adding a fake required field to `computer`) produced
`FAIL computer: DRIFTED from baseline snapshot` with an `expected:`/`actual:`
diff and a nonzero exit code; the snapshot was restored to the clean
regenerated version before finishing this task.

## Existing suites re-verified (no regressions)

```
$ node test/handlers.test.mjs
ALL HANDLER TESTS PASSED

$ node host/test/endpoint.test.mjs
7/7 passed

$ node host/test/ownership.test.mjs
12/12 passed
```

## Explicitly out of scope for this task (left for later)

- **Mapping friendly SDK-facing operations to preserved executor contracts**
  (the second half of task 6.1). There is no SDK adapter yet (`host/agent/`
  does not exist), so there is nothing to map friendly names onto. Building
  this now would mean inventing the adapter's shape ahead of task group 3,
  which is explicitly not this task's job.
- **The borrowed-tab scope extension from design section 5b.** Same
  dependency: it requires the per-run borrowed-tab scope validation that task
  3.4/5.6 will add. The current registry's `tabId` semantics (managed tab
  group membership) are captured as-is in the baseline; the extension is not
  simulated or stubbed.
- **Any live browser round trip** (real screenshots, real tab creation/
  navigation/side effects, real GIF export, real shortcut execution). No
  browser or native host was available in this session. This belongs to task
  6.4's "Run representative read/action/vision flows plus every registry
  fixture" work.

## Files touched

- `test/registry-baseline.test.mjs` (new)
- `test/fixtures/registry-baseline.json` (new, committed snapshot)
- `openspec/changes/migrate-to-claude-agent-sdk/reports/06-registry-baseline.md` (this file)

No files outside this list were modified. `host/tool-definitions.js`,
`host/tool-runtime.js`, `host/codemode/common.js`, and `extension/background.js`
were read for analysis only, never edited.
