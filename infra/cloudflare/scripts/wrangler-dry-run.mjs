import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { accessSync, constants, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pinnedWranglerVersion = '4.127.1'
const localWrangler = resolve(root, 'node_modules', '.bin', process.platform === 'win32' ? 'wrangler.cmd' : 'wrangler')

function assertPinnedLocalWrangler() {
  accessSync(localWrangler, constants.X_OK)
  const packageConfig = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
  const installedManifest = JSON.parse(readFileSync(resolve(root, 'node_modules', 'wrangler', 'package.json'), 'utf8'))
  assert.equal(packageConfig.devDependencies.wrangler, pinnedWranglerVersion, 'package.json must pin the audited Wrangler version')
  assert.equal(installedManifest.version, pinnedWranglerVersion, 'installed Wrangler must match the audited package.json pin')
}

export function runWranglerDryRun(deployment, options = {}) {
  if (!['production', 'staging'].includes(deployment)) {
    throw new Error('Usage: node scripts/wrangler-dry-run.mjs <production|staging>')
  }

  assertPinnedLocalWrangler()
  const spawn = options.spawn ?? spawnSync
  const workers = [
    'hid-web', 'hid-ehr', 'hid-lab', 'hid-pharmacy', 'hid-ocr', 'hid-outreach', 'hid-admin',
    ...(deployment === 'production' ? ['hid-apex-redirect'] : []),
  ]

  for (const worker of workers) {
    const config = resolve(root, 'workers', worker, 'wrangler.json')
    const result = spawn(localWrangler, [
      'deploy', '--dry-run', '--env', deployment, '--config', config,
    ], { cwd: root, stdio: 'inherit' })
    if (result.error) {
      throw new Error(`Could not run pinned local Wrangler for ${worker}: ${result.error.message}`)
    }
    if (result.status !== 0) {
      throw new Error(`Wrangler ${deployment} dry-run failed for ${worker}`)
    }
  }

  process.stdout.write(`Wrangler ${deployment} dry-run passed for ${workers.length} Workers without deployment.\n`)
  return workers
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runWranglerDryRun(process.argv[2])
}
