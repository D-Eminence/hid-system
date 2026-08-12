import assert from 'node:assert/strict'
import { access, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..', '..', '..')
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
  const path = resolve(root, 'infra', 'cloudflare', 'workers', worker, 'wrangler.json')
  const raw = await readFile(path, 'utf8')
  const config = JSON.parse(raw)
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

const apex = JSON.parse(await readFile(resolve(root, 'infra/cloudflare/workers/hid-apex-redirect/wrangler.json'), 'utf8'))
assert.equal(apex.routes, undefined)
assert.deepEqual(Object.keys(apex.env), ['production'])
assert.equal(apex.env.production.name, 'hid-apex-redirect-production')
assert.deepEqual(apex.env.production.routes, [{ pattern: 'healthidentitydirectory.com', custom_domain: true }])
process.stdout.write('Cloudflare configuration verified: seven isolated production/staging frontend Workers and one production apex redirect.\n')
