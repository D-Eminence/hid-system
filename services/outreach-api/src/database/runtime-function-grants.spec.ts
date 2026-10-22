import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * The Outreach API connects as hid_outreach_api_runtime (through
 * hid_outreach_runtime). Every function that runs with the caller's rights on
 * that path must be executable by those roles: functions the API source calls,
 * functions named in RLS policies on Outreach tables (policies are evaluated as
 * the querying role), and the callees of invoker-rights trigger functions and
 * of any invoker-rights function reached that way. platform.current_account_id()
 * is such an invoker SQL function and calls auth.account_id_for_subject(text),
 * which is revoked from PUBLIC; without the explicit grant every Outreach
 * command failed with 42501. Unit tests mock the database and CI runs no SQL,
 * so this reads the migrations, the role bootstrap and the API source instead.
 * `runtime-roles.integration.sql` checks the same grant against a database.
 */
const service = join(__dirname, '..', '..');
const database = join(service, '..', 'ehr-api', 'database');
const OUTREACH_ROLES = ['hid_outreach_runtime', 'hid_outreach_api_runtime'];
const SCHEMAS = 'identity|auth|platform|audit|ehr|integration|ocr|lab|pharmacy|outreach|notification';

const withoutComments = (sql: string) => sql.replace(/--[^\n]*/g, '');
/** SQL without comments or dollar-quoted bodies, so only top-level statements remain. */
const topLevel = (sql: string) => withoutComments(sql).replace(/\$([a-z_]*)\$[\s\S]*?\$\1\$/gi, "''");
const functionNames = (list: string) => [...list.matchAll(/\b([a-z_]+)\.([a-z_][a-z0-9_]*)\s*\(/gi)]
  .map(([, schema, name]) => `${schema}.${name}`.toLowerCase());
const roleNames = (list: string) => list.split(',').map((role) => role.trim().toLowerCase());

interface Definition { definer: boolean; body: string }

function databaseScripts() {
  return [
    ...readdirSync(join(database, 'migrations')).filter((name) => name.endsWith('.sql')).sort()
      .map((name) => join(database, 'migrations', name)),
    join(database, 'runtime-grants.sql'),
  ];
}

/**
 * Replays the migrations and then the role bootstrap: the latest definition of
 * every function, the functions the Outreach roles or PUBLIC may execute, the
 * functions Outreach RLS policies name, and the Outreach trigger functions.
 */
function databaseState() {
  const definitions = new Map<string, Definition>();
  const outreach = new Set<string>();
  const publicExecute = new Set<string>();
  const policyFunctions = new Map<string, Set<string>>();
  const triggerFunctions = new Map<string, Set<string>>();
  for (const script of databaseScripts()) {
    const raw = withoutComments(readFileSync(script, 'utf8'));
    for (const match of raw.matchAll(/create\s+(?:or\s+replace\s+)?function\s+([a-z_]+)\.([a-z_][a-z0-9_]*)\s*\(/gi)) {
      const rest = raw.slice(match.index);
      const open = /\$([a-z_]*)\$/i.exec(rest);
      if (!open) continue;
      const close = rest.indexOf(open[0], open.index + open[0].length);
      if (close < 0) continue;
      const end = rest.indexOf(';', close);
      const options = rest.slice(0, open.index) + rest.slice(close + open[0].length, end < 0 ? undefined : end);
      definitions.set(`${match[1]}.${match[2]}`.toLowerCase(), {
        definer: /\bsecurity\s+definer\b/i.test(options),
        body: rest.slice(open.index + open[0].length, close),
      });
    }
    for (const statement of topLevel(raw).split(';')) {
      const policy = /^\s*create\s+policy\s+(\S+)\s+on\s+(outreach\.[a-z_][a-z0-9_]*)([\s\S]*)$/i.exec(statement);
      if (policy) {
        for (const name of functionNames(policy[3]!)) {
          policyFunctions.set(name, (policyFunctions.get(name) ?? new Set()).add(`policy ${policy[1]} on ${policy[2]}`));
        }
        continue;
      }
      const trigger = /^\s*create\s+(?:constraint\s+)?trigger\s+(\S+)[\s\S]*?\bon\s+(outreach\.[a-z_][a-z0-9_]*)[\s\S]*?\bexecute\s+(?:function|procedure)\s+([a-z_]+\.[a-z_][a-z0-9_]*)\s*\(/i
        .exec(statement);
      if (trigger) {
        const name = trigger[3]!.toLowerCase();
        triggerFunctions.set(name, (triggerFunctions.get(name) ?? new Set()).add(`trigger ${trigger[1]} on ${trigger[2]}`));
        continue;
      }
      const reset = /^\s*revoke\s+(?:all(?:\s+privileges)?|execute)\s+on\s+all\s+functions\s+in\s+schema\s+([\s\S]+?)\s+from\s+([\s\S]+)$/i
        .exec(statement);
      if (reset) {
        const schemas = roleNames(reset[1]!);
        const roles = roleNames(reset[2]!);
        for (const target of [...(roles.some((role) => OUTREACH_ROLES.includes(role)) ? [outreach] : []),
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
        if (roles.some((role) => OUTREACH_ROLES.includes(role))) {
          if (granting) outreach.add(name); else outreach.delete(name);
        }
        if (roles.includes('public')) {
          if (granting) publicExecute.add(name); else publicExecute.delete(name);
        }
      }
    }
  }
  return { definitions, executable: new Set([...outreach, ...publicExecute]), policyFunctions, triggerFunctions };
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return name.endsWith('.ts') && !name.endsWith('.spec.ts') ? [path] : [];
  });
}

/**
 * Functions the Outreach runtime executes with its own rights, each with one
 * path that reaches it: API calls, policy expressions, callees of
 * invoker-rights trigger functions, and callees of invoker-rights functions
 * already reached. A SECURITY DEFINER function needs EXECUTE itself but its
 * callees run as its owner.
 */
function invokerReach(state: ReturnType<typeof databaseState>) {
  const { definitions, policyFunctions, triggerFunctions } = state;
  const reached = new Map<string, string>();
  const pending: string[] = [];
  const reach = (name: string, via: string) => {
    if (!definitions.has(name) || reached.has(name)) return;
    reached.set(name, via);
    pending.push(name);
  };
  const callees = (name: string) => functionNames(definitions.get(name)?.body ?? '');
  for (const file of sourceFiles(join(service, 'src'))) {
    const text = readFileSync(file, 'utf8');
    for (const [, schema, name] of text.matchAll(new RegExp(`\\b(${SCHEMAS})\\.([a-z_][a-z0-9_]*)\\s*\\(`, 'g'))) {
      reach(`${schema}.${name}`, relative(service, file));
    }
  }
  for (const [name, uses] of policyFunctions) reach(name, [...uses][0]!);
  for (const [name, uses] of triggerFunctions) {
    if (definitions.get(name)?.definer !== false) continue;
    for (const callee of callees(name)) reach(callee, `${name} (${[...uses][0]})`);
  }
  while (pending.length > 0) {
    const name = pending.shift()!;
    if (definitions.get(name)!.definer) continue;
    for (const callee of callees(name)) reach(callee, `${name} <- ${reached.get(name)}`);
  }
  return reached;
}

/**
 * SQL forms the replay above does not follow. None occurs today; if one is
 * added, extend the replay instead of trusting a pass.
 */
function unfollowedForms() {
  const found: string[] = [];
  for (const script of databaseScripts()) {
    const raw = withoutComments(readFileSync(script, 'utf8'));
    const name = relative(database, script);
    if (/\balter\s+policy\s+\S+\s+on\s+"?outreach"?\./i.test(raw)) found.push(`${name}: ALTER POLICY on Outreach`);
    if (/\balter\s+function\b[^;]*\bsecurity\s+(?:invoker|definer)\b/i.test(raw)) found.push(`${name}: ALTER FUNCTION ... SECURITY`);
    for (const [body] of raw.matchAll(/\$([a-z_]*)\$[\s\S]*?\$\1\$/gi)) {
      if (/\bcreate\s+policy\s+\S+\s+on\s+"?outreach"?\./i.test(body)) found.push(`${name}: Outreach policy in a dollar-quoted body`);
    }
  }
  return found;
}

describe('Outreach runtime function grants', () => {
  const state = databaseState();
  const reached = invokerReach(state);

  it('meets no SQL form it cannot follow', () => {
    expect(unfollowedForms()).toEqual([]);
  });

  it('reads the Outreach policies, invoker triggers and API calls', () => {
    expect(state.definitions.get('platform.current_account_id')?.definer).toBe(false);
    expect(state.definitions.get('outreach.validate_registration_case_event')?.definer).toBe(false);
    expect(state.definitions.get('outreach.validate_registration_case_write')?.definer).toBe(true);
    for (const name of ['outreach.context_allows', 'platform.current_account_id', 'platform.current_membership_id',
      'auth.account_id_for_subject', 'outreach.registration_campaign_member']) {
      expect(reached.has(name)).toBe(true);
    }
  });

  it('can execute every function the Outreach runtime reaches with its own rights', () => {
    const missing = [...reached].filter(([name]) => !state.executable.has(name))
      .map(([name, via]) => `${name} (via ${via})`);
    expect(missing).toEqual([]);
  });
});
