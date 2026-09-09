// Per-session skill workspace: what group 3's session/query() builder
// actually consumes.
//
// buildSessionSkills() COPIES the current enabled+approved snapshots into
// the session's own private materialized plugin directory once, at session
// build time. This is deliberate, not incidental: it is what makes "a
// refresh during an active run leaves that run on its existing snapshot"
// true without any extra bookkeeping - the run never reads the shared
// snapshots/ store again after this call, so a later refreshSkill()
// overwriting the shared store cannot reach back into an already-built
// session workspace. A later buildSessionSkills() call (a new conversation)
// naturally picks up the refreshed content because it re-copies from the
// shared store at that later point in time.
//
// design.md decision 9 (superseding decision 7, kept in full there for the
// record): this module used to materialize snapshots directly under
// `${sessionWorkspaceDir}/.claude/skills/`, on the theory that adding
// `'project'` to `settingSources` would make the SDK discover that tree.
// A real, unmocked `query()` proved `'project'` walks the ENTIRE ancestor
// directory tree with no repo-root gating at all - on a real installation
// this would have exposed the operator's whole global `~/.claude/skills/`
// collection (189 skills, independently verified) to every conversation.
// See plans/reports/blocker-260909-0712-project-settingsource-walkup-leak.md
// and host/test/skills-scope-verification.test.mjs for the executable proof.
//
// The replacement: materialize the same approved snapshots as a LOCAL
// PLUGIN - the same mechanism this repository already ships itself as
// (host/.claude-plugin/plugin.json) - and load it by absolute, explicit path
// via the SDK's `plugins` option (host/agent/tools/query-options.js),
// `settingSources` staying `[]` throughout. `plugins` has no ancestor
// walk-up: it loads exactly the directory named, proven by
// host/test/skills-plugin-scope-verification.test.mjs's real `query()` run.

import fs from "node:fs";
import path from "node:path";
import { listCatalog } from "./manage.js";
import { snapshotDir } from "./paths.js";
import { SkillPathError } from "./errors.js";
import { toSkillOverrideValue } from "./capabilities.js";

// Fixed, application-owned plugin name for every session's materialized
// skill plugin - NEVER derived per conversation/run. A per-run name would
// make the qualified canonical name (see qualifiedSkillName() below) a
// moving target dispatch.js's buildSkillDispatchPrompt() could never predict
// ahead of the SDK actually reporting it in a `system`/`init` message.
export const SESSION_SKILLS_PLUGIN_NAME = "ocic-session-skills";

// Empirical finding (design.md decision 9, host/test/skills-plugin-scope-
// verification.test.mjs's spike): a skill loaded through a plugin is
// reported by the real SDK under its PLUGIN-QUALIFIED canonical name -
// "<plugin-name>:<skill-name>" - never the bare directory name, in the real
// `system`/`init` message's `skills` array. This settles a real contradiction
// between two doc sites in the pinned SDK's sdk.d.ts (~2094 implies a bare
// name matches; ~4010 documents "the exact canonical name (e.g.
// 'my-plugin:my-skill') or a ':name' suffix of it") in favour of the
// qualified form - chosen over the ':name'-suffix alternative because it is
// the exact string the SDK itself was observed emitting, requiring no
// separate assumption about suffix-matching behavior.
function qualifiedSkillName(name) {
  return `${SESSION_SKILLS_PLUGIN_NAME}:${name}`;
}

// The reverse of qualifiedSkillName(): strips the plugin-qualification
// prefix when present, otherwise returns the input unchanged. Used only by
// assertCanonicalSkillResourcePath() below to recover the PHYSICAL on-disk
// directory name (always the bare skill name - qualification is an SDK-
// facing naming concept, never a filesystem one) from a caller-supplied
// allowedSkillNames entry that may now be qualified.
function bareSkillName(name) {
  const prefix = `${SESSION_SKILLS_PLUGIN_NAME}:`;
  return typeof name === "string" && name.startsWith(prefix) ? name.slice(prefix.length) : name;
}

/**
 * Writes the minimal plugin manifest this session's materialized skill
 * plugin needs, mirroring host/.claude-plugin/plugin.json's required shape
 * (name/version/description). Deliberately carries no `mcpServers` field -
 * this plugin never owns any MCP connection, and query-options.js's
 * `skipMcpDiscovery: true` on the `plugins` entry makes that explicit rather
 * than relying on the manifest's mere omission.
 */
function writePluginManifest(pluginDir) {
  const manifestDir = path.join(pluginDir, ".claude-plugin");
  fs.mkdirSync(manifestDir, { recursive: true });
  fs.writeFileSync(
    path.join(manifestDir, "plugin.json"),
    JSON.stringify(
      {
        name: SESSION_SKILLS_PLUGIN_NAME,
        version: "1.0.0",
        description:
          "Materialized, per-conversation skill snapshots for this application's session workspace. Generated automatically by buildSessionSkills(); never user-authored, never hand-edited."
      },
      null,
      2
    ) + "\n"
  );
}

function isWithin(root, target) {
  if (target === root) return true;
  const rel = path.relative(root, target);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function copyDirRecursive(srcDir, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const s = path.join(srcDir, entry.name);
    const d = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(s, d);
    } else if (entry.isFile()) {
      fs.copyFileSync(s, d);
    }
    // Snapshots never contain symlinks or other file types - source-scan.js
    // already dereferenced every symlink and rejected anything else at
    // import time - so there is nothing else to handle here.
  }
}

/**
 * Shared plugin-materialization loop: copies each of `skillEntries` (catalog-
 * shaped objects — {name, snapshotId, userInvocable, modelInvocable, ...})
 * into a LOCAL PLUGIN under `${sessionWorkspaceDir}` (a
 * `.claude-plugin/plugin.json` manifest plus a `skills/` subdirectory) and
 * returns the SDK query() option fragments this materialization produces.
 * Used by both `buildSessionSkills()` (a fresh binding, `skillEntries` from
 * the LIVE catalog) and `materializePluginFromCatalogSnapshot()` (a backfill
 * for an existing binding, `skillEntries` from that binding's OWN already-
 * pinned `catalogSnapshot` — never the live catalog; see that function's own
 * docstring for why that distinction is what keeps a backfill from being a
 * refresh).
 *
 * `allowedSkillNames` maps to the SDK's `skills` query() option (the real
 * enable/disable gate - "unlisted skills are hidden from the model's
 * listing and rejected by the Skill tool", `sdk.d.ts:2108` on the pinned
 * 0.3.263 package) - now carrying each skill's PLUGIN-QUALIFIED canonical
 * name (see qualifiedSkillName() above), the form the SDK was empirically
 * observed to require. `skillOverrides` maps to the SDK's `skillOverrides`
 * query() option (`sdk.d.ts:5979`) - a presentation-only per-skill listing
 * hint, layered on top of `skills` - and is keyed by the same qualified name
 * for consistency, since it is "keyed by skill name" and the skill's actual
 * name, once loaded through a plugin, IS the qualified form; a mismatch here
 * would silently degrade to the "on" fallback rather than break anything,
 * but qualifying it keeps the override's intent effective. Neither is
 * treated as authoritative by this codebase: `catalogSnapshot` (this
 * application's own data, always BARE names - it is never SDK-facing) is
 * what assertSlashDispatchAllowed() actually checks, per the SDK's own
 * documented warning that `skills` "is a context filter, not a sandbox...
 * their files remain on disk and are reachable via Read/Bash" - exactly why
 * this module copies only approved snapshots into the session's own plugin
 * directory in the first place, rather than trusting the SDK option alone.
 */
function materializeSkillsPlugin(sessionWorkspaceDir, skillEntries) {
  const pluginDir = path.join(sessionWorkspaceDir, "skills-plugin");
  const skillsDir = path.join(pluginDir, "skills");
  fs.mkdirSync(skillsDir, { recursive: true });
  writePluginManifest(pluginDir);

  const allowedSkillNames = [];
  const catalogSnapshot = [];
  const skillOverrides = {};
  for (const skill of skillEntries) {
    const src = snapshotDir(skill.snapshotId);
    if (!fs.existsSync(src)) {
      // Catalog says enabled but the on-disk snapshot is missing (e.g. the
      // snapshot directory was deleted out from under the catalog). Skip
      // rather than fail the whole session - the skill simply will not be
      // available in this run, and it will not appear in allowedSkillNames
      // or catalogSnapshot, so assertSlashDispatchAllowed correctly treats
      // it as unknown.
      continue;
    }
    // The PHYSICAL directory name stays bare (skill.name) - qualification is
    // an SDK-facing canonical-naming concept, not a filesystem one, and the
    // plugin's own `name` (from writePluginManifest above) is what supplies
    // the qualifying prefix when the SDK reports this skill.
    const dest = path.join(skillsDir, skill.name);
    copyDirRecursive(src, dest);
    const qualifiedName = qualifiedSkillName(skill.name);
    allowedSkillNames.push(qualifiedName);
    skillOverrides[qualifiedName] = toSkillOverrideValue(skill.userInvocable, skill.modelInvocable);
    // Deep-cloned so a later in-memory mutation of the live catalog (or of
    // the caller's own input array) can never retroactively change what this
    // already-built session believes its bound snapshot looked like.
    catalogSnapshot.push(JSON.parse(JSON.stringify(skill)));
  }

  return { pluginDir, skillsDir, allowedSkillNames, catalogSnapshot, skillOverrides };
}

/**
 * Materializes only enabled, capability-approved skill snapshots as a LOCAL
 * PLUGIN under `${sessionWorkspaceDir}` and returns the SDK query() option
 * fragments group 3's session builder needs, plus the plugin's own absolute
 * path for host/agent/tools/query-options.js's `plugins` option. See
 * `materializeSkillsPlugin()` above for the shared copy/qualify logic this
 * delegates to.
 *
 * Also materializes this session's own isolated Claude Code CLI config
 * directory (`configDir`, `${sessionWorkspaceDir}/claude-config/`) and
 * returns it alongside the plugin fields. `query-options.js`'s
 * `buildIsolatedOptions()` requires it and sets `CLAUDE_CONFIG_DIR` to it in
 * the isolated `env` it builds for `query()`. Without an explicit
 * `CLAUDE_CONFIG_DIR`, the installed SDK's bundled CLI subprocess falls back
 * to `path.join(homedir(), ".claude")` (confirmed by reading the installed
 * `sdk.mjs`) and writes real session `.jsonl` files into the OPERATOR's own
 * `~/.claude/projects/<encoded-cwd>/`, interleaved with their real Claude
 * Code CLI history — a real, reproduced isolation leak (see this change's
 * Part A evidence report), the write-path counterpart of decision 9's
 * read-path `settingSources` leak this file's own header already documents.
 * Scoping it per session workspace (rather than one shared directory for the
 * whole product) also means a session id minted under one conversation's
 * `CLAUDE_CONFIG_DIR` can never be found by a `resume` call issued under a
 * different conversation's `configDir` — the on-disk session store is keyed
 * by `(CLAUDE_CONFIG_DIR, encoded cwd)`, so this is a real, load-bearing
 * isolation property for any future SDK-`resume` use, not merely tidiness.
 *
 * @param {string} sessionWorkspaceDir
 * @returns {Promise<{ skillsDir: string, pluginDir: string, configDir: string, allowedSkillNames: string[], catalogSnapshot: object[], skillOverrides: Record<string, string> }>}
 */
export async function buildSessionSkills(sessionWorkspaceDir) {
  const catalog = await listCatalog();
  const approved = catalog.filter(
    (s) => s.enabled === true && (!s.unsupportedCapabilities || s.unsupportedCapabilities.length === 0)
  );

  const { pluginDir, skillsDir, allowedSkillNames, catalogSnapshot, skillOverrides } = materializeSkillsPlugin(
    sessionWorkspaceDir,
    approved
  );

  // This session's own isolated Claude Code CLI config directory — see the
  // docstring above. Created eagerly (mirroring the plugin dir above) so it
  // always exists by the time buildIsolatedOptions() reads it, even for a
  // session with zero approved skills.
  const configDir = path.join(sessionWorkspaceDir, "claude-config");
  fs.mkdirSync(configDir, { recursive: true });

  return { skillsDir, pluginDir, configDir, allowedSkillNames, catalogSnapshot, skillOverrides };
}

/**
 * Backfill path for a skills binding persisted before plugin materialization
 * existed at all (no `pluginDir` on the persisted binding — see
 * host/agent/companion.js's `_bindSkillsForRun()`, and this change's own
 * conversation-metadata census: real, already-persisted conversations on
 * disk with this exact pre-plugin shape). Rebuilds the plugin directory from
 * the binding's OWN already-pinned `catalogSnapshot` — deliberately NEVER
 * calls `listCatalog()` itself, unlike `buildSessionSkills()` above. That is
 * what makes this a backfill of already-recorded data rather than a refresh
 * against the live catalog store: it recreates on disk the exact same frozen
 * selection this conversation was already bound to, it does not pick a new
 * one — preserving the "a refresh during an active run leaves that run on
 * its existing snapshot" guarantee `buildSessionSkills()`'s own file header
 * documents. A skill snapshot that no longer exists on disk is skipped,
 * exactly like a fresh `buildSessionSkills()` call already tolerates.
 *
 * Returns fresh `pluginDir`/`skillsDir`/`allowedSkillNames`/`skillOverrides`
 * — the caller must overwrite the binding's own copies of all four fields
 * with these (never just add `pluginDir` alongside the OLD, unqualified
 * `allowedSkillNames`/`skillOverrides`/`skillsDir`: those were computed
 * before plugin-qualification existed and would silently mismatch what the
 * SDK now reports once this skill is loaded through a plugin — see
 * `materializeSkillsPlugin()`'s own docstring on why the qualified form is
 * required). `catalogSnapshot` itself is untouched by the caller — it is not
 * returned here because it does not change.
 *
 * @param {string} sessionWorkspaceDir - the binding's own `cwd`.
 * @param {object[]} catalogSnapshot - the binding's own already-pinned
 *   `catalogSnapshot` (never the live catalog).
 * @returns {{ pluginDir: string, skillsDir: string, allowedSkillNames: string[], skillOverrides: Record<string, string> }}
 */
export function materializePluginFromCatalogSnapshot(sessionWorkspaceDir, catalogSnapshot) {
  const { pluginDir, skillsDir, allowedSkillNames, skillOverrides } = materializeSkillsPlugin(
    sessionWorkspaceDir,
    Array.isArray(catalogSnapshot) ? catalogSnapshot : []
  );
  return { pluginDir, skillsDir, allowedSkillNames, skillOverrides };
}

/**
 * Canonical-path enforcement for a Read into a session's materialized skill
 * snapshot: re-checked at every access, not only at import
 * (specs/agent-skills.md's non-negotiable boundary). Group 3's Read tool
 * handler is expected to call this before serving any skill-resource read.
 *
 * @param {string} skillsDir - the `skillsDir` returned by buildSessionSkills()
 *   (now the plugin's own `skills/` subdirectory - see that function's
 *   updated docstring)
 * @param {string[]} allowedSkillNames - the `allowedSkillNames` returned by
 *   buildSessionSkills() for the SAME session (so a name that was valid at
 *   session-build time but has since been removed/disabled is still allowed
 *   for reads within this already-bound run - see design.md's
 *   run/snapshot-binding rule; a NEW session simply never gets it
 *   materialized). Entries may be plugin-qualified
 *   ("${SESSION_SKILLS_PLUGIN_NAME}:name") or bare - this function normalizes
 *   either form before comparing against the PHYSICAL on-disk directory
 *   name, which is always bare (see bareSkillName() above and
 *   buildSessionSkills()'s note that qualification is an SDK-facing naming
 *   concept, never a filesystem one). The boundary strength itself
 *   (canonical resolution, symlink re-check, exact skill-name membership) is
 *   unchanged by this normalization - it only tolerates a caller passing
 *   either name form for the same physical skill.
 * @param {string} requestedPath - absolute or skillsDir-relative path
 * @returns {string} the canonical (fully resolved) absolute path, safe to read
 */
export function assertCanonicalSkillResourcePath(skillsDir, allowedSkillNames, requestedPath) {
  let canonicalSkillsDir;
  try {
    canonicalSkillsDir = fs.realpathSync(skillsDir);
  } catch {
    throw new SkillPathError("NOT_FOUND", `Session skills directory does not exist: ${skillsDir}`);
  }

  const resolved = path.resolve(canonicalSkillsDir, requestedPath);
  if (!isWithin(canonicalSkillsDir, resolved)) {
    throw new SkillPathError(
      "PATH_TRAVERSAL",
      `Path "${requestedPath}" resolves outside the session skills directory.`
    );
  }

  const rel = path.relative(canonicalSkillsDir, resolved);
  const topSegment = rel.split(path.sep)[0];
  const bareAllowedNames = (Array.isArray(allowedSkillNames) ? allowedSkillNames : []).map(bareSkillName);
  if (!bareAllowedNames.includes(topSegment)) {
    throw new SkillPathError(
      "PATH_TRAVERSAL",
      `Path "${requestedPath}" does not belong to an enabled skill in this session.`
    );
  }

  let canonicalTarget;
  try {
    canonicalTarget = fs.realpathSync(resolved);
  } catch {
    throw new SkillPathError("NOT_FOUND", `Path "${requestedPath}" does not exist in the session skill snapshot.`);
  }
  // Re-check after following any remaining link/junction in the resolved
  // path itself - the snapshot should never contain one (see
  // copyDirRecursive's note above), but a Read handler must never rely on
  // that invariant alone.
  if (!isWithin(canonicalSkillsDir, canonicalTarget)) {
    throw new SkillPathError(
      "SYMLINK_ESCAPE",
      `Path "${requestedPath}" resolves outside the session skills directory after following links.`
    );
  }

  return canonicalTarget;
}
