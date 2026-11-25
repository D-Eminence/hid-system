/**
 * ED-1 (0168, 0169): the board's service and its SQL on PostgreSQL, not on a
 * fake client.
 *
 * Runs only when EHR_ED_BOARD_REHEARSAL_URL names a disposable rehearsal
 * database whose name ends in `_rehearsal` or `_joined`, with 0001-0151, 0168
 * and 0169 applied and the runtime roles bootstrapped (skipped otherwise, so
 * CI without one is unchanged). Everything runs in one transaction that is
 * rolled back. The service and its SQL are the real ones; only
 * DatabaseService.withTransaction is replaced by a savepoint on that
 * transaction that sets ehr-api's login role and the request context, as the
 * real one does. Fictional data only; ids start e1681.
 */
import { Pool, type PoolClient } from 'pg';
import type { DataAccessContext } from '../../common/request-context';
import { resetEnvironmentForTests } from '../../config/environment';
import type { DatabaseService } from '../../database/database.service';
import { VisitQueueService } from '../worklist/visit-queue.service';
import { EdBoardService } from './ed-board.service';

const url = process.env.EHR_ED_BOARD_REHEARSAL_URL;
const rehearsal = url !== undefined && /\/[A-Za-z0-9_]*_(rehearsal|joined)(\?|$)/.test(url);
const describeRehearsal = rehearsal ? describe : describe.skip;

const facilityId = 'e1681000-0000-4000-8000-000000000002';
const organizationId = 'e1681000-0000-4000-8000-000000000001';
const desk = { n: 1, role: 'receptionist' };
const nurse = { n: 2, role: 'nurse' };
const doctor = { n: 3, role: 'doctor' };
const id = (block: string, n: number) => `e1681${block}-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ownPatient = id('400', 1);
const strangerPatient = id('400', 2);
const key = (label: string) => `ed-board-pg-key-${label}`;

function contextFor(member: { n: number; role: string }): DataAccessContext {
  const membershipId = id('300', member.n);
  return {
    correlationId: `ed-board-pg-${member.n}`, facilityId, membershipId, purposeOfUse: 'direct-care',
    actor: { id: id('100', member.n), subject: `synthetic:ed-board-pg-${member.n}`, accountId: id('100', member.n),
      roles: [member.role], permissions: [], facilityIds: [facilityId], facilities: [],
      facility: { id: facilityId, membershipId, organizationId, name: 'Board PG Clinic', roles: [member.role],
        permissions: [], isPrimary: true } },
  } as unknown as DataAccessContext;
}

const originalEnvironment = { ...process.env };
/** ED_BOARD_ENABLED as the waiting list reads it (the board's own service is called directly here). */
function boardEnabled(on: boolean): void {
  Object.assign(process.env, { NODE_ENV: 'test', DATABASE_URL: 'postgresql://ehr:test@localhost:5432/hid',
    CORS_ORIGINS: 'http://localhost:3000', STORAGE_MODE: 'disabled', ED_BOARD_ENABLED: on ? 'true' : 'false' });
  resetEnvironmentForTests();
}

describeRehearsal('ED-1 the emergency department board on PostgreSQL (0168, 0169)', () => {
  let pool: Pool;
  let client: PoolClient;
  let board: EdBoardService;
  let queue: VisitQueueService;

  beforeAll(async () => {
    boardEnabled(true);
    pool = new Pool({ connectionString: url, max: 1 });
    client = await pool.connect();
    await client.query('begin');
    await client.query('set local session_replication_role = replica');
    await client.query(`insert into identity.purpose_of_use_codes (code, display, source_system)
      values ('direct-care', 'Direct patient care', 'ed-board-pg') on conflict (code) do update set active = true`);
    await client.query(`insert into identity.organizations (id, name, slug) values ($1, 'Board PG Group', 'board-pg-group')`,
      [organizationId]);
    await client.query(`insert into identity.facilities (id, organization_id, name, code, timezone, active, lifecycle_status)
      values ($1, $2, 'Board PG Clinic', 'BOARD-PG', 'Africa/Lagos', true, 'verified')`, [facilityId, organizationId]);
    for (const member of [desk, nurse, doctor]) {
      await client.query(`insert into auth.accounts (id, subject, email, display_name, status)
        values ($1, $2, $3, $4, 'active')`, [id('100', member.n), `synthetic:ed-board-pg-${member.n}`,
        `ed-board-pg-${member.n}@example.invalid`, `Board PG ${member.role}`]);
      await client.query(`insert into identity.staff (id, account_id, full_name, email, verification_status, default_role)
        values ($1, $2, $3, $4, 'verified', $5)`, [id('200', member.n), id('100', member.n), `Board PG ${member.role}`,
        `ed-board-pg-${member.n}@example.invalid`, member.role]);
      await client.query(`insert into identity.staff_facility_memberships (id, staff_id, account_id, organization_id,
        facility_id, membership_role, app_role, is_primary, active) values ($1, $2, $3, $4, $5, $6, $6, true, true)`,
        [id('300', member.n), id('200', member.n), id('100', member.n), organizationId, facilityId, member.role]);
      await client.query(`insert into auth.account_roles (id, account_id, role_code, scope_type, membership_id, facility_id,
        grant_reason) values (gen_random_uuid(), $1, $2, 'facility', $3, $4, 'Synthetic board role')`,
        [id('100', member.n), member.role, id('300', member.n), facilityId]);
    }
    for (const [patientId, hid, first, last, source] of [
      [ownPatient, 'HID-EPAA22', 'Bola', 'Boardown', 'hid-desk-registration'],
      [strangerPatient, 'HID-EPAB22', 'Chidi', 'Boardstranger', 'hid'],
    ] as const) {
      await client.query(`insert into identity.patients (id, hid_code, first_name, last_name, full_name, gender, dob, status,
        source_system) values ($1, $2, $3, $4, $3 || ' ' || $4, 'female', date '1990-01-02', 'active', $5)`,
      [patientId, hid, first, last, source]);
    }
    // The own patient: registered at this desk without a NIN (0130).
    await client.query(`insert into identity.registration_cases (id, facility_id, created_by_account_id,
      created_by_membership_id, status, first_name, last_name, full_name, dob, identity_evidence, no_nin_reason,
      idempotency_key, request_sha256, resolved_patient_id, review_idempotency_key, review_request_sha256,
      reviewed_by_account_id, reviewed_by_membership_id, review_reason, created_at, updated_at)
      values ($1, $2, $3, $4, 'approved_new_identity', 'Bola', 'Boardown', 'Bola Boardown', date '1990-01-02', 'none',
        'no_nin', 'ed-board-pg-case-0001', repeat('0', 64), $5, 'ed-board-pg-review-0001', repeat('0', 64), $3, $4,
        'Checked at the desk', now() - interval '30 days', now() - interval '30 days')`,
    [id('500', 1), facilityId, id('100', desk.n), id('300', desk.n), ownPatient]);
    await client.query('set local session_replication_role = origin');

    let savepoint = 0;
    const database = {
      withTransaction: async <Result>(context: DataAccessContext, operation: (given: PoolClient) => Promise<Result>) => {
        const name = `ed_board_pg_${savepoint += 1}`;
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
    board = new EdBoardService(database);
    queue = new VisitQueueService(database);
  });

  afterAll(async () => {
    for (const name of Object.keys(process.env)) if (!(name in originalEnvironment)) delete process.env[name];
    Object.assign(process.env, originalEnvironment);
    resetEnvironmentForTests();
    await client?.query('rollback');
    client?.release();
    await pool?.end();
  });

  it('puts this facility\'s own patient on the board, and refuses a stranger with the one answer', async () => {
    const answer = await board.arrive(contextFor(nurse), { patientId: ownPatient, arrivalMode: 'ambulance', triageLevel: 2,
      presentingComplaint: 'Fall from motorcycle' }, key('arrive-own'));
    expect(answer).toMatchObject({ outcome: 'arrived', replayed: false, attendance: { fullName: 'Bola Boardown',
      arrivalBasis: 'own-facility', column: 'waiting', stage: 'ready', triageLevel: 2,
      presentingComplaint: 'Fall from motorcycle', complaintHidden: false, status: 'open', rowVersion: 1 } });
    expect(JSON.stringify(answer)).not.toContain('HID-');
    await expect(board.arrive(contextFor(nurse), { patientId: ownPatient, arrivalMode: 'ambulance', triageLevel: 2,
      presentingComplaint: 'Fall from motorcycle' }, key('arrive-own'))).resolves.toMatchObject({ replayed: true });
    await expect(board.arrive(contextFor(desk), { patientId: strangerPatient, arrivalMode: 'walk_in' }, key('arrive-stranger')))
      .rejects.toMatchObject({ code: 'ED_ARRIVAL_NEEDS_SEARCH' });
    await expect(board.arrive(contextFor(desk), { patientId: ownPatient, arrivalMode: 'walk_in', triageLevel: 1 },
      key('arrive-desk-triage'))).rejects.toMatchObject({ code: 'ED_TRIAGE_NOT_ALLOWED' });
  });

  it('shows the board, the complaint only to nurses, clinicians and doctors, and marks the waiting list', async () => {
    const nurseBoard = await board.board(contextFor(nurse), false);
    expect(nurseBoard.counts).toEqual({ waiting: 1, beingSeen: 0, disposition: 0 });
    expect(nurseBoard.items[0]).toMatchObject({ presentingComplaint: 'Fall from motorcycle', complaintHidden: false });
    const deskBoard = await board.board(contextFor(desk), false);
    expect(deskBoard.items[0]).toMatchObject({ presentingComplaint: null, complaintHidden: true });
    const list = await queue.list(contextFor(desk), false);
    expect(list.items.map((item) => [item.fullName, item.edAttendanceId]))
      .toEqual([['Bola Boardown', nurseBoard.items[0]?.attendanceId]]);
  });

  it('starts care, records a decision and lets the patient leave, with the row version', async () => {
    const [card] = (await board.board(contextFor(doctor), false)).items;
    const started = await board.move(contextFor(doctor), card!.attendanceId,
      { expectedRowVersion: card!.rowVersion, stage: 'with_clinician', assignedMembershipId: id('300', doctor.n) },
      key('start-care'));
    expect(started.attendance).toMatchObject({ column: 'being_seen', assignedMembershipId: id('300', doctor.n), rowVersion: 2 });
    await expect(board.move(contextFor(nurse), card!.attendanceId, { expectedRowVersion: 1, stage: 'ready' },
      key('stale'))).rejects.toMatchObject({ code: 'ED_VERSION_CONFLICT' });
    await expect(board.disposition(contextFor(nurse), card!.attendanceId, { expectedRowVersion: 2, outcome: 'discharged' },
      key('nurse-decides'))).rejects.toMatchObject({ code: 'ED_DISPOSITION_NOT_ALLOWED' });
    const decided = await board.disposition(contextFor(doctor), card!.attendanceId,
      { expectedRowVersion: 2, outcome: 'discharged' }, key('discharge'));
    expect(decided.attendance).toMatchObject({ column: 'disposition', status: 'decided',
      disposition: { outcome: 'discharged', admitToDepartmentCode: null } });
    const left = await board.leave(contextFor(nurse), card!.attendanceId, { expectedRowVersion: 3 }, key('leave'));
    expect(left.attendance).toMatchObject({ column: 'closed', status: 'closed', stage: 'finished' });
    const record = await board.read(contextFor(desk), card!.attendanceId);
    expect(record.history.map((entry) => entry.kind)).toEqual(['arrived', 'moved', 'disposition', 'left']);
    expect((await board.board(contextFor(desk), false)).items).toEqual([]);
    expect((await board.board(contextFor(desk), true)).items.map((item) => item.status)).toEqual(['closed']);
  });

  it('with the board switched off after use, the waiting list finishes a board patient\'s row and closes the record',
    async () => {
      const arrived = await board.arrive(contextFor(nurse), { patientId: ownPatient, arrivalMode: 'walk_in' }, key('arrive-again'));
      const attendanceId = arrived.attendance.attendanceId;
      const [row] = (await queue.list(contextFor(desk), false)).items;
      expect(row?.edAttendanceId).toBe(attendanceId);
      await expect(queue.update(contextFor(desk), row!.entryId, { expectedRowVersion: row!.rowVersion, stage: 'finished' }))
        .rejects.toMatchObject({ code: 'VISIT_QUEUE_ON_ED_BOARD' });
      boardEnabled(false);
      try {
        const [plain] = (await queue.list(contextFor(desk), false)).items;
        expect(plain).toMatchObject({ entryId: row!.entryId, edAttendanceId: null });
        const finished = await queue.update(contextFor(desk), row!.entryId,
          { expectedRowVersion: plain!.rowVersion, stage: 'finished' });
        expect(finished).toMatchObject({ stage: 'finished', edAttendanceId: null });
        expect(finished.closedAt).not.toBeNull();
      } finally {
        boardEnabled(true);
      }
      const record = await board.read(contextFor(desk), attendanceId);
      expect(record.attendance).toMatchObject({ status: 'closed', column: 'closed' });
      expect(record.history.map((entry) => entry.kind)).toEqual(['arrived', 'closed_on_waiting_list']);
      const audited = await client.query(`select count(*)::integer as count from audit.events
        where action = 'ehr.ed.closed-on-waiting-list' and resource_id = $1 and details ->> 'boardOff' = 'true'`,
      [attendanceId]);
      expect(audited.rows[0].count).toBe(1);
    });

  it('writes no name, Health ID or complaint into any audit row', async () => {
    const leaked = await client.query(`select count(*)::integer as count from audit.events
      where facility_id = $1 and action like 'ehr.ed.%' and details::text ~* 'boardown|HID-EP|motorcycle'`, [facilityId]);
    expect(leaked.rows[0].count).toBe(0);
  });
});
