import assert from 'node:assert/strict'
import { sep } from 'node:path'
import test from 'node:test'
import { isFrontendSourcePath, isTestFixturePath, normalizeVerificationPath, toPosixPath } from '../verification-paths.mjs'

const fixtures = [
  '/repo/services/ehr-api/database/tests/schema.integration.sql',
  '/repo/services/identity-api/src/auth/auth.service.spec.ts',
  '/repo/scripts/tests/example.test.mjs',
  '/repo/scripts/run-container-database-acceptance.sh',
]
const nonFixtures = ['/repo/services/identity-api/src/auth/auth.service.ts', '/repo/scripts/apply-migrations.mjs']
const frontend = ['/repo/apps/web/src/App.tsx', '/repo/apps/ehr/vite.config.ts', '/repo/apps/admin/index.html']
const windows = (path) => `C:${path.replaceAll('/', '\\')}`

test('only the platform separator is rewritten', () => {
  assert.equal(toPosixPath('C:\\repo\\apps\\web\\src\\App.tsx', '\\'), 'C:/repo/apps/web/src/App.tsx')
  assert.equal(toPosixPath('/repo/apps/web/src/App.tsx', '/'), '/repo/apps/web/src/App.tsx')
  // A backslash is a legal file-name character on POSIX, not a separator.
  assert.equal(toPosixPath('/repo/a\\tests\\b.ts', '/'), '/repo/a\\tests\\b.ts')
  assert.equal(normalizeVerificationPath('/repo/a\\tests\\b.ts'), toPosixPath('/repo/a\\tests\\b.ts', sep))
})

test('fixture and frontend rules classify POSIX paths as before', () => {
  for (const path of fixtures) assert.equal(isTestFixturePath(path), true, path)
  for (const path of nonFixtures) assert.equal(isTestFixturePath(path), false, path)
  for (const path of frontend) assert.equal(isFrontendSourcePath(path), true, path)
  assert.equal(isFrontendSourcePath('/repo/apps/web/package.json'), false)
})

test('POSIX normalisation does not widen the fixture rule', { skip: sep !== '/' }, () => {
  assert.equal(isTestFixturePath('/repo/services/a\\tests\\credentials.ts'), false)
  assert.equal(isFrontendSourcePath('/repo/apps/web\\src\\server.ts'), false)
})

test('Windows paths classify like their POSIX form', () => {
  for (const path of [...fixtures, ...nonFixtures, ...frontend, '/repo/apps/web/package.json']) {
    const posix = toPosixPath(windows(path), '\\')
    assert.equal(posix, `C:${path}`)
    assert.equal(isTestFixturePath(posix), isTestFixturePath(path), path)
    assert.equal(isFrontendSourcePath(posix), isFrontendSourcePath(path), path)
  }
})

test('Windows separators are normalised on Windows', { skip: sep !== '\\' }, () => {
  for (const path of fixtures) assert.equal(isTestFixturePath(windows(path)), true, path)
  for (const path of nonFixtures) assert.equal(isTestFixturePath(windows(path)), false, path)
  for (const path of frontend) assert.equal(isFrontendSourcePath(windows(path)), true, path)
  assert.equal(normalizeVerificationPath('C:\\repo\\apps\\web\\src\\App.tsx'), 'C:/repo/apps/web/src/App.tsx')
})
