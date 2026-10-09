import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createPublicKey } from 'node:crypto'
import { parse as yaml } from 'yaml'
import { writeRepository, digest, signedEnvelope } from '../../infra/cloudflare/test/helpers/tuf-repository-fixture.mjs'
import { signerConfig, signerProvenance, signerPolicy, signerClaims, prepareSignerRequest, validatePreparedRequest, submitSignerRequest, reserveSigningAttempt } from '../scripts/submit-staging-signing-request.mjs'

const source = 'a'.repeat(40), workflow = 'b'.repeat(40)
const config = (role = 'snapshot', candidate = 'one') => ({ schema_version: 'hid.staging-signing-submission/v1', environment: 'staging', role, candidate,
  source_sha: source, workflow_sha: workflow, caller_workflow_path: '.github/workflows/staging-fixture-caller.yml', aws_account_id: '659225405023', aws_region: 'eu-west-1',
  submitter_role_arn: `arn:aws:iam::659225405023:role/Hid-staging-ReleaseTrust-${role[0].toUpperCase() + role.slice(1)}Signer${candidate[0].toUpperCase() + candidate.slice(1)}Role`,
  broker_version_arn: `arn:aws:lambda:eu-west-1:659225405023:function:hid-staging-tuf-broker-${role}-${candidate}:7`,
  candidate_spki_sha256: 'f'.repeat(64),
  request_bucket: 'hid-staging-evidence-fixture', storage_kms_key_arn: 'arn:aws:kms:eu-west-1:659225405023:key/00000000-0000-4000-8000-000000000001',
  release_id: `r0000000001-g${source}`, root_version: 1, root_sha256: 'c'.repeat(64), input_version: 1, input_sha256: 'd'.repeat(64),
  request_lifetime_seconds: role === 'snapshot' ? 96 * 3600 : 12 * 3600,
  producer: { run_id: '123', artifact_id: '456', artifact_digest: 'sha256:' + 'e'.repeat(64), workflow_path: '.github/workflows/staging-input-fixture.yml' } })
const context = c => ({ GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'D-Eminence/hid-system', GITHUB_REPOSITORY_ID: '1317340803', GITHUB_REPOSITORY_OWNER_ID: '182018869',
  GITHUB_REF: 'refs/heads/tuf-production-release', GITHUB_REF_TYPE: 'branch', GITHUB_REF_PROTECTED: 'true', GITHUB_RUN_ATTEMPT: '1', RUNNER_ENVIRONMENT: 'github-hosted',
  GITHUB_SHA: source, GITHUB_WORKFLOW_SHA: source, APPROVED_SOURCE_SHA: source, REQUESTED_SOURCE_SHA: source, APPROVED_WORKFLOW_SHA: workflow,
  SUBMITTER_ROLE_ARN: c.submitter_role_arn, HID_SIGNING_ROLE: c.role, HID_SIGNING_CANDIDATE: c.candidate,
  GITHUB_WORKFLOW_REF: `D-Eminence/hid-system/${c.caller_workflow_path}@refs/heads/tuf-production-release`,
  GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_RUN_ID: '789', GITHUB_ACTOR_ID: '182018869' })
const run = c => ({ id: 123, run_attempt: 1, status: 'completed', conclusion: 'success', event: 'push', head_sha: source, head_branch: 'tuf-production-release', path: c.producer.workflow_path,
  repository: { id: 1317340803, full_name: 'D-Eminence/hid-system', owner: { id: 182018869 } }, head_repository: { id: 1317340803 } })
const artifact = c => ({ id: 456, expired: false, size_in_bytes: 1000, digest: c.producer.artifact_digest,
  workflow_run: { id: 123, head_sha: source, head_branch: 'tuf-production-release', repository_id: 1317340803, head_repository_id: 1317340803 } })
const policy = c => ({ name: `staging-${c.role}-signer-${c.candidate}`, id: 9, can_admins_bypass: false,
  deployment_branch_policy: { protected_branches: true, custom_branch_policies: false },
  protection_rules: [{ type: 'required_reviewers', prevent_self_review: false, reviewers: [{ type: 'User', reviewer: { id: 182018869, login: 'D-Eminence' } }] }] })
const claims = (c, e, now) => ({ iss: 'https://token.actions.githubusercontent.com', aud: 'sts.amazonaws.com', repository: e.GITHUB_REPOSITORY,
  repository_id: '1317340803', repository_owner_id: '182018869', ref: e.GITHUB_REF, ref_type: 'branch', environment: `staging-${c.role}-signer-${c.candidate}`,
  sub: `repo:D-Eminence/hid-system:environment:staging-${c.role}-signer-${c.candidate}`, sha: source, job_workflow_sha: workflow,
  job_workflow_ref: `D-Eminence/hid-system/.github/workflows/tuf-${c.role}-signer-${c.candidate}.yml@${workflow}`, workflow_ref: e.GITHUB_WORKFLOW_REF,
  runner_environment: 'github-hosted', run_id: '789', run_attempt: '1', actor_id: '182018869', event_name: 'workflow_dispatch', iat: now / 1000 - 10, exp: now / 1000 + 290 })

test('all four capabilities bind actual staging config source workflow role and producer', () => {
  for (const role of ['snapshot', 'timestamp']) for (const candidate of ['one', 'two']) {
    const c = config(role, candidate), e = context(c), bytes = JSON.stringify(c), now = 1800000000000
    assert.deepEqual(signerConfig(bytes, digest(bytes), e), c)
    signerProvenance(c, run(c), artifact(c)); signerPolicy(c, policy(c)); signerClaims(c, e, claims(c, e, now), now)
    for (const field of Object.keys(claims(c, e, now)).filter(k => !['iat', 'exp'].includes(k))) {
      assert.throws(() => signerClaims(c, e, { ...claims(c, e, now), [field]: 'wrong' }, now), field)
    }
  }
})

test('production cross-account cross-candidate stale-source mutable-version and placeholder inputs fail before authority', () => {
  for (const edit of [c => { c.environment = 'production' }, c => { c.aws_region = 'us-east-1' }, c => { c.aws_account_id = '000000000000' },
    c => { c.workflow_sha = null }, c => { c.source_sha = 'f'.repeat(40) }, c => { c.extra = true },
    c => { c.broker_version_arn = c.broker_version_arn.replace(':7', ':live') }, c => { c.broker_version_arn = c.broker_version_arn.replace('snapshot-one', 'snapshot-two') },
    c => { c.submitter_role_arn = c.submitter_role_arn.replace('SnapshotSignerOne', 'SnapshotSignerTwo') }, c => { c.request_bucket = 'hid-production-data' },
    c => { c.request_lifetime_seconds = 72 * 3600 }, c => { c.producer.artifact_digest = null }]) {
    const c = config(); edit(c); const bytes = JSON.stringify(c); assert.throws(() => signerConfig(bytes, digest(bytes), context(config())))
  }
  const c = config(), bytes = JSON.stringify(c)
  for (const change of [{ GITHUB_EVENT_NAME: 'pull_request' }, { GITHUB_RUN_ATTEMPT: '2' }, { GITHUB_REF_PROTECTED: 'false' },
    { HID_SIGNING_CANDIDATE: 'two' }, { GITHUB_WORKFLOW_REF: 'other' }]) assert.throws(() => signerConfig(bytes, digest(bytes), { ...context(c), ...change }))
  assert.throws(() => signerConfig(bytes, 'f'.repeat(64), context(c)))
  const duplicate = bytes.replace('"environment":"staging"', '"environment":"staging","environment":"staging"')
  assert.throws(() => signerConfig(duplicate, digest(duplicate), context(c)))
  for (const changed of [{ run_attempt: 2 }, { conclusion: 'failure' }, { head_sha: 'f'.repeat(40) }, { event: 'pull_request' }]) assert.throws(() => signerProvenance(c, { ...run(c), ...changed }, artifact(c)))
  for (const changed of [{ expired: true }, { digest: 'sha256:' + 'f'.repeat(64) }, { id: 99 }]) assert.throws(() => signerProvenance(c, run(c), { ...artifact(c), ...changed }))
  assert.throws(() => signerPolicy(c, { ...policy(c), can_admins_bypass: true }))
})

async function fixture(role = 'snapshot', candidate = 'one') {
  const f = await writeRepository('staging'), directory = resolve(f.repository, 'input')
  await mkdir(directory)
  const root = await readFile(resolve(f.repository, 'metadata/1.root.json'))
  const inputRole = role === 'snapshot' ? 'targets' : 'snapshot'
  const input = await readFile(resolve(f.repository, `metadata/1.${inputRole}.json`))
  await writeFile(resolve(directory, '1.root.json'), root); await writeFile(resolve(directory, `1.${inputRole}.json`), input)
  const signer = f.signers[role][candidate === 'one' ? 0 : 1]
  return { ...f, signer, directory, c: { ...config(role, candidate), root_sha256: digest(root), input_sha256: digest(input),
    candidate_spki_sha256: digest(createPublicKey(signer.key.keyval.public).export({ type: 'spki', format: 'der' })) } }
}

test('fresh request preparation preserves exact signed bytes and canonical Go request field order for all capabilities', async () => {
  for (const role of ['snapshot', 'timestamp']) for (const candidate of ['one', 'two']) {
    const f = await fixture(role, candidate)
    try {
      const now = Date.now(), bytes = await prepareSignerRequest(f.c, f.directory, now), request = validatePreparedRequest(f.c, bytes, now)
      const goTypes = await readFile(new URL('../../tools/tuf-release/internal/signingbroker/types.go', import.meta.url), 'utf8')
      const goRequest = goTypes.match(/type Request struct \{([\s\S]*?)\n\}/)[1]
      const goFieldOrder = [...goRequest.matchAll(/json:"([a-z_0-9]+)"/g)].map(match => match[1])
      assert.deepEqual(Object.keys(request), goFieldOrder, 'request bytes must retain the actual Go broker struct field order')
      assert.equal(request.role, role); assert.equal(request.environment, 'staging')
      assert.equal(digest(Buffer.from(request.root, 'base64')), f.c.root_sha256)
      assert.equal(digest(Buffer.from(request.input_metadata, 'base64')), f.c.input_sha256)
      assert.throws(() => validatePreparedRequest(f.c, Buffer.concat([bytes, Buffer.from('\n')]), now))
      assert.throws(() => validatePreparedRequest(f.c, bytes, now + 301000))
      assert.throws(() => validatePreparedRequest(f.c, bytes, now - 61000))
      assert.throws(() => validatePreparedRequest({ ...f.c, candidate, role: role === 'snapshot' ? 'timestamp' : 'snapshot' }, bytes, now))
    } finally { await rm(f.repository, { recursive: true, force: true }) }
  }
})

test('input hash signature threshold closure and symlink substitution fail before S3', async () => {
  const f = await fixture()
  try {
    await assert.rejects(prepareSignerRequest({ ...f.c, input_sha256: 'f'.repeat(64) }, f.directory))
    await writeFile(resolve(f.directory, 'unexpected'), 'data'); await assert.rejects(prepareSignerRequest(f.c, f.directory)); await rm(resolve(f.directory, 'unexpected'))
    const path = resolve(f.directory, '1.targets.json'), bytes = await readFile(path), bad = JSON.parse(bytes)
    bad.signatures[0].sig = '00'.repeat(64)
    const tampered = Buffer.from(JSON.stringify(bad)); await writeFile(path, tampered)
    await assert.rejects(prepareSignerRequest({ ...f.c, input_sha256: digest(tampered) }, f.directory), /threshold/)
    await rm(path); await symlink(resolve(f.repository, 'metadata/1.targets.json'), path)
    await assert.rejects(prepareSignerRequest(f.c, f.directory))
  } finally { await rm(f.repository, { recursive: true, force: true }) }
})

function transportFixture(c, requestBytes, signer) {
  const calls = [], sha = digest(requestBytes), r = JSON.parse(requestBytes)
  const output = signedEnvelope({ _type: c.role, spec_version: '1.0.31', version: 1, expires: r.expires,
    meta: { [c.role === 'snapshot' ? 'targets.json' : 'snapshot.json']: { version: c.input_version,
      length: Buffer.from(r.input_metadata, 'base64').length, hashes: { sha256: c.input_sha256 } } } }, [signer])
  const object = { bucket: c.request_bucket, key: `tuf-signing-broker/requests/hid-staging-broker-v1/${c.role}-${c.candidate}/${sha}.json`, version_id: 'immutable-version-1', sha256: sha }
  const result = { schema_version: '1.0.0', environment: 'staging', repository_id: 'hid-staging-v1', state_id: 'hid-staging-broker-v1', role: c.role, candidate_id: c.candidate,
    release_id: c.release_id, request_sha256: sha, request_object: object, root_version: c.root_version, root_sha256: c.root_sha256,
    input_metadata_version: c.input_version, input_metadata_sha256: c.input_sha256, output_version: 1, output_sha256: digest(output), output: output.toString('base64'), state_revision: 1, idempotent_replay: false }
  const transport = {
    identity: async () => { calls.push('identity'); return { Account: c.aws_account_id, Arn: `arn:aws:sts::659225405023:assumed-role/${c.submitter_role_arn.split('/').at(-1)}/fixture` } },
    put: async input => { calls.push({ put: input }); return { VersionId: object.version_id, ChecksumSHA256: Buffer.from(sha, 'hex').toString('base64'), ServerSideEncryption: 'aws:kms', SSEKMSKeyId: c.storage_kms_key_arn, BucketKeyEnabled: false } },
    invoke: async input => { calls.push({ invoke: input }); return { StatusCode: 200, ExecutedVersion: '7', Payload: Buffer.from(JSON.stringify(result)) } },
  }
  return { calls, transport, object, result }
}

test('submission uses exact create-only checksummed KMS storage envelope and invokes one paired qualified Lambda', async () => {
  const f = await fixture()
  try {
    const bytes = await prepareSignerRequest(f.c, f.directory), t = transportFixture(f.c, bytes, f.signer), receipt = await submitSignerRequest(f.c, bytes, t.transport)
    assert.equal(t.calls.length, 3); assert.equal(receipt.deployment_authorized, false); assert.equal(receipt.publication_authorized, false)
    const put = t.calls[1].put
    assert.equal(put.IfNoneMatch, '*'); assert.equal(put.ExpectedBucketOwner, '659225405023'); assert.equal(put.BucketKeyEnabled, false)
    assert.equal(put.ChecksumSHA256, Buffer.from(digest(bytes), 'hex').toString('base64')); assert.ok(put.Body.equals(bytes))
    assert.equal(Object.keys(put.Metadata).length, 5); assert.equal(put.Metadata['hid-candidate'], 'one')
    assert.ok(!Object.hasOwn(put, 'ObjectLockMode')); assert.ok(!Object.hasOwn(put, 'ObjectLockRetainUntilDate'))
    assert.deepEqual(JSON.parse(t.calls[2].invoke.Payload), { schema_version: 'hid.tuf.signing-broker.invoke/v1', ...t.object })
    assert.equal(t.calls[2].invoke.FunctionName, f.c.broker_version_arn); assert.equal(t.calls[2].invoke.LogType, 'None')
  } finally { await rm(f.repository, { recursive: true, force: true }) }
})

test('wrong identity upload version checksum encryption or ambiguous Lambda failure is never retried', async () => {
  const f = await fixture()
  try {
    const bytes = await prepareSignerRequest(f.c, f.directory)
    for (const [method, change] of [
      ['identity', value => ({ ...value, Account: '000000000000' })], ['identity', value => ({ ...value, Arn: value.Arn.replace('OneRole', 'TwoRole') })],
      ['put', value => ({ ...value, VersionId: 'null' })], ['put', value => ({ ...value, ChecksumSHA256: 'wrong' })],
      ['put', value => ({ ...value, SSEKMSKeyId: 'wrong' })], ['put', value => ({ ...value, BucketKeyEnabled: true })],
      ['invoke', value => ({ ...value, FunctionError: 'Unhandled' })], ['invoke', value => ({ ...value, ExecutedVersion: '8' })],
      ['invoke', value => ({ ...value, Payload: Buffer.from('{}') })],
    ]) {
      const t = transportFixture(f.c, bytes, f.signer), original = t.transport[method]
      t.transport[method] = async args => change(await original(args))
      await assert.rejects(submitSignerRequest(f.c, bytes, t.transport))
      assert.equal(t.calls.filter(v => v[method]).length, method === 'identity' ? 0 : 1)
      if (method !== 'invoke') assert.ok(!t.calls.some(v => v.invoke))
    }
    for (const method of ['put', 'invoke']) {
      const t = transportFixture(f.c, bytes, f.signer); let count = 0
      t.transport[method] = async () => { count++; throw Error('ambiguous transport failure') }
      await assert.rejects(submitSignerRequest(f.c, bytes, t.transport)); assert.equal(count, 1)
    }
  } finally { await rm(f.repository, { recursive: true, force: true }) }
})

test('paired output signature metadata reference and checksum cannot be spoofed', async () => {
  const f = await fixture()
  try {
    const bytes = await prepareSignerRequest(f.c, f.directory)
    for (const edit of [
      result => { result.output_sha256 = '0'.repeat(64) },
      result => { const output = JSON.parse(Buffer.from(result.output, 'base64')); output.signatures[0].sig = '00'.repeat(64)
        const changed = Buffer.from(JSON.stringify(output)); result.output = changed.toString('base64'); result.output_sha256 = digest(changed) },
      result => { const output = JSON.parse(Buffer.from(result.output, 'base64')); output.signed.meta['targets.json'].hashes.sha256 = '0'.repeat(64)
        const changed = signedEnvelope(output.signed, [f.signer]); result.output = changed.toString('base64'); result.output_sha256 = digest(changed) },
      result => { const output = JSON.parse(Buffer.from(result.output, 'base64'))
        const changed = signedEnvelope(output.signed, [f.signers.snapshot[1]]); result.output = changed.toString('base64'); result.output_sha256 = digest(changed) },
    ]) {
      const t = transportFixture(f.c, bytes, f.signer), invoke = t.transport.invoke
      t.transport.invoke = async args => { const response = await invoke(args), result = JSON.parse(response.Payload); edit(result); return { ...response, Payload: Buffer.from(JSON.stringify(result)) } }
      await assert.rejects(submitSignerRequest(f.c, bytes, t.transport)); assert.equal(t.calls.filter(c => c.invoke).length, 1)
    }
    const path = resolve(f.directory, '1.targets.json'), metadata = JSON.parse(await readFile(path))
    metadata.signed.expires = new Date(Date.now() + 20 * 86400000).toISOString().replace('Z', '+00:00')
    const changed = signedEnvelope(metadata.signed, f.signers.targets.slice(0, 2)); await writeFile(path, changed)
    await assert.rejects(prepareSignerRequest({ ...f.c, input_sha256: digest(changed) }, f.directory))
  } finally { await rm(f.repository, { recursive: true, force: true }) }
})

test('exclusive local attempt marker survives failures and prevents reusing the same runner attempt', async () => {
  const f = await fixture()
  try {
    const bytes = await prepareSignerRequest(f.c, f.directory), marker = await reserveSigningAttempt(f.repository, f.c, bytes)
    assert.equal(marker.status, 'STARTED_RECONCILE_BEFORE_RETRY'); assert.equal(marker.request_sha256, digest(bytes))
    await assert.rejects(reserveSigningAttempt(f.repository, f.c, bytes), { code: 'EEXIST' })
    assert.deepEqual(JSON.parse(await readFile(resolve(f.repository, 'staging-signing-attempt.json'))), marker)
  } finally { await rm(f.repository, { recursive: true, force: true }) }
})

test('four real workflow guards pin capabilities and reject changed source before checkout', async () => {
  for (const role of ['snapshot', 'timestamp']) for (const candidate of ['one', 'two']) {
    const path = new URL(`../../.github/workflows/tuf-${role}-signer-${candidate}.yml`, import.meta.url)
    const sourceText = await readFile(path, 'utf8'), w = yaml(sourceText), steps = w.jobs.submit.steps
    assert.deepEqual(Object.keys(w.on), ['workflow_call']); assert.equal(w.jobs.submit.environment, `staging-${role}-signer-${candidate}`)
    assert.equal(w.jobs.submit.env.HID_SIGNING_ROLE, role); assert.equal(w.jobs.submit.env.HID_SIGNING_CANDIDATE, candidate)
    for (const step of steps.filter(s => s.uses)) assert.match(step.uses, /@[a-f0-9]{40}$/)
    const awsIndex = steps.findIndex(s => s.uses?.startsWith('aws-actions/'))
    assert.ok(steps.findIndex(s => s.run?.endsWith('mjs prepare')) < awsIndex)
    assert.ok(steps.findIndex(s => s.run?.endsWith('mjs submit')) > awsIndex)
    assert.doesNotMatch(sourceText, /secrets\.|kms:Sign|cdk deploy|tuf-publish|workflow_dispatch:/)
    const inline = steps[0].run.split("<<'NODE'\n")[1].split('\nNODE')[0], c = config(role, candidate)
    const e = { ...process.env, ...context(c), SIGNER_CONFIG_JSON: JSON.stringify(c), SIGNER_CONFIG_SHA256: digest(JSON.stringify(c)), GITHUB_SHA: 'f'.repeat(40) }
    assert.throws(() => execFileSync(process.execPath, ['--input-type=module', '-e', inline], { env: e, stdio: 'pipe' }))
  }
})
