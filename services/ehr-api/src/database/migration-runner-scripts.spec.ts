import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

// The migration runner's own node:test suites run here too, so the locked
// ehr-api tests in CI cover them: the notices the runner forwards, and the dry
// run's bounded retry of a file's busy-table refusal (scripts/dry-run-attempts.mjs;
// coordinator, hid-system #258, 20 November 2026). Paths are built from
// __dirname and literals only, inside ehr-api.
const notices = join(__dirname, '../../scripts/migration-notices.test.mjs');
const attempts = join(__dirname, '../../scripts/dry-run-attempts.test.mjs');

describe('migration runner scripts', () => {
  it('pass their node:test suites', () => {
    const child = spawnSync(process.execPath, ['--test', notices, attempts], {
      encoding: 'utf8', timeout: 60_000, env: { ...process.env, NODE_OPTIONS: '' },
    });
    const output = `${child.stdout}\n${child.stderr}`;
    expect(output).toMatch(/^# fail 0$/m);
    expect(output).toMatch(/^# pass [1-9]\d*$/m);
    expect(child.status).toBe(0);
  });
});
