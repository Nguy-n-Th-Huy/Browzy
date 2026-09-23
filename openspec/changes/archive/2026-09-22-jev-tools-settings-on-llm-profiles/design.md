## Context

The Settings provider section (`extension/settings/settings-app.js`, render logic ~616-660) toggles blocks by provider type:
- `$("typesafe-fields").hidden = !isTypesafe` hides the entire Jev block unless `providerType === "typesafe"`.
- The primary base URL and key inputs (`#provider-baseurl-item`, `#anthropic-key-item`, `#key-input`) are multiplexed across provider types (comments at ~29-44, logic at ~616-656) — e.g. the base URL field doubles as a `typesafe` profile's Jev endpoint, and the key input relabels per decision source.

The host already persists Jev fields on any profile (`typesafeSource`, `typesafeDecisionSource`, `textModelBaseUrl`, `textModelId`, secrets), and the just-shipped resolvers gate the tools:
- `resolveJevBrowserSubgoalConfig`: requires `anthropic`/`chatgpt` + `typesafeDecisionSource === "openai"` + text model + transport + keys.
- `resolveJevExtractPageConfig`: requires `anthropic`/`chatgpt` + text model + text-model key only.

`set_typesafe_config` / `set_typesafe_credentials` (companion.js ~2753-2823) already accept these on any profile with no provider-type gate.

## Goals / Non-Goals

**Goals:**
- Give `anthropic`/`chatgpt` profiles a UI to enter the Jev-tools config the host already reads.
- Keep the primary Anthropic/ChatGPT config and the `typesafe` block untouched.
- Secrets isolated; availability authority stays with the host gate.

**Non-Goals:**
- Reusing/multiplexing the primary base URL or key inputs for Jev.
- Changing the host gate, the accepted decision sources, or tool runtime behavior.
- Any change to the standalone `typesafe` provider block.

## Decisions

1. **A distinct section with its own inputs.** Add a new "Jev browser tools" section in settings.html with input ids separate from both the primary provider inputs and the existing `typesafe-fields` ids (e.g. `jevtools-*`). It is NOT the `typesafe-fields` block un-hidden — that block is bound to the `typesafe` primary-provider flow and its multiplexed fields; reusing it on an LLM profile would collide with the primary Anthropic/ChatGPT config. Distinct ids keep the two flows independent.

2. **Visibility.** In settings-app.js render, show the new section when `providerType === "anthropic" || providerType === "chatgpt"`, and keep it hidden for `typesafe` (whose own `typesafe-fields` block is unchanged). This is a new `hidden` toggle beside the existing ones; it does not alter the existing `isTypesafe`/`isChatgpt` branches.

3. **Grouping mirrors the gates.** Two labelled groups, not three: Text model (base URL, model id, text-model key — enables `extract_page`); Transport (source, endpoint hint, transport key). There is no separate "decision model" group: `resolveJevBrowserSubgoalConfig`'s `openai` decision source reuses `textModelBaseUrl`/`textModelId` as the decision model (never `typesafeDecisionBaseUrl`/`typesafeDecisionModelId`), so the Text model group doubles as the fixed-`openai` decision model. Saving Text model + Transport together (decision source sent as the fixed, non-editable `openai`) is what additionally enables `browser_subgoal`. Copy states which group enables which tool and that the text model also serves as the decision model for `browser_subgoal`. No decision-source control is offered in this section — it is not a user choice, it is fixed to `openai` by what the gate accepts.

4. **Persistence via existing envelopes.** settings-controller.js maps the new fields to the existing `set_typesafe_config` (non-secret: transport source, text-model base URL and model id, decision source sent as the fixed `openai`) and `set_typesafe_credentials` (transport/typesafe key, text-model key) calls used today, targeted at the current profile. No decision-model base URL/model id and no separate decision key are sent — there is no such field in this section. No new envelope, no schema change. If a field the resolvers need cannot be written through the existing envelopes, STOP and surface it rather than adding a host path.

5. **Secret handling.** Each key input follows the existing pattern: placeholder "Nhập API key mới…", a saved-state line and a clear-key action, value written to the secret store via `set_typesafe_credentials`, never read back into the DOM. Reuse the existing key-item rendering helpers where possible.

6. **Honesty.** The UI labels which tool each group enables but shows no "active/enabled" claim — the host gate decides. Partial entry simply leaves the tool absent at runtime.

## Risks / Trade-offs

- [Colliding with the multiplexed primary inputs] → Avoided by using entirely separate `jevtools-*` ids and never touching `#provider-baseurl-item`/`#anthropic-key-item`/`#key-input`.
- [Duplicated field logic between this section and `typesafe-fields`] → Accepted: independence is safer than sharing a block bound to a different provider flow; shared rendering helpers are reused where they don't couple the two flows.
- [Parallel-session edits in extension/ and host/] → This change is extension/settings/* only; the extract_page/browser_subgoal host work is disjoint. Build on current contents; revert nothing.
- [The existing envelopes might not carry a needed field] → Confirm at implement time; if a gap exists, STOP and surface rather than adding a host path (out of scope).

## Migration Plan

Additive and opt-in. Existing profiles show the new section empty and behave exactly as before. Rollback = remove the section markup, its render toggle, and its controller handlers.

## Open Questions

None blocking. One confirm-at-implement: whether `set_typesafe_config`/`set_typesafe_credentials` already carry every field the two resolvers read (they should, per the archived jev-browser-subgoal-tool findings); if not, surface it.
