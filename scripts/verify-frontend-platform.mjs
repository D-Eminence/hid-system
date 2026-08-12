#!/usr/bin/env node

import assert from 'node:assert/strict'
import { access, readdir, readFile } from 'node:fs/promises'
import { extname, join, resolve } from 'node:path'

const repository = resolve(import.meta.dirname, '..')
const apps = ['web', 'ehr', 'lab', 'pharmacy', 'ocr', 'outreach', 'admin']
const bases = { web: '/', ehr: '/ehr/', lab: '/lab/', pharmacy: '/pharmacy/', ocr: '/ocr/', outreach: '/outreach/', admin: '/admin/' }
const entryHtml = { web: 'index.html', ehr: 'ehr.html', lab: 'index.html', pharmacy: 'index.html', ocr: 'index.html', outreach: 'index.html', admin: 'index.html' }

async function files(root, extensions) {
  const entries = await readdir(root, { withFileTypes: true })
  const nested = await Promise.all(entries.map(async entry => {
    const path = join(root, entry.name)
    if (entry.isDirectory()) return files(path, extensions)
    return entry.isFile() && extensions.has(extname(entry.name)) ? [path] : []
  }))
  return nested.flat()
}

const sourceFiles = (await Promise.all(apps.map(app => files(
  join(repository, 'apps', app, 'src'), new Set(['.ts', '.tsx', '.js', '.jsx']),
)))).flat()

const databasePattern = /(?:postgres(?:ql)?:\/\/|DATABASE_URL|service[_-]?role|@supabase\/supabase-js|\bfrom\s+['"]pg['"]|supabase\.from\s*\()/i
const directInternalTarget = /(?:127\.0\.0\.1|localhost):(?:300[1-6]|3010)\b/i
const dangerousLog = /console\.(?:log|debug|info)\s*\([^\n]*(?:patient|record|result|prescription|ocr|token|nin|clinical)/i
for (const file of sourceFiles) {
  const source = await readFile(file, 'utf8')
  assert.doesNotMatch(source, databasePattern, `${file.slice(repository.length + 1)} contains browser database access`)
  assert.doesNotMatch(source, directInternalTarget, `${file.slice(repository.length + 1)} contains a direct internal service target`)
  assert.doesNotMatch(source, dangerousLog, `${file.slice(repository.length + 1)} contains a potentially sensitive production log`)
}

const allowedBrowserStorageFiles = new Set([
  'apps/web/src/components/AppInstallPrompt.tsx',
  'apps/web/src/features/migrate/ui/CaptureWorkspace.tsx',
  'apps/web/src/lib/routePreload.tsx',
])
for (const file of sourceFiles) {
  const relative = file.slice(repository.length + 1)
  const source = await readFile(file, 'utf8')
  if (/localStorage|sessionStorage/.test(source)) {
    assert.ok(allowedBrowserStorageFiles.has(relative), `${relative} uses unreviewed browser string storage`)
  }
}
const migrateCapture = await readFile(join(repository, 'apps/web/src/features/migrate/ui/CaptureWorkspace.tsx'), 'utf8')
assert.match(migrateCapture, /crypto\.randomUUID\(\)/)
assert.doesNotMatch(migrateCapture, /localStorage\.(?:setItem|getItem)\([^\n]*(?:patient|nin|folderReference|file|document)/i,
  'migration capture string storage must remain a non-PHI client-session identifier only')

for (const app of apps) {
  const root = join(repository, 'apps', app)
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  assert.ok(manifest.dependencies?.['@hid/offline'], `${app} must consume the shared offline package`)
  assert.ok(manifest.dependencies?.['@hid/telemetry'], `${app} must consume the shared telemetry package`)

  const html = await readFile(join(root, entryHtml[app]), 'utf8')
  assert.match(html, /rel=["']manifest["']/i, `${app} must advertise its PWA manifest`)
  const webManifest = JSON.parse(await readFile(join(root, 'public/manifest.webmanifest'), 'utf8'))
  const manifestBase = new URL(bases[app], 'http://hid.local')
  assert.equal(new URL(webManifest.scope, manifestBase).pathname, bases[app],
    `${app} manifest must resolve to the exact ${bases[app]} scope`)
  assert.equal(new URL(webManifest.start_url, manifestBase).pathname, bases[app],
    `${app} manifest must start in the exact ${bases[app]} scope`)
  assert.ok(Array.isArray(webManifest.icons) && webManifest.icons.length > 0, `${app} manifest must own at least one icon`)
  for (const icon of webManifest.icons) {
    const iconPath = new URL(icon.src, manifestBase).pathname
    assert.ok(iconPath.startsWith(bases[app]), `${app} icon ${iconPath} must remain in its application scope`)
    const publicPath = app === 'web' ? iconPath.slice(1) : iconPath.slice(bases[app].length)
    await access(join(root, 'public', publicPath))
  }
  const worker = await readFile(join(root, 'public/service-worker.js'), 'utf8')
  assert.match(worker, /\/api\//, `${app} service worker must explicitly exclude API responses`)
  assert.match(worker, /caches\.open/, `${app} service worker must cache an app shell`)
  if (app !== 'web') assert.match(worker, /new URL\(self\.registration\.scope\)\.pathname/,
    `${app} service worker must derive the current host/path scope from its registration`)

  const mainCandidates = sourceFiles.filter(file => file.startsWith(join(root, 'src')) && /\/main\.(?:tsx|jsx|ts|js)$/.test(file))
  assert.equal(mainCandidates.length, 1, `${app} must have one active frontend entrypoint`)
  const main = await readFile(mainCandidates[0], 'utf8')
  const appSource = (await Promise.all(sourceFiles.filter(file => file.startsWith(join(root, 'src')))
    .map(file => readFile(file, 'utf8')))).join('\n')
  assert.match(appSource, /initializeTelemetry\s*\(/, `${app} must initialize shared telemetry`)
  assert.match(appSource, new RegExp(`app:\\s*['"]${app}['"]`), `${app} telemetry must carry its app identity`)
  assert.match(main, /OfflineBanner|useConnectivity/, `${app} must expose connectivity state`)
}

const ehrProductionHtml = await readFile(join(repository, 'apps/ehr/dist/index.html'), 'utf8')
assert.ok(
  ehrProductionHtml.includes('/ehr/assets/canonical-platform-runtime.js')
    || ehrProductionHtml.includes('/assets/canonical-platform-runtime.js'),
  'canonical EHR production HTML must attach its governed platform runtime in local or host-root mode',
)
const ehrPlatformRuntime = await readFile(join(repository, 'apps/ehr/dist/assets/canonical-platform-runtime.js'), 'utf8')
assert.match(ehrPlatformRuntime, /hid-ehr-connectivity/,
  'canonical EHR production runtime must retain connectivity indication')
assert.ok(
  ehrPlatformRuntime.includes('/ehr/service-worker.js')
    || ehrPlatformRuntime.includes('/service-worker.js'),
  'canonical EHR production runtime must register its worker in local or host-root mode',
)

for (const file of sourceFiles) {
  const source = await readFile(file, 'utf8')
  if (!file.includes('/packages/telemetry/')) {
    assert.doesNotMatch(source, /from\s+['"]posthog-js['"]|from\s+['"]@sentry\//,
      `${file.slice(repository.length + 1)} bypasses shared telemetry policy`)
  }
}

const bundleFiles = (await Promise.all(apps.map(app => files(
  join(repository, 'apps', app, 'dist'), new Set(['.js', '.html', '.json', '.css']),
)))).flat()
const bundleSecretPattern = /(?:AKIA[0-9A-Z]{16}|postgres(?:ql)?:\/\/|BEGIN (?:RSA |EC )?PRIVATE KEY|AWS_SECRET_ACCESS_KEY|JWT_SIGNING_SECRET|WORKLOAD_TOKEN|SUPABASE_SERVICE_ROLE)/
for (const file of bundleFiles) {
  const source = await readFile(file, 'utf8')
  assert.doesNotMatch(source, bundleSecretPattern, `${file.slice(repository.length + 1)} contains a secret-like production value`)
  assert.doesNotMatch(source, directInternalTarget, `${file.slice(repository.length + 1)} contains a direct internal service target`)
}

const gateway = await readFile(join(repository, 'apps/web/vite.config.ts'), 'utf8')
for (const route of ['/ehr', '/lab', '/pharmacy', '/ocr', '/outreach', '/admin']) {
  assert.ok(gateway.includes(`'${route}'`), `gateway is missing ${route}`)
}
assert.match(gateway, /'\/api\/v1\/pharmacy'[\s\S]{0,100}ports\.pharmacyApi/, 'Pharmacy API must retain its owning service target')
assert.match(gateway, /'\/api\/v1\/ocr'[\s\S]{0,100}ports\.ocrApi/, 'OCR API must retain its owning service target')

process.stdout.write(JSON.stringify({
  status: 'passed', apps, pwaInstallable: apps, bundleFilesScanned: bundleFiles.length,
  browserStringStorageAllowlist: [...allowedBrowserStorageFiles], replay: 'disabled',
}) + '\n')
