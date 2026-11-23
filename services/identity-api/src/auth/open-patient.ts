import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { getEnvironment } from '../config/environment';
import { DatabaseService } from '../database/database.service';
import { isDatabaseError } from '../patient-safety/database-error';

/**
 * The patient a staff sign-in has open, kept across a reload (SX-8, 0140;
 * STAFF_OPEN_PATIENT_ENABLED). One row per sign-in, as 0129's facility choice
 * is, at one facility, for at most 8 hours. The row grants nothing: Identity
 * stores it only after the read_records access check allows it, and every
 * session read that finds it checks again; every chart read still names its
 * facility and goes through the access check.
 */
export const OPEN_PATIENT_TABLE = 'auth.session_open_patient';

/** The longest an open patient is kept: the staff sign-in's own longest life. */
export const OPEN_PATIENT_HOURS = 8;

/**
 * The one event logged when the open patient cannot be read, stored or
 * cleared. It carries no identifier and no SQL diagnostic, only which
 * operation failed.
 */
export const OPEN_PATIENT_UNAVAILABLE_EVENT = 'auth.open_patient.unavailable';

/** 0140's guard refusal of a row it does not admit (raised with SQLSTATE 23514). */
export const OPEN_PATIENT_INVALID = 'SESSION_OPEN_PATIENT_INVALID';

/** Whether STAFF_OPEN_PATIENT_ENABLED is on (read each time, so tests can change it). */
export function openPatientEnabled(): boolean {
  return getEnvironment().STAFF_OPEN_PATIENT_ENABLED;
}

/**
 * A move to another facility (POST /auth/facility) clears the sign-in's open
 * patient kept at any other facility, in the same transaction as 0129's
 * choice is stored, in every 0129 mode. $1 is the presented session, $2 its
 * account, $3 the facility moved to. Through the presented session of the
 * account only, never by family id from the request.
 */
export const OPEN_PATIENT_CLEAR_ELSEWHERE_SQL = `delete from auth.session_open_patient open_patient
  using auth.sessions session
 where session.id = $1
   and session.account_id = $2
   and open_patient.family_id = session.family_id
   and open_patient.account_id = session.account_id
   and open_patient.facility_id <> $3`;

const clearLogger = new Logger('OpenPatientClear');

/**
 * Runs OPEN_PATIENT_CLEAR_ELSEWHERE_SQL on the move's transaction under a
 * savepoint: a missing table or grant (42P01, 42501: 0140 not applied, or
 * applied without its grants) is rolled back to the savepoint and logged once
 * with no diagnostic, so it never rolls back the facility move itself. With
 * no table nothing can be stored, so nothing is left to clear. Any other
 * failure is rethrown, and the move's transaction is rolled back as before.
 */
export async function clearOpenPatientElsewhere(client: PoolClient, sessionId: string, accountId: string,
  facilityId: string): Promise<void> {
  await client.query('savepoint open_patient_clear_elsewhere');
  try {
    await client.query(OPEN_PATIENT_CLEAR_ELSEWHERE_SQL, [sessionId, accountId, facilityId]);
  } catch (error) {
    if (!isDatabaseError(error) || (error.code !== '42P01' && error.code !== '42501')) throw error;
    await client.query('rollback to savepoint open_patient_clear_elsewhere');
    clearLogger.warn({ event: OPEN_PATIENT_UNAVAILABLE_EVENT, operation: 'clear_elsewhere' });
  }
  await client.query('release savepoint open_patient_clear_elsewhere');
}

/** 0140 D6: the patient existence check POST /auth/open-patient asks first. */
export const OPEN_PATIENT_TARGET_FUNCTION = 'auth.session_open_patient_target_exists(uuid)';

/**
 * The start-up check's one read: whether the table exists, each of the four
 * privileges the runtime needs on it, asked separately (one
 * has_table_privilege call naming several privileges is true when ANY of them
 * is held), and EXECUTE on D6's existence check. For a missing table or
 * function the privilege is null, never an error.
 */
export const OPEN_PATIENT_STARTUP_SQL = `select target.oid is not null as present,
       has_table_privilege(target.oid, 'SELECT') as can_select,
       has_table_privilege(target.oid, 'INSERT') as can_insert,
       has_table_privilege(target.oid, 'UPDATE') as can_update,
       has_table_privilege(target.oid, 'DELETE') as can_delete,
       has_function_privilege(to_regprocedure('${OPEN_PATIENT_TARGET_FUNCTION}')::oid, 'EXECUTE') as can_check_patient
  from (select to_regclass('auth.session_open_patient')::oid as oid) target`;

interface StartupRow {
  present: boolean | null;
  can_select: boolean | null;
  can_insert: boolean | null;
  can_update: boolean | null;
  can_delete: boolean | null;
  can_check_patient: boolean | null;
}

const PRIVILEGES = [['SELECT', 'can_select'], ['INSERT', 'can_insert'], ['UPDATE', 'can_update'],
  ['DELETE', 'can_delete']] as const;

/** How many times the start-up read is tried, and the pause between tries. */
export const OPEN_PATIENT_STARTUP_ATTEMPTS = 5;
export const OPEN_PATIENT_STARTUP_RETRY_MS = 2_000;

/**
 * With STAFF_OPEN_PATIENT_ENABLED=true, Identity refuses to start unless it
 * has a definite answer that 0140's table and each of its SELECT, INSERT,
 * UPDATE and DELETE grants are there: the deploy then fails its health checks
 * and rolls back, and the running tasks keep serving. A failed read is tried
 * again, OPEN_PATIENT_STARTUP_ATTEMPTS times in all, OPEN_PATIENT_STARTUP_RETRY_MS
 * apart; a database still unreachable after the last one also refuses (unlike
 * 0129's check, which leaves that to GET /health/ready: a task that became
 * ready without the table would answer every facility move with 503). With
 * the setting off it reads nothing.
 */
@Injectable()
export class OpenPatientStartupCheck implements OnModuleInit {
  private readonly logger = new Logger(OpenPatientStartupCheck.name);

  constructor(private readonly database: DatabaseService) {}

  async onModuleInit(): Promise<void> {
    if (!openPatientEnabled()) return;
    let row: StartupRow | undefined;
    for (let attempt = 1; row === undefined; attempt += 1) {
      try {
        row = (await this.database.query<StartupRow>(OPEN_PATIENT_STARTUP_SQL)).rows[0];
        if (row === undefined) throw new Error('no answer');
      } catch {
        // No SQL diagnostics or identifiers may enter service logs.
        this.logger.warn({ event: 'auth.open_patient.startup_check_unavailable', attempt });
        if (attempt >= OPEN_PATIENT_STARTUP_ATTEMPTS) {
          throw new Error(`STAFF_OPEN_PATIENT_ENABLED is true, but whether ${OPEN_PATIENT_TABLE} and its grants are `
            + `there could not be read after ${OPEN_PATIENT_STARTUP_ATTEMPTS} attempts: Identity does not start `
            + 'without that answer');
        }
        await this.pause(OPEN_PATIENT_STARTUP_RETRY_MS);
      }
    }
    if (row.present !== true) {
      throw new Error(`STAFF_OPEN_PATIENT_ENABLED is true, but ${OPEN_PATIENT_TABLE} does not exist: `
        + 'apply migration 0140 first, or set STAFF_OPEN_PATIENT_ENABLED=false');
    }
    const missing = PRIVILEGES.filter(([, column]) => row?.[column] !== true).map(([privilege]) => privilege);
    if (missing.length > 0) {
      throw new Error(`STAFF_OPEN_PATIENT_ENABLED is true, but the Identity runtime lacks ${missing.join(', ')} `
        + `on ${OPEN_PATIENT_TABLE}: apply migration 0140's grants, or set STAFF_OPEN_PATIENT_ENABLED=false`);
    }
    if (row.can_check_patient !== true) {
      throw new Error(`STAFF_OPEN_PATIENT_ENABLED is true, but the Identity runtime cannot execute `
        + `${OPEN_PATIENT_TARGET_FUNCTION}: apply migration 0140 and its grants, or set STAFF_OPEN_PATIENT_ENABLED=false`);
    }
  }

  /** The pause between tries (a method, so a test can make it immediate). */
  protected pause(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }
}
