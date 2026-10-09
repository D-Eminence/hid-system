import assert from 'node:assert/strict'
import { createHash, createPublicKey, generateKeyPairSync } from 'node:crypto'
import { execFile } from 'node:child_process'
import { readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import { template, loadPublicCustody, validateStagingPublicCustody } from '../scripts/validate-staging-public-custody.mjs'
import { validatePublicRootFile } from '../../infra/cloudflare/scripts/tuf-repository-layout.mjs'
import { digest, signedEnvelope, writeRepository } from '../../infra/cloudflare/test/helpers/tuf-repository-fixture.mjs'

const run = promisify(execFile)
const script = resolve(import.meta.dirname, '../scripts/validate-staging-public-custody.mjs')
async function fixture(t) {
  // Existing fixture creates ephemeral synthetic keys solely for local tests.
  const source = await writeRepository('staging')
  t.after(() => rm(source.repository, { recursive: true, force: true }))
  const rootPath = resolve(source.repository, 'metadata/1.root.json')
  const input = structuredClone(template)
  input.trusted_root = { version: 1, sha256: digest(source.metadata.root), public_provenance_evidence_sha256: digest('synthetic provenance only') }
  for (const role of ['root', 'targets']) input.offline_custodians[role].forEach((record, index) => {
    Object.assign(record, { key_id: source.signers[role][index].id, custodian_id: `Synthetic ${role} ${index}`,
      hardware_provider: 'Synthetic test fixture', public_custody_evidence_sha256: digest(`synthetic ${role} ${index}`) })
  })
  return { ...source, rootPath, input }
}

test('empty public template has valid shape, missing inputs and no authority', async () => {
  const result = await validateStagingPublicCustody(template)
  assert.equal(result.shape_valid, true)
  assert.equal(result.valid, false)
  assert.equal(result.input_complete, false)
  assert.equal(result.missing.length, 28)
  assert.equal(result.status, 'NOT_READY')
  assert.equal(result.authorization, 'NOT_AUTHORIZED')
  assert.equal(result.derived_public_root, null)
})

test('complete synthetic intake derives public fingerprints but never proves custody or authorizes deployment', async t => {
  const { input, rootPath, signed } = await fixture(t)
  const result = await validateStagingPublicCustody(input, { rootPath })
  assert.equal(result.valid, true)
  assert.equal(result.status, 'NOT_READY')
  for (const field of ['deployment_authorized', 'custody_verified', 'public_evidence_verified', 'staging_key_separation_verified']) assert.equal(result[field], false)
  assert.equal(result.derived_public_root.self_signature_verified, true)
  assert.equal(result.derived_public_root.rotation_chain_verified, false)
  assert.equal(result.derived_public_root.keys.length, 10)
  for (const key of result.derived_public_root.keys) {
    assert.equal(key.spki_sha256, createHash('sha256').update(createPublicKey(signed.root.keys[key.key_id].keyval.public).export({ type: 'spki', format: 'der' })).digest('hex'))
  }
  assert.ok(!JSON.stringify(result).includes('Synthetic test fixture'))
})

test('production, private fields, JWK material, PINs and fabricated authorization claims fail without echoing values', async () => {
  const privatePem = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey
    .export({ type: 'pkcs8', format: 'pem' })
  for (const mutate of [
    value => { value.environment = 'production' }, value => { value.repository_id = 'hid-production-v1' },
    value => { value.authorization = 'APPROVED' }, value => { value.custody_verified = true },
    value => { value.deployment_authorized = true }, value => { value.trusted_root.private_key = 'SENSITIVE_SENTINEL' },
    value => { value.offline_custodians.root[0].jwk = { d: 'SENSITIVE_SENTINEL' } },
    value => { value.offline_custodians.targets[0].pin = 'SENSITIVE_SENTINEL' },
    value => { value.offline_custodians.root[0].hardware_provider = privatePem },
    value => { value.offline_custodians.root[0].custodian_id = 'approved custodian' },
  ]) {
    const input = structuredClone(template); mutate(input)
    const result = await validateStagingPublicCustody(input)
    assert.equal(result.shape_valid, false)
    assert.equal(result.valid, false)
    assert.ok(!JSON.stringify(result).includes('SENSITIVE_SENTINEL'))
    assert.ok(!JSON.stringify(result).includes(privatePem))
  }
})

test('key reuse, duplicate custodian aliases and substituted role keys are rejected', async t => {
  const { input, rootPath } = await fixture(t)
  for (const mutate of [
    value => { value.offline_custodians.targets[0].key_id = value.offline_custodians.root[0].key_id },
    value => { value.offline_custodians.root[1].custodian_id = value.offline_custodians.root[0].custodian_id.toUpperCase().replaceAll(' ', '-') },
    value => { value.offline_custodians.root[0].key_id = digest('not an authorized role key') },
    value => { value.offline_custodians.targets.pop() },
  ]) {
    const candidate = structuredClone(input); mutate(candidate)
    assert.equal((await validateStagingPublicCustody(candidate, { rootPath })).valid, false)
  }
})

test('a missing local root or an independent digest/version mismatch cannot complete intake', async t => {
  const { input, rootPath } = await fixture(t)
  assert.equal((await validateStagingPublicCustody(input)).valid, false)
  for (const field of ['version', 'sha256']) {
    const candidate = structuredClone(input)
    candidate.trusted_root[field] = field === 'version' ? 2 : digest('different root')
    const result = await validateStagingPublicCustody(candidate, { rootPath })
    assert.equal(result.valid, false)
    assert.equal(result.derived_public_root, null)
  }
})

test('existing root signature threshold and publication freshness checks are reused', async t => {
  const source = await fixture(t)
  for (const mutation of ['one signature', 'short expiry', 'invalid threshold']) {
    const signed = structuredClone(source.signed.root)
    if (mutation === 'short expiry') signed.expires = new Date(Date.now() + 86400000).toISOString()
    if (mutation === 'invalid threshold') signed.roles.root.threshold = 1
    await writeFile(source.rootPath, signedEnvelope(signed, source.signers.root.slice(0, mutation === 'one signature' ? 1 : 2)))
    await assert.rejects(validatePublicRootFile(source.rootPath))
  }
})

test('private PEM in public-key field and extra private JWK fields are refused', async t => {
  const source = await fixture(t)
  const keyID = source.signers.root[0].id
  const signed = structuredClone(source.signed.root)
  signed.keys[keyID].keyval.public = source.signers.root[0].privateKey.export({ type: 'pkcs8', format: 'pem' })
  await writeFile(source.rootPath, signedEnvelope(signed, source.signers.root.slice(0, 2)), { mode: 0o600 })
  await assert.rejects(validatePublicRootFile(source.rootPath), /only SPKI PUBLIC KEY/)
  const publicWithPrivateField = structuredClone(source.signed.root)
  publicWithPrivateField.keys[keyID].keyval.private = 'SENSITIVE_SENTINEL'
  await writeFile(source.rootPath, signedEnvelope(publicWithPrivateField, source.signers.root.slice(0, 2)))
  const result = await validateStagingPublicCustody(source.input, { rootPath: source.rootPath })
  assert.equal(result.valid, false)
  assert.ok(!JSON.stringify(result).includes('SENSITIVE_SENTINEL'))
})

test('root duplicate JSON keys, symlink and unversioned filenames fail closed', async t => {
  const source = await fixture(t)
  const alternate = resolve(source.repository, 'root.json')
  await writeFile(alternate, source.metadata.root)
  await assert.rejects(validatePublicRootFile(alternate), /versioned root filename/)
  await rm(alternate)
  await symlink(source.rootPath, alternate)
  await assert.rejects(validatePublicRootFile(alternate), /canonical absolute/)
  await writeFile(source.rootPath, source.metadata.root.toString().replace('"signed":', '"signed":{},"signed":'))
  await assert.rejects(validatePublicRootFile(source.rootPath), /duplicate-free/)
})

test('intake file reader rejects duplicate JSON, symlinks and oversized inputs', async t => {
  const { repository } = await fixture(t)
  const path = resolve(repository, 'intake.json'), link = resolve(repository, 'linked.json')
  await writeFile(path, JSON.stringify(template))
  assert.deepEqual(await loadPublicCustody(path), template)
  await symlink(path, link)
  await assert.rejects(loadPublicCustody(link))
  await writeFile(path, '{"environment":"staging","environment":"production"}')
  await assert.rejects(loadPublicCustody(path))
  await writeFile(path, ' '.repeat(16385))
  await assert.rejects(loadPublicCustody(path))
})

test('CLI template check exits zero with NOT_READY; normal check rejects incomplete intake', async () => {
  const path = resolve(import.meta.dirname, '../config/staging-public-custody.template.json')
  const { stdout } = await run(process.execPath, [script, '--check-template', path])
  assert.equal(JSON.parse(stdout).status, 'NOT_READY')
  await assert.rejects(run(process.execPath, [script, path]), error => error.code === 1 && JSON.parse(error.stdout).valid === false)
})

test('CLI validates complete public data with no writes and no authorization, and redacts malformed input', async t => {
  const source = await fixture(t)
  const path = resolve(source.repository, 'intake.json')
  const original = JSON.stringify(source.input)
  await writeFile(path, original)
  const { stdout } = await run(process.execPath, [script, path, source.rootPath])
  assert.equal(JSON.parse(stdout).valid, true)
  assert.equal(JSON.parse(stdout).authorization, 'NOT_AUTHORIZED')
  assert.equal(await readFile(path, 'utf8'), original)
  await writeFile(path, '{"SENSITIVE_SENTINEL":')
  await assert.rejects(run(process.execPath, [script, path]), error => error.code === 1 && !`${error.stdout}${error.stderr}`.includes('SENSITIVE_SENTINEL'))
})
