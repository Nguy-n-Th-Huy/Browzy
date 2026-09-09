// Shared standalone-CLI tail for each gate module.
//
// Why each gate runs in its OWN process (see gate.mjs): Node's ESM loader
// caches a module by its resolved file URL for the lifetime of the process,
// regardless of which file imported it. host/tool-runtime.js reads its pipe
// path once, at module-load time, from `process.env.OCIC_PIPE`. If two gates
// ran inside one shared process, the SECOND gate's dynamic
// `import("../../../tool-runtime.js")` would silently return the FIRST
// gate's already-cached module instance — still bound to the first gate's
// scratch pipe — instead of picking up the second gate's own OCIC_PIPE. That
// is a real bug this spike hit empirically (gate 1.5 hung when run in the
// same process as gate 1.2, and passed once each gate got its own process),
// not a hypothetical: it is why gate.mjs spawns one child process per gate
// instead of importing every gate module into itself.

export async function runAsCli(runFn, { markerStart = "===GATE_RESULT_JSON_START===", markerEnd = "===GATE_RESULT_JSON_END===" } = {}) {
  const live = process.argv.includes("--live");
  let result;
  try {
    result = await runFn({ live });
  } catch (err) {
    result = {
      status: "FAIL",
      title: "(threw before returning a result)",
      evidence: [],
      error: err && err.stack ? err.stack : String(err)
    };
  }
  process.stdout.write(`${markerStart}\n${JSON.stringify(result)}\n${markerEnd}\n`);
  process.exitCode = result.status === "FAIL" ? 1 : 0;
}
