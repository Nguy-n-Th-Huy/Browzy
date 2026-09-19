#!/usr/bin/env node

// `browzy` CLI entry point — install/uninstall/doctor the native messaging
// host registration for the Browzy extension, plus `provider-test` to
// diagnose a configured provider. See host/agent/installer/ for the install
// logic (ported from install.sh/install.ps1) and host/agent/provider-test.mjs
// for the diagnostic.

import { main } from "../agent/installer/cli.js";

// `provider-test` returns a promise (it awaits the network); every other
// command resolves immediately. Awaiting both here keeps `process.exitCode`
// correct for either, instead of exiting 0 before an async command finished.
process.exitCode = await main(process.argv.slice(2));
