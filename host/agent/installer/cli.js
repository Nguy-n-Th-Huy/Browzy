// Argument parsing + dispatch for the `browzy` CLI. Kept separate from
// host/bin/browzy.js so tests can drive `main()` directly without spawning a
// child process.

import { runInstall, runUninstall, runDoctor } from "./core.js";

const HELP = `Usage: browzy <command> [options]

Commands:
  install     Register the native messaging host for installed browsers
  uninstall   Remove that registration
  doctor      Report what is currently registered, for which extension id,
              and whether the host file it points at exists

Options (install, uninstall):
  --only=chrome,edge,brave[,chromium]   Restrict to these browsers
  --extension-id <id>                   Override the built-in extension id
  -h, --help                            Show this help

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

  if (!["install", "uninstall", "doctor"].includes(command)) {
    error(`Error: unknown command '${command}'.`);
    log(HELP);
    return 1;
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
