import { Injectable } from '@nestjs/common';
import { AuditService } from '../../audit/audit.service';
import { DomainProblem } from '../../common/problem';
import type { DataAccessContext, HidRequest } from '../../common/request-context';
import { DatabaseService } from '../../database/database.service';
import { IdentityApiService } from '../../integrations/identity-api.service';
import { PATIENT_IMPORTED_HISTORY, PatientRecordRelease } from '../patient-records/patient-release';
import { authorizeOwnSession, requirePatientSession } from '../patient-records/patient-self-authorization';
import { decodeTimelineCursor } from '../shared/clinical-context';
import { ClinicalRepository } from '../shared/clinical.repository';
import {
  IMPORTED_HISTORY_LIMITS,
  IMPORTED_HISTORY_LISTS,
  type ImportedHistoryPage,
  importedHistoryAuditCounts,
  readImportedHistory,
  refusedImportedHistoryRead,
} from './imported-history.query';

export { IMPORTED_HISTORY_LIMITS } from './imported-history.query';

/** Where every imported record came from: the legacy system, imported as it held them (ADR-066). */
const PROVENANCE = 'legacy-import' as const;

export interface ImportedHistoryResponse extends ImportedHistoryPage {
  /** Imported health profiles are not part of this change (ADR-066). */
  healthProfile: null;
  limits: typeof IMPORTED_HISTORY_LIMITS;
  provenance: typeof PROVENANCE;
}

export interface StaffImportedHistoryResponse extends ImportedHistoryResponse {
  /** Whether the patient shares their imported history with staff they consented to. */
  shared: boolean;
}

/**
 * Imported legacy medical history (owner decision 3 of 2026-10-16,
 * ADR-066). The patient reads their own through the patient-self path and
 * the one release set, behind its own flag, needing no sharing choice. Staff
 * read it only through ClinicalRepository (Identity's fresh consent and
 * facility authorization, the audit and the refusal record), for direct
 * care, never under break-glass, and see it only when the database's staff
 * decision (0097: the purpose, the consent at the selected facility, the
 * permission, and the patient's own sharing choice) allows it.
 */
@Injectable()
export class ImportedHistoryService {
  constructor(private readonly database: DatabaseService, private readonly identity: IdentityApiService,
    private readonly audit: AuditService, private readonly clinical: ClinicalRepository,
    private readonly release: PatientRecordRelease) {}

  /** GET /ehr/me/imported-history: the patient's own, newest first, audited with counts only. */
  async self(request: HidRequest, cursorValue?: string): Promise<ImportedHistoryResponse> {
    if (!this.release.releases(PATIENT_IMPORTED_HISTORY)) {
      throw new DomainProblem(503, 'IMPORTED_HISTORY_DISABLED', 'Imported medical history is not available');
    }
    const session = requirePatientSession(request);
    const cursor = decodeTimelineCursor(cursorValue, { list: IMPORTED_HISTORY_LISTS.self, patientId: session.patientId });
    const { actor, authorization } = await authorizeOwnSession(this.identity, request);
    return this.database.withPatientTransaction(authorization, request.correlationId, async (client) => {
      const page = await this.release.readImportedHistory(client, authorization.patientId, cursor);
      await this.audit.recordWithClient(client, {
        correlationId: request.correlationId, actorType: 'patient', actorSubject: actor.subject,
        actorAccountId: actor.accountId, patientId: authorization.patientId,
        action: 'ehr.patient.self.imported-history.read', resourceType: 'imported-medical-history', outcome: 'success',
        purposeOfUse: 'patient-self', details: importedHistoryAuditCounts(page),
      });
      return response(page);
    });
  }

  /**
   * GET /ehr/patients/:patientId/imported-history for direct care. A patient
   * who has not shared their imported history (or has none) answers
   * `shared: false` with nothing in it; a break-glass authorization is
   * refused with 403 BREAK_GLASS_EXCLUDED. A decision or read the database
   * refuses or times out answers 503 IMPORTED_HISTORY_UNAVAILABLE.
   */
  async staff(patientId: string, context: DataAccessContext, cursorValue?: string): Promise<StaffImportedHistoryResponse> {
    const cursor = decodeTimelineCursor(cursorValue, { list: IMPORTED_HISTORY_LISTS.staff, patientId });
    return this.clinical.run(context, patientId, 'read_records', {
      action: 'ehr.imported-history.read', resourceType: 'imported-medical-history',
      excludeBreakGlass: { code: 'BREAK_GLASS_EXCLUDED' },
    }, async (client) => {
      // The decision the staff policies apply, asked once so that "not
      // shared" is an answer rather than an empty page, in the statement that
      // binds the patient the policies compare each row with (0097): the
      // policies then decide once per statement, not once per row, and admit
      // no other patient's rows in this transaction.
      let shared: boolean;
      try {
        const decision = await client.query<{ shared: boolean }>(
          "select ehr.imported_history_staff_read_allowed($1::uuid) as shared, "
          + "set_config('app.imported_history_patient', $1::uuid::text, true) as bound", [patientId]);
        shared = decision.rows[0]?.shared === true;
      } catch (error) {
        throw refusedImportedHistoryRead(error);
      }
      const page: ImportedHistoryPage = shared
        ? await readImportedHistory(client, patientId, cursor, IMPORTED_HISTORY_LISTS.staff)
        : { records: [], truncated: { records: false }, nextCursor: null };
      return { value: { shared, ...response(page) }, details: { shared, ...importedHistoryAuditCounts(page) } };
    });
  }
}

function response(page: ImportedHistoryPage): ImportedHistoryResponse {
  return { records: page.records, healthProfile: null, limits: IMPORTED_HISTORY_LIMITS, truncated: page.truncated,
    nextCursor: page.nextCursor, provenance: PROVENANCE };
}
