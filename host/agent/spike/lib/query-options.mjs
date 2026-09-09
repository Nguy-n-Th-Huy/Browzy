// Builds the isolated `query()` Options object used by every gate.
//
// Encodes design.md decision 0/2/4's isolation requirements as a single,
// inspectable object so gates can assert on its literal fields instead of on
// claims:
//   - `env` REPLACES the child process environment (documented SDK
//     semantics: "this value REPLACES the subprocess environment entirely —
//     it is not merged with process.env"). Only PATH/SystemRoot (needed to
//     spawn the bundled runtime itself) and the two Anthropic credential
//     variables are present — no ambient credentials, no ANTHROPIC_* left
//     over from the developer's own shell, no unrelated secrets.
//   - `mcpServers` carries exactly one entry: this project's own in-process
//     browser server. No user-configured MCP server is referenced.
//   - `strictMcpConfig: true` makes the SDK ignore project .mcp.json, user
//     settings, plugins, and on-disk agent frontmatter MCP — the documented
//     "only use MCP servers passed via the mcpServers option" mode.
//   - `settingSources: []` disables ~/.claude/settings.json, project and
//     local settings entirely (the SDK's own "isolation mode").
//   - `tools: []` disables every built-in tool (Bash, Write, Edit, Read,
//     Glob, Grep, WebFetch, Task/subagents, ...). Only the explicit
//     mcpServers tools remain.
//   - `disallowedTools` repeats the highest-risk built-ins by name as a
//     defense-in-depth belt-and-suspenders check alongside `tools: []`.

const HIGH_RISK_BUILTINS = ["Bash", "Write", "Edit", "Task", "WebFetch", "WebSearch", "NotebookEdit"];

/**
 * @param {object} params
 * @param {object} params.mcpServer - result of createBrowserMcpServer()
 * @param {string} params.baseUrl - ANTHROPIC_BASE_URL value
 * @param {string} params.apiKey - ANTHROPIC_API_KEY value
 * @param {string} [params.model]
 * @param {AbortController} [params.abortController]
 * @param {object} [params.extraEnv] - additional isolated env entries (never
 *   a process.env spread; callers should pass explicit key/value pairs only)
 * @param {string} params.serverName - key under mcpServers (defaults to the
 *   SDK_MCP_SERVER_NAME export from adapter.mjs, passed in by the caller so
 *   this module has no static dependency on tool-runtime.js)
 */
export function buildIsolatedOptions({
  mcpServer,
  serverName,
  baseUrl,
  apiKey,
  model,
  abortController,
  extraEnv = {}
} = {}) {
  if (!mcpServer) throw new Error("buildIsolatedOptions requires mcpServer");
  if (!serverName) throw new Error("buildIsolatedOptions requires serverName");

  // Only what the bundled runtime itself needs to start, plus the provider
  // credential — deliberately never `...process.env`.
  const env = {
    PATH: process.env.PATH || process.env.Path || "",
    ...(process.platform === "win32" ? { SystemRoot: process.env.SystemRoot || "" } : {}),
    ANTHROPIC_BASE_URL: baseUrl,
    ANTHROPIC_API_KEY: apiKey,
    ...extraEnv
  };

  return {
    abortController,
    model,
    mcpServers: { [serverName]: mcpServer },
    strictMcpConfig: true,
    settingSources: [],
    tools: [],
    disallowedTools: [...HIGH_RISK_BUILTINS],
    env
  };
}

export { HIGH_RISK_BUILTINS };
