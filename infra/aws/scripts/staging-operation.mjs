#!/usr/bin/env node
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

const operation = process.argv[2]
const operations = {
  start: { profile: 'economy', action: 'deploy', startsDatabase: true },
  sleep: { profile: 'sleep', action: 'deploy', stopsDatabase: true },
  'fidelity-enable': { profile: 'fidelity', action: 'deploy', startsDatabase: true },
  'fidelity-disable': { profile: 'economy', action: 'deploy', startsDatabase: true },
  teardown: { profile: 'sleep', action: 'destroy' },
}
const selected = operations[operation]
assert.ok(selected, `unknown staging operation ${operation ?? 'unset'}`)

const root = resolve(import.meta.dirname, '..')
const repository = resolve(root, '..', '..')
const account = required('HID_AWS_ACCOUNT', /^[0-9]{12}$/)
const region = required('HID_AWS_REGION', /^[a-z]{2}(?:-gov)?-[a-z]+-[0-9]$/)
const releaseSha = required('HID_RELEASE_SHA', /^[a-f0-9]{40}$/)
const expectedConfirmation = `HID-STAGING:${operation}:${account}:${region}:${releaseSha}`
assert.equal(process.env.HID_CONFIRM, expectedConfirmation,
  `HID_CONFIRM must equal ${expectedConfirmation}`)
for (const acknowledgement of [
  'HID_READINESS_ACK', 'HID_MIGRATIONS_ACK', 'HID_QUEUES_DRAINED_ACK',
  'HID_OUTBOX_DRAINED_ACK', 'HID_BILLING_SUMMARY_ACK',
]) assert.equal(process.env[acknowledgement], 'true', `${acknowledgement}=true is required`)
assert.equal(process.env.HID_OPERATION_EXECUTE, 'true',
  'HID_OPERATION_EXECUTE=true is required; this command never deploys from its name alone')

const currentSha = capture('git', ['rev-parse', 'HEAD'], repository)
assert.equal(currentSha, releaseSha, 'HID_RELEASE_SHA must be the checked-out release source')
assert.notEqual(capture('git', ['branch', '--show-current'], repository), 'main',
  'staging operations are forbidden from main')
assert.equal(capture('git', ['status', '--porcelain'], repository), '',
  'staging operations require a clean release-source worktree')
const caller = JSON.parse(capture('aws', ['sts', 'get-caller-identity', '--output', 'json', '--region', region], root))
assert.equal(caller.Account, account, 'AWS caller account does not match HID_AWS_ACCOUNT')

const databaseId = 'hid-staging-postgres'
const databaseStatus = capture('aws', ['rds', 'describe-db-instances', '--db-instance-identifier', databaseId,
  '--query', 'DBInstances[0].DBInstanceStatus', '--output', 'text', '--region', region], root)
process.stdout.write(JSON.stringify({ operation, account, region, releaseSha,
  targetProfile: selected.profile, databaseStatus,
  readiness: 'acknowledged', migrations: 'acknowledged', queues: 'drained', outbox: 'drained',
  billingSummary: 'reviewed; consult infra/aws/cost-inventory.json; sleep is not zero cost',
}, null, 2) + '\n')

const env = { ...process.env, HID_INFRA_ENV: 'staging', HID_STAGING_MODE: selected.profile,
  HID_COST_GOVERNANCE_ENABLED: 'false' }
run(process.execPath, ['scripts/synth.mjs'], root, env)
const cdk = resolve(root, 'node_modules', 'aws-cdk', 'bin', 'cdk')
run(process.execPath, [cdk, 'diff', 'Hid-staging-Regional', '--no-lookups'], root, env)

if (selected.startsDatabase && databaseStatus === 'stopped') {
  run('aws', ['rds', 'start-db-instance', '--db-instance-identifier', databaseId, '--region', region], root)
  run('aws', ['rds', 'wait', 'db-instance-available', '--db-instance-identifier', databaseId, '--region', region], root)
}

const extraArgs = process.env.HID_CDK_EXTRA_ARGS_JSON
  ? JSON.parse(process.env.HID_CDK_EXTRA_ARGS_JSON) : []
assert.ok(Array.isArray(extraArgs) && extraArgs.every((value) => typeof value === 'string'),
  'HID_CDK_EXTRA_ARGS_JSON must be a JSON array of CDK argument strings')
if (selected.action === 'deploy') {
  run(process.execPath, [cdk, 'deploy', 'Hid-staging-Regional', '--no-lookups',
    '--require-approval', 'never', ...extraArgs], root, env)
} else {
  assert.equal(process.env.HID_TEARDOWN_CONFIRM, `DELETE-EPHEMERAL-HID-STAGING:${releaseSha}`,
    'the exact HID_TEARDOWN_CONFIRM is required for teardown')
  run(process.execPath, [cdk, 'destroy', 'Hid-staging-Regional', '--force'], root, env)
}

if (selected.stopsDatabase) {
  const current = capture('aws', ['rds', 'describe-db-instances', '--db-instance-identifier', databaseId,
    '--query', 'DBInstances[0].DBInstanceStatus', '--output', 'text', '--region', region], root)
  if (current === 'available') {
    run('aws', ['rds', 'stop-db-instance', '--db-instance-identifier', databaseId, '--region', region], root)
  } else if (current !== 'stopped' && current !== 'stopping') {
    throw new Error(`refusing to stop RDS from unexpected state ${current}`)
  }
}

function required(name, pattern) {
  const value = process.env[name]
  assert.ok(value && pattern.test(value), `${name} is required and invalid`)
  return value
}

function capture(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', env: process.env })
  if (result.status !== 0) throw new Error(`${command} failed: ${(result.stderr || result.stdout).trim()}`)
  return result.stdout.trim()
}

function run(command, args, cwd, env = process.env) {
  const result = spawnSync(command, args, { cwd, env, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} exited ${result.status}`)
}
