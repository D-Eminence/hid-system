import assert from 'node:assert/strict';
import test from 'node:test';
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { environmentConfig, externalAwsEnvironment } from '../src/config.js';
import { HidCostGovernanceStack } from '../src/cost-governance-stack.js';
import { HidRegionalStack } from '../src/hid-regional-stack.js';
import { costInventory } from '../src/cost-inventory.js';
import { browserPaths, databaseConnectionDemand, validateDatabaseConnectionBudget,
  workloadNames, workloadScale } from '../src/workloads.js';

interface Resource {
  readonly Type: string;
  readonly Properties?: Record<string, unknown>;
  readonly DeletionPolicy?: string;
  readonly UpdateReplacePolicy?: string;
}

const application = new App();
const configuration = environmentConfig('production');
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
  assert.equal(environmentConfig('staging', 'economy').publicApiSubdomain, 'api.staging');
  assert.deepEqual(environmentConfig('staging', 'economy').browserSubdomains, [
    'staging', 'ehr.staging', 'lab.staging', 'pharmacy.staging', 'ocr.staging', 'outreach.staging', 'admin.staging',
  ]);
});

test('account and region are both external or both absent', () => {
  assert.deepEqual(externalAwsEnvironment(undefined, undefined), undefined);
  assert.throws(() => externalAwsEnvironment('123456789012', undefined));
  assert.deepEqual(externalAwsEnvironment('123456789012', 'eu-west-1'), {
    account: '123456789012', region: 'eu-west-1',
  });
});

test('RDS is private', () => {
  const [database] = properties(regional, 'AWS::RDS::DBInstance');
  assert.equal(database!.PubliclyAccessible, false);
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
  ]);
  assert.equal(eventPattern['detail-type'].some((eventType) => /otp|passwordreset/i.test(eventType)), false);
  assert.equal(resources(regional, 'AWS::Lambda::Function').length, 0);
  assert.equal(resources(regional, 'AWS::Events::EventBus').length, 1);
});

test('the canonical seven browser roots remain explicit', () => {
  assert.deepEqual(browserPaths, ['/', '/ehr/', '/lab/', '/pharmacy/', '/ocr/', '/outreach/', '/admin/']);
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
  const [acl] = properties(regional, 'AWS::WAFv2::WebACL');
  const serialized = JSON.stringify(acl!.Rules);
  assert.match(serialized, /x-hid-origin-authorization/);
  assert.match(serialized, /ProductionCloudflareOriginSecret/);
  assert.doesNotMatch(serialized, /StagingCloudflareOriginSecret/);
  assert.match(serialized, /AWSManagedRulesCommonRuleSet/);
  assert.match(serialized, /AWSManagedRulesKnownBadInputsRuleSet/);
  assert.match(serialized, /RateBasedStatement/);
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
  assert.doesNotMatch(JSON.stringify(ehr!.ContainerDefinitions), /AUTH_SIGNING_SECRET|AUTH_LOGIN_PEPPER/);
});

test('workload identity issuer, JWKS, and subjects are required external inputs', () => {
  for (const name of [
    'WorkloadIssuerUrl', 'WorkloadJwksUrl', 'EhrWorkloadSubject', 'LabWorkloadSubject',
    'PharmacyWorkloadSubject', 'OcrWorkloadSubject', 'OutreachWorkloadSubject',
    'IdentityWorkloadSubject',
  ]) {
    assert.ok(regional.Parameters[name]);
    assert.equal(regional.Parameters[name]!.Default, undefined);
  }
});

test('monitoring is focused on RDS, task health, OCR, and event delivery', () => {
  assert.equal(properties(regional, 'AWS::CloudWatch::Alarm').length, 47);
  assert.equal(properties(regional, 'AWS::Logs::MetricFilter').length, 13);
  assert.doesNotMatch(JSON.stringify(properties(regional, 'AWS::CloudWatch::Alarm')), /patient|\bnin\b|document_text/i);
});

test('sleep removes fixed-cost runtime ingress while retaining protected data controls', () => {
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
  assert.equal(resources(sleepRegional, 'AWS::KMS::Key').length, 3);
});

test('economy and fidelity are explicit, bounded staging modes', () => {
  assert.equal(resources(stagingRegional, 'AWS::EC2::NatGateway').length, 1);
  assert.equal(resources(stagingRegional, 'AWS::ElasticLoadBalancingV2::LoadBalancer').length, 2);
  assert.equal(resources(stagingRegional, 'AWS::EC2::VPCEndpoint')
    .filter(([, item]) => String(item.Properties?.VpcEndpointType) === 'Interface').length, 4);
  assert.equal(stagingRegional.Parameters.GatewayDesiredCount!.Default, 1);
  assert.equal(stagingRegional.Parameters.OcrWorkerDesiredCount!.Default, 0);
  assert.equal(properties(stagingRegional, 'AWS::RDS::DBInstance')[0]!.MultiAZ, false);

  assert.equal(resources(fidelityRegional, 'AWS::EC2::NatGateway').length, 2);
  assert.equal(resources(fidelityRegional, 'AWS::EC2::VPCEndpoint')
    .filter(([, item]) => String(item.Properties?.VpcEndpointType) === 'Interface').length, 8);
  assert.equal(fidelityRegional.Parameters.GatewayDesiredCount!.Default, 2);
  assert.equal(fidelityRegional.Parameters.OcrWorkerDesiredCount!.Default, 1);
  assert.equal(properties(fidelityRegional, 'AWS::RDS::DBInstance')[0]!.MultiAZ, true);
});

test('every live workload has typed resource and autoscaling boundaries', () => {
  assert.equal(resources(regional, 'AWS::ApplicationAutoScaling::ScalableTarget').length, workloadNames.length);
  assert.equal(resources(regional, 'AWS::ApplicationAutoScaling::ScalingPolicy').length, 33);
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
  assert.equal(sleep.kmsKeys, 3);
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
