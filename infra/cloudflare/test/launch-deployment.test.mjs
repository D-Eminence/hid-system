import assert from 'node:assert/strict'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import test from 'node:test'

import { stageHealthIdBuild } from '../scripts/health-id-artifact.mjs'
import {
  HEALTH_ID_WORKERS,
  LAUNCH_DECISION,
  assertLaunchManifest,
  configuredWorkers,
  launchWorkers,
  loadWorkerConfigs,
  readLaunchManifest,
  verifyLaunchDeployment,
} from '../scripts/launch-deployment.mjs'
import { SOURCE_COMMIT, temporaryDirectory, writeHealthIdBuild } from './helpers/health-id-build-fixture.mjs'

const cloudflareRoot = resolve(import.meta.dirname, '..')
const repositoryRoot = resolve(cloudflareRoot, '..', '..')
const DEFERRED_PRODUCT_WORKERS = ['hid-lab', 'hid-pharmacy', 'hid-ocr', 'hid-ocr-redirect', 'hid-outreach']

function names(entries) {
  return entries.map((entry) => entry.worker)
}

test('the launch manifest deploys only the Health-id web and admin hosts (and the production apex redirect)', async () => {
  const manifest = await readLaunchManifest(cloudflareRoot)
  assert.equal(manifest.schema_version, 'hid.cloudflare.launch-deployment/v1')
  assert.deepEqual(Object.keys(manifest.environments).sort(), ['production', 'staging'])
  assert.deepEqual(names(manifest.environments.staging.deploy), ['hid-web', 'hid-admin'])
  assert.deepEqual(names(manifest.environments.production.deploy), ['hid-web', 'hid-admin', 'hid-apex-redirect'])
  assert.deepEqual(launchWorkers(manifest, 'staging'), ['hid-web', 'hid-admin'])
  assert.deepEqual(launchWorkers(manifest, 'production'), ['hid-web', 'hid-admin', 'hid-apex-redirect'])
  assert.deepEqual(HEALTH_ID_WORKERS, ['hid-web', 'hid-admin'])

  for (const environment of ['staging', 'production']) {
    const plan = manifest.environments[environment]
    for (const worker of DEFERRED_PRODUCT_WORKERS) {
      assert.ok(names(plan.not_deployed).includes(worker), `${worker} must be marked not deployed in ${environment}`)
    }
    assert.ok(names(plan.not_deployed).includes('hid-ehr'), 'the legacy EHR product host is not deployed at launch')
    assert.deepEqual(names(plan.separately_governed), [`hid-tuf-${environment}`])
    for (const entry of plan.deploy.filter((item) => HEALTH_ID_WORKERS.includes(item.worker))) {
      assert.equal(entry.assets, 'health-id-patient-web')
      assert.equal(entry.proxies_api, true)
    }
    for (const entry of plan.not_deployed) assert.match(entry.reason, /\S/)
  }
  assert.deepEqual(manifest.environments.production.deploy.find((item) => item.worker === 'hid-apex-redirect'),
    { worker: 'hid-apex-redirect', host: 'healthidentitydirectory.com', assets: null, proxies_api: false })
  assert.deepEqual(LAUNCH_DECISION.staging.deploy, ['hid-web', 'hid-admin'])
})

test('API closure for deferred modules is the gateway route switch, not the absence of a host', async () => {
  const manifest = await readLaunchManifest(cloudflareRoot)
  assert.equal(manifest.api_route_closure.mechanism, 'gateway HID_ENABLED_API_ROUTES')
  const config = await readFile(resolve(repositoryRoot, 'infra/aws/src/config.ts'), 'utf8')
  const launchRoutes = config.match(/export const launchApiRoutes[^=]*=\s*\[([^\]]*)\]/)
  assert.ok(launchRoutes, 'infra/aws/src/config.ts must define launchApiRoutes')
  assert.deepEqual(manifest.api_route_closure.launch_modules, [...launchRoutes[1].matchAll(/'([a-z]+)'/g)].map((match) => match[1]))
  for (const module of ['lab', 'pharmacy', 'ocr', 'outreach']) {
    assert.ok(!manifest.api_route_closure.launch_modules.includes(module), `${module} must stay closed at the gateway`)
  }
})

test('every configured worker is classified exactly once per environment', async () => {
  const configs = await loadWorkerConfigs(cloudflareRoot)
  const directories = (await readdir(resolve(cloudflareRoot, 'workers'), { withFileTypes: true }))
    .filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()
  assert.deepEqual(Object.keys(configs).sort(), directories)
  assert.deepEqual(configuredWorkers(configs, 'staging'), [
    'hid-admin', 'hid-ehr', 'hid-lab', 'hid-ocr', 'hid-ocr-redirect', 'hid-outreach', 'hid-pharmacy', 'hid-tuf-staging', 'hid-web',
  ])
  assert.deepEqual(configuredWorkers(configs, 'production'), [
    'hid-admin', 'hid-apex-redirect', 'hid-ehr', 'hid-lab', 'hid-ocr', 'hid-ocr-redirect', 'hid-outreach', 'hid-pharmacy',
    'hid-tuf-production', 'hid-web',
  ])

  const manifest = await readLaunchManifest(cloudflareRoot)
  assertLaunchManifest(manifest, configs)
  const mutations = [
    ['an unclassified worker', (m) => { m.environments.staging.not_deployed = m.environments.staging.not_deployed.filter((e) => e.worker !== 'hid-lab') }],
    ['a deferred module deployed', (m) => {
      m.environments.production.not_deployed = m.environments.production.not_deployed.filter((e) => e.worker !== 'hid-lab')
      m.environments.production.deploy.push({ worker: 'hid-lab', host: 'lab.healthidentitydirectory.com', assets: 'health-id-patient-web', proxies_api: true })
    }],
    ['a worker classified twice', (m) => { m.environments.staging.not_deployed.push({ worker: 'hid-web', reason: 'duplicate' }) }],
    ['an unknown worker', (m) => { m.environments.staging.not_deployed.push({ worker: 'hid-unknown', reason: 'unknown' }) }],
    ['a deployed host that is not the Worker host', (m) => { m.environments.staging.deploy[0].host = 'www.healthidentitydirectory.com' }],
    ['a deployed frontend served from a legacy build', (m) => { m.environments.staging.deploy[1].assets = 'legacy-apps-admin' }],
    ['a third environment', (m) => { m.environments.development = m.environments.staging }],
    ['a different API closure', (m) => { m.api_route_closure.launch_modules = ['identity', 'ehr', 'lab'] }],
  ]
  for (const [label, mutate] of mutations) {
    const copy = structuredClone(manifest)
    mutate(copy)
    assert.throws(() => assertLaunchManifest(copy, configs), Error, `${label} must be refused`)
  }
})

test('the Health-id workers serve the staged artefact of their own environment', async () => {
  const configs = await loadWorkerConfigs(cloudflareRoot)
  for (const worker of ['hid-web', 'hid-admin']) {
    const config = configs[worker]
    assert.equal(config.assets, undefined, `${worker} must not have a default asset directory`)
    for (const environment of ['staging', 'production']) {
      assert.deepEqual(config.env[environment].assets, {
        directory: `./staged/${environment}/site`,
        binding: 'ASSETS',
        not_found_handling: 'single-page-application',
        run_worker_first: true,
      })
    }
    assert.doesNotMatch(JSON.stringify(config), /apps\/(?:web|admin)\/dist/)
  }
  const ignore = await readFile(resolve(cloudflareRoot, '.gitignore'), 'utf8')
  assert.match(ignore, /^\/workers\/\*\/staged\/$/m, 'staged artefacts must never be committed')
})

async function stagedRootFixture(t) {
  const root = await temporaryDirectory()
  t.after(() => rm(root, { recursive: true, force: true }))
  const stagedDirectoryFor = (worker, environment) => resolve(root, 'staged', worker, environment)
  const stage = async (worker, environment) => {
    const build = await writeHealthIdBuild(resolve(root, 'builds', worker, environment), { worker, environment })
    return stageHealthIdBuild({
      build, sourceCommit: SOURCE_COMMIT, worker, environment, cloudflareRoot,
      stagedDirectory: stagedDirectoryFor(worker, environment),
    })
  }
  return { root, stagedDirectoryFor, stage }
}

test('launch verification requires a verified staged artefact for every deployed Health-id worker', async (t) => {
  const fixture = await stagedRootFixture(t)
  const verify = (environment) => verifyLaunchDeployment({
    cloudflareRoot, environment, requireStaged: true, stagedDirectoryFor: fixture.stagedDirectoryFor,
  })
  await assert.rejects(verify('staging'), /hid-web.*not staged/)
  await fixture.stage('hid-web', 'staging')
  await assert.rejects(verify('staging'), /hid-admin.*not staged/)
  await fixture.stage('hid-admin', 'staging')

  const summary = await verify('staging')
  assert.deepEqual(summary.environment, 'staging')
  assert.deepEqual(summary.deploy, ['hid-web', 'hid-admin'])
  assert.deepEqual(summary.not_deployed, ['hid-ehr', 'hid-lab', 'hid-pharmacy', 'hid-ocr', 'hid-outreach', 'hid-ocr-redirect'])
  assert.deepEqual(summary.artifacts.map((artifact) => [artifact.worker, artifact.host, artifact.source_commit]), [
    ['hid-web', 'staging.healthidentitydirectory.com', SOURCE_COMMIT],
    ['hid-admin', 'admin.staging.healthidentitydirectory.com', SOURCE_COMMIT],
  ])

  // A production launch needs production builds; staging artefacts do not count.
  await assert.rejects(verify('production'), /not staged/)
  await assert.rejects(verifyLaunchDeployment({ cloudflareRoot, environment: 'development', requireStaged: true }), /environment/)

  await writeFile(resolve(fixture.stagedDirectoryFor('hid-admin', 'staging'), 'site', 'index.html'), '<!doctype html>')
  await assert.rejects(verify('staging'), /hid-admin/)
})

test('repository verification accepts unstaged workers but refuses a partial or foreign artefact', async (t) => {
  const fixture = await stagedRootFixture(t)
  const verify = () => verifyLaunchDeployment({
    cloudflareRoot, environment: null, requireStaged: false, stagedDirectoryFor: fixture.stagedDirectoryFor,
  })
  const summary = await verify()
  assert.deepEqual(summary.artifacts, [])

  await fixture.stage('hid-web', 'production')
  assert.deepEqual((await verify()).artifacts.map((artifact) => `${artifact.worker}/${artifact.environment}`), ['hid-web/production'])

  const partial = fixture.stagedDirectoryFor('hid-admin', 'staging')
  await mkdir(resolve(partial, 'site'), { recursive: true })
  await writeFile(resolve(partial, 'site', 'index.html'), '<!doctype html>')
  await assert.rejects(verify(), /hid-admin.*provenance/)
  await rm(partial, { recursive: true })

  // An artefact staged for one worker cannot be dropped into another's directory.
  await fixture.stage('hid-web', 'staging')
  await mkdir(fixture.stagedDirectoryFor('hid-admin', 'staging'), { recursive: true })
  for (const name of ['site', 'provenance.json']) {
    await rm(resolve(fixture.stagedDirectoryFor('hid-admin', 'staging'), name), { recursive: true, force: true })
  }
  const { cp } = await import('node:fs/promises')
  await cp(fixture.stagedDirectoryFor('hid-web', 'staging'), fixture.stagedDirectoryFor('hid-admin', 'staging'), { recursive: true })
  await assert.rejects(verify(), /hid-admin/)
})

test('verify-config verifies the launch artefacts of the environment named by --launch, and only those', async () => {
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const execute = promisify(execFile)
  const script = resolve(cloudflareRoot, 'scripts', 'verify-config.mjs')
  for (const args of [['--launch'], ['--launch', 'development'], ['--launch', 'staging', '--launch', 'production'], ['--profile']]) {
    await assert.rejects(execute(process.execPath, [script, ...args]), (error) => {
      assert.equal(error.code, 1)
      assert.match(error.stderr, /Usage: node scripts\/verify-config\.mjs \[--launch <staging\|production>\]/)
      return true
    })
  }
  const source = await readFile(script, 'utf8')
  assert.match(source, /verifyLaunchDeployment\(\{[^}]*requireStaged: launchEnvironment !== null/s)
})
