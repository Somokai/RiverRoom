targetScope = 'resourceGroup'

param appName string
param location string = resourceGroup().location
param registryName string
param environmentName string
param identityName string
param keyVaultName string
param imageTag string

resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' existing = { name: registryName }
resource environment 'Microsoft.App/managedEnvironments@2024-03-01' existing = { name: environmentName }
resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = { name: identityName }
resource vault 'Microsoft.KeyVault/vaults@2023-07-01' existing = { name: keyVaultName }

resource app 'Microsoft.App/containerApps@2024-03-01' = {
  name: appName
  location: location
  tags: { application: 'River Room', riverRoomApp: appName }
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: { '${identity.id}': {} }
  }
  properties: {
    environmentId: environment.id
    workloadProfileName: 'Consumption'
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        external: true
        targetPort: 8080
        transport: 'auto'
        allowInsecure: false
        stickySessions: { affinity: 'sticky' }
      }
      registries: [{ server: registry.properties.loginServer, identity: identity.id }]
      secrets: [
        {
          name: 'database-url'
          keyVaultUrl: '${vault.properties.vaultUri}secrets/database-url'
          identity: identity.id
        }
        {
          name: 'host-key'
          keyVaultUrl: '${vault.properties.vaultUri}secrets/host-key'
          identity: identity.id
        }
      ]
    }
    template: {
      revisionSuffix: imageTag
      containers: [
        {
          name: 'river-room'
          image: '${registry.properties.loginServer}/river-room:${imageTag}'
          resources: { cpu: json('0.5'), memory: '1Gi' }
          env: [
            { name: 'NODE_ENV', value: 'production' }
            { name: 'HOST', value: '0.0.0.0' }
            { name: 'PORT', value: '8080' }
            { name: 'TRUST_PROXY', value: '1' }
            { name: 'APP_ORIGIN', value: 'https://${appName}.${environment.properties.defaultDomain}' }
            { name: 'DATABASE_SSL', value: 'true' }
            { name: 'DATABASE_URL', secretRef: 'database-url' }
            { name: 'HOST_KEY', secretRef: 'host-key' }
          ]
          probes: [
            {
              type: 'Startup'
              httpGet: { path: '/health/ready', port: 8080, scheme: 'HTTP' }
              initialDelaySeconds: 5
              periodSeconds: 5
              timeoutSeconds: 3
              failureThreshold: 30
            }
            {
              type: 'Readiness'
              httpGet: { path: '/health/ready', port: 8080, scheme: 'HTTP' }
              periodSeconds: 10
              timeoutSeconds: 3
              failureThreshold: 3
            }
            {
              type: 'Liveness'
              httpGet: { path: '/health/live', port: 8080, scheme: 'HTTP' }
              periodSeconds: 20
              timeoutSeconds: 3
              failureThreshold: 3
            }
          ]
        }
      ]
      scale: { minReplicas: 1, maxReplicas: 1 }
    }
  }
}
output url string = 'https://${app.properties.configuration.ingress.fqdn}'
output appName string = app.name
