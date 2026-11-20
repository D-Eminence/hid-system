import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { getEnvironment } from '../config/environment';
import { DatabaseService } from '../database/database.service';

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

/**
 * The start-up check's one read: whether the table exists, and each of the
 * four privileges the runtime needs on it, asked separately (one
 * has_table_privilege call naming several privileges is true when ANY of them
 * is held). For a missing table every privilege is null, never an error.
 */
export const OPEN_PATIENT_STARTUP_SQL = `select target.oid is not null as present,
       has_table_privilege(target.oid, 'SELECT') as can_select,
       has_table_privilege(target.oid, 'INSERT') as can_insert,
       has_table_privilege(target.oid, 'UPDATE') as can_update,
       has_table_privilege(target.oid, 'DELETE') as can_delete
  from (select to_regclass('auth.session_open_patient')::oid as oid) target`;

interface StartupRow {
  present: boolean | null;
  can_select: boolean | null;
  can_insert: boolean | null;
  can_update: boolean | null;
  can_delete: boolean | null;
}

const PRIVILEGES = [['SELECT', 'can_select'], ['INSERT', 'can_insert'], ['UPDATE', 'can_update'],
  ['DELETE', 'can_delete']] as const;

/**
 * With STAFF_OPEN_PATIENT_ENABLED=true, Identity refuses to start while
 * 0140's table or any one of its SELECT, INSERT, UPDATE and DELETE grants is
 * missing: the deploy then fails its health checks and rolls back, and the
 * running tasks keep serving. It refuses only on a definite false; a database
 * it cannot reach at boot is left to GET /health/ready, as 0129's check does.
 * With the setting off it reads nothing.
 */
@Injectable()
export class OpenPatientStartupCheck implements OnModuleInit {
  private readonly logger = new Logger(OpenPatientStartupCheck.name);

  constructor(private readonly database: DatabaseService) {}

  async onModuleInit(): Promise<void> {
    if (!openPatientEnabled()) return;
    let row: StartupRow | undefined;
    try {
      row = (await this.database.query<StartupRow>(OPEN_PATIENT_STARTUP_SQL)).rows[0];
    } catch {
      // No SQL diagnostics or identifiers may enter service logs.
      this.logger.warn({ event: 'auth.open_patient.startup_check_unavailable' });
      return;
    }
    if (row?.present === false) {
      throw new Error(`STAFF_OPEN_PATIENT_ENABLED is true, but ${OPEN_PATIENT_TABLE} does not exist: `
        + 'apply migration 0140 first, or set STAFF_OPEN_PATIENT_ENABLED=false');
    }
    const missing = PRIVILEGES.filter(([, column]) => row?.[column] === false).map(([privilege]) => privilege);
    if (missing.length > 0) {
      throw new Error(`STAFF_OPEN_PATIENT_ENABLED is true, but the Identity runtime lacks ${missing.join(', ')} `
        + `on ${OPEN_PATIENT_TABLE}: apply migration 0140's grants, or set STAFF_OPEN_PATIENT_ENABLED=false`);
    }
  }
}
