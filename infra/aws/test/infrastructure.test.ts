import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { environmentConfig, externalAwsEnvironment, vpcDnsResolver } from '../src/config.js';
import { HidCostGovernanceStack } from '../src/cost-governance-stack.js';
import { HidRegionalStack } from '../src/hid-regional-stack.js';
import { costInventory } from '../src/cost-inventory.js';
import { browserPaths, databaseConnectionDemand, validateDatabaseConnectionBudget,
  workloadNames, workloads, workloadScale } from '../src/workloads.js';

interface Resource {
  readonly Type: string;
  readonly Properties?: Record<string, unknown>;
  readonly DeletionPolicy?: string;
  readonly UpdateReplacePolicy?: string;
}

// The exact ARN of the operator-created production alarm topic (synthetic
// account; D4 / ADR-053). Production refuses to synthesize without one.
const productionTopicArn = 'arn:aws:sns:eu-west-1:000000000000:hid-production-operational-alerts';
const application = new App();
const configuration = environmentConfig('production', undefined, undefined, undefined,
  { operationalAlarmTopicArn: productionTopicArn });
const regionalStack = new HidRegionalStack(application, 'RegionalTest', { configuration });
const regional = Template.fromStack(regionalStack).toJSON() as {
  readonly Parameters: Record<string, Record<string, unknown>>;
  readonly Resources: Record<string, Resource>;
};
const stagingApplication = new App();
const stagingRegionalStack = new HidRegionalStack(stagingApplication, 'StagingRegionalTest', {
  configuration: environmentConfig('staging', 'economy'),
});
const stagingRegional = Template.fromStack(stagingRegionalStack).toJSON() as {
  readonly Parameters: Record<string, Record<string, unknown>>;
  readonly Resources: Record<string, Resource>;
};
const sleepConfiguration = environmentConfig('staging', 'sleep');
const sleepApplication = new App();
const sleepRegional = Template.fromStack(new HidRegionalStack(sleepApplication, 'SleepRegionalTest', {
  configuration: sleepConfiguration,
})).toJSON() as typeof regional;
const fidelityConfiguration = environmentConfig('staging', 'fidelity');
const fidelityApplication = new App();
const fidelityRegional = Template.fromStack(new HidRegionalStack(fidelityApplication, 'FidelityRegionalTest', {
  configuration: fidelityConfiguration,
})).toJSON() as typeof regional;
const developmentRegional = Template.fromStack(new HidRegionalStack(new App(), 'DevelopmentRegionalTest', {
  configuration: environmentConfig('development'),
})).toJSON() as typeof regional;
const workloadParameters = [
  'WorkloadIssuerUrl', 'WorkloadJwksUrl', 'EhrWorkloadSubject', 'LabWorkloadSubject',
  'PharmacyWorkloadSubject', 'OcrWorkloadSubject', 'OutreachWorkloadSubject',
  'IdentityWorkloadSubject',
] as const;
const qoreIdStagingApplication = new App();
const qoreIdStagingRegional = Template.fromStack(new HidRegionalStack(qoreIdStagingApplication, 'QoreIdStagingRegionalTest', {
  configuration: environmentConfig('staging', 'economy', 'true'),
})).toJSON() as typeof regional;

function resources(template: typeof regional, type: string): Array<[string, Resource]> {
  return Object.entries(template.Resources).filter(([, resource]) => resource.Type === type);
}

function properties(template: typeof regional, type: string): Array<Record<string, unknown>> {
  return resources(template, type).map(([, resource]) => resource.Properties ?? {});
}

function statements(): Array<Record<string, unknown>> {
  return properties(regional, 'AWS::IAM::Policy').flatMap((policy) => {
    const document = policy.PolicyDocument as { readonly Statement?: Array<Record<string, unknown>> } | undefined;
    return document?.Statement ?? [];
  });
}

test('environment names are typed and production is multi-AZ', () => {
  assert.equal(configuration.name, 'production');
  assert.equal(configuration.databaseMultiAz, true);
  assert.equal(configuration.availabilityZones, 3);
  assert.equal(configuration.publicApiSubdomain, 'api');
  assert.throws(() => environmentConfig('staging'), /HID_STAGING_MODE/);
  assert.throws(() => environmentConfig('production', 'sleep'), /valid only/);
  assert.throws(() => environmentConfig('staging', 'economy', 'enabled'), /HID_QOREID_ENABLED/);
  assert.equal(environmentConfig('staging', 'economy').qoreIdEnabled, false);
  assert.equal(environmentConfig('staging', 'economy', 'true').qoreIdEnabled, true);
  assert.equal(environmentConfig('staging', 'economy').publicApiSubdomain, 'api.staging');
  assert.deepEqual(environmentConfig('staging', 'economy').browserSubdomains, [
    'staging', 'ehr.staging', 'lab.staging', 'pharmacy.staging', 'migrate.staging', 'outreach.staging', 'admin.staging',
  ]);
  assert.deepEqual(environmentConfig('production').browserSubdomains, [
    'www', 'ehr', 'lab', 'pharmacy', 'migrate', 'outreach', 'admin',
  ]);
});

test('account and region are both external or both absent', () => {
  assert.deepEqual(externalAwsEnvironment(undefined, undefined), undefined);
  assert.throws(() => externalAwsEnvironment('123456789012', undefined));
  assert.deepEqual(externalAwsEnvironment('123456789012', 'eu-west-1'), {
    account: '123456789012', region: 'eu-west-1',
  });
});

test('staging requires the selected Novu region while production configuration is unchanged', () => {
  for (const template of [stagingRegional, fidelityRegional, sleepRegional]) {
    assert.deepEqual(template.Parameters.StagingNovuApiUrl?.AllowedValues,
      ['https://api.novu.co', 'https://eu.api.novu.co']);
    assert.equal(template.Parameters.StagingNovuApiUrl?.Default, undefined);
    const task = resources(template, 'AWS::ECS::TaskDefinition')
      .find(([id]) => id.startsWith('NotificationWorkerTaskDefinition'))?.[1];
    assert.ok(task);
    const containers = task.Properties!.ContainerDefinitions as Array<{ Name: string; Environment: Array<{ Name: string; Value: unknown }> }>;
    const worker = containers.find(container => container.Name === 'notification-worker');
    assert.ok(worker);
    assert.deepEqual(worker.Environment.find(entry => entry.Name === 'NOVU_API_URL')?.Value, { Ref: 'StagingNovuApiUrl' });
  }
  assert.equal(regional.Parameters.StagingNovuApiUrl, undefined);
  const serialized = JSON.stringify(regional);
  assert.ok(!serialized.includes('StagingNovuApiUrl'));
});

test('RDS is private', () => {
  const [database] = properties(regional, 'AWS::RDS::DBInstance');
  assert.equal(database!.PubliclyAccessible, false);
});

test('internal HTTPS ingress is limited to the eight owner-service security groups', () => {
  const allowedSourcePrefixes = [
    'IdentityApi', 'EhrApi', 'LabApi', 'PharmacyApi', 'OcrApi', 'OutreachApi',
    'NotificationApi', 'NotificationWorker',
  ];
  for (const template of [regional, stagingRegional, fidelityRegional]) {
    const internal = resources(template, 'AWS::EC2::SecurityGroup').find(([, group]) =>
      group.Properties?.GroupDescription === 'Internal HTTPS service boundary for server-to-server calls');
    assert.ok(internal);
    const [internalId, internalGroup] = internal;
    assert.deepEqual(internalGroup.Properties?.SecurityGroupIngress ?? [], [],
      'the listener must not add an inline world-open ingress rule');

    const ingress = properties(template, 'AWS::EC2::SecurityGroupIngress').filter((rule) =>
      JSON.stringify(rule.GroupId) === JSON.stringify({ 'Fn::GetAtt': [internalId, 'GroupId'] }));
    assert.equal(ingress.length, allowedSourcePrefixes.length);
    const actualSources = new Set<string>();
    for (const rule of ingress) {
      assert.equal(rule.IpProtocol, 'tcp');
      assert.equal(rule.FromPort, 443);
      assert.equal(rule.ToPort, 443);
      assert.equal(rule.CidrIp, undefined);
      assert.equal(rule.CidrIpv6, undefined);
      const source = rule.SourceSecurityGroupId as { readonly 'Fn::GetAtt': readonly string[] };
      assert.deepEqual(source['Fn::GetAtt'].slice(1), ['GroupId']);
      actualSources.add(source['Fn::GetAtt'][0]!);
    }
    const expectedSources = allowedSourcePrefixes.map((prefix) => {
      const source = resources(template, 'AWS::EC2::SecurityGroup').find(([id]) =>
        id.startsWith(`${prefix}SecurityGroup`));
      assert.ok(source, `missing ${prefix} source security group`);
      return source[0];
    });
    assert.deepEqual(actualSources, new Set(expectedSources));
  }
  assert.equal(resources(sleepRegional, 'AWS::EC2::SecurityGroup').some(([, group]) =>
    group.Properties?.GroupDescription === 'Internal HTTPS service boundary for server-to-server calls'), false);
});

test('RDS is encrypted with a customer-managed KMS key', () => {
  const [database] = properties(regional, 'AWS::RDS::DBInstance');
  assert.equal(database!.StorageEncrypted, true);
  assert.ok(database!.KmsKeyId);
});

test('production RDS has deletion protection, Multi-AZ, backups, and final snapshot behavior', () => {
  const databaseResource = resources(regional, 'AWS::RDS::DBInstance')[0]?.[1];
  assert.ok(databaseResource);
  assert.equal(databaseResource.Properties!.DeletionProtection, true);
  assert.equal(databaseResource.Properties!.MultiAZ, true);
  assert.equal(databaseResource.Properties!.BackupRetentionPeriod, 35);
  assert.equal(databaseResource.DeletionPolicy, 'Snapshot');
});

test('staging snapshots only RDS and uses supported retention elsewhere', () => {
  for (const resource of Object.values(stagingRegional.Resources)) {
    if (resource.Type === 'AWS::RDS::DBInstance') {
      assert.equal(resource.DeletionPolicy, 'Snapshot');
      assert.equal(resource.UpdateReplacePolicy, 'Snapshot');
      continue;
    }
    assert.notEqual(resource.DeletionPolicy, 'Snapshot');
    assert.notEqual(resource.UpdateReplacePolicy, 'Snapshot');
  }
});

test('RDS uses PostgreSQL 16 family without a pinned minor version', () => {
  const [database] = properties(regional, 'AWS::RDS::DBInstance');
  assert.equal(database!.Engine, 'postgres');
  assert.equal(database!.EngineVersion, '16');
  const [parameterGroup] = properties(regional, 'AWS::RDS::DBParameterGroup');
  assert.equal(parameterGroup!.Family, 'postgres16');
});

test('database security-group ingress never uses a world CIDR', () => {
  const databaseIngress = properties(regional, 'AWS::EC2::SecurityGroupIngress')
    .filter((item) => item.FromPort === 5432 || item.ToPort === 5432);
  assert.equal(databaseIngress.length, 10);
  for (const ingress of databaseIngress) {
    assert.ok(ingress.SourceSecurityGroupId);
    assert.equal(ingress.CidrIp, undefined);
    assert.equal(ingress.CidrIpv6, undefined);
  }
});

test('all backend ECS services run without public IPs', () => {
  const services = properties(regional, 'AWS::ECS::Service');
  assert.equal(services.length, 11);
  for (const service of services) {
    const network = service.NetworkConfiguration as {
      readonly AwsvpcConfiguration: { readonly AssignPublicIp: string };
    };
    assert.equal(network.AwsvpcConfiguration.AssignPublicIp, 'DISABLED');
  }
});

test('execution and task roles are separate on every task definition', () => {
  const taskDefinitions = properties(regional, 'AWS::ECS::TaskDefinition');
  assert.equal(taskDefinitions.length, 12);
  for (const definition of taskDefinitions) {
    assert.notDeepEqual(definition.ExecutionRoleArn, definition.TaskRoleArn);
  }
});

test('OCR worker IAM is action-bounded and document-resource-bounded', () => {
  const workerStatements = statements().filter((statement) => String(statement.Sid ?? '').includes('Document')
    || statement.Sid === 'UseTextractDocumentOperations' || statement.Sid === 'DecryptDocumentObjects');
  assert.ok(workerStatements.some((statement) => statement.Sid === 'ReadExactDocumentVersions'));
  assert.ok(workerStatements.some((statement) => statement.Sid === 'ReadExactDocumentObjects'));
  const textract = workerStatements.find((statement) => statement.Sid === 'UseTextractDocumentOperations')!;
  assert.deepEqual(textract.Action, [
    'textract:AnalyzeDocument',
    'textract:StartDocumentTextDetection',
    'textract:GetDocumentTextDetection',
  ]);
  assert.deepEqual(textract.Resource, '*');
  assert.ok(textract.Condition);
});

test('dispatcher IAM can put only to the HID EventBridge bus', () => {
  const statement = statements().find((candidate) => candidate.Sid === 'PutOnlyToHidEventBus')!;
  assert.deepEqual(statement.Action, 'events:PutEvents');
  assert.notDeepEqual(statement.Resource, '*');
  assert.match(JSON.stringify(statement.Resource), /PlatformEventBus/);
});

test('document bucket blocks every public access mode', () => {
  const [bucket] = properties(regional, 'AWS::S3::Bucket');
  assert.deepEqual(bucket!.PublicAccessBlockConfiguration, {
    BlockPublicAcls: true,
    BlockPublicPolicy: true,
    IgnorePublicAcls: true,
    RestrictPublicBuckets: true,
  });
});

test('document bucket uses KMS encryption', () => {
  const [bucket] = properties(regional, 'AWS::S3::Bucket');
  assert.match(JSON.stringify(bucket!.BucketEncryption), /aws:kms/);
  assert.ok((bucket!.BucketEncryption as Record<string, unknown>).ServerSideEncryptionConfiguration);
});

test('document bucket is versioned and production-retained', () => {
  const bucket = resources(regional, 'AWS::S3::Bucket')[0]?.[1];
  assert.ok(bucket);
  assert.deepEqual(bucket.Properties!.VersioningConfiguration, { Status: 'Enabled' });
  assert.equal(bucket.DeletionPolicy, 'Retain');
});

test('clinical object versions have no generic current or noncurrent expiration', () => {
  const [bucket] = properties(regional, 'AWS::S3::Bucket');
  const rules = bucket!.LifecycleConfiguration as { readonly Rules: Array<Record<string, unknown>> };
  for (const prefix of ['clinical/', 'objects/']) {
    const rule = rules.Rules.find((candidate) => JSON.stringify(candidate).includes(prefix));
    assert.ok(rule, `missing ${prefix} clinical lifecycle boundary`);
    assert.equal(rule!.ExpirationInDays, undefined);
    assert.equal(rule!.NoncurrentVersionExpiration, undefined);
  }
  assert.ok(rules.Rules.some((rule) => JSON.stringify(rule).includes('temporary/')));
  assert.ok(rules.Rules.some((rule) => JSON.stringify(rule).includes('release-evidence/')));
  assert.ok(rules.Rules.some((rule) => JSON.stringify(rule).includes('test-staging/')));
});

test('OCR KMS use is exact-key and constrained to S3 via-service', () => {
  const statement = statements().find((candidate) => candidate.Sid === 'DecryptDocumentObjects')!;
  assert.deepEqual(statement.Action, 'kms:Decrypt');
  assert.notDeepEqual(statement.Resource, '*');
  assert.match(JSON.stringify(statement.Condition), /kms:ViaService/);
});

test('all workloads and the migration job have separate task definitions', () => {
  assert.equal(properties(regional, 'AWS::ECS::Service').length, workloadNames.length);
  assert.equal(properties(regional, 'AWS::ECS::TaskDefinition').length, workloadNames.length + 1);
  const families = properties(regional, 'AWS::ECS::TaskDefinition').map((item) => item.Family);
  assert.equal(new Set(families.map((item) => JSON.stringify(item))).size, workloadNames.length + 1);
});

test('CloudFront is absent because Cloudflare owns frontend and edge delivery', () => {
  assert.equal(resources(regional, 'AWS::CloudFront::Distribution').length, 0);
  assert.equal(regional.Parameters.PublicHostedZoneId, undefined);
  assert.equal(regional.Parameters.ApplicationDomainName, undefined);
});

test('staging and production synthesize distinct fixed public API hostnames and browser origins', () => {
  const productionText = JSON.stringify(regional);
  const stagingText = JSON.stringify(stagingRegional);
  assert.match(productionText, /api\./);
  assert.match(stagingText, /api\.staging\./);
  assert.match(productionText, /www\./);
  assert.match(stagingText, /ehr\.staging\./);
  assert.doesNotMatch(stagingText, /api\.healthidentitydirectory\.com/);
  assert.equal(regional.Parameters.OriginDomainName, undefined);
  assert.equal(stagingRegional.Parameters.OriginDomainName, undefined);
});

test('task definitions contain secret references rather than plaintext secrets', () => {
  const serialized = JSON.stringify(regional);
  assert.doesNotMatch(serialized, /postgresql:\/\//);
  assert.doesNotMatch(serialized, /replace-me|change-me|local-only-independent-random-secret/);
  const definitions = properties(regional, 'AWS::ECS::TaskDefinition');
  assert.ok(definitions.some((definition) => JSON.stringify(definition).includes('ValueFrom')));
});

test('no JWT value is embedded and caller credentials are file paths', () => {
  const serialized = JSON.stringify(regional);
  assert.doesNotMatch(serialized, /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/);
  assert.match(serialized, /\/var\/run\/hid\/workload-tokens\/identity\.jwt/);
});

test('token-bearing tasks mount the token volume read-only', () => {
  const definitions = properties(regional, 'AWS::ECS::TaskDefinition');
  const mounted = definitions.filter((definition) => JSON.stringify(definition).includes('workload-tokens'));
  assert.equal(mounted.length, 6);
  for (const definition of mounted) assert.match(JSON.stringify(definition), /"ReadOnly":true/);
});

test('migration is a separate one-shot task with a safe plan default', () => {
  const migration = properties(regional, 'AWS::ECS::TaskDefinition')
    .find((definition) => JSON.stringify(definition.Family).includes('database-migration'))!;
  const containers = migration.ContainerDefinitions as Array<Record<string, unknown>>;
  assert.deepEqual(containers[0]!.Command, ['--plan']);
  assert.equal(properties(regional, 'AWS::ECS::Service')
    .some((service) => JSON.stringify(service).includes('database-migration')), false);
});

test('ordinary notifications have one selected EventBridge route and encrypted SQS/DLQ pair', () => {
  const rules = properties(regional, 'AWS::Events::Rule');
  assert.equal(rules.length, 1);
  assert.equal(resources(regional, 'AWS::SQS::Queue').length, 2);
  const eventPattern = rules[0]!.EventPattern as { readonly 'detail-type': readonly string[] };
  assert.deepEqual(eventPattern['detail-type'], [
    'PatientRegistered.v1',
    'PatientIdentityResolved.v1',
    'OcrPublicationSucceeded.v1',
    'LabResultReleased.v1',
    'MedicationDispensed.v1',
    'OutreachPatientResolved.v1',
    'PatientAccessPinVerified.v1',
  ]);
  assert.equal(eventPattern['detail-type'].some((eventType) => /otp|passwordreset/i.test(eventType)), false);
  assert.equal(resources(regional, 'AWS::Lambda::Function')
    .filter(([, item]) => item.Properties?.FunctionName !== 'hid-production-workload-issuer').length, 0,
  'the only production Lambda is the workload issuer');
  assert.equal(resources(regional, 'AWS::Events::EventBus').length, 1);
});

test('the canonical seven browser roots remain explicit', () => {
  assert.deepEqual(browserPaths, ['/', '/ehr/', '/lab/', '/pharmacy/', '/migrate/', '/outreach/', '/admin/']);
  assert.equal(browserPaths.length, 7);
});

test('all deployable resources receive governance tags', () => {
  const required = {
    Project: 'HID', Environment: 'production', ManagedBy: 'CDK', Owner: 'HID',
    CostCenter: 'HID', DataClassification: 'healthcare-restricted',
  } as const;
  for (const type of ['AWS::ECS::Service', 'AWS::ECS::TaskDefinition', 'AWS::ECR::Repository',
    'AWS::RDS::DBInstance', 'AWS::S3::Bucket', 'AWS::KMS::Key', 'AWS::SQS::Queue',
    'AWS::Events::EventBus', 'AWS::Logs::LogGroup', 'AWS::ElasticLoadBalancingV2::LoadBalancer',
    'AWS::WAFv2::WebACL', 'AWS::CloudWatch::Alarm']) {
    for (const item of properties(regional, type)) {
      const tags = item.Tags as Array<{ readonly Key: string; readonly Value: string }>;
      assert.ok(tags.some((tag) => tag.Key === 'Service'), `${type} lacks a Service tag`);
      for (const [key, value] of Object.entries(required)) {
        assert.ok(tags.some((tag) => tag.Key === key && tag.Value === value), `${type} lacks ${key}=${value}`);
      }
    }
  }
});

test('production logs are retained rather than destroyed', () => {
  for (const [, logGroup] of resources(regional, 'AWS::Logs::LogGroup')) {
    assert.equal(logGroup.DeletionPolicy, 'Retain');
    assert.equal(logGroup.Properties!.RetentionInDays, 365);
  }
});

test('every service and migration image is a required immutable-digest parameter', () => {
  const imageParameters = Object.entries(regional.Parameters).filter(([name]) => name.endsWith('ImageUri'));
  assert.equal(imageParameters.length, 12);
  for (const [, parameter] of imageParameters) {
    assert.equal(parameter.Default, undefined);
    assert.match(String(parameter.AllowedPattern), /sha256/);
  }
  assert.doesNotMatch(JSON.stringify(properties(regional, 'AWS::ECS::TaskDefinition')), /:latest/);
});

test('ECR repositories are encrypted, scan-on-push, immutable, and lifecycle-bounded', () => {
  const repositories = properties(regional, 'AWS::ECR::Repository');
  assert.equal(repositories.length, 11);
  for (const repository of repositories) {
    assert.equal(repository.ImageTagMutability, 'IMMUTABLE');
    assert.deepEqual(repository.ImageScanningConfiguration, { ScanOnPush: true });
    assert.equal(repository.EncryptionConfiguration, undefined, 'ECR AES256 encryption is the CloudFormation default');
    assert.ok(repository.LifecyclePolicy);
  }
});

test('regional API WAF requires the Cloudflare origin secret and baseline protections', () => {
  const acls = properties(regional, 'AWS::WAFv2::WebACL').filter((item) =>
    (item.VisibilityConfig as { readonly MetricName?: string }).MetricName === 'hid-production-api-origin');
  assert.equal(acls.length, 1);
  const [acl] = acls;
  const serialized = JSON.stringify(acl!.Rules);
  assert.match(serialized, /x-hid-origin-authorization/);
  assert.match(serialized, /ProductionCloudflareOriginSecret/);
  assert.doesNotMatch(serialized, /StagingCloudflareOriginSecret/);
  assert.match(serialized, /AWSManagedRulesCommonRuleSet/);
  assert.match(serialized, /AWSManagedRulesKnownBadInputsRuleSet/);
  assert.match(serialized, /RateBasedStatement/);
});

interface WafRule {
  readonly Name: string;
  readonly Priority: number;
  readonly Action?: Record<string, unknown>;
  readonly OverrideAction?: Record<string, unknown>;
  readonly Statement: Record<string, any>;
}

function apiOriginRules(template: typeof regional, environment: string): readonly WafRule[] {
  const acls = properties(template, 'AWS::WAFv2::WebACL').filter((item) =>
    (item.VisibilityConfig as { readonly MetricName?: string }).MetricName === `hid-${environment}-api-origin`);
  assert.equal(acls.length, 1);
  return [...(acls[0]!.Rules as readonly WafRule[])].sort((left, right) => left.Priority - right.Priority);
}

const uuid = '0b9d2f9e-6b7c-4b55-9a39-1d3e0e7a1f11';
const other = '1c8e3f0a-2b4d-4e6f-8a9b-0c1d2e3f4a5b';
const encounter = `/api/v1/ehr/patients/${uuid}/encounters/${other}`;

// WAF-CRS-BODY. The Core Rule Set's SizeRestrictions_BODY blocks any body over
// 8 KB, but ehr-api accepts clinical text up to 100,000 characters (512 KiB
// JSON) and 4,000-character fields that exceed 8 KB in multi-byte text. The
// rule now only counts; a rule right after the group blocks what it labels
// unless the request is a POST or PATCH to an encounter-scoped clinical write
// route spelled exactly as Health-id sends it. Every other CRS rule still blocks.
test('the WAF body-size rule is relaxed only for encounter-scoped clinical writes', () => {
  for (const [template, environment] of [[regional, 'production'], [stagingRegional, 'staging']] as const) {
    const rules = apiOriginRules(template, environment);
    const common = rules.find((rule) => rule.Name === 'AwsCommonRules')!;
    assert.deepEqual(common.OverrideAction, { None: {} });
    assert.deepEqual(common.Statement.ManagedRuleGroupStatement, {
      Name: 'AWSManagedRulesCommonRuleSet', VendorName: 'AWS',
      RuleActionOverrides: [{ Name: 'SizeRestrictions_BODY', ActionToUse: { Count: {} } }],
    }, 'only SizeRestrictions_BODY is overridden, and only to count');
    const scoped = rules.find((rule) => rule.Name === 'AwsCommonRulesBodySize')!;
    assert.ok(scoped, 'a rule must block oversized bodies outside the clinical write routes');
    assert.ok(scoped.Priority > common.Priority, 'the scoped rule must run after the group that labels the request');
    assert.ok(scoped.Priority < rules.find((rule) => rule.Name === 'AwsKnownBadInputs')!.Priority);
    assert.deepEqual(scoped.Action, { Block: {} });
    const [label, exemption] = scoped.Statement.AndStatement.Statements;
    assert.deepEqual(label, { LabelMatchStatement: { Scope: 'LABEL', Key: 'awswaf:managed:aws:core-rule-set:SizeRestrictions_Body' } });
    const [method, path] = exemption.NotStatement.Statement.AndStatement.Statements;
    assert.deepEqual(method.RegexMatchStatement.FieldToMatch, { Method: {} });
    assert.deepEqual(method.RegexMatchStatement.TextTransformations, [{ Priority: 0, Type: 'NONE' }]);
    assert.deepEqual(path.RegexMatchStatement.FieldToMatch, { UriPath: {} });
    assert.deepEqual(path.RegexMatchStatement.TextTransformations, [{ Priority: 0, Type: 'NONE' }],
      'the raw path is matched, so an encoded or dot-segment spelling never gains the exemption');
    const methodPattern = new RegExp(method.RegexMatchStatement.RegexString as string);
    const pathPattern = new RegExp(path.RegexMatchStatement.RegexString as string);
    assert.ok((path.RegexMatchStatement.RegexString as string).length <= 512, 'WAF regex strings are at most 512 characters');
    for (const allowed of ['POST', 'PATCH']) assert.match(allowed, methodPattern);
    for (const refused of ['GET', 'PUT', 'DELETE', 'post', 'XPOST', 'POSTX']) assert.doesNotMatch(refused, methodPattern);
    for (const route of [
      `/api/v1/ehr/patients/${uuid}/encounters`, encounter,
      `${encounter}/clinical-notes`, `${encounter}/clinical-notes/${uuid}`, `${encounter}/clinical-notes/${uuid}/revisions`,
      `${encounter}/diagnoses`, `${encounter}/diagnoses/${uuid}`, `${encounter}/prescriptions`, `${encounter}/prescriptions/${uuid}`,
      `${encounter}/lab-requests`, `${encounter}/lab-requests/${uuid}`,
    ]) assert.match(route, pathPattern, `${route} carries clinical text the service accepts`);
    for (const route of [
      `${encounter}/vitals`, `${encounter}/vitals/${uuid}/corrections`, `${encounter}/prescriptions/${uuid}/pharmacy-work-item`,
      `${encounter}/lab-requests/${uuid}/lab-work-item`, `${encounter}/clinical-notes/${uuid}/revisions/x`,
      `${encounter}/diagnoses/${uuid}/revisions`, `${encounter}/prescriptions/${uuid}/revisions`,
      `${encounter}/clinical-notes/`, `${encounter}//clinical-notes`, `${encounter}/./clinical-notes`,
      `${encounter}/x/../clinical-notes`, `${encounter}/clinical%2Dnotes`, `${encounter}/CLINICAL-NOTES`,
      `/api/v1/ehr/patients/${uuid.toUpperCase()}/encounters`, `/api/v1/ehr/patients/x/encounters`,
      `/API/v1/ehr/patients/${uuid}/encounters`, `/api/v1/ehr/documents/scan-events`, '/api/v1/ehr/internal/ocr/x',
      '/api/v1/identity/patient-enrollments', '/api/v1/auth/login', `/api/v1/lab/patients/${uuid}/encounters`,
      `/x/api/v1/ehr/patients/${uuid}/encounters`, `/api/v1/ehr/patients/${uuid}/encounters?x=1`,
    ]) assert.doesNotMatch(route, pathPattern, `${route} keeps the 8 KB body limit`);
  }
});

// A7. Every connection to the ALB comes from the Cloudflare Worker, so a rate
// rule keyed on the connecting address throttled every user behind one
// Cloudflare egress address together. Rule 0 blocks every request without the
// Worker's origin secret before any rate rule counts it, and the Worker always
// replaces X-HID-Client-Network with the client network it derives from
// CF-Connecting-IP: the IPv4 address, or the IPv6 /64 network address, so a
// client rotating addresses inside its /64 keeps one count (keyed on the full
// IPv6 address in X-Real-IP it could not be limited, and only the backstop
// would stop it, for every user behind that egress address). A backstop on the
// connecting address catches a leaked secret or a request without the header.
test('the WAF rate limit is per client network (IPv4 address or IPv6 /64), with a high backstop per connecting address', () => {
  for (const [template, environment] of [[regional, 'production'], [stagingRegional, 'staging']] as const) {
    const rules = apiOriginRules(template, environment);
    assert.deepEqual(rules.map((rule) => [rule.Priority, rule.Name]), [
      [0, 'RequireCloudflareOriginSecret'], [10, 'AwsCommonRules'], [11, 'AwsCommonRulesBodySize'],
      [20, 'AwsKnownBadInputs'], [30, 'ApiOriginRateLimit'], [31, 'ApiOriginEdgeRateLimit'],
    ]);
    const perClient = rules.find((rule) => rule.Name === 'ApiOriginRateLimit')!;
    assert.deepEqual(perClient.Action, { Block: {} });
    assert.deepEqual(perClient.Statement.RateBasedStatement, {
      AggregateKeyType: 'FORWARDED_IP', Limit: 2_000,
      ForwardedIPConfig: { HeaderName: 'X-HID-Client-Network', FallbackBehavior: 'MATCH' },
    });
    const backstop = rules.find((rule) => rule.Name === 'ApiOriginEdgeRateLimit')!;
    assert.deepEqual(backstop.Action, { Block: {} });
    assert.deepEqual(backstop.Statement.RateBasedStatement, { AggregateKeyType: 'IP', Limit: 50_000 });
  }
});

test('staging and production require independently named Cloudflare origin authorization inputs', () => {
  assert.ok(regional.Parameters.ProductionCloudflareOriginSecret);
  assert.equal(regional.Parameters.StagingCloudflareOriginSecret, undefined);
  assert.ok(stagingRegional.Parameters.StagingCloudflareOriginSecret);
  assert.equal(stagingRegional.Parameters.ProductionCloudflareOriginSecret, undefined);
  for (const parameter of [
    regional.Parameters.ProductionCloudflareOriginSecret,
    stagingRegional.Parameters.StagingCloudflareOriginSecret,
  ]) {
    assert.equal(parameter!.NoEcho, true);
    assert.equal(parameter!.Default, undefined);
  }
});

test('both ALB listeners enforce modern TLS', () => {
  const listeners = properties(regional, 'AWS::ElasticLoadBalancingV2::Listener');
  assert.equal(listeners.length, 2);
  for (const listener of listeners) assert.equal(listener.Protocol, 'HTTPS');
});

test('runtime database secret interfaces are unique and have no defaults', () => {
  const databaseSecretParameters = Object.entries(regional.Parameters)
    .filter(([name]) => name.endsWith('DatabaseSecretArn') && name !== 'MigrationDatabaseSecretArn');
  assert.equal(databaseSecretParameters.length, 9);
  for (const [, parameter] of databaseSecretParameters) {
    assert.equal(parameter.Default, undefined);
    assert.equal(parameter.NoEcho, true);
  }
});

test('human authentication secrets are injected only into the Identity authority', () => {
  const taskDefinitions = properties(regional, 'AWS::ECS::TaskDefinition');
  const carryingAuthSecret = taskDefinitions.filter((task) =>
    JSON.stringify(task.ContainerDefinitions).includes('AUTH_SIGNING_SECRET'));
  assert.equal(carryingAuthSecret.length, 1);
  assert.match(JSON.stringify(carryingAuthSecret[0]!.Family), /identity-api/i);
  const ehr = taskDefinitions.find((task) => JSON.stringify(task.Family).includes('ehr-api'));
  assert.ok(ehr);
  assert.doesNotMatch(JSON.stringify(ehr!.ContainerDefinitions), /AUTH_SIGNING_SECRET|AUTH_LOGIN_PEPPER|GOOGLE_OIDC_CLIENT_IDS/);
});

test('staging NIN is deferred and QoreID remains explicitly disabled without credential dependencies', () => {
  for (const template of [stagingRegional, fidelityRegional, sleepRegional, regional]) {
    const task = properties(template, 'AWS::ECS::TaskDefinition')
      .find(item => JSON.stringify(item.Family).includes('identity-api'))!;
    const api = (task.ContainerDefinitions as Array<{ Name: string; Environment: Array<{ Name: string; Value: unknown }>; Secrets: Array<{ Name: string }> }>)
      .find(item => item.Name === 'identity-api')!;
    const environment = Object.fromEntries(api.Environment.map(item => [item.Name, item.Value]));
    const names = api.Secrets.map(item => item.Name);
    assert.equal(environment.NIN_PROVIDER_MODE, template === regional ? 'unavailable' : 'deferred');
    for (const key of ['NIN_LOOKUP_HMAC_KEY_B64', 'NIN_ENCRYPTION_KEY_B64']) assert.equal(names.includes(key), template === regional);
    assert.ok(names.includes('OTP_HMAC_KEY_B64'));
    assert.ok(names.includes('TURNSTILE_SECRET_KEY'));
    assert.ok(names.includes('GOOGLE_OIDC_CLIENT_IDS'));
    assert.equal(environment.IDENTITY_SERVICE_IDENTITY_MODE, 'jwt');
    assert.equal(environment.TURNSTILE_MODE, 'required');
    assert.equal(environment.QOREID_ENABLED, 'false');
    assert.equal(names.includes('QOREID_CLIENT_ID'), false);
    assert.equal(names.includes('QOREID_CLIENT_SECRET'), false);
    assert.doesNotMatch(JSON.stringify(api), /METAMAP|metamap/);
  }
});

test('an explicit QoreID staging synth injects its distinct server-only secret into Identity only', () => {
  const parameter = qoreIdStagingRegional.Parameters.QoreIdCredentialsSecretArn;
  assert.ok(parameter);
  assert.equal(parameter.Default, undefined);
  assert.equal(parameter.NoEcho, true);
  const tasks = properties(qoreIdStagingRegional, 'AWS::ECS::TaskDefinition');
  const identity = tasks.find(task => JSON.stringify(task.Family).includes('identity-api'))!;
  const identityContainer = (identity.ContainerDefinitions as Array<{
    Name: string; Environment: Array<{ Name: string; Value: unknown }>; Secrets: Array<{ Name: string; ValueFrom: unknown }>;
  }>).find(container => container.Name === 'identity-api')!;
  const environment = Object.fromEntries(identityContainer.Environment.map(item => [item.Name, item.Value]));
  assert.equal(environment.QOREID_ENABLED, 'true');
  assert.deepEqual(identityContainer.Secrets.filter(item => item.Name.startsWith('QOREID_')).map(item => item.Name).sort(),
    ['QOREID_CLIENT_ID', 'QOREID_CLIENT_SECRET']);
  assert.ok(identityContainer.Secrets.some(item => item.Name === 'NIN_LOOKUP_HMAC_KEY_B64'));
  assert.ok(identityContainer.Secrets.some(item => item.Name === 'NIN_ENCRYPTION_KEY_B64'));
  for (const task of tasks.filter(task => task !== identity)) {
    assert.doesNotMatch(JSON.stringify(task.ContainerDefinitions), /QOREID_CLIENT_ID|QOREID_CLIENT_SECRET|NIN_LOOKUP_HMAC_KEY_B64/);
  }
});

test('Identity receives the platform MFA key from its sensitive secret and a fixed key version in every environment', () => {
  const developmentRegional = Template.fromStack(new HidRegionalStack(new App(), 'DevelopmentRegionalTest', {
    configuration: environmentConfig('development'),
  })).toJSON() as typeof regional;
  const profiles: Array<[string, typeof regional]> = [
    ['production', regional], ['development', developmentRegional], ['staging economy', stagingRegional],
    ['staging fidelity', fidelityRegional], ['staging sleep', sleepRegional], ['staging QoreID', qoreIdStagingRegional],
  ];
  for (const [label, template] of profiles) {
    const tasks = resources(template, 'AWS::ECS::TaskDefinition');
    const identity = tasks.find(([, task]) => JSON.stringify(task.Properties?.Family).includes('identity-api'));
    assert.ok(identity, `${label}: missing Identity task definition`);
    const containers = identity[1].Properties!.ContainerDefinitions as Array<{
      Name: string; Environment?: Array<{ Name: string; Value: unknown }>; Secrets?: Array<{ Name: string; ValueFrom: unknown }>;
    }>;
    const api = containers.find(container => container.Name === 'identity-api');
    assert.ok(api, `${label}: missing identity-api container`);
    const keys = (api.Secrets ?? []).filter(item => item.Name === 'MFA_SECRET_KEY_B64');
    assert.equal(keys.length, 1, `${label}: Identity has no MFA_SECRET_KEY_B64 secret reference`);
    assert.deepEqual(keys[0]!.ValueFrom, { 'Fn::Join': ['', [{ Ref: 'IdentitySensitiveSecretArn' }, ':mfaSecretKeyB64::']] },
      `${label}: MFA_SECRET_KEY_B64 must come from the mfaSecretKeyB64 field of the Identity sensitive secret`);
    const environment = api.Environment ?? [];
    assert.equal(environment.some(item => item.Name === 'MFA_SECRET_KEY_B64'), false,
      `${label}: MFA_SECRET_KEY_B64 must never be a plaintext environment value`);
    assert.deepEqual(environment.filter(item => item.Name === 'MFA_KEY_VERSION').map(item => item.Value), ['aws-v1'],
      `${label}: Identity must run with MFA_KEY_VERSION aws-v1, not the local-v1 default`);
    for (const container of containers.filter(item => item !== api)) {
      assert.doesNotMatch(JSON.stringify(container), /MFA_SECRET_KEY_B64|mfaSecretKeyB64|MFA_KEY_VERSION/,
        `${label}: only the identity-api container may receive the MFA key`);
    }
    for (const [, task] of tasks.filter(([id]) => id !== identity[0])) {
      assert.doesNotMatch(JSON.stringify(task), /MFA_SECRET_KEY_B64|mfaSecretKeyB64|MFA_KEY_VERSION/,
        `${label}: only the Identity task definition may receive the MFA key`);
    }
    const executionPolicy = resources(template, 'AWS::IAM::Policy')
      .find(([id]) => id.startsWith('IdentityApiExecutionRoleDefaultPolicy'));
    assert.ok(executionPolicy, `${label}: missing Identity execution-role policy`);
    assert.match(JSON.stringify(executionPolicy[1].Properties), /"Ref":"IdentitySensitiveSecretArn"/,
      `${label}: the Identity execution role must be able to resolve the sensitive secret`);
    assert.match(String(template.Parameters.IdentitySensitiveSecretArn!.Description), /mfaSecretKeyB64/,
      `${label}: the IdentitySensitiveSecretArn description must name the mfaSecretKeyB64 field`);
  }
});

test('the IdentitySensitiveSecretArn description names exactly the fields the Identity task reads from that secret', () => {
  const developmentRegional = Template.fromStack(new HidRegionalStack(new App(), 'DevelopmentSensitiveFieldsTest', {
    configuration: environmentConfig('development'),
  })).toJSON() as typeof regional;
  const profiles: Array<[string, typeof regional]> = [
    ['production', regional], ['development', developmentRegional], ['staging economy', stagingRegional],
    ['staging fidelity', fidelityRegional], ['staging sleep', sleepRegional], ['staging QoreID', qoreIdStagingRegional],
  ];
  const fieldsRead = new Map(profiles.map(([label, template]) => {
    const fields = properties(template, 'AWS::ECS::TaskDefinition')
      .flatMap(task => task.ContainerDefinitions as Array<{ Secrets?: Array<{ ValueFrom: unknown }> }>)
      .flatMap(container => container.Secrets ?? [])
      .map(secret => (secret.ValueFrom as { 'Fn::Join'?: [string, unknown[]] })['Fn::Join']?.[1])
      .filter((parts): parts is unknown[] => Array.isArray(parts)
        && JSON.stringify(parts[0]) === JSON.stringify({ Ref: 'IdentitySensitiveSecretArn' }))
      .map(parts => /^:([A-Za-z0-9]+)::$/.exec(String(parts[1]))?.[1] ?? `unparsed ${JSON.stringify(parts)}`);
    return [label, new Set(fields)] as const;
  }));
  const everyField = new Set([...fieldsRead.values()].flatMap(fields => [...fields]));
  for (const field of ['ninLookupHmacKeyB64', 'ninEncryptionKeyB64', 'otpHmacKeyB64', 'contactLookupHmacKeyB64',
    'turnstileSecretKey', 'googleOidcClientIds', 'mfaSecretKeyB64']) {
    assert.ok(everyField.has(field), `some profile must read ${field} from the Identity sensitive secret`);
  }
  for (const [label, template] of profiles) {
    const description = String(template.Parameters.IdentitySensitiveSecretArn!.Description);
    const read = fieldsRead.get(label)!;
    assert.ok(description.length <= 4000, `${label}: a CloudFormation parameter description is at most 4000 characters`);
    for (const field of everyField) {
      assert.equal(new RegExp(`\\b${field}\\b`).test(description), read.has(field), read.has(field)
        ? `${label}: the IdentitySensitiveSecretArn description must name ${field}, which the Identity task reads`
        : `${label}: the IdentitySensitiveSecretArn description must not name ${field}, which the Identity task does not read`);
    }
    if (read.has('ninLookupHmacKeyB64')) {
      assert.doesNotMatch(description, /deferred/i, `${label}: the description must not call NIN deferred while Identity reads the NIN keys`);
    }
    assert.match(description, /Identity tasks cannot start until every field exists/,
      `${label}: the description must state that a missing field stops every Identity task`);
  }
});

test('staging email OTP injects only its SES sender while ordinary delivery retains Novu', () => {
  function container(template: typeof regional, name: string) {
    const task = properties(template, 'AWS::ECS::TaskDefinition')
      .find(item => JSON.stringify(item.Family).includes(name));
    assert.ok(task, `missing ${name}`);
    return (task.ContainerDefinitions as Array<{
      Name: string;
      Environment: Array<{ Name: string; Value: unknown }>;
      Secrets: Array<{ Name: string; ValueFrom: unknown }>;
    }>).find(item => item.Name === name)!;
  }
  for (const template of [stagingRegional, fidelityRegional, sleepRegional]) {
    const api = container(template, 'notification-api');
    assert.match(String(template.Parameters.NotificationProviderSecretArn!.Description), /sesFromAddress and novuApiKey/);
    assert.doesNotMatch(String(template.Parameters.NotificationProviderSecretArn!.Description), /Termii|Meta|Brevo/);
    const environment = Object.fromEntries(api.Environment.map(item => [item.Name, item.Value]));
    assert.equal(environment.NODE_ENV, 'production');
    assert.equal(environment.HID_DEPLOYMENT_ENV, 'staging');
    assert.equal(environment.NOTIFICATION_PROVIDER_MODE, 'live');
    assert.equal(environment.NOTIFICATION_WORKLOAD_IDENTITY_MODE, 'jwt');
    assert.equal(environment.NOTIFICATION_DELIVERY_PROFILE, 'email-only');
    assert.deepEqual(api.Secrets.map(item => item.Name), ['SES_FROM_ADDRESS']);
    assert.match(JSON.stringify(api.Secrets[0]!.ValueFrom), /sesFromAddress/);
    assert.doesNotMatch(JSON.stringify(api), /TERMII|META_|BREVO|termiiApiKey|metaAccessToken|brevoApiKey/);
    const worker = container(template, 'notification-worker');
    const workerEnvironment = Object.fromEntries(worker.Environment.map(item => [item.Name, item.Value]));
    assert.equal(workerEnvironment.NOVU_MODE, 'live');
    assert.ok(worker.Secrets.some(item => item.Name === 'NOVU_API_KEY'));
  }
  const productionApi = container(regional, 'notification-api');
  const productionEnvironment = Object.fromEntries(productionApi.Environment.map(item => [item.Name, item.Value]));
  assert.equal(productionEnvironment.NOTIFICATION_DELIVERY_PROFILE, 'otp-email-sms');
  assert.equal(productionEnvironment.HID_DEPLOYMENT_ENV, 'production');
  for (const name of ['SES_FROM_ADDRESS', 'TERMII_API_KEY']) {
    assert.ok(productionApi.Secrets.some(item => item.Name === name));
  }
  for (const name of ['META_ACCESS_TOKEN', 'BREVO_API_KEY']) {
    assert.equal(productionApi.Secrets.some(item => item.Name === name), false);
  }
});

test('production takes its workload issuer from the stack; development keeps the external inputs', () => {
  for (const name of workloadParameters) {
    assert.equal(regional.Parameters[name], undefined, `production must not take ${name}`);
    assert.equal(stagingRegional.Parameters[name], undefined, `staging must not take ${name}`);
    assert.ok(developmentRegional.Parameters[name], `development must still require ${name}`);
    assert.equal(developmentRegional.Parameters[name]!.Default, undefined);
  }
});

test('monitoring is focused on RDS, task health, the enabled modules, the issuer, OTP delivery and event delivery', () => {
  // 4 RDS, 5 running-task, 8 request-signal (gateway, Identity, EHR and
  // Notification targets), 3 event delivery, 5 log-volume, 4 issuer, 1 token
  // renewal and 1 OTP delivery alarm; the disabled modules (Lab, Pharmacy,
  // OCR, Outreach, notification worker) have none.
  assert.equal(properties(regional, 'AWS::CloudWatch::Alarm').length, 31);
  // 13 OCR and event-delivery filters, 2 token-renewal filters (Identity and
  // EHR, the enabled token tasks) and 1 OTP outcome filter.
  assert.equal(properties(regional, 'AWS::Logs::MetricFilter').length, 16);
  assert.doesNotMatch(JSON.stringify(properties(regional, 'AWS::CloudWatch::Alarm')), /patient|\bnin\b|document_text/i);
});

test('sleep removes application ingress while retaining protected data and stable workload identity', () => {
  assert.equal(resources(sleepRegional, 'AWS::EC2::NatGateway').length, 0);
  assert.equal(resources(sleepRegional, 'AWS::EC2::VPCEndpoint')
    .filter(([, item]) => String(item.Properties?.VpcEndpointType) === 'Interface').length, 0);
  assert.equal(resources(sleepRegional, 'AWS::ElasticLoadBalancingV2::LoadBalancer').length, 0);
  assert.equal(resources(sleepRegional, 'AWS::WAFv2::WebACL').length, 0);
  assert.equal(resources(sleepRegional, 'AWS::ApplicationAutoScaling::ScalableTarget').length, 0);
  assert.equal(resources(sleepRegional, 'AWS::Scheduler::Schedule').length, 1);
  assert.equal(Object.keys(sleepRegional.Parameters).some((name) => name.endsWith('DesiredCount')), false);
  for (const service of properties(sleepRegional, 'AWS::ECS::Service')) assert.equal(service.DesiredCount, 0);
  const [database] = properties(sleepRegional, 'AWS::RDS::DBInstance');
  assert.equal(database!.DeletionProtection, true);
  assert.equal(database!.MultiAZ, false);
  assert.equal(database!.BackupRetentionPeriod, 14);
  assert.equal(resources(sleepRegional, 'AWS::S3::Bucket').length, 1);
  const signingKeys = resources(sleepRegional, 'AWS::KMS::Key')
    .filter(([, key]) => key.Properties?.KeyUsage === 'SIGN_VERIFY');
  assert.equal(signingKeys.length, 1);
  assert.equal(signingKeys[0]![1].Properties?.KeySpec, 'ECC_NIST_P256');
  assert.equal(signingKeys[0]![1].DeletionPolicy, 'Retain');
  assert.equal(signingKeys[0]![1].UpdateReplacePolicy, 'Retain');
  assert.deepEqual(signingKeys.map(([id]) => id), ['StagingWorkloadIdentitySigningKey53DFD52F'],
    'the retained staging signing key keeps its logical ID');
  for (const template of [stagingRegional, fidelityRegional, sleepRegional]) {
    assert.equal(resources(template, 'AWS::KMS::Key').length, 4);
    assert.deepEqual(resources(template, 'AWS::KMS::Key')
      .filter(([, key]) => key.Properties?.KeyUsage === 'SIGN_VERIFY')
      .map(([id]) => id), signingKeys.map(([id]) => id),
    'sleep and wake must preserve the signing key logical identity');
    assert.equal(resources(template, 'AWS::ApiGateway::RestApi').length, 1);
    assert.equal(resources(template, 'AWS::Lambda::Function').length, 1);
  }
  assert.equal(resources(regional, 'AWS::KMS::Key').length, 4);
  assert.equal(resources(developmentRegional, 'AWS::KMS::Key').length, 3);
});

test('economy and fidelity are explicit, bounded staging modes', () => {
  assert.equal(resources(stagingRegional, 'AWS::EC2::NatGateway').length, 1);
  assert.equal(resources(stagingRegional, 'AWS::ElasticLoadBalancingV2::LoadBalancer').length, 2);
  assert.equal(resources(stagingRegional, 'AWS::EC2::VPCEndpoint')
    .filter(([, item]) => String(item.Properties?.VpcEndpointType) === 'Interface').length, 7);
  assert.equal(stagingRegional.Parameters.GatewayDesiredCount!.Default, 1);
  assert.equal(stagingRegional.Parameters.OcrWorkerDesiredCount!.Default, 0);
  assert.equal(properties(stagingRegional, 'AWS::RDS::DBInstance')[0]!.MultiAZ, false);

  assert.equal(resources(fidelityRegional, 'AWS::EC2::NatGateway').length, 2);
  assert.equal(resources(fidelityRegional, 'AWS::EC2::VPCEndpoint')
    .filter(([, item]) => String(item.Properties?.VpcEndpointType) === 'Interface').length, 8);
  assert.equal(fidelityRegional.Parameters.GatewayDesiredCount!.Default, 2);
  // OCR is outside the default enabled module set, so its worker stays at 0.
  assert.equal(fidelityRegional.Parameters.OcrWorkerDesiredCount!.Default, 0);
  assert.equal(fidelityRegional.Parameters.OcrWorkerDesiredCount!.MaxValue, 0);
  assert.equal(properties(fidelityRegional, 'AWS::RDS::DBInstance')[0]!.MultiAZ, true);
});

test('live staging can bootstrap restricted tasks through ECR, Logs, and secret endpoints', () => {
  for (const template of [stagingRegional, fidelityRegional]) {
    const endpoints = properties(template, 'AWS::EC2::VPCEndpoint')
      .filter((endpoint) => endpoint.VpcEndpointType === 'Interface');
    for (const service of ['ecr.api', 'ecr.dkr', 'logs', 'secretsmanager']) {
      assert.ok(endpoints.some((endpoint) => JSON.stringify(endpoint.ServiceName).includes(service)),
        `missing staging bootstrap endpoint ${service}`);
    }
    for (const name of ['Gateway', 'OcrWorker', 'EventDispatcher', 'Migration']) {
      const [groupId] = resources(template, 'AWS::EC2::SecurityGroup')
        .find(([id]) => id.startsWith(`${name}SecurityGroup`))!;
      const outbound = properties(template, 'AWS::EC2::SecurityGroupEgress')
        .filter((rule) => JSON.stringify(rule.GroupId).includes(groupId));
      assert.ok(outbound.some((rule) => rule.FromPort === 443 && rule.ToPort === 443
        && JSON.stringify(rule.DestinationSecurityGroupId ?? '').includes('AwsEndpointSecurityGroup')));
      assert.ok(outbound.some((rule) => rule.FromPort === 443 && rule.ToPort === 443
        && JSON.stringify(rule.DestinationPrefixListId ?? '').includes('S3PrefixListId')));
      for (const rule of outbound) {
        assert.equal(rule.CidrIp, undefined, `${name} must not gain public egress`);
        assert.equal(rule.CidrIpv6, undefined, `${name} must not gain public IPv6 egress`);
      }
      if (name === 'Migration') {
        assert.equal(outbound.length, 3, 'migration may reach only RDS, AWS endpoints, and S3');
        assert.ok(outbound.some((rule) => rule.FromPort === 5432 && rule.ToPort === 5432
          && JSON.stringify(rule.DestinationSecurityGroupId ?? '').includes('DatabaseSecurityGroup')));
      }
    }
  }
});

test('sleep keeps migration HTTPS paths closed', () => {
  const [groupId] = resources(sleepRegional, 'AWS::EC2::SecurityGroup')
    .find(([id]) => id.startsWith('MigrationSecurityGroup'))!;
  const outbound = properties(sleepRegional, 'AWS::EC2::SecurityGroupEgress')
    .filter((rule) => JSON.stringify(rule.GroupId).includes(groupId));
  assert.equal(outbound.length, 1);
  assert.equal(outbound[0]!.FromPort, 5432);
  assert.match(JSON.stringify(outbound[0]!.DestinationSecurityGroupId), /DatabaseSecurityGroup/);
});

test('staging HeadBucket access uses ListBucket only for the two exact document-bucket roles', () => {
  for (const template of [stagingRegional, fidelityRegional, sleepRegional]) {
    const policies = properties(template, 'AWS::IAM::Policy');
    const documentPolicies = policies.filter((policy) => JSON.stringify(policy).includes('s3:ListBucket'));
    assert.equal(documentPolicies.length, 2);
    for (const policy of documentPolicies) {
      assert.match(JSON.stringify(policy.Roles), /EhrApiTaskRole|OcrWorkerTaskRole/);
      const document = policy.PolicyDocument as { readonly Statement: Array<Record<string, unknown>> };
      for (const statement of document.Statement.filter((entry) => JSON.stringify(entry.Action).includes('s3:ListBucket'))) {
        assert.deepEqual(statement.Resource, {
          'Fn::GetAtt': [resources(template, 'AWS::S3::Bucket')[0]![0], 'Arn'],
        });
      }
    }
    assert.doesNotMatch(JSON.stringify(policies), /s3:HeadBucket/);
  }
});

test('staging public CA input and native templates respect CloudFormation quotas', () => {
  for (const template of [stagingRegional, fidelityRegional, sleepRegional]) {
    assert.equal(template.Parameters.RdsCaBundleBase64!.MaxLength, 4096);
    assert.equal(template.Parameters.RdsCaBundleBase64!.Default, undefined);
    assert.match(String(template.Parameters.RdsCaBundleBase64!.Description), /matching.*staging region and RDS CA/);
    assert.ok(Object.keys(template.Parameters).length <= 200);
    assert.ok(Object.keys(template.Resources).length <= 500);
    assert.ok(Buffer.byteLength(JSON.stringify(template)) <= 1024 * 1024);
  }
  assert.equal(regional.Parameters.RdsCaBundleBase64!.MaxLength, undefined,
    'this staging repair must preserve the approved production parameter');
});

test('production and development templates respect CloudFormation quotas', () => {
  for (const template of [regional, developmentRegional]) {
    assert.ok(Object.keys(template.Parameters).length <= 200);
    assert.ok(Object.keys(template.Resources).length <= 500);
    assert.ok(Buffer.byteLength(JSON.stringify(template)) <= 1024 * 1024);
  }
});

test('every live workload has typed resource and autoscaling boundaries', () => {
  // Every workload keeps a scaling target; only the five enabled production
  // workloads have scaling policies (D17): gateway, Identity, EHR,
  // Notification API and the event dispatcher.
  assert.equal(resources(regional, 'AWS::ApplicationAutoScaling::ScalableTarget').length, workloadNames.length);
  assert.equal(resources(regional, 'AWS::ApplicationAutoScaling::ScalingPolicy').length, 15);
  for (const name of workloadNames) {
    const scale = workloadScale('production', name);
    assert.ok(scale.minimumLiveTasks >= 2);
    assert.ok(scale.normalMaxTasks < scale.reviewedEmergencyMaxTasks);
  }
});

test('database connection budgets fail synthesis policy before unsafe ceilings ship', () => {
  assert.equal(databaseConnectionDemand('production'), 312);
  assert.equal(databaseConnectionDemand('production', true), 624);
  assert.doesNotThrow(() => validateDatabaseConnectionBudget('production', 400, 650));
  assert.throws(() => validateDatabaseConnectionBudget('production', 311, 650), /normal scaling requires 312/);
  assert.throws(() => validateDatabaseConnectionBudget('production', 400, 623), /reviewed-emergency scaling requires 624/);
});

test('cost inventory is deterministic and never labels sleep zero-cost', () => {
  const sleep = costInventory(sleepConfiguration);
  assert.deepEqual({ nat: sleep.natGateways, endpoints: sleep.interfaceEndpointAzAttachments,
    publicAlbs: sleep.publicAlbs, internalAlbs: sleep.internalAlbs,
    publicIpv4: sleep.estimatedPublicIpv4Count },
  { nat: 0, endpoints: 0, publicAlbs: 0, internalAlbs: 0, publicIpv4: 0 });
  assert.equal(sleep.rds.expectedComputeState, 'stopped-by-operation');
  assert.equal(sleep.s3Buckets, 1);
  assert.equal(sleep.kmsKeys, 4);
  for (const mode of ['sleep', 'economy', 'fidelity'] as const) {
    assert.equal(costInventory(environmentConfig('staging', mode)).kmsKeys, 4,
      `${mode} must account for the retained workload signing key`);
  }
  assert.equal(costInventory(environmentConfig('production')).kmsKeys, 4,
    'production must account for its workload signing key');
  assert.equal(costInventory(environmentConfig('development')).kmsKeys, 3);
  // The public API web ACL, plus the workload issuer's allowlist web ACL
  // wherever an issuer runs behind NAT (D3); sleep and development have none.
  assert.equal(costInventory(environmentConfig('production')).wafs, 2);
  assert.equal(costInventory(environmentConfig('staging', 'economy')).wafs, 2);
  assert.equal(costInventory(environmentConfig('staging', 'fidelity')).wafs, 2);
  assert.equal(costInventory(environmentConfig('staging', 'sleep')).wafs, 0);
  assert.equal(costInventory(environmentConfig('development')).wafs, 1);
});

test('optional billing governance notifies without creating cost actions', () => {
  const costApp = new App();
  const cost = Template.fromStack(new HidCostGovernanceStack(costApp, 'CostTest')).toJSON() as typeof regional;
  assert.equal(resources(cost, 'AWS::Budgets::Budget').length, 3);
  assert.equal(resources(cost, 'AWS::Budgets::BudgetsAction').length, 0);
  assert.equal(resources(cost, 'AWS::CE::AnomalyMonitor').length, 2);
  assert.equal(resources(cost, 'AWS::CE::AnomalySubscription').length, 1);
  const text = JSON.stringify(cost);
  assert.match(text, /IncludeCredit/);
  assert.match(text, /CostNotificationEmail/);
  assert.doesNotMatch(text, /StopInstances|UpdateService|ExecutePolicy|iam:Attach/);
});


test('staging emergency notifications use the existing encrypted ordinary event route', () => {
  for (const template of [stagingRegional, fidelityRegional, sleepRegional]) {
    const rules = properties(template, 'AWS::Events::Rule');
    assert.equal(rules.length, 1);
    const pattern = rules[0]!.EventPattern as { readonly 'detail-type': readonly string[] };
    assert.equal(pattern['detail-type'].filter(type => type === 'EmergencyAccessActivated.v1').length, 1);
    assert.equal(pattern['detail-type'].some(type => /otp|passwordreset/i.test(type)), false);
  }
  const productionPattern = properties(regional, 'AWS::Events::Rule')[0]!.EventPattern as { readonly 'detail-type': readonly string[] };
  assert.equal(productionPattern['detail-type'].includes('EmergencyAccessActivated.v1'), false);
});

// IP-1, GW-DNS, MOD-1: the gateway takes the client address from the
// Worker's X-Real-IP only on connections from the VPC (the public ALB),
// requires it in staging and production, resolves its Cloud Map upstreams per
// request through the VPC resolver, and routes only the enabled modules.
function gatewayEnvironment(template: typeof regional): Record<string, unknown> {
  const task = properties(template, 'AWS::ECS::TaskDefinition')
    .find(item => JSON.stringify(item.Family).endsWith('-gateway"'));
  assert.ok(task, 'missing gateway task definition');
  const container = (task.ContainerDefinitions as Array<{ Name: string; Environment: Array<{ Name: string; Value: unknown }> }>)
    .find(item => item.Name === 'gateway');
  assert.ok(container, 'missing gateway container');
  return Object.fromEntries(container.Environment.map(item => [item.Name, item.Value]));
}

test('the gateway trusts the client address only from the VPC, re-resolves upstreams and routes only the launch modules', () => {
  const developmentRegional = Template.fromStack(new HidRegionalStack(new App(), 'DevelopmentGatewayTest', {
    configuration: environmentConfig('development'),
  })).toJSON() as typeof regional;
  for (const [label, template, name, vpcCidr, resolver, required] of [
    ['production', regional, 'production', '10.40.0.0/16', '10.40.0.2', 'true'],
    ['staging economy', stagingRegional, 'staging', '10.30.0.0/16', '10.30.0.2', 'true'],
    ['staging fidelity', fidelityRegional, 'staging', '10.30.0.0/16', '10.30.0.2', 'true'],
    ['staging sleep', sleepRegional, 'staging', '10.30.0.0/16', '10.30.0.2', 'true'],
    ['development', developmentRegional, 'development', '10.20.0.0/16', '10.20.0.2', 'false'],
  ] as const) {
    const environment = gatewayEnvironment(template);
    assert.equal(environment.VPC_CIDR, vpcCidr, `${label}: the realip trust range is the VPC`);
    assert.equal(environment.GATEWAY_DNS_RESOLVER, resolver, `${label}: the Amazon-provided VPC resolver`);
    assert.equal(environment.HID_REQUIRE_CLIENT_IP, required, `${label}: client address requirement`);
    assert.equal(environment.HID_ENABLED_API_ROUTES, 'identity,ehr', `${label}: launch routes only by default`);
    const namespace = `services.${name}.hid`;
    assert.deepEqual(Object.fromEntries(Object.entries(environment).filter(([key]) => key.endsWith('_API_UPSTREAM'))), {
      IDENTITY_API_UPSTREAM: `http://identity-api.${namespace}:3001`, EHR_API_UPSTREAM: `http://ehr-api.${namespace}:3002`,
      LAB_API_UPSTREAM: `http://lab-api.${namespace}:3003`, PHARMACY_API_UPSTREAM: `http://pharmacy-api.${namespace}:3004`,
      OCR_API_UPSTREAM: `http://ocr-api.${namespace}:3005`, OUTREACH_API_UPSTREAM: `http://outreach-api.${namespace}:3006`,
    }, `${label}: upstreams stay Cloud Map names`);
    // The backends trust exactly the range the gateway takes the header from.
    const identity = properties(template, 'AWS::ECS::TaskDefinition')
      .find(item => JSON.stringify(item.Family).endsWith('-identity-api"'))!;
    const api = (identity.ContainerDefinitions as Array<{ Name: string; Environment: Array<{ Name: string; Value: unknown }> }>)
      .find(item => item.Name === 'identity-api')!;
    assert.equal(api.Environment.find(item => item.Name === 'TRUST_PROXY_CIDRS')?.Value, vpcCidr, label);
  }
  const optedIn = Template.fromStack(new HidRegionalStack(new App(), 'StagingModulesGatewayTest', {
    configuration: environmentConfig('staging', 'economy', undefined, 'identity,ehr,outreach,lab'),
  })).toJSON() as typeof regional;
  assert.equal(gatewayEnvironment(optedIn).HID_ENABLED_API_ROUTES, 'identity,ehr,lab,outreach');
});

test('the enabled API routes are an explicit, validated synth input that production keeps at the launch set', () => {
  assert.deepEqual(environmentConfig('production').enabledApiRoutes, ['identity', 'ehr']);
  assert.deepEqual(environmentConfig('staging', 'economy').enabledApiRoutes, ['identity', 'ehr']);
  assert.deepEqual(environmentConfig('staging', 'fidelity', undefined, 'identity, ehr, pharmacy').enabledApiRoutes,
    ['identity', 'ehr', 'pharmacy']);
  assert.deepEqual(environmentConfig('development', undefined, undefined, 'ocr,identity,ehr').enabledApiRoutes,
    ['identity', 'ehr', 'ocr']);
  assert.deepEqual(environmentConfig('production', undefined, undefined, 'identity,ehr').enabledApiRoutes, ['identity', 'ehr']);
  assert.throws(() => environmentConfig('production', undefined, undefined, 'identity,ehr,lab'),
    /HID_ENABLED_API_ROUTES.*production/);
  for (const value of ['ehr', 'identity', '', 'identity,ehr,billing', 'identity,ehr,ehr', 'identity,ehr,LAB', 'identity;ehr']) {
    assert.throws(() => environmentConfig('staging', 'economy', undefined, value), /HID_ENABLED_API_ROUTES/,
      `HID_ENABLED_API_ROUTES=${JSON.stringify(value)} must be refused`);
  }
});

test('the gateway resolver is the Amazon-provided DNS server of the VPC', () => {
  assert.equal(vpcDnsResolver('10.40.0.0/16'), '10.40.0.2');
  assert.equal(vpcDnsResolver('10.0.128.0/20'), '10.0.128.2');
  assert.equal(vpcDnsResolver('172.31.255.0/24'), '172.31.255.2');
  for (const value of ['10.40.0.0', '10.40.0.0/8', '10.40.0.0/29', '300.1.0.0/16', 'fd00::/56']) {
    assert.throws(() => vpcDnsResolver(value), /VPC CIDR/, value);
  }
});

// Production launch configuration (INFRA-COUNT, D4, NOTIF-PROD, CFG-PROD, I1).
const pascalName = (name: string) => name.split('-').map(part => `${part[0]!.toUpperCase()}${part.slice(1)}`).join('');
const disabledAtLaunch = ['lab-api', 'pharmacy-api', 'ocr-api', 'ocr-worker', 'outreach-api', 'notification-worker'];
const productionTopic = { 'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, ':sns:', { Ref: 'AWS::Region' }, ':',
  { Ref: 'AWS::AccountId' }, ':hid-production-operational-alerts']] };
const stagingTopicArn = 'arn:aws:sns:eu-west-1:000000000000:hid-staging-operational-alerts';

function alarmsById(template: typeof regional): Map<string, Record<string, unknown>> {
  return new Map(resources(template, 'AWS::CloudWatch::Alarm').map(([id, alarm]) => [id, alarm.Properties ?? {}]));
}

function containerOf(template: typeof regional, name: string) {
  const task = properties(template, 'AWS::ECS::TaskDefinition').find(item => JSON.stringify(item.Family).endsWith(`-${name}"`));
  assert.ok(task, `missing ${name} task definition`);
  const container = (task.ContainerDefinitions as Array<{
    Name: string; Environment?: Array<{ Name: string; Value: unknown }>; Secrets?: Array<{ Name: string; ValueFrom: unknown }>;
  }>).find(item => item.Name === name);
  assert.ok(container, `missing ${name} container`);
  return { environment: Object.fromEntries((container.Environment ?? []).map(item => [item.Name, item.Value])),
    secrets: container.Secrets ?? [] };
}

test('every production task count defaults to zero and keeps the recommended count in its description', () => {
  for (const name of workloadNames) {
    const parameter = regional.Parameters[`${pascalName(name)}DesiredCount`];
    assert.ok(parameter, `missing ${name} desired count`);
    assert.equal(parameter.Default, 0, `production ${name} must default to zero tasks (ADR-032, I6)`);
    assert.equal(parameter.MinValue, 0);
    const scale = workloadScale('production', name);
    assert.match(String(parameter.Description), new RegExp(`recommended ${scale.recommendedTasks}\\b`),
      `${name}: the description keeps the recommended count`);
    if (disabledAtLaunch.includes(name)) {
      assert.equal(parameter.MaxValue, 0, `${name} is outside the launch module set and cannot be scaled up`);
      assert.match(String(parameter.Description), /launch module set/);
    } else {
      assert.equal(parameter.MaxValue, scale.normalMaxTasks);
      assert.match(String(parameter.Description), /reviewed parameter file/);
    }
  }
  // The autoscaling floor follows the desired count, so nothing runs until the
  // reviewed parameter file raises it. A disabled module's target is pinned at
  // 0..0 and has no scaling policy, so not even a queue backlog can start it.
  const targets = resources(regional, 'AWS::ApplicationAutoScaling::ScalableTarget');
  const policies = properties(regional, 'AWS::ApplicationAutoScaling::ScalingPolicy');
  for (const name of workloadNames) {
    const id = pascalName(name);
    const [targetId, target] = targets.find(([, item]) =>
      JSON.stringify(item.Properties?.MinCapacity) === JSON.stringify({ Ref: `${id}DesiredCount` }))!;
    assert.deepEqual(target.Properties?.MaxCapacity, { Ref: `${id}ScalingCeiling` });
    const ceiling = regional.Parameters[`${id}ScalingCeiling`]!;
    const scaled = policies.filter(policy => JSON.stringify(policy.ScalingTargetId).includes(targetId)).length;
    if (disabledAtLaunch.includes(name)) {
      assert.deepEqual([ceiling.Default, ceiling.MinValue, ceiling.MaxValue], [0, 0, 0], `${name} ceiling is pinned at 0`);
      assert.equal(scaled, 0, `${name} must have no scaling policy`);
    } else {
      assert.ok(scaled >= 2, `${name} keeps its scaling policies`);
    }
  }
  // Staging keeps its profile defaults for enabled workloads.
  assert.equal(stagingRegional.Parameters.IdentityApiDesiredCount!.Default, 1);
  assert.equal(fidelityRegional.Parameters.IdentityApiDesiredCount!.Default, 2);
  assert.equal(stagingRegional.Parameters.LabApiDesiredCount!.MaxValue, 0, 'Lab is not routed by default');
});

test('the operational alarm topic is an exact, validated input that production requires', () => {
  assert.throws(() => new HidRegionalStack(new App(), 'NoTopicProduction', { configuration: environmentConfig('production') }),
    /HID_OPERATIONAL_ALARM_TOPIC_ARN/);
  const config = (value: string, name: 'production' | 'staging' = 'production') => environmentConfig(
    name, name === 'staging' ? 'economy' : undefined, undefined, undefined, { operationalAlarmTopicArn: value });
  assert.equal(config(productionTopicArn).operationalAlarmTopicArn, productionTopicArn);
  assert.equal(config('arn:aws-us-gov:sns:us-gov-west-1:123456789012:hid-production-operational-alerts')
    .operationalAlarmTopicArn, 'arn:aws-us-gov:sns:us-gov-west-1:123456789012:hid-production-operational-alerts');
  assert.equal(config(stagingTopicArn, 'staging').operationalAlarmTopicArn, stagingTopicArn);
  assert.equal(environmentConfig('staging', 'economy').operationalAlarmTopicArn, undefined);
  for (const value of [
    stagingTopicArn,
    'arn:aws:sns:eu-west-1:000000000000:hid-production-release-trust-alerts',
    'arn:aws:sns:eu-west-1:000000000000:hid-production-operational-alerts-copy',
    'arn:aws:sqs:eu-west-1:000000000000:hid-production-operational-alerts',
    'arn:aws:sns:eu-west-1:00000000000:hid-production-operational-alerts',
    'arn:aws:sns:*:000000000000:hid-production-operational-alerts',
    'arn:aws:sns:eu-west-1:000000000000:hid-production-operational-alerts\n',
    ' arn:aws:sns:eu-west-1:000000000000:hid-production-operational-alerts',
    'arn:other:sns:eu-west-1:000000000000:hid-production-operational-alerts',
    '${Token[TOKEN.1]}',
    '',
  ]) {
    assert.throws(() => config(value), /HID_OPERATIONAL_ALARM_TOPIC_ARN/, JSON.stringify(value));
  }
  // A stack bound to an account and region accepts only a topic in that
  // account and region.
  assert.throws(() => new HidRegionalStack(new App(), 'WrongAccount', { configuration,
    env: { account: '111111111111', region: 'eu-west-1' } }), /operational alarm topic.*account/i);
  assert.throws(() => new HidRegionalStack(new App(), 'WrongRegion', { configuration,
    env: { account: '000000000000', region: 'eu-west-2' } }), /operational alarm topic.*region/i);
  assert.doesNotThrow(() => new HidRegionalStack(new App(), 'BoundTopic', { configuration,
    env: { account: '000000000000', region: 'eu-west-1' } }));
});

test('every production alarm notifies the operational topic on alarm and on recovery', () => {
  const alarms = alarmsById(regional);
  assert.ok(alarms.size > 0);
  for (const [id, alarm] of alarms) {
    assert.deepEqual(alarm.AlarmActions, [productionTopic], `${id} must notify the operational topic`);
    assert.deepEqual(alarm.OKActions, [productionTopic], `${id} must notify the operational topic on recovery`);
  }
  const outputs = (regional as unknown as { Outputs: Record<string, { Value: unknown }> }).Outputs;
  assert.deepEqual(outputs.OperationalAlarmTopicArn?.Value, productionTopic);
  // Staging routes its alarms only when the operator supplies its own topic.
  for (const [, alarm] of alarmsById(stagingRegional)) {
    assert.equal(alarm.AlarmActions, undefined);
    assert.equal(alarm.OKActions, undefined);
  }
  const stagingWithTopic = Template.fromStack(new HidRegionalStack(new App(), 'StagingTopicTest', {
    configuration: environmentConfig('staging', 'economy', undefined, undefined, { operationalAlarmTopicArn: stagingTopicArn }),
  })).toJSON() as typeof regional;
  for (const [id, alarm] of alarmsById(stagingWithTopic)) {
    assert.equal(JSON.stringify(alarm.AlarmActions).includes('hid-staging-operational-alerts'), true, id);
    assert.equal(JSON.stringify(alarm.OKActions).includes('hid-staging-operational-alerts'), true, id);
  }
});

test('the workload issuer, token renewal and OTP delivery each raise an alarm', () => {
  for (const template of [regional, stagingRegional]) {
    const alarms = [...alarmsById(template).values()];
    const metric = (namespace: string, name: string) => alarms.filter(alarm => alarm.Namespace === namespace && alarm.MetricName === name);
    for (const name of ['Errors', 'Throttles']) {
      const [alarm] = metric('AWS/Lambda', name);
      assert.ok(alarm, `missing issuer Lambda ${name} alarm`);
      assert.match(JSON.stringify(alarm.Dimensions), /WorkloadIdentityIssuer/);
    }
    for (const name of ['5XXError', '4XXError']) {
      const [alarm] = metric('AWS/ApiGateway', name);
      assert.ok(alarm, `missing issuer API ${name} alarm`);
      const dimensions = alarm.Dimensions as Array<{ Name: string; Value: unknown }>;
      assert.deepEqual(dimensions.map(item => item.Name).sort(), ['ApiName', 'Stage']);
      // A Ref to an API Gateway stage resolves to its stage name.
      const stage = dimensions.find(item => item.Name === 'Stage')!.Value as { Ref: string };
      assert.equal(template.Resources[stage.Ref]?.Type, 'AWS::ApiGateway::Stage');
      assert.equal(template.Resources[stage.Ref]!.Properties!.StageName, template === regional ? 'production' : 'staging');
    }
    assert.equal(metric('HID/WorkloadIdentity', 'TokenRenewalUnavailable').length, 1);
    assert.equal(metric('HID/Notification', 'OtpDefinitiveFailures').length, 1);
  }
  // The agent's stderr line is plain text: the filter matches its exact words.
  const agent = readFileSync(new URL('../../../services/workload-token-agent/src/main.mjs', import.meta.url), 'utf8');
  const line = /process\.stderr\.write\('([^'\\]+)\\n'\)/.exec(agent)?.[1];
  assert.equal(line, 'Workload token renewal unavailable');
  const filters = properties(regional, 'AWS::Logs::MetricFilter');
  const renewal = filters.filter(filter => JSON.stringify(filter.MetricTransformations).includes('TokenRenewalUnavailable'));
  const tokenTasks = workloadNames.filter(name => Object.keys(workloads[name].tokenFiles).length > 0
    && !disabledAtLaunch.includes(name));
  assert.deepEqual(tokenTasks, ['identity-api', 'ehr-api']);
  assert.equal(renewal.length, tokenTasks.length);
  for (const filter of renewal) assert.equal(filter.FilterPattern, `"${line}"`);
  assert.deepEqual(renewal.map(filter => JSON.stringify(filter.LogGroupName)).sort(),
    tokenTasks.map(name => JSON.stringify({ Ref: resources(regional, 'AWS::Logs::LogGroup')
      .find(([, group]) => group.Properties?.LogGroupName === `/hid/production/${name}`)![0] })).sort());
  const otp = filters.filter(filter => JSON.stringify(filter.MetricTransformations).includes('OtpDefinitiveFailures'));
  assert.equal(otp.length, 1);
  assert.equal(otp[0]!.FilterPattern, '{ ($.event = "notification.otp.outcome") && ($.outcome = "definitive_failure") }');
});

test('disabled modules have no running-task or module alarms, and the notification worker is off in production', () => {
  const production = [...alarmsById(regional).keys()];
  for (const prefix of ['OcrWorkerRunningTask', 'NotificationWorkerRunningTask', 'OcrWorkerFailure', 'OcrQueueAge',
    'OcrDrainRate', 'NotificationQueueAge', 'NotificationQueueBacklog', 'NotificationQueueDrain',
    'LabApi', 'PharmacyApi', 'OcrApi', 'OutreachApi', 'OcrWorker', 'NotificationWorker']) {
    assert.equal(production.some(id => id.startsWith(prefix)), false, `production must not alarm on ${prefix}`);
  }
  for (const prefix of ['GatewayRunningTask', 'IdentityApiRunningTask', 'EhrApiRunningTask', 'NotificationApiRunningTask',
    'EventDispatcherRunningTask', 'DispatcherTerminalFailure']) {
    assert.ok(production.some(id => id.startsWith(prefix)), `production must alarm on ${prefix}`);
  }
  // Staging keeps its notification worker; OCR alarms follow the OCR route.
  const staging = [...alarmsById(stagingRegional).keys()];
  assert.ok(staging.some(id => id.startsWith('NotificationWorkerRunningTask')));
  assert.ok(staging.some(id => id.startsWith('NotificationQueueAge')));
  assert.equal(staging.some(id => id.startsWith('OcrWorkerRunningTask')), false);
  const ocrStaging = [...alarmsById(Template.fromStack(new HidRegionalStack(new App(), 'OcrStagingAlarms', {
    configuration: environmentConfig('staging', 'economy', undefined, 'identity,ehr,ocr'),
  })).toJSON() as typeof regional).keys()];
  for (const prefix of ['OcrWorkerRunningTask', 'OcrWorkerFailure', 'OcrQueueAge', 'OcrDrainRate']) {
    assert.ok(ocrStaging.some(id => id.startsWith(prefix)), `an OCR-enabled staging synth alarms on ${prefix}`);
  }
  assert.equal(environmentConfig('production').notificationWorkerEnabled, false);
  assert.equal(environmentConfig('staging', 'economy').notificationWorkerEnabled, true);
  assert.equal(environmentConfig('development').notificationWorkerEnabled, true);
  assert.equal(environmentConfig('staging', 'economy', undefined, undefined,
    { notificationWorkerEnabled: 'false' }).notificationWorkerEnabled, false);
  assert.throws(() => environmentConfig('production', undefined, undefined, undefined, { notificationWorkerEnabled: 'true' }),
    /HID_NOTIFICATION_WORKER_ENABLED/);
  assert.throws(() => environmentConfig('staging', 'economy', undefined, undefined, { notificationWorkerEnabled: 'yes' }),
    /HID_NOTIFICATION_WORKER_ENABLED/);
});

test('production OTP delivery injects only the otp-email-sms provider fields', () => {
  const developmentTemplate = Template.fromStack(new HidRegionalStack(new App(), 'DevelopmentOtpProfile', {
    configuration: environmentConfig('development'),
  })).toJSON() as typeof regional;
  for (const template of [regional, developmentTemplate]) {
    const api = containerOf(template, 'notification-api');
    assert.equal(api.environment.NOTIFICATION_DELIVERY_PROFILE, 'otp-email-sms');
    assert.deepEqual(api.secrets.map(item => item.Name).sort(),
      ['SES_FROM_ADDRESS', 'TERMII_API_KEY', 'TERMII_BASE_URL', 'TERMII_SENDER_ID']);
    assert.deepEqual(api.secrets.map(item => /:([A-Za-z]+)::$/.exec(String((item.ValueFrom as { 'Fn::Join': [string, unknown[]] })
      ['Fn::Join'][1][1]))?.[1]).sort(), ['sesFromAddress', 'termiiApiKey', 'termiiBaseUrl', 'termiiSenderId']);
    assert.doesNotMatch(JSON.stringify(containerOf(template, 'notification-api')), /META_|BREVO|WHATSAPP|meta[A-Z]|brevo[A-Z]/);
  }
  assert.equal(containerOf(regional, 'notification-api').environment.HID_DEPLOYMENT_ENV, 'production');
  const description = String(regional.Parameters.NotificationProviderSecretArn!.Description);
  for (const field of ['sesFromAddress', 'termiiBaseUrl', 'termiiApiKey', 'termiiSenderId']) assert.match(description, new RegExp(field));
  assert.doesNotMatch(description, /Meta|Brevo|novuApiKey|WhatsApp/);
  // The disabled notification worker reads nothing from the provider secret.
  assert.equal(containerOf(regional, 'notification-worker').secrets.some(item => item.Name === 'NOVU_API_KEY'), false);
  assert.ok(containerOf(stagingRegional, 'notification-worker').secrets.some(item => item.Name === 'NOVU_API_KEY'));
});

test('NIN-only enrollment and the NIN holder routes are explicit synth inputs that default to false (ADR-062)', () => {
  const productionTopic = { operationalAlarmTopicArn: 'arn:aws:sns:eu-west-1:000000000000:hid-production-operational-alerts' };
  const production = environmentConfig('production');
  assert.deepEqual([production.qoreIdNinOnlyEnrollmentEnabled, production.ninHolderSmsEnabled,
    production.assistedRegistrationEnabled, production.qoreIdPatientSelfNinBindingEnabled], [false, false, false, false]);
  const flags = ['QOREID_NIN_ONLY_ENROLLMENT_ENABLED', 'NIN_HOLDER_SMS_ENABLED', 'ASSISTED_REGISTRATION_ENABLED',
    'QOREID_PATIENT_SELF_NIN_BINDING_ENABLED'];
  for (const template of [regional, stagingRegional]) {
    for (const flag of flags) assert.equal(containerOf(template, 'identity-api').environment[flag], 'false', flag);
  }
  // NIN-only enrollment needs QoreID and a route to prove that a person holds the NIN.
  assert.throws(() => environmentConfig('staging', 'economy', undefined, undefined,
    { qoreIdNinOnlyEnrollmentEnabled: 'true', assistedRegistrationEnabled: 'true' }),
  /HID_QOREID_NIN_ONLY_ENROLLMENT_ENABLED.*HID_QOREID_ENABLED/);
  assert.throws(() => environmentConfig('staging', 'economy', 'true', undefined, { qoreIdNinOnlyEnrollmentEnabled: 'true' }),
    /requires HID_NIN_HOLDER_SMS_ENABLED=true or HID_ASSISTED_REGISTRATION_ENABLED=true/);
  for (const [input, value] of [['qoreIdNinOnlyEnrollmentEnabled', 'yes'], ['ninHolderSmsEnabled', 'on'],
    ['assistedRegistrationEnabled', '1'], ['qoreIdPatientSelfNinBindingEnabled', 'TRUE']] as const) {
    assert.throws(() => environmentConfig('staging', 'economy', 'true', undefined, { [input]: value }), /must be true or false/);
  }
  // Staging's notification-api sends email only: no holder SMS there.
  assert.throws(() => environmentConfig('staging', 'economy', 'true', undefined, { ninHolderSmsEnabled: 'true' }),
    /HID_NIN_HOLDER_SMS_ENABLED=true is refused on staging/);
  // Production: the blanket NIN-only refusal is replaced by the route rules.
  assert.throws(() => environmentConfig('production', undefined, 'true', undefined,
    { ...productionTopic, qoreIdNinOnlyEnrollmentEnabled: 'true', ninHolderSmsEnabled: 'true' }),
  /HID_NIN_HOLDER_SMS_ENABLED=true requires HID_ASSISTED_REGISTRATION_ENABLED=true in production/);
  const bothRoutes = environmentConfig('production', undefined, 'true', undefined, { ...productionTopic,
    qoreIdNinOnlyEnrollmentEnabled: 'true', ninHolderSmsEnabled: 'true', assistedRegistrationEnabled: 'true' });
  assert.deepEqual([bothRoutes.qoreIdNinOnlyEnrollmentEnabled, bothRoutes.ninHolderSmsEnabled,
    bothRoutes.assistedRegistrationEnabled], [true, true, true]);
  assert.throws(() => environmentConfig('production', undefined, 'true', undefined,
    { ...productionTopic, qoreIdPatientSelfNinBindingEnabled: 'true' }),
  /HID_QOREID_PATIENT_SELF_NIN_BINDING_ENABLED=true is refused in production/);
  assert.equal(environmentConfig('staging', 'economy', 'true', undefined,
    { qoreIdPatientSelfNinBindingEnabled: 'true' }).qoreIdPatientSelfNinBindingEnabled, true);
  // The regional stack refuses the same, for a configuration built by hand.
  const productionConfiguration = environmentConfig('production', undefined, 'true', undefined, productionTopic);
  for (const [label, change, message] of [
    ['online route without the facility route', { ninHolderSmsEnabled: true },
      /HID_NIN_HOLDER_SMS_ENABLED=true requires HID_ASSISTED_REGISTRATION_ENABLED=true in production/],
    ['signed-in NIN binding', { qoreIdPatientSelfNinBindingEnabled: true },
      /HID_QOREID_PATIENT_SELF_NIN_BINDING_ENABLED=true is refused in production/],
    ['NIN-only enrollment without a route', { qoreIdNinOnlyEnrollmentEnabled: true },
      /requires HID_NIN_HOLDER_SMS_ENABLED=true or HID_ASSISTED_REGISTRATION_ENABLED=true/],
  ] as const) {
    assert.throws(() => new HidRegionalStack(new App(), `Holder${label.replace(/[^A-Za-z]/g, '')}`, {
      configuration: { ...productionConfiguration, ...change } }), message, label);
  }
  const enabled = environmentConfig('staging', 'economy', 'true', undefined,
    { qoreIdNinOnlyEnrollmentEnabled: 'true', assistedRegistrationEnabled: 'true' });
  assert.deepEqual([enabled.qoreIdNinOnlyEnrollmentEnabled, enabled.assistedRegistrationEnabled], [true, true]);
  const template = Template.fromStack(new HidRegionalStack(new App(), 'NinOnlyStaging', { configuration: enabled }))
    .toJSON() as typeof regional;
  assert.equal(containerOf(template, 'identity-api').environment.QOREID_NIN_ONLY_ENROLLMENT_ENABLED, 'true');
  assert.equal(containerOf(template, 'identity-api').environment.ASSISTED_REGISTRATION_ENABLED, 'true');
  assert.equal(containerOf(template, 'identity-api').environment.NIN_HOLDER_SMS_ENABLED, 'false');
  for (const name of workloadNames.filter(item => item !== 'identity-api')) {
    assert.doesNotMatch(JSON.stringify(containerOf(template, name)),
      /QOREID_NIN_ONLY|NIN_HOLDER|ASSISTED_REGISTRATION|PATIENT_SELF_NIN_BINDING/);
  }
});

test('the production preflight checks exactly the secret fields and alarm topic the production template uses', () => {
  const script = readFileSync(new URL('../../../scripts/production-external-preflight.py', import.meta.url), 'utf8');
  const list = (name: string) => JSON.parse((new RegExp(`^${name} = (\\[[^\\]]*\\])`, 'm').exec(script)?.[1] ?? 'null')
    .replace(/'/g, '"'));
  const fields = (secret: string, container: string) => containerOf(regional, container).secrets
    .map(item => (item.ValueFrom as { 'Fn::Join': [string, unknown[]] })['Fn::Join'][1])
    .filter(parts => JSON.stringify(parts[0]) === JSON.stringify({ Ref: secret }))
    .map(parts => /^:([A-Za-z0-9]+)::$/.exec(String(parts[1]))?.[1]).sort();
  assert.deepEqual([...list('IDENTITY_SENSITIVE_FIELDS')].sort(), fields('IdentitySensitiveSecretArn', 'identity-api'));
  assert.deepEqual([...list('NOTIFICATION_PROVIDER_FIELDS')].sort(), fields('NotificationProviderSecretArn', 'notification-api'));
  assert.deepEqual([...list('AUTH_FIELDS')].sort(), fields('AuthSecretArn', 'identity-api'));
  assert.match(script, /^ALARM_TOPIC_NAME = "hid-production-operational-alerts"$/m);
});
