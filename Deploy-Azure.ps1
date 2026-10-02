#requires -Version 7.2
[CmdletBinding(SupportsShouldProcess)]
param(
    [ValidatePattern('^[a-z][a-z0-9-]{1,21}[a-z0-9]$')]
    [string]$AppName = 'river-room',
    [string]$ResourceGroup = 'river-room-northcentral-rg',
    [string]$Location = 'northcentralus',
    [string]$SubscriptionId,
    [string]$DeployerObjectId,
    [ValidateSet('User', 'ServicePrincipal', 'Group')]
    [string]$DeployerPrincipalType = 'User',
    [ValidateSet('Standard_B1ms', 'Standard_B2s')]
    [string]$DatabaseSku = 'Standard_B1ms',
    [string]$SourceRegistryResourceId,
    [ValidatePattern('^[a-z0-9]+(?:[._/-][a-z0-9]+)*@sha256:[a-f0-9]{64}$')]
    [string]$SourceImageDigest,
    [switch]$AcceptAzureCharges,
    [switch]$ValidateOnly
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ($AppName.Contains('--')) { throw 'AppName cannot contain consecutive hyphens.' }
if ([bool]$SourceRegistryResourceId -xor [bool]$SourceImageDigest) {
    throw 'Supply both SourceRegistryResourceId and SourceImageDigest to import an already verified image.'
}
$root = $PSScriptRoot
$az = (Get-Command az -ErrorAction Stop).Source
$oldPythonUtf8 = $env:PYTHONUTF8
$oldPythonEncoding = $env:PYTHONIOENCODING
$env:PYTHONUTF8 = '1'
$env:PYTHONIOENCODING = 'utf-8'
function Invoke-Azure([string[]]$Arguments) {
    $output = & $az @Arguments --only-show-errors
    if ($LASTEXITCODE -ne 0) { throw "Azure CLI failed: az $($Arguments[0..([Math]::Min(2, $Arguments.Length - 1))] -join ' ')" }
    return ($output -join "`n")
}
function New-Secret {
    return 'Rr!' + [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)).ToLowerInvariant()
}
function Save-PrivateParameters([string]$Path, [hashtable]$Parameters) {
    $values = @{}
    foreach ($key in $Parameters.Keys) { $values[$key] = @{ value = $Parameters[$key] } }
    $document = @{
        '$schema' = 'https://schema.management.azure.com/schemas/2019-04-01/deploymentParameters.json#'
        contentVersion = '1.0.0.0'
        parameters = $values
    }
    [IO.File]::WriteAllText($Path, ($document | ConvertTo-Json -Depth 12))
}
function New-BuildContext([string]$Path) {
    $null = New-Item -ItemType Directory -Path $Path
    foreach ($name in @('Dockerfile', '.dockerignore', 'package.json', 'package-lock.json',
        'tsconfig.json', 'tsconfig.server.json', 'vite.config.ts', 'index.html', 'src', 'public')) {
        $source = Join-Path $root $name
        if (-not (Test-Path -LiteralPath $source)) { throw "Missing container build input: $name" }
        Copy-Item -LiteralPath $source -Destination $Path -Recurse -Force
    }
}

$temp = Join-Path ([IO.Path]::GetTempPath()) ('river-room-deploy-' + [guid]::NewGuid().ToString('N'))
$null = New-Item -ItemType Directory -Path $temp -WhatIf:$false -Confirm:$false
try {
    if ($IsWindows) {
        $acl = [Security.AccessControl.DirectorySecurity]::new()
        $acl.SetAccessRuleProtection($true, $false)
        $rule = [Security.AccessControl.FileSystemAccessRule]::new(
            [Security.Principal.WindowsIdentity]::GetCurrent().User,
            [Security.AccessControl.FileSystemRights]::FullControl,
            [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit',
            [Security.AccessControl.PropagationFlags]::None,
            [Security.AccessControl.AccessControlType]::Allow
        )
        $acl.AddAccessRule($rule)
        Set-Acl -LiteralPath $temp -AclObject $acl -WhatIf:$false -Confirm:$false
    } else {
        & chmod 700 $temp
        if ($LASTEXITCODE -ne 0) { throw 'Could not protect temporary deployment parameters.' }
    }

    & $az bicep version --only-show-errors *> $null
    if ($LASTEXITCODE -ne 0) { $null = Invoke-Azure @('bicep', 'install') }
    $null = Invoke-Azure @('bicep', 'build', '--file', (Join-Path $root 'infra\main.bicep'), '--outdir', $temp)
    $null = Invoke-Azure @('bicep', 'build', '--file', (Join-Path $root 'infra\app.bicep'), '--outdir', $temp)
    if ($ValidateOnly) {
        Write-Host 'Both Azure templates compiled. No Azure resources were created or changed.'
        return
    }
    if (-not $AcceptAzureCharges -and -not $WhatIfPreference) {
        throw 'This creates billable Azure resources. Review README.md and run again with -AcceptAzureCharges to authorize deployment.'
    }
    if (-not $PSCmdlet.ShouldProcess("$ResourceGroup in $Location", 'Create/update River Room, PostgreSQL, Key Vault, Container Registry, logging, and private networking')) { return }
    if ($SubscriptionId) { $null = Invoke-Azure @('account', 'set', '--subscription', $SubscriptionId) }
    $account = (Invoke-Azure @('account', 'show', '--output', 'json')) | ConvertFrom-Json
    if (-not $DeployerObjectId) {
        if ($account.user.type -ne 'user') { throw 'For service-principal deployments, provide -DeployerObjectId and -DeployerPrincipalType ServicePrincipal.' }
        $DeployerObjectId = (Invoke-Azure @('ad', 'signed-in-user', 'show', '--query', 'id', '--output', 'tsv')).Trim()
    }
    if (-not [guid]::TryParse($DeployerObjectId, [ref]([guid]::Empty))) { throw 'DeployerObjectId must be a Microsoft Entra object GUID.' }
    foreach ($provider in @('Microsoft.App', 'Microsoft.OperationalInsights', 'Microsoft.ContainerRegistry', 'Microsoft.DBforPostgreSQL', 'Microsoft.KeyVault', 'Microsoft.ManagedIdentity', 'Microsoft.Network')) {
        $null = Invoke-Azure @('provider', 'register', '--namespace', $provider, '--wait', '--output', 'none')
    }
    $capabilities = (Invoke-Azure @('rest', '--method', 'get', '--url',
        "https://management.azure.com/subscriptions/$($account.id)/providers/Microsoft.DBforPostgreSQL/locations/$Location/capabilities?api-version=2024-08-01",
        '--output', 'json')) | ConvertFrom-Json
    $availableCapabilities = @($capabilities.value | Where-Object { $_.restricted -eq 'Disabled' })
    if (-not $availableCapabilities.Count) {
        throw "PostgreSQL is restricted or unavailable for this subscription in $Location. Select an allowed region before creating a new stack; do not guess a different database version."
    }
    $supportedDatabase = @($availableCapabilities | Where-Object {
        $versions = @($_.supportedServerVersions | Where-Object { $_.name -eq '16' })
        $editions = @($_.supportedServerEditions | Where-Object { $_.name -eq 'Burstable' })
        $skus = @($editions | ForEach-Object { $_.supportedServerSkus } | Where-Object { $_.name -eq $DatabaseSku })
        $storage = @($editions | ForEach-Object { $_.supportedStorageEditions } |
            ForEach-Object { $_.supportedStorageMb } | Where-Object { $_.storageSizeMb -eq 32768 })
        $versions.Count -and $skus.Count -and $storage.Count -and $_.storageAutoGrowthSupported -eq 'Enabled'
    })
    if (-not $supportedDatabase.Count) {
        throw "This subscription does not advertise PostgreSQL16/$DatabaseSku/32GiB with autogrow in $Location. No new stack has been created."
    }
    $groupExists = (Invoke-Azure @('group', 'exists', '--name', $ResourceGroup, '--output', 'tsv')).Trim() -eq 'true'
    if ($groupExists) {
        $resources = (Invoke-Azure @('resource', 'list', '--resource-group', $ResourceGroup,
            '--query', "[?tags.riverRoomApp=='$AppName'].{name:name,location:location}", '--output', 'json')) | ConvertFrom-Json
        if (@($resources | Where-Object { $_.location -and $_.location -ne 'global' -and $_.location -ne $Location }).Count) {
            throw 'Existing River Room resources are in another region. Use a new resource group rather than relocating or overwriting that stack.'
        }
    } else {
        $null = Invoke-Azure @('group', 'create', '--name', $ResourceGroup, '--location', $Location, '--tags', "riverRoomApp=$AppName", '--output', 'none')
    }
    $existingVault = (Invoke-Azure @('keyvault', 'list', '--resource-group', $ResourceGroup, '--query', "[?tags.riverRoomApp=='$AppName'] | [0].name", '--output', 'tsv')).Trim()
    if ($existingVault) {
        Write-Host 'Reusing the existing database password and host key.'
        $databasePassword = (Invoke-Azure @('keyvault', 'secret', 'show', '--vault-name', $existingVault, '--name', 'database-admin-password', '--query', 'value', '--output', 'tsv')).Trim()
        $hostKey = (Invoke-Azure @('keyvault', 'secret', 'show', '--vault-name', $existingVault, '--name', 'host-key', '--query', 'value', '--output', 'tsv')).Trim()
        if (-not $databasePassword -or -not $hostKey) { throw 'Existing credentials could not be loaded. Do not replace or reset the database.' }
    } else {
        $databasePassword = New-Secret
        $hostKey = New-Secret
    }
    $parameterFile = Join-Path $temp 'infra.parameters.json'
    Save-PrivateParameters $parameterFile @{
        appName = $AppName; location = $Location; deployerObjectId = $DeployerObjectId
        deployerPrincipalType = $DeployerPrincipalType; databasePassword = $databasePassword
        hostKey = $hostKey; databaseSku = $DatabaseSku
    }
    Write-Host 'Creating durable infrastructure. Database provisioning can take several minutes.'
    $deployment = (Invoke-Azure @(
        'deployment', 'group', 'create', '--name', "$AppName-infrastructure",
        '--resource-group', $ResourceGroup, '--template-file', (Join-Path $temp 'main.json'),
        '--parameters', "@$parameterFile", '--output', 'json'
    )) | ConvertFrom-Json
    $outputs = $deployment.properties.outputs
    $imageTag = 'r' + [DateTime]::UtcNow.ToString('yyyyMMddHHmmss') + '-' + [guid]::NewGuid().ToString('N').Substring(0, 5)
    if ($SourceImageDigest) {
        Write-Host 'Importing the verified immutable image into the regional registry.'
        $null = Invoke-Azure @('acr', 'import', '--name', $outputs.registryName.value,
            '--registry', $SourceRegistryResourceId, '--source', $SourceImageDigest,
            '--image', "river-room:$imageTag", '--output', 'none')
        $importedDigest = (Invoke-Azure @('acr', 'repository', 'show', '--name', $outputs.registryName.value,
            '--image', "river-room:$imageTag", '--query', 'digest', '--output', 'tsv')).Trim()
        if ($importedDigest -ne $SourceImageDigest.Split('@')[1]) { throw 'The imported image digest does not match the verified build.' }
    } else {
        Write-Host 'Building the Linux container in Azure Container Registry. Local Docker is not required.'
        $buildContext = Join-Path $temp 'container-source'
        New-BuildContext $buildContext
        $null = Invoke-Azure @('acr', 'build', '--registry', $outputs.registryName.value, '--image', "river-room:$imageTag", '--platform', 'linux/amd64', '--file', (Join-Path $buildContext 'Dockerfile'), $buildContext, '--no-logs', '--output', 'none')
    }
    $appParameters = Join-Path $temp 'app.parameters.json'
    Save-PrivateParameters $appParameters @{
        appName = $AppName; location = $Location; registryName = $outputs.registryName.value
        environmentName = $outputs.environmentName.value; identityName = $outputs.identityName.value
        keyVaultName = $outputs.keyVaultName.value; imageTag = $imageTag
    }
    $appDeployment = $null
    for ($attempt = 1; $attempt -le 3; $attempt++) {
        try {
            $appDeployment = (Invoke-Azure @(
                'deployment', 'group', 'create', '--name', "$AppName-application",
                '--resource-group', $ResourceGroup, '--template-file', (Join-Path $temp 'app.json'),
                '--parameters', "@$appParameters", '--output', 'json'
            )) | ConvertFrom-Json
            break
        } catch {
            if ($attempt -eq 3) { throw }
            Write-Warning "App deployment failed. Retrying once permissions have had time to propagate ($attempt/3). $($_.Exception.Message)"
            Start-Sleep -Seconds (30 * $attempt)
        }
    }
    $url = $appDeployment.properties.outputs.url.value
    $healthy = $false
    for ($attempt = 1; $attempt -le 30; $attempt++) {
        try {
            $health = Invoke-RestMethod -Uri "$url/health/ready" -TimeoutSec 10
            if ($health.status -eq 'ready') { $healthy = $true; break }
            Write-Warning "Readiness returned an unexpected response ($attempt/30)."
        } catch { Write-Warning "Waiting for HTTPS readiness ($attempt/30): $($_.Exception.Message)" }
        Start-Sleep -Seconds 10
    }
    if (-not $healthy) { throw "Deployment finished but readiness failed. Inspect Container Apps logs for $AppName; deployment is NOT verified." }
    $receiptPath = Join-Path $root 'deployment.json'
    @{
        appName = $AppName; resourceGroup = $ResourceGroup; location = $Location
        subscriptionId = $account.id; url = $url; imageTag = $imageTag
        keyVaultName = $outputs.keyVaultName.value; registryName = $outputs.registryName.value
        databaseServerName = $outputs.databaseServerName.value; deployedAtUtc = [DateTime]::UtcNow.ToString('o')
    } | ConvertTo-Json | Set-Content -LiteralPath $receiptPath -Encoding utf8
    Write-Host "`nRiver Room is ready: $url"
    Write-Host "Deployment details: $receiptPath"
    Write-Host 'Retrieve your private host-creation key when needed; do not share it with players:'
    Write-Host "az keyvault secret show --vault-name $($outputs.keyVaultName.value) --name host-key --query value --output tsv"
    Write-Host 'Existing active games pause during server restarts; their hosts should resume them after the update.'
} finally {
    Remove-Variable databasePassword, hostKey -ErrorAction SilentlyContinue
    if (Test-Path -LiteralPath $temp) { Remove-Item -LiteralPath $temp -Recurse -Force -WhatIf:$false -Confirm:$false }
    [Environment]::SetEnvironmentVariable('PYTHONUTF8', $oldPythonUtf8, 'Process')
    [Environment]::SetEnvironmentVariable('PYTHONIOENCODING', $oldPythonEncoding, 'Process')
}
