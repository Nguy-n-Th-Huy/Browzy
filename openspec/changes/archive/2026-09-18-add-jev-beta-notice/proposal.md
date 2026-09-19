# Proposal: Jev Beta Notice

## Why

The Jev — ultrafast integration ships as a working third provider type, but it is still a beta surface: its behavior and results can change between releases. Nothing on the surface that offers it says so — the operator picks "Jev — ultrafast" in Settings and configures keys as if it were a settled provider. The disclosure belongs where the choice is made (the provider-type radio, the provider's own section) and in the README that documents the setup path.

## What Changes

- **Settings labels it beta**: a `Beta` badge beside the provider-type choice, and a notice line at the top of the Jev section stating that the integration is in beta and its behavior, quality, and results may change between releases.
- **README says it too**: the provider-type paragraph and the Jev setup section carry the same beta note.
- **Unchanged**: every field, seeding, validation, and run behavior of the provider — this is disclosure only.

## Capabilities

### New Capabilities
- (none)

### Modified Capabilities
- `typesafe-jev-provider`: "Provider type and configuration surface" gains the beta-label sentence and its scenario.

## Impact

- **Extension**: `extension/settings/settings.html` (badge, style, notice).
- **Docs**: `README.md`.
- **Tests**: `test/settings-connection-gate.test.mjs` (pin the badge, the notice, and the badge's own style).
