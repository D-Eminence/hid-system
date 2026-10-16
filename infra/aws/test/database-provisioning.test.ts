import assert from 'node:assert/strict';
import test from 'node:test';
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { environmentConfig, type HidEnvironmentConfig } from '../src/config.js';
import { HidRegionalStack } from '../src/hid-regional-stack.js';

// Gap 5: a new RDS instance has only its master, and RDS admits only the
// service tasks and the one-shot migration task. The one-shot provisioning
// task (MIGRATION_RUNBOOK.md §6.1 and §6.3) runs the master's statements and
// creates the ten runtime LOGINs from the passwords in their secrets, then
// verifies them. It runs the migration image with the migration security
// group, so the database gains no ingress; it maps the RDS master's username
// and password, the migration administrator's URL and each runtime
// credential's URL, nothing else; its default command only verifies; and no
// service runs it.
interface Resource { readonly Type: string; readonly Properties?: Record<string, any> }
interface Synthesized {
  readonly Resources: Record<string, Resource>;
  readonly Outputs: Record<string, { readonly Value: unknown }>;
}
const productionTopic = { operationalAlarmTopicArn: 'arn:aws:sns:eu-west-1:000000000000:hid-production-operational-alerts' };
const profiles: Array<[string, HidEnvironmentConfig]> = [
  ['production', environmentConfig('production', undefined, undefined, undefined, productionTopic)],
  ['staging economy', environmentConfig('staging', 'economy')],
  ['staging sleep', environmentConfig('staging', 'sleep')],
  ['development', environmentConfig('development')],
];
const templates = profiles.map(([label, configuration], index) => [label, configuration.name,
  Template.fromStack(new HidRegionalStack(new App(), `DatabaseProvisioning${index}`, { configuration }))
    .toJSON() as Synthesized] as const);

const runtimeLogins: Array<[string, string, string]> = [
  ['DATABASE_LOGIN_URL_IDENTITY_API', 'IdentityApiDatabaseSecretArn', 'url'],
  ['DATABASE_LOGIN_URL_EHR_API', 'EhrApiDatabaseSecretArn', 'url'],
  ['DATABASE_LOGIN_URL_EHR_API_SCANNER', 'EhrApiDatabaseSecretArn', 'scannerUrl'],
  ['DATABASE_LOGIN_URL_LAB_API', 'LabApiDatabaseSecretArn', 'url'],
  ['DATABASE_LOGIN_URL_PHARMACY_API', 'PharmacyApiDatabaseSecretArn', 'url'],
  ['DATABASE_LOGIN_URL_OCR_API', 'OcrApiDatabaseSecretArn', 'url'],
  ['DATABASE_LOGIN_URL_OCR_WORKER', 'OcrWorkerDatabaseSecretArn', 'url'],
  ['DATABASE_LOGIN_URL_OUTREACH_API', 'OutreachApiDatabaseSecretArn', 'url'],
  ['DATABASE_LOGIN_URL_EVENT_DISPATCHER', 'EventDispatcherDatabaseSecretArn', 'url'],
  ['DATABASE_LOGIN_URL_NOTIFICATION_WORKER', 'NotificationWorkerDatabaseSecretArn', 'url'],
];
const field = (secret: unknown, name: string) => ({ 'Fn::Join': ['', [secret, `:${name}::`]] });

function provisioning(template: Synthesized, environment: string) {
  const entries = Object.entries(template.Resources).filter(([, resource]) => resource.Type === 'AWS::ECS::TaskDefinition'
    && resource.Properties!.Family === `hid-${environment}-database-provisioning`);
  assert.equal(entries.length, 1, `${environment}: one provisioning task definition`);
  return entries[0]!;
}

function roleStatements(template: Synthesized, roleArn: unknown): Array<Record<string, any>> {
  const roleId = (roleArn as { 'Fn::GetAtt': [string, string] })['Fn::GetAtt'][0];
  return Object.values(template.Resources).filter((resource) => resource.Type === 'AWS::IAM::Policy'
    && (resource.Properties!.Roles as unknown[]).some((role) => JSON.stringify(role) === JSON.stringify({ Ref: roleId })))
    .flatMap((policy) => policy.Properties!.PolicyDocument.Statement as Array<Record<string, any>>);
}

test('the provisioning task is one-shot, verifies by default and runs the migration image read-only', () => {
  for (const [label, environment, template] of templates) {
    const [id, task] = provisioning(template, environment);
    assert.equal(Object.values(template.Resources).some((resource) => resource.Type === 'AWS::ECS::Service'
      && JSON.stringify(resource.Properties!.TaskDefinition) === JSON.stringify({ Ref: id })), false,
    `${label}: no service runs the provisioning task`);
    const containers = task.Properties!.ContainerDefinitions as Array<Record<string, any>>;
    assert.equal(containers.length, 1, label);
    const container = containers[0]!;
    assert.equal(container.Name, 'database-provisioning');
    assert.deepEqual(container.Image, { Ref: 'MigrationImageUri' }, label);
    // The image's entrypoint is /nodejs/bin/node, so the command names the script.
    assert.deepEqual(container.Command, ['scripts/provision-database-logins.mjs', '--verify-logins'], label);
    assert.equal(container.ReadonlyRootFilesystem, true, label);
    assert.equal(container.PortMappings, undefined, label);
    assert.deepEqual(Object.fromEntries((container.Environment as Array<{ Name: string; Value: unknown }>)
      .map((entry) => [entry.Name, entry.Value])), { NODE_ENV: 'production', DATABASE_SSL: 'true',
      DATABASE_SSL_ROOT_CERT_BASE64: { Ref: 'RdsCaBundleBase64' } }, label);
    const logGroup = Object.values(template.Resources).find((resource) => resource.Type === 'AWS::Logs::LogGroup'
      && resource.Properties!.LogGroupName === `/hid/${environment}/database-provisioning`);
    assert.ok(logGroup, `${label}: the provisioning task logs to its own group`);
    assert.equal(template.Outputs.DatabaseProvisioningTaskDefinitionArn?.Value !== undefined, true, label);
  }
});

test('the provisioning task maps the RDS master, the migration administrator and each runtime credential, nothing else', () => {
  for (const [label, environment, template] of templates) {
    const [, task] = provisioning(template, environment);
    const container = (task.Properties!.ContainerDefinitions as Array<Record<string, any>>)[0]!;
    const master = template.Outputs.BootstrapDatabaseSecretArn!.Value;
    const expected = [
      ['DATABASE_ADMIN_URL', field({ Ref: 'MigrationDatabaseSecretArn' }, 'url')],
      ['DATABASE_MASTER_PASSWORD', field(master, 'password')],
      ['DATABASE_MASTER_USERNAME', field(master, 'username')],
      ...runtimeLogins.map(([name, parameter, key]) => [name, field({ Ref: parameter }, key)]),
    ].sort((left, right) => String(left[0]).localeCompare(String(right[0])));
    assert.deepEqual((container.Secrets as Array<{ Name: string; ValueFrom: unknown }>)
      .map((secret) => [secret.Name, secret.ValueFrom])
      .sort((left, right) => String(left[0]).localeCompare(String(right[0]))), expected, label);
  }
});

test('the provisioning roles read only those secrets and call no other AWS API', () => {
  for (const [label, environment, template] of templates) {
    const [, task] = provisioning(template, environment);
    assert.notDeepEqual(task.Properties!.ExecutionRoleArn, task.Properties!.TaskRoleArn, label);
    assert.deepEqual(roleStatements(template, task.Properties!.TaskRoleArn), [], `${label}: the task role has no policy`);
    const master = JSON.stringify(template.Outputs.BootstrapDatabaseSecretArn!.Value);
    const allowed = new Set([master, JSON.stringify({ Ref: 'MigrationDatabaseSecretArn' }),
      ...runtimeLogins.map(([, parameter]) => JSON.stringify({ Ref: parameter }))]);
    const secretReads = roleStatements(template, task.Properties!.ExecutionRoleArn)
      .filter((statement) => [statement.Action].flat().some((action: string) => action.startsWith('secretsmanager:')));
    const read = new Set(secretReads.flatMap((statement) => [statement.Resource].flat()).map((resource) => JSON.stringify(resource)));
    assert.deepEqual([...read].sort(), [...allowed].sort(), `${label}: exactly the mapped secrets`);
    for (const statement of secretReads) {
      assert.deepEqual([statement.Action].flat().sort(), ['secretsmanager:DescribeSecret', 'secretsmanager:GetSecretValue'], label);
    }
  }
});

test('the provisioning task adds no security group and no database ingress', () => {
  for (const [label, , template] of templates) {
    assert.equal(Object.keys(template.Resources).some((id) => id.startsWith('DatabaseProvisioning')
      && template.Resources[id]!.Type === 'AWS::EC2::SecurityGroup'), false, label);
    const ingress = Object.values(template.Resources).filter((resource) => resource.Type === 'AWS::EC2::SecurityGroupIngress'
      && resource.Properties!.FromPort === 5432);
    assert.equal(ingress.length, 10, `${label}: nine runtime services and the migration security group`);
    assert.ok(template.Outputs.MigrationSecurityGroupId, `${label}: run it with the migration security group`);
  }
});
