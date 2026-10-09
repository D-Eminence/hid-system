import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Every SQL function the Identity API calls must be executable by its runtime
 * role (hid_identity_api_runtime, through hid_identity_runtime) once the role
 * bootstrap has run. A function revoked from PUBLIC and never granted fails only
 * under that least-privilege role, with 42501, which the API reports like a
 * genuine authorization refusal (for example CONSENT_COMMAND_DENIED). Unit tests
 * mock the database and CI runs no SQL, so this reads the migrations, the role
 * bootstrap and the API source instead. `runtime-roles.integration.sql` checks
 * the same grants against a real database.
 */
const service = join(__dirname, '..', '..');
const database = join(service, '..', 'ehr-api', 'database');
const IDENTITY_ROLES = ['hid_identity_runtime', 'hid_identity_api_runtime'];
const SCHEMAS = 'identity|auth|platform|audit|ehr|integration|ocr|lab|pharmacy|outreach|notification';

/** SQL without comments or dollar-quoted bodies, so only top-level statements remain. */
const topLevel = (sql: string) => sql.replace(/--[^\n]*/g, '').replace(/\$([a-z_]*)\$[\s\S]*?\$\1\$/gi, "''");
const functionNames = (list: string) => [...list.matchAll(/\b([a-z_]+)\.([a-z_][a-z0-9_]*)\s*\(/gi)]
  .map(([, schema, name]) => `${schema}.${name}`.toLowerCase());
const roleNames = (list: string) => list.split(',').map((role) => role.trim().toLowerCase());

/** Function execute privileges after every migration and then the role bootstrap, in order. */
function executableFunctions() {
  const scripts = [
    ...readdirSync(join(database, 'migrations')).filter((name) => name.endsWith('.sql')).sort()
      .map((name) => join(database, 'migrations', name)),
    join(database, 'runtime-grants.sql'),
  ];
  const defined = new Set<string>();
  const identity = new Set<string>();
  const publicExecute = new Set<string>();
  for (const script of scripts) {
    const raw = readFileSync(script, 'utf8').replace(/--[^\n]*/g, '');
    for (const [, schema, name] of raw.matchAll(/create\s+(?:or\s+replace\s+)?function\s+([a-z_]+)\.([a-z_][a-z0-9_]*)\s*\(/gi)) {
      defined.add(`${schema}.${name}`.toLowerCase());
    }
    for (const statement of topLevel(raw).split(';')) {
      const reset = /^\s*revoke\s+all\s+privileges\s+on\s+all\s+functions\s+in\s+schema\s+([\s\S]+?)\s+from\s+([\s\S]+)$/i.exec(statement);
      if (reset) {
        const schemas = roleNames(reset[1]!);
        const roles = roleNames(reset[2]!);
        for (const target of [...(roles.some((role) => IDENTITY_ROLES.includes(role)) ? [identity] : []),
          ...(roles.includes('public') ? [publicExecute] : [])]) {
          for (const name of [...target]) if (schemas.includes(name.split('.')[0]!)) target.delete(name);
        }
        continue;
      }
      const change = /^\s*(grant|revoke)\s+(?:execute|all)(?:\s+privileges)?\s+on\s+function\s+([\s\S]+?)\s+(?:to|from)\s+([\s\S]+)$/i
        .exec(statement);
      if (!change) continue;
      const granting = change[1]!.toLowerCase() === 'grant';
      const roles = roleNames(change[3]!);
      for (const name of functionNames(change[2]!)) {
        if (roles.some((role) => IDENTITY_ROLES.includes(role))) {
          if (granting) identity.add(name); else identity.delete(name);
        }
        if (roles.includes('public')) {
          if (granting) publicExecute.add(name); else publicExecute.delete(name);
        }
      }
    }
  }
  return { defined, executable: new Set([...identity, ...publicExecute]) };
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return name === 'testing' ? [] : sourceFiles(path);
    return name.endsWith('.ts') && !name.endsWith('.spec.ts') ? [path] : [];
  });
}

/** Database functions named in the API source (any `schema.function(` of a migration-defined function). */
function calledFunctions(defined: Set<string>) {
  const called = new Map<string, Set<string>>();
  for (const file of sourceFiles(join(service, 'src'))) {
    const text = readFileSync(file, 'utf8');
    for (const [, schema, name] of text.matchAll(new RegExp(`\\b(${SCHEMAS})\\.([a-z_][a-z0-9_]*)\\s*\\(`, 'g'))) {
      const qualified = `${schema}.${name}`;
      if (!defined.has(qualified)) continue;
      called.set(qualified, (called.get(qualified) ?? new Set()).add(relative(service, file)));
    }
  }
  return called;
}

describe('Identity runtime function grants', () => {
  const { defined, executable } = executableFunctions();
  const called = calledFunctions(defined);

  it('reads the database functions the Identity API calls', () => {
    expect(called.size).toBeGreaterThan(30);
    for (const name of ['identity.list_my_staff_access_requests', 'auth.admin_revoke_session_family',
      'platform.control_enabled', 'audit.list_platform_events']) {
      expect(called.has(name)).toBe(true);
    }
  });

  it('can execute every one of them as the Identity runtime role', () => {
    const missing = [...called].filter(([name]) => !executable.has(name))
      .map(([name, files]) => `${name} (${[...files].join(', ')})`);
    expect(missing).toEqual([]);
  });
});
