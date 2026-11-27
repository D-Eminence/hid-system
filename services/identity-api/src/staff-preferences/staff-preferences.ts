import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { FACILITY_MODULE_RULES, facilityModules, type FacilityModuleKey } from '../auth/facility-modules';
import { getEnvironment } from '../config/environment';
import { DatabaseService } from '../database/database.service';

/**
 * SX-7 (0206): a staff member's language (per account) and up to 12 Home
 * shortcuts (per membership). STAFF_PREFERENCES_ENABLED switches the three
 * routes on; SX-5's canChange.preferences follows it.
 */

/** Whether STAFF_PREFERENCES_ENABLED is on (read each time, so tests can change it). */
export function staffPreferencesEnabled(): boolean {
  return getEnvironment().STAFF_PREFERENCES_ENABLED;
}

/** The languages a member may choose: English only until P2-2 adds translations. */
export const STAFF_LANGUAGES = Object.freeze(['en'] as const);

/** The most shortcuts a membership keeps (0206's CHECK holds the same bound). */
export const STAFF_SHORTCUTS_MAX = 12;

/**
 * The notice choices, answered and never stored: ORD-11 (0159) is not built
 * and reads no preference, so `served` is false and the save refuses
 * `notices` (VALIDATION_FAILED). A critical result always notifies.
 */
export const STAFF_NOTICE_DEFAULTS = Object.freeze({
  served: false,
  labResultReady: true,
  prescriptionDispensed: true,
  criticalResult: true,
  criticalResultCanChange: false,
});

/**
 * The keys a shortcut may name: SX-1's module keys, in their order. Read from
 * FACILITY_MODULE_RULES, so a key a department adds there is accepted with no
 * change here; 0206 stores any key of the shape ^[a-z][A-Za-z]{1,39}$.
 */
export const SHORTCUT_MODULE_KEYS: readonly FacilityModuleKey[] = Object.freeze(FACILITY_MODULE_RULES.map((rule) => rule.key));

/** 0206's staff_shortcut_keys_valid shape: letters only, so no UUID, Health ID or match reference. */
export const SHORTCUT_KEY_SHAPE = /^[a-z][A-Za-z]{1,39}$/;

/** Whether a string is one of SX-1's module keys. */
export function isShortcutModuleKey(value: string): value is FacilityModuleKey {
  return (SHORTCUT_MODULE_KEYS as readonly string[]).includes(value);
}

/**
 * Whether a saved shortcut can be opened now: the key is one of SX-1's and
 * the membership's permissions at this facility show its area. A key no
 * longer known (a rollback to an older image) is answered unavailable, never
 * an error.
 *
 * TODO(SX-6): once the session states the product site it was issued on,
 * also answer false for an area another product's site serves (lab,
 * pharmacy, migrate, outreach), as the design note's open question 7 asks.
 */
export function shortcutAvailable(module: string, permissions: readonly string[]): boolean {
  return isShortcutModuleKey(module) && facilityModules(permissions)[module] === true;
}

/** The three functions 0206 grants to the Identity runtime. */
export const STAFF_PREFERENCES_FUNCTIONS = Object.freeze([
  'identity.read_my_staff_preferences()',
  'identity.save_my_staff_preferences(text,bigint,text,text)',
  'identity.save_my_staff_shortcuts(text[],bigint,text,text)',
] as const);

/**
 * The start-up check's one read: EXECUTE on each of 0206's three functions,
 * asked separately. For a missing function the answer is null, never an
 * error.
 */
export const STAFF_PREFERENCES_STARTUP_SQL = `select ${STAFF_PREFERENCES_FUNCTIONS.map((signature, index) =>
  `has_function_privilege(to_regprocedure('${signature}')::oid, 'EXECUTE') as function_${index}`).join(',\n       ')}`;

/** How many times the start-up read is tried, and the pause between tries. */
export const STAFF_PREFERENCES_STARTUP_ATTEMPTS = 5;
export const STAFF_PREFERENCES_STARTUP_RETRY_MS = 2_000;

type StartupRow = Record<`function_${number}`, boolean | null>;

/**
 * With STAFF_PREFERENCES_ENABLED=true, Identity refuses to start unless it
 * has a definite answer that it may execute each of 0206's three functions:
 * the deploy then fails its health checks and rolls back, and the running
 * tasks keep serving. A failed read is tried again,
 * STAFF_PREFERENCES_STARTUP_ATTEMPTS times in all, STAFF_PREFERENCES_STARTUP_RETRY_MS
 * apart; a database still unreachable after the last one also refuses (as
 * OpenPatientStartupCheck). With the setting off it reads nothing.
 */
@Injectable()
export class StaffPreferencesStartupCheck implements OnModuleInit {
  private readonly logger = new Logger(StaffPreferencesStartupCheck.name);

  constructor(private readonly database: DatabaseService) {}

  async onModuleInit(): Promise<void> {
    if (!staffPreferencesEnabled()) return;
    let row: StartupRow | undefined;
    for (let attempt = 1; row === undefined; attempt += 1) {
      try {
        row = (await this.database.query<StartupRow>(STAFF_PREFERENCES_STARTUP_SQL)).rows[0];
        if (row === undefined) throw new Error('no answer');
      } catch {
        // No SQL diagnostics or identifiers may enter service logs.
        this.logger.warn({ event: 'identity.staff_preferences.startup_check_unavailable', attempt });
        if (attempt >= STAFF_PREFERENCES_STARTUP_ATTEMPTS) {
          throw new Error('STAFF_PREFERENCES_ENABLED is true, but whether 0206\'s functions and grants are there could '
            + `not be read after ${STAFF_PREFERENCES_STARTUP_ATTEMPTS} attempts: Identity does not start without that answer`);
        }
        await this.pause(STAFF_PREFERENCES_STARTUP_RETRY_MS);
      }
    }
    const missing = STAFF_PREFERENCES_FUNCTIONS.filter((_signature, index) => row?.[`function_${index}`] !== true);
    if (missing.length > 0) {
      throw new Error(`STAFF_PREFERENCES_ENABLED is true, but the Identity runtime cannot execute ${missing.join(', ')}: `
        + 'apply migration 0206 and its grants, or set STAFF_PREFERENCES_ENABLED=false');
    }
  }

  /** The pause between tries (a method, so a test can make it immediate). */
  protected pause(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }
}
