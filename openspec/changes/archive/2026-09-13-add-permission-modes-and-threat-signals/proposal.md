## Why

The runtime has exactly one permission behavior and no memory of past decisions. Its gate classifies only three tools (`computer`, `javascript_tool`, `webmcp_call_tool`) and only for send/submit-class calls; the existing requirement states plainly that "every other classified call, and every call to any other registered browser tool, MUST proceed automatically with no decision required". A user who wants to watch every action cannot, and a user who trusts a site they use daily is asked about it identically every run. Decisions are per-run only: approval tokens are deliberately non-reusable, so nothing carries a user's answer to the next run even for the same site and the same action.

Two things the runtime never computes are missing from that gate. It never inspects returned web content for instructions aimed at the agent before acting on it, even though the captured system prompt instructs the model to stop when it sees them — leaving detection entirely to the model's own compliance, with nothing to compare a model's behavior against. It also never scores what a tab is for, so a banking tab and a documentation tab are gated identically.

Finally, an administrator deploying Browzy has no channel to set any of this. Policy is whatever each local profile happens to hold.

## What Changes

- A permission mode — Manual, Auto, or Skip — determines which classified actions require a decision. Manual asks for every mutating action; Auto keeps today's send/submit-class gating; Skip asks for nothing except protected actions. Auto is the default, so an unconfigured install behaves exactly as it does today.
- A safety classifier assigns every action a decision outcome under the active mode, so no action reaches dispatch without having been classified.
- A per-site permission store remembers a user's decision for a site and an action class, and a management page lists remembered sites and revokes them individually or entirely.
- A protected-action class always requires a fresh decision regardless of mode and regardless of any remembered per-site grant: causing a file to be written or downloaded, entering credentials or payment details, and granting a browser permission on the page's behalf.
- A prompt-injection probe scans returned web content before the agent acts on it and records what it found. Findings are advisory: they warn, annotate the timeline, and raise a tab's risk, but never by themselves block an action.
- A per-tab risk category scores what a tab appears to be for and surfaces that as a warning on the tab and in the panel. Like the probe, it warns and never blocks.
- An administrator-managed policy channel reads `chrome.storage.managed` and can pin the mode, force sites into or out of the per-site store, and require protected-action confirmation. Managed values are read-only locally and always override local settings.
- **BREAKING** The send/submit gate requirement is no longer unconditional: what suspends for a decision now depends on the active mode, the per-site store, and managed policy. Auto mode reproduces the previous behavior exactly.

## Capabilities

### New Capabilities
- `agent-permission-policy`: the permission mode, the safety classifier that decides per action under it, the per-site permission store and its revocation surface, the always-ask protected-action class, and the administrator-managed policy channel that overrides all of them.
- `agent-threat-assessment`: the prompt-injection probe over returned web content and the per-tab risk category, both advisory signals that warn and raise risk without ever blocking an action on their own.

### Modified Capabilities
- `agent-browser-runtime`: the send/submit-class gate becomes mode-aware and consults the per-site store and managed policy, rather than gating one fixed set and auto-proceeding on everything else.
- `browser-assistant-panel`: gains the mode control, the approved-sites management page, protected-action decision cards that name why they cannot be remembered, and the surfacing of injection findings and tab risk as warnings distinct from approval requests.

## Impact

- `host/agent/policy/` — `can-use-tool.js` consults mode, store, and managed policy; `authorization.js` gains the protected-action check that no mode or grant can bypass; a policy resolver and a per-site store are added.
- `host/agent/tools/mapping.js` — the classifier extends beyond the three send-class tools to cover every registered tool under Manual mode, and gains the protected-action classification.
- `extension/background.js` — reads `chrome.storage.managed`, observes downloads for the protected-action class, and relays tab risk to the overlay.
- `extension/sidepanel/` — mode control, protected-action cards, warning surfaces distinct from approval cards.
- `extension/settings/` — the approved-sites management page, with managed entries shown as locked.
- `extension/manifest.json` — a `downloads` permission is required to observe a download the agent causes; without it the protected-action class cannot detect one.
- `openspec/specs/agent-browser-runtime/spec.md`, `openspec/specs/browser-assistant-panel/spec.md` — the modified requirements above.
- Existing approval-token binding, single-use semantics, and invalidation rules are unchanged and continue to apply to every decision this change introduces.
