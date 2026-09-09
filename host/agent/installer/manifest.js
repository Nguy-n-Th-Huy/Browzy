// Native messaging host manifest generation — a literal port of install.sh's
// `json_escape` + `generate_manifest` shell functions (see install.sh).

/**
 * JSON-escape backslashes so a Windows path can be embedded in a hand-built
 * JSON string. POSIX paths contain no backslashes, so this is a no-op on
 * macOS/Linux — exactly like install.sh's `json_escape`.
 *
 * @param {string} rawPath
 * @returns {string}
 */
export function jsonEscapePath(rawPath) {
  return String(rawPath).replace(/\\/g, "\\\\");
}

/**
 * Build the native messaging host manifest JSON text, byte-identical in
 * shape to install.sh's `generate_manifest` (same key order, same 2-space
 * indentation, same single trailing newline).
 *
 * @param {{hostName: string, description: string, execPath: string, extensionId: string}} opts
 * @returns {string}
 */
export function generateHostManifest({ hostName, description, execPath, extensionId }) {
  const escapedPath = jsonEscapePath(execPath);
  const origin = `chrome-extension://${extensionId}/`;
  return (
    [
      "{",
      `  "name": "${hostName}",`,
      `  "description": "${description}",`,
      `  "path": "${escapedPath}",`,
      `  "type": "stdio",`,
      `  "allowed_origins": [`,
      `    "${origin}"`,
      `  ]`,
      "}"
    ].join("\n") + "\n"
  );
}
