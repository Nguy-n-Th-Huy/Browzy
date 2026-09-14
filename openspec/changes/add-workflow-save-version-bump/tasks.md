## 1. Save semantics (host)

- [x] 1.1 `_handleWorkflowDraftSave`: `DUPLICATE_IDENTITY` → `updateWorkflow` bump — disabled, host-written provenance with `supersededVersion`, same reply/event shape. ← (verify: `host/test/workflow-prove-bridge.test.mjs` — second save returns v2; v2 disabled; v1 addressable; the transcript carries v2)
- [x] 1.2 All other validation errors still refuse with the registry's own codes.
- [x] 1.3 Doc comment updated: "stored as a DISABLED version — version 1; the next version when the id is already stored".

## 2. Verification

- [x] 2.1 `node host/test/workflow-prove-bridge.test.mjs` — 17/17 (bump assertions included).
- [x] 2.2 Regression: `host/test/workflows-materialize.test.mjs` 22/22, `host/test/skills-workflows.test.mjs` 13/13, `host/test/workflows-heal.test.mjs` 9/9.
- [ ] 2.3 Live follow-up (operator): press "Lưu bản nháp" on a re-derived draft of an existing workflow — it saves as the next version (no refusal), the card then proves/enables that version.
