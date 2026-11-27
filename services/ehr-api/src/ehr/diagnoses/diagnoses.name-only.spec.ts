import { Logger } from '@nestjs/common';
import type { DataAccessContext } from '../../common/request-context';
import { patientEvidence } from '../patient-records/patient-evidence.policy';
import { evidence } from '../patient-records/patient-evidence.types';
import { CreateDiagnosisBodyPipe, NAME_ONLY_CODES_OFF, NameOnlyCodes } from '../shared/name-only-codes';
import { CODE_LISTED_SQL, DiagnosesService, firstDiagnosisCode, type DiagnosisRow } from './diagnoses.service';

/*
 * A diagnosis by its name only, and ORD-9's codeStatus (0156), while
 * DIAGNOSIS_NAME_ONLY_ENABLED is on. Off, the create answer is exactly
 * today's. On, a diagnosis may be saved with both codes null, it is not a
 * recent pick, and the create answer (and its replay) carries codeStatus:
 * `in_list` or `not_in_list` for an ICD-11 code against the active release
 * (ehr.catalog_diagnosis_listed, on the first code of a post-coordinated
 * one), `not_checked` for any other code system or no release, and `no_code`
 * by name only. Fictional data only.
 */

const patientId = '123e4567-e89b-42d3-a456-426614174001';
const facilityId = '123e4567-e89b-42d3-a456-426614174002';
const accountId = '123e4567-e89b-42d3-a456-426614174003';
const membershipId = '123e4567-e89b-42d3-a456-426614174004';
const encounterId = '123e4567-e89b-42d3-a456-426614174006';
const diagnosisId = '123e4567-e89b-42d3-a456-426614174008';
const context = { correlationId: 'correlation-name-only-1', facilityId, membershipId, purposeOfUse: 'direct-care',
  actor: { id: accountId, subject: 'staff:test', accountId, authenticationMethod: 'local', roles: ['doctor'],
    permissions: ['ehr.diagnosis.write'], facilityIds: [facilityId], facilities: [] } } as unknown as DataAccessContext;
const NOW = new Date('2026-12-01T10:00:00Z');
const pipe = new CreateDiagnosisBodyPipe(new NameOnlyCodes(false, true));
const named = { display: 'Sickle cell crisis (as written, test)', clinicalStatus: 'active', verificationStatus: 'provisional' };

interface Lookup { listed?: boolean | null; error?: string }

/**
 * A fake database for one diagnosis create: the insert returns what it was
 * given; ehr.catalog_diagnosis_listed answers `lookup.listed` (or fails with
 * `lookup.error`); a replay (`replay`) loads `stored` instead of inserting.
 */
const harness = (nameOnly: NameOnlyCodes | undefined, lookup: Lookup = {},
  options: { replay?: DiagnosisRow; isolation?: string } = {}) => {
  const statements: { sql: string; values: unknown[] }[] = [];
  const query = jest.fn(async (sql: string, values: unknown[] = []) => {
    statements.push({ sql, values });
    if (/insert into ehr\.diagnoses/.test(sql)) {
      return { rows: [{ id: diagnosisId, encounterId, patientId, facilityId, createdBy: accountId,
        createdByMembershipId: membershipId, codeSystem: values[5], code: values[6], display: values[7],
        clinicalStatus: values[8], verificationStatus: values[9], onsetAt: values[10], abatementAt: values[11],
        notes: values[12], rowVersion: '1', createdAt: NOW, updatedAt: NOW }] };
    }
    if (sql === CODE_LISTED_SQL) {
      if (lookup.error) throw Object.assign(new Error('lookup failed'), { code: lookup.error });
      return { rows: [{ listed: lookup.listed ?? null }] };
    }
    if (/from ehr\.diagnoses where id = \$1/.test(sql)) return { rows: options.replay ? [options.replay] : [] };
    if (/transaction_isolation/.test(sql)) return { rows: [{ isolation: options.isolation ?? 'read committed' }] };
    return { rows: [] };
  });
  const repository = {
    run: jest.fn(async (_c: unknown, _p: unknown, _a: unknown, _e: unknown,
      operation: (client: unknown) => Promise<{ value: unknown }>) => (await operation({ query })).value),
    executeCreate: jest.fn(async (...args: unknown[]) => options.replay
      ? { value: await (args[8] as (id: string) => Promise<unknown>)(diagnosisId), resourceId: diagnosisId }
      : (args[7] as () => Promise<unknown>)()),
  };
  const service = nameOnly === undefined ? new DiagnosesService(repository as never)
    : new DiagnosesService(repository as never, nameOnly);
  const sqls = () => statements.map(({ sql }) => sql);
  return { service, statements, sqls };
};
const create = async (service: DiagnosesService, body: object) =>
  service.create(context, patientId, encounterId, await pipe.transform(body), 'diagnosis-key-0000001');

describe('diagnoses: DIAGNOSIS_NAME_ONLY_ENABLED off', () => {
  it.each([['no setting passed (every existing caller)', undefined], ['the setting false', NAME_ONLY_CODES_OFF]])(
    'with %s, an ICD-11 diagnosis answers today\'s keys, no codeStatus, and nothing is looked up', async (_label, nameOnly) => {
      const { service, sqls } = harness(nameOnly, { listed: true });
      const created = await create(service, { ...named, codeSystem: 'ICD-11', code: '3A51.0' });
      expect(Object.keys(created)).toEqual(['id', 'encounterId', 'patientId', 'facilityId', 'createdBy', 'createdByMembershipId',
        'codeSystem', 'code', 'display', 'clinicalStatus', 'verificationStatus', 'onsetAt', 'abatementAt', 'notes', 'rowVersion',
        'createdAt', 'updatedAt']);
      expect(sqls()).not.toContain(CODE_LISTED_SQL);
      expect(sqls().filter((sql) => /ehr_diagnosis_code_status/.test(sql))).toEqual([]);
      expect(sqls()).toContain('select ehr.record_recent_diagnosis($1, $2, $3)');
    });
});

describe('diagnoses: DIAGNOSIS_NAME_ONLY_ENABLED on', () => {
  const on = new NameOnlyCodes(false, true);

  it('saves a diagnosis by name only with both codes null: codeStatus no_code, no lookup, no recent pick', async () => {
    const { service, statements, sqls } = harness(on);
    const created = await create(service, named);
    expect(statements.find(({ sql }) => /insert into ehr\.diagnoses/.test(sql))?.values.slice(5, 8))
      .toEqual([null, null, 'Sickle cell crisis (as written, test)']);
    expect(created).toMatchObject({ codeSystem: null, code: null, codeStatus: 'no_code' });
    expect(sqls()).not.toContain(CODE_LISTED_SQL);
    expect(sqls().filter((sql) => /record_recent_diagnosis|ehr_recent_diagnosis/.test(sql))).toEqual([]);
  });

  it.each([['ICD-10', 'D57.0'], ['SNOMED CT', '127040003'], ['icd-11', '3A51.0'], ['ICD-11 MMS', '3A51.0']])(
    'answers not_checked for code system %s without a lookup, and records the pick as before', async (codeSystem, code) => {
      const { service, sqls } = harness(on, { listed: true });
      await expect(create(service, { ...named, codeSystem, code })).resolves.toMatchObject({ codeSystem, code,
        codeStatus: 'not_checked' });
      expect(sqls()).not.toContain(CODE_LISTED_SQL);
      expect(sqls()).toContain('select ehr.record_recent_diagnosis($1, $2, $3)');
    });

  it.each([[true, 'in_list'], [false, 'not_in_list'], [null, 'not_checked']] as const)(
    'an ICD-11 code the lookup answers %p for is %s, asked in a savepoint after the save', async (listed, codeStatus) => {
      const { service, statements, sqls } = harness(on, { listed });
      await expect(create(service, { ...named, codeSystem: 'ICD-11', code: '3A51.0' })).resolves.toMatchObject({
        codeSystem: 'ICD-11', code: '3A51.0', codeStatus });
      expect(statements.find(({ sql }) => sql === CODE_LISTED_SQL)?.values).toEqual(['ICD-11', '3A51.0']);
      const order = sqls().filter((sql) => /insert into ehr\.diagnoses|ehr_diagnosis_code_status|catalog_diagnosis_listed/.test(sql));
      expect(order).toEqual([expect.stringMatching(/insert into ehr\.diagnoses/), 'savepoint ehr_diagnosis_code_status',
        CODE_LISTED_SQL, 'release savepoint ehr_diagnosis_code_status']);
    });

  it.each([['3A51.0&XS25', '3A51.0'], ['5A11/1C62.1', '5A11'], ['1F40 & XA9Z', '1F40']])(
    'a post-coordinated code %s is looked up on its first code %s, and saved as typed', async (code, first) => {
      const { service, statements } = harness(on, { listed: true });
      await expect(create(service, { ...named, codeSystem: 'ICD-11', code })).resolves.toMatchObject({ code,
        codeStatus: 'in_list' });
      expect(statements.find(({ sql }) => sql === CODE_LISTED_SQL)?.values).toEqual(['ICD-11', first]);
    });

  it.each(['42883', '57014', '55P03', '40001'])(
    'saves the diagnosis when the lookup fails (%s in READ COMMITTED): not_checked, a warning with the SQLSTATE only',
    async (code) => {
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      try {
        const { service, sqls } = harness(on, { error: code });
        await expect(create(service, { ...named, codeSystem: 'ICD-11', code: '3A51.0' })).resolves.toMatchObject({
          id: diagnosisId, codeStatus: 'not_checked' });
        expect(sqls()).toContain('rollback to savepoint ehr_diagnosis_code_status');
        expect(sqls()).not.toContain('release savepoint ehr_diagnosis_code_status');
        expect(warn).toHaveBeenCalledWith({ message: 'A diagnosis code could not be checked against the ICD-11 list',
          sqlState: code, correlationId: 'correlation-name-only-1' });
        expect(JSON.stringify(warn.mock.calls)).not.toMatch(/3A51|Sickle|123e4567/);
      } finally {
        warn.mockRestore();
      }
    });

  it('passes a serialization failure of the lookup on in a SERIALIZABLE transaction, so the whole save is run again', async () => {
    const { service } = harness(on, { error: '40001' }, { isolation: 'serializable' });
    await expect(create(service, { ...named, codeSystem: 'ICD-11', code: '3A51.0' })).rejects.toMatchObject({ code: '40001' });
  });

  it('answers a replay with the stored diagnosis and its codeStatus now', async () => {
    const stored = { id: diagnosisId, encounterId, patientId, facilityId, createdBy: accountId,
      createdByMembershipId: membershipId, codeSystem: 'ICD-11', code: '3A51.0', display: 'Sickle cell disease with crisis',
      clinicalStatus: 'active', verificationStatus: 'provisional', onsetAt: null, abatementAt: null, notes: null, rowVersion: '1',
      createdAt: NOW, updatedAt: NOW } as DiagnosisRow;
    const { service, sqls } = harness(on, { listed: false }, { replay: stored });
    await expect(create(service, { ...named, codeSystem: 'ICD-11', code: '3A51.0' })).resolves.toMatchObject({
      id: diagnosisId, codeStatus: 'not_in_list' });
    expect(sqls().filter((sql) => /insert into ehr\.diagnoses|record_recent_diagnosis/.test(sql))).toEqual([]);
    const nameOnly = harness(on, {}, { replay: { ...stored, codeSystem: null, code: null } });
    await expect(create(nameOnly.service, named)).resolves.toMatchObject({ codeStatus: 'no_code' });
  });

  it('firstDiagnosisCode takes the text before the first & or /, without the spaces at its ends', () => {
    expect(['1F40', '1F40&XS25', ' 1F40 /XS25', '5A11/1C62.1&XA', '&1F40', 'B50.9'].map(firstDiagnosisCode))
      .toEqual(['1F40', '1F40', '1F40', '5A11', '', 'B50.9']);
  });
});

describe('a name-only diagnosis or test in the patient\'s record chat (null codes)', () => {
  const profile = { firstName: 'Adaeze', lastName: 'Okafor', fullName: 'Adaeze Okafor', dateOfBirth: '1994-03-12',
    gender: 'female' };
  let n = 0;
  const record = (kind: 'diagnosis' | 'investigation', fields: Record<string, unknown>, title: string) => {
    n += 1;
    return evidence({ kind, id: `22222222-2222-4222-8222-${String(n).padStart(12, '0')}`, version: '1', title,
      recordedAt: '2026-12-01T10:00:00.000Z', effectiveAt: null, provenance: 'Synthetic provenance', quality: 'recorded',
      fields: { _encounterId: encounterId, _encounterStatus: 'completed', ...fields } });
  };
  const diagnosis = (condition: string) => record('diagnosis', { codeSystem: null, code: null, condition,
    clinicalStatus: 'active', verificationStatus: 'confirmed', onsetAt: null, abatementAt: null }, condition);
  const test = (name: string) => record('investigation', { test: name, codeSystem: null, code: null, status: 'active' }, name);
  const shown = (records: ReturnType<typeof record>[]) => patientEvidence(records, profile, NOW).map((item) => item.title);

  it('shows a name-only diagnosis or test with null codes, and still hides a sensitive one by its name', () => {
    expect(shown([diagnosis('Sickle cell crisis'), diagnosis('HIV disease'), test('Full blood count'), test('HIV screening')]))
      .toEqual(['Sickle cell crisis', 'Full blood count']);
    expect(patientEvidence([diagnosis('Sickle cell crisis')], profile, NOW)[0]?.fields).toMatchObject({ codeSystem: null,
      code: null, condition: 'Sickle cell crisis' });
  });
});
