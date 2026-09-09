#!/bin/bash
set -e

# Install script for the Browzy extension.
# Registers the native messaging host for Chrome, Edge, and Brave on
# macOS, Linux, and Windows (run under Git Bash / MSYS2 / Cygwin).
#
# Usage: ./install.sh [--only=chrome,edge,brave[,chromium]] [--extension-id <id>] [-h|--help]
#
# THIS IS A THIN SHIM. The actual registration logic (deriving the extension
# id, generating the native-messaging manifest, writing it per browser,
# Windows registry, write-if-changed/backup semantics, the --only filter)
# now lives once in the cross-platform Node CLI at host/agent/installer/,
# shared by this script, install.ps1, and the published `browzy` npm CLI
# (`npm i -g @huydepzai2810/browzy-host` then `browzy install`) — see
# host/agent/installer/core.js for the annotated implementation. Keeping one
# implementation means the three entry points can never drift from each
# other, including on a browser/platform combination nobody here can test.
#
# By default every installed browser is registered; pass --only to restrict
# that to a subset. The extension id is derived automatically from the
# extension's persistent public key unless overridden with --extension-id
# (see package-extension.sh for when that override is needed).
#
# Rerunning this script is a no-op when nothing changed, and it only ever
# writes/backs up files and registry keys that belong to THIS product's own
# native-messaging host name — it never touches another extension's
# registration.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HOST_DIR="$SCRIPT_DIR/host"

if ! command -v node &> /dev/null; then
  echo "Error: node is not installed. Install Node.js first, then rerun this script." >&2
  exit 1
fi

if [ ! -f "$HOST_DIR/native-host.js" ]; then
  echo "Error: $HOST_DIR/native-host.js not found." >&2
  echo "Run this script from the project's own install.sh (it locates the" >&2
  echo "host/ directory next to itself); do not copy install.sh elsewhere." >&2
  exit 1
fi

if [ ! -f "$HOST_DIR/bin/browzy.js" ]; then
  echo "Error: $HOST_DIR/bin/browzy.js not found." >&2
  echo "The install CLI is missing from this checkout — pull the latest changes." >&2
  exit 1
fi

# Verify npm dependencies are installed. Only needed for this local
# git-clone dev flow: a global `npm i -g @huydepzai2810/browzy-host` install
# already has every dependency resolved by npm itself. Not optional — the
# companion cannot run at all without these, so a failure here is fatal.
if [ ! -d "$HOST_DIR/node_modules" ]; then
  echo "Installing npm dependencies..."
  if ! (cd "$HOST_DIR" && npm install); then
    echo "Error: dependency installation failed in $HOST_DIR." >&2
    echo "The companion cannot run until 'npm install' succeeds there — fix the error above and rerun this script." >&2
    exit 1
  fi
fi

# The codemode/hybrid servers bundle a Cloudflare Worker (execute_code) that
# imports @cloudflare/codemode; wrangler's build fails if the worker's own
# dependencies aren't installed. Install them here so execute_code works.
# This is optional — only the execute_code feature depends on it — so a
# failure here must not abort the rest of the install (native-host
# registration below still needs to run even if this fails).
WORKER_DIR="$HOST_DIR/codemode/worker"
if [ -f "$WORKER_DIR/package.json" ] && [ ! -d "$WORKER_DIR/node_modules" ]; then
  echo "Installing codemode worker dependencies..."
  (cd "$WORKER_DIR" && npm install) || {
    echo "Warning: codemode worker dependency install failed — the execute_code feature will be unavailable. Continuing with the rest of the install." >&2
  }
fi

# Hand off to the real implementation. Test hooks (OCIC_HOME_OVERRIDE,
# OCIC_REGISTRY_ROOT, OCIC_OS_OVERRIDE) are picked up directly from the
# environment by the Node CLI, exactly as before; --only/--extension-id/-h
# are forwarded as given, and an unrecognized argument (e.g. the old
# positional extension-id usage) is rejected there with a message pointing
# at --extension-id.
exec node "$HOST_DIR/bin/browzy.js" install "$@"
