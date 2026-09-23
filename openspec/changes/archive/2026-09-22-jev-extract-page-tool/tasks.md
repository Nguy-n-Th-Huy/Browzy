## 1. Text-model-only config resolver

- [x] 1.1 In `host/agent/settings/profile.js`, add `resolveJevExtractPageConfig(profileId)`: require `providerType ∈ {anthropic, chatgpt}` and a configured text model (base URL + model id + text-model key); do NOT require `typesafeDecisionSource === "openai"`. Return `{ textModel }` (resolved text model + its key) or `null`. Reuse `resolveTypesafeDecisionModel`/`readTypesafeKeys`; gate on the text-model key specifically. No persisted-shape change. ← (verify: returns null when text model or its key missing; does NOT require openai decision source; never returns for a typesafe-only profile path)

## 2. Text-model extraction call

- [x] 2.1 In `host/agent/jev/text-helper.js`, extract via the text model. Prefer reusing the existing `postMemoryRequest`-style path; only if it cannot carry a caller-supplied field schema + per-field-nullable parsing, add ONE minimal exported `requestPageExtract({ textModel, instruction, fields, page, ... })` following the same `decisionWire`/timeout/bounded-retry/no-secret-logging discipline, with a `parse` that validates against the caller schema and maps type mismatches to `null`. Do not weaken existing structured-output guards. ← (verify: no secret logging; malformed output raises a bounded named failure, never a fabricated object)

## 3. The extract_page tool

- [x] 3.1 Create `host/agent/tools/extract-page.js` (factory following `host/agent/tools/browser-subgoal.js`). Validate the request: `instruction` non-empty string; `fields` non-empty, bounded count (≤20) and nesting (≤3); each `name` matches `/^[A-Za-z][A-Za-z0-9_]{0,63}$/`, `type` in {string,number,boolean,url,object,array}, bounded `description`; `object` requires `properties`, `array` requires `items`. Invalid → bounded validation failure, no model call.
- [x] 3.2 Observe the bound tab through the existing `page_snapshot` path via `toolBridge` (no second snapshot mechanism); call the text model (task 2) with the fixed untrusted-content/return-null system prompt + caller instruction + fields + observation.
- [x] 3.3 Validate output against a schema derived from caller fields (each nullable); type mismatch → `null`; structurally invalid response → bounded named failure. Read-only: no approval card, no browser dispatch. Return `{ ok:true, fields }` or `{ ok:false, error }` (no secrets); outer run continues either way. ← (verify: page-supplied names/instructions cannot add/rename a field; only caller keys returned; failure carries no secrets)

## 4. Conditional registration

- [x] 4.1 In `host/agent/companion.js`, register `extract_page` in the `createBrowserMcpServer` `extraTools` for `anthropic`/`chatgpt` runs ONLY when `resolveJevExtractPageConfig` returns non-null. Absent → not registered, no error. Never for a `typesafe` run. ← (verify: silent absence when text model unconfigured; not offered to typesafe runs)

## 5. Tests

- [x] 5.1 New `host/test/jev-extract-page.test.mjs`: resolver eligibility (text model present vs missing key/base/id; openai decision source NOT required); tool present when eligible, absent (no error) otherwise and for typesafe runs; request validation (bad name, over-count, over-nesting, missing instruction/fields, object without properties, array without items); schema built only from caller fields; page-supplied names/instructions cannot inject fields; missing evidence → null; type mismatch → null; malformed model output → bounded named failure; transport failure → bounded named failure, outer run continues; no secret leakage in any failure. Follow existing host/test/jev-*.test.mjs conventions. ← (verify: every spec scenario has a test; null-vs-failure distinction covered)
- [x] 5.2 Run `node --test host/test/jev-*.test.mjs` and `openspec validate jev-extract-page-tool --strict`; report actual output. Report failures in unowned files (parallel-session work) without editing them ← (verify: in-scope tests green; pre-existing out-of-scope failures noted with ownership)
