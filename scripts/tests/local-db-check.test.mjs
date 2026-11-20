import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import {
  REHEARSAL, dependencyState, firstErrorLine, owningFolder, parseArgs, rehearsalFailure, rehearsalModules,
  resolvesFrom, workspace,
} from '../local-db-check.mjs';

const repository = resolve(import.meta.dirname, '../..');

async function folder(t) {
  const dir = await mkdtemp(join(tmpdir(), 'hid-db-check-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
const json = (path, value) => writeFile(path, JSON.stringify(value, null, 2));

test('parseArgs accepts the documented options', () => {
  assert.deepEqual(parseArgs([]).options, { prepare: false, all: false, checkOnly: false, logDir: null });
  assert.deepEqual(parseArgs(['--prepare', '--all', '--log-dir', 'logs']).options,
    { prepare: true, all: true, checkOnly: false, logDir: resolve('logs') });
  assert.equal(parseArgs(['--log-dir=out']).options.logDir, resolve('out'));
  assert.equal(parseArgs(['--check-only']).options.checkOnly, true);
  assert.equal(parseArgs(['--help']).help, true);
});

test('parseArgs rejects --log-dir without a folder, with a plain message', () => {
  for (const args of [['--log-dir'], ['--log-dir', '--all'], ['--log-dir', '-h'], ['--log-dir=']]) {
    const parsed = parseArgs(args);
    assert.equal(parsed.options, undefined, args.join(' '));
    assert.match(parsed.error, /^--log-dir needs a folder name/, args.join(' '));
  }
});

test('parseArgs rejects --prepare with --check-only and unknown options', () => {
  assert.match(parseArgs(['--prepare', '--check-only']).error, /cannot be used together/);
  assert.match(parseArgs(['--check-only', '--prepare']).error, /cannot be used together/);
  assert.equal(parseArgs(['--fast']).error, 'Unknown option: --fast');
});

test('release/ is always checked and installed, not only with --all', () => {
  assert.ok(workspace(repository, false).installDirs.includes(join(repository, 'release')));
  assert.ok(workspace(repository, true).installDirs.includes(join(repository, 'infra/cloudflare')));
  assert.ok(!workspace(repository, false).installDirs.includes(join(repository, 'infra/cloudflare')));
});

test('every npm package the rehearsal imports comes from a folder the check installs', () => {
  const { modules, unknown } = rehearsalModules(join(repository, REHEARSAL));
  assert.deepEqual(unknown, [], 'every createRequire base in the rehearsal must be understood');
  const found = modules.map((entry) => `${entry.specifier} from ${owningFolder(entry.from, repository).slice(repository.length + 1)}`);
  assert.ok(found.includes('pg from services/ehr-api'), found.join(', '));
  assert.ok(found.includes('json-dup-key-validator from release'), found.join(', '));
  const { installDirs } = workspace(repository, false);
  for (const entry of modules) {
    assert.ok(installDirs.includes(owningFolder(entry.from, repository)),
      `${entry.specifier} is loaded from ${entry.from}, which check:db never installs`);
  }
});

test('the import self-check reports a module that is not installed', async (t) => {
  const root = await folder(t);
  await mkdir(join(root, 'scripts'));
  await mkdir(join(root, 'lib'));
  await json(join(root, 'lib/package.json'), { name: 'lib', dependencies: { 'needed-module': '1.0.0' } });
  await writeFile(join(root, 'scripts/helper.mjs'), [
    "import { createRequire } from 'node:module';",
    "const require = createRequire(new URL('../lib/package.json', import.meta.url));",
    "export const needed = require('needed-module');", ''].join('\n'));
  await writeFile(join(root, 'scripts/entry.mjs'), [
    "import { join } from 'node:path';",
    "// import nothing from 'commented-out';",
    "import { needed } from './helper.mjs';",
    "import esmOnly from '@scope/esm-only';", ''].join('\n'));
  const { modules, unknown } = rehearsalModules(join(root, 'scripts/entry.mjs'));
  assert.deepEqual(unknown, []);
  assert.deepEqual(modules.map((entry) => entry.specifier).sort(), ['@scope/esm-only', 'needed-module']);
  const needed = modules.find((entry) => entry.specifier === 'needed-module');
  assert.equal(owningFolder(needed.from, root), join(root, 'lib'));
  assert.equal(resolvesFrom(needed.from, 'needed-module'), false);

  await mkdir(join(root, 'lib/node_modules/needed-module'), { recursive: true });
  await json(join(root, 'lib/node_modules/needed-module/package.json'), { name: 'needed-module', version: '1.0.0' });
  await writeFile(join(root, 'lib/node_modules/needed-module/index.js'), 'module.exports = 1;\n');
  assert.equal(resolvesFrom(needed.from, 'needed-module'), true);
  // An ESM-only package (no require entry point) counts as installed when its folder is there.
  const esm = modules.find((entry) => entry.specifier === '@scope/esm-only');
  await mkdir(join(root, 'node_modules/@scope/esm-only'), { recursive: true });
  await json(join(root, 'node_modules/@scope/esm-only/package.json'),
    { name: '@scope/esm-only', version: '1.0.0', type: 'module', exports: { import: './index.js' } });
  assert.equal(resolvesFrom(esm.from, '@scope/esm-only'), true);
});

async function project(t, { installed, record = true }) {
  const dir = await folder(t);
  await json(join(dir, 'package.json'), { name: 'svc', dependencies: { direct: '1.0.0' } });
  await json(join(dir, 'package-lock.json'), { lockfileVersion: 3, packages: {
    '': { name: 'svc' },
    'node_modules/direct': { version: '1.0.0' },
    'node_modules/indirect': { version: '2.0.0' },
    'node_modules/direct/node_modules/nested': { version: '3.0.0' },
    'node_modules/other-platform': { version: '1.0.0', optional: true },
  } });
  if (!installed) return dir;
  for (const [path, version] of Object.entries(installed)) {
    await mkdir(join(dir, path), { recursive: true });
    await json(join(dir, path, 'package.json'), { name: path.split('/').pop(), version });
  }
  if (record) {
    await json(join(dir, 'node_modules/.package-lock.json'), { lockfileVersion: 3, packages: Object.fromEntries(
      Object.entries(installed).map(([path, version]) => [path, { version }])) });
  }
  return dir;
}
const current = {
  'node_modules/direct': '1.0.0', 'node_modules/indirect': '2.0.0', 'node_modules/direct/node_modules/nested': '3.0.0',
};

test('dependencyState: no node_modules is missing; a matching install is ok', async (t) => {
  assert.equal(dependencyState(await project(t, {})).state, 'missing');
  assert.equal(dependencyState(await project(t, { installed: current })).state, 'ok');
  assert.equal(dependencyState(await project(t, { installed: current, record: false })).state, 'ok');
});

test('dependencyState: an indirect dependency at another version is out of date', async (t) => {
  for (const record of [true, false]) {
    const result = dependencyState(await project(t, {
      installed: { ...current, 'node_modules/direct/node_modules/nested': '2.9.0' }, record }));
    assert.equal(result.state, 'stale');
    assert.deepEqual(result.differ, ['direct > nested 2.9.0 (lockfile wants 3.0.0)']);
  }
});

test('dependencyState: missing and leftover packages are out of date', async (t) => {
  const { 'node_modules/indirect': _, ...withoutIndirect } = current;
  const missing = dependencyState(await project(t, { installed: withoutIndirect }));
  assert.equal(missing.state, 'stale');
  assert.deepEqual(missing.absent, ['indirect']);
  const leftover = dependencyState(await project(t, { installed: { ...current, 'node_modules/removed': '1.0.0' } }));
  assert.equal(leftover.state, 'stale');
  assert.deepEqual(leftover.extra, ['removed (installed, no longer in package-lock.json)']);
});

test('dependencyState: a deleted direct dependency folder is caught even if npm still records it', async (t) => {
  const dir = await project(t, { installed: current });
  await rm(join(dir, 'node_modules/direct/package.json'));
  assert.deepEqual(dependencyState(dir).absent, ['direct']);
});

test('firstErrorLine skips stack frames and object dumps', () => {
  const text = ['node:internal/modules/cjs/loader:1228', '  throw err;', '  ^', '',
    "Error: Cannot find module 'json-dup-key-validator'", 'Require stack:', '- /repo/scripts/x.mjs'].join('\n');
  assert.equal(firstErrorLine(text).line, "Error: Cannot find module 'json-dup-key-validator'");
  const pg = ['migrating 0042', 'error: permission denied for table patients', '    at /repo/node_modules/pg/lib/client.js:545:17',
    '  length: 104,', "  severity: 'ERROR',", "  code: '42501',"].join('\n');
  assert.equal(firstErrorLine(pg).line, 'error: permission denied for table patients');
  assert.equal(firstErrorLine('all good\n# fail 0\n0 failed'), null);
});

test('rehearsalFailure names the failing step and uses its full output, not the 1800-character tail', () => {
  const repo = '/work/hid';
  const stderr = ['notice: starting', 'AssertionError [ERR_ASSERTION]: role cannot read table',
    `    at check (file://${repo}/services/ehr-api/scripts/verify-role.mjs:41:9)`,
    ...Array.from({ length: 200 }, (_, i) => `  field${i}: 'object dump line ${i}',`), '}'].join('\n');
  const log = JSON.stringify({ status: 'failed', evidence: '/logs/rehearsal-evidence/evidence.json',
    failure: `exact-role pharmacy failed: ${stderr.slice(-1800)}` });
  const commands = [{ label: 'migrate', stdout: 'ok', stderr: '' },
    { label: 'exact-role pharmacy', stdout: '', stderr }];
  const found = rehearsalFailure(`${log}\n`, commands, repo);
  assert.equal(found.step, 'exact-role pharmacy');
  assert.equal(found.firstError, 'AssertionError [ERR_ASSERTION]: role cannot read table');
  assert.equal(found.where, 'services/ehr-api/scripts/verify-role.mjs:41:9');
  assert.equal(found.fromCommand, true);
  assert.equal(found.output.includes('notice: starting'), true);
  assert.equal(found.evidence, '/logs/rehearsal-evidence/evidence.json');
});

test('rehearsalFailure handles a rehearsal that could not start or failed in its own checks', () => {
  const crash = rehearsalFailure([`file:///work/hid/scripts/prepare-staging-journey-fixture.mjs:13`,
    "Error: Cannot find module 'json-dup-key-validator'"].join('\n'), null, '/work/hid');
  assert.match(crash.step, /^start-up/);
  assert.equal(crash.firstError, "Error: Cannot find module 'json-dup-key-validator'");
  assert.equal(crash.where, 'scripts/prepare-staging-journey-fixture.mjs:13');
  const own = rehearsalFailure(JSON.stringify({ status: 'failed', failure: 'Expected values to be strictly equal:\n\n3 !== 4\n' }),
    [], '/work/hid');
  assert.match(own.step, /rehearsal's own checks/);
  assert.equal(own.firstError, 'Expected values to be strictly equal:');
  assert.equal(own.fromCommand, false);
});
