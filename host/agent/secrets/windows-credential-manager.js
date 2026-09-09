// Windows Credential Manager secret-store adapter.
//
// No native addon and no new npm dependency: this shells out to
// `powershell.exe`, using `Add-Type` to P/Invoke the same Win32
// Credential Manager APIs (`CredWriteW`/`CredReadW`/`CredDeleteW` in
// advapi32.dll) that the Windows "Credential Manager" control panel and
// `vaultcmd` use — a generic credential, persisted as
// `CRED_PERSIST_LOCAL_MACHINE`, scoped to the current Windows user account.
//
// The secret itself never appears on a command line (visible to every other
// process on the machine via Task Manager / `Get-Process`/`ps` while the
// child runs) and is never written to a file: it is sent to PowerShell over
// stdin and read back over stdout, both base64-encoded so the console's text
// encoding/newline handling can't corrupt it. Only the (non-secret)
// credential *target name* is passed, via an environment variable — never
// string-interpolated into the script text — to avoid any injection concern.

import { execFileSync } from "node:child_process";

const CRED_TYPE_GENERIC = 1;
const CRED_PERSIST_LOCAL_MACHINE = 2;

// Shared C# P/Invoke declarations, injected once per invocation via
// `Add-Type`. Every script below starts from this same definition so the
// three operations (write/read/delete) share identical marshaling.
const CSHARP_CRED_MAN = `
using System;
using System.Runtime.InteropServices;
public class OcicCredMan {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct CREDENTIAL {
        public uint Flags;
        public uint Type;
        public string TargetName;
        public string Comment;
        public long LastWritten;
        public uint CredentialBlobSize;
        public IntPtr CredentialBlob;
        public uint Persist;
        public uint AttributeCount;
        public IntPtr Attributes;
        public string TargetAlias;
        public string UserName;
    }
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern bool CredWrite(ref CREDENTIAL credential, uint flags);
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern bool CredRead(string target, uint type, uint flags, out IntPtr credentialPtr);
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern bool CredDelete(string target, uint type, uint flags);
    [DllImport("advapi32.dll", SetLastError = true)]
    public static extern void CredFree(IntPtr cred);
}
`;

function runPowerShell(script, { input, env } = {}) {
  return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], {
    input: input ?? "",
    env: { ...process.env, ...env },
    encoding: "utf-8",
    windowsHide: true
  });
}

/**
 * @param {string} target non-secret credential target name (e.g.
 *   "browzy-in-chrome/settings/default")
 * @param {string} secret
 */
export function windowsCredWrite(target, secret) {
  const secretB64 = Buffer.from(secret, "utf-8").toString("base64");
  const script = `
$csharpSource = @'
${CSHARP_CRED_MAN}
'@
Add-Type -TypeDefinition $csharpSource -ErrorAction Stop
$target = $env:OCIC_CRED_TARGET
$secretB64 = [Console]::In.ReadToEnd()
$secretBytes = [System.Text.Encoding]::Unicode.GetBytes([System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($secretB64)))
$blobPtr = [System.Runtime.InteropServices.Marshal]::AllocHGlobal($secretBytes.Length)
try {
  [System.Runtime.InteropServices.Marshal]::Copy($secretBytes, 0, $blobPtr, $secretBytes.Length)
  $cred = New-Object OcicCredMan+CREDENTIAL
  $cred.Type = ${CRED_TYPE_GENERIC}
  $cred.TargetName = $target
  $cred.CredentialBlobSize = [uint32]$secretBytes.Length
  $cred.CredentialBlob = $blobPtr
  $cred.Persist = ${CRED_PERSIST_LOCAL_MACHINE}
  $cred.UserName = "browzy-in-chrome"
  $ok = [OcicCredMan]::CredWrite([ref]$cred, 0)
  if (-not $ok) {
    $err = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
    Write-Error "CredWrite failed with Win32 error $err"
    exit 1
  }
} finally {
  [System.Runtime.InteropServices.Marshal]::FreeHGlobal($blobPtr)
}
exit 0
`;
  runPowerShell(script, { input: secretB64, env: { OCIC_CRED_TARGET: target } });
}

/**
 * @param {string} target
 * @returns {string|null} the secret, or null if no credential is stored under `target`.
 */
export function windowsCredRead(target) {
  const script = `
$csharpSource = @'
${CSHARP_CRED_MAN}
'@
Add-Type -TypeDefinition $csharpSource -ErrorAction Stop
$target = $env:OCIC_CRED_TARGET
$ptr = [IntPtr]::Zero
$ok = [OcicCredMan]::CredRead($target, ${CRED_TYPE_GENERIC}, 0, [ref]$ptr)
if (-not $ok) { exit 2 }
try {
  $credStruct = [System.Runtime.InteropServices.Marshal]::PtrToStructure($ptr, [type][OcicCredMan+CREDENTIAL])
  $bytes = New-Object byte[] $credStruct.CredentialBlobSize
  [System.Runtime.InteropServices.Marshal]::Copy($credStruct.CredentialBlob, $bytes, 0, $credStruct.CredentialBlobSize)
  $secret = [System.Text.Encoding]::Unicode.GetString($bytes)
  [Console]::Out.Write([System.Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($secret)))
} finally {
  [OcicCredMan]::CredFree($ptr)
}
exit 0
`;
  try {
    const out = runPowerShell(script, { env: { OCIC_CRED_TARGET: target } });
    const trimmed = out.trim();
    if (!trimmed) return null;
    return Buffer.from(trimmed, "base64").toString("utf-8");
  } catch (err) {
    if (err.status === 2) return null;
    throw err;
  }
}

/**
 * @param {string} target
 * @returns {boolean} true if a credential was deleted, false if none existed.
 */
export function windowsCredDelete(target) {
  const script = `
$csharpSource = @'
${CSHARP_CRED_MAN}
'@
Add-Type -TypeDefinition $csharpSource -ErrorAction Stop
$target = $env:OCIC_CRED_TARGET
$ok = [OcicCredMan]::CredDelete($target, ${CRED_TYPE_GENERIC}, 0)
if (-not $ok) { exit 2 }
exit 0
`;
  try {
    runPowerShell(script, { env: { OCIC_CRED_TARGET: target } });
    return true;
  } catch (err) {
    if (err.status === 2) return false;
    throw err;
  }
}

/**
 * @returns {boolean} true if this platform can plausibly use Windows
 *   Credential Manager (does not guarantee a call will succeed — actual
 *   availability is confirmed by a real write+read+delete probe, see
 *   `isAvailable()` in secret-store.js).
 */
export function isWindowsCredentialManagerPlatform() {
  return process.platform === "win32";
}
