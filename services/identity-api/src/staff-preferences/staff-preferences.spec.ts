jest.mock('jose', () => ({ createRemoteJWKSet: jest.fn(), jwtVerify: jest.fn(), SignJWT: jest.fn() }));
import 'reflect-metadata';
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { databaseError, fakeStaffPreferencesDatabase } from '../../test/staff-preferences.fixtures';
import { FACILITY_MODULE_RULES, facilityModules } from '../auth/facility-modules';
import {
  ACCOUNT_ONLY_ALLOWED, AUDIT_ACTION, AUDIT_FAILURES_ONLY, FACILITY_OPTIONAL, NO_AUDIT, PATIENT_ALLOWED, PUBLIC_ROUTE,
  REQUIRED_PERMISSIONS,
} from '../common/decorators';
import { requestDigest } from '../common/idempotency';
import { DomainProblem } from '../common/problem';
import type { ActorContext, FacilityAssignment, StaffAccountContext } from '../common/request-context';
import type { DatabaseService } from '../database/database.service';
import {
  SHORTCUT_KEY_SHAPE, SHORTCUT_MODULE_KEYS, shortcutAvailable, STAFF_NOTICE_DEFAULTS, STAFF_PREFERENCES_FUNCTIONS,
  STAFF_PREFERENCES_STARTUP_SQL,
} from './staff-preferences';
import {
  STAFF_PREFERENCES_READ_ACTION, STAFF_PREFERENCES_UPDATE_ACTION, STAFF_SHORTCUTS_UPDATE_ACTION,
  StaffPreferencesController,
} from './staff-preferences.controller';
import {
  READ_STAFF_PREFERENCES_SQL, SAVE_STAFF_PREFERENCES_SQL, SAVE_STAFF_SHORTCUTS_SQL, shortcutRefusal,
  STAFF_PREFERENCES_OPERATION, STAFF_SHORTCUTS_OPERATION, staffPreferencesProblem, StaffPreferencesService,
} from './staff-preferences.service';

const ACCOUNT = '20000000-0000-4000-8000-000000000071';
const FACILITY = '30000000-0000-4000-8000-000000000071';
const SECOND_FACILITY = '30000000-0000-4000-8000-000000000072';
const MEMBERSHIP = '40000000-0000-4000-8000-000000000071';
const SECOND_MEMBERSHIP = '40000000-0000-4000-8000-000000000072';
const KEY = 'sx7-unit-key-000000001';

// A doctor-like set: shows patients, triage, consultation, orders, prescriptions; not lab, pharmacy, admin.
const DOCTOR = ['identity.patient.read', 'ehr.vital.read', 'ehr.vital.write', 'ehr.diagnosis.read', 'ehr.diagnosis.write',
  'ehr.note.write', 'ehr.lab-request.write', 'ehr.prescription.write', 'ehr.prescription.read'];
const facility = (id: string, membershipId: string, permissions: string[]): FacilityAssignment => ({
  id, membershipId, organizationId: '10000000-0000-4000-8000-000000000071', name: `Fictional Ward ${id.slice(-1)}`,
  roles: ['doctor'], permissions, isPrimary: id === FACILITY,
});
const doctorAt = facility(FACILITY, MEMBERSHIP, DOCTOR);
const nurseAt = facility(SECOND_FACILITY, SECOND_MEMBERSHIP, ['identity.patient.read', 'ehr.vital.read']);
const actor: ActorContext = {
  kind: 'staff', id: ACCOUNT, subject: 'staff:fictional-sx7', accountId: ACCOUNT, sessionId: '50000000-0000-4000-8000-000000000071',
  roles: ['doctor'], permissions: DOCTOR, facilityIds: [FACILITY, SECOND_FACILITY], facilities: [doctorAt, nurseAt],
  authenticationMethod: 'local',
};
const at = (assignment?: FacilityAssignment): StaffAccountContext => ({
  correlationId: 'sx7-unit-correlation',
  actor: assignment ? { ...actor, facility: assignment, permissions: assignment.permissions } : actor,
  ...(assignment ? { facilityId: assignment.id, membershipId: assignment.membershipId } : {}),
});

function route(name: string) {
  const handler = (StaffPreferencesController.prototype as unknown as Record<string, object>)[name]!;
  const meta = (key: symbol) => Reflect.getMetadata(key, handler) ?? Reflect.getMetadata(key, StaffPreferencesController);
  return { base: Reflect.getMetadata(PATH_METADATA, StaffPreferencesController), path: Reflect.getMetadata(PATH_METADATA, handler),
    method: Reflect.getMetadata(METHOD_METADATA, handler), audit: meta(AUDIT_ACTION), failuresOnly: meta(AUDIT_FAILURES_ONLY),
    facilityOptional: meta(FACILITY_OPTIONAL), noAudit: meta(NO_AUDIT), patientAllowed: meta(PATIENT_ALLOWED),
    accountOnly: meta(ACCOUNT_ONLY_ALLOWED), isPublic: meta(PUBLIC_ROUTE), permissions: meta(REQUIRED_PERMISSIONS) };
}

describe('SX-7 (0206): the routes', () => {
  it('reads and saves preferences with X-Facility-ID optional, auditing on their own; shortcuts need the facility', () => {
    const none = { patientAllowed: undefined, accountOnly: undefined, isPublic: undefined, permissions: undefined };
    expect(route('read')).toEqual({ base: 'identity', path: 'me/preferences', method: RequestMethod.GET, audit: undefined,
      failuresOnly: undefined, facilityOptional: true, noAudit: true, ...none });
    expect(route('savePreferences')).toEqual({ base: 'identity', path: 'me/preferences', method: RequestMethod.POST,
      audit: undefined, failuresOnly: undefined, facilityOptional: true, noAudit: true, ...none });
    expect(route('saveShortcuts')).toEqual({ base: 'identity', path: 'me/shortcuts', method: RequestMethod.POST,
      audit: 'identity.staff-shortcuts.update', failuresOnly: true, facilityOptional: undefined, noAudit: undefined, ...none });
  });

  it('names its audit actions so the audit CHECKs admit them: auth.* on session with no facility, identity.* with one', () => {
    expect([STAFF_PREFERENCES_READ_ACTION, STAFF_PREFERENCES_UPDATE_ACTION, STAFF_SHORTCUTS_UPDATE_ACTION])
      .toEqual(['auth.staff-preferences.read', 'auth.staff-preferences.update', 'identity.staff-shortcuts.update']);
    expect(STAFF_PREFERENCES_OPERATION).toBe(STAFF_PREFERENCES_UPDATE_ACTION);
    expect(STAFF_SHORTCUTS_OPERATION).toBe(STAFF_SHORTCUTS_UPDATE_ACTION);
  });
});

describe('SX-7 (0206): the shortcut keys', () => {
  it('accepts exactly SX-1\'s module keys, in their order, so a key a department adds is accepted with no change here', () => {
    expect(SHORTCUT_MODULE_KEYS).toEqual(FACILITY_MODULE_RULES.map((rule) => rule.key));
    expect(Object.keys(facilityModules([]))).toEqual([...SHORTCUT_MODULE_KEYS]);
  });

  it('every SX-1 key fits 0206\'s stored shape (the CHECK and the save refuse any other)', () => {
    const migration = readFileSync(join(__dirname, '../../../ehr-api/database/migrations/0206_staff_preferences_and_shortcuts.sql'), 'utf8');
    expect(migration).toContain(`key_value ~ '${SHORTCUT_KEY_SHAPE.source}'`);
    for (const key of SHORTCUT_MODULE_KEYS) expect(key).toMatch(SHORTCUT_KEY_SHAPE);
  });

  it.each([
    ['a UUID', '30000000-0000-4000-8000-000000000071'],
    ['a Health ID', 'HID-QPA2B3C4'],
    ['a matchRef', `psr_${'A'.repeat(43)}`],
    ['a NIN', '12345678901'],
    ['the contract\'s example find-patient', 'find-patient'],
    ['the contract\'s example lab-queue', 'lab-queue'],
    ['a key with a capital first', 'Patients'],
    ['an empty string', ''],
  ])('refuses %s as SHORTCUT_UNKNOWN', (_label, module) => {
    expect(shortcutRefusal([module], new Set(), DOCTOR)).toMatchObject({ code: 'SHORTCUT_UNKNOWN' });
    expect(shortcutRefusal([module], new Set([module]), DOCTOR)).toMatchObject({ code: 'SHORTCUT_UNKNOWN' });
  });

  it('refuses more than 12, repeats, and a key the roles here do not show unless it is already saved', () => {
    const thirteen = SHORTCUT_MODULE_KEYS.slice(0, 13);
    expect(thirteen).toHaveLength(13);
    expect(shortcutRefusal(thirteen, new Set(thirteen), DOCTOR)).toMatchObject({ code: 'SHORTCUTS_TOO_MANY' });
    expect(shortcutRefusal(['patients', 'triage', 'patients'], new Set(), DOCTOR)).toMatchObject({ code: 'SHORTCUT_DUPLICATE' });
    expect(shortcutRefusal(['patients', 'lab'], new Set(), DOCTOR)).toMatchObject({ code: 'SHORTCUT_NOT_ALLOWED' });
    expect(shortcutRefusal(['patients', 'lab'], new Set(['lab']), DOCTOR)).toBeUndefined();
    expect(shortcutRefusal([], new Set(), [])).toBeUndefined();
    expect(shortcutRefusal(SHORTCUT_MODULE_KEYS.slice(0, 12), new Set(SHORTCUT_MODULE_KEYS), [])).toBeUndefined();
  });

  it('keeps a saved key this image does not know (of 0206\'s shape); refuses it when it is not saved', () => {
    expect(shortcutRefusal(['retiredDepartment', 'patients'], new Set(['retiredDepartment']), DOCTOR)).toBeUndefined();
    expect(shortcutRefusal(['retiredDepartment'], new Set(['retiredDepartment']), [])).toBeUndefined();
    expect(shortcutRefusal(['retiredDepartment', 'patients'], new Set(['patients']), DOCTOR))
      .toMatchObject({ code: 'SHORTCUT_UNKNOWN' });
    expect(shortcutRefusal(['retiredDepartment'], new Set(), DOCTOR)).toMatchObject({ code: 'SHORTCUT_UNKNOWN' });
    expect(shortcutRefusal(['retiredDepartment', 'retiredDepartment'], new Set(['retiredDepartment']), DOCTOR))
      .toMatchObject({ code: 'SHORTCUT_DUPLICATE' });
  });

  it('answers available from the current permissions, and a key no longer known as unavailable', () => {
    expect(shortcutAvailable('patients', DOCTOR)).toBe(true);
    expect(shortcutAvailable('lab', DOCTOR)).toBe(false);
    expect(shortcutAvailable('retiredDepartment', DOCTOR)).toBe(false);
  });
});

describe('SX-7 (0206): StaffPreferencesService', () => {
  function setup(options: Parameters<typeof fakeStaffPreferencesDatabase>[0] = {}) {
    const fake = fakeStaffPreferencesDatabase(options);
    return { ...fake, service: new StaffPreferencesService(fake.database as unknown as DatabaseService) };
  }

  it('reads the defaults through 0206\'s read, read only, with shortcuts null and no facility', async () => {
    const s = setup();
    await expect(s.service.read(at())).resolves.toEqual({ version: 0, language: 'en', languagesAvailable: ['en'],
      notices: { served: false, labResultReady: true, prescriptionDispensed: true, criticalResult: true,
        criticalResultCanChange: false }, shortcuts: null });
    expect(s.statements).toEqual([READ_STAFF_PREFERENCES_SQL]);
    expect(s.database.withStaffAccountTransaction).toHaveBeenCalledWith(at(), expect.any(Function), { readOnly: true });
    expect(STAFF_NOTICE_DEFAULTS.served).toBe(false);
  });

  it('reads a facility\'s empty shortcuts with max 12', async () => {
    const s = setup();
    await expect(s.service.read(at(doctorAt))).resolves.toMatchObject({
      shortcuts: { facilityId: FACILITY, version: 0, max: 12, items: [] } });
  });

  it('saves the language (en only) under the request digest and answers the read shape with replayed', async () => {
    const s = setup();
    await expect(s.service.savePreferences(at(), { language: 'fr', expectedVersion: 0 }, KEY))
      .rejects.toMatchObject({ code: 'LANGUAGE_NOT_AVAILABLE', status: 400 });
    expect(s.statements).toEqual([]);
    const saved = await s.service.savePreferences(at(doctorAt), { language: 'en', expectedVersion: 0 }, KEY);
    expect(saved).toEqual({ version: 1, language: 'en', languagesAvailable: ['en'], notices: { ...STAFF_NOTICE_DEFAULTS },
      shortcuts: { facilityId: FACILITY, version: 0, max: 12, items: [] }, replayed: false });
    expect(s.statements).toEqual([SAVE_STAFF_PREFERENCES_SQL, READ_STAFF_PREFERENCES_SQL]);
    expect(s.state().preferences.get(ACCOUNT)!.sha)
      .toBe(requestDigest('auth.staff-preferences.update', { language: 'en', expectedVersion: 0 }));
    await expect(s.service.savePreferences(at(), { language: 'en', expectedVersion: 0 }, KEY))
      .resolves.toMatchObject({ version: 1, replayed: true });
    await expect(s.service.savePreferences(at(), { language: 'en', expectedVersion: 1 }, KEY))
      .rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED', status: 409 });
    await expect(s.service.savePreferences(at(), { language: 'en', expectedVersion: 0 }, 'sx7-unit-key-000000002'))
      .rejects.toMatchObject({ code: 'VERSION_CONFLICT', status: 412 });
  });

  it('saves shortcuts in order, scoped by facility, and keeps a saved key the roles no longer show', async () => {
    const s = setup();
    const saved = await s.service.saveShortcuts(at(doctorAt),
      { items: [{ module: 'triage' }, { module: 'patients' }], expectedVersion: 0 }, KEY);
    expect(saved.shortcuts).toEqual({ facilityId: FACILITY, version: 1, max: 12,
      items: [{ module: 'triage', available: true }, { module: 'patients', available: true }] });
    expect(s.statements).toEqual([READ_STAFF_PREFERENCES_SQL, SAVE_STAFF_SHORTCUTS_SQL, READ_STAFF_PREFERENCES_SQL]);
    expect(s.state().shortcuts.get(MEMBERSHIP)!.sha).toBe(requestDigest('identity.staff-shortcuts.update',
      { facilityId: FACILITY, modules: ['triage', 'patients'], expectedVersion: 0 }));
    // The role that showed triage is removed (SX-4): the saved shortcut is kept and answered unavailable.
    const narrowed = { ...doctorAt, permissions: ['identity.patient.read'] };
    await expect(s.service.read(at(narrowed))).resolves.toMatchObject({ shortcuts: { items: [
      { module: 'triage', available: false }, { module: 'patients', available: true }] } });
    // Sent again it is kept; a key never saved that the roles do not show is refused.
    await expect(s.service.saveShortcuts(at(narrowed), { items: [{ module: 'patients' }, { module: 'triage' }],
      expectedVersion: 1 }, 'sx7-unit-key-000000003')).resolves.toMatchObject({ shortcuts: { version: 2, items: [
      { module: 'patients', available: true }, { module: 'triage', available: false }] } });
    await expect(s.service.saveShortcuts(at(narrowed), { items: [{ module: 'consultation' }], expectedVersion: 2 },
      'sx7-unit-key-000000004')).rejects.toMatchObject({ code: 'SHORTCUT_NOT_ALLOWED', status: 400 });
    expect(s.state().shortcuts.get(MEMBERSHIP)!.modules).toEqual(['patients', 'triage']);
  });

  it('answers a stored key no longer known (an older image) unavailable, never an error', async () => {
    const s = setup();
    s.state().shortcuts.set(MEMBERSHIP, { facilityId: FACILITY, modules: ['retiredDepartment', 'patients'], version: 3,
      key: KEY, sha: 'a'.repeat(64) });
    await expect(s.service.read(at(doctorAt))).resolves.toMatchObject({ shortcuts: { version: 3, items: [
      { module: 'retiredDepartment', available: false }, { module: 'patients', available: true }] } });
  });

  it('keeps a saved key this image does not know when it is sent back, and refuses one that is not saved', async () => {
    const s = setup();
    s.state().shortcuts.set(MEMBERSHIP, { facilityId: FACILITY, modules: ['retiredDepartment', 'patients'], version: 3,
      key: KEY, sha: 'a'.repeat(64) });
    await expect(s.service.saveShortcuts(at(doctorAt), { items: [{ module: 'patients' }, { module: 'retiredDepartment' }],
      expectedVersion: 3 }, 'sx7-unit-key-000000005')).resolves.toMatchObject({ replayed: false, shortcuts: { version: 4,
      items: [{ module: 'patients', available: true }, { module: 'retiredDepartment', available: false }] } });
    expect(s.state().shortcuts.get(MEMBERSHIP)!.modules).toEqual(['patients', 'retiredDepartment']);
    await expect(s.service.saveShortcuts(at(nurseAt), { items: [{ module: 'retiredDepartment' }], expectedVersion: 0 },
      'sx7-unit-key-000000006')).rejects.toMatchObject({ code: 'SHORTCUT_UNKNOWN', status: 400 });
    expect(s.state().shortcuts.has(SECOND_MEMBERSHIP)).toBe(false);
  });

  it('refuses too many, unknown and repeated keys before any statement', async () => {
    const s = setup();
    for (const [items, code] of [
      [SHORTCUT_MODULE_KEYS.slice(0, 13), 'SHORTCUTS_TOO_MANY'],
      [['patients', 'HID-QPA2B3C4'], 'SHORTCUT_UNKNOWN'],
      [['patients', 'patients'], 'SHORTCUT_DUPLICATE'],
    ] as const) {
      await expect(s.service.saveShortcuts(at(doctorAt), { items: items.map((module) => ({ module })), expectedVersion: 0 }, KEY))
        .rejects.toMatchObject({ code, status: 400 });
    }
    expect(s.statements).toEqual([]);
  });

  it('refuses a shortcuts save with no resolved facility', async () => {
    const s = setup();
    await expect(s.service.saveShortcuts(at(), { items: [], expectedVersion: 0 }, KEY))
      .rejects.toMatchObject({ code: 'FACILITY_ACCESS_DENIED', status: 403 });
  });

  it('maps 0206\'s refusals, and answers anything else 503 PREFERENCES_UNAVAILABLE with no diagnostic', () => {
    const cases: [unknown, number, string][] = [
      [databaseError('22023', 'LANGUAGE_NOT_AVAILABLE'), 400, 'LANGUAGE_NOT_AVAILABLE'],
      [databaseError('22023', 'SHORTCUTS_TOO_MANY'), 400, 'SHORTCUTS_TOO_MANY'],
      [databaseError('22023', 'SHORTCUT_INVALID'), 400, 'SHORTCUT_UNKNOWN'],
      [databaseError('22023', 'SHORTCUT_DUPLICATE'), 400, 'SHORTCUT_DUPLICATE'],
      [databaseError('22023', 'IDEMPOTENCY_KEY_REQUIRED'), 400, 'IDEMPOTENCY_KEY_REQUIRED'],
      [databaseError('22023', 'STAFF_PREFERENCES_INVALID'), 400, 'VALIDATION_FAILED'],
      [databaseError('23505', 'IDEMPOTENCY_KEY_REUSED'), 409, 'IDEMPOTENCY_KEY_REUSED'],
      [databaseError('40001', 'VERSION_CONFLICT'), 412, 'VERSION_CONFLICT'],
      [databaseError('42501', 'STAFF_PREFERENCES_NOT_ALLOWED'), 401, 'AUTHENTICATION_REQUIRED'],
      [databaseError('42501', 'STAFF_SHORTCUTS_NOT_ALLOWED'), 403, 'FACILITY_ACCESS_DENIED'],
      // A unique violation that is not 0206's key refusal (a first-save race without 0206's lock) is not a key reuse.
      [databaseError('23505', 'duplicate key value violates unique constraint "staff_preferences_pkey"'), 503, 'PREFERENCES_UNAVAILABLE'],
      [databaseError('22023', 'Invalid membership request context'), 503, 'PREFERENCES_UNAVAILABLE'],
      [databaseError('42883', 'function identity.read_my_staff_preferences() does not exist'), 503, 'PREFERENCES_UNAVAILABLE'],
      [databaseError('42501', 'permission denied for function read_my_staff_preferences'), 503, 'PREFERENCES_UNAVAILABLE'],
      [new Error('connect ECONNREFUSED'), 503, 'PREFERENCES_UNAVAILABLE'],
    ];
    for (const [error, status, code] of cases) {
      const problem = staffPreferencesProblem(error) as DomainProblem;
      expect([problem.getStatus(), problem.code]).toEqual([status, code]);
      expect(JSON.stringify(problem.getResponse())).not.toMatch(/staff_preferences|function|ECONNREFUSED/);
    }
    const passed = new DomainProblem(400, 'SHORTCUT_NOT_ALLOWED', 'x');
    expect(staffPreferencesProblem(passed)).toBe(passed);
  });

  it('a database failure on save answers 503 and keeps nothing', async () => {
    const s = setup({ failWith: () => databaseError('57014', 'canceling statement due to statement timeout') });
    await expect(s.service.savePreferences(at(), { language: 'en', expectedVersion: 0 }, KEY))
      .rejects.toMatchObject({ code: 'PREFERENCES_UNAVAILABLE', status: 503 });
    expect(s.state().preferences.size).toBe(0);
  });

  it('runs exactly 0206\'s three functions, and the start-up check asks EXECUTE on each', () => {
    expect(READ_STAFF_PREFERENCES_SQL).toContain('from identity.read_my_staff_preferences() read');
    expect(SAVE_STAFF_PREFERENCES_SQL).toContain('identity.save_my_staff_preferences($1::text, $2::bigint, $3::text, $4::text)');
    expect(SAVE_STAFF_SHORTCUTS_SQL).toContain('identity.save_my_staff_shortcuts($1::text[], $2::bigint, $3::text, $4::text)');
    for (const sql of [READ_STAFF_PREFERENCES_SQL, SAVE_STAFF_PREFERENCES_SQL, SAVE_STAFF_SHORTCUTS_SQL]) {
      expect(sql).not.toMatch(/identity\.staff_(preferences|shortcuts)\b/);
    }
    for (const signature of STAFF_PREFERENCES_FUNCTIONS) {
      expect(STAFF_PREFERENCES_STARTUP_SQL).toContain(`has_function_privilege(to_regprocedure('${signature}')::oid, 'EXECUTE')`);
    }
    const migration = readFileSync(join(__dirname, '../../../ehr-api/database/migrations/0206_staff_preferences_and_shortcuts.sql'), 'utf8');
    for (const name of ['read_my_staff_preferences', 'save_my_staff_preferences', 'save_my_staff_shortcuts']) {
      expect(migration).toContain(`create function identity.${name}(`);
    }
  });

  it('runs, in the database suite, the three statements the service sends, word for word', () => {
    // The fake database answers these statements from its own model. The
    // Postgres suite (staff-preferences.integration.sql) runs exactly these
    // against 0206 in its preferences, shortcuts and Identity-login cases, so
    // a wrong column, cast or argument order fails there. It must keep
    // testing what the code sends.
    const suite = readFileSync(join(__dirname, '../../../ehr-api/test/database/staff-preferences.integration.sql'), 'utf8');
    const words = (text: string) => text.replace(/\s+/g, ' ').trim();
    const body = (name: string) => new RegExp(`create function pg_temp\\.${name}\\([\\s\\S]*?as \\$\\$([\\s\\S]*?)\\$\\$`)
      .exec(suite)?.[1] ?? `pg_temp.${name} is missing`;
    expect(words(body('service_read'))).toBe(words(READ_STAFF_PREFERENCES_SQL));
    expect(words(body('service_save_preferences'))).toBe(words(SAVE_STAFF_PREFERENCES_SQL));
    expect(words(body('service_save_shortcuts'))).toBe(words(SAVE_STAFF_SHORTCUTS_SQL));
  });
});
