// Native file picker for the operator's upload grants.
//
// The extension cannot obtain a filesystem path from a page: a
// <input type="file"> selection in an extension page yields bytes, never a
// path (a browser security property, not an oversight of this project). The
// upload grant is path-based on purpose — CDP's DOM.setFileInputFiles takes
// real paths, so what reaches the page is the operator's actual file, live,
// never a copy this process made. That makes the OS dialog, owned by this
// native process, the only source of upload paths in the product — and by
// construction the only thing that can ever populate a run's
// RunUploadAllowlist (host/agent/policy/authorization.js).
//
// Every platform branch is a pure command builder plus a pure output parser,
// so the logic is testable without opening a dialog; only `spawn` is real.

import { spawn as defaultSpawn } from "node:child_process";

export const PICK_FILES_TIMEOUT_MS = 10 * 60 * 1000;
export const DEFAULT_PICK_FILES_PROMPT = "Chọn tệp cho agent được phép upload";

function psLiteral(s) {
  return "'" + String(s).replace(/'/g, "''") + "'";
}

function appleScriptLiteral(s) {
  return '"' + String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

function shellQuote(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

/**
 * @param {string} platform - process.platform ("win32" | "darwin" | anything
 *   else = POSIX shell branch).
 * @returns {{command: string, args: string[]}}
 */
export function buildPickFilesCommand(platform, { prompt = DEFAULT_PICK_FILES_PROMPT } = {}) {
  if (platform === "win32") {
    // -STA is required by System.Windows.Forms; -NoProfile keeps a user's
    // PowerShell profile from printing into the JSON stream we parse.
    const script = [
      "Add-Type -AssemblyName System.Windows.Forms | Out-Null",
      "$d = New-Object System.Windows.Forms.OpenFileDialog",
      "$d.Multiselect = $true",
      `$d.Title = ${psLiteral(prompt)}`,
      "if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { ConvertTo-Json -Compress @($d.FileNames) } else { '[]' }"
    ].join("; ");
    return { command: "powershell.exe", args: ["-NoProfile", "-STA", "-Command", script] };
  }
  if (platform === "darwin") {
    return {
      command: "osascript",
      args: [
        "-e",
        `set theFiles to choose file with prompt ${appleScriptLiteral(prompt)} with multiple selections allowed`,
        "-e",
        'set out to ""',
        "-e",
        "repeat with f in theFiles",
        "-e",
        "set out to out & POSIX path of f & linefeed",
        "-e",
        "end repeat",
        "-e",
        "return out"
      ]
    };
  }
  // Linux/BSD: zenity when present, kdialog otherwise — whichever exists
  // prints one path per line (kdialog via --separate-output) and exits
  // non-zero on cancel. `sh` (not bash) runs both: the command list below is
  // plain POSIX.
  const script = [
    `zenity --file-selection --multiple --title=${shellQuote(prompt)} 2>/dev/null`,
    `|| kdialog --getopenfilename --multiple --separate-output ${shellQuote("$HOME")} --title ${shellQuote(prompt)} 2>/dev/null`
  ].join(" ");
  return { command: "sh", args: ["-c", script] };
}

/**
 * Turn one picker run's exit status and output into the two outcomes the
 * extension understands: some paths, or a cancel.
 *
 * @returns {{cancelled: false, paths: string[]} | {cancelled: true, paths: []}}
 */
export function parsePickFilesOutput(platform, { code = 0, stdout = "", stderr = "" } = {}) {
  void stderr;
  if (platform === "win32") {
    const text = String(stdout).trim();
    if (!text) return { cancelled: true, paths: [] };
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      // Unparseable output is NOT a selection: the caller must not treat a
      // broken picker as "the user chose nothing" without knowing, so this
      // still reads as a cancel but with the raw text dropped, never guessed
      // into paths.
      return { cancelled: true, paths: [] };
    }
    // A single selection serializes to a bare string, not a one-element
    // array — both shapes are selections.
    const list = Array.isArray(parsed) ? parsed : typeof parsed === "string" ? [parsed] : [];
    const paths = list.filter((p) => typeof p === "string" && p);
    return paths.length ? { cancelled: false, paths } : { cancelled: true, paths: [] };
  }
  if (code !== 0) return { cancelled: true, paths: [] };
  // One per line; a picker whose separator is a bar (zenity's default in some
  // versions) is handled by splitting on either.
  const raw = String(stdout);
  const lines = raw.includes("\n") || raw.includes("\r") ? raw.split(/\r?\n/) : raw.split("|");
  const paths = lines.map((l) => l.trim()).filter(Boolean);
  return paths.length ? { cancelled: false, paths } : { cancelled: true, paths: [] };
}

/**
 * Open the native picker and resolve with its outcome. Rejects only when the
 * dialog could not be run at all (no picker binary, spawn failure, timeout) —
 * a cancel is a normal result, because it is a normal thing for a person to
 * do.
 */
export function runPickFiles({ platform = process.platform, spawn = defaultSpawn, prompt, timeoutMs = PICK_FILES_TIMEOUT_MS } = {}) {
  const { command, args } = buildPickFilesCommand(platform, { prompt });
  return new Promise((resolve, reject) => {
    let child;
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer = null;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      fn(value);
    };
    try {
      child = spawn(command, args, { windowsHide: true });
    } catch (e) {
      reject(e);
      return;
    }
    child.on("error", (e) => finish(reject, e));
    if (child.stdout) child.stdout.on("data", (d) => { stdout += d; });
    if (child.stderr) child.stderr.on("data", (d) => { stderr += d; });
    child.on("close", (code) => finish(resolve, parsePickFilesOutput(platform, { code: code ?? 0, stdout, stderr })));
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          /* already gone */
        }
        finish(reject, new Error("file picker timed out"));
      }, timeoutMs);
    }
  });
}
