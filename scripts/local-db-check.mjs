#!/usr/bin/env node
// One-command local version of CI's database gate (Q94 5).
//
//   npm run check:db                  check prerequisites, then run the rehearsal
//   npm run check:db -- --prepare     also install/build what is missing first
//   npm run check:db -- --all         also run identity-api and ehr-api jest and the release tests
//
// It only uses the throwaway, socket-only PostgreSQL cluster that
// scripts/tuf-staging-migration-rehearsal.mjs creates with fictional data. It
// never takes a database URL, never reads .env files and never changes git or
// npm settings. --prepare runs `npm ci` and `npm run build` in this checkout's
// folders; like any npm ci, that downloads from your configured registry, reads
// your npm settings (~/.npmrc) and writes to your npm cache and log folder.
import { spawnSync } from 'node:child_process';
import {
  closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync,
  readlinkSync, statSync, statfsSync, writeFileSync,
} from 'node:fs';
import { createRequire, isBuiltin } from 'node:module';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultRepository = resolve(import.meta.dirname, '..');
export const REHEARSAL = 'scripts/tuf-staging-migration-rehearsal.mjs';

export const usage = `Usage: npm run check:db [-- options]

  --prepare       install missing or out-of-date dependencies (npm ci in each
                  service/package folder of this checkout) and build missing
                  packages, then run. npm ci downloads from your configured
                  registry and uses your npm settings (~/.npmrc) and npm cache.
  --all           also run identity-api and ehr-api jest and the release tests
  --check-only    only check prerequisites; do not install or run anything
                  (cannot be combined with --prepare)
  --log-dir DIR   write logs to DIR (default: a new hid-db-check-* folder in
                  your system temp folder, ${tmpdir()})
  --help          show this help`;

// ---------------------------------------------------------------- arguments
// Returns { options } or { error } (a plain message), or { help: true }.
export function parseArgs(args) {
  const options = { prepare: false, all: false, checkOnly: false, logDir: null };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--prepare') options.prepare = true;
    else if (arg === '--all') options.all = true;
    else if (arg === '--check-only') options.checkOnly = true;
    else if (arg === '--help' || arg === '-h') return { help: true };
    else if (arg === '--log-dir' || arg.startsWith('--log-dir=')) {
      const value = arg === '--log-dir' ? args[(i += 1)] : arg.slice('--log-dir='.length);
      if (!value || value.startsWith('-')) {
        return { error: '--log-dir needs a folder name after it, for example: --log-dir ./db-check-logs' };
      }
      options.logDir = resolve(value);
    } else return { error: `Unknown option: ${arg}` };
  }
  if (options.prepare && options.checkOnly) {
    return { error: '--prepare and --check-only cannot be used together: --check-only never installs anything.'
      + ' Use --check-only to look, or --prepare to install and run.' };
  }
  return { options };
}

// ---------------------------------------------------------------- what the check needs
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const readJsonOrNull = (path) => { try { return readJson(path); } catch { return null; } };

// Every service with a lockfile (the rehearsal boots Identity, EHR, Lab,
// Pharmacy, OCR and Notification code; CI installs them all), every local
// package those services link with `file:` (they import its built dist/), and
// release/ (the rehearsal always loads release/ modules, for example
// json-dup-key-validator through prepare-staging-journey-fixture.mjs).
// --all adds infra/cloudflare, whose TUF scripts the release tests load.
export function workspace(repository, all = false) {
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
  const installDirs = [...packageDirs, ...serviceDirs, join(repository, 'release'),
    ...(all ? [join(repository, 'infra/cloudflare')] : [])];
  return { serviceDirs, packageDirs, installDirs };
}

// Compare what is in node_modules with the folder's package-lock.json. Every
// package in package-lock.json is compared with npm's record of what it
// installed (node_modules/.package-lock.json, or each installed package.json
// when that record is missing), so a changed lockfile that was not reinstalled
// shows up even when only an indirect dependency moved.
export function dependencyState(dir) {
  const modules = join(dir, 'node_modules');
  if (!existsSync(modules)) return { state: 'missing' };
  const manifest = readJson(join(dir, 'package.json'));
  const lock = readJson(join(dir, 'package-lock.json'));
  const locked = lock.packages ?? {};
  const absent = [];
  const differ = [];
  const extra = [];
  // Direct dependencies must really be on disk (a deleted folder leaves npm's record behind).
  for (const name of Object.keys({ ...manifest.dependencies, ...manifest.devDependencies })) {
    if (!existsSync(join(modules, name, 'package.json'))) absent.push(name);
  }
  const record = readJsonOrNull(join(modules, '.package-lock.json'))?.packages ?? null;
  const show = (path) => path.replace(/^node_modules\//, '').replaceAll('/node_modules/', ' > ');
  let count = 0;
  for (const [path, wanted] of Object.entries(locked)) {
    if (!path.startsWith('node_modules/')) continue;
    count += 1;
    const have = record ? record[path] : readJsonOrNull(join(dir, path, 'package.json'));
    if (!have) {
      // Optional packages for another platform are legitimately absent.
      if (!wanted.optional && !absent.includes(show(path))) absent.push(show(path));
      continue;
    }
    if (wanted.link || !wanted.version) continue;
    if (have.version !== wanted.version) differ.push(`${show(path)} ${have.version} (lockfile wants ${wanted.version})`);
  }
  if (record) {
    for (const path of Object.keys(record)) {
      if (path.startsWith('node_modules/') && !locked[path]) extra.push(`${show(path)} (installed, no longer in package-lock.json)`);
    }
  }
  if (absent.length || differ.length || extra.length) return { state: 'stale', absent, differ, extra };
  return { state: 'ok', count };
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

// ---------------------------------------------------------------- rehearsal imports
// Statically follow the rehearsal's own .mjs imports and list every npm
// package it loads, with the place it is loaded from: `import ... from 'pkg'`
// (from the importing file) and `require('pkg')` through createRequire(base).
function splitArgs(text) {
  const parts = [];
  let depth = 0;
  let quote = null;
  let current = '';
  for (const char of text) {
    if (quote) { if (char === quote) quote = null; current += char; continue; }
    if (char === '\'' || char === '"' || char === '`') quote = char;
    else if ('([{'.includes(char)) depth += 1;
    else if (')]}'.includes(char)) depth -= 1;
    else if (char === ',' && depth === 0) { parts.push(current.trim()); current = ''; continue; }
    current += char;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

function evaluatePath(expression, file, source, depth = 0) {
  const expr = expression.trim();
  if (depth > 8) return null;
  let match;
  if ((match = /^(['"])([^'"]*)\1$/.exec(expr))) return match[2];
  if (expr === 'import.meta.dirname') return dirname(file);
  if (expr === 'import.meta.filename') return file;
  if ((match = /^new URL\(([\s\S]*)\)$/.exec(expr))) {
    const [target, base] = splitArgs(match[1]);
    if (base !== 'import.meta.url') return null;
    const value = evaluatePath(target, file, source, depth + 1);
    return value === null ? null : resolve(dirname(file), value);
  }
  if ((match = /^fileURLToPath\(([\s\S]*)\)$/.exec(expr))) return evaluatePath(match[1], file, source, depth + 1);
  if ((match = /^(join|resolve)\(([\s\S]*)\)$/.exec(expr))) {
    const parts = splitArgs(match[2]).map((part) => evaluatePath(part, file, source, depth + 1));
    if (parts.some((part) => part === null)) return null;
    return match[1] === 'join' ? join(...parts) : resolve(...parts);
  }
  if (/^\w+$/.test(expr)) {
    const definition = new RegExp(`(?:const|let)\\s+${expr}\\s*=\\s*([^;\\n]+);`).exec(source);
    return definition ? evaluatePath(definition[1], file, source, depth + 1) : null;
  }
  return null;
}

export function rehearsalModules(entry) {
  const seen = new Set();
  const modules = [];
  const unknown = [];
  const visit = (file) => {
    if (seen.has(file) || !existsSync(file)) return;
    seen.add(file);
    const source = readFileSync(file, 'utf8');
    const code = source.split('\n').filter((line) => !/^\s*\/\//.test(line)).join('\n');
    const specifiers = [];
    for (const match of code.matchAll(/(?:^|[\s;])(?:import|export)\s[^'"`;]*?\bfrom\s*['"]([^'"]+)['"]|(?:^|[\s;])import\s*['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]\s*\)/gm)) {
      specifiers.push({ specifier: match[1] ?? match[2] ?? match[3], from: file });
    }
    for (const match of code.matchAll(/(?:const|let|var)\s+(\w+)\s*=\s*createRequire\(/g)) {
      let end = match.index + match[0].length;
      for (let depth = 1; end < code.length && depth > 0; end += 1) {
        if (code[end] === '(') depth += 1;
        else if (code[end] === ')') depth -= 1;
      }
      const argument = code.slice(match.index + match[0].length, end - 1);
      const base = evaluatePath(argument, file, code);
      for (const call of code.matchAll(new RegExp(`\\b${match[1]}(?:\\.resolve)?\\(\\s*['"]([^'"]+)['"]\\s*\\)`, 'g'))) {
        if (base === null) unknown.push({ specifier: call[1], importer: file, expression: argument });
        else specifiers.push({ specifier: call[1], from: base });
      }
    }
    for (const { specifier, from } of specifiers) {
      if (isBuiltin(specifier)) continue;
      if (specifier.startsWith('.') || specifier.startsWith('/')) {
        const target = resolve(dirname(from), specifier);
        if (/\.(mjs|js|cjs)$/.test(target)) visit(target);
        continue;
      }
      modules.push({ specifier, importer: file, from });
    }
  };
  visit(entry);
  return { modules, unknown, files: [...seen] };
}

const packageName = (specifier) => specifier.split('/').slice(0, specifier.startsWith('@') ? 2 : 1).join('/');

export function resolvesFrom(from, specifier) {
  try { createRequire(from).resolve(specifier); return true; } catch (error) {
    if (error.code === 'MODULE_NOT_FOUND') return false;
  }
  // An ESM-only package has no `require` entry point; it is enough that the package is installed.
  for (let dir = dirname(from); ; dir = dirname(dir)) {
    if (existsSync(join(dir, 'node_modules', packageName(specifier), 'package.json'))) return true;
    if (dirname(dir) === dir) return false;
  }
}

// The folder whose `npm ci` provides a module loaded from `from`.
export function owningFolder(from, repository) {
  for (let dir = dirname(from); dir.startsWith(repository); dir = dirname(dir)) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    if (dir === repository) break;
  }
  return repository;
}

// ---------------------------------------------------------------- failure analysis
const STACK_FRAME = /^\s*at\s|^\s*throw\s|^\s*\^+\s*$/;
const ERROR_LINE = /\b(?:[A-Z][A-Za-z]*Error|ERR_[A-Z_]+)\b|\bfailed\b|^\s*(?:FAIL\s|not ok\b|npm (?:ERR!|error)\b)|^\s*(?:[Ee]rror|ERROR|[Ff]atal|FATAL|PANIC)\b/;
const NOT_AN_ERROR = /\b0 failed\b|^\s*#\s*fail\s+0\b/i;

// First line that reads like the actual error, not the tail of a stack or an object dump.
export function firstErrorLine(text) {
  const lines = String(text ?? '').split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim() || STACK_FRAME.test(line) || NOT_AN_ERROR.test(line)) continue;
    if (ERROR_LINE.test(line)) return { line: line.trim().slice(0, 300), index };
  }
  return null;
}

// First file of this checkout named at or after line `from` (the error's own stack).
export function repoLocation(text, repository, from = 0) {
  const escaped = repository.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`(?:file://)?${escaped}/([^\\s():'"]+(?::\\d+){0,2})`);
  const lines = String(text ?? '').split('\n');
  for (const slice of [lines.slice(from), lines]) {
    for (const line of slice) {
      const match = pattern.exec(line);
      if (match && !match[1].includes('node_modules/')) return match[1];
    }
  }
  return null;
}

// Work out which rehearsal step failed and where its full output is.
// `log` is the rehearsal's own output; `commands` is its evidence commands.json
// (every child command's full stdout and stderr), when it got that far.
export function rehearsalFailure(log, commands, repository) {
  const result = String(log).trim().split('\n').reverse()
    .map((line) => { try { const value = JSON.parse(line); return value && typeof value === 'object' ? value : null; } catch { return null; } })
    .find(Boolean) ?? null;
  if (!result) {
    const first = firstErrorLine(log);
    return { step: 'start-up (the rehearsal stopped before running any step)', output: log, fromCommand: false,
      firstError: first?.line ?? null, where: repoLocation(log, repository, first?.index), evidence: null };
  }
  const failure = String(result.failure ?? result.cleanup_failure ?? '');
  const headline = failure.split('\n')[0];
  const label = /^(.*?) (?:failed:|unexpectedly succeeded)/.exec(headline)?.[1] ?? null;
  const entry = label && Array.isArray(commands) ? [...commands].reverse().find((command) => command.label === label) : null;
  const output = entry ? [entry.stderr, entry.stdout].filter(Boolean).join('\n') : failure;
  const first = firstErrorLine(output);
  let firstError = first?.line ?? null;
  if (/unexpectedly succeeded/.test(headline)) firstError = `${label} was expected to be rejected, but it succeeded`;
  return {
    step: label ?? 'one of the rehearsal\'s own checks (not a child command)',
    output, fromCommand: Boolean(entry),
    firstError: firstError ?? (headline.slice(0, 300) || null),
    where: repoLocation(output, repository, first?.index),
    evidence: result.evidence ?? null,
  };
}

// ---------------------------------------------------------------- main
function main(argv) {
  const parsed = parseArgs(argv);
  if (parsed.help) { console.log(usage); return 0; }
  if (parsed.error) { console.error(`${parsed.error}\n\n${usage}`); return 64; }
  const { options } = parsed;
  const repository = defaultRepository;
  const rel = (path) => relative(repository, path) || '.';
  const { packageDirs, installDirs } = workspace(repository, options.all);

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
  const orPrepare = options.prepare ? '' : '      (or run: npm run check:db -- --prepare)';

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
    const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8', env });
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
    // The rehearsal always puts its throwaway database in /tmp.
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
      if (result.state === 'ok') { ok(`${name}: dependencies installed and match package-lock.json`); continue; }
      const fix = [`Fix: npm --prefix ${name} ci${orPrepare}`];
      if (result.state === 'missing') { problem(`${name}: dependencies are not installed (no node_modules).`, fix, 'npm'); continue; }
      const details = [...result.absent.map((dep) => `${dep} (not installed)`), ...result.differ, ...result.extra];
      problem(`${name}: dependencies out of date, run with --prepare. Not matching package-lock.json: `
        + `${details.slice(0, 3).join(', ')}${details.length > 3 ? ` and ${details.length - 3} more` : ''}`, fix, 'npm');
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
          [`Fix: npm --prefix ${name} ci && npm --prefix ${name} run build${orPrepare}`], 'npm');
      }
    }
  }

  // Every npm package the rehearsal itself loads must resolve, or it cannot even start.
  function checkRehearsalImports() {
    const { modules, unknown } = rehearsalModules(join(repository, REHEARSAL));
    for (const entry of unknown) {
      warn(`cannot tell where ${rel(entry.importer)} loads ${entry.specifier} from (createRequire(${entry.expression})); not checked`);
    }
    const missing = modules.filter((entry) => !resolvesFrom(entry.from, entry.specifier));
    if (!missing.length) { ok(`the rehearsal's own imports resolve (${modules.length} npm packages)`); return; }
    for (const entry of missing) {
      const owner = rel(owningFolder(entry.from, repository));
      problem(`The rehearsal cannot start: ${entry.specifier} (loaded by ${rel(entry.importer)}) is not installed in ${owner}.`,
        [`Fix: npm --prefix ${owner} ci${orPrepare}`], 'npm');
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
    checkRehearsalImports();
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

  // For npm and jest steps: the first real error line, then the failing suites and totals.
  function failureLines(record) {
    const text = readFileSync(record.log, 'utf8');
    if (/EACCES/.test(text)) {
      const denied = text.split('\n').find((line) => /EACCES/.test(line)).trim().slice(0, 300);
      return [`First error: ${denied}`, 'Your account cannot write to this folder. Use a clone your own account owns.'];
    }
    const first = firstErrorLine(text);
    const lines = first ? [`First error: ${first.line}`] : [];
    const where = repoLocation(text, repository, first?.index);
    if (where) lines.push(`Where: ${where}`);
    const suites = [...new Set(text.split('\n').filter((line) => /^\s*(FAIL\s|Tests:|# fail\s)/.test(line))
      .map((line) => line.trim().slice(0, 200)))].slice(0, 4);
    return [...lines, ...suites];
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
    // Packages first (services link to them and import their dist/), then services and release/.
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
        lines.push('For the npm items you can also run: npm run check:db -- --prepare',
          '  (runs npm ci and package builds in this checkout\'s folders; npm downloads from your registry'
          + ' and uses your npm settings and cache)');
      }
    } else if (failed) {
      lines.push(`Result: FAILED at "${failed.label}" (${failed.reason})`, ...extra.map((line) => `  ${line}`));
      lines.push(`  Log of "${failed.label}": ${failed.log}`);
    } else if (outcome === 'check-only') {
      lines.push('Result: all prerequisites are in place (--check-only: nothing was installed or run).');
    } else {
      lines.push(`Result: PASSED (${seconds(steps.reduce((sum, record) => sum + record.ms, 0))} in total)`);
    }
    if (logDir) {
      lines.push(`Logs: ${logDir}`, `  (remove when done: rm -rf ${logDir})`);
      writeFileSync(join(logDir, 'summary.txt'), lines.join('\n') + '\n', { mode: 0o600 });
    }
    console.log(lines.join('\n'));
  }

  // ---------------------------------------------------------------- run
  console.log(`HID database check in ${repository}`);
  console.log('\nPrerequisites');
  let ready = checkPrerequisites();

  if (!ready && options.prepare) {
    if (problems.some((p) => p.kind === 'setup')) {
      console.log('\n--prepare only installs npm dependencies and builds packages; fix the items above that'
        + ' are about your account, PostgreSQL, git or Node.js first.');
    } else {
      console.log('\nPreparing (npm ci and package builds in this checkout; npm uses your registry, ~/.npmrc and npm cache)');
      if (prepare()) {
        console.log('\nPrerequisites (after preparing)');
        ready = checkPrerequisites();
      }
    }
  } else if (ready && options.prepare) {
    console.log('\nPreparing\n  nothing to install or build');
  }

  const prepareFailure = steps.find((record) => !record.passed);
  if (prepareFailure) { summary('prepare', failureLines(prepareFailure)); return 1; }
  if (!ready) { summary('prerequisites'); return 2; }
  if (options.checkOnly) { summary('check-only'); return 0; }

  console.log('\nRunning (each step writes a log; this takes a few minutes)');
  // The rehearsal insists on a new evidence folder, so never reuse one from an earlier --log-dir run.
  let rehearsalEvidence = join(ensureLogDir(), 'rehearsal-evidence');
  for (let n = 2; existsSync(rehearsalEvidence); n += 1) rehearsalEvidence = join(logDir, `rehearsal-evidence-${n}`);
  const rehearsal = step('migration rehearsal', 'migration-rehearsal', process.execPath,
    [REHEARSAL, '--evidence-dir', rehearsalEvidence],
    { env: { ...process.env, PG_CONFIG: pgConfig } });
  const detail = [];
  if (!rehearsal.passed) {
    const found = rehearsalFailure(readFileSync(rehearsal.log, 'utf8'),
      readJsonOrNull(join(rehearsalEvidence, 'commands.json')), repository);
    detail.push(`Failing rehearsal step: ${found.step}`);
    if (found.firstError) detail.push(`First error: ${found.firstError}`);
    if (found.where) detail.push(`Where: ${found.where}`);
    if (found.fromCommand) {
      // The rehearsal's one-line result keeps only the end of the output; save all of it.
      const stepLog = join(logDir, 'rehearsal-failed-step.log');
      writeFileSync(stepLog, found.output.endsWith('\n') ? found.output : `${found.output}\n`, { mode: 0o600 });
      detail.push(`Full output of that step: ${stepLog}`);
    }
    if (/^exact-role /.test(found.step)) {
      detail.push('This is a runtime verifier. If your change altered a table, grant or route it uses,'
        + ' update that verifier script in the same branch.');
    }
    if (found.evidence) detail.push(`Rehearsal evidence: ${found.evidence}`);
    if (options.all) detail.push('The jest and release tests were not run because the rehearsal failed.');
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
  return steps.every((record) => record.passed) ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
