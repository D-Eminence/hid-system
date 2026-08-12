import { Injectable } from '@nestjs/common';
import type { PoolClient, QueryResultRow } from 'pg';
import { DomainProblem } from '../../common/problem';
import type { DataAccessContext } from '../../common/request-context';
import { decodeTimelineCursor, requestDigest, timelinePage } from '../shared/clinical-context';
import { CreateDiagnosisDto, TimelineQueryDto, UpdateDiagnosisDto } from '../shared/clinical.dto';
import { ClinicalRepository } from '../shared/clinical.repository';

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
  constructor(private readonly repository: ClinicalRepository) {}

  list(context: DataAccessContext, patientId: string, encounterId: string, query: TimelineQueryDto) {
    const cursor = decodeTimelineCursor(query.cursor);
    return this.repository.run(
      context, patientId, 'read_records',
      { action: 'ehr.diagnosis.list', resourceType: 'diagnosis', resourceId: encounterId },
      async (client) => {
        const result = await client.query<DiagnosisRow>(
          `select ${COLUMNS} from ehr.diagnoses
           where encounter_id = $1 and patient_id = $2 and facility_id = $3
             and ($4::timestamptz is null or (created_at, id) < ($4::timestamptz, $5::uuid))
           order by created_at desc, id desc limit $6`,
          [encounterId, patientId, context.facilityId, cursor?.sortAt ?? null, cursor?.id ?? null, query.limit + 1],
        );
        const page = timelinePage(result.rows, query.limit, (row) => row.createdAt);
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
    const operation = 'diagnosis.create';
    const digest = requestDigest(operation, { patientId, encounterId, input });
    return this.repository.run(
      context, patientId, 'write_records', { action: 'ehr.diagnosis.create', resourceType: 'diagnosis' },
      (client) => this.repository.executeCreate(
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
          return { value: row, id: row.id };
        },
        (id) => this.findById(client, context, patientId, id),
      ),
      (client) => this.repository.encounterExists(client, encounterId, patientId, context.facilityId),
    );
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
