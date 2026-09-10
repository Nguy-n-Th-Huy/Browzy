## 1. Scope the remembered identity in the store

- [x] 1.1 In `extension/sidepanel/history-store.js`, key the last-active conversation id by panel scope instead of holding a single profile-wide value, and move it from `chrome.storage.local` to `chrome.storage.session` (keeping the conversation index itself in local storage, untouched). Use one storage key per scope rather than a single key holding a `{scope: id}` object — see design.md for why the shared-object shape loses writes when two panels save at once.
- [x] 1.2 Change `getLastActive()` / `setLastActive()` to take the scope, with `setLastActive(scope, null)` forgetting just that scope's conversation and leaving every other scope's untouched. Keep the existing swallow-on-failure behavior — a storage failure resolves to `null` / a no-op, never a throw — and keep it working when `chrome.storage.session` is absent. ← (verify: no code path can reject; an absent session store degrades to "nothing remembered", not an error)
- [x] 1.3 Update `test/sidepanel-history-store.test.mjs` for the scoped shape: two scopes round-trip independently, clearing one leaves the other, an unknown scope reads `null`, and a throwing storage still does not propagate.

## 2. Give the controller its scope

- [x] 2.1 In `extension/sidepanel/panel-controller.js`, accept the panel's scope as an injected resolver rather than a per-call argument, so no call site can perform an unscoped read or write.
- [x] 2.2 Route the existing single `_setCurrentConversationId()` setter and `deleteConversationLocally()` through the scope, so each writes and clears only its own entry. ← (verify: grep — every `setLastActive`/`getLastActive` call passes a scope; none reads the map whole)
- [x] 2.3 In `restoreOrStartConversation()`, read only this scope's remembered id, and start a new conversation when the scope resolves to nothing (spec scenario "No identifiable scope") — never fall through to another scope's id.

## 3. Resolve the scope once at boot

- [x] 3.1 In `extension/sidepanel/sidepanel.js` `boot()`, resolve the panel's tab id once after `pageContext.start()` and before the restore call, and freeze it as the scope for the life of the panel document. Do not re-read it on page-context change — the tracker follows the active tab when unpinned and would otherwise drift onto a tab this panel does not belong to. ← (verify: the scope value is captured once and never reassigned; a later context change does not alter it)

## 4. Coverage

- [x] 4.1 In `test/sidepanel-fake-companion.test.mjs`, add: two controllers with different scopes sharing one storage each restore their own conversation, and a third scope starts a new one rather than adopting either.
- [x] 4.2 Add: a panel whose scope resolves to nothing starts a new conversation and does not read another scope's entry.
- [x] 4.3 Confirm the existing restore, deleted-locally, stale-id and explicit-reopen cases still pass under the scoped store, adapting only their setup to supply a scope — not their assertions. ← (verify: no existing assertion was weakened to accommodate the new shape)
- [x] 4.4 Run every `test/sidepanel-*.test.mjs` with `node` directly (no npm target covers them) and confirm all pass.
