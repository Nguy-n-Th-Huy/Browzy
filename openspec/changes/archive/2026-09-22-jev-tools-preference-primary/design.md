## Context

`renderJevToolsPreferenceSystemPrompt(serverName, extraToolNames)` (host/agent/tools/query-options.js ~518) returns a bounded guidance block appended to `systemPromptText`, or `null` when neither `browser_subgoal` nor `extract_page` is in `extraToolNames`. It currently uses soft "prefer" wording. The nudge is already gated correctly (present iff the tool is registered; never names an absent tool; `null` → prompt unchanged when neither present), proven by `host/test/jev-tools-preference-nudge.test.mjs`. Only the wording is too weak.

## Goals / Non-Goals

**Goals:**
- Make the registered Jev tool the primary path in the guidance, native tools the explicit fallback.

**Non-Goals:**
- Enforcing tool use or removing/gating the native tools (they stay callable — the fallback must exist).
- Any change to resolvers, gates, tool runtime, or the standalone `typesafe` path.

## Decisions

1. **Wording only.** Rewrite the strings inside `renderJevToolsPreferenceSystemPrompt` to the primary/fallback rule. Keep the exact same conditional structure and return contract: only present tools are named, and `null` is returned when neither is present so `.filter(Boolean).join(...)` leaves `systemPromptText` byte-for-byte unchanged. No signature, gating, or call-site change.
   - `browser_subgoal` line: default to it for every interaction (click/type/select/submit/in-page navigation) by describing the goal; use `computer`/`form_input` only when a `browser_subgoal` attempt fails, is blocked, or cannot express the step; do not fall back to the read_page→find→computer-click pattern for interactions.
   - `extract_page` line: default to it for structured/field reads; use `read_page`/`get_page_text` for free-text/inspection only.
2. **Test update.** Strengthen `host/test/jev-tools-preference-nudge.test.mjs` to assert the primary/fallback semantics (keywords for "primary/default" and "fallback/when it fails"), while keeping the existing assertions: nudge present iff the tool is in `extraToolNames`, absent tool never named, prompt unchanged when neither present, existing browser-automation guidance intact.

## Risks / Trade-offs

- [Over-steering: the model routes something through Jev that a native tool does better] → The wording keeps the native tools as an explicit, legitimate fallback; it is guidance, not enforcement.
- [Still not 100% obeyed] → Prompt guidance is the strongest safe lever without removing the baseline native tools (out of scope); this materially shifts the default.

## Migration Plan

Text-only, additive. Rollback = restore the previous wording.

## Open Questions

None.
