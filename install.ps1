<#
.SYNOPSIS
    Installs the Browzy native messaging host for Chrome, Edge,
    and Brave on native Windows PowerShell — no Git Bash / MSYS2 required.

.DESCRIPTION
    THIS IS A THIN SHIM. The actual registration logic (deriving the
    extension id, generating the native-messaging manifest, writing it per
    browser, the Windows registry branch, write-if-changed/backup semantics,
    the -Only filter) now lives once in the cross-platform Node CLI at
    host/agent/installer/, shared by this script, install.sh, and the
    published `browzy` npm CLI (`npm i -g @huydepzai2810/browzy-host` then
    `browzy install`) — see host/agent/installer/core.js for the annotated
    implementation. Keeping one implementation means the three entry points
    can never drift from each other.

    By default every installed/selected browser is registered. The extension
    id is derived automatically from the extension's persistent public key
    unless overridden with -ExtensionId.

    Rerunning this script is a no-op when nothing changed, and it only ever
    writes/backs up registry keys and files that belong to THIS product's own
    native-messaging host name — it never touches another extension's
    registration.

.PARAMETER Only
    Comma-separated subset of browsers to register: chrome, edge, brave.
    Default: all three.

.PARAMETER ExtensionId
    Override the built-in extension id (derived from the persistent public
    key). Needed for a Chrome Web Store install, which is assigned its own
    id — see package-extension.sh.

.PARAMETER RegistryRoot
    Test hook only (never needed for a real install): overrides the
    HKCU:\Software root used for native-host registration, so the test suite
    can point registration at a scratch registry subtree instead of the real
    per-browser keys.

.EXAMPLE
    .\install.ps1

.EXAMPLE
    .\install.ps1 -Only chrome,edge
#>
[CmdletBinding(PositionalBinding = $false)]
param(
    [string]$Only = "",
    [string]$ExtensionId = "",
    [string]$RegistryRoot = "HKCU:\Software",
    [switch]$Help
)
# PositionalBinding is deliberately off: there is no positional extension-ID
# argument, ever (use -ExtensionId), so a bare positional argument like the
# old `.\install.ps1 <id>` usage must be a hard parameter-binding error.

$ErrorActionPreference = "Stop"

$ScriptDir = $PSScriptRoot
if ([string]::IsNullOrEmpty($ScriptDir)) {
    $ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
}
$HostDir = Join-Path $ScriptDir "host"

$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
    Write-Host "Error: node is not installed. Install Node.js first, then rerun this script." -ForegroundColor Red
    exit 1
}
$NodeExePath = $nodeCmd.Source

$NativeHostJs = Join-Path $HostDir "native-host.js"
if (-not (Test-Path -LiteralPath $NativeHostJs)) {
    Write-Host "Error: $NativeHostJs not found." -ForegroundColor Red
    Write-Host "Run this script from the project's own install.ps1 (it locates the" -ForegroundColor Red
    Write-Host "host directory next to itself); do not copy install.ps1 elsewhere." -ForegroundColor Red
    exit 1
}

$BrowzyCli = Join-Path $HostDir "bin\browzy.js"
if (-not (Test-Path -LiteralPath $BrowzyCli)) {
    Write-Host "Error: $BrowzyCli not found." -ForegroundColor Red
    Write-Host "The install CLI is missing from this checkout - pull the latest changes." -ForegroundColor Red
    exit 1
}

# Verify npm dependencies are installed. Only needed for this local
# git-clone dev flow: a global `npm i -g @huydepzai2810/browzy-host` install
# already has every dependency resolved by npm itself. Not optional — the
# companion cannot run at all without these, so a failure here is fatal.
if (-not (Test-Path -LiteralPath (Join-Path $HostDir "node_modules"))) {
    Write-Host "Installing npm dependencies..."
    Push-Location -LiteralPath $HostDir
    npm install
    $hostNpmExit = $LASTEXITCODE
    Pop-Location
    if ($hostNpmExit -ne 0) {
        Write-Host "Error: dependency installation failed in $HostDir." -ForegroundColor Red
        Write-Host "The companion cannot run until 'npm install' succeeds there - fix the error above and rerun this script." -ForegroundColor Red
        exit 1
    }
}

# The codemode/hybrid servers bundle a Cloudflare Worker (execute_code) that
# imports @cloudflare/codemode; wrangler's build fails if the worker's own
# dependencies aren't installed. Install them here so execute_code works.
# This is optional — only the execute_code feature depends on it — so a
# failure here must not abort the rest of the install (native-host
# registration below still needs to run even if this fails).
$WorkerDir = Join-Path $HostDir "codemode\worker"
if ((Test-Path -LiteralPath (Join-Path $WorkerDir "package.json")) -and -not (Test-Path -LiteralPath (Join-Path $WorkerDir "node_modules"))) {
    Write-Host "Installing codemode worker dependencies..."
    Push-Location -LiteralPath $WorkerDir
    npm install
    $workerNpmExit = $LASTEXITCODE
    Pop-Location
    if ($workerNpmExit -ne 0) {
        Write-Host "Warning: codemode worker dependency install failed - the execute_code feature will be unavailable. Continuing with the rest of the install." -ForegroundColor Yellow
    }
}

# Hand off to the real implementation. -RegistryRoot is a test hook the Node
# CLI reads from the environment (OCIC_REGISTRY_ROOT, reg.exe form, e.g.
# "HKCU\Software") rather than as a CLI flag — translate PowerShell's PSDrive
# form ("HKCU:\Software") the same way install.ps1 always has for reg.exe
# export/query calls.
$cliArgs = @("install")
if ($Only) { $cliArgs += "--only=$Only" }
if ($ExtensionId) { $cliArgs += @("--extension-id", $ExtensionId) }
if ($Help) { $cliArgs += "--help" }

if ($RegistryRoot -and $RegistryRoot -ne "HKCU:\Software") {
    $env:OCIC_REGISTRY_ROOT = ($RegistryRoot -replace '^HKCU:', 'HKCU')
}

& $NodeExePath $BrowzyCli @cliArgs
exit $LASTEXITCODE
