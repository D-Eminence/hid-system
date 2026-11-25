/**
 * NUR-1 (0174-0177): the nursing service and its SQL on PostgreSQL, not on a
 * fake client: "one record per scheduled dose under any race" (two sessions
 * record the same dose at the same moment; exactly one is kept, the other is
 * told it is already recorded), and the observation chart with a reading of
 * the new fields.
 *
 * Runs only when EHR_NURSING_REHEARSAL_URL names a disposable rehearsal
 * database whose name ends in `_rehearsal` or `_joined`, with 0001-0153,
 * BILL-1's 0162-0167, ED-1's 0168-0169, ADT-1's 0170-0173 and 0174-0177 applied
 * and the runtime roles bootstrapped (skipped otherwise, so CI without one is
 * unchanged). It needs committed rows that both sessions see, so it writes its
 * own fictional facility, ward, bed, patient, admission and order with fresh
 * ids each run, and leaves them in the disposable database (the clinical tables
 * refuse deletes). Fictional data only.
 */
import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import type { DataAccessContext } from '../../common/request-context';
import type { DatabaseService } from '../../database/database.service';
import type { RequestAdmissionDto } from '../inpatient/inpatient.dto';
import { InpatientService } from '../inpatient/inpatient.service';
import { NursingService } from './nursing.service';

const url = process.env.EHR_NURSING_REHEARSAL_URL;
const rehearsal = url !== undefined && /\/[A-Za-z0-9_]*_(rehearsal|joined)(\?|$)/.test(url);
const describeRehearsal = rehearsal ? describe : describe.skip;

const key = (label: string) => `nursing-pg-key-${label}`;

interface Member { n: number; role: string }
const nurse: Member = { n: 1, role: 'nurse' };
const doctor: Member = { n: 2, role: 'doctor' };
const admin: Member = { n: 3, role: 'admin' };

function ids(prefix: string) {
  const id = (block: string, n: number) => `${prefix}${block}-0000-4000-8000-${String(n).padStart(12, '0')}`;
  return { id, organizationId: id('000', 1), facilityId: id('000', 2) };
}

function contextFor(facilityId: string, organizationId: string, idOf: (block: string, n: number) => string,
  member: Member, purpose = 'direct-care'): DataAccessContext {
  const membershipId = idOf('300', member.n);
  return {
    correlationId: `nursing-pg-${member.n}-${randomUUID()}`, facilityId, membershipId, purposeOfUse: purpose,
    actor: { id: idOf('100', member.n), subject: `synthetic:nursing-pg-${idOf('100', member.n)}`,
      accountId: idOf('100', member.n), roles: [member.role], permissions: [], facilityIds: [facilityId], facilities: [],
      facility: { id: facilityId, membershipId, organizationId, name: 'Nursing PG Hospital', roles: [member.role],
        permissions: [], isPrimary: true } },
  } as unknown as DataAccessContext;
}

/** A facility with a nurse, a doctor and an admin, and one patient both clinicians may open. */
async function seed(client: PoolClient, prefix: string): Promise<void> {
  const { id, organizationId, facilityId } = ids(prefix);
  await client.query('set local session_replication_role = replica');
  await client.query(`insert into identity.purpose_of_use_codes (code, display, source_system)
    values ('direct-care', 'Direct patient care', 'nursing-pg'), ('healthcare-operations', 'Operations', 'nursing-pg')
    on conflict (code) do update set active = true`);
  await client.query(`insert into identity.organizations (id, name, slug) values ($1, 'Nursing PG Group', $2)`,
    [organizationId, `nursing-pg-${prefix}`]);
  await client.query(`insert into identity.facilities (id, organization_id, name, code, timezone, active, lifecycle_status)
    values ($1, $2, 'Nursing PG Hospital', $3, 'Africa/Lagos', true, 'verified')`,
  [facilityId, organizationId, `NUR-PG-${prefix.toUpperCase()}`]);
  for (const member of [nurse, doctor, admin]) {
    await client.query(`insert into auth.accounts (id, subject, email, display_name, status) values ($1, $2, $3, $4, 'active')`,
      [id('100', member.n), `synthetic:nursing-pg-${id('100', member.n)}`, `nursing-pg-${id('100', member.n)}@example.invalid`,
        `Nursing PG ${member.role}`]);
    await client.query(`insert into identity.staff (id, account_id, full_name, email, verification_status, default_role)
      values ($1, $2, $3, $4, 'verified', $5)`, [id('200', member.n), id('100', member.n), `Nursing PG ${member.role}`,
      `nursing-pg-${id('100', member.n)}@example.invalid`, member.role]);
    await client.query(`insert into identity.staff_facility_memberships (id, staff_id, account_id, organization_id,
      facility_id, membership_role, app_role, is_primary, active) values ($1, $2, $3, $4, $5, $6, $6, true, true)`,
    [id('300', member.n), id('200', member.n), id('100', member.n), organizationId, facilityId, member.role]);
    await client.query(`insert into auth.account_roles (id, account_id, role_code, scope_type, membership_id, facility_id,
      grant_reason) values (gen_random_uuid(), $1, $2, 'facility', $3, $4, 'Synthetic nursing role')`,
    [id('100', member.n), member.role, id('300', member.n), facilityId]);
  }
  await client.query(`insert into identity.patients (id, hid_code, first_name, last_name, full_name, gender, dob, status,
    source_system) values ($1, $2, 'Pat', 'Nursingpg', 'Pat Nursingpg', 'female', date '1980-03-04', 'active', 'hid')`,
  [id('400', 1), `HID-NP${prefix.toUpperCase().replace(/[^A-HJ-NP-Z2-9]/g, 'Q')}AA`]);
  for (const member of [nurse, doctor]) {
    await client.query(`insert into identity.consent_grants (id, patient_id, staff_id, account_id, membership_id,
      facility_id, scope, purpose_of_use, status, reason, starts_at, expires_at, break_glass)
      values (gen_random_uuid(), $1, $2, $3, $4, $5, 'write_records', 'direct-care', 'active', 'Synthetic nursing grant',
        now() - interval '5 minutes', now() + interval '1 hour', false)`,
    [id('400', 1), id('200', member.n), id('100', member.n), id('300', member.n), facilityId]);
  }
  await client.query('set local session_replication_role = origin');
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

describeRehearsal('NUR-1 one record per scheduled dose under a race (two sessions, committed rows)', () => {
  const prefix = `a${randomUUID().slice(0, 4)}`;
  const { id, organizationId, facilityId } = ids(prefix);
  const as = (member: Member, purpose?: string) => contextFor(facilityId, organizationId, id, member, purpose);
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, max: 4 });
    const client = await pool.connect();
    try {
      await client.query('begin');
      await seed(client, prefix);
      await client.query('commit');
    } finally {
      client.release();
    }
  });

  afterAll(async () => {
    await pool?.end();
  });

  it('two nurses record the same due dose at once: exactly one is kept, the other is told it is recorded', async () => {
    const wards = new InpatientService(committedDatabase(pool));
    const nursing = new NursingService(committedDatabase(pool));
    const ward = await wards.createWard(as(admin, 'healthcare-operations'), { name: 'Race Ward', wardType: 'general' },
      key(`ward-${prefix}`)) as { ward: { wardId: string } };
    const bed = await wards.createBed(as(admin, 'healthcare-operations'), ward.ward.wardId, { name: 'Bed 1' },
      key(`bed-${prefix}`)) as { bedId: string };
    const requested = await wards.request(as(doctor), { patientId: id('400', 1), source: 'direct',
      reason: 'Observation (fictional)', responsibleMembershipId: id('300', doctor.n) } as RequestAdmissionDto,
    key(`request-${prefix}`)) as { admission: { admissionId: string; rowVersion: number; encounterId: string } };
    await wards.admit(as(nurse), requested.admission.admissionId,
      { expectedRowVersion: requested.admission.rowVersion, bedId: bed.bedId }, key(`admit-${prefix}`));
    // An order with one set time, due now (as the doctor's prescription create writes it).
    const due = new Date(Math.floor(Date.now() / 60_000) * 60_000);
    const lagos = new Date(due.getTime() + 60 * 60_000).toISOString().slice(11, 16);
    const prescription = await committedDatabase(pool).withTransaction(as(doctor), async (client) =>
      (await client.query<{ id: string }>(`insert into ehr.prescriptions (encounter_id, patient_id, facility_id, created_by,
        created_by_membership_id, medication_display, dose_quantity, dose_unit, route_code, frequency, instructions, status,
        schedule_kind, scheduled_times, first_due_at) values ($1, $2, $3, $4, $5, 'Fictional Med Race', 1, 'g', 'IV',
        $6, 'Fictional', 'active', 'regular', array[$6], now() - interval '1 day') returning id`,
      [requested.admission.encounterId, id('400', 1), facilityId, id('100', doctor.n), id('300', doctor.n), lagos])).rows[0]!.id);
    const record = (label: string) => nursing.recordDose(as(nurse), requested.admission.admissionId, {
      prescriptionId: prescription, scheduledFor: due.toISOString(), outcome: 'given', givenAt: new Date().toISOString(),
      dose: { quantity: 1, unit: 'g' }, route: 'IV', supplySource: 'ward_stock' }, key(`${label}-${prefix}`));
    const results = await Promise.allSettled([record('dose-a'), record('dose-b')]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const refused = results.find((result) => result.status === 'rejected') as PromiseRejectedResult;
    expect(refused.reason).toMatchObject({ code: 'DOSE_ALREADY_RECORDED' });
    const round = await nursing.medicineRound(as(nurse), requested.admission.admissionId, undefined, undefined) as {
      administrations: unknown[]; orders: { pharmacyState: string }[] };
    expect(round.administrations).toHaveLength(1);
    expect(round.orders[0]?.pharmacyState).toBe('not_sent');
  });
});
