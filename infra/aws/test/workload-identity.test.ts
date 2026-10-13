import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { environmentConfig } from '../src/config.js';
import { HidRegionalStack } from '../src/hid-regional-stack.js';

interface Resource { Type: string; Properties?: Record<string, any>; DependsOn?: string | string[]; DeletionPolicy?: string }
interface Assembly { Resources: Record<string, Resource>; Parameters: Record<string, any>; Outputs?: Record<string, any> }
type IssuerEnvironment = 'staging' | 'production';
const expected: Readonly<Record<string, readonly string[]>> = {
  'identity-api': ['hid-notification-api'],
  'ehr-api': ['hid-identity-api', 'hid-lab-api', 'hid-pharmacy-api'],
  'lab-api': ['hid-identity-api'],
  'pharmacy-api': ['hid-identity-api'],
  'ocr-api': ['hid-identity-api', 'hid-ehr-api', 'hid-lab-api', 'hid-pharmacy-api'],
  'outreach-api': ['hid-identity-api'],
};
const tokenDirectory = '/var/run/hid/workload-tokens';
const externalWorkloadParameters = ['WorkloadIssuerUrl', 'WorkloadJwksUrl', 'EhrWorkloadSubject', 'LabWorkloadSubject',
  'PharmacyWorkloadSubject', 'OcrWorkloadSubject', 'OutreachWorkloadSubject', 'IdentityWorkloadSubject'];
const labels: Readonly<Record<IssuerEnvironment, string>> = { staging: 'Staging', production: 'Production' };
const logRetentionDays: Readonly<Record<IssuerEnvironment, number>> = { staging: 14, production: 365 };
function synth(environment: 'staging' | 'production' | 'development', mode?: 'economy' | 'fidelity' | 'sleep'): Assembly {
  return Template.fromStack(new HidRegionalStack(new App(), `WorkloadIdentity-${environment}-${mode ?? 'production'}`, {
    configuration: environmentConfig(environment, mode),
  })).toJSON() as Assembly;
}
const economy = synth('staging', 'economy');
const fidelity = synth('staging', 'fidelity');
const sleep = synth('staging', 'sleep');
const production = synth('production');
const development = synth('development');
const profiles = [['economy', economy, 'staging'], ['fidelity', fidelity, 'staging'], ['sleep', sleep, 'staging'],
  ['production', production, 'production']] as const;
const entries = (assembly: Assembly, type: string) => Object.entries(assembly.Resources).filter(([, item]) => item.Type === type);
const list = <T>(value: T | T[] | undefined): T[] => value === undefined ? [] : Array.isArray(value) ? value : [value];
function resolve(value: any): any {
  if (Array.isArray(value)) return value.map(resolve);
  if (!value || typeof value !== 'object') return value;
  if (value.Ref) return `REF:${value.Ref}`;
  if (value['Fn::GetAtt']) return `ATT:${list(value['Fn::GetAtt']).join('.')}`;
  if (value['Fn::Join']) return resolve(value['Fn::Join'][1]).join(value['Fn::Join'][0]);
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolve(item)]));
}
function namedTask(assembly: Assembly, name: string) {
  const result = entries(assembly, 'AWS::ECS::TaskDefinition').find(([, item]) =>
    item.Properties?.ContainerDefinitions.some((container: any) => container.Name === name));
  assert(result, `Missing ${name} task`);
  return result[1].Properties!;
}
function environment(container: any): Record<string, any> {
  return Object.fromEntries(container.Environment.map((item: any) => [item.Name, item.Value]));
}
function roleId(task: any): string { return task.TaskRoleArn['Fn::GetAtt'][0]; }
function roleStatements(assembly: Assembly, role: string): any[] {
  return entries(assembly, 'AWS::IAM::Policy').filter(([, item]) =>
    item.Properties?.Roles?.some((candidate: any) => candidate.Ref === role))
    .flatMap(([, item]) => item.Properties!.PolicyDocument.Statement);
}
function issuerFunction(assembly: Assembly, issuer: IssuerEnvironment): [string, Resource] {
  const found = entries(assembly, 'AWS::Lambda::Function')
    .filter(([, item]) => item.Properties?.FunctionName === `hid-${issuer}-workload-issuer`);
  assert.equal(found.length, 1, `Expected exactly one hid-${issuer}-workload-issuer function`);
  return found[0]!;
}
function issuerApi(assembly: Assembly, issuer: IssuerEnvironment): [string, Resource] {
  const found = entries(assembly, 'AWS::ApiGateway::RestApi')
    .filter(([, item]) => item.Properties?.Name === `hid-${issuer}-workload-identity`);
  assert.equal(found.length, 1, `Expected exactly one hid-${issuer}-workload-identity API`);
  return found[0]!;
}
function tokenTasks(assembly: Assembly) {
  return entries(assembly, 'AWS::ECS::TaskDefinition').map(([, resource]) => resource.Properties!)
    .filter(task => list(task.Volumes).some((volume: any) => volume.Name === 'workload-tokens'));
}
const tokenMounts = (container: any) => list<any>(container.MountPoints).filter(mount => mount.SourceVolume === 'workload-tokens');

test('development keeps the external workload contract and has no in-stack issuer or token writer', () => {
  assert.equal(entries(development, 'AWS::ApiGateway::RestApi').length, 0);
  assert.equal(entries(development, 'AWS::Lambda::Function').length, 0);
  assert.equal(entries(development, 'AWS::KMS::Key').filter(([, item]) => item.Properties?.KeyUsage === 'SIGN_VERIFY').length, 0);
  assert(!JSON.stringify(development).includes('workload-token-agent'));
  assert.doesNotMatch(JSON.stringify(development), /hid:(?:staging|production):|hid-(?:staging|production)-workload/);
  const tasks = tokenTasks(development);
  assert.equal(tasks.length, 6);
  for (const task of tasks) {
    assert.deepEqual(task.ContainerDefinitions.flatMap((container: any) => tokenMounts(container).map(mount => mount.ReadOnly)), [true]);
  }
  for (const name of externalWorkloadParameters) {
    assert.ok(development.Parameters[name], `development must still require ${name}`);
    assert.equal(development.Parameters[name].Default, undefined);
  }
});

test('staging and production never share issuer names, keys, stages or subjects', () => {
  const productionText = JSON.stringify(production);
  for (const value of ['hid:staging:', 'alias/hid-staging-workload-signing', 'hid-staging-workload', '/hid/staging/workload-issuer',
    'StagingWorkloadIdentity']) {
    assert(!productionText.includes(value), `production template contains ${value}`);
  }
  for (const [mode, assembly] of [['economy', economy], ['fidelity', fidelity], ['sleep', sleep]] as const) {
    const text = JSON.stringify(assembly);
    for (const value of ['hid:production:', 'alias/hid-production-workload-signing', 'hid-production-workload',
      '/hid/production/workload-issuer', 'ProductionWorkloadIdentity']) {
      assert(!text.includes(value), `${mode} template contains ${value}`);
    }
  }
  for (const name of externalWorkloadParameters) assert.equal(production.Parameters[name], undefined, `production must not take ${name}`);
});

test('sleep preserves the staging signing identity while all runtime tasks remain stopped', () => {
  const ids = (assembly: Assembly, type: string) => entries(assembly, type)
    .filter(([id]) => id.startsWith('StagingWorkloadIdentity')).map(([id]) => id).sort();
  for (const type of ['AWS::ApiGateway::RestApi', 'AWS::KMS::Key', 'AWS::Lambda::Function']) {
    assert.equal(ids(sleep, type).length, 1);
    assert.deepEqual(ids(sleep, type), ids(economy, type));
  }
  for (const [, service] of entries(sleep, 'AWS::ECS::Service')) assert.equal(service.Properties!.DesiredCount, 0);
  assert.equal(entries(sleep, 'AWS::EC2::NatGateway').length, 0);
});

for (const [mode, assembly, issuer] of profiles) {
  test(`${mode} token minting is IAM authenticated; only JWKS is public`, () => {
    const [apiId, api] = issuerApi(assembly, issuer);
    assert.equal(api.Properties!.Description, `IAM-bound short-lived ${issuer} workload tokens and public verification keys`);
    assert.deepEqual(api.Properties!.EndpointConfiguration, { Types: ['REGIONAL'] });
    const methods = entries(assembly, 'AWS::ApiGateway::Method').filter(([, item]) => item.Properties?.RestApiId.Ref === apiId);
    assert.equal(methods.length, 2);
    const method = (verb: string) => methods.find(([, item]) => item.Properties?.HttpMethod === verb)![1].Properties!;
    assert.equal(method('POST').AuthorizationType, 'AWS_IAM');
    assert.equal(method('GET').AuthorizationType, 'NONE');
    assert.equal(method('POST').Integration.Type, 'AWS_PROXY');
    assert.equal(method('GET').Integration.Type, 'AWS_PROXY');
    const path = (item: any) => assembly.Resources[item.ResourceId.Ref]!.Properties!.PathPart;
    assert.equal(path(method('POST')), 'token');
    assert.equal(path(method('GET')), 'jwks.json');
    const stages = entries(assembly, 'AWS::ApiGateway::Stage').filter(([, item]) => item.Properties?.RestApiId.Ref === apiId);
    assert.equal(stages.length, 1);
    assert.equal(stages[0]![1].Properties!.StageName, issuer);
    // DEP-4-DOS: POST /token and the public JWKS GET each have their own
    // method throttle; no stage-wide '/*/*' setting is shared between them.
    const settings = stages[0]![1].Properties!.MethodSettings as any[];
    assert(!settings.some(setting => setting.ResourcePath === '/*' || setting.HttpMethod === '*'),
      'no stage-wide method setting may be shared by the token and JWKS methods');
    assert.equal(settings.length, 2);
    const setting = (verb: string, resourcePath: string) => {
      const found = settings.filter(item => item.HttpMethod === verb && item.ResourcePath === resourcePath);
      assert.equal(found.length, 1, `exactly one ${verb} ${resourcePath} method setting`);
      return found[0];
    };
    const token = setting('POST', '/~1token');
    const jwks = setting('GET', '/~1.well-known~1jwks.json');
    for (const item of [token, jwks]) {
      assert.equal(item.DataTraceEnabled, false);
      assert.equal(item.LoggingLevel, 'OFF');
      assert.equal(item.MetricsEnabled, true);
    }
    assert.equal(token.ThrottlingRateLimit, 30);
    assert.equal(token.ThrottlingBurstLimit, 60);
    assert(jwks.ThrottlingRateLimit >= token.ThrottlingRateLimit && jwks.ThrottlingBurstLimit >= token.ThrottlingBurstLimit,
      'the JWKS limit is never below the token limit');
    const [issuerId] = issuerFunction(assembly, issuer);
    const permissions = entries(assembly, 'AWS::Lambda::Permission').filter(([, r]) => JSON.stringify(r.Properties?.FunctionName).includes(issuerId));
    assert.equal(permissions.length, 2);
    const sources = permissions.map(([, r]) => {
      assert.equal(r.Properties!.Principal, 'apigateway.amazonaws.com');
      assert.equal(r.Properties!.Action, 'lambda:InvokeFunction');
      assert.match(JSON.stringify(r.Properties!.SourceArn), new RegExp(apiId));
      return resolve(r.Properties!.SourceArn) as string;
    });
    assert(sources.some(source => source.endsWith('/POST/token')));
    assert(sources.some(source => source.endsWith('/GET/.well-known/jwks.json')));
    assert(sources.every(source => !source.includes('test-invoke-stage')));
    const outputs = Object.keys(assembly.Outputs ?? {});
    assert(outputs.some(name => name.startsWith(`${labels[issuer]}WorkloadIdentityIssuerUrl`)));
    assert(outputs.some(name => name.startsWith(`${labels[issuer]}WorkloadIdentityJwksUrl`)));
  });

  test(`${mode} exactly six caller roles mint only eleven approved subject/audience bindings`, () => {
    const issuerProperties = issuerFunction(assembly, issuer)[1].Properties!;
    const variables = issuerProperties.Environment.Variables;
    assert.equal(variables.HID_DEPLOYMENT_ENV, issuer);
    const [apiId] = issuerApi(assembly, issuer);
    assert.equal(resolve(variables.WORKLOAD_ISSUER_URL),
      `https://REF:${apiId}.execute-api.REF:AWS::Region.REF:AWS::URLSuffix/${issuer}`);
    const policy = JSON.parse(resolve(variables.WORKLOAD_CALLER_POLICY_JSON)) as any[];
    assert.equal(policy.length, 6);
    assert.equal(new Set(policy.map(item => item.roleArn)).size, 6);
    assert.equal(policy.reduce((count, item) => count + item.audiences.length, 0), 11);
    assert(policy.every(item => item.subject.startsWith(`hid:${issuer}:`)));
    assert.deepEqual(Object.fromEntries(policy.map(item => [item.subject.replace(`hid:${issuer}:`, ''), item.audiences])), expected);
    for (const [name, audiences] of Object.entries(expected)) {
      const task = namedTask(assembly, name);
      const rule = policy.find(item => item.subject === `hid:${issuer}:${name}`)!;
      assert.equal(rule.roleArn, resolve(task.TaskRoleArn));
      assert.deepEqual(rule.audiences, audiences);
      const actions = roleStatements(assembly, roleId(task));
      const invocation = actions.filter(statement => list(statement.Action).includes('execute-api:Invoke'));
      assert.equal(invocation.length, 1);
      assert.equal(list(invocation[0].Resource).length, 1);
      assert.equal(resolve(invocation[0].Resource),
        `arn:REF:AWS::Partition:execute-api:REF:AWS::Region:REF:AWS::AccountId:REF:${apiId}/${issuer}/POST/token`);
      assert(!JSON.stringify(invocation[0].Resource).includes('/*/'));
    }
    for (const [, resource] of entries(assembly, 'AWS::ECS::TaskDefinition')) {
      const task = resource.Properties!;
      for (const statement of roleStatements(assembly, roleId(task))) {
        assert(!list(statement.Action).some(action => /^(?:kms:\*|kms:Sign|\*)$/i.test(action)), 'Task acquired signing authority');
      }
      if (!task.ContainerDefinitions.some((container: any) => container.Name in expected)) {
        assert(!roleStatements(assembly, roleId(task)).some(statement => list(statement.Action).includes('execute-api:Invoke')),
          'A non-caller task acquired issuer invocation');
      }
    }
  });

  test(`${mode} ES256 signing key is isolated to the issuer role`, () => {
    const signingKeys = entries(assembly, 'AWS::KMS::Key').filter(([, item]) => item.Properties?.KeyUsage === 'SIGN_VERIFY');
    assert.equal(signingKeys.length, 1);
    const [keyId, key] = signingKeys[0]!;
    assert.match(keyId, new RegExp(`^${labels[issuer]}WorkloadIdentitySigningKey[0-9A-F]{8}$`));
    assert.equal(key.Properties!.KeySpec, 'ECC_NIST_P256');
    assert.equal(key.Properties!.Description,
      `${labels[issuer]} workload identity ES256 signer; distinct from release signing custody`);
    assert.equal(key.DeletionPolicy, 'Retain');
    const aliases = entries(assembly, 'AWS::KMS::Alias').filter(([, item]) => item.Properties?.AliasName === `alias/hid-${issuer}-workload-signing`);
    assert.equal(aliases.length, 1);
    assert.deepEqual(aliases[0]![1].Properties!.TargetKeyId, { 'Fn::GetAtt': [keyId, 'Arn'] });
    const issuerProperties = issuerFunction(assembly, issuer)[1].Properties!;
    assert.deepEqual(issuerProperties.Environment.Variables.WORKLOAD_SIGNING_KEY_ID, { 'Fn::GetAtt': [keyId, 'Arn'] });
    const role = issuerProperties.Role['Fn::GetAtt'][0];
    const signed = entries(assembly, 'AWS::IAM::Policy').flatMap(([, item]) => item.Properties!.PolicyDocument.Statement
      .filter((statement: any) => list(statement.Action).includes('kms:Sign'))
      .map((statement: any) => ({ roles: item.Properties!.Roles, statement })));
    assert.equal(signed.length, 1);
    assert.deepEqual(signed[0]!.roles, [{ Ref: role }]);
    assert.deepEqual(signed[0]!.statement.Resource, { 'Fn::GetAtt': [keyId, 'Arn'] });
    assert.deepEqual(signed[0]!.statement.Condition, { StringEquals: { 'kms:SigningAlgorithm': 'ECDSA_SHA_256' } });
    assert(!JSON.stringify(issuerProperties.Environment).includes('PRIVATE_KEY'));
    // DEP-4-KEY: the key policy keeps the account root statement (no lockout)
    // and denies kms:Sign to every principal but the issuer role, and any
    // algorithm or message type other than the issuer's ES256 RAW signing.
    const keyPolicy = key.Properties!.KeyPolicy.Statement as any[];
    const root = keyPolicy.filter(statement => statement.Effect === 'Allow');
    assert.equal(root.length, 1);
    assert.equal(root[0].Action, 'kms:*');
    assert.equal(root[0].Resource, '*');
    assert.equal(resolve(root[0].Principal.AWS), 'arn:REF:AWS::Partition:iam::REF:AWS::AccountId:root');
    const denies = keyPolicy.filter(statement => statement.Effect === 'Deny');
    assert.deepEqual(denies.map(statement => statement.Sid).sort(),
      ['DenyEveryOtherMessageType', 'DenyEveryOtherSigningAlgorithm', 'DenySigningFromEveryOtherPrincipal']);
    const deny = (sid: string) => denies.find(statement => statement.Sid === sid);
    for (const statement of denies) {
      assert.deepEqual(statement.Principal, { AWS: '*' });
      assert.equal(statement.Action, 'kms:Sign');
      assert.equal(statement.Resource, '*');
    }
    assert.deepEqual(deny('DenySigningFromEveryOtherPrincipal').Condition,
      { ArnNotEquals: { 'aws:PrincipalArn': { 'Fn::GetAtt': [role, 'Arn'] } } });
    assert.deepEqual(deny('DenyEveryOtherSigningAlgorithm').Condition,
      { StringNotEquals: { 'kms:SigningAlgorithm': 'ECDSA_SHA_256' } });
    assert.deepEqual(deny('DenyEveryOtherMessageType').Condition, { StringNotEquals: { 'kms:MessageType': 'RAW' } });
    const issuerSource = readFileSync(new URL('../runtime/workload-issuer/index.mjs', import.meta.url), 'utf8');
    assert.match(issuerSource, /MessageType: 'RAW', SigningAlgorithm: 'ECDSA_SHA_256'/);
    const logGroups = entries(assembly, 'AWS::Logs::LogGroup').filter(([, item]) => item.Properties?.LogGroupName === `/hid/${issuer}/workload-issuer`);
    assert.equal(logGroups.length, 1);
    assert.equal(logGroups[0]![1].Properties!.RetentionInDays, logRetentionDays[issuer]);
    assert.equal(logGroups[0]![1].DeletionPolicy, 'Retain');
    assert.deepEqual(issuerProperties.LoggingConfig, { LogGroup: { Ref: logGroups[0]![0] } });
  });

  test(`${mode} receiving services enforce the same issuer and exact caller subject mappings`, () => {
    const issuerProperties = issuerFunction(assembly, issuer)[1].Properties!;
    const url = resolve(issuerProperties.Environment.Variables.WORKLOAD_ISSUER_URL);
    const receivers: Readonly<Record<string, {prefix: string; audience: string; callers: Record<string, string>}>> = {
      'identity-api': {prefix:'WORKLOAD',audience:'hid-identity-api',callers:{
        IDENTITY_EHR_CALLER_SUBJECT:'ehr-api',IDENTITY_LAB_CALLER_SUBJECT:'lab-api',
        IDENTITY_PHARMACY_CALLER_SUBJECT:'pharmacy-api',IDENTITY_OCR_CALLER_SUBJECT:'ocr-api',OUTREACH_CALLER_SUBJECT:'outreach-api'}},
      'ehr-api': {prefix:'EHR_WORKLOAD',audience:'hid-ehr-api',callers:{EHR_OCR_CALLER_SUBJECT:'ocr-api'}},
      'lab-api': {prefix:'LAB_WORKLOAD',audience:'hid-lab-api',callers:{LAB_EHR_CALLER_SUBJECT:'ehr-api',LAB_OCR_CALLER_SUBJECT:'ocr-api'}},
      'pharmacy-api': {prefix:'PHARMACY_WORKLOAD',audience:'hid-pharmacy-api',callers:{PHARMACY_EHR_CALLER_SUBJECT:'ehr-api',PHARMACY_OCR_CALLER_SUBJECT:'ocr-api'}},
      'notification-api': {prefix:'WORKLOAD',audience:'hid-notification-api',callers:{IDENTITY_CALLER_SUBJECT:'identity-api'}},
    };
    for (const [name, receiver] of Object.entries(receivers)) {
      const app = namedTask(assembly, name).ContainerDefinitions.find((container: any) => container.Name === name);
      const variables = environment(app);
      assert.equal(resolve(variables[`${receiver.prefix}_ISSUER_URL`]), url);
      assert.equal(resolve(variables[`${receiver.prefix}_JWKS_URL`]), `${url}/.well-known/jwks.json`);
      assert.equal(variables[`${receiver.prefix}_AUDIENCE`], receiver.audience);
      for (const [parameter, caller] of Object.entries(receiver.callers)) assert.equal(variables[parameter], `hid:${issuer}:${caller}`);
      for (const [key, value] of Object.entries(variables)) {
        if (key.endsWith('IDENTITY_MODE')) assert.equal(value, 'jwt', `${name} must not permit a shared-secret fallback`);
      }
    }
    const worker = namedTask(assembly, 'ocr-worker').ContainerDefinitions.find((container: any) => container.Name === 'ocr-worker');
    assert.equal(environment(worker).OCR_WORKER_SUBJECT, `hid:${issuer}:ocr-api`);
  });

  test(`${mode} every token volume has exactly one writer, the token agent, and the application waits for it`, () => {
    const tasks = tokenTasks(assembly);
    assert.equal(tasks.length, 6);
    for (const task of tasks) {
      const app = task.ContainerDefinitions.find((container: any) => container.Name in expected);
      assert(app, 'A token volume belongs to an unexpected task');
      const writers = task.ContainerDefinitions.filter((container: any) => tokenMounts(container).some(mount => mount.ReadOnly === false));
      assert.deepEqual(writers.map((container: any) => container.Name), ['workload-token-agent'],
        `${app.Name} token volume must have exactly one workload-token-agent writer`);
      assert.deepEqual(tokenMounts(writers[0]).map(mount => mount.ReadOnly), [false]);
      assert.deepEqual(tokenMounts(app).map(mount => mount.ReadOnly), [true]);
      assert.deepEqual(app.DependsOn, [{ ContainerName: 'workload-token-agent', Condition: 'HEALTHY' }]);
    }
  });

  test(`${mode} token sidecars share only read-only application token mounts and gate startup on health`, () => {
    const tasks = entries(assembly, 'AWS::ECS::TaskDefinition').map(([, resource]) => resource.Properties!);
    const sidecars = tasks.filter(task => task.ContainerDefinitions.some((container: any) => container.Name === 'workload-token-agent'));
    assert.equal(sidecars.length, 6);
    for (const task of sidecars) {
      const agent = task.ContainerDefinitions.find((container: any) => container.Name === 'workload-token-agent');
      const app = task.ContainerDefinitions.find((container: any) => container.Name !== 'workload-token-agent');
      assert(app.Name in expected);
      assert.equal(agent.User, '65532:65532');
      assert.equal(agent.ReadonlyRootFilesystem, true);
      // D2: an issuer outage stops service-to-service calls, not the task. The
      // agent is not essential, ECS restarts it if it exits, and the
      // application still starts only once the agent is HEALTHY.
      assert.equal(agent.Essential, false);
      assert.deepEqual(agent.RestartPolicy, { Enabled: true, RestartAttemptPeriod: 60 });
      assert.equal(app.Essential, true);
      assert.equal(agent.Secrets, undefined);
      assert.equal(agent.Privileged, undefined);
      assert.deepEqual(agent.Image, { Ref: 'IdentityApiImageUri' });
      assert.deepEqual(agent.Command, ['/app/services/workload-token-agent/src/main.mjs']);
      assert.deepEqual(agent.HealthCheck.Command, ['CMD', '/nodejs/bin/node', '/app/services/workload-token-agent/src/health.mjs']);
      assert.deepEqual(app.DependsOn, [{ ContainerName: 'workload-token-agent', Condition: 'HEALTHY' }]);
      assert.deepEqual(app.MountPoints, [{ ContainerPath: tokenDirectory, ReadOnly: true, SourceVolume: 'workload-tokens' }]);
      assert.deepEqual(agent.MountPoints, [{ ContainerPath: tokenDirectory, ReadOnly: false, SourceVolume: 'workload-tokens' }]);
      assert.deepEqual(task.Volumes, [{ Name: 'workload-tokens' }]);
      const variables = environment(agent);
      assert.equal(variables.HID_DEPLOYMENT_ENV, issuer);
      assert.equal(variables.WORKLOAD_SUBJECT, `hid:${issuer}:${app.Name}`);
      assert.equal(variables.WORKLOAD_TOKEN_DIRECTORY, tokenDirectory);
      const [apiId] = issuerApi(assembly, issuer);
      assert.equal(resolve(variables.WORKLOAD_ISSUER_URL), `https://REF:${apiId}.execute-api.REF:AWS::Region.REF:AWS::URLSuffix/${issuer}`);
      assert.equal(resolve(variables.WORKLOAD_JWKS_URL),
        `https://REF:${apiId}.execute-api.REF:AWS::Region.REF:AWS::URLSuffix/${issuer}/.well-known/jwks.json`);
      const files = JSON.parse(variables.WORKLOAD_TOKEN_FILES_JSON) as Array<{audience: string; file: string}>;
      assert.deepEqual(files.map(item => item.audience), expected[app.Name]);
      for (const item of files) assert.equal(item.file, `${item.audience.slice(4, -4)}.jwt`);
      const appFiles = Object.values(environment(app)).filter(value => typeof value === 'string' && value.startsWith(`${tokenDirectory}/`)).sort();
      assert.deepEqual(appFiles, files.map(item => `${tokenDirectory}/${item.file}`).sort());
    }
    const dockerfile = readFileSync(new URL('../../../services/identity-api/Dockerfile', import.meta.url), 'utf8');
    assert.match(dockerfile, /chown 65532:65532 \/var\/run\/hid\/workload-tokens/);
    assert.match(dockerfile, /VOLUME \["\/var\/run\/hid\/workload-tokens"\]/);
    const health = readFileSync(new URL('../../../services/workload-token-agent/src/health.mjs', import.meta.url), 'utf8');
    assert.match(health, /readFile/);
    assert.doesNotMatch(health, /TokenAgent|\.renew\(|\.clear\(|writeFile|unlink|rename/);
  });

  test(`${mode} the issuer stage is behind a REGIONAL web ACL that allows only the VPC's NAT addresses`, () => {
    const [apiId] = issuerApi(assembly, issuer);
    const stage = entries(assembly, 'AWS::ApiGateway::Stage').find(([, item]) => item.Properties?.RestApiId.Ref === apiId)!;
    const associations = entries(assembly, 'AWS::WAFv2::WebACLAssociation')
      .filter(([, item]) => JSON.stringify(item.Properties?.ResourceArn).includes(apiId));
    const nats = entries(assembly, 'AWS::EC2::NatGateway');
    if (mode === 'sleep') {
      // Sleep runs no task and has no NAT address to allow (D3).
      assert.equal(nats.length, 0);
      assert.equal(associations.length, 0);
      return;
    }
    assert.equal(associations.length, 1);
    const association = associations[0]![1].Properties!;
    assert.equal(resolve(association.ResourceArn),
      `arn:REF:AWS::Partition:apigateway:REF:AWS::Region::/restapis/REF:${apiId}/stages/REF:${stage[0]}`);
    const aclId = association.WebACLArn['Fn::GetAtt'][0];
    const acl = assembly.Resources[aclId]!.Properties!;
    assert.equal(assembly.Resources[aclId]!.Type, 'AWS::WAFv2::WebACL');
    assert.equal(acl.Scope, 'REGIONAL');
    assert.deepEqual(acl.DefaultAction, { Block: {} });
    assert.equal(acl.Rules.length, 1);
    const [rule] = acl.Rules;
    assert.deepEqual(rule.Action, { Allow: {} });
    assert.equal(rule.Priority, 0);
    const ipSetId = rule.Statement.IPSetReferenceStatement.Arn['Fn::GetAtt'][0];
    assert.equal(rule.Statement.IPSetReferenceStatement.IPSetForwardedIPConfig, undefined,
      'the allowlist must match the connection source, never a forwarded header');
    const ipSet = assembly.Resources[ipSetId]!;
    assert.equal(ipSet.Type, 'AWS::WAFv2::IPSet');
    assert.equal(ipSet.Properties!.Scope, 'REGIONAL');
    assert.equal(ipSet.Properties!.IPAddressVersion, 'IPV4');
    // Exactly the Elastic IPs of this VPC's NAT gateways, as /32 addresses.
    const natEips = nats.map(([, item]) => item.Properties!.AllocationId['Fn::GetAtt'][0]).sort();
    assert.equal(natEips.length, mode === 'economy' ? 1 : 2);
    for (const eip of natEips) assert.equal(assembly.Resources[eip]!.Type, 'AWS::EC2::EIP');
    assert.deepEqual(ipSet.Properties!.Addresses.map((address: any) => resolve(address)).sort(),
      natEips.map(eip => `ATT:${eip}.PublicIp/32`).sort());
  });

  test(`${mode} CloudFormation resource graph has no implicit or explicit cycle`, () => {
    const graph = new Map<string, Set<string>>();
    const refs = (value: any, found: Set<string>) => {
      if (!value || typeof value !== 'object') return;
      if (typeof value.Ref === 'string' && assembly.Resources[value.Ref]) found.add(value.Ref);
      const get = value['Fn::GetAtt'];
      if (get) { const id = typeof get === 'string' ? get.split('.')[0] : get[0]; if (assembly.Resources[id]) found.add(id); }
      const sub = value['Fn::Sub'];
      if (sub) for (const match of String(Array.isArray(sub) ? sub[0] : sub).matchAll(/\$\{([^.}!]+)(?:\.[^}]+)?\}/g)) {
        if (assembly.Resources[match[1]!]) found.add(match[1]!);
      }
      Object.values(value).forEach(item => { if (Array.isArray(item)) item.forEach(part => refs(part, found)); else refs(item, found); });
    };
    for (const [id, resource] of Object.entries(assembly.Resources)) {
      const dependencies = new Set(list(resource.DependsOn));
      refs(resource.Properties, dependencies); graph.set(id, dependencies);
    }
    const complete = new Set<string>();
    const visit = (id: string, path: string[]) => {
      assert(!path.includes(id), `CloudFormation dependency cycle: ${[...path, id].join(' -> ')}`);
      if (complete.has(id)) return;
      for (const dependency of graph.get(id) ?? []) visit(dependency, [...path, id]);
      complete.add(id);
    };
    for (const id of graph.keys()) visit(id, []);
  });
}
