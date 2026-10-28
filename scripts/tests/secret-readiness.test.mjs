import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'

// The secret gate run on a minimal synthetic repository: the gate's own two
// scripts, the repository's ignore files and one probe file per case, so the
// cases see exactly what CI's verify:secret-readiness sees.
const repository = resolve(import.meta.dirname, '..', '..')
const apps = ['web', 'ehr', 'lab', 'pharmacy', 'ocr', 'outreach', 'admin']
// A synthetic value shaped like a VAPID private key (43 base64url characters); never key material.
const vapidShaped = createHash('sha256').update('synthetic web push probe').digest('base64url')

function runGate(files) {
  const root = mkdtempSync(join(tmpdir(), 'secret-readiness-'))
  try {
    for (const script of ['verify-secret-readiness.mjs', 'verification-paths.mjs']) {
      mkdirSync(join(root, 'scripts'), { recursive: true })
      copyFileSync(join(repository, 'scripts', script), join(root, 'scripts', script))
    }
    copyFileSync(join(repository, '.gitignore'), join(root, '.gitignore'))
    copyFileSync(join(repository, '.dockerignore'), join(root, '.dockerignore'))
    for (const name of ['CODEX.md', 'README.md']) writeFileSync(join(root, name), '# probe\n')
    writeFileSync(join(root, 'package.json'), '{}\n')
    for (const directory of ['services', 'packages', 'gateway', 'infra', 'docs']) mkdirSync(join(root, directory))
    for (const app of apps) {
      mkdirSync(join(root, 'apps', app, 'dist'), { recursive: true })
      writeFileSync(join(root, 'apps', app, 'vite.config.ts'), "export default { envPrefix: 'VITE_' }\n")
    }
    for (const [path, source] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true })
      writeFileSync(join(root, path), source)
    }
    const result = spawnSync(process.execPath, [join(root, 'scripts', 'verify-secret-readiness.mjs')], { encoding: 'utf8' })
    return { status: result.status, output: `${result.stdout}${result.stderr}` }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test('the web push VAPID private key passes as an empty .env.example entry and an unquoted schema name', () => {
  const result = runGate({
    'services/probe/.env.example': '# 43 base64url characters, notification-api only\nWEB_PUSH_VAPID_PRIVATE_KEY=\n',
    'services/probe/src/config/environment.ts': 'export const schema = { WEB_PUSH_VAPID_PRIVATE_KEY: optional }\n',
  })
  assert.equal(result.status, 0, result.output)
  assert.match(result.output, /"status":"passed"/)
})

test('a web push VAPID private key value in a .env.example fails the gate', () => {
  const result = runGate({ 'services/probe/.env.example': `WEB_PUSH_VAPID_PRIVATE_KEY=${vapidShaped}\n` })
  assert.notEqual(result.status, 0)
  assert.match(result.output, /services\/probe\/\.env\.example:configured-secret-in-env-example/)
})

test('a quoted web push VAPID private key in non-test source fails the gate', () => {
  const result = runGate({ 'services/probe/src/push.ts': `export const keys = { WEB_PUSH_VAPID_PRIVATE_KEY: '${vapidShaped}' }\n` })
  assert.notEqual(result.status, 0)
  assert.match(result.output, /services\/probe\/src\/push\.ts:configured-named-secret/)
})

test('a frontend source naming the web push VAPID private key fails the gate', () => {
  const result = runGate({ 'apps/web/src/push.ts': 'export const name = import.meta.env.WEB_PUSH_VAPID_PRIVATE_KEY\n' })
  assert.notEqual(result.status, 0)
  assert.match(result.output, /apps\/web\/src\/push\.ts references a server-only secret contract/)
})
