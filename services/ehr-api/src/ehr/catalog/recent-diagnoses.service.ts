import { Injectable, Logger } from '@nestjs/common';
import type { QueryResultRow } from 'pg';
import { AuditService } from '../../audit/audit.service';
import { DomainProblem } from '../../common/problem';
import { DatabaseService, type StaffTransactionContext } from '../../database/database.service';
import { diagnosisSearchUnavailable } from './catalog.service';

export interface RecentDiagnosis {
  codeSystem: string;
  code: string;
  display: string;
  lastUsedAt: string;
  useCount: number;
}

export interface RecentDiagnosesAnswer {
  items: RecentDiagnosis[];
}

/** Whose list is read, and who the audit row names: the guards' actor at this facility. */
export interface RecentDiagnosesCaller extends StaffTransactionContext {
  accountId?: string;
  organizationId?: string;
}

interface RecentRow extends QueryResultRow {
  code_system: string;
  code: string;
  display: string;
  last_used_at: Date;
  use_count: number;
}

export const RECENT_DIAGNOSES_SQL = `select code_system, code, display, last_used_at, use_count
  from ehr.recent_diagnoses($1)`;

/**
 * ORD-9 (0151): the caller's own last diagnosis picks at this facility,
 * newest first. ehr.recent_diagnoses answers only for the session's
 * membership, and only while it holds ehr.diagnosis.write there; the list
 * holds no patient id (each display is the clinician's own text, which may
 * name a patient, and is given as saved, across an ICD-11 release switch
 * too). The read and its audit row (ehr.terminology.recent-read,
 * the count only) commit together. A schema without 0151, or any database
 * failure, is 503 CATALOG_UNAVAILABLE with the diagnosis search's words
 * ("Diagnosis search is not available right now.", no advice: trying again
 * does not help while 0151 is not there, and a name alone is not accepted
 * yet), on which the screen shows the empty field as before. Those words
 * stay inside: ProblemDetailsFilter sends every 5xx as "The service could
 * not complete the request."
 */
@Injectable()
export class RecentDiagnosesService {
  private readonly logger = new Logger(RecentDiagnosesService.name);

  constructor(private readonly database: DatabaseService, private readonly audit: AuditService) {}

  async list(caller: RecentDiagnosesCaller, limit: number): Promise<RecentDiagnosesAnswer> {
    try {
      return await this.database.withStaffTransaction(caller, async (client) => {
        const rows = (await client.query<RecentRow>(RECENT_DIAGNOSES_SQL, [limit])).rows;
        await this.audit.recordWithClient(client, {
          correlationId: caller.correlationId,
          actorType: 'staff',
          actorSubject: caller.subject,
          actorAccountId: caller.accountId,
          actorMembershipId: caller.membershipId,
          organizationId: caller.organizationId,
          facilityId: caller.facilityId,
          action: 'ehr.terminology.recent-read',
          resourceType: 'recent-diagnoses',
          outcome: 'success',
          details: { resultCount: rows.length },
        });
        return {
          items: rows.map((row) => ({
            codeSystem: row.code_system,
            code: row.code,
            display: row.display,
            lastUsedAt: new Date(row.last_used_at).toISOString(),
            useCount: Number(row.use_count),
          })),
        };
      });
    } catch (error) {
      if (error instanceof DomainProblem) throw error;
      const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
      if (code !== '42883') {
        this.logger.warn(`Recent diagnoses could not be read (${typeof code === 'string' ? code : 'no database code'})`);
      }
      throw diagnosisSearchUnavailable();
    }
  }
}
