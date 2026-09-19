# Tasks: add-jev-run-screenshots

## 1. Capture and attachment (host)

- [x] 1.1 `runtime.js`: when enabled, capture the bound tab once per cycle after the observation (`computer { action: "screenshot", tabId, annotate: false }` through the same bridge, host-side checks only, no approval); extract the image item; any failure (refused check / capture error / lost response) drops the image and the cycle proceeds text-only
- [x] 1.2 `runtime.js`: pass the cycle's image into the step-decision call and carry the `DONE` cycle's image into the completion check (reuse, no second capture); the toggle-off path makes every request text-only
- [x] 1.3 `text-helper.js`: multimodal user-content builder for the step decision and the completion check — `[{type:"text",...}, {type:"image_url", image_url:{url:"data:<mime>;base64,<data>"}}]` when an image exists, byte-identical string content otherwise; validators and failure mappings unchanged ← (verify: message shapes for image/text paths; no change to instruction text, bounds, or parsing)
- [x] 1.4 `companion.js` + `profile.js`/`profile-schema.js`: the non-secret `sendScreenshots` field (absent loads as enabled) in the snapshot and through the runtime's `provider` object
- [x] 1.5 Host tests: capture on/off/failure/lost-response; image attached to the decision; completion-check reuse; disabled = text-only everywhere ← (verify: a failed capture never changes any terminal outcome; the element-selection request never carries an image)

## 2. Capability image stage (host)

- [x] 2.1 `capability.js`: third stage — one minimal multimodal completion carrying a small embedded PNG under the text stage's instruction/goal, parsed by the same single-key validator; result gains `capabilities.image` / `errors.image`; `status` stays decided by `systemone` + `textModel`
- [x] 2.2 `text-helper.js`: the vision-probe request builder (same transport/reasoning rules, image attached) + tests for the stage and the result shape ← (verify: image failure is distinguishable from text-model failure; an image-failed profile remains runnable; stored old results read as image-not-tested)

## 3. Settings surface (host + extension)

- [x] 3.1 Host settings: `set_typesafe_config` accepts and persists `sendScreenshots`; snapshot exposes it; settings tests
- [x] 3.2 Extension settings: toggle in the typesafe block (`settings.html`) with a vision hint; controller/client read+write it; the image stage renders separately with its own copy (`errors-ui.js`); copy stays inside the connection-gate regex windows; UI tests ← (verify: toggle round-trips; old profiles show it enabled; stage copy names the image stage distinctly)

## 4. Docs

- [x] 4.1 README: the Jev section gains the screenshots (per-cycle capture, toggle, the test's image stage, cost/privacy notes) and the side-panel wording where it lists the model's request families ← (verify: README claims match the shipped behavior; disclosure wording matches the agent-settings delta)

## 5. Focused suites and validation

- [x] 5.1 Run the focused suites (`cd host && node --test test/jev-*.test.mjs test/agent-typesafe-run.test.mjs test/settings-typesafe.test.mjs`; from root `node --test test/sidepanel-*.test.mjs test/settings-*.test.mjs test/extension-scripts-parse.test.mjs`) and `openspec validate add-jev-run-screenshots --strict` — done: all green in the verification round; validate strict valid ← (verify: green; only in-scope files edited)
