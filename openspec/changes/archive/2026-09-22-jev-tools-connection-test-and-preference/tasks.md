## 1. Host: Jev-tools capability test

- [x] 1.1 In `host/agent/settings/profile.js`, add a Jev-tools capability test that resolves the profile's Jev config (via `resolveJevExtractPageConfig` for the text model and `resolveJevBrowserSubgoalConfig` for decision+text+transport) and runs the existing `capability-test.js` sub-tests against it (reuse `testCapabilityForTypesafe`'s core; adapt the resolved config into the shape those sub-tests need without persisting anything). Validate the text model always; validate the decision model + transport only when the full config resolves. Return a bounded, secret-free result naming which tool(s) are enabled and any classified failure. ← (verify: no secret in the result/logs; extract_page-only vs browser_subgoal-capable distinguished; reuses capability-test.js, no second transport)
- [x] 1.2 In `host/agent/companion.js`, extend the `test_capability` envelope (~2506) with an optional `target: "jev-tools"` routed to the new test (absent target = existing behavior, byte-for-byte). ← (verify: existing test_capability callers unaffected)

## 2. Settings UI: test affordance

- [x] 2.1 In `extension/settings/settings.html`, add a "Kiểm tra kết nối Jev" button and a result/disclosure line inside `#jevtools-fields`, mirroring the primary test button + `test-disclosure-*` markup. Distinct ids.
- [x] 2.2 In `extension/settings/settings-controller.js` + `settings-client.js`, add a handler that sends the `test_capability` envelope with `target: "jev-tools"` for the current profile and renders success/failure (including which tool(s) enabled), reusing the existing capability-test result rendering. Never render a secret. In `settings-app.js`, wire the button and show the result only for anthropic/chatgpt profiles. ← (verify: button visible only in the Jev-tools section on anthropic/chatgpt; result shows pass/fail; no secret rendered; primary test untouched)

## 3. Preference nudge

- [x] 3.1 In `host/agent/tools/query-options.js`, append a preference instruction to `systemPromptText` ONLY when `extraToolNames` includes `browser_subgoal` and/or `extract_page`, naming only the present tool(s) (prefer `browser_subgoal` for interactions, `extract_page` for structured reads, over inline native tools; native tools remain for uncovered cases). When neither is present, append nothing — the prompt stays byte-for-byte unchanged. ← (verify: nudge present iff the tool is in extraToolNames; never names an absent tool; existing browser-automation guidance unchanged)

## 4. Tests

- [x] 4.1 Host test: the Jev-tools capability test validates the resolved config, distinguishes extract_page-only vs browser_subgoal-capable, returns bounded named success/failure, and leaks no secret. Follow existing host/test conventions.
- [x] 4.2 query-options.js test: the preference instruction appears when `browser_subgoal`/`extract_page` are in `extraToolNames` and is absent (prompt unchanged) when neither is; an absent tool is never named. 
- [x] 4.3 Settings-controller test: the test button triggers the `target: "jev-tools"` envelope and renders success/failure; no secret rendered. ← (verify: every spec scenario has a test)
- [x] 4.4 Run the relevant host/test and test/settings-ui suites plus query-options tests; report actual output; report unowned parallel-session failures without editing them. Run `openspec validate jev-tools-connection-test-and-preference --strict`.
