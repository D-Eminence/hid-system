import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { access, open, realpath } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import duplicateKeyJson from 'json-dup-key-validator'

const SHA256 = /^[a-f0-9]{64}$/
const RELEASE_ID = /^r[0-9]{10}-g[a-f0-9]{40}$/
const ROLES = ['root', 'targets', 'snapshot', 'timestamp']
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')

function keys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort())) {
    throw new Error(`${label} has missing or unexpected properties`)
  }
}

function time(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value)
    || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value.replace('Z', '.000Z')) {
    throw new Error('publication authorization time is invalid')
  }
  return Date.parse(value)
}

export function validatePublicationAuthorization(result, repository, now = new Date()) {
  keys(result, ['schema_version', 'repository_sha256', 'previous_repository_sha256', 'file_count',
    'authorization', 'config_sha256', 'executable_sha256'], 'publication authorization result')
  if (result.schema_version !== 'hid.tuf.publication-authorization/v1'
    || result.repository_sha256 !== repository.repositorySha256 || !SHA256.test(result.repository_sha256)
    || result.file_count !== repository.fileCount || !Number.isSafeInteger(result.file_count)
    || result.file_count < 5 || result.file_count > 20000 || !SHA256.test(result.config_sha256) || !SHA256.test(result.executable_sha256)) {
    throw new Error('publication authorization does not bind this repository and pinned operator')
  }
  const decision = result.authorization
  keys(decision, ['schema_version', 'environment', 'repository_id', 'state_id', 'bootstrap_root_sha256',
    'state_revision', 'release_id', 'authorized_at', 'expires_at', 'current', 'candidate'], 'publication authorization')
  if (decision.schema_version !== '1.0.0' || decision.environment !== repository.deployment
    || decision.repository_id !== `hid-${repository.deployment}-v1`
    || decision.state_id !== `hid-${repository.deployment}-broker-v1`
    || !SHA256.test(decision.bootstrap_root_sha256) || !RELEASE_ID.test(decision.release_id)
    || !Number.isSafeInteger(decision.state_revision) || decision.state_revision < 0) {
    throw new Error('publication authorization trust context is invalid')
  }
  const bootstrap = decision.state_revision === 0
  if (bootstrap ? result.previous_repository_sha256 !== '' : !SHA256.test(result.previous_repository_sha256)) {
    throw new Error('publication authorization predecessor hash is invalid')
  }
  const authorizedAt = time(decision.authorized_at)
  const expiresAt = time(decision.expires_at)
  if (expiresAt - authorizedAt !== 300000
    || now !== null && (authorizedAt > now.getTime() || now.getTime() - authorizedAt > 60000 || now.getTime() >= expiresAt)) {
    throw new Error('publication authorization is expired, future-dated or not freshly obtained')
  }
  for (const selection of ['current', 'candidate']) {
    keys(decision[selection], ROLES, `publication ${selection} metadata`)
    for (const role of ROLES) {
      const selected = decision[selection][role]
      keys(selected, ['version', 'sha256'], `publication ${selection} ${role}`)
      if (bootstrap && selection === 'current') {
        if (selected.version !== 0 || selected.sha256 !== '') throw new Error('bootstrap authorization has a predecessor')
        continue
      }
      if (!Number.isSafeInteger(selected.version) || selected.version < 1 || !SHA256.test(selected.sha256)
        || bootstrap && selected.version !== 1) throw new Error('publication role identity is invalid')
      if (selection === 'candidate') {
        if (selected.version !== repository[`${role}Version`]) throw new Error('publication authorization role version differs from the repository')
        if (repository.files) {
          const path = role === 'timestamp' ? 'metadata/timestamp.json' : `metadata/${selected.version}.${role}.json`
          if (repository.files.find((file) => file.path === path)?.sha256 !== selected.sha256) {
            throw new Error('publication authorization role bytes differ from the repository')
          }
        }
      }
    }
  }
  if (bootstrap && decision.bootstrap_root_sha256 !== decision.candidate.root.sha256) {
    throw new Error('bootstrap publication root differs from the fixed trust pin')
  }
  return result
}

// These pins belong to the protected runner configuration, never to the
// candidate/upload receipt. The returned JSON is fresh process output; a file
// containing a previous authorization is deliberately not an accepted input.
export async function obtainPublicationAuthorization(repository, options = {}) {
  let result
  if (options.authorize !== undefined) {
    result = await options.authorize(repository)
  } else {
    const executable = process.env.HID_TUF_PUBLICATION_EXECUTABLE
    const config = process.env.HID_TUF_PUBLICATION_CONFIG
    const executableHash = process.env.HID_TUF_PUBLICATION_EXECUTABLE_SHA256
    const configHash = process.env.HID_TUF_PUBLICATION_CONFIG_SHA256
    const previous = process.env.HID_TUF_PREVIOUS_REPOSITORY
    const previousHash = process.env.HID_TUF_PREVIOUS_REPOSITORY_SHA256
    if (!SHA256.test(executableHash ?? '') || !SHA256.test(configHash ?? '')
      || typeof previous !== 'string' || previous !== '-' && (!isAbsolute(previous) || resolve(previous) !== previous)
      || (previous === '-' ? previousHash !== '-' : !SHA256.test(previousHash ?? ''))) {
      throw new Error('protected publication executable/configuration pins and predecessor are required')
    }
    for (const [path, expected, maximum] of [[executable, executableHash, 128 * 1024 * 1024], [config, configHash, 64000]]) {
      const bytes = await readPinnedFile(path, maximum)
      if (hash(bytes) !== expected) throw new Error('protected publication executable/configuration hash mismatch')
    }
    await access(executable, constants.X_OK)
    const command = spawnSync(executable, [config, previous, previousHash, repository.repository, repository.repositorySha256], {
      shell: false, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 120000,
      killSignal: 'SIGKILL', maxBuffer: 64000,
    })
    if (command.error || command.status !== 0) throw new Error('fresh durable publication authorization failed; publication remains unpromoted')
    result = {
      ...duplicateKeyJson.parse(command.stdout, false),
      config_sha256: configHash, executable_sha256: executableHash,
    }
    if (result.previous_repository_sha256 !== (previous === '-' ? '' : previousHash)) {
      throw new Error('publication predecessor differs from the protected previously published repository hash')
    }
  }
  return validatePublicationAuthorization(result, repository, options.now ?? new Date())
}

async function readPinnedFile(path, maximum) {
  if (typeof path !== 'string' || !isAbsolute(path) || resolve(path) !== path || await realpath(path) !== path) {
    throw new Error('protected publication files must have canonical, non-symlink absolute paths')
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size < 1 || stat.size > maximum || (stat.mode & 0o022) !== 0) {
      throw new Error('protected publication file must be bounded, regular and not writable by group or others')
    }
    const bytes = Buffer.alloc(stat.size)
    let offset = 0
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset)
      if (bytesRead === 0) throw new Error('protected publication file changed during inspection')
      offset += bytesRead
    }
    if ((await handle.read(Buffer.alloc(1), 0, 1, offset)).bytesRead !== 0) throw new Error('protected publication file grew during inspection')
    return bytes
  } finally {
    await handle.close()
  }
}

export function publicationBinding(result) {
  const { authorized_at, expires_at, ...decision } = result.authorization
  return { ...result, authorization: decision }
}
