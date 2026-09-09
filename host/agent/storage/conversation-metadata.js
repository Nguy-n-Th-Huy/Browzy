// Versioned conversation metadata schema (tasks.md 2.1) and the app/SDK
// snapshot boundary it exists to make explicit (tasks.md 2.2).
//
// design.md decision 2: "Extend conversation metadata with a secret-free app
// profile identity (profile id, endpoint/model identity, credential
// revision), skill identity, permission policy, SDK reference, session
// schema version, lifecycle status, and budget policy... Do not conflate
// this app snapshot with the SDK's persisted prompt/system snapshot."
//
// The "SDK persisted prompt/system snapshot" this must never be conflated
// with is a REAL, named SDK mechanism, not a metaphor: the pinned SDK's own
// `Options.systemPrompt.snapshot` field (sdk.d.ts ~2192-2220) — "whether the
// conversation's system prompt is recorded once ... and reused verbatim on
// every later request and resume/continue, instead of being rendered fresh
// each time." This project's `systemPrompt` text always embeds the CURRENT
// run's bound page/document context (query-options.js's
// `renderPageContextSystemPrompt`), so recording it would freeze a stale
// page/document identity across every future resumed turn — exactly what
// decision 2 forbids ("every resumed turn must rebuild fresh page context
// ... must not freeze a prior custom system prompt"). query-options.js's
// `buildIsolatedOptions()` sets `snapshot: false` explicitly for this reason
// (see its own comment) — this module owns the APP-side half of the
// boundary: everything here is secret-free, page-context-free, and prompt-
// text-free by construction. Nothing in this module ever stores an API key,
// a page URL/tabId, or system-prompt text; the SDK's own session reference
// (`sdkSessionRef` below) is recorded only as an opaque id, never resolved
// or reconstructed from here.
//
// Scope note (osf-apply, tasks 2.1/2.2): this module originally only defined
// the schema, its migration, and the app-snapshot builders, leaving
// `sdkSessionRef` reserved/null. Tasks 2.3/2.4 (osf-apply, same change) add:
//   - `buildSdkSessionRef()` / `SDK_SESSION_REF_STATUS` — the shape a
//     captured SDK session_id is recorded in (host/agent/session/manager.js's
//     `claimSdkSessionRef()` is the CAS write path; this module only shapes
//     the value, never touches storage).
//   - `assessResumeCompatibility()` — the pure comparison 2.4 requires
//     ("reject incompatible endpoint/model/skill/cwd/session identity")
//     before a later run of an already-bound conversation is allowed to pass
//     `resume` to the SDK at all. Field selection is deliberate — see the
//     function's own docstring for exactly what is and is not compared, and
//     why.
// `budgetPolicy` stays reserved for group 5, untouched here.

import { SESSION_SKILLS_PLUGIN_NAME } from "../skills/session-workspace.js";

export const CONVERSATION_METADATA_SCHEMA_VERSION = 1;

export const LIFECYCLE = Object.freeze({
  ACTIVE: "active",
  // Reserved for task 2.3's tombstone semantics; never set by this module.
  DELETED: "deleted"
});

// Advisory-only defaults (design.md decision 4: a local wall-clock/turn
// counter stays authoritative; SDK `maxTurns`/`maxBudgetUsd` are best-effort
// on top of it — group 5's job to populate real values). `null` means
// "no policy configured yet", never a fabricated limit.
export const DEFAULT_BUDGET_POLICY = Object.freeze({
  maxTurns: null,
  maxBudgetUsd: null,
  wallClockDeadlineMs: null
});

// Validation ranges for a run/conversation usage policy (tasks.md 5.1).
// `maxTurns`: a positive integer SDK agent-loop cap (gate-0.2 G6: this caps
// internal tool-loop rounds, NOT paced streaming-input conversation turns —
// the local admission counter stays authoritative regardless).
// `maxBudgetUsd`: a positive finite USD estimate for the SDK's estimated
// query-budget stop (gate-0.2 G7: the stop lands AFTER the turn that crosses
// the cap — in-flight overrun is real — and the figure is an SDK cost-table
// estimate, never a provider billing ceiling).
// `wallClockDeadlineMs`: a positive finite local wall-clock admission
// deadline in milliseconds from run start.
export const BUDGET_POLICY_LIMITS = Object.freeze({
  maxTurns: { min: 1, max: 1000, integer: true },
  maxBudgetUsd: { min: 0.01, max: 10000 },
  wallClockDeadlineMs: { min: 1000, max: 24 * 60 * 60 * 1000 }
});

/**
 * Validate a run- or conversation-scoped usage policy (tasks.md 5.1).
 * Unknown fields are rejected rather than silently dropped, so a caller can
 * never believe a limit applies when it was ignored. `null`/`undefined`
 * values mean "no limit configured", never zero.
 *
 * @param {object|null} policy
 * @returns {{ok: true, policy: {maxTurns:number|null, maxBudgetUsd:number|null, wallClockDeadlineMs:number|null}}
 *          | {ok: false, reason: string}}
 */
export function validateBudgetPolicy(policy) {
  if (policy === undefined || policy === null) return { ok: true, policy: { ...DEFAULT_BUDGET_POLICY } };
  if (typeof policy !== "object" || Array.isArray(policy)) return { ok: false, reason: "budget_policy_not_an_object" };
  const allowed = Object.keys(DEFAULT_BUDGET_POLICY);
  for (const key of Object.keys(policy)) {
    if (!allowed.includes(key)) return { ok: false, reason: `budget_policy_unknown_field:${key}` };
  }
  const out = { ...DEFAULT_BUDGET_POLICY };
  for (const key of allowed) {
    const value = policy[key];
    if (value === undefined || value === null) {
      out[key] = null;
      continue;
    }
    if (typeof value !== "number" || !Number.isFinite(value)) return { ok: false, reason: `budget_policy_invalid:${key}` };
    const limits = BUDGET_POLICY_LIMITS[key];
    if (limits.integer && !Number.isInteger(value)) return { ok: false, reason: `budget_policy_invalid:${key}` };
    if (value < limits.min || value > limits.max) return { ok: false, reason: `budget_policy_out_of_range:${key}` };
    out[key] = value;
  }
  return { ok: true, policy: out };
}

/**
 * Resolve the effective limits for one run (tasks.md 5.1 inheritance):
 * a run-scoped override wins per-field over the conversation policy; an
 * unset override field inherits the conversation value. Neither input is
 * mutated; both must already be normalized (validateBudgetPolicy output or
 * DEFAULT_BUDGET_POLICY shape).
 *
 * @param {object|null} conversationPolicy
 * @param {object|null} runOverride
 * @returns {{maxTurns:number|null, maxBudgetUsd:number|null, wallClockDeadlineMs:number|null}}
 */
export function resolveEffectiveLimits(conversationPolicy, runOverride) {
  const conv = conversationPolicy || { ...DEFAULT_BUDGET_POLICY };
  const over = runOverride || {};
  const out = {};
  for (const key of Object.keys(DEFAULT_BUDGET_POLICY)) {
    const o = over[key];
    out[key] = o === undefined || o === null ? (conv[key] ?? null) : o;
  }
  return out;
}

function freshMigrationState({ backfilled, legacy }) {
  return {
    schemaVersion: CONVERSATION_METADATA_SCHEMA_VERSION,
    backfilled: Boolean(backfilled),
    backfilledAt: backfilled ? Date.now() : null,
    legacy: Boolean(legacy)
  };
}

/**
 * The envelope a brand-new conversation gets at creation time (before any
 * run has ever started, so app profile / skill / permission identity are
 * not knowable yet — same lazy "bound on first run" pattern already used by
 * SessionManager.getSkillsBinding/setSkillsBinding).
 */
export function initConversationMetadataEnvelope() {
  return {
    schemaVersion: CONVERSATION_METADATA_SCHEMA_VERSION,
    appProfile: null,
    sessionSchemaIdentity: null,
    permissionPolicy: null,
    // { sessionId, persistSession, forkedFrom } once a later group wires
    // SDK-level `resume` — reserved, never populated here.
    sdkSessionRef: null,
    budgetPolicy: { ...DEFAULT_BUDGET_POLICY },
    lifecycle: LIFECYCLE.ACTIVE,
    usageEpoch: 0,
    migrationState: freshMigrationState({ backfilled: false, legacy: false })
  };
}

/**
 * Secret-free app profile identity (design.md decision 2's exact field
 * list): profile id, endpoint/model identity, credential revision. NEVER
 * accepts or stores `env`/an API key — callers must destructure only the
 * fields listed here out of a resolved profile snapshot.
 *
 * @param {object} params
 * @param {string|null} [params.profileId]
 * @param {string|null} [params.baseUrl] - non-secret endpoint URL (the
 *   snapshot's `env.ANTHROPIC_BASE_URL`), never the API key.
 * @param {string|null} [params.modelId]
 * @param {number|null} [params.credentialRevision] - from
 *   host/agent/settings/profile.js's `credentialRevision` (bumped on
 *   setCredential/removeCredential); `null` (never `0`) when the resolved
 *   snapshot did not carry one (e.g. a test double's minimal fake).
 */
export function buildAppProfileIdentity({ profileId = null, baseUrl = null, modelId = null, credentialRevision = null } = {}) {
  return {
    profileId: profileId ?? null,
    endpoint: baseUrl ?? null,
    modelId: modelId ?? null,
    credentialRevision: credentialRevision ?? null
  };
}

/**
 * The "cwd/session schema identity" input list gate-0.2's own evidence
 * report names as load-bearing for a future resume-compatibility check
 * (tasks.md 2.4) — reproduced here exactly, not re-derived:
 *   1. cwd (the session's skills workspace directory)
 *   2. the materialized plugin directory + its fixed plugin name
 *   3. allowedSkillNames in plugin-qualified form
 *   4. skillOverrides, keyed the same way
 *   5. settingSources (fixed `[]`, per query-options.js's isolation
 *      contract — never varies, included for completeness/comparability)
 *
 * Derived from a conversation's own `skillsBinding` (SessionManager's
 * existing `getSkillsBinding()` shape) so this never re-implements or
 * drifts from what buildSessionSkills() actually materialized. Tolerates
 * both the current (plugin-era) and a legacy pre-plugin `skillsBinding`
 * shape (no `pluginDir`/`configDir`) — see migrateConversationMetadata()'s
 * own real-fixture tests. `pluginName` is reported only when this binding
 * actually has a `pluginDir` — a legacy record never went through the
 * plugin mechanism at all, so attaching today's fixed plugin name to it
 * would misrepresent what was actually materialized for that conversation.
 *
 * @param {object|null} skillsBinding
 * @returns {object|null} null when no skillsBinding exists yet (conversation
 *   has never had a run).
 */
export function buildSessionSchemaIdentity(skillsBinding) {
  if (!skillsBinding || typeof skillsBinding !== "object") return null;
  return {
    cwd: skillsBinding.cwd ?? null,
    pluginDir: skillsBinding.pluginDir ?? null,
    pluginName: skillsBinding.pluginDir ? SESSION_SKILLS_PLUGIN_NAME : null,
    configDir: skillsBinding.configDir ?? null,
    allowedSkillNames: Array.isArray(skillsBinding.allowedSkillNames) ? [...skillsBinding.allowedSkillNames].sort() : [],
    skillOverrides: { ...(skillsBinding.skillOverrides || {}) },
    // Fixed today (query-options.js's isolation contract never widens this),
    // never derived from the binding itself.
    settingSources: []
  };
}

/**
 * A self-maintaining identity of the permission policy actually applied to
 * a run's constructed `query()` Options (host/agent/tools/query-options.js's
 * `buildIsolatedOptions()` return value) — sorted so two runs with the same
 * effective policy compare equal regardless of construction order. Deriving
 * this FROM the real options object (rather than a hand-maintained constant)
 * means it can never silently drift from what the run actually got.
 *
 * @param {object|null} options - a buildIsolatedOptions() result
 * @returns {object|null}
 */
export function buildPermissionPolicyIdentity(options) {
  if (!options || typeof options !== "object") return null;
  const sortedCopy = (arr) => (Array.isArray(arr) ? [...arr].sort() : []);
  return {
    tools: sortedCopy(options.tools),
    allowedTools: sortedCopy(options.allowedTools),
    disallowedTools: sortedCopy(options.disallowedTools)
  };
}

/**
 * Normalize an on-disk conversation meta record (TranscriptStore's
 * `loadMeta()` shape) into the current schema envelope, WITHOUT mutating the
 * input. Idempotent: an already-current envelope is returned by reference,
 * unchanged, so a caller can cheaply detect "no migration was needed" via
 * `=== ` and skip a redundant disk write.
 *
 * Hard rule (this change's own non-negotiable): a legacy record's
 * `appProfile` is NEVER reconstructed — no historical-secret/identity
 * replay. `sessionSchemaIdentity` MAY be derived from an existing
 * `skillsBinding`, because that is real state this conversation already
 * recorded, not a guess.
 *
 * @param {object|null} rawMeta - TranscriptStore.loadMeta()'s return value
 *   (or any object with the same shape) — never assumed to already carry a
 *   `conversationMetadata` envelope.
 * @returns {object} a current-schema conversationMetadata envelope
 */
// The three states a captured SDK session reference can be in (tasks.md
// 2.3/2.4/2.5). `sessionId` is NEVER cleared once captured — "never auto-
// clear a ref on resume failure" (design.md decision 2's tombstone/no-
// resurrection framing extends to this: a failed resume must not silently
// discard the one piece of state that makes a later, explicit retry
// possible). Only `status` (and `updatedAt`) change after the first claim.
export const SDK_SESSION_REF_STATUS = Object.freeze({
  // A resume was attempted with this id and the SDK accepted it (or this is
  // the id captured from a fresh, non-resumed query()'s own init message).
  ACTIVE: "active",
  // A resume attempt for this id failed with an explicit "session not
  // found" signal (gate-0.2 evidence G2: a thrown terminal error AND, where
  // observed before the throw, a `result` message with
  // `is_error:true`/`subtype:"error_during_execution"` naming the missing
  // session id). The conversation's transcript is untouched; only SDK-level
  // continuity for THIS id is gone.
  MISSING: "missing",
  // A resume attempt for this id failed for some other explicit reason (not
  // the "missing session" shape above) — e.g. an incompatible SDK/CLI
  // version, a corrupted session file. Distinct from MISSING only so a
  // later UI/log can say which explicit failure occurred; both states
  // equally forbid an automatic retry.
  RESUME_FAILED: "resume_failed"
});

/**
 * The shape a captured (or status-updated) SDK session reference takes
 * inside `conversationMetadata.sdkSessionRef`. Pure — never touches storage;
 * host/agent/session/manager.js's `claimSdkSessionRef()`/
 * `markSdkSessionRefStatus()` are the CAS write paths that call this.
 *
 * @param {object} params
 * @param {string} params.sessionId - the SDK's own `session_id` (from the
 *   `system`/`init` message's `session_id` field, sdk.d.ts ~5207).
 * @param {string} [params.status] - one of SDK_SESSION_REF_STATUS; defaults
 *   to ACTIVE (the shape a freshly captured id gets).
 * @param {object|null} [params.previous] - the prior ref (if any), so
 *   `capturedAt` survives a status-only update.
 */
export function buildSdkSessionRef({ sessionId, status = SDK_SESSION_REF_STATUS.ACTIVE, previous = null } = {}) {
  if (!sessionId || typeof sessionId !== "string") {
    throw new Error("buildSdkSessionRef requires a non-empty sessionId string");
  }
  const now = Date.now();
  return {
    sessionId,
    status,
    capturedAt: previous && previous.sessionId === sessionId ? previous.capturedAt : now,
    updatedAt: now
  };
}

/**
 * The exact field comparison tasks.md 2.4 requires before a later run of an
 * already-bound conversation may pass `resume` to the SDK: "reject
 * incompatible endpoint/model/skill/cwd/session identity". Pure function —
 * no storage access, no side effects.
 *
 * Deliberately compares ONLY the fields that can actually vary between two
 * runs of the same conversation in this codebase's current architecture,
 * per gate-0.2's own "concrete session-schema-identity inputs" list and this
 * change's own 2.1/2.2 report:
 *   - `appProfile.endpoint` / `appProfile.modelId` — the ONE input that can
 *     genuinely differ turn to turn: the operator can pick a different
 *     profile/model in the composer for the same conversation's next Send.
 *   - `sessionSchemaIdentity.cwd` / `.pluginDir` / `.allowedSkillNames` /
 *     `.skillOverrides` — included because decision 2.4's own text names
 *     "skill"/"cwd" explicitly; compared for completeness and as a
 *     forward-compatible guard, even though in today's architecture a
 *     conversation's `skillsBinding` is bound once
 *     (SessionManager.setSkillsBinding, "reused verbatim afterward") and
 *     `cwd` is always `conversationDir(conversationId)` — neither can
 *     actually drift once `appProfile` (and therefore
 *     `sessionSchemaIdentity`) has been bound at all, so this branch is
 *     defensive rather than reachable by today's callers.
 *
 * Deliberately EXCLUDED, each for a stated reason:
 *   - `appProfile.profileId` — two different profile ids can point at the
 *     identical endpoint+model (e.g. a duplicated profile record); the
 *     conversation's actual SDK-facing identity is the endpoint+model pair,
 *     not the application's bookkeeping id for it.
 *   - `appProfile.credentialRevision` — a rotated credential on the SAME
 *     endpoint+model is exactly the "current credential" case decision 2.4
 *     itself calls out ("unavailable current credentials" is the separate
 *     failure this guards, via `ProfileUnavailableError` — resolved BEFORE
 *     this check ever runs, since `resolveProfileSnapshot` throws first).
 *     Comparing credentialRevision here would force a hard, unnecessary
 *     incompatibility on ordinary key rotation and contradicts "no
 *     historical-secret reconstruction" (which is about never REBUILDING an
 *     old credential, not about pinning conversations to one).
 *   - `permissionPolicy` — decision 2 records it as part of the app
 *     snapshot, but decision 2.4's own rejection list does not name it, and
 *     it is entirely DERIVED from `appProfile`/`sessionSchemaIdentity`/the
 *     fixed isolation contract (buildIsolatedOptions never varies it for a
 *     given skills+tool registry) — comparing it would be redundant with
 *     the fields above, never an independent signal.
 *   - `sessionSchemaIdentity.settingSources` — fixed `[]` unconditionally
 *     (query-options.js's isolation contract never widens it); comparing a
 *     constant to itself can never produce a mismatch.
 *
 * A `bound.appProfile` of `null` (nothing bound yet — a legacy conversation
 * or this conversation's very first run) is always reported compatible:
 * there is nothing to conflict with yet, and binding is `SessionManager
 * .bindConversationAppSnapshot()`'s job, not this function's.
 *
 * @param {object} params
 * @param {{appProfile: object|null, sessionSchemaIdentity: object|null}} params.bound -
 *   the conversation's already-recorded identity (getConversationMetadata()).
 * @param {{appProfile: object, sessionSchemaIdentity: object|null}} params.current -
 *   this run's freshly resolved identity (buildAppProfileIdentity()/
 *   buildSessionSchemaIdentity() over THIS run's snapshot/skills).
 * @returns {{compatible: true} | {compatible: false, mismatches: Array<{field: string, bound: *, current: *}>}}
 */
export function assessResumeCompatibility({ bound, current }) {
  const boundProfile = bound && bound.appProfile;
  if (!boundProfile) return { compatible: true };

  const currentProfile = (current && current.appProfile) || {};
  const boundSchema = bound.sessionSchemaIdentity || {};
  const currentSchema = (current && current.sessionSchemaIdentity) || {};

  const sameArray = (a, b) => JSON.stringify([...(a || [])].sort()) === JSON.stringify([...(b || [])].sort());
  const sameObject = (a, b) => JSON.stringify(a || {}) === JSON.stringify(b || {});

  const checks = [
    { field: "endpoint", bound: boundProfile.endpoint ?? null, current: currentProfile.endpoint ?? null, eq: (a, b) => a === b },
    { field: "modelId", bound: boundProfile.modelId ?? null, current: currentProfile.modelId ?? null, eq: (a, b) => a === b },
    { field: "cwd", bound: boundSchema.cwd ?? null, current: currentSchema.cwd ?? null, eq: (a, b) => a === b },
    { field: "pluginDir", bound: boundSchema.pluginDir ?? null, current: currentSchema.pluginDir ?? null, eq: (a, b) => a === b },
    { field: "allowedSkillNames", bound: boundSchema.allowedSkillNames || [], current: currentSchema.allowedSkillNames || [], eq: sameArray },
    { field: "skillOverrides", bound: boundSchema.skillOverrides || {}, current: currentSchema.skillOverrides || {}, eq: sameObject }
  ];

  const mismatches = checks.filter((c) => !c.eq(c.bound, c.current)).map(({ field, bound, current }) => ({ field, bound, current }));
  return mismatches.length ? { compatible: false, mismatches } : { compatible: true };
}

export function migrateConversationMetadata(rawMeta) {
  const existing = rawMeta && typeof rawMeta === "object" ? rawMeta.conversationMetadata : null;
  if (existing && existing.schemaVersion === CONVERSATION_METADATA_SCHEMA_VERSION) {
    return existing;
  }
  const legacySkillsBinding = rawMeta && typeof rawMeta === "object" ? rawMeta.skillsBinding || null : null;
  return {
    schemaVersion: CONVERSATION_METADATA_SCHEMA_VERSION,
    appProfile: null,
    sessionSchemaIdentity: buildSessionSchemaIdentity(legacySkillsBinding),
    permissionPolicy: null,
    sdkSessionRef: null,
    budgetPolicy: { ...DEFAULT_BUDGET_POLICY },
    lifecycle: LIFECYCLE.ACTIVE,
    usageEpoch: 0,
    migrationState: freshMigrationState({ backfilled: true, legacy: true })
  };
}
