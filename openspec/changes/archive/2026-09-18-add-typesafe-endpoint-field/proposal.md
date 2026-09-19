# Proposal: TypeSafe Endpoint Field (edit the Jev endpoint in Settings)

## Why

Found live: a `typesafe` profile whose endpoint had been carried over as a custom URL from an earlier `anthropic` configuration (a personal gateway) could never be pointed at a service that speaks either Jev wire — the settings UI exposes **no endpoint field** for this provider, and the host deliberately redirects only KNOWN default endpoints when the source changes. Source switches therefore left the custom URL untouched and unreachable, so both wires failed the capability test with no way out through the UI. The endpoint is the one knob the operator must be able to set for this provider; hiding it was the gap.

## What Changes

- **The endpoint is editable.** For a `typesafe` profile, Settings shows the endpoint the provider's own requests use (the same `profile.baseUrl` value, under its own label — "Điểm cuối Jev" — dynamically naming the selected source: TypeSafe API or Vercel AI Gateway). It is prefilled with the profile's current endpoint, validated as a well-formed HTTPS URL under the existing rules, and persisted with the profile; a run or capability test uses exactly it.
- **The existing source rule is kept and made visible.** A source change still moves the endpoint to the new source's documented default (`https://api.typesafe.ai` ↔ `https://ai-gateway.vercel.sh`) **only while it is a known default**, and leaves any other endpoint untouched — and the page now mirrors that rule locally so the field shows what will be saved.
- **Key labels follow the source.** The remove action for the provider key names the selected source's key ("Xóa key TypeSafe" / "Xóa key Vercel AI Gateway"), matching the key field's own label and status line.
- **Copy.** The source hint says the endpoint is editable and names the source default; README notes it.
- **Unchanged**: the wire behaviour of either source; the profile schema (the endpoint already lives in `profile.baseUrl`); the `set_typesafe_config`/`saveProfile` ops (both already accept the endpoint); secret handling; `anthropic`/`chatgpt` surfaces.

## Capabilities

### New Capabilities
- (none — the change extends existing capabilities)

### Modified Capabilities
- `typesafe-jev-provider`: the provider-type requirement's exposed-field list gains the editable endpoint (prefilled; source default named; custom endpoints preserved across source changes and now reachable for editing).
- `agent-settings`: the TypeSafe profile's field list gains the editable endpoint field, its API-key bullet names the selected source, and a scenario pins that editing the endpoint persists it and drives tests/runs.

## Impact

- **Extension**: `extension/settings/settings.html` (expose + relabel the endpoint field for typesafe; dynamic hint/placeholder; label fix for the key-remove action), `extension/settings/settings-app.js` (visibility + dynamic labels + source-change mirroring of the default remap), `extension/settings/settings-controller.js` (draft/read/write already exists for `baseUrl` — wire it for the typesafe path), and their test suites.
- **Host**: expected none — `saveProfile`/`setTypesafeConfig` already persist and validate `baseUrl`; its tests stay as the guard and are re-run.
- **Docs/specs**: README (the Jev section's endpoint sentence), the two capability deltas above.
