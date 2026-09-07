import { createHash, createPublicKey, verify as verifySignature } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, readdir, realpath } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import duplicateKeyJson from 'json-dup-key-validator'
import { classifyTufPath } from '../src/tuf-path-policy.mjs'

const DEPLOYMENTS = new Set(['staging', 'production'])
const MAX_REPOSITORY_FILES = 20_000
const MAX_TARGET_BYTES = 25 * 1024 * 1024
const SPEC_VERSION = '1.0.31'
const HEX_SHA256 = /^[a-f0-9]{64}$/
const RELEASE_ID = /^r[0-9]{10}-g[a-f0-9]{40}$/
const CANONICAL_EXPIRY = /^([0-9]{4})-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):([0-5][0-9]):([0-5][0-9])(?:\.[0-9]+)?Z$/
const ROLE_POLICY = Object.freeze({
  root: Object.freeze({ keys: 3, threshold: 2, maximumBytes: 512_000, maximumRemainingMs: 365 * 86400000, minimumRemainingMs: 30 * 86400000 }),
  targets: Object.freeze({ keys: 3, threshold: 2, maximumBytes: 5_000_000, maximumRemainingMs: 90 * 86400000, minimumRemainingMs: 14 * 86400000 }),
  snapshot: Object.freeze({ keys: 2, threshold: 1, maximumBytes: 2_000_000, maximumRemainingMs: 7 * 86400000, minimumRemainingMs: 72 * 3600000 }),
  timestamp: Object.freeze({ keys: 2, threshold: 1, maximumBytes: 64_000, maximumRemainingMs: 24 * 3600000, minimumRemainingMs: 6 * 3600000 }),
})

function fail(message) {
  throw new Error(`TUF repository validation failed: ${message}`)
}

function record(value, label, required, optional = []) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`)
  const allowed = new Set([...required, ...optional])
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(`${label} has unexpected property ${JSON.stringify(key)}`)
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) fail(`${label} is missing ${JSON.stringify(key)}`)
  }
  return value
}

function stringMap(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`)
  return value
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) fail(`${label} must be a positive safe integer`)
  return value
}

function canonicalString(value) {
  // go-tuf v2.4.2 uses securesystemslib's OLPC canonical JSON encoder. That
  // format escapes only backslashes and quotes; JSON.stringify() additionally
  // escapes PEM newlines and therefore produces different TUF key IDs and root
  // signatures.
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
}

function utf8Order(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'))
}

export function canonicalizeTuf(value) {
  if (value === null) return 'null'
  if (typeof value === 'string') return canonicalString(value)
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) fail('canonical TUF JSON permits only safe base-10 integers')
    return String(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonicalizeTuf).join(',')}]`
  if (value === null || typeof value !== 'object') fail(`canonical TUF JSON cannot encode ${typeof value}`)
  return `{${Object.keys(value).sort(utf8Order).map((key) => `${canonicalString(key)}:${canonicalizeTuf(value[key])}`).join(',')}}`
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex')
}

async function readRegular(path, maximum, label) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const metadata = await handle.stat()
    if (!metadata.isFile() || metadata.size < 1 || metadata.size > maximum) {
      fail(`${label} must be a regular file from 1 through ${maximum} bytes`)
    }
    const bytes = Buffer.alloc(metadata.size)
    let offset = 0
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset)
      if (bytesRead === 0) fail(`${label} changed or was truncated while being read`)
      offset += bytesRead
    }
    if ((await handle.read(Buffer.alloc(1), 0, 1, offset)).bytesRead !== 0) fail(`${label} grew while being read`)
    return bytes
  } finally {
    await handle.close()
  }
}

async function regularFiles(root, relativeDirectory, output) {
  const entries = await readdir(resolve(root, relativeDirectory), { withFileTypes: true })
  for (const entry of entries) {
    const relative = `${relativeDirectory}/${entry.name}`
    if (entry.isSymbolicLink()) fail(`${relative} must not be a symbolic link`)
    if (entry.isDirectory()) await regularFiles(root, relative, output)
    else if (entry.isFile()) output.push(relative)
    else fail(`${relative} must be a regular file or directory`)
    if (output.length > MAX_REPOSITORY_FILES) fail(`repository exceeds ${MAX_REPOSITORY_FILES} files`)
  }
}

function metadataExpiry(value, label) {
  const match = typeof value === 'string' ? CANONICAL_EXPIRY.exec(value) : null
  if (!match) fail(`${label} must be a canonical UTC RFC 3339 timestamp`)
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) fail(`${label} is not a real timestamp`)
  const expected = match.slice(1, 7).map(Number)
  const calendar = new Date(0)
  calendar.setUTCFullYear(expected[0], expected[1] - 1, expected[2])
  calendar.setUTCHours(expected[3], expected[4], expected[5], 0)
  const actual = [
    calendar.getUTCFullYear(), calendar.getUTCMonth() + 1, calendar.getUTCDate(),
    calendar.getUTCHours(), calendar.getUTCMinutes(), calendar.getUTCSeconds(),
  ]
  if (!actual.every((part, index) => part === expected[index])) fail(`${label} is not a real timestamp`)
  return parsed
}

function validateCommonSigned(signed, role, label) {
  if (signed._type !== role) fail(`${label} has the wrong signed role`)
  if (signed.spec_version !== SPEC_VERSION) fail(`${label} must use TUF spec_version ${SPEC_VERSION}`)
  positiveInteger(signed.version, `${label}.version`)
  return metadataExpiry(signed.expires, `${label}.expires`)
}

async function readMetadata(repository, relativePath, pathPolicy) {
  const policy = ROLE_POLICY[pathPolicy.role]
  const bytes = await readRegular(resolve(repository, relativePath), policy.maximumBytes, relativePath)
  let envelope
  try {
    envelope = duplicateKeyJson.parse(bytes.toString('utf8'), false)
  } catch (error) {
    fail(`${relativePath} must contain duplicate-free JSON: ${error.message}`)
  }
  record(envelope, relativePath, ['signatures', 'signed'])
  if (!Array.isArray(envelope.signatures) || envelope.signatures.length < 1 || envelope.signatures.length > 20) {
    fail(`${relativePath}.signatures must contain from 1 through 20 records`)
  }
  const signatureIDs = new Set()
  for (const [index, signature] of envelope.signatures.entries()) {
    record(signature, `${relativePath}.signatures[${index}]`, ['keyid', 'sig'])
    if (!HEX_SHA256.test(signature.keyid) || typeof signature.sig !== 'string'
      || signature.sig.length < 2 || signature.sig.length > 512 || !/^(?:[a-f0-9]{2})+$/.test(signature.sig)) {
      fail(`${relativePath}.signatures[${index}] is not a bounded lowercase-hex signature`)
    }
    if (signatureIDs.has(signature.keyid)) fail(`${relativePath} repeats signature key ID ${signature.keyid}`)
    signatureIDs.add(signature.keyid)
  }
  const signed = record(envelope.signed, `${relativePath}.signed`,
    pathPolicy.role === 'root'
      ? ['_type', 'spec_version', 'version', 'expires', 'consistent_snapshot', 'keys', 'roles']
      : pathPolicy.role === 'targets'
        ? ['_type', 'spec_version', 'version', 'expires', 'targets']
        : ['_type', 'spec_version', 'version', 'expires', 'meta'])
  const expires = validateCommonSigned(signed, pathPolicy.role, `${relativePath}.signed`)
  if (pathPolicy.version !== undefined && signed.version !== pathPolicy.version) {
    fail(`${relativePath} filename and signed version differ`)
  }
  return Object.freeze({
    bytes,
    digest: digest(bytes),
    envelope,
    expires,
    path: relativePath,
    signed,
    size: bytes.length,
    version: signed.version,
  })
}

function parseRoot(root) {
  const label = `${root.path}.signed`
  if (root.signed.consistent_snapshot !== true) fail(`${root.path} must enable consistent snapshots`)
  const keys = stringMap(root.signed.keys, `${label}.keys`)
  const roles = record(root.signed.roles, `${label}.roles`, ['root', 'targets', 'snapshot', 'timestamp'])
  const roleKeyIDs = new Set()
  for (const [roleName, policy] of Object.entries(ROLE_POLICY)) {
    const role = record(roles[roleName], `${label}.roles.${roleName}`, ['keyids', 'threshold'])
    if (!Array.isArray(role.keyids) || role.keyids.length !== policy.keys || role.threshold !== policy.threshold) {
      fail(`${label}.roles.${roleName} must be threshold ${policy.threshold} of exactly ${policy.keys} keys`)
    }
    const unique = new Set(role.keyids)
    if (unique.size !== role.keyids.length) fail(`${label}.roles.${roleName} repeats a key ID`)
    for (const keyID of role.keyids) {
      if (!HEX_SHA256.test(keyID) || !Object.hasOwn(keys, keyID)) fail(`${label}.roles.${roleName} references an invalid or missing key`)
      if (roleKeyIDs.has(keyID)) fail(`${label} reuses a key across top-level roles`)
      roleKeyIDs.add(keyID)
    }
  }
  if (Object.keys(keys).length !== roleKeyIDs.size) fail(`${label}.keys must contain exactly the ten governed role keys`)
  const publicKeys = new Map()
  const publicKeyFingerprints = new Set()
  for (const [keyID, value] of Object.entries(keys)) {
    const key = record(value, `${label}.keys.${keyID}`, ['keytype', 'scheme', 'keyval'])
    if (!['ecdsa', 'ecdsa-sha2-nistp256'].includes(key.keytype)
      || key.scheme !== 'ecdsa-sha2-nistp256') {
      fail(`${label}.keys.${keyID} must be a P-256 ECDSA/SHA-256 key`)
    }
    const keyval = record(key.keyval, `${label}.keys.${keyID}.keyval`, ['public'])
    if (typeof keyval.public !== 'string' || keyval.public.length < 100 || keyval.public.length > 1000) {
      fail(`${label}.keys.${keyID}.keyval.public is invalid`)
    }
    if (digest(canonicalizeTuf(key)) !== keyID) fail(`${label}.keys.${keyID} does not match its canonical TUF key ID`)
    let publicKey
    try {
      publicKey = createPublicKey(keyval.public)
    } catch {
      fail(`${label}.keys.${keyID} does not contain a valid public key`)
    }
    if (publicKey.asymmetricKeyType !== 'ec'
      || !['prime256v1', 'P-256'].includes(publicKey.asymmetricKeyDetails?.namedCurve)) {
      fail(`${label}.keys.${keyID} is not a P-256 public key`)
    }
    const publicKeyFingerprint = digest(publicKey.export({ format: 'der', type: 'spki' }))
    if (publicKeyFingerprints.has(publicKeyFingerprint)) {
      fail(`${label} repeats one cryptographic public key under multiple key IDs`)
    }
    publicKeyFingerprints.add(publicKeyFingerprint)
    publicKeys.set(keyID, publicKey)
  }
  return Object.freeze({ root, keys: publicKeys, roles })
}

function thresholdValid(authority, roleName, metadata, rejectUnknown = true) {
  const role = authority.roles[roleName]
  const allowed = new Set(role.keyids)
  const payload = Buffer.from(canonicalizeTuf(metadata.signed))
  let valid = 0
  for (const signature of metadata.envelope.signatures) {
    if (!allowed.has(signature.keyid)) {
      if (rejectUnknown) fail(`${metadata.path} has a signature outside the authorized ${roleName} keys`)
      continue
    }
    const publicKey = authority.keys.get(signature.keyid)
    let verified = false
    try {
      verified = verifySignature('sha256', payload, publicKey, Buffer.from(signature.sig, 'hex'))
    } catch {
      verified = false
    }
    if (verified) valid += 1
  }
  return valid >= role.threshold
}

function requireThreshold(authority, roleName, metadata, label, rejectUnknown = true) {
  if (!thresholdValid(authority, roleName, metadata, rejectUnknown)) {
    fail(`${label} does not meet the ${roleName} signature threshold`)
  }
}

function signedByAny(authorities, roleName, metadata) {
  return authorities.some((authority) => thresholdValid(authority, roleName, metadata, false))
}

function metadataReference(reference, selected, label) {
  record(reference, label, ['version', 'length', 'hashes'])
  if (positiveInteger(reference.version, `${label}.version`) !== selected.version) fail(`${label}.version does not select ${selected.path}`)
  if (!Number.isSafeInteger(reference.length) || reference.length !== selected.size) fail(`${label}.length does not match ${selected.path}`)
  const hashes = record(reference.hashes, `${label}.hashes`, ['sha256'])
  if (!HEX_SHA256.test(hashes.sha256) || hashes.sha256 !== selected.digest) fail(`${label}.hashes.sha256 does not match ${selected.path}`)
}

function selectedVersion(versions, version, label) {
  const selected = versions.get(version)
  if (!selected) fail(`${label} selects missing metadata version ${version}`)
  return selected
}

function highestVersion(versions) {
  return Math.max(...versions.keys())
}

function freshness(metadata, role, now) {
  const policy = ROLE_POLICY[role]
  const remaining = metadata.expires - now.getTime()
  if (remaining < policy.minimumRemainingMs) fail(`${metadata.path} has less than the required ${role} publication freshness`)
  if (remaining > policy.maximumRemainingMs) fail(`${metadata.path} exceeds the maximum ${role} metadata lifetime`)
}

function physicalTargetPath(logicalPath, sha256, deployment) {
  const segments = logicalPath.split('/')
  const releasePath = segments.length >= 5
    && segments[0] === 'environments' && segments[1] === deployment
    && segments[2] === 'releases' && RELEASE_ID.test(segments[3])
  const channelPath = segments.length === 4
    && segments[0] === 'environments' && segments[1] === deployment
    && segments[2] === 'channels' && segments[3] === 'current.json'
  if ((!releasePath && !channelPath)
    || segments.some((segment) => !/^[a-z0-9][a-z0-9._-]*$/.test(segment))) {
    fail(`logical target ${logicalPath} is outside the governed ${deployment} release namespace`)
  }
  const basename = segments.pop()
  return `targets/${segments.join('/')}/${sha256}.${basename}`
}

export async function validateTufRepositoryDirectory(directory, deployment, options = {}) {
  if (!DEPLOYMENTS.has(deployment)) fail('deployment must be staging or production')
  if (typeof directory !== 'string' || !isAbsolute(directory)) fail('an explicit absolute repository directory is required')
  const requested = resolve(directory)
  const requestedStat = await lstat(requested).catch(() => null)
  if (!requestedStat?.isDirectory() || requestedStat.isSymbolicLink()) {
    fail('repository directory must exist, be a directory, and not be a symbolic link')
  }
  const repository = await realpath(requested)
  const rootEntries = await readdir(repository, { withFileTypes: true })
  if (rootEntries.length !== 2
    || !rootEntries.every((entry) => entry.isDirectory() && ['metadata', 'targets'].includes(entry.name))) {
    fail('repository root must contain only metadata/ and targets/ directories')
  }
  const relativeFiles = []
  await regularFiles(repository, 'metadata', relativeFiles)
  await regularFiles(repository, 'targets', relativeFiles)
  relativeFiles.sort((left, right) => Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8')))
  if (relativeFiles.length < 5 || relativeFiles.length > MAX_REPOSITORY_FILES) {
    fail(`repository must contain from 5 through ${MAX_REPOSITORY_FILES} files`)
  }

  const metadataByRole = new Map([
    ['root', new Map()],
    ['snapshot', new Map()],
    ['targets', new Map()],
  ])
  const targetFiles = new Map()
  const generationFiles = []
  let timestamp
  for (const relativePath of relativeFiles) {
    const policy = classifyTufPath(`/${relativePath}`)
    if (!policy) fail(`${relativePath} is not an allowed repository asset path`)
    if (policy.kind === 'metadata') {
      const parsed = await readMetadata(repository, relativePath, policy)
      generationFiles.push({ path: relativePath, length: parsed.size, sha256: parsed.digest })
      if (policy.role === 'timestamp') {
        if (timestamp) fail('repository contains more than one timestamp metadata file')
        timestamp = parsed
      } else {
        if (metadataByRole.get(policy.role).has(parsed.version)) fail(`repository repeats ${policy.role} version ${parsed.version}`)
        metadataByRole.get(policy.role).set(parsed.version, parsed)
      }
      continue
    }
    if (!policy.logicalName.startsWith(`environments/${deployment}/`)) fail(`${relativePath} is outside the ${deployment} target namespace`)
    const bytes = await readRegular(resolve(repository, relativePath), MAX_TARGET_BYTES, relativePath)
    const actualDigest = digest(bytes)
    if (actualDigest !== policy.sha256) fail(`${relativePath} hash prefix does not match its bytes`)
    targetFiles.set(relativePath, { digest: actualDigest, size: bytes.length })
    generationFiles.push({ path: relativePath, length: bytes.length, sha256: actualDigest })
  }
  if (!timestamp) fail('metadata/timestamp.json is required')
  for (const [role, versions] of metadataByRole) {
    if (versions.size === 0) fail(`at least one versioned ${role} metadata file is required`)
  }
  if (targetFiles.size === 0) fail('at least one hash-prefixed target is required')

  const rootVersions = [...metadataByRole.get('root').keys()].sort((a, b) => a - b)
  rootVersions.forEach((version, index) => {
    if (version !== index + 1) fail('root metadata versions must be retained contiguously from version 1')
  })
  const rootAuthorities = rootVersions.map((version) => parseRoot(metadataByRole.get('root').get(version)))
  for (let index = 0; index < rootAuthorities.length; index += 1) {
    const current = rootAuthorities[index]
    if (index === 0) requireThreshold(current, 'root', current.root, `${current.root.path} self-signature`)
    else {
      requireThreshold(rootAuthorities[index - 1], 'root', current.root, `${current.root.path} old-root signature`, false)
      requireThreshold(current, 'root', current.root, `${current.root.path} new-root signature`, false)
    }
  }
  const latestRootAuthority = rootAuthorities.at(-1)

  for (const targets of metadataByRole.get('targets').values()) {
    if (!signedByAny(rootAuthorities, 'targets', targets)) fail(`${targets.path} is not threshold-signed by any retained root targets role`)
  }
  for (const snapshot of metadataByRole.get('snapshot').values()) {
    if (!signedByAny(rootAuthorities, 'snapshot', snapshot)) fail(`${snapshot.path} is not signed by any retained root snapshot role`)
  }
  requireThreshold(latestRootAuthority, 'timestamp', timestamp, timestamp.path)

  const timestampMeta = record(timestamp.signed.meta, `${timestamp.path}.signed.meta`, ['snapshot.json'])
  const snapshotReference = timestampMeta['snapshot.json']
  const currentSnapshot = selectedVersion(
    metadataByRole.get('snapshot'),
    positiveInteger(snapshotReference?.version, `${timestamp.path} snapshot version`),
    timestamp.path,
  )
  metadataReference(snapshotReference, currentSnapshot, `${timestamp.path} snapshot.json reference`)
  if (currentSnapshot.version !== highestVersion(metadataByRole.get('snapshot'))) fail('timestamp does not select the highest retained snapshot version')
  requireThreshold(latestRootAuthority, 'snapshot', currentSnapshot, currentSnapshot.path)

  let previousTargetsVersion = 0
  const selectedTargetsVersions = new Set()
  for (const snapshot of [...metadataByRole.get('snapshot').values()].sort((left, right) => left.version - right.version)) {
    const meta = record(snapshot.signed.meta, `${snapshot.path}.signed.meta`, ['targets.json'])
    const reference = meta['targets.json']
    const selected = selectedVersion(
      metadataByRole.get('targets'),
      positiveInteger(reference?.version, `${snapshot.path} targets version`),
      snapshot.path,
    )
    metadataReference(reference, selected, `${snapshot.path} targets.json reference`)
    if (selected.version < previousTargetsVersion) fail('retained snapshots mix or roll back targets versions')
    previousTargetsVersion = selected.version
    selectedTargetsVersions.add(selected.version)
  }
  for (const version of metadataByRole.get('targets').keys()) {
    if (!selectedTargetsVersions.has(version)) fail(`retained targets version ${version} is not selected by any retained snapshot`)
  }
  const currentTargetsReference = currentSnapshot.signed.meta['targets.json']
  const currentTargets = selectedVersion(metadataByRole.get('targets'), currentTargetsReference.version, currentSnapshot.path)
  if (currentTargets.version !== highestVersion(metadataByRole.get('targets'))) fail('current snapshot does not select the highest retained targets version')
  requireThreshold(latestRootAuthority, 'targets', currentTargets, currentTargets.path)

  const now = options.now instanceof Date ? options.now : new Date()
  if (!Number.isFinite(now.getTime())) fail('validation time is invalid')
  freshness(latestRootAuthority.root, 'root', now)
  freshness(currentTargets, 'targets', now)
  freshness(currentSnapshot, 'snapshot', now)
  freshness(timestamp, 'timestamp', now)

  const referencedTargets = new Set()
  const immutableReleaseTargets = new Map()
  for (const targetsMetadata of metadataByRole.get('targets').values()) {
    const signedTargets = stringMap(targetsMetadata.signed.targets, `${targetsMetadata.path}.signed.targets`)
    for (const [logicalPath, descriptor] of Object.entries(signedTargets)) {
      const targetDescriptor = record(descriptor, `${targetsMetadata.path} target ${logicalPath}`, ['length', 'hashes'])
      if (!Number.isSafeInteger(targetDescriptor.length)
        || targetDescriptor.length < 1 || targetDescriptor.length > MAX_TARGET_BYTES) {
        fail(`${targetsMetadata.path} target ${logicalPath} has an invalid length`)
      }
      const hashes = record(targetDescriptor.hashes, `${targetsMetadata.path} target ${logicalPath}.hashes`, ['sha256'])
      if (!HEX_SHA256.test(hashes.sha256)) fail(`${targetsMetadata.path} target ${logicalPath} requires one lowercase SHA-256 hash`)
      if (logicalPath.includes('/releases/')) {
        const descriptorIdentity = `${targetDescriptor.length}:${hashes.sha256}`
        const previousIdentity = immutableReleaseTargets.get(logicalPath)
        if (previousIdentity !== undefined && previousIdentity !== descriptorIdentity) {
          fail(`immutable release target ${logicalPath} changes across retained targets metadata`)
        }
        immutableReleaseTargets.set(logicalPath, descriptorIdentity)
      }
      const relativePath = physicalTargetPath(logicalPath, hashes.sha256, deployment)
      const physicalTarget = targetFiles.get(relativePath)
      if (!physicalTarget) fail(`${targetsMetadata.path} references missing ${relativePath}`)
      if (physicalTarget.size !== targetDescriptor.length) fail(`${relativePath} length does not match signed targets metadata`)
      referencedTargets.add(relativePath)
    }
  }
  for (const relativePath of targetFiles.keys()) {
    if (!referencedTargets.has(relativePath)) fail(`${relativePath} is not referenced by retained targets metadata`)
  }

  return Object.freeze({
    deployment,
    repository,
    repositorySha256: digest(canonicalizeTuf(generationFiles)),
    fileCount: relativeFiles.length,
    files: Object.freeze(generationFiles.map((file) => Object.freeze({ ...file }))),
    rootVersion: latestRootAuthority.root.version,
    snapshotVersion: currentSnapshot.version,
    targetsVersion: currentTargets.version,
    timestampVersion: timestamp.version,
  })
}
