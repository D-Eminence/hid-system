import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { access, readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import duplicateKeyJson from 'json-dup-key-validator'

import { HEALTH_ID_WORKERS, LAUNCH_DECISION, assertHealthIdWorkerConfig, verifyLaunchDeployment } from './launch-deployment.mjs'

// `--launch <environment>` is the pre-deployment check: every Worker the launch
// manifest deploys there must have a verified staged Health-id artefact.
// Without it (repository mode, as the root `npm run verify` runs it) staged
// artefacts are optional, but any that is present must verify. Repository mode
// also checks the legacy apps/<app>/dist build of every other frontend Worker;
// launch mode keeps their configuration checks but skips the builds of the
// Workers the launch decision does not deploy in that environment, so an
// operator needs only the Health-id builds (P14).
const USAGE = 'Usage: node scripts/verify-config.mjs [--launch <staging|production>]'
function parseArguments(argv) {
  if (argv.length === 0) return null
  if (argv.length === 2 && argv[0] === '--launch' && ['staging', 'production'].includes(argv[1])) return argv[1]
  process.stderr.write(`${USAGE}\n`)
  process.exit(1)
}
const launchEnvironment = parseArguments(process.argv.slice(2))

const root = resolve(import.meta.dirname, '..', '..', '..')
const cloudflareRoot = resolve(root, 'infra', 'cloudflare')
const packagePins = Object.freeze({
  '@cloudflare/workers-types': Object.freeze({
    version: '5.20261006.1',
    integrity: 'sha512-5OclwQK1d8f5LCPvOlyldC3ryKLUa4nLXegcgPZeUxAPudczQ9xujJDdpS2Tenp7JqbBLW3OgGciHJmuc7QShg==',
    lockPath: 'node_modules/@cloudflare/workers-types',
  }),
  'json-dup-key-validator': Object.freeze({
    version: '1.0.3',
    integrity: 'sha512-JvJcV01JSiO7LRz7DY1Fpzn4wX2rJ3dfNTiAfnlvLNdhhnm0Pgdvhi2SGpENrZn7eSg26Ps3TPhOcuD/a4STXQ==',
    lockPath: 'node_modules/json-dup-key-validator',
  }),
  wrangler: Object.freeze({
    version: '4.149.0',
    integrity: 'sha512-OzK7xmB5r5iLKb3cIT3783g13fe6T7xyeKu9LEdUyl+DKAM2KP/jkjnE0OUhyw+mB/XJM9ycjgF3MWm8PR9amg==',
    lockPath: 'node_modules/wrangler',
  }),
})
const wranglerSchemaSha256 = '12dbdc9ba08cb4db1213bbe3d917a6f5f0bb6ee0852b56d9b4c66b3ab588c42c'
const wranglerBinSha256 = '780661a508810f3b65786895b1ca9aacbc4f55d329ae6b8c1e49ec8433569f77'
const wranglerCliSha256 = '31866b9a3686777254819158e60ebe4920d1d91141cde68846c62b52f75d7a66'

function parseStrictJson(raw, label) {
  try {
    return duplicateKeyJson.parse(raw, false)
  } catch (error) {
    throw new Error(`${label} must be duplicate-free JSON: ${error.message}`)
  }
}

async function readStrictJson(path, label) {
  const raw = await readFile(path, 'utf8')
  return { raw, value: parseStrictJson(raw, label) }
}

const packagePath = resolve(cloudflareRoot, 'package.json')
const lockPath = resolve(cloudflareRoot, 'package-lock.json')
const { value: packageConfig } = await readStrictJson(packagePath, 'infra/cloudflare/package.json')
const packageLock = JSON.parse(await readFile(lockPath, 'utf8'))
assert.equal(packageLock.lockfileVersion, 3)
assert.equal(packageLock.requires, true)
assert.deepEqual(Object.keys(packageConfig.devDependencies).sort(), Object.keys(packagePins).sort())
assert.deepEqual(packageLock.packages[''].devDependencies, packageConfig.devDependencies)

for (const [name, pin] of Object.entries(packagePins)) {
  assert.equal(packageConfig.devDependencies[name], pin.version, `${name} must use its exact audited version`)
  assert.equal(packageLock.packages[pin.lockPath].version, pin.version, `${name} lock version must match package.json`)
  assert.equal(packageLock.packages[pin.lockPath].integrity, pin.integrity, `${name} lock integrity must match its audited artifact`)
  assert.equal(packageLock.packages[pin.lockPath].dev, true, `${name} must remain a development-only dependency`)

  const installedManifestPath = resolve(cloudflareRoot, pin.lockPath, 'package.json')
  const { value: installedManifest } = await readStrictJson(installedManifestPath, `${name} installed package manifest`)
  assert.equal(installedManifest.version, pin.version, `${name} installed version must match package.json and package-lock.json`)
}

const wranglerSchemaPath = resolve(cloudflareRoot, 'node_modules', 'wrangler', 'config-schema.json')
const schemaBytes = await readFile(wranglerSchemaPath)
assert.equal(
  createHash('sha256').update(schemaBytes).digest('hex'),
  wranglerSchemaSha256,
  'installed Wrangler configuration schema must match the audited pinned schema',
)
const wranglerSchema = parseStrictJson(schemaBytes.toString('utf8'), 'pinned Wrangler configuration schema')
assert.equal(wranglerSchema.$schema, 'http://json-schema.org/draft-07/schema#')
assert.equal(typeof wranglerSchema.definitions, 'object')
assert.equal(typeof wranglerSchema.definitions.RawConfig, 'object')
assert.equal(typeof wranglerSchema.definitions.Assets, 'object')
assert.equal(typeof wranglerSchema.definitions.Observability, 'object')
assert.ok(Array.isArray(wranglerSchema.allOf))

for (const [relativePath, expectedSha256] of [
  ['node_modules/wrangler/bin/wrangler.js', wranglerBinSha256],
  ['node_modules/wrangler/wrangler-dist/cli.js', wranglerCliSha256],
]) {
  const bytes = await readFile(resolve(cloudflareRoot, relativePath))
  assert.equal(
    createHash('sha256').update(bytes).digest('hex'),
    expectedSha256,
    `${relativePath} must match the audited Wrangler ${packagePins.wrangler.version} bytes`,
  )
}

const applications = [
  ['hid-web', 'web', 'www.healthidentitydirectory.com', 'staging.healthidentitydirectory.com'],
  ['hid-ehr', 'ehr', 'ehr.healthidentitydirectory.com', 'ehr.staging.healthidentitydirectory.com'],
  ['hid-lab', 'lab', 'lab.healthidentitydirectory.com', 'lab.staging.healthidentitydirectory.com'],
  ['hid-pharmacy', 'pharmacy', 'pharmacy.healthidentitydirectory.com', 'pharmacy.staging.healthidentitydirectory.com'],
  ['hid-ocr', 'ocr', 'migrate.healthidentitydirectory.com', 'migrate.staging.healthidentitydirectory.com'],
  ['hid-outreach', 'outreach', 'outreach.healthidentitydirectory.com', 'outreach.staging.healthidentitydirectory.com'],
  ['hid-admin', 'admin', 'admin.healthidentitydirectory.com', 'admin.staging.healthidentitydirectory.com'],
]

const notDeployedAtLaunch = new Set(launchEnvironment === null ? [] : LAUNCH_DECISION[launchEnvironment].not_deployed)
const skippedLegacyBuilds = []

const deployments = [
  ['production', 'https://api.healthidentitydirectory.com'],
  ['staging', 'https://api.staging.healthidentitydirectory.com'],
]

for (const [worker, app, productionHost, stagingHost] of applications) {
  const path = resolve(cloudflareRoot, 'workers', worker, 'wrangler.json')
  const { raw, value: config } = await readStrictJson(path, `${worker} Wrangler configuration`)
  const healthId = HEALTH_ID_WORKERS.includes(worker)
  assert.equal(config.name, worker)
  assert.equal(config.main, '../../src/frontend-worker.mjs')
  if (healthId) {
    // ADR-052: www, staging and admin.* serve the Health-id patient-web build
    // staged for each environment (with its provenance), not apps/web or apps/admin.
    assertHealthIdWorkerConfig(worker, config)
  } else {
    assert.equal(config.assets.directory, `../../../../apps/${app}/dist`)
    assert.equal(config.assets.binding, 'ASSETS')
    assert.equal(config.assets.not_found_handling, 'single-page-application')
    assert.equal(config.assets.run_worker_first, true)
  }
  assert.equal(config.routes, undefined, `${worker} must require an explicit deployment environment`)
  assert.equal(config.vars, undefined, `${worker} must not have a default API environment`)
  assert.deepEqual(Object.keys(config.env).sort(), ['production', 'staging'])
  assert.doesNotMatch(raw, /ORIGIN_AUTH_TOKEN/, `${worker} must not commit an origin authorization secret`)

  for (const [deployment, apiOrigin] of deployments) {
    const host = deployment === 'production' ? productionHost : stagingHost
    const environment = config.env[deployment]
    assert.equal(environment.name, `${worker}-${deployment}`)
    assert.deepEqual(environment.routes, [{ pattern: host, custom_domain: true }])
    assert.deepEqual(environment.vars, {
      DEPLOYMENT_ENV: deployment,
      API_ORIGIN: apiOrigin,
      EXPECTED_HOST: host,
      APP_NAME: app,
    })
    if (!healthId) assert.equal(environment.assets, undefined, `${worker} must serve one artifact in every environment`)
  }

  // The Health-id artefact deliberately has no manifest.webmanifest or
  // service-worker.js (Health-id registers no service worker and keeps no
  // clinical data in browser storage); its rules and provenance are checked by
  // verifyLaunchDeployment below. The legacy applications keep these checks.
  if (healthId) continue
  if (notDeployedAtLaunch.has(worker)) {
    skippedLegacyBuilds.push(worker)
    continue
  }

  const dist = resolve(root, 'apps', app, 'dist')
  const html = await readFile(resolve(dist, 'index.html'), 'utf8')
  const publicBase = '/'
  const assetPrefix = publicBase === '/' ? '/assets/' : `${publicBase}assets/`
  assert.ok(html.includes(`src="${assetPrefix}`) || html.includes(`href="${assetPrefix}`),
    `${app} Cloudflare artifact must load assets from ${publicBase}`)
  if (app === 'ocr') {
    assert.match(
      html,
      /rel="canonical" href="https:\/\/migrate\.healthidentitydirectory\.com\/"/,
      'Migrate Cloudflare artifact must retain its canonical hostname-root URL',
    )
  }
  if (app !== 'web' && app !== 'ocr') {
    assert.doesNotMatch(
      html,
      new RegExp(`(?:src|href)=["']\\/${app}\\/`),
      `${app} Cloudflare artifact must not retain its local path prefix`,
    )
  }

  const manifest = JSON.parse(await readFile(resolve(dist, 'manifest.webmanifest'), 'utf8'))
  for (const host of [productionHost, stagingHost]) {
    const hostRoot = new URL(`https://${host}/`)
    const appBase = new URL(publicBase, hostRoot)
    assert.equal(new URL(manifest.scope, appBase).pathname, publicBase, `${app} manifest scope must resolve to ${publicBase}`)
    assert.equal(new URL(manifest.start_url, appBase).pathname, publicBase, `${app} manifest start URL must resolve to ${publicBase}`)
  }
  await access(resolve(dist, 'service-worker.js'))
}

const { value: apex } = await readStrictJson(
  resolve(cloudflareRoot, 'workers', 'hid-apex-redirect', 'wrangler.json'),
  'hid-apex-redirect Wrangler configuration',
)
assert.equal(apex.routes, undefined)
assert.deepEqual(Object.keys(apex.env), ['production'])
assert.equal(apex.env.production.name, 'hid-apex-redirect-production')
assert.deepEqual(apex.env.production.routes, [{ pattern: 'healthidentitydirectory.com', custom_domain: true }])

const { raw: legacyOcrRedirectRaw, value: legacyOcrRedirect } = await readStrictJson(
  resolve(cloudflareRoot, 'workers', 'hid-ocr-redirect', 'wrangler.json'),
  'hid-ocr-redirect Wrangler configuration',
)
assert.equal(legacyOcrRedirect.name, 'hid-ocr-redirect')
assert.equal(legacyOcrRedirect.main, '../../src/legacy-ocr-domain-redirect-worker.mjs')
assert.equal(legacyOcrRedirect.routes, undefined)
assert.equal(legacyOcrRedirect.vars, undefined)
assert.equal(legacyOcrRedirect.assets, undefined)
assert.deepEqual(Object.keys(legacyOcrRedirect.env).sort(), ['production', 'staging'])
for (const [deployment, expectedHost, targetOrigin] of [
  ['production', 'ocr.healthidentitydirectory.com', 'https://migrate.healthidentitydirectory.com'],
  ['staging', 'ocr.staging.healthidentitydirectory.com', 'https://migrate.staging.healthidentitydirectory.com'],
]) {
  const environment = legacyOcrRedirect.env[deployment]
  assert.equal(environment.name, `hid-ocr-redirect-${deployment}`)
  assert.deepEqual(environment.routes, [{ pattern: expectedHost, custom_domain: true }])
  assert.deepEqual(environment.vars, { DEPLOYMENT_ENV: deployment, EXPECTED_HOST: expectedHost, TARGET_ORIGIN: targetOrigin })
}
assert.doesNotMatch(legacyOcrRedirectRaw, /ORIGIN_AUTH_TOKEN/, 'legacy redirect must not require an API-origin secret')

const tufDeployments = Object.freeze({
  staging: 'updates.staging.healthidentitydirectory.com',
  production: 'updates.healthidentitydirectory.com',
})
const tufNames = new Set()
for (const [deployment, host] of Object.entries(tufDeployments)) {
  const worker = `hid-tuf-${deployment}`
  const path = resolve(cloudflareRoot, 'workers', worker, 'wrangler.json')
  const { raw, value: config } = await readStrictJson(path, `${worker} Wrangler configuration`)
  assert.deepEqual(config, {
    $schema: '../../node_modules/wrangler/config-schema.json',
    name: worker,
    main: '../../src/tuf-repository-worker.mjs',
    compatibility_date: '2026-08-31',
    compatibility_flags: ['nodejs_compat'],
    workers_dev: false,
    preview_urls: true,
    routes: [{ pattern: host, custom_domain: true }],
    vars: {
      DEPLOYMENT_ENV: deployment,
      EXPECTED_HOST: host,
      WORKER_NAME: worker,
    },
    assets: {
      directory: './repository',
      binding: 'ASSETS',
      html_handling: 'none',
      not_found_handling: 'none',
      run_worker_first: true,
    },
    observability: {
      enabled: true,
      logs: { enabled: true, head_sampling_rate: 1, invocation_logs: false },
      traces: { enabled: false },
    },
  })
  assert.equal(resolve(dirname(path), config.$schema), wranglerSchemaPath)
  assert.doesNotMatch(raw, /password|private[_-]?key|api[_-]?token|secret/i)
  tufNames.add(config.name)
}
assert.equal(tufNames.size, 2, 'staging and production TUF Workers must remain isolated')

const ignore = await readFile(resolve(cloudflareRoot, '.gitignore'), 'utf8')
assert.match(ignore, /hid-tuf-staging\/repository\//)
assert.match(ignore, /hid-tuf-production\/repository\//)
assert.match(ignore, /^\/workers\/\*\/staged\/$/m, 'staged Health-id artefacts must never be committed')

const launch = await verifyLaunchDeployment({ cloudflareRoot, environment: launchEnvironment, requireStaged: launchEnvironment !== null })

process.stdout.write(
  'Cloudflare configuration verified: seven isolated production/staging frontend Worker configurations (hid-web and hid-admin serve the staged Health-id build), one legacy OCR-domain redirect per environment, one production apex redirect, two isolated TUF repository Workers, the launch deployment manifest, and the pinned local Wrangler schema/toolchain.\n',
)
process.stdout.write(launchEnvironment === null
  ? `Staged Health-id artefacts verified: ${launch.artifacts.length === 0 ? 'none present' : launch.artifacts.map((artifact) => `${artifact.worker}/${artifact.environment} at ${artifact.source_commit}`).join(', ')}.\n`
  : `Launch ${launchEnvironment} verified: deploy ${launch.deploy.join(', ')}; not deployed ${launch.not_deployed.join(', ')}; artefacts ${launch.artifacts.map((artifact) => `${artifact.worker} ${artifact.host} at ${artifact.source_commit} (tree ${artifact.tree_sha256})`).join(', ')}. `
    + `The apps/*/dist builds of the Workers not deployed in ${launchEnvironment} were not required (${skippedLegacyBuilds.join(', ')}); their configurations were checked.\n`)
