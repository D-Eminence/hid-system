import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

export function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function canonicalString(value) {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
}

export function canonicalize(value) {
  if (value === null) return 'null'
  if (typeof value === 'string') return canonicalString(value)
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number' && Number.isSafeInteger(value) && !Object.is(value, -0)) return String(value)
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`
  if (value === null || typeof value !== 'object') throw new Error('unsupported canonical test value')
  return `{${Object.keys(value).sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right))).map((key) => `${canonicalString(key)}:${canonicalize(value[key])}`).join(',')}}`
}

function createKey() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  })
  const key = {
    keytype: 'ecdsa',
    scheme: 'ecdsa-sha2-nistp256',
    keyval: { public: publicKey },
  }
  return { id: digest(canonicalize(key)), key, privateKey }
}

export function signedEnvelope(signed, signers) {
  const payload = Buffer.from(canonicalize(signed))
  return Buffer.from(JSON.stringify({
    signatures: signers.map((key) => ({
      keyid: key.id,
      sig: sign('sha256', payload, key.privateKey).toString('hex'),
    })),
    signed,
  }))
}

export async function writeRepository(deployment) {
  const repository = await mkdtemp(join(tmpdir(), `hid-tuf-${deployment}-test-`))
  await mkdir(resolve(repository, 'metadata'))
  await mkdir(resolve(repository, 'targets', 'environments', deployment, 'channels'), { recursive: true })

  const logicalTarget = `environments/${deployment}/channels/current.json`
  const targetBytes = Buffer.from('{"release":"test"}\n')
  const targetDigest = digest(targetBytes)
  const targetPath = resolve(
    repository,
    'targets',
    'environments',
    deployment,
    'channels',
    `${targetDigest}.current.json`,
  )
  await writeFile(targetPath, targetBytes)

  const keys = Array.from({ length: 10 }, createKey)
  const rootKeys = keys.slice(0, 3)
  const targetsKeys = keys.slice(3, 6)
  const snapshotKeys = keys.slice(6, 8)
  const timestampKeys = keys.slice(8, 10)
  const now = Date.now()
  const rootSigned = {
    _type: 'root',
    spec_version: '1.0.31',
    version: 1,
    expires: new Date(now + 300 * 86400000).toISOString(),
    consistent_snapshot: true,
    keys: Object.fromEntries(keys.map((key) => [key.id, key.key])),
    roles: {
      root: { keyids: rootKeys.map((key) => key.id), threshold: 2 },
      targets: { keyids: targetsKeys.map((key) => key.id), threshold: 2 },
      snapshot: { keyids: snapshotKeys.map((key) => key.id), threshold: 1 },
      timestamp: { keyids: timestampKeys.map((key) => key.id), threshold: 1 },
    },
  }
  const targetsSigned = {
    _type: 'targets',
    spec_version: '1.0.31',
    version: 1,
    expires: new Date(now + 60 * 86400000).toISOString(),
    targets: {
      [logicalTarget]: { length: targetBytes.length, hashes: { sha256: targetDigest } },
    },
  }
  const targets = signedEnvelope(targetsSigned, targetsKeys.slice(0, 2))
  const snapshotSigned = {
    _type: 'snapshot',
    spec_version: '1.0.31',
    version: 1,
    expires: new Date(now + 5 * 86400000).toISOString(),
    meta: {
      'targets.json': { version: 1, length: targets.length, hashes: { sha256: digest(targets) } },
    },
  }
  const snapshot = signedEnvelope(snapshotSigned, snapshotKeys.slice(0, 1))
  const timestampSigned = {
    _type: 'timestamp',
    spec_version: '1.0.31',
    version: 1,
    expires: new Date(now + 12 * 3600000).toISOString(),
    meta: {
      'snapshot.json': { version: 1, length: snapshot.length, hashes: { sha256: digest(snapshot) } },
    },
  }
  const root = signedEnvelope(rootSigned, rootKeys.slice(0, 2))
  const timestamp = signedEnvelope(timestampSigned, timestampKeys.slice(0, 1))
  await Promise.all([
    writeFile(resolve(repository, 'metadata', '1.root.json'), root),
    writeFile(resolve(repository, 'metadata', '1.targets.json'), targets),
    writeFile(resolve(repository, 'metadata', '1.snapshot.json'), snapshot),
    writeFile(resolve(repository, 'metadata', 'timestamp.json'), timestamp),
  ])
  return {
    repository,
    targetPath,
    metadata: { root, targets, snapshot, timestamp },
    signed: { root: rootSigned, targets: targetsSigned, snapshot: snapshotSigned, timestamp: timestampSigned },
    signers: { root: rootKeys, targets: targetsKeys, snapshot: snapshotKeys, timestamp: timestampKeys },
  }
}
