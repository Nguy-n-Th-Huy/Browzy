// What a skill is allowed to ask for.
//
// Skills are reusable instructions and resources, not extra authority
// (design.md section 7 / specs/agent-skills). The only tool a skill package
// may need beyond the Skill tool itself is read access to its own snapshot
// and session artifacts - never Bash, Write, Edit, or any other
// host-execution/write surface. A skill flagged as needing more than that
// can never be enabled (see manage.js's enableSkill), which is how "a skill
// requiring host shell execution or writes must produce an explicit
// unsupported-capability error - never silently enable shell access" is
// enforced at the catalog layer.
//
// Verified against the pinned SDK (`@anthropic-ai/claude-agent-sdk@0.3.263`,
// read directly from `host/node_modules/@anthropic-ai/claude-agent-sdk`):
// `sdk.d.ts` defines no `allowed-tools`/`allowed_tools` SKILL.md frontmatter
// field anywhere (grep across the whole package: zero hits). There is no
// SDK-defined, per-package way for a skill to self-declare a tool
// requirement at all - `grep -rn "allowed-tools\|allowed_tools"` across the
// installed package returns nothing. So capability detection here does NOT
// depend on any single frontmatter key being present or absent:
//
//   1. computeDeclaredCapabilities() still reads an optional `allowed-tools`
//      frontmatter key IF a package happens to carry one - this is a real
//      convention used by some skill packages in the wild, so a package
//      that sets it gets a specific, actionable rejection reason. Its
//      ABSENCE is normal, not an error and not evidence of anything.
//   2. detectContentCapabilities() is the actual, unconditional gate: it
//      inspects the package's real files (script-like extensions, a
//      shebang line, a POSIX executable bit) regardless of what any
//      frontmatter claims. A package cannot obtain shell/write capability
//      by simply omitting `allowed-tools` - see
//      host/test/skills-catalog.test.mjs's "no tools frontmatter" case.
//
// import.js merges both signals into one `unsupportedCapabilities` list on
// the catalog record.

import fs from "node:fs";

export const SUPPORTED_SKILL_TOOLS = new Set(["Read", "Skill"]);

// Tool grants are sometimes scoped, e.g. "Bash(git:*)" - only the leading
// tool name matters for this check.
export function baseToolName(entry) {
  const m = /^([A-Za-z]+)/.exec(String(entry).trim());
  return m ? m[1] : String(entry).trim();
}

// Signal 1: an optional, tolerated (not SDK-verified) `allowed-tools`
// frontmatter declaration.
export function computeDeclaredCapabilities(allowedTools) {
  if (!Array.isArray(allowedTools) || allowedTools.length === 0) return [];
  const unsupported = new Set();
  for (const entry of allowedTools) {
    const base = baseToolName(entry);
    if (!SUPPORTED_SKILL_TOOLS.has(base)) unsupported.add(base);
  }
  return [...unsupported];
}

// Signal 2: structural evidence in the package's actual files, independent
// of any frontmatter claim. Intentionally conservative (biased toward
// flagging): a false positive just means a legitimate reference script
// needs a product-level override later (task 7.3, out of scope here); a
// false negative would mean a shell-requiring skill silently gets enabled,
// which is the actual security failure this exists to prevent.
const SCRIPT_EXTENSIONS = new Map([
  [".sh", "shell-script"],
  [".bash", "shell-script"],
  [".zsh", "shell-script"],
  [".ps1", "windows-script"],
  [".psm1", "windows-script"],
  [".cmd", "windows-script"],
  [".bat", "windows-script"],
  [".vbs", "windows-script"],
  [".py", "python-script"],
  [".rb", "ruby-script"],
  [".pl", "perl-script"],
  [".exe", "executable"],
  [".com", "executable"],
  [".msi", "executable"]
]);

/**
 * @param {Array<{ rel: string, sourceAbs: string }>} files - exactly the
 *   shape source-scan.js's scanSkillSource() produces: a validated relative
 *   path plus the real absolute file to read (already symlink-resolved).
 *   Only ever read, never executed.
 */
export function detectContentCapabilities(files) {
  const flags = new Set();
  for (const f of files) {
    const ext = extname(f.rel);
    const known = SCRIPT_EXTENSIONS.get(ext);
    if (known) {
      flags.add(`content:${known}(${f.rel})`);
      continue;
    }
    // Extensionless scripts are still real scripts - sniff a shebang line.
    if (looksLikeShebang(f.sourceAbs)) {
      flags.add(`content:shebang-script(${f.rel})`);
    }
  }
  return [...flags];
}

function extname(rel) {
  const base = rel.split("/").pop();
  const idx = base.lastIndexOf(".");
  return idx <= 0 ? "" : base.slice(idx).toLowerCase();
}

function looksLikeShebang(absPath) {
  let fd;
  try {
    fd = fs.openSync(absPath, "r");
    const buf = Buffer.alloc(2);
    const n = fs.readSync(fd, buf, 0, 2, 0);
    return n === 2 && buf[0] === 0x23 && buf[1] === 0x21; // "#!"
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }
}

/**
 * Maps this catalog's own (product-owned, not SDK-defined) userInvocable /
 * modelInvocable flags onto the SDK's real `skillOverrides` per-skill value
 * (`sdk.d.ts:5979` on the pinned 0.3.263 package: 'on' | 'name-only' |
 * 'user-invocable-only' | 'off', "Absent = on").
 *
 * The SDK's four values do not cover all four of our boolean combinations:
 *  - userInvocable && modelInvocable       -> "on"      (exact match)
 *  - !userInvocable && !modelInvocable     -> "off"     (exact match)
 *  - userInvocable && !modelInvocable      -> "user-invocable-only"
 *      (exact match: SDK docstring says this value "hides it from the model
 *      but keeps /name" - explicit-only, never auto-invoked)
 *  - !userInvocable && modelInvocable      -> no SDK equivalent exists.
 *      We want "the model may still auto-invoke it, but hide /name from the
 *      user's own listing" - none of the four SDK values expresses that
 *      (the closest, "user-invocable-only", means the opposite: hidden from
 *      the model, kept for the user). Falling back to "on" preserves what
 *      we actually need (model visibility) and is safe precisely because
 *      this option is presentation only, never authorization: the real gate
 *      against a manually typed "/name" in this state is
 *      assertSlashDispatchAllowed()'s own NOT_USER_INVOCABLE check, which
 *      does not depend on skillOverrides at all.
 */
export function toSkillOverrideValue(userInvocable, modelInvocable) {
  if (userInvocable && modelInvocable) return "on";
  if (!userInvocable && !modelInvocable) return "off";
  if (userInvocable && !modelInvocable) return "user-invocable-only";
  return "on";
}
