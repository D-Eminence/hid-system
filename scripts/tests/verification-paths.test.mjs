import assert from 'node:assert/strict'
import test from 'node:test'
import { isFrontendSourcePath, isTestFixturePath, normalizeVerificationPath } from '../verification-paths.mjs'

test('security checks classify Windows and Linux fixture paths identically', () => {
  for (const path of [
    '/repo/services/ehr-api/database/tests/schema.integration.sql',
    '/repo/services/identity-api/src/auth/auth.service.spec.ts',
    '/repo/scripts/tests/example.test.mjs',
    '/repo/scripts/run-container-database-acceptance.sh',
  ]) {
    assert.equal(isTestFixturePath(path), true)
    assert.equal(isTestFixturePath(path.replaceAll('/', '\\')), true)
  }
  for (const path of ['/repo/services/identity-api/src/auth/auth.service.ts', '/repo/scripts/apply-migrations.mjs']) {
    assert.equal(isTestFixturePath(path), false)
    assert.equal(isTestFixturePath(path.replaceAll('/', '\\')), false)
  }
})

test('Windows frontend sources remain included in backend-secret checks', () => {
  for (const path of ['/repo/apps/web/src/App.tsx', '/repo/apps/ehr/vite.config.ts', '/repo/apps/admin/index.html']) {
    assert.equal(isFrontendSourcePath(path), true)
    assert.equal(isFrontendSourcePath(path.replaceAll('/', '\\')), true)
  }
  assert.equal(isFrontendSourcePath('C:\\repo\\apps\\web\\package.json'), false)
  assert.equal(normalizeVerificationPath('C:\\repo\\apps\\web\\src\\App.tsx'), 'C:/repo/apps/web/src/App.tsx')
})
