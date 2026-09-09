#!/usr/bin/env node

// `browzy` CLI entry point — install/uninstall/doctor the native messaging
// host registration for the Browzy extension. See host/agent/installer/ for
// the actual logic (ported from install.sh/install.ps1).

import { main } from "../agent/installer/cli.js";

process.exit(main(process.argv.slice(2)));
