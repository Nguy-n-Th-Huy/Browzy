## Context

- `testCapability(profileId, modelId)` (host/agent/settings/profile.js:1676) branches: `chatgpt` → `testCapabilityForChatgpt` (primary provider), `typesafe` → `testCapabilityForTypesafe` (Jev decision + text model via host/agent/settings/capability-test.js). No branch tests the Jev config attached to an `anthropic`/`chatgpt` profile.
- The Jev config on an LLM profile is resolved by `resolveJevBrowserSubgoalConfig` (full: openai decision + text + transport) and `resolveJevExtractPageConfig` (text model only), both added in prior changes.
- The `test_capability` companion envelope (companion.js:2506) delegates to `settings.testCapability`.
- The "Jev browser tools" settings section (`#jevtools-fields`, extension/settings) has Save but no test affordance.
- The SDK-run system prompt is assembled in host/agent/tools/query-options.js (~742: `renderBrowserAutomationSystemPrompt(serverName)` + page/upload blocks). query-options.js already receives `extraToolNames` (used to qualify tool names ~766), so it knows which extra tools are registered for this run.

## Goals / Non-Goals

**Goals:**
- Let a user verify the Jev-tools config from Settings with a clear pass/fail.
- Make the model actually prefer `browser_subgoal`/`extract_page` when they are available.

**Non-Goals:**
- Changing the gates/resolvers, accepted decision sources, tool runtime, or the standalone `typesafe` path.
- Forcing the model to use the tools (guidance, not a hard constraint) — the native tools remain available.

## Decisions

1. **Jev-tools capability test reuses the typesafe core.** Add `testCapabilityForJevTools(profile, ...)` (or a target-parameterized branch) in profile.js that resolves the Jev config with the existing resolvers and runs the SAME `capability-test.js` sub-tests `testCapabilityForTypesafe` uses, but against the Jev-tools-resolved decision/text model rather than a `typesafe` primary profile. The text-model path (extract_page) is validated whenever the text model resolves; the decision model + transport (browser_subgoal) are validated additionally when `resolveJevBrowserSubgoalConfig` is non-null. The result names which tool(s) are enabled and carries a bounded, secret-free failure message. No new provider transport is invented.

2. **Envelope.** Extend `test_capability` with an optional `target: "jev-tools"` (default = existing behavior) OR add a sibling op `test_jev_tools_capability`. Prefer extending `test_capability` with a target so the extension reuses the existing result-handling path. The host routes `target: "jev-tools"` to `testCapabilityForJevTools`.

3. **Settings UI.** In `#jevtools-fields` add a "Kiểm tra kết nối Jev" button and a disclosure/result line, mirroring the existing primary test button + `test-disclosure-*` pattern. settings-controller.js adds a handler that sends the test envelope for the current profile and renders success/failure (which tools enabled), reusing the existing capability-test result rendering. No secret is rendered.

4. **Preference nudge, strictly conditional.** In query-options.js, after assembling `systemPromptText`, append a short preference instruction ONLY when `extraToolNames` includes `browser_subgoal` and/or `extract_page`. The text names only the present tool(s): prefer `browser_subgoal` for interactions, `extract_page` for structured reads, over doing them inline; the native tools remain for cases the Jev tools do not cover. When neither is present, nothing is appended and the prompt is byte-for-byte unchanged. This is additive guidance, not a constraint, and never references an absent tool.

## Risks / Trade-offs

- [The test spends provider credits] → Same as the existing capability test; documented in copy, run only on the user's click.
- [The nudge over-steers the model] → It is guidance, not enforcement; native tools stay available, and it is scoped to registered tools only.
- [Extending test_capability changes an existing envelope] → Keep it backward compatible: absent `target` preserves current behavior exactly.
- [Parallel-session edits across host/ and extension/] → Additive, localized; build on current contents, revert nothing.

## Migration Plan

Additive. No new persisted state. Rollback = remove the test branch/envelope target, the settings button/handler, and the conditional prompt append.

## Open Questions

None blocking. One confirm-at-implement: whether `capability-test.js`'s sub-tests can be pointed at the Jev-tools-resolved config without a `typesafe` profile object (decision 1); if a `typesafe`-shaped input is required, adapt the resolved config into that shape without persisting it.
