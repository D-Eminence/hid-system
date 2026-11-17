import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import type { ActorContext, FacilityAssignment } from '../common/request-context';
import { getEnvironment } from '../config/environment';
import { DatabaseService } from '../database/database.service';

/**
 * A staff member's chosen facility, kept per sign-in (0129, port of main 0089;
 * STAFF_FACILITY_SELECTION_MODE). The choice grants nothing: every request
 * still names its facility in X-Facility-ID, which SecurityGuard checks against
 * the actor's active memberships, and every read re-checks the stored facility
 * against the actor's facilities as resolved on that request.
 */
export const FACILITY_SELECTION_TABLE = 'auth.session_facility_selection';

/**
 * The one event logged when a choice cannot be read or stored. It carries no
 * identifier and no SQL diagnostic (no session, account, facility or
 * correlation id), only which operation failed.
 */
export const FACILITY_SELECTION_UNAVAILABLE_EVENT = 'auth.facility_selection.unavailable';

/**
 * Whether an actor's sign-in keeps a facility choice: a staff session of an
 * Identity sign-in (a session id; an OIDC bearer caller has none) with at
 * least one facility on its site. Patients, account-only outreach sessions
 * (Q88-2) and a staff login with no facility on this site (a platform
 * administrator) keep none, and get no read and no field.
 */
export function keepsFacilityChoice(actor: ActorContext): actor is ActorContext & { sessionId: string } {
  return actor.kind !== 'patient' && actor.accountOnly !== true
    && typeof actor.sessionId === 'string' && actor.sessionId.length > 0
    && actor.facilities.length > 0;
}

/** The actor working at one of its facilities, with that membership's roles and permissions, as SecurityGuard binds it. */
export function actorAtFacility(actor: ActorContext, facility: FacilityAssignment): ActorContext {
  return { ...actor, facility, roles: facility.roles, role: facility.roles[0], permissions: facility.permissions };
}

/**
 * The start-up check's one read: whether the table exists, and each of the
 * three privileges the runtime needs on it, asked separately (one
 * has_table_privilege call naming several privileges is true when ANY of them
 * is held). For a missing table every privilege is null, never an error.
 */
export const FACILITY_SELECTION_STARTUP_SQL = `select target.oid is not null as present,
       has_table_privilege(target.oid, 'SELECT') as can_select,
       has_table_privilege(target.oid, 'INSERT') as can_insert,
       has_table_privilege(target.oid, 'UPDATE') as can_update
  from (select to_regclass('auth.session_facility_selection')::oid as oid) target`;

interface StartupRow {
  present: boolean | null;
  can_select: boolean | null;
  can_insert: boolean | null;
  can_update: boolean | null;
}

const PRIVILEGES = [['SELECT', 'can_select'], ['INSERT', 'can_insert'], ['UPDATE', 'can_update']] as const;

/**
 * With STAFF_FACILITY_SELECTION_MODE keep or ask, Identity refuses to start
 * while 0129's table or any one of its SELECT, INSERT and UPDATE grants is
 * missing: the deploy then fails its health checks and rolls back, and the
 * running tasks keep serving. It refuses only on a definite false. A database
 * it cannot reach at boot is not one: that is left to GET /health/ready,
 * rather than a crash loop. With the setting off it reads nothing.
 */
@Injectable()
export class FacilitySelectionStartupCheck implements OnModuleInit {
  private readonly logger = new Logger(FacilitySelectionStartupCheck.name);

  constructor(private readonly database: DatabaseService) {}

  async onModuleInit(): Promise<void> {
    const mode = getEnvironment().STAFF_FACILITY_SELECTION_MODE;
    if (mode === 'off') return;
    let row: StartupRow | undefined;
    try {
      row = (await this.database.query<StartupRow>(FACILITY_SELECTION_STARTUP_SQL)).rows[0];
    } catch {
      // No SQL diagnostics or identifiers may enter service logs.
      this.logger.warn({ event: 'auth.facility_selection.startup_check_unavailable' });
      return;
    }
    if (row?.present === false) {
      throw new Error(`STAFF_FACILITY_SELECTION_MODE is ${mode}, but ${FACILITY_SELECTION_TABLE} does not exist: `
        + 'apply migration 0129 first, or set STAFF_FACILITY_SELECTION_MODE=off');
    }
    const missing = PRIVILEGES.filter(([, column]) => row?.[column] === false).map(([privilege]) => privilege);
    if (missing.length > 0) {
      throw new Error(`STAFF_FACILITY_SELECTION_MODE is ${mode}, but the Identity runtime lacks ${missing.join(', ')} `
        + `on ${FACILITY_SELECTION_TABLE}: apply migration 0129's grants, or set STAFF_FACILITY_SELECTION_MODE=off`);
    }
  }
}
