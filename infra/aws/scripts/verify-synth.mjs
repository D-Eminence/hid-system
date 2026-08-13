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
  economy: { api: 'api.staging', secret: 'StagingCloudflareOriginSecret', nat: 1, endpoints: 4, multiAz: false },
  fidelity: { api: 'api.staging', secret: 'StagingCloudflareOriginSecret', nat: 2, endpoints: 8, multiAz: true },
  production: { api: 'api', secret: 'ProductionCloudflareOriginSecret', nat: 2, endpoints: 8, multiAz: true },
}
const contract = contracts[profile]
assert.ok(contract, `unknown deployment profile ${profile}`)
const names = (await readdir(output)).filter(name => name.endsWith('.template.json'))
assert.equal(names.length, 1, 'default synth must produce exactly one regional stack')
const regional = JSON.parse(await readFile(resolve(output, names[0]), 'utf8'))
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
assert.equal(resources('AWS::EC2::NatGateway').length, contract.nat)
assert.equal(resources('AWS::EC2::VPCEndpoint')
  .filter(resource => resource.Properties.VpcEndpointType === 'Interface').length, contract.endpoints)

const asleep = profile === 'sleep'
assert.equal(resources('AWS::ElasticLoadBalancingV2::LoadBalancer').length, asleep ? 0 : 2)
assert.equal(resources('AWS::WAFv2::WebACL').length, asleep ? 0 : 1)
assert.equal(resources('AWS::WAFv2::WebACLAssociation').length, asleep ? 0 : 1)
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
assert.equal(resources('AWS::Lambda::Function').length, 0)
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
