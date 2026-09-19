// Argument parsing + dispatch for the `browzy` CLI. Kept separate from
// host/bin/browzy.js so tests can drive `main()` directly without spawning a
// child process.

import { runInstall, runUninstall, runDoctor } from "./core.js";

/**
 * `provider-test` is the only ASYNC command, so it is loaded and awaited
 * separately. It is imported dynamically (not at module top) so that the
 * installer's own paths — install, uninstall, doctor — never pay for loading
 * the SDK-backed diagnostic, and so a broken/missing file there cannot break
 * `browzy install`.
 *
 * @param {string[]} rest arguments after the subcommand
 * @param {(line: string) => void} error
 * @returns {Promise<number>} exit code
 */
async function runProviderTest(rest, error) {
  try {
    const { main: providerTest } = await import("../provider-test.mjs");
    return await providerTest(rest);
  } catch (err) {
    error(`Error: provider-test could not run: ${(err && err.message) || String(err)}`);
    return 2;
  }
}

const HELP = `Usage: browzy <command> [options]

Commands:
  install        Register the native messaging host for installed browsers
  uninstall      Remove that registration
  doctor         Report what is currently registered, for which extension id,
                 and whether the host file it points at exists
  provider-test  Diagnose why a configured provider does not work: reachability,
                 what the endpoint says about the saved API key, and the real
                 capability sub-tests — with the raw error the Settings page
                 collapses into "network/TLS"

Options (install, uninstall):
  --only=chrome,edge,brave[,chromium]   Restrict to these browsers
  --extension-id <id>                   Override the built-in extension id
  -h, --help                            Show this help

Options (provider-test):
  --network-only     Reachability/TLS only — no credential read, no SDK, no tokens
  --model <id>       Test one specific model id
  --all-models       Test every model configured in the profile
  --json             Machine-readable report (safe to paste: the credential is
                     redacted from every field)

The extension id is derived automatically from extension/manifest.json's
persistent public key and embedded as a constant — nothing to copy or pass
by hand, unless you need to point at a different install (e.g. a Chrome Web
Store build), in which case use --extension-id.
`;

function parseOnly(value) {
  return value
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * @param {string[]} args (already past the subcommand)
 * @returns {{only: string[]|null, extensionId: string|undefined, help: boolean}|{error: string}}
 */
function parseFlags(args) {
  const result = { only: null, extensionId: undefined, help: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "-h" || arg === "--help") {
      result.help = true;
    } else if (arg.startsWith("--only=")) {
      result.only = parseOnly(arg.slice("--only=".length));
    } else if (arg === "--only") {
      const value = args[++i];
      if (!value) return { error: "--only requires a value, e.g. --only=chrome,edge" };
      result.only = parseOnly(value);
    } else if (arg.startsWith("--extension-id=")) {
      result.extensionId = arg.slice("--extension-id=".length);
    } else if (arg === "--extension-id") {
      const value = args[++i];
      if (!value) return { error: "--extension-id requires a value" };
      result.extensionId = value;
    } else if (arg.startsWith("--")) {
      return { error: `Error: unknown flag '${arg}'.` };
    } else {
      return {
        error:
          `Error: unrecognized argument '${arg}'.\n` +
          `The extension id is derived automatically; to override it, use --extension-id <id>.`
      };
    }
  }
  return result;
}

/**
 * @param {string[]} argv process.argv.slice(2)
 * @param {{log?: Function, error?: Function}} [io]
 * @returns {number} exit code
 */
export function main(argv, io = {}) {
  const log = io.log ?? ((line) => console.log(line));
  const error = io.error ?? ((line) => console.error(line));

  const [command, ...rest] = argv;

  if (!command || command === "-h" || command === "--help") {
    log(HELP);
    return command ? 0 : 1;
  }

  if (!["install", "uninstall", "doctor", "provider-test"].includes(command)) {
    error(`Error: unknown command '${command}'.`);
    log(HELP);
    return 1;
  }

  // provider-test owns its own (richer) argument set and is the one command
  // that must run WITHOUT the install flags meaning anything — dispatch it
  // before parseFlags(), which only knows the installer's flags. The two
  // installer flags are named in its help, so a reader who passes one by
  // mistake gets provider-test's "unknown argument" message rather than a
  // silent no-op.
  if (command === "provider-test") {
    // The one ASYNC command (it awaits the network). `main` stays synchronous
    // for install/uninstall/doctor so existing callers and tests keep working;
    // the async half is entered here and its promise returned.
    return runProviderTest(rest, error);
  }

  const flags = parseFlags(rest);
  if ("error" in flags) {
    error(flags.error);
    return 1;
  }
  if (flags.help) {
    log(HELP);
    return 0;
  }

  const runOpts = { only: flags.only, extensionId: flags.extensionId, log, error };
  // resolveOptions() only applies its own default when the field is
  // `undefined`, so an explicit `undefined` here (no --extension-id given)
  // correctly falls through to the built-in EXTENSION_ID constant.
  if (runOpts.extensionId === undefined) delete runOpts.extensionId;

  let result;
  if (command === "install") result = runInstall(runOpts);
  else if (command === "uninstall") result = runUninstall(runOpts);
  else result = runDoctor(runOpts);

  return result.exitCode;
}
