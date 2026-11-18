/**
 * EHR-C7 (0135): the waiting-list service and its SQL on PostgreSQL, not on a
 * fake client.
 *
 * Runs only when EHR_VISIT_QUEUE_REHEARSAL_URL names a disposable rehearsal
 * database whose name ends in `_rehearsal` or `_joined`, with 0001-0127,
 * 0130-0132 and 0135 applied and the runtime roles bootstrapped (skipped
 * otherwise, so CI without one is unchanged). Everything runs in one
 * transaction that is rolled back. The service and its SQL are the real ones;
 * only DatabaseService.withTransaction is replaced by a savepoint on that
 * transaction that sets ehr-api's login role and the request context, as the
 * real one does. Fictional data only; ids start e1351.
 */
import { Pool, type PoolClient } from 'pg';
import { DomainProblem } from '../../common/problem';
import type { DataAccessContext } from '../../common/request-context';
import type { DatabaseService } from '../../database/database.service';
import { VisitQueueService } from './visit-queue.service';

const url = process.env.EHR_VISIT_QUEUE_REHEARSAL_URL;
const rehearsal = url !== undefined && /\/[A-Za-z0-9_]*_(rehearsal|joined)(\?|$)/.test(url);
const describeRehearsal = rehearsal ? describe : describe.skip;

const facilityId = 'e1351000-0000-4000-8000-000000000002';
const organizationId = 'e1351000-0000-4000-8000-000000000001';
const desk = { n: 1, role: 'receptionist' };
const nurse = { n: 2, role: 'nurse' };
const id = (block: string, n: number) => `e1351${block}-0000-4000-8000-${String(n).padStart(12, '0')}`;
const searchedPatient = id('400', 1);
const ownPatient = id('400', 2);
const strangerPatient = id('400', 3);
const matchRef = `psr_${'Q'.repeat(43)}`;

function contextFor(member: { n: number; role: string }): DataAccessContext {
  const membershipId = id('300', member.n);
  return {
    correlationId: `visit-queue-pg-${member.n}`, facilityId, membershipId, purposeOfUse: 'direct-care',
    actor: { id: id('100', member.n), subject: `synthetic:queue-pg-${member.n}`, accountId: id('100', member.n),
      roles: [member.role], permissions: [], facilityIds: [facilityId], facilities: [],
      facility: { id: facilityId, membershipId, organizationId, name: 'Queue PG Clinic', roles: [member.role],
        permissions: [], isPrimary: true } },
  } as unknown as DataAccessContext;
}

describeRehearsal('EHR-C7 the waiting list on PostgreSQL (0135)', () => {
  let pool: Pool;
  let client: PoolClient;
  let service: VisitQueueService;

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, max: 1 });
    client = await pool.connect();
    await client.query('begin');
    await client.query('set local session_replication_role = replica');
    await client.query(`insert into identity.purpose_of_use_codes (code, display, source_system)
      values ('direct-care', 'Direct patient care', 'visit-queue-pg') on conflict (code) do update set active = true`);
    await client.query(`insert into identity.organizations (id, name, slug) values ($1, 'Queue PG Group', 'queue-pg-group')`,
      [organizationId]);
    await client.query(`insert into identity.facilities (id, organization_id, name, code, timezone, active, lifecycle_status)
      values ($1, $2, 'Queue PG Clinic', 'QUEUE-PG', 'Africa/Lagos', true, 'verified')`, [facilityId, organizationId]);
    for (const member of [desk, nurse]) {
      await client.query(`insert into auth.accounts (id, subject, email, display_name, status)
        values ($1, $2, $3, $4, 'active')`, [id('100', member.n), `synthetic:queue-pg-${member.n}`,
        `queue-pg-${member.n}@example.invalid`, `Queue PG ${member.role}`]);
      await client.query(`insert into identity.staff (id, account_id, full_name, email, verification_status, default_role)
        values ($1, $2, $3, $4, 'verified', $5)`, [id('200', member.n), id('100', member.n), `Queue PG ${member.role}`,
        `queue-pg-${member.n}@example.invalid`, member.role]);
      await client.query(`insert into identity.staff_facility_memberships (id, staff_id, account_id, organization_id,
        facility_id, membership_role, app_role, is_primary, active) values ($1, $2, $3, $4, $5, $6, $6, true, true)`,
        [id('300', member.n), id('200', member.n), id('100', member.n), organizationId, facilityId, member.role]);
      await client.query(`insert into auth.account_roles (id, account_id, role_code, scope_type, membership_id, facility_id,
        grant_reason) values (gen_random_uuid(), $1, $2, 'facility', $3, $4, 'Synthetic waiting-list role')`,
        [id('100', member.n), member.role, id('300', member.n), facilityId]);
    }
    const patients: [string, string, string, string][] = [
      [searchedPatient, 'HID-QPAA22', 'Ada', 'Searched'], [ownPatient, 'HID-QPAB22', 'Bola', 'Ownpatient'],
      [strangerPatient, 'HID-QPAC22', 'Chidi', 'Stranger'],
    ];
    for (const [patientId, hid, first, last] of patients) {
      await client.query(`insert into identity.patients (id, hid_code, first_name, last_name, full_name, gender, dob, status)
        values ($1, $2, $3, $4, $3 || ' ' || $4, 'female', date '1990-01-02', 'active')`, [patientId, hid, first, last]);
    }
    // The own patient: a visit here last month that the nurse started under the patient's approval (0131 basis).
    await client.query(`insert into identity.consent_grants (id, patient_id, staff_id, account_id, membership_id, facility_id,
      scope, purpose_of_use, status, granted_by_patient_id, reason, starts_at, expires_at, break_glass, created_at)
      values ($1, $2, $3, $4, $5, $6, 'write_records', 'direct-care', 'expired', $2, 'Fixture grant',
        now() - interval '31 days', now() - interval '30 days', false, now() - interval '31 days')`,
      [id('700', 2), ownPatient, id('200', nurse.n), id('100', nurse.n), id('300', nurse.n), facilityId]);
    await client.query(`insert into ehr.encounters (id, patient_id, facility_id, created_by, created_by_membership_id,
      encounter_type, status, started_at, ended_at, chief_complaint, created_at) values ($1, $2, $3, $4, $5, 'ambulatory',
      'completed', now() - interval '30 days 1 hour', now() - interval '30 days', 'Fixture visit', now() - interval '30 days 1 hour')`,
      [id('800', 2), ownPatient, facilityId, id('100', nurse.n), id('300', nurse.n)]);
    // A matchRef the desk's search handed out a minute ago (0132's table; only its SHA-256 is stored).
    await client.query(`insert into identity.patient_search_refs (token_sha256, patient_id, account_id, membership_id,
      facility_id, purpose_of_use, search_mode, created_at, expires_at) values (encode(sha256(convert_to($1, 'UTF8')), 'hex'),
      $2, $3, $4, $5, 'direct-care', 'standard', statement_timestamp(), statement_timestamp() + interval '10 minutes')`,
      [matchRef, searchedPatient, id('100', desk.n), id('300', desk.n), facilityId]);
    await client.query('set local session_replication_role = origin');

    let savepoint = 0;
    const database = {
      withTransaction: async <Result>(context: DataAccessContext, operation: (given: PoolClient) => Promise<Result>) => {
        const name = `queue_pg_${savepoint += 1}`;
        await client.query(`savepoint ${name}`);
        try {
          await client.query('set local role hid_ehr_api_runtime');
          await client.query(`select set_config('app.actor_subject', $1, true), set_config('app.facility_id', $2, true),
            set_config('app.correlation_id', $3, true), set_config('app.membership_id', $4, true),
            set_config('app.purpose_of_use', $5, true)`, [context.actor.subject, context.facilityId, context.correlationId,
            context.membershipId, context.purposeOfUse]);
          const result = await operation(client);
          await client.query('reset role');
          await client.query(`release savepoint ${name}`);
          return result;
        } catch (error) {
          await client.query(`rollback to savepoint ${name}`);
          await client.query('reset role');
          throw error;
        }
      },
    } as unknown as DatabaseService;
    service = new VisitQueueService(database);
  });

  afterAll(async () => {
    await client?.query('rollback');
    client?.release();
    await pool?.end();
  });

  it('checks in from a search, and the card holds only the identity details', async () => {
    const answer = await service.checkIn(contextFor(desk), { matchRef });
    expect(answer.outcome).toBe('checked_in');
    expect(answer.entry).toMatchObject({ patientId: searchedPatient, fullName: 'Ada Searched', sex: 'female',
      dateOfBirth: '1990-01-02', healthIdLast4: 'AA22', stage: 'waiting', triageLevel: null, assignedMembershipId: null,
      checkInBasis: 'search', closedAt: null, rowVersion: 1, chartBlocked: false });
    expect(answer.entry.checkInDay).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(JSON.stringify(answer)).not.toContain('HID-');
    await expect(service.checkIn(contextFor(desk), { matchRef })).resolves.toMatchObject({ outcome: 'already_on_list' });
  });

  it('checks in this facility\'s own patient by id, and refuses a stranger with the one answer', async () => {
    await expect(service.checkIn(contextFor(desk), { patientId: ownPatient }))
      .resolves.toMatchObject({ outcome: 'checked_in', entry: { checkInBasis: 'own-facility', fullName: 'Bola Ownpatient' } });
    const refusal = await service.checkIn(contextFor(desk), { patientId: strangerPatient }).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(DomainProblem);
    expect(refusal).toMatchObject({ code: 'CHECK_IN_NEEDS_SEARCH' });
    const audit = await client.query(`select outcome, details ->> 'refusal' as refusal from audit.events
      where action = 'ehr.visit-queue.check-in' and facility_id = $1 and patient_id = $2`, [facilityId, strangerPatient]);
    expect(audit.rows).toEqual([{ outcome: 'denied', refusal: 'not_own_facility_patient' }]);
  });

  it('lists, reorders by triage level, assigns and closes, with the row version', async () => {
    const first = await service.list(contextFor(nurse), false);
    expect(first.items.map((item) => item.fullName)).toEqual(['Ada Searched', 'Bola Ownpatient']);
    expect(first.hasMore).toBe(false);
    const own = first.items[1]!;
    const triaged = await service.update(contextFor(nurse), own.entryId,
      { expectedRowVersion: own.rowVersion, stage: 'triage', triageLevel: 1, assignedMembershipId: id('300', nurse.n) });
    expect(triaged).toMatchObject({ stage: 'triage', triageLevel: 1, assignedMembershipId: id('300', nurse.n), rowVersion: 2 });
    expect((await service.list(contextFor(desk), false)).items.map((item) => item.fullName))
      .toEqual(['Bola Ownpatient', 'Ada Searched']);
    await expect(service.update(contextFor(desk), own.entryId, { expectedRowVersion: 1, stage: 'ready' }))
      .rejects.toMatchObject({ code: 'VISIT_QUEUE_ENTRY_CHANGED' });
    await expect(service.update(contextFor(desk), own.entryId, { expectedRowVersion: 2, assignedMembershipId: id('300', desk.n) }))
      .rejects.toMatchObject({ code: 'VISIT_QUEUE_ASSIGNEE_INVALID' });
    const cleared = await service.update(contextFor(nurse), own.entryId,
      { expectedRowVersion: 2, triageLevel: null, assignedMembershipId: null });
    expect(cleared).toMatchObject({ triageLevel: null, assignedMembershipId: null, rowVersion: 3 });
    const finished = await service.update(contextFor(nurse), own.entryId, { expectedRowVersion: 3, stage: 'finished' });
    expect(finished.closedAt).not.toBeNull();
    expect((await service.list(contextFor(desk), false)).items.map((item) => item.fullName)).toEqual(['Ada Searched']);
    expect((await service.list(contextFor(desk), true)).items.map((item) => item.fullName))
      .toEqual(['Ada Searched', 'Bola Ownpatient']);
    await expect(service.update(contextFor(nurse), id('900', 9), { expectedRowVersion: 1, stage: 'left' }))
      .rejects.toMatchObject({ code: 'VISIT_QUEUE_ENTRY_NOT_FOUND' });
  });

  it('audits every patient shown on every list', async () => {
    const shown = await client.query(`select count(*)::integer as count from audit.events
      where action = 'ehr.visit-queue.list.shown' and facility_id = $1`, [facilityId]);
    const lists = await client.query(`select count(*)::integer as count from audit.events
      where action = 'ehr.visit-queue.list' and facility_id = $1`, [facilityId]);
    expect({ shown: shown.rows[0].count, lists: lists.rows[0].count }).toEqual({ shown: 7, lists: 4 });
  });
});
