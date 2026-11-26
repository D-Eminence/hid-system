/**
 * ADT-1 (0170-0173): the inpatient service and its SQL on PostgreSQL, not on a
 * fake client.
 *
 * Runs only when EHR_INPATIENT_REHEARSAL_URL names a disposable rehearsal
 * database whose name ends in `_rehearsal` or `_joined`, with 0001-0151,
 * BILL-1's 0162-0167, ED-1's 0168-0169 and 0170-0173 applied and the runtime
 * roles bootstrapped (skipped otherwise, so CI without one is unchanged).
 *
 * The first part runs in one transaction that is rolled back; the service and
 * its SQL are the real ones, and only DatabaseService.withTransaction is
 * replaced by a savepoint on that transaction that sets ehr-api's login role
 * and the request context, as the real one does.
 *
 * The second part is "one patient per bed under a race": two sessions admit
 * two patients to the same free bed at the same moment, so it needs committed
 * rows that both sessions see. It writes its own fictional facility, ward,
 * bed, patients and admissions with fresh ids each run, and leaves them in the
 * disposable database (the clinical tables refuse deletes). Fictional data
 * only; ids start a1701 (the race: a and four random hex digits).
 */
import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import type { DataAccessContext } from '../../common/request-context';
import type { DatabaseService } from '../../database/database.service';
import type { DischargeDto, RequestAdmissionDto } from './inpatient.dto';
import { InpatientService } from './inpatient.service';

const url = process.env.EHR_INPATIENT_REHEARSAL_URL;
const rehearsal = url !== undefined && /\/[A-Za-z0-9_]*_(rehearsal|joined)(\?|$)/.test(url);
const describeRehearsal = rehearsal ? describe : describe.skip;

const key = (label: string) => `inpatient-pg-key-${label}-${'0'.repeat(4)}`;

interface Member { n: number; role: string }
const nurse: Member = { n: 1, role: 'nurse' };
const doctor: Member = { n: 2, role: 'doctor' };
const admin: Member = { n: 3, role: 'admin' };

/** Fixed ids of the rolled-back part; a fresh run prefix for the committed race. */
function ids(prefix: string) {
  const id = (block: string, n: number) => `${prefix}${block}-0000-4000-8000-${String(n).padStart(12, '0')}`;
  return { id, organizationId: id('000', 1), facilityId: id('000', 2) };
}

function contextFor(facilityId: string, organizationId: string, idOf: (block: string, n: number) => string,
  member: Member, purpose = 'direct-care'): DataAccessContext {
  const membershipId = idOf('300', member.n);
  return {
    correlationId: `inpatient-pg-${member.n}-${randomUUID()}`, facilityId, membershipId, purposeOfUse: purpose,
    actor: { id: idOf('100', member.n), subject: `synthetic:inpatient-pg-${idOf('100', member.n)}`,
      accountId: idOf('100', member.n), roles: [member.role], permissions: [], facilityIds: [facilityId], facilities: [],
      facility: { id: facilityId, membershipId, organizationId, name: 'Ward PG Hospital', roles: [member.role],
        permissions: [], isPrimary: true } },
  } as unknown as DataAccessContext;
}

/** The fixture: a facility with a nurse, a doctor and an admin, and patients with the doctor's chart grant. */
async function seed(client: PoolClient, prefix: string, patients: number): Promise<void> {
  const { id, organizationId, facilityId } = ids(prefix);
  await client.query('set local session_replication_role = replica');
  await client.query(`insert into identity.purpose_of_use_codes (code, display, source_system)
    values ('direct-care', 'Direct patient care', 'inpatient-pg'), ('healthcare-operations', 'Operations', 'inpatient-pg')
    on conflict (code) do update set active = true`);
  await client.query(`insert into identity.organizations (id, name, slug) values ($1, 'Ward PG Group', $2)`,
    [organizationId, `ward-pg-${prefix}`]);
  await client.query(`insert into identity.facilities (id, organization_id, name, code, timezone, active, lifecycle_status)
    values ($1, $2, 'Ward PG Hospital', $3, 'Africa/Lagos', true, 'verified')`,
  [facilityId, organizationId, `WARD-PG-${prefix.toUpperCase()}`]);
  for (const member of [nurse, doctor, admin]) {
    await client.query(`insert into auth.accounts (id, subject, email, display_name, status) values ($1, $2, $3, $4, 'active')`,
      [id('100', member.n), `synthetic:inpatient-pg-${id('100', member.n)}`, `inpatient-pg-${id('100', member.n)}@example.invalid`,
        `Ward PG ${member.role}`]);
    await client.query(`insert into identity.staff (id, account_id, full_name, email, verification_status, default_role)
      values ($1, $2, $3, $4, 'verified', $5)`, [id('200', member.n), id('100', member.n), `Ward PG ${member.role}`,
      `inpatient-pg-${id('100', member.n)}@example.invalid`, member.role]);
    await client.query(`insert into identity.staff_facility_memberships (id, staff_id, account_id, organization_id,
      facility_id, membership_role, app_role, is_primary, active) values ($1, $2, $3, $4, $5, $6, $6, true, true)`,
    [id('300', member.n), id('200', member.n), id('100', member.n), organizationId, facilityId, member.role]);
    await client.query(`insert into auth.account_roles (id, account_id, role_code, scope_type, membership_id, facility_id,
      grant_reason) values (gen_random_uuid(), $1, $2, 'facility', $3, $4, 'Synthetic ward role')`,
    [id('100', member.n), member.role, id('300', member.n), facilityId]);
  }
  for (let n = 1; n <= patients; n += 1) {
    const letters = String(n).padStart(2, '0').replace(/[0-9]/g, (digit) => 'ABCDEFGHJK'[Number(digit)]!);
    await client.query(`insert into identity.patients (id, hid_code, first_name, last_name, full_name, gender, dob, status,
      source_system) values ($1, $2, 'Pat', $3, 'Pat ' || $3, 'female', date '1980-03-04', 'active', 'hid')`,
    [id('400', n), `HID-WP${prefix.toUpperCase().replace(/[^A-HJ-NP-Z2-9]/g, 'Q')}${letters}`, `Wardpg${n}`]);
    await client.query(`insert into identity.consent_grants (id, patient_id, staff_id, account_id, membership_id,
      facility_id, scope, purpose_of_use, status, reason, starts_at, expires_at, break_glass)
      values (gen_random_uuid(), $1, $2, $3, $4, $5, 'write_records', 'direct-care', 'active', 'Synthetic ward grant',
        now() - interval '5 minutes', now() + interval '1 hour', false)`,
    [id('400', n), id('200', doctor.n), id('100', doctor.n), id('300', doctor.n), facilityId]);
  }
  await client.query('set local session_replication_role = origin');
}

/** A DatabaseService whose transactions run as ehr-api's login role on one client (a savepoint each). */
function savepointDatabase(client: PoolClient): DatabaseService {
  let savepoint = 0;
  return {
    withTransaction: async <Result>(context: DataAccessContext, operation: (given: PoolClient) => Promise<Result>) => {
      const name = `inpatient_pg_${savepoint += 1}`;
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
}

/** A DatabaseService whose every transaction is its own committed transaction on its own client. */
function committedDatabase(pool: Pool): DatabaseService {
  return {
    withTransaction: async <Result>(context: DataAccessContext, operation: (given: PoolClient) => Promise<Result>) => {
      const client = await pool.connect();
      try {
        await client.query('begin');
        await client.query('set local role hid_ehr_api_runtime');
        await client.query(`select set_config('app.actor_subject', $1, true), set_config('app.facility_id', $2, true),
          set_config('app.correlation_id', $3, true), set_config('app.membership_id', $4, true),
          set_config('app.purpose_of_use', $5, true)`, [context.actor.subject, context.facilityId, context.correlationId,
          context.membershipId, context.purposeOfUse]);
        const result = await operation(client);
        await client.query('commit');
        return result;
      } catch (error) {
        await client.query('rollback');
        throw error;
      } finally {
        client.release();
      }
    },
  } as unknown as DatabaseService;
}

describeRehearsal('ADT-1 inpatient admission on PostgreSQL (0170-0173)', () => {
  const prefix = 'a1701';
  const { id, organizationId, facilityId } = ids(prefix);
  const as = (member: Member, purpose?: string) => contextFor(facilityId, organizationId, id, member, purpose);
  let pool: Pool;
  let client: PoolClient;
  let service: InpatientService;

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, max: 1 });
    client = await pool.connect();
    await client.query('begin');
    await seed(client, prefix, 3);
    service = new InpatientService(savepointDatabase(client));
  });

  afterAll(async () => {
    await client?.query('rollback');
    client?.release();
    await pool?.end();
  });

  it('a facility admin sets up a ward, its beds and its staff list', async () => {
    const created = await service.createWard(as(admin, 'healthcare-operations'),
      { name: 'Female Medical Ward', wardType: 'general', takes: 'female' }, key('ward')) as { ward: { wardId: string } };
    expect(created.ward).toMatchObject({ name: 'Female Medical Ward', wardType: 'general', takes: 'female', bedCount: 0 });
    for (const [n, name] of [[1, 'Bed 1'], [2, 'Bed 2']] as const) {
      await service.createBed(as(admin, 'healthcare-operations'), created.ward.wardId, { name }, key(`bed-${n}`));
    }
    const staffed = await service.setWardStaff(as(admin, 'healthcare-operations'), created.ward.wardId,
      { expectedRowVersion: 3, membershipIds: [id('300', nurse.n), id('300', doctor.n)] }, key('staff')) as
      { ward: { staffCount: number; bedCount: number } };
    expect(staffed.ward).toMatchObject({ staffCount: 2, bedCount: 2 });
    await expect(service.createWard(as(nurse, 'healthcare-operations'), { name: 'Another Ward', wardType: 'general' },
      key('ward-nurse'))).rejects.toMatchObject({ code: 'WARD_SETUP_NOT_ALLOWED' });
  });

  it('a doctor requests, a nurse gives a bed, the board hides the name from the nurse, the doctor discharges', async () => {
    const wards = await service.listWards(as(nurse), false, true) as { items: { wardId: string; beds: { bedId: string;
      name: string; rowVersion: number }[] }[] };
    const ward = wards.items[0]!;
    const bed = ward.beds.find((entry) => entry.name === 'Bed 1')!;
    const requested = await service.request(as(doctor), { patientId: id('400', 1), source: 'direct',
      reason: 'Pneumonia (fictional)', responsibleMembershipId: id('300', doctor.n), requestedWardId: ward.wardId } as
      RequestAdmissionDto, key('request')) as { admission: { admissionId: string; rowVersion: number; status: string;
      admissionNumber: string; billId: unknown } };
    expect(requested.admission).toMatchObject({ status: 'requested', billId: null });
    expect(requested.admission.admissionNumber).toMatch(/^A-\d{4}-000001$/);
    const admitted = await service.admit(as(nurse), requested.admission.admissionId,
      { expectedRowVersion: requested.admission.rowVersion, bedId: bed.bedId }, key('admit')) as
      { admission: { status: string; rowVersion: number; bedName: string } };
    expect(admitted.admission).toMatchObject({ status: 'admitted', bedName: 'Bed 1' });
    const board = await service.bedBoard(as(nurse), ward.wardId, undefined) as { wards: { beds: { name: string;
      patient: { nameHidden: boolean; fullName: unknown; initials: string } | null }[] }[] };
    expect(board.wards[0]!.beds.find((entry) => entry.name === 'Bed 1')!.patient)
      .toMatchObject({ nameHidden: true, fullName: null, initials: 'P W' });
    expect(JSON.stringify(board)).not.toMatch(/HID-|Wardpg1/);
    const band = await service.wristband(as(nurse), requested.admission.admissionId, {}, key('band'), false) as
      { healthId: string; printNumber: number };
    expect(band).toMatchObject({ printNumber: 1 });
    expect(band.healthId).toMatch(/^HID-/);
    const discharged = await service.discharge(as(doctor), requested.admission.admissionId,
      { expectedRowVersion: admitted.admission.rowVersion, outcome: 'dama', signature: 'SIGN',
        summary: { presentingProblem: 'Cough (fictional)', courseInHospital: 'Left against advice (fictional)' } } as
      DischargeDto, key('discharge')) as { admission: { status: string }; summaryNoteId: string };
    expect(discharged.admission.status).toBe('discharged');
    expect(discharged.summaryNoteId).toMatch(/^[0-9a-f-]{36}$/);
    const census = await service.census(as(nurse), undefined) as { facility: Record<string, number> };
    expect(census.facility).toMatchObject({ beds: 2, cleaning: 1, admitted: 1, discharged: 1 });
  });
});

describeRehearsal('ADT-1 one patient per bed under a race (two sessions, committed rows)', () => {
  // A fresh prefix each run (hex), so committed rows of an earlier run never clash.
  const prefix = `a${randomUUID().slice(0, 4)}`;
  const { id, organizationId, facilityId } = ids(prefix);
  const as = (member: Member, purpose?: string) => contextFor(facilityId, organizationId, id, member, purpose);
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, max: 4 });
    const client = await pool.connect();
    try {
      await client.query('begin');
      await seed(client, prefix, 2);
      await client.query('commit');
    } finally {
      client.release();
    }
  });

  afterAll(async () => {
    await pool?.end();
  });

  it('two admits to the same free bed at once: exactly one wins, the other finds the bed taken', async () => {
    const service = new InpatientService(committedDatabase(pool));
    const ward = await service.createWard(as(admin, 'healthcare-operations'), { name: 'Race Ward', wardType: 'general' },
      key(`race-ward-${prefix}`)) as { ward: { wardId: string } };
    const bed = await service.createBed(as(admin, 'healthcare-operations'), ward.ward.wardId, { name: 'Bed 1' },
      key(`race-bed-${prefix}`)) as { bedId: string };
    const admissions = [];
    for (const n of [1, 2]) {
      admissions.push(await service.request(as(doctor), { patientId: id('400', n), source: 'direct',
        reason: 'Observation (fictional)', responsibleMembershipId: id('300', doctor.n) } as RequestAdmissionDto,
      key(`race-request-${prefix}-${n}`)) as { admission: { admissionId: string; rowVersion: number } });
    }
    const results = await Promise.allSettled(admissions.map((answer, index) => service.admit(as(nurse),
      answer.admission.admissionId, { expectedRowVersion: answer.admission.rowVersion, bedId: bed.bedId },
      key(`race-admit-${prefix}-${index}`))));
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const refused = results.find((result) => result.status === 'rejected') as PromiseRejectedResult;
    expect(refused.reason).toMatchObject({ code: 'BED_NOT_AVAILABLE' });
  });
});
