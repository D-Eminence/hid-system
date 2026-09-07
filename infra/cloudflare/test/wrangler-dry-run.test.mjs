import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import test from 'node:test'
import { runWranglerDryRun } from '../scripts/wrangler-dry-run.mjs'

const cloudflareRoot = resolve(import.meta.dirname, '..')
const localWrangler = resolve(
  cloudflareRoot,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'wrangler.cmd' : 'wrangler',
)

test('frontend dry-runs use only the pinned local Wrangler executable', () => {
  for (const [deployment, expectedWorkers] of [
    ['staging', ['hid-web', 'hid-ehr', 'hid-lab', 'hid-pharmacy', 'hid-ocr', 'hid-outreach', 'hid-admin']],
    ['production', ['hid-web', 'hid-ehr', 'hid-lab', 'hid-pharmacy', 'hid-ocr', 'hid-outreach', 'hid-admin', 'hid-apex-redirect']],
  ]) {
    const invocations = []
    const workers = runWranglerDryRun(deployment, {
      spawn(binary, args, options) {
        invocations.push({ binary, args, options })
        return { status: 0 }
      },
    })

    assert.deepEqual(workers, expectedWorkers)
    assert.equal(invocations.length, expectedWorkers.length)
    for (const [index, invocation] of invocations.entries()) {
      assert.equal(invocation.binary, localWrangler)
      assert.deepEqual(invocation.args, [
        'deploy',
        '--dry-run',
        '--env',
        deployment,
        '--config',
        resolve(cloudflareRoot, 'workers', expectedWorkers[index], 'wrangler.json'),
      ])
      assert.equal(invocation.options.cwd, cloudflareRoot)
      assert.equal(invocation.options.stdio, 'inherit')
    }
  }
})

test('frontend dry-run wrapper rejects unknown environments and failed Wrangler checks', () => {
  assert.throws(() => runWranglerDryRun('development'), /Usage:/)
  assert.throws(
    () => runWranglerDryRun('staging', { spawn: () => ({ status: 1 }) }),
    /staging dry-run failed for hid-web/,
  )
  assert.throws(
    () => runWranglerDryRun('production', { spawn: () => ({ status: null, error: new Error('unavailable') }) }),
    /Could not run pinned local Wrangler for hid-web: unavailable/,
  )
})

test('frontend dry-run source contains no network package runner or stale Wrangler pin', async () => {
  const source = await readFile(resolve(cloudflareRoot, 'scripts', 'wrangler-dry-run.mjs'), 'utf8')
  assert.doesNotMatch(source, /\bnpx\b/)
  assert.doesNotMatch(source, /wrangler@/)
  assert.doesNotMatch(source, /4\.33\.0/)
})
