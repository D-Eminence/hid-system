import assert from 'node:assert/strict'
import { access, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..', '..', '..')
const applications = [
  ['hid-web', 'web', 'www.healthidentitydirectory.com'],
  ['hid-ehr', 'ehr', 'ehr.healthidentitydirectory.com'],
  ['hid-lab', 'lab', 'lab.healthidentitydirectory.com'],
  ['hid-pharmacy', 'pharmacy', 'pharmacy.healthidentitydirectory.com'],
  ['hid-ocr', 'ocr', 'ocr.healthidentitydirectory.com'],
  ['hid-outreach', 'outreach', 'outreach.healthidentitydirectory.com'],
  ['hid-admin', 'admin', 'admin.healthidentitydirectory.com'],
]

for (const [worker, app, host] of applications) {
  const path = resolve(root, 'infra', 'cloudflare', 'workers', worker, 'wrangler.json')
  const config = JSON.parse(await readFile(path, 'utf8'))
  assert.equal(config.name, worker)
  assert.equal(config.main, '../../src/frontend-worker.mjs')
  assert.equal(config.assets.directory, `../../../apps/${app}/dist`)
  assert.equal(config.assets.binding, 'ASSETS')
  assert.equal(config.assets.not_found_handling, 'single-page-application')
  assert.equal(config.assets.run_worker_first, true)
  assert.deepEqual(config.routes, [{ pattern: host, custom_domain: true }])
  assert.equal(config.vars.API_ORIGIN, 'https://api.healthidentitydirectory.com')
  assert.equal(config.vars.EXPECTED_HOST, host)

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
  const hostRoot = new URL(`https://${host}/`)
  assert.equal(new URL(manifest.scope, hostRoot).pathname, '/', `${app} manifest scope must resolve to its host root`)
  assert.equal(new URL(manifest.start_url, hostRoot).pathname, '/', `${app} manifest start URL must resolve to its host root`)
  await access(resolve(dist, 'service-worker.js'))
}

const apex = JSON.parse(await readFile(resolve(root, 'infra/cloudflare/workers/hid-apex-redirect/wrangler.json'), 'utf8'))
assert.deepEqual(apex.routes, [{ pattern: 'healthidentitydirectory.com', custom_domain: true }])
process.stdout.write('Cloudflare configuration verified: seven frontend Workers and one apex redirect.\n')
