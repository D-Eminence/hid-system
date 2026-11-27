import type { StaffAccountContext } from '../src/common/request-context';
import { STAFF_PREFERENCES_STARTUP_SQL } from '../src/staff-preferences/staff-preferences';
import {
  READ_STAFF_PREFERENCES_SQL, SAVE_STAFF_PREFERENCES_SQL, SAVE_STAFF_SHORTCUTS_SQL,
} from '../src/staff-preferences/staff-preferences.service';

/**
 * An in-memory stand-in for 0206's three functions (the database suite
 * services/ehr-api/test/database/staff-preferences.integration.sql holds the
 * real ones), for identity-api's specs. It answers the three statements
 * StaffPreferencesService runs, with 0206's rules: the caller is the
 * context's account; the membership is the context's when it is one of the
 * actor's at that facility; replay, key reuse and version conflict as 0206;
 * the same 22023, 23505, 40001 and 42501 refusals (pg-style errors with
 * code and message). Each transaction works on a copy that is kept only when
 * the operation succeeds.
 */
export interface FakePreferenceRow { language: string; version: number; key: string; sha: string }
export interface FakeShortcutRow { facilityId: string; modules: string[]; version: number; key: string; sha: string }

export interface FakeStaffPreferencesState {
  preferences: Map<string, FakePreferenceRow>;
  shortcuts: Map<string, FakeShortcutRow>;
  audit: { action: string; accountId: string; membershipId?: string; facilityId?: string; details: Record<string, unknown> }[];
}

export function databaseError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

const KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/;
const SHA = /^[0-9a-f]{64}$/;
const MODULE = /^[a-z][A-Za-z]{1,39}$/;

function clone(state: FakeStaffPreferencesState): FakeStaffPreferencesState {
  return {
    preferences: new Map([...state.preferences].map(([key, row]) => [key, { ...row }])),
    shortcuts: new Map([...state.shortcuts].map(([key, row]) => [key, { ...row, modules: [...row.modules] }])),
    audit: [...state.audit],
  };
}

export function fakeStaffPreferencesDatabase(options: { inactiveAccounts?: Set<string>; failWith?: () => unknown } = {}) {
  let state: FakeStaffPreferencesState = { preferences: new Map(), shortcuts: new Map(), audit: [] };
  const statements: string[] = [];
  const contexts: StaffAccountContext[] = [];

  function membership(context: StaffAccountContext): string | undefined {
    if (!context.membershipId || !context.facilityId) return undefined;
    const found = context.actor.facilities.find((facility) => facility.membershipId === context.membershipId
      && facility.id === context.facilityId);
    return found ? found.membershipId : undefined;
  }

  function query(work: FakeStaffPreferencesState, context: StaffAccountContext, sql: string, values: unknown[] = []) {
    statements.push(sql);
    const failure = options.failWith?.();
    if (failure) throw failure;
    const account = context.actor.accountId;
    if (options.inactiveAccounts?.has(account)) throw databaseError('42501', 'STAFF_PREFERENCES_NOT_ALLOWED');
    if (sql === READ_STAFF_PREFERENCES_SQL) {
      const preference = work.preferences.get(account);
      let shortcuts: FakeShortcutRow | undefined;
      let named = false;
      if (context.membershipId || context.facilityId) {
        if (!membership(context)) throw databaseError('42501', 'STAFF_SHORTCUTS_NOT_ALLOWED');
        named = true;
        shortcuts = work.shortcuts.get(context.membershipId!);
      }
      return { rows: [{
        preferences_language: preference?.language ?? 'en',
        preferences_version: String(preference?.version ?? 0),
        shortcuts_facility_id: named ? context.facilityId! : null,
        shortcuts_modules: named ? [...(shortcuts?.modules ?? [])] : null,
        shortcuts_version: named ? String(shortcuts?.version ?? 0) : null,
      }] };
    }
    if (sql === SAVE_STAFF_PREFERENCES_SQL) {
      const [language, expected, key, sha] = values as [string, number, string, string];
      if (!KEY.test(key ?? '') || !SHA.test(sha ?? '')) throw databaseError('22023', 'IDEMPOTENCY_KEY_REQUIRED');
      if (!/^[a-z]{2}$/.test(language ?? '')) throw databaseError('22023', 'LANGUAGE_NOT_AVAILABLE');
      const row = work.preferences.get(account);
      let replayed = false;
      if (row && row.key === key) {
        if (row.sha !== sha) throw databaseError('23505', 'IDEMPOTENCY_KEY_REUSED');
        replayed = true;
      } else if ((row?.version ?? 0) !== Number(expected)) {
        throw databaseError('40001', 'VERSION_CONFLICT');
      } else {
        work.preferences.set(account, { language, version: (row?.version ?? 0) + 1, key, sha });
      }
      const saved = work.preferences.get(account)!;
      work.audit.push({ action: 'auth.staff-preferences.update', accountId: account,
        details: { language: saved.language, version: saved.version, ...(replayed ? { replayed } : {}) } });
      return { rows: [{ replayed }] };
    }
    if (sql === SAVE_STAFF_SHORTCUTS_SQL) {
      const [modules, expected, key, sha] = values as [string[], number, string, string];
      const member = membership(context);
      if (!member) throw databaseError('42501', 'STAFF_SHORTCUTS_NOT_ALLOWED');
      if (!KEY.test(key ?? '') || !SHA.test(sha ?? '')) throw databaseError('22023', 'IDEMPOTENCY_KEY_REQUIRED');
      if (modules.length > 12) throw databaseError('22023', 'SHORTCUTS_TOO_MANY');
      if (!modules.every((module) => MODULE.test(module))) throw databaseError('22023', 'SHORTCUT_INVALID');
      if (new Set(modules).size !== modules.length) throw databaseError('22023', 'SHORTCUT_DUPLICATE');
      const row = work.shortcuts.get(member);
      let replayed = false;
      if (row && row.key === key) {
        if (row.sha !== sha) throw databaseError('23505', 'IDEMPOTENCY_KEY_REUSED');
        replayed = true;
      } else if ((row?.version ?? 0) !== Number(expected)) {
        throw databaseError('40001', 'VERSION_CONFLICT');
      } else {
        work.shortcuts.set(member, { facilityId: context.facilityId!, modules: [...modules],
          version: (row?.version ?? 0) + 1, key, sha });
      }
      const saved = work.shortcuts.get(member)!;
      work.audit.push({ action: 'identity.staff-shortcuts.update', accountId: account, membershipId: member,
        facilityId: context.facilityId, details: { modules: [...saved.modules], version: saved.version,
          ...(replayed ? { replayed } : {}) } });
      return { rows: [{ replayed }] };
    }
    throw new Error(`unexpected statement: ${sql}`);
  }

  const database = {
    // The pool's own reads: StaffPreferencesStartupCheck's (0206's three
    // functions all executable), and the guard's feature-flag read.
    query: jest.fn(async (sql: string, values: unknown[] = []) => (sql === STAFF_PREFERENCES_STARTUP_SQL
      ? { rows: [{ function_0: true, function_1: true, function_2: true }] }
      : { rows: [{ enabled: values[0] !== 'maintenance_mode' }] })),
    withStaffAccountTransaction: jest.fn(async <Result>(context: StaffAccountContext,
      operation: (client: { query: (sql: string, values?: unknown[]) => Promise<unknown> }) => Promise<Result>) => {
      contexts.push(context);
      const work = clone(state);
      const result = await operation({ query: async (sql: string, values?: unknown[]) => query(work, context, sql, values) });
      state = work;
      return result;
    }),
  };
  return { database, state: () => state, statements, contexts };
}
