import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { cp, mkdir, readdir, rm, symlink } from 'node:fs/promises'
import { resolve } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

import { stageHealthIdBuild } from '../scripts/health-id-artifact.mjs'
import { SOURCE_COMMIT, temporaryDirectory, writeHealthIdBuild } from './helpers/health-id-build-fixture.mjs'

const execute = promisify(execFile)
const cloudflareRoot = resolve(import.meta.dirname, '..')

/**
 * A copy of infra/cloudflare (configuration, scripts and Worker configurations,
 * with the installed packages linked) at <root>/infra/cloudflare, so that
 * verify-config.mjs sees a repository with no apps/ builds at all.
 */
async function copyCloudflareTree(root) {
  const target = resolve(root, 'infra', 'cloudflare')
  await mkdir(target, { recursive: true })
  for (const name of ['package.json', 'package-lock.json', '.gitignore', 'launch-deployment.json']) {
    await cp(resolve(cloudflareRoot, name), resolve(target, name))
  }
  await cp(resolve(cloudflareRoot, 'scripts'), resolve(target, 'scripts'), { recursive: true })
  for (const entry of await readdir(resolve(cloudflareRoot, 'workers'), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    await mkdir(resolve(target, 'workers', entry.name), { recursive: true })
    await cp(resolve(cloudflareRoot, 'workers', entry.name, 'wrangler.json'), resolve(target, 'workers', entry.name, 'wrangler.json'))
  }
  await symlink(resolve(cloudflareRoot, 'node_modules'), resolve(target, 'node_modules'), 'dir')
  return target
}

test('verify:launch needs no build of a Worker the launch does not deploy; repository mode still checks those builds', async (t) => {
  const root = await temporaryDirectory('hid-verify-launch-')
  t.after(() => rm(root, { recursive: true, force: true }))
  const copy = await copyCloudflareTree(root)
  const script = resolve(copy, 'scripts', 'verify-config.mjs')
  for (const worker of ['hid-web', 'hid-admin']) {
    const build = await writeHealthIdBuild(resolve(root, 'builds', worker), { worker, environment: 'staging' })
    await stageHealthIdBuild({
      build, sourceCommit: SOURCE_COMMIT, worker, environment: 'staging', cloudflareRoot: copy,
      stagedDirectory: resolve(copy, 'workers', worker, 'staged', 'staging'),
    })
  }

  // The pre-deployment check (P14) on a checkout where only Health-id was built.
  const { stdout } = await execute(process.execPath, [script, '--launch', 'staging'])
  assert.match(stdout, /Launch staging verified: deploy hid-web, hid-admin; not deployed hid-ehr, hid-lab, hid-pharmacy, hid-ocr, hid-outreach, hid-ocr-redirect;/)
  assert.match(stdout, /builds of the Workers not deployed in staging were not required/)

  // Production has no artefacts here: refused for that, not for a legacy build.
  await assert.rejects(execute(process.execPath, [script, '--launch', 'production']), (error) => {
    assert.equal(error.code, 1)
    assert.match(error.stderr, /hid-web production: the Health-id artefact is not staged/)
    assert.doesNotMatch(error.stderr, /apps\/[a-z]+\/dist/)
    return true
  })

  // Repository mode (the root npm run verify) still checks every legacy build.
  await assert.rejects(execute(process.execPath, [script]), (error) => {
    assert.equal(error.code, 1)
    assert.match(error.stderr, /apps\/ehr\/dist\/index\.html/)
    return true
  })
})
