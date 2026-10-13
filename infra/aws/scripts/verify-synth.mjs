#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const output = resolve(root, 'cdk.out')
const environment = process.env.HID_INFRA_ENV ?? 'development'
const stagingMode = process.env.HID_STAGING_MODE
if (environment === 'staging') assert.ok(['sleep', 'economy', 'fidelity'].includes(stagingMode),
  'staging synth verification requires HID_STAGING_MODE=sleep|economy|fidelity')
else assert.equal(stagingMode, undefined, 'HID_STAGING_MODE is staging-only')
const profile = environment === 'staging' ? stagingMode : environment
const contracts = {
  development: { api: 'api.development', secret: 'DevelopmentCloudflareOriginSecret', nat: 1, endpoints: 8, multiAz: false },
  sleep: { api: 'api.staging', secret: 'StagingCloudflareOriginSecret', nat: 0, endpoints: 0, multiAz: false },
  economy: { api: 'api.staging', secret: 'StagingCloudflareOriginSecret', nat: 1, endpoints: 7, multiAz: false },
  fidelity: { api: 'api.staging', secret: 'StagingCloudflareOriginSecret', nat: 2, endpoints: 8, multiAz: true },
  production: { api: 'api', secret: 'ProductionCloudflareOriginSecret', nat: 2, endpoints: 8, multiAz: true },
}
const contract = contracts[profile]
assert.ok(contract, `unknown deployment profile ${profile}`)
const names = (await readdir(output)).filter(name => name.endsWith('.template.json'))
assert.equal(names.length, 1, 'default synth must produce exactly one regional stack')
const regional = JSON.parse(await readFile(resolve(output, names[0]), 'utf8'))
if (environment === 'staging') {
  const templateBytes = (await readFile(resolve(output, names[0]))).byteLength
  assert.ok(templateBytes <= 1024 * 1024, 'staging template exceeds the CloudFormation S3 object quota')
  assert.ok(Object.keys(regional.Parameters ?? {}).length <= 200, 'staging template exceeds the parameter quota')
  assert.ok(Object.keys(regional.Resources ?? {}).length <= 500, 'staging template exceeds the resource quota')
  assert.ok(Object.keys(regional.Outputs ?? {}).length <= 200, 'staging template exceeds the output quota')
  assert.equal(regional.Parameters.RdsCaBundleBase64.MaxLength, 4096,
    'staging public CA parameter must enforce the CloudFormation value limit')
}
const templateBytes = (await readFile(resolve(output, names[0]))).byteLength
assert.ok(templateBytes <= 1024 * 1024, `${profile} template exceeds the CloudFormation S3 object quota`)
assert.ok(Object.keys(regional.Parameters ?? {}).length <= 200, `${profile} template exceeds the parameter quota`)
assert.ok(Object.keys(regional.Resources ?? {}).length <= 500, `${profile} template exceeds the resource quota`)
assert.ok(Object.keys(regional.Outputs ?? {}).length <= 200, `${profile} template exceeds the output quota`)
assert.ok(names[0].includes('Regional'), 'regional template is missing')
const resources = (type) => Object.values(regional.Resources ?? {}).filter(resource => resource.Type === type)
const text = JSON.stringify(regional)

const database = resources('AWS::RDS::DBInstance')[0]
assert.ok(database)
assert.equal(database.Properties.PubliclyAccessible, false)
assert.equal(database.Properties.StorageEncrypted, true)
assert.equal(database.Properties.EngineVersion, '16')
assert.equal(database.Properties.MultiAZ, contract.multiAz)
assert.equal(database.Properties.DeletionProtection, environment !== 'development')
assert.equal(database.Properties.DatabaseInsightsMode, 'standard')

const databaseIngress = resources('AWS::EC2::SecurityGroupIngress')
  .filter(resource => resource.Properties.FromPort === 5432 || resource.Properties.ToPort === 5432)
assert.equal(databaseIngress.length, 10)
for (const ingress of databaseIngress) {
  assert.ok(ingress.Properties.SourceSecurityGroupId)
  assert.equal(ingress.Properties.CidrIp, undefined)
  assert.equal(ingress.Properties.CidrIpv6, undefined)
}

const services = resources('AWS::ECS::Service')
assert.equal(services.length, 11)
for (const service of services) {
  assert.equal(service.Properties.NetworkConfiguration.AwsvpcConfiguration.AssignPublicIp, 'DISABLED')
  if (profile === 'sleep') assert.equal(service.Properties.DesiredCount, 0)
}
assert.equal(resources('AWS::ECS::TaskDefinition').length, 12)
const identityApis = resources('AWS::ECS::TaskDefinition')
  .filter(task => String(task.Properties.Family).endsWith('-identity-api'))
  .flatMap(task => task.Properties.ContainerDefinitions).filter(container => container.Name === 'identity-api')
assert.equal(identityApis.length, 1)
assert.deepEqual(identityApis[0].Secrets.filter(secret => secret.Name === 'MFA_SECRET_KEY_B64').map(secret => secret.ValueFrom),
  [{ 'Fn::Join': ['', [{ Ref: 'IdentitySensitiveSecretArn' }, ':mfaSecretKeyB64::']] }],
  'Identity must read MFA_SECRET_KEY_B64 from the mfaSecretKeyB64 field of its sensitive secret')
assert.deepEqual(identityApis[0].Environment.filter(entry => entry.Name === 'MFA_KEY_VERSION').map(entry => entry.Value),
  ['aws-v1'], 'Identity must run with MFA_KEY_VERSION aws-v1')
assert.equal(text.split('mfaSecretKeyB64::').length, 2, 'only Identity may reference the MFA key')
// ECS stops every Identity task while a referenced field is missing, so the
// parameter description operators follow must name each field the task reads.
const sensitiveFields = resources('AWS::ECS::TaskDefinition').flatMap(task => task.Properties.ContainerDefinitions)
  .flatMap(container => container.Secrets ?? []).map(secret => secret.ValueFrom?.['Fn::Join']?.[1])
  .filter(parts => Array.isArray(parts) && parts[0]?.Ref === 'IdentitySensitiveSecretArn')
  .map(parts => /^:([A-Za-z0-9]+)::$/.exec(String(parts[1]))?.[1])
assert.ok(sensitiveFields.length > 0 && sensitiveFields.every(Boolean), 'every Identity sensitive secret reference must name one JSON field')
for (const field of sensitiveFields) {
  assert.match(regional.Parameters.IdentitySensitiveSecretArn.Description, new RegExp(`\\b${field}\\b`),
    `the IdentitySensitiveSecretArn description must name ${field}, which the Identity task reads`)
}
assert.equal(resources('AWS::EC2::NatGateway').length, contract.nat)
assert.equal(resources('AWS::EC2::VPCEndpoint')
  .filter(resource => resource.Properties.VpcEndpointType === 'Interface').length, contract.endpoints)

const asleep = profile === 'sleep'
assert.equal(resources('AWS::ElasticLoadBalancingV2::LoadBalancer').length, asleep ? 0 : 2)
// The public API web ACL, and the workload issuer's NAT allowlist web ACL
// wherever an in-stack issuer runs behind NAT gateways (staging live modes and
// production; D3 in ADR-047).
const issuerWebAcl = ['economy', 'fidelity', 'production'].includes(profile) ? 1 : 0
assert.equal(resources('AWS::WAFv2::WebACL').length, asleep ? 0 : 1 + issuerWebAcl)
assert.equal(resources('AWS::WAFv2::WebACLAssociation').length, asleep ? 0 : 1 + issuerWebAcl)
assert.equal(resources('AWS::ApplicationAutoScaling::ScalableTarget').length, asleep ? 0 : 11)
assert.equal(resources('AWS::Scheduler::Schedule').length, asleep ? 1 : 0)

const bucket = resources('AWS::S3::Bucket')[0]
assert.ok(bucket)
assert.equal(bucket.Properties.VersioningConfiguration.Status, 'Enabled')
assert.equal(bucket.Properties.PublicAccessBlockConfiguration.BlockPublicAcls, true)
assert.equal(bucket.Properties.PublicAccessBlockConfiguration.BlockPublicPolicy, true)
assert.match(JSON.stringify(bucket.Properties.BucketEncryption), /aws:kms/)
for (const prefix of ['clinical/', 'objects/']) {
  const rule = bucket.Properties.LifecycleConfiguration.Rules
    .find(candidate => JSON.stringify(candidate).includes(prefix))
  assert.ok(rule)
  assert.equal(rule.ExpirationInDays, undefined)
  assert.equal(rule.NoncurrentVersionExpiration, undefined)
}

const repositories = resources('AWS::ECR::Repository')
assert.equal(repositories.length, 11)
for (const repository of repositories) {
  assert.equal(repository.Properties.ImageTagMutability, 'IMMUTABLE')
  assert.equal(repository.Properties.ImageScanningConfiguration.ScanOnPush, true)
  assert.ok(repository.Properties.LifecyclePolicy)
}
const imageParameters = Object.entries(regional.Parameters).filter(([name]) => name.endsWith('ImageUri'))
assert.equal(imageParameters.length, 12)
for (const [, parameter] of imageParameters) {
  assert.equal(parameter.Default, undefined)
  assert.match(parameter.AllowedPattern, /sha256/)
}

assert.doesNotMatch(text, /postgresql:\/\//)
assert.doesNotMatch(text, /:latest/)
assert.doesNotMatch(text, /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/)
assert.doesNotMatch(text, /(?:AKIA|ASIA)[0-9A-Z]{16}/)
assert.doesNotMatch(text, /CloudFront/i)
assert.equal(resources('AWS::SQS::Queue').length, 2)
assert.equal(resources('AWS::Events::Rule').length, 1)

// Staging and production carry their own in-stack workload issuer; development
// deliberately keeps the external issuer, JWKS and subject inputs.
const issuerEnvironment = ['staging', 'production'].includes(environment) ? environment : undefined
const workloadParameters = ['WorkloadIssuerUrl', 'WorkloadJwksUrl', 'EhrWorkloadSubject', 'LabWorkloadSubject',
  'PharmacyWorkloadSubject', 'OcrWorkloadSubject', 'OutreachWorkloadSubject', 'IdentityWorkloadSubject']
const tokenMounts = container => (container.MountPoints ?? []).filter(mount => mount.SourceVolume === 'workload-tokens')
const tokenTasks = resources('AWS::ECS::TaskDefinition')
  .filter(task => (task.Properties.Volumes ?? []).some(volume => volume.Name === 'workload-tokens'))
assert.equal(tokenTasks.length, 6, 'six token-bearing tasks must have a workload token volume')
for (const task of tokenTasks) {
  const containers = task.Properties.ContainerDefinitions
  const app = containers.find(container => container.Name !== 'workload-token-agent')
  const writers = containers.filter(container => tokenMounts(container).some(mount => mount.ReadOnly === false))
  assert.deepEqual(tokenMounts(app).map(mount => mount.ReadOnly), [true], `${app.Name} must mount its token volume read-only`)
  if (issuerEnvironment) {
    assert.deepEqual(writers.map(container => container.Name), ['workload-token-agent'],
      `${app.Name} token volume must have exactly one workload-token-agent writer`)
    assert.deepEqual(tokenMounts(writers[0]).map(mount => mount.ReadOnly), [false])
    assert.deepEqual(app.DependsOn, [{ ContainerName: 'workload-token-agent', Condition: 'HEALTHY' }],
      `${app.Name} must wait for its token agent to be healthy`)
    const agentEnvironment = Object.fromEntries(writers[0].Environment.map(item => [item.Name, item.Value]))
    assert.equal(agentEnvironment.HID_DEPLOYMENT_ENV, issuerEnvironment)
    assert.equal(agentEnvironment.WORKLOAD_SUBJECT, `hid:${issuerEnvironment}:${app.Name}`)
  } else {
    assert.equal(writers.length, 0, 'development token delivery remains an external prerequisite')
  }
}
assert.equal(resources('AWS::Lambda::Function').length, issuerEnvironment ? 1 : 0)
if (issuerEnvironment) {
  const methods = resources('AWS::ApiGateway::Method')
  assert.equal(methods.length, 2)
  assert.equal(methods.find(method => method.Properties.HttpMethod === 'POST').Properties.AuthorizationType, 'AWS_IAM')
  assert.equal(methods.find(method => method.Properties.HttpMethod === 'GET').Properties.AuthorizationType, 'NONE')
  assert.deepEqual(resources('AWS::ApiGateway::Stage').map(stage => stage.Properties.StageName), [issuerEnvironment])
  assert.equal(resources('AWS::Lambda::Function')[0].Properties.FunctionName, `hid-${issuerEnvironment}-workload-issuer`)
  assert.equal(resources('AWS::KMS::Key').filter(key => key.Properties.KeyUsage === 'SIGN_VERIFY').length, 1)
  for (const name of workloadParameters) assert.equal(regional.Parameters[name], undefined, `${name} must not be an input`)
  assert.doesNotMatch(text, issuerEnvironment === 'production' ? /hid:staging:|hid-staging-workload/ : /hid:production:|hid-production-workload/)
  const tokenAgents = resources('AWS::ECS::TaskDefinition').flatMap(task => task.Properties.ContainerDefinitions)
    .filter(container => container.Name === 'workload-token-agent')
  assert.equal(tokenAgents.length, 6)
  for (const agent of tokenAgents) {
    assert.deepEqual(agent.Image, { Ref: 'IdentityApiImageUri' })
    assert.equal(agent.User, '65532:65532')
    assert.equal(agent.ReadonlyRootFilesystem, true)
    // D2: an issuer outage stops service-to-service calls, not the task.
    assert.equal(agent.Essential, false, 'the token agent must not be essential')
    assert.deepEqual(agent.RestartPolicy, { Enabled: true, RestartAttemptPeriod: 60 },
      'ECS must restart an exited token agent')
  }
  // DEP-4-KEY: only the issuer role may sign, and only ES256 over RAW messages.
  const [signingKey] = resources('AWS::KMS::Key').filter(key => key.Properties.KeyUsage === 'SIGN_VERIFY')
  const keyStatements = signingKey.Properties.KeyPolicy.Statement
  assert.equal(keyStatements.filter(statement => statement.Effect === 'Allow' && statement.Action === 'kms:*').length, 1,
    'the signing key keeps its account root statement')
  const issuerRole = resources('AWS::Lambda::Function')[0].Properties.Role['Fn::GetAtt'][0]
  const denied = Object.fromEntries(keyStatements.filter(statement => statement.Effect === 'Deny')
    .map(statement => [statement.Sid, statement]))
  assert.deepEqual(Object.keys(denied).sort(),
    ['DenyEveryOtherMessageType', 'DenyEveryOtherSigningAlgorithm', 'DenySigningFromEveryOtherPrincipal'])
  for (const statement of Object.values(denied)) {
    assert.deepEqual([statement.Principal, statement.Action, statement.Resource], [{ AWS: '*' }, 'kms:Sign', '*'])
  }
  assert.deepEqual(denied.DenySigningFromEveryOtherPrincipal.Condition,
    { ArnNotEquals: { 'aws:PrincipalArn': { 'Fn::GetAtt': [issuerRole, 'Arn'] } } })
  assert.deepEqual(denied.DenyEveryOtherSigningAlgorithm.Condition, { StringNotEquals: { 'kms:SigningAlgorithm': 'ECDSA_SHA_256' } })
  assert.deepEqual(denied.DenyEveryOtherMessageType.Condition, { StringNotEquals: { 'kms:MessageType': 'RAW' } })
  // DEP-4-DOS: separate method throttles; no stage-wide setting shared by both methods.
  const [issuerStage] = resources('AWS::ApiGateway::Stage')
  assert.deepEqual(issuerStage.Properties.MethodSettings.map(setting => `${setting.HttpMethod} ${setting.ResourcePath}`).sort(),
    ['GET /~1.well-known~1jwks.json', 'POST /~1token'])
  for (const setting of issuerStage.Properties.MethodSettings) {
    assert.ok(setting.ThrottlingRateLimit >= 30 && setting.ThrottlingBurstLimit >= 60)
    assert.equal(setting.DataTraceEnabled, false)
    assert.equal(setting.LoggingLevel, 'OFF')
  }
  // D3: a REGIONAL web ACL on the issuer stage blocks every source except this VPC's NAT gateway addresses.
  const issuerAssociations = resources('AWS::WAFv2::WebACLAssociation')
    .filter(association => JSON.stringify(association.Properties.ResourceArn).includes('/restapis/'))
  assert.equal(issuerAssociations.length, issuerWebAcl)
  if (issuerWebAcl) {
    const acl = regional.Resources[issuerAssociations[0].Properties.WebACLArn['Fn::GetAtt'][0]].Properties
    assert.equal(acl.Scope, 'REGIONAL')
    assert.deepEqual(acl.DefaultAction, { Block: {} })
    assert.deepEqual(acl.Rules.map(rule => rule.Action), [{ Allow: {} }])
    const ipSet = regional.Resources[acl.Rules[0].Statement.IPSetReferenceStatement.Arn['Fn::GetAtt'][0]].Properties
    const natEips = resources('AWS::EC2::NatGateway').map(nat => nat.Properties.AllocationId['Fn::GetAtt'][0]).sort()
    assert.equal(natEips.length, contract.nat)
    assert.deepEqual(ipSet.Addresses.map(address => address['Fn::Join'][1][0]['Fn::GetAtt'][0]).sort(), natEips,
      'the issuer allowlist must be exactly the NAT gateway Elastic IPs')
    assert.ok(ipSet.Addresses.every(address => address['Fn::Join'][1][0]['Fn::GetAtt'][1] === 'PublicIp'
      && address['Fn::Join'][1][1] === '/32'))
  }
} else {
  for (const name of workloadParameters) {
    assert.ok(regional.Parameters[name], `development must still require ${name}`)
    assert.equal(regional.Parameters[name].Default, undefined)
  }
  assert.equal(resources('AWS::ApiGateway::RestApi').length, 0)
  assert.doesNotMatch(text, /workload-token-agent/)
}
assert.equal(regional.Parameters.OriginDomainName, undefined)
if (asleep) {
  assert.equal(regional.Parameters[contract.secret], undefined)
} else {
  assert.ok(regional.Parameters[contract.secret])
  assert.equal(regional.Parameters[contract.secret].Default, undefined)
  assert.equal(regional.Parameters[contract.secret].NoEcho, true)
  assert.match(text, new RegExp(`${contract.api.replace('.', '\\.') }\\.`))
}
for (const parameter of Object.keys(regional.Parameters)) {
  if (parameter.endsWith('CloudflareOriginSecret') && parameter !== contract.secret) {
    assert.fail(`${environment} must not synthesize another environment's origin secret`)
  }
}

for (const policy of resources('AWS::IAM::Policy')) {
  for (const statement of policy.Properties.PolicyDocument.Statement ?? []) {
    const actions = Array.isArray(statement.Action) ? statement.Action : [statement.Action]
    assert.ok(!actions.includes('*'))
    assert.ok(!actions.some(action => typeof action === 'string' && action.endsWith(':*')))
    if (statement.Resource === '*') {
      assert.ok(['UseTextractDocumentOperations', 'SendOtpEmailWithSesV2'].includes(statement.Sid))
      assert.ok(statement.Condition)
    }
  }
}

const schema = JSON.parse(await readFile(resolve(root, 'release-manifest.schema.json'), 'utf8'))
const manifest = JSON.parse(await readFile(resolve(root, 'release-manifest.template.json'), 'utf8'))
assert.equal(schema.properties.schema_version.const, '1.0')
assert.ok(schema.$defs.component.required.includes('image_digest'))
assert.ok(schema.$defs.component.required.includes('sbom'))
assert.ok(schema.$defs.component.required.includes('scan'))
assert.equal(schema.properties.components.minItems, 12)
assert.equal(schema.properties.components.maxItems, 12)
assert.match(manifest.components[0].image_digest, /\$\{IMAGE_DIGEST_64_HEX\}/)

process.stdout.write(`IaC ${profile} synth verification passed: ${services.length} services, ${repositories.length} repositories, ${imageParameters.length} digest inputs\n`)
