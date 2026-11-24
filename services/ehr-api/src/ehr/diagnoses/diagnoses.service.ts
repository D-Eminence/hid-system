import { Injectable, Logger } from '@nestjs/common';
import type { PoolClient, QueryResultRow } from 'pg';
import { DomainProblem } from '../../common/problem';
import type { DataAccessContext } from '../../common/request-context';
import { decodeTimelineCursor, requestDigest, timelineCursorSql, timelinePage } from '../shared/clinical-context';
import { CreateDiagnosisDto, TimelineQueryDto, UpdateDiagnosisDto } from '../shared/clinical.dto';
import { ClinicalRepository, type OperationResult } from '../shared/clinical.repository';

export interface DiagnosisRow extends QueryResultRow {
  id: string;
  encounterId: string;
  patientId: string;
  facilityId: string;
  createdBy: string;
  createdByMembershipId: string;
  codeSystem: string;
  code: string;
  display: string;
  clinicalStatus: string;
  verificationStatus: string;
  onsetAt: Date | null;
  abatementAt: Date | null;
  notes: string | null;
  rowVersion: string;
  createdAt: Date;
  updatedAt: Date;
}

const COLUMNS = `
  id, encounter_id as "encounterId", patient_id as "patientId", facility_id as "facilityId",
  created_by as "createdBy", created_by_membership_id as "createdByMembershipId",
  code_system as "codeSystem", code, display, clinical_status as "clinicalStatus",
  verification_status as "verificationStatus", onset_at as "onsetAt", abatement_at as "abatementAt",
  notes, row_version as "rowVersion", created_at as "createdAt", updated_at as "updatedAt"`;

@Injectable()
export class DiagnosesService {
  private readonly logger = new Logger(DiagnosesService.name);

  constructor(private readonly repository: ClinicalRepository) {}

  list(context: DataAccessContext, patientId: string, encounterId: string, query: TimelineQueryDto) {
    const scope = { list: 'ehr.diagnoses', patientId, encounterId };
    const cursor = decodeTimelineCursor(query.cursor, scope);
    return this.repository.run(
      context, patientId, 'read_records',
      { action: 'ehr.diagnosis.list', resourceType: 'diagnosis', resourceId: encounterId },
      async (client) => {
        const result = await client.query<DiagnosisRow & { cursorAt: string }>(
          `select ${COLUMNS}, ${timelineCursorSql('created_at')} as "cursorAt" from ehr.diagnoses
           where encounter_id = $1 and patient_id = $2 and facility_id = $3
             and ($4::timestamptz is null or (created_at, id) < ($4::timestamptz, $5::uuid))
           order by created_at desc, id desc limit $6`,
          [encounterId, patientId, context.facilityId, cursor?.sortAt ?? null, cursor?.id ?? null, query.limit + 1],
        );
        const page = timelinePage(result.rows, query.limit, scope);
        return { value: page, details: { resultCount: page.items.length } };
      },
      (client) => this.repository.encounterExists(client, encounterId, patientId, context.facilityId),
    );
  }

  get(context: DataAccessContext, patientId: string, encounterId: string, diagnosisId: string) {
    return this.repository.run(
      context, patientId, 'read_records',
      { action: 'ehr.diagnosis.read', resourceType: 'diagnosis', resourceId: diagnosisId },
      async (client) => ({ value: this.single(await this.find(client, context, patientId, encounterId, diagnosisId)) }),
      (client) => this.repository.exists(client, 'diagnoses', diagnosisId, patientId, context.facilityId, encounterId),
    );
  }

  create(context: DataAccessContext, patientId: string, encounterId: string, input: CreateDiagnosisDto, key: string) {
    return this.repository.run(
      context, patientId, 'write_records', { action: 'ehr.diagnosis.create', resourceType: 'diagnosis' },
      (client) => this.createInTransaction(client, context, patientId, encounterId, input, key),
      (client) => this.repository.encounterExists(client, encounterId, patientId, context.facilityId),
    );
  }

  /**
   * The diagnosis create inside a transaction the caller already holds (the
   * route's own, or EHR-C5's one-call consultation). The caller writes the
   * `ehr.diagnosis.create` audit row.
   */
  createInTransaction(
    client: PoolClient,
    context: DataAccessContext,
    patientId: string,
    encounterId: string,
    input: CreateDiagnosisDto,
    key: string,
    operation = 'diagnosis.create',
  ): Promise<OperationResult<DiagnosisRow>> {
    const digest = requestDigest(operation, { patientId, encounterId, input });
    return this.repository.executeCreate(
      client, context, patientId, key, operation, digest, 'diagnosis',
      async () => {
        const result = await client.query<DiagnosisRow>(
          `insert into ehr.diagnoses (
             encounter_id, patient_id, facility_id, created_by, created_by_membership_id,
             code_system, code, display, clinical_status, verification_status, onset_at, abatement_at, notes
           ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
           returning ${COLUMNS}`,
          [
            encounterId, patientId, context.facilityId, context.actor.accountId, context.membershipId,
            input.codeSystem, input.code, input.display, input.clinicalStatus, input.verificationStatus,
            input.onsetAt ?? null, input.abatementAt ?? null, input.notes ?? null,
          ],
        );
        const row = this.single(result.rows[0]);
        await this.recordRecent(client, context, row);
        return { value: row, id: row.id };
      },
      (id) => this.findById(client, context, patientId, id),
    );
  }

  /**
   * ORD-9 (0151): the member's recent diagnoses, written in the save's own
   * transaction (the route's and EHR-C5's consultation's). It is a
   * best-effort side record. What it guarantees: the record never waits for
   * another save of the same membership (it skips the record while another
   * open transaction of the membership, or of a membership whose id has the
   * same hashtext value, holds the recording lock, which lasts to the end of
   * that transaction). It reads the auth role tables
   * (auth.membership_has_permission), so a DDL lock there can hold the save
   * at the record up to the statement timeout (15 s, DatabaseService's
   * pool), after which the error (57014) is rolled back to the savepoint as
   * below and the save goes on.
   * ehr.record_recent_diagnosis records only for a membership holding
   * ehr.diagnosis.write at the session's facility, and nothing with no code;
   * it holds no patient id (its display is the clinician's own text, which
   * may name a patient).
   * It runs in a savepoint, and any failure of the record (a schema without
   * 0151, 42883; a deadlock, 40P01; a lock not available, 55P03; anything
   * else) is rolled back to it and the diagnosis saves as before; after
   * ROLLBACK TO SAVEPOINT the rest of the transaction commits normally. Only
   * a serialization failure (40001) in a SERIALIZABLE transaction is passed
   * on, so withTransaction runs the whole transaction again (no diagnosis
   * path is SERIALIZABLE today). The warning names the SQLSTATE and the
   * request's correlation id, as other ehr-api warnings do, and nothing of
   * the patient or the member. An idempotent replay records nothing.
   */
  private async recordRecent(client: PoolClient, context: DataAccessContext, row: DiagnosisRow): Promise<void> {
    await client.query('savepoint ehr_recent_diagnosis');
    try {
      await client.query('select ehr.record_recent_diagnosis($1, $2, $3)', [row.codeSystem, row.code, row.display]);
      await client.query('release savepoint ehr_recent_diagnosis');
    } catch (error) {
      const code = sqlState(error);
      await client.query('rollback to savepoint ehr_recent_diagnosis');
      if (code === '40001' && await isSerializable(client)) throw error;
      if (code !== '42883') {
        this.logger.warn({ message: 'A recent diagnosis could not be recorded', sqlState: code,
          correlationId: context.correlationId });
      }
    }
  }

  update(
    context: DataAccessContext,
    patientId: string,
    encounterId: string,
    diagnosisId: string,
    input: UpdateDiagnosisDto,
  ) {
    if (input.clinicalStatus === undefined && input.verificationStatus === undefined
      && input.abatementAt === undefined && input.notes === undefined) {
      throw new DomainProblem(400, 'EMPTY_UPDATE', 'At least one clinical field must be supplied');
    }
    return this.repository.run(
      context, patientId, 'write_records',
      { action: 'ehr.diagnosis.update', resourceType: 'diagnosis', resourceId: diagnosisId },
      async (client) => {
        await this.lock(client, context, patientId, encounterId, diagnosisId);
        await this.repository.setChangeReason(client, input.changeReason);
        const result = await client.query<DiagnosisRow>(
          `update ehr.diagnoses set
             clinical_status = coalesce($1, clinical_status),
             verification_status = coalesce($2, verification_status),
             abatement_at = coalesce($3::timestamptz, abatement_at),
             notes = coalesce($4, notes)
           where id = $5 and encounter_id = $6 and patient_id = $7 and facility_id = $8 and row_version = $9
           returning ${COLUMNS}`,
          [
            input.clinicalStatus ?? null, input.verificationStatus ?? null, input.abatementAt ?? null,
            input.notes ?? null, diagnosisId, encounterId, patientId, context.facilityId, input.expectedRowVersion,
          ],
        );
        const row = result.rows[0];
        if (!row) throw new DomainProblem(412, 'VERSION_CONFLICT', 'Diagnosis changed since it was loaded');
        return { value: row, resourceId: diagnosisId, details: { rowVersion: row.rowVersion } };
      },
      (client) => this.repository.exists(client, 'diagnoses', diagnosisId, patientId, context.facilityId, encounterId),
    );
  }

  private async find(client: PoolClient, context: DataAccessContext, patientId: string, encounterId: string, id: string) {
    const result = await client.query<DiagnosisRow>(
      `select ${COLUMNS} from ehr.diagnoses
       where id = $1 and encounter_id = $2 and patient_id = $3 and facility_id = $4`,
      [id, encounterId, patientId, context.facilityId],
    );
    return result.rows[0];
  }

  private async findById(client: PoolClient, context: DataAccessContext, patientId: string, id: string) {
    const result = await client.query<DiagnosisRow>(
      `select ${COLUMNS} from ehr.diagnoses where id = $1 and patient_id = $2 and facility_id = $3`,
      [id, patientId, context.facilityId],
    );
    return result.rows[0];
  }

  private async lock(client: PoolClient, context: DataAccessContext, patientId: string, encounterId: string, id: string) {
    const result = await client.query<DiagnosisRow>(
      `select ${COLUMNS} from ehr.diagnoses
       where id = $1 and encounter_id = $2 and patient_id = $3 and facility_id = $4 for update`,
      [id, encounterId, patientId, context.facilityId],
    );
    return this.single(result.rows[0]);
  }

  private single(row: DiagnosisRow | undefined): DiagnosisRow {
    if (!row) throw new DomainProblem(404, 'DIAGNOSIS_NOT_FOUND', 'Diagnosis was not found');
    return row;
  }
}

/** Whether the transaction the client holds is SERIALIZABLE (withTransaction's isolationLevel). */
async function isSerializable(client: PoolClient): Promise<boolean> {
  const result = await client.query<{ isolation: string }>(
    "select current_setting('transaction_isolation') as isolation");
  return result.rows[0]?.isolation === 'serializable';
}

function sqlState(error: unknown): string {
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? code : 'unknown';
}
