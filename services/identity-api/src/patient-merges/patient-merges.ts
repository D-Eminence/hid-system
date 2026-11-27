import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { getEnvironment } from '../config/environment';
import { DatabaseService } from '../database/database.service';

/**
 * ID-8a (0207): merge requests and the review list. A member asks to merge
 * this facility's unknown (ID-7) or NIN Not Verified record that nobody signs
 * in to into the record behind their own direct-care search matchRef; an
 * approver refuses, the member who asked cancels. Nothing moves: ID-8b (0208)
 * carries out the merge and the 30-day undo, and until it is there the
 * approve and undo routes answer 503 MERGE_UNAVAILABLE.
 * PATIENT_MERGE_REQUESTS_ENABLED switches the routes on.
 */

/** Whether PATIENT_MERGE_REQUESTS_ENABLED is on (read each time, so tests can change it). */
export function patientMergeRequestsEnabled(): boolean {
  return getEnvironment().PATIENT_MERGE_REQUESTS_ENABLED;
}

/** The five functions 0207 grants to the Identity runtime. */
export const PATIENT_MERGE_FUNCTIONS = Object.freeze([
  'identity.request_patient_merge(uuid,text,text,text,text)',
  'identity.list_patient_merges(text,text,integer,timestamp with time zone,uuid)',
  'identity.read_patient_merge(uuid)',
  'identity.refuse_patient_merge(uuid,bigint,text,text,text)',
  'identity.cancel_patient_merge(uuid,bigint,text,text)',
] as const);

/**
 * ID-8b's two commands, by name (0208 is not written yet, so its signatures
 * are not known here). While neither exists, approve and undo answer 503
 * MERGE_UNAVAILABLE.
 */
export const PATIENT_MERGE_ID8B_FUNCTIONS = Object.freeze({
  approve: 'approve_patient_merge',
  undo: 'undo_patient_merge',
} as const);

/**
 * The start-up check's one read: EXECUTE on each of 0207's five functions,
 * asked separately. For a missing function the answer is null, never an
 * error.
 */
export const PATIENT_MERGE_STARTUP_SQL = `select ${PATIENT_MERGE_FUNCTIONS.map((signature, index) =>
  `has_function_privilege(to_regprocedure('${signature}')::oid, 'EXECUTE') as function_${index}`).join(',\n       ')}`;

/** How many times the start-up read is tried, and the pause between tries. */
export const PATIENT_MERGE_STARTUP_ATTEMPTS = 5;
export const PATIENT_MERGE_STARTUP_RETRY_MS = 2_000;

type StartupRow = Record<`function_${number}`, boolean | null>;

/**
 * With PATIENT_MERGE_REQUESTS_ENABLED=true, Identity refuses to start unless
 * it has a definite answer that it may execute each of 0207's five functions:
 * the deploy then fails its health checks and rolls back, and the running
 * tasks keep serving. A failed read is tried again,
 * PATIENT_MERGE_STARTUP_ATTEMPTS times in all, PATIENT_MERGE_STARTUP_RETRY_MS
 * apart; a database still unreachable after the last one also refuses (as
 * OpenPatientStartupCheck). With the setting off it reads nothing.
 */
@Injectable()
export class PatientMergeStartupCheck implements OnModuleInit {
  private readonly logger = new Logger(PatientMergeStartupCheck.name);

  constructor(private readonly database: DatabaseService) {}

  async onModuleInit(): Promise<void> {
    if (!patientMergeRequestsEnabled()) return;
    let row: StartupRow | undefined;
    for (let attempt = 1; row === undefined; attempt += 1) {
      try {
        row = (await this.database.query<StartupRow>(PATIENT_MERGE_STARTUP_SQL)).rows[0];
        if (row === undefined) throw new Error('no answer');
      } catch {
        // No SQL diagnostics or identifiers may enter service logs.
        this.logger.warn({ event: 'identity.patient_merge.startup_check_unavailable', attempt });
        if (attempt >= PATIENT_MERGE_STARTUP_ATTEMPTS) {
          throw new Error('PATIENT_MERGE_REQUESTS_ENABLED is true, but whether 0207\'s functions and grants are there '
            + `could not be read after ${PATIENT_MERGE_STARTUP_ATTEMPTS} attempts: Identity does not start without that answer`);
        }
        await this.pause(PATIENT_MERGE_STARTUP_RETRY_MS);
      }
    }
    const missing = PATIENT_MERGE_FUNCTIONS.filter((_signature, index) => row?.[`function_${index}`] !== true);
    if (missing.length > 0) {
      throw new Error(`PATIENT_MERGE_REQUESTS_ENABLED is true, but the Identity runtime cannot execute ${missing.join(', ')}: `
        + 'apply migration 0207 and its grants, or set PATIENT_MERGE_REQUESTS_ENABLED=false');
    }
  }

  /** The pause between tries (a method, so a test can make it immediate). */
  protected pause(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }
}
