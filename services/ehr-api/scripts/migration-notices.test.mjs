import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { forwardMigrationNotices } from './migration-notices.mjs';

const scripts = import.meta.dirname;
const repository = path.resolve(scripts, '../../..');

// The release reads the runner's log line by line with these two patterns
// (scripts/production_deployment.py); a forwarded notice must never match either.
async function releasePatterns() {
  const source = await readFile(path.join(repository, 'scripts/production_deployment.py'), 'utf8');
  return ['PENDING_LINE', 'PLAN_LINE'].map((name) => {
    const found = source.match(new RegExp(`^${name} = re\\.compile\\(r"(.+)"\\)$`, 'm'));
    assert.ok(found, `${name} is in production_deployment.py`);
    return new RegExp(`^(?:${found[1]})$`);
  });
}

function notice(message, severity = 'NOTICE') {
  return { name: 'notice', severity, message };
}

test('forwards only what a pending migration raises, one line each, named by the migration', async () => {
  const client = new EventEmitter();
  const written = [];
  const notices = forwardMigrationNotices(client, (line) => written.push(line));
  client.emit('notice', notice('schema "migration" already exists, skipping'));
  const answer = await notices.during('0090_order_route_late_correction.sql', async () => {
    client.emit('notice', notice('0090: owners checked: o (H6)=hid_schema_owner, T8=hid_schema_owner'));
    client.emit('notice', notice('first line\n  second line', 'WARNING'));
    return 'applied';
  });
  client.emit('notice', notice('after the migration'));
  assert.equal(answer, 'applied');
  assert.deepEqual(written, [
    'NOTICE 0090_order_route_late_correction.sql: 0090: owners checked: o (H6)=hid_schema_owner, T8=hid_schema_owner\n',
    'WARNING 0090_order_route_late_correction.sql: first line second line\n',
  ]);
});

test('stops forwarding when the migration fails, and passes the failure on', async () => {
  const client = new EventEmitter();
  const written = [];
  const notices = forwardMigrationNotices(client, (line) => written.push(line));
  await assert.rejects(notices.during('0090_order_route_late_correction.sql', async () => {
    client.emit('notice', notice('0090: owners checked: o (H6)=pgrun'));
    throw new Error('0090: H6\'s owner pgrun, which will own the new objects, lacks: ...');
  }), /lacks/);
  client.emit('notice', notice('rolled back'));
  assert.deepEqual(written, ['NOTICE 0090_order_route_late_correction.sql: 0090: owners checked: o (H6)=pgrun\n']);
});

test('a forwarded line is never read as the runner\'s pending count or plan', async () => {
  const [pending, plan] = await releasePatterns();
  assert.ok(pending.test('1 pending migration(s)'));
  assert.ok(plan.test(`0090_order_route_late_correction.sql ${'a'.repeat(64)}`));
  const client = new EventEmitter();
  const written = [];
  const notices = forwardMigrationNotices(client, (line) => written.push(line));
  await notices.during('0090_order_route_late_correction.sql', async () => {
    client.emit('notice', notice('1 pending migration(s)'));
    client.emit('notice', notice(`x\n0090_order_route_late_correction.sql ${'a'.repeat(64)}`));
  });
  assert.equal(written.length, 2);
  for (const line of written) {
    for (const part of line.split('\n').filter(Boolean)) {
      assert.ok(!pending.test(part) && !plan.test(part), part);
    }
  }
});

test('the runner forwards the notices of every pending migration, in the dry run and in the apply', async () => {
  const runner = await readFile(path.join(scripts, 'apply-migrations.mjs'), 'utf8');
  assert.match(runner, /import \{ forwardMigrationNotices \} from '\.\/migration-notices\.mjs';/);
  assert.match(runner, /const notices = forwardMigrationNotices\(client, \(line\) => process\.stdout\.write\(line\)\);/);
  const runs = runner.match(/await notices\.during\(migration\.version, \(\) => client\.query\(migration\.effectiveSql\)\);/g) ?? [];
  assert.equal(runs.length, 2);
  assert.doesNotMatch(runner, /await client\.query\(migration\.effectiveSql\)/);
});
