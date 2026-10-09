import { createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import duplicateKeyJson from 'json-dup-key-validator'

const hash = (value) => createHash('sha256').update(value).digest('hex')
const canonical = (value) => value === null || typeof value !== 'object' ? JSON.stringify(value)
  : Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
    : `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
const same = (a, b) => canonical(a) === canonical(b)
const sha = /^[a-f0-9]{64}$/
const fail = () => { throw new Error('publication failed closed; independent reconciliation is required') }

export function evidenceEnvelope(binding, phase, payload) {
  const bytes = Buffer.from(canonical({ schema_version: 'hid.tuf.publication-evidence/v1', binding, phase, payload }))
  return { bytes, sha256: hash(bytes) }
}

function verifiedEvidence(value, binding, phase) {
  if (!Buffer.isBuffer(value?.bytes) || value.bytes.length > 64000 || value.bytes.length === 0
    || !sha.test(value.sha256) || hash(value.bytes) !== value.sha256) fail()
  const ref = value.reference
  if (!ref || Object.keys(ref).sort().join(',') !== 'bucket,key,sha256,version_id'
    || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(ref.bucket) || ref.sha256 !== value.sha256
    || ref.key !== `tuf-publication-journal/hid-${binding.authorization.environment}-publication-v1/evidence/${value.sha256}.json`
    || typeof ref.version_id !== 'string' || !/^[A-Za-z0-9._~+\/-]{1,1024}$/.test(ref.version_id) || ref.version_id === 'null') fail()
  const envelope = duplicateKeyJson.parse(value.bytes.toString('utf8'), false)
  if (Object.keys(envelope).sort().join(',') !== 'binding,payload,phase,schema_version'
    || envelope.schema_version !== 'hid.tuf.publication-evidence/v1' || envelope.phase !== phase || !same(envelope.binding, binding)) fail()
  return Object.freeze({ reference: Object.freeze({ ...ref }), sha256: value.sha256, payload: structuredClone(envelope.payload) })
}

// One invocation is one attempt. Ports are trusted code, never loaded from the
// candidate artifact. No side effect is retried, even if its receipt is lost.
export async function runPublicationPipeline(options, ports) {
  const binding = structuredClone(options.binding)
  if (!binding || !sha.test(binding.repository_sha256) || !sha.test(binding.artifact_sha256)
    || !sha.test(binding.artifact_set_sha256) || !/^[a-f0-9]{40}$/.test(binding.git_sha)
    || !binding.authorization?.release_id?.endsWith(`-g${binding.git_sha}`)
    || !['staging', 'production'].includes(binding.authorization.environment)
    || typeof options.bootstrap !== 'boolean' || options.bootstrap !== (binding.authorization.state_revision === 0)) fail()
  const attempts = options.maxConfirmationAttempts ?? 30
  const pause = options.confirmationDelayMs ?? 10000
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 60 || !Number.isSafeInteger(pause) || pause < 0 || pause > 30000) fail()
  for (const name of ['authorize', 'verifyArchive', 'upload', 'preview', 'deploy', 'confirmPublished', ...(options.bootstrap ? ['parent', 'route'] : [])]) {
    if (typeof ports[name] !== 'function') fail()
  }
  for (const name of ['begin', 'advance', 'confirm', 'fail']) if (typeof ports.journal?.[name] !== 'function') fail()
  const check = () => { if (options.signal?.aborted) fail() }
  const now = ports.now ?? Date.now
  const start = now()
  let record
  let evidenceHash = hash(canonical(binding))
  let failureCode = 'validation-failed'
  const references = []
  const acceptRecord = (value, phase, revision) => {
    check()
    if (!value || value.schema_version !== '1.0.0' || value.phase !== phase || value.revision !== revision
      || !same(value.binding, binding) || value.result !== (phase === 'confirmed' ? 'completed' : 'pending')) fail()
    record = structuredClone(value)
  }
  const advance = async (phase, authorization) => {
    check()
    if (now() - start > 1800000 || now() < start) fail()
    failureCode = 'storage-failed'
    const next = await ports.journal.advance(record, phase, evidenceHash, authorization)
    acceptRecord(next, phase, record.revision + 1)
  }
  const evidence = (value, phase) => {
    check()
    const verified = verifiedEvidence(value, binding, phase)
    evidenceHash = verified.sha256
    references.push({ phase, ...verified.reference })
    return verified
  }
  const effect = async (name, intent, completed, inputs = {}) => {
    let called = false
    let committed = false
    const beforeEffect = async () => {
      check()
      if (called) fail()
      called = true
      failureCode = 'validation-failed'
      const auth = await ports.authorize()
      const { authorized_at, expires_at, ...identity } = auth
      const { authorized_at: _, expires_at: __, ...expected } = binding.authorization
      if (!same(identity, expected) || !Number.isFinite(Date.parse(authorized_at))
        || Date.parse(expires_at) - Date.parse(authorized_at) !== 300000
        || now() < Date.parse(authorized_at) || now() - Date.parse(authorized_at) > 60000) fail()
      await advance(intent, auth)
      check()
      committed = true
      failureCode = 'external-outcome-unknown'
      return auth
    }
    const result = await ports[name]({ binding, signal: options.signal, beforeEffect, ...inputs })
    if (!called || !committed) fail()
    const verified = evidence(result, completed)
    await advance(completed)
    return verified
  }
  try {
    check()
    const claim = await ports.journal.begin(binding)
    // A new claim can follow a confirmed earlier attempt, so its revision need
    // not be one. The durable Go policy authenticates the predecessor chain.
    if (!Number.isSafeInteger(claim?.revision) || claim.revision < 1) fail()
    acceptRecord(claim, 'claimed', claim.revision)
    const archive = evidence(await ports.verifyArchive({ binding, signal: options.signal }), 'archive-verified')
    await advance('archive-verified')
    if (options.bootstrap) await effect('parent', 'parent-started', 'parent-created', { archive })
    const upload = await effect('upload', 'upload-started', 'uploaded', { archive })
    failureCode = 'validation-failed'
    const preview = evidence(await ports.preview({ binding, upload, signal: options.signal }), 'preview-verified')
    await advance('preview-verified')
    const deployment = await effect('deploy', 'deploy-started', 'deployed', { upload, preview })
    if (options.bootstrap) await effect('route', 'route-started', 'route-activated', { deployment })
    failureCode = 'canary-timeout'
    for (let attempt = 0; attempt < attempts; attempt++) {
      check()
      const confirmation = await ports.confirmPublished({ binding, signal: options.signal })
      if (confirmation !== null) {
        const verified = evidence(confirmation, 'confirmed')
        const next = await ports.journal.confirm(record, verified.payload, evidenceHash)
        acceptRecord(next, 'confirmed', record.revision + 1)
        return { record, evidence: references }
      }
      if (attempt + 1 < attempts) await (ports.wait ?? delay)(pause, undefined, { signal: options.signal })
    }
    fail()
  } catch {
    // Best-effort bounded failure annotation cannot reconcile or unlock. If a
    // commit response was lost, stale revision CAS also prevents this append.
    if (record && record.result === 'pending') {
      try { await ports.journal.fail(record, options.signal?.aborted ? 'canceled' : failureCode, evidenceHash) } catch { /* Preserve unresolved durable state. */ }
    }
    fail()
  }
}
