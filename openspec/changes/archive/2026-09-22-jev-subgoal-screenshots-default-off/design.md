## Context

- `runtime.js` captures a screenshot only when `provider.sendScreenshots === true` (`capturePage()` in `prepare()`), and it goes to the configured planning/content model — never to Jev's decision request (`questions.js`/`client.js` carry no image).
- `resolveJevBrowserSubgoalConfig` (host/agent/settings/profile.js) sets `sendScreenshots: resolveSendScreenshots(profile)` — the profile-level toggle, which defaults ON for existing profiles. That is why a `browser_subgoal` sub-run screenshots by default.
- `resolveJevExtractPageConfig` also carries `sendScreenshots`, but `extract_page`/`requestPageExtract` never captures an image, so it is irrelevant there.
- The `#send-screenshots` toggle exists in settings.html but inside the `typesafe-fields` block (typesafe profiles only). The `#jevtools-fields` section has no screenshot toggle.
- Persistence goes through `set_typesafe_config` (non-secret) which already carries flat profile fields.

## Goals / Non-Goals

**Goals:**
- Default `browser_subgoal` sub-runs to no screenshot; make it opt-in via a Jev-tools toggle.
- Keep the primary/typesafe screenshot setting and Jev's decision inputs unchanged.

**Non-Goals:**
- Changing what Jev's decision receives (already image-free).
- Touching the standalone `typesafe` screenshot toggle or `extract_page`.

## Decisions

1. **New profile field `jevToolsSendScreenshots` (boolean, default `false`).** Added to `profile-schema.js` (createEmptyProfile + validator), distinct from the profile-level `sendScreenshots`. Absent/unset resolves to `false` — a browser_subgoal sub-run is text-only unless the operator opts in.

2. **Resolver reads the new field.** `resolveJevBrowserSubgoalConfig` sets `sendScreenshots` from `jevToolsSendScreenshots` (default `false`), NOT `resolveSendScreenshots(profile)`. `resolveJevExtractPageConfig` may drop `sendScreenshots` or keep it harmless (extract_page ignores it) — leave it as whatever is simplest without behavior impact.

3. **Persistence via the existing envelope.** `setTypesafeConfig`/`set_typesafe_config` accepts and persists `jevToolsSendScreenshots` as a boolean like the existing `sendScreenshots`. No new envelope.

4. **UI.** Add a "Gửi ảnh chụp màn hình" checkbox (`#jevtools-send-screenshots`, unchecked by default) to `#jevtools-fields`, wired in settings-controller.js to persist `jevToolsSendScreenshots` via `saveJevTools()`. Copy notes it is off by default because Jev decides from structured page state and the screenshot is only extra evidence for the planning model.

## Risks / Trade-offs

- [Existing configured profiles lose screenshots for subgoals] → Intended: default off matches the user's request; opt back in with the toggle.
- [A new persisted field] → Additive with a documented default; old profiles read `false` (their sub-runs go text-only, the desired behavior).
- [Parallel-session edits] → Additive, localized; build on current contents, revert nothing.

## Migration Plan

Additive. Old profiles read `jevToolsSendScreenshots` as `false` (text-only sub-runs). Rollback = remove the field, restore `resolveSendScreenshots(profile)` in the subgoal resolver, and drop the UI toggle.

## Open Questions

None.
