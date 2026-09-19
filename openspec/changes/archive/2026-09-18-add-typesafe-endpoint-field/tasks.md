# Tasks: add-typesafe-endpoint-field

## 1. Extension settings surface

- [x] 1.1 `settings.html` + `settings-app.js`: show the base-url field for a `typesafe` profile with the dynamic label ("Điểm cuối Jev — TypeSafe API" / "— Vercel AI Gateway"), a per-source placeholder, and a hint naming that source's documented default and the "custom endpoint is kept on source change" rule; keep the `anthropic` API-key field hidden
- [x] 1.2 `settings-app.js`/`settings-controller.js`: mirror the host's source-change rule in the draft (a known default follows the source; anything else stays), so the shown value is what a Save persists
- [x] 1.3 Key labels follow the source: field label, status line, and the remove action ("Xóa key TypeSafe" ↔ "Xóa key Vercel AI Gateway")
- [x] 1.4 Tests: endpoint field visible for typesafe / hidden for chatgpt; custom endpoint round-trips through Save; source-change mirror only for known defaults; invalid URL blocks the save with the field error; the three key labels follow the source; connection-gate/scripts-parse pins green ← (verify: the field shows the profile's actual endpoint on load; saving an edited endpoint persists it and a capability test then uses it)

## 2. Host confirmation

- [x] 2.1 Confirm no host change is required (`saveProfile`/`setTypesafeConfig` already validate and persist `baseUrl` for a `typesafe` profile); re-run the host settings suites; if a gap appears, STOP and report instead of patching around it — done: `cd host && node --test test/settings-typesafe.test.mjs test/settings-profile.test.mjs test/agent-settings-relay.test.mjs` green with no host file touched; no gap found ← (verify: `cd host && node --test test/settings-typesafe.test.mjs test/settings-profile.test.mjs test/agent-settings-relay.test.mjs` green without edits)

## 3. Docs

- [x] 3.1 README: the Jev section notes the endpoint is editable (and that a custom endpoint is kept when the source changes) ← (verify: wording matches the shipped behaviour)

## 4. Focused suites and validation

- [x] 4.1 Run the focused suites (`node --test test/settings-ui-controller.test.mjs test/settings-ui-client.test.mjs test/settings-connection-gate.test.mjs test/extension-scripts-parse.test.mjs`) and `openspec validate add-typesafe-endpoint-field --strict` ← (verify: green; only in-scope files edited)
