#requires -Version 7.2
[CmdletBinding()]
param(
    [ValidateRange(1024, 65535)]
    [int]$Port = 8080,
    [switch]$SkipBuild,
    [switch]$CheckOnly
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$oldPath = $env:PATH
$oldLocation = Get-Location
$oldEnvironment = @{}
foreach ($name in @('PORT', 'APP_ORIGIN', 'HOST', 'NODE_USE_SYSTEM_CA')) {
    $oldEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
}
try {
    Set-Location -LiteralPath $root
    $node = Get-Command node -ErrorAction SilentlyContinue
    if ($node) {
        $major = (& $node.Source --version).Trim().Split('.')[0]
        if ($LASTEXITCODE -ne 0 -or $major -ne 'v24') { $node = $null }
    }
    if (-not $node) {
        if (-not $IsWindows) { throw 'Install Node.js 24 LTS, then rerun this script. Portable automatic installation is supported on Windows.' }
        $tools = Join-Path $root '.tools'
        $existing = if (Test-Path -LiteralPath $tools) {
            Get-ChildItem -LiteralPath $tools -Directory | Where-Object Name -Match '^node-v24\.\d+\.\d+-win-(x64|arm64)$' | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
        }
        if (-not $existing) {
            Write-Host 'Node.js 24 is missing. Downloading a verified portable toolchain from nodejs.org.'
            $architecture = if ([Runtime.InteropServices.RuntimeInformation]::OSArchitecture -eq 'Arm64') { 'arm64' } else { 'x64' }
            $releases = Invoke-RestMethod -Uri 'https://nodejs.org/dist/index.json'
            $release = $releases | Where-Object { $_.version -match '^v24\.' -and $_.lts -and $_.files -contains "win-$architecture-zip" } | Select-Object -First 1
            if (-not $release -or $release.version -notmatch '^v24\.\d+\.\d+$') { throw 'An official Node.js 24 LTS release could not be resolved.' }
            $archiveName = "node-$($release.version)-win-$architecture.zip"
            $downloadBase = "https://nodejs.org/dist/$($release.version)"
            $sums = (Invoke-WebRequest -Uri "$downloadBase/SHASUMS256.txt").Content
            $line = @($sums -split "`n" | Where-Object { $_.Trim().EndsWith(" $archiveName", [StringComparison]::Ordinal) })
            if ($line.Count -ne 1) { throw 'The official checksum manifest did not contain exactly one matching archive.' }
            $expected = ($line[0] -split '\s+')[0].ToUpperInvariant()
            $null = New-Item -ItemType Directory -Path $tools -Force
            $archive = Join-Path $tools $archiveName
            try {
                Invoke-WebRequest -Uri "$downloadBase/$archiveName" -OutFile $archive
                if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ne $expected) { throw 'Node.js archive checksum mismatch. Refusing to extract it.' }
                Expand-Archive -LiteralPath $archive -DestinationPath $tools
            } finally { if (Test-Path -LiteralPath $archive) { Remove-Item -LiteralPath $archive -Force } }
            $existing = Get-Item -LiteralPath (Join-Path $tools ([IO.Path]::GetFileNameWithoutExtension($archiveName)))
        }
        $env:PATH = "$($existing.FullName);$env:PATH"
        $node = Get-Command node -ErrorAction Stop
    }
    $env:NODE_USE_SYSTEM_CA = '1'
    $npm = (Get-Command $(if ($IsWindows) { 'npm.cmd' } else { 'npm' }) -ErrorAction Stop).Source
    if (-not (Test-Path -LiteralPath (Join-Path $root 'node_modules\.package-lock.json'))) {
        Write-Host 'Installing the locked application dependencies.'
        & $npm ci --ignore-scripts --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed.' }
    }
    if (-not $SkipBuild) {
        & $npm run build
        if ($LASTEXITCODE -ne 0) { throw 'The application build failed.' }
    }
    if (-not (Test-Path -LiteralPath (Join-Path $root 'dist\server\index.js')) -or -not (Test-Path -LiteralPath (Join-Path $root 'dist\client\index.html'))) {
        throw 'The production build is missing. Run again without -SkipBuild.'
    }
    if ($CheckOnly) { Write-Host "Local application is built and ready: $root"; return }
    $env:PORT = [string]$Port
    $env:APP_ORIGIN = "http://localhost:$Port"
    $env:HOST = '127.0.0.1'
    Write-Host "`nStarting River Room at $env:APP_ORIGIN"
    Write-Host "Data stays in this project's .data folder unless DATA_DIR or DATABASE_URL is configured."
    Write-Host 'Keep this terminal open. Press Ctrl+C to stop the server safely.'
    $server = [Diagnostics.Process]::new()
    $server.StartInfo.FileName = $node.Source
    $server.StartInfo.WorkingDirectory = $root
    $server.StartInfo.UseShellExecute = $false
    $server.StartInfo.RedirectStandardInput = $true
    $server.StartInfo.Environment['RIVER_ROOM_PARENT_STDIN'] = '1'
    $server.StartInfo.ArgumentList.Add('--env-file-if-exists=.env')
    $server.StartInfo.ArgumentList.Add((Join-Path $root 'dist\server\index.js'))
    $started = $false
    try {
        $started = $server.Start()
        if (-not $started) { throw 'The River Room server process could not be started.' }
        while (-not $server.WaitForExit(250)) {}
        if ($server.ExitCode -ne 0) { throw "The River Room server exited with code $($server.ExitCode)." }
    } finally {
        if ($started) {
            # Closing the owned pipe also stops Node if this launcher is interrupted or terminated.
            try { $server.StandardInput.Close() } catch {}
            if (-not $server.HasExited -and -not $server.WaitForExit(17000)) {
                Write-Warning "Server process $($server.Id) did not stop within 17 seconds. Stopping only that process."
                Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue
                $null = $server.WaitForExit(3000)
            }
        }
        $server.Dispose()
    }
} finally {
    $env:PATH = $oldPath
    foreach ($name in $oldEnvironment.Keys) { [Environment]::SetEnvironmentVariable($name, $oldEnvironment[$name], 'Process') }
    Set-Location -LiteralPath $oldLocation
}
