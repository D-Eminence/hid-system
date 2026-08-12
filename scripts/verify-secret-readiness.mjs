#!/usr/bin/env node

import assert from 'node:assert/strict'
import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, join, relative, resolve } from 'node:path'

const repository = resolve(import.meta.dirname, '..')
const canonicalRoots = ['apps', 'services', 'packages', 'gateway', 'infra', 'scripts', 'docs']
const explicitFiles = ['CODEX.md', 'README.md', 'package.json', '.gitignore', '.dockerignore']
const ignoredDirectories = new Set([
  '.git', '.vercel', '.vite', '.wrangler', '.cache', '.codex', '.agents', '.turbo',
  'build', 'cdk.out', 'coverage', 'dist', 'identity', 'node_modules',
  'playwright-report', 'test-results', 'upstream_snapshot',
])
const serverSecretName = [
  'AUTH_(?:SIGNING_SECRET|LOGIN_PEPPER)',
  'AWS_(?:ACCESS_KEY_ID|SECRET_ACCESS_KEY|SESSION_TOKEN)',
  'BREVO_API_KEY',
  'CLOUDFLARE_(?:API_TOKEN|ORIGIN_AUTH_TOKEN)',
  'DATABASE_(?:URL|PASSWORD)',
  'FCM_(?:SERVICE_ACCOUNT|PRIVATE_KEY)',
  'FIREBASE_(?:PRIVATE_KEY|SERVICE_ACCOUNT)',
  'GITHUB_(?:TOKEN|PAT)',
  'INFOBIP_API_KEY',
  'META_ACCESS_TOKEN',
  'NIN_(?:API_KEY|PROVIDER_SECRET)',
  'NPM_TOKEN',
  'NOVU_API_KEY',
  'OAUTH(?:_[A-Z0-9]+)?_CLIENT_SECRET',
  'OIDC_CLIENT_SECRET',
  'PGPASSWORD',
  'POSTHOG_(?:PERSONAL_API_KEY|PRIVATE_KEY)',
  'POSTGRES_(?:URL|PASSWORD)',
  'RESEND_API_KEY',
  'SENDGRID_API_KEY',
  'SENTRY_AUTH_TOKEN',
  'SMTP_(?:PASS|PASSWORD)',
  'SUPABASE_SERVICE_ROLE_KEY',
  'TERMII_API_KEY',
  'TWILIO_AUTH_TOKEN',
  'TURNSTILE_SECRET_KEY',
  'VERCEL_TOKEN',
  'WORKLOAD_(?:TOKEN|SIGNING)',
  '(?:COOKIE|ENCRYPTION|HMAC|JWT|SESSION)_(?:SECRET|SIGNING_KEY)',
].join('|')
const frontendServerIdentifiers = new RegExp(`(?:${serverSecretName}|DATABASE_URL)`, 'i')
const namedSecret = new RegExp(String.raw`\b(${serverSecretName})\s*(?:=|:)\s*(['"])([^\n'"]+)\2`, 'gi')
const sensitiveEnvironmentNames = new RegExp(`^(?:${serverSecretName})$`, 'i')

function isIgnoredEnvironmentFile(path) {
  const name = basename(path)
  return name.startsWith('.env') && name !== '.env.example'
}

function isTestFile(path) {
  return /(?:\.spec\.[cm]?[jt]sx?$|\.test\.[cm]?[jt]sx?$|(?:^|\/)test(?:s)?\/)/.test(path)
    || path.endsWith('/scripts/run-container-database-acceptance.sh')
}

function isPlaceholder(value) {
  const normalized = value.trim().toLowerCase()
  return normalized === ''
    || normalized.includes('change-me')
    || normalized.includes('replace-with')
    || normalized.includes('example')
    || normalized.includes('placeholder')
    || normalized.startsWith('<')
    || normalized === 'test'
    || normalized === 'testing'
    || normalized === 'local'
    || normalized === 'development'
    || normalized === 'dummy'
    || normalized === 'fake'
}

function isLocalExampleDatabaseUrl(value) {
  try {
    const url = new URL(value)
    return ['localhost', '127.0.0.1', '::1'].includes(url.hostname)
      || url.hostname.endsWith('.invalid')
  } catch {
    return false
  }
}

function isReferenceInsteadOfValue(name, value) {
  const normalized = value.trim()
  const selector = name.toLowerCase().replace(/_([a-z])/g, (_, letter) => letter.toUpperCase())
  return normalized === name
    || normalized === selector
    || normalized.startsWith('$')
    || normalized.startsWith('${')
    || normalized.startsWith('process.env.')
}

async function walk(directory) {
  const files = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...await walk(path))
    else if (entry.isFile() && !isIgnoredEnvironmentFile(path) && !path.endsWith('.tsbuildinfo')) files.push(path)
  }
  return files
}

async function text(path) {
  const metadata = await stat(path)
  if (metadata.size > 2_000_000) return null
  const source = await readFile(path, 'utf8')
  return source.includes('\0') ? null : source
}

function addFinding(findings, path, rule) {
  findings.add(`${relative(repository, path)}:${rule}`)
}

function inspectEnvironmentExample(path, source, findings) {
  for (const line of source.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
    if (!match || !sensitiveEnvironmentNames.test(match[1])) continue
    const value = match[2].trim().replace(/^['"]|['"]$/g, '')
    if (match[1] === 'DATABASE_URL' && isLocalExampleDatabaseUrl(value)) continue
    if (!isPlaceholder(value)) addFinding(findings, path, 'configured-secret-in-env-example')
  }
}

function inspectSource(path, source, findings) {
  if (/-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/.test(source)) addFinding(findings, path, 'private-key')
  if (/\b(?:AKIA|ASIA)(?!IOSFODNN7EXAMPLE)[0-9A-Z]{16}\b/.test(source)) addFinding(findings, path, 'aws-access-key')
  if (/\b(?:gh[pousr]_[A-Za-z0-9_]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/.test(source)) addFinding(findings, path, 'github-token')
  if (/https?:\/\/[^\s"']+X-Amz-Credential=[^\s"']+/i.test(source)) addFinding(findings, path, 'presigned-aws-url')
  if (/postgres(?:ql)?:\/\/[^\s:'"/]+:(?!change-me|replace-me|password|postgres|test|testing|local|example)[^@\s'"/]{8,}@/i.test(source)) {
    addFinding(findings, path, 'database-password-url')
  }
  if (/(?:access_token|refresh_token|session_token)\s*[:=]\s*['"](?:eyJ[A-Za-z0-9._-]{20,}|[A-Za-z0-9_-]{80,})/i.test(source)
    || /(?:set-cookie|cookie)\s*[:=]\s*['"][^'"\n]*(?:session|refresh|token)=[A-Za-z0-9._-]{40,}/i.test(source)) {
    addFinding(findings, path, 'session-or-access-token')
  }
  if (!isTestFile(path) && /(?:\bnin\b|national identity number)[^\n0-9]{0,40}(?<![0-9])[0-9]{11}(?![0-9])/i.test(source)) {
    addFinding(findings, path, 'unclassified-nin-value')
  }

  for (const match of source.matchAll(namedSecret)) {
    const value = match[3].trim()
    if (!isTestFile(path) && !isPlaceholder(value) && !isReferenceInsteadOfValue(match[1], value)) {
      addFinding(findings, path, 'configured-named-secret')
    }
  }
  if (basename(path) === '.env.example') inspectEnvironmentExample(path, source, findings)
}

const gitIgnore = await readFile(join(repository, '.gitignore'), 'utf8')
for (const required of [
  '/identity/', '/upstream_snapshot/', '**/node_modules/', '**/dist/', '**/build/', '**/.vite/',
  '**/.vercel/', '**/coverage/', '.env', '.env.*', '!.env.example', '!**/.env.example',
]) {
  assert.ok(gitIgnore.includes(required), `.gitignore must exclude or preserve ${required}`)
}

const dockerIgnore = await readFile(join(repository, '.dockerignore'), 'utf8')
for (const required of ['identity/', 'upstream_snapshot/', '**/.env', '**/.env.*', '!**/.env.example']) {
  assert.ok(dockerIgnore.includes(required), `.dockerignore must contain ${required}`)
}

const canonicalFiles = [
  ...(await Promise.all(canonicalRoots.map((root) => walk(join(repository, root))))).flat(),
  ...explicitFiles.map((path) => join(repository, path)),
]
const canonicalFindings = new Set()
let canonicalTextFiles = 0
for (const path of canonicalFiles) {
  const source = await text(path)
  if (source === null) continue
  canonicalTextFiles += 1
  inspectSource(path, source, canonicalFindings)
}
assert.deepEqual([...canonicalFindings], [], `canonical secret findings: ${[...canonicalFindings].join(', ')}`)

const frontendFiles = (await walk(join(repository, 'apps'))).filter((path) => /(?:\/src\/|vite\.config\.|index\.html$)/.test(path))
for (const path of frontendFiles) {
  const source = await text(path)
  if (source === null) continue
  assert.doesNotMatch(source, frontendServerIdentifiers,
    `${relative(repository, path)} references a server-only secret contract`)
}
for (const app of ['web', 'ehr', 'lab', 'pharmacy', 'ocr', 'outreach', 'admin']) {
  const vitePath = join(repository, 'apps', app, 'vite.config.ts')
  const vite = await readFile(vitePath, 'utf8')
  const configuredPrefix = vite.match(/envPrefix\s*:\s*([^,\n}]+)/)
  if (configuredPrefix) assert.match(configuredPrefix[1], /VITE_/, `${app} Vite envPrefix must remain public-only`)
}

const artifactFindings = new Set()
const artifactRoots = ['web', 'ehr', 'lab', 'pharmacy', 'ocr', 'outreach', 'admin']
  .map((app) => join(repository, 'apps', app, 'dist'))
const artifactFiles = (await Promise.all(artifactRoots.map((root) => walk(root)))).flat()
let artifactTextFiles = 0
for (const path of artifactFiles) {
  const source = await text(path)
  if (source === null) continue
  artifactTextFiles += 1
  inspectSource(path, source, artifactFindings)
  assert.doesNotMatch(source, frontendServerIdentifiers,
    `${relative(repository, path)} contains a server-only secret contract`)
}
assert.deepEqual([...artifactFindings], [], `frontend artifact secret findings: ${[...artifactFindings].join(', ')}`)

process.stdout.write(JSON.stringify({
  status: 'passed',
  canonicalTextFiles,
  frontendSourceFiles: frontendFiles.length,
  frontendArtifactTextFiles: artifactTextFiles,
  canonicalSecretFindings: 0,
  frontendArtifactSecretFindings: 0,
  publicFrontendPrefix: 'VITE_',
  historicalReferencesExcluded: ['identity/', 'upstream_snapshot/'],
}) + '\n')
