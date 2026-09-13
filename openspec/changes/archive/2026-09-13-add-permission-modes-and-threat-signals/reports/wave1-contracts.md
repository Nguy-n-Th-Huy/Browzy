# Wave 1 contracts — as actually implemented

This is the ground truth for the extension wave: the exact `agent_settings`
op shapes and the exact `managed_policy_snapshot` wire message, as shipped in
`host/agent/companion.js` / `host/agent/protocol.js` / `host/agent/policy/**`.
Where the brief's proposed shapes needed a small adjustment to fit the
existing `{ok, result|error}` envelope and error-code conventions, the
adjustment is called out.

## `agent_settings` ops (unchanged envelope: `{v, type:"agent_settings",
requestId, op, ...payload}` -> `{v, type:"agent_settings", requestId, ok,
result}` or `{..., ok:false, error:{code, message}}`)

### `get_permission_state`

Request: `{ op: "get_permission_state" }` (no payload).

Result:

```js
{
  mode: "manual" | "auto" | "skip",           // the EFFECTIVE mode (managed pin wins while present)
  modeSource: "local" | "managed",
  sites: [
    {
      origin: string,                          // normalized origin, e.g. "https://example.com"
      actionClass: "mutating" | "send",        // protected is never storable
      decision: "allow" | "deny",
      recordedAt: string | null,               // ISO timestamp; null for a managed entry received
                                                // before this companion process ever validated one
      source: "local" | "managed"
    }
  ],
  managedPolicy: {
    present: boolean,   // true iff the extension has ever pushed a non-null policy or a readError
    readable: boolean,  // false iff the last push was malformed or unreadable
    error?: string      // present only when readable is false — joined validation errors, or the
                         // extension's own readError string
  }
}
```

`sites` merges local entries (from the per-site store, `source:"local"`) and
the CURRENT managed policy's `sites` array (`source:"managed"`) — managed
entries always listed first. No error path; always `ok:true`.

### `set_permission_mode`

Request: `{ op: "set_permission_mode", mode: "manual" | "auto" | "skip" }`.

Success result: `{ mode }` — the effective mode after the write (identical
to the requested mode, since this op is rejected outright when a managed pin
is in effect).

Errors:
- `INVALID_MODE` — `mode` is not one of `manual`/`auto`/`skip`.
- `MANAGED_POLICY_PINNED` — administrator policy currently pins the mode;
  the local file is left untouched.

Side effect: if the EFFECTIVE mode actually changes as a result, every
outstanding approval decision (across every conversation this companion
process is running) is invalidated — a late answer is rejected with a
distinguishable reason rather than being applied under the new mode.

### `revoke_site_entry`

Request: `{ op: "revoke_site_entry", origin: string, actionClass: "mutating" | "send" }`.

Success result: `{ revoked: true }`.

Errors:
- `PROTOCOL_ERROR` — missing/invalid `origin` or `actionClass`, or an
  origin that fails to parse as an `https:`/`http:` URL.
- `MANAGED_ENTRY_LOCKED` — a managed policy entry exists for this exact
  `(origin, actionClass)`; administrator entries are never revocable
  locally, whether or not a local entry also exists underneath it.
- `NOT_FOUND` — no local entry matches; distinguishable from success so the
  panel never reports "revoked" for something that was never there.

### `revoke_all_site_entries`

Request: `{ op: "revoke_all_site_entries" }` (no payload).

Result: `{ removed: <count> }`. Removes LOCAL entries only — a managed
policy's `sites` are administrator-controlled and unaffected, exactly as
`revoke_site_entry` treats them individually.

## `managed_policy_snapshot` (its own top-level message type, not an
`agent_settings` op — pushed unsolicited by the extension, not requested by
the panel)

Added to `host/agent/protocol.js`'s `AGENT_MESSAGE_TYPES` as
`MANAGED_POLICY_SNAPSHOT: "managed_policy_snapshot"`. Gated behind a
completed `hello` (a fact about the current browser connection, like the
`installationId`/`connectionId` half of `hello` itself).

Extension -> companion:

```js
{ v, type: "managed_policy_snapshot", policy: object | null, readError?: string }
```

Companion -> extension (ack only, no result payload beyond `ok`):

```js
{ v, type: "managed_policy_snapshot", ok: true }
```

Semantics (all host-side, in `CompanionCore._handleManagedPolicySnapshot`):

- `readError` a non-empty string: the extension could not read
  `chrome.storage.managed` at all. The companion falls back to local
  settings for every decision from the very next call onward, and
  `get_permission_state().managedPolicy` reports `{present:true,
  readable:false, error:readError}`.
- `policy` is `null` (or omitted) and no `readError`: managed policy is
  absent/withdrawn. Local settings apply immediately;
  `managedPolicy` reports `{present:false, readable:true}`. If a managed
  mode pin was previously in effect and this withdrawal changes the
  EFFECTIVE mode, every outstanding approval is invalidated (same mechanism
  as `set_permission_mode`).
- `policy` is a non-null value: validated via
  `host/agent/policy/permission-modes.js`'s `validateManagedPolicy()`.
  - Valid (possibly normalizing to an empty/no-op policy): applied
    immediately; `managedPolicy` reports `{present:true, readable:true}`.
  - Invalid: ignored for every decision (falls back to local, exactly like
    withdrawal), but `managedPolicy` reports `{present:true, readable:false,
    error:"<joined validation errors>"}` — never silently treated as
    absent.
  - In both the withdrawal and the newly-applied-policy cases, if the
    EFFECTIVE mode changes as a result, every outstanding approval decision
    is invalidated the same way `set_permission_mode` does.

`validateManagedPolicy`'s accepted shape (unchanged from what
`permission-modes.js` already implemented before this wave):

```js
{
  mode?: "manual" | "auto" | "skip",
  requireProtectedConfirm?: boolean,   // validated for shape; not yet consumed by
                                        // the resolver — protected always decides
                                        // regardless (design.md decision 2), so this
                                        // field can only ever ADD confirmation, never
                                        // remove one, and there is nothing to remove
  sites?: [{ origin: string, actionClass: "mutating" | "send", decision: "allow" | "deny" }]
}
```

A managed policy can never disable a protected action's decision requirement
— `resolveModeDecision()` checks `actionClass === PROTECTED` before it ever
looks at managed policy or the per-site store, and `validateManagedPolicy`
has no field that targets protected actions at all (`sites[].actionClass` is
restricted to `REMEMBERABLE_CLASSES`, which excludes `protected` by
construction).

## Notes for the extension wave

- The extension owns pushing `managed_policy_snapshot` on connect and on
  every `chrome.storage.onChanged` for the `managed` area — the host takes
  whatever it is sent, validates, and applies; it has no polling loop of its
  own.
- `get_permission_state`'s `sites[].recordedAt` for a `source:"managed"`
  entry is the time the CURRENT managed snapshot was last validated, not a
  per-entry timestamp — `chrome.storage.managed` carries no such thing.
- The panel's decision-card `remember` flag and `protectedCategory`/
  `rememberable` fields on `approval_request` were already implemented
  before this wave (see `host/agent/policy/can-use-tool.js`'s emit of
  `approval_request`); this wave's own addition on that path was forwarding
  the wire's `remember` field through
  `CompanionCore._handleApprovalDecision` to the `canUseTool` resolver,
  which previously dropped it silently.
