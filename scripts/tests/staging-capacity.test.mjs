import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { assessStagingCapacity } from '../../infra/aws/scripts/assess-staging-capacity.mjs';

function fixture(desired = 1, ceiling = 2, percent = 200) {
  const bytes = Buffer.from(JSON.stringify({ Resources: {
    AppTask: { Type: 'AWS::ECS::TaskDefinition', Properties: { Cpu: '512' } },
    MigrationTaskDefinition: { Type: 'AWS::ECS::TaskDefinition', Properties: { Cpu: '512' } },
    AppService: { Type: 'AWS::ECS::Service', Properties: { TaskDefinition: { Ref: 'AppTask' },
      DesiredCount: { Ref: 'AppDesiredCount' }, DeploymentConfiguration: { MaximumPercent: percent } } },
  } }));
  const plan = { environment: 'staging', stack: 'Hid-staging-Regional', aws_account: '659225405023',
    aws_region: 'eu-west-1', template_sha256: createHash('sha256').update(bytes).digest('hex'),
    parameters: { AppDesiredCount: { value: desired }, AppScalingCeiling: { value: ceiling },
      SecretParameter: { value: 'PRIVATE_SENTINEL' } } };
  const quota = { account_id: plan.aws_account, region: plan.aws_region, quota_code: 'L-3032A538',
    value: 2, checked_at: '2026-09-14T00:00:00Z' };
  return { bytes, plan, quota };
}

test('includes rolling replacements at scaling ceiling and one migration task without serializing unrelated parameters', () => {
  const f = fixture(); const r = assessStagingCapacity(f.bytes, f.plan, f.quota);
  assert.equal(r.desired_vcpu, 0.5); assert.equal(r.configured_ceiling_vcpu, 1);
  assert.equal(r.full_rollout_plus_migration_vcpu, 2.5);
  assert.equal(r.minimum_whole_vcpu_for_staging_envelope, 3);
  assert.equal(r.configured_envelope_exceeds_quota, true);
  assert.equal(r.deployment_authorized, false);
  assert(!JSON.stringify(r).includes('PRIVATE_SENTINEL'));
});

test('zero desired services still reserve configured scaling and round the deployment task upper bound down', () => {
  const f = fixture(0, 3, 125); const r = assessStagingCapacity(f.bytes, f.plan, f.quota);
  assert.deepEqual(r.zero_desired_services, ['AppDesiredCount']);
  assert.equal(r.desired_vcpu, 0); assert.equal(r.simultaneous_ceiling_rollout_vcpu, 1.5);
  assert.equal(r.configured_envelope_exceeds_quota, false);
  assert.equal(r.status, 'USAGE_AND_LIVE_CAPACITY_CHECK_REQUIRED');
});

test('wrong account, production, mismatched source bytes, unresolved counts and malformed quota fail closed', () => {
  for (const modify of [
    f => { f.plan.environment = 'production'; }, f => { f.plan.aws_account = '000000000000'; },
    f => { f.quota.region = 'us-east-1'; }, f => { f.quota.quota_code = 'another-quota'; },
    f => { f.quota.value = -1; }, f => { f.plan.template_sha256 = '0'.repeat(64); },
    f => { f.plan.parameters.AppDesiredCount.value = null; },
    f => { f.plan.parameters.AppScalingCeiling.value = 0; },
  ]) { const f = fixture(); modify(f); assert.throws(() => assessStagingCapacity(f.bytes, f.plan, f.quota)); }
});
