import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { environmentConfig } from '../src/config.js';
import { HidRegionalStack } from '../src/hid-regional-stack.js';

interface Resource { Type: string; Properties?: Record<string, any>; DependsOn?: string | string[]; DeletionPolicy?: string }
interface Assembly { Resources: Record<string, Resource> }
const expected: Readonly<Record<string, readonly string[]>> = {
  'identity-api': ['hid-notification-api'],
  'ehr-api': ['hid-identity-api', 'hid-lab-api', 'hid-pharmacy-api'],
  'lab-api': ['hid-identity-api'],
  'pharmacy-api': ['hid-identity-api'],
  'ocr-api': ['hid-identity-api', 'hid-ehr-api', 'hid-lab-api', 'hid-pharmacy-api'],
  'outreach-api': ['hid-identity-api'],
};
const tokenDirectory = '/var/run/hid/workload-tokens';
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

test('issuer is absent from production and development templates', () => {
  for (const assembly of [production, development]) {
    assert.equal(entries(assembly, 'AWS::ApiGateway::RestApi').filter(([, r]) => r.Properties?.Name === 'hid-staging-workload-identity').length, 0);
    assert.equal(entries(assembly, 'AWS::Lambda::Function').filter(([, r]) => r.Properties?.FunctionName === 'hid-staging-workload-issuer').length, 0);
    assert(!JSON.stringify(assembly).includes('workload-token-agent'));
    assert(!JSON.stringify(assembly).includes('alias/hid-staging-workload-signing'));
  }
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

for (const [mode, assembly] of [['economy', economy], ['fidelity', fidelity], ['sleep', sleep]] as const) {
  test(`${mode} token minting is IAM authenticated; only JWKS is public`, () => {
    const apis = entries(assembly, 'AWS::ApiGateway::RestApi').filter(([, item]) => item.Properties?.Name === 'hid-staging-workload-identity');
    assert.equal(apis.length, 1);
    const apiId = apis[0]![0];
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
    assert.equal(stages[0]![1].Properties!.StageName, 'staging');
    const settings = stages[0]![1].Properties!.MethodSettings;
    assert(settings.every((setting: any) => setting.DataTraceEnabled === false && setting.LoggingLevel === 'OFF'));
    assert(settings.every((setting: any) => setting.ThrottlingRateLimit === 30 && setting.ThrottlingBurstLimit === 60));
    const issuer = entries(assembly, 'AWS::Lambda::Function').find(([, r]) => r.Properties?.FunctionName === 'hid-staging-workload-issuer')!;
    const permissions = entries(assembly, 'AWS::Lambda::Permission').filter(([, r]) => JSON.stringify(r.Properties?.FunctionName).includes(issuer[0]));
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
  });

  test(`${mode} exactly six caller roles mint only eleven approved subject/audience bindings`, () => {
    const issuer = entries(assembly, 'AWS::Lambda::Function').find(([, r]) => r.Properties?.FunctionName === 'hid-staging-workload-issuer')![1].Properties!;
    const variables = issuer.Environment.Variables;
    assert.equal(variables.HID_DEPLOYMENT_ENV, 'staging');
    const policy = JSON.parse(resolve(variables.WORKLOAD_CALLER_POLICY_JSON)) as any[];
    assert.equal(policy.length, 6);
    assert.equal(new Set(policy.map(item => item.roleArn)).size, 6);
    assert.equal(policy.reduce((count, item) => count + item.audiences.length, 0), 11);
    assert.deepEqual(Object.fromEntries(policy.map(item => [item.subject.replace('hid:staging:', ''), item.audiences])), expected);
    for (const [name, audiences] of Object.entries(expected)) {
      const task = namedTask(assembly, name);
      const rule = policy.find(item => item.subject === `hid:staging:${name}`)!;
      assert.equal(rule.roleArn, resolve(task.TaskRoleArn));
      assert.deepEqual(rule.audiences, audiences);
      const actions = roleStatements(assembly, roleId(task));
      const invocation = actions.filter(statement => list(statement.Action).includes('execute-api:Invoke'));
      assert.equal(invocation.length, 1);
      assert.equal(list(invocation[0].Resource).length, 1);
      assert.match(resolve(invocation[0].Resource), /\/staging\/POST\/token$/);
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
    assert.equal(key.Properties!.KeySpec, 'ECC_NIST_P256');
    assert.equal(key.DeletionPolicy, 'Retain');
    const issuer = entries(assembly, 'AWS::Lambda::Function').find(([, r]) => r.Properties?.FunctionName === 'hid-staging-workload-issuer')![1].Properties!;
    const role = issuer.Role['Fn::GetAtt'][0];
    const signed = entries(assembly, 'AWS::IAM::Policy').flatMap(([, item]) => item.Properties!.PolicyDocument.Statement
      .filter((statement: any) => list(statement.Action).includes('kms:Sign'))
      .map((statement: any) => ({ roles: item.Properties!.Roles, statement })));
    assert.equal(signed.length, 1);
    assert.deepEqual(signed[0]!.roles, [{ Ref: role }]);
    assert.deepEqual(signed[0]!.statement.Resource, { 'Fn::GetAtt': [keyId, 'Arn'] });
    assert.deepEqual(signed[0]!.statement.Condition, { StringEquals: { 'kms:SigningAlgorithm': 'ECDSA_SHA_256' } });
    assert(!JSON.stringify(issuer.Environment).includes('PRIVATE_KEY'));
  });

  test(`${mode} receiving services enforce the same issuer and exact caller subject mappings`, () => {
    const issuer = entries(assembly, 'AWS::Lambda::Function').find(([, r]) => r.Properties?.FunctionName === 'hid-staging-workload-issuer')![1].Properties!;
    const url = resolve(issuer.Environment.Variables.WORKLOAD_ISSUER_URL);
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
      for (const [parameter, caller] of Object.entries(receiver.callers)) assert.equal(variables[parameter], `hid:staging:${caller}`);
      for (const [key, value] of Object.entries(variables)) {
        if (key.endsWith('IDENTITY_MODE')) assert.equal(value, 'jwt', `${name} must not permit a shared-secret fallback`);
      }
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
      assert.equal(agent.Essential, true);
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
      assert.equal(variables.HID_DEPLOYMENT_ENV, 'staging');
      assert.equal(variables.WORKLOAD_SUBJECT, `hid:staging:${app.Name}`);
      assert.equal(variables.WORKLOAD_TOKEN_DIRECTORY, tokenDirectory);
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
