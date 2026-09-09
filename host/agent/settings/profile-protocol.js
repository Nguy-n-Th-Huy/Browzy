// Settings CRUD/select protocol over the named-profile backend (task 9.2).
//
// A pure op-dispatch seam between the extension relay
// (extension/background.js + host/agent/protocol.js — both dirty and owned
// by a parallel session) and host/agent/settings/named-profiles.js. The
// relay's job is transport only: parse the envelope, call
// dispatchProfileCollectionOp(op, payload, deps), and serialize the
// `{ ok, result } / { ok: false, error }` shape back. Every op here:
//
//   - takes only profile id/model id plus nonsecret fields — selection sends
//     never reconstruct historical credentials;
//   - stores runtime credentials only in the OS store (or an explicitly
//     labeled memory-only mode) via named-profiles.js; nothing returned here
//     ever contains a secret (assertSecretFree() scans outbound results in
//     tests and, defensively, at runtime for the credential-bearing ops);
//   - maps storage/validation failures to stable `{ code, message }`
//     errors; secure-storage unavailability surfaces as
//     SECURE_STORAGE_UNAVAILABLE with a memory-only hint, never a silent
//     plaintext fallback;
//   - answers unknown ops/versions with UPDATE_REQUIRED so stale peers get
//     an explicit update error instead of a weaker legacy path (migration
//     plan §4).
//
// Supported ops (v1):
//   list_profiles | get_profile | create_profile | update_profile |
//   delete_profile | select_profile | get_selected |
//   set_credential | remove_credential |
//   test_capability | discover_models | export_profile

import {
  listProfiles,
  getProfile,
  getSelectedProfile,
  getSelectedProfileId,
  createProfile,
  updateProfile,
  selectProfile,
  deleteProfile,
  setCredential,
  removeCredential,
  testCapability,
  refreshDiscoveredModels,
  exportProfileRedacted,
  isRunnable,
  NamedProfileError
} from "./named-profiles.js";
import { SecureStorageUnavailableError } from "../secrets/secret-store.js";

export const PROFILE_COLLECTION_PROTOCOL_VERSION = 1;

const KNOWN_OPS = new Set([
  "list_profiles",
  "get_profile",
  "create_profile",
  "update_profile",
  "delete_profile",
  "select_profile",
  "get_selected",
  "set_credential",
  "remove_credential",
  "test_capability",
  "discover_models",
  "export_profile"
]);

function err(code, message, extra) {
  return { ok: false, error: { code, message, ...(extra || {}) } };
}

function ok(result) {
  return { ok: true, result };
}

/**
 * Defensive outbound scan: no result leaving this layer may carry a raw
 * credential field. The store never persists secrets, so this is a second
 * layer, not the only one — but a second layer that fails closed.
 */
export function assertSecretFree(value, secretHint) {
  let found = false;
  const visit = (node) => {
    if (found || node === null || node === undefined) return;
    if (typeof node === "string") {
      if (secretHint && node === secretHint) found = true;
      return;
    }
    if (typeof node !== "object") return;
    for (const key of Object.keys(node)) {
      if (/^(secret|apiKey|api_key|credential)$/i.test(key)) {
        found = true;
        return;
      }
      visit(node[key]);
    }
  };
  visit(value);
  if (found) throw new Error("profile protocol refused to emit a secret-bearing result");
  return true;
}

function mapError(command, error) {
  if (error instanceof NamedProfileError) return err(error.code, error.message);
  if (error instanceof SecureStorageUnavailableError) {
    return err("SECURE_STORAGE_UNAVAILABLE", `${error.message} — retry with memoryOnly:true for an explicitly labeled memory-only credential, which is never written to application persistence.`);
  }
  const code = (error && error.code) || "PROFILE_OP_FAILED";
  return err(code, (error && error.message) || `profile op "${command}" failed`);
}

/**
 * Dispatch one settings-collection op. `deps` lets tests inject doubles for
 * the network-bearing ops (test_capability, discover_models) without
 * touching the network:
 *   { capabilityRunner, discoveryRunner }
 *
 * @param {string} op
 * @param {object} [payload]
 * @param {{ capabilityRunner?: Function, discoveryRunner?: Function }} [deps]
 * @returns {Promise<{ ok: true, result: unknown } | { ok: false, error: { code: string, message: string } }>}
 */
export async function dispatchProfileCollectionOp(op, payload = {}, deps = {}) {
  const body = payload && typeof payload === "object" ? payload : {};
  if (!KNOWN_OPS.has(op)) {
    return err(
      "UPDATE_REQUIRED",
      `unknown settings op "${op}" (protocol v${PROFILE_COLLECTION_PROTOCOL_VERSION}) — the companion requires an update; no legacy fallback is attempted.`,
      { updateRequired: true }
    );
  }
  try {
    switch (op) {
      case "list_profiles": {
        const profiles = listProfiles();
        assertSecretFree(profiles);
        return ok({ profiles, selectedProfileId: getSelectedProfileId() });
      }
      case "get_selected": {
        const profile = getSelectedProfile();
        if (profile) assertSecretFree(profile);
        return ok({ profile });
      }
      case "get_profile": {
        const profile = getProfile(body.profileId);
        if (!profile) return err("PROFILE_NOT_FOUND", `no profile named "${body.profileId}"`);
        assertSecretFree(profile);
        return ok({ profile });
      }
      case "create_profile": {
        const profile = createProfile({
          profileId: body.profileId,
          baseUrl: body.baseUrl,
          models: body.models,
          defaultModelId: body.defaultModelId
        });
        assertSecretFree(profile);
        return ok({ profile, selectedProfileId: getSelectedProfileId() });
      }
      case "update_profile": {
        const profile = updateProfile(body.profileId, {
          ...(body.baseUrl !== undefined ? { baseUrl: body.baseUrl } : {}),
          ...(body.models !== undefined ? { models: body.models } : {}),
          ...(body.defaultModelId !== undefined ? { defaultModelId: body.defaultModelId } : {})
        });
        assertSecretFree(profile);
        return ok({ profile });
      }
      case "delete_profile": {
        const outcome = await deleteProfile(body.profileId);
        return ok(outcome);
      }
      case "select_profile": {
        const profile = selectProfile(body.profileId);
        assertSecretFree(profile);
        return ok({ profile, selectedProfileId: profile.profileId });
      }
      case "set_credential": {
        if (typeof body.secret !== "string" || !body.secret.trim()) {
          return err("INVALID_PROFILE", "credential must be a nonempty string");
        }
        const outcome = await setCredential(body.profileId, body.secret, {
          memoryOnly: body.memoryOnly === true
        });
        // The raw secret is never echoed back; the reply carries only the
        // backend label so the UI can show "key saved (OS store)".
        assertSecretFree(outcome, body.secret);
        return ok(outcome);
      }
      case "remove_credential": {
        await removeCredential(body.profileId);
        return ok({ removed: body.profileId });
      }
      case "test_capability": {
        const runner = deps.capabilityRunner || testCapability;
        const result = await runner(body.profileId, body.modelId, deps.capabilityRunnerOpts || {});
        assertSecretFree(result);
        const runnable = await isRunnable(body.profileId, body.modelId);
        return ok({ result, runnable });
      }
      case "discover_models": {
        const runner = deps.discoveryRunner || refreshDiscoveredModels;
        const result = await runner(body.profileId);
        assertSecretFree(result);
        return ok(result);
      }
      case "export_profile": {
        const exported = exportProfileRedacted(body.profileId);
        if (!exported) return err("PROFILE_NOT_FOUND", `no profile named "${body.profileId}"`);
        assertSecretFree(exported);
        return ok({ profile: exported });
      }
      /* c8 ignore next 2 — exhaustive switch over KNOWN_OPS above */
      default:
        return err("UPDATE_REQUIRED", `unsupported settings op "${op}"`, { updateRequired: true });
    }
  } catch (error) {
    return mapError(op, error);
  }
}
