#requires -Version 7.2
[CmdletBinding()]
param(
    [ValidateRange(2, 9)]
    [int]$Players = 6,
    [ValidateRange(1, 200)]
    [int]$Hands = 24,
    [ValidateRange(1, 20)]
    [int]$NativeHands = 3,
    [ValidatePattern('^(holdem|omaha|omaha_bomb|indian)(,(holdem|omaha|omaha_bomb|indian))*$')]
    [string]$Games = 'holdem',
    [ValidateRange(1, 3)]
    [int]$MaxRunouts = 1,
    [ValidateRange(0, 10000000)]
    [int]$SevenDeuceBounty = 0,
    [switch]$SkipBrowser
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$oldPath = $env:PATH
$oldCa = $env:NODE_USE_SYSTEM_CA
$oldLocation = Get-Location
try {
    Set-Location -LiteralPath $PSScriptRoot
    & (Join-Path $PSScriptRoot 'Start-Local.ps1') -CheckOnly
    $tools = Join-Path $PSScriptRoot '.tools'
    $portable = if (Test-Path -LiteralPath $tools) {
        Get-ChildItem -LiteralPath $tools -Directory |
            Where-Object Name -Match '^node-v24\.\d+\.\d+-win-(x64|arm64)$' |
            Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
    }
    if ($portable) { $env:PATH = "$($portable.FullName);$env:PATH" }
    $env:NODE_USE_SYSTEM_CA = '1'
    $npm = (Get-Command $(if ($IsWindows) { 'npm.cmd' } else { 'npm' }) -ErrorAction Stop).Source
    & $npm test
    if ($LASTEXITCODE -ne 0) { throw 'Local unit/integration verification failed.' }
    if (-not $SkipBrowser) {
        & $npm run test:e2e
        if ($LASTEXITCODE -ne 0) {
            throw "Browser verification failed. See the output above. If Chromium is missing, run: & '$npm' exec playwright install chromium"
        }
    }
    & $npm run test:bots -- --players $Players --hands $Hands --native-hands $NativeHands --games $Games --max-runouts $MaxRunouts --bounty $SevenDeuceBounty
    if ($LASTEXITCODE -ne 0) { throw 'The isolated live bot sessions failed. See .artifacts\local-bot-run.json.' }
    Write-Host "`nLocal bot sessions completed. No Azure deployment was performed."
    Write-Host "Report: $(Join-Path $PSScriptRoot '.artifacts\local-bot-run.json')"
    if ($SkipBrowser) { Write-Warning 'Browser tests were explicitly skipped.' }
} finally {
    $env:PATH = $oldPath
    [Environment]::SetEnvironmentVariable('NODE_USE_SYSTEM_CA', $oldCa, 'Process')
    Set-Location -LiteralPath $oldLocation
}
