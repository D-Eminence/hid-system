#!/usr/bin/env node

import assert from 'node:assert/strict'
import { access, readdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { resolveDevelopmentPorts } from './ports.mjs'

const repository = resolve(import.meta.dirname, '..')

function reachableRootScripts(scripts, entrypoint) {
  const reachable = new Set()
  const pending = [entrypoint]
  while (pending.length > 0) {
    const script = pending.pop()
    if (reachable.has(script)) continue
    reachable.add(script)
    const command = scripts[script]
    if (typeof command !== 'string') continue
    for (const match of command.matchAll(/(?:^|\s|&&)npm\s+run\s+([a-z0-9:_-]+)/gi)) {
      pending.push(match[1])
    }
  }
  return reachable
}

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx'))
      && !entry.name.endsWith('.spec.ts') && !entry.name.endsWith('.spec.tsx')
      ? [path]
      : []
  }))
  return nested.flat()
}

async function assertMutationOwnership(name, roots, allowedSchemas) {
  const files = (await Promise.all(roots.map(sourceFiles))).flat()
  const violations = []
  const mutation = /\b(?:insert\s+into|update|delete\s+from)\s+([a-z_][a-z0-9_]*)\./gi
  for (const file of files) {
    const source = await readFile(file, 'utf8')
    for (const match of source.matchAll(mutation)) {
      if (!allowedSchemas.has(match[1])) {
        violations.push(`${file.slice(repository.length + 1)} -> ${match[1]}`)
      }
    }
  }
  assert.deepEqual(violations, [], `${name} contains direct cross-domain SQL mutations`)
}

async function assertSqlOwnership(name, roots, allowedSchemas) {
  const files = (await Promise.all(roots.map(sourceFiles))).flat()
  const violations = []
  const reference = /\b(?:from|join|insert\s+into|update|delete\s+from)\s+([a-z_][a-z0-9_]*)\./gi
  for (const file of files) {
    const source = await readFile(file, 'utf8')
    for (const match of source.matchAll(reference)) {
      if (!allowedSchemas.has(match[1])) violations.push(`${file.slice(repository.length + 1)} -> ${match[1]}`)
    }
  }
  assert.deepEqual(violations, [], `${name} contains direct cross-domain SQL references`)
}

const gateway = await readFile(join(repository,
  'apps/web/vite.config.ts'), 'utf8')
const expectedGatewayTargets = new Map([
  ["'/api/v1/lab'", 'ports.labApi'],
  ["'/api/v1/pharmacy'", 'ports.pharmacyApi'],
  ["'/api/v1/ocr'", 'ports.ocrApi'],
  ["'/api/v1/outreach'", 'ports.outreachApi'],
  ["'/api/v1/auth'", 'ports.identityApi'],
  ["'/api/v1/identity'", 'ports.identityApi'],
  ["'/api/v1/audit'", 'ports.identityApi'],
  ["'/api/v1/admin'", 'ports.identityApi'],
  ["'/api'", 'ports.ehrApi'],
])
for (const [route, target] of expectedGatewayTargets) {
  assert.match(gateway, new RegExp(`${route.replaceAll('/', '\\/')}[\\s\\S]{0,100}${target}`),
    `gateway ownership mismatch for ${route}`)
}
assert.ok(gateway.indexOf("'/api/v1/ocr'") < gateway.indexOf("'/api'"),
  'specific service routes must precede the EHR fallback')
assert.match(gateway, /'\/admin'[\s\S]{0,100}ports\.adminUi/,
  'the one-origin gateway must route the dedicated Admin UI')
assert.match(gateway, /'\/outreach'[\s\S]{0,100}ports\.outreachUi/,
  'the one-origin gateway must route the dedicated Outreach UI')
assert.match(gateway, /'\/pharmacy'[\s\S]{0,100}ports\.pharmacyUi/,
  'the one-origin gateway must route the dedicated Pharmacy UI')
assert.match(gateway, /'\/ocr'[\s\S]{0,100}ports\.ocrUi/,
  'the one-origin gateway must route the dedicated OCR UI')

await assert.rejects(access(join(repository, 'apps/ehr/server')), { code: 'ENOENT' },
  'retired ehr/server path must not remain')

const requiredBackendDirectories = [
  'identity-api', 'ehr-api', 'lab-api', 'pharmacy-api', 'ocr-api', 'ocr-worker', 'outreach-api',
  'event-dispatcher',
]
await Promise.all(requiredBackendDirectories.map((directory) => access(join(repository, 'services', directory))))
await Promise.all(['web', 'ehr', 'lab', 'pharmacy', 'ocr', 'outreach', 'admin'].map((app) => access(join(repository, 'apps', app))))
const adminVite = await readFile(join(repository, 'apps/admin/vite.config.ts'), 'utf8')
assert.match(adminVite, /optimizeDeps:\s*\{\s*include:\s*\[['"]@hid\/api-client['"]\]/,
  'Admin development must prebundle the linked CommonJS API client for browser ESM')
const adminSources = await sourceFiles(join(repository, 'apps/admin/src'))
for (const file of adminSources) {
  const source = await readFile(file, 'utf8')
  assert.doesNotMatch(source, /(?:postgres(?:ql)?:\/\/|DATABASE_URL|@supabase\/supabase-js|\bfrom\s+['"]pg['"])/,
    'Admin browser source must not contain database access or credentials')
  assert.doesNotMatch(source, /dangerouslySetInnerHTML/,
    'Admin browser must preserve React escaping for untrusted administration fields')
}
const adminController = await readFile(join(repository,
  'services/identity-api/src/admin/admin.controller.ts'), 'utf8')
assert.doesNotMatch(adminController, /(?:admin\/sql|update-record|force-write)/i,
  'Identity must not expose a generic administrative backdoor')
for (const capability of ['platform.facility.manage', 'platform.principal.manage',
  'platform.role.manage', 'platform.session.revoke', 'platform.audit.read', 'platform.operations.read']) {
  assert.match(adminController, new RegExp(`RequirePermissions\\('${capability.replaceAll('.', '\\.')}\'\\)`),
    `Admin API is missing server enforcement for ${capability}`)
}
const adminService = await readFile(join(repository,
  'services/identity-api/src/admin/admin.service.ts'), 'utf8')
assert.doesNotMatch(adminService, /nin_(?:ciphertext|lookup_hmac)|password_(?:hash|digest)|refresh_token/i,
  'Admin response queries must not expose raw identity or authentication secrets')

const ehrComposition = await readFile(join(repository, 'services/ehr-api/src/app.module.ts'), 'utf8')
for (const active of ['DocumentModule', 'EhrModule', 'ServiceClientsModule']) {
  assert.match(ehrComposition, new RegExp(`\\b${active}\\b`), `EHR composition is missing ${active}`)
}
for (const retired of ['AuthModule', 'IdentityModule', 'ConsentModule', 'LabModule',
  'PharmacyModule', 'OutreachModule', 'OcrModule']) {
  assert.doesNotMatch(ehrComposition, new RegExp(`\\b${retired}\\b`),
    `EHR composition still registers ${retired}`)
}

await Promise.all([
  assertMutationOwnership('Identity', [join(repository, 'services/identity-api/src')],
    new Set(['auth', 'identity', 'audit'])),
  assertMutationOwnership('Lab', [join(repository, 'services/lab-api/src')],
    new Set(['lab', 'audit'])),
  assertMutationOwnership('Pharmacy', [join(repository, 'services/pharmacy-api/src')],
    new Set(['pharmacy', 'audit'])),
  assertMutationOwnership('Outreach', [join(repository, 'services/outreach-api/src')],
    new Set(['outreach', 'audit'])),
  assertSqlOwnership('OCR', [join(repository, 'services/ocr-api/src')],
    new Set(['ocr', 'audit'])),
  assertMutationOwnership('EHR', [
    join(repository, 'services/ehr-api/src/audit'),
    join(repository, 'services/ehr-api/src/documents'),
    join(repository, 'services/ehr-api/src/ehr'),
  ], new Set(['ehr', 'audit'])),
  assertSqlOwnership('OCR worker', [join(repository, 'services/ocr-worker/src')],
    new Set(['ocr'])),
  assertMutationOwnership('OCR', [join(repository, 'services/ocr-api/src')],
    new Set(['ocr', 'audit'])),
  assertSqlOwnership('Event dispatcher', [join(repository, 'services/event-dispatcher/src')],
    new Set(['integration'])),
])

const ports = resolveDevelopmentPorts({})
assert.equal(new Set(Object.values(ports)).size, Object.values(ports).length,
  'default service ports must be unique')

const dockerIgnore = await readFile(join(repository, '.dockerignore'), 'utf8')
for (const excluded of ['**/.env.*', '**/*.pem', '**/*.key', '**/*.jwt', '**/node_modules']) {
  assert.match(dockerIgnore, new RegExp(excluded.replaceAll('*', '\\*')),
    `.dockerignore must exclude ${excluded}`)
}
for (const excluded of ['**/.aws', '**/workload-token.*', '**/secrets/**', '**/pgdata', '**/*.log']) {
  assert.match(dockerIgnore, new RegExp(excluded.replaceAll('*', '\\*')),
    `.dockerignore must exclude ${excluded}`)
}

const [rootPackage, apiClientPackage, webPackage, ehrUiPackage, labUiPackage, pharmacyUiPackage, ocrUiPackage, outreachUiPackage, adminPackage, ehrPackage, labPackage, workerPackage, dispatcherPackage] = await Promise.all([
  readFile(join(repository, 'package.json'), 'utf8').then(JSON.parse),
  readFile(join(repository, 'packages/api-client/package.json'), 'utf8').then(JSON.parse),
  readFile(join(repository, 'apps/web/package.json'), 'utf8').then(JSON.parse),
  readFile(join(repository, 'apps/ehr/package.json'), 'utf8').then(JSON.parse),
  readFile(join(repository, 'apps/lab/package.json'), 'utf8').then(JSON.parse),
  readFile(join(repository, 'apps/pharmacy/package.json'), 'utf8').then(JSON.parse),
  readFile(join(repository, 'apps/ocr/package.json'), 'utf8').then(JSON.parse),
  readFile(join(repository, 'apps/outreach/package.json'), 'utf8').then(JSON.parse),
  readFile(join(repository, 'apps/admin/package.json'), 'utf8').then(JSON.parse),
  readFile(join(repository, 'services/ehr-api/package.json'), 'utf8').then(JSON.parse),
  readFile(join(repository, 'services/lab-api/package.json'), 'utf8').then(JSON.parse),
  readFile(join(repository, 'services/ocr-worker/package.json'), 'utf8').then(JSON.parse),
  readFile(join(repository, 'services/event-dispatcher/package.json'), 'utf8').then(JSON.parse),
])
const pretestScripts = reachableRootScripts(rootPackage.scripts, 'pretest')
const testScripts = reachableRootScripts(rootPackage.scripts, 'test')
const preverifyScripts = reachableRootScripts(rootPackage.scripts, 'preverify')
const verifyScripts = reachableRootScripts(rootPackage.scripts, 'verify')
assert.ok(pretestScripts.has('build:test-prerequisites'),
  'root pretest must declare the generated shared-package prerequisite phase')
assert.ok(pretestScripts.has('build:api-client'),
  'root pretest must build the API client before tests consume its generated entrypoint')
assert.ok(testScripts.has('test:admin'), 'root test must retain the Admin test suite')
assert.ok(preverifyScripts.has('build:verification-prerequisites'),
  'root preverify must declare the generated verification-artifact prerequisite phase')
assert.ok(preverifyScripts.has('build:cloudflare'),
  'root preverify must transitively reach the governed Cloudflare frontend build')
for (const app of ['web', 'ehr', 'lab', 'pharmacy', 'ocr', 'outreach', 'admin']) {
  assert.ok(preverifyScripts.has(`build:cloudflare:${app}`),
    `root preverify must generate the ${app} frontend artifact`)
}
assert.ok(preverifyScripts.has('build:container-verification-prerequisites'),
  'root preverify must declare the generated container-artifact prerequisite phase')
for (const service of [
  'identity-api', 'ehr-api', 'lab-api', 'pharmacy-api', 'ocr-api', 'ocr-worker', 'outreach-api',
  'notification-api', 'notification-worker', 'event-dispatcher',
]) {
  assert.ok(preverifyScripts.has(`build:${service}`),
    `root preverify must generate the ${service} container artifact`)
}
assert.ok(verifyScripts.has('verify:secret-readiness'),
  'root verify must retain canonical and built-frontend secret scanning')
assert.ok(verifyScripts.has('verify:containers'),
  'root verify must retain built-container artifact scanning')
assert.equal(apiClientPackage.main, 'dist/index.js',
  'API client runtime consumers must keep the compiled package entrypoint')
assert.equal(apiClientPackage.types, 'dist/index.d.ts',
  'API client type consumers must keep the compiled declaration entrypoint')
assert.equal(adminPackage.dependencies['@hid/api-client'], 'file:../../packages/api-client',
  'Admin must consume the shared API client package')
assert.equal(rootPackage.scripts['dev:ocr-worker'],
  'npm --prefix services/ocr-worker run start:dev')
assert.equal(workerPackage.scripts.start, 'node dist/main.js')
assert.equal(rootPackage.scripts['dev:event-dispatcher'],
  'npm --prefix services/event-dispatcher run start:dev')
assert.equal(dispatcherPackage.scripts.start, 'node dist/main.js')
assert.equal(rootPackage.scripts['dev:admin'], 'npm --prefix apps/admin run dev')
assert.equal(rootPackage.scripts['build:admin'], 'npm --prefix apps/admin run build')
assert.equal(rootPackage.scripts['dev:web'], 'HID_WEB_DIRECT=true npm --prefix apps/web run dev')
assert.equal(rootPackage.scripts['build:web'], 'npm --prefix apps/web run build')
assert.equal(rootPackage.scripts['dev:ehr'], 'npm --prefix apps/ehr run dev')
assert.equal(rootPackage.scripts['build:ehr'], 'npm --prefix apps/ehr run build')
assert.equal(rootPackage.scripts['dev:lab'], 'npm --prefix apps/lab run dev')
assert.equal(rootPackage.scripts['build:lab'], 'npm --prefix apps/lab run build')
assert.equal(rootPackage.scripts['dev:pharmacy'], 'npm --prefix apps/pharmacy run dev')
assert.equal(rootPackage.scripts['build:pharmacy'], 'npm --prefix apps/pharmacy run build')
assert.equal(rootPackage.scripts['dev:ocr'], 'npm --prefix apps/ocr run dev')
assert.equal(rootPackage.scripts['build:ocr'], 'npm --prefix apps/ocr run build')
assert.equal(rootPackage.scripts['dev:outreach'], 'npm --prefix apps/outreach run dev')
assert.equal(rootPackage.scripts['build:outreach'], 'npm --prefix apps/outreach run build')
for (const [name, manifest] of [['Web', webPackage], ['EHR UI', ehrUiPackage], ['Lab UI', labUiPackage], ['Pharmacy UI', pharmacyUiPackage], ['OCR UI', ocrUiPackage], ['Outreach UI', outreachUiPackage]]) {
  assert.equal(manifest.dependencies?.pg, undefined, `${name} browser source must not depend on a database driver`)
  assert.equal(manifest.dependencies?.['@supabase/supabase-js'], undefined,
    `${name} browser source must not use a hosted database SDK`)
}
assert.equal(adminPackage.dependencies?.pg, undefined, 'Admin UI must never depend on a database driver')
assert.equal(adminPackage.dependencies?.['@supabase/supabase-js'], undefined,
  'Admin UI must never use a hosted database SDK')
for (const [name, manifest] of [['EHR', ehrPackage], ['Lab', labPackage]]) {
  assert.equal(manifest.scripts['ocr:worker'], undefined, `${name} must not expose a duplicate OCR worker entrypoint`)
}

for (const directory of requiredBackendDirectories) {
  const manifest = JSON.parse(await readFile(join(repository, 'services', directory, 'package.json'), 'utf8'))
  const internalRuntimeDependencies = Object.keys(manifest.dependencies ?? {})
    .filter((dependency) => dependency.startsWith('@hid/'))
  assert.deepEqual(internalRuntimeDependencies.filter((dependency) => dependency !== '@hid/api-client'), [],
    `${directory} imports another owning service package`)
}

const workerSources = await sourceFiles(join(repository, 'services/ocr-worker/src'))
for (const file of workerSources) {
  const source = await readFile(file, 'utf8')
  assert.doesNotMatch(source, /(?:ehr-api|ocr-api|@hid\/api-client)/,
    'OCR worker must not import an HTTP service implementation or transport package')
}

const dispatcherSources = await sourceFiles(join(repository, 'services/event-dispatcher/src'))
for (const file of dispatcherSources) {
  const source = await readFile(file, 'utf8')
  assert.doesNotMatch(source, /(?:identity-api|ehr-api|ocr-api|lab-api|pharmacy-api|outreach-api)/,
    'Event dispatcher must not import an owning service implementation')
}
const eventBridgeSource = await readFile(join(repository,
  'services/event-dispatcher/src/eventbridge.transport.ts'), 'utf8')
assert.match(eventBridgeSource, /maxAttempts:\s*1/,
  'EventBridge SDK retries must remain owned by the dispatcher')

const dispatcherDockerfile = await readFile(join(repository,
  'services/event-dispatcher/Dockerfile'), 'utf8')
assert.match(dispatcherDockerfile, /EVENT_DISPATCHER_STATUS_HOST=0\.0\.0\.0/,
  'Dispatcher container must expose status outside its own loopback namespace')
assert.match(dispatcherDockerfile, /HEALTHCHECK[\s\S]*\/api\/v1\/health\/ready/,
  'Dispatcher container must use truthful readiness for its image health check')
assert.match(dispatcherDockerfile, /STOPSIGNAL SIGTERM/,
  'Dispatcher container must receive the graceful-drain signal')
assert.doesNotMatch(dispatcherDockerfile, /COPY\s+\.\s+\./,
  'Dispatcher image must copy only its explicit package inputs')

const dispatcherIam = JSON.parse(await readFile(join(repository,
  'services/event-dispatcher/iam-policy.example.json'), 'utf8'))
assert.deepEqual(dispatcherIam.Statement[0].Action.sort(),
  ['events:DescribeEventBus', 'events:PutEvents'].sort())
assert.doesNotMatch(dispatcherIam.Statement[0].Resource, /\*/,
  'Event dispatcher IAM example must bind an exact event bus ARN')

const distrolessNodeRuntime = 'gcr.io/distroless/nodejs22-debian13@sha256:939d6f1671529d230f50b563578e9b5d206af58f038b10ebd7e1233023d4e167'
const dockerContracts = new Map([
  ['identity-api', 'CMD ["dist/main.js"]'],
  ['ehr-api', 'CMD ["dist/main.js"]'],
  ['lab-api', 'CMD ["dist/main.js"]'],
  ['pharmacy-api', 'CMD ["dist/main.js"]'],
  ['ocr-api', 'CMD ["dist/main.js"]'],
  ['ocr-worker', 'CMD ["dist/main.js"]'],
  ['outreach-api', 'CMD ["dist/main.js"]'],
  ['event-dispatcher', 'CMD ["dist/main.js"]'],
])
for (const [directory, command] of dockerContracts) {
  const dockerfile = await readFile(join(repository, 'services', directory, 'Dockerfile'), 'utf8')
  assert.match(dockerfile, /FROM node:22-bookworm-slim AS build/)
  assert.match(dockerfile, /npm ci/)
  assert.ok(dockerfile.includes(`FROM ${distrolessNodeRuntime} AS runtime`),
    `${directory} Dockerfile must use the pinned Distroless final runtime`)
  const runtime = dockerfile.slice(dockerfile.lastIndexOf(`FROM ${distrolessNodeRuntime} AS runtime`))
  assert.match(runtime, /USER 65532:65532/)
  assert.ok(runtime.includes(command), `${directory} Dockerfile has the wrong production command`)
}

process.stdout.write(JSON.stringify({
  status: 'passed',
  gatewayRoutes: Object.fromEntries(expectedGatewayTargets),
  mutationOwners: {
    Identity: ['auth', 'identity', 'audit'], EHR: ['ehr', 'audit'], OCR: ['ocr', 'audit'],
    Lab: ['lab', 'audit'], Pharmacy: ['pharmacy', 'audit'], Outreach: ['outreach', 'audit'],
  },
  ports,
}) + '\n')
