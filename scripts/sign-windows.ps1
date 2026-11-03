# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Ashutosh Sahoo
#
# sign-windows.ps1 - Tauri custom sign command target (bundle.windows.signCommand).
#
# Invoked by tauri-bundler once per file that needs an Authenticode signature
# (the main application .exe before bundling, then the NSIS installer .exe).
# Signs through SSL.com eSigner: the file's hash is sent to SSL.com's cloud
# HSM via CodeSignTool, which returns the file signed AND RFC 3161
# timestamped (SSL.com TSA) in place - no -output_dir_path is passed, so
# CodeSignTool overwrites the input file, exactly as the bundler expects.
#
# Contract:
#   - ESIGNER_USERNAME / ESIGNER_PASSWORD / ESIGNER_TOTP_SECRET unset or
#     empty  ->  signing is not configured: print a notice and exit 0 so
#     local builds and secret-less CI runs stay unsigned and green.
#   - Credentials set but CodeSignTool.bat cannot be located  ->  throw.
#     A release that asked for signing must never ship unsigned silently.
#   - CODESIGNTOOL_BAT (set by .github/workflows/release.yml) points at the
#     CodeSignTool.bat from the official SSL.com CodeSignTool release;
#     CODESIGNTOOL_HOME (its parent dir) and a .codesigntool\ search under
#     the workspace are accepted fallbacks.
#   - ESIGNER_CREDENTIAL_ID is optional: required only when the SSL.com
#     account holds more than one eSigner code-signing certificate.
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true, Position = 0)]
  [string]$FilePath
)

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($env:ESIGNER_USERNAME) -or
    [string]::IsNullOrWhiteSpace($env:ESIGNER_PASSWORD) -or
    [string]::IsNullOrWhiteSpace($env:ESIGNER_TOTP_SECRET)) {
  Write-Host "sign-windows: eSigner credentials not set - skipping signing of $FilePath"
  exit 0
}

$bat = $env:CODESIGNTOOL_BAT
if ([string]::IsNullOrWhiteSpace($bat) -and -not [string]::IsNullOrWhiteSpace($env:CODESIGNTOOL_HOME)) {
  $bat = Join-Path $env:CODESIGNTOOL_HOME 'CodeSignTool.bat'
}
if ([string]::IsNullOrWhiteSpace($bat) -or -not (Test-Path $bat)) {
  $bat = $null
  $roots = @($env:GITHUB_WORKSPACE, (Get-Location).Path) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
  foreach ($root in $roots) {
    $toolDir = Join-Path $root '.codesigntool'
    if (Test-Path $toolDir) {
      $found = Get-ChildItem -Path $toolDir -Recurse -Filter 'CodeSignTool.bat' -ErrorAction SilentlyContinue |
        Select-Object -First 1
      if ($found) { $bat = $found.FullName; break }
    }
  }
}
if ([string]::IsNullOrWhiteSpace($bat) -or -not (Test-Path $bat)) {
  throw 'sign-windows: ESIGNER_* credentials are set but CodeSignTool.bat was not found (CODESIGNTOOL_BAT). Refusing to continue - the artifact would ship unsigned.'
}

$signArgs = @(
  'sign',
  "-username=$env:ESIGNER_USERNAME",
  "-password=$env:ESIGNER_PASSWORD",
  "-totp_secret=$env:ESIGNER_TOTP_SECRET",
  "-input_file_path=$FilePath"
)
if (-not [string]::IsNullOrWhiteSpace($env:ESIGNER_CREDENTIAL_ID)) {
  $signArgs += "-credential_id=$env:ESIGNER_CREDENTIAL_ID"
}

Write-Host "sign-windows: signing $FilePath via eSigner CodeSignTool"
& $bat @signArgs
if ($LASTEXITCODE -ne 0) {
  throw "sign-windows: CodeSignTool exited with code $LASTEXITCODE while signing $FilePath"
}
Write-Host "sign-windows: signed $FilePath"
