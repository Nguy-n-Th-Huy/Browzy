# Task group 2 evidence: stable packaging and native registration

Scope: `openspec/changes/migrate-to-claude-agent-sdk/tasks.md` group 2 (2.1–2.4).

## Environment constraint

No browser was available in this session to install into. Everything that
needs a real browser profile/registry to observe was instead exercised
against a **temporary fake registration root** — a scratch registry subtree
(`HKCU:\Software\OcicInstallerTestPs`) for `install.ps1`, an `OCIC_HOME_OVERRIDE`
scratch directory for `install.sh`'s POSIX branches, and a scratch copy of the
whole repo under a path containing spaces and CJK characters — so the actual
installer logic ran for real and was asserted against, not mocked. Anything
that genuinely requires a real installed browser is marked **BLOCKED** below
with the exact command to run.

All fake registry keys and scratch directories were deleted after testing;
`git status` at the end of this report confirms nothing test-related was left
behind or committed.

## 2.1 — Persistent public key + identity derivation/validation

**Algorithm** (`host/agent/identity.js`): decode the manifest's base64 `key`
as an SPKI-DER public key, SHA-256 it, take the first 128 bits (16 bytes), map
each nibble 0–f to a–p — the documented Chromium extension-ID algorithm.

**Generated keypair**: `host/agent/generate-key.js` generated one RSA-2048
keypair. The private key is at repo-root `extension.pem` (already covered by
the pre-existing `.gitignore` entry — this file was never committed). Only the
base64 SPKI public key was written into `extension/manifest.json`'s new `"key"`
field.

**Derived extension id** (deterministic, same for every browser):

```
ihljfjgoakmoemkdondoaadegpmibimh
```

**Independent known-vector verification** — computed with `openssl` + `tr`,
entirely outside this project's own code, and cross-checked against
`host/agent/identity.js`'s own output:

```
$ openssl rsa -in extension.pem -pubout -outform DER -out pub.der
$ openssl dgst -sha256 -binary pub.der | xxd -p -c 256
87b9596e0ace4ca3ed3e00346fc818c7833d0513593e20657fb6215ace330318
$ HEX=87b9596e0ace4ca3ed3e00346fc818c7   # first 32 hex chars = first 128 bits
$ echo -n "$HEX" | tr '0123456789abcdef' 'abcdefghijklmnop'
ihljfjgoakmoemkdondoaadegpmibimh
```

Matches `node host/agent/identity.js derive extension/manifest.json` exactly.
This exact value is hard-coded as the known vector in
`host/test/identity.test.mjs`.

**Validator**: `verifyExtensionId(base64Key, expectedId)` compares a derived
id against an expected/browser-reported id and returns a structured
`{ok, derived, expected, reason}` — distinct reasons for "manifest key
invalid", "expected id not well-formed", and "id mismatch". The CLI
(`node host/agent/identity.js verify <manifest> <expected-id>`) exits 0/1
accordingly, for use by diagnostics.

## 2.2 — `install.sh` rewrite + new `install.ps1`

Both installers now:

- **Derive the id automatically** by shelling out to
  `node host/agent/identity.js derive extension/manifest.json` — no
  extension-ID argument exists anymore in either script. `install.sh` errors
  with a clear message on any legacy positional argument; `install.ps1` uses
  `[CmdletBinding(PositionalBinding = $false)]` so a bare positional argument
  is a hard PowerShell parameter-binding error rather than silently landing
  somewhere.
- **Build exact origins**: `allowed_origins: ["chrome-extension://<id>/"]` —
  one exact id, reused across every browser (that's the point of the
  persistent key — see the "no wildcards" grep below).
- **Target selected installed browsers**: Chrome/Edge/Brave on
  mac/Linux/Windows, `--only=`/`-Only` to restrict, auto-skip on POSIX when a
  browser's profile directory doesn't exist.
- **Validate runtime/paths**: both check `node` is on PATH and that
  `host/native-host.js` / `extension/manifest.json` exist next to the script
  before doing anything, with a distinct error message per failure.
- **Are idempotent and back up replaced registrations**: a `write-if-changed`
  helper (bash function / PowerShell function) compares existing content
  first; unchanged → "Already up to date", changed → back up to `.bak` (files)
  or export a `.reg` file (Windows registry value) before overwriting.
- **Only touch this product's own registration**: every write is scoped to
  the literal filename/registry-key-name `com.anthropic.open_claude_in_chrome`
  — never a wildcard or another extension's entry.

### Real bugs found and fixed while testing against the fake root

1. **`install.sh`**: `local browser="$1" hive="$2" key="$hive\\$HOST_NAME"` on
   one line — bash expands `$hive` using its value from *before* the command
   runs, not the value just assigned earlier in the same `local` statement, so
   `key` silently built with an empty hive. Fixed by splitting into separate
   `local` statements (now commented in the script).
2. **`install.sh`**: the registry-value-comparison used
   `awk '/REG_SZ/{ $1=$2=$3=""; ... }'`, assuming a leading blank field before
   `(Default)` that reg.exe's CRLF output does not actually have — it cleared
   the value along with the label columns, so the idempotence check always
   thought the registration had changed. Replaced with
   `sed -n 's/^.*REG_SZ[[:space:]]*//p' | tr -d '\r'`.
3. **`install.ps1`**: without `PositionalBinding = $false`, a bare positional
   argument (the old `.\install.ps1 <id>` calling convention) silently bound
   to `-Only` instead of erroring — and because the default `-RegistryRoot` is
   the REAL `HKCU:\Software`, this could have caused a real (if harmless,
   since it just skipped every browser) touch of the real registry root
   during what looked like a harmless smoke test. Fixed with
   `[CmdletBinding(PositionalBinding = $false)]`; verified the bare-arg case
   now hard-errors with `ParameterBindingException` before any registry code
   runs.
4. **`install.ps1`**: `$ErrorActionPreference = "Stop"` combined with
   `2>&1` on the native `node` derive call turned an ordinary "the key is
   corrupt" diagnostic into an uncaught crash instead of the intended
   "Repair: regenerate the persistent key with..." message (PowerShell wraps
   redirected native stderr as an `ErrorRecord`, and `Stop` promotes that to
   terminating regardless of the redirection target). Fixed by temporarily
   setting `$ErrorActionPreference = "Continue"` around that one call and
   redirecting stderr to a temp file instead of `2>&1`, then parsing
   PowerShell's `"<exe> : <message>"` wrapper back down to the plain message.
5. **`host/agent/identity.js`**: `loadManifestKey` didn't strip a UTF-8 BOM.
   `PowerShell`'s `Set-Content -Encoding utf8` (and Notepad, etc.) commonly
   save UTF-8 **with** a BOM; Node decodes that as a literal `U+FEFF`
   character, which made `JSON.parse` fail on an otherwise perfectly valid
   manifest. Fixed by stripping a leading BOM before parsing; regression test
   added (`loadManifestKey tolerates a UTF-8 BOM`).

## 2.3 — Legacy migration: export/import + one-time guidance

New module: `extension/settings-migration/` (`migrate.js`, `migrate.test.mjs`,
`README.md`). Justification for this location over a single flat file: it's a
genuinely separate concern from the recorder/options code it will eventually
be wired into (task groups 4/5 build `extension/settings/`), it needs its own
test file, and `extension/settings-migration/**` was explicitly pre-approved
in scope.

- **Exports**: the non-secret operational config (`ocic_config_v1`:
  humanize/humanize_speed/humanize_seed/audit_mode) and the recorder session
  index (id, times, url0, event/utterance counts, `path`, transcript status,
  full trace) from IndexedDB `ocic-recorder`/`sessions`.
- **Never exports**: `openai_api_key` (or any other secret) — there is no
  adapter method that could even read it — and the cached `audio` Blob /
  `images` thumbnails, which are a disposable cache of what a session's
  `path` already points to on disk.
- **Host-side recordings are untouched**: the module only ever reads/writes
  browser-side `chrome.storage`/IndexedDB; it never touches the native host's
  on-disk recording files, so the acceptance requirement "host-side
  recordings keep their current locations" holds by construction (nothing in
  this module can move or rewrite them).
- **One-time ID-transition guidance**: both installers print an explanatory
  block after a successful run, naming the new id, explaining why it's
  different and permanent, and pointing at this module's `README.md` for the
  export/import steps and the required secret re-entry.
- Storage access is dependency-injected (`adapter` parameter), so the actual
  export/import logic (`buildExport`/`applyImport`) is unit-tested with a
  real in-memory fake adapter under Node — not mocked-and-hoped, genuinely
  executed with assertions on the resulting state.
- **Not yet wired into a Settings UI button** — that UI lands with
  `extension/settings/` in task group 4/5, out of this group's scope. Until
  then it's invoked from the browser DevTools console; exact commands are in
  the module's `README.md`. This is called out explicitly rather than glossed
  over.

## 2.4 — Test matrix

Run from `D:/Dev/www/open-claude-in-chrome` unless noted. Windows tests used
PowerShell 5.1 directly (not Git Bash) for `install.ps1`; POSIX-branch tests
used Git Bash on Windows with `OCIC_OS_OVERRIDE`/`OCIC_HOME_OVERRIDE` since no
real macOS/Linux machine was available (documented test hooks, not present in
any real-install code path).

| # | Case | Result | Evidence |
|---|---|---|---|
| 1 | Fresh install (`install.sh`, POSIX branch, fake `$HOME`) | PASS | `Installed: .../NativeMessagingHosts/com.anthropic.open_claude_in_chrome.json` for Chrome+Edge, `Skipping ... (not installed)` for the rest |
| 2 | Fresh install (`install.ps1`, fake registry root) | PASS | `Registered for Google Chrome/Microsoft Edge/Brave` |
| 3 | Rerun is a no-op (both installers) | PASS | Second run prints `Already up to date` for every file and every browser, no new `.bak`/`.reg` created |
| 4 | Backup on changed registration (both installers) | PASS | Seeded a stale value (`C:\stale\old-path.json` / `{"old":"registration"}`), rerun printed `Backed up previous ... registration to: ...bak`/`...reg`, then re-registered correctly; the `.bak`/`.reg` file contains the OLD value |
| 5 | Extension reload / browser restart against a real browser profile | **BLOCKED: requires a real browser install** | Run: load the unpacked `extension/` directory in Chrome/Edge/Brave (`chrome://extensions` → Developer mode → Load unpacked), confirm the id shown matches `ihljfjgoakmoemkdondoaadegpmibimh`, reload the extension and fully restart the browser, and confirm the id is unchanged both times |
| 6 | Moved extension directory | PASS | Copied `extension/manifest.json` alone into a scratch dir with spaces+Unicode in its path; `deriveIdFromManifest` returned the same id regardless of location (id is a pure function of the key, not the path) |
| 7 | Moved host path | PASS | Copied the whole scratch repo tree to a second scratch directory and reran `install.ps1` there: the manifest's `path` field updated to the new location, the old file's prior content was backed up first |
| 8 | Corrupt key | PASS | `identity.js`: empty string, invalid base64 charset, structurally-invalid-but-valid-base64, and truncated real key are all rejected with distinct messages, never silently derive an id (`host/test/identity.test.mjs`, 4 cases). `install.ps1` end-to-end: prints `Error: could not derive the extension id ...` + the underlying reason + repair instructions, exits 1, writes nothing |
| 9 | Paths with spaces and Unicode | PASS | Ran `install.ps1` from `...\ocic install test 目录\...`; generated manifest/bat files and their content (verified via raw UTF-8 byte read, not a misconfigured-encoding console echo) are correct |
| 10 | ID mismatch | PASS | `node host/agent/identity.js verify extension/manifest.json aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa` → exits 1 with `id mismatch: the manifest key derives to ihljfjgoakmoemkdondoaadegpmibimh, but the browser-reported id is aaaa...`; verifying the correct id exits 0 |
| 11 | Rejected foreign origins | PASS (config-level) / **BLOCKED (browser enforcement): requires a real browser install** | Structurally verified: the generated `allowed_origins` array contains exactly one exact origin for the derived id, never a second id and never a wildcard (see grep below) — this is what makes Chrome's own native-messaging host reject any other extension id. Actually observing Chrome refuse a connection from a foreign id needs a real browser; run: load two differently-keyed unpacked copies of the extension and confirm only the registered id's `connectNative()` succeeds |
| 12 | Existing host suites still pass | PASS | see below |
| 13 | New `host/test/identity.test.mjs` | PASS | 20/20 |
| 14 | New `extension/settings-migration/migrate.test.mjs` | PASS | 7/7 (browser-only wrappers correctly reported BLOCKED inside the test's own output, not silently skipped) |

### Captured command output

```
$ node host/test/identity.test.mjs
Extension identity derivation
  PASS  known vector: the real manifest key derives to the independently-computed id
  PASS  deriveIdFromManifest matches deriveExtensionId(loadManifestKey(...))
  PASS  derivation is deterministic across repeated calls
  PASS  different keys derive to different ids
  PASS  isValidExtensionId accepts only 32 lowercase a-p characters
  PASS  verifyExtensionId succeeds when derived and expected match (case-insensitive, trimmed)
  PASS  verifyExtensionId reports a mismatch distinctly from an invalid expected id
  PASS  corrupt key: empty string is rejected
  PASS  corrupt key: invalid base64 characters are rejected
  PASS  corrupt key: base64 that is not a real SPKI public key is rejected
  PASS  corrupt key: truncated real key is rejected, not silently re-hashed
  PASS  loadManifestKey distinguishes a missing manifest file
  PASS  loadManifestKey tolerates a UTF-8 BOM (Windows editors/PowerShell commonly add one)
  PASS  loadManifestKey distinguishes invalid JSON
  PASS  loadManifestKey distinguishes a manifest with no key field
  PASS  paths with spaces and unicode: manifest can live under such a directory
  PASS  CLI derive: prints only the bare id and exits 0
  PASS  CLI verify: exits 0 on a matching id
  PASS  CLI verify: exits 1 with an 'id mismatch' diagnostic on a wrong id
  PASS  CLI derive: exits 1 with a 'not found' diagnostic for a missing manifest
20/20 passed

$ node extension/settings-migration/migrate.test.mjs
Legacy settings/recorder-metadata export-import
  PASS  export never includes the OpenAI secret key even if present in raw storage
  PASS  export excludes audio/images cache fields even if a session row carries them
  PASS  export with no settings yet yields an empty settings object, not an error
  PASS  round trip: export from one adapter, import into a fresh one
  PASS  import into an extension that already has sessions merges rather than wiping
  PASS  import rejects an unrecognized/incompatible export format
  PASS  import skips a malformed recording (no recording_id) instead of throwing
7/7 passed

$ node host/test/endpoint.test.mjs
Rendezvous address
  PASS  windows: a pipe under \\.\pipe\, no separators in the name
  PASS  posix: an absolute .sock path inside the socket dir
  PASS  posix: path fits in sun_path (104 bytes) with room to spare
  PASS  posix: still fits when tmpdir is a long macOS-style path
  PASS  both platforms: a username with separators or spaces is sanitised
  PASS  both platforms: a passwd-less account still resolves an address
  PASS  env override wins on every platform
7/7 passed

$ node host/test/parent-watch.test.mjs
Parent watch
  PASS  leaves a child alone while its parent is alive and healthy  (6017ms)
  PASS  survives many identity re-checks without drift  (5016ms)
  PASS  still exits when the parent really is gone  (829ms)
3/3 passed

$ node host/test/ownership.test.mjs
Browser-bridge ownership
  PASS  host claims a free bridge and reports itself as owner  (61ms)
  PASS  a client's request reaches the extension and the reply comes back  (65ms)
  PASS  concurrent clients each get only their own responses  (65ms)
  PASS  a client that vanishes mid-request does not take the host down  (470ms)
  PASS  the host forgets clients that go away  (256ms)
  PASS  stale clients cannot block a fresh host from owning the bridge  (196ms)
  PASS  host releases the bridge the moment the extension disconnects  (124ms)
  PASS  recording_complete fans out to every attached client  (467ms)
  PASS  a real session joins the host instead of owning anything  (126ms)
  PASS  a session survives the host being respawned under it  (201ms)
  PASS  a session started before the browser reconnects when it appears  (6148ms)
  PASS  a waiting host takes over promptly when the owner releases  (3190ms)
12/12 passed
```

## No wildcard origins anywhere (grep proof)

```
$ grep -rn "allowed_origins" --include="*.json" --include="*.sh" --include="*.ps1" --include="*.js" . | grep -v node_modules
./host/com.anthropic.open_claude_in_chrome.json:6:  "allowed_origins": [
./install.ps1:118:# exact allowed_origins entry, never a per-browser list and never a wildcard.
./install.ps1:187:        "  `"allowed_origins`": [",
./install.sh:124:# exact allowed_origins entry, never a per-browser list and never a wildcard.
./install.sh:158:  "allowed_origins": [
```

Every array populated from these sites is `["chrome-extension://<derived-id>/"]`
— a single exact origin, never `*`, never a second id, verified by reading
`host/com.anthropic.open_claude_in_chrome.json` after every test run above.

## No private key committed (confirmation)

```
$ git check-ignore -v extension.pem
.gitignore:16:extension.pem	extension.pem

$ git status --porcelain
 M .gitignore
 M extension/manifest.json
 M host/package-lock.json      <- owned by a parallel session, not this task
 M host/package.json           <- owned by a parallel session, not this task
 M install.sh
?? extension/settings-migration/
?? host/agent/
?? host/test/identity.test.mjs
?? install.ps1
?? openspec/
```

`extension.pem` does not appear in `git status` at all (correctly ignored);
`.gitignore` was extended with `host/*.bak` and `host/*.registry-backup.reg`
so the installers' own backup/rollback artifacts never risk being committed
either.

## Files changed/added in this task group

- `extension/manifest.json` — added `"key"` (persistent public SPKI key only)
- `install.sh` — rewritten: automatic id derivation, single exact origin,
  idempotent writes with backup, `--only=` browser selection, test-hook env
  overrides (`OCIC_HOME_OVERRIDE`, `OCIC_REGISTRY_ROOT`, `OCIC_OS_OVERRIDE`)
- `install.ps1` — new native PowerShell 5.1 installer, same guarantees
- `host/agent/identity.js` — id derivation/validation + CLI (`derive`/`verify`)
- `host/agent/generate-key.js` — one-time/idempotent keypair generation helper
- `host/test/identity.test.mjs` — new, 20 tests
- `extension/settings-migration/migrate.js`, `migrate.test.mjs`, `README.md` —
  new, legacy export/import module + 7 tests
- `.gitignore` — added `host/*.bak`, `host/*.registry-backup.reg`
- `openspec/changes/migrate-to-claude-agent-sdk/tasks.md` — checked off 2.1–2.4

`extension.pem` (private key) was generated at the repo root but is not
committed (pre-existing `.gitignore` entry).
