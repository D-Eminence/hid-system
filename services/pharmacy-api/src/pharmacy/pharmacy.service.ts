import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { PoolClient, QueryResultRow } from 'pg';
import { AuditService } from '../audit/audit.service';
import { requestDigest } from '../common/idempotency';
import { DomainProblem } from '../common/problem';
import type { DataAccessContext } from '../common/request-context';
import { DatabaseService } from '../database/database.service';
import { IdentityService } from '../identity/identity.service';
import type { AcceptEhrPrescriptionDto } from './dto/accept-ehr-prescription.dto';
import type { CreateDispensingDto, ReverseDispensingDto } from './dto/dispensing.dto';
import type { OcrMedicationImportDto } from './dto/ocr-medication-import.dto';

interface WorkItemRow extends QueryResultRow {
  id: string; patient_id: string; facility_id: string; ordering_facility_id: string;
  source_ehr_prescription_id: string; source_ehr_prescription_version: string;
  source_encounter_id: string; source_status: 'active'; status: 'accepted';
  medication_code_system: string | null; medication_code: string | null; medication_display: string;
  dose_quantity: string | null; dose_unit: string | null; route_code: string | null;
  frequency: string; instructions: string; starts_on: string | null; ends_on: string | null;
  prescribed_by: string; prescribed_at: Date; accepted_by: string; accepted_at: Date;
  row_version: string; created_at: Date; request_sha256?: string;
  dispensing_id?: string | null; dispensing_status?: 'dispensed' | null;
  reversal_id?: string | null;
}

interface DispensingRow extends QueryResultRow {
  id: string; work_item_id: string; work_item_version: string; patient_id: string; facility_id: string;
  medication_code_system: string | null; medication_code: string | null; medication_display: string;
  quantity_dispensed: string; quantity_unit: string; status: 'dispensed'; dispensed_by: string;
  dispensed_at: Date; row_version: string; created_at: Date; request_sha256?: string;
  reversal_id?: string | null; reversed_at?: Date | null;
}

interface ReversalRow extends QueryResultRow {
  id: string; dispensing_id: string; dispensing_version: string; work_item_id: string;
  patient_id: string; facility_id: string; status: 'reversed'; reversed_by: string;
  reversed_at: Date; row_version: string; created_at: Date; request_sha256?: string;
}

interface ImportRow extends QueryResultRow {
  id: string; patient_id: string; facility_id: string; source_type: 'IMPORTED_MEDICATION_EVIDENCE';
  activity_status: 'unknown'; source_document_id: string; ocr_job_id: string; extraction_id: string;
  validation_id: string; validation_version: number; publication_id: string;
  medication_text: string; strength_text: string | null; dose_text: string | null;
  frequency_text: string | null; historical_context: string | null; reviewed_by: string;
  row_version: string; created_at: Date; request_sha256?: string;
}

const WORK_ITEM_SELECT = `select w.*,d.id::text as dispensing_id,d.status as dispensing_status,
  r.id::text as reversal_id from pharmacy.work_items w
  left join pharmacy.dispensings d on d.work_item_id=w.id
  left join pharmacy.dispensing_reversals r on r.dispensing_id=d.id`;

const DISPENSING_SELECT = `select d.*,r.id::text as reversal_id,r.reversed_at
  from pharmacy.dispensings d left join pharmacy.dispensing_reversals r on r.dispensing_id=d.id`;

@Injectable()
export class PharmacyService {
  constructor(private readonly database: DatabaseService, private readonly identity: IdentityService,
    private readonly audit: AuditService) {}

  async acceptPrescription(context: DataAccessContext, input: AcceptEhrPrescriptionDto, key: string) {
    if (input.orderingFacilityId !== context.facilityId) throw new DomainProblem(403,
      'PHARMACY_CROSS_FACILITY_ACCEPTANCE_DENIED', 'Only same-facility Pharmacy acceptance is supported');
    if ((input.doseQuantity === undefined) !== (input.doseUnit === undefined)) throw new DomainProblem(400,
      'PHARMACY_DOSE_PAIR_REQUIRED', 'Dose quantity and dose unit must be supplied together');
    if ((input.medicationCodeSystem === undefined) !== (input.medicationCode === undefined)) {
      throw new DomainProblem(400, 'PHARMACY_MEDICATION_CODE_PAIR_REQUIRED',
        'Medication code system and code must be supplied together');
    }
    await this.authorize(input.patientId, context, 'write_records');
    const digest = requestDigest('pharmacy.work-item.accept-ehr-prescription', input);
    return this.database.withTransaction(context, async (client) => {
      const existing = (await client.query<WorkItemRow>(`${WORK_ITEM_SELECT}
        where (w.facility_id=$1 and w.accepted_by=$2 and w.idempotency_key=$3)
          or w.source_ehr_prescription_id=$4 for update of w`,
      [context.facilityId, context.actor.accountId, key, input.sourceEhrPrescriptionId])).rows[0];
      if (existing) {
        if (existing.request_sha256 !== digest) throw new DomainProblem(409, 'IDEMPOTENCY_CONFLICT',
          'Prescription acceptance conflicts with existing Pharmacy work');
        return this.projectWorkItem(existing);
      }
      const inserted = await client.query<WorkItemRow>(`insert into pharmacy.work_items (
        id,patient_id,facility_id,ordering_facility_id,source_ehr_prescription_id,
        source_ehr_prescription_version,source_encounter_id,source_status,medication_code_system,
        medication_code,medication_display,dose_quantity,dose_unit,route_code,frequency,instructions,
        starts_on,ends_on,prescribed_by,prescribed_at,accepted_by,accepted_by_membership_id,
        acceptance_reason,idempotency_key,request_sha256,correlation_id
      ) values ($1,$2,$3,$4,$5,$6,$7,'active',$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)
      returning *`, [randomUUID(), input.patientId, context.facilityId, input.orderingFacilityId,
        input.sourceEhrPrescriptionId, input.sourceEhrPrescriptionVersion, input.sourceEncounterId,
        input.medicationCodeSystem ?? null, input.medicationCode ?? null, input.medicationDisplay,
        input.doseQuantity ?? null, input.doseUnit ?? null, input.routeCode ?? null, input.frequency,
        input.instructions, input.startsOn ?? null, input.endsOn ?? null, input.prescribedBy,
        input.prescribedAt, context.actor.accountId, context.membershipId, input.acceptanceReason,
        key, digest, context.correlationId]);
      const row = inserted.rows[0];
      if (!row) throw new DomainProblem(503, 'PHARMACY_WORK_ITEM_NOT_CREATED',
        'Pharmacy could not accept the prescription');
      await client.query(`insert into pharmacy.work_item_events (
        work_item_id,patient_id,facility_id,event_version,event_type,actor_id,actor_membership_id,reason,correlation_id
      ) values ($1,$2,$3,1,'prescription_accepted',$4,$5,$6,$7)`, [row.id, row.patient_id,
        row.facility_id, context.actor.accountId, context.membershipId, input.acceptanceReason,
        context.correlationId]);
      await this.outbox(client, 'PharmacyWorkItemCreated', 'pharmacy-work-item', row.id,
        row.facility_id, row.patient_id, context.correlationId, { workItemId: row.id,
          sourceEhrPrescriptionId: row.source_ehr_prescription_id,
          sourceEhrPrescriptionVersion: Number(row.source_ehr_prescription_version), status: 'accepted' });
      await this.audit.recordWithClient(client, context, 'pharmacy.work-item.accept', {
        patientId: row.patient_id, resourceType: 'pharmacy-work-item', resourceId: row.id,
      }, { sourceEhrPrescriptionId: row.source_ehr_prescription_id,
        sourceEhrPrescriptionVersion: Number(row.source_ehr_prescription_version), status: 'accepted' });
      return this.projectWorkItem(row);
    }, { isolationLevel: 'SERIALIZABLE' });
  }

  async listWorkItems(context: DataAccessContext) {
    return this.database.withTransaction(context, async (client) => {
      const result = await client.query<WorkItemRow>(`${WORK_ITEM_SELECT}
        order by w.accepted_at asc,w.id asc limit 200`);
      await this.audit.recordWithClient(client, context, 'pharmacy.work-item.list', {
        resourceType: 'pharmacy-work-item-collection', resourceId: context.facilityId,
      }, { returnedCount: result.rows.length });
      return { items: result.rows.map((row) => this.projectWorkItem(row)) };
    });
  }

  async getWorkItem(context: DataAccessContext, id: string) {
    return this.database.withTransaction(context, async (client) => {
      const row = (await client.query<WorkItemRow>(`${WORK_ITEM_SELECT} where w.id=$1`, [id])).rows[0];
      if (!row) throw new DomainProblem(404, 'PHARMACY_WORK_ITEM_NOT_FOUND',
        'Pharmacy work item was not found');
      await this.authorize(row.patient_id, context, 'read_records');
      await this.audit.recordWithClient(client, context, 'pharmacy.work-item.read', {
        patientId: row.patient_id, resourceType: 'pharmacy-work-item', resourceId: row.id,
      });
      return this.projectWorkItem(row);
    });
  }

  async dispense(context: DataAccessContext, workItemId: string, input: CreateDispensingDto, key: string) {
    return this.database.withTransaction(context, async (client) => {
      const work = (await client.query<WorkItemRow>(`${WORK_ITEM_SELECT} where w.id=$1 for update of w`,
        [workItemId])).rows[0];
      if (!work) throw new DomainProblem(404, 'PHARMACY_WORK_ITEM_NOT_FOUND',
        'Pharmacy work item was not found');
      await this.authorize(work.patient_id, context, 'write_records');
      if (Number(work.row_version) !== input.expectedWorkItemVersion) throw new DomainProblem(412,
        'PHARMACY_WORK_ITEM_VERSION_CONFLICT', 'Dispensing must bind to the exact accepted work-item version');
      const digest = requestDigest('pharmacy.dispensing.create', { workItemId, ...input });
      const existing = (await client.query<DispensingRow>(`${DISPENSING_SELECT}
        where (d.facility_id=$1 and d.dispensed_by=$2 and d.idempotency_key=$3) or d.work_item_id=$4
        for update of d`, [context.facilityId, context.actor.accountId, key, workItemId])).rows[0];
      if (existing) {
        if (existing.request_sha256 === digest) return this.projectDispensing(existing);
        throw new DomainProblem(409, 'PHARMACY_WORK_ITEM_ALREADY_DISPENSED',
          'A full dispensing is already recorded for this work item; partial dispensing is not supported');
      }
      const inserted = await client.query<DispensingRow>(`insert into pharmacy.dispensings (
        id,work_item_id,work_item_version,patient_id,facility_id,medication_code_system,medication_code,
        medication_display,quantity_dispensed,quantity_unit,dispensed_by,dispensed_by_membership_id,
        reason,idempotency_key,request_sha256,correlation_id
      ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) returning *`,
      [randomUUID(), work.id, input.expectedWorkItemVersion, work.patient_id, work.facility_id,
        work.medication_code_system, work.medication_code, work.medication_display,
        input.quantityDispensed, input.quantityUnit, context.actor.accountId, context.membershipId,
        input.reason, key, digest, context.correlationId]);
      const row = inserted.rows[0];
      if (!row) throw new DomainProblem(503, 'PHARMACY_DISPENSING_NOT_CREATED',
        'Pharmacy could not record the dispensing');
      await this.outbox(client, 'MedicationDispensed', 'medication-dispensing', row.id,
        row.facility_id, row.patient_id, context.correlationId,
        { dispensingId: row.id, workItemId: row.work_item_id, status: 'dispensed' });
      await this.audit.recordWithClient(client, context, 'pharmacy.dispensing.create', {
        patientId: row.patient_id, resourceType: 'medication-dispensing', resourceId: row.id,
      }, { workItemId: row.work_item_id, workItemVersion: Number(row.work_item_version), status: 'dispensed' });
      return this.projectDispensing(row);
    }, { isolationLevel: 'SERIALIZABLE' });
  }

  async getDispensing(context: DataAccessContext, id: string) {
    return this.database.withTransaction(context, async (client) => {
      const row = (await client.query<DispensingRow>(`${DISPENSING_SELECT} where d.id=$1`, [id])).rows[0];
      if (!row) throw new DomainProblem(404, 'PHARMACY_DISPENSING_NOT_FOUND', 'Dispensing was not found');
      await this.authorize(row.patient_id, context, 'read_records');
      await this.audit.recordWithClient(client, context, 'pharmacy.dispensing.read', {
        patientId: row.patient_id, resourceType: 'medication-dispensing', resourceId: row.id,
      });
      return this.projectDispensing(row);
    });
  }

  async reverse(context: DataAccessContext, dispensingId: string, input: ReverseDispensingDto, key: string) {
    return this.database.withTransaction(context, async (client) => {
      const dispensing = (await client.query<DispensingRow>(`${DISPENSING_SELECT}
        where d.id=$1 for update of d`, [dispensingId])).rows[0];
      if (!dispensing) throw new DomainProblem(404, 'PHARMACY_DISPENSING_NOT_FOUND',
        'Dispensing was not found');
      await this.authorize(dispensing.patient_id, context, 'write_records');
      if (Number(dispensing.row_version) !== input.expectedDispensingVersion) throw new DomainProblem(412,
        'PHARMACY_DISPENSING_VERSION_CONFLICT', 'Reversal must bind to the exact dispensing version');
      const digest = requestDigest('pharmacy.dispensing.reverse', { dispensingId, ...input });
      const existing = (await client.query<ReversalRow>(`select * from pharmacy.dispensing_reversals
        where (facility_id=$1 and reversed_by=$2 and idempotency_key=$3) or dispensing_id=$4 for update`,
      [context.facilityId, context.actor.accountId, key, dispensingId])).rows[0];
      if (existing) {
        if (existing.request_sha256 === digest) return this.projectReversal(existing);
        throw new DomainProblem(409, 'PHARMACY_DISPENSING_ALREADY_REVERSED',
          'This dispensing already has a preserved reversal');
      }
      const inserted = await client.query<ReversalRow>(`insert into pharmacy.dispensing_reversals (
        id,dispensing_id,dispensing_version,work_item_id,patient_id,facility_id,reversed_by,
        reversed_by_membership_id,reason,idempotency_key,request_sha256,correlation_id
      ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning *`, [randomUUID(),
        dispensing.id, input.expectedDispensingVersion, dispensing.work_item_id, dispensing.patient_id,
        dispensing.facility_id, context.actor.accountId, context.membershipId, input.reason,
        key, digest, context.correlationId]);
      const row = inserted.rows[0];
      if (!row) throw new DomainProblem(503, 'PHARMACY_REVERSAL_NOT_CREATED',
        'Pharmacy could not record the dispensing reversal');
      await this.outbox(client, 'MedicationDispensingReversed', 'medication-dispensing-reversal',
        row.id, row.facility_id, row.patient_id, context.correlationId,
        { reversalId: row.id, dispensingId: row.dispensing_id, workItemId: row.work_item_id, status: 'reversed' });
      await this.audit.recordWithClient(client, context, 'pharmacy.dispensing.reverse', {
        patientId: row.patient_id, resourceType: 'medication-dispensing-reversal', resourceId: row.id,
      }, { dispensingId: row.dispensing_id, dispensingVersion: Number(row.dispensing_version), status: 'reversed' });
      return this.projectReversal(row);
    }, { isolationLevel: 'SERIALIZABLE' });
  }

  async createImport(context: DataAccessContext, input: OcrMedicationImportDto, key: string) {
    await this.authorize(input.patientId, context, 'write_records');
    const digest = requestDigest('pharmacy.imported-medication-evidence.create', input);
    return this.database.withTransaction(context, async (client) => {
      const existing = (await client.query<ImportRow>(`select * from pharmacy.imported_medication_evidence
        where (facility_id=$1 and created_by=$2 and idempotency_key=$3) or publication_id=$4 for update`,
      [context.facilityId, context.actor.accountId, key, input.publicationId])).rows[0];
      if (existing) {
        if (existing.request_sha256 !== digest) throw new DomainProblem(409, 'IDEMPOTENCY_CONFLICT',
          'Idempotency-Key was used for different imported medication evidence');
        return this.projectImport(existing);
      }
      const inserted = await client.query<ImportRow>(`insert into pharmacy.imported_medication_evidence (
        id,patient_id,facility_id,source_document_id,ocr_job_id,extraction_id,validation_id,
        validation_version,publication_id,medication_text,strength_text,dose_text,frequency_text,
        historical_context,reviewed_by,created_by,created_by_membership_id,idempotency_key,
        request_sha256,correlation_id
      ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
      returning *`, [randomUUID(), input.patientId, context.facilityId, input.sourceDocumentId,
        input.ocrJobId, input.extractionId, input.validationId, input.validationVersion,
        input.publicationId, input.medicationText, input.strengthText ?? null, input.doseText ?? null,
        input.frequencyText ?? null, input.historicalContext ?? null, input.reviewedBy,
        context.actor.accountId, context.membershipId, key, digest, context.correlationId]);
      const row = inserted.rows[0];
      if (!row) throw new DomainProblem(503, 'PHARMACY_IMPORT_NOT_CREATED',
        'Imported medication evidence could not be created');
      await this.outbox(client, 'PharmacyImportedMedicationEvidenceCreated',
        'imported-medication-evidence', row.id, row.facility_id, row.patient_id, context.correlationId,
        { importedMedicationEvidenceId: row.id, sourceType: 'IMPORTED_MEDICATION_EVIDENCE',
          activityStatus: 'unknown' });
      await this.audit.recordWithClient(client, context, 'pharmacy.import.create', {
        patientId: row.patient_id, resourceType: 'pharmacy-imported-medication-evidence', resourceId: row.id,
      }, { publicationId: row.publication_id, sourceType: row.source_type, activityStatus: row.activity_status });
      return this.projectImport(row);
    }, { isolationLevel: 'SERIALIZABLE' });
  }

  async getImport(context: DataAccessContext, id: string) {
    return this.database.withTransaction(context, async (client) => {
      const row = (await client.query<ImportRow>(
        'select * from pharmacy.imported_medication_evidence where id=$1', [id])).rows[0];
      if (!row) throw new DomainProblem(404, 'PHARMACY_IMPORT_NOT_FOUND',
        'Imported medication evidence was not found');
      await this.authorize(row.patient_id, context, 'read_records');
      await this.audit.recordWithClient(client, context, 'pharmacy.import.read', {
        patientId: row.patient_id, resourceType: 'pharmacy-imported-medication-evidence', resourceId: row.id,
      });
      return this.projectImport(row);
    });
  }

  private async authorize(patientId: string, context: DataAccessContext,
    scope: 'read_records' | 'write_records'): Promise<void> {
    const decision = await this.identity.authorize(patientId, scope, context);
    if (!decision.allowed || (scope === 'write_records' && decision.breakGlass)) {
      throw new DomainProblem(403, 'PHARMACY_ACCESS_DENIED',
        scope === 'write_records' && decision.breakGlass
          ? 'Break-glass authorization cannot mutate Pharmacy records'
          : 'Pharmacy access is not authorized');
    }
  }

  private outbox(client: PoolClient, eventType: string, aggregateType: string, aggregateId: string,
    facilityId: string, patientId: string, correlationId: string, payload: Record<string, unknown>) {
    return client.query(`insert into pharmacy.outbox_events (
      event_type,aggregate_type,aggregate_id,aggregate_version,facility_id,patient_id,correlation_id,payload
    ) values ($1,$2,$3,1,$4,$5,$6,$7::jsonb)`, [eventType, aggregateType, aggregateId,
      facilityId, patientId, correlationId, JSON.stringify(payload)]);
  }

  private projectWorkItem(row: WorkItemRow) {
    return { id: row.id, patientId: row.patient_id, facilityId: row.facility_id,
      sourceEhrPrescriptionId: row.source_ehr_prescription_id,
      sourceEhrPrescriptionVersion: Number(row.source_ehr_prescription_version),
      sourceEncounterId: row.source_encounter_id, status: 'accepted' as const,
      medication: { codeSystem: row.medication_code_system, code: row.medication_code,
        display: row.medication_display }, doseQuantity: row.dose_quantity === null ? null : Number(row.dose_quantity),
      doseUnit: row.dose_unit, routeCode: row.route_code, frequency: row.frequency,
      instructions: row.instructions, acceptedAt: row.accepted_at, version: Number(row.row_version),
      dispensing: row.dispensing_id ? { id: row.dispensing_id, status: row.dispensing_status,
        reversed: Boolean(row.reversal_id) } : null };
  }

  private projectDispensing(row: DispensingRow) {
    return { id: row.id, workItemId: row.work_item_id, patientId: row.patient_id,
      facilityId: row.facility_id, status: row.status, effectiveStatus: row.reversal_id ? 'reversed' : 'dispensed',
      medication: { codeSystem: row.medication_code_system, code: row.medication_code,
        display: row.medication_display }, quantityDispensed: Number(row.quantity_dispensed),
      quantityUnit: row.quantity_unit, dispensedAt: row.dispensed_at,
      reversalId: row.reversal_id ?? null, version: Number(row.row_version) };
  }

  private projectReversal(row: ReversalRow) {
    return { id: row.id, dispensingId: row.dispensing_id, workItemId: row.work_item_id,
      patientId: row.patient_id, facilityId: row.facility_id, status: row.status,
      reversedAt: row.reversed_at, version: Number(row.row_version) };
  }

  private projectImport(row: ImportRow) {
    return { id: row.id, patientId: row.patient_id, facilityId: row.facility_id,
      sourceType: row.source_type, activityStatus: row.activity_status,
      medicationText: row.medication_text, strengthText: row.strength_text,
      doseText: row.dose_text, frequencyText: row.frequency_text,
      historicalContext: row.historical_context, sourceDocumentId: row.source_document_id,
      ocrJobId: row.ocr_job_id, extractionId: row.extraction_id, validationId: row.validation_id,
      validationVersion: row.validation_version, publicationId: row.publication_id,
      version: Number(row.row_version), createdAt: row.created_at };
  }
}
