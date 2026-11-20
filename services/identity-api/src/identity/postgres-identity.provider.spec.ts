import type { PoolClient } from 'pg';
import type { DataAccessContext, PurposeOfUse } from '../common/request-context';
import type { DatabaseService } from '../database/database.service';
import { PostgresIdentityProvider } from './postgres-identity.provider';

const patientId = '50000000-0000-4000-8000-000000000001';
const context = { actor: { kind: 'staff', subject: 'staff:doctor', accountId: 'a1' }, facilityId: 'f1', membershipId: 'm1',
  correlationId: 'staff-correlation-01', purposeOfUse: 'healthcare-operations' } as unknown as DataAccessContext;
const until = new Date('2026-11-04T09:00:00.000Z');

interface Answers {
  allowed: boolean;
  grants?: Array<{ id: string; scope: string; expires_at: Date; break_glass: boolean }>;
  cover?: Array<{ id: string; covered_until: Date }>;
}

function provider(answers: Answers) {
  const query = jest.fn(async (sql: string, _values?: unknown[]) => {
    if (sql.includes('has_active_consent_grant')) return { rows: [{ allowed: answers.allowed }] };
    if (sql.includes('records_processing_direct_care_cover')) return { rows: answers.cover ?? [] };
    return { rows: answers.grants ?? [] };
  });
  const database = { withTransaction: jest.fn(async (_c: DataAccessContext, work: (client: PoolClient) => Promise<unknown>) =>
    work({ query } as unknown as PoolClient)) } as unknown as DatabaseService;
  return { identity: new PostgresIdentityProvider(database), query };
}

function authorize(identity: PostgresIdentityProvider, purpose: PurposeOfUse, scope: 'read_records' | 'write_records' = 'write_records') {
  return identity.authorize({ patientId, scope, purpose, context });
}

describe('PostgresIdentityProvider records-processing cover (0104, owner decision 34(1))', () => {
  it('names the covering direct-care grant and the end of the cover when records processing is allowed by it', async () => {
    const { identity, query } = provider({ allowed: true, cover: [{ id: 'dc-grant', covered_until: until }] });
    await expect(authorize(identity, 'healthcare-operations')).resolves.toEqual({
      allowed: true, patientId, facilityId: 'f1', membershipId: 'm1', scope: 'write_records',
      purpose: 'healthcare-operations', consentGrantId: 'dc-grant', expiresAt: until.toISOString(), breakGlass: false,
    });
    const coverCall = query.mock.calls.find(([sql]) => sql.includes('records_processing_direct_care_cover'));
    expect(coverCall?.[1]).toEqual([patientId, 'staff:doctor', 'm1', 'f1', 'write_records']);
  });

  it('prefers a records-processing grant of its own and does not read the cover then', async () => {
    const { identity, query } = provider({ allowed: true,
      grants: [{ id: 'rp-grant', scope: 'write_records', expires_at: until, break_glass: false }],
      cover: [{ id: 'dc-grant', covered_until: until }] });
    await expect(authorize(identity, 'healthcare-operations')).resolves.toMatchObject({ allowed: true, consentGrantId: 'rp-grant' });
    expect(query.mock.calls.some(([sql]) => sql.includes('records_processing_direct_care_cover'))).toBe(false);
  });

  it('never reads the cover when the database refuses, and refuses', async () => {
    const { identity, query } = provider({ allowed: false, cover: [{ id: 'dc-grant', covered_until: until }] });
    const decision = await authorize(identity, 'healthcare-operations');
    expect(decision).toMatchObject({ allowed: false, breakGlass: false });
    expect(decision.consentGrantId).toBeUndefined();
    expect(query.mock.calls.some(([sql]) => sql.includes('records_processing_direct_care_cover'))).toBe(false);
  });

  it('refuses when allowed but neither a grant nor a cover is found (fail closed)', async () => {
    const { identity } = provider({ allowed: true });
    await expect(authorize(identity, 'healthcare-operations')).resolves.toMatchObject({ allowed: false });
  });

  it.each<PurposeOfUse>(['direct-care', 'emergency'])('never reads the cover for %s', async (purpose) => {
    const { identity, query } = provider({ allowed: true, cover: [{ id: 'dc-grant', covered_until: until }] });
    await expect(authorize(identity, purpose, 'read_records')).resolves.toMatchObject({ allowed: false });
    expect(query.mock.calls.some(([sql]) => sql.includes('records_processing_direct_care_cover'))).toBe(false);
  });
});

describe('PostgresIdentityProvider record kind (0146, ID-7)', () => {
  const patientRow = { id: patientId, hid_code: 'HID-UNKAAA2', first_name: 'Unknown', last_name: 'U-0007',
    full_name: 'Unknown patient U-0007', dob: '1990-07-01', gender: 'male', row_version: '2', nin_verified: false };

  function lookups(present: boolean, kind = 'unknown') {
    const query = jest.fn(async (sql: string, _values?: unknown[]) => {
      if (sql.includes('to_regprocedure')) return { rows: [{ present }] };
      if (sql.includes('identity.patient_record_kind($1')) return { rows: [{ record_kind: kind }] };
      return { rows: [patientRow] };
    });
    const database = { withTransaction: jest.fn(async (_c: DataAccessContext, work: (client: PoolClient) => Promise<unknown>) =>
      work({ query } as unknown as PoolClient)) } as unknown as DatabaseService;
    return { identity: new PostgresIdentityProvider(database), query };
  }

  it('reads the kind through identity.patient_record_kind, and asks whether it exists only until it does', async () => {
    const { identity, query } = lookups(true);
    await expect(identity.lookupExactHid('HID-UNKAAA2', context)).resolves.toMatchObject({ recordKind: 'unknown' });
    await expect(identity.lookupPatientId(patientId, context)).resolves.toMatchObject({ recordKind: 'unknown' });
    expect(query.mock.calls.filter(([sql]) => sql.includes('to_regprocedure'))).toHaveLength(1);
    expect(query.mock.calls.filter(([sql]) => sql.includes('patient_record_kind($1')).map(([, values]) => values))
      .toEqual([[patientId], [patientId]]);
    expect(query.mock.calls.some(([sql]) => sql.includes('record_kind') && sql.includes('identity.patients'))).toBe(false);
  });

  it('leaves the kind out before 0146, asking again next time', async () => {
    const { identity, query } = lookups(false);
    const found = await identity.lookupExactHid('HID-UNKAAA2', context);
    expect(found).not.toHaveProperty('recordKind');
    await identity.lookupPatientId(patientId, context);
    expect(query.mock.calls.filter(([sql]) => sql.includes('to_regprocedure'))).toHaveLength(2);
    expect(query.mock.calls.some(([sql]) => sql.includes('patient_record_kind($1'))).toBe(false);
  });
});
