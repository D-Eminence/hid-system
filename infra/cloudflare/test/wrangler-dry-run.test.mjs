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

test('frontend dry-runs cover only the launch Workers and use only the pinned local Wrangler executable', async () => {
  for (const [deployment, expectedWorkers] of [
    ['staging', ['hid-web', 'hid-admin']],
    ['production', ['hid-web', 'hid-admin', 'hid-apex-redirect']],
  ]) {
    const invocations = []
    const verified = []
    const workers = await runWranglerDryRun(deployment, {
      async verifyLaunch(environment) {
        verified.push(environment)
        return { deploy: expectedWorkers }
      },
      spawn(binary, args, options) {
        invocations.push({ binary, args, options })
        return { status: 0 }
      },
    })

    assert.deepEqual(verified, [deployment], 'the staged launch artefacts are verified before Wrangler runs')
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
    for (const deferred of ['hid-ehr', 'hid-lab', 'hid-pharmacy', 'hid-ocr', 'hid-outreach', 'hid-ocr-redirect']) {
      assert.ok(!workers.includes(deferred), `${deferred} is not deployed at launch`)
    }
  }
})

test('frontend dry-run wrapper rejects unknown environments, unverified artefacts and failed Wrangler checks', async () => {
  const verifyLaunch = async () => ({})
  await assert.rejects(runWranglerDryRun('development', { verifyLaunch }), /Usage:/)
  let spawned = false
  await assert.rejects(runWranglerDryRun('staging', {
    verifyLaunch: async () => { throw new Error('hid-web staging artefact is not staged') },
    spawn: () => { spawned = true; return { status: 0 } },
  }), /not staged/)
  assert.equal(spawned, false, 'Wrangler must not run before the launch artefacts verify')
  await assert.rejects(
    runWranglerDryRun('staging', { verifyLaunch, spawn: () => ({ status: 1 }) }),
    /staging dry-run failed for hid-web/,
  )
  await assert.rejects(
    runWranglerDryRun('production', { verifyLaunch, spawn: () => ({ status: null, error: new Error('unavailable') }) }),
    /Could not run pinned local Wrangler for hid-web: unavailable/,
  )
})

test('frontend dry-run source contains no network package runner or stale Wrangler pin', async () => {
  const source = await readFile(resolve(cloudflareRoot, 'scripts', 'wrangler-dry-run.mjs'), 'utf8')
  assert.doesNotMatch(source, /\bnpx\b/)
  assert.doesNotMatch(source, /wrangler@/)
  assert.doesNotMatch(source, /4\.33\.0/)
})
