import { Injectable } from '@nestjs/common';
import type { QueryResultRow } from 'pg';
import { AuditService } from '../../audit/audit.service';
import { DomainProblem } from '../../common/problem';
import type { DataAccessContext } from '../../common/request-context';
import { DatabaseService } from '../../database/database.service';
import { OCR_JOB_LIST_DEFAULT_LIMIT, type OcrJobListQueryDto, type OcrJobStatus } from './ocr-job-list.dto';

interface JobListRow extends QueryResultRow {
  id: string;
  document_id: string;
  status: OcrJobStatus;
  created_at: Date;
  /** created_at in UTC to the microsecond, for the next page's cursor (a Date keeps milliseconds only). */
  cursor_at: string;
  created_by_membership_id: string;
  attempt_count: number;
  max_attempts: number;
  completed_at: Date | null;
  failed_at: Date | null;
  last_error_code: string | null;
}

interface Cursor { at: string; id: string }

const CURSOR_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const OCR_JOB_LIST_CURSOR_INVALID = 'OCR_JOB_LIST_CURSOR_INVALID';

/**
 * The list reads ocr.jobs alone, under the request's facility (row-level
 * security, 0013 ocr_jobs_staff) and an explicit facility filter as well. It
 * selects no patient column and joins no patient or document table: a job
 * is opened with GET ocr/jobs/:jobId, which checks access to its patient.
 */
export const OCR_JOB_LIST_SQL = `select id::text, document_id::text, status, created_at,
         to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as cursor_at,
         created_by_membership_id::text, attempt_count, max_attempts, completed_at, failed_at, last_error_code
    from ocr.jobs
   where facility_id = $1::uuid
     and ($2::text is null or status = $2::text)
     and ($3::uuid is null or created_by_membership_id = $3::uuid)
     and ($4::timestamptz is null or (created_at, id) < ($4::timestamptz, $5::uuid))
   order by created_at desc, id desc
   limit $6`;

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(`${cursor.at}|${cursor.id}`, 'utf8').toString('base64url');
}

/** The cursor a page answered with, or 400: never a value the database would read as anything else. */
export function decodeCursor(value: string): Cursor {
  const [at, id, extra] = Buffer.from(value, 'base64url').toString('utf8').split('|');
  if (extra !== undefined || !at || !id || !CURSOR_AT.test(at) || !UUID.test(id) || Number.isNaN(Date.parse(at))) {
    throw new DomainProblem(400, OCR_JOB_LIST_CURSOR_INVALID, 'This page of the list can no longer be opened. Start the list again.');
  }
  return { at, id };
}

/**
 * SX-9 (Akos P1-10): this facility's OCR jobs, newest first, paged, so the
 * Migrate desk keeps its work after the page is left. It changes no job;
 * purpose healthcare-operations. Each answer is audited (ocr.job.list) with
 * the job ids shown; no patient is named because none is read. The audit row
 * is inserted in the same transaction as the read, so that transaction is
 * not read-only (PostgreSQL refuses an INSERT in a READ ONLY transaction,
 * 25006); the default READ COMMITTED transaction is used, as every other OCR
 * reader that audits through recordWithClient does.
 */
@Injectable()
export class OcrJobListService {
  constructor(private readonly database: DatabaseService, private readonly audit: AuditService) {}

  async list(query: OcrJobListQueryDto, context: DataAccessContext) {
    const limit = query.limit ? Number(query.limit) : OCR_JOB_LIST_DEFAULT_LIMIT;
    const cursor = query.cursor ? decodeCursor(query.cursor) : undefined;
    const mine = query.mine === 'true';
    if (mine && !context.membershipId) {
      throw new DomainProblem(403, 'FACILITY_ACCESS_DENIED', 'The actor is not active at this facility');
    }
    return this.database.withTransaction(context, async (client) => {
      const result = await client.query<JobListRow>(OCR_JOB_LIST_SQL, [
        context.facilityId, query.status ?? null, mine ? context.membershipId : null,
        cursor?.at ?? null, cursor?.id ?? null, limit + 1,
      ]);
      const rows = result.rows.slice(0, limit);
      const last = rows.at(-1);
      const nextCursor = result.rows.length > limit && last ? encodeCursor({ at: last.cursor_at, id: last.id }) : null;
      await this.audit.recordWithClient(client, {
        correlationId: context.correlationId,
        actorType: 'staff',
        actorSubject: context.actor.subject,
        actorAccountId: context.actor.accountId,
        actorMembershipId: context.membershipId,
        organizationId: context.actor.facility?.organizationId,
        facilityId: context.facilityId,
        action: 'ocr.job.list',
        resourceType: 'ocr-job-list',
        outcome: 'success',
        purposeOfUse: context.purposeOfUse,
        details: { count: rows.length, jobIds: rows.map((row) => row.id), status: query.status ?? null, mine,
          page: cursor ? 'next' : 'first' },
        sourceSystem: 'ocr-api',
      });
      return {
        items: rows.map((row) => ({
          id: row.id,
          documentId: row.document_id,
          status: row.status,
          createdAt: row.created_at,
          createdByMembershipId: row.created_by_membership_id,
          createdByMe: row.created_by_membership_id === context.membershipId,
          attemptCount: row.attempt_count,
          maxAttempts: row.max_attempts,
          completedAt: row.completed_at,
          failedAt: row.failed_at,
          failureCode: row.last_error_code,
        })),
        nextCursor,
      };
    });
  }
}
