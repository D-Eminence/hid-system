/**
 * Review finding 6 (FR-1, EHR-C1, EHR-C3, EHR-C8a): the new SQL run on
 * PostgreSQL, not on a fake client.
 *
 * Runs only when EHR_SCRATCH_DATABASE_URL names an empty scratch database
 * whose name ends in `_scratch` (it is skipped otherwise, so CI without a
 * database is unchanged). It builds a small copy of the tables these
 * features read (the same column names, types and status checks as 0004 and
 * 0113, without the other schemas' foreign keys), with forced row-level
 * security shaped like the real policies: staff see their facility's rows;
 * the patient sees only completed visits and signed or amended notes; the
 * record_versions history is read under a facility policy and written by a
 * SECURITY DEFINER trigger, as `ehr.capture_record_version` is. The services
 * and their SQL are the real ones; only the clinical repository's `run` is
 * replaced by a real transaction that sets the role and context. It is not a
 * substitute for the full database suites; it checks the SQL these commits
 * add: the record_versions read, the `$3::text[]` binding, the advisory lock,
 * the Lagos day bounds, the jsonb paths of /vitals/latest, the replay
 * answer, the visit lock and the patient's note read.
 *
 * Fictional data only.
 */
import { Pool, type PoolClient } from 'pg';
import type { DataAccessContext } from '../../common/request-context';
import { ClinicalRepository } from './clinical.repository';
import { neverReachedBefore } from './change-reason';
import { requireVisitOpenForWork } from './visit-guard';
import { EncounterStatus, EncounterType } from './clinical.dto';
import { EncountersService } from '../encounters/encounters.service';
import { VitalsService } from '../vitals/vitals.service';
import { PatientRecordsService } from '../patient-records/patient-records.service';

const url = process.env.EHR_SCRATCH_DATABASE_URL;
const scratch = url !== undefined && /\/[A-Za-z0-9_]*_scratch(\?|$)/.test(url);
const describeScratch = scratch ? describe : describe.skip;

const patientId = '223e4567-e89b-42d3-a456-426614174001';
const facilityId = '223e4567-e89b-42d3-a456-426614174002';
const otherFacilityId = '223e4567-e89b-42d3-a456-426614174012';
const accountId = '223e4567-e89b-42d3-a456-426614174003';
const membershipId = '223e4567-e89b-42d3-a456-426614174004';

const SCHEMA = `
create schema ehr;
comment on schema ehr is 'wave1-clinical scratch';
create role wave1_runtime nologin;
grant usage on schema ehr to wave1_runtime;

create function ehr.ctx(name text) returns uuid language sql stable
  as $$ select nullif(current_setting('wave1.' || name, true), '')::uuid $$;

create table ehr.encounters (
  id uuid primary key default gen_random_uuid(), patient_id uuid not null, facility_id uuid not null,
  created_by uuid not null, created_by_membership_id uuid not null, encounter_number text,
  encounter_type text not null check (encounter_type in ('ambulatory', 'emergency', 'inpatient', 'virtual', 'home', 'other')),
  status text not null check (status in ('planned', 'in_progress', 'on_hold', 'completed', 'cancelled', 'entered_in_error')),
  started_at timestamptz not null, ended_at timestamptz, chief_complaint text,
  row_version bigint not null default 1, created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(), imported_paper_records boolean not null default false,
  unique (id, patient_id, facility_id),
  check ((status = 'completed' and ended_at is not null) or status <> 'completed'));
create table ehr.clinical_notes (
  id uuid primary key default gen_random_uuid(), encounter_id uuid not null, patient_id uuid not null,
  facility_id uuid not null, created_by uuid not null, created_by_membership_id uuid not null,
  note_type text not null, title text not null,
  status text not null default 'draft' check (status in ('draft', 'signed', 'amended', 'entered_in_error')),
  current_revision_no integer not null default 1, signed_at timestamptz, signed_by uuid,
  row_version bigint not null default 1, created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  foreign key (encounter_id, patient_id, facility_id) references ehr.encounters(id, patient_id, facility_id));
create table ehr.clinical_note_revisions (
  clinical_note_id uuid not null references ehr.clinical_notes(id), patient_id uuid not null, facility_id uuid not null,
  revision_no integer not null, content text not null, primary key (clinical_note_id, revision_no));
create table ehr.prescriptions (
  id uuid primary key default gen_random_uuid(), encounter_id uuid not null, patient_id uuid not null,
  facility_id uuid not null, created_by uuid not null, created_by_membership_id uuid not null,
  medication_display text not null,
  status text not null check (status in ('draft', 'active', 'on_hold', 'completed', 'cancelled', 'entered_in_error')),
  row_version bigint not null default 1, created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  foreign key (encounter_id, patient_id, facility_id) references ehr.encounters(id, patient_id, facility_id));
create table ehr.lab_requests (like ehr.prescriptions including defaults including constraints);
alter table ehr.lab_requests add primary key (id);
create table ehr.vitals (
  id uuid primary key default gen_random_uuid(), encounter_id uuid not null, patient_id uuid not null,
  facility_id uuid not null, recorded_at timestamptz not null,
  height_cm numeric(6,2), weight_kg numeric(7,3), temperature_c numeric(4,1), pulse_bpm smallint,
  respiratory_rate smallint, systolic_mmhg smallint, diastolic_mmhg smallint, oxygen_saturation_percent numeric(5,2),
  current_correction_no integer not null default 0, created_at timestamptz not null default clock_timestamp(),
  foreign key (encounter_id, patient_id, facility_id) references ehr.encounters(id, patient_id, facility_id));
create table ehr.vital_corrections (
  id uuid primary key default gen_random_uuid(), vital_id uuid not null references ehr.vitals(id),
  patient_id uuid not null, facility_id uuid not null, correction_no integer not null,
  replacement_values jsonb not null check (jsonb_typeof(replacement_values) = 'object'), unique (vital_id, correction_no));
create table ehr.idempotency_keys (
  id uuid primary key default gen_random_uuid(), facility_id uuid not null, patient_id uuid not null,
  created_by uuid not null, created_by_membership_id uuid not null, idempotency_key text not null,
  operation text not null, request_sha256 char(64) not null,
  state text not null default 'processing' check (state in ('processing', 'completed', 'failed')),
  result_resource_type text, result_resource_id text, response_status smallint,
  locked_until timestamptz not null, expires_at timestamptz not null, row_version bigint not null default 1,
  created_at timestamptz not null default clock_timestamp(), updated_at timestamptz not null default clock_timestamp(),
  unique (facility_id, created_by, operation, idempotency_key));
create table ehr.record_versions (
  id bigint generated always as identity primary key, resource_type text not null, resource_id text not null,
  version_no bigint not null, operation text not null check (operation in ('create', 'update')),
  patient_id uuid not null, facility_id uuid not null, changed_by uuid not null, correlation_id text not null,
  change_reason text not null, resulting_state jsonb not null, recorded_at timestamptz not null default clock_timestamp(),
  unique (resource_type, resource_id, version_no));

-- Shaped like ehr.capture_record_version (0004): SECURITY DEFINER, tg_table_name, row_version.
create function ehr.capture_record_version() returns trigger language plpgsql security definer
  set search_path = ehr, pg_temp as $$
begin
  if tg_op = 'INSERT' then new.row_version := 1; else new.row_version := old.row_version + 1; end if;
  new.updated_at := clock_timestamp();
  insert into ehr.record_versions (resource_type, resource_id, version_no, operation, patient_id, facility_id,
    changed_by, correlation_id, change_reason, resulting_state)
  values (tg_table_name, new.id::text, new.row_version, case when tg_op = 'INSERT' then 'create' else 'update' end,
    new.patient_id, new.facility_id, ehr.ctx('account'), current_setting('wave1.correlation'),
    coalesce(nullif(current_setting('app.change_reason', true), ''), 'create'), to_jsonb(new));
  return new;
end $$;
create trigger encounters_versioned before insert or update on ehr.encounters
  for each row execute function ehr.capture_record_version();
create trigger clinical_notes_versioned before insert or update on ehr.clinical_notes
  for each row execute function ehr.capture_record_version();
create trigger prescriptions_versioned before insert or update on ehr.prescriptions
  for each row execute function ehr.capture_record_version();
create trigger idempotency_keys_versioned before insert or update on ehr.idempotency_keys
  for each row execute function ehr.capture_record_version();

create function ehr.imported_paper_records_signed(uuid, uuid, uuid) returns boolean language sql stable as 'select false';

do $$
declare t text;
begin
  foreach t in array array['encounters', 'clinical_notes', 'clinical_note_revisions', 'prescriptions', 'lab_requests',
    'vitals', 'vital_corrections', 'idempotency_keys', 'record_versions'] loop
    execute format('alter table ehr.%I enable row level security', t);
    execute format('alter table ehr.%I force row level security', t);
    execute format('grant select, insert, update on ehr.%I to wave1_runtime', t);
    execute format('create policy staff_all on ehr.%I using (facility_id = ehr.ctx(''facility'')) '
      'with check (facility_id = ehr.ctx(''facility''))', t);
  end loop;
end $$;
-- 0030 / 0113: the patient sees completed visits and signed or amended notes.
create policy encounters_patient_self_read on ehr.encounters for select
  using (patient_id = ehr.ctx('patient') and status = 'completed');
create policy clinical_notes_patient_self_read on ehr.clinical_notes for select
  using (patient_id = ehr.ctx('patient') and status in ('signed', 'amended'));
create policy note_revisions_patient_self_read on ehr.clinical_note_revisions for select
  using (patient_id = ehr.ctx('patient'));
`;

type Session = { facility?: string; patient?: string; correlation: string };

function staffContext(correlationId: string, facility = facilityId): DataAccessContext {
  return { correlationId, facilityId: facility, membershipId, purposeOfUse: 'direct-care', authorization: 'Bearer user',
    actor: { id: accountId, subject: 'staff:test', accountId, authenticationMethod: 'local', roles: ['doctor'],
      permissions: [], facilityIds: [facility], facilities: [], facility: { id: facility, membershipId,
        organizationId: facility, name: 'Scratch', roles: ['doctor'], permissions: [], isPrimary: true } } } as never;
}

describeScratch('wave 1 clinical SQL on PostgreSQL (review finding 6)', () => {
  jest.setTimeout(30_000);
  let pool: Pool;

  async function inTransaction<T>(session: Session, work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query('set local role wave1_runtime');
      await client.query(`select set_config('wave1.facility', $1, true), set_config('wave1.patient', $2, true),
        set_config('wave1.account', $3, true), set_config('wave1.correlation', $4, true)`,
      [session.facility ?? '', session.patient ?? '', accountId, session.correlation]);
      const result = await work(client);
      await client.query('commit');
      return result;
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }

  /** The real ClinicalRepository's executeCreate and setChangeReason; `run` is a real staff transaction. */
  function scratchRepository() {
    const real = new ClinicalRepository({} as never, {} as never, {} as never);
    const pauses = new Map<string, Promise<void>>();
    const repository = {
      pauses,
      run: <Value>(context: DataAccessContext, _patientId: string, _access: string, _event: unknown,
        operation: (client: PoolClient) => Promise<{ value: Value }>): Promise<Value> =>
        inTransaction({ facility: context.facilityId, correlation: context.correlationId },
          async (client) => (await operation(client)).value),
      setChangeReason: real.setChangeReason.bind(real),
      executeCreate: (...args: Parameters<ClinicalRepository['executeCreate']>) => {
        const [client, context, patient, key, operation, digest, type, create, load] = args;
        return real.executeCreate(client, context, patient, key, operation, digest, type, async () => {
          await pauses.get(key);
          return create();
        }, load);
      },
    };
    return repository as typeof repository & ClinicalRepository;
  }

  async function insertVisit(status: string, startedAt: string, facility = facilityId, correlation = 'seed-visit-0001') {
    return inTransaction({ facility, correlation }, async (client) => (await client.query<{ id: string }>(
      `insert into ehr.encounters (patient_id, facility_id, created_by, created_by_membership_id, encounter_type, status,
         started_at, ended_at) values ($1, $2, $3, $4, 'ambulatory', $5, $6, case when $5 = 'completed' then $6::timestamptz end)
       returning id`, [patientId, facility, accountId, membershipId, status, startedAt])).rows[0]!.id);
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, max: 6 });
    const existing = await pool.query(`select obj_description(oid, 'pg_namespace') as marker
      from pg_namespace where nspname = 'ehr'`);
    if (existing.rows.length > 0 && existing.rows[0].marker !== 'wave1-clinical scratch') {
      throw new Error('EHR_SCRATCH_DATABASE_URL has a schema ehr that this spec did not make; refusing to touch it');
    }
    await pool.query('drop schema if exists ehr cascade');
    await pool.query('drop role if exists wave1_runtime');
    await pool.query(SCHEMA);
  });

  beforeEach(async () => {
    await pool.query(`truncate ehr.record_versions, ehr.idempotency_keys, ehr.vital_corrections, ehr.vitals,
      ehr.clinical_note_revisions, ehr.clinical_notes, ehr.prescriptions, ehr.lab_requests, ehr.encounters`);
  });

  afterAll(async () => {
    await pool.query('drop schema if exists ehr cascade');
    await pool.query('drop role if exists wave1_runtime');
    await pool.end();
  });

  it('(a) FR-1: a doctor\'s session reads its own note\'s create version; true for a draft, false after a sign', async () => {
    const visitId = await insertVisit('in_progress', '2026-11-18T08:00:00Z');
    const noteId = await inTransaction({ facility: facilityId, correlation: 'note-create-0001' }, async (client) =>
      (await client.query<{ id: string }>(`insert into ehr.clinical_notes (encounter_id, patient_id, facility_id,
        created_by, created_by_membership_id, note_type, title) values ($1, $2, $3, $4, $5, 'progress', 'Visit note')
        returning id`, [visitId, patientId, facilityId, accountId, membershipId])).rows[0]!.id);
    const check = (facility: string) => inTransaction({ facility, correlation: 'note-check-0001' },
      (client) => neverReachedBefore(client, 'clinical_notes', noteId, ['signed', 'amended']));
    await expect(check(facilityId)).resolves.toBe(true);
    // Another facility's session cannot see the history: fails closed.
    await expect(check(otherFacilityId)).resolves.toBe(false);
    await inTransaction({ facility: facilityId, correlation: 'note-sign-00001' }, async (client) => {
      await client.query(`select set_config('app.change_reason', 'First signature (no reason needed)', true)`);
      await client.query(`update ehr.clinical_notes set status = 'signed', signed_at = clock_timestamp(), signed_by = $2
        where id = $1`, [noteId, accountId]);
    });
    await expect(check(facilityId)).resolves.toBe(false);
  });

  it('(a) FR-1: a prescription held and put back to draft is not "first" (status array bound as text[])', async () => {
    const visitId = await insertVisit('in_progress', '2026-11-18T08:00:00Z');
    const id = await inTransaction({ facility: facilityId, correlation: 'rx-create-00001' }, async (client) =>
      (await client.query<{ id: string }>(`insert into ehr.prescriptions (encounter_id, patient_id, facility_id,
        created_by, created_by_membership_id, medication_display, status) values ($1, $2, $3, $4, $5, 'Paracetamol', 'draft')
        returning id`, [visitId, patientId, facilityId, accountId, membershipId])).rows[0]!.id);
    const first = () => inTransaction({ facility: facilityId, correlation: 'rx-check-000001' },
      (client) => neverReachedBefore(client, 'prescriptions', id, ['active', 'on_hold', 'completed']));
    await expect(first()).resolves.toBe(true);
    await inTransaction({ facility: facilityId, correlation: 'rx-hold-0000001' }, async (client) => {
      await client.query(`update ehr.prescriptions set status = 'on_hold' where id = $1`, [id]);
      await client.query(`update ehr.prescriptions set status = 'draft' where id = $1`, [id]);
    });
    await expect(first()).resolves.toBe(false);
  });

  const createBody = (startedAt: string) => ({ encounterType: EncounterType.Ambulatory, status: EncounterStatus.InProgress,
    startedAt, reuseOpenVisit: true });

  it('(b) EHR-C1: two reuseOpenVisit creates at the same moment give one visit', async () => {
    const service = new EncountersService(scratchRepository());
    service.now = () => new Date('2026-11-18T10:00:00Z');
    const results = await Promise.all([1, 2, 3].map((n) => service.create(staffContext(`double-tap-000${n}`), patientId,
      createBody('2026-11-18T09:59:00.000Z'), `visit-key-0000000${n}`)));
    const visits = await pool.query('select id from ehr.encounters');
    expect(visits.rows).toHaveLength(1);
    expect(new Set(results.map((row) => row.id)).size).toBe(1);
    expect(results.map((row) => row.reusedOpenVisit).sort()).toEqual([false, true, true]);
  });

  it('(b) EHR-C1 finding 5: a replay of a request whose key is older than the visit still answers reused', async () => {
    const repository = scratchRepository();
    const service = new EncountersService(repository);
    service.now = () => new Date('2026-11-18T10:00:00Z');
    // Request B writes its key, then waits (as if on the advisory lock) while request A creates the visit.
    let releaseB!: () => void;
    repository.pauses.set('visit-key-0000000b', new Promise<void>((resolve) => { releaseB = resolve; }));
    const b = service.create(staffContext('request-b-00001'), patientId, createBody('2026-11-18T09:59:00.000Z'),
      'visit-key-0000000b');
    await new Promise((resolve) => setTimeout(resolve, 200));
    const a = await service.create(staffContext('request-a-00001'), patientId, createBody('2026-11-18T09:59:00.000Z'),
      'visit-key-0000000a');
    releaseB();
    const answeredB = await b;
    expect(a.reusedOpenVisit).toBe(false);
    expect(answeredB).toMatchObject({ id: a.id, reusedOpenVisit: true });
    const times = await pool.query(`select (select created_at from ehr.idempotency_keys where idempotency_key = 'visit-key-0000000b')
      < (select created_at from ehr.encounters) as "keyOlder"`);
    expect(times.rows[0].keyOlder).toBe(true); // the case the old timestamp rule answered wrongly
    // The retries (replays) answer what the original requests answered.
    const replayB = await service.create(staffContext('request-b-retry'), patientId, createBody('2026-11-18T09:59:00.000Z'),
      'visit-key-0000000b');
    const replayA = await service.create(staffContext('request-a-retry'), patientId, createBody('2026-11-18T09:59:00.000Z'),
      'visit-key-0000000a');
    expect(replayB).toMatchObject({ id: a.id, reusedOpenVisit: true });
    expect(replayA).toMatchObject({ id: a.id, reusedOpenVisit: false });
  });

  it('(c) EHR-C1: visits at 23:59 and 00:01 Lagos time fall on different days', async () => {
    const late = await insertVisit('in_progress', '2026-11-18T22:59:00Z'); // 23:59 on the 18th in Lagos
    const early = await insertVisit('in_progress', '2026-11-18T23:01:00Z'); // 00:01 on the 19th in Lagos
    const service = new EncountersService(scratchRepository());
    service.now = () => new Date('2026-11-18T12:00:00Z');
    await expect(service.openToday(staffContext('open-today-0001'), patientId))
      .resolves.toMatchObject({ day: '2026-11-18', encounter: { id: late } });
    service.now = () => new Date('2026-11-19T12:00:00Z');
    await expect(service.openToday(staffContext('open-today-0002'), patientId))
      .resolves.toMatchObject({ day: '2026-11-19', encounter: { id: early } });
    service.now = () => new Date('2026-11-20T12:00:00Z');
    await expect(service.openToday(staffContext('open-today-0003'), patientId)).resolves.toMatchObject({ encounter: null });
  });

  it('(d) EHR-C3: /vitals/latest on a partly corrected reading and on a visit entered in error', async () => {
    const visitId = await insertVisit('completed', '2026-11-18T08:00:00Z');
    const wrongVisit = await insertVisit('entered_in_error', '2026-11-18T09:00:00Z');
    await inTransaction({ facility: facilityId, correlation: 'vitals-seed-001' }, async (client) => {
      const reading = (await client.query<{ id: string }>(`insert into ehr.vitals (encounter_id, patient_id, facility_id,
        recorded_at, weight_kg, pulse_bpm, systolic_mmhg, diastolic_mmhg, current_correction_no)
        values ($1, $2, $3, '2026-11-18T08:30:00Z', 70, 120, 150, 95, 1) returning id`,
      [visitId, patientId, facilityId])).rows[0]!.id;
      await client.query(`insert into ehr.vital_corrections (vital_id, patient_id, facility_id, correction_no,
        replacement_values) values ($1, $2, $3, 1, '{"pulse_bpm": 80, "diastolic_mmhg": 85}')`, [reading, patientId, facilityId]);
      // A newer reading on a visit entered in error is left out.
      await client.query(`insert into ehr.vitals (encounter_id, patient_id, facility_id, recorded_at, weight_kg, pulse_bpm)
        values ($1, $2, $3, '2026-11-18T09:30:00Z', 99, 99)`, [wrongVisit, patientId, facilityId]);
    });
    const latest = await new VitalsService(scratchRepository()).latest(staffContext('vitals-latest-1'), patientId);
    expect(latest.measures).toEqual({
      weightKg: expect.objectContaining({ value: 70, encounterId: visitId, corrected: false }),
      pulseBpm: expect.objectContaining({ value: 80, encounterId: visitId, corrected: true }),
      bloodPressure: expect.objectContaining({ value: { systolicMmhg: 150, diastolicMmhg: 85 }, corrected: true }),
    });
  });

  /** Transactions left open by a race below; a failed test rolls them back so nothing waits on them. */
  const openClients = new Set<PoolClient>();
  afterEach(async () => {
    for (const client of openClients) {
      await client.query('rollback').catch(() => undefined);
      client.release();
    }
    openClients.clear();
  });

  /** A staff transaction left open, for the races below. */
  async function openTransaction(correlation: string) {
    const client = await pool.connect();
    openClients.add(client);
    await client.query('begin');
    await client.query('set local role wave1_runtime');
    await client.query(`select set_config('wave1.facility', $1, true), set_config('wave1.account', $2, true),
      set_config('wave1.correlation', $3, true)`, [facilityId, accountId, correlation]);
    return { client, commit: async () => { await client.query('commit'); openClients.delete(client); client.release(); } };
  }
  const settledAfter = async (promise: Promise<unknown>, ms: number) => {
    let settled = false;
    promise.then(() => { settled = true; }, () => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, ms));
    return settled;
  };

  it('EHR-C8a finding 1: a signature holding the visit lock makes the visit change wait, then refuse', async () => {
    const visitId = await insertVisit('completed', '2026-11-17T08:00:00Z');
    const noteId = await inTransaction({ facility: facilityId, correlation: 'note-create-0002' }, async (client) =>
      (await client.query<{ id: string }>(`insert into ehr.clinical_notes (encounter_id, patient_id, facility_id,
        created_by, created_by_membership_id, note_type, title) values ($1, $2, $3, $4, $5, 'progress', 'Late note')
        returning id`, [visitId, patientId, facilityId, accountId, membershipId])).rows[0]!.id);
    const service = new EncountersService(scratchRepository());
    // The note path: the visit FOR SHARE, then the draft signed (an UPDATE: no foreign key lock on the visit).
    const sign = await openTransaction('note-sign-race01');
    await requireVisitOpenForWork(sign.client, patientId, facilityId, visitId);
    await sign.client.query(`update ehr.clinical_notes set status = 'signed', signed_at = clock_timestamp(), signed_by = $2
      where id = $1`, [noteId, accountId]);
    const change = service.update(staffContext('visit-eie-00001'), patientId, visitId,
      { expectedRowVersion: 1, status: EncounterStatus.EnteredInError, changeReason: 'Wrong patient chosen' });
    expect(await settledAfter(change, 300)).toBe(false); // waiting on the visit lock
    await sign.commit();
    await expect(change).rejects.toMatchObject({ status: 409, code: 'VISIT_HAS_SIGNED_NOTES' });
  });

  it('EHR-C8a finding 1: an order started while the visit is being entered in error waits, then is refused', async () => {
    const visitId = await insertVisit('completed', '2026-11-17T08:00:00Z');
    // The visit change: locked FOR UPDATE and entered in error, not yet committed.
    const change = await openTransaction('visit-eie-race01');
    await change.client.query(`select 1 from ehr.encounters where id = $1 for update`, [visitId]);
    await change.client.query(`select set_config('app.change_reason', 'Wrong patient chosen', true)`);
    await change.client.query(`update ehr.encounters set status = 'entered_in_error' where id = $1`, [visitId]);
    // The order path: the visit check, then a new active prescription.
    const order = inTransaction({ facility: facilityId, correlation: 'rx-race-0000002' }, async (client) => {
      await requireVisitOpenForWork(client, patientId, facilityId, visitId);
      await client.query(`insert into ehr.prescriptions (encounter_id, patient_id, facility_id, created_by,
        created_by_membership_id, medication_display, status) values ($1, $2, $3, $4, $5, 'Ibuprofen', 'active')`,
      [visitId, patientId, facilityId, accountId, membershipId]);
    });
    expect(await settledAfter(order, 300)).toBe(false); // the FOR SHARE read waits for the visit change
    await change.commit();
    await expect(order).rejects.toMatchObject({ status: 409, code: 'VISIT_ENTERED_IN_ERROR' });
    expect((await pool.query('select count(*)::int as n from ehr.prescriptions')).rows[0].n).toBe(0);
  });

  it('EHR-C8a finding 1: a draft order still blocks; once cancelled the visit can be entered in error', async () => {
    const visitId = await insertVisit('completed', '2026-11-17T08:00:00Z');
    await inTransaction({ facility: facilityId, correlation: 'rx-create-00003' }, (client) => client.query(
      `insert into ehr.lab_requests (encounter_id, patient_id, facility_id, created_by, created_by_membership_id,
        medication_display, status) values ($1, $2, $3, $4, $5, 'Full blood count', 'draft')`,
      [visitId, patientId, facilityId, accountId, membershipId]));
    const service = new EncountersService(scratchRepository());
    const enter = (n: number) => service.update(staffContext(`visit-eie-0000${n}`), patientId, visitId,
      { expectedRowVersion: 1, status: EncounterStatus.EnteredInError, changeReason: 'Wrong patient chosen' });
    await expect(enter(3)).rejects.toMatchObject({ status: 409, code: 'VISIT_HAS_OPEN_ORDERS' });
    await inTransaction({ facility: facilityId, correlation: 'lab-cancel-0001' },
      (client) => client.query(`update ehr.lab_requests set status = 'cancelled'`));
    await expect(enter(4)).resolves.toMatchObject({ status: 'entered_in_error' });
  });

  it('EHR-C8a finding 2: the patient still sees notes of an open visit; the emergency read leaves out a visit in error '
    + '(the patient still sees a note of a visit entered in error before it was completed: the known gap, as before)', async () => {
    const open = await insertVisit('in_progress', '2026-11-18T08:00:00Z');
    const done = await insertVisit('completed', '2026-11-17T08:00:00Z');
    const wrong = await insertVisit('entered_in_error', '2026-11-16T08:00:00Z');
    await inTransaction({ facility: facilityId, correlation: 'notes-seed-0001' }, async (client) => {
      for (const [visit, title] of [[open, 'Open visit note'], [done, 'Completed visit note'], [wrong, 'Wrong visit note']]) {
        const note = (await client.query<{ id: string }>(`insert into ehr.clinical_notes (encounter_id, patient_id,
          facility_id, created_by, created_by_membership_id, note_type, title, status, signed_at, signed_by)
          values ($1, $2, $3, $4, $5, 'progress', $6, 'signed', clock_timestamp(), $4) returning id`,
        [visit, patientId, facilityId, accountId, membershipId, title])).rows[0]!.id;
        await client.query(`insert into ehr.clinical_note_revisions (clinical_note_id, patient_id, facility_id, revision_no,
          content) values ($1, $2, $3, 1, 'Fictional text')`, [note, patientId, facilityId]);
      }
    });
    const records = new PatientRecordsService({} as never, {} as never, {} as never, {} as never);
    const read = (records as unknown as { read: (c: PoolClient, p: string, f?: string) => Promise<{ notes: { title: string }[] }> })
      .read.bind(records);
    // Only the visit and note reads go to PostgreSQL; the imported-records reads are not part of this check.
    const twoReads = (client: PoolClient) => {
      let count = 0;
      return { query: (sql: string, values: unknown[]) => (count++ < 2 ? client.query(sql, values) : { rows: [] }) } as never;
    };
    const patientTitles = await inTransaction({ patient: patientId, correlation: 'patient-read-01' },
      async (client) => (await read(twoReads(client), patientId)).notes.map((note) => note.title).sort());
    expect(patientTitles).toEqual(['Completed visit note', 'Open visit note', 'Wrong visit note']);
    const emergencyTitles = await inTransaction({ facility: facilityId, correlation: 'emergency-read1' },
      async (client) => (await read(twoReads(client), patientId, facilityId)).notes.map((note) => note.title).sort());
    expect(emergencyTitles).toEqual(['Completed visit note', 'Open visit note']);
  });
});
