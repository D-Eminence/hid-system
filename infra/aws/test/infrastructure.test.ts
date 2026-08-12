import assert from 'node:assert/strict';
import test from 'node:test';
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { environmentConfig, externalAwsEnvironment } from '../src/config.js';
import { HidRegionalStack } from '../src/hid-regional-stack.js';
import { browserPaths, workloadNames } from '../src/workloads.js';

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
  configuration: environmentConfig('staging'),
});
const stagingRegional = Template.fromStack(stagingRegionalStack).toJSON() as {
  readonly Parameters: Record<string, Record<string, unknown>>;
  readonly Resources: Record<string, Resource>;
};

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
  assert.equal(environmentConfig('staging').publicApiSubdomain, 'api.staging');
  assert.deepEqual(environmentConfig('staging').browserSubdomains, [
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
  for (const type of ['AWS::ECS::Service', 'AWS::ECR::Repository', 'AWS::RDS::DBInstance']) {
    for (const item of properties(regional, type)) {
      const tags = item.Tags as Array<{ readonly Key: string; readonly Value: string }>;
      assert.ok(tags.some((tag) => tag.Key === 'Environment' && tag.Value === 'production'));
      assert.ok(tags.some((tag) => tag.Key === 'DataClassification' && tag.Value === 'healthcare-restricted'));
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
  assert.equal(properties(regional, 'AWS::CloudWatch::Alarm').length, 11);
  assert.equal(properties(regional, 'AWS::Logs::MetricFilter').length, 2);
  assert.doesNotMatch(JSON.stringify(properties(regional, 'AWS::CloudWatch::Alarm')), /patient|\bnin\b|document_text/i);
});
