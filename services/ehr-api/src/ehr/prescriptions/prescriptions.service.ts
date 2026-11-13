import { Injectable } from '@nestjs/common';
import type { PoolClient, QueryResultRow } from 'pg';
import { DomainProblem } from '../../common/problem';
import type { DataAccessContext } from '../../common/request-context';
import { decodeTimelineCursor, requestDigest, timelineCursorSql, timelinePage } from '../shared/clinical-context';
import { AcceptPrescriptionForPharmacyDto, CreatePrescriptionDto, OrderStatus,
  TimelineQueryDto, UpdatePrescriptionDto } from '../shared/clinical.dto';
import { ClinicalRepository } from '../shared/clinical.repository';
import { PharmacyApiService } from '../../integrations/pharmacy-api.service';
import { OrderRouteReader } from '../order-routes/order-route-reader';
import { routeInForce, withOrderRoute } from '../order-routes/order-route.mapping';
import { calendarDate } from '../shared/calendar-date';
import { checkPrescriptionAllergies, readAllergyAcknowledgements,
  recordAllergyAcknowledgement } from '../allergies/prescription-allergy-gate';

export interface PrescriptionRow extends QueryResultRow {
  id: string;
  encounterId: string;
  patientId: string;
  facilityId: string;
  createdBy: string;
  createdByMembershipId: string;
  medicationCodeSystem: string | null;
  medicationCode: string | null;
  medicationDisplay: string;
  doseQuantity: string | null;
  doseUnit: string | null;
  routeCode: string | null;
  frequency: string;
  instructions: string;
  startsOn: string | null;
  endsOn: string | null;
  status: OrderStatus;
  rowVersion: string;
  createdAt: Date;
  updatedAt: Date;
}

const COLUMNS = `
  id, encounter_id as "encounterId", patient_id as "patientId", facility_id as "facilityId",
  created_by as "createdBy", created_by_membership_id as "createdByMembershipId",
  medication_code_system as "medicationCodeSystem", medication_code as "medicationCode",
  medication_display as "medicationDisplay", dose_quantity as "doseQuantity", dose_unit as "doseUnit",
  route_code as "routeCode", frequency, instructions, starts_on as "startsOn", ends_on as "endsOn",
  status, row_version as "rowVersion", created_at as "createdAt", updated_at as "updatedAt"`;

const TRANSITIONS: Readonly<Record<OrderStatus, readonly OrderStatus[]>> = {
  [OrderStatus.Draft]: [OrderStatus.Active, OrderStatus.Cancelled, OrderStatus.EnteredInError],
  [OrderStatus.Active]: [OrderStatus.OnHold, OrderStatus.Completed, OrderStatus.Cancelled, OrderStatus.EnteredInError],
  [OrderStatus.OnHold]: [OrderStatus.Active, OrderStatus.Cancelled, OrderStatus.EnteredInError],
  [OrderStatus.Completed]: [],
  [OrderStatus.Cancelled]: [],
  [OrderStatus.EnteredInError]: [],
};

@Injectable()
export class PrescriptionsService {
  constructor(
    private readonly repository: ClinicalRepository,
    private readonly pharmacyApi: PharmacyApiService,
    private readonly orderRoutes: OrderRouteReader,
  ) {}

  /**
   * One page of the encounter's prescriptions, each with its latest route to
   * another facility (`orderRoute`), and whether orders between facilities
   * are on (`crossFacilityOrders`, a pool read after the transaction), and
   * `wrongPatientReports: true`: the receiving pharmacy can end an order it
   * accepted for someone who was not the patient (item 3, 0088), so the
   * website may ask a clinician to have it ended there first (D15); and
   * `lateCorrection: true`: it can also reverse, after the prescription
   * ended, a dispensing it recorded for the wrong person (D17, 0090).
   */
  async list(context: DataAccessContext, patientId: string, encounterId: string, query: TimelineQueryDto) {
    const scope = { list: 'ehr.prescriptions', patientId, encounterId };
    const cursor = decodeTimelineCursor(query.cursor, scope);
    const page = await this.repository.run(
      context, patientId, 'read_records',
      { action: 'ehr.prescription.list', resourceType: 'prescription', resourceId: encounterId },
      async (client) => {
        const result = await client.query<PrescriptionRow & { cursorAt: string }>(
          `select ${COLUMNS}, ${timelineCursorSql('created_at')} as "cursorAt" from ehr.prescriptions
           where encounter_id = $1 and patient_id = $2 and facility_id = $3
             and ($4::timestamptz is null or (created_at, id) < ($4::timestamptz, $5::uuid))
           order by created_at desc, id desc limit $6`,
          [encounterId, patientId, context.facilityId, cursor?.sortAt ?? null, cursor?.id ?? null, query.limit + 1],
        );
        const page = timelinePage(result.rows, query.limit, scope);
        const ids = page.items.map((item) => item.id);
        const routes = await this.orderRoutes.summaries(client, context, 'prescription', patientId, ids);
        // 0117: each prescription's stored allergy acknowledgements (audited as a count, never the reason).
        const acknowledgements = await readAllergyAcknowledgements(client, context, patientId, ids);
        const items = page.items.map((item) => ({ ...withOrderRoute(item, routes),
          allergyAcknowledgements: acknowledgements.get(item.id) ?? [] }));
        return { value: { ...page, items },
          details: { resultCount: page.items.length, allergyAcknowledgementCount: countValues(acknowledgements) } };
      },
      (client) => this.repository.encounterExists(client, encounterId, patientId, context.facilityId),
    );
    return { ...page, crossFacilityOrders: await this.orderRoutes.crossFacilityOrdersEnabled(), wrongPatientReports: true,
      lateCorrection: true };
  }

  get(context: DataAccessContext, patientId: string, encounterId: string, prescriptionId: string) {
    return this.repository.run(
      context, patientId, 'read_records',
      { action: 'ehr.prescription.read', resourceType: 'prescription', resourceId: prescriptionId },
      async (client) => {
        const row = this.single(await this.find(client, context, patientId, encounterId, prescriptionId));
        const routes = await this.orderRoutes.summaries(client, context, 'prescription', patientId, [row.id]);
        // 0117: the allergy acknowledgements stored for it, so whoever activates or resumes a draft
        // sees the earlier reason (audited as a count, never the reason).
        const acknowledgements = (await readAllergyAcknowledgements(client, context, patientId, [row.id])).get(row.id) ?? [];
        return { value: { ...withOrderRoute(row, routes), allergyAcknowledgements: acknowledgements },
          details: { allergyAcknowledgementCount: acknowledgements.length } };
      },
      (client) => this.repository.exists(client, 'prescriptions', prescriptionId, patientId, context.facilityId, encounterId),
    );
  }

  create(context: DataAccessContext, patientId: string, encounterId: string, input: CreatePrescriptionDto, key: string) {
    if ((input.doseQuantity === undefined) !== (input.doseUnit === undefined)) {
      throw new DomainProblem(400, 'DOSE_INCOMPLETE', 'Dose quantity and unit must be supplied together');
    }
    const operation = 'prescription.create';
    const digest = requestDigest(operation, { patientId, encounterId, input });
    return this.repository.run(
      context, patientId, 'write_records',
      { action: 'ehr.prescription.create', resourceType: 'prescription' },
      (client) => this.repository.executeCreate(
        client, context, patientId, key, operation, digest, 'prescription',
        async () => {
          // 0117: the allergy check. A match needs the prescriber's acknowledgement with a reason, for
          // the warning they were shown (its warningToken); without it nothing is written (the whole
          // transaction, idempotency key included, rolls back).
          const matches = await checkPrescriptionAllergies(client, context, patientId,
            { display: input.medicationDisplay, code: input.medicationCode ?? null }, input.allergyAcknowledgement);
          const result = await client.query<PrescriptionRow>(
            `insert into ehr.prescriptions (
               encounter_id, patient_id, facility_id, created_by, created_by_membership_id,
               medication_code_system, medication_code, medication_display, dose_quantity, dose_unit,
               route_code, frequency, instructions, starts_on, ends_on, status
             ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
             returning ${COLUMNS}`,
            [
              encounterId, patientId, context.facilityId, context.actor.accountId, context.membershipId,
              input.medicationCodeSystem ?? null, input.medicationCode ?? null, input.medicationDisplay,
              input.doseQuantity ?? null, input.doseUnit ?? null, input.routeCode ?? null,
              input.frequency, input.instructions, input.startsOn ?? null, input.endsOn ?? null, input.status,
            ],
          );
          const row = this.single(result.rows[0]);
          if (matches.length > 0 && input.allergyAcknowledgement) {
            // The audit says the prescriber went ahead after a warning: flags and counts only,
            // never the substance or the reason text.
            const details = await recordAllergyAcknowledgement(client, context, patientId, row.id, 'create', matches,
              input.allergyAcknowledgement);
            return { value: row, id: row.id, details };
          }
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
    prescriptionId: string,
    input: UpdatePrescriptionDto,
  ) {
    if (input.status === undefined && input.frequency === undefined
      && input.instructions === undefined && input.endsOn === undefined) {
      throw new DomainProblem(400, 'EMPTY_UPDATE', 'At least one clinical field must be supplied');
    }
    return this.repository.run(
      context, patientId, 'write_records',
      { action: 'ehr.prescription.update', resourceType: 'prescription', resourceId: prescriptionId },
      async (client) => {
        const current = await this.lock(client, context, patientId, encounterId, prescriptionId);
        if (input.status && input.status !== current.status && !TRANSITIONS[current.status].includes(input.status)) {
          throw new DomainProblem(409, 'INVALID_PRESCRIPTION_TRANSITION', 'Prescription status transition is not allowed');
        }
        // 0117: Activate (draft) and Resume (on hold) check the allergies again: one may have been
        // recorded since the prescription was saved. A match already covered by a stored reason for
        // this prescription needs none.
        const activating = input.status === OrderStatus.Active && current.status !== OrderStatus.Active;
        const matches = activating
          ? await checkPrescriptionAllergies(client, context, patientId,
            { display: current.medicationDisplay, code: current.medicationCode }, input.allergyAcknowledgement, current.id)
          : [];
        await this.repository.setChangeReason(client, input.changeReason);
        const result = await client.query<PrescriptionRow>(
          `update ehr.prescriptions set
             status = coalesce($1, status), frequency = coalesce($2, frequency),
             instructions = coalesce($3, instructions), ends_on = coalesce($4::date, ends_on)
           where id = $5 and encounter_id = $6 and patient_id = $7 and facility_id = $8 and row_version = $9
           returning ${COLUMNS}`,
          [
            input.status ?? null, input.frequency ?? null, input.instructions ?? null, input.endsOn ?? null,
            prescriptionId, encounterId, patientId, context.facilityId, input.expectedRowVersion,
          ],
        );
        const row = result.rows[0];
        if (!row) throw new DomainProblem(412, 'VERSION_CONFLICT', 'Prescription changed since it was loaded');
        if (matches.length > 0 && input.allergyAcknowledgement) {
          const override = await recordAllergyAcknowledgement(client, context, patientId, row.id,
            current.status === OrderStatus.Draft ? 'activate' : 'resume', matches, input.allergyAcknowledgement);
          return { value: row, resourceId: prescriptionId, details: { rowVersion: row.rowVersion, ...override } };
        }
        return { value: row, resourceId: prescriptionId, details: { rowVersion: row.rowVersion } };
      },
      (client) => this.repository.exists(client, 'prescriptions', prescriptionId, patientId, context.facilityId, encounterId),
    );
  }

  async acceptForPharmacy(
    context: DataAccessContext,
    patientId: string,
    encounterId: string,
    prescriptionId: string,
    input: AcceptPrescriptionForPharmacyDto,
    idempotencyKey: string,
  ) {
    const row = await this.repository.run(
      context,
      patientId,
      'write_records',
      {
        action: 'ehr.prescription.pharmacy-handoff.eligibility-checked',
        resourceType: 'prescription',
        resourceId: prescriptionId,
        details: { expectedPrescriptionVersion: input.expectedRowVersion },
      },
      async (client) => {
        const current = await this.lock(client, context, patientId, encounterId, prescriptionId);
        if (Number(current.rowVersion) !== input.expectedRowVersion) {
          throw new DomainProblem(
            412,
            'PRESCRIPTION_VERSION_CONFLICT',
            'Pharmacy acceptance must bind to the current exact prescription version',
          );
        }
        if (current.status !== OrderStatus.Active) {
          throw new DomainProblem(
            409,
            'PRESCRIPTION_NOT_ELIGIBLE',
            'Only an active prescription can enter Pharmacy work',
          );
        }
        // P4c (§7.5): a prescription with a route to another facility in
        // force is not taken into this facility's Pharmacy; its validator
        // refuses it too.
        if (routeInForce(await this.orderRoutes.summary(client, context, 'prescription', patientId, prescriptionId))) {
          throw new DomainProblem(409, 'PRESCRIPTION_ROUTED',
            'This prescription has been sent to another pharmacy; withdraw it there first');
        }
        // 0117 (the review of PR 218): an allergy may have been recorded since the prescription
        // became active, so it is checked before this facility's pharmacy takes it. A match already
        // covered by a reason stored for it needs none. Otherwise the 409 answers here, before
        // Pharmacy is called, and the transaction writes nothing. An accepted reason is stored for
        // the handoff stage; the audit says so with flags and counts, never the substance or reason.
        const matches = await checkPrescriptionAllergies(client, context, patientId,
          { display: current.medicationDisplay, code: current.medicationCode }, input.allergyAcknowledgement, current.id);
        const allergyOverride = matches.length > 0 && input.allergyAcknowledgement
          ? await recordAllergyAcknowledgement(client, context, patientId, current.id, 'handoff', matches,
            input.allergyAcknowledgement)
          : {};
        return {
          value: current,
          resourceId: prescriptionId,
          details: { prescriptionVersion: Number(current.rowVersion), ...allergyOverride },
        };
      },
      (client) => this.repository.exists(
        client,
        'prescriptions',
        prescriptionId,
        patientId,
        context.facilityId,
        encounterId,
      ),
    );
    return this.pharmacyApi.acceptEhrPrescription(context, {
      patientId: row.patientId,
      orderingFacilityId: row.facilityId,
      sourceEhrPrescriptionId: row.id,
      sourceEhrPrescriptionVersion: Number(row.rowVersion),
      sourceEncounterId: row.encounterId,
      sourceStatus: row.status,
      medicationCodeSystem: row.medicationCodeSystem ?? undefined,
      medicationCode: row.medicationCode ?? undefined,
      medicationDisplay: row.medicationDisplay,
      doseQuantity: row.doseQuantity === null ? undefined : Number(row.doseQuantity),
      doseUnit: row.doseUnit ?? undefined,
      routeCode: row.routeCode ?? undefined,
      frequency: row.frequency,
      instructions: row.instructions,
      // Calendar dates, not the local-midnight Date node-postgres makes of a date column
      // (its ISO string is the day before east of UTC); 0100 compares them exactly.
      startsOn: calendarDate(row.startsOn),
      endsOn: calendarDate(row.endsOn),
      prescribedBy: row.createdBy,
      prescribedAt: row.createdAt.toISOString(),
      acceptanceReason: input.reason,
    }, idempotencyKey);
  }

  private async find(client: PoolClient, context: DataAccessContext, patientId: string, encounterId: string, id: string) {
    const result = await client.query<PrescriptionRow>(
      `select ${COLUMNS} from ehr.prescriptions
       where id = $1 and encounter_id = $2 and patient_id = $3 and facility_id = $4`,
      [id, encounterId, patientId, context.facilityId],
    );
    return result.rows[0];
  }

  private async findById(client: PoolClient, context: DataAccessContext, patientId: string, id: string) {
    const result = await client.query<PrescriptionRow>(
      `select ${COLUMNS} from ehr.prescriptions where id = $1 and patient_id = $2 and facility_id = $3`,
      [id, patientId, context.facilityId],
    );
    return result.rows[0];
  }

  private async lock(client: PoolClient, context: DataAccessContext, patientId: string, encounterId: string, id: string) {
    const result = await client.query<PrescriptionRow>(
      `select ${COLUMNS} from ehr.prescriptions
       where id = $1 and encounter_id = $2 and patient_id = $3 and facility_id = $4 for update`,
      [id, encounterId, patientId, context.facilityId],
    );
    return this.single(result.rows[0]);
  }

  private single(row: PrescriptionRow | undefined): PrescriptionRow {
    if (!row) throw new DomainProblem(404, 'PRESCRIPTION_NOT_FOUND', 'Prescription was not found');
    return row;
  }
}

function countValues(map: ReadonlyMap<string, readonly unknown[]>): number {
  let count = 0;
  for (const list of map.values()) count += list.length;
  return count;
}
