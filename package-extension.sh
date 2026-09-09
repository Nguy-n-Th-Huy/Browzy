#!/usr/bin/env bash
# Build a Chrome Web Store upload package from extension/.
#
# Two things make this more than "zip the folder":
#
#  1. THE `key` FIELD IS REMOVED. extension/manifest.json carries a public
#     key so that an unpacked install always derives the same extension id —
#     that is what lets install.sh write a native-messaging manifest whose
#     allowed_origins actually matches (see host/agent/identity.js). The Web
#     Store does not honour that key: it mints its own keypair when the item
#     is first created and assigns an id from that. Shipping the key would
#     leave a field in the published manifest that claims an identity the
#     published extension does not have. It is stripped here rather than
#     deleted from the repo, because the unpacked development install still
#     needs it.
#
#     CONSEQUENCE, and it is not small: a store-installed Browzy has a
#     DIFFERENT id from the unpacked one, so the native host registered by
#     install.sh/install.ps1/`browzy install` will refuse to talk to it. Take
#     the id the Web Store assigns and pass it with --extension-id (e.g.
#     `./install.sh --extension-id <id>` or `browzy install --extension-id
#     <id>`; see --help there) before expecting a store install to reach the
#     companion.
#
#  2. DEVELOPMENT LEFTOVERS ARE EXCLUDED. Backup copies (*.prev), test files
#     and docs are not part of what runs, and every one of them is extra
#     surface a reviewer has to read.
#
# Usage: ./package-extension.sh [--version X.Y.Z]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
EXT_DIR="$SCRIPT_DIR/extension"
BUILD_DIR="$SCRIPT_DIR/build"
STAGE_DIR="$BUILD_DIR/browzy-extension"

VERSION_OVERRIDE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --version) VERSION_OVERRIDE="${2:-}"; shift 2 ;;
    --version=*) VERSION_OVERRIDE="${1#--version=}"; shift ;;
    -h|--help)
      echo "Usage: $0 [--version X.Y.Z]"
      echo "Writes build/browzy-<version>.zip, ready to upload to the Chrome Web Store."
      exit 0 ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

[ -f "$EXT_DIR/manifest.json" ] || { echo "No manifest at $EXT_DIR/manifest.json" >&2; exit 1; }
command -v node >/dev/null 2>&1 || { echo "node is required" >&2; exit 1; }

# --- Stage a clean copy ----------------------------------------------------
rm -rf "$STAGE_DIR"
mkdir -p "$STAGE_DIR"

# Copy everything, then remove what must not ship. Listing exclusions beats
# listing inclusions here: a new source file added later is included by
# default, whereas an inclusion list would silently drop it and the failure
# would only show up as a broken extension.
cp -r "$EXT_DIR/." "$STAGE_DIR/"
find "$STAGE_DIR" \( \
  -name "*.prev" -o \
  -name "*.test.mjs" -o \
  -name "*.test.js" -o \
  -name "README.md" -o \
  -name "SCHEMA_*.md" -o \
  -name ".DS_Store" \
\) -type f -print -delete | sed 's|^'"$STAGE_DIR"'/|  excluded: |'

# --- Rewrite the manifest --------------------------------------------------
VERSION="$(node -e '
const fs = require("fs");
const p = process.argv[1];
const override = process.argv[2];
const m = JSON.parse(fs.readFileSync(p, "utf8"));

// The store assigns its own identity; see the header.
delete m.key;

if (override) {
  if (!/^\d+(\.\d+){0,3}$/.test(override)) {
    console.error("version must be 1-4 dot-separated integers");
    process.exit(1);
  }
  m.version = override;
}

// Key order is preserved by JSON.parse/stringify for string keys, so the
// published manifest still reads in the same order as the source.
fs.writeFileSync(p, JSON.stringify(m, null, 2) + "\n");
process.stdout.write(m.version);
' "$STAGE_DIR/manifest.json" "$VERSION_OVERRIDE")"

ZIP_PATH="$BUILD_DIR/browzy-$VERSION.zip"
rm -f "$ZIP_PATH"

# --- Zip -------------------------------------------------------------------
# The archive's root must be the manifest itself, not a wrapping directory.
if command -v zip >/dev/null 2>&1; then
  (cd "$STAGE_DIR" && zip -q -r -X "$ZIP_PATH" .)
else
  # No zip on this machine (the usual case on Windows). Compress-Archive is
  # the obvious substitute and is WRONG here: on Windows PowerShell it writes
  # entry names with backslashes, while the ZIP spec requires forward slashes.
  # Chrome then unpacks the archive as a flat directory of files literally
  # named \"sidepanel\\sidepanel.js\", with no manifest where it looks for
  # one. Drive System.IO.Compression directly instead and set each entry name
  # by hand.
  STAGE_WIN="$(cygpath -w "$STAGE_DIR" 2>/dev/null || echo "$STAGE_DIR")"
  ZIP_WIN="$(cygpath -w "$ZIP_PATH" 2>/dev/null || echo "$ZIP_PATH")"
  powershell -NoProfile -NonInteractive -Command "
    Add-Type -AssemblyName System.IO.Compression.FileSystem;
    \$src = '$STAGE_WIN';
    \$zip = [IO.Compression.ZipFile]::Open('$ZIP_WIN', 'Create');
    try {
      Get-ChildItem -LiteralPath \$src -Recurse -File | ForEach-Object {
        \$rel = \$_.FullName.Substring(\$src.Length + 1).Replace([char]92, [char]47);
        [void][IO.Compression.ZipFileExtensions]::CreateEntryFromFile(\$zip, \$_.FullName, \$rel);
      }
    } finally { \$zip.Dispose() }
  "
fi

[ -f "$ZIP_PATH" ] || { echo "Packaging failed: no archive written" >&2; exit 1; }

echo
echo "Package: $ZIP_PATH"
echo "Version: $VERSION"
node -e '
const fs = require("fs");
const m = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
console.log("Manifest: key removed =", !("key" in m), "| permissions =", m.permissions.length);
' "$STAGE_DIR/manifest.json"
echo
echo "Before uploading, read the notes at the top of this script about the"
echo "extension id: a store install will NOT reach the native companion until"
echo "install.sh/install.ps1/browzy install is pointed at the id the Web Store"
echo "assigns, via --extension-id."
