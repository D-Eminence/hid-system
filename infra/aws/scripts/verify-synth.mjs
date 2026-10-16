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
// The gateway trusts X-Real-IP only from the VPC, requires it outside
// development, resolves upstreams through the VPC resolver, and routes the
// launch modules unless the synth input HID_ENABLED_API_ROUTES opts staging in.
const gateways = resources('AWS::ECS::TaskDefinition')
  .filter(task => String(task.Properties.Family).endsWith('-gateway'))
  .flatMap(task => task.Properties.ContainerDefinitions).filter(container => container.Name === 'gateway')
assert.equal(gateways.length, 1)
const gatewayEnvironment = Object.fromEntries(gateways[0].Environment.map(entry => [entry.Name, entry.Value]))
const vpcCidr = { development: '10.20.0.0/16', staging: '10.30.0.0/16', production: '10.40.0.0/16' }[environment]
assert.equal(gatewayEnvironment.VPC_CIDR, vpcCidr, 'the gateway trusts X-Real-IP only from the VPC')
assert.equal(gatewayEnvironment.GATEWAY_DNS_RESOLVER, vpcCidr.replace(/0\/16$/, '2'), 'the gateway resolves through the VPC resolver')
assert.equal(gatewayEnvironment.HID_REQUIRE_CLIENT_IP, environment === 'development' ? 'false' : 'true')
if (environment === 'production' || process.env.HID_ENABLED_API_ROUTES === undefined) {
  assert.equal(gatewayEnvironment.HID_ENABLED_API_ROUTES, 'identity,ehr', 'the gateway routes only the launch modules')
}
assert.equal(identityApis[0].Environment.find(entry => entry.Name === 'TRUST_PROXY_CIDRS')?.Value, vpcCidr)

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
if (!asleep) {
  // The public API web ACL: the origin secret first; the Core Rule Set with
  // only SizeRestrictions_BODY counted, and a rule after it that blocks the
  // oversized bodies it labels outside the encounter-scoped clinical writes
  // (WAF-CRS-BODY); a rate limit per client network (X-HID-Client-Network,
  // the IPv4 address or IPv6 /64 the Worker derives from CF-Connecting-IP) and
  // a high backstop per connecting address (A7).
  const [apiAcl] = resources('AWS::WAFv2::WebACL')
    .filter(resource => resource.Properties.VisibilityConfig?.MetricName === `hid-${environment}-api-origin`)
  assert.ok(apiAcl, 'the public API web ACL is missing')
  const rules = [...apiAcl.Properties.Rules].sort((left, right) => left.Priority - right.Priority)
  assert.deepEqual(rules.map(rule => [rule.Priority, rule.Name]), [
    [0, 'RequireCloudflareOriginSecret'], [10, 'AwsCommonRules'], [11, 'AwsCommonRulesBodySize'],
    [20, 'AwsKnownBadInputs'], [30, 'ApiOriginRateLimit'], [31, 'ApiOriginEdgeRateLimit'],
  ])
  assert.deepEqual(rules[1].Statement.ManagedRuleGroupStatement.RuleActionOverrides,
    [{ Name: 'SizeRestrictions_BODY', ActionToUse: { Count: {} } }])
  assert.deepEqual(rules[2].Action, { Block: {} })
  assert.deepEqual(rules[2].Statement.AndStatement.Statements[0],
    { LabelMatchStatement: { Scope: 'LABEL', Key: 'awswaf:managed:aws:core-rule-set:SizeRestrictions_Body' } })
  assert.match(JSON.stringify(rules[2].Statement.AndStatement.Statements[1].NotStatement), /clinical-notes/)
  assert.deepEqual(rules[4].Statement.RateBasedStatement, { AggregateKeyType: 'FORWARDED_IP', Limit: 2000,
    ForwardedIPConfig: { HeaderName: 'X-HID-Client-Network', FallbackBehavior: 'MATCH' } })
  assert.deepEqual(rules[5].Statement.RateBasedStatement, { AggregateKeyType: 'IP', Limit: 50000 })
}
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
// INFRA-COUNT and D17: every production task count defaults to 0 and is raised
// only through the reviewed parameter file (I6); a module outside the enabled
// set is pinned at 0 tasks, has no scaling policy and raises no alarm.
const taskContainer = name => resources('AWS::ECS::TaskDefinition')
  .filter(task => String(task.Properties.Family).endsWith(`-${name}`))
  .flatMap(task => task.Properties.ContainerDefinitions).find(container => container.Name === name)
const routeModules = { LabApi: 'lab', PharmacyApi: 'pharmacy', OcrApi: 'ocr', OcrWorker: 'ocr', OutreachApi: 'outreach' }
const enabledRoutes = String(gatewayEnvironment.HID_ENABLED_API_ROUTES).split(',')
const notificationWorkerEnabled = environment !== 'production' && process.env.HID_NOTIFICATION_WORKER_ENABLED !== 'false'
const disabledIds = [...Object.entries(routeModules).filter(([, module]) => !enabledRoutes.includes(module)).map(([id]) => id),
  ...(notificationWorkerEnabled ? [] : ['NotificationWorker'])]
const desiredCounts = Object.entries(regional.Parameters).filter(([name]) => name.endsWith('DesiredCount'))
assert.equal(desiredCounts.length, asleep ? 0 : 11)
for (const [name, parameter] of desiredCounts) {
  const id = name.slice(0, -'DesiredCount'.length)
  const ceiling = regional.Parameters[`${id}ScalingCeiling`]
  assert.ok(ceiling, `${id} must have a scaling ceiling`)
  if (environment === 'production') {
    assert.equal(parameter.Default, 0, `production ${name} must default to 0 tasks (ADR-032, I6)`)
    assert.match(parameter.Description, /recommended \d+/, `${name} must keep its recommended count`)
  }
  if (disabledIds.includes(id)) {
    assert.deepEqual([parameter.Default, parameter.MaxValue], [0, 0], `${name} is outside the enabled modules and stays at 0`)
    assert.deepEqual([ceiling.Default, ceiling.MinValue, ceiling.MaxValue], [0, 0, 0], `${id} scaling is pinned at 0`)
  } else {
    assert.ok(parameter.MaxValue > 0, `${name} must be scalable`)
  }
}
const resourceIds = Object.keys(regional.Resources)
const scalingPolicies = resources('AWS::ApplicationAutoScaling::ScalingPolicy')
for (const id of disabledIds) {
  for (const prefix of [`${id}RunningTask`, `${id}LogVolume`, `${id}TargetLatency`, `${id}TargetError`, `${id}TokenRenewal`]) {
    assert.ok(!resourceIds.some(resource => resource.startsWith(prefix)), `${id} is disabled and must have no ${prefix} resource`)
  }
  assert.ok(!scalingPolicies.some(policy => JSON.stringify(policy.Properties.ScalingTargetId).includes(`${id}Service`)),
    `${id} is disabled and must have no scaling policy`)
}
if (disabledIds.includes('OcrWorker')) {
  assert.ok(!resourceIds.some(resource => /^Ocr(WorkerFailure|QueueAge|DrainRate)Alarm/.test(resource)), 'OCR is disabled: no OCR alarms')
}
if (!notificationWorkerEnabled) {
  assert.ok(!resourceIds.some(resource => /^NotificationQueue(Age|Backlog|Drain)Alarm/.test(resource)),
    'the notification worker is off: no notification queue alarms')
  assert.doesNotMatch(text, /:novuApiKey::/, 'a disabled notification worker reads nothing from the provider secret')
}
// ADR-064: the worker gives Novu the verified login email only when staging
// opts in with HID_NOVU_SUBSCRIBER_SYNC_ENABLED; every other synth keeps it off.
const notificationWorkerTask = taskContainer('notification-worker')
if (notificationWorkerTask) {
  const workerEnvironment = Object.fromEntries((notificationWorkerTask.Environment ?? []).map(entry => [entry.Name, entry.Value]))
  assert.equal(workerEnvironment.NOVU_SUBSCRIBER_SYNC,
    environment === 'staging' && process.env.HID_NOVU_SUBSCRIBER_SYNC_ENABLED === 'true' ? 'email' : 'disabled',
    'the notification worker syncs subscriber emails only where staging opted in')
  assert.equal(workerEnvironment.HID_DEPLOYMENT_ENV, environment)
}

// D4 (ADR-053): in production, and wherever HID_OPERATIONAL_ALARM_TOPIC_ARN is
// supplied, every alarm notifies the environment's own operator-created
// topic on ALARM and on OK; otherwise no alarm has an action.
const alarms = resources('AWS::CloudWatch::Alarm')
const alarmTopic = { 'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, ':sns:', { Ref: 'AWS::Region' }, ':',
  { Ref: 'AWS::AccountId' }, `:hid-${environment}-operational-alerts`]] }
const alarmsRouted = environment === 'production' || process.env.HID_OPERATIONAL_ALARM_TOPIC_ARN !== undefined
assert.ok(alarms.length > 0)
for (const alarm of alarms) {
  for (const key of ['AlarmActions', 'OKActions']) {
    if (alarmsRouted) assert.deepEqual(alarm.Properties[key], [alarmTopic], `every alarm must notify the operational topic (${key})`)
    else assert.equal(alarm.Properties[key], undefined, 'no alarm action without an operational topic')
  }
}
if (alarmsRouted) assert.deepEqual(regional.Outputs.OperationalAlarmTopicArn?.Value, alarmTopic)
const alarmsOn = (namespace, metricName) => alarms.filter(alarm =>
  alarm.Properties.Namespace === namespace && alarm.Properties.MetricName === metricName)
if (issuerEnvironment) {
  for (const metricName of ['Errors', 'Throttles']) {
    assert.equal(alarmsOn('AWS/Lambda', metricName).length, 1, `the issuer Lambda needs a ${metricName} alarm`)
  }
  for (const metricName of ['5XXError', '4XXError']) {
    assert.equal(alarmsOn('AWS/ApiGateway', metricName).length, 1, `the issuer stage needs a ${metricName} alarm`)
  }
}
const filters = resources('AWS::Logs::MetricFilter')
if (!asleep) {
  const otp = filters.filter(filter => filter.Properties.MetricTransformations[0].MetricName === 'OtpDefinitiveFailures')
  assert.equal(otp.length, 1)
  assert.equal(otp[0].Properties.FilterPattern,
    '{ ($.event = "notification.otp.outcome") && ($.outcome = "definitive_failure") }')
  assert.equal(alarmsOn('HID/Notification', 'OtpDefinitiveFailures').length, 1)
  if (issuerEnvironment) {
    const renewal = filters.filter(filter => filter.Properties.MetricTransformations[0].MetricName === 'TokenRenewalUnavailable')
    const disabledNames = disabledIds.map(id => id.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase())
    const enabledTokenApps = tokenTasks.map(task => task.Properties.ContainerDefinitions
      .find(container => container.Name !== 'workload-token-agent').Name).filter(name => !disabledNames.includes(name))
    assert.equal(renewal.length, enabledTokenApps.length, 'one renewal filter per enabled token-bearing task')
    for (const filter of renewal) assert.equal(filter.Properties.FilterPattern, '"Workload token renewal unavailable"')
    assert.equal(alarmsOn('HID/WorkloadIdentity', 'TokenRenewalUnavailable').length, 1)
  }
}

// NOTIF-PROD: notification-api reads exactly its delivery profile's provider
// fields: email-only (staging) is the SES sender; otp-email-sms is the SES
// sender and the three Termii fields. No Meta, WhatsApp or Brevo field.
const notificationApi = taskContainer('notification-api')
const notificationEnvironment = Object.fromEntries(notificationApi.Environment.map(entry => [entry.Name, entry.Value]))
assert.equal(notificationEnvironment.NOTIFICATION_DELIVERY_PROFILE, environment === 'staging' ? 'email-only' : 'otp-email-sms')
assert.equal(notificationEnvironment.HID_DEPLOYMENT_ENV, environment)
const providerFields = notificationApi.Secrets.map(secret => secret.ValueFrom?.['Fn::Join']?.[1])
  .filter(parts => Array.isArray(parts) && parts[0]?.Ref === 'NotificationProviderSecretArn')
  .map(parts => /^:([A-Za-z0-9]+)::$/.exec(String(parts[1]))?.[1]).sort()
assert.deepEqual(providerFields, environment === 'staging' ? ['sesFromAddress']
  : ['sesFromAddress', 'termiiApiKey', 'termiiBaseUrl', 'termiiSenderId'])
assert.doesNotMatch(text, /:(meta[A-Za-z]+|brevo[A-Za-z]+)::/, 'no Meta, WhatsApp or Brevo provider field is read')

// CFG-PROD, N1, ADR-062: Identity's NIN-only enrollment flag and the routes
// that prove a person holds the NIN are the explicit synth inputs, false by
// default. NIN-only enrollment needs a route; staging sends no holder SMS;
// production runs the online route only with the facility route (ADR-063)
// and never the signed-in NIN binding.
const identityFlag = name => identityApis[0].Environment.find(entry => entry.Name === name)?.Value
const ninOnlyEnrollment = identityFlag('QOREID_NIN_ONLY_ENROLLMENT_ENABLED')
const ninHolderSms = identityFlag('NIN_HOLDER_SMS_ENABLED')
const assistedRegistration = identityFlag('ASSISTED_REGISTRATION_ENABLED')
const patientSelfNinBinding = identityFlag('QOREID_PATIENT_SELF_NIN_BINDING_ENABLED')
assert.equal(ninOnlyEnrollment, process.env.HID_QOREID_NIN_ONLY_ENROLLMENT_ENABLED ?? 'false')
assert.equal(ninHolderSms, process.env.HID_NIN_HOLDER_SMS_ENABLED ?? 'false')
assert.equal(assistedRegistration, process.env.HID_ASSISTED_REGISTRATION_ENABLED ?? 'false')
assert.equal(patientSelfNinBinding, process.env.HID_QOREID_PATIENT_SELF_NIN_BINDING_ENABLED ?? 'false')
if (ninOnlyEnrollment === 'true') {
  assert.ok(ninHolderSms === 'true' || assistedRegistration === 'true',
    'NIN-only enrollment needs the online or the facility holder route (ADR-062)')
}
if (environment === 'staging') assert.equal(ninHolderSms, 'false', 'staging identity-api must not send holder SMS')
if (environment === 'production') {
  if (ninHolderSms === 'true') {
    assert.equal(assistedRegistration, 'true',
      'production identity-api sends holder SMS only with the facility route on (ADR-062, ADR-063)')
  }
  assert.equal(patientSelfNinBinding, 'false', 'production identity-api must not enable the signed-in NIN binding')
}

// Patient record release (owner decision 4 of 2026-10-16, D7): ehr-api's
// category flags are the explicit synth inputs, false by default, and only
// staging may set one. Production releases no Lab result while Lab is off at
// launch (D17) and no other category until the clinical owner signs it off
// (P36); the development stack's ehr-api runs in the production profile.
const ehrApis = resources('AWS::ECS::TaskDefinition')
  .filter(task => String(task.Properties.Family).endsWith('-ehr-api'))
  .flatMap(task => task.Properties.ContainerDefinitions).filter(container => container.Name === 'ehr-api')
assert.equal(ehrApis.length, 1)
for (const [flag, input] of [['EHR_PATIENT_RELEASE_VITALS', 'HID_EHR_PATIENT_RELEASE_VITALS'],
  ['EHR_PATIENT_RELEASE_DIAGNOSES', 'HID_EHR_PATIENT_RELEASE_DIAGNOSES'],
  ['EHR_PATIENT_RELEASE_PRESCRIPTIONS', 'HID_EHR_PATIENT_RELEASE_PRESCRIPTIONS'],
  ['EHR_PATIENT_RELEASE_LAB_RESULTS', 'HID_EHR_PATIENT_RELEASE_LAB_RESULTS'],
  ['EHR_PATIENT_RELEASE_DOCUMENTS', 'HID_EHR_PATIENT_RELEASE_DOCUMENTS']]) {
  assert.equal(ehrApis[0].Environment.find(entry => entry.Name === flag)?.Value, process.env[input] ?? 'false', flag)
}
if (environment !== 'staging') {
  for (const flag of ['EHR_PATIENT_RELEASE_VITALS', 'EHR_PATIENT_RELEASE_DIAGNOSES', 'EHR_PATIENT_RELEASE_PRESCRIPTIONS',
    'EHR_PATIENT_RELEASE_LAB_RESULTS', 'EHR_PATIENT_RELEASE_DOCUMENTS']) {
    assert.equal(ehrApis[0].Environment.find(entry => entry.Name === flag)?.Value, 'false',
      `${environment} ehr-api must not release ${flag} to patients outside staging (D17, P36)`)
  }
}

// Imported legacy medical history (owner decision 3 of 2026-10-16, ADR-066):
// the patient read and the staff read in ehr-api and the patient's sharing
// choice in identity-api are explicit synth inputs, false by default, and only
// staging may set one until the P37 sign-off.
// identityApis is the identity-api container list declared above.
const importedHistory = {}
for (const [containers, flag, input] of [[ehrApis, 'EHR_PATIENT_RELEASE_IMPORTED_HISTORY', 'HID_EHR_PATIENT_RELEASE_IMPORTED_HISTORY'],
  [ehrApis, 'EHR_STAFF_IMPORTED_HISTORY_ENABLED', 'HID_EHR_STAFF_IMPORTED_HISTORY_ENABLED'],
  [identityApis, 'IMPORTED_HISTORY_SHARING_ENABLED', 'HID_IMPORTED_HISTORY_SHARING_ENABLED']]) {
  const value = containers[0].Environment.find(entry => entry.Name === flag)?.Value
  assert.equal(value, process.env[input] ?? 'false', flag)
  if (environment !== 'staging') {
    assert.equal(value, 'false', `${environment} must not set ${flag} outside staging (P37, ADR-066)`)
  }
  importedHistory[flag] = value === 'true'
}
// Staff read only while patients can choose and withdraw, and sharing only
// of what the patient can see: on patient read first, off staff read first.
assert.ok(!importedHistory.EHR_STAFF_IMPORTED_HISTORY_ENABLED || importedHistory.IMPORTED_HISTORY_SHARING_ENABLED,
  'EHR_STAFF_IMPORTED_HISTORY_ENABLED needs IMPORTED_HISTORY_SHARING_ENABLED (ADR-066)')
assert.ok(!importedHistory.IMPORTED_HISTORY_SHARING_ENABLED || importedHistory.EHR_PATIENT_RELEASE_IMPORTED_HISTORY,
  'IMPORTED_HISTORY_SHARING_ENABLED needs EHR_PATIENT_RELEASE_IMPORTED_HISTORY (ADR-066)')
// Patient record chat (owner decision 1 of 2026-10-16): off unless HID_RECORD_CHAT_PATIENT_ENABLED
// is true. Off, ehr-api receives the false flag and nothing else of record
// chat, and no task reads the record chat secret. No task receives an
// ANTHROPIC_* variable: ehr-api refuses to start beside one.
const recordChatEnabled = (process.env.HID_RECORD_CHAT_PATIENT_ENABLED ?? 'false') === 'true'
assert.equal(ehrApis[0].Environment.find(entry => entry.Name === 'RECORD_CHAT_PATIENT_ENABLED')?.Value,
  String(recordChatEnabled), 'RECORD_CHAT_PATIENT_ENABLED')
assert.deepEqual((ehrApis[0].Secrets ?? []).map(entry => entry.Name).filter(name => name.startsWith('RECORD_CHAT_')).sort(),
  recordChatEnabled ? ['RECORD_CHAT_ANTHROPIC_API_KEY', 'RECORD_CHAT_AUDIT_DIGEST_KEY_B64'] : [])
assert.equal(Boolean(regional.Parameters.RecordChatSecretArn), recordChatEnabled, 'RecordChatSecretArn')
if (!recordChatEnabled) {
  assert.deepEqual(ehrApis[0].Environment.map(entry => entry.Name)
    .filter(name => name.startsWith('RECORD_CHAT_') && name !== 'RECORD_CHAT_PATIENT_ENABLED'), [])
}
for (const container of resources('AWS::ECS::TaskDefinition').flatMap(task => task.Properties.ContainerDefinitions)) {
  const names = [...(container.Environment ?? []), ...(container.Secrets ?? [])].map(entry => entry.Name)
  assert.deepEqual(names.filter(name => name.startsWith('ANTHROPIC_')), [], container.Name)
  if (container.Name !== 'ehr-api') assert.deepEqual(names.filter(name => name.startsWith('RECORD_CHAT_')), [], container.Name)
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
