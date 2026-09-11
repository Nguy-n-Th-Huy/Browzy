// Background service worker for the Browzy extension.
// Handles: native messaging, CDP via chrome.debugger, tool dispatch, tab group management.

import * as humanize from "./humanize/index.js";
import * as audit from "./audit/index.js";
import * as actionEvents from "./events/action-events.js";
import * as documentIdentity from "./events/document-identity.js";

// Prevent unhandled rejections from killing the service worker
self.addEventListener("unhandledrejection", (event) => {
  event.preventDefault();
});

const NATIVE_HOST_NAME = "com.anthropic.browzy_in_chrome";

// --- State ---
let nativePort = null;
let tabGroupId = null;

// The visible title of the tab group automation works inside. Agent-created
// tabs are gathered here rather than scattered through the operator's tab
// strip, so it is always obvious which tabs the assistant opened — the same
// affordance Claude in Chrome's own "Claude" group provides.
//
// LEGACY_TAB_GROUP_TITLES keeps older group titles recognisable on recovery:
// a group created before this rename (titled "MCP") must still be adopted
// after a service-worker restart instead of being orphaned while a second,
// empty group is created beside it.
// The extension's own assistant (sidepanel + companion) and an external MCP
// client each get their own visible label, so the tab strip says which one is
// driving. Only one drives at a time — they share a single browser lease — so
// the group is re-titled on takeover rather than duplicated.
const AGENT_TAB_GROUP_TITLE = "Browzy";
const MCP_TAB_GROUP_TITLE = "MCP Browzy";
// Older builds titled the group plain "MCP"; a group left over from one must
// still be adopted on recovery instead of being orphaned beside a new one.
const LEGACY_TAB_GROUP_TITLES = [MCP_TAB_GROUP_TITLE, "MCP"];
let tabGroupTabs = new Set();

// --- Per-tab side panel + numbered solo agent groups ----------------------
// Panel visibility follows the EXPLICITLY opened tab only (close-on-switch):
// the panel is visible solely on tabs where the operator clicked the toolbar
// icon. Switching to any other tab — a fresh New Tab, a plain page, anything
// never clicked — hides the panel the moment that tab becomes active. Chrome
// offers no "close the side panel" call; per-tab setOptions({enabled:false})
// on the newly active tab is the mechanism. Returning to an explicitly opened
// tab re-enables it with no new click needed.
//
// Each explicitly opened tab gets its OWN numbered agent group ("Browzy",
// "Browzy 2", "Browzy 3", ...) containing only that tab — groups are never
// merged, and stale groups are never auto-deleted. The shared primary group
// (tabGroupId, used by the MCP tool paths) is untouched by all of this.
//
// The explicit set lives in chrome.storage.session so a service-worker
// restart does not silently close the working tab; it is best-effort with a
// memory-only fallback and is pruned when tabs close.
const extraAgentGroupIds = new Set();

/**
 * 1 for "Browzy", N for "Browzy N", 0 for anything else. The numbered suffix
 * is derived from AGENT_TAB_GROUP_TITLE rather than hardcoded, so a rename
 * keeps the whole family consistent.
 */
function agentFamilyTitleNumber(title) {
  if (title === AGENT_TAB_GROUP_TITLE) return 1;
  if (typeof title !== "string") return 0;
  const m = /^(.*) (\d+)$/.exec(title);
  if (m && m[1] === AGENT_TAB_GROUP_TITLE) {
    const n = parseInt(m[2], 10);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function isAgentFamilyTitle(title) {
  return agentFamilyTitleNumber(title) > 0;
}

/** Next free family title: "Browzy" when unused, otherwise "Browzy N". */
async function nextAgentGroupTitle() {
  let max = 0;
  try {
    const groups = await chrome.tabGroups.query({});
    for (const g of groups || []) {
      const n = agentFamilyTitleNumber(g && g.title);
      if (n > max) max = n;
    }
  } catch {
    // Group listing unavailable: fall back to the base title. Grouping still
    // works; only the numbering may collide, which is cosmetic.
  }
  const next = max + 1;
  return next <= 1 ? AGENT_TAB_GROUP_TITLE : AGENT_TAB_GROUP_TITLE + " " + next;
}

const PANEL_ENABLED_TABS_SESSION_KEY = "browzyPanelTabsV1";
let panelEnabledTabsCache = null;

async function loadPanelEnabledTabs() {
  if (panelEnabledTabsCache !== null) return panelEnabledTabsCache;
  panelEnabledTabsCache = new Set();
  try {
    const sessionStore =
      typeof chrome !== "undefined" && chrome.storage && chrome.storage.session
        ? chrome.storage.session
        : null;
    if (sessionStore && typeof sessionStore.get === "function") {
      const got = await sessionStore.get(PANEL_ENABLED_TABS_SESSION_KEY);
      const arr = got && got[PANEL_ENABLED_TABS_SESSION_KEY];
      if (Array.isArray(arr)) {
        for (const id of arr) if (typeof id === "number") panelEnabledTabsCache.add(id);
      }
    }
  } catch {
    // Memory-only fallback: the rule still holds until the next eviction.
  }
  return panelEnabledTabsCache;
}

async function persistPanelEnabledTabs() {
  if (panelEnabledTabsCache === null) return;
  try {
    const sessionStore =
      typeof chrome !== "undefined" && chrome.storage && chrome.storage.session
        ? chrome.storage.session
        : null;
    if (sessionStore && typeof sessionStore.set === "function") {
      await sessionStore.set({ [PANEL_ENABLED_TABS_SESSION_KEY]: [...panelEnabledTabsCache] });
    }
  } catch {
    // Best-effort: visibility still enforced from memory for this lifetime.
  }
}

async function isPanelTabExplicitlyEnabled(tabId) {
  if (typeof tabId !== "number") return false;
  return (await loadPanelEnabledTabs()).has(tabId);
}

/** Remember an explicit toolbar-icon open. Fire-and-forget (never awaited on the gesture path). */
function markPanelTabEnabled(tabId) {
  return loadPanelEnabledTabs().then((set) => {
    set.add(tabId);
    return persistPanelEnabledTabs();
  });
}

/** Forget a closed tab so the set cannot grow unbounded. Fire-and-forget. */
function forgetPanelTab(tabId) {
  if (panelEnabledTabsCache === null) return Promise.resolve(false);
  if (!panelEnabledTabsCache.delete(tabId)) return Promise.resolve(false);
  return persistPanelEnabledTabs().then(() => true);
}

/** Synchronous group-membership check against every group id we track. */
function isOwnAgentGroupId(groupId) {
  if (typeof groupId !== "number" || groupId === -1) return false;
  if (groupId === tabGroupId) return true;
  if (typeof extraAgentGroupIds !== "undefined" && extraAgentGroupIds.has(groupId)) return true;
  return false;
}

// Serializes solo-group creation so rapid icon clicks number groups
// sequentially instead of racing two creations onto the same title.
let soloGroupChain = Promise.resolve();

function adoptSoloAgentGroup(tabId) {
  const run = soloGroupChain.then(() => adoptSoloAgentGroupInner(tabId));
  soloGroupChain = run.catch(() => {});
  return run;
}

/**
 * Give an explicitly clicked tab its own numbered solo group, recording the
 * previous group for later restore (same borrowed-tab contract as
 * adoptBorrowedTab). Never merges into the shared group; a re-click on a tab
 * already in one of our own family groups keeps it where it is.
 */
async function adoptSoloAgentGroupInner(tabId) {
  if (typeof tabId !== "number" || adoptedBorrowedTabs.has(tabId)) return false;
  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    return false; // Tab vanished before it could be grouped.
  }
  if (typeof tab.groupId === "number" && tab.groupId !== -1) {
    let own = isOwnAgentGroupId(tab.groupId);
    if (!own) {
      try {
        const g = await chrome.tabGroups.get(tab.groupId);
        const title = g && g.title;
        own = isAgentFamilyTitle(title) || LEGACY_TAB_GROUP_TITLES.includes(title);
      } catch {
        own = false;
      }
    }
    if (own) {
      extraAgentGroupIds.add(tab.groupId);
      return false; // Already ours — kept, not regrouped.
    }
  }
  adoptedBorrowedTabs.set(tabId, tab.groupId ?? -1);
  const title = await nextAgentGroupTitle();
  // Claimed in adoptedBorrowedTabs BEFORE the grouping call (same reason
  // ensureTabGroup claims first): the grouping event must not look operator-made.
  const groupId = await chrome.tabs.group({ tabIds: [tabId] });
  try {
    await chrome.tabGroups.update(groupId, { title: title, color: "blue" });
  } catch {
    // Cosmetic only — the tab is still isolated in its own group.
  }
  extraAgentGroupIds.add(groupId);
  return true;
}

// Epoch ms of the most recent moment a tool dispatch held the browser. Chrome
// puts a tab opened FROM a grouped tab (target=_blank, window.open, a
// ctrl-clicked link) into that same group automatically, and the tab strip
// cannot say who did the clicking. This timestamp is that answer: a child tab
// appearing while a tool is running — or in the short window right after one
// finished, since a page's own window.open lands a beat after the click that
// triggered it — was opened by the agent and belongs in the group. Any other
// child tab is the operator's, and Chrome must not be allowed to file it under
// the agent's label. See guardInheritedTabGroup() below.
let lastAgentTabActivityAt = 0;
// The tab the agent last actually operated on, taken only from a real
// tool_request's own `args.tabId` (see handleToolRequest). tabs_create_mcp uses
// it as the anchor to open beside, so a new tab lands next to the work instead
// of at the far end of the window. Never a guess: a tool that named no tab
// leaves this untouched, and the anchor is re-verified against chrome.tabs.get
// before it is used at all.
let lastAgentTabId = null;
// The run that set `lastAgentTabId`, so a later run can tell that anchor is
// someone else's. The slot outlives a run, and a stale tab from the previous
// one is usually still in a group of ours — following it drops the new tab
// into that older group, which is exactly the split this anchoring exists to
// prevent. `null` for the legacy MCP path, which has no runs.
let lastAgentTabRunId = null;
// Long enough to cover a page opening its popup a beat after the click that
// triggered it, short enough that a tab the operator opens seconds later is
// still recognised as theirs.
const INHERITED_TAB_GRACE_MS = 1500;

// --- Agent protocol (SDK companion channel) -------------------------------
// Versioned envelopes multiplexed over the SAME native port as tool_request
// traffic (host/native-host.js unwraps `{type:"agent_msg", envelope}` and
// routes it to the companion it supervises). See design.md decision 1 and
// host/agent/protocol.js, whose PROTOCOL_VERSION this constant mirrors — kept
// as a small literal here rather than imported, since this file runs in the
// extension's own module graph and cannot import a Node-side file under
// host/. Bump both together; a mismatch fails closed at native-host.js
// (unknown/incompatible versions never reach a companion) rather than
// silently behaving as some other version.
const AGENT_PROTOCOL_VERSION = 1;
// 'pending' until a hello_ack or version_mismatch arrives; a future
// sidepanel (extension/sidepanel/**) reads this to know whether the
// companion is usable yet without re-deriving the handshake itself.
let agentHandshakeState = "pending";
let agentHandshakeDetail = null;
// True once Chrome has told us the native-messaging host is not registered for
// this extension — the companion was never installed on this machine, rather
// than installed and briefly down. The distinction is the whole point: one is
// a wait, the other is a missing setup step only the operator can perform, and
// until now both looked identical in the panel ("Đang kết nối", forever).
let companionMissing = false;

// Explicit browser/profile identity (design.md decision 1: "Distinguish
// browser instances with installation/profile connection IDs, not a
// model-provided display name."). `installationId` is generated once and
// persisted in this extension's OWN storage — which chrome.storage.local
// already scopes per browser profile, so a second profile installing the
// same extension gets its own id for free — and never comes from a model or
// a page. `connectionId` is fresh per native-messaging connection, so the
// companion/native-host can tell "the same browser reconnected" apart from
// "a different browser instance is now attached" across a switch_browser
// hand-off.
let installationId = null;
async function ensureInstallationId() {
  if (installationId) return installationId;
  try {
    const stored = await chrome.storage.local.get("ocic_installation_id");
    if (stored && stored.ocic_installation_id) {
      installationId = stored.ocic_installation_id;
      return installationId;
    }
  } catch {}
  installationId = crypto.randomUUID();
  try {
    await chrome.storage.local.set({ ocic_installation_id: installationId });
  } catch {
    // Storage unavailable: keep the in-memory id for this service-worker
    // lifetime rather than failing hello entirely.
  }
  return installationId;
}
// Long-lived ports from other extension surfaces (the sidepanel, once it
// exists) that want the raw agent_msg stream relayed both ways. Named
// "ocic-agent" by convention; anything else connecting is left alone.
const agentPorts = new Set();

async function sendAgentHello() {
  const id = await ensureInstallationId();
  if (!nativePort) return; // may have disconnected while awaiting storage
  const connectionId = crypto.randomUUID();
  try {
    nativePort.postMessage({
      type: "agent_msg",
      envelope: {
        v: AGENT_PROTOCOL_VERSION,
        type: "hello",
        installationId: id,
        connectionId,
        ts: Date.now()
      }
    });
  } catch {
    // Port disconnected; onDisconnect will retry the whole connection.
  }
}

// --- Settings relay (agent_settings) --------------------------------------
//
// extension/settings/settings-client.js's documented wire contract:
//   chrome.runtime.sendMessage({ type: "agent_settings", op, ...payload })
//     -> { ok: true, result } | { ok: false, error: { code, message } }
// Reuses the SAME "existing versioned agent channel" this file already
// speaks for the sidepanel (agent_msg envelopes over nativePort, gated by
// the same hello handshake / fail-closed version semantics) rather than a
// second channel or a parallel message format — settings-client.js's own
// header asks for exactly this. Request/response correlation is needed
// here (unlike the sidepanel's own port relay, which just forwards
// verbatim both ways) because chrome.runtime.sendMessage's single
// sendResponse callback must resolve with the ONE reply matching THIS
// call, not just the next envelope to arrive on the shared channel.
//
// Secret transience (design.md decision 4 / settings-client.js's own file
// header): the API key travels through `handleRequest`'s `payload` spread
// and `postToNative`'s call argument ONLY — never assigned to a variable
// that outlives that synchronous call, never logged (no dbg() call in this
// relay ever receives the full envelope/payload), never written to
// chrome.storage. The companion (once it implements this op) is what
// writes it to the OS credential store.
//
// KNOWN GAP, disclosed rather than hidden: host/agent/companion.js (out of
// this task's file ownership — host/** entirely) does not yet implement an
// "agent_settings" case in its envelope switch as of this session (grepped
// on disk immediately before writing this). Every real request therefore
// currently resolves with a PROTOCOL_ERROR-shaped failure from the
// companion's own generic unknown_message_type reply — never a false
// success. This relay's own correctness (message shaping, hello/version
// reuse, request/response correlation, timeout, and disconnect handling)
// is independently covered by test/background-agent-settings-relay.test.mjs
// against a scripted fake reply, since a real end-to-end pass needs that
// host-side handling to exist first.
// Takes one plain options object (not a destructured parameter) so
// test/_extract.mjs's brace-matching (it finds the first "{" after the
// function name to locate the body) lands on this function's actual body,
// not a destructuring pattern in its own parameter list.
function createAgentSettingsRelay(opts) {
  const { postToNative, isConnected, timeoutMs = 65000, genId } = opts;
  const pending = new Map(); // requestId -> { resolve, timer }
  const newId = genId || (() => crypto.randomUUID());

  function settle(requestId, response) {
    const entry = pending.get(requestId);
    if (!entry) return false;
    clearTimeout(entry.timer);
    pending.delete(requestId);
    entry.resolve(response);
    return true;
  }

  function handleRequest(msg) {
    return new Promise((resolve) => {
      if (!isConnected()) {
        resolve({ ok: false, error: { code: "NETWORK_ERROR", message: "native host not connected" } });
        return;
      }
      const requestId = newId();
      const timer = setTimeout(() => {
        pending.delete(requestId);
        resolve({ ok: false, error: { code: "NETWORK_ERROR", message: "timed out waiting for companion response" } });
      }, timeoutMs);
      pending.set(requestId, { resolve, timer });
      const { type: _drop, ...payload } = msg || {}; // "type" is the wrapper's own field ("agent_settings"), not part of the op payload
      try {
        postToNative({ v: AGENT_PROTOCOL_VERSION, type: "agent_settings", requestId, ...payload, ts: Date.now() });
      } catch (e) {
        settle(requestId, { ok: false, error: { code: "NETWORK_ERROR", message: String(e && e.message) } });
      }
    });
  }

  /** Called from handleAgentMessage() for every inbound envelope; returns
   * true when it consumed (settled) a pending settings request, so the
   * caller knows not to also relay that envelope to sidepanel agent ports
   * (settings traffic is this relay's own business, not the panel's). */
  function handleReply(envelope) {
    if (envelope.type === "agent_settings" && envelope.requestId) {
      return settle(envelope.requestId, { ok: !!envelope.ok, result: envelope.result, error: envelope.error });
    }
    if (envelope.type === "error" && envelope.inReplyTo === "agent_settings") {
      // This generic shape (companion.js's default unknown_message_type
      // case) never echoes a requestId back. Settle the oldest still-
      // pending request instead of leaving it hanging to its timeout —
      // settings operations are issued one at a time by the settings page,
      // so "oldest pending" is the correct match in every real case, and
      // strictly better than an unresolved hang in every other case.
      const oldest = pending.keys().next().value;
      if (oldest !== undefined) {
        return settle(oldest, {
          ok: false,
          error: { code: "PROTOCOL_ERROR", message: envelope.reason || "agent_settings is not supported by the connected companion" }
        });
      }
    }
    return false;
  }

  function handleDisconnect(reason = "native_host_disconnected") {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.resolve({ ok: false, error: { code: "NETWORK_ERROR", message: reason } });
    }
    pending.clear();
  }

  return { handleRequest, handleReply, handleDisconnect };
}

const agentSettingsRelay = createAgentSettingsRelay({
  postToNative: (envelope) => nativePort.postMessage({ type: "agent_msg", envelope }),
  isConnected: () => !!nativePort
});

// --- Profile-cache mirror (extension/sidepanel/profile-cache.js's reader
// side of `ocic_profile_cache_v1`) --------------------------------------
//
// The settings page (extension/settings/**) talks to the companion through
// agentSettingsRelay above via a REQUEST/RESPONSE call — nothing about that
// exchange is ever visible to a different extension page. The sidepanel
// (extension/sidepanel/profile-cache.js) instead reads a STANDING mirror
// from chrome.storage.local under `ocic_profile_cache_v1` and listens for
// chrome.storage.onChanged, so it can reflect "just tested"/"just changed
// the key" without polling. This section is the ONLY writer of that key —
// it mirrors the exact non-secret shape profile-cache.js's own file header
// documents, populated from the real, authoritative
// host/agent/settings/profile.js state (never invented or hand-patched),
// and NEVER includes the API key, `secretBackend`, or `memoryOnlyCredential`
// (none of those are needed by the panel's readiness logic, and the spec's
// "never a secret in chrome.storage" rule is absolute).
const AGENT_SETTINGS_PROFILE_CACHE_KEY = "ocic_profile_cache_v1";
// Matches settings-controller.js's/host/agent/settings/profile-schema.js's
// own DEFAULT_PROFILE_ID literal ("default") — this file cannot import
// either (browser vs. Node module graphs), so it is kept as a small literal
// here, the same convention AGENT_PROTOCOL_VERSION above already uses.
const AGENT_SETTINGS_DEFAULT_PROFILE_ID = "default";

/**
 * Project a full host/agent/settings/profile.js `loadProfile()`-shaped
 * object down to exactly what extension/sidepanel/profile-cache.js's
 * documented contract needs — never the credential, never `secretBackend`/
 * `memoryOnlyCredential` (both harmless as text but not needed here, so left
 * out on the side of least data in chrome.storage).
 * @param {object|null} profile
 * @returns {object|null}
 */
function toProfileCacheMirror(profile) {
  if (!profile) return null;
  return {
    profileId: profile.profileId,
    baseUrl: profile.baseUrl,
    models: Array.isArray(profile.models) ? profile.models.map((m) => ({ id: m.id, label: m.label })) : [],
    defaultModelId: profile.defaultModelId,
    revision: profile.revision,
    credentialRevision: profile.credentialRevision || 0,
    hasCredential: !!profile.hasCredential,
    // host/agent/settings/capability-test.js's {status, capabilities, errors,
    // timestamp} records, keyed by host/agent/settings/profile-schema.js's
    // capabilityTestKey(baseUrl, modelId, credentialRevision) — the exact
    // same non-secret shape extension/settings/settings-app.js already
    // renders directly in its own capability-detail pills. No secret is ever
    // part of this record.
    lastCapabilityTest:
      profile.lastCapabilityTest && typeof profile.lastCapabilityTest === "object" ? { ...profile.lastCapabilityTest } : {}
  };
}

/** Write (or clear, for `profile === null`) the mirrored cache. Failure to
 * write is never fatal — profile-cache.js's own reader already treats a
 * missing/absent cache as "not configured", the correct safe default. */
async function writeProfileCacheMirror(profile) {
  try {
    await chrome.storage.local.set({ [AGENT_SETTINGS_PROFILE_CACHE_KEY]: toProfileCacheMirror(profile) });
  } catch {
    // storage unavailable in this browser/session — nothing else to do.
  }
}

/** Re-fetch the authoritative profile from the companion (a plain
 * `get_profile` call through the SAME relay every other settings op already
 * uses — not a new channel) and mirror it. Used both at native-host
 * connect/reconnect time (a panel opened before any settings change should
 * still see current state, not an empty cache) and after any settings op
 * whose OWN reply does not already carry the full profile (see
 * `syncProfileCacheAfterAgentSettings` below). */
async function refreshProfileCacheMirror(profileId = AGENT_SETTINGS_DEFAULT_PROFILE_ID) {
  const reply = await agentSettingsRelay.handleRequest({ type: "agent_settings", op: "get_profile", profileId });
  if (reply && reply.ok) await writeProfileCacheMirror(reply.result);
}

/**
 * Called after every `agent_settings` request this relay answers (see the
 * chrome.runtime.onMessage listener below), AFTER the caller (the settings
 * page) has already been sent its own response — this never adds latency to
 * that call, it only keeps the sidepanel's mirror in sync with what the
 * settings page just did.
 *
 * `get_profile`/`save_profile` replies already carry the full profile
 * (host/agent/settings/profile.js's loadProfile()/saveProfile() — see
 * host/agent/companion.js's `_handleAgentSettings`), so those are mirrored
 * directly with no extra round trip. `set_credential`/`remove_credential`/
 * `test_capability`/`discover_models` reply with only their own narrow
 * result shape (`{backend}`/`{removed:true}`/the raw capability-test
 * result/`{supported,...}`) — none of those alone are enough to know the
 * new `hasCredential`/`credentialRevision`/`lastCapabilityTest` state, so
 * those four re-fetch the authoritative profile instead of hand-patching a
 * guess from the narrow reply.
 * @param {{ op?: string, profileId?: string }} request
 * @param {{ ok: boolean, result?: any }} response
 */
async function syncProfileCacheAfterAgentSettings(request, response) {
  if (!response || !response.ok) return; // the op failed: host state did not change
  const op = request && request.op;
  const profileId = (request && request.profileId) || AGENT_SETTINGS_DEFAULT_PROFILE_ID;
  if (op === "get_profile" || op === "save_profile") {
    await writeProfileCacheMirror(response.result);
    return;
  }
  if (op === "set_credential" || op === "remove_credential" || op === "test_capability" || op === "discover_models") {
    await refreshProfileCacheMirror(profileId);
  }
}

// Pending USER_ATTACHMENT_STORED acks: attachmentId/artifactId -> { resolve, reject, timer }
const pendingAttachmentAcks = new Map();

function handleAgentMessage(envelope) {
  if (!envelope || typeof envelope !== "object") return;
  if (envelope.type === "user_attachment_stored") {
    const aid = envelope.attachmentId || envelope.artifactId;
    const pend = aid && pendingAttachmentAcks.get(aid);
    if (pend) {
      clearTimeout(pend.timer);
      pendingAttachmentAcks.delete(aid);
      if (envelope.stored) pend.resolve(envelope);
      else pend.reject(new Error(envelope.reason || "attachment_not_stored"));
    }
  }
  if (agentSettingsRelay.handleReply(envelope)) return;
  if (envelope.type === "hello_ack") {
    agentHandshakeState = "ok";
    agentHandshakeDetail = null;
  } else if (envelope.type === "version_mismatch") {
    // Fail closed: never guess a compatible shape and keep talking.
    agentHandshakeState = "version_mismatch";
    agentHandshakeDetail = envelope.reason || "unsupported_version";
    dbg("agent", "protocol version mismatch with companion", envelope);
  } else if (envelope.type === "error") {
    agentHandshakeDetail = envelope.reason || "error";
  }
  // Overlay bridge (design.md 5c): observe — never alter — the run-lifecycle
  // events already flowing through this relay, so a Stop/error/interrupt
  // clears that run's overlay right away rather than only via its local
  // heartbeat expiry (see OVERLAY_TEARDOWN_RUN_EVENTS/teardownOverlayForRun
  // below). This reads the envelope; it does not change what gets relayed
  // to agentPorts below, which still happens verbatim exactly as before.
  if (envelope.type === "stream_event" && envelope.event && envelope.runId && OVERLAY_TEARDOWN_RUN_EVENTS.has(envelope.event.type)) {
    teardownOverlayForRun(envelope.runId, envelope.event.type);
  }
  // The other end of the same lifecycle, observed the same way: a run that has
  // just taken the browser lease gets its overlay raised on the tabs it holds,
  // instead of the page staying unmarked until the first tool that names one.
  if (envelope.type === "stream_event" && envelope.event && envelope.runId && envelope.event.type === "run_started") {
    startOverlayForRun(envelope.runId, envelope.event.tabScope).catch(() => {});
  }
  // Overlay approval bridge (design.md D5 / redesign-remote-control-overlay
  // task 5.1): the same observe-only pattern as the teardown hook above, on
  // the SAME sendOverlayMessage path (forwardApprovalToOverlay below) — no
  // second channel. `approval_request` arrives wrapped as a stream_event
  // (host/agent/policy/can-use-tool.js's run.emit() payload, per
  // host/agent/companion.js's own STREAM_EVENT wrapping); `approval_decision`
  // arrives as its own top-level envelope — the direct reply to the panel's
  // decision request (host/agent/companion.js's _handleApprovalDecision).
  // Neither changes what gets relayed to agentPorts below.
  if (envelope.type === "stream_event" && envelope.event && envelope.event.type === "approval_request" && envelope.runId) {
    forwardApprovalToOverlay(envelope.runId, {
      type: "browzyOverlayApproval",
      phase: "pending",
      requestId: envelope.event.requestId,
      action: envelope.event.action,
      target: envelope.event.target
    });
  } else if (envelope.type === "approval_decision" && envelope.runId) {
    forwardApprovalToOverlay(envelope.runId, {
      type: "browzyOverlayApproval",
      phase: "resolved",
      requestId: envelope.requestId
    });
  }
  // Relay verbatim to every connected agent-channel port (the sidepanel,
  // once extension/sidepanel/** exists) — background.js does not interpret
  // stream_event/snapshot/token_batch/chunk_* payloads itself.
  for (const port of agentPorts) {
    try {
      port.postMessage({ type: "agent_msg", envelope });
    } catch {
      // Port gone; onDisconnect below will remove it.
    }
  }
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "ocic-agent") return;
  agentPorts.add(port);
  // A late-connecting panel gets the current handshake state immediately,
  // rather than waiting for the next native-host event (which may never
  // come again once the handshake has already settled).
  if (agentHandshakeState !== "pending") {
    try {
      port.postMessage({
        type: "agent_msg",
        envelope:
          agentHandshakeState === "ok"
            ? { v: AGENT_PROTOCOL_VERSION, type: "hello_ack", ts: Date.now() }
            : { v: AGENT_PROTOCOL_VERSION, type: agentHandshakeState, reason: agentHandshakeDetail, ts: Date.now() }
      });
    } catch {}
  }
  port.onMessage.addListener((msg) => {
    if (!msg || msg.type !== "agent_msg" || !msg.envelope) return;
    if (!nativePort) {
      try {
        port.postMessage({
          type: "agent_msg",
          envelope: { v: AGENT_PROTOCOL_VERSION, type: "error", reason: "native_host_unavailable", ts: Date.now() }
        });
      } catch {}
      return;
    }
    try {
      nativePort.postMessage(msg);
    } catch {}
  });
  port.onDisconnect.addListener(() => agentPorts.delete(port));
});

// --- Per-call timing forensics -------------------------------------------
// Ring buffer of tool-call timings, persisted to chrome.storage.session so a
// worker restart doesn't lose the window we were trying to catch. Exists to
// pin down a field-observed failure mode: calls against certain tabs paying a
// flat ~1s quantum each (payload-independent), in windows lasting minutes.
// Read (and optionally clear) via the debug_timings tool.
const bootAt = Date.now();
const callTimings = [];
let timingsDirty = 0;
function recordTiming(entry) {
  callTimings.push(entry);
  if (callTimings.length > 600) callTimings.splice(0, callTimings.length - 600);
  if (++timingsDirty >= 20) {
    timingsDirty = 0;
    try {
      chrome.storage.session.set({ mcp_call_timings: callTimings.slice(), mcp_boot_at: bootAt });
    } catch {}
  }
}
const attachedTabs = new Map(); // tabId -> { enabledDomains: Set }
const consoleMessages = new Map(); // tabId -> [{level, text, timestamp, url}]
const networkRequests = new Map(); // tabId -> [{url, method, status, type, timestamp}]
// tabId -> Map<requestId, record> — lets responseReceived augment the entry
// created by requestWillBeSent instead of recording each request twice.
const networkByRequestId = new Map();
const screenshotStore = new Map(); // imageId -> base64
const screenshotSaves = new Map(); // reqId -> { resolve, reject } for save_to_disk

// --- Panel attachment byte store (in-memory only) --------------------------
//
// Mirrors `screenshotStore`'s shape and lifetime rule above: user-composer
// image bytes (pasted/dropped/picked in the sidepanel) live ONLY here for the
// span between capture and Send-completes — never chrome.storage, never a
// log line, never a diagnostics/settings/session export. Nothing in this file
// ever hands base64 or raw bytes to dbg()/console or serializes them into
// storage; only ids, MIME types, and sizes are named anywhere else (task 3.5
// of adopt-panel-design-and-image-attachments; the same secrets-never-logged
// discipline host/test/secrets-redaction.test.mjs enforces host-side).
//
// Keyed by panelId -> Map<attachmentId, { base64, mimeType, byteLength }> so
// one panel's attachments are addressable and disposable as a set; the
// sidepanel's entry points (drag-drop / Ctrl+V / Ctrl+U picker, task 2.x) are
// the ONLY writers, via addPanelAttachment() below. Handled the same way
// screenshotStore is across service-worker eviction: bytes evaporate with the
// worker, and the panel's stored/not-stored ack discipline (user_attachment_stored
// over the ocic-agent relay) makes a lost pre-Send attachment a visible
// failure, never a silent text-only send.
const panelAttachmentStore = new Map();

// Where the cursor currently is, PER TAB. Viewport coordinates are tab-local,
// so a single global cursor would start a move in tab B from tab A's position
// — meaningless, and anomalous in its own right. Seeded on first interaction,
// dropped when the tab closes.
const cursorByTab = new Map(); // tabId -> { x, y }

// Per-tab "document identity" for the action-event schema (design.md 5c /
// reports/05-action-event-schema.md). See action-events.js's
// DocumentIdTracker header comment for exactly what this does and does not
// observe (browser-visible URL changes only — not content.js's own SPA
// documentEpoch, which is out of this batch's scope).
const actionDocTracker = new actionEvents.DocumentIdTracker();

// The P0 minimum document identity primitive (design.md decision 6 /
// tasks.md 1.2-1.3) — see extension/events/document-identity.js's own
// header for the full contract and the gate-1.1 evidence it is built on.
// Unlike `actionDocTracker` above (a best-effort action-event id, design.md
// 5c, never authoritative for anything), this tracker is the one that
// CONFIRMS identity via the content-script handshake and can fail closed.
// Later work (groups 2/3/7) wires this into send/lease/read/mutation/
// approval; this batch only produces and confirms real bindings.
const documentBindings = new documentIdentity.DocumentBindingTracker();

// One humanization "hand" for the life of the service worker: a seeded rng
// plus a persona (tempo, steadiness, overshoot). Reused across actions so a
// session is internally consistent rather than re-rolling its character every
// click. Lazily created — costs nothing when humanize is off.
let humanSession = null;
let humanSessionSeed = null; // the seed the live session was built from

/**
 * The humanization "hand" for this browser: one persona (tempo, steadiness,
 * overshoot) reused across actions and tabs, because a person does not become
 * someone else between clicks or when they switch tab.
 *
 * With humanize_seed unset the hand is random per service-worker lifetime,
 * which is what production wants — two sessions should not share a trajectory
 * signature. Pinning the seed rebuilds the session deterministically, so a
 * controlled comparison can hold the hand fixed and vary only the tier.
 */
function human(speed, seed) {
  const tier = speed || "fast";
  const wantSeed = typeof seed === "number" ? seed : null;
  if (!humanSession || wantSeed !== humanSessionSeed) {
    humanSession = humanize.createSession(wantSeed === null ? undefined : wantSeed, tier);
    humanSessionSeed = wantSeed;
  } else {
    humanize.setSpeed(humanSession, tier);
  }
  return humanSession;
}

let heartbeatTimer = null;

// switch_browser releases this browser's hold on the shared runtime by
// dropping the native port; this window keeps us from immediately re-grabbing
// it so a target browser (extension enabled) can become primary.
let suspendReconnectUntil = 0;
const SWITCH_RELEASE_MS = 15000;

async function detectBrowser() {
  try {
    if (navigator.brave && (await navigator.brave.isBrave?.())) return "Brave";
  } catch (e) {}
  const ua = navigator.userAgent || "";
  if (/Edg\//.test(ua)) return "Edge";
  const brands = (navigator.userAgentData?.brands || []).map((b) => b.brand).join(" ");
  if (/Brave/i.test(brands)) return "Brave";
  if (/OPR\//.test(ua)) return "Opera";
  return "Chrome";
}

// Browser-aware mouse ack strategy. Whether we're on Brave is stable for the
// life of the service worker, so cache the detection at module level and
// resolve it lazily (detectBrowser is async). null = not yet determined.
let IS_BRAVE = null;

async function isBrave() {
  if (IS_BRAVE === null) {
    IS_BRAVE = (await detectBrowser()) === "Brave";
  }
  return IS_BRAVE;
}

// --- Keep-alive alarm ---
// Backstop wake-up for the MV3 service worker. The proactive heartbeat
// inside connectNativeHost (~15s) is the primary mechanism; this alarm
// covers cases where the SW is fully evicted between heartbeats.
chrome.alarms.create("keepalive", { periodInMinutes: 0.4 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "keepalive") {
    if (!nativePort) connectNativeHost();
  }
});

// --- Native messaging ---
// Chrome's own wording when `connectNative` cannot reach a host. The first is
// "no native-messaging manifest for this host name" — i.e. the companion was
// never installed on this machine, or its registration was removed. The second
// is a manifest that exists but does not list this extension's id in
// `allowed_origins`, which is the same operator-visible problem (install.sh
// was never run for THIS build) and has the same answer.
//
// Matching Chrome's message text is unavoidable: `chrome.runtime.lastError`
// carries no code. It is matched loosely (lowercased substrings) so a wording
// change degrades to the old behaviour — a generic retry — rather than to a
// wrong claim about the operator's machine.
const NATIVE_HOST_ABSENT_PATTERNS = ["not found", "forbidden"];

function isNativeHostAbsent(message) {
  if (!message) return false;
  const text = String(message).toLowerCase();
  return NATIVE_HOST_ABSENT_PATTERNS.some((p) => text.includes(p));
}

// Reconnect backoff. 250ms is right when the host is installed and merely
// restarting — reconnect latency dominates per-call wall-clock. It is wrong
// when the host was never installed: that loop then runs four times a second
// for the life of the browser, achieving nothing, and keeping the service
// worker awake to do it. On a host that is absent the delay climbs to
// NATIVE_RETRY_MAX_MS; the keepalive alarm above still retries every ~24s
// regardless, so a companion installed later is still picked up on its own.
const NATIVE_RETRY_MIN_MS = 250;
const NATIVE_RETRY_MAX_MS = 30000;
let nativeRetryDelayMs = NATIVE_RETRY_MIN_MS;

/** Record whether the companion is absent, and tell every open panel — but
 * only when the answer CHANGES, so a backing-off retry loop does not push the
 * same envelope every few seconds. `agentHandshakeState` is set to "error"
 * with a reason the panel already knows how to route (protocol-client.js maps
 * a connection-scoped error reason to HANDSHAKE.ERROR), so nothing new is
 * needed on the wire for the panel to stop saying "connecting". */
function setCompanionMissing(missing, detail) {
  if (companionMissing === missing) return;
  companionMissing = missing;
  if (missing) {
    agentHandshakeState = "error";
    agentHandshakeDetail = "companion_not_installed";
    dbg("port", "companion is not installed on this machine", { err: detail ? String(detail).slice(0, 120) : null });
    const envelope = { v: AGENT_PROTOCOL_VERSION, type: "error", reason: "companion_not_installed", ts: Date.now() };
    for (const port of agentPorts) {
      try {
        port.postMessage({ type: "agent_msg", envelope });
      } catch {
        // Port gone; its own onDisconnect removes it.
      }
    }
  } else {
    // Found again: back to the fast retry floor, so a companion that restarts
    // during a run reconnects at 250ms rather than at whatever the backoff had
    // climbed to while it was gone.
    nativeRetryDelayMs = NATIVE_RETRY_MIN_MS;
  }
}

function scheduleNativeReconnect() {
  const delay = nativeRetryDelayMs;
  if (companionMissing) nativeRetryDelayMs = Math.min(nativeRetryDelayMs * 2, NATIVE_RETRY_MAX_MS);
  setTimeout(connectNativeHost, delay);
}

function connectNativeHost() {
  if (nativePort) return;
  // Honor a switch_browser release window: stay disconnected so another
  // browser can take the primary connection, then resume.
  if (Date.now() < suspendReconnectUntil) {
    setTimeout(connectNativeHost, 500);
    return;
  }
  try {
    nativePort = chrome.runtime.connectNative(NATIVE_HOST_NAME);

    nativePort.onMessage.addListener((msg) => {
      // Heartbeat acks (and any other non-request server-originated messages)
      // are intentionally ignored here — only tool_request kicks work.
      if (msg.type === "tool_request" && msg.id) {
        // msg.runId (and its sibling lease fields) is only ever present for an
        // SDK-path call — host/tool-runtime.js's sendToExtension() only adds
        // them when the caller passed a `meta` (host/agent/tools/adapter.js;
        // legacy MCP callers never do). Building `meta` as undefined for the
        // legacy case, rather than an object with undefined fields, keeps
        // isInGroup()'s `currentToolMeta && currentToolMeta.runId` check
        // (see its definition below) identical to no meta ever having
        // existed at all. handleToolRequest() assigns this to the
        // module-level `currentToolMeta` immediately before invoking a
        // handler — see its own comment for why.
        const meta = msg.runId
          ? {
              runId: msg.runId,
              conversationId: msg.conversationId,
              browserIdentity: msg.browserIdentity,
              tabScope: msg.tabScope,
              requestId: msg.requestId
            }
          : undefined;
        handleToolRequest(msg.id, msg.tool, msg.args || {}, meta);
      } else if (msg.type === "recording_saved") {
        // Reply from the native host after writing a recording bundle to disk.
        const resolve = recorder.pendingSaves.get(String(msg.recording_id));
        if (resolve) {
          recorder.pendingSaves.delete(String(msg.recording_id));
          resolve(msg.ok ? msg.path : null);
        }
      } else if (msg.type === "screenshot_saved") {
        // Reply from the native host after writing a screenshot to disk
        // (save_to_disk on the computer tool's screenshot action).
        const pending = screenshotSaves.get(String(msg.id));
        if (pending) {
          screenshotSaves.delete(String(msg.id));
          if (msg.ok && msg.path) pending.resolve(msg.path);
          else pending.reject(new Error(msg.error || "failed to save screenshot"));
        }
      } else if (msg.id && pendingNative.has(msg.id)) {
        // Generic reply to a nativeRequest() (e.g. write_temp_file). The host
        // echoes the request id back so we can settle the matching promise.
        const p = pendingNative.get(msg.id);
        pendingNative.delete(msg.id);
        if (msg.ok) p.resolve(msg.result);
        else p.reject(new Error(String(msg.error || "Native request failed")));
      } else if (msg.type === "agent_msg" && msg.envelope) {
        handleAgentMessage(msg.envelope);
      }
    });

    nativePort.onDisconnect.addListener(() => {
      const err = chrome.runtime.lastError;
      dbg("port", `native host disconnected`, { err: err && String(err.message).slice(0, 120) });
      // Chrome reports "host not found" / "forbidden" through lastError on the
      // very first connect attempt when the companion was never registered.
      // Until this line that message went only to the debug log, so a machine
      // with no companion was indistinguishable from one whose companion was
      // restarting — both showed "Đang kết nối" and retried forever.
      setCompanionMissing(isNativeHostAbsent(err && err.message), err && err.message);
      nativePort = null;
      agentHandshakeState = "pending";
      agentHandshakeDetail = null;
      agentSettingsRelay.handleDisconnect("native_host_disconnected");
      // Overlay bridge (design.md 5c: "companion loss" clears stale
      // overlays): the whole native-messaging connection just dropped, a
      // stronger signal than any single run ending — clear every tab's
      // overlay this service worker currently believes is showing one.
      teardownAllOverlays("companion_disconnected");
      stopHeartbeat();
      // Retry quickly. Reconnect latency dominates per-call wall-clock when
      // the SW just slept; 250ms is the right floor — fast enough to be
      // invisible to a single tool call, slow enough not to busy-spin on a
      // genuinely dead host (which will be retried again on next alarm).
      // scheduleNativeReconnect() keeps that floor for an installed host and
      // backs off only when Chrome said the host is not registered at all.
      scheduleNativeReconnect();
    });

    // The port opened, so whatever Chrome said on a previous attempt is stale:
    // the companion IS registered. Clearing here (rather than only on
    // hello_ack) keeps the panel from showing "chưa cài" while a freshly
    // installed companion is still completing its handshake.
    setCompanionMissing(false, null);
    startHeartbeat();
    // Version handshake for the SDK companion channel (design.md decision 1:
    // "hello/version... Unknown versions fail closed."). Ordinary tool
    // dispatch does not depend on this succeeding; it only gates the
    // separate agent_msg channel a future sidepanel uses.
    sendAgentHello();
    // Populate extension/sidepanel/profile-cache.js's mirror on every
    // connect/reconnect (service-worker startup, and again after any
    // companion restart) — a panel opened before any settings-page change
    // this session should still see the real current state, not an empty
    // cache. `agent_settings` ops are deliberately not gated on the hello
    // handshake above (see host/agent/companion.js's `_handleAgentSettings`
    // header), so this does not need to wait for hello_ack either.
    refreshProfileCacheMirror().catch(() => {});
  } catch (e) {
    nativePort = null;
    stopHeartbeat();
    // connectNative() itself threw — same classification as a disconnect, so
    // an absent host backs off here too rather than spinning.
    if (isNativeHostAbsent(e && e.message)) setCompanionMissing(true, e && e.message);
    scheduleNativeReconnect();
  }
}

// Proactive heartbeat: send a small message every ~15s while the native
// port is alive. Two effects:
//   1) The SW stays alive between alarm fires (postMessage resets the
//      ~30s idle timer Chrome uses to evict MV3 service workers).
//   2) The native-host TCP socket stays warm — no chance of Chrome
//      garbage-collecting the connection because it's been idle.
// 15s is well under both Chrome's SW idle timeout and the alarm period.
function startHeartbeat() {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    if (!nativePort) return;
    try {
      nativePort.postMessage({ type: "heartbeat", t: Date.now() });
    } catch {
      // Port disconnected; the onDisconnect handler will reconnect.
    }
  }, 15000);
}

function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

function sendResponse(id, result) {
  if (!nativePort) return;
  try {
    nativePort.postMessage({ id, type: "tool_response", result });
  } catch {
    // Port disconnected
  }
}

function sendError(id, error) {
  if (!nativePort) return;
  try {
    nativePort.postMessage({ id, type: "tool_error", error: String(error) });
  } catch {
    // Port disconnected
  }
}

// --- Native host request/response (ask host to do something, wait for result) ---
// The recorder's save_* messages are fire-and-forget; upload_image needs a
// reply (the temp file path). pendingNative correlates a reply by id. Bound
// the wait so a lost reply can't hang a tool call past the CDP timeout.
const pendingNative = new Map(); // request id -> { resolve, reject }
let nativeReqSeq = 0;

function nativeRequest(msg) {
  return new Promise((resolve, reject) => {
    if (!nativePort) { reject(new Error("Native host not connected")); return; }
    const id = `nr_${Date.now()}_${nativeReqSeq++}`;
    pendingNative.set(id, { resolve, reject });
    nativePort.postMessage({ ...msg, id });
    setTimeout(() => {
      const p = pendingNative.get(id);
      if (p) { pendingNative.delete(id); p.reject(new Error("Native request timed out")); }
    }, CDP_TIMEOUT_MS);
  });
}

// --- Tab group management ---

/**
 * Which label the group should currently wear. A dispatch carrying a run id
 * came from this extension's own assistant; anything else is an external MCP
 * client. `titleOverride` is for callers outside a tool dispatch (the panel
 * adopting its bound tab), where there is no currentToolMeta to read.
 *
 * The `typeof` guard is the same one tabs_create_mcp uses: this file's method
 * bodies are extracted and compiled standalone by test/handlers.test.mjs and
 * test/registry-borrowed-tab-scope.test.mjs against a fixed dependency list,
 * where a bare reference would throw instead of being a no-op.
 */
function agentTabGroupTitle(titleOverride) {
  if (titleOverride) return titleOverride;
  const isOwnAssistant =
    typeof currentToolMeta !== "undefined" && currentToolMeta && currentToolMeta.runId;
  return isOwnAssistant ? AGENT_TAB_GROUP_TITLE : MCP_TAB_GROUP_TITLE;
}

async function ensureTabGroup(createIfEmpty, titleOverride) {
  const wantedTitle = agentTabGroupTitle(titleOverride);
  // Check if our tab group still exists
  if (tabGroupId !== null) {
    try {
      const group = await chrome.tabGroups.get(tabGroupId);
      if (group) {
        // Verify tabs are still in the group
        const tabs = await chrome.tabs.query({ groupId: tabGroupId });
        tabGroupTabs = new Set(tabs.map((t) => t.id));
        if (tabGroupTabs.size > 0) {
          // Takeover: the other client is driving now, so relabel rather than
          // leaving a stale name on a group that is no longer theirs.
          if (group.title !== wantedTitle) {
            try {
              await chrome.tabGroups.update(tabGroupId, { title: wantedTitle });
            } catch {
              // Cosmetic only — never fail a dispatch over a group label.
            }
          }
          return;
        }
      }
    } catch {
      tabGroupId = null;
      tabGroupTabs.clear();
    }
  }

  if (!createIfEmpty) return;

  // Create a new window with a tab, group it. focused:false — the window is
  // created and rendered, but does not jump in front of whatever the operator
  // is doing. set_tab_focus raises it on purpose when that is actually wanted.
  const win = await chrome.windows.create({ focused: false, url: "about:blank" });
  const tab = win.tabs[0];
  // Claimed BEFORE the grouping call, not after: grouping fires the events
  // guardInheritedTabGroup() listens on, and a tab that is not on the books
  // by the time one arrives looks exactly like a tab the operator opened.
  tabGroupTabs.add(tab.id);
  const groupId = await chrome.tabs.group({ tabIds: [tab.id] });
  await chrome.tabGroups.update(groupId, { title: wantedTitle, color: "blue" });
  tabGroupId = groupId;
  tabGroupTabs = new Set([tab.id]);
}

function formatTabContext(tabs) {
  const available = tabs.map((t) => ({
    tabId: t.id,
    title: t.title || "Untitled",
    url: t.url || "",
  }));

  let text = `Tab Context:\n- Available tabs:\n`;
  for (const t of available) {
    text += `  \u2022 tabId ${t.tabId}: "${t.title}" (${t.url})\n`;
  }

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({ availableTabs: available, tabGroupId }) + "\n\n" + text,
      },
    ],
  };
}

// --- SDK-path borrowed-tab scope (design.md decision 5b) -------------------
//
// `currentToolMeta` carries the SDK-path wire fields (runId/tabScope/etc. —
// see host/agent/broker/browser-lease.js's describeForWire(), forwarded
// verbatim by host/tool-runtime.js's sendToExtension()) for whichever
// tool_request handleToolRequest() is CURRENTLY dispatching to a handler. It
// is undefined for every legacy MCP call (host/mcp-server.js,
// host/codemode/*, which never attach a runId), so isInGroup()'s legacy
// branch below — the real Chrome "MCP" tab group — is exactly as byte-for-
// byte unchanged for them as if this variable never existed.
//
// It is deliberately NOT a handler parameter: extension/background.js's
// `toolHandlers` object methods are extracted from this file BY NAME AND
// EXACT SIGNATURE TEXT (test/_extract.mjs's extractMethod(), shared by the
// out-of-this-task's-ownership test/handlers.test.mjs and by this task's own
// test/registry-baseline.test.mjs) — every one of the 26 handlers must keep
// its original `(args)` signature, or that shared extractor's literal
// `  async ${name}(args)` string match breaks for every tool, not just the
// ones this task touches. handleToolRequest() (below, never itself
// extracted by name) sets this variable synchronously, immediately before
// invoking a handler — with no `await` in between — so any handler whose own
// first action is an (also synchronous-until-its-own-await) call into
// isInGroup() reads exactly the value meant for THAT dispatch, never a
// different concurrent call's, before either function's first real yield to
// the event loop. tabs_close_mcp (the one handler that calls isInGroup()
// more than once, across multiple internal awaits) additionally captures its
// own local snapshot at entry rather than re-reading this variable on every
// loop iteration, so it stays correct even if something else overwrites this
// module-level value mid-loop.
let currentToolMeta;

// --- Action-event identity for the CURRENTLY dispatching tool_request ------
//
// Parallel to `currentToolMeta` above and set/reset by the exact same
// synchronous-before-the-handler-call / reset-in-finally discipline (see the
// long comment above for why that ordering is race-free across concurrent
// dispatch): `currentAction` is the read-only action-event identity
// (actionId/streamKey/tab/document/etc. — see emitActionStart() below) for
// whichever handler is CURRENTLY running, and `currentActionExtras` is a
// small mutable slot a handler may write into (never read its own previous
// value — write-only from the handler's point of view) to attach information
// only IT has: an artifact id for a capture, or an outcome the handler's own
// existing post-action verification already computed. handleToolRequest()
// reads `currentActionExtras` once, immediately after the handler settles,
// to build the `complete`/`error` event — never before, and never from
// anything the handler merely PLANNED to do.
let currentAction = null;
let currentActionExtras = null;

/** Pure derivation of the one bit of "did this dispatch's effect verify?"
 * information the handler-level code already computes today (the `hitNote`
 * warning text computer() builds from probeHit()/resolveRefToCoordinates()).
 * This is NOT new verification — see design.md 5c: "Successful dispatch is
 * not proof of the intended DOM effect. Preserve existing post-action
 * verification and unknown-outcome states" — it only re-labels an existing
 * signal for the schema's `outcome.status` field. */
function deriveOutcomeStatus(existingWarningText) {
  return existingWarningText ? actionEvents.OUTCOME_STATUSES.UNKNOWN : actionEvents.OUTCOME_STATUSES.SUCCESS;
}

/** Emit the `start` event for a tool_request and return the action-event
 * identity (`ctx`) later calls (emitActionProgress/emitActionSettled) need.
 * Called by handleToolRequest() BEFORE `await handler(args)` — see its call
 * site for the exact ordering guarantee tasked acceptance criteria require
 * ("start precedes execution"). */
function emitActionStart(tool, args, meta) {
  const { type, op } = actionEvents.classifyAction(tool, args);
  const runId = (meta && meta.runId) || null;
  const conversationId = (meta && meta.conversationId) || null;
  const requestId = (meta && meta.requestId) || null;
  const tabId = args && typeof args.tabId === "number" ? args.tabId : null;
  const documentId = actionDocTracker.current(tabId);
  const streamKey = actionEvents.streamKeyForRun(runId);
  const actionId = actionEvents.newActionId();
  const startedAt = Date.now();
  const { summary, redaction } = actionEvents.summarize(tool, args);
  actionEvents.emitActionEvent(
    actionEvents.buildEvent({
      kind: actionEvents.EVENT_KINDS.START,
      streamKey,
      runId,
      conversationId,
      requestId,
      actionId,
      tabId,
      documentId,
      action: { type, tool, op },
      timing: { startedAt, endedAt: null },
      pointer: null,
      capture: null,
      summary,
      redaction,
      outcome: null
    })
  );
  return { actionId, runId, conversationId, requestId, tabId, documentId, streamKey, type, tool, op, startedAt, args };
}

/** Emit a `progress` event carrying a batch of ALREADY-dispatched pointer
 * points, grouped under the parent action identified by `ctx`. Never called
 * for a non-pointer-capable action type — buildEvent() enforces that too. */
function emitActionProgress(ctx, points) {
  if (!ctx || !points || !points.length) return;
  actionEvents.emitActionEvent(
    actionEvents.buildEvent({
      kind: actionEvents.EVENT_KINDS.PROGRESS,
      streamKey: ctx.streamKey,
      runId: ctx.runId,
      conversationId: ctx.conversationId,
      requestId: ctx.requestId,
      actionId: ctx.actionId,
      tabId: ctx.tabId,
      documentId: ctx.documentId,
      action: { type: ctx.type, tool: ctx.tool, op: ctx.op },
      timing: { startedAt: ctx.startedAt, endedAt: null },
      pointer: { points, frame: { frameId: 0, isMainFrame: true } },
      capture: null,
      summary: "",
      redaction: { applied: false, reason: null },
      outcome: null
    })
  );
}

/** Build a step-callback for dispatchPlan()/mouseClick() that batches real
 * dispatched pointer steps and flushes them as grouped `progress` events
 * (design.md 5c: "Group low-level movement samples within their parent
 * action rather than emitting hundreds of rows"). Returns null when the
 * action is not pointer-capable, so call sites can pass the result straight
 * through without their own type check. */
function makePointerStepHandler(ctx) {
  if (!ctx || !actionEvents.isPointerCapable(ctx.type)) return null;
  const batcher = new actionEvents.PointBatcher(20);
  const onStep = (step) => {
    if (step.k !== "move" && step.k !== "down" && step.k !== "up" && step.k !== "wheel") return;
    const full = batcher.push({ x: step.x, y: step.y, t: Date.now(), phase: step.k });
    if (full) emitActionProgress(ctx, full);
  };
  onStep.flush = () => {
    const rest = batcher.drain();
    if (rest) emitActionProgress(ctx, rest);
  };
  return onStep;
}

/** Emit the `complete`/`error` event for a tool_request, from ONLY the
 * handler's actual settled outcome (never from an args-only guess). Called
 * by handleToolRequest() immediately after `await handler(args)`
 * resolves/throws — see its call site. */
function emitActionSettled(ctx, kind, opts) {
  if (!ctx) return;
  // Plain-object param, not destructured in the signature itself, so this
  // function stays extractable by test/_extract.mjs's brace-counting
  // extractor — a destructured default parameter's own braces would confuse
  // that count. See test/action-events-emission.test.mjs.
  const extras = opts && opts.extras;
  const errorSummary = opts && opts.errorSummary;
  const capture = extras && extras.artifactId ? { artifactId: extras.artifactId } : null;
  const outcomeStatus =
    kind === actionEvents.EVENT_KINDS.ERROR
      ? actionEvents.OUTCOME_STATUSES.ERROR
      : (extras && extras.outcomeStatus) || actionEvents.OUTCOME_STATUSES.SUCCESS;
  const outcomeDetail = kind === actionEvents.EVENT_KINDS.ERROR ? errorSummary : (extras && extras.outcomeDetail) || null;
  const { summary, redaction } = actionEvents.summarize(ctx.tool, ctx.args || {});
  actionEvents.emitActionEvent(
    actionEvents.buildEvent({
      kind,
      streamKey: ctx.streamKey,
      runId: ctx.runId,
      conversationId: ctx.conversationId,
      requestId: ctx.requestId,
      actionId: ctx.actionId,
      tabId: ctx.tabId,
      documentId: ctx.documentId,
      action: { type: ctx.type, tool: ctx.tool, op: ctx.op },
      timing: { startedAt: ctx.startedAt, endedAt: Date.now() },
      pointer: null,
      capture,
      summary,
      redaction,
      outcome: { status: outcomeStatus, detail: outcomeDetail }
    })
  );
}

// --- Agent pointer overlay bridge (design.md 5c / task 5.9) ---------------
//
// Delivers the SAME action-event stream action-events.js already emits
// in-process (see emitActionStart/emitActionProgress/emitActionSettled
// above) to the controlled tab's own overlay (extension/overlay/
// pointer-overlay.js). This section is pure transport: it never derives,
// delays, reorders, or invents an event — every message it sends IS one of
// the real objects action-events.js already built for a real dispatch.
//
// Injection mirrors sendContentMessage()'s existing shape exactly (try
// chrome.tabs.sendMessage, and only on failure chrome.scripting.executeScript
// then retry once) — a fresh document (navigation) or a tab whose overlay
// was never injected both "just work" without this module tracking document
// identity itself, because a stale listener from a torn-down document can
// never answer chrome.tabs.sendMessage in the first place.
const OVERLAY_SCRIPT_FILES = ["overlay/pointer-overlay.js"];

// Tabs whose overlay delivery has already been reported, so the console shows
// one line per tab per outcome instead of one per keepalive tick.
const overlayDeliveryLogged = new Map();

/** One console line per tab whenever its overlay delivery outcome CHANGES.
 *
 * Every failure path in sendOverlayMessage below returns undefined and every
 * caller swallows it with `.catch(() => {})` — by design, because an overlay
 * that cannot be shown must never fail the action it accompanies. The cost was
 * that "the overlay never appeared" produced no evidence anywhere: not in the
 * service worker console, not in the page console, not in the debug stream.
 * This is that evidence. Read it at chrome://extensions -> Browzy -> service
 * worker. */
function logOverlayDelivery(tabId, outcome, detail) {
  if (overlayDeliveryLogged.get(tabId) === outcome) return;
  overlayDeliveryLogged.set(tabId, outcome);
  // The URL, not just the id. A bare tab number cannot answer the first
  // question anyone asks of this log — "is the page I am looking at one of
  // these?" — and answering it otherwise means opening DevTools on the page
  // itself, where the console only retains what was printed after it opened.
  // Looked up rather than cached: an id outlives the page it pointed at.
  chrome.tabs
    .get(tabId)
    .then((tab) => emitOverlayDeliveryLine(tabId, outcome, detail, tab && tab.url))
    .catch(() => emitOverlayDeliveryLine(tabId, outcome, detail, null));
}

function emitOverlayDeliveryLine(tabId, outcome, detail, url) {
  const where = url ? ` (${String(url).slice(0, 120)})` : "";
  const line = `[browzy-overlay-bg] tab ${tabId}${where}: ${outcome}${detail ? " — " + detail : ""}`;
  if (outcome === "delivered" || outcome === "delivered after inject") console.log(line);
  else console.warn(line);
}

// RC7 (design.md / task 0.1(b)): whether chrome.tabs.sendMessage REJECTS or
// resolves `undefined` when a tab has no listener for the message is not
// something this codebase could settle by reading Chrome's own source, and
// the working tree's own retry logic was built on the assumption it always
// rejects. If a given Chrome build instead resolves quietly, the OLD code
// below would log "delivered" on a message nothing actually answered, and
// the inject-then-retry path would never run — silently leaving a document
// with no overlay while the service-worker console claimed success.
//
// pointer-overlay.js's own onOverlayMessage listener ALWAYS calls
// sendResponse({ok:true}) for every message type it handles (see that
// file's own comment above the listener), so this function no longer
// trusts a resolved promise alone: a reply that is not that EXACT
// acknowledgement is treated as "no overlay answered", identically to a
// rejection, regardless of which resolve-vs-reject behaviour is in force on
// a given Chrome build. This makes delivery detection correct under either
// semantics rather than depending on which one is real.
function isOverlayAck(reply) {
  return !!reply && reply.ok === true;
}

async function sendOverlayMessage(tabId, message) {
  try {
    const reply = await chrome.tabs.sendMessage(tabId, message);
    if (!isOverlayAck(reply)) throw new Error("no overlay acknowledgement");
    logOverlayDelivery(tabId, "delivered");
    return reply;
  } catch (firstError) {
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: OVERLAY_SCRIPT_FILES });
    } catch (injectError) {
      // Injection can legitimately fail (chrome://, the Web Store, a PDF
      // viewer, a tab that closed mid-flight, ...). This function must
      // never claim overlay delivery succeeded when it did not (design.md
      // 5c: "Overlay failure does not pretend control is visible") — the
      // caller already treats this as a no-op via .catch(() => {}).
      logOverlayDelivery(tabId, "injection refused", String(injectError && injectError.message));
      return undefined;
    }
    try {
      const reply = await chrome.tabs.sendMessage(tabId, message);
      if (!isOverlayAck(reply)) {
        // Injected successfully, yet still no real acknowledgement — do not
        // claim delivery on an unverifiable reply either.
        logOverlayDelivery(tabId, "injected but unreachable", "no acknowledgement after inject");
        return undefined;
      }
      logOverlayDelivery(tabId, "delivered after inject");
      return reply;
    } catch (retryError) {
      // Injected without error, then still unreachable: the overlay script
      // itself threw on load, or the document went away between the two steps.
      logOverlayDelivery(
        tabId,
        "injected but unreachable",
        `first: ${String(firstError && firstError.message)}; retry: ${String(retryError && retryError.message)}`
      );
      return undefined;
    }
  }
}

// runId -> Set<tabId> currently believed to be showing that run's overlay.
// Built only from REAL action-events' own runId/tabId pairs as they are
// forwarded below — never from a guess about which tab a run "should" be
// controlling.
const overlayRunTabs = new Map();

/** Subscribed once, at module load (see actionEvents.onActionEvent(...) call
 * below), to every real action-event this extension emits. Fire-and-forget
 * by construction: emitActionEvent() itself (action-events.js) does not
 * await its listeners, so nothing here can ever slow the real dispatch that
 * produced `event` (design.md 5c: "never slow a real action for
 * animation"). */
function forwardActionEventToOverlay(event) {
  if (event.tabId === null || event.tabId === undefined) {
    // A tool that names no tab (tabs_create_mcp, update_plan, switch_browser,
    // ...) still happens DURING the run, and the operator is still being
    // driven. Dropping it left the page with no signal for the whole step and,
    // worse, no keepalive — long enough and the overlay expired mid-run and the
    // page went dark while the agent was still working. Deliver it to the tabs
    // this run is ALREADY known to be showing an overlay on (learned only from
    // earlier real events of this same run — never a guess about which tab the
    // run "should" be on), and leave `event` itself untouched: its tabId stays
    // honestly null for every other consumer.
    if (!event.runId) return;
    const known = overlayRunTabs.get(event.runId);
    if (!known || known.size === 0) return;
    startOverlayKeepalive(event.runId);
    for (const tabId of known) {
      sendOverlayMessage(tabId, { type: "browzyOverlayEvent", event }).catch(() => {});
    }
    return;
  }
  if (event.runId) {
    let tabs = overlayRunTabs.get(event.runId);
    if (!tabs) overlayRunTabs.set(event.runId, (tabs = new Set()));
    tabs.add(event.tabId);
    startOverlayKeepalive(event.runId);
  }
  sendOverlayMessage(event.tabId, { type: "browzyOverlayEvent", event }).catch(() => {});
}

// --- Overlay keepalive ---------------------------------------------------
//
// The overlay expires its own visible state under three seconds since the
// last signal, which is what stops a dead host from leaving a misleading
// "being controlled" badge on the operator's page. Real actions, though,
// arrive in bursts seconds apart: while the model is thinking, nothing is
// dispatched, the expiry fires, and the page goes dark in exactly the gaps
// where the operator most needs to see that the agent still holds it.
//
// So a run that is still open pings its tabs on a timer. This is not a
// synthesized action — it carries no pointer, no click, and moves nothing;
// it only says "still here", and the overlay's reducer treats it that way.
// The safety property is untouched: these pings stop the instant the run
// ends, the companion disconnects, or this service worker dies, and the
// overlay then clears itself within the same bound as before.
const OVERLAY_KEEPALIVE_INTERVAL_MS = 1000;
const overlayKeepaliveTimers = new Map(); // runId -> interval handle

/** One keepalive tick to one tab — the message that keeps that page's overlay
 * from expiring. Fire-and-forget, like every other overlay message. */
function sendOverlayKeepalive(runId, tabId) {
  sendOverlayMessage(tabId, {
    type: "browzyOverlayEvent",
    event: { kind: "keepalive", runId, tabId }
  }).catch(() => {});
}

/** Widen a run's overlay to every tab in the operator's tab group.
 *
 * A run holds its lease on specific tabs, but the group is what the operator
 * sees as "the browser Browzy is driving": the agent opens tabs mid-run, moves
 * between them, and comes back. Marking only the leased tab left the others
 * looking like ordinary pages while a run was live on them. Re-run on every
 * keepalive tick so a tab created after the run began is covered too. */
async function addGroupTabsToOverlayRun(runId) {
  if (tabGroupId === null) return;
  const tabs = overlayRunTabs.get(runId);
  if (!tabs) return;
  let groupTabs;
  try {
    groupTabs = await chrome.tabs.query({ groupId: tabGroupId });
  } catch {
    return; // The group is gone; the leased tabs already in the set still stand.
  }
  for (const tab of groupTabs) {
    if (typeof tab.id !== "number") continue;
    // A page no extension may script can never host the overlay, and adding it
    // buys one refused injection per keepalive tick plus a console warning
    // about the extension's own settings page. The agent cannot drive these
    // pages either, so there is nothing to mark on them.
    if (isUnscriptableUrl(tab.url)) continue;
    tabs.add(tab.id);
  }
}

/** Pages Chrome refuses to inject into, whoever asks. */
function isUnscriptableUrl(url) {
  if (typeof url !== "string" || url === "") return false; // Unknown: let it try.
  return (
    /^(chrome|edge|brave|about|devtools|view-source|chrome-extension|moz-extension):/i.test(url) ||
    /^https:\/\/chromewebstore\.google\.com\//i.test(url) ||
    /^https:\/\/chrome\.google\.com\/webstore\//i.test(url)
  );
}

function startOverlayKeepalive(runId) {
  if (overlayKeepaliveTimers.has(runId)) return;
  const timer = setInterval(() => {
    const tabs = overlayRunTabs.get(runId);
    if (!tabs || tabs.size === 0) {
      stopOverlayKeepalive(runId);
      return;
    }
    addGroupTabsToOverlayRun(runId).catch(() => {});
    for (const tabId of tabs) sendOverlayKeepalive(runId, tabId);
  }, OVERLAY_KEEPALIVE_INTERVAL_MS);
  overlayKeepaliveTimers.set(runId, timer);
}

/** Raise the overlay for a run that has just started, on the tabs it holds the
 * browser lease for — rather than waiting for the first dispatched tool that
 * happens to carry a tabId.
 *
 * The gap this closes is the whole opening of a run. The overlay used to appear
 * only once forwardActionEventToOverlay() saw an event WITH a tab on it, so a
 * run that began by thinking, then called tabs_context_mcp (which names no
 * tab), left the page it was about to drive completely unmarked for as long as
 * that took. The operator had a run in flight against their page and no cursor,
 * no badge and no Stop button on it — precisely the state design.md 5c exists
 * to prevent.
 *
 * Nothing here is fabricated. `run_started` is emitted by
 * host/agent/session/run.js the line after the run acquires the browser lease
 * for `tabScope`, so at the moment this arrives the run really is holding those
 * tabs. The event sent on is the ordinary `keepalive` — the one signal whose
 * whole meaning is "this run is alive and nothing has been dispatched", which
 * is exactly true here: the overlay draws its idle/"thinking" state, never a
 * pointer or an action that has not happened.
 *
 * RC1 (design.md D7): an unscoped run — `tabScope` is the string "any",
 * produced whenever the panel bound no active-tab page context — used to
 * return here immediately, delaying the raise until the first action-event
 * that happens to carry a tabId. `addGroupTabsToOverlayRun()` already
 * resolves "which pages is this run on" for the keepalive path one second
 * later, and already skips any page no extension may script — so an
 * unscoped run now falls through to that SAME resolution instead of a
 * second, invented one, making the run's opening consistent with its
 * middle rather than leaving it blank in between. */
async function startOverlayForRun(runId, tabScope) {
  if (!runId) return;
  let tabs = overlayRunTabs.get(runId);
  if (!tabs) overlayRunTabs.set(runId, (tabs = new Set()));
  if (Array.isArray(tabScope) && tabScope.length > 0) {
    for (const tabId of tabScope) {
      if (typeof tabId === "number") tabs.add(tabId);
    }
  }
  await addGroupTabsToOverlayRun(runId);
  if (tabs.size === 0) return;
  // Sent immediately rather than left to the keepalive's first tick, so every
  // page is marked from the start of the run and not a second into it.
  for (const tabId of tabs) sendOverlayKeepalive(runId, tabId);
  startOverlayKeepalive(runId);
}

function stopOverlayKeepalive(runId) {
  const timer = overlayKeepaliveTimers.get(runId);
  if (timer === undefined) return;
  clearInterval(timer);
  overlayKeepaliveTimers.delete(runId);
}

function stopAllOverlayKeepalives() {
  for (const timer of overlayKeepaliveTimers.values()) clearInterval(timer);
  overlayKeepaliveTimers.clear();
}
actionEvents.onActionEvent(forwardActionEventToOverlay);

/** Proactively clear a run's overlay the moment its lifecycle actually ends
 * (design.md 5c: "Stop, cancellation, ... clear stale overlays") —
 * belt-and-suspenders alongside the overlay's OWN local <=3s heartbeat
 * expiry (extension/overlay/pointer-overlay.js), which is the guaranteed
 * fallback if this never fires (e.g. the tab was unreachable, or this
 * service worker itself restarted and lost `overlayRunTabs`). */
function teardownOverlayForRun(runId, reason) {
  stopOverlayKeepalive(runId);
  const tabs = overlayRunTabs.get(runId);
  if (!tabs) return;
  overlayRunTabs.delete(runId);
  for (const tabId of tabs) {
    sendOverlayMessage(tabId, { type: "browzyOverlayTeardown", reason: reason || "run_ended" }).catch(() => {});
  }
}

/** Deliver one approval-state change (design.md D5 / task 5.1) to every tab
 * currently believed to be showing this run's overlay — fire-and-forget,
 * exactly like every other overlay message. `overlayRunTabs` is the only
 * tab-tracking this bridge has (the same source teardownOverlayForRun above
 * already relies on): a run whose approval fires before any action-event of
 * its own ever reached this tab has nothing tracked yet, so there is
 * nothing to deliver to — the overlay's own local heartbeat expiry is what
 * keeps a run in that state from ever claiming to be "waiting" indefinitely
 * either way. */
function forwardApprovalToOverlay(runId, message) {
  const tabs = overlayRunTabs.get(runId);
  if (!tabs) return;
  for (const tabId of tabs) {
    sendOverlayMessage(tabId, message).catch(() => {});
  }
}

/** Every tab currently believed to be showing an active overlay, across
 * every run — used only when the whole companion connection is lost (a
 * stronger signal than any single run ending: design.md 5c "companion
 * loss" clears stale overlays too). */
function teardownAllOverlays(reason) {
  stopAllOverlayKeepalives();
  const tabIds = new Set();
  for (const tabs of overlayRunTabs.values()) {
    for (const tabId of tabs) tabIds.add(tabId);
  }
  overlayRunTabs.clear();
  for (const tabId of tabIds) {
    sendOverlayMessage(tabId, { type: "browzyOverlayTeardown", reason: reason || "companion_disconnected" }).catch(() => {});
  }
}

// Debugger detachment (design.md 5c: "debugger detachment... clear stale
// overlays") — a SEPARATE listener registration from the pre-existing one
// further below (which only manages attachedTabs bookkeeping), so this
// addition never touches that already-shipped behavior.
chrome.debugger.onDetach.addListener((source) => {
  sendOverlayMessage(source.tabId, { type: "browzyOverlayTeardown", reason: "debugger_detached" }).catch(() => {});
});

// Tab closed — nothing to message (the tab and its overlay are already
// gone), just stop tracking it so overlayRunTabs cannot grow unbounded.
chrome.tabs.onRemoved.addListener((tabId) => {
  for (const [runId, tabs] of overlayRunTabs) {
    tabs.delete(tabId);
    if (tabs.size === 0) overlayRunTabs.delete(runId);
  }
  // A closed tab must not linger in the panel's explicit-open set either.
  if (typeof forgetPanelTab === "function") forgetPanelTab(tabId).catch(() => {});
});

/** Send a stop instruction to the native host over the EXACT SAME wire path
 * the sidepanel's own Stop button already uses: the "ocic-agent" port
 * handler above does nothing but `nativePort.postMessage({type:"agent_msg",
 * envelope})` verbatim, and extension/sidepanel/protocol-client.js's own
 * envelope() builds `{v, type:"stop", conversationId, reason, ts}` for the
 * panel's Stop. This function builds the IDENTICAL wire shape and posts it
 * through the IDENTICAL nativePort.postMessage call — design.md 5c: "Stop
 * from page and panel uses the same cancellation path" — rather than
 * re-implementing cancellation. host/agent/session/run.js's own stop()
 * (unmodified, out of this task's ownership) is what actually invalidates
 * pending actions/approvals on the far end, exactly as it already does for
 * the panel's Stop; this function only reaches the same door. */
function sendStopToHost(conversationId, reason) {
  if (!nativePort || !conversationId) return false;
  try {
    nativePort.postMessage({
      type: "agent_msg",
      envelope: { v: AGENT_PROTOCOL_VERSION, type: "stop", conversationId, reason: reason || "user_stop", ts: Date.now() }
    });
    return true;
  } catch {
    return false;
  }
}

// The overlay's own Stop button (extension/overlay/pointer-overlay.js)
// reaches this via a plain chrome.runtime.sendMessage — a separate listener
// from the large pre-existing chrome.runtime.onMessage.addListener further
// below, so this addition never touches that already-shipped dispatch.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== "browzyOverlayStop") return;
  const ok = sendStopToHost(msg.conversationId, msg.reason);
  sendResponse({ ok });
  return true;
});

// The overlay's own Open-panel button (extension/overlay/pointer-overlay.js)
// reaches this via a plain chrome.runtime.sendMessage — a separate listener
// from the large pre-existing chrome.runtime.onMessage.addListener further
// below, mirroring the browzyOverlayStop listener immediately above. It only
// ever routes the operator to the panel (design.md D6) — it never takes the
// approval decision itself, so a no-op open costs nothing beyond "nothing
// happened".
//
// chrome.sidePanel.open() may only be called in direct, synchronous response
// to a user gesture
// (https://developer.chrome.com/docs/extensions/reference/api/sidePanel).
// Verified before writing this: this exact shape — a content script sends a
// message from its own click handler, and the service worker calls
// sidePanel.open() inside the resulting chrome.runtime.onMessage listener —
// is Chrome's own documented pattern for opening the side panel from a
// button click; the user gesture active when chrome.runtime.sendMessage()
// was called is extended to the receiving listener, but ONLY if that
// listener spends it immediately, with no `await` or other async work ahead
// of the call (several Chromium bug reports on this exact API —
// crbug.com/355266358, crbug.com/415694848,
// GoogleChrome/chrome-extensions-samples#1001 — all show the gesture is
// lost the moment anything asynchronous runs first). This listener does
// nothing else before calling it.
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || msg.type !== "browzyOverlayOpenPanel") return;
  const sidePanelAvailable = typeof chrome.sidePanel === "object" && chrome.sidePanel !== null;
  if (!sidePanelAvailable || !sender.tab) return;
  // Opened for the TAB, not the window. A window-scoped panel — what
  // open({windowId}) produces — ignores per-tab setOptions({enabled}) entirely,
  // so it stayed on screen over tabs the group rule had already disabled. The
  // whole "close outside the group" behaviour depends on this being tab-scoped.
  if (sender.tab.id != null) {
    chrome.sidePanel.open({ tabId: sender.tab.id }).catch(() => {});
  } else if (sender.tab.windowId != null) {
    chrome.sidePanel.open({ windowId: sender.tab.windowId }).catch(() => {});
  }
});

// design.md D8's residual-race detector (task 7.7). The overlay blocks the
// operator's input while `state.actionInFlight` is false — but
// emitActionStart() (below) runs SYNCHRONOUSLY before any CDP command goes
// out, while the `start` message that would set actionInFlight true on the
// overlay's own side travels an INDEPENDENT async path
// (chrome.tabs.sendMessage vs. chrome.debugger.sendCommand). If the CDP
// dispatch lands on the page before that message is processed, the overlay
// can suppress the agent's OWN trusted click, believing it to be the
// operator's stray one. `hitNote`/`probeHit` run BEFORE dispatch
// (see computer()'s own comments near currentActionExtras.outcomeStatus)
// and `outcome.status` is derived from that probe alone — so a swallowed
// click would otherwise still report `success`, with the model believing it
// clicked. This is what stands between that race and a silent wrong
// result: when the overlay reports a suppression correlated with this run's
// own `start`, the action currently open for that run gets a warning
// attached to its outcome instead of a bare `success`.
const INPUT_SUPPRESSION_ATTACH_WINDOW_MS = 1500;
/** Named so it can be unit-tested directly (test/overlay-background-bridge.
 * test.mjs cannot execute handleToolRequest itself — see that file's own
 * header). Mutates the CURRENTLY open action's `currentActionExtras` (the
 * same module-level slot emitActionStart's caller assigns immediately
 * before `handler(args)` runs, and clears in its own `finally` — see
 * handleToolRequest()) — never anything already settled. Returns whether it
 * actually attached anything, so a test can assert the order dependency
 * directly rather than only the message shape. */
function attachSuppressionWarning(runId, tabId, ts) {
  if (!currentAction || !currentActionExtras) return false;
  if (currentAction.runId !== runId) return false;
  if (typeof ts !== "number" || Math.abs(Date.now() - ts) > INPUT_SUPPRESSION_ATTACH_WINDOW_MS) return false;
  currentActionExtras.outcomeStatus = actionEvents.OUTCOME_STATUSES.UNKNOWN;
  currentActionExtras.outcomeDetail =
    "The page's input was locked at this moment by the remote-control overlay — this action may not have landed.";
  return true;
}
chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.type !== "browzyOverlayInputSuppressed") return;
  attachSuppressionWarning(msg.runId, msg.tabId, msg.ts);
});

// Run-lifecycle events that should clear a stale overlay right away rather
// than waiting out its local heartbeat expiry — see handleAgentMessage()'s
// use of this set, below.
// `run_done` belongs here every bit as much as the failure cases: a run that
// finished normally is a run that has stopped driving the page, and it is by
// far the most common way one ends. Leaving it out meant the keepalive below
// went on pinging after every successful run — the overlay only ever cleared
// via its own heartbeat expiry once the service worker died or the companion
// disconnected, and until then the operator's page kept a "being controlled"
// badge for a run that had been over for minutes.
const OVERLAY_TEARDOWN_RUN_EVENTS = new Set(["run_done", "run_stopped", "run_error", "run_interrupted_by_restart"]);

// --- Action-event -> companion timeline sender -----------------------------
//
// The other half of the SAME action-event stream the overlay bridge above
// consumes, this time forwarding it to the COMPANION over the SAME
// "ocic-agent" agent_msg channel the hello handshake/agent_settings relay
// already use (host/agent/companion.js's own `ACTION_EVENT`/`CHUNK_*`
// handlers already exist and are already tested against a real wire — see
// reports/05-timeline-host-evidence.md's "What is BLOCKED" section, which
// names this exact listener as the one remaining piece). No second channel,
// no new message shape beyond what host/agent/protocol.js already declares
// — this is a SEPARATE onActionEvent() subscriber from
// forwardActionEventToOverlay above (delivers to the controlled TAB); this
// one delivers to the COMPANION.
//
// Batched per conversationId and flushed on a short timer (design.md
// decision 1: "Batch token/event updates to avoid flooding native
// messaging" — the same reason TOKEN_BATCH exists for streamed SDK text) so
// a burst of events (a PointBatcher flush landing next to its own action's
// start/complete) goes out as ONE action_event message. Fire-and-forget and
// silently degrades to a no-op when no companion is connected, or when an
// event carries no conversationId at all (every legacy/external-MCP tool
// call — design.md 5d: those have no SDK conversation to store a timeline
// against; the overlay bridge above still shows them on the page
// regardless, since that path never depended on conversationId).
const ACTION_EVENT_FLUSH_MS = 200;
const pendingActionEventsByConversation = new Map(); // conversationId -> event[]
let actionEventFlushTimer = null;

function scheduleActionEventFlush() {
  if (actionEventFlushTimer) return;
  actionEventFlushTimer = setTimeout(() => {
    actionEventFlushTimer = null;
    flushActionEventsToCompanion();
  }, ACTION_EVENT_FLUSH_MS);
}

function flushActionEventsToCompanion() {
  if (!pendingActionEventsByConversation.size) return;
  const groups = new Map(pendingActionEventsByConversation);
  pendingActionEventsByConversation.clear();
  if (!nativePort) return; // degrade safely: no companion connected, drop silently
  for (const [conversationId, events] of groups) {
    try {
      nativePort.postMessage({
        type: "agent_msg",
        envelope: { v: AGENT_PROTOCOL_VERSION, type: "action_event", conversationId, events, ts: Date.now() }
      });
    } catch {
      // Native port gone mid-flush; the next real event re-arms a fresh
      // flush against whatever connection exists then.
    }
  }
}

function queueActionEventForCompanion(event) {
  if (!event.conversationId) return; // no SDK conversation to store against
  let list = pendingActionEventsByConversation.get(event.conversationId);
  if (!list) pendingActionEventsByConversation.set(event.conversationId, (list = []));
  list.push(event);
  scheduleActionEventFlush();
  if (event.kind === actionEvents.EVENT_KINDS.COMPLETE && event.capture && event.capture.artifactId) {
    sendActionArtifactToCompanion(event.conversationId, event.capture.artifactId);
  }
}
actionEvents.onActionEvent(queueActionEventForCompanion);

// Comfortably under native messaging's real size ceiling once JSON+base64
// overhead is accounted for — hand-mirrors host/agent/broker/
// chunked-transport.js's own DEFAULT_MAX_CHUNK_BYTES/DEFAULT_CHUNK_TTL_MS
// (a Node-side host file, not importable into this browser module graph —
// the same constraint extension/sidepanel/protocol-client.js's own header
// already documents for AGENT_PROTOCOL_VERSION/MSG). Keep these two in sync
// by hand; never invent a second wire shape for the same transport.
const ACTION_ARTIFACT_MAX_CHUNK_BYTES = 700000;
const ACTION_ARTIFACT_CHUNK_TTL_MS = 60000;

function base64ToUint8Array(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function uint8ArrayToBase64(bytes) {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** Split `bytes` into the exact chunk_begin / chunk_part (repeated) /
 * chunk_end wire shape host/agent/broker/chunked-transport.js's
 * chunkBuffer() produces (field
 * names and values match; `chunkId` uses crypto.randomUUID() here instead
 * of that module's node:crypto random bytes — an opaque unique string
 * either way, which is all ChunkReassembler requires). */
function chunkBytesForWire(bytes, meta) {
  const chunkId = crypto.randomUUID();
  const expiresAt = Date.now() + ACTION_ARTIFACT_CHUNK_TTL_MS;
  const total = Math.max(1, Math.ceil(bytes.length / ACTION_ARTIFACT_MAX_CHUNK_BYTES));
  const parts = [];
  for (let i = 0; i < total; i++) {
    const start = i * ACTION_ARTIFACT_MAX_CHUNK_BYTES;
    const slice = bytes.subarray(start, Math.min(start + ACTION_ARTIFACT_MAX_CHUNK_BYTES, bytes.length));
    parts.push({
      type: "chunk_part",
      chunkId,
      index: i,
      total,
      size: slice.length,
      expiresAt,
      dataB64: uint8ArrayToBase64(slice),
      ...meta
    });
  }
  return {
    begin: { type: "chunk_begin", chunkId, total, totalBytes: bytes.length, expiresAt, ...meta },
    parts,
    end: { type: "chunk_end", chunkId, total, expiresAt }
  };
}

/** Send a captured screenshot's REAL bytes to the companion over the chunk
 * transport host/agent/companion.js's `_handleChunkEnvelope` already
 * ingests (reports/05-timeline-host-evidence.md) — `kind:"action_artifact"`
 * is the exact string that handler checks before persisting. `screenshotStore`
 * (this file's own existing in-memory imageId->base64 map, populated by
 * takeScreenshot() above) is the ONLY source of bytes: this never
 * re-captures the page and never substitutes a different image. A
 * screenshot no longer in that bounded (10-entry) store is simply not sent
 * — the timeline preview's own host-side "unavailable" state is the honest
 * outcome for that case, not a fabricated substitute. */
function sendActionArtifactToCompanion(conversationId, artifactId) {
  if (!nativePort) return;
  const base64 = screenshotStore.get(artifactId);
  if (!base64) return;
  let bytes;
  try {
    bytes = base64ToUint8Array(base64);
  } catch {
    return;
  }
  const chunked = chunkBytesForWire(bytes, { kind: "action_artifact", conversationId, artifactId, mimeType: "image/jpeg" });
  const parts = [chunked.begin, ...chunked.parts, chunked.end];
  for (const part of parts) {
    if (!nativePort) break;
    try {
      nativePort.postMessage({ type: "agent_msg", envelope: { v: AGENT_PROTOCOL_VERSION, ...part, ts: Date.now() } });
    } catch {
      break; // connection dropped mid-sequence — the host's own chunk expiry/validation rejects a stale partial sequence rather than accepting a truncated one
    }
  }
}

function panelIdOf(sender) {
  // chrome.runtime.Port objects (the sidepanel "ocic-agent" relay) and
  // chrome.runtime.MessageSender objects (content/sidepanel sendMessage
  // callers) have no single canonical stable id — but they DO each expose a
  // tab id or a sender origin that is enough to scope one panel's store
  // away from another panel's under the same extension. Prefer a concrete
  // panelId carried as msg.panelId / port.__panelId when the panel reuses
  // getPanelId() for it; otherwise fall back to sender.tab.id.
  const tabId = sender && typeof sender === "object" ? (sender.tab && sender.tab.id) : undefined;
  return tabId != null ? `tab:${tabId}` : "default";
}

function _panelAttachmentMap(panelId) {
  const id = panelId || "default";
  let m = panelAttachmentStore.get(id);
  if (!m) { m = new Map(); panelAttachmentStore.set(id, m); }
  return m;
}

/**
 * Add one composer image to the in-memory panel store for `panelId`.
 * Only the sidepanel's own drag/paste/picker entry points (task 2.x)
 * should call this: bytes travel ONE way (panel -> this worker -> companion
 * chunk transport, kind user_attachment), never written anywhere else.
 * @returns {{ id: string, mimeType: string, byteLength: number }} — the
 *   persisted entry's artifact reference (no base64 leaked back to callers
 *   beyond this one reply; chrome.storage/logs/exports never see bytes, only
 *   refs).
 */
export function addPanelAttachment(panelId, base64, mimeType) {
  const map = _panelAttachmentMap(panelId);
  const id = `img_${Date.now()}_${crypto.randomUUID().slice(0, 6)}`;
  const bytes = (() => { try { return base64ToUint8Array(base64); } catch { return null; } })();
  const byteLength = bytes ? bytes.length : 0;
  map.set(id, { base64, mimeType, byteLength });
  return { id, mimeType, byteLength };
}
export function addPanelAttachmentWithId(panelId, id, base64, mimeType) {
  if (typeof id !== "string" || !id) throw new Error("addPanelAttachmentWithId requires a non-empty id");
  const map = _panelAttachmentMap(panelId);
  const bytes = (() => { try { return base64ToUint8Array(base64); } catch { return null; } })();
  const byteLength = bytes ? bytes.length : 0;
  map.set(id, { base64, mimeType, byteLength });
  return { id, mimeType, byteLength };
}

export function removePanelAttachment(panelId, id) {
  const map = panelAttachmentStore.get(panelId || "default");
  if (map) { map.delete(id); if (!map.size) panelAttachmentStore.delete(panelId || "default"); }
}

export function listPanelAttachments(panelId) {
  const map = panelAttachmentStore.get(panelId || "default");
  if (!map) return [];
  return Array.from(map.entries()).map(([id, e]) => ({ id, mimeType: e.mimeType, byteLength: e.byteLength }));
}

export function clearPanelAttachments(panelId) {
  const id = panelId || "default";
  panelAttachmentStore.delete(id);
}

/**
 * Totally internal seam for the extension's own unit fakes to call (the
 * sidepanel itself only uses the exported add/remove/list wrappers above,
 * never this). Sees nothing but bytes-per-panel — nothing the caller must
 * handle by leaking base64 outside the store again. Not a secret-storage
 * surface: the panel owns capture/removal truth, this worker owns the hold-
 * until-send contract, the companion owns the eventual disk write.
 */
export function _sendPanelAttachmentBytes(conversationId, panelId, attachmentId) {
  if (!nativePort) return false;
  const map = panelAttachmentStore.get(panelId || "default");
  const entry = map && map.get(attachmentId);
  if (!entry) return false;
  let bytes;
  try { bytes = base64ToUint8Array(entry.base64); } catch { return false; }
  const chunked = chunkBytesForWire(bytes, { kind: "user_attachment", conversationId, artifactId: attachmentId, mimeType: entry.mimeType });
  const parts = [chunked.begin, ...chunked.parts, chunked.end];
  for (const part of parts) {
    if (!nativePort) return false;
    try {
      nativePort.postMessage({ type: "agent_msg", envelope: { v: AGENT_PROTOCOL_VERSION, ...part, ts: Date.now() } });
    } catch {
      return false;
    }
  }
  return true;
}

function isTabInWireScope(tabScope, tabId) {
  if (tabScope === "any") return true;
  return Array.isArray(tabScope) && tabScope.includes(tabId);
}

async function isInGroup(tabId) {
  if (currentToolMeta && currentToolMeta.runId) {
    // SDK path: the run's own already-validated tab scope (see
    // host/agent/policy/authorization.js, out of this task's ownership,
    // which already rejected an out-of-scope tabId before this file is ever
    // reached) replaces Chrome tab-group membership entirely. A bound
    // "borrowed" tab (design.md 5b's article tab) legitimately was never
    // added to the Chrome group, so the legacy check below would otherwise
    // incorrectly reject every read against it.
    return isTabInWireScope(currentToolMeta.tabScope, tabId);
  }
  // Legacy path — byte-for-byte unchanged.
  // Always check live state — in-memory tabGroupTabs can be stale after service worker restart
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab.groupId !== -1) {
      // Recover tabGroupId if we lost it (service worker restart)
      if (tabGroupId === null) {
        try {
          const group = await chrome.tabGroups.get(tab.groupId);
          if (group.title === AGENT_TAB_GROUP_TITLE || LEGACY_TAB_GROUP_TITLES.includes(group.title)) {
            tabGroupId = group.id;
            const groupTabs = await chrome.tabs.query({ groupId: tabGroupId });
            tabGroupTabs = new Set(groupTabs.map((t) => t.id));
          }
        } catch {}
      }
      // An adopted borrowed tab sits inside the group for visibility only.
      // Membership must not become authority: before this feature the
      // operator's page tab was simply not in the group, so a legacy client
      // was refused — excluding it here keeps that refusal byte-for-byte
      // identical instead of silently widening legacy reach to the page the
      // operator happens to be reading.
      // `typeof` guard for the same reason as tabs_create_mcp's below: this
      // method's shipped body is extracted and compiled standalone by
      // test/registry-borrowed-tab-scope.test.mjs and test/handlers.test.mjs
      // with a fixed dependency list, where a bare reference would be a
      // ReferenceError rather than a no-op.
      if (typeof adoptedBorrowedTabs !== "undefined" && adoptedBorrowedTabs.has(tabId)) return false;
      if (tab.groupId === tabGroupId) return true;
      if (typeof extraAgentGroupIds !== "undefined" && extraAgentGroupIds.has(tab.groupId)) return true;
      // A solo group created while the worker was evicted is untracked in
      // memory: recognize the family by live title (the same rule recovery
      // uses) rather than refusing a tab that is legitimately ours. The
      // typeof guards keep this body compilable standalone in the test
      // sandboxes, which do not declare these names.
      try {
        if (chrome.tabGroups && typeof chrome.tabGroups.get === "function") {
          const liveGroup = await chrome.tabGroups.get(tab.groupId);
          const liveTitle = liveGroup && liveGroup.title;
          const family =
            (typeof isAgentFamilyTitle === "function" && isAgentFamilyTitle(liveTitle)) ||
            (typeof LEGACY_TAB_GROUP_TITLES !== "undefined" && LEGACY_TAB_GROUP_TITLES.includes(liveTitle));
          if (family) {
            if (typeof extraAgentGroupIds !== "undefined") extraAgentGroupIds.add(tab.groupId);
            return true;
          }
        }
      } catch {
        // Unknown group: not ours.
      }
      return false;
    }
    return tabGroupTabs.has(tabId);
  } catch {
    return false;
  }
}

/**
 * Adopt one of the operator's own tabs into the visible agent group, keeping
 * it borrowed. Records its previous group so releaseBorrowedTab() can put it
 * back. Idempotent; never selects the tab or raises its window.
 */
/**
 * A tab showing nothing yet: the browser's new-tab page, an about:blank, or a
 * tab so freshly created it has no URL at all.
 *
 * This is what Ctrl+T produces. The panel binds to whatever tab is active, so
 * without this check pressing Ctrl+T while the panel is open makes the empty
 * new tab the "page the assistant is looking at" and adopts it into the agent
 * group — the operator opening a blank tab for their own use, filed under the
 * assistant's label. An empty tab is never a page anyone is working on.
 *
 * @param {chrome.tabs.Tab} tab
 * @returns {boolean}
 */
// Every Chromium fork names its new-tab page differently (chrome://newtab,
// brave://newtab, edge://newtab, chrome://new-tab-page), so this matches the
// shape rather than enumerating browsers.
const BROWSER_NEW_TAB_URL = new RegExp("^[a-z-]+://(newtab|new-tab-page)/?$", "i");

function isBlankNewTab(tab) {
  const url = (tab && (tab.url || tab.pendingUrl)) || "";
  if (!url) return true; // created moments ago, nothing committed yet
  if (/^about:(blank|newtab)?$/i.test(url)) return true;
  return BROWSER_NEW_TAB_URL.test(url);
}

/**
 * @param {number} tabId
 * @param {object} [opts]
 * @param {boolean} [opts.explicit] - the operator asked for this tab by name,
 *   by clicking the toolbar icon on it. The blank-tab guard below is skipped
 *   for such a request and ONLY for such a request: passively following the
 *   panel's page context past a New Tab must still leave it alone, or every
 *   Ctrl+T on the way somewhere else would be dragged into the group.
 */
async function adoptBorrowedTab(tabId, opts) {
  // Read out of an options object rather than destructuring in the signature:
  // test/_extract.mjs pulls this function out of the shipped file by matching
  // braces, and a `{ ... }` in the parameter list makes it extract the wrong
  // span. Every function in this file is reachable that way and must stay so.
  const explicit = !!(opts && opts.explicit);
  if (typeof tabId !== "number" || adoptedBorrowedTabs.has(tabId)) return false;
  try {
    const tab = await chrome.tabs.get(tabId);
    // Ctrl+T, or any other empty tab the operator just opened for themselves.
    // Unless they opened the panel ON it, which says the opposite: this blank
    // tab is where they intend to work. Before this, such a tab stayed outside
    // the group — and once the panel became group-scoped, that made it the one
    // place the panel could not be used.
    if (!explicit && isBlankNewTab(tab)) return false;
    // Adoption comes from the panel, outside any tool dispatch, so name the
    // group explicitly rather than letting it fall through to the MCP label.
    await ensureTabGroup(false, AGENT_TAB_GROUP_TITLE);
    if (tabGroupId !== null && tab.groupId === tabGroupId) return false; // already ours

    adoptedBorrowedTabs.set(tabId, tab.groupId ?? -1);
    if (tabGroupId === null) {
      // No group yet: build it out of THIS tab instead of calling
      // ensureTabGroup(true), which opens a fresh window with a blank tab.
      // The operator opened the panel while reading this page — spawning an
      // untouched about:blank beside it is pure clutter, and it is what put
      // three tabs in the group when only one was ever used.
      const groupId = await chrome.tabs.group({ tabIds: [tabId] });
      await chrome.tabGroups.update(groupId, { title: AGENT_TAB_GROUP_TITLE, color: "blue" });
      tabGroupId = groupId;
    } else {
      await chrome.tabs.group({ tabIds: [tabId], groupId: tabGroupId });
    }
    return true;
  } catch {
    adoptedBorrowedTabs.delete(tabId);
    return false;
  }
}

/** Put an adopted tab back where it was. Never closes it. */
async function releaseBorrowedTab(tabId) {
  if (!adoptedBorrowedTabs.has(tabId)) return false;
  const previousGroupId = adoptedBorrowedTabs.get(tabId);
  adoptedBorrowedTabs.delete(tabId);
  try {
    if (previousGroupId === -1 || previousGroupId === undefined) {
      await chrome.tabs.ungroup([tabId]);
    } else {
      await chrome.tabs.group({ tabIds: [tabId], groupId: previousGroupId });
    }
    return true;
  } catch {
    return false;
  }
}

// Kept in sync BY HAND with extension/sidepanel/page-context.js's own
// RESTRICTED_URL_PATTERN — deliberately duplicated rather than shared via
// import, since this file is a service-worker module and the sidepanel
// files load in a separate module graph; each is independently readable and
// testable this way. Both only ever inspect the URL string.
const RESTRICTED_URL_PATTERN =
  /^(chrome|chrome-extension|brave|edge|about|devtools|view-source):|^https:\/\/(chrome\.google\.com\/webstore|chromewebstore\.google\.com|microsoftedge\.microsoft\.com\/addons)/i;

/**
 * design.md 5b / specs/agent-browser-runtime.md "Live current-page reading":
 * "A changed/closed tab before capture yields an explicit stale-context
 * result — never retry on a newly active tab" and "Restricted page ...
 * without opening an unrelated tab or guessing the article." Checked BEFORE
 * attempting real extraction so a closed or browser-internal tab produces an
 * explicit, typed result instead of whatever generic failure
 * sendContentMessage's inject-and-retry path would otherwise throw.
 *
 * @returns {Promise<{content: Array}|null>} an explicit result to return
 *   as-is, or null when the tab is open and (as far as its URL says) readable.
 */
async function checkTabReadableForExtraction(tabId) {
  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    return {
      content: [
        {
          type: "text",
          text: `Stale context: tab ${tabId} is no longer open. The page bound to this run is gone — do not retry against a different or newly active tab; report this to the user and ask them to reopen the page or bind a new one.`
        }
      ]
    };
  }
  if (tab.url && RESTRICTED_URL_PATTERN.test(tab.url)) {
    return {
      content: [
        {
          type: "text",
          text: `Restricted page: tab ${tabId} (${tab.url}) is a browser-internal or store page that cannot be read by content scripts. Identify this limitation to the user rather than guessing its content or opening a different tab.`
        }
      ]
    };
  }
  return null;
}

// Tabs THIS extension created in response to an SDK-path tabs_create_mcp
// call. Tracked separately from the legacy tabGroupTabs so a borrowed
// (pre-existing, never-created-by-us) tab can never be mistaken for one the
// agent made — see tabs_close_mcp below, the one place that distinction is
// safety-critical: cleanup must never close (or, per design.md, regroup) a
// tab the agent did not create. Mutating a borrowed tab at all (closing it
// is a mutation) is additionally gated pre-dispatch by
// host/agent/tools/mapping.js's isMutatingCall()/isBorrowedTab(), which runs
// inside the SDK adapter before this file is ever reached; this set is the
// second, independent layer for the one handler where "the wrong tab" would
// otherwise be irreversible.
const sdkAgentCreatedTabs = new Set();

// Tabs of the OPERATOR'S OWN that the panel has adopted into the visible
// agent tab group, so it is obvious at a glance which page the assistant is
// working on — the affordance Claude in Chrome's "Claude" group provides.
// Maps tabId -> the groupId it sat in beforehand (-1 = ungrouped), so the
// adoption can be undone rather than permanently rearranging the operator's
// tab strip. design.md 5b originally said not to move the operator's tab at
// all; the operator has since chosen this behavior explicitly, and these two
// guarantees are what make it safe rather than destructive:
//
//   1. An adopted tab stays BORROWED. It is deliberately never added to
//      `tabGroupTabs` and is excluded from isInGroup()'s legacy branch
//      below, so being inside the group grants no authority: a legacy MCP
//      client still cannot touch it (exactly as before this feature), and
//      the SDK path still treats it read-only until the task authorizes a
//      mutation.
//   2. Its previous group is restored on release, and it is never closed by
//      cleanup — it is the operator's page, not ours.
const adoptedBorrowedTabs = new Map();

// --- CDP helpers ---
// NOTE ON TAB ACTIVATION: nothing in here selects a tab or raises a window.
// Automation drives background tabs, so it never yanks the operator away from
// what they are doing — that interruption is the whole of issue #28, and it is
// also how the official Claude in Chrome behaves. The one deliberate exception
// is the set_tab_focus tool, which exists precisely so surfacing a tab is a
// choice the agent makes rather than a side effect of every click.
//
// The tradeoff: Chromium throttles a fully hidden tab's compositor, so input
// dispatched to one can be slower than to a visible tab. A tab in a visible
// window (even an unfocused one) still renders, which is the normal case here
// since the MCP group lives in its own window.

// Attach is not idempotent and not instant: two concurrent calls to a
// not-yet-attached tab both pass the `has` check and the second
// chrome.debugger.attach throws "Another debugger is already attached".
// Reachable by any two consumers hitting a cold tab at the same time.
// Concurrent callers share one in-flight attach.
const attachingTabs = new Map();
async function ensureAttached(tabId) {
  if (attachedTabs.has(tabId)) return;
  if (attachingTabs.has(tabId)) return attachingTabs.get(tabId);
  const attach = (async () => {
    await chrome.debugger.attach({ tabId }, "1.3");
    attachedTabs.set(tabId, { enabledDomains: new Set() });
  // No device-metrics emulation here. Screenshots get CSS-pixel framing from an
  // explicit capture clip instead (see takeScreenshot), which is more direct and
  // touches nothing about the page — no re-layout, no resize handlers fired.
  //
  // An earlier version of this comment claimed the override was what froze the
  // viewport against resize_window. That was wrong. The real cause is below:
  // Chrome does not re-layout a tab that is not the SELECTED tab in its window,
  // and since #28 we never select tabs. Removing the override did not change
  // that, and restoring it would not either.
  //
  // Builds before this one DID install an override (at the outer window size,
  // which is larger than the viewport, so pages laid out for a size that did not
  // exist). A tab attached by one of those builds still carries it, so clear it
  // once here rather than inheriting a stale viewport from whatever ran before.
  try {
    await chrome.debugger.sendCommand({ tabId }, "Emulation.clearDeviceMetricsOverride", {});
  } catch {}
  // Make the tab behave as focused/active for input purposes WITHOUT selecting
  // it. Since we stopped foregrounding tabs (#28), a driven tab is often not
  // the selected one, and Chromium throttles a hidden tab: synthesized
  // mousePressed/mouseReleased can be dropped outright — observed as clicks
  // that reach the page as zero mousedown/mouseup events. This is the same
  // primitive headless automation uses to drive unfocused pages, and it is
  // what lets "never steal the operator's focus" and "input actually lands"
  // both hold. Best-effort: older builds without it just keep the old
  // behaviour rather than failing the attach.
  try {
    await chrome.debugger.sendCommand({ tabId }, "Emulation.setFocusEmulationEnabled", {
      enabled: true,
    });
  } catch (e) {
    // Without this, input to an unselected tab can be dropped outright, so a
    // silent failure here turns into clicks that vanish with no other trace.
    dbg("cdp", "Emulation.setFocusEmulationEnabled FAILED — input to unselected tabs may be dropped",
        { tab: tabId, err: String(e && e.message).slice(0, 120) });
    console.warn("setFocusEmulationEnabled unavailable:", e.message);
  }
  })();
  attachingTabs.set(tabId, attach);
  try {
    await attach;
  } catch (e) {
    // Failed attach must not leave a half-registered tab behind.
    attachedTabs.delete(tabId);
    throw e;
  } finally {
    attachingTabs.delete(tabId);
  }
}

async function ensureDomain(tabId, domain) {
  const state = attachedTabs.get(tabId);
  if (!state) throw new Error("Not attached to tab");
  if (state.enabledDomains.has(domain)) return;
  await chrome.debugger.sendCommand({ tabId }, `${domain}.enable`, {});
  state.enabledDomains.add(domain);
}

// A single CDP command must never hang a tool call to the 60s MCP timeout.
// On a heavy page mid-reflow, Page.captureScreenshot (and other commands) can
// block indefinitely; bound every command so a stuck one fails fast and
// surfaces as a tool error the agent can react to, instead of a silent stall.
const CDP_TIMEOUT_MS = 20000;
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function cdp(tabId, method, params = {}) {
  await ensureAttached(tabId);
  const t0 = Date.now();
  try {
    const out = await withTimeout(
      chrome.debugger.sendCommand({ tabId }, method, params),
      CDP_TIMEOUT_MS,
      `CDP ${method}`
    );
    dbg("cdp", `${method}${cdpDetail(method, params)}`, { tab: tabId, ms: Date.now() - t0 });
    return out;
  } catch (e) {
    dbg("cdp", `${method}${cdpDetail(method, params)}`, {
      tab: tabId, ms: Date.now() - t0, err: String(e && e.message).slice(0, 120)
    });
    throw e;
  }
}

// A short, useful summary of a CDP call: the parameters that matter for
// diagnosis (where an input went, which key, how far a scroll) without dumping
// entire payloads such as screenshot bytes into the log.
function cdpDetail(method, p) {
  if (!p) return "";
  if (method === "Input.dispatchMouseEvent")
    return ` ${p.type}(${p.x},${p.y})${p.deltaY ? ` dy=${p.deltaY}` : ""}${p.button && p.type !== "mouseMoved" ? ` ${p.button}` : ""}`;
  if (method === "Input.dispatchKeyEvent")
    return ` ${p.type} ${JSON.stringify(p.key || "")}${p.autoRepeat ? " repeat" : ""}`;
  if (method === "Input.insertText") return ` ${JSON.stringify(String(p.text).slice(0, 20))}`;
  if (method === "Runtime.evaluate") return ` ${JSON.stringify(String(p.expression || "").slice(0, 60))}`;
  if (method === "Input.synthesizeScrollGesture") return ` (${p.x},${p.y}) y=${p.yDistance}`;
  return "";
}

// Clean up when tab is closed
chrome.tabs.onRemoved.addListener((tabId) => {
  tabGroupTabs.delete(tabId);
  sdkAgentCreatedTabs.delete(tabId);
  recentlyCreatedTabs.delete(tabId);
  // The operator closed a tab we had adopted: drop the bookkeeping without
  // trying to restore a group for a tab that no longer exists.
  adoptedBorrowedTabs.delete(tabId);
  if (attachedTabs.has(tabId)) {
    try { chrome.debugger.detach({ tabId }); } catch {}
    attachedTabs.delete(tabId);
  }
  consoleMessages.delete(tabId);
  networkRequests.delete(tabId);
  networkByRequestId.delete(tabId);
  cursorByTab.delete(tabId);
  captureScaleByTab.delete(tabId);
  actionDocTracker.clear(tabId);
  documentBindings.clear(tabId);
  // Drop any per-tab config override too: tab ids are recycled by the browser,
  // so a stale override would silently apply to an unrelated future tab.
  if (configState.byTab[String(tabId)]) {
    const byTab = { ...configState.byTab };
    delete byTab[String(tabId)];
    configState.byTab = byTab;
    chrome.storage.session.set({ [TAB_CONFIG_KEY]: byTab }).catch(() => {});
  }
});

// Handle user dismissing debugger bar
chrome.debugger.onDetach.addListener((source, reason) => {
  attachedTabs.delete(source.tabId);
});

// --- CDP event listeners for console and network ---
chrome.debugger.onEvent.addListener((source, method, params) => {
  const tabId = source.tabId;

  if (method === "Console.messageAdded" && params.message) {
    const msgs = consoleMessages.get(tabId) || [];
    msgs.push({
      level: params.message.level,
      text: params.message.text,
      url: params.message.url || "",
      timestamp: Date.now(),
    });
    // Keep last 1000
    if (msgs.length > 1000) msgs.splice(0, msgs.length - 1000);
    consoleMessages.set(tabId, msgs);
  }

  if (method === "Runtime.consoleAPICalled" && params.args) {
    const msgs = consoleMessages.get(tabId) || [];
    const text = params.args.map((a) => a.value ?? a.description ?? "").join(" ");
    msgs.push({
      level: params.type || "log",
      text,
      url: params.stackTrace?.callFrames?.[0]?.url || "",
      timestamp: Date.now(),
    });
    if (msgs.length > 1000) msgs.splice(0, msgs.length - 1000);
    consoleMessages.set(tabId, msgs);
  }

  // Merge CDP network events into one record per requestId so the reader
  // sees each request once. requestWillBeSent carries the real method + url;
  // responseReceived augments that same record with the status. A requestId
  // is reused across redirect hops, so a later event updates the existing
  // record in place rather than appending a duplicate.
  if (method === "Network.responseReceived" && params.response) {
    recordNetworkEvent(tabId, params.requestId, (existing) => ({
      status: params.response.status,
      statusText: params.response.statusText,
      mimeType: params.response.mimeType,
      type: params.type || (existing && existing.type) || "Other",
      // method + url come from requestWillBeSent; fall back to the old
      // heuristic only when no earlier event was seen for this id.
      method: (existing && existing.method) || (params.response.requestHeaders ? "?" : "GET"),
      url: (existing && existing.url) || params.response.url,
      timestamp: (existing && existing.timestamp) || Date.now(),
    }));
  }

  if (method === "Network.requestWillBeSent" && params.request) {
    recordNetworkEvent(tabId, params.requestId, (existing) => ({
      url: params.request.url,
      method: params.request.method,
      type: params.type || (existing && existing.type) || "Other",
      status: (existing && existing.status) || 0,
      timestamp: (existing && existing.timestamp) || Date.now(),
    }));
  }
});

// Append (or update) one entry for a network event, keyed by requestId.
// makeRecord(existing) returns the fields to merge; when a record already
// exists for the id (a duplicate event or a redirect hop) it is patched
// in place so the request appears exactly once in the reader's list.
function recordNetworkEvent(tabId, requestId, makeRecord) {
  const reqs = networkRequests.get(tabId) || [];
  let byId = networkByRequestId.get(tabId);
  if (!byId) {
    byId = new Map();
    networkByRequestId.set(tabId, byId);
  }

  const existing = byId.get(requestId);
  if (existing) {
    Object.assign(existing, makeRecord(existing));
    return;
  }

  const record = makeRecord(null);
  reqs.push(record);
  byId.set(requestId, record);

  if (reqs.length > 1000) {
    const evicted = reqs.splice(0, reqs.length - 1000);
    // Drop the requestId lookups for evicted records so a reused id does
    // not resurrect a stale entry.
    const evictedSet = new Set(evicted);
    for (const [id, rec] of byId) {
      if (evictedSet.has(rec)) byId.delete(id);
    }
  }
  networkRequests.set(tabId, reqs);
}

// --- Key code mapping ---
const KEY_MAP = {
  enter: "Enter", return: "Enter", tab: "Tab", escape: "Escape", esc: "Escape",
  backspace: "Backspace", delete: "Delete", space: "Space", " ": "Space",
  arrowup: "ArrowUp", arrowdown: "ArrowDown", arrowleft: "ArrowLeft", arrowright: "ArrowRight",
  up: "ArrowUp", down: "ArrowDown", left: "ArrowLeft", right: "ArrowRight",
  home: "Home", end: "End", pageup: "PageUp", pagedown: "PageDown",
  f1: "F1", f2: "F2", f3: "F3", f4: "F4", f5: "F5", f6: "F6",
  f7: "F7", f8: "F8", f9: "F9", f10: "F10", f11: "F11", f12: "F12",
};

function parseKeyCombo(keyStr) {
  const parts = keyStr.split("+").map((p) => p.trim().toLowerCase());
  let modifiers = 0;
  let key = "";
  for (const part of parts) {
    if (part === "ctrl" || part === "control") modifiers |= 2;
    else if (part === "alt") modifiers |= 1;
    else if (part === "shift") modifiers |= 8;
    else if (part === "meta" || part === "cmd" || part === "command" || part === "win" || part === "windows") modifiers |= 4;
    else key = KEY_MAP[part] || part;
  }
  return { key, modifiers };
}

function parseModifierString(modStr) {
  if (!modStr) return 0;
  let modifiers = 0;
  const parts = modStr.split("+").map((p) => p.trim().toLowerCase());
  for (const part of parts) {
    if (part === "ctrl" || part === "control") modifiers |= 2;
    else if (part === "alt") modifiers |= 1;
    else if (part === "shift") modifiers |= 8;
    else if (part === "meta" || part === "cmd" || part === "command" || part === "win" || part === "windows") modifiers |= 4;
  }
  return modifiers;
}

// --- Content script communication ---
/** Thrown when the page could not be inspected at all, as opposed to being
 * inspected and found to contain nothing. Callers MUST keep those two apart:
 * turning the first into "no elements found" states a fact about the page that
 * was never established, and the agent then goes looking for another way to do
 * something it had every reason to believe was impossible. */
class ContentScriptUnavailableError extends Error {
  constructor(tabId, type, cause) {
    super(
      `the page in tab ${tabId} could not be inspected — its content script is not responding, ` +
        `so nothing could be read from it (${type}). This says NOTHING about what the page ` +
        `contains: do not conclude an element is absent. Reload the tab (navigate to its ` +
        `current URL) and try again.`
    );
    this.name = "ContentScriptUnavailableError";
    this.tabId = tabId;
    if (cause) this.cause = cause;
  }
}

async function injectContentScript(tabId) {
  await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
}

async function sendContentMessage(tabId, message) {
  // Two different failures need the same recovery, and only one of them used to
  // get it. A tab with no live listener REJECTS, which triggered the
  // inject-and-retry below. But a content script whose extension context was
  // invalidated — every page left open across an extension reload — can leave
  // the send RESOLVING with nothing instead, and that path did no recovery at
  // all: it returned an empty answer, which `find` reported as "No elements
  // found" and read_page as "Could not generate accessibility tree". The agent
  // was told, in effect, that the page was empty. It then spent the rest of the
  // run guessing coordinates and hand-assembling URLs for a page it had simply
  // never been able to read.
  //
  // So recovery is driven by the OUTCOME (no usable answer) rather than by which
  // shape the failure took.
  let response;
  try {
    response = await chrome.tabs.sendMessage(tabId, message);
  } catch {
    response = undefined;
  }
  // "Usable" means an answer came back at all — NOT that it carries `result`.
  // markElementForUpload/unmarkElementForUpload legitimately answer `{ok:true}`
  // with no `result` field, and treating those as failures would re-inject and
  // then throw in the middle of a working file upload.
  if (response !== undefined && response !== null) return response;

  try {
    await injectContentScript(tabId);
  } catch (e) {
    dbg("content", `${message.type}: inject failed — ${String(e && e.message).slice(0, 120)}`, { tab: tabId });
    throw new ContentScriptUnavailableError(tabId, message.type, e);
  }
  dbg("content", `${message.type}: no usable answer, re-injected content.js`, { tab: tabId });

  try {
    response = await chrome.tabs.sendMessage(tabId, message);
  } catch (err) {
    throw new ContentScriptUnavailableError(tabId, message.type, err);
  }
  if (response === undefined || response === null) {
    dbg("content", `${message.type}: still no answer after re-injection`, { tab: tabId });
    throw new ContentScriptUnavailableError(tabId, message.type);
  }
  return response;
}

// Complete the document-identity handshake (design.md decision 6 / tasks.md
// 1.2) for a tab whose current generation is not yet CONFIRMED by
// `documentBindings`. Deliberately LAZY, not driven eagerly from every
// onUpdated "loading" event: an eager call would race chrome.tabs.
// sendMessage against content.js's own document_idle injection timing and
// produce a spurious failure for an ordinary in-flight navigation. A
// restricted page (chrome://, the extension gallery, ...) legitimately
// never answers at all — per decision 6 that is the correct FAIL-CLOSED
// outcome, not a transient error worth retrying.
//
// Returns the confirmed binding, or null if the handshake could not be
// completed — NEVER a tabId+url-only binding as a substitute.
async function ensureDocumentBinding(tabId) {
  const existing = documentBindings.getBinding(tabId);
  if (existing && existing.confirmed) return existing;
  try {
    const reply = await sendContentMessage(tabId, { type: "getDocumentIdentity" });
    const info = reply && reply.result;
    if (!info || !info.docNonce) return null;
    return documentBindings.confirmHandshake(tabId, { url: info.url, docNonce: info.docNonce });
  } catch {
    // Content script unreachable (restricted page, or a tab that closed
    // mid-handshake) — fail closed, never fall back to url-only identity.
    return null;
  }
}

// --- Resolve ref to coordinates ---
// Resolve a ref to the point to dispatch at, scrolling the element into view
// first so the point is actually reachable. Returns the full record (not just
// the pair) so callers can report interception.
async function resolveRefToCoordinates(tabId, ref, opts = {}) {
  const resp = await sendContentMessage(tabId, {
    type: "getRefCoordinates",
    ref,
    scrollIntoView: opts.scrollIntoView !== false
  });
  return resp?.result || null;
}

// --- Screenshot helper ---
//
// THE COORDINATE SPACE THE MODEL CLICKS IN.
//
// A screenshot is not just a picture here: it is the surface the model reads
// click coordinates off, so the image's pixel grid IS a coordinate system, and
// it has to be the same one `Input.dispatchMouseEvent` uses. The capture below
// already undoes the device pixel ratio so image pixels are CSS pixels — but
// that is only half of it, because the image does not reach the model
// untouched. The API resizes any image whose long edge exceeds this bound
// before the model ever sees it.
//
// That silent resize is a targeting bug, not a quality one. A maximized window
// on a 1920-wide display produced a 1920px-wide image; the model was shown a
// 1568px-wide one, read a button's centre off THAT, and sent back a coordinate
// in 1568-space which was then dispatched as CSS pixels. Every click landed at
// ~82% of where it should — systematically short and high, worse the further
// right and further down the target sat, and completely invisible in the logs
// because the dispatch itself always succeeded. Clicking near the top-left
// still worked, which is exactly what makes this kind of bug look intermittent.
//
// So the capture is scaled HERE, deliberately, to whatever keeps the image
// inside the bound — and the resulting factor is remembered per tab
// (`captureScaleByTab`) so a coordinate the model reads off that image is
// mapped back to CSS pixels before dispatch. The two halves must always move
// together; neither is meaningful alone.
//
// The previous constants here (MAX_SCREENSHOT_WIDTH/HEIGHT = 1280x800) claimed
// this cap but were never read by any code path — the capture was full-size all
// along.
const MODEL_IMAGE_MAX_EDGE = 1568;

/** The factor to capture at so the image survives to the model unresized.
 * 1 whenever the viewport already fits, which is the common laptop case — no
 * detail is thrown away to solve a problem that is not there. */
function captureScaleForViewport(viewportWidth, viewportHeight) {
  const longEdge = Math.max(viewportWidth, viewportHeight);
  if (!(longEdge > 0)) return 1;
  return Math.min(1, MODEL_IMAGE_MAX_EDGE / longEdge);
}

// tabId -> the scale the last screenshot of that tab was captured at. Written
// only by a real capture, so it always describes an image the model has
// actually been shown; absent means no image, and coordinates are then already
// CSS pixels (from `find`/`read_page` refs) with nothing to map.
const captureScaleByTab = new Map();

/** Map a coordinate the model read off this tab's last screenshot back into the
 * CSS pixels the dispatch layer works in. Identity when that image was 1:1, and
 * identity for a tab that has never been captured. */
function screenshotToCssCoordinate(tabId, pair) {
  const scale = captureScaleByTab.get(tabId);
  if (!scale || scale === 1 || !Array.isArray(pair) || pair.length < 2) return pair;
  return [Math.round(pair[0] / scale), Math.round(pair[1] / scale)];
}

// Overlay capture exclusion (design.md 5c: "Hide the layer briefly around
// capture and restore in a finally path without changing cursor state" /
// "Keep product elements out of ... default model screenshots"). Best-effort
// and bounded: an absent or unresponsive overlay must never slow down a real
// screenshot capture (the same "never slow a real action for animation"
// invariant the pointer-progress wiring already follows), so the hide
// request never waits longer than OVERLAY_HIDE_WAIT_MS regardless of the
// tab's state — far shorter than a typical CDP screenshot round trip.
const OVERLAY_HIDE_WAIT_MS = 150;
// tabId -> the in-flight hide delivery, so the matching show can be sent AFTER
// it rather than racing it. Bounding how long the CAPTURE waits (above) must
// not also unorder the two messages: when the hide has to inject the overlay
// first (a fresh document — exactly what a click that navigated just made),
// delivery outlives the 150ms bound, the capture finishes, the show is sent
// immediately, and the hide lands LAST. The overlay then sits at
// `visibility:hidden` with a perfectly live run behind it — the probe's
// `present:true, vis:hidden` state — for the rest of the run, because nothing
// but another capture ever writes that flag again.
const overlayHideInFlight = new Map();
// design.md D3: the capture lease's own correlation id, minted here (not by
// the overlay) so a `hide` and its matching `show` share one identity. A
// simple incrementing counter, not a timestamp — the overlay only ever
// needs to tell "this is a newer hide than the one currently in force" or
// "this show belongs to that exact hide", and a counter answers both with
// no clock-skew concerns between the service worker and the page.
let overlayCaptureIdCounter = 0;
// tabId -> the captureId of the most recent hide sent for that tab, so its
// matching show sends the SAME id rather than an anonymous one.
const overlayHideCaptureId = new Map();
// design.md D3: the bound background sends with each hide, because
// background is the one side that knows the real worst-case budget it
// intends to spend on THIS capture — hide-wait (<=OVERLAY_HIDE_WAIT_MS) +
// paint settle + evaluate + capture, plus one blank-retry recapture — which
// on a heavy page can exceed the overlay's own CAPTURE_HIDE_MAX_AGE_MS
// default. Generous enough to cover a full retry cycle; still short enough
// that a genuinely lost show costs seconds, not the rest of the run.
const OVERLAY_CAPTURE_LEASE_MS = 4000;
function requestOverlayHide(tabId) {
  const captureId = ++overlayCaptureIdCounter;
  overlayHideCaptureId.set(tabId, captureId);
  const hidden = sendOverlayMessage(tabId, {
    type: "browzyOverlayCapture",
    phase: "hide",
    captureId,
    maxMs: OVERLAY_CAPTURE_LEASE_MS
  }).catch(() => {});
  overlayHideInFlight.set(tabId, hidden);
  return Promise.race([hidden, new Promise((resolve) => setTimeout(resolve, OVERLAY_HIDE_WAIT_MS))]);
}
function requestOverlayShow(tabId) {
  const pendingHide = overlayHideInFlight.get(tabId);
  overlayHideInFlight.delete(tabId);
  const captureId = overlayHideCaptureId.get(tabId);
  overlayHideCaptureId.delete(tabId);
  // Still fire-and-forget from the caller's point of view — the capture is
  // already done and nothing waits on this — but ordered behind its own hide.
  Promise.resolve(pendingHide)
    .then(() => sendOverlayMessage(tabId, { type: "browzyOverlayCapture", phase: "show", captureId }))
    .catch(() => {});
}

/** How much to magnify a zoomed region. The point of a zoom is to resolve
 * something the full-page capture rendered too small to read, so the region is
 * enlarged to fill the image budget instead of being reproduced at its original
 * size. Capped, because past a few times life-size a JPEG of a rasterised page
 * only gets blurrier, not more legible. */
const MAX_ZOOM_MAGNIFICATION = 4;

/** Turn a caller-supplied [x0,y0,x1,y1] into a clip rect in CSS pixels, or null
 * when there is nothing usable to crop to. Corners may arrive in either order,
 * and a rectangle that runs off the page is clamped rather than rejected — a
 * region read off a screenshot routinely overshoots an edge by a pixel or two,
 * and refusing it would send the caller back to a full capture for no reason.
 * A rectangle entirely outside the viewport, or one with no area after
 * clamping, has nothing to show and returns null. */
function normalizeCropRegion(region, viewportWidth, viewportHeight) {
  if (!Array.isArray(region) || region.length < 4) return null;
  const nums = region.slice(0, 4).map(Number);
  if (nums.some((n) => !Number.isFinite(n))) return null;
  const x0 = Math.max(0, Math.min(nums[0], nums[2]));
  const y0 = Math.max(0, Math.min(nums[1], nums[3]));
  const x1 = Math.min(viewportWidth, Math.max(nums[0], nums[2]));
  const y1 = Math.min(viewportHeight, Math.max(nums[1], nums[3]));
  const width = x1 - x0;
  const height = y1 - y0;
  if (!(width >= 1 && height >= 1)) return null;
  return { x: x0, y: y0, width, height };
}

function zoomScaleForRegion(regionWidth, regionHeight) {
  const longEdge = Math.max(regionWidth, regionHeight);
  if (!(longEdge > 0)) return 1;
  return Math.min(MAX_ZOOM_MAGNIFICATION, MODEL_IMAGE_MAX_EDGE / longEdge);
}

/**
 * @param {number} tabId
 * @param {object} [opts]
 * @param {number[]} [opts.region] - [x0,y0,x1,y1] in CSS pixels to crop to.
 *   When given, the capture is that rectangle, magnified — and the per-tab
 *   capture scale is deliberately NOT updated, because coordinates read off a
 *   cropped, magnified image are relative to the crop and mean nothing to the
 *   click dispatcher. See the `zoom` action for how that is reported.
 */
async function takeScreenshot(tabId, opts = {}) {
  await ensureAttached(tabId);
  await requestOverlayHide(tabId);
  // Wait for the page to actually PAINT before capturing.
  //
  // Page.captureScreenshot grabs whatever the compositor has right now, which
  // after a scroll or a click that expands a panel can still be the blank frame
  // the renderer is part-way through replacing. That produced a
  // near-uniform-white JPEG — 9.5KB where a real capture of the same viewport
  // is 130KB — and the agent, shown a blank picture of a page that was in fact
  // full of the form it was looking for, concluded there was nothing there and
  // gave up on the interface entirely.
  //
  // Two nested requestAnimationFrame callbacks resolve only after a frame has
  // been composited, which is the event actually being waited for; the fixed
  // sleeps this replaces were guesses about how long that takes. Bounded and
  // best-effort: a page that never paints (background tab, stalled renderer)
  // must not hold up the capture indefinitely.
  try {
    await withTimeout(
      cdp(tabId, "Runtime.evaluate", {
        expression: "new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r(1))))",
        awaitPromise: true
      }),
      500,
      "paint settle"
    );
  } catch {}
  try {
    // Capture at EXACTLY CSS-pixel dimensions, because the agent reads click
    // coordinates off this image and clicks are dispatched in CSS pixels. On a
    // 1.5x display an uncorrected capture of a 1008x632 viewport comes back
    // 1512x948, so an agent told to "click what you see" aims 1.5x off and
    // misses everything.
    //
    // The capture is rasterised at the display's pixel ratio, so on a scaled
    // display the image comes back larger than the CSS viewport and every
    // coordinate read off it is wrong by that factor. Undo it in the capture
    // itself: clip to the viewport and scale by 1/ratio, which yields an image
    // whose pixels ARE CSS pixels. Emulation would also achieve this, but at the
    // cost of freezing the viewport (see ensureAttached).
    let clip = null;
    let shotScale = 1;
    try {
      const vp = await cdp(tabId, "Runtime.evaluate", {
        expression: "JSON.stringify([innerWidth, innerHeight, devicePixelRatio, scrollX, scrollY])",
        returnByValue: true
      });
      const [vw, vh, dpr, scrollX, scrollY] = JSON.parse(vp.result.value);
      if (vw > 0 && vh > 0) {
        const inverseDpr = 1 / (dpr > 0 ? dpr : 1);
        // `clip` is in PAGE coordinates, not viewport coordinates — the offset
        // from the document origin, which is what `scrollX/scrollY` are. Every
        // capture used to pass x:0,y:0, i.e. "the top of the document", however
        // far down the page actually was. Unscrolled that is the same rectangle
        // and everything looked right; scrolled, it asks for a region that is no
        // longer on screen, and with captureBeyondViewport:false the part
        // outside the viewport comes back empty. The images degraded exactly in
        // step with scroll depth — 112KB unscrolled, 76KB after three ticks,
        // 18KB after eight, 9KB after fourteen — and the agent, shown a blank
        // picture of the form it had just scrolled to, concluded the page had
        // nothing on it. Worse than blank: a partially-overlapping capture is
        // legible but shifted, so every coordinate read off it is wrong by
        // exactly the scroll offset.
        const region = normalizeCropRegion(opts.region, vw, vh);
        if (region) {
          // A zoom: crop to the rectangle and magnify it, so the thing that was
          // unreadable at page scale is actually resolvable. Before this, the
          // `zoom` action captured the WHOLE viewport and returned it unchanged
          // with the region echoed in the text — the caller asked to look
          // closer, got the identical picture back, and had no way to tell.
          shotScale = zoomScaleForRegion(region.width, region.height);
          // The caller's region is viewport-relative (read off a screenshot),
          // so it needs the same page-coordinate shift.
          clip = {
            x: region.x + scrollX,
            y: region.y + scrollY,
            width: region.width,
            height: region.height,
            scale: shotScale * inverseDpr
          };
        } else {
          // 1/dpr undoes the display's rasterisation so image pixels are CSS
          // pixels; `shotScale` then shrinks the whole thing, if it has to, so
          // the API does not do that resize itself behind our back and shift
          // every coordinate the model reads off the result. See
          // MODEL_IMAGE_MAX_EDGE above.
          shotScale = captureScaleForViewport(vw, vh);
          clip = { x: scrollX, y: scrollY, width: vw, height: vh, scale: shotScale * inverseDpr };
        }
      }
    } catch {}
    // Recorded BEFORE the capture can fail: a screenshot the model never
    // receives must not leave a scale behind that a later click would apply.
    // Written only on success, below.

    const shot = async (quality) => {
      const params = { format: "jpeg", quality, optimizeForSpeed: true, captureBeyondViewport: false };
      if (clip) params.clip = clip;
      return (await cdp(tabId, "Page.captureScreenshot", params)).data;
    };

    let base64 = await shot(45);

    // Blank-frame guard. Even with the paint wait above, a capture can still
    // catch the renderer mid-replacement and come back essentially uniform. The
    // tell is the compressed size: a real 1198x912 page is 60-150KB, while the
    // blank frame that derailed a run measured 9.5KB — under 9KB per megapixel,
    // where a page with any content on it does not go near that. One more
    // paint wait and one more capture is cheap; being handed a white picture of
    // a page full of content is not, because "blank image" and "empty page" are
    // indistinguishable to whoever is looking at it.
    const megapixels = clip ? Math.max(0.01, (clip.width * clip.height * shotScale * shotScale) / 1e6) : 1;
    const looksBlank = (b64) => b64.length / megapixels < 15000;
    let blankAfterRetry = false;
    if (looksBlank(base64)) {
      try {
        await withTimeout(
          cdp(tabId, "Runtime.evaluate", {
            expression: "new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r(1))))",
            awaitPromise: true
          }),
          500,
          "paint settle retry"
        );
      } catch {}
      const second = await shot(45);
      if (second.length > base64.length) base64 = second;
      blankAfterRetry = looksBlank(base64);
      dbg("cdp", `capture looked blank (${Math.round(base64.length / megapixels / 1000)}KB/MP); recaptured${blankAfterRetry ? " — still blank" : " — recovered"}`, { tab: tabId });
    }

    // If still too large (>350KB base64 ≈ ~262KB binary), reduce quality further
    if (base64.length > 350000) {
      base64 = await shot(28);
    }

    // The coordinate space this image is in — the single fact that made screenshot
    // bugs invisible for so long. The response reports dimensions; it says nothing
    // about the pixel ratio the capture was rasterised at, the clip scale used to
    // undo it, or whether a quality retry fired. An agent reading coordinates off
    // this image is trusting every one of those.
    dbg(
      "cdp",
      `screenshot ${clip ? `${clip.width}x${clip.height} CSS px, dpr ${Math.round((1 / clip.scale) * 100) / 100}, clip scale ${Math.round(clip.scale * 1000) / 1000}` : "NO CLIP — image is in device pixels, not CSS pixels"}` +
        ` -> ${Math.round((base64.length * 3) / 4 / 1024)}KB${base64.length > 350000 ? " (after quality retry)" : ""}`,
      { tab: tabId }
    );

    const imageId = `screenshot_${Date.now()}`;
    screenshotStore.set(imageId, base64);
    // Keep only last 10 screenshots (less memory pressure)
    const keys = Array.from(screenshotStore.keys());
    while (keys.length > 10) {
      screenshotStore.delete(keys.shift());
    }

    // The model is about to be shown THIS image; from here until the next
    // capture, a coordinate it sends for this tab is in this image's space.
    // A cropped zoom is the exception: its pixels are relative to the crop and
    // magnified, so adopting its scale would misdirect every subsequent click.
    // The last full-page capture stays authoritative.
    if (!opts.region) captureScaleByTab.set(tabId, shotScale);

    return {
      base64,
      imageId,
      scale: shotScale,
      width: clip ? Math.round(clip.width * shotScale) : null,
      height: clip ? Math.round(clip.height * shotScale) : null,
      // Reported so the caller can say the image may be blank, rather than
      // letting a white picture read as an empty page.
      blank: blankAfterRetry
    };
  } finally {
    requestOverlayShow(tabId);
  }
}

// Write a captured base64 screenshot to disk via the native host and resolve
// with the absolute path. Used when the computer tool's screenshot action is
// called with save_to_disk: true. The native host replies with `screenshot_saved`.
function writeScreenshotToDisk(base64) {
  if (!nativePort) return Promise.reject(new Error("native host not connected"));
  const id = `shot_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  return new Promise((resolve, reject) => {
    screenshotSaves.set(id, { resolve, reject });
    nativePort.postMessage({
      type: "save_screenshot_to_disk",
      id,
      dataUrl: "data:image/jpeg;base64," + base64,
    });
    // Guard against a dead native host so callers never hang forever.
    setTimeout(() => {
      if (screenshotSaves.has(id)) {
        screenshotSaves.delete(id);
        reject(new Error("timed out waiting for native host to save screenshot"));
      }
    }, 5000);
  });
}

// --- Mouse helpers ---
// Brave withholds the debugger ack for synthesized mouse events (a constant
// ~5s flush for move/press/release; mouseWheel is never acked at all) while
// applying the event itself immediately. Chrome acks instantly. The ack
// carries no data we need, so give real protocol errors a short grace window
// and then proceed; a late ack (or late failure) is logged, not awaited.
// Brave's debugger input pipeline (verified empirically, 2026-07-15):
// the FIRST Input.dispatchMouseEvent of a burst acks after a constant ~5s
// cold-start; commands issued while an earlier one is still un-acked are
// NOT queued for press/release types, they are silently DROPPED (mouseMoved
// queues and applies late; mousePressed/Released vanish). mouseWheel is
// never acked at all but its scroll effect applies immediately.
// Consequences: move/press/release MUST be dispatched serially with each
// ack awaited (correctness over speed); ONLY mouseWheel may use a bounded
// race, because its effect is verified to apply without the ack and nothing
// depends on it inside the same action. Chrome acks everything instantly,
// so the awaits cost nothing there.
const INPUT_ACK_WAIT_MS = 250; // Brave: bounded wait for fire-and-forget (mouseWheel never acks)
const CHROME_INPUT_ACK_WAIT_MS = 50; // Chrome: acks instantly, a short window suffices

async function sendMouseEvent(tabId, params, { awaitAck = true, noAck = false } = {}) {
  await ensureAttached(tabId);
  const t0 = Date.now();
  dbg("input", `${params.type}(${params.x},${params.y})${params.deltaY ? ` dy=${params.deltaY}` : ""}${noAck ? " noack" : awaitAck ? "" : " raced"}`,
      { tab: tabId, x: params.x, y: params.y });
  const send = withTimeout(
    chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", params),
    CDP_TIMEOUT_MS,
    "CDP Input.dispatchMouseEvent",
  );
  if (noAck) {
    // Queue it and move on WITHOUT waiting for the ack at all.
    //
    // This exists for humanized motion, where the ack round-trip — not the
    // modelled timing — is the real cost: a natural click plans ~0.8s of
    // delays but measured ~3.9s in the browser, because each of ~45 moves
    // waited ~85ms for its ack. Cursor moves need no ack (they apply
    // regardless, and the plan carries its own pacing in sleep steps), so
    // waiting only buys latency. Press/release still use the awaited path,
    // since those ARE dropped if issued while an earlier command is un-acked.
    // A failure arriving after we stopped waiting is precisely the case where
    // the stream would otherwise show a clean dispatch for an event that never
    // landed. Record it against the coordinates it was meant for.
    send.catch((e) => {
      dbg("input", `${params.type}(${params.x},${params.y}) FAILED AFTER SEND (noack) — nothing received it`,
          { tab: tabId, x: params.x, y: params.y, err: String(e && e.message).slice(0, 120) });
      console.warn("Input.dispatchMouseEvent (noAck):", e.message);
    });
    return;
  }
  if (awaitAck) {
    await send; // serial-await path (required on Brave: press/release dropped if not awaited)
    return;
  }
  // Fire-and-forget path (mouseWheel, and Chrome mouseMoved): wait for the ack
  // only up to a bounded window so Brave's ~5s-stalled acks don't block us.
  // Brave needs the full window; Chrome acks instantly, so a short one suffices.
  const ackWaitMs = (await isBrave()) ? INPUT_ACK_WAIT_MS : CHROME_INPUT_ACK_WAIT_MS;
  await Promise.race([
    send.catch((e) => {
      dbg("input", `${params.type}(${params.x},${params.y}) LATE FAILURE — dispatch did not take`,
          { tab: tabId, x: params.x, y: params.y, err: String(e && e.message).slice(0, 120) });
      console.warn("Input.dispatchMouseEvent late ack/failure:", e.message);
    }),
    sleep(ackWaitMs),
  ]);
}

async function dispatchMouse(tabId, type, x, y, opts = {}) {
  if (opts.noAck) {
    await sendMouseEvent(
      tabId,
      { type, x, y, button: opts.button || "left", clickCount: opts.clickCount || 1, modifiers: opts.modifiers || 0 },
      { noAck: true }
    );
    return;
  }
  // Chrome acks instantly and applies immediately, so the mouseMoved "move"
  // sub-event needs no ack and can be fire-and-forget (awaitAck:false). Brave
  // must keep the serial-await path (its moves silently drop if not awaited).
  const awaitAck = opts.awaitAck ?? (type === "mouseMoved" ? await isBrave() : true);
  await sendMouseEvent(
    tabId,
    {
      type,
      x,
      y,
      button: opts.button || "left",
      clickCount: opts.clickCount || 1,
      modifiers: opts.modifiers || 0,
    },
    { awaitAck },
  );
}

async function mouseClick(tabId, x, y, opts = {}) {
  const button = opts.button || "left";
  const clickCount = opts.clickCount || 1;
  const modifiers = opts.modifiers || 0;
  // Real-dispatch progress callback for the action-event schema (design.md
  // 5c) — see makePointerStepHandler(). Undefined for any caller that does
  // not pass it (every pre-existing call site before this batch), so this
  // parameter changes nothing unless a caller explicitly opts in.
  const onStep = opts.onStep;

  // Humanized: approach along a curved path from wherever this tab's cursor
  // actually is, land on the requested point, press/release with real dwell.
  if (await humanizeOn(tabId)) {
    const s = human(effectiveConfig(tabId).humanize_speed, effectiveConfig(tabId).humanize_seed);
    const from = cursorByTab.get(tabId) || { x: Math.max(0, x - 220), y: Math.max(0, y - 160) };
    await dispatchPlan(
      tabId,
      humanize.planClick(s, from, { x, y }, { button, clickCount, targetSize: opts.targetSize }),
      modifiers,
      onStep
    );
    return;
  }

  await dispatchMouse(tabId, "mouseMoved", x, y, { modifiers });
  if (onStep) onStep({ k: "move", x, y });
  // Brave's debugger pipeline needs a ~50ms settle window between dispatched
  // events (verified empirically); Chrome acks instantly, so the sleeps are
  // pure latency there and are dropped to keep clicks snappy.
  const brave = await isBrave();
  if (brave) await sleep(50);
  await dispatchMouse(tabId, "mousePressed", x, y, { button, clickCount, modifiers });
  if (onStep) onStep({ k: "down", x, y, button, clickCount });
  if (brave) await sleep(50);
  await dispatchMouse(tabId, "mouseReleased", x, y, { button, clickCount, modifiers });
  if (onStep) onStep({ k: "up", x, y, button, clickCount });
  cursorByTab.set(tabId, { x, y });
}

// --- Humanization config + plan execution -----------------------------------
//
// The behavioural modelling lives in extension/humanize/ (pure, no browser
// APIs). Everything below is the thin seam: read the flag, walk a plan, map
// each primitive step onto the CDP call the non-humanized path already uses.

const CONFIG_KEY = "ocic_config_v1";       // { default: {...} } in local
const TAB_CONFIG_KEY = "ocic_tab_config_v1"; // { [tabId]: {...} } in session

// Recognized settings, and what they do when true. `get_config` reports this
// catalog, so adding a setting later means adding one entry here and reading
// effectiveConfig(tabId).<key> where it applies — set_config never changes.
const CONFIG_SCHEMA = {
  humanize:
    "Drive mouse and keyboard the way a person would: curved cursor paths with " +
    "acceleration and overshoot, clicks that land off-centre inside the target " +
    "with a real press dwell, scrolls decomposed into momentum ticks, and typing " +
    "with per-character keydown/keyup and human inter-key timing. Outcomes are " +
    "identical (same element, same text, same scroll position) — only the motion " +
    "and timing change, so actions take noticeably longer. Default false.",
  humanize_speed:
    "How much time humanized motion is allowed to take, fastest to slowest: " +
    "\"fastest\", \"fast\" (default), \"natural\", \"relaxed\". Higher tiers " +
    "spend more time and draw cursor paths with more samples. \"natural\" is " +
    "genuine human cadence; \"fastest\" keeps the shape of human motion but " +
    "compresses it, for when there is a lot to get through. Every tier keeps " +
    "movement before the click, real key events and identical outcomes — faster " +
    "tiers use fewer path samples and shorter pauses, never none. Only applies " +
    "while humanize is true.",
  audit_mode:
    "Passively record what this agent does in the browser, so a person can watch " +
    "it back. \"off\" (default) records nothing and costs nothing. \"audit\" " +
    "starts an rrweb DOM recording in each tab the first time an action touches " +
    "it, and stitches those into one timeline per Claude Code session, viewable " +
    "under Audits on the extension's options page. Recording runs in the " +
    "extension's isolated world, so the page cannot observe it, and captures DOM " +
    "rather than pixels — video and canvas content are not captured. This is a " +
    "mode rather than a flag because a future \"teach\" mode wants the opposite " +
    "masking defaults."
};

const AUDIT_MODES = ["off", "audit"];
let configState = {
  default: { humanize: false, humanize_speed: "fast", humanize_seed: null, audit_mode: "off" },
  byTab: {}
};
let configHydrated = null;

async function hydrateConfig() {
  try {
    const local = await chrome.storage.local.get(CONFIG_KEY);
    const session = await chrome.storage.session.get(TAB_CONFIG_KEY);
    configState = {
      default: {
        humanize: false, humanize_speed: "fast", humanize_seed: null, audit_mode: "off",
        ...(local[CONFIG_KEY] || {})
      },
      byTab: session[TAB_CONFIG_KEY] || {}
    };
  } catch {}
  return configState;
}
// MV3 evicts this worker, so re-hydrate at every start and keep the cache live.
configHydrated = hydrateConfig().then((c) => {
  audit.setEnabled(c.default.audit_mode === "audit");
  return c;
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes[CONFIG_KEY]) {
    configState.default = { humanize: false, audit_mode: "off", ...(changes[CONFIG_KEY].newValue || {}) };
    audit.setEnabled(configState.default.audit_mode === "audit");
  }
  if (area === "session" && changes[TAB_CONFIG_KEY]) {
    configState.byTab = changes[TAB_CONFIG_KEY].newValue || {};
  }
});

/** Per-tab overrides win over the default. */
function effectiveConfig(tabId) {
  return { ...configState.default, ...(configState.byTab[String(tabId)] || {}) };
}

async function humanizeOn(tabId) {
  await configHydrated;
  return !!effectiveConfig(tabId).humanize;
}

async function writeConfig(key, value, tabId) {
  await configHydrated;
  if (tabId === undefined || tabId === null) {
    const next = { ...configState.default };
    if (value === null) delete next[key];
    else next[key] = value;
    configState.default = next;
    await chrome.storage.local.set({ [CONFIG_KEY]: next });
    return next;
  }
  const id = String(tabId);
  const byTab = { ...configState.byTab };
  const forTab = { ...(byTab[id] || {}) };
  if (value === null) delete forTab[key];
  else forTab[key] = value;
  if (Object.keys(forTab).length) byTab[id] = forTab;
  else delete byTab[id];
  configState.byTab = byTab;
  // Per-tab overrides live in session storage: tab ids are session-scoped, so
  // persisting them past a browser restart would attach settings to unrelated
  // future tabs.
  await chrome.storage.session.set({ [TAB_CONFIG_KEY]: byTab });
  return effectiveConfig(tabId);
}

/**
 * Execute a humanize plan. The ONLY place plans meet the browser: each step is
 * dispatched through the same CDP calls the non-humanized path uses, so a
 * humanized action cannot do anything a normal one could not.
 *
 * `onStep`, if given, is called SYNCHRONOUSLY right after each step's real
 * CDP dispatch (never before, never for "sleep" — that is timing, not a
 * dispatch) with the exact step object just sent. It is optional and purely
 * additive: every call site that omits it (including
 * test/humanize-executor.test.mjs's fixture, which predates this parameter)
 * dispatches byte-for-byte identically to before — see
 * reports/05-action-event-schema.md's "instrumentation did not alter
 * dispatch ordering or timing" evidence.
 */
async function dispatchPlan(tabId, plan, modifiers = 0, onStep) {
  await ensureAttached(tabId);
  for (const step of plan) {
    switch (step.k) {
      case "sleep":
        await sleep(step.ms);
        break;
      case "move":
        // awaitAck:false is load-bearing here. A humanized path dispatches
        // dozens of mouseMoved events, and on some Chromium builds each one
        // can sit ~5s waiting for a debugger ack — 26 moves then blow past the
        // 60s tool timeout (observed). The plan already carries its own timing
        // in the sleep steps, and moves apply without their ack, so nothing is
        // lost by not waiting. Press/release still await (they are dropped if
        // issued while an earlier command is un-acked).
        await dispatchMouse(tabId, "mouseMoved", step.x, step.y, { modifiers, noAck: true });
        cursorByTab.set(tabId, { x: step.x, y: step.y });
        if (onStep) onStep(step);
        break;
      case "down":
        await dispatchMouse(tabId, "mousePressed", step.x, step.y, {
          button: step.button, clickCount: step.clickCount, modifiers
        });
        if (onStep) onStep(step);
        break;
      case "up":
        await dispatchMouse(tabId, "mouseReleased", step.x, step.y, {
          button: step.button, clickCount: step.clickCount, modifiers
        });
        cursorByTab.set(tabId, { x: step.x, y: step.y });
        if (onStep) onStep(step);
        break;
      case "wheel":
        await sendMouseEvent(
          tabId,
          { type: "mouseWheel", x: step.x, y: step.y, deltaX: step.dx, deltaY: step.dy, modifiers },
          { noAck: true }
        );
        if (onStep) onStep(step);
        break;
      case "kdown":
        // rawKeyDown is the NON-text-producing variant: it gives the page a
        // keydown event without the renderer inserting a character. All text
        // comes from the "text" step below, exactly once.
        await cdp(tabId, "Input.dispatchKeyEvent", {
          type: "rawKeyDown",
          key: step.key,
          code: step.code,
          windowsVirtualKeyCode: step.keyCode || 0,
          modifiers: step.mods || 0,
          autoRepeat: !!step.autoRepeat
        });
        if (onStep) onStep(step);
        break;
      case "kup":
        await cdp(tabId, "Input.dispatchKeyEvent", {
          type: "keyUp",
          key: step.key,
          code: step.code,
          windowsVirtualKeyCode: step.keyCode || 0,
          modifiers: step.mods || 0
        });
        if (onStep) onStep(step);
        break;
      case "text":
        await cdp(tabId, "Input.insertText", { text: step.text });
        if (onStep) onStep(step);
        break;
    }
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- What a coordinate-based action actually landed on -----------------------
//
// A dispatch always "succeeds": the events go out whether or not anything is
// there to receive them. So a perfect hit, a click into empty space, and a
// click swallowed by a transparent overlay all used to return the identical
// `Clicked at (x, y)` and nothing else — the caller could not tell them apart
// without instrumenting the page itself. Every click-accuracy bug found so far
// was invisible for exactly this reason.
//
// Resolving the point through the content script (isolated world) lets the
// answer include the ref of whatever is there, in the same ref space that
// read_page and find hand out. Best-effort throughout: this is an observability
// aid, so a failure here must never fail the action it is describing.
// Probe what is at a point. Split into three pieces on purpose: the probe, the
// full descriptor, and the (usually empty) response note.
//
// The tool response is deliberately silent when a click lands cleanly, because
// annotating every successful click would be noise on the overwhelmingly common
// path. But "omitted from the response" must not mean "discarded": the debug
// stream is where everything the response leaves out is supposed to end up, so
// the descriptor is computed once and always recorded, whatever the response
// chooses to say.
async function probeHit(tabId, x, y) {
  try {
    const resp = await sendContentMessage(tabId, { type: "describePoint", x, y });
    const r = resp && resp.result;
    return r ? { ok: true, r } : { ok: false, err: "content script returned no result" };
  } catch (e) {
    return { ok: false, err: String(e && e.message).slice(0, 120) };
  }
}

// Compact one-line descriptor for the debug stream. Always produced — including
// on the success path, where the response itself says nothing.
function formatHit(p) {
  if (!p.ok) {
    // A failed probe is NOT a clean hit. Saying so explicitly is the whole
    // point: silence here would be indistinguishable from success.
    return `PROBE FAILED (${p.err}) — nothing is known about what is at this point`;
  }
  const r = p.r;
  const vp = r.viewport ? r.viewport.join("x") : "?";
  if (!r.hit) {
    return r.outside
      ? `NOTHING — point lies outside the ${vp} viewport`
      : `NOTHING — no element at that point in the ${vp} viewport`;
  }
  const h = r.hit;
  const a = h.attrs || {};
  const id = a.id ? `#${a.id}` : "";
  const cls = h.cls ? `.${h.cls}` : "";
  const extra = [];
  if (a["data-testid"] || a["data-test"]) extra.push(`testid=${a["data-testid"] || a["data-test"]}`);
  if (a.role) extra.push(`role=${a.role}`);
  if (a["aria-label"]) extra.push(`aria="${a["aria-label"]}"`);
  if (a.name) extra.push(`name=${a.name}`);
  if (a.type) extra.push(`type=${a.type}`);
  if (h.ref) extra.push(h.ref);
  const text = h.text ? ` "${h.text}"` : "";
  return `<${h.tag}${id}${cls}>${text}${extra.length ? " " + extra.join(" ") : ""}` +
    `${r.bare ? " (page background)" : ""} in ${vp} viewport`;
}

// The response note. Silent on success; only the two cases a caller cannot
// otherwise detect get a word. A failed probe stays silent here too — it is a
// fault in the instrument, not a finding about the click, and it is recorded in
// the debug stream instead of being guessed at in the result.
/** A short, factual note naming what a coordinate click actually landed on.
 *
 * hitNote_ below deliberately stays silent whenever the click hit SOME element,
 * on the reasoning that there is nothing to warn about. But "hit an element" and
 * "hit the intended element" are different facts, and the caller can only tell
 * them apart if we say which one it was. Clicking a radio it had estimated the
 * position of, the agent got back exactly `Clicked at (309, 182)` — no way to
 * know it had selected the wrong option, so it went on to confirm the dialog and
 * only discovered the mistake a full read_page later.
 *
 * This is not a warning and does not claim anything failed: it reports the
 * element that received the click, so a wrong target is visible immediately
 * instead of two steps later. */
function hitLandedNote_(p) {
  if (!p.ok || !p.r || !p.r.hit) return "";
  const h = p.r.hit;
  const a = h.attrs || {};
  const bits = [];
  if (a.type) bits.push(`type=${a.type}`);
  if (a["aria-label"]) bits.push(`aria="${a["aria-label"]}"`);
  const text = h.text ? ` "${String(h.text).slice(0, 60)}"` : "";
  return ` — landed on <${h.tag}${bits.length ? " " + bits.join(" ") : ""}>${text}`;
}

/**
 * Split a hit probe into what the caller is told and the part of that which is
 * actually a warning.
 *
 * These are two different facts and only one of them says anything went wrong.
 * `hitLandedNote_` documents itself as "not a warning": it reports which
 * element received a click that landed cleanly. Feeding it to
 * deriveOutcomeStatus() — which reads any non-empty note as a reason for
 * doubt — stamped `unknown` on every click that hit exactly what it aimed at,
 * so a run reading its own timeline saw a page full of maybe-failures and
 * re-screenshotted, re-clicked and second-guessed work that had in fact
 * succeeded. The note stays; only the outcome label is now taken from the
 * warning alone.
 */
function probeNotes_(p) {
  const warning = hitNote_(p);
  return { note: warning || hitLandedNote_(p), warning };
}

/** Reports the dropdown a click just opened, so the next move is not a guess.
 *
 * A click that opens a list and a click that closes one return the identical
 * `Clicked at (x, y)`. That symmetry is what let a run alternate open/closed
 * eleven times in a row without typing anything: each result looked like the
 * one before it. Saying "a list is open" — and what to do with it — makes the
 * page's state part of the answer. Best-effort: never fails the click. */
async function openListNote_(tabId) {
  try {
    const resp = await sendContentMessage(tabId, { type: "describeOpenList" });
    const r = resp && resp.result;
    if (!r || !r.open) return "";
    if (r.kind === "datepicker") {
      const fields = r.inputs
        ? ` It has ${r.inputs} date field(s) of its own: click one and TYPE the date into it.`
        : "";
      return ` — a date picker is now OPEN. Screenshot it, then either type the date or click the day cell you want.${fields} Do NOT click the field again: that closes the picker and keeps the old value.`;
    }
    const count = r.options ? ` with ${r.options} option(s)` : "";
    return r.hasSearch
      ? ` — a dropdown list is now OPEN${count} and has a search field. Type your text to filter it, then click the option you want. Do NOT click this control again: that closes the list and discards what you typed.`
      : ` — a dropdown list is now OPEN${count}. Pick one of its options. Do NOT click this control again: that closes the list.`;
  } catch {
    return "";
  }
}

function hitNote_(p) {
  if (!p.ok) return "";
  const r = p.r;
  if (r.hit && !r.bare && !r.deadLabel) return "";
  const vp = r.viewport ? `${r.viewport[0]}x${r.viewport[1]}` : "the";
  // A label with no activatable control and no interactive ancestor: browsers
  // forward activation only for a label actually wired to a live control, so
  // nothing native is guaranteed to receive this click. It may still be caught
  // by a delegated handler we can't see, so warn rather than claim it failed.
  if (r.deadLabel) {
    return ` — WARNING: landed on a <label> whose control is missing or disabled, so the click may not have activated the widget it labels. Pass the control's ref instead of raw coordinates if that widget was intended.`;
  }
  if (!r.hit) {
    return r.outside
      ? ` — WARNING: nothing received this. The point is outside the ${vp} viewport, so it landed on no element. Pass the element's ref instead of raw coordinates and it will be scrolled into view automatically.`
      : ` — WARNING: no element at that point in the ${vp} viewport, so nothing received this.`;
  }
  return ` — WARNING: landed on <${r.hit.tag}> (page background), not on any element. Pass the element's ref instead of raw coordinates and it will be scrolled into view automatically.`;
}


// --- Debug recorder ----------------------------------------------------------
//
// One flat, timestamped event stream covering everything this extension does:
// tool calls, CDP commands and their durations, dispatched input with its
// coordinates, what each click actually landed on, and native-host connection
// changes. Read it with the `debug` tool.
//
// It exists so a failure can be SEEN rather than reconstructed. Several bugs
// here (clicks landing on nothing, screenshots in the wrong coordinate space,
// a resize the window manager refused) were invisible because success and
// failure produced identical output, and each took hours of forensics.
//
// Two rules, because a feedback channel that lies is worse than none:
//
//   1. Recording must never affect what it records. Every entry point is
//      wrapped so a fault in here can never fail, slow, or alter a real
//      action. Recording is a plain array push.
//   2. Absence of a record must never look like absence of an event. The
//      buffer is bounded and lives in a service worker that MV3 evicts, so
//      both limits are reported explicitly on every read: how many events were
//      dropped, and how far back the buffer actually reaches. A reader is told
//      what is NOT in here, not left to assume the silence is meaningful.
const DEBUG_MAX = 1000;
const debugLog = [];
let debugDropped = 0;
const debugBootedAt = Date.now();

// What the caller actually ASKED for. A tool response never echoes its own
// arguments, so without this the stream cannot answer the first question you
// ask of any log entry: what was this call, exactly?
function argSummary(args) {
  if (!args || typeof args !== "object") return "(no args)";
  const parts = [];
  for (const [k, v] of Object.entries(args)) {
    if (k === "tabId") continue; // already carried on the entry itself
    let out;
    if (typeof v === "string") {
      out = v.length > 60 ? JSON.stringify(v.slice(0, 60)) + `…+${v.length - 60}ch` : JSON.stringify(v);
    } else if (Array.isArray(v)) {
      out = `[${v.slice(0, 4).join(",")}${v.length > 4 ? ",…" : ""}]`;
    } else if (v && typeof v === "object") {
      out = "{…}";
    } else {
      out = String(v);
    }
    parts.push(`${k}=${out}`);
  }
  return parts.length ? parts.join(" ") : "(no args)";
}

// What the response LEAVES OUT about itself: how much came back, and the size
// of any image. Deliberately NOT the response text — the caller already has
// that, and echoing it here would make the stream a duplicate rather than a
// record of what was omitted.
function resultShape(result) {
  const items = (result && result.content) || [];
  let chars = 0, images = 0, b64 = 0;
  for (const it of items) {
    if (!it) continue;
    if (it.type === "text" && typeof it.text === "string") chars += it.text.length;
    else if (it.type === "image" && typeof it.data === "string") { images++; b64 += it.data.length; }
  }
  const bits = [];
  if (chars) bits.push(`${chars}ch`);
  if (images) bits.push(`${images} image ${Math.round((b64 * 3) / 4 / 1024)}KB`);
  return bits.length ? bits.join(" + ") : "empty";
}

function dbg(kind, detail, extra) {
  try {
    const e = { t: Date.now(), kind, detail: String(detail).slice(0, 300) };
    if (extra && typeof extra === "object") {
      for (const k of ["tab", "ms", "x", "y", "err"]) {
        if (extra[k] !== undefined && extra[k] !== null) e[k] = extra[k];
      }
    }
    debugLog.push(e);
    if (debugLog.length > DEBUG_MAX) {
      debugDropped += debugLog.length - DEBUG_MAX;
      debugLog.splice(0, debugLog.length - DEBUG_MAX);
    }
  } catch {
    // A recorder that throws would take down the action it is observing.
  }
}

// SDK-path tabs_context_mcp (design.md 5b): report this run's own tab scope
// — usually the current-page tab already bound to it — instead of the
// legacy Chrome "MCP" group, which a borrowed tab was never added to. Kept
// as a standalone function (rather than inlined in the handler below) so it
// is trivially unit-testable against a fake chrome.tabs without dragging in
// ensureTabGroup()'s window-creation side effects.
async function sdkTabsContext(meta) {
  const scope = meta.tabScope;
  const scopeTabIds = scope === "any" ? [...sdkAgentCreatedTabs] : Array.isArray(scope) ? scope : [];
  const tabs = [];
  for (const id of scopeTabIds) {
    try {
      tabs.push(await chrome.tabs.get(id));
    } catch {
      // Closed/invalid tabId in scope: omit rather than fail the whole call.
    }
  }
  const result = formatTabContext(tabs);
  const borrowedIds = scopeTabIds.filter((id) => !sdkAgentCreatedTabs.has(id));
  const note = borrowedIds.length
    ? `This run's context already includes tab(s) [${borrowedIds.join(", ")}] as the current page(s) provided for it — read-only by default; mutating one needs explicit task authorization. `
    : "";
  result.content[0].text =
    `${note}Create a new tab with tabs_create_mcp only if the task genuinely needs a separate page.\n\n` +
    result.content[0].text;
  return result;
}

// Does `input` already carry a URL scheme (any scheme, not just http/https)?
// Used by navigate() to decide whether to prepend "https://" — the tool's
// documented "with or without protocol (defaults to https://)" behavior.
//
// A naive substring check on "://" (or worse, blindly prefixing "https://"
// whenever the input isn't already http/https) mishandles every non-web
// scheme: "chrome-extension://<id>/..." would get "https://" prepended,
// producing "https://chrome-extension://<id>/...", which `new URL()` then
// re-parses as host "chrome-extension" with the rest of the string collapsed
// into an opaque path (the ":" after "chrome-extension" is read as a port
// separator and dropped) — a corrupted URL that 404s/DNS-fails instead of
// the extension page it named.
//
// This does real scheme-grammar parsing (RFC 3986: ALPHA *(ALPHA / DIGIT /
// "+" / "-" / ".")) instead of a "://" substring check, then resolves the
// one genuine ambiguity in that grammar — a bare "host:port" like
// "example.com:8080/path" is *syntactically* indistinguishable from
// "scheme:opaque-data" — the same way a browser does: a scheme written in
// authority form ("scheme://...") is unambiguous and always accepted (this
// is what makes chrome-extension://, file://, http(s)://, ftp://, and any
// future browser/extension scheme pass through untouched); a scheme NOT in
// authority form is only accepted when it's one of the small set of
// well-known non-slash browser schemes, so "example.com:8080/path" and
// "localhost:3000" are correctly treated as scheme-less and still get
// "https://" prepended.
const KNOWN_NON_SLASH_SCHEMES = new Set(["about", "data", "blob", "javascript", "mailto", "view-source"]);
function hasUrlScheme(input) {
  const m = /^([a-zA-Z][a-zA-Z\d+\-.]*):(.*)$/s.exec(input);
  if (!m) return false;
  const [, scheme, rest] = m;
  if (rest.startsWith("//")) return true;
  return KNOWN_NON_SLASH_SCHEMES.has(scheme.toLowerCase());
}

// --- WebMCP page-tool state (consume-webmcp-page-tools) --------------------
//
// document.modelContext (WebMCP, W3C WebML CG, Chrome origin trial 149-156,
// expiring 2026-11-16) lets a VISITED PAGE publish its own callable tools.
// This is off by default on essentially every site today — the trial
// requires either an enrolled origin or the user's own
// chrome://flags/#enable-webmcp-testing — so "no entry in this table" is the
// ordinary state of almost every tab, and reads as empty, never as an error
// (spec: "Silent absence when the page publishes no tools").
//
// extension/webmcp/detect-main.js runs at document_start in the page's own
// (MAIN) world — the only place document.modelContext is reachable — and
// cannot use chrome.*. extension/webmcp/relay-isolated.js bridges it to this
// service worker over window.postMessage, namespaced under WEBMCP_MARKER so
// it is never confused with any other extension channel. Unlike
// detect-main.js (declared in extension/manifest.json, the one new
// content_scripts entry task 1.5 allows), relay-isolated.js is registered
// dynamically below via chrome.scripting.registerContentScripts: this keeps
// both pre-existing manifest entries byte-identical while still giving the
// relay real document_start timing (not a race against a later re-injection
// attempt) — a gap design.md's "one new manifest entry" framing did not
// itself spell out, since the manifest can only bind one world per entry
// and detect-main.js already claims that one entry for the MAIN world.
//
// Everything this table holds is PAGE-SUPPLIED CONTENT: names, descriptions,
// and schemas the visited site chose to publish about itself. It is handed
// to the agent labelled as such by webmcp_list_tools/webmcp_call_tool below,
// and is never treated as instructions from the extension itself.
const WEBMCP_MARKER = "browzy_webmcp_v1";
const WEBMCP_RELAY_SCRIPT_ID = "browzy-webmcp-relay";
const WEBMCP_CALL_TIMEOUT_MS = 20000; // longer than relay-isolated.js's own 18s internal timeout, so the page-side "timed out waiting for the page" message wins over this generic one in the ordinary case.

// tabId -> { origin: string|null, tools: [{name, description, inputSchema}], executeToolAvailable: boolean }
const webmcpTabTools = new Map();

async function ensureWebmcpRelayRegistered() {
  try {
    const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [WEBMCP_RELAY_SCRIPT_ID] });
    if (existing && existing.length > 0) return; // already registered — re-registering the same id throws
    await chrome.scripting.registerContentScripts([
      {
        id: WEBMCP_RELAY_SCRIPT_ID,
        js: ["webmcp/relay-isolated.js"],
        matches: ["<all_urls>"],
        runAt: "document_start",
        allFrames: false,
        world: "ISOLATED",
        persistAcrossSessions: true
      }
    ]);
  } catch (e) {
    // A registration race (two service-worker startups overlapping) throws
    // "already registered" — harmless, the earlier call already won.
    // Anything else just means the relay stays unregistered on this
    // browser: WebMCP is best-effort everywhere, and the practical effect is
    // that webmcp_list_tools keeps reporting the ordinary "no page-declared
    // tools" empty state rather than the feature working.
    dbg("webmcp", `relay registration failed: ${String(e && e.message).slice(0, 160)}`);
  }
}
ensureWebmcpRelayRegistered();

// Cleared on every navigation start and on tab close — a stale entry (the
// PREVIOUS page's tools, surviving into a new document) would be worse than
// an empty table, since it would let the agent call a tool that belongs to a
// page that is no longer there.
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading") webmcpTabTools.delete(tabId);
});
chrome.tabs.onRemoved.addListener((tabId) => {
  webmcpTabTools.delete(tabId);
});

// relay-isolated.js's unsolicited inventory pushes land here. Fire-and-
// forget from the relay's side (it does not await a response), so this
// listener never calls sendResponse and never returns true.
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || msg[WEBMCP_MARKER] !== true || msg.type !== "webmcp_inventory_report") return;
  const tabId = sender && sender.tab && typeof sender.tab.id === "number" ? sender.tab.id : null;
  if (tabId === null) return;
  let origin = null;
  if (sender.origin) origin = sender.origin;
  else if (sender.url) {
    try {
      origin = new URL(sender.url).origin;
    } catch {
      origin = null;
    }
  }
  const tools = Array.isArray(msg.tools)
    ? msg.tools
        .filter((t) => t && typeof t.name === "string")
        .map((t) => ({
          name: t.name,
          description: typeof t.description === "string" ? t.description : "",
          inputSchema: t.inputSchema && typeof t.inputSchema === "object" ? t.inputSchema : {}
        }))
    : [];
  webmcpTabTools.set(tabId, { origin, tools, executeToolAvailable: !!msg.executeToolAvailable });
});

// Re-inject relay-isolated.js into a tab on demand, in case
// registerContentScripts (above) never reached it — belt-and-suspenders,
// not load-bearing: the dynamic registration already covers every ordinary
// navigation. Mirrors sendContentMessage's own inject-and-retry shape.
async function ensureWebmcpRelayInTab(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["webmcp/relay-isolated.js"] });
  } catch {
    // Expected for chrome://, the Web Store, PDF viewers, a closed tab, and
    // any other page scripting cannot reach — never worth surfacing as an
    // error. callWebmcpTool()'s own send below is the real signal of
    // whether a relay ended up listening.
  }
}

// Dispatch a call request to tabId's WebMCP relay and wait for its result.
// Resolves with { ok, via, result } or { ok:false, via, error } — never
// throws for an ordinary "the page tool failed" outcome; only throws when no
// relay in the tab could be reached at all (no page code was ever invoked in
// that case).
async function callWebmcpTool(tabId, name, toolArgs) {
  const requestId = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const request = { [WEBMCP_MARKER]: true, type: "call_request", requestId, name, toolArgs };
  let response;
  try {
    response = await chrome.tabs.sendMessage(tabId, request);
  } catch {
    response = undefined;
  }
  if (response === undefined || response === null) {
    await ensureWebmcpRelayInTab(tabId);
    try {
      response = await chrome.tabs.sendMessage(tabId, request);
    } catch (e) {
      throw new Error(`no WebMCP relay is reachable in tab ${tabId} (${e.message})`);
    }
  }
  if (!response) throw new Error(`tab ${tabId}'s WebMCP relay returned no response`);
  return response;
}

// --- Tool handlers ---
const toolHandlers = {
  async tabs_context_mcp(args) {
    if (currentToolMeta && currentToolMeta.runId) return sdkTabsContext(currentToolMeta);
    await ensureTabGroup(args.createIfEmpty);
    if (tabGroupId === null) {
      return {
        content: [{ type: "text", text: "No MCP tab group exists. Use createIfEmpty: true to create one." }],
      };
    }
    const tabs = await chrome.tabs.query({ groupId: tabGroupId });
    return formatTabContext(tabs);
  },

  async tabs_create_mcp(args) {
    // Resolve the anchor — the tab the agent is actually working in — BEFORE
    // deciding on a group, because when that tab already sits in one of our
    // own groups the new tab belongs in THAT group, beside it. Grouping it
    // somewhere else splits one task across two groups, and when no group
    // exists yet ensureTabGroup(true) would additionally open a whole new
    // window for it: the operator watches one group while the work appears
    // outside it. The anchor is whatever tab the last tool_request named
    // (`lastAgentTabId`); a stale, closed or ungrouped one simply falls back
    // to the previous behaviour below.
    // `typeof` guards rather than bare reads: this method's SHIPPED body is
    // compiled standalone by test/handlers.test.mjs with a fixed dependency
    // list that declares neither `lastAgentTabId`'s value nor
    // `isOwnAgentGroupId`, where a bare reference is a ReferenceError rather
    // than a no-op.
    let anchor = null;
    try {
      let anchorId = typeof lastAgentTabId === "number" ? lastAgentTabId : null;
      // On the SDK path the run carries its own reach (`tabScope`), and that
      // is the better anchor in the two cases `lastAgentTabId` alone gets
      // wrong:
      //   - the run has not named a tab yet (its first tool was
      //     tabs_context_mcp, or tabs_create_mcp itself), so the slot is
      //     still null even though the run IS bound to the operator's page;
      //   - the slot is a leftover from an EARLIER run and points at a tab
      //     this run cannot touch, so following it would open the new tab
      //     beside unrelated work, in that other group.
      // Both showed as the same symptom: a task begun on the operator's page
      // sprouting a second group. Outside a run (legacy path) the slot is
      // still the only signal there is, and is used unchanged.
      const meta = typeof currentToolMeta !== "undefined" ? currentToolMeta : null;
      if (meta && meta.runId) {
        const scope = meta.tabScope;
        const scopeIds = Array.isArray(scope) ? scope : [];
        // In reach means this run can point at the tab: it is in the run's
        // wire scope, this run opened it, or this run is what put it in the
        // slot. An unscoped run ("any") reaches every tab in principle, but
        // that is precisely the case where an anchor left behind by an
        // earlier run must NOT be inherited — it is only a record of where
        // someone else was working.
        const withinReach =
          anchorId !== null &&
          (scopeIds.includes(anchorId) ||
            (typeof sdkAgentCreatedTabs !== "undefined" && sdkAgentCreatedTabs.has(anchorId)) ||
            (typeof lastAgentTabRunId !== "undefined" && lastAgentTabRunId === meta.runId));
        if (!withinReach) anchorId = scopeIds.length > 0 ? scopeIds[0] : null;
      }
      if (anchorId !== null) anchor = await chrome.tabs.get(anchorId);
    } catch {
      anchor = null; // anchor closed mid-run
    }
    const anchorGroupId = anchor && typeof anchor.groupId === "number" && anchor.groupId !== -1 ? anchor.groupId : null;
    const joinAnchorGroup =
      anchorGroupId !== null && typeof isOwnAgentGroupId === "function" && isOwnAgentGroupId(anchorGroupId);

    // Create the tab INSIDE the target group's own window and do NOT select
    // it: automation must never yank the operator away from what they are
    // looking at. Without windowId the tab lands in whatever window is
    // currently focused — i.e. the operator's — which is exactly the
    // interruption we are avoiding. Use the set_tab_focus tool to surface a
    // tab deliberately.
    let targetGroupId;
    let windowId;
    if (joinAnchorGroup) {
      targetGroupId = anchorGroupId;
      windowId = anchor.windowId;
    } else {
      await ensureTabGroup(true);
      targetGroupId = tabGroupId;
      try {
        const groupTabs = await chrome.tabs.query({ groupId: tabGroupId });
        windowId = groupTabs[0]?.windowId;
      } catch {}
    }
    // Open BESIDE the tab the agent is working on, not at the end of the
    // window. Without an index Chrome appends, and the subsequent
    // chrome.tabs.group() then parks the tab at the far end of the group, so a
    // multi-tab task read back in an order that matched nothing the agent did.
    // `openerTabId` additionally gives Chrome the real parent-child relation it
    // uses for its own tab ordering and close-activation behaviour.
    // The anchor resolved above places the tab; an anchor in another window
    // (or none at all) simply falls back to the previous append.
    const createOpts = { active: false };
    if (windowId) createOpts.windowId = windowId;
    if (anchor && typeof anchor.index === "number" && (windowId === undefined || anchor.windowId === windowId)) {
      createOpts.index = anchor.index + 1;
      createOpts.openerTabId = anchor.id;
    }
    const tab = await chrome.tabs.create(createOpts);
    // Claimed before the grouping call for the same reason ensureTabGroup()
    // does: the tabs event this fires must find the tab already ours.
    tabGroupTabs.add(tab.id);
    await chrome.tabs.group({ tabIds: [tab.id], groupId: targetGroupId });
    // Record this tab as agent-created for the SDK path (design.md 5b) — a
    // tab this call itself made is never "borrowed", regardless of whether
    // it also lives in the legacy Chrome group above. No-op for legacy
    // callers. The `typeof` guard (rather than a bare `currentToolMeta`
    // reference) is deliberate: this method's SHIPPED body is extracted and
    // compiled standalone by test/handlers.test.mjs (an existing suite this
    // task does not own) with a fixed dependency list that does not include
    // `currentToolMeta` — `typeof` is the one JS operator that never throws
    // on a name undeclared in that sandbox, so this stays a real, safe
    // no-op there instead of a ReferenceError, while behaving normally in
    // the real module (where `currentToolMeta` is an ordinary closure
    // variable declared above).
    if (typeof currentToolMeta !== "undefined" && currentToolMeta && currentToolMeta.runId) {
      sdkAgentCreatedTabs.add(tab.id);
    }
    // Read back the group the tab actually landed in, not the standalone one:
    // once it joins the anchor's group those differ, and listing the other
    // group's tabs describes a window the agent is not working in.
    const tabs = await chrome.tabs.query({ groupId: targetGroupId });
    const result = formatTabContext(tabs);
    result.content[0].text = `Created new tab. Tab ID: ${tab.id}\n\n` + result.content[0].text;
    return result;
  },

  async tabs_close_mcp(args) {
    // Captured ONCE, synchronously, at entry — this handler calls isInGroup()
    // (or, on the SDK path, the equivalent scope check) more than once across
    // several `await`s below, and module-level `currentToolMeta` belongs to
    // WHATEVER tool_request handleToolRequest() is currently dispatching. A
    // local snapshot keeps every iteration of this loop consistent with the
    // call THIS invocation was made for, immune to a differently-scoped
    // concurrent dispatch overwriting the module-level value in between.
    const requestMeta = currentToolMeta;
    // Accept either a single tabId (most common) or a tabIds array for
    // batch close. Validate every id is actually in the current MCP group
    // (legacy) or this run's scope (SDK path) so we never close the user's
    // other tabs.
    const requested = Array.isArray(args?.tabIds)
      ? args.tabIds
      : args?.tabId !== undefined
        ? [args.tabId]
        : [];
    if (requested.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: "No tabId provided. Pass `tabId: <number>` or `tabIds: [<number>, ...]`."
          }
        ]
      };
    }
    const inGroup = [];
    const skipped = [];
    // SDK path only (design.md 5b): a tab in this run's scope that the run
    // did not itself create is "borrowed" — the user's own tab. Cleanup must
    // never close (or, elsewhere, regroup) it. This is a second, independent
    // check from host/agent/tools/mapping.js's pre-dispatch mutation gate,
    // which normally prevents this call from ever reaching here at all for
    // such a tab — this one protects the irreversible operation even if that
    // gate is ever bypassed or absent.
    const blockedBorrowed = [];
    for (const id of requested) {
      const idNum = typeof id === "string" ? Number(id) : id;
      const authorized =
        requestMeta && requestMeta.runId ? isTabInWireScope(requestMeta.tabScope, idNum) : await isInGroup(idNum);
      if (!authorized) {
        skipped.push(idNum);
        continue;
      }
      if (requestMeta && requestMeta.runId && !sdkAgentCreatedTabs.has(idNum)) {
        blockedBorrowed.push(idNum);
        continue;
      }
      inGroup.push(idNum);
    }
    if (inGroup.length === 0) {
      const text = blockedBorrowed.length
        ? `Refused to close [${blockedBorrowed.join(", ")}]: borrowed tab(s) bound to this run's context are never closed by cleanup — the agent did not create them. Requested: [${requested.join(", ")}].`
        : requestMeta && requestMeta.runId
          ? `None of the requested tabs are in this run's scope. Requested: [${requested.join(", ")}]. Use tabs_context_mcp to see what is available.`
          : `None of the requested tabs are in the MCP group. Requested: [${requested.join(", ")}]. Use tabs_context_mcp to see what is in the group.`;
      return { content: [{ type: "text", text }] };
    }
    // chrome.tabs.remove force-closes — no beforeunload prompt. Detach any
    // CDP debuggers proactively so the onRemoved handler doesn't race.
    for (const id of inGroup) {
      if (attachedTabs.has(id)) {
        try { await chrome.debugger.detach({ tabId: id }); } catch {}
        attachedTabs.delete(id);
      }
    }
    await chrome.tabs.remove(inGroup);
    for (const id of inGroup) {
      tabGroupTabs.delete(id);
      sdkAgentCreatedTabs.delete(id);
    }

    // Closing the last tab in the group also closes the window; the group
    // becomes invalid. Reflect that in the response so the model doesn't
    // try to reuse stale tabIds.
    let tabs = [];
    try {
      if (tabGroupId !== null) {
        tabs = await chrome.tabs.query({ groupId: tabGroupId });
      }
    } catch {}
    if (tabs.length === 0) {
      tabGroupId = null;
      tabGroupTabs.clear();
      return {
        content: [
          {
            type: "text",
            text:
              `Closed ${inGroup.length} tab(s): [${inGroup.join(", ")}]` +
              (skipped.length ? `. Skipped (not in group): [${skipped.join(", ")}]` : "") +
              (blockedBorrowed.length ? `. Refused (borrowed, not agent-created): [${blockedBorrowed.join(", ")}]` : "") +
              `. The MCP tab group is now empty — the window has been closed. Use tabs_context_mcp({ createIfEmpty: true }) to start a new group.`
          }
        ]
      };
    }
    const result = formatTabContext(tabs);
    result.content[0].text =
      `Closed ${inGroup.length} tab(s): [${inGroup.join(", ")}]` +
      (skipped.length ? `. Skipped (not in group): [${skipped.join(", ")}]` : "") +
      (blockedBorrowed.length ? `. Refused (borrowed, not agent-created): [${blockedBorrowed.join(", ")}]` : "") +
      `.\n\n` +
      result.content[0].text;
    return result;
  },

  async navigate(args) {
    const { url, tabId } = args;
    if (!(await isInGroup(tabId))) return { content: [{ type: "text", text: `Tab ${tabId} is not in the MCP group.` }] };

    // Correlated navigation semantics (design.md decision 6 / tasks.md 1.3):
    // this is the ONE privileged, background-script-issued navigate call
    // site (gate-1.1 finding G6 — only a call issued here, never from page/
    // content-script context, gets a meaningful browser-level signal at
    // all). Minting the correlation BEFORE the actual chrome.tabs.* call
    // below is what lets documentBindings.onNavigationSignal() (the
    // chrome.tabs.onUpdated listener) recognize the resulting navigation as
    // authorized instead of an unexpected replacement. `typeof` guards
    // (rather than a bare `documentBindings` reference) are deliberate:
    // this method's SHIPPED body is extracted and compiled standalone by
    // test/navigate-url-scheme.test.mjs with a fixed dependency list that
    // does not include `documentBindings` — the same discipline
    // tabs_create_mcp already uses for `currentToolMeta` above.
    // `isDestinationAllowed` is intentionally the default allow-all: today's
    // navigate() has no domain/scope constraint of its own beyond the
    // isInGroup check just above — a real predicate is a workflow/approval
    // concern (design.md decision 8), out of this task's scope, and this
    // call never invents one.
    if (typeof documentBindings !== "undefined" && documentBindings) {
      documentBindings.beginAuthorizedNavigation(tabId, url === "back" || url === "forward" ? null : url);
    }

    if (url === "back") {
      await chrome.tabs.goBack(tabId);
    } else if (url === "forward") {
      await chrome.tabs.goForward(tabId);
    } else {
      let targetUrl = url;
      // "with or without protocol (defaults to https://)" — only default to
      // https:// when there is truly no scheme at all. Any input that
      // already carries a scheme (chrome-extension:, file:, about:, data:,
      // blob:, view-source:, http(s):, ...) passes through untouched; see
      // hasUrlScheme() for why this can't be a "://" substring check.
      if (!hasUrlScheme(targetUrl)) {
        targetUrl = "https://" + targetUrl;
      }
      try {
        new URL(targetUrl); // Validate URL before passing to Chrome
      } catch {
        return { content: [{ type: "text", text: `Invalid URL: "${url}". Could not parse as a valid URL.` }] };
      }
      await chrome.tabs.update(tabId, { url: targetUrl });
    }

    // Wait for page load — short timeout to avoid service worker idle kill
    // If the page takes longer, the caller can use screenshot/wait to check
    await new Promise((resolve) => {
      const listener = (updatedTabId, info) => {
        if (updatedTabId === tabId && info.status === "complete") {
          chrome.tabs.onUpdated.removeListener(listener);
          resolve();
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
      // 10s max — enough for most pages, avoids service worker timeout
      setTimeout(() => {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }, 10000);
    });

    // Complete the document-identity handshake now that the navigation has
    // settled (design.md decision 6 / tasks.md 1.2) — best-effort: a
    // restricted destination (chrome://, the extension gallery, ...)
    // legitimately never confirms, and that is the correct fail-closed
    // outcome, not a reason to fail this tool call. Same `typeof` guard
    // discipline as above.
    if (typeof ensureDocumentBinding !== "undefined") {
      await ensureDocumentBinding(tabId).catch(() => null);
    }

    const tab = await chrome.tabs.get(tabId);
    const tabs = await chrome.tabs.query({ groupId: tabGroupId });
    const loading = tab.status !== "complete" ? " (still loading)" : "";
    const text = `Navigated to ${tab.url}${loading}.\n## Pages\n` +
      tabs.map((t, i) => `${i + 1}: ${t.url}${t.id === tabId ? " [selected]" : ""}`).join("\n");

    return { content: [{ type: "text", text }] };
  },

  async computer(args) {
    const { action, tabId } = args;
    // Local snapshot, captured SYNCHRONOUSLY before this handler's first
    // `await` — the same discipline tabs_close_mcp already uses for
    // `currentToolMeta` (see that module-level variable's header comment):
    // handleToolRequest() assigns the module-level `currentAction`/
    // `currentActionExtras` with no `await` between that assignment and this
    // handler being called, so THIS statement is guaranteed to see exactly
    // the identity meant for this dispatch. computer() awaits many times
    // after this line (isInGroup, resolveRefToCoordinates, probeHit,
    // dispatchPlan/mouseClick...), during which a DIFFERENT concurrent
    // tool_request could reassign the module-level variables — so every
    // later reference in this handler uses these locals, never the
    // module-level names again.
    const actionCtx = currentAction;
    const actionExtras = currentActionExtras;
    if (!(await isInGroup(tabId))) return { content: [{ type: "text", text: `Tab ${tabId} is not in the MCP group.` }] };

    // Everything the MODEL supplies as a coordinate was read off the last
    // screenshot of this tab, so it is in that image's pixel space. Map it into
    // the CSS pixels the dispatch layer works in — identity when that image was
    // 1:1, which is the common case. Deliberately BEFORE the ref branch below
    // and never applied to it: a ref is resolved server-side by
    // getRefCoordinates(), which already reports CSS pixels and never went
    // through an image at all. See MODEL_IMAGE_MAX_EDGE.
    let coordinate = screenshotToCssCoordinate(tabId, args.coordinate);
    const startCoordinate = screenshotToCssCoordinate(tabId, args.start_coordinate);
    // Resolve ref to coordinates if provided. This scrolls the element into
    // view first: coordinates are viewport-relative, so an element that is off
    // screen has coordinates no dispatch can reach, and the click would land on
    // the document root instead of the thing that was named.
    let refCovering = null;
    let refProxiedFrom = null;
    if (args.ref && !coordinate) {
      const res = await resolveRefToCoordinates(tabId, args.ref);
      if (!res) return { content: [{ type: "text", text: `Could not resolve ref "${args.ref}" to coordinates. The page may have changed — re-run read_page or find for a fresh ref.` }] };
      if (!res.reachable) {
        // A ref that has gone stale and one that is merely out of reach are
        // different problems with different fixes, and saying which is which
        // saves the caller from retrying the wrong one.
        return {
          content: [
            {
              type: "text",
              text: res.detached
                ? `Ref "${args.ref}" no longer exists on the page — the element was removed since it was found. This happens to items inside a dropdown or popup once it closes: the list is rebuilt each time it opens. Re-open it if needed, run find again for a fresh ref, and click that.`
                : `Could not bring ref "${args.ref}" into view — it is still outside the viewport after scrolling, so a click there would land on the page background rather than the element. It may be inside a container that needs scrolling separately, or hidden.`
            }
          ]
        };
      }
      coordinate = [res.x, res.y];
      refCovering = res.covering;
      refProxiedFrom = res.proxiedFrom || null;
      if (res.scrolledFrom) {
        // The coordinates just changed underneath the caller. Recording it is
        // what stops a reader of the log concluding no scroll took place.
        dbg(
          "hit",
          `${args.ref} scrolled into view: (${res.scrolledFrom[0]},${res.scrolledFrom[1]}) -> (${res.x},${res.y})`,
          { tab: tabId }
        );
      }
    }

    const modifiers = parseModifierString(args.modifiers);

    // Probe BEFORE dispatching: the action itself can change what is under the
    // point, so an after-the-fact test would describe the consequence rather
    // than the target. For a drag the meaningful point is where the grab
    // happens, not where it is released.
    const HIT_PROBED = ["left_click", "right_click", "double_click", "triple_click", "hover", "scroll"];
    let hitNote = "";
    // Only the subset of `hitNote` that reports a problem. The outcome label
    // is derived from THIS, never from a note that merely says which element
    // received the click — see probeNotes_().
    let hitWarning = "";
    if (args.ref && coordinate) {
      // Resolving the ref already scrolled it into view and hit-tested the
      // result, so there is nothing left to check — only interception is worth
      // mentioning, and it is deliberately not auto-corrected: a person
      // clicking there would hit the same thing.
      if (refProxiedFrom) {
        // Not a warning: this is what a person's click does too. But the agent
        // named one element and another is being clicked, so it has to be told.
        hitNote = ` — NOTE: ${refProxiedFrom} sits outside the page (a visually hidden control), so this was aimed at the label that operates it, exactly as a click by hand would be.`;
        hitWarning = hitNote;
        dbg("hit", `${args.ref} unreachable; clicked its label instead @(${coordinate[0]},${coordinate[1]})`, { tab: tabId });
      } else if (refCovering) {
        hitNote = ` — NOTE: <${args.ref}> is covered at that point by ${refCovering}, which received this instead.`;
        hitWarning = hitNote;
        dbg("hit", `${args.ref} @(${coordinate[0]},${coordinate[1]}) COVERED BY ${refCovering}`, { tab: tabId });
      } else {
        dbg("hit", `${args.ref} @(${coordinate[0]},${coordinate[1]}) reachable`, { tab: tabId });
      }
    } else if (HIT_PROBED.includes(action) && coordinate) {
      const probe = await probeHit(tabId, coordinate[0], coordinate[1]);
      // A warning when there is something to warn about; otherwise still say
      // WHICH element received it, so aiming at the wrong one is visible now
      // rather than inferred from a screenshot two steps later.
      ({ note: hitNote, warning: hitWarning } = probeNotes_(probe));
      dbg("hit", `@(${coordinate[0]},${coordinate[1]}) ${formatHit(probe)}`, { tab: tabId, x: coordinate[0], y: coordinate[1] });
    } else if (action === "left_click_drag" && startCoordinate) {
      const probe = await probeHit(tabId, startCoordinate[0], startCoordinate[1]);
      hitNote = hitNote_(probe);
      hitWarning = hitNote;
      dbg("hit", `drag start @(${startCoordinate[0]},${startCoordinate[1]}) ${formatHit(probe)}`,
          { tab: tabId, x: startCoordinate[0], y: startCoordinate[1] });
    }

    // Action-event outcome (design.md 5c: "Successful dispatch is not proof
    // of the intended DOM effect") — re-labels the hit-probe warning this
    // handler already computed above; see deriveOutcomeStatus()'s comment.
    // Not new verification: `hitNote` is the exact signal the tool response
    // itself already surfaces to the caller.
    if (actionExtras) actionExtras.outcomeStatus = deriveOutcomeStatus(hitWarning);
    // Real-dispatch progress handler for the visible-cursor overlay
    // (design.md 5c). null for any non-pointer-capable action type, so a
    // case below that never calls it (screenshot, zoom, wait, type, key,
    // scroll_to) can never fabricate movement — see makePointerStepHandler().
    const onPointerStep = makePointerStepHandler(actionCtx);

    switch (action) {
      case "screenshot": {
        const { base64, imageId, width: shotW, height: shotH, scale: shotScale, blank: shotBlank } = await takeScreenshot(tabId);
        if (actionExtras) actionExtras.artifactId = imageId;
        // Report the IMAGE's own dimensions, not the CSS viewport's. They are
        // the same whenever the capture was 1:1, but when it was scaled down
        // (see MODEL_IMAGE_MAX_EDGE) the viewport figure would describe a
        // coordinate space this picture is not in — and this text is read by
        // the same caller that then sends back a coordinate.
        let dims = shotW && shotH ? `${shotW}x${shotH}` : "";
        if (!dims) {
          try {
            const vp = await cdp(tabId, "Runtime.evaluate", {
              expression: "window.innerWidth + 'x' + window.innerHeight",
            });
            if (vp?.result?.value) dims = vp.result.value;
          } catch {}
        }
        // Only worth saying when it is actually true; on a 1:1 capture it would
        // be noise on every single screenshot.
        // Never let a blank capture pass as a picture of an empty page.
        const blankNote = shotBlank
          ? " — WARNING: this capture came back essentially blank even after a repaint, so it probably shows the renderer mid-paint rather than the real page. Do not conclude the page is empty from it; wait a moment and capture again."
          : "";
        const scaleNote =
          shotScale && shotScale !== 1
            ? " — give click coordinates in this image's own pixels; they are mapped back to the page for you"
            : "";
        // save_to_disk: write the captured image to disk and report the path so
        // Claude Code can open it. Best-effort — never fails the screenshot.
        let saveNote = "";
        if (args.save_to_disk) {
          try {
            const path = await writeScreenshotToDisk(base64);
            saveNote = `\nSaved to disk: ${path}`;
          } catch (e) {
            saveNote = `\n(Unable to save to disk: ${e.message})`;
          }
        }
        return {
          content: [
            { type: "text", text: `Successfully captured screenshot (${dims}, jpeg) - ID: ${imageId}${scaleNote}${blankNote}${saveNote}` },
            { type: "image", data: base64, mimeType: "image/jpeg" },
          ],
        };
      }

      case "left_click": {
        if (!coordinate) return { content: [{ type: "text", text: "coordinate is required for left_click" }] };
        await mouseClick(tabId, coordinate[0], coordinate[1], { modifiers, onStep: onPointerStep });
        if (onPointerStep) onPointerStep.flush();
        const listNote = await openListNote_(tabId);
        return { content: [{ type: "text", text: `Clicked at (${coordinate[0]}, ${coordinate[1]})${hitNote}${listNote}` }] };
      }

      // Hidden diagnostic (not in the tool schema): serially times every CDP
      // input variant at the given coordinate so we can hunt for a dispatch
      // path Brave acks fast (keyboard-style) instead of the ~5s mouse path.
      case "diag_input": {
        const dx = coordinate ? coordinate[0] : 200;
        const dy = coordinate ? coordinate[1] : 200;
        const r = {};
        const t = async (label, fn) => {
          const t0 = Date.now();
          try { await fn(); r[label] = (Date.now() - t0) / 1000; }
          catch (e) { r[label] = (Date.now() - t0) / 1000; r[label + "_err"] = String(e.message || e).slice(0, 80); }
        };
        await t("mouse_moved", () => cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x: dx, y: dy }));
        await t("mouse_pressed", () => cdp(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", x: dx, y: dy, button: "left", clickCount: 1 }));
        await t("mouse_released", () => cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", x: dx, y: dy, button: "left", clickCount: 1 }));
        await t("touch_start", () => cdp(tabId, "Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: dx, y: dy }] }));
        await t("touch_end", () => cdp(tabId, "Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }));
        await t("synthesize_tap", () => cdp(tabId, "Input.synthesizeTapGesture", { x: dx, y: dy }));
        await t("synthesize_scroll", () => cdp(tabId, "Input.synthesizeScrollGesture", { x: dx, y: dy, yDistance: -100 }));
        await t("insert_text_noop", () => cdp(tabId, "Input.insertText", { text: "" }));
        return { content: [{ type: "text", text: JSON.stringify(r) }] };
      }

      case "right_click": {
        if (!coordinate) return { content: [{ type: "text", text: "coordinate is required for right_click" }] };
        await mouseClick(tabId, coordinate[0], coordinate[1], { button: "right", modifiers, onStep: onPointerStep });
        if (onPointerStep) onPointerStep.flush();
        return { content: [{ type: "text", text: `Right-clicked at (${coordinate[0]}, ${coordinate[1]})${hitNote}` }] };
      }

      case "double_click": {
        if (!coordinate) return { content: [{ type: "text", text: "coordinate is required for double_click" }] };
        await mouseClick(tabId, coordinate[0], coordinate[1], { clickCount: 2, modifiers, onStep: onPointerStep });
        if (onPointerStep) onPointerStep.flush();
        return { content: [{ type: "text", text: `Double-clicked at (${coordinate[0]}, ${coordinate[1]})${hitNote}` }] };
      }

      case "triple_click": {
        if (!coordinate) return { content: [{ type: "text", text: "coordinate is required for triple_click" }] };
        await mouseClick(tabId, coordinate[0], coordinate[1], { clickCount: 3, modifiers, onStep: onPointerStep });
        if (onPointerStep) onPointerStep.flush();
        return { content: [{ type: "text", text: `Triple-clicked at (${coordinate[0]}, ${coordinate[1]})${hitNote}` }] };
      }

      case "hover": {
        if (!coordinate) return { content: [{ type: "text", text: "coordinate is required for hover" }] };
        if (await humanizeOn(tabId)) {
          // Curved approach, then park STILL. No tremor while holding: a hover
          // exists to keep a tooltip/menu open, and jitter near an element edge
          // can cross the boundary, fire mouseleave and dismiss it.
          const s = human(effectiveConfig(tabId).humanize_speed, effectiveConfig(tabId).humanize_seed);
          const from = cursorByTab.get(tabId) || { x: Math.max(0, coordinate[0] - 200), y: Math.max(0, coordinate[1] - 150) };
          await dispatchPlan(tabId, humanize.planHover(s, from, { x: coordinate[0], y: coordinate[1] }), modifiers, onPointerStep);
          if (onPointerStep) onPointerStep.flush();
          return { content: [{ type: "text", text: `Hovered at (${coordinate[0]}, ${coordinate[1]})${hitNote}` }] };
        }
        await dispatchMouse(tabId, "mouseMoved", coordinate[0], coordinate[1], { modifiers });
        if (onPointerStep) onPointerStep({ k: "move", x: coordinate[0], y: coordinate[1] });
        cursorByTab.set(tabId, { x: coordinate[0], y: coordinate[1] });
        // Let the page apply the hover state; Brave additionally needs a settle
        // window, Chrome doesn't.
        if (await isBrave()) await sleep(200);
        if (onPointerStep) onPointerStep.flush();
        return { content: [{ type: "text", text: `Hovered at (${coordinate[0]}, ${coordinate[1]})${hitNote}` }] };
      }

      case "type": {
        if (!args.text) return { content: [{ type: "text", text: "text is required for type action" }] };
        await ensureAttached(tabId);
        if (await humanizeOn(tabId)) {
          // Same key events as the default path below, but with human-shaped
          // inter-key timing instead of a flat interval.
          await dispatchPlan(tabId, humanize.planType(human(effectiveConfig(tabId).humanize_speed, effectiveConfig(tabId).humanize_seed), args.text));
          return { content: [{ type: "text", text: `Typed "${args.text.substring(0, 50)}${args.text.length > 50 ? "..." : ""}"` }] };
        }
        // Default path: emit real keydown/keyup around each character.
        //
        // Measured against the official Claude in Chrome on an instrumented
        // page: its `type` delivers a keydown+keyup per character with correct
        // `code` values. Insertion-only (bare insertText) delivered ZERO key
        // events, so pages that gate on keydown — search-as-you-type, key
        // validators, shortcut handlers — saw nothing. That was a parity gap,
        // not just a realism one, so key events are the default here too.
        //
        // rawKeyDown is the NON-text-producing variant: the character comes
        // from insertText alone, exactly once, so this cannot double-insert or
        // drop text. Characters with no real key identity (emoji, CJK) fall
        // back to insertText on its own rather than a fabricated keystroke.
        for (const char of args.text) {
          const d = humanize.keyDescriptorFor(char);
          if (d) {
            await cdp(tabId, "Input.dispatchKeyEvent", {
              type: "rawKeyDown",
              key: char,
              code: d.code,
              windowsVirtualKeyCode: d.keyCode || 0,
              modifiers: d.shift ? 8 : 0
            });
          }
          await cdp(tabId, "Input.insertText", { text: char });
          if (d) {
            await cdp(tabId, "Input.dispatchKeyEvent", {
              type: "keyUp",
              key: char,
              code: d.code,
              windowsVirtualKeyCode: d.keyCode || 0,
              modifiers: d.shift ? 8 : 0
            });
          }
          await sleep(10);
        }
        return { content: [{ type: "text", text: `Typed "${args.text.substring(0, 50)}${args.text.length > 50 ? "..." : ""}"` }] };
      }

      case "key": {
        if (!args.text) return { content: [{ type: "text", text: "text is required for key action" }] };
        await ensureAttached(tabId);
        const repeat = Math.min(args.repeat || 1, 100);
        // Parse space-separated key combos
        const keys = args.text.split(" ").filter(Boolean);
        for (let r = 0; r < repeat; r++) {
          for (const keyStr of keys) {
            const { key, modifiers: keyMod } = parseKeyCombo(keyStr);
            const resolvedKey = key.length === 1 ? key : key;
            await cdp(tabId, "Input.dispatchKeyEvent", {
              type: "keyDown",
              key: resolvedKey,
              code: resolvedKey.length === 1 ? `Key${resolvedKey.toUpperCase()}` : resolvedKey,
              modifiers: keyMod,
              windowsVirtualKeyCode: resolvedKey.charCodeAt ? resolvedKey.charCodeAt(0) : 0,
            });
            await cdp(tabId, "Input.dispatchKeyEvent", {
              type: "keyUp",
              key: resolvedKey,
              code: resolvedKey.length === 1 ? `Key${resolvedKey.toUpperCase()}` : resolvedKey,
              modifiers: keyMod,
            });
            // Brave's debugger pipeline needs a settle window between key
            // events; Chrome acks instantly, so the sleep is pure latency there.
            if (await isBrave()) await sleep(30);
          }
        }
        return { content: [{ type: "text", text: `Pressed ${repeat} key${repeat > 1 ? "s" : ""}: ${args.text}` }] };
      }

      case "scroll": {
        if (!coordinate) return { content: [{ type: "text", text: "coordinate is required for scroll" }] };
        const dir = args.scroll_direction || "down";
        const amount = Math.min(args.scroll_amount || 3, 10);
        const deltaX = dir === "left" ? -amount * 100 : dir === "right" ? amount * 100 : 0;
        const deltaY = dir === "up" ? -amount * 100 : dir === "down" ? amount * 100 : 0;
        if (await humanizeOn(tabId)) {
          // Humanize the APPROACH, deliver the scroll with the same single
          // wheel event the non-humanized path uses.
          //
          // Two attempts at decomposing the scroll both broke the invariant
          // that humanization must not change outcomes, in opposite ways:
          //   - many wheel ticks spread over time: the page scrolled under the
          //     stationary cursor, a nested scrollable slid into place and ate
          //     the rest (page moved 89-109px instead of 400px). Capping the
          //     burst under 200ms did not help.
          //   - Input.synthesizeScrollGesture: fixed the targeting (the nested
          //     box stayed at 0) but its yDistance is literal pixels, while a
          //     wheel event's deltaY goes through the browser's own scaling —
          //     the same request scrolled 600px humanized vs 400px plain.
          //     Matching them would mean hardcoding a platform-specific factor.
          //
          // So the wheel event stays exactly as it is, and what gets humanized
          // is the cursor arriving at the scroll position and the beat before
          // and after. A real mouse wheel is a chunky discrete device anyway;
          // the smooth part of a scroll is the page's own animation, not the
          // input. Correctness first: an agent asking to scroll one screen must
          // land in the same place whether or not humanization is on.
          const s = human(effectiveConfig(tabId).humanize_speed, effectiveConfig(tabId).humanize_seed);
          const from = cursorByTab.get(tabId);
          if (from && (from.x !== coordinate[0] || from.y !== coordinate[1])) {
            await dispatchPlan(tabId, humanize.planHover(s, from, { x: coordinate[0], y: coordinate[1] }), modifiers, onPointerStep);
          }
          await sendMouseEvent(tabId, {
            type: "mouseWheel", x: coordinate[0], y: coordinate[1], deltaX, deltaY, modifiers
          }, { awaitAck: false });
          if (onPointerStep) onPointerStep({ k: "wheel", x: coordinate[0], y: coordinate[1] });
          await sleep(humanize.thinkDelay(s, 0.5));
        } else {
        await sendMouseEvent(tabId, {
          type: "mouseWheel",
          x: coordinate[0],
          y: coordinate[1],
          deltaX,
          deltaY,
          modifiers,
        }, { awaitAck: false });
        if (onPointerStep) onPointerStep({ k: "wheel", x: coordinate[0], y: coordinate[1] });
        }
        if (onPointerStep) onPointerStep.flush();
        // Let the compositor repaint before the confirmation screenshot; Chrome
        // repaints fast, Brave needs a longer settle window.
        await sleep((await isBrave()) ? 300 : 100);
        // The scroll already happened; the confirmation screenshot is best-effort.
        // On a heavy page still re-rendering after the scroll, the capture can
        // block, so bound it and degrade to a text-only result rather than
        // stalling the whole scroll (and the agent's retries) to the 60s cap.
        const scrollContent = [
          { type: "text", text: `Scrolled ${dir} by ${amount} ticks at (${coordinate[0]}, ${coordinate[1]})${hitNote}` },
        ];
        try {
          const { base64, blank } = await withTimeout(takeScreenshot(tabId), 6000, "scroll screenshot");
          if (blank) {
            scrollContent[0].text +=
              " — WARNING: the confirmation capture came back essentially blank even after a repaint, so it shows the renderer mid-paint, not the page. Do not conclude this part of the page is empty; capture again before deciding.";
          }
          scrollContent.push({ type: "image", data: base64, mimeType: "image/jpeg" });
        } catch (e) {
          scrollContent[0].text += ` (post-scroll screenshot unavailable: ${e.message}; take a screenshot to see the result)`;
          // The dispatch itself already succeeded (the wheel event went out
          // above) — what is unverified is only the confirmation capture, so
          // this is exactly the "successful dispatch is not proof of the
          // intended DOM effect" case design.md 5c calls out.
          if (actionExtras) {
            actionExtras.outcomeStatus = actionEvents.OUTCOME_STATUSES.UNKNOWN;
            actionExtras.outcomeDetail = "post-scroll confirmation screenshot unavailable";
          }
        }
        return { content: scrollContent };
      }

      case "scroll_to": {
        if (!coordinate && !args.ref) return { content: [{ type: "text", text: "coordinate or ref is required for scroll_to" }] };
        if (args.ref) {
          await sendContentMessage(tabId, {
            type: "scrollToRef",
            ref: args.ref,
          });
        }
        // Scroll target element into view via JS
        if (coordinate) {
          await cdp(tabId, "Runtime.evaluate", {
            expression: `window.scrollTo(${coordinate[0]}, ${coordinate[1]})`,
          });
        }
        // Let the page repaint the scroll; Chrome is fast, Brave slower.
        await sleep((await isBrave()) ? 300 : 100);
        return { content: [{ type: "text", text: `Scrolled to target` }] };
      }

      case "wait": {
        const duration = Math.min(args.duration || 1, 30);
        await sleep(duration * 1000);
        return { content: [{ type: "text", text: `Waited for ${duration} second${duration !== 1 ? "s" : ""}` }] };
      }

      case "left_click_drag": {
        if (!startCoordinate || !coordinate) {
          return { content: [{ type: "text", text: "start_coordinate and coordinate are required for left_click_drag" }] };
        }
        const [sx, sy] = startCoordinate;
        const [ex, ey] = coordinate;
        if (await humanizeOn(tabId)) {
          const s = human(effectiveConfig(tabId).humanize_speed, effectiveConfig(tabId).humanize_seed);
          const from = cursorByTab.get(tabId) || { x: sx, y: sy };
          await dispatchPlan(tabId, humanize.planDrag(s, from, { x: sx, y: sy }, { x: ex, y: ey }), modifiers, onPointerStep);
          if (onPointerStep) onPointerStep.flush();
          return { content: [{ type: "text", text: `Dragged from (${sx}, ${sy}) to (${ex}, ${ey})${hitNote}` }] };
        }
        await dispatchMouse(tabId, "mouseMoved", sx, sy, { modifiers });
        if (onPointerStep) onPointerStep({ k: "move", x: sx, y: sy });
        if (await isBrave()) await sleep(50);
        await dispatchMouse(tabId, "mousePressed", sx, sy, { button: "left", modifiers });
        if (onPointerStep) onPointerStep({ k: "down", x: sx, y: sy, button: "left" });
        if (await isBrave()) await sleep(50);
        // Move in steps
        const steps = 10;
        for (let i = 1; i <= steps; i++) {
          const mx = sx + ((ex - sx) * i) / steps;
          const my = sy + ((ey - sy) * i) / steps;
          await dispatchMouse(tabId, "mouseMoved", mx, my, { modifiers });
          if (onPointerStep) onPointerStep({ k: "move", x: mx, y: my });
          if (await isBrave()) await sleep(20);
        }
        await dispatchMouse(tabId, "mouseReleased", ex, ey, { button: "left", modifiers });
        if (onPointerStep) onPointerStep({ k: "up", x: ex, y: ey, button: "left" });
        if (onPointerStep) onPointerStep.flush();
        return { content: [{ type: "text", text: `Dragged from (${sx}, ${sy}) to (${ex}, ${ey})${hitNote}` }] };
      }

      case "zoom": {
        if (!args.region || args.region.length !== 4) {
          return { content: [{ type: "text", text: "region [x0, y0, x1, y1] is required for zoom" }] };
        }
        // The region arrives in the coordinate space of the last screenshot the
        // caller looked at, which is the image's own pixels — map it back to
        // CSS pixels the same way a click coordinate is, or the crop lands
        // somewhere other than what was pointed at.
        const zoomRegion = (() => {
          const scale = captureScaleByTab.get(tabId);
          if (!scale || scale === 1) return args.region;
          return args.region.map((v) => v / scale);
        })();
        const {
          base64: fullBase64,
          imageId: zoomImageId,
          width: zoomW,
          height: zoomH,
          scale: zoomScale
        } = await takeScreenshot(tabId, { region: zoomRegion });
        if (actionExtras) actionExtras.artifactId = zoomImageId;
        // save_to_disk: write the captured image to disk and report the path.
        // Best-effort — never fails the zoom.
        let zoomSaveNote = "";
        if (args.save_to_disk) {
          try {
            const path = await writeScreenshotToDisk(fullBase64);
            zoomSaveNote = `\nSaved to disk: ${path}`;
          } catch (e) {
            zoomSaveNote = `\n(Unable to save to disk: ${e.message})`;
          }
        }
        // Say plainly that this image is a crop, and that its pixels are not
        // the page's. A magnified region looks exactly like a normal
        // screenshot, so without this the caller would happily read a
        // coordinate off it and click somewhere unrelated.
        const zoomDims = zoomW && zoomH ? `${zoomW}x${zoomH}` : "";
        const zoomMag = zoomScale ? `${Math.round(zoomScale * 100) / 100}x` : "";
        return {
          content: [
            {
              type: "text",
              text:
                `Zoomed into region [${args.region.join(", ")}]` +
                (zoomDims ? ` — ${zoomDims} image at ${zoomMag} magnification` : "") +
                `. This image is a crop: coordinates in it are relative to the region, not the page, so do not click from it — take a full screenshot when you are ready to act.${zoomSaveNote}`
            },
            { type: "image", data: fullBase64, mimeType: "image/jpeg" },
          ],
        };
      }

      default:
        return { content: [{ type: "text", text: `Unknown computer action: ${action}` }] };
    }
  },

  async read_page(args) {
    const { tabId } = args;
    if (!(await isInGroup(tabId))) return { content: [{ type: "text", text: `Tab ${tabId} is not in the MCP group.` }] };
    const staleOrRestricted = await checkTabReadableForExtraction(tabId);
    if (staleOrRestricted) return staleOrRestricted;

    const resp = await sendContentMessage(tabId, {
      type: "generateAccessibilityTree",
      options: {
        filter: args.filter,
        depth: args.depth,
        max_chars: args.max_chars,
        ref_id: args.ref_id,
      },
    });

    let tree = resp?.result || "Error: Could not generate accessibility tree";
    // Append viewport dimensions so Claude knows the coordinate space
    try {
      await ensureAttached(tabId);
      const vp = await cdp(tabId, "Runtime.evaluate", {
        expression: "window.innerWidth + 'x' + window.innerHeight",
      });
      if (vp?.result?.value) tree += `\n\nViewport: ${vp.result.value}`;
    } catch {}
    return { content: [{ type: "text", text: tree }] };
  },

  async get_page_text(args) {
    const { tabId } = args;
    if (!(await isInGroup(tabId))) return { content: [{ type: "text", text: `Tab ${tabId} is not in the MCP group.` }] };
    const staleOrRestricted = await checkTabReadableForExtraction(tabId);
    if (staleOrRestricted) return staleOrRestricted;

    const resp = await sendContentMessage(tabId, { type: "getPageText" });
    if (!resp?.result) return { content: [{ type: "text", text: "Error: Could not extract page text" }] };

    try {
      const data = JSON.parse(resp.result);
      // design.md 5b: "Extraction returns source URL/title, capture
      // timestamp, and completeness/truncation status." capturedAt/truncated
      // are new, additive fields content.js's getPageText() now reports;
      // older/cached content-script instances that predate them simply omit
      // the lines rather than printing "undefined".
      //
      // Task 10.1/10.2 (design section 9a): the `Complete:` line is now
      // derived from TWO independent signals — `truncated` (length ceiling)
      // and `coverageRatio`/`usedBodyFallback` (content coverage). The
      // header is NEVER `Complete: yes` when the body fallback was used
      // (no candidate content container was found at all), and never when
      // coverageRatio is implausibly low against substantial page text
      // elsewhere. In those cases it reports a distinct partial/low-
      // confidence status naming the container and suggesting read_page/
      // find for listing-style pages — exactly the existing "report
      // missing portions instead of claiming a complete reading" rule,
      // now with the detection mechanism that rule was missing.
      const capturedLine = data.capturedAt ? `Captured: ${data.capturedAt}` : null;
      let completeLine;
      if (typeof data.truncated === "boolean" && data.truncated) {
        completeLine = "Complete: no (truncated)";
      } else if (data.usedBodyFallback === true) {
        // The body fallback means no selector matched at all — there was
        // no candidate content container. Never report Complete: yes.
        completeLine = `Complete: partial (container <${data.sourceTag}> was the document.body last resort; try read_page or find for listing-style pages)`;
      } else if (typeof data.coverageRatio === "number" && data.coverageRatio < 0.5) {
        // The matched container held less than half the page's cleaned text
        // — the page likely has substantial content outside it (a listing/
        // index page is the canonical case). Report partial.
        const pct = Math.round(data.coverageRatio * 100);
        completeLine = `Complete: partial (container <${data.sourceTag}> captured ${pct}% of the page's text; try read_page or find for listing-style pages)`;
      } else if (typeof data.truncated === "boolean") {
        completeLine = "Complete: yes";
      } else {
        // Older content-script builds that predate 10.1 omit both
        // coverageRatio and usedBodyFallback — fall back to the original
        // truncated-only signal so a stale script instance never breaks.
        completeLine = null;
      }
      const header = [`Title: ${data.title}`, `URL: ${data.url}`, `Source: <${data.sourceTag}>`, capturedLine, completeLine]
        .filter((l) => l !== null)
        .join("\n");
      return {
        content: [
          {
            type: "text",
            text: `${header}\n\n${data.text}`,
          },
        ],
      };
    } catch {
      return { content: [{ type: "text", text: resp.result }] };
    }
  },

  async find(args) {
    const { query, tabId } = args;
    if (!(await isInGroup(tabId))) return { content: [{ type: "text", text: `Tab ${tabId} is not in the MCP group.` }] };

    const resp = await sendContentMessage(tabId, { type: "findElements", query });
    // findElements reports how many elements matched in TOTAL, not just the
    // ranked page it returns, so the caller can be told to narrow the query
    // instead of silently receiving the top 20 as though they were all of them
    // (which is what this tool's own description already promises).
    const payload = resp?.result;
    const results = (Array.isArray(payload) ? payload : payload?.results) || [];
    const total = Array.isArray(payload) ? payload.length : (payload?.total ?? results.length);

    if (results.length === 0) {
      return { content: [{ type: "text", text: `No elements found matching "${query}"` }] };
    }

    let text =
      total > results.length
        ? `Found ${total} element(s) matching "${query}"; showing the ${results.length} best matches. Narrow the query if none of these is the one you want:\n\n`
        : `Found ${results.length} element(s) matching "${query}":\n\n`;
    let anyOff = false;
    for (const r of results) {
      text += `[${r.ref}] ${r.role} "${r.name}" at (${r.coordinates[0]}, ${r.coordinates[1]})`;
      if (r.offViewport) {
        anyOff = true;
        text += ` [OFF-VIEWPORT]`;
      }
      text += `\n`;
    }
    if (anyOff) {
      // Handing out coordinates that cannot be clicked is how a silent miss
      // starts: the click dispatches fine and lands on the document root.
      text +=
        `\nNote: entries marked [OFF-VIEWPORT] are not at those coordinates right now, so ` +
        `clicking there would land on the page background. Pass the ref to computer instead ` +
        `of the coordinate: a ref is resolved to the element's live position and scrolled ` +
        `into view first, and for a control parked outside the page — as visually hidden ` +
        `radios and checkboxes are — it is redirected to the label that operates it, exactly ` +
        `as a click by hand would be.\n`;
    }

    return { content: [{ type: "text", text }] };
  },

  async form_input(args) {
    const { ref, value, tabId } = args;
    if (!(await isInGroup(tabId))) return { content: [{ type: "text", text: `Tab ${tabId} is not in the MCP group.` }] };

    const resp = await sendContentMessage(tabId, { type: "setFormValue", ref, value });
    const result = resp?.result;

    if (result?.error) return { content: [{ type: "text", text: `Error: ${result.error}` }] };
    return { content: [{ type: "text", text: `Set ${ref} to "${value}". Result: ${JSON.stringify(result)}` }] };
  },

  async javascript_tool(args) {
    const { text, tabId } = args;
    const tIn = Date.now();
    if (!(await isInGroup(tabId))) return { content: [{ type: "text", text: `Tab ${tabId} is not in the MCP group.` }] };

    await ensureAttached(tabId);
    try {
      const tEval = Date.now();
      const result = await cdp(tabId, "Runtime.evaluate", {
        expression: text,
        returnByValue: true,
        awaitPromise: true,
      });
      // preMs = group check + debugger attach; evalMs = the evaluate alone.
      // The split is the whole point: it separates "the renderer serviced the
      // task late" from every other stage of the pipe.
      recordTiming({ t: tIn, tool: "javascript_tool", tab: tabId,
                     preMs: tEval - tIn, evalMs: Date.now() - tEval,
                     bytes: (text || "").length });

      if (result.exceptionDetails) {
        return {
          content: [{ type: "text", text: `Error: ${result.exceptionDetails.text || JSON.stringify(result.exceptionDetails)}` }],
        };
      }

      const val = result.result;
      if (val.type === "undefined") return { content: [{ type: "text", text: "undefined" }] };
      return {
        content: [{ type: "text", text: val.value !== undefined ? JSON.stringify(val.value) : val.description || String(val) }],
      };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }] };
    }
  },

  // Read the per-call timing ring (live + storage.session backlog from before
  // any worker restart) plus a live snapshot of every group tab's scheduling-
  // relevant state. The snapshot is what turns a timing anomaly into a
  // diagnosis: it says which tabs were active/audible/discarded/frozen and
  // what state their windows were in while the quantum was being paid.
  async debug_timings(args) {
    const limit = Math.min(Number(args?.limit) || 200, 600);
    let stored = [];
    let storedBootAt = null;
    try {
      const got = await chrome.storage.session.get(["mcp_call_timings", "mcp_boot_at"]);
      stored = got.mcp_call_timings || [];
      storedBootAt = got.mcp_boot_at ?? null;
    } catch {}
    const seen = new Set(callTimings.map((e) => `${e.t}|${e.tool}`));
    const merged = stored.filter((e) => !seen.has(`${e.t}|${e.tool}`)).concat(callTimings);
    const tabs = [];
    const winIds = new Set();
    for (const id of tabGroupTabs) {
      try {
        const t = await chrome.tabs.get(id);
        winIds.add(t.windowId);
        tabs.push({ id, windowId: t.windowId, active: t.active, audible: !!t.audible,
                    discarded: !!t.discarded, frozen: !!t.frozen,
                    origin: (t.url || "").split("/").slice(0, 3).join("/") });
      } catch {}
    }
    const windows = [];
    for (const wid of winIds) {
      try {
        const w = await chrome.windows.get(wid);
        windows.push({ id: wid, state: w.state, focused: w.focused });
      } catch {}
    }
    if (args?.clear) {
      callTimings.length = 0;
      timingsDirty = 0;
      try { chrome.storage.session.remove(["mcp_call_timings", "mcp_boot_at"]); } catch {}
    }
    return { content: [{ type: "text", text: JSON.stringify({
      bootAt, storedBootAt, now: Date.now(), count: merged.length,
      tabs, windows, timings: merged.slice(-limit),
    }) }] };
  },

  async read_console_messages(args) {
    const { tabId, pattern, limit = 100, onlyErrors, clear } = args;
    if (!(await isInGroup(tabId))) return { content: [{ type: "text", text: `Tab ${tabId} is not in the MCP group.` }] };

    // Ensure console domain is enabled
    await ensureAttached(tabId);
    await ensureDomain(tabId, "Console");
    await ensureDomain(tabId, "Runtime");

    let msgs = consoleMessages.get(tabId) || [];

    if (onlyErrors) {
      msgs = msgs.filter((m) => ["error", "exception"].includes(m.level));
    }

    if (pattern) {
      try {
        const re = new RegExp(pattern, "i");
        msgs = msgs.filter((m) => re.test(m.text) || re.test(m.level));
      } catch {
        // Invalid regex, use as substring
        msgs = msgs.filter((m) => m.text.includes(pattern));
      }
    }

    msgs = msgs.slice(-limit);

    if (clear) {
      consoleMessages.set(tabId, []);
    }

    if (msgs.length === 0) {
      return { content: [{ type: "text", text: "No console messages matching the pattern." }] };
    }

    const text = msgs
      .map((m) => `[${m.level}] ${m.text}${m.url ? ` (${m.url})` : ""}`)
      .join("\n");

    return { content: [{ type: "text", text: `Console messages (${msgs.length}):\n${text}` }] };
  },

  async read_network_requests(args) {
    const { tabId, urlPattern, limit = 100, clear } = args;
    if (!(await isInGroup(tabId))) return { content: [{ type: "text", text: `Tab ${tabId} is not in the MCP group.` }] };

    // Ensure network domain is enabled
    await ensureAttached(tabId);
    await ensureDomain(tabId, "Network");

    let reqs = networkRequests.get(tabId) || [];

    if (urlPattern) {
      reqs = reqs.filter((r) => r.url.includes(urlPattern));
    }

    reqs = reqs.slice(-limit);

    if (clear) {
      networkRequests.set(tabId, []);
      networkByRequestId.set(tabId, new Map());
    }

    if (reqs.length === 0) {
      return { content: [{ type: "text", text: "No network requests matching the pattern." }] };
    }

    const text = reqs
      .map((r) => `${r.method} ${r.url} ${r.status ? `→ ${r.status}` : "(pending)"}${r.mimeType ? ` [${r.mimeType}]` : ""}`)
      .join("\n");

    return { content: [{ type: "text", text: `Network requests (${reqs.length}):\n${text}` }] };
  },

  async resize_window(args) {
    const { width, height, tabId } = args;
    if (!(await isInGroup(tabId))) return { content: [{ type: "text", text: `Tab ${tabId} is not in the MCP group.` }] };

    await ensureAttached(tabId);
    const tab = await chrome.tabs.get(tabId);

    // A maximized or full-screen window ignores width/height, so it has to be
    // returned to "normal" FIRST, and the state change has to have landed before
    // the resize is issued: chrome.windows.update resolves when the request is
    // accepted, not when the window manager has applied it. Exiting macOS
    // full-screen is an animation, which is why this polls rather than retrying
    // once.
    //
    // This guard is precautionary — it has never been observed firing. It was
    // written to explain four resizes that left the viewport untouched, and that
    // explanation was wrong: the cause was that Chrome does not re-layout a tab
    // which is not the selected tab in its window (see the NOTE further down),
    // and the window measured "normal" every time. So the race described above
    // is plausible rather than demonstrated. It stays because the behaviour it
    // guards against is real — a maximized window genuinely does ignore a resize
    // — and because the whole block is a no-op on a window already normal.
    let win = await chrome.windows.get(tab.windowId);
    if (win.state !== "normal") {
      try {
        await chrome.windows.update(tab.windowId, { state: "normal" });
      } catch {}
      for (let i = 0; i < 20; i++) {
        await sleep(100);
        try {
          win = await chrome.windows.get(tab.windowId);
        } catch {
          break;
        }
        if (win.state === "normal") break;
      }
    }
    if (win.state !== "normal") {
      return {
        content: [
          {
            type: "text",
            text: `Could not resize: the window is ${win.state} and would not return to a normal state, so the window manager will ignore any size. Exit full screen and try again.`
          }
        ]
      };
    }
    // Record the window's own bounds either side of the call. The viewport
    // alone cannot distinguish "the window never moved" from "the window moved
    // but the page did not follow", and those have completely different causes.
    const before = { state: win.state, w: win.width, h: win.height, left: win.left, top: win.top };
    // The viewport before the call, so a window that moves while the page stays
    // put is detectable. That combination is not a window-manager behaviour at
    // all — it means something on our side has pinned the viewport — and it is
    // exactly what emulation used to do here.
    let vpBefore = null;
    try {
      const v0 = await cdp(tabId, "Runtime.evaluate", {
        expression: "JSON.stringify([innerWidth, innerHeight])",
        returnByValue: true
      });
      vpBefore = JSON.parse(v0.result.value);
    } catch {}
    let updateErr = null;
    try {
      await chrome.windows.update(tab.windowId, { width, height, state: "normal" });
    } catch (e) {
      updateErr = String(e && e.message).slice(0, 160);
    }
    // Give the window manager a moment to apply the size before measuring it,
    // for the same reason as above.
    await sleep(150);
    let after = null;
    try {
      const w2 = await chrome.windows.get(tab.windowId);
      after = { state: w2.state, w: w2.width, h: w2.height, left: w2.left, top: w2.top };
    } catch {}

    // A window resize and the page's re-layout are not the same event: the
    // window can report its new bounds while the renderer has not yet reflowed.
    // A fixed sleep here read the pre-resize viewport often enough to make
    // correct resizes report themselves as failures. Wait for the viewport to
    // actually move instead, then let it settle, and cap the wait so a resize
    // that genuinely changes nothing still returns promptly.
    const readViewport = async () => {
      try {
        const v = await cdp(tabId, "Runtime.evaluate", {
          expression: "JSON.stringify([innerWidth, innerHeight])",
          returnByValue: true
        });
        return JSON.parse(v.result.value);
      } catch {
        return null;
      }
    };
    const changedFromBefore = (v) =>
      v && vpBefore && (v[0] !== vpBefore[0] || v[1] !== vpBefore[1]);
    const settleDeadline = 900;
    let waited = 0;
    let last = await readViewport();
    while (waited < settleDeadline) {
      if (changedFromBefore(last)) {
        // Moved. One more read so a mid-reflow value is not what we report.
        await sleep(60);
        waited += 60;
        const settled = await readViewport();
        if (settled) last = settled;
        break;
      }
      await sleep(60);
      waited += 60;
      const next = await readViewport();
      if (next) last = next;
    }
    const settledViewport = last;
    dbg(
      "tool",
      `resize_window bounds ${before.w}x${before.h}(${before.state}) -> ${after ? `${after.w}x${after.h}(${after.state})` : "unknown"} requested ${width}x${height}${updateErr ? ` ERR ${updateErr}` : ""}`,
      { tab: tabId }
    );
    // Report what actually happened rather than echoing the request, and judge
    // the window against the WINDOW bounds — not the viewport, which is legitimately
    // ~100px shorter than the window it lives in because the browser's own chrome
    // takes that space. Comparing the two directly made every successful resize
    // look like a failure.
    const actual = settledViewport;

    const windowTook = after && Math.abs(after.w - width) <= 8 && Math.abs(after.h - height) <= 8;
    const windowMoved = after && (after.w !== before.w || after.h !== before.h);
    const pageFollowed =
      !vpBefore || !actual || actual[0] !== vpBefore[0] || actual[1] !== vpBefore[1];

    let note = "";
    if (!windowTook) {
      // The window itself did not reach the requested size: a window-manager call.
      note =
        ` — NOTE: requested ${width}x${height} but the window went ${before.w}x${before.h} -> ` +
        `${after ? `${after.w}x${after.h}` : "unknown"} (state ${after ? after.state : "?"}), so the ` +
        `window manager ${windowMoved ? "clamped" : "ignored"} the request. Full-screen, tiled, and ` +
        `snapped windows refuse resizes; on macOS, Stage Manager and split view do too, while still ` +
        `reporting state "normal".${updateErr ? ` The update call also errored: ${updateErr}` : ""}`;
    } else if (windowMoved && !pageFollowed) {
      // The window took the size but the page did not re-layout. Not the window
      // manager's doing — something is holding the viewport fixed on our side.
      // Gated on windowMoved so that asking for the size the window already has
      // (a legitimate no-op, where the viewport correctly does not change) is
      // not reported as a fault.
      note =
        ` — NOTE: the window resized to ${after.w}x${after.h} as requested, but the page's viewport ` +
        `stayed ${actual[0]}x${actual[1]} after waiting ${settleDeadline}ms for it to reflow. Chrome ` +
        `does not re-layout a tab that is not the SELECTED tab in its window, and this tab is not ` +
        `selected, so the page keeps the size it had when it was last displayed. Call set_tab_focus ` +
        `on this tab first if the new size actually needs to reach the page. Note that the page ` +
        `cannot tell you this itself: focus emulation makes it report visibilityState "visible" and ` +
        `hasFocus() true either way. Until then, anything measured at this "new size" is really ` +
        `still the old one.`;
    }
    return {
      content: [
        {
          type: "text",
          text: `Resized window to ${width}x${height}${after ? ` (window is ${after.w}x${after.h})` : ""}; ` +
            `viewport is now ${actual ? `${actual[0]}x${actual[1]}` : "unknown"}.${note}`
        }
      ]
    };
  },

  async upload_image(args) {
    const { imageId, tabId, ref, filename = "image.png" } = args;
    if (!(await isInGroup(tabId))) return { content: [{ type: "text", text: `Tab ${tabId} is not in the MCP group.` }] };
    if (!ref) {
      return { content: [{ type: "text", text: "upload_image requires 'ref' (element reference from read_page/find) identifying the target <input type=file>." }] };
    }

    const base64 = screenshotStore.get(imageId);
    if (!base64) {
      return { content: [{ type: "text", text: `Image ${imageId} not found. Take a screenshot first.` }] };
    }

    await ensureAttached(tabId);
    await ensureDomain(tabId, "DOM");

    // 1) Resolve the ref through the content-script channel (isolated world,
    //    where resolveRef lives), stamping a DOM attribute CDP can find. A
    //    main-world Runtime.evaluate can't see the isolated-world globals.
    const mark = await sendContentMessage(tabId, { type: "markElementForUpload", ref });
    if (!mark || !mark.ok) {
      return { content: [{ type: "text", text: `No element found for ref=${ref}. Re-run read_page/find to get a fresh ref.` }] };
    }
    if (!mark.isFileInput) {
      await sendContentMessage(tabId, { type: "unmarkElementForUpload" }).catch(() => {});
      return { content: [{ type: "text", text: `Target ref=${ref} is a <${mark.tag}>, not a file input.` }] };
    }

    // 2) Stage the screenshot bytes as a real temp file via the native host.
    //    The screenshot lives in-memory (base64), so setFileInputFiles needs a
    //    path on disk to attach.
    let tempPath;
    try {
      tempPath = await nativeRequest({ type: "write_temp_file", dataUrl: base64, filename });
    } catch (e) {
      await sendContentMessage(tabId, { type: "unmarkElementForUpload" }).catch(() => {});
      return { content: [{ type: "text", text: `Failed to stage temp file for ${imageId}: ${String(e && e.message)}` }] };
    }
    if (!tempPath) {
      await sendContentMessage(tabId, { type: "unmarkElementForUpload" }).catch(() => {});
      return { content: [{ type: "text", text: `Failed to stage temp file for ${imageId}.` }] };
    }

    // 3) Find the marked file input via CDP, then attach the staged file.
    try {
      const doc = await cdp(tabId, "DOM.getDocument", {});
      const q = await cdp(tabId, "DOM.querySelector", {
        nodeId: doc.root.nodeId,
        selector: "[data-ocic-upload-target]",
      });
      if (!q || !q.nodeId) {
        return { content: [{ type: "text", text: `Could not resolve the file input node for ref=${ref}.` }] };
      }
      await cdp(tabId, "DOM.setFileInputFiles", { nodeId: q.nodeId, files: [tempPath] });
    } finally {
      await sendContentMessage(tabId, { type: "unmarkElementForUpload" }).catch(() => {});
    }

    return { content: [{ type: "text", text: `Uploaded ${filename} (${imageId}) to the file input. Temp file: ${tempPath}` }] };
  },

  // Re-run a failed transcription for a saved recording. The offscreen doc
  // re-assembles the durable segments from IndexedDB and re-maps them onto the
  // shared clock; we then persist the patched trace.json on disk.
  async retranscribe_recording(args) {
    const { recording_id } = args;
    if (!recording_id)
      return { content: [{ type: "text", text: "recording_id is required." }] };

    const apiKey = await getApiKey();
    // The offscreen document owns the durable audio buffer; make sure it's alive
    // before asking it to retranscribe, or the message is dropped (res undefined).
    await ensureOffscreen();
    const res = await chrome.runtime.sendMessage({
      __ocic_offscreen: true,
      cmd: "retranscribe",
      recording_id,
      apiKey,
    });
    if (!res || !res.ok) {
      return { content: [{ type: "text", text: res?.error || "retranscription failed." }] };
    }

    // Persist the patched trace via the SAME disk-write path used at stop
    // (saveBundleToDisk -> save_recording -> native host), rather than a
    // bespoke retry-only write path. Reuse keeps the retry a thin re-run.
    const path = await saveBundleToDisk({
      recording_id,
      schema: res.trace?.schema || "v0",
      trace: res.trace,
    }).catch(() => null);
    const synopsis =
      `Recording ${recording_id} retranscribed: ${res.transcript_status}. ` +
      `${(res.cognitive || []).length} utterances. ` +
      (path ? `trace.json updated on disk (${path}).` : "WARNING: trace.json could not be written to disk.");
    return { content: [{ type: "text", text: synopsis }] };
  },

  async file_upload(args) {
    const { tabId, paths, ref } = args;
    if (!(await isInGroup(tabId))) return { content: [{ type: "text", text: `Tab ${tabId} is not in the MCP group.` }] };
    if (!Array.isArray(paths) || paths.length === 0 || !paths.every((p) => typeof p === "string" && p)) {
      return { content: [{ type: "text", text: "file_upload requires 'paths' — a non-empty array of absolute file paths that already exist on this machine." }] };
    }
    if (!ref || typeof ref !== "string") {
      return { content: [{ type: "text", text: "file_upload requires 'ref' — the element reference of an <input type=file> from read_page or find." }] };
    }

    await ensureAttached(tabId);
    await ensureDomain(tabId, "DOM");

    // Resolve the ref through the content-script channel (isolated world, where
    // resolveRef/__unblockedChrome live), which stamps a DOM attribute on the
    // element. CDP Runtime.evaluate runs in the page's MAIN world and can't see
    // the isolated-world globals, so we locate the element via that shared-DOM
    // attribute instead. Works for hidden file inputs too.
    const mark = await sendContentMessage(tabId, { type: "markElementForUpload", ref });
    if (!mark || !mark.ok) {
      return { content: [{ type: "text", text: `No element found for ref=${ref}. Re-run read_page/find to get a fresh ref.` }] };
    }
    if (!mark.isFileInput) {
      return { content: [{ type: "text", text: `Target ref=${ref} is a <${mark.tag}>, not a file input. Point at the <input type=file> element (read_page/find can locate hidden ones).` }] };
    }

    // The files are already on disk on the same machine as the browser, so pass
    // the real paths straight to CDP — no temp staging needed. Find the marked
    // node via CDP, then DOM.setFileInputFiles.
    try {
      const doc = await cdp(tabId, "DOM.getDocument", {});
      const q = await cdp(tabId, "DOM.querySelector", {
        nodeId: doc.root.nodeId,
        selector: "[data-ocic-upload-target]",
      });
      if (!q || !q.nodeId) {
        return { content: [{ type: "text", text: `Could not resolve the file input node for ref=${ref}.` }] };
      }
      await cdp(tabId, "DOM.setFileInputFiles", { nodeId: q.nodeId, files: paths });
    } finally {
      await sendContentMessage(tabId, { type: "unmarkElementForUpload" }).catch(() => {});
    }

    const label = paths.length === 1 ? paths[0] : `${paths.length} files`;
    return { content: [{ type: "text", text: `Attached ${label} to the file input (ref=${ref}).` }] };
  },

  async gif_creator(args) {
    return { content: [{ type: "text", text: "GIF recording is not yet implemented in this extension." }] };
  },

  async shortcuts_list(args) {
    return { content: [{ type: "text", text: "No shortcuts available. Shortcuts are not supported in this extension." }] };
  },

  async shortcuts_execute(args) {
    return { content: [{ type: "text", text: "Shortcuts are not supported in this extension." }] };
  },

  async switch_browser(args) {
    const current = await detectBrowser();
    // Release AFTER this reply is delivered — it goes out over the very native
    // port we are about to drop. Suspending reconnect lets a target browser
    // whose extension is enabled bind the shared runtime and become primary;
    // if none takes over, this browser reconnects when the window elapses.
    setTimeout(() => {
      suspendReconnectUntil = Date.now() + SWITCH_RELEASE_MS;
      if (nativePort) {
        try { nativePort.disconnect(); } catch (e) {}
        nativePort = null;
        stopHeartbeat();
      }
    }, 300);
    return {
      content: [{
        type: "text",
        text:
          `Releasing the connection from ${current}. Enable this extension in the ` +
          `target browser (no restart needed) — for the next ~${SWITCH_RELEASE_MS / 1000}s it can take over ` +
          `the shared runtime automatically. Only one browser drives automation at a ` +
          `time. If nothing takes over, ${current} reconnects when the window elapses. ` +
          `Re-run tabs_context_mcp after a few seconds to confirm the active browser.`,
      }],
    };
  },

  async update_plan(args) {
    const { domains, approach } = args;
    let text = `Plan:\n\nDomains: ${domains.join(", ")}\n\nApproach:\n`;
    for (const step of approach) {
      text += `- ${step}\n`;
    }
    text += "\nPlan auto-approved (no permission restrictions in this extension).";
    return { content: [{ type: "text", text }] };
  },

  async debug(args) {
    const limit = Math.min(Math.max(Number(args?.limit) || 100, 1), DEBUG_MAX);
    const kind = args?.kind;
    const filter = args?.filter;
    const tabId = args?.tabId;
    const sinceMs = Number(args?.since_ms) || 0;
    const now = Date.now();

    let re = null;
    let reErr = "";
    if (filter) {
      try {
        re = new RegExp(filter, "i");
      } catch (e) {
        // Fall back to substring rather than failing the call: a debug tool
        // that errors on its own input is useless exactly when it is needed.
        reErr = ` (filter "${filter}" is not valid regex — matched as plain text)`;
      }
    }

    let rows = debugLog;
    const total = rows.length;
    if (sinceMs) rows = rows.filter((e) => now - e.t <= sinceMs);
    if (kind) rows = rows.filter((e) => e.kind === kind);
    if (tabId !== undefined && tabId !== null) rows = rows.filter((e) => e.tab === tabId);
    if (filter) {
      rows = rows.filter((e) => {
        const hay = `${e.kind} ${e.detail} ${e.err || ""}`;
        return re ? re.test(hay) : hay.toLowerCase().includes(String(filter).toLowerCase());
      });
    }
    const matched = rows.length;
    rows = rows.slice(-limit);

    // Everything the reader needs to know about what is NOT here. Silence in a
    // debug stream must never be mistaken for silence in the system.
    const ageS = Math.round((now - debugBootedAt) / 1000);
    const head = [
      `OCIC debug — ${rows.length} shown of ${matched} matching, ${total} in buffer${reErr}`,
      `Buffer keeps the most recent ${DEBUG_MAX} events${debugDropped ? `; ${debugDropped} older event(s) have been DROPPED` : ""}.`,
      `Recording started ${ageS}s ago (service worker start). NOTHING before that is in here — MV3 evicts the worker, which clears the buffer, so an empty or short log may mean the worker restarted rather than that nothing happened.`
    ];
    if (!rows.length) {
      head.push("", "No events matched. If you expected some, check the window above before concluding the action did not occur.");
      return { content: [{ type: "text", text: head.join("\n") }] };
    }

    const t0 = rows[0].t;
    const lines = rows.map((e) => {
      const rel = `+${String(e.t - t0).padStart(6)}ms`;
      const ms = e.ms !== undefined ? ` (${e.ms}ms)` : "";
      const tab = e.tab !== undefined ? ` tab=${e.tab}` : "";
      const err = e.err ? `  ERR: ${e.err}` : "";
      return `${rel}  ${e.kind.padEnd(5)} ${e.detail}${ms}${tab}${err}`;
    });

    // Timing roll-up: the question after "what happened" is nearly always
    // "what was slow", and it is cheap to answer here.
    const byKind = {};
    for (const e of rows) {
      if (typeof e.ms !== "number") continue;
      const k = e.detail.split(" ")[0];
      (byKind[k] = byKind[k] || []).push(e.ms);
    }
    const slow = Object.entries(byKind)
      .map(([k, v]) => ({ k, n: v.length, total: v.reduce((a, b) => a + b, 0), max: Math.max(...v) }))
      .sort((a, b) => b.total - a.total)
      .slice(0, 6)
      .map((r) => `  ${r.k} x${r.n}: ${r.total}ms total, ${r.max}ms slowest`);

    const span = rows[rows.length - 1].t - t0;
    const out = [
      ...head,
      `Window shown spans ${span}ms.`,
      "",
      ...lines
    ];
    if (slow.length) out.push("", "Slowest by total time:", ...slow);
    if (args?.clear) {
      debugLog.length = 0;
      debugDropped = 0;
      out.push("", "Buffer cleared.");
    }
    return { content: [{ type: "text", text: out.join("\n") }] };
  },

  async get_config(args) {
    await configHydrated;
    const tabId = args?.tabId;
    const payload = {
      default: configState.default,
      perTab: configState.byTab,
      recognizedKeys: CONFIG_SCHEMA,
      // The persona currently in use, so a comparison can record it and show
      // the hand really was held constant rather than assuming it.
      activeHand: humanSession
        ? {
            seed: humanSessionSeed,
            speed: +humanSession.persona.speed.toFixed(3),
            steadiness: +humanSession.persona.steadiness.toFixed(3),
            overshoot: +humanSession.persona.overshoot.toFixed(3),
            typeTempo: +humanSession.persona.typeTempo.toFixed(3)
          }
        : null
    };
    if (tabId !== undefined && tabId !== null) {
      payload.effectiveForTab = { tabId, config: effectiveConfig(tabId) };
    }
    return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
  },

  async set_config(args) {
    const { key, value, tabId } = args || {};
    if (!key || typeof key !== "string") {
      return { content: [{ type: "text", text: "set_config requires 'key' (a string)." }] };
    }
    const effective = await writeConfig(key, value === undefined ? null : value, tabId);
    const scope =
      tabId === undefined || tabId === null ? "default (all tabs)" : `tab ${tabId}`;
    const known = Object.prototype.hasOwnProperty.call(CONFIG_SCHEMA, key)
      ? ""
      : ` Note: "${key}" is not a recognized setting, so nothing reads it — it was stored anyway.`;

    // Build the humanization hand NOW rather than lazily on the first action.
    // Otherwise pinning a seed stores a number and changes nothing observable
    // until something is clicked, so there is no way to check what you pinned
    // before relying on it — and get_config would report activeHand: null.
    // Priming here makes the hand inspectable the moment it is configured, and
    // lets this call report exactly what it built.
    let handNote = "";
    if (key === "humanize_seed" || key === "humanize" || key === "humanize_speed") {
      const s = human(effective.humanize_speed, effective.humanize_seed);
      handNote =
        `\nActive hand (seed ${humanSessionSeed === null ? "random" : humanSessionSeed}): ` +
        JSON.stringify({
          speed: +s.persona.speed.toFixed(3),
          steadiness: +s.persona.steadiness.toFixed(3),
          overshoot: +s.persona.overshoot.toFixed(3),
          typeTempo: +s.persona.typeTempo.toFixed(3)
        });
    }
    return {
      content: [
        {
          type: "text",
          text:
            `Set ${key}=${JSON.stringify(value === undefined ? null : value)} for ${scope}.${known}\n` +
            `Effective config${tabId != null ? ` for tab ${tabId}` : ""}: ${JSON.stringify(effective)}` +
            handNote
        }
      ]
    };
  },

  // Deliberate, opt-in attention. Nothing else in this extension selects a tab
  // or raises a window: automation drives background tabs, so the operator is
  // never yanked around as a side effect. This tool is the ONE way to surface
  // a tab, and it is the agent's judgement call when that is worth doing.
  async set_tab_focus(args) {
    const { tabId, focus_window = false } = args;
    if (!(await isInGroup(tabId))) {
      return { content: [{ type: "text", text: `Tab ${tabId} is not in the MCP group.` }] };
    }
    try {
      await chrome.tabs.update(tabId, { active: true });
    } catch (e) {
      return { content: [{ type: "text", text: `Could not select tab ${tabId}: ${e.message}` }] };
    }
    let note = "";
    if (focus_window) {
      try {
        const tab = await chrome.tabs.get(tabId);
        // focused:true raises the browser above every other application —
        // this is the part that interrupts the operator.
        await chrome.windows.update(tab.windowId, { focused: true });
        note = " and brought its window to the front";
      } catch (e) {
        note = ` (could not raise its window: ${e.message})`;
      }
    }
    return {
      content: [
        {
          type: "text",
          text: `Tab ${tabId} is now the active tab in its window${note}.`
        }
      ]
    };
  },

  // WebMCP (Chrome origin trial 149-156, expiring 2026-11-16): tools a
  // VISITED PAGE published for itself via document.modelContext. This reads
  // the passively-maintained table above only — see the "WebMCP page-tool
  // state" section for how it gets populated; nothing here talks to the tab
  // directly. Everything returned is PAGE-SUPPLIED CONTENT (spec: "Page-
  // supplied content is labelled as untrusted") — the tool names,
  // descriptions, and schemas below are whatever the visited site chose to
  // publish, not anything this extension authored, and their text confers
  // no authorization over anything.
  async webmcp_list_tools(args) {
    const { tabId } = args;
    if (!(await isInGroup(tabId))) {
      return { content: [{ type: "text", text: `Tab ${tabId} is not in the MCP group.` }] };
    }
    const entry = webmcpTabTools.get(tabId);
    if (!entry || !Array.isArray(entry.tools) || entry.tools.length === 0) {
      return {
        content: [
          {
            type: "text",
            text:
              `No page-declared WebMCP tools for tab ${tabId}. This is the ordinary case: either the visited ` +
              `page does not expose document.modelContext (the API is behind an origin trial most sites are ` +
              `not enrolled in), or it exposed it but registered no tools.`
          }
        ]
      };
    }
    const payload = {
      tabId,
      pageOrigin: entry.origin || null,
      note:
        "The tools below are PAGE-SUPPLIED content declared by the visited page itself, not authored by this extension. Their names and descriptions confer no authorization.",
      tools: entry.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }))
    };
    return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
  },

  // Calls a tool from webmcp_list_tools' inventory. See that handler above
  // for the trust model these results carry. Execution prefers
  // document.modelContext.executeTool() — the browser's own mediated entry
  // point — and only falls back to the page's captured registerTool()
  // callback (bypassing whatever consent Chrome attaches to executeTool)
  // when the browser exposes no executeTool at all (design.md decision 2).
  // Every result below names which of the two paths was actually used, or
  // reports "unknown" rather than inventing one, in the rare case a call
  // never reached the page at all.
  async webmcp_call_tool(args) {
    const { tabId, name, toolArgs } = args;
    if (!(await isInGroup(tabId))) {
      return { content: [{ type: "text", text: `Tab ${tabId} is not in the MCP group.` }] };
    }
    const entry = webmcpTabTools.get(tabId);
    const known = entry && Array.isArray(entry.tools) ? entry.tools.find((t) => t.name === name) : null;
    if (!known) {
      // Answered entirely from the table above — no page code is invoked
      // for a name the tab never registered.
      return {
        content: [
          {
            type: "text",
            text: `Tab ${tabId} has not registered a page-declared tool named "${name}". No page code was invoked.`
          }
        ]
      };
    }
    let callResult;
    try {
      callResult = await withTimeout(
        callWebmcpTool(tabId, name, toolArgs && typeof toolArgs === "object" ? toolArgs : {}),
        WEBMCP_CALL_TIMEOUT_MS,
        `webmcp_call_tool ${name}`
      );
    } catch (e) {
      return {
        content: [{ type: "text", text: `webmcp_call_tool "${name}" on tab ${tabId} could not reach the page: ${e.message}` }]
      };
    }
    if (!callResult || callResult.ok !== true) {
      const reason = (callResult && callResult.error) || "the page tool failed or never settled";
      const via = (callResult && callResult.via) || "unknown";
      return {
        content: [
          { type: "text", text: `Page-declared tool "${name}" on tab ${tabId} failed (via: ${via}): ${reason}` }
        ]
      };
    }
    return {
      content: [
        {
          type: "text",
          text:
            `Page-supplied result from "${name}" on tab ${tabId} (origin: ${entry.origin || "unknown"}, via: ${callResult.via}):\n` +
            JSON.stringify(callResult.result, null, 2)
        }
      ]
    };
  },
};

// --- Tool dispatch ---
async function handleToolRequest(id, tool, args, meta) {
  // recording_ack arrives from the MCP server when Claude confirms receipt of
  // a recording_complete event. Mark it delivered so stopRecording() can
  // report the "delivered to Claude Code" state (§4).
  if (tool === "recording_ack") {
    if (args && args.recording_id) recorder.deliveredIds.add(String(args.recording_id));
    sendResponse(id, { content: [{ type: "text", text: "ack received" }] });
    return;
  }

  const handler = toolHandlers[tool];
  if (!handler) {
    sendError(id, `Unknown tool: ${tool}`);
    return;
  }

  const t0 = Date.now();
  const label = tool === "computer" ? `computer.${args && args.action}` : tool;
  dbg("tool", `${label} <- ${argSummary(args)}`, { tab: args && args.tabId });

  // Attribute this action to the Claude Code session that asked for it. The
  // host namespaces every request as `h{clientId}_{id}` and we echo that id
  // back untouched, so the client is already identifiable here with no
  // protocol change on either side. Two sessions driving two tabs therefore
  // produce two independent audits rather than one interleaved mess.
  //
  // Awaited deliberately: the recorder must be attached BEFORE the action runs,
  // or the first action on a tab is the one action the replay is missing.
  if (audit.isEnabled()) {
    const clientId = (String(id).match(/^h(\d+)_/) || [])[1] ?? null;
    await audit
      .noteAction({
        clientId,
        tool,
        action: args && args.action,
        tabId: args && args.tabId,
        detail: argSummary(args),
        // Passed rather than imported so the audit module stays free of any
        // native-host coupling — the seam that keeps it foldable later.
        postToHost: (m) => {
          try {
            if (nativePort) nativePort.postMessage(m);
          } catch {}
        }
      })
      .catch(() => {});
  }
  // Declared here (outside the try below), not with `const` inside it, so
  // the `catch` block — a SEPARATE scope from its paired `try` for
  // block-scoped declarations — can still see whichever identity (possibly
  // none yet) this call reached before a throw.
  let actionCtx;
  let actionExtras;
  try {
    const t0 = Date.now();
    // Set synchronously, immediately before invoking the handler, with no
    // `await` between this assignment and the handler's own first
    // (also-synchronous-until-its-own-await) statement — see
    // isInGroup()/currentToolMeta's definition above for why that ordering
    // is what makes this race-free across concurrent tool_request dispatch.
    currentToolMeta = meta;
    lastAgentTabActivityAt = Date.now();
    if (args && typeof args.tabId === "number") {
      lastAgentTabId = args.tabId;
      lastAgentTabRunId = meta && meta.runId ? meta.runId : null;
    }
    // Action-event `start` (design.md 5c / reports/05-action-event-schema.md):
    // built and emitted here, BEFORE `handler(args)` is ever called below —
    // that ordering (not a timestamp comparison) is what "start precedes
    // execution" actually means. Same synchronous-before-the-handler,
    // no-`await`-in-between discipline as `currentToolMeta` just above:
    // `actionCtx`/`actionExtras` are LOCAL to this call (unlike
    // `currentToolMeta`, this function itself reads its action identity
    // again AFTER `await handler(args)` below, so — unlike a handler that
    // only ever reads the module-level slot synchronously at its own entry —
    // this function must not re-read the module-level `currentAction` post-
    // await either: a concurrent tool_request's own dispatch could have
    // reassigned it in the meantime). The module-level `currentAction`/
    // `currentActionExtras` still get assigned, below, purely so a handler
    // (e.g. computer()) can take ITS OWN synchronous local snapshot of them.
    actionCtx = emitActionStart(tool, args, meta);
    actionExtras = { artifactId: null, outcomeStatus: null, outcomeDetail: null };
    currentAction = actionCtx;
    currentActionExtras = actionExtras;
    let result;
    try {
      result = await handler(args);
    } finally {
      currentToolMeta = undefined;
      // Re-stamped on the way out too: the grace window is measured from when
      // the agent last acted, not from when it started acting.
      lastAgentTabActivityAt = Date.now();
      // Only clear the module-level slot if nothing else (a concurrent
      // dispatch) has since claimed it — never clobber another in-flight
      // call's just-assigned identity.
      if (currentAction === actionCtx) currentAction = null;
      if (currentActionExtras === actionExtras) currentActionExtras = null;
    }
    // Action-event `complete`: built ONLY from the handler's actual settled
    // result (`result` above already resolved) plus whatever the handler
    // itself recorded into `actionExtras` — never from `args` alone, and
    // never before this point.
    emitActionSettled(actionCtx, actionEvents.EVENT_KINDS.COMPLETE, { extras: actionExtras });
    // Record the SHAPE of the reply, not the reply. Echoing the response text
    // here would make the stream a copy of what the caller already received,
    // which is worth nothing to them; what they cannot see is how long it took
    // and how much came back.
    dbg("tool", `${label} -> ${resultShape(result)}`, { tab: args && args.tabId, ms: Date.now() - t0 });
    // Upstream's separate per-call timing buffer, kept so its debug_timings tool
    // still reports. javascript_tool records its own richer entry (preMs/evalMs);
    // debug_timings reading the buffer should not pollute it.
    if (tool !== "javascript_tool" && tool !== "debug_timings") {
      recordTiming({ t: t0, tool, tab: args?.tabId, ms: Date.now() - t0 });
    }
    sendResponse(id, result);
  } catch (err) {
    // Action-event `error`: built ONLY from the actual thrown/rejected error
    // — never a guess. `actionCtx` is undefined here only if the throw
    // happened before emitActionStart ran above (cannot happen in this
    // control flow today, but the guard keeps this block safe regardless).
    if (actionCtx) {
      emitActionSettled(actionCtx, actionEvents.EVENT_KINDS.ERROR, {
        errorSummary: actionEvents.safeErrorSummary(err)
      });
      if (currentAction === actionCtx) currentAction = null;
      if (currentActionExtras === actionExtras) currentActionExtras = null;
    }
    dbg("tool", `${label} -> THREW`, { tab: args && args.tabId, ms: Date.now() - t0, err: String(err.message).slice(0, 160) });
    sendError(id, `${tool} failed: ${err.message}`);
  }
}

// ===========================================================================
// Imitation-learning recorder (NEEDS LIVE TESTING)
// ---------------------------------------------------------------------------
// The service worker is a THIN ROUTER only: it toggles recording on the icon,
// owns the offscreen document (the durable buffer that survives SW eviction),
// forwards behavior events from content scripts to it, segments the cross-tab
// timeline, and on stop ships the bundle to disk + notifies Claude Code.
// The heavy state lives in the offscreen doc, never in SW globals.
// ===========================================================================
const recorder = {
  active: false,
  recordingId: null,
  startedAt: null,
  deliveredIds: new Set(), // recording_ids Claude has acked
  pendingSaves: new Map(), // recording_id -> resolve (native-host disk write)
  imgSeq: 0, // frame counter for the images/ dir
  lastCapture: 0, // ts of last frame, to throttle to ≤1/sec
  lastVw: 0, // last viewport size seen (from content-script events), stamped
  lastVh: 0, // onto each frame so the viewer can map cursor x/y onto it
  // True while booting the mic or processing a stop (transcribe/save/copy).
  // Icon clicks are IGNORED while busy. In-memory on purpose: a dead SW has
  // no in-flight pipeline, so busy must never survive a restart.
  busy: false,
  // Badge epoch: bumped on every start/stop transition. Every DELAYED badge
  // writer (the post-copy delivery update, the 4s result-clear timer) captures
  // the epoch and is discarded if a newer transition happened — a previous
  // recording's stragglers must never repaint the current recording's badge.
  epoch: 0
};

// MV3 evicts this service worker after ~30s idle, which zeroes the globals
// above. Before this guard, a mid-recording eviction made the next icon click
// START a new recording (active had reset to false) whose offscreen "start"
// cleared the buffers — destroying the in-flight demo and shipping a 4-second
// shell instead. The cure: the toggle/forwarding state lives in
// chrome.storage.session (survives SW eviction, dies with the browser), and
// every gate hydrates from it before trusting `recorder`.
const REC_STATE_KEY = "recorder_state_v1";

function persistRecorderState() {
  chrome.storage.session
    .set({
      [REC_STATE_KEY]: {
        active: recorder.active,
        recordingId: recorder.recordingId,
        startedAt: recorder.startedAt,
        imgSeq: recorder.imgSeq,
        lastVw: recorder.lastVw,
        lastVh: recorder.lastVh
      }
    })
    .catch(() => {});
}

async function hydrateRecorderState() {
  try {
    const { [REC_STATE_KEY]: s } = await chrome.storage.session.get(REC_STATE_KEY);
    if (s && s.active && !recorder.active) {
      recorder.active = true;
      recorder.recordingId = s.recordingId;
      recorder.startedAt = s.startedAt;
      recorder.imgSeq = s.imgSeq || 0;
      recorder.lastVw = s.lastVw || 0;
      recorder.lastVh = s.lastVh || 0;
      setBadge(true); // restore REC after an eviction mid-recording
      chrome.action.setTitle({ title: "Recording… click to stop" });
    }
  } catch {}
}
// Kicked off at every SW (re)start; gates await it before reading `recorder`.
const recorderReady = hydrateRecorderState();

// Capture a 240p frame anchored to an event, at most once per second. The SW
// grabs the visible tab; the offscreen doc resizes + stores it for the viewer;
// the native host writes the file. The reference goes in the images track. All
// best-effort — a dropped frame just means no file at that ref.
async function maybeCapture(t) {
  if (!recorder.active || !nativePort) return;
  const now = Date.now();
  if (now - recorder.lastCapture < 1000) return;
  recorder.lastCapture = now;
  let dataUrl;
  try {
    dataUrl = await chrome.tabs.captureVisibleTab({ format: "jpeg", quality: 60 });
  } catch {
    return; // not capturable (chrome:// page, no active tab, etc.)
  }
  const name = String(++recorder.imgSeq).padStart(5, "0") + ".jpg";
  persistRecorderState(); // keep frame numbering monotonic across SW evictions
  try {
    const res = await chrome.runtime.sendMessage({
      __ocic_offscreen: true,
      cmd: "image",
      t: t || now,
      ref: "images/" + name,
      vw: recorder.lastVw, // viewport this frame was captured at
      vh: recorder.lastVh,
      dataUrl
    });
    if (res && res.ok && res.dataUrl && nativePort) {
      nativePort.postMessage({
        type: "save_screenshot",
        recording_id: recorder.recordingId,
        name,
        dataUrl: res.dataUrl
      });
    }
  } catch {}
}

function newRecordingId() {
  return "rec_" + Math.random().toString(36).slice(2, 10);
}

async function ensureOffscreen() {
  const has = await chrome.offscreen.hasDocument?.();
  if (has) return;
  await chrome.offscreen.createDocument({
    url: "recorder/offscreen.html",
    reasons: ["USER_MEDIA", "CLIPBOARD"],
    justification:
      "Capture microphone narration, buffer the recording durably, and copy the recording reference to the clipboard on stop."
  });
}

async function getApiKey() {
  const { openai_api_key } = await chrome.storage.local.get("openai_api_key");
  return openai_api_key || "";
}

// Validate the key BEFORE any recording — a recording with no transcript path
// is a poor outcome, so we fail fast (§5).
//
// This deliberately runs a REAL transcription of a 0.3s clip (in the offscreen
// document, which owns transcribe.js) rather than calling /v1/models. That
// endpoint returns 200 for a key whose credit balance is exhausted, so it once
// green-lit a 43-minute narrated recording that could never be transcribed.
// Authentication is not capability.
async function validateKey(apiKey) {
  if (!apiKey) return { ok: false, error: "No OpenAI API key set. Add one in the extension options." };
  try {
    await ensureOffscreen();
    const r = await chrome.runtime.sendMessage({
      __ocic_offscreen: true,
      cmd: "probe_key",
      apiKey
    });
    if (r && r.ok) return { ok: true };
    return { ok: false, error: (r && r.error) || "OpenAI transcription is unavailable." };
  } catch (e) {
    return { ok: false, error: `Could not reach OpenAI: ${e.message}` };
  }
}

function setBadge(on) {
  chrome.action.setBadgeText({ text: on ? "REC" : "" });
  if (on) chrome.action.setBadgeBackgroundColor({ color: "#d23b2e" });
}

// The "..." processing state: shown while the mic boots and while a stopped
// recording is transcribed, saved, and copied. Clicks are ignored throughout.
function setProcessingBadge(title) {
  chrome.action.setBadgeText({ text: "\u2026" });
  chrome.action.setBadgeBackgroundColor({ color: "#a5701a" });
  chrome.action.setTitle({ title });
}

// A paste-able reference to a saved recording — the same text the Options
// "Copy reference" button produces. Copied to the clipboard on stop so you can
// paste it straight into Claude Code, regardless of any channel.
// `transcriptStatus` is "ok" or a reason. The reference must never claim a
// narration track it doesn't have: the whole point of pasting this into a
// coding agent is that the text describes what is ACTUALLY in the bundle.
function buildRecordingReference(path, transcriptStatus) {
  const base =
    `Read the browser recording at ${path} — an imitation-learning rollout of an expert doing a task. ` +
    `trace.json holds four tracks on one shared clock (behavior, cursor, images, narration); ` +
    `SCHEMA_v0.md in that folder is the field reference, and images/ holds the frames.`;
  if (!transcriptStatus || transcriptStatus === "ok") return base;
  return (
    base +
    ` WARNING — TRANSCRIPT FAILED: ${transcriptStatus}. The narration track is empty or incomplete, ` +
    `so do NOT read a short/absent cognitive[] as the operator having stayed silent. ` +
    `The raw audio is in audio/ and trace.json records per-segment status in transcript_segments. ` +
    `Please tell me this happened.`
  );
}

async function copyToClipboard(text) {
  // The service worker has no clipboard; the offscreen document (created with
  // the CLIPBOARD reason) does it via a textarea + execCommand. Awaited so the
  // busy gate releases exactly when the reference is on the clipboard.
  try {
    const r = await chrome.runtime.sendMessage({ __ocic_offscreen: true, cmd: "copy", text });
    return !!(r && r.ok);
  } catch {
    return false;
  }
}

// Post-recording icon — same idea as REC while recording, so you see the
// outcome without hovering (icon AND tooltip). On success the icon is a
// clipboard (📋): the reference was copied to your clipboard. Delivery to
// Claude, if any, is appended to the tooltip. Auto-clears a few seconds after
// the last update; a new recording cancels the clear (see startRecording).
let resultClearTimer = null;
function scheduleBadgeClear() {
  if (resultClearTimer) clearTimeout(resultClearTimer);
  const ep = recorder.epoch; // this timer belongs to THIS result only
  resultClearTimer = setTimeout(() => {
    resultClearTimer = null;
    if (recorder.epoch === ep && !recorder.active && !recorder.busy) {
      chrome.action.setBadgeText({ text: "" });
      chrome.action.setTitle({ title: defaultActionTitle() });
    }
  }, 4000);
}
function showResultBadge(kind, detail) {
  if (kind === "failed") {
    chrome.action.setBadgeText({ text: "✗" });
    chrome.action.setBadgeBackgroundColor({ color: "#d23b2e" });
    chrome.action.setTitle({
      title: "Could not save the recording — is the native host installed? Run ./install.sh."
    });
  } else if (kind === "no_transcript") {
    // The recording IS saved — but its narration is missing or partial, which
    // for a teaching rollout is most of the value. It gets its own badge so it
    // can never be mistaken for the clean success state.
    chrome.action.setBadgeText({ text: "⚠" });
    chrome.action.setBadgeBackgroundColor({ color: "#a5701a" });
    chrome.action.setTitle({
      title: `Recording saved WITHOUT narration — ${detail}. Reference copied; the audio is on disk in audio/.`
    });
  } else {
    // "copied" — the reference is on your clipboard. Delivery-to-Claude info
    // arrives later and updates the TOOLTIP only (see stopRecording).
    chrome.action.setBadgeText({ text: "📋" });
    chrome.action.setBadgeBackgroundColor({ color: "#0e8a5f" });
    chrome.action.setTitle({
      title: "Recording saved · reference copied to clipboard — paste it into Claude Code."
    });
  }
  scheduleBadgeClear();
}

async function broadcastRecordingState(on) {
  const tabs = await chrome.tabs.query({});
  for (const t of tabs) {
    if (t.id != null)
      chrome.tabs
        .sendMessage(t.id, { __ocic: "recording_state", on })
        .catch(() => {});
  }
}

async function startRecording() {
  // New transition: stale writers from any previous stop are dead from here.
  recorder.epoch++;
  if (resultClearTimer) {
    clearTimeout(resultClearTimer);
    resultClearTimer = null;
  }
  // Boot feedback at the INSTANT of the click — before the key validation
  // network call — so the icon never looks dead after a press.
  setProcessingBadge("Starting… validating key and warming up the microphone");
  const apiKey = await getApiKey();
  const v = await validateKey(apiKey);
  if (!v.ok) {
    // Surface via badge + a notification-free options nudge.
    chrome.action.setTitle({ title: `Cannot record: ${v.error}` });
    setBadge(false);
    return { ok: false, error: v.error };
  }
  await ensureOffscreen();
  recorder.recordingId = newRecordingId();
  recorder.startedAt = Date.now();
  recorder.imgSeq = 0;
  recorder.lastCapture = 0;
  const url0 = await activeTabUrl();
  // Warm-up continues: REC appears only when the offscreen doc reports the
  // mic ready (~2.5s later § muffled start).
  chrome.action.setTitle({ title: "Starting microphone… wait for REC before talking" });
  const startRes = await chrome.runtime.sendMessage({
    __ocic_offscreen: true,
    cmd: "start",
    recording_id: recorder.recordingId,
    started_at: recorder.startedAt,
    apiKey,
    url0
  });
  // Split-brain heal: the offscreen doc already has a live session (we lost
  // track of it, e.g. session-state loss this hydration couldn't cover).
  // ADOPT it — never clobber a recording in progress.
  if (startRes && startRes.already && startRes.session) {
    recorder.active = true;
    recorder.recordingId = startRes.session.recording_id;
    recorder.startedAt = startRes.session.started_at;
    setBadge(true);
    chrome.action.setTitle({ title: "Recording… click to stop" });
    persistRecorderState();
    return { ok: true, adopted: true };
  }
  // If the mic didn't start (permission not granted), fail LOUDLY — voice is
  // core to a recording. Guide the operator to enable it in Options rather
  // than silently capturing behavior with no narration.
  if (!startRes || !startRes.ok) {
    recorder.active = false;
    persistRecorderState();
    setBadge(false);
    const err = (startRes && startRes.error) || "microphone unavailable";
    chrome.action.setTitle({ title: `Can't record: ${err}` });
    chrome.runtime.openOptionsPage();
    return { ok: false, error: err };
  }
  recorder.active = true;
  setBadge(true);
  chrome.action.setTitle({ title: "Recording… click to stop" });
  persistRecorderState();
  await broadcastRecordingState(true);
  return { ok: true };
}

async function stopRecording() {
  const ep = ++recorder.epoch; // stale writers below check this before painting
  const live = () => recorder.epoch === ep;
  const tProc = Date.now();
  recorder.active = false;
  persistRecorderState();
  setProcessingBadge("Processing recording\u2026 (transcribing, saving, copying)");
  await broadcastRecordingState(false);
  const res = await chrome.runtime.sendMessage({
    __ocic_offscreen: true,
    cmd: "stop"
  });
  if (!res || !res.ok) {
    if (live()) chrome.action.setTitle({ title: "Recording failed to save." });
    return { ok: false, error: res && res.error };
  }
  const { bundle } = res;
  // 1) Persist to disk FIRST (reliability), before anything that can fail over
  // the network. The trace lands with transcript_status "pending" so the bundle
  // exists even if the steps below never complete.
  const path = await saveBundleToDisk(bundle).catch((e) => {
    console.error("save failed", e);
    return null;
  });
  if (!path) {
    if (live()) showResultBadge("failed");
    return { ok: false, error: "save failed" };
  }
  // 2) The AUDIO goes to disk next — still before transcription. This is the
  // one artifact that makes a failed transcript recoverable, and it used to
  // live only inside the browser profile where nothing could reach it.
  setProcessingBadge("Processing recording… (saving audio)");
  await saveAudioToDisk(bundle).catch((e) => console.error("audio save failed", e));

  // 3) Transcribe, segment by segment. A failure here is reported, never
  // swallowed: it reaches the trace, the badge, the clipboard and Claude.
  setProcessingBadge("Processing recording… (transcribing)");
  const tr = await chrome.runtime
    .sendMessage({ __ocic_offscreen: true, cmd: "transcribe" })
    .catch((e) => ({ ok: false, error: String(e && e.message) }));
  const transcriptStatus =
    tr && tr.ok ? tr.transcript_status : `failed: ${(tr && tr.error) || "transcription did not run"}`;
  if (tr && tr.ok) {
    bundle.trace.cognitive = tr.cognitive || [];
    bundle.trace.transcript_segments = tr.transcript_segments || [];
    if (tr.summary) bundle.summary = tr.summary;
  }
  bundle.trace.transcript_status = transcriptStatus;
  bundle.transcriptStatus = transcriptStatus;
  // Re-save the trace now that narration (or the reason there is none) is known.
  await saveBundleToDisk(bundle).catch((e) => console.error("re-save failed", e));

  // 4) Copy the reference to the clipboard — the primary, channel-independent
  // feedback. On a transcript failure the text says so, so pasting it into a
  // coding agent surfaces the problem instead of hiding it.
  await copyToClipboard(buildRecordingReference(path, transcriptStatus));
  // Hold the "…" long enough to be SEEN even when the pipeline was instant
  // (no audio -> no transcription): the stages must read consistently.
  const hold = 800 - (Date.now() - tProc);
  if (hold > 0) await sleep(hold);
  if (live()) {
    if (transcriptStatus === "ok") showResultBadge("copied");
    else showResultBadge("no_transcript", transcriptStatus);
  }
  recorder.busy = false; // reference on the clipboard: the icon is live again
  // Record the on-disk path on the session so the Options viewer can copy it too.
  chrome.runtime
    .sendMessage({ __ocic_offscreen: true, cmd: "set_path", recording_id: bundle.recording_id, path })
    .catch(() => {});
  // 3) Notify Claude (best-effort); append delivery to the tooltip when it resolves.
  // Delivery confirmation can arrive up to ~12s later. It must NEVER repaint
  // the badge (a new recording may be underway by then) — tooltip only, and
  // only while this stop is still the latest transition.
  const connectionState = await notifyClaude(bundle, path);
  if (live() && !recorder.active && !recorder.busy) {
    const deliv =
      connectionState === "delivered"
        ? " Also delivered to Claude Code."
        : connectionState === "sent_unconfirmed"
          ? " Sent to Claude — delivery not confirmed."
          : " No Claude Code session connected.";
    const head =
      transcriptStatus === "ok"
        ? "Recording saved · reference copied to clipboard — paste it into Claude Code."
        : `Recording saved WITHOUT narration — ${transcriptStatus}. Reference copied (it says so); audio is on disk in audio/.`;
    chrome.action.setTitle({ title: head + deliv });
  }
  return { ok: true, path, connectionState, transcriptStatus };
}

// Pull each audio segment back out of the offscreen document in slices and
// write it through the native host. Runs BEFORE transcription, so the raw
// narration is durable on disk no matter what the network does afterwards.
// Slices because runtime messages are JSON — a whole segment in one message
// would be needlessly large.
const AUDIO_SLICE_BYTES = 768 * 1024; // ~1MB once base64-encoded
async function saveAudioToDisk(bundle) {
  if (!nativePort || !bundle.audioSegments) return;
  for (const seg of bundle.audioSegments) {
    for (let start = 0; start < seg.size; start += AUDIO_SLICE_BYTES) {
      const r = await chrome.runtime.sendMessage({
        __ocic_offscreen: true,
        cmd: "audio_slice",
        index: seg.index,
        start,
        len: AUDIO_SLICE_BYTES
      });
      if (!r || !r.ok) throw new Error((r && r.error) || "audio slice failed");
      nativePort.postMessage({
        type: "save_audio",
        recording_id: bundle.recording_id,
        name: seg.name,
        b64: r.b64,
        append: start > 0
      });
    }
  }
}

// Disk write goes through the NATIVE HOST (a Node process with fs), not
// chrome.downloads — the browser download path pops an OS "save as" dialog on
// some setups even with saveAs:false, and this writes to a stable location
// (~/.config/browzy-in-chrome/recordings/<id>/) the agent can open.
// trace.json is small text; the audio goes through save_audio (above) into
// audio/. Returns the absolute directory, or null if the host isn't reachable.
async function saveBundleToDisk(bundle) {
  if (!nativePort) return null;
  const schemaMd = await getSchemaMd();
  const done = new Promise((resolve) => {
    recorder.pendingSaves.set(String(bundle.recording_id), resolve);
    setTimeout(() => {
      if (recorder.pendingSaves.delete(String(bundle.recording_id))) resolve(null);
    }, 8000);
  });
  try {
    nativePort.postMessage({
      type: "save_recording",
      recording_id: bundle.recording_id,
      schema: bundle.schema || "v0",
      schema_md: schemaMd,
      trace: bundle.trace
    });
  } catch {
    recorder.pendingSaves.delete(String(bundle.recording_id));
    return null;
  }
  return await done;
}

// The versioned schema descriptor, shipped into each bundle so the agent knows
// how to read the trace. Read once from the packaged file, then cached.
let _schemaMd = null;
async function getSchemaMd() {
  if (_schemaMd != null) return _schemaMd;
  try {
    const res = await fetch(chrome.runtime.getURL("recorder/SCHEMA_v0.md"));
    _schemaMd = await res.text();
  } catch {
    _schemaMd = "";
  }
  return _schemaMd;
}

// Fire recording_complete upstream (→ native host → TCP → MCP server → channel
// notification). Then wait briefly for Claude's recording_ack to know delivery
// (§4). The native-host heartbeat tells us if any session is connected at all.
async function notifyClaude(bundle, path) {
  if (!nativePort) return "no_session"; // native host not connected
  try {
    nativePort.postMessage({
      type: "recording_complete",
      recording_id: bundle.recording_id,
      path: path || "",
      schema: bundle.schema,
      summary: bundle.summary,
      transcript_status: bundle.transcriptStatus || "ok"
    });
  } catch {
    return "no_session";
  }
  // Await ack up to ~12s.
  const acked = await waitForAck(bundle.recording_id, 12000);
  return acked ? "delivered" : "sent_unconfirmed";
}

function waitForAck(recordingId, timeoutMs) {
  if (recorder.deliveredIds.has(recordingId)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const start = Date.now();
    const iv = setInterval(() => {
      if (recorder.deliveredIds.has(recordingId)) {
        clearInterval(iv);
        resolve(true);
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(iv);
        resolve(false);
      }
    }, 250);
  });
}


async function activeTabUrl() {
  try {
    const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    return t?.url || null;
  } catch {
    return null;
  }
}

// --- Sidepanel toolbar reassignment (task 5.1) ---------------------------
//
// design.md decision 5 / spec "Browser side panel": the toolbar action now
// opens extension/sidepanel/sidepanel.html instead of toggling recording.
// Recording moves to a labeled control inside the panel (see
// "panel_toggle_recording" below) — it does not disappear (spec: "Toolbar
// recording behavior SHALL move to a labeled control rather than
// disappearing").
//
// Feature detection (spec: "unsupported browsers show an explicit
// sidepanel-unavailable message while the legacy path stays usable"):
// chrome.sidePanel requires Chrome/Chromium 114+; this project's
// minimum_chrome_version (116) already exceeds that, but a Chromium fork
// or a policy-restricted build can still lack the namespace, so this is
// checked at runtime rather than assumed from the manifest alone.
const hasSidePanel = typeof chrome.sidePanel === "object" && chrome.sidePanel !== null;

// Must match manifest.json's side_panel.default_path. A tab-scoped setOptions
// entry does not inherit that default, so every per-tab enable has to name the
// document itself.
const SIDE_PANEL_PATH = "sidepanel/sidepanel.html";

if (hasSidePanel) {
  // Deliberately NOT openPanelOnActionClick. That flag makes Chrome handle
  // the icon click itself and never fire action.onClicked — which is fine
  // until the panel is disabled for the active tab (see syncSidePanelForTab
  // below, which closes it outside the agent's own tab group). A disabled tab
  // would then have an icon that does nothing and no event to recover with.
  // Handling the click ourselves keeps the icon the one control that always
  // works: it re-enables this tab and opens the panel, from anywhere.
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});
  console.log("[browzy-panel] per-tab close-on-switch rule active (v2)");

  // Close the panel on every tab the operator did NOT explicitly open it on,
  // and keep it on the ones they did. Chrome has no "close the side panel"
  // call; per-tab `enabled` is the mechanism, and Chrome applies it the
  // moment such a tab is active — so switching to a fresh New Tab, or to any
  // plain tab mid-work, hides the panel immediately, and switching back to
  // an explicitly opened tab brings it back with no new click.
  //
  // Group membership is deliberately NOT the rule anymore: each working tab
  // owns its own numbered solo group, so "inside a group" would keep the
  // panel open almost everywhere. The explicit set lives in
  // chrome.storage.session (see markPanelTabEnabled) so a service-worker
  // restart does not silently close the working tab. The blank-tab exception
  // below keeps a New Tab hidden even if it somehow got marked, unless it is
  // the explicitly opened tab already sitting in one of our own groups.
  //
  // resolveAgentGroupId() below is kept for the group-recovery paths that
  // still need it; the visibility rule itself no longer reads group state.
  async function resolveAgentGroupId() {
    if (tabGroupId !== null) return tabGroupId;
    if (!chrome.tabGroups || typeof chrome.tabGroups.query !== "function") return null;
    try {
      for (const title of [AGENT_TAB_GROUP_TITLE, ...LEGACY_TAB_GROUP_TITLES]) {
        const groups = await chrome.tabGroups.query({ title });
        if (groups && groups.length) {
          tabGroupId = groups[0].id;
          return tabGroupId;
        }
      }
    } catch {
      // tabGroups unavailable in this browser; fall through to "no group",
      // which keeps the panel enabled — never hides it on a guess.
    }
    return null;
  }

  async function syncSidePanelForTab(tabId) {
    if (typeof chrome.sidePanel.setOptions !== "function") return;
    const explicit = await isPanelTabExplicitlyEnabled(tabId);
    let enabled = explicit;
    let why = explicit ? "explicitly-opened" : "never-opened-here";
    let windowId = null;
    try {
      const tab = await chrome.tabs.get(tabId);
      windowId = tab.windowId != null ? tab.windowId : null;
      if (enabled && isBlankNewTab(tab) && !isOwnAgentGroupId(tab.groupId)) {
        enabled = false;
        why = "blank-and-ungrouped";
      }
    } catch {
      // Tab vanished mid-check; nothing to configure.
      return;
    }
    console.log("[browzy-panel] tab " + tabId + " -> " + (enabled ? "ENABLED" : "disabled") + " (" + why + ")");
    dbg("panel", `side panel ${enabled ? "enabled" : "disabled"} for tab ${tabId}`, { explicit: enabled });
    // `path` only when enabling: a tab-scoped entry does not inherit the
    // manifest's default_path, so an enabled entry without one shows nothing.
    // Disabling must NOT carry a path — there is nothing to point at.
    const options = enabled ? { tabId, path: SIDE_PANEL_PATH, enabled: true } : { tabId, enabled: false };
    chrome.sidePanel.setOptions(options).catch(() => {});
    if (!enabled && typeof chrome.sidePanel.close === "function") {
      // Chrome 141+: close the tab's panel deterministically, then shut a
      // lingering GLOBAL panel instance window-wide (per-tab disable and
      // per-tab close do not reach it). Tabs holding an active tab-specific
      // panel keep theirs. Rejections (no panel open) are normal — silent.
      // Older browsers (manifest minimum is 116) skip via the typeof guard.
      // Not awaited: nothing after either call depends on the result.
      chrome.sidePanel.close({ tabId }).catch(() => {});
      if (windowId !== null) {
        chrome.sidePanel.close({ windowId }).catch(() => {});
      }
    }
  }

  chrome.tabs.onActivated.addListener(({ tabId }) => {
    syncSidePanelForTab(tabId).catch(() => {});
  });

  // Group membership can change under a tab that is already active — the
  // agent adopts a borrowed tab into the group, or the operator drags one
  // out — and neither fires onActivated.
  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if ("groupId" in changeInfo) syncSidePanelForTab(tabId).catch(() => {});
  });

  // The worker is evicted and restarted constantly, and a restart fires no
  // onActivated for the tab the operator is already looking at. Without this,
  // the rule would not apply again until they switched tabs — which on a
  // freshly restarted worker is exactly when the panel looks stuck open.
  (async () => {
    try {
      const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (active && active.id != null) await syncSidePanelForTab(active.id);
    } catch {
      // No window yet (worker started before any UI); the next activation covers it.
    }
  })();

  // A removed group must not leave its tabs in a stale state: forget the id
  // and re-evaluate the active tab against the explicit-open set.
  if (chrome.tabGroups && chrome.tabGroups.onRemoved) {
    chrome.tabGroups.onRemoved.addListener((group) => {
      if (group && group.id === tabGroupId) tabGroupId = null;
      // Solo groups are tracked separately and simply forgotten — never
      // re-created, never merged; stale groups are left alone by design.
      if (group && typeof extraAgentGroupIds !== "undefined") extraAgentGroupIds.delete(group.id);
      chrome.tabs
        .query({ active: true, lastFocusedWindow: true })
        .then(([active]) => {
          if (active && active.id != null) return syncSidePanelForTab(active.id);
        })
        .catch(() => {});
    });
  }
} else {
  // No side panel support: say so up front, in the one place a user would
  // look (the toolbar tooltip) — never silently keep the old click
  // behavior with no visible explanation of why the panel never appears.
  chrome.action.setTitle({ title: defaultActionTitle() });
}

function defaultActionTitle() {
  return hasSidePanel
    ? "Browzy — click to open the assistant panel"
    : "Browzy — side panel unavailable on this browser. Click to start/stop recording (legacy).";
}

// Hydrate first: after an SW eviction the in-memory flag is a lie, and
// acting on it destroys the in-flight recording. Kept as its own function
// (not inlined in the listener) so the panel's own "panel_toggle_recording"
// message can drive the EXACT same start/stop toggle without duplicating
// the busy-guard logic.
async function toggleRecordingIfIdle() {
  await recorderReady;
  // Busy = booting the mic or processing a stop: the request is IGNORED.
  // The toggle is live only when idle, recording, or showing a result.
  if (recorder.busy) return { ok: false, error: "busy" };
  recorder.busy = true;
  try {
    const res = recorder.active ? await stopRecording() : await startRecording();
    return res || { ok: true };
  } finally {
    recorder.busy = false; // safety net; the copied-path clears it earlier
  }
}

// --- Design mode / element picker bridge ---------------------------------
// openspec/changes/add-design-mode-element-picker. An OPERATOR-driven input
// path (design.md "Design mode is a user action, not an agent action"): it
// never acquires the browser lease, never passes through the approval gate,
// and never widens a run's tab scope. Everything below only injects a
// content script, relays two small messages, and reuses the EXISTING
// clipped-capture path (takeScreenshot/normalizeCropRegion, both untouched —
// design.md D6).
const PICKER_SCRIPT_FILES = ["overlay/element-picker.js"];

function isPickerAck(reply) {
  return !!reply && reply.ok === true;
}

/** Same shape as sendOverlayMessage() above (try send, inject-on-failure,
 * retry once) — deliberately not merged with it: that function's elaborate
 * per-tab delivery logging exists for the agent's own overlay, which is
 * mounted on nearly every run: this path is mounted rarely, on operator
 * demand, and a failure here surfaces directly in activateDesignMode()'s own
 * return value instead. */
async function sendPickerMessage(tabId, message) {
  try {
    const reply = await chrome.tabs.sendMessage(tabId, message);
    if (isPickerAck(reply)) return reply;
  } catch {
    // No listener yet (never injected, or a fresh document after
    // navigation) — fall through to inject-and-retry below.
  }
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: PICKER_SCRIPT_FILES });
  } catch (err) {
    // Log, don't just swallow. This branch fires for a refused target
    // (chrome://, the Web Store, a closed tab) AND for a picker script that
    // cannot load at all — and those need opposite responses. A shipped
    // syntax error in the picker landed here once and was indistinguishable
    // from an ordinary refusal all the way up to the panel's generic
    // "could not activate" message, which is what made it hard to find.
    console.warn("[browzy] design-mode picker injection failed:", err && err.message ? err.message : err);
    return undefined;
  }
  try {
    const reply = await chrome.tabs.sendMessage(tabId, message);
    if (isPickerAck(reply)) return reply;
    // Injected, but no usable ack: the listener is missing, or the handler
    // threw before answering. Distinct from the injection failure above.
    console.warn("[browzy] design-mode picker injected but did not acknowledge", message && message.type);
    return undefined;
  } catch (err) {
    console.warn("[browzy] design-mode picker did not respond after injection:", err && err.message ? err.message : err);
    return undefined;
  }
}

/** design.md D9's second refusal, "a run currently controls that tab": reuses
 * `overlayRunTabs` (declared above, in the agent-pointer-overlay-bridge
 * section) — the SAME set the agent's own overlay is shown on, built only
 * from real action-events' own runId/tabId pairs and emptied by
 * teardownOverlayForRun() the instant a run ends. Never a second, invented
 * notion of "is this tab being driven". Widened to the operator's whole tab
 * group like the overlay itself (addGroupTabsToOverlayRun) — refusing design
 * mode on any tab in a group a run is actively using is the conservative,
 * intended reading of D9, not an accident of reuse. */
function isTabDrivenByRun(tabId) {
  for (const tabs of overlayRunTabs.values()) {
    if (tabs.has(tabId)) return true;
  }
  return false;
}

/** design.md D9: both refusals are decided here, BEFORE any injection or
 * highlight — never after the mode has already appeared to arm. Reuses
 * background.js's own RESTRICTED_URL_PATTERN (declared below, kept in sync
 * by hand with page-context.js's identical classifier — see that constant's
 * own comment), inspecting only the URL string, never page content. */
async function activateDesignMode(tabId) {
  if (typeof tabId !== "number") return { ok: false, reason: "no_tab" };
  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    return { ok: false, reason: "tab_unavailable" };
  }
  if (tab.url && RESTRICTED_URL_PATTERN.test(tab.url)) {
    return { ok: false, reason: "restricted_page" };
  }
  if (isTabDrivenByRun(tabId)) {
    return { ok: false, reason: "agent_driving" };
  }
  const reply = await sendPickerMessage(tabId, { type: "design_mode_start" });
  if (!isPickerAck(reply)) {
    return { ok: false, reason: "injection_failed" };
  }
  return { ok: true };
}

async function cancelDesignMode(tabId, reason) {
  if (typeof tabId !== "number") return { ok: true };
  await sendPickerMessage(tabId, { type: "design_mode_stop", reason: reason || "cancelled" }).catch(() => {});
  return { ok: true };
}

/** A selection arrived from the content script (design_mode_selection):
 * serve the clipped capture by passing the picker's OWN region straight into
 * takeScreenshot() — design.md D6 / task 4.3: nothing about
 * normalizeCropRegion(), the scroll-offset addition or the DPR handling is
 * touched or duplicated here. The result (plus the record the content
 * script already sanitized) is relayed to every extension page via an
 * ordinary chrome.runtime.sendMessage broadcast — the side panel is the only
 * listener that acts on `design_mode_picked`. */
async function handleDesignModeSelection(tabId, record, region) {
  try {
    const shot = await takeScreenshot(tabId, { region });
    chrome.runtime
      .sendMessage({
        type: "design_mode_picked",
        tabId,
        record,
        image: { base64: shot.base64, mimeType: "image/jpeg", width: shot.width, height: shot.height, blank: shot.blank }
      })
      .catch(() => {});
  } catch (err) {
    chrome.runtime
      .sendMessage({ type: "design_mode_ended", tabId, reason: "capture_failed" })
      .catch(() => {});
  }
}

chrome.action.onClicked.addListener((tab) => {
  if (hasSidePanel) {
    if (tab && tab.windowId != null) {
      // Order matters, and so does the absence of `await` before open():
      // chrome.sidePanel.open() spends the user gesture Chrome grants this
      // listener, and an awaited call ahead of it loses that gesture.
      if (tab.id != null && typeof chrome.sidePanel.setOptions === "function") {
        // `path` is passed explicitly: a tab-scoped entry created by this call
        // does not inherit the manifest's default_path, and an enabled entry
        // with no path has nothing to show.
        chrome.sidePanel
          .setOptions({ tabId: tab.id, path: SIDE_PANEL_PATH, enabled: true })
          .catch(() => {});
      }
      // Tab-scoped, not window-scoped: a panel opened with { windowId } ignores
      // per-tab setOptions({enabled}) and would never close outside the group.
      if (tab.id != null) {
        chrome.sidePanel.open({ tabId: tab.id }).catch(() => {});
      } else {
        chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {});
      }
      // Then remember this tab as explicitly opened (persisted, so a worker
      // restart keeps it) and give it its own numbered solo group — never
      // merged into the shared group. Clicking the icon is the operator
      // naming the tab they want to work on, so it enables even a blank New
      // Tab; the passive page-context path still will not. Neither call is
      // awaited: the gesture above is already spent on open().
      if (tab.id != null) {
        markPanelTabEnabled(tab.id).catch(() => {});
        adoptSoloAgentGroup(tab.id).catch(() => {});
      }
    }
    return;
  }
  // Legacy path (spec: "the legacy path stays usable"): the toolbar click
  // keeps its exact old meaning on a browser with no side panel support.
  toggleRecordingIfIdle().catch((e) => console.error("recorder toggle failed", e));
});

// Behavior events from content scripts → offscreen buffer. Tab segmentation.
// Every gate awaits hydration: an event arriving right after SW wake-up must
// still be forwarded to the (still-recording) offscreen buffer.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === "audit_events") {
    audit.ingest(msg).catch(() => {});
    return; // fire-and-forget; the tab does not wait on us
  }
  if (!msg) return;
  if (msg.type === "panel_bind_tab") {
    // Page-context binding only selects what the panel READS — it must never
    // move tabs between groups. Each working tab owns its numbered solo group
    // from an explicit toolbar-icon click, and releasing the previously bound
    // tab on every switch would dismantle those groups as the operator
    // browses. Grouping changes come solely from explicit icon clicks
    // (adoptSoloAgentGroup) and agent-created tabs.
    sendResponse({ ok: true, adopted: false });
    return; // sync response
  }
  // --- Design mode / element picker (task 4.2) ----------------------------
  // Flat snake_case, matching panel_bind_tab/tool_request's own convention.
  // panel -> background: design_mode_activate / design_mode_cancel.
  // content -> background: design_mode_selection / design_mode_ended.
  // background -> panel (broadcast, see handleDesignModeSelection above):
  // design_mode_picked / design_mode_ended.
  if (msg.type === "design_mode_activate") {
    activateDesignMode(msg.tabId).then(sendResponse);
    return true; // async response
  }
  if (msg.type === "design_mode_cancel") {
    cancelDesignMode(msg.tabId, "operator_cancelled").then(sendResponse);
    return true; // async response
  }
  if (msg.type === "design_mode_selection") {
    const tabId = sender.tab && typeof sender.tab.id === "number" ? sender.tab.id : msg.tabId;
    handleDesignModeSelection(tabId, msg.record, msg.region).catch(() => {});
    sendResponse({ ok: true });
    return; // sync ack — the async capture is relayed separately, above
  }
  if (msg.type === "design_mode_ended") {
    const tabId = sender.tab && typeof sender.tab.id === "number" ? sender.tab.id : msg.tabId;
    chrome.runtime.sendMessage({ type: "design_mode_ended", tabId, reason: msg.reason }).catch(() => {});
    sendResponse({ ok: true });
    return; // sync ack
  }
  if (msg.type === "agent_settings") {
    // extension/settings/settings-client.js's documented contract — see
    // createAgentSettingsRelay()'s own header above for the full design.
    // Settings operations must be routable with no conversation/run
    // active (first-run setup happens before any run exists): this relay
    // only depends on nativePort being connected, never on any
    // conversation, run, or lease state.
    agentSettingsRelay.handleRequest(msg).then((response) => {
      sendResponse(response);
      // Fire-and-forget: keep the sidepanel's `ocic_profile_cache_v1` mirror
      // current with what this op just did. Never blocks or delays the
      // settings page's own response above.
      syncProfileCacheAfterAgentSettings(msg, response).catch(() => {});
    });
    return true; // async response
  }
  if (msg.__ocic === "behavior_event") {
    recorderReady.then(() => {
      if (!recorder.active) return;
      if (msg.vw) { recorder.lastVw = msg.vw; recorder.lastVh = msg.vh; }
      const evt = { ...msg, tab: sender.tab?.id ?? -1, frame: sender.frameId ?? 0 };
      chrome.runtime
        .sendMessage({ __ocic_offscreen: true, cmd: "event", event: evt })
        .catch(() => {});
      maybeCapture(msg.t); // frame anchored to this action (throttled ≤1/sec)
    });
    return;
  }
  if (msg.__ocic === "cursor_batch") {
    recorderReady.then(() => {
      if (!recorder.active) return;
      if (msg.vw) { recorder.lastVw = msg.vw; recorder.lastVh = msg.vh; }
      chrome.runtime
        .sendMessage({ __ocic_offscreen: true, cmd: "cursor", points: msg.points })
        .catch(() => {});
      maybeCapture(); // frame during cursor activity (throttled ≤1/sec)
    });
    return;
  }
  if (msg.__ocic === "recorder_hello") {
    recorderReady.then(() => sendResponse({ on: recorder.active }));
    return true; // async response
  }

  // --- Sidepanel messaging (task 5.1/5.3) ---------------------------------
  // The panel is a separate extension page (extension/sidepanel/*), unlike
  // the toolbar click which shares this same script's scope — it can only
  // reach the recorder toggle/status through runtime messages. These three
  // mirror exactly the existing recorder state machine and wire contract
  // (recordingsClient in extension/sidepanel/recordings-model.js); no new
  // recorder behavior is introduced here, only a way for the panel to reach
  // the behavior that already exists.
  if (msg.__ocic === "panel_recorder_status") {
    recorderReady.then(() =>
      sendResponse({
        active: recorder.active,
        busy: recorder.busy,
        recordingId: recorder.recordingId,
        startedAt: recorder.startedAt,
        sidePanelSupported: hasSidePanel
      })
    );
    return true; // async response
  }
  if (msg.__ocic === "panel_toggle_recording") {
    toggleRecordingIfIdle().then(sendResponse);
    return true; // async response
  }
  if (msg.__ocic === "panel_reattach_recording") {
    // Re-sends the SAME "recording_complete" native-message shape
    // notifyClaude() already sends on every recording stop (see that
    // function below) — reusing the one existing wire path rather than
    // inventing a second one. native-host.js forwards it to whichever
    // conversation currently holds the active browser lease
    // (host/agent/session/manager.js's activeConversationIdForRecording()),
    // or persists it as pending again if none does; see
    // extension/sidepanel/recordings-model.js's file header for the honest
    // limitation this implies.
    if (!nativePort) {
      sendResponse({ ok: false, error: "native_host_unavailable" });
      return true;
    }
    try {
      nativePort.postMessage({
        type: "recording_complete",
        recording_id: String(msg.recording_id ?? ""),
        path: String(msg.path ?? ""),
        schema: String(msg.schema ?? "v0"),
        summary: typeof msg.summary === "string" ? msg.summary : "",
        transcript_status: String(msg.transcript_status ?? "ok")
      });
      sendResponse({ ok: true });
    } catch (e) {
      sendResponse({ ok: false, error: String(e && e.message) });
    }
    return true;
  }
});

// Dedicated panel-attachment byte-transport listener (isolated from the
// large recording/behavior onMessage above so attachment handling never
// interferes with it and vice-versa). Uses panelIdOf(sender) for scoping.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== "string") return;
  if (msg.type === "panelAttachmentAdd") {
    const panelId = panelIdOf(sender);
    const mimeType = String(msg.mimeType || "");
    const base64 = String(msg.base64 || "");
    const explicitId = typeof msg.id === "string" && msg.id ? String(msg.id) : (typeof msg.attachmentId === "string" && msg.attachmentId ? String(msg.attachmentId) : "");
    if (!base64 || !mimeType) { sendResponse({ ok: false, error: "missing_bytes_or_mimeType", reason: "missing_bytes_or_mimeType" }); return true; }
    try {
      const ref = explicitId ? addPanelAttachmentWithId(panelId, explicitId, base64, mimeType) : addPanelAttachment(panelId, base64, mimeType);
      sendResponse({ ok: true, ...ref });
    } catch (e) { sendResponse({ ok: false, error: String(e && e.message || e), reason: String(e && e.message || e) }); }
    return true;
  }
  if (msg.type === "panelAttachmentAddWithId") {
    const panelId = panelIdOf(sender);
    const id = String(msg.id || msg.attachmentId || "");
    const mimeType = String(msg.mimeType || "");
    const base64 = String(msg.base64 || "");
    if (!id || !base64 || !mimeType) { sendResponse({ ok: false, error: "missing_id_or_bytes", reason: "missing_id_or_bytes" }); return true; }
    try { const ref = addPanelAttachmentWithId(panelId, id, base64, mimeType); sendResponse({ ok: true, ...ref }); }
    catch (e) { sendResponse({ ok: false, error: String(e && e.message || e), reason: String(e && e.message || e) }); }
    return true;
  }
  if (msg.type === "panelAttachmentRemove") {
    const panelId = panelIdOf(sender);
    const id = String(msg.id || msg.attachmentId || "");
    if (id) removePanelAttachment(panelId, id);
    sendResponse({ ok: true });
    return true;
  }
  if (msg.type === "panelAttachmentClear") {
    clearPanelAttachments(panelIdOf(sender));
    sendResponse({ ok: true });
    return true;
  }
  if (msg.type === "panelAttachmentSend" || msg.type === "panelAttachmentFlush") {
    const conversationId = String(msg.conversationId || "");
    const ids = Array.isArray(msg.attachmentIds) ? msg.attachmentIds.map(String) : (Array.isArray(msg.ids) ? msg.ids.map(String) : []);
    const panelId = panelIdOf(sender);
    if (!conversationId || !ids.length) { sendResponse({ ok: false, error: "missing_conversationId_or_ids", reason: "missing_conversationId_or_ids" }); return true; }
    if (!nativePort) { sendResponse({ ok: false, error: "native_host_unavailable", reason: "native_host_unavailable" }); return true; }
    (async () => {
      const results = [];
      const sent = [];
      for (const aid of ids) {
        const ok = _sendPanelAttachmentBytes(conversationId, panelId, aid);
        if (!ok) { results.push({ id: aid, ok: false, reason: "missing_bytes_or_native_unavailable" }); continue; }
        const ack = await new Promise((resolve, reject) => {
          const timer = setTimeout(() => { pendingAttachmentAcks.delete(aid); reject(new Error("attachment_ack_timeout")); }, 15000);
          pendingAttachmentAcks.set(aid, { resolve, reject, timer });
        }).then(() => ({ id: aid, ok: true }), (err) => ({ id: aid, ok: false, reason: String(err && err.message || err) }));
        results.push(ack);
        if (ack.ok) sent.push(aid);
      }
      const failed = results.filter(r => !r.ok);
      if (failed.length) sendResponse({ ok: false, error: "attachment_flush_failed", reason: "attachment_flush_failed", results, sent, failed: failed.map(f=>f.id) });
      else sendResponse({ ok: true, results, sent });
    })();
    return true;
  }
});

// Tab + navigation events, captured in the SW so the trace has one-to-one
// parity with OCIC's own commands (navigate, tab focus/create) — not just the
// computer-tool primitives. Each carries the tab's URL so the trace records
// what tab we're in and what the current URL is.
async function recordSwEvent(action, tabId, extra = {}) {
  await recorderReady; // SW may have just woken mid-recording
  if (!recorder.active) return;
  let url = extra.url;
  if (url === undefined && tabId != null && tabId >= 0) {
    try {
      const t = await chrome.tabs.get(tabId);
      url = t && t.url;
    } catch {
      url = undefined;
    }
  }
  chrome.runtime
    .sendMessage({
      __ocic_offscreen: true,
      cmd: "event",
      event: {
        t: Date.now(),
        tab: tabId ?? -1,
        frame: 0,
        action,
        // The core `command` key: the exact OCIC tool input (plus the event's
        // tab as tabId). tab_activated has NO OCIC verb — tools select tabs
        // via their tabId param — so it carries no command, only context.
        command:
          action === "navigate"
            ? { tool: "navigate", input: { url } }
            : action === "tab_opened"
              ? { tool: "tabs_create_mcp", input: {} }
              : action === "tab_closed"
                ? { tool: "tabs_close_mcp", input: {} }
                : undefined,
        url: url || undefined // context enrichment (what URL the tab shows)
      }
    })
    .catch(() => {});
  maybeCapture(); // frame on navigation / tab change (throttled ≤1/sec)
}

// Focus/select a tab → tab_activated (with the URL now showing).
chrome.tabs.onActivated.addListener((info) => recordSwEvent("tab_activated", info.tabId));
// Tabs created moments ago, awaiting the group verdict below: tabId -> the
// epoch ms it was created. Chrome files a tab opened with the new-tab button
// at the end of a group into that group only AFTER onCreated has fired, so
// the decision has to be reachable from the later onUpdated too — but only
// for a tab that genuinely just appeared.
const recentlyCreatedTabs = new Map();
// How long after creation a grouping still counts as part of opening the tab.
const NEW_TAB_GROUPING_WINDOW_MS = 3_000;

/** Record a freshly created tab, dropping any entries that have aged out. */
function noteTabCreated(tabId) {
  const now = Date.now();
  for (const [id, at] of recentlyCreatedTabs) {
    if (now - at > NEW_TAB_GROUPING_WINDOW_MS) recentlyCreatedTabs.delete(id);
  }
  recentlyCreatedTabs.set(tabId, now);
}

/**
 * True if this tab was created within the window above — and forget it either
 * way, so one grouping event per tab is ever judged as part of its creation.
 */
function consumeRecentlyCreated(tabId) {
  const at = recentlyCreatedTabs.get(tabId);
  if (at === undefined) return false;
  recentlyCreatedTabs.delete(tabId);
  return Date.now() - at <= NEW_TAB_GROUPING_WINDOW_MS;
}

/** True only for an empty tab the OPERATOR just opened — the Ctrl+T / new-tab-
 * button case guardInheritedTabGroup() must evict even mid-run. */
async function looksLikeOperatorNewTab(tab) {
  if (!isBlankNewTab(tab)) return false;
  // onCreated (and the onUpdated grouping event, which carries no URL at all)
  // can reach us before Chrome has committed the destination of a tab a PAGE
  // opened, which at that instant is indistinguishable from Ctrl+T. Re-read
  // once: a real destination has landed in url/pendingUrl by now, while the
  // operator's empty tab is still empty.
  try {
    return isBlankNewTab(await chrome.tabs.get(tab.id));
  } catch {
    // Already closed. Nothing to evict, and never guess about a tab that is gone.
    return false;
  }
}

/**
 * Keep the agent's tab group to tabs the agent actually opened.
 *
 * Chrome hands a tab opened from a grouped tab that tab's group, so a link the
 * OPERATOR ctrl-clicks on a page the assistant is driving silently lands in
 * the agent's group. That is not cosmetic: isInGroup()'s legacy branch grants
 * authority by group membership alone (`tab.groupId === tabGroupId`), so an
 * inherited tab of the operator's would become a tab an external MCP client
 * may drive. This puts it straight back where Chrome found it.
 *
 * A tab the AGENT opened this way is kept — a page the assistant clicked that
 * opens its own popup belongs with the rest of its work. The two are told
 * apart by when the tab appeared relative to tool activity; nothing else in
 * the tabs API distinguishes them.
 *
 * Kept tabs join `tabGroupTabs` (bookkeeping for a membership that already
 * grants legacy authority via the group itself) but deliberately NOT
 * `sdkAgentCreatedTabs`: on the SDK path they stay borrowed, so the one
 * irreversible operation — cleanup closing a tab — still only ever touches a
 * tab `tabs_create_mcp` made itself.
 *
 * @param {chrome.tabs.Tab} tab the freshly created tab, as onCreated saw it
 * @returns {Promise<"kept"|"ungrouped"|"ignored">} for tests; unused in situ
 */
async function guardInheritedTabGroup(tab) {
  if (!tab || typeof tab.id !== "number") return "ignored";
  // Ungrouped, or in somebody else's group: not ours to touch either way.
  if (typeof tab.groupId !== "number" || tab.groupId === -1) return "ignored";
  // After a service-worker restart the group id is not known yet, and a tab
  // created in that window would otherwise slip through unexamined.
  // Tabs THIS extension put in the group: opened by ensureTabGroup, created
  // by tabs_create_mcp, or adopted from the operator by the panel. Each of
  // those records the tab before calling chrome.tabs.group(), so the claim is
  // always already on the books by the time the resulting event lands here.
  // The `typeof` guards are the same ones the rest of this file uses for
  // names the standalone test-extraction sandboxes do not declare.
  if (
    tabGroupTabs.has(tab.id) ||
    (typeof sdkAgentCreatedTabs !== "undefined" && sdkAgentCreatedTabs.has(tab.id)) ||
    (typeof adoptedBorrowedTabs !== "undefined" && adoptedBorrowedTabs.has(tab.id))
  ) {
    return "kept";
  }
  if (tabGroupId === null) {
    try {
      await recoverTabGroupState();
    } catch {
      return "ignored";
    }
  }
  // Family-aware membership: the primary group plus every numbered solo group
  // ("Browzy 2", ...) an explicit icon click created. The typeof guards keep
  // this body compilable standalone in the test sandboxes.
  const inPrimary = tabGroupId !== null && tab.groupId === tabGroupId;
  const inSolo = typeof extraAgentGroupIds !== "undefined" && extraAgentGroupIds.has(tab.groupId);
  if (!inPrimary && !inSolo) {
    // Untracked group (e.g. created while the worker was evicted): check the
    // live title before treating it as somebody else's.
    let family = false;
    try {
      if (typeof chrome !== "undefined" && chrome.tabGroups && typeof chrome.tabGroups.get === "function") {
        const liveGroup = await chrome.tabGroups.get(tab.groupId);
        const liveTitle = liveGroup && liveGroup.title;
        family =
          (typeof isAgentFamilyTitle === "function" && isAgentFamilyTitle(liveTitle)) ||
          (typeof LEGACY_TAB_GROUP_TITLES !== "undefined" && LEGACY_TAB_GROUP_TITLES.includes(liveTitle));
      }
    } catch {
      family = false;
    }
    if (!family) return "ignored";
    if (typeof extraAgentGroupIds !== "undefined") extraAgentGroupIds.add(tab.groupId);
  }

  // `typeof` rather than a bare read: this guard is extracted and compiled
  // standalone by test/tab-group-inheritance.test.mjs, where an undeclared name
  // would throw instead of reading as "no tool running". In the real module it
  // is an ordinary closure variable, undefined between dispatches.
  const agentIsDriving =
    typeof currentToolMeta !== "undefined" ||
    Date.now() - lastAgentTabActivityAt <= INHERITED_TAB_GRACE_MS;
  // ...but "the agent is acting right now" is a statement about the AGENT, not
  // about this tab. The operator hitting Ctrl+T (or the + button beside the
  // group) mid-run lands here too, and keeping it swallowed their own tab into
  // the agent's group and, via tabGroupTabs, handed an external MCP client
  // authority over it. An empty new tab is never something the agent opened:
  // everything the agent opens is already claimed above (tabs_create_mcp /
  // ensureTabGroup / adoptBorrowedTab all record the tab before grouping it),
  // and a popup a page opened always carries its destination. This is the same
  // rule adoptBorrowedTab() already applies one screen up — the two paths judge
  // the same situation, so they must judge it the same way.
  if (agentIsDriving && !(await looksLikeOperatorNewTab(tab))) {
    tabGroupTabs.add(tab.id);
    return "kept";
  }

  try {
    await chrome.tabs.ungroup(tab.id);
  } catch {
    // The tab may already be gone, or Chrome may refuse mid-drag. Leaving it
    // grouped is the wrong outcome but not one worth throwing over inside an
    // event listener.
    return "ignored";
  }
  tabGroupTabs.delete(tab.id);
  return "ungrouped";
}

// Open a tab → tab_opened.
chrome.tabs.onCreated.addListener((tab) => {
  recordSwEvent("tab_opened", tab.id, { url: tab.url || tab.pendingUrl });
  noteTabCreated(tab.id);
  guardInheritedTabGroup(tab).catch(() => {});
});
// Close a tab → tab_closed.
chrome.tabs.onRemoved.addListener((tabId) => {
  recordSwEvent("tab_closed", tabId, { url: null });
  audit.onTabRemoved(tabId).catch(() => {});
});
// URL change in a tab (address bar, link, redirect, SPA history) → navigate.
// This is what captures "the current state of the URL" as it changes.
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  // The new-tab button INSIDE a group creates the tab first and files it into
  // the group a moment later, so onCreated sees an ungrouped tab and only this
  // event carries the group. Restricted to tabs that were just created, so a
  // tab the operator deliberately DRAGS into the group later is left alone —
  // dragging is a choice; the new-tab button is not.
  if (changeInfo.groupId !== undefined && consumeRecentlyCreated(tabId)) {
    guardInheritedTabGroup({ id: tabId, groupId: changeInfo.groupId }).catch(() => {});
  }
  if (changeInfo.url) recordSwEvent("navigate", tabId, { url: changeInfo.url });
  // Bumps the action-event schema's best-effort document identity (design.md
  // 5c) on every browser-visible URL change, including SPA history-API
  // navigation the tabs API itself already surfaces here. ALSO bumps on
  // `changeInfo.status === "loading"` (gate-1.1 G0c / tasks.md 1.2's fix for
  // that live defect): Chrome does NOT set `changeInfo.url` for a same-URL
  // reload (the URL string never changes), so that case was previously
  // invisible to this tracker even though gate-1.1's G1 independently
  // confirmed a same-URL reload IS a new document at the browser level.
  const isNavigationSignal = Boolean(changeInfo.url) || changeInfo.status === "loading";
  if (isNavigationSignal) actionDocTracker.bump(tabId);
  // The P0 minimum document binding (design.md decision 6 / tasks.md 1.2):
  // every navigation-start signal invalidates the previously CONFIRMED
  // binding and (unless a matching `beginAuthorizedNavigation()` correlation
  // is live for this tab — see navigate()'s call sites) fires the
  // replacement/invalidation event for a future consumer (groups 2/3/7).
  if (isNavigationSignal) documentBindings.onNavigationSignal(tabId, { url: changeInfo.url || null });
});

// --- Init ---

// Recover MCP tab group state after service worker restart
async function recoverTabGroupState() {
  try {
    let groups = await chrome.tabGroups.query({ title: AGENT_TAB_GROUP_TITLE });
    for (const legacyTitle of LEGACY_TAB_GROUP_TITLES) {
      if (groups.length > 0) break;
      groups = await chrome.tabGroups.query({ title: legacyTitle });
    }
    if (groups.length > 0) {
      tabGroupId = groups[0].id;
      const tabs = await chrome.tabs.query({ groupId: tabGroupId });
      tabGroupTabs = new Set(tabs.map((t) => t.id));
    }
    // Numbered solo groups ("Browzy 2", ...) from earlier sessions: track
    // them, never merge them into the primary group.
    try {
      const all = await chrome.tabGroups.query({});
      for (const g of all || []) {
        if (!g || g.id === tabGroupId) continue;
        if (typeof isAgentFamilyTitle === "function" ? isAgentFamilyTitle(g.title) : g.title === AGENT_TAB_GROUP_TITLE) {
          extraAgentGroupIds.add(g.id);
        }
      }
    } catch {
      // Tracking is best-effort; the live-title checks recover stragglers.
    }
  } catch {
    // Not critical — will be set on first tabs_context_mcp call
  }
}

recoverTabGroupState();
connectNativeHost();
