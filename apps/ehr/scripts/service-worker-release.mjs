import { execFileSync } from 'node:child_process'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join, posix, resolve } from 'node:path'

export const SERVICE_WORKER_RELEASE_TOKEN = '__HID_EHR_RELEASE_SHA__'
export const SERVICE_WORKER_ASSET_TOKEN = '__HID_EHR_SHELL_ASSETS__'
export const GIT_SHA_PATTERN = /^[a-f0-9]{40}$/
const SAFE_ASSET_PATH = /^assets\/[A-Za-z0-9._~/-]+$/

export function assertGitSha(value, label = 'release Git SHA') {
  if (typeof value !== 'string' || !GIT_SHA_PATTERN.test(value)) {
    throw new Error(`${label} must be exactly 40 lowercase hexadecimal characters`)
  }
  return value
}

export function resolveBuildReleaseSha(options = {}) {
  const repositoryRoot = options.repositoryRoot ?? resolve(import.meta.dirname, '../../..')
  const configuredSha = options.configuredSha ?? process.env.HID_RELEASE_SHA
  let checkedOutSha
  try {
    checkedOutSha = assertGitSha(execFileSync(
      'git', ['rev-parse', '--verify', 'HEAD'],
      { cwd: repositoryRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim(), 'checked-out Git SHA')
  } catch (error) {
    if (configuredSha === undefined) throw new Error('Unable to determine the checked-out release Git SHA', { cause: error })
  }

  if (configuredSha !== undefined) {
    const releaseSha = assertGitSha(configuredSha, 'HID_RELEASE_SHA')
    if (checkedOutSha !== undefined && checkedOutSha !== releaseSha) {
      throw new Error(`HID_RELEASE_SHA ${releaseSha} does not match checked-out Git SHA ${checkedOutSha}`)
    }
    return releaseSha
  }
  return checkedOutSha
}

function tokenOccurrences(source, token) {
  return source.split(token).length - 1
}

export function normalizeShellAssetPaths(paths) {
  if (!Array.isArray(paths)) throw new Error('EHR shell assets must be an array')
  const normalized = [...new Set(paths)].sort()
  for (const path of normalized) {
    if (typeof path !== 'string' || !SAFE_ASSET_PATH.test(path)
      || path.includes('//') || path.split('/').includes('..')) {
      throw new Error(`Unsafe EHR shell asset path: ${String(path)}`)
    }
  }
  return normalized
}

export async function collectShellAssetPaths(assetDirectory) {
  const paths = []
  async function visit(directory, relativeDirectory) {
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      const relativePath = posix.join(relativeDirectory, entry.name)
      if (entry.isDirectory()) await visit(join(directory, entry.name), relativePath)
      else if (entry.isFile()) paths.push(relativePath)
      else throw new Error(`Unsupported EHR build asset type: ${relativePath}`)
    }
  }
  await visit(assetDirectory, 'assets')
  return normalizeShellAssetPaths(paths)
}

export function bindServiceWorkerRelease(source, releaseSha, shellAssetPaths) {
  assertGitSha(releaseSha)
  const releaseOccurrences = tokenOccurrences(source, SERVICE_WORKER_RELEASE_TOKEN)
  if (releaseOccurrences !== 1) {
    throw new Error(`EHR service worker must contain exactly one release token; found ${releaseOccurrences}`)
  }
  const assetOccurrences = tokenOccurrences(source, SERVICE_WORKER_ASSET_TOKEN)
  if (assetOccurrences !== 1) {
    throw new Error(`EHR service worker must contain exactly one asset token; found ${assetOccurrences}`)
  }
  const assets = normalizeShellAssetPaths(shellAssetPaths)
  if (!assets.includes('assets/canonical-platform-runtime.js')) {
    throw new Error('EHR shell assets must include the canonical platform runtime')
  }
  return source
    .replace(SERVICE_WORKER_RELEASE_TOKEN, releaseSha)
    .replace(SERVICE_WORKER_ASSET_TOKEN, JSON.stringify(assets))
}

export function releaseBoundServiceWorkerPlugin(releaseSha) {
  assertGitSha(releaseSha)
  let serviceWorkerPath
  return {
    name: 'hid-ehr-release-bound-service-worker',
    apply: 'build',
    configResolved(config) {
      serviceWorkerPath = resolve(config.root, config.build.outDir, 'service-worker.js')
    },
    async writeBundle() {
      if (serviceWorkerPath === undefined) throw new Error('EHR service-worker output path was not resolved')
      const source = await readFile(serviceWorkerPath, 'utf8')
      const assetPaths = await collectShellAssetPaths(resolve(serviceWorkerPath, '../assets'))
      await writeFile(serviceWorkerPath, bindServiceWorkerRelease(source, releaseSha, assetPaths), 'utf8')
    },
  }
}
