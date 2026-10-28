import { type BeforeApplicationShutdown, Injectable, Logger } from '@nestjs/common';
import { AFTER_RESPONSE_SHUTDOWN_GRACE_MS, AfterResponseTasks } from '../common/after-response-tasks';
import type { DataAccessContext } from '../common/request-context';
import { DatabaseService } from '../database/database.service';
import type { AuthorizationDecision } from './identity.types';

/** At most this many patient:facility:day keys are remembered; the map is cleared when it is full or the Lagos day changes. */
export const RECORD_ACCESS_NOTICE_MEMORY = 10_000;

const LAGOS_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Lagos', year: 'numeric', month: '2-digit', day: '2-digit' });

/** The Africa/Lagos calendar day of an instant, YYYY-MM-DD. */
export function lagosDay(at: Date): string {
  return LAGOS_DAY.format(at);
}

/**
 * "Your records were opened" (B4, migration 0095, D9). After a staff
 * authorization allowed by a consent grant that is not break-glass, this
 * notes the access once per patient, facility and Africa/Lagos day:
 * identity.note_record_access writes the inbox notice (naming the facility)
 * and queues the email (naming nothing), at most 10 a day per patient.
 * Break-glass is left out (it already notifies), and so are denied attempts
 * and anything without a grant. The note runs after the answer, in its own
 * short transaction in the same staff context: the read never waits for it
 * or fails because of it, and only an error code is logged. An in-process
 * map skips the calls already made today.
 */
@Injectable()
export class RecordAccessNoticeService implements BeforeApplicationShutdown {
  private readonly logger = new Logger(RecordAccessNoticeService.name);
  private readonly tasks = new AfterResponseTasks(this.logger, 'Records-opened notice could not be written');
  private readonly noted = new Set<string>();
  private day = lagosDay(new Date());

  constructor(private readonly database: DatabaseService) {}

  /** Waits for the notes started so far (tests). */
  settle(): Promise<void> {
    return this.tasks.settle();
  }

  beforeApplicationShutdown(): Promise<void> {
    return this.tasks.settle(AFTER_RESPONSE_SHUTDOWN_GRACE_MS);
  }

  /** Called after every staff authorization decision; does nothing unless D9 applies. */
  afterAuthorization(context: DataAccessContext, patientId: string, decision: AuthorizationDecision): void {
    if (!decision.allowed || !decision.consentGrantId || decision.breakGlass) return;
    if (context.actor.kind === 'patient' || !context.facilityId || !context.membershipId) return;
    const today = lagosDay(new Date());
    if (today !== this.day || this.noted.size >= RECORD_ACCESS_NOTICE_MEMORY) {
      this.noted.clear();
      this.day = today;
    }
    const key = `${patientId}:${context.facilityId}:${today}`;
    if (this.noted.has(key)) return;
    const grantId = decision.consentGrantId;
    this.tasks.run(context.correlationId, async () => {
      try {
        const outcome = await this.database.withTransaction(context, async (client) => (await client.query<{ outcome: string }>(
          'select identity.note_record_access($1) as outcome', [grantId])).rows[0]?.outcome);
        if (outcome === 'noted' || outcome === 'already_noted' || outcome === 'capped') this.noted.add(key);
      } catch (error) {
        // Never the driver's message: it can carry identifiers.
        const code = typeof (error as { code?: unknown })?.code === 'string' ? (error as { code: string }).code : 'unknown';
        this.logger.warn(`Records-opened notice not written (code=${code}, correlation=${context.correlationId})`);
      }
    });
  }
}
