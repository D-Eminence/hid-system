#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const output = resolve(root, 'cdk.out')
const names = (await readdir(output)).filter(name => name.endsWith('.template.json'))
assert.equal(names.length, 1, 'synth must produce exactly one regional template; Cloudflare owns the frontend edge')

const regional = JSON.parse(await readFile(resolve(output, names[0]), 'utf8'))
assert.ok(names[0].includes('Regional'), 'regional template is missing')

const resources = (template, type) => Object.values(template.Resources ?? {}).filter(resource => resource.Type === type)
const database = resources(regional, 'AWS::RDS::DBInstance')[0]
assert.ok(database)
assert.equal(database.Properties.PubliclyAccessible, false)
assert.equal(database.Properties.StorageEncrypted, true)
assert.equal(database.Properties.EngineVersion, '16')

const databaseIngress = resources(regional, 'AWS::EC2::SecurityGroupIngress')
  .filter(resource => resource.Properties.FromPort === 5432 || resource.Properties.ToPort === 5432)
assert.equal(databaseIngress.length, 10)
for (const ingress of databaseIngress) {
  assert.ok(ingress.Properties.SourceSecurityGroupId, 'database ingress must use a source security group')
  assert.equal(ingress.Properties.CidrIp, undefined, 'database ingress must not use an IPv4 CIDR')
  assert.equal(ingress.Properties.CidrIpv6, undefined, 'database ingress must not use an IPv6 CIDR')
}

const services = resources(regional, 'AWS::ECS::Service')
assert.equal(services.length, 11)
for (const service of services) {
  assert.equal(service.Properties.NetworkConfiguration.AwsvpcConfiguration.AssignPublicIp, 'DISABLED')
}
assert.equal(resources(regional, 'AWS::ECS::TaskDefinition').length, 12)

const bucket = resources(regional, 'AWS::S3::Bucket')[0]
assert.ok(bucket)
assert.equal(bucket.Properties.VersioningConfiguration.Status, 'Enabled')
assert.equal(bucket.Properties.PublicAccessBlockConfiguration.BlockPublicAcls, true)
assert.equal(bucket.Properties.PublicAccessBlockConfiguration.BlockPublicPolicy, true)
assert.match(JSON.stringify(bucket.Properties.BucketEncryption), /aws:kms/)

const ecrRepositories = resources(regional, 'AWS::ECR::Repository')
assert.equal(ecrRepositories.length, 11)
for (const repository of ecrRepositories) {
  assert.equal(repository.Properties.ImageTagMutability, 'IMMUTABLE')
  assert.equal(repository.Properties.ImageScanningConfiguration.ScanOnPush, true)
  assert.ok(repository.Properties.LifecyclePolicy)
}

const imageParameters = Object.entries(regional.Parameters)
  .filter(([name]) => name.endsWith('ImageUri'))
assert.equal(imageParameters.length, 12)
for (const [, parameter] of imageParameters) {
  assert.equal(parameter.Default, undefined)
  assert.match(parameter.AllowedPattern, /sha256/)
}

const regionalText = JSON.stringify(regional)
assert.doesNotMatch(regionalText, /postgresql:\/\//)
assert.doesNotMatch(regionalText, /:latest/)
assert.doesNotMatch(regionalText, /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/)
assert.doesNotMatch(regionalText, /(?:AKIA|ASIA)[0-9A-Z]{16}/)
assert.equal(resources(regional, 'AWS::CloudFront::Distribution').length, 0)
assert.equal(resources(regional, 'AWS::SQS::Queue').length, 2)
assert.equal(resources(regional, 'AWS::Events::Rule').length, 1)
assert.equal(resources(regional, 'AWS::Lambda::Function').length, 0)

const notificationRule = resources(regional, 'AWS::Events::Rule')[0]
const notificationTypes = notificationRule.Properties.EventPattern['detail-type']
assert.deepEqual(notificationTypes, [
  'PatientRegistered.v1',
  'PatientIdentityResolved.v1',
  'OcrPublicationSucceeded.v1',
  'LabResultReleased.v1',
  'MedicationDispensed.v1',
  'OutreachPatientResolved.v1',
])
assert.equal(notificationTypes.some(eventType => /otp|passwordreset/i.test(eventType)), false)

for (const policy of resources(regional, 'AWS::IAM::Policy')) {
  const statements = policy.Properties.PolicyDocument.Statement ?? []
  for (const statement of statements) {
    const actions = Array.isArray(statement.Action) ? statement.Action : [statement.Action]
    assert.ok(!actions.includes('*'), 'inline IAM must never grant Action "*"')
    assert.ok(!actions.some(action => typeof action === 'string' && action.endsWith(':*')), 'inline IAM must not grant service wildcards')
    if (statement.Resource === '*') {
      assert.ok(['UseTextractDocumentOperations', 'SendOtpEmailWithSesV2'].includes(statement.Sid),
        'only provider APIs without a fixed resource may use Resource "*"')
      assert.ok(statement.Condition, 'a permitted provider wildcard must be condition-bounded')
    }
  }
}

const webAcl = resources(regional, 'AWS::WAFv2::WebACL')[0]
assert.ok(webAcl)
const webAclText = JSON.stringify(webAcl)
assert.match(webAclText, /x-hid-origin-authorization/)
assert.match(webAclText, /CloudflareOriginSecret/)
assert.match(webAclText, /AWSManagedRulesCommonRuleSet/)
assert.match(webAclText, /AWSManagedRulesKnownBadInputsRuleSet/)
assert.match(webAclText, /RateBasedStatement/)
assert.doesNotMatch(webAclText, /"SingleHeader":\{"name"/)

const schema = JSON.parse(await readFile(resolve(root, 'release-manifest.schema.json'), 'utf8'))
const manifestTemplate = JSON.parse(await readFile(resolve(root, 'release-manifest.template.json'), 'utf8'))
assert.equal(schema.properties.schema_version.const, '1.0')
assert.ok(schema.$defs.component.required.includes('image_digest'))
assert.ok(schema.$defs.component.required.includes('sbom'))
assert.ok(schema.$defs.component.required.includes('scan'))
assert.equal(schema.properties.components.minItems, 12)
assert.equal(schema.properties.components.maxItems, 12)
assert.equal(schema.$defs.component.properties.component.enum.length, 12)
assert.match(manifestTemplate.components[0].image_digest, /\$\{IMAGE_DIGEST_64_HEX\}/)

process.stdout.write(`IaC synth verification passed: ${services.length} services, ${ecrRepositories.length} repositories, ${imageParameters.length} digest inputs\n`)
