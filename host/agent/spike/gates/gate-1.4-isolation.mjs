// Gate 1.4 — negative/isolation gate.
//
// Update (this session): tasks.md's two previously-open sub-items for this
// gate depended on infrastructure that did not exist when this gate was
// first written — the run-ID + browser-lease infrastructure (task 3.4) and
// the capability-scoped filesystem allowlist (tasks 3.3/7.x). Both now exist
// (host/agent/session/run.js, host/agent/broker/browser-lease.js,
// host/agent/broker/native-lease.js, host/agent/policy/authorization.js,
// host/agent/policy/approvals.js, host/agent/tools/adapter.js,
// host/agent/skills/session-workspace.js), so this gate now exercises the
// REAL production modules, not a synthetic stand-in: a real Run, a real
// BrowserLease, a real ApprovalRegistry, and the real
// host/agent/tools/adapter.js buildSdkTools()/createBrowserMcpServer()
// wiring, dispatching through the real @modelcontextprotocol/sdk
// validateToolInput/executeToolHandler path exactly like a live query()
// would. Only the very last hop — host/tool-runtime.js's actual socket to a
// real browser extension — is stood in for by a counting fake (there is no
// live browser in this session), which is exactly the right place to stand
// in: everything this gate claims to prove is the authorization/scope logic
// that runs BEFORE that hop, and the fake makes it possible to assert
// "the tool bridge was never dispatched to" as positive proof of rejection,
// not just an absence of a thrown error.
//
// Fully offline. Uses a scratch, unreachable pipe for the group-1 tool
// registration checks below; the new production-adapter checks never touch
// host/tool-runtime.js's real socket at all (they use an injected fake
// tool bridge), so they carry no pipe-isolation risk of their own.

import { readFileSync, mkdtempSync, writeFileSync, unlinkSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HIGH_RISK_BUILTINS, buildIsolatedOptions } from "../lib/query-options.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

export async function run() {
  const evidence = [];
  const gaps = [];
  const fail = (msg) => {
    evidence.push(`FAIL: ${msg}`);
    throw new Error(msg);
  };

  process.env.OCIC_PIPE =
    process.platform === "win32"
      ? `\\\\.\\pipe\\ocic-spike-1.4-${process.pid}`
      : `/tmp/ocic-spike-1.4-${process.pid}.sock`;

  const adapter = await import("../lib/adapter.mjs");
  await adapter.initRuntime();
  const server = adapter.createBrowserMcpServer();
  const inst = server.instance;

  // --- Environment isolation ---
  const options = buildIsolatedOptions({
    mcpServer: server,
    serverName: adapter.SDK_MCP_SERVER_NAME,
    baseUrl: "http://127.0.0.1:1", // deliberately unreachable, never a real endpoint
    apiKey: "sk-ant-spike-placeholder-not-a-real-key",
    model: "claude-3-5-haiku-latest"
  });

  const allowedEnvKeys = new Set(["PATH", "SystemRoot", "ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY"]);
  const actualEnvKeys = Object.keys(options.env);
  const leaked = actualEnvKeys.filter((k) => !allowedEnvKeys.has(k));
  evidence.push(`options.env keys: ${actualEnvKeys.join(", ")}`);
  if (leaked.length) fail(`env carries unexpected keys beyond the isolated allowlist: ${leaked.join(", ")}`);
  // Prove this isn't just an empty coincidence: process.env on this machine
  // has other variables that must NOT have leaked through.
  const ambientOnly = Object.keys(process.env).filter((k) => !allowedEnvKeys.has(k) && k !== "OCIC_PIPE");
  const stillPresent = ambientOnly.filter((k) => options.env[k] !== undefined);
  if (stillPresent.length) fail(`ambient env leaked into isolated options.env: ${stillPresent.join(", ")}`);
  evidence.push(`PASS: options.env excludes ${ambientOnly.length} ambient process.env variables (e.g. ${ambientOnly.slice(0, 5).join(", ")}${ambientOnly.length > 5 ? ", ..." : ""})`);

  if (options.settingSources.length !== 0) fail("settingSources is not empty");
  evidence.push("PASS: settingSources === [] (no ~/.claude/settings.json, project or local settings loaded)");

  if (options.strictMcpConfig !== true) fail("strictMcpConfig is not true");
  evidence.push("PASS: strictMcpConfig === true (project .mcp.json / user settings / plugin MCP servers ignored)");

  if (Object.keys(options.mcpServers).length !== 1) fail("more than one mcpServers entry present");
  evidence.push(`PASS: mcpServers has exactly one entry: ${Object.keys(options.mcpServers)[0]}`);

  if (!Array.isArray(options.tools) || options.tools.length !== 0) fail("built-in tools are not fully disabled (tools !== [])");
  evidence.push("PASS: tools === [] (Bash, Write, Edit, Read, Glob, Grep, WebFetch, Task/subagents, etc. all disabled)");
  for (const name of HIGH_RISK_BUILTINS) {
    if (!options.disallowedTools.includes(name)) fail(`disallowedTools missing defense-in-depth entry: ${name}`);
  }
  evidence.push(`PASS: disallowedTools explicitly repeats ${HIGH_RISK_BUILTINS.join(", ")} as belt-and-suspenders`);

  // --- No shell / no arbitrary command execution ---
  // Architectural check on the REAL production source: tool-runtime.js's
  // entire contract to the extension is one JSON line over a socket
  // (sendToExtension in tool-runtime.js) — there is no child_process usage
  // anywhere in the call path from an SDK tool handler to the extension.
  const runtimeSrc = readFileSync(path.join(HERE, "..", "..", "..", "tool-runtime.js"), "utf-8");
  const shellPatterns = ["child_process", "exec(", "execSync(", "spawn("];
  const foundShell = shellPatterns.filter((p) => runtimeSrc.includes(p));
  if (foundShell.length) fail(`tool-runtime.js contains shell-invocation patterns: ${foundShell.join(", ")}`);
  evidence.push("PASS: host/tool-runtime.js (real production source) contains no child_process/exec/spawn calls in the tool-dispatch path");

  // Attempt a "shell injection" style payload through a real tool argument
  // (javascript_tool's `text` field, which legitimately accepts arbitrary
  // strings) and confirm it is merely forwarded as inert JSON data to the
  // (deliberately absent) browser — never interpreted by a shell on this
  // process. With no browser attached, the real NO_BRIDGE_ERROR is returned,
  // which is itself proof nothing executed locally.
  const jsTool = inst._registeredTools["javascript_tool"];
  const injectionArgs = await inst.validateToolInput(
    jsTool,
    { action: "javascript_exec", text: "1; $(rm -rf / --no-preserve-root) #", tabId: 1 },
    "javascript_tool"
  );
  const injectionResult = await inst.executeToolHandler(jsTool, injectionArgs, {});
  const injectionText = injectionResult?.content?.[0]?.text ?? "";
  if (!/not connected/i.test(injectionText)) fail(`unexpected result for injection payload: ${injectionText}`);
  evidence.push("PASS: a shell-metacharacter payload in a tool argument was forwarded as inert data (real 'not connected' result), never executed as a command");

  // --- Unknown tool name rejected before execution ---
  const unknown = inst._registeredTools["unknown_tool_xyz_does_not_exist"];
  if (unknown) fail("an unregistered tool name resolved to a handler");
  evidence.push("PASS: an unknown tool name has no registered handler (the real @modelcontextprotocol/sdk McpServer dispatch throws McpError InvalidParams \"Tool X not found\" for this case before any handler runs)");

  // --- Malformed / missing required arguments rejected before execution ---
  const navTool = inst._registeredTools["navigate"];
  let rejected = false;
  let rejectMessage = "";
  try {
    await inst.validateToolInput(navTool, {}, "navigate");
  } catch (err) {
    rejected = true;
    rejectMessage = err.message;
  }
  if (!rejected) fail("navigate accepted a call with no url/tabId");
  evidence.push(`PASS: navigate({}) rejected before dispatch by real zod schema validation -> ${rejectMessage.slice(0, 140)}`);

  adapter.shutdownRuntime();

  // --- Production-infrastructure checks (this session's additions) --------
  // Everything below imports and exercises the REAL group-3/7 modules —
  // never a synthetic stand-in for their logic — via an injected fake
  // tool bridge standing in only for the final "call a live browser" hop.
  const { Run } = await import("../../session/run.js");
  const { BrowserLease } = await import("../../broker/browser-lease.js");
  const { ApprovalRegistry } = await import("../../policy/approvals.js");
  const { ToolBridge } = await import("../../broker/tool-bridge.js");
  const productionAdapter = await import("../../tools/adapter.js");
  const mapping = await import("../../tools/mapping.js");
  const { coerceArgs } = await import("../../../tool-runtime.js");

  function makeCountingToolBridge() {
    const calls = [];
    const bridge = new ToolBridge({
      init: async () => {},
      callTool: async (name, args) => {
        calls.push({ name, args });
        return { content: [{ type: "text", text: `dispatched:${name}` }] };
      },
      shutdown: () => {}
    });
    return { bridge, calls };
  }

  // --- 1. Invalid tab scope rejected at the handler, even for a call whose
  //        shape the real SDK/zod validation already accepted as well-formed
  //        (the "SDK permission checks preapproved the tool" case: nothing
  //        about a well-formed navigate({tabId: 999}) call looks wrong to
  //        schema validation — only the run's own tab-scope check can catch
  //        it). Uses the REAL host/agent/tools/adapter.js buildSdkTools(),
  //        which is exactly what group 3's session builder registers. ------
  {
    const lease = new BrowserLease({ browserIdentity: "gate-1.4-browser-scope" });
    const approvals = new ApprovalRegistry();
    const scopedRun = new Run({ conversationId: "conv-scope", lease, approvals, tabScope: [100] });
    await scopedRun.begin();
    const { bridge: toolBridge, calls: bridgeCalls } = makeCountingToolBridge();
    const scopedServer = productionAdapter.createBrowserMcpServer({ toolBridge, coerceArgs, run: scopedRun });
    const scopedInst = scopedServer.instance;
    const scopedNavTool = scopedInst._registeredTools["navigate"];

    const outArgs = await scopedInst.validateToolInput(scopedNavTool, { url: "https://example.com", tabId: 999 }, "navigate");
    const outResult = await scopedInst.executeToolHandler(scopedNavTool, outArgs, {});
    const outText = outResult?.content?.[0]?.text ?? "";
    if (!outResult.isError) fail("navigate(tabId=999), outside this run's tab scope [100], was NOT rejected");
    if (!/tab_out_of_scope/.test(outText)) fail(`expected a tab_out_of_scope rejection, got: ${outText}`);
    if (bridgeCalls.length !== 0) fail("authorization was bypassed: an out-of-scope tabId reached the tool bridge");
    evidence.push(
      "PASS: navigate(tabId=999) is rejected (tab_out_of_scope) by the REAL production handler-side authorizeToolCall() " +
        "(host/agent/policy/authorization.js), invoked through the REAL host/agent/tools/adapter.js buildSdkTools() " +
        "registration and the real @modelcontextprotocol/sdk validateToolInput/executeToolHandler dispatch — even though " +
        "zod schema validation (the 'SDK-level' check) already accepted the call as a well-formed navigate request. " +
        "This run's tabScope is [100]; the tool bridge received zero dispatches."
    );

    // Same run, a read-only tool (no borrowed-tab-mutation gate applies —
    // that is task-group-6's separate, already-proven concern), targeting a
    // tabId that genuinely IS in scope: authorized, and reaches the bridge.
    const readTool = scopedInst._registeredTools["read_page"];
    const inArgs = await scopedInst.validateToolInput(readTool, { tabId: 100 }, "read_page");
    const inResult = await scopedInst.executeToolHandler(readTool, inArgs, {});
    if (inResult.isError) fail(`read_page(tabId=100), the run's own in-scope tab, was unexpectedly rejected: ${inResult.content?.[0]?.text}`);
    if (bridgeCalls.length !== 1) fail(`expected exactly 1 dispatched call for the in-scope read_page, got ${bridgeCalls.length}`);
    evidence.push(
      "PASS: read_page(tabId=100) — inside this same run's own tab scope — is authorized and reaches the tool bridge " +
        "exactly once, proving the rejection above was scope-specific, not a blanket failure of this run's tools."
    );
    scopedRun.stop("gate_test_cleanup");
  }

  // --- 2. Stale / cross-session capability rejected: a capability (an
  //        approval token, or dispatch rights derived from holding the
  //        shared browser lease) issued to one run must not work for a
  //        DIFFERENT run, and must stop working for its OWN run once that
  //        run is finished/superseded. Uses the REAL ApprovalRegistry
  //        (host/agent/policy/approvals.js), the REAL BrowserLease
  //        (host/agent/broker/browser-lease.js), and the REAL Run
  //        (host/agent/session/run.js). --------------------------------
  {
    const lease = new BrowserLease({ browserIdentity: "gate-1.4-browser-stale" });
    const approvals = new ApprovalRegistry();

    const runA = new Run({ conversationId: "conv-A", lease, approvals, tabScope: "any" });
    await runA.begin();
    const { bridge: toolBridgeA, calls: bridgeCallsA } = makeCountingToolBridge();
    const serverA = productionAdapter.createBrowserMcpServer({ toolBridge: toolBridgeA, coerceArgs, run: runA });
    const instA = serverA.instance;
    const readTool = instA._registeredTools["read_page"];

    // Sanity: run A can genuinely dispatch while it holds the lease, so the
    // rejections below are proven to be about staleness/cross-session, not
    // about some unrelated misconfiguration.
    const sanityArgs = await instA.validateToolInput(readTool, { tabId: 1 }, "read_page");
    const sanityResult = await instA.executeToolHandler(readTool, sanityArgs, {});
    if (sanityResult.isError) fail(`run A could not dispatch while genuinely holding the lease: ${sanityResult.content?.[0]?.text}`);
    if (bridgeCallsA.length !== 1) fail(`expected exactly 1 sanity dispatch for run A, got ${bridgeCallsA.length}`);
    evidence.push("PASS (sanity): run A dispatches a real tool call successfully while it genuinely holds the browser lease");

    // Cross-session: an approval token issued to run A must be rejected if a
    // DIFFERENT run/session (run B) attempts to consume it — even for the
    // exact same action/target.
    const tokenA = runA.issueApproval("file_upload", { tabId: 1, ref: "ref_1" });
    const runB = new Run({ conversationId: "conv-B", lease, approvals, tabScope: [200] });
    const crossResult = runB.consumeApproval(tokenA, "file_upload", { tabId: 1, ref: "ref_1" });
    if (crossResult.ok) fail("a different run/session (run B) successfully consumed run A's approval token");
    if (crossResult.reason !== "run_mismatch") fail(`expected run_mismatch, got ${crossResult.reason}`);
    evidence.push(
      `PASS: an approval token issued to run A (${runA.runId}) is rejected (run_mismatch) when a DIFFERENT, ` +
        `independent run/session (${runB.runId}) attempts to consume it for the identical action/target — real ` +
        "ApprovalRegistry.consume() (host/agent/policy/approvals.js)."
    );

    // Stale: stopping run A invalidates every approval it issued, so even
    // run A itself cannot reuse its own now-finished token.
    runA.stop("gate_test_stale");
    const staleTokenResult = runA.consumeApproval(tokenA, "file_upload", { tabId: 1, ref: "ref_1" });
    if (staleTokenResult.ok) fail("a stopped (stale) run's own approval token was still honored after stop");
    if (staleTokenResult.reason !== "unknown_token") fail(`expected unknown_token for a stale/invalidated token, got ${staleTokenResult.reason}`);
    evidence.push(
      "PASS: stopping run A invalidates every approval token it issued (ApprovalRegistry.invalidateForRun()) — the " +
        "SAME, now-finished run's own stale token is rejected as unknown_token, not silently honored."
    );

    // Cross-session at the lease level: a fresh run (run C) acquires the
    // lease run A just released. Run A — finished and superseded — must be
    // rejected at the handler for ANY further dispatch attempt, even a
    // well-formed, in-scope, read-only call identical to the one that
    // succeeded in the sanity check above.
    const runC = new Run({ conversationId: "conv-C", lease, approvals, tabScope: "any" });
    await runC.begin();
    if (!runC.leaseHeldByThisRun()) fail("run C did not acquire the browser lease that run A released");
    if (runA.leaseHeldByThisRun()) fail("run A still reports holding the browser lease after being stopped and superseded");
    evidence.push(`PASS: after run A stopped, run C (${runC.runId}) acquired the freed browser lease; run A no longer reports holding it.`);

    const staleDispatchArgs = await instA.validateToolInput(readTool, { tabId: 1 }, "read_page");
    const staleDispatchResult = await instA.executeToolHandler(readTool, staleDispatchArgs, {});
    const staleText = staleDispatchResult?.content?.[0]?.text ?? "";
    if (!staleDispatchResult.isError) fail("run A dispatched a tool call after being stopped and superseded by run C — stale capability was honored");
    if (!/run_not_active/.test(staleText)) fail(`expected run_not_active for a stopped/superseded run's dispatch attempt, got: ${staleText}`);
    if (bridgeCallsA.length !== 1) fail(`run A's tool bridge received an unexpected extra dispatch (total calls: ${bridgeCallsA.length}, expected 1 from the earlier sanity check only)`);
    evidence.push(
      "PASS: run A — stopped and superseded by run C's lease acquisition — is rejected at the handler (run_not_active) " +
        "for a further dispatch attempt using the EXACT SAME well-formed, in-scope call that succeeded before it was " +
        "stopped; its tool bridge received no additional dispatch. A capability from a finished or different run does " +
        "not work."
    );
    runC.stop("gate_test_cleanup");
  }

  // --- 3. Capability-scoped filesystem allowlist for file_upload actually
  //        rejects a path outside what this run's own uploadAllowlist has
  //        explicitly approved (the only thing that can ever add a path is
  //        an explicit user file-picker selection surfaced by the panel —
  //        never a model request), and accepts the identical call once that
  //        exact path has been explicitly allowlisted. Uses the REAL
  //        RunUploadAllowlist (host/agent/policy/authorization.js) via the
  //        REAL Run/adapter wiring. ------------------------------------
  {
    const lease = new BrowserLease({ browserIdentity: "gate-1.4-browser-upload" });
    const approvals = new ApprovalRegistry();
    const uploadRun = new Run({ conversationId: "conv-upload", lease, approvals, tabScope: [400] });
    await uploadRun.begin();
    // Mark tab 400 as this run's own (agent-created) tab so the separate,
    // already-proven-elsewhere borrowed-tab-mutation gate (task group 6,
    // test/registry-sdk-mapping.test.mjs) never interferes with isolating
    // the filesystem-allowlist check under test here.
    mapping.recordAgentCreatedTab(uploadRun, 400);

    const { bridge: toolBridge, calls: bridgeCalls } = makeCountingToolBridge();
    const uploadServer = productionAdapter.createBrowserMcpServer({ toolBridge, coerceArgs, run: uploadRun });
    const uploadInst = uploadServer.instance;
    const uploadTool = uploadInst._registeredTools["file_upload"];

    const selectedFile = path.join(os.tmpdir(), `ocic-gate14-selected-${process.pid}.txt`);
    writeFileSync(selectedFile, "user-selected upload fixture, not a real secret", "utf-8");
    const outsidePath =
      process.platform === "win32" ? "C:\\Windows\\System32\\drivers\\etc\\hosts" : "/etc/passwd";

    try {
      const outsideArgs = await uploadInst.validateToolInput(
        uploadTool,
        { paths: [outsidePath], ref: "ref_1", tabId: 400 },
        "file_upload"
      );
      const outsideResult = await uploadInst.executeToolHandler(uploadTool, outsideArgs, {});
      const outsideText = outsideResult?.content?.[0]?.text ?? "";
      if (!outsideResult.isError) fail(`file_upload for a path never added to this run's upload allowlist was NOT rejected: ${outsidePath}`);
      if (!/path_not_allowlisted/.test(outsideText)) fail(`expected path_not_allowlisted, got: ${outsideText}`);
      if (bridgeCalls.length !== 0) fail("a non-allowlisted file_upload path reached the tool bridge");
      evidence.push(
        `PASS: file_upload for a real, existing filesystem path never explicitly selected by a user for this run ` +
          `(${outsidePath}) is rejected (path_not_allowlisted) by the REAL RunUploadAllowlist ` +
          "(host/agent/policy/authorization.js) — the tool bridge received zero dispatches."
      );

      uploadRun.uploadAllowlist.allow(selectedFile);
      const allowedArgs = await uploadInst.validateToolInput(
        uploadTool,
        { paths: [selectedFile], ref: "ref_1", tabId: 400 },
        "file_upload"
      );
      const allowedResult = await uploadInst.executeToolHandler(uploadTool, allowedArgs, {});
      if (allowedResult.isError) fail(`file_upload for an explicitly allowlisted path was unexpectedly rejected: ${allowedResult.content?.[0]?.text}`);
      if (bridgeCalls.length !== 1) fail(`expected exactly 1 dispatched call after allowlisting, got ${bridgeCalls.length}`);
      evidence.push(
        "PASS: file_upload for the SAME path, after this run's own uploadAllowlist explicitly authorized it (simulating " +
          "a user's own file-picker selection — the only thing that ever populates this allowlist), is allowed through " +
          "and reaches the tool bridge exactly once."
      );

      bridgeCalls.length = 0;
      const mixedArgs = await uploadInst.validateToolInput(
        uploadTool,
        { paths: [selectedFile, outsidePath], ref: "ref_1", tabId: 400 },
        "file_upload"
      );
      const mixedResult = await uploadInst.executeToolHandler(uploadTool, mixedArgs, {});
      if (!mixedResult.isError) fail("a file_upload call mixing one allowlisted and one non-allowlisted path was not rejected");
      if (bridgeCalls.length !== 0) fail("a mixed allowlisted/non-allowlisted file_upload call was partially dispatched");
      evidence.push(
        "PASS: a single file_upload call mixing an allowlisted path with a non-allowlisted one is rejected IN FULL " +
          "(path_not_allowlisted) — no partial dispatch of only the approved path."
      );
    } finally {
      try {
        unlinkSync(selectedFile);
      } catch {}
      uploadRun.stop("gate_test_cleanup");
    }
  }

  // --- 4. Capability-scoped filesystem allowlist for enabled-skill
  //        resources: a Read into a session's materialized skill snapshot is
  //        rejected outside that snapshot, and for a skill folder that
  //        exists on disk but was never part of THIS session's own approved
  //        allowedSkillNames list. Uses the REAL
  //        assertCanonicalSkillResourcePath() (host/agent/skills/
  //        session-workspace.js, task 7.2's application-owned half). -------
  {
    const { assertCanonicalSkillResourcePath } = await import("../../skills/session-workspace.js");
    const tmpRoot = mkdtempSync(path.join(os.tmpdir(), "ocic-gate14-skills-"));
    try {
      const skillsDir = path.join(tmpRoot, ".claude", "skills");
      const fsMod = await import("node:fs");
      fsMod.mkdirSync(path.join(skillsDir, "demo-skill"), { recursive: true });
      fsMod.writeFileSync(path.join(skillsDir, "demo-skill", "resource.txt"), "ok", "utf-8");
      fsMod.mkdirSync(path.join(skillsDir, "not-approved-skill"), { recursive: true });
      fsMod.writeFileSync(path.join(skillsDir, "not-approved-skill", "resource.txt"), "nope", "utf-8");
      fsMod.mkdirSync(path.join(tmpRoot, "outside-secret-dir"), { recursive: true });
      fsMod.writeFileSync(path.join(tmpRoot, "outside-secret-dir", "secret.txt"), "nope", "utf-8");

      const allowedSkillNames = ["demo-skill"]; // "not-approved-skill" exists on disk but is NOT in this session's own approved list

      const okPath = assertCanonicalSkillResourcePath(skillsDir, allowedSkillNames, "demo-skill/resource.txt");
      if (!okPath.endsWith("resource.txt")) fail("canonical path for an in-skill resource did not resolve to the expected file");
      evidence.push(
        "PASS: a resource inside an enabled skill's own materialized session snapshot is allowed " +
          "(assertCanonicalSkillResourcePath, host/agent/skills/session-workspace.js)."
      );

      let traversalRejected = false;
      try {
        assertCanonicalSkillResourcePath(skillsDir, allowedSkillNames, path.join("..", "..", "outside-secret-dir", "secret.txt"));
      } catch (err) {
        traversalRejected = /PATH_TRAVERSAL/.test(err.code || err.message || "");
      }
      if (!traversalRejected) fail("a path traversal outside the session's skill snapshot directory was not rejected");
      evidence.push("PASS: a path traversal outside the session's own skill-snapshot directory is rejected (PATH_TRAVERSAL).");

      let notApprovedRejected = false;
      try {
        assertCanonicalSkillResourcePath(skillsDir, allowedSkillNames, "not-approved-skill/resource.txt");
      } catch {
        notApprovedRejected = true;
      }
      if (!notApprovedRejected) fail("a resource under a skill folder present on disk but not in this session's own allowedSkillNames was not rejected");
      evidence.push(
        "PASS: a resource under a skill folder that exists on disk but was never part of THIS session's own approved " +
          "allowedSkillNames list is rejected — the filesystem allowlist is scoped per-session, not by mere on-disk " +
          "presence."
      );
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  }

  // Honest scope note: no tool in host/tool-definitions.js exposes an
  // arbitrary "artifact path" for a model to request in the first place
  // (host/agent/storage/paths.js's conversationArtifactsDir() is used only
  // internally by host/agent/storage/transcript-store.js, never as a
  // model-facing tool argument) — verified by grep, not assumed. There is
  // therefore no additional per-call allowlist to exercise for "approved
  // artifacts" beyond the id-safety check (assertSafeId) storage/paths.js
  // already applies to every conversation/artifact directory it constructs;
  // recorded here rather than silently claimed as "tested".
  evidence.push(
    "Note: 'approved artifacts' scoping has no separate per-call filesystem-allowlist surface to test, because no " +
      "registry tool accepts an arbitrary artifact path from the model in the first place (grep-verified against " +
      "host/tool-definitions.js) — every artifact path is host-constructed and id-validated " +
      "(host/agent/storage/paths.js's assertSafeId()), not model-supplied."
  );

  return {
    id: "1.4",
    title: "Rejected shell injection / unknown tools / malformed args; env & config isolation; tab scope, stale/cross-session capabilities, and filesystem allowlists",
    status: "PASS",
    evidence,
    gaps
  };
}

import { runAsCli } from "../lib/cli-runner.mjs";
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runAsCli(run);
}
