# Design: TypeSafe Endpoint Field

## Context

- **The trap, found live.** A `typesafe` profile's endpoint is `profile.baseUrl` — a single value shared with the `anthropic` provider type, defaulted per Jev source (`https://api.typesafe.ai` directly, `https://ai-gateway.vercel.sh` through the Vercel AI Gateway) and remapped on a source change **only while it is still a known default** (`profile.js`'s `endpointForProviderSwitch` / `setTypesafeConfig`). A profile that carried a **custom** URL over from an earlier `anthropic` configuration keeps it forever — and the settings page exposes **no endpoint field** for this provider ("the endpoint itself has no free-text field"), so the operator can neither correct nor clear it. Both Jev wires fail, and no UI action can fix it.
- **What already exists and is reusable.** The provider-agnostic `baseUrl` field: `settings-controller.js` holds `baseUrl`/`baseUrlDraft`, validates through `validateBaseUrl`, and `save()` already sends the normalized value in every `saveProfile` call (hidden for `typesafe`, but still sent). The host persists and validates it; `set_typesafe_config` also accepts `baseUrl` (`this client only ever sends it when a caller passes one`). Nothing new is needed on the wire.
- **See proposal.md** for motivation; delta requirements: `typesafe-jev-provider` ("Provider type and configuration surface"), `agent-settings` ("Editable provider profile").

## Goals / Non-Goals

**Goals:**
- A `typesafe` profile's endpoint is visible and editable in Settings: prefilled with the current value, labeled with the selected Jev source, validated under the existing URL rules, persisted on Save, and used by every provider request.
- The existing source-change rule is preserved (a known default follows the source; any other endpoint is untouched) and mirrored in the page so the field always shows what a Save will persist.
- Every key control names the selected source's key, so the field set reads coherently ("Xóa key Vercel AI Gateway" when the Vercel source is selected).

**Non-Goals:**
- No separate per-source key slots (one key slot for the selected source is the shipped design), no auto-detection of the service from the URL, no change to either source's wire or defaults, no host-side behaviour change.

## Decisions

### 1. Expose the shared `baseUrl` value as the provider's endpoint field — no new state, no new op

For a `typesafe` profile the existing base-url field is shown (the `anthropic` API-key field stays hidden) with a dynamic label — "Điểm cuối Jev — TypeSafe API" / "— Vercel AI Gateway" — and a hint that names the selected source's documented default and states that a custom endpoint is kept when the source changes. The draft/validation/save plumbing is already wired (`validateBaseUrl`, `saveProfile`); the change is visibility, labels, and copy. `set_typesafe_config` continues to receive no `baseUrl` (the save path persists it; the host's own remap still runs for callers that omit it).

- *Alternatives rejected*: a second, provider-local endpoint field (two sources of truth for one value); a "reset to default" button alone (helps this trap, but still bars deliberate custom gateways); keeping the field hidden (the gap being fixed).

### 2. The page mirrors the host's source-change rule

When the source select changes: if the current endpoint draft equals a known default (`https://api.typesafe.ai`, `https://ai-gateway.vercel.sh`), the draft and labels move to the new source's default; any other value stays put. This matches `endpointForProviderSwitch`/`setTypesafeConfig` exactly, so "what the page shows" and "what a Save persists" cannot diverge, and a custom endpoint is never silently rewritten in either direction.

### 3. Key labels follow the source

The key field's label, its stored/not-stored status line, and the remove action all name the selected source's key ("Xóa key TypeSafe" ↔ "Xóa key Vercel AI Gateway"), matching the existing dynamic label and status behaviour.

### 4. Tests carry the contract

Controller tests: the endpoint field is visible for `typesafe` (and hidden for `chatgpt` as today), a custom endpoint round-trips through Save, the source-change mirror updates only known defaults, an invalid URL yields the field-level error that blocks the save, and the three key labels follow the source. Connection-gate/scripts-parse pins stay green; the host settings suites are re-run unchanged (no host change expected — if a gap appears, the implementer reports before touching host code).

## Risks / Trade-offs

- **[The field can point a run at a service the stored key is not for]** → both the label and the hint name the selected source and its default; validation is shape-only and the choice is the operator's, explicitly. This restores control that hiding the field had taken away — the accepted trade.
- **[Legacy profiles]** → the field simply shows the current value; nothing is rewritten until a Save, and the source-change rule is unchanged.
- **[Copy length windows]** → new copy stays inside the connection-gate test's existing regex windows, asserted by that suite.
