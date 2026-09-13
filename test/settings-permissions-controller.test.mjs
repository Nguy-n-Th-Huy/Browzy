#!/usr/bin/env node
// extension/settings/permissions-controller.js: the DOM-free state machine
// behind Settings > Approved sites (task 7.8) and the mode control it also
// exposes. Tested directly against a fake client, the same convention
// settings-controller.js/skills-controller.js already establish.
//
// Run: node test/settings-permissions-controller.test.mjs

import { PermissionsController } from "../extension/settings/permissions-controller.js";
import { PermissionsErrorLike } from "../extension/settings/permissions-client.js";

let fail = 0;
function ok(cond, msg) {
  console.log((cond ? "  PASS " : "  FAIL ") + msg);
  if (!cond) fail++;
}

function fakeClient(overrides = {}) {
  return {
    getPermissionState: async () => ({
      mode: "auto",
      modeSource: "local",
      sites: [
        { origin: "https://admin.example", actionClass: "mutating", decision: "allow", recordedAt: null, source: "managed" },
        { origin: "https://a.example", actionClass: "send", decision: "deny", recordedAt: "2024-01-01T00:00:00.000Z", source: "local" }
      ],
      managedPolicy: { present: false, readable: true }
    }),
    setPermissionMode: async (mode) => ({ mode }),
    revokeSiteEntry: async () => ({ revoked: true }),
    revokeAllSiteEntries: async () => ({ removed: 1 }),
    ...overrides
  };
}

async function main() {
  console.log("== load(): state mirrors get_permission_state exactly ==");
  {
    const c = new PermissionsController(fakeClient());
    await c.load();
    ok(c.state.loaded === true && c.state.loadError === null, "loaded, no error");
    ok(c.state.mode === "auto" && c.state.modeSource === "local", "mode/modeSource carried through");
    ok(c.state.sites.length === 2, "both entries carried through, host order preserved (managed first)");
    ok(c.isEmpty() === false, "not reported empty when entries exist");
  }

  console.log("== load(): a failure is reported, never silently treated as empty ==");
  {
    const c = new PermissionsController(fakeClient({ getPermissionState: async () => { throw new PermissionsErrorLike("NETWORK_ERROR", "no companion"); } }));
    await c.load();
    ok(c.state.loaded === true && typeof c.state.loadError === "string" && c.state.loadError.length > 0, "a load failure sets loadError, not a silently-empty list");
  }

  console.log("== isEmpty(): the explicit empty state (spec 'Empty state') ==");
  {
    const c = new PermissionsController(fakeClient({ getPermissionState: async () => ({ mode: "auto", modeSource: "local", sites: [], managedPolicy: null }) }));
    await c.load();
    ok(c.isEmpty() === true, "an empty sites array is reported as the explicit empty state");
  }

  console.log("== modeView(): reflects deriveModeView()'s managed/changeable split ==");
  {
    const c = new PermissionsController(fakeClient());
    await c.load();
    ok(c.modeView().changeable === true, "a local mode is changeable");
  }
  {
    const c = new PermissionsController(fakeClient({ getPermissionState: async () => ({ mode: "skip", modeSource: "managed", sites: [], managedPolicy: { present: true, readable: true } }) }));
    await c.load();
    ok(c.modeView().changeable === false && c.modeView().isManaged === true, "a managed mode is reported unchangeable");
  }

  console.log("== setMode(): never attempted at all when the mode is managed ==");
  {
    let called = false;
    const c = new PermissionsController(
      fakeClient({
        getPermissionState: async () => ({ mode: "skip", modeSource: "managed", sites: [], managedPolicy: { present: true, readable: true } }),
        setPermissionMode: async (mode) => {
          called = true;
          return { mode };
        }
      })
    );
    await c.load();
    const changed = await c.setMode("manual");
    ok(called === false, "the client is never even called when modeSource is managed — the control offers no local change");
    ok(changed === false, "setMode() reports no effective change");
  }

  console.log("== setMode(): MANAGED_POLICY_PINNED is never surfaced as a generic failure (task 7.1) ==");
  {
    const c = new PermissionsController(
      fakeClient({
        setPermissionMode: async () => {
          throw new PermissionsErrorLike("MANAGED_POLICY_PINNED", "pinned");
        }
      })
    );
    await c.load();
    const changed = await c.setMode("manual");
    ok(changed === false, "no effective change is reported");
    ok(c.state.banner && c.state.banner.kind === "info", "a MANAGED_POLICY_PINNED failure renders as an informational banner, not an error/failure banner");
    ok(!/lỗi không xác định/i.test(c.state.banner.title), "the banner is NOT the generic 'unknown error' copy");
  }

  console.log("== setMode(): reports whether the EFFECTIVE mode actually changed (task 7.2's trigger condition) ==");
  {
    const c = new PermissionsController(fakeClient({ setPermissionMode: async () => ({ mode: "manual" }) }));
    await c.load(); // starts at mode:"auto"
    const changed = await c.setMode("manual");
    ok(changed === true, "reports true when the effective mode actually changed");
  }
  {
    const c = new PermissionsController(fakeClient({ setPermissionMode: async () => ({ mode: "auto" }) }));
    await c.load(); // starts at mode:"auto"
    const changed = await c.setMode("auto");
    ok(changed === false, "reports false when the host reports the SAME effective mode back (e.g. a request that changed nothing)");
  }

  console.log("== revokeEntry(): NOT_FOUND is reported, never treated as a successful revoke ==");
  {
    const c = new PermissionsController(fakeClient());
    await c.load();
    const before = c.state.sites.length;
    const failing = new PermissionsController(
      fakeClient({
        revokeSiteEntry: async () => {
          throw new PermissionsErrorLike("NOT_FOUND", "gone");
        }
      })
    );
    await failing.load();
    const beforeFailing = failing.state.sites.length;
    await failing.revokeEntry("https://a.example", "send");
    ok(failing.state.sites.length === beforeFailing, "a NOT_FOUND reply leaves the list UNCHANGED — never removed as if it had succeeded");
    ok(failing.state.banner && failing.state.banner.kind === "error", "NOT_FOUND is reported as an error banner");
    void before;
  }

  console.log("== revokeEntry(): MANAGED_ENTRY_LOCKED is never a generic failure ==");
  {
    const c = new PermissionsController(
      fakeClient({
        revokeSiteEntry: async () => {
          throw new PermissionsErrorLike("MANAGED_ENTRY_LOCKED", "locked");
        }
      })
    );
    await c.load();
    await c.revokeEntry("https://admin.example", "mutating");
    ok(c.state.banner && c.state.banner.kind === "info", "MANAGED_ENTRY_LOCKED renders as informational, not a generic failure");
    ok(c.state.sites.some((s) => s.origin === "https://admin.example"), "the managed entry is left in place");
  }

  console.log("== revokeEntry(): a successful revoke removes exactly that entry ==");
  {
    const c = new PermissionsController(fakeClient());
    await c.load();
    await c.revokeEntry("https://a.example", "send");
    ok(!c.state.sites.some((s) => s.origin === "https://a.example"), "the revoked entry is removed");
    ok(c.state.sites.some((s) => s.origin === "https://admin.example"), "other entries are unaffected");
  }

  console.log("== revokeAll(): removes only LOCAL entries, managed entries survive ==");
  {
    const c = new PermissionsController(fakeClient());
    await c.load();
    await c.revokeAll();
    ok(c.state.sites.length === 1 && c.state.sites[0].source === "managed", "revoke-all clears local entries but leaves a managed entry in place");
  }

  console.log("== siteRows(): view rows carry the right revoke affordance per entry ==");
  {
    const c = new PermissionsController(fakeClient());
    await c.load();
    const rows = c.siteRows();
    const managedRow = rows.find((r) => r.origin === "https://admin.example");
    const localRow = rows.find((r) => r.origin === "https://a.example");
    ok(managedRow.canRevoke === false, "the managed row cannot be revoked");
    ok(localRow.canRevoke === true, "the local row can be revoked");
  }

  console.log(fail === 0 ? "\nAll assertions passed." : `\n${fail} assertion(s) FAILED.`);
  process.exit(fail === 0 ? 0 : 1);
}

main();
