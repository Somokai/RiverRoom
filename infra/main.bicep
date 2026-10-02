targetScope = 'resourceGroup'

@minLength(3)
@maxLength(24)
param appName string = 'river-room'
param location string = resourceGroup().location
param deployerObjectId string
@allowed(['User', 'ServicePrincipal', 'Group'])
param deployerPrincipalType string = 'User'
@secure()
@minLength(24)
param databasePassword string
@secure()
@minLength(24)
param hostKey string
@allowed(['Standard_B1ms', 'Standard_B2s'])
param databaseSku string = 'Standard_B1ms'

var suffix = uniqueString(resourceGroup().id, appName)
var tags = {
  application: 'River Room'
  riverRoomApp: appName
}
var databaseName = 'riverroom'
var adminLogin = 'riveradmin'
var secretsUserRole = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '4633458b-17de-408a-b874-0445c86b69e6')
var secretsOfficerRole = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'b86a8fe4-44ce-4948-aee5-eccb2c155cd7')

resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${appName}-identity'
  location: location
  tags: tags
}
resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' = {
  name: 'rr${suffix}'
  location: location
  tags: tags
  sku: { name: 'Basic' }
  properties: {
    adminUserEnabled: false
    publicNetworkAccess: 'Enabled'
    policies: {
      azureADAuthenticationAsArmPolicy: { status: 'enabled' }
    }
  }
}
resource imagePull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(registry.id, identity.id, 'AcrPull')
  scope: registry
  properties: {
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '7f951dda-4ed3-4680-a7ca-43fe172d538d')
  }
}
resource vault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: 'rr-${suffix}-kv'
  location: location
  tags: tags
  properties: {
    tenantId: subscription().tenantId
    sku: { family: 'A', name: 'standard' }
    enableRbacAuthorization: true
    enableSoftDelete: true
    enablePurgeProtection: true
    softDeleteRetentionInDays: 90
    publicNetworkAccess: 'Enabled'
  }
}
resource vaultOperator 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(vault.id, deployerObjectId, 'SecretsOfficer')
  scope: vault
  properties: {
    principalId: deployerObjectId
    principalType: deployerPrincipalType
    roleDefinitionId: secretsOfficerRole
  }
}
resource hostSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: vault
  name: 'host-key'
  properties: { value: hostKey }
}
resource passwordSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: vault
  name: 'database-admin-password'
  properties: { value: databasePassword }
}
resource vnet 'Microsoft.Network/virtualNetworks@2024-05-01' = {
  name: '${appName}-vnet'
  location: location
  tags: tags
  properties: {
    addressSpace: { addressPrefixes: ['10.86.0.0/16'] }
  }
}
resource appsSubnet 'Microsoft.Network/virtualNetworks/subnets@2024-05-01' = {
  parent: vnet
  name: 'container-apps'
  properties: {
    addressPrefix: '10.86.0.0/23'
    delegations: [
      { name: 'container-apps', properties: { serviceName: 'Microsoft.App/environments' } }
    ]
  }
}
resource databaseSubnet 'Microsoft.Network/virtualNetworks/subnets@2024-05-01' = {
  parent: vnet
  name: 'postgres'
  properties: {
    addressPrefix: '10.86.2.0/27'
    delegations: [
      { name: 'postgres', properties: { serviceName: 'Microsoft.DBforPostgreSQL/flexibleServers' } }
    ]
    serviceEndpoints: [{ service: 'Microsoft.Storage' }]
  }
  dependsOn: [appsSubnet]
}
resource dns 'Microsoft.Network/privateDnsZones@2020-06-01' = {
  name: 'private.${suffix}.postgres.database.azure.com'
  location: 'global'
  tags: tags
}
resource dnsLink 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2020-06-01' = {
  parent: dns
  name: 'river-room-vnet'
  location: 'global'
  properties: {
    registrationEnabled: false
    virtualNetwork: { id: vnet.id }
  }
}
resource postgres 'Microsoft.DBforPostgreSQL/flexibleServers@2024-08-01' = {
  name: 'rr-${suffix}-pg'
  location: location
  tags: tags
  sku: { name: databaseSku, tier: 'Burstable' }
  properties: {
    version: '16'
    administratorLogin: adminLogin
    administratorLoginPassword: databasePassword
    storage: { storageSizeGB: 32, autoGrow: 'Enabled' }
    backup: { backupRetentionDays: 7, geoRedundantBackup: 'Disabled' }
    highAvailability: { mode: 'Disabled' }
    network: {
      delegatedSubnetResourceId: databaseSubnet.id
      privateDnsZoneArmResourceId: dns.id
      publicNetworkAccess: 'Disabled'
    }
    authConfig: { activeDirectoryAuth: 'Disabled', passwordAuth: 'Enabled' }
  }
  dependsOn: [dnsLink, environment]
}
resource database 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2024-08-01' = {
  parent: postgres
  name: databaseName
  properties: { charset: 'UTF8', collation: 'en_US.utf8' }
}
resource tls 'Microsoft.DBforPostgreSQL/flexibleServers/configurations@2024-08-01' = {
  parent: postgres
  name: 'require_secure_transport'
  properties: { value: 'ON', source: 'user-override' }
}
resource databaseSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: vault
  name: 'database-url'
  properties: {
    value: 'postgresql://${adminLogin}:${uriComponent(databasePassword)}@${postgres.properties.fullyQualifiedDomainName}:5432/${databaseName}'
  }
  dependsOn: [database, tls]
}
resource databaseSecretReader 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(databaseSecret.id, identity.id, 'SecretsUser')
  scope: databaseSecret
  properties: {
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: secretsUserRole
  }
}
resource hostSecretReader 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(hostSecret.id, identity.id, 'SecretsUser')
  scope: hostSecret
  properties: {
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: secretsUserRole
  }
}
resource logs 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: '${appName}-logs'
  location: location
  tags: tags
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: 30
    workspaceCapping: { dailyQuotaGb: 1 }
    features: { enableLogAccessUsingOnlyResourcePermissions: true }
  }
}
resource environment 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: '${appName}-environment'
  location: location
  tags: tags
  properties: {
    vnetConfiguration: { infrastructureSubnetId: appsSubnet.id, internal: false }
    workloadProfiles: [{ name: 'Consumption', workloadProfileType: 'Consumption' }]
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logs.properties.customerId
        sharedKey: logs.listKeys().primarySharedKey
      }
    }
  }
}

output registryName string = registry.name
output registryServer string = registry.properties.loginServer
output environmentName string = environment.name
output identityName string = identity.name
output keyVaultName string = vault.name
output databaseServerName string = postgres.name
output databaseName string = databaseName
