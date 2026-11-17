#!/usr/bin/env node
// One-command local version of CI's database gate (Q94 5).
//
//   npm run check:db                  check prerequisites, then run the rehearsal
//   npm run check:db -- --prepare     also install/build what is missing first
//   npm run check:db -- --all         also run identity-api and ehr-api jest and the release tests
//
// It only uses the throwaway, socket-only PostgreSQL cluster that
// scripts/tuf-staging-migration-rehearsal.mjs creates with fictional data. It
// never takes a database URL, never reads .env files and never changes global
// settings: --prepare only runs `npm ci` and `npm run build` inside this checkout.
import { spawnSync } from 'node:child_process';
import {
  closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync,
  readlinkSync, statSync, statfsSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, relative, resolve } from 'node:path';

const repository = resolve(import.meta.dirname, '..');
const rel = (path) => relative(repository, path) || '.';
const usage = `Usage: npm run check:db [-- options]

  --prepare       install missing or out-of-date dependencies (npm ci in each
                  service/package folder) and build missing packages, then run
  --all           also run identity-api and ehr-api jest and the release tests
  --check-only    only check prerequisites; do not run anything
  --log-dir DIR   write logs to DIR (default: a new folder under ${tmpdir()})
  --help          show this help`;

// ---------------------------------------------------------------- arguments
const options = { prepare: false, all: false, checkOnly: false, logDir: null };
{
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--prepare') options.prepare = true;
    else if (arg === '--all') options.all = true;
    else if (arg === '--check-only') options.checkOnly = true;
    else if (arg === '--log-dir' && args[i + 1]) options.logDir = resolve(args[(i += 1)]);
    else if (arg === '--help' || arg === '-h') { console.log(usage); process.exit(0); }
    else { console.error(`Unknown option: ${arg}\n\n${usage}`); process.exit(64); }
  }
}

// ---------------------------------------------------------------- output helpers
const color = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code, text) => (color ? `\x1b[${code}m${text}\x1b[0m` : text);
const ok = (text) => console.log(`  ${paint(32, 'ok     ')} ${text}`);
const warn = (text) => console.log(`  ${paint(33, 'warn   ')} ${text}`);
const problems = [];
function problem(title, fixes, kind = 'setup') {
  problems.push({ title, fixes, kind });
  console.log(`  ${paint(31, 'MISSING')} ${title}`);
  for (const fix of fixes) console.log(`          ${fix}`);
}
const seconds = (ms) => {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
};
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const run = (executable, args, extra = {}) =>
  spawnSync(executable, args, { cwd: repository, encoding: 'utf8', ...extra });

// ---------------------------------------------------------------- what the check needs
// Every service with a lockfile (the rehearsal boots Identity, EHR, Lab,
// Pharmacy, OCR and Notification code; CI installs them all) and every local
// package those services link with `file:` (they import its built dist/).
const serviceDirs = readdirSync(join(repository, 'services'))
  .map((name) => join(repository, 'services', name))
  .filter((dir) => existsSync(join(dir, 'package-lock.json')));
const linkedPackages = new Set();
for (const dir of serviceDirs) {
  const manifest = readJson(join(dir, 'package.json'));
  for (const spec of Object.values({ ...manifest.dependencies, ...manifest.devDependencies })) {
    if (typeof spec === 'string' && spec.startsWith('file:')) linkedPackages.add(resolve(dir, spec.slice(5)));
  }
}
const packageDirs = [...linkedPackages].filter((dir) => existsSync(join(dir, 'package.json'))).sort();
// --all adds the release tests, which also load infra/cloudflare's TUF scripts.
const installDirs = [...packageDirs, ...serviceDirs,
  ...(options.all ? [join(repository, 'release'), join(repository, 'infra/cloudflare')] : [])];

// Compare what is in node_modules with the folder's package-lock.json, for the
// folder's direct dependencies only (fast, and catches "lockfile changed, not reinstalled").
function dependencyState(dir) {
  const modules = join(dir, 'node_modules');
  if (!existsSync(modules)) return { state: 'missing' };
  const manifest = readJson(join(dir, 'package.json'));
  const lock = readJson(join(dir, 'package-lock.json'));
  const names = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies });
  const absent = [];
  const differ = [];
  for (const name of names) {
    const locked = lock.packages?.[`node_modules/${name}`];
    const installedManifest = join(modules, name, 'package.json');
    if (!existsSync(installedManifest)) { absent.push(name); continue; }
    if (locked?.link || !locked?.version) continue;
    const installed = readJson(installedManifest).version;
    if (installed !== locked.version) differ.push(`${name} ${installed} (lockfile wants ${locked.version})`);
  }
  if (absent.length || differ.length) return { state: 'stale', absent, differ };
  return { state: 'ok', count: names.length };
}

function newestMtime(path) {
  if (!existsSync(path)) return 0;
  const stat = statSync(path);
  if (!stat.isDirectory()) return stat.mtimeMs;
  let newest = 0;
  for (const entry of readdirSync(path)) newest = Math.max(newest, newestMtime(join(path, entry)));
  return newest;
}

function buildState(dir) {
  const manifest = readJson(join(dir, 'package.json'));
  const main = join(dir, manifest.main || 'dist/index.js');
  if (!existsSync(main)) return { state: 'missing', main };
  const sources = Math.max(newestMtime(join(dir, 'src')), newestMtime(join(dir, 'tsconfig.json')));
  if (sources > statSync(main).mtimeMs) return { state: 'older', main };
  return { state: 'ok', main };
}

const isLinkedFolder = (dir) => {
  try { return lstatSync(join(dir, 'node_modules')).isSymbolicLink(); } catch { return false; }
};

// ---------------------------------------------------------------- prerequisite checks
let pgConfig = null;

function checkNode() {
  const major = Number(process.versions.node.split('.')[0]);
  if (major >= 22) ok(`Node.js ${process.versions.node}`);
  else problem(`Node.js 22 or newer is needed (this is ${process.versions.node}).`,
    ['Install Node.js 22 (the version CI uses), for example with nvm: nvm install 22 && nvm use 22']);
}

function checkUser() {
  if (process.getuid?.() !== 0) { ok('running as a normal (non-root) user'); return; }
  problem('You are running as root. PostgreSQL refuses to start as root, so the rehearsal stops.', [
    'Run the check from your normal user account (not with sudo).',
    'In a container that only has root, run it as another user, for example:',
    `  su <user> -c 'cd ${repository} && npm run check:db'`,
  ]);
}

function pgMajor(candidate) {
  const result = spawnSync(candidate, ['--version'], { encoding: 'utf8' });
  if (result.error || result.status !== 0) return null;
  const match = /PostgreSQL (\d+)/.exec(result.stdout);
  return match ? { version: result.stdout.trim(), major: Number(match[1]) } : null;
}

function checkPostgres() {
  const explicit = process.env.PG_CONFIG;
  const onPath = (process.env.PATH || '').split(delimiter).map((dir) => join(dir, 'pg_config')).filter(existsSync);
  const wellKnown = ['/usr/lib/postgresql/16/bin/pg_config', '/usr/pgsql-16/bin/pg_config',
    '/opt/homebrew/opt/postgresql@16/bin/pg_config', '/usr/local/opt/postgresql@16/bin/pg_config',
    '/Applications/Postgres.app/Contents/Versions/16/bin/pg_config'].filter(existsSync);
  const install = ['Install PostgreSQL 16 server binaries and pgvector, for example:',
    '  Ubuntu/Debian: sudo apt install postgresql-16 postgresql-16-pgvector',
    '  macOS (Homebrew): brew install postgresql@16 pgvector',
    'then point the check at it: export PG_CONFIG=/usr/lib/postgresql/16/bin/pg_config',
    '  (Homebrew: export PG_CONFIG="$(brew --prefix postgresql@16)/bin/pg_config")'];
  if (explicit) {
    const found = pgMajor(explicit);
    if (!found) { problem(`PG_CONFIG is set to ${explicit}, but that program does not run.`, install); return; }
    if (found.major !== 16) {
      problem(`PG_CONFIG points to ${found.version}; the rehearsal needs PostgreSQL 16 (as in CI).`,
        [wellKnown[0] ? `Use: export PG_CONFIG=${wellKnown[0]}` : install[0], ...(wellKnown[0] ? [] : install.slice(1))]);
      return;
    }
    pgConfig = explicit;
  } else {
    const candidates = [...new Set([...onPath, ...wellKnown])];
    const seen = candidates.map((candidate) => ({ candidate, found: pgMajor(candidate) }));
    pgConfig = seen.find((entry) => entry.found?.major === 16)?.candidate ?? null;
    if (!pgConfig) {
      const other = seen.find((entry) => entry.found);
      problem(other ? `Only ${other.found.version} was found (${other.candidate}); the rehearsal needs PostgreSQL 16.`
        : 'PostgreSQL 16 was not found (no pg_config on PATH or in the usual places).', install);
      return;
    }
  }
  const bindir = spawnSync(pgConfig, ['--bindir'], { encoding: 'utf8' }).stdout.trim();
  const sharedir = spawnSync(pgConfig, ['--sharedir'], { encoding: 'utf8' }).stdout.trim();
  const tools = ['postgres', 'initdb', 'pg_ctl', 'createdb', 'psql', 'pg_dump', 'pg_restore'];
  const absentTools = tools.filter((tool) => !existsSync(join(bindir, tool)));
  if (absentTools.length) {
    problem(`PostgreSQL 16 client is there but server tools are missing in ${bindir}: ${absentTools.join(', ')}.`,
      ['Install the server package, for example: sudo apt install postgresql-16']);
    return;
  }
  if (!existsSync(join(sharedir, 'extension/vector.control'))) {
    problem(`The pgvector extension is not installed for PostgreSQL 16 (${join(sharedir, 'extension')}).`,
      ['Ubuntu/Debian: sudo apt install postgresql-16-pgvector', 'macOS (Homebrew): brew install pgvector']);
    return;
  }
  ok(`${pgMajor(pgConfig).version} with pgvector (${process.env.PG_CONFIG ? 'PG_CONFIG' : 'found'}: ${pgConfig})`);
}

function checkGit() {
  // The rehearsal calls git with a minimal environment (no HOME), so only the
  // checkout's own and the system git settings apply. Check it the same way.
  const env = { PATH: process.env.PATH, LANG: 'C.UTF-8', TZ: 'UTC' };
  const result = run('git', ['rev-parse', 'HEAD'], { env });
  if (result.error) {
    problem('git is not installed or not on PATH.', ['Install git (the rehearsal records the commit it tested).']);
    return;
  }
  if (result.status === 0) { ok(`git can read this checkout (HEAD ${result.stdout.trim().slice(0, 12)})`); return; }
  if (/dubious ownership/.test(result.stderr)) {
    problem(`git refuses to read ${repository}: the folder belongs to another user ("dubious ownership").`, [
      'Best fix: work in a clone that your own account created (git clone ... as yourself).',
      'The rehearsal runs git without your HOME, so a --global safe.directory setting is not enough.',
      `If you must use this folder, an administrator can allow it: sudo git config --system --add safe.directory ${repository}`,
    ]);
    return;
  }
  problem(`git could not read this checkout: ${(result.stderr || '').trim().split('\n')[0]}`,
    ['Run the check from inside a git clone of hid-system.']);
}

function checkTmp() {
  try {
    const stat = statfsSync('/tmp');
    const free = (stat.bavail * stat.bsize) / 1024 ** 3;
    if (free < 1) warn(`/tmp has only ${free.toFixed(1)} GB free; the throwaway database needs a few hundred MB.`);
    else ok(`/tmp has ${free.toFixed(1)} GB free for the throwaway database`);
  } catch { warn('could not read free space in /tmp'); }
}

function checkDependencies() {
  for (const dir of installDirs) {
    const name = rel(dir);
    const result = dependencyState(dir);
    if (result.state === 'ok') { ok(`${name}: dependencies installed`); continue; }
    const fix = [`Fix: npm --prefix ${name} ci${options.prepare ? '' : '      (or run: npm run check:db -- --prepare)'}`];
    if (result.state === 'missing') problem(`${name}: dependencies are not installed (no node_modules).`, fix, 'npm');
    else {
      const details = [...result.absent.map((dep) => `${dep} (not installed)`), ...result.differ];
      problem(`${name}: dependencies do not match package-lock.json: ${details.slice(0, 3).join(', ')}`
        + (details.length > 3 ? ` and ${details.length - 3} more` : ''), fix, 'npm');
    }
  }
}

function checkBuilds() {
  for (const dir of packageDirs) {
    const name = rel(dir);
    const manifest = readJson(join(dir, 'package.json'));
    const result = buildState(dir);
    if (result.state === 'ok') ok(`${name}: built (${rel(result.main)})`);
    else if (result.state === 'older') {
      warn(`${name}: ${rel(result.main)} is older than its source; rebuild if you changed it: npm --prefix ${name} run build`);
    } else {
      problem(`${name} (${manifest.name}) is not built: ${rel(result.main)} is missing. Services import the built package.`,
        [`Fix: npm --prefix ${name} ci && npm --prefix ${name} run build${options.prepare ? '' : '      (or: npm run check:db -- --prepare)'}`], 'npm');
    }
  }
}

function checkPrerequisites() {
  problems.length = 0;
  checkNode();
  checkUser();
  checkPostgres();
  checkGit();
  checkTmp();
  checkDependencies();
  checkBuilds();
  return problems.length === 0;
}

// ---------------------------------------------------------------- logging and steps
let logDir = options.logDir;
function ensureLogDir() {
  if (logDir) { mkdirSync(logDir, { recursive: true, mode: 0o700 }); return logDir; }
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');
  logDir = mkdtempSync(join(tmpdir(), `hid-db-check-${stamp}-`));
  return logDir;
}

const steps = [];
function step(label, file, executable, args, extra = {}) {
  const log = join(ensureLogDir(), `${file}.log`);
  process.stdout.write(`  ${label} ... `);
  const started = Date.now();
  const fd = openSync(log, 'w', 0o600);
  let result;
  try {
    result = spawnSync(executable, args, {
      cwd: repository, stdio: ['ignore', fd, fd], timeout: 45 * 60 * 1000, env: process.env, ...extra,
    });
  } finally { closeSync(fd); }
  const passed = !result.error && result.status === 0;
  const record = { label, log, passed, ms: Date.now() - started, reason: null };
  if (!passed) {
    record.reason = result.error ? `could not start: ${result.error.code || result.error.message}`
      : result.signal ? `stopped by ${result.signal} (timeout is 45 minutes)` : `exit code ${result.status}`;
  }
  console.log(`${passed ? paint(32, 'passed') : paint(31, 'FAILED')} (${seconds(record.ms)})`);
  steps.push(record);
  return record;
}

const tail = (path, pattern, count = 3) => readFileSync(path, 'utf8').split('\n')
  .filter((line) => pattern.test(line)).slice(-count).map((line) => line.trim().slice(0, 300));
function failureLines(record) {
  const lines = [...new Set(tail(record.log, /^\s*(FAIL\s|Tests:|# fail|not ok)|\b(error|ERR!)\b|EACCES/i, 4))];
  const denied = lines.find((line) => /EACCES/.test(line));
  if (denied) return [denied, 'Your account cannot write to this checkout. Use a clone your own account owns.'];
  return lines;
}

// ---------------------------------------------------------------- prepare
function prepare() {
  const installs = [];
  for (const dir of installDirs) {
    if (dependencyState(dir).state === 'ok') continue;
    if (isLinkedFolder(dir)) {
      console.log(`  skip  ${rel(dir)}: node_modules is a link to ${readlinkSync(join(dir, 'node_modules'))};`
        + ' not replacing it. Remove the link yourself, then run --prepare again.');
      continue;
    }
    installs.push(dir);
  }
  const builds = packageDirs.filter((dir) => installs.includes(dir) || buildState(dir).state === 'missing');
  // Packages first (services link to them and import their dist/), then services.
  const planned = [
    ...installs.filter((dir) => packageDirs.includes(dir)).map((dir) => ['install', dir, ['ci', '--no-audit', '--no-fund']]),
    ...builds.map((dir) => ['build', dir, ['run', 'build']]),
    ...installs.filter((dir) => !packageDirs.includes(dir)).map((dir) => ['install', dir, ['ci', '--no-audit', '--no-fund']]),
  ];
  if (!planned.length) { console.log('  nothing to install or build'); return true; }
  for (const [verb, dir, args] of planned) {
    const name = rel(dir);
    if (!step(`${verb} ${name}`, `prepare-${verb}-${name.replaceAll('/', '-')}`, 'npm', ['--prefix', dir, ...args]).passed) {
      return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------- summary
function summary(outcome, extra = []) {
  const lines = ['', 'Database check summary'];
  for (const record of steps) {
    lines.push(`  ${record.passed ? 'passed' : 'FAILED'}  ${record.label.padEnd(36)} ${seconds(record.ms)}`);
  }
  const failed = steps.find((record) => !record.passed);
  if (outcome === 'prerequisites') {
    lines.push(`Result: NOT RUN - ${problems.length} prerequisite(s) missing (see the MISSING lines above).`);
    if (problems.some((p) => p.kind === 'npm') && !options.prepare) {
      lines.push('For the npm items you can also run: npm run check:db -- --prepare   (installs and builds inside this checkout only)');
    }
  } else if (failed) {
    lines.push(`Result: FAILED at "${failed.label}" (${failed.reason})`, ...extra.map((line) => `  ${line}`));
    lines.push(`  Log: ${failed.log}`);
  } else if (outcome === 'check-only') {
    lines.push('Result: all prerequisites are in place (--check-only: nothing was run).');
  } else {
    lines.push(`Result: PASSED (${seconds(steps.reduce((sum, record) => sum + record.ms, 0))} in total)`);
  }
  if (logDir) {
    lines.push(`Logs: ${logDir}`, `  (remove when done: rm -rf ${logDir})`);
    writeFileSync(join(logDir, 'summary.txt'), lines.join('\n') + '\n', { mode: 0o600 });
  }
  console.log(lines.join('\n'));
}

// ---------------------------------------------------------------- main
console.log(`HID database check in ${repository}`);
console.log('\nPrerequisites');
let ready = checkPrerequisites();

if (!ready && options.prepare) {
  if (problems.some((p) => p.kind === 'setup')) {
    console.log('\n--prepare only installs npm dependencies and builds packages; fix the items above that'
      + ' are about your account, PostgreSQL, git or Node.js first.');
  } else {
    console.log('\nPreparing (npm ci and package builds inside this checkout)');
    if (prepare()) {
      console.log('\nPrerequisites (after preparing)');
      ready = checkPrerequisites();
    }
  }
} else if (ready && options.prepare) {
  console.log('\nPreparing\n  nothing to install or build');
}

const prepareFailure = steps.find((record) => !record.passed);
if (prepareFailure) { summary('prepare', failureLines(prepareFailure)); process.exit(1); }
if (!ready) { summary('prerequisites'); process.exit(2); }
if (options.checkOnly) { summary('check-only'); process.exit(0); }

console.log('\nRunning (each step writes a log; this takes a few minutes)');
// The rehearsal insists on a new evidence folder, so never reuse one from an earlier --log-dir run.
let rehearsalEvidence = join(ensureLogDir(), 'rehearsal-evidence');
for (let n = 2; existsSync(rehearsalEvidence); n += 1) rehearsalEvidence = join(logDir, `rehearsal-evidence-${n}`);
const rehearsal = step('migration rehearsal', 'migration-rehearsal', process.execPath,
  ['scripts/tuf-staging-migration-rehearsal.mjs', '--evidence-dir', rehearsalEvidence],
  { env: { ...process.env, PG_CONFIG: pgConfig } });
const detail = [];
if (!rehearsal.passed) {
  // The rehearsal prints one JSON line; its `failure` names the sub-step ("<label> failed: ...").
  const last = readFileSync(rehearsal.log, 'utf8').trim().split('\n').reverse()
    .map((line) => { try { return JSON.parse(line); } catch { return null; } }).find(Boolean);
  if (last?.failure) {
    const lines = last.failure.split('\n');
    const sub = /^(.*?) failed:/.exec(lines[0])?.[1];
    // Prefer the error message over the first stack line, and name the repo file it came from.
    const message = lines.find((line) => /^\s*(?:[A-Za-z]*Error|Assertion)\b[^:]*:/.test(line))?.trim();
    const where = lines.map((line) => line.split(`file://${repository}/`)[1]).find(Boolean)?.replace(/\)?\s*$/, '');
    if (sub) detail.push(`Failing rehearsal step: ${sub}`);
    detail.push(`Reason: ${(message || lines[0]).slice(0, 300)}`);
    if (where) detail.push(`Where: ${where}`);
    if (/^exact-role /.test(sub || '')) {
      detail.push('This is a runtime verifier. If your change altered a table, grant or route it uses,'
        + ' update that verifier script in the same branch.');
    }
    detail.push(`Rehearsal evidence: ${last.evidence}`);
    if (options.all) detail.push('The jest and release tests were not run because the rehearsal failed.');
  } else {
    detail.push(...tail(rehearsal.log, /Error|error:/, 3).map((line) => `Reason: ${line.slice(0, 300)}`));
  }
} else if (options.all) {
  const suites = [
    ['identity-api jest', 'identity-api-jest', ['--prefix', 'services/identity-api', 'test']],
    ['ehr-api jest', 'ehr-api-jest', ['--prefix', 'services/ehr-api', 'test']],
    ['release tests', 'release-tests', ['--prefix', 'release', 'test']],
  ];
  for (const [label, file, args] of suites) {
    const record = step(label, file, 'npm', args);
    if (!record.passed) {
      detail.push(...failureLines(record));
      break;
    }
  }
}
summary('run', detail);
process.exit(steps.every((record) => record.passed) ? 0 : 1);
