## 1. Schema + persistence

- [x] 1.1 In `host/agent/settings/profile-schema.js`, add `jevToolsSendScreenshots` (boolean, default `false`) to `createEmptyProfile` and the profile validator, distinct from `sendScreenshots`.
- [x] 1.2 In `host/agent/settings/profile.js` `setTypesafeConfig` (and the `set_typesafe_config` companion envelope if not pass-through), accept and persist `jevToolsSendScreenshots` as a boolean (invalid non-boolean rejected like the existing `sendScreenshots`). ← (verify: persisted as boolean; absent stays default false; primary/typesafe sendScreenshots untouched)

## 2. Resolver default-off

- [x] 2.1 In `host/agent/settings/profile.js` `resolveJevBrowserSubgoalConfig`, source `sendScreenshots` from `jevToolsSendScreenshots` (default `false`) instead of `resolveSendScreenshots(profile)`. Leave Jev's decision inputs and other resolver fields unchanged. `resolveJevExtractPageConfig` is unaffected in behavior (extract_page ignores screenshots). ← (verify: a profile with the toggle unset yields sendScreenshots=false for the browser_subgoal sub-run; setting it true yields true; standalone typesafe path unchanged)

## 3. Settings UI toggle

- [x] 3.1 In `extension/settings/settings.html`, add a "Gửi ảnh chụp màn hình" checkbox (`#jevtools-send-screenshots`, unchecked by default) inside `#jevtools-fields`, with copy noting Jev decides from structured page state and the screenshot is optional planning evidence.
- [x] 3.2 In `extension/settings/settings-controller.js` + `settings-client.js` + `settings-app.js`, wire the checkbox to persist `jevToolsSendScreenshots` via the existing `saveJevTools()` path; render its saved state; default unchecked. ← (verify: toggle shows in the Jev-tools section on anthropic/chatgpt; saving persists the boolean; primary provider config untouched)

## 4. Tests

- [x] 4.1 Host test: `resolveJevBrowserSubgoalConfig` yields `sendScreenshots=false` when the toggle is unset and `true` when set; `setTypesafeConfig` persists the boolean; the standalone `typesafe` `sendScreenshots` and `extract_page` are unaffected. Follow existing host/test conventions.
- [x] 4.2 Settings test: the Jev-tools screenshot toggle renders, defaults unchecked, and saves via the existing envelope without touching primary config. Follow existing test/settings-ui conventions.
- [x] 4.3 Run the relevant host/test + test/settings-ui suites and `openspec validate jev-subgoal-screenshots-default-off --strict`; report actual output; report unowned parallel-session failures without editing them.
