#!/usr/bin/env node

import assert from 'node:assert/strict'
import { readdir, readFile, stat } from 'node:fs/promises'
import { extname, join, relative, resolve } from 'node:path'

const repository = resolve(import.meta.dirname, '..')
const backends = [
  ['identity-api', 3001, true],
  ['ehr-api', 3002, true],
  ['lab-api', 3003, true],
  ['pharmacy-api', 3004, true],
  ['ocr-api', 3005, true],
  ['ocr-worker', null, false],
  ['outreach-api', 3006, true],
  ['notification-api', 3007, true],
  ['notification-worker', 3008, true],
  ['event-dispatcher', 3010, true],
]
const apps = ['web', 'ehr', 'lab', 'pharmacy', 'ocr', 'outreach', 'admin']
const bases = { web: '/', ehr: '/ehr/', lab: '/lab/', pharmacy: '/pharmacy/',
  ocr: '/ocr/', outreach: '/outreach/', admin: '/admin/' }

const textExtensions = new Set([
  '', '.cjs', '.conf', '.css', '.env', '.example', '.html', '.js', '.json', '.jsx',
  '.md', '.mjs', '.nginx', '.sh', '.sql', '.template', '.ts', '.tsx', '.txt', '.xml', '.yaml', '.yml',
])
const skippedDirectories = new Set([
  '.git', '.codex', '.agents', 'node_modules', 'dist', 'coverage', '.cache', '.vite',
  '.turbo', 'test-results', 'playwright-report', 'upstream_snapshot',
])

async function walk(directory, options = {}) {
  const output = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && skippedDirectories.has(entry.name)) continue
    const path = join(directory, entry.name)
    if (entry.isDirectory()) output.push(...await walk(path, options))
    else if (entry.isFile() && (!options.textOnly || textExtensions.has(extname(entry.name)))) output.push(path)
  }
  return output
}

function relativePath(path) { return relative(repository, path) }

function secretFindings(path, source) {
  const findings = []
  const highConfidence = [
    ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
    ['aws-access-key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
    ['private-service-key', /\b(?:SENTRY_AUTH_TOKEN|POSTHOG_(?:PERSONAL_API_KEY|PRIVATE_KEY)|SUPABASE_SERVICE_ROLE_KEY)\s*[:=]\s*['"][A-Za-z0-9_+\/.=-]{20,}['"]/i],
  ]
  for (const [rule, pattern] of highConfidence) if (pattern.test(source)) findings.push(`${relativePath(path)}:${rule}`)

  for (const match of source.matchAll(/postgres(?:ql)?:\/\/[^\s:'"/]+:([^@\s'"/]+)@/gi)) {
    const normalized = match[1].toLowerCase()
    const testFixture = /(?:\.spec\.[cm]?[jt]sx?$|\/tests?\/)/.test(path)
    if (!testFixture && !/^(?:change-me|replace-me|password|postgres|test|testing|local|example|<[^>]+>)$/.test(normalized)) {
      findings.push(`${relativePath(path)}:embedded-database-password`)
    }
  }
  return findings
}

const dockerIgnore = await readFile(join(repository, '.dockerignore'), 'utf8')
for (const required of [
  '.git', '**/node_modules', '**/dist', '**/coverage', '**/.cache', '**/.env', '**/.env.*',
  '!**/.env.example', '**/.npmrc', '**/*.pem', '**/*.key', '**/*.crt', '**/*.jwt', '**/.aws',
  '**/aws-credentials', '**/workload-token.*', '**/secrets/**', '**/pgdata', '**/postgres-data',
  '**/*.sqlite', '**/*.dump', '**/*.heapsnapshot', '**/*.log', '**/.idea', '**/.vscode',
]) assert.ok(dockerIgnore.includes(required), `.dockerignore must exclude ${required}`)

for (const [service, port, hasHttpHealth] of backends) {
  const root = join(repository, 'services', service)
  const dockerfile = await readFile(join(root, 'Dockerfile'), 'utf8')
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  await stat(join(root, 'package-lock.json'))
  assert.match(manifest.engines?.node ?? '', />=22/, `${service} must declare Node 22 compatibility`)
  assert.ok((dockerfile.match(/^FROM /gm) ?? []).length >= 2, `${service} must use a multi-stage image`)
  assert.match(dockerfile, /FROM node:22-bookworm-slim AS build/, `${service} build Node must match the platform major`)
  assert.match(dockerfile, /npm ci/, `${service} must use its lockfile`)
  assert.match(dockerfile, /npm ci --omit=dev/, `${service} runtime must omit development dependencies`)
  assert.match(dockerfile, /USER node/, `${service} runtime must be non-root`)
  assert.match(dockerfile, /CMD \["node", "dist\/main\.js"\]/, `${service} must use exec-form Node startup`)
  assert.match(dockerfile, /STOPSIGNAL SIGTERM/, `${service} must receive its graceful stop signal`)
  assert.doesNotMatch(dockerfile, /COPY\s+\.\s+\./, `${service} must not copy the entire context`)
  assert.doesNotMatch(dockerfile, /chmod\s+777/, `${service} must not use world-writable permissions`)
  assert.doesNotMatch(dockerfile, /COPY[^\n]*(?:workload|token|\.env|credential|secret)/i,
    `${service} must not copy credentials into the image`)
  if (port !== null) assert.match(dockerfile, new RegExp(`EXPOSE ${port}`), `${service} port mismatch`)
  else assert.doesNotMatch(dockerfile, /^EXPOSE /m, `${service} has no public HTTP port`)
  if (hasHttpHealth && service !== 'event-dispatcher') {
    assert.match(dockerfile, /HEALTHCHECK[\s\S]*\/api\/v1\/health\/ready/,
      `${service} image health must use readiness`)
    assert.match(dockerfile, /CMD \["node", "-e"/, `${service} health tooling must be the Node runtime already in the image`)
  }
}

const ehrDockerfile = await readFile(join(repository, 'services/ehr-api/Dockerfile'), 'utf8')
assert.match(ehrDockerfile, /FROM production-dependencies AS migration[\s\S]*scripts\/apply-migrations\.mjs/,
  'EHR must expose a controlled, separate migration job target')
const ehrRuntime = ehrDockerfile.slice(ehrDockerfile.indexOf('FROM production-dependencies AS runtime'))
assert.doesNotMatch(ehrRuntime, /services\/ehr-api\/(?:database|scripts)/,
  'the EHR API runtime image must not contain the migration executor or ledger')

const workerDockerfile = await readFile(join(repository, 'services/ocr-worker/Dockerfile'), 'utf8')
assert.doesNotMatch(workerDockerfile, /HEALTHCHECK/, 'the portless OCR worker must use orchestrator/process lifecycle, not fake HTTP health')
const workerSource = await readFile(join(repository, 'services/ocr-worker/src/worker.ts'), 'utf8')
for (const contract of ['acceptingClaims = false', 'shutdown.abort', 'repository.close()', 'startLeaseRenewal']) {
  assert.ok(workerSource.includes(contract), `OCR worker shutdown/lease contract is missing ${contract}`)
}

const dispatcherDockerfile = await readFile(join(repository, 'services/event-dispatcher/Dockerfile'), 'utf8')
assert.match(dispatcherDockerfile, /HEALTHCHECK[\s\S]*\/api\/v1\/health\/ready/,
  'dispatcher image health must use readiness')
const dispatcherSource = await readFile(join(repository, 'services/event-dispatcher/src/dispatcher.ts'), 'utf8')
for (const contract of ['acceptingDispatch = false', 'drain_timeout', 'repository.close()', 'transportAbort.abort']) {
  assert.ok(dispatcherSource.includes(contract), `dispatcher graceful-drain contract is missing ${contract}`)
}

for (const app of apps) {
  const root = join(repository, 'apps', app)
  await stat(join(root, 'package-lock.json'))
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  assert.ok(manifest.scripts?.build, `${app} must have a production build command`)
  await stat(join(root, 'dist', 'index.html'))
  await stat(join(root, 'dist', 'service-worker.js'))
  await stat(join(root, 'dist', 'manifest.webmanifest'))
  const vite = await readFile(join(root, 'vite.config.ts'), 'utf8')
  if (app !== 'web') {
    assert.ok(vite.includes(bases[app]) && vite.includes('HID_PUBLIC_BASE'),
      `${app} must retain local base ${bases[app]} and accept the Cloudflare root-build override`)
  }
}

const webVite = await readFile(join(repository, 'apps/web/vite.config.ts'), 'utf8')
assert.match(webVite, /envPrefix:\s*\[['"]VITE_['"]\]/,
  'Web builds must expose only explicitly public VITE_* variables')
const allFrontendSource = (await walk(join(repository, 'apps'), { textOnly: true }))
  .filter((path) => path.includes('/src/'))
for (const path of allFrontendSource) {
  const source = await readFile(path, 'utf8')
  assert.doesNotMatch(source, /(?:from\s+['"]pg['"]|DATABASE_URL|WORKLOAD_TOKEN_FILE|node:fs|scripts\/apply-migrations)/,
    `${relativePath(path)} imports backend-only runtime concerns`)
}

const gatewayDockerfile = await readFile(join(repository, 'gateway/Dockerfile'), 'utf8')
assert.match(gatewayDockerfile, /FROM nginxinc\/nginx-unprivileged:1\.27-alpine AS configuration/)
assert.match(gatewayDockerfile, /FROM nginxinc\/nginx-unprivileged:1\.27-alpine AS runtime/)
for (const app of apps) {
  assert.doesNotMatch(gatewayDockerfile, new RegExp(`apps/${app}/dist/`),
    `API-only gateway must not package the Cloudflare-hosted ${app} frontend`)
}
assert.match(gatewayDockerfile, /USER 101/, 'gateway must run as the unprivileged Nginx user')
assert.match(gatewayDockerfile, /EXPOSE 3000/)
assert.match(gatewayDockerfile, /HEALTHCHECK[\s\S]*gateway-health\/ready/)
assert.doesNotMatch(gatewayDockerfile, /(?:SENTRY_AUTH_TOKEN|POSTHOG_(?:PERSONAL_API_KEY|PRIVATE_KEY)|DATABASE_URL|WORKLOAD_TOKEN)/,
  'gateway build arguments must contain public browser configuration only')

const gatewayConfig = await readFile(join(repository, 'gateway/nginx.conf.template'), 'utf8')
for (const [route, upstream] of [
  ['/api/v1/auth', 'IDENTITY_API_UPSTREAM'], ['/api/v1/identity', 'IDENTITY_API_UPSTREAM'],
  ['/api/v1/audit', 'IDENTITY_API_UPSTREAM'], ['/api/v1/admin', 'IDENTITY_API_UPSTREAM'],
  ['/api/v1/ehr', 'EHR_API_UPSTREAM'], ['/api/v1/lab', 'LAB_API_UPSTREAM'],
  ['/api/v1/pharmacy', 'PHARMACY_API_UPSTREAM'], ['/api/v1/ocr', 'OCR_API_UPSTREAM'],
  ['/api/v1/outreach', 'OUTREACH_API_UPSTREAM'],
]) {
  const escaped = route.replaceAll('/', '\\/')
  assert.match(gatewayConfig, new RegExp(`${escaped}[^\\n]*proxy_pass \\$\\{${upstream}\\}`),
    `production gateway ownership mismatch for ${route}`)
}
assert.doesNotMatch(gatewayConfig, /3010|EVENT_DISPATCHER/, 'dispatcher must not be browser-routed')
for (const [app, base] of Object.entries(bases).filter(([name]) => name !== 'web')) {
  const route = base.slice(0, -1).replaceAll('/', '\\/')
  assert.doesNotMatch(gatewayConfig, new RegExp(`location ${route}\\/`),
    `${app} static routing belongs to Cloudflare, not the API-only AWS gateway`)
}
assert.match(gatewayConfig, /error_page 502 503 504 = @upstream_unavailable/)
assert.match(gatewayConfig, /UPSTREAM_UNAVAILABLE/)
const proxyHeaders = await readFile(join(repository, 'gateway/proxy-headers.conf'), 'utf8')
assert.match(proxyHeaders, /X-Forwarded-For \$remote_addr/, 'gateway must overwrite caller-supplied forwarding chains')
assert.match(proxyHeaders, /Origin \$http_origin/)
assert.match(proxyHeaders, /X-CSRF-Token \$http_x_csrf_token/)

const databaseRoots = backends.map(([service]) => join(repository, 'services', service, 'src'))
const databaseSources = (await Promise.all(databaseRoots.map((path) => walk(path, { textOnly: true })))).flat()
for (const path of databaseSources) {
  const source = await readFile(path, 'utf8')
  assert.doesNotMatch(source, /rejectUnauthorized\s*:\s*false/,
    `${relativePath(path)} disables TLS verification`)
}
for (const service of ['identity-api', 'ehr-api', 'lab-api', 'pharmacy-api', 'ocr-api', 'outreach-api']) {
  const environment = await readFile(join(repository, 'services', service, 'src/config/environment.ts'), 'utf8')
  assert.match(environment, /DATABASE_SSL_ROOT_CERT_BASE64/, `${service} must accept a trusted PostgreSQL CA`)
  assert.match(environment, /TLS is required in production|Production .*database TLS is required/,
    `${service} must fail closed without production database TLS`)
  assert.match(environment, /NODE_TLS_REJECT_UNAUTHORIZED/,
    `${service} must reject a process-wide TLS verification bypass in production`)
  assert.match(environment, /sslmode[\s\S]*sslrootcert/,
    `${service} must detect database URL TLS overrides`)
  assert.match(environment, /must not override(?: the dedicated)? verified TLS configuration/,
    `${service} must reject database URL TLS overrides in production`)
  assert.match(environment, /TRUST_PROXY_CIDRS/, `${service} must use an explicit proxy trust boundary`)
}

for (const [service, configurationPath] of [
  ['ocr-worker', 'src/config.ts'],
  ['event-dispatcher', 'src/config.ts'],
  ['notification-worker', 'src/config.ts'],
]) {
  const environment = await readFile(join(repository, 'services', service, configurationPath), 'utf8')
  assert.match(environment, /NODE_TLS_REJECT_UNAUTHORIZED/,
    `${service} must reject a process-wide TLS verification bypass in production`)
  assert.match(environment, /sslmode[\s\S]*sslrootcert/,
    `${service} must detect database URL TLS overrides`)
  assert.match(environment, /must not override(?: the dedicated)? verified TLS configuration/,
    `${service} must reject database URL TLS overrides in production`)
}

for (const service of ['ehr-api', 'lab-api', 'pharmacy-api', 'ocr-api', 'outreach-api']) {
  const sources = (await walk(join(repository, 'services', service, 'src'), { textOnly: true }))
    .filter((path) => /workload|integration/i.test(path))
  const combined = (await Promise.all(sources.map((path) => readFile(path, 'utf8')))).join('\n')
  assert.match(combined, /readFile\s*\(/, `${service} must read rotating workload credentials from files`)
  assert.match(combined, /stat\s*\(/, `${service} must validate mounted workload token files`)
}

const contextFiles = await walk(repository, { textOnly: true })
const contextFindings = []
for (const path of contextFiles) {
  const metadata = await stat(path)
  if (metadata.size > 2_000_000) continue
  contextFindings.push(...secretFindings(path, await readFile(path, 'utf8')))
}
assert.deepEqual(contextFindings, [], `secret-like build-context findings: ${contextFindings.join(', ')}`)

const builtRoots = [
  ...apps.map((app) => join(repository, 'apps', app, 'dist')),
  ...backends.map(([service]) => join(repository, 'services', service, 'dist')),
]
const builtFiles = (await Promise.all(builtRoots.map((path) => walk(path, { textOnly: true })))).flat()
const builtFindings = []
for (const path of builtFiles) builtFindings.push(...secretFindings(path, await readFile(path, 'utf8')))
assert.deepEqual(builtFindings, [], `secret-like built-artifact findings: ${builtFindings.join(', ')}`)

process.stdout.write(JSON.stringify({
  status: 'passed',
  backendArtifacts: backends.length,
  frontendArtifacts: apps.length,
  gatewayArtifact: 'gateway/Dockerfile',
  contextFilesScanned: contextFiles.length,
  builtFilesScanned: builtFiles.length,
  secretFindings: 0,
  packaging: Object.fromEntries(apps.map((app) => [app, 'cloudflare-worker-static-assets'])),
}) + '\n')
