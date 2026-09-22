#!/usr/bin/env node
// Offline capacity review only. Does not resolve credentials or change AWS resources.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function assessStagingCapacity(templateBytes, plan, quota) {
  assert(plan.environment === 'staging' && plan.stack === 'Hid-staging-Regional'
    && plan.aws_account === '659225405023' && plan.aws_region === 'eu-west-1', 'Staging plan identity rejected');
  assert(quota.account_id === plan.aws_account && quota.region === plan.aws_region
    && quota.quota_code === 'L-3032A538', 'Quota identity rejected');
  assert(Number.isFinite(quota.value) && quota.value > 0, 'Quota value rejected');
  const sha256 = createHash('sha256').update(templateBytes).digest('hex');
  assert.equal(plan.template_sha256, sha256, 'Plan/template digest mismatch');
  const { Resources: resources } = JSON.parse(templateBytes.toString());
  const count = ref => {
    assert(ref && typeof ref.Ref === 'string', 'Explicit count parameter required');
    const input = plan.parameters[ref.Ref];
    const value = input && typeof input === 'object' ? input.value : input;
    assert(Number.isSafeInteger(value) && value >= 0, 'Count parameter unresolved');
    return value;
  };
  const taskCpu = id => {
    const task = resources[id];
    assert(task?.Type === 'AWS::ECS::TaskDefinition', 'Task definition unresolved');
    const units = Number(task.Properties.Cpu);
    assert(Number.isSafeInteger(units) && units > 0, 'Task CPU unresolved');
    return units / 1024;
  };
  const referenced = new Set();
  const services = Object.entries(resources).filter(([, value]) => value.Type === 'AWS::ECS::Service').map(([id, value]) => {
    const p = value.Properties;
    assert(p.TaskDefinition?.Ref && p.DesiredCount?.Ref?.endsWith('DesiredCount'), 'Service binding unresolved');
    referenced.add(p.TaskDefinition.Ref);
    const desired = count(p.DesiredCount);
    const ceiling = count({ Ref: p.DesiredCount.Ref.replace(/DesiredCount$/, 'ScalingCeiling') });
    assert(ceiling >= desired, 'Scaling ceiling below desired count');
    const percent = p.DeploymentConfiguration?.MaximumPercent;
    assert(Number.isSafeInteger(percent) && percent >= 100 && percent <= 200, 'Deployment maximum unresolved');
    const cpu = taskCpu(p.TaskDefinition.Ref);
    return { service: id, desired_parameter: p.DesiredCount.Ref, desired_tasks: desired,
      ceiling_tasks: ceiling, vcpu_per_task: cpu, maximum_percent: percent,
      desired_vcpu: desired * cpu, ceiling_vcpu: ceiling * cpu,
      desired_rollout_vcpu: Math.floor(desired * percent / 100) * cpu,
      ceiling_rollout_vcpu: Math.floor(ceiling * percent / 100) * cpu };
  });
  assert(services.length > 0, 'No services found');
  const standalone = Object.entries(resources).filter(([id, r]) => r.Type === 'AWS::ECS::TaskDefinition' && !referenced.has(id));
  assert(standalone.length === 1 && standalone[0][0].startsWith('MigrationTaskDefinition'), 'Standalone migration task unresolved');
  const migration = taskCpu(standalone[0][0]);
  const sum = key => services.reduce((n, row) => n + row[key], 0);
  const required = sum('ceiling_rollout_vcpu') + migration;
  return { schema_version: 'hid.staging-capacity-review/v1', environment: 'staging',
    account_id: plan.aws_account, region: plan.aws_region, template_sha256: sha256,
    deployment_authorized: false, staging_accepted: false, cloud_calls: false,
    quota_vcpu: quota.value, quota_observed_at: quota.checked_at,
    existing_account_usage: 'unverified; do not interpret missing metric datapoints as zero',
    desired_vcpu: sum('desired_vcpu'), desired_rollout_vcpu: sum('desired_rollout_vcpu'),
    configured_ceiling_vcpu: sum('ceiling_vcpu'), simultaneous_ceiling_rollout_vcpu: sum('ceiling_rollout_vcpu'),
    one_migration_task_vcpu: migration, full_rollout_plus_migration_vcpu: required,
    minimum_whole_vcpu_for_staging_envelope: Math.ceil(required),
    configured_envelope_exceeds_quota: required > quota.value,
    status: required > quota.value ? 'QUOTA_INCREASE_REQUIRED_FOR_CONFIGURED_ENVELOPE' : 'USAGE_AND_LIVE_CAPACITY_CHECK_REQUIRED',
    zero_desired_services: services.filter(row => row.desired_tasks === 0).map(row => row.desired_parameter),
    services };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    assert.equal(args.length, 3, 'Expected template, parameter plan and quota receipt');
    const [template, plan, quota] = await Promise.all(args.map(path => readFile(path)));
    const result = assessStagingCapacity(template, JSON.parse(plan.toString()), JSON.parse(quota.toString()));
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } catch {
    process.stderr.write('Staging capacity inputs rejected; no cloud operation performed\n');
    process.exitCode = 1;
  }
}
