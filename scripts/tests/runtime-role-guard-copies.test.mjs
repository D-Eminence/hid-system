import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';

// Every service that connects to the database refuses, in production, to start
// over a superuser, BYPASSRLS or owner connection (launch, DB-LOGIN-VERIFY).
// Services build independently, so each carries its own copy of the check.
const repository = resolve(import.meta.dirname, '../..');
const copies = [
  'services/identity-api/src/database/runtime-role-guard.ts',
  'services/ehr-api/src/database/runtime-role-guard.ts',
  'services/lab-api/src/database/runtime-role-guard.ts',
  'services/pharmacy-api/src/database/runtime-role-guard.ts',
  'services/ocr-api/src/database/runtime-role-guard.ts',
  'services/outreach-api/src/database/runtime-role-guard.ts',
  'services/ocr-worker/src/runtime-role-guard.ts',
  'services/event-dispatcher/src/runtime-role-guard.ts',
  'services/notification-worker/src/runtime-role-guard.ts',
];

test('the nine copies of the runtime database role check are identical', () => {
  const [first, ...rest] = copies.map((path) => readFileSync(join(repository, path), 'utf8'));
  for (const [index, copy] of rest.entries()) assert.equal(copy, first, `${copies[index + 1]} differs from ${copies[0]}`);
});

test('each database layer runs the check before it serves', () => {
  for (const service of ['identity-api', 'ehr-api', 'lab-api', 'pharmacy-api', 'ocr-api', 'outreach-api']) {
    const source = readFileSync(join(repository, 'services', service, 'src/database/database.service.ts'), 'utf8');
    assert.match(source, /implements OnModuleInit, OnApplicationShutdown/, service);
    assert.match(source, /this\.verifyRuntimeRole = environment\.NODE_ENV === 'production';/, service);
    assert.match(source, /await assertRuntimeDatabaseRole\(this\.pool\);/, service);
  }
  for (const service of ['ocr-worker', 'event-dispatcher', 'notification-worker']) {
    assert.match(readFileSync(join(repository, 'services', service, 'src/main.ts'), 'utf8'),
      /await repository\.verifyRuntimeRole\(\);/, service);
  }
});
