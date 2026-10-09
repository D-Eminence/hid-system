import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The worker's database login inherits hid_ocr_worker, which has no table
 * privileges and may execute only the OCR worker commands granted in the role
 * bootstrap. A direct table read compiles and passes mocked unit tests but is
 * refused at run time with 42501. The worker swallows that for queue metrics
 * (ocr.queue.metrics_unavailable), which is how the queue-age alarm went
 * without data. This reads the migrations, the role bootstrap and the worker
 * source; runtime-roles.integration.sql checks the same grants on a database.
 */
const worker = join(__dirname, '..');
const database = join(worker, '..', 'ehr-api', 'database');
const ROLE = 'hid_ocr_worker';
const SCHEMAS = 'ocr|ehr|identity|auth|platform|audit|integration|lab|pharmacy|outreach|notification';

const topLevel = (sql: string) => sql.replace(/--[^\n]*/g, '').replace(/\$([a-z_]*)\$[\s\S]*?\$\1\$/gi, "''");
const functionNames = (list: string) => [...list.matchAll(/\b([a-z_]+)\.([a-z_][a-z0-9_]*)\s*\(/gi)]
  .map(([, schema, name]) => `${schema}.${name}`.toLowerCase());
const names = (list: string) => list.split(',').map((item) => item.trim().toLowerCase());

/** Functions hid_ocr_worker (or PUBLIC) may execute after every migration and then the role bootstrap. */
function executableFunctions() {
  const scripts = [
    ...readdirSync(join(database, 'migrations')).filter((name) => name.endsWith('.sql')).sort()
      .map((name) => join(database, 'migrations', name)),
    join(database, 'runtime-grants.sql'),
  ];
  const defined = new Set<string>();
  const worker = new Set<string>();
  const publicExecute = new Set<string>();
  for (const script of scripts) {
    const raw = readFileSync(script, 'utf8').replace(/--[^\n]*/g, '');
    for (const [, schema, name] of raw.matchAll(/create\s+(?:or\s+replace\s+)?function\s+([a-z_]+)\.([a-z_][a-z0-9_]*)\s*\(/gi)) {
      defined.add(`${schema}.${name}`.toLowerCase());
    }
    for (const statement of topLevel(raw).split(';')) {
      const reset = /^\s*revoke\s+all\s+privileges\s+on\s+all\s+functions\s+in\s+schema\s+([\s\S]+?)\s+from\s+([\s\S]+)$/i.exec(statement);
      if (reset) {
        const schemas = names(reset[1]!);
        const roles = names(reset[2]!);
        for (const target of [...(roles.includes(ROLE) ? [worker] : []), ...(roles.includes('public') ? [publicExecute] : [])]) {
          for (const name of [...target]) if (schemas.includes(name.split('.')[0]!)) target.delete(name);
        }
        continue;
      }
      const change = /^\s*(grant|revoke)\s+(?:execute|all)(?:\s+privileges)?\s+on\s+function\s+([\s\S]+?)\s+(?:to|from)\s+([\s\S]+)$/i
        .exec(statement);
      if (!change) continue;
      const granting = change[1]!.toLowerCase() === 'grant';
      const roles = names(change[3]!);
      for (const name of functionNames(change[2]!)) {
        if (roles.includes(ROLE)) { if (granting) worker.add(name); else worker.delete(name); }
        if (roles.includes('public')) { if (granting) publicExecute.add(name); else publicExecute.delete(name); }
      }
    }
  }
  return { defined, executable: new Set([...worker, ...publicExecute]) };
}

function workerSource() {
  return readdirSync(join(worker, 'src'))
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.spec.ts'))
    .map((name) => ({ name, text: readFileSync(join(worker, 'src', name), 'utf8') }));
}

describe('OCR worker database privileges', () => {
  const { defined, executable } = executableFunctions();
  const source = workerSource();

  it('reads tables only through granted commands, never directly', () => {
    const direct = source.flatMap(({ name, text }) => [...text.matchAll(
      new RegExp(`\\b(?:from|join|into|update)\\s+((?:${SCHEMAS})\\.[a-z_][a-z0-9_]*)(?![a-z0-9_])(?!\\s*\\()`, 'gi'))]
      .map(([, relation]) => `${relation} (${name})`));
    expect(direct).toEqual([]);
  });

  it('calls only database functions that hid_ocr_worker can execute', () => {
    const called = new Set(source.flatMap(({ text }) => [...text.matchAll(
      new RegExp(`\\b(${SCHEMAS})\\.([a-z_][a-z0-9_]*)\\s*\\(`, 'g'))]
      .map(([, schema, name]) => `${schema}.${name}`)));
    expect([...called].sort()).toEqual(['ocr.claim_worker_job', 'ocr.complete_worker_job',
      'ocr.fail_worker_job', 'ocr.renew_worker_claim', 'ocr.worker_queue_metrics']);
    expect([...called].filter((name) => !defined.has(name))).toEqual([]);
    expect([...called].filter((name) => !executable.has(name))).toEqual([]);
  });
});
