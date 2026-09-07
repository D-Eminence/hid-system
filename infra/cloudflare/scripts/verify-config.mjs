import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { access, readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import duplicateKeyJson from 'json-dup-key-validator'

const root = resolve(import.meta.dirname, '..', '..', '..')
const cloudflareRoot = resolve(root, 'infra', 'cloudflare')
const packagePins = Object.freeze({
  '@cloudflare/workers-types': Object.freeze({
    version: '5.20260831.1',
    integrity: 'sha512-yXg4pwfYjhsDH9rYc3qZ3K+z62DCSvO/aj7GiZo6AyDeWGZpyFRpPMYcQ6LF/zfaf1x0Ngw2gSqL8JjuUtMGlA==',
    lockPath: 'node_modules/@cloudflare/workers-types',
  }),
  'json-dup-key-validator': Object.freeze({
    version: '1.0.3',
    integrity: 'sha512-JvJcV01JSiO7LRz7DY1Fpzn4wX2rJ3dfNTiAfnlvLNdhhnm0Pgdvhi2SGpENrZn7eSg26Ps3TPhOcuD/a4STXQ==',
    lockPath: 'node_modules/json-dup-key-validator',
  }),
  wrangler: Object.freeze({
    version: '4.127.1',
    integrity: 'sha512-OzsiNgaI8i681L/+KnAKc+uEZ5D57xK5JuNvCOpRKICF4/5Q3Cu1oTGuUiT/f3GDUqQb3gzXNT0tfOHGMEtknw==',
    lockPath: 'node_modules/wrangler',
  }),
})
const wranglerSchemaSha256 = 'e42dc556dcb039aa1103d4811b1f58497e2676aceee20488d9ceb1d8ab712018'
const wranglerBinSha256 = '780661a508810f3b65786895b1ca9aacbc4f55d329ae6b8c1e49ec8433569f77'
const wranglerCliSha256 = 'ba531de00d3c21615f3d523df4e83a94d487de68d77225aa703463b6a2979406'

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
  ['hid-ocr', 'ocr', 'ocr.healthidentitydirectory.com', 'ocr.staging.healthidentitydirectory.com'],
  ['hid-outreach', 'outreach', 'outreach.healthidentitydirectory.com', 'outreach.staging.healthidentitydirectory.com'],
  ['hid-admin', 'admin', 'admin.healthidentitydirectory.com', 'admin.staging.healthidentitydirectory.com'],
]

const deployments = [
  ['production', 'https://api.healthidentitydirectory.com'],
  ['staging', 'https://api.staging.healthidentitydirectory.com'],
]

for (const [worker, app, productionHost, stagingHost] of applications) {
  const path = resolve(cloudflareRoot, 'workers', worker, 'wrangler.json')
  const { raw, value: config } = await readStrictJson(path, `${worker} Wrangler configuration`)
  assert.equal(config.name, worker)
  assert.equal(config.main, '../../src/frontend-worker.mjs')
  assert.equal(config.assets.directory, `../../../../apps/${app}/dist`)
  assert.equal(config.assets.binding, 'ASSETS')
  assert.equal(config.assets.not_found_handling, 'single-page-application')
  assert.equal(config.assets.run_worker_first, true)
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
  }

  const dist = resolve(root, 'apps', app, 'dist')
  const html = await readFile(resolve(dist, 'index.html'), 'utf8')
  assert.match(html, /(?:src|href)="\/assets\//, `${app} Cloudflare artifact must load assets from its host root`)
  if (app !== 'web') {
    assert.doesNotMatch(
      html,
      new RegExp(`(?:src|href)=["']\\/${app}\\/`),
      `${app} Cloudflare artifact must not retain its local path prefix`,
    )
  }

  const manifest = JSON.parse(await readFile(resolve(dist, 'manifest.webmanifest'), 'utf8'))
  for (const host of [productionHost, stagingHost]) {
    const hostRoot = new URL(`https://${host}/`)
    assert.equal(new URL(manifest.scope, hostRoot).pathname, '/', `${app} manifest scope must resolve to its host root`)
    assert.equal(new URL(manifest.start_url, hostRoot).pathname, '/', `${app} manifest start URL must resolve to its host root`)
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

process.stdout.write(
  'Cloudflare configuration verified: seven isolated production/staging frontend Workers, one production apex redirect, two isolated TUF repository Workers, and the pinned local Wrangler schema/toolchain.\n',
)
