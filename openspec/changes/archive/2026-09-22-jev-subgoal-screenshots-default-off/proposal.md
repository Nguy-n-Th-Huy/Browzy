## Why

Jev selects actions from the structured `page_snapshot` (control table + text) and never receives a screenshot — the decision request carries no image. Screenshots are captured only for the configured planning/content model, and only when the profile's "send screenshots" toggle is on. On an `anthropic`/`chatgpt` profile a `browser_subgoal` sub-run inherits the profile-level screenshot toggle, which defaults ON, so every sub-run captures a screenshot for its planning call — extra latency and cost that Jev itself does not use. There is also no toggle in the "Jev browser tools" settings section to turn it off. The user wants the Jev sub-run to act fast without screenshots, with an opt-in to re-enable.

## What Changes

- A `browser_subgoal` sub-run on an `anthropic`/`chatgpt` profile SHALL default to **no screenshot capture**, controlled by a new, Jev-tools-specific toggle that is off by default and independent of the profile's primary/typesafe screenshot toggle. Jev's action selection is unchanged (it never used the image); only the optional planning-model screenshot is dropped by default.
- A "Gửi ảnh chụp màn hình" checkbox is added to the "Jev browser tools" settings section, unchecked by default, persisted through the existing config envelope. Checking it re-enables screenshot capture for the sub-run.
- `extract_page` is unaffected (it is read-only and never captures a screenshot).
- No change to Jev's decision inputs, the tool gates/resolvers' other fields, tool runtime guards, or the standalone `typesafe` screenshot toggle.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `agent-settings`: the Jev browser-tools configuration gains a screenshot toggle that is off by default and controls only the `browser_subgoal` sub-run's optional screenshot capture, separate from the primary/typesafe screenshot setting.

## Impact

- `host/agent/settings/profile-schema.js`: a new profile field (e.g. `jevToolsSendScreenshots`, boolean, default `false`) with its validator.
- `host/agent/settings/profile.js`: `resolveJevBrowserSubgoalConfig` sources `sendScreenshots` from the new Jev-tools toggle (default `false`) instead of the profile-level `resolveSendScreenshots`; the `set_typesafe_config` writer accepts and persists the new field.
- `host/agent/companion.js`: the `set_typesafe_config` envelope carries the new toggle if it is not already pass-through.
- `extension/settings/settings.html`, `settings-app.js`, `settings-controller.js`, `settings-client.js`: a "Gửi ảnh chụp màn hình" checkbox in `#jevtools-fields`, unchecked by default, wired to persist the new field.
- Tests: resolver defaults screenshots off unless the toggle is set; the toggle persists via the existing envelope; the settings section renders and saves it; `extract_page` path unaffected.
- Out of scope: Jev's decision inputs, the standalone `typesafe` screenshot toggle, other resolver fields, tool runtime guards.
