import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { environmentConfig, identityBudgetInputs, type HidEnvironmentConfig } from '../src/config.js';
import { HidRegionalStack } from '../src/hid-regional-stack.js';
import { workloadNames } from '../src/workloads.js';

// Identity's patient-enrollment and in-person budgets and the QoreID timeout
// are optional synth inputs HID_<VARIABLE>. Left out, nothing is emitted and
// Identity keeps its own default; QOREID_TIMEOUT_MS stays 5000.
const productionTopic = { operationalAlarmTopicArn: 'arn:aws:sns:eu-west-1:000000000000:hid-production-operational-alerts' };
const budgets = [
  'PATIENT_ENROLLMENT_QOREID_DAILY_CAP', 'PATIENT_ENROLLMENT_QOREID_NETWORK_HOURLY_MAX',
  'PATIENT_ENROLLMENT_QOREID_NETWORK_DAILY_MAX', 'PATIENT_ENROLLMENT_START_RATE_MAX_REQUESTS',
  'ASSISTED_VERIFICATION_STAFF_DAILY_MAX', 'ASSISTED_VERIFICATION_FACILITY_DAILY_MAX',
] as const;
let stackCount = 0;

function containers(configuration: HidEnvironmentConfig): Map<string, Record<string, string>> {
  const template = Template.fromStack(new HidRegionalStack(new App(), `IdentityBudgets${stackCount++}`, { configuration }))
    .toJSON() as { readonly Resources: Record<string, { readonly Type: string; readonly Properties?: Record<string, unknown> }> };
  const result = new Map<string, Record<string, string>>();
  for (const resource of Object.values(template.Resources)) {
    if (resource.Type !== 'AWS::ECS::TaskDefinition') continue;
    for (const container of resource.Properties!.ContainerDefinitions as Array<{
      readonly Name: string; readonly Environment?: Array<{ readonly Name: string; readonly Value: unknown }>;
    }>) {
      result.set(container.Name, Object.fromEntries((container.Environment ?? [])
        .map((entry) => [entry.Name, typeof entry.Value === 'string' ? entry.Value : JSON.stringify(entry.Value)])));
    }
  }
  return result;
}

test('Identity keeps its own enrollment budgets and a 5000 ms QoreID timeout unless the operator sets an input', () => {
  for (const configuration of [environmentConfig('production', undefined, 'true', undefined, productionTopic),
    environmentConfig('staging', 'economy'), environmentConfig('development')]) {
    assert.deepEqual(configuration.identityBudgets, {});
    const identity = containers(configuration).get('identity-api')!;
    for (const name of budgets) assert.equal(identity[name], undefined, `${configuration.name}: ${name} is not emitted`);
    assert.equal(identity.QOREID_TIMEOUT_MS, '5000');
  }
});

test('each supplied budget and the QoreID timeout reach the Identity task exactly, and no other workload', () => {
  const supplied = {
    PATIENT_ENROLLMENT_QOREID_DAILY_CAP: '5000', PATIENT_ENROLLMENT_QOREID_NETWORK_HOURLY_MAX: '30',
    PATIENT_ENROLLMENT_QOREID_NETWORK_DAILY_MAX: '300', PATIENT_ENROLLMENT_START_RATE_MAX_REQUESTS: '20',
    ASSISTED_VERIFICATION_STAFF_DAILY_MAX: '40', ASSISTED_VERIFICATION_FACILITY_DAILY_MAX: '400',
    QOREID_TIMEOUT_MS: '8000',
  };
  const configuration = environmentConfig('production', undefined, 'true', undefined,
    { ...productionTopic, identityBudgets: supplied });
  assert.deepEqual(configuration.identityBudgets, Object.fromEntries(Object.entries(supplied)
    .map(([name, value]) => [name, Number(value)])));
  const tasks = containers(configuration);
  const identity = tasks.get('identity-api')!;
  for (const [name, value] of Object.entries(supplied)) assert.equal(identity[name], value, name);
  for (const name of workloadNames.filter((item) => item !== 'identity-api')) {
    assert.doesNotMatch(JSON.stringify(tasks.get(name)), /PATIENT_ENROLLMENT_|ASSISTED_VERIFICATION_|QOREID_TIMEOUT/, name);
  }
  // One input alone leaves the others to Identity.
  const capOnly = containers(environmentConfig('production', undefined, 'true', undefined,
    { ...productionTopic, identityBudgets: { PATIENT_ENROLLMENT_QOREID_DAILY_CAP: '1500' } })).get('identity-api')!;
  assert.equal(capOnly.PATIENT_ENROLLMENT_QOREID_DAILY_CAP, '1500');
  for (const name of budgets.filter((item) => item !== 'PATIENT_ENROLLMENT_QOREID_DAILY_CAP')) {
    assert.equal(capOnly[name], undefined, name);
  }
  assert.equal(capOnly.QOREID_TIMEOUT_MS, '5000');
});

test('the synth bounds and defaults are Identity\'s own and the 0085 quota command\'s', () => {
  const schema = readFileSync(new URL('../../../services/identity-api/src/config/environment.ts', import.meta.url), 'utf8');
  const names = Object.keys(identityBudgetInputs).sort();
  assert.deepEqual(names, [...budgets, 'QOREID_TIMEOUT_MS'].sort());
  for (const name of names) {
    const match = new RegExp(`\\b${name}: z\\.coerce\\.number\\(\\)\\.int\\(\\)\\.min\\(([\\d_]+)\\)\\.max\\(([\\d_]+)\\)\\.default\\(([\\d_]+)\\)`)
      .exec(schema);
    assert.ok(match, `${name} is an integer with bounds and a default in Identity's environment schema`);
    const [min, max, fallback] = match.slice(1, 4).map((value) => Number(value!.replaceAll('_', '')));
    assert.deepEqual(identityBudgetInputs[name as keyof typeof identityBudgetInputs], { min, max, default: fallback }, name);
  }
  const quota = readFileSync(new URL(
    '../../../services/ehr-api/database/migrations/0085_public_enrollment_windows_and_nin_lookup_quota.sql', import.meta.url), 'utf8');
  assert.match(quota, /network_hourly_limit not between 1 and 100\b/);
  assert.match(quota, /network_daily_limit not between network_hourly_limit and 1000\b/);
  assert.match(quota, /platform_daily_limit not between 1 and 100000\b/);
  assert.deepEqual(identityBudgetInputs.PATIENT_ENROLLMENT_QOREID_NETWORK_HOURLY_MAX, { min: 1, max: 100, default: 5 });
  assert.equal(identityBudgetInputs.PATIENT_ENROLLMENT_QOREID_NETWORK_DAILY_MAX.max, 1000);
  assert.deepEqual([identityBudgetInputs.PATIENT_ENROLLMENT_QOREID_DAILY_CAP.min,
    identityBudgetInputs.PATIENT_ENROLLMENT_QOREID_DAILY_CAP.max], [1, 100000]);
});

test('synthesis refuses a budget Identity or the quota command would refuse', () => {
  const refuse = (identityBudgets: Record<string, string>, message: RegExp) => assert.throws(
    () => environmentConfig('production', undefined, 'true', undefined, { ...productionTopic, identityBudgets }), message,
    JSON.stringify(identityBudgets));
  for (const name of [...budgets, 'QOREID_TIMEOUT_MS']) {
    for (const value of ['', ' 5', '5 ', 'abc', '1.5', '1e3', '-1', '0', '05', '+5', '0x10']) {
      refuse({ [name]: value }, new RegExp(`HID_${name} must be a whole number from \\d+ to \\d+`));
    }
    const { max } = identityBudgetInputs[name as keyof typeof identityBudgetInputs];
    refuse({ [name]: String(max + 1) }, new RegExp(`HID_${name} must be a whole number from \\d+ to ${max}\\b`));
  }
  refuse({ QOREID_TIMEOUT_MS: '249' }, /HID_QOREID_TIMEOUT_MS must be a whole number from 250 to 10000/);
  // Hourly <= daily and staff <= facility, against Identity's default for an
  // input left out (5 and 15, 20 and 100).
  refuse({ PATIENT_ENROLLMENT_QOREID_NETWORK_HOURLY_MAX: '20' },
    /HID_PATIENT_ENROLLMENT_QOREID_NETWORK_HOURLY_MAX \(20\) cannot exceed .*NETWORK_DAILY_MAX \(15/);
  refuse({ PATIENT_ENROLLMENT_QOREID_NETWORK_DAILY_MAX: '4' },
    /HID_PATIENT_ENROLLMENT_QOREID_NETWORK_HOURLY_MAX \(5.*\) cannot exceed .*NETWORK_DAILY_MAX \(4\)/);
  refuse({ PATIENT_ENROLLMENT_QOREID_NETWORK_HOURLY_MAX: '50', PATIENT_ENROLLMENT_QOREID_NETWORK_DAILY_MAX: '40' },
    /cannot exceed/);
  refuse({ ASSISTED_VERIFICATION_STAFF_DAILY_MAX: '150' },
    /HID_ASSISTED_VERIFICATION_FACILITY_DAILY_MAX \(100.*\) cannot be below .*STAFF_DAILY_MAX \(150\)/);
  refuse({ ASSISTED_VERIFICATION_FACILITY_DAILY_MAX: '10' }, /cannot be below/);
  refuse({ UNKNOWN_LIMIT: '5' }, /UNKNOWN_LIMIT is not an Identity budget synth input/);
  // The edges are accepted.
  const edges = environmentConfig('production', undefined, 'true', undefined, { ...productionTopic, identityBudgets: {
    PATIENT_ENROLLMENT_QOREID_DAILY_CAP: '100000', PATIENT_ENROLLMENT_QOREID_NETWORK_HOURLY_MAX: '100',
    PATIENT_ENROLLMENT_QOREID_NETWORK_DAILY_MAX: '100', PATIENT_ENROLLMENT_START_RATE_MAX_REQUESTS: '1',
    ASSISTED_VERIFICATION_STAFF_DAILY_MAX: '200', ASSISTED_VERIFICATION_FACILITY_DAILY_MAX: '200', QOREID_TIMEOUT_MS: '250',
  } });
  assert.equal(edges.identityBudgets.PATIENT_ENROLLMENT_QOREID_NETWORK_DAILY_MAX, 100);
});

test('the regional stack refuses a hand-built configuration with a budget out of bounds', () => {
  const production = environmentConfig('production', undefined, 'true', undefined, productionTopic);
  for (const [label, identityBudgets, message] of [
    ['hourly above the default daily', { PATIENT_ENROLLMENT_QOREID_NETWORK_HOURLY_MAX: 50 }, /cannot exceed/],
    ['cap above the quota command', { PATIENT_ENROLLMENT_QOREID_DAILY_CAP: 100001 }, /from 1 to 100000/],
    ['fractional timeout', { QOREID_TIMEOUT_MS: 1000.5 }, /from 250 to 10000/],
  ] as const) {
    assert.throws(() => new HidRegionalStack(new App(), `IdentityBudgetsRefused${stackCount++}`, {
      configuration: { ...production, identityBudgets } }), message, label);
  }
});
