import { Injectable, Optional } from '@nestjs/common';
import type { PoolClient, QueryResultRow } from 'pg';
import { DomainProblem } from '../../common/problem';
import type { DataAccessContext } from '../../common/request-context';
import { decodeTimelineCursor, requestDigest, timelineCursorSql, timelinePage } from '../shared/clinical-context';
import { AcceptPrescriptionForPharmacyDto, OrderStatus, TimelineQueryDto, UpdatePrescriptionDto } from '../shared/clinical.dto';
import { ClinicalRepository } from '../shared/clinical.repository';
import { hasTypedReason, neverReachedBefore, resolveChangeReason } from '../shared/change-reason';
import { requireVisitOpenForWork } from '../shared/visit-guard';
import { PharmacyApiService } from '../../integrations/pharmacy-api.service';
import { OrderRouteReader } from '../order-routes/order-route-reader';
import { routeInForce, withOrderRoute } from '../order-routes/order-route.mapping';
import { calendarDate } from '../shared/calendar-date';
import { checkPrescriptionAllergies, readAllergyAcknowledgements,
  recordAllergyAcknowledgement } from '../allergies/prescription-allergy-gate';
import { type CreatePrescriptionInput, PRESCRIPTION_DISPENSING_DETAILS_OFF,
  PrescriptionDispensingDetails } from './prescription-dispensing-details';
import { OWN_PHARMACY_SEND_OFF, OwnPharmacySend, type PharmacyHandoff, pharmacyHandoff } from './own-pharmacy-send';
import { PRESCRIPTION_REFILLS_OFF, PrescriptionRefills } from './prescription-refills';
import type { SendPrescriptionToOwnPharmacyDto } from './own-pharmacy-send.dto';

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

/** EHR-C8a: the only changes allowed on a visit entered in error: stopping the order. */
const STOPPING: readonly OrderStatus[] = [OrderStatus.OnHold, OrderStatus.Cancelled, OrderStatus.EnteredInError];

@Injectable()
export class PrescriptionsService {
  constructor(
    private readonly repository: ClinicalRepository,
    private readonly pharmacyApi: PharmacyApiService,
    private readonly orderRoutes: OrderRouteReader,
    private readonly details: PrescriptionDispensingDetails = PRESCRIPTION_DISPENSING_DETAILS_OFF,
    private readonly ownPharmacy: OwnPharmacySend = OWN_PHARMACY_SEND_OFF,
    // ORD-12 (0154): refills, behind PRESCRIPTION_REFILLS_ENABLED; last, optional and off by default, so every
    // `new PrescriptionsService(...)` and every testing module built before it is unchanged.
    @Optional() private readonly refills: PrescriptionRefills = PRESCRIPTION_REFILLS_OFF,
  ) {}

  /** The answer's columns: today's, plus the dispensing details (0125) and the refills (ORD-12) while each is on. */
  private columns(): string {
    return COLUMNS + this.details.selectList() + this.refills.selectList();
  }

  /** A row as these routes answer it: the details (0125), then `refillsAllowed` (ORD-12), each while on. */
  private project<Row extends object>(row: Row) {
    return this.refills.project(this.details.project(row));
  }

  /**
   * One page of the encounter's prescriptions, each with its latest route to
   * another facility (`orderRoute`), and whether orders between facilities
   * are on (`crossFacilityOrders`, a pool read after the transaction), and
   * `wrongPatientReports: true`: the receiving pharmacy can end an order it
   * accepted for someone who was not the patient (item 3, 0088), so the
   * website may ask a clinician to have it ended there first (D15); and
   * `lateCorrection: true`: it can also reverse, after the prescription
   * ended, a dispensing it recorded for the wrong person (D17, 0090). While
   * PRESCRIPTION_DISPENSING_DETAILS_ENABLED is on (0125), each item carries
   * the dispensing details it was written with, and `dispensingDetails: true`
   * says a create may carry them; off, neither. While PRESCRIPTION_REFILLS_ENABLED
   * is on (ORD-12), each item carries `refillsAllowed` and `refills: true` says
   * a create may carry it; off, neither.
   */
  async list(context: DataAccessContext, patientId: string, encounterId: string, query: TimelineQueryDto) {
    const scope = { list: 'ehr.prescriptions', patientId, encounterId };
    const cursor = decodeTimelineCursor(query.cursor, scope);
    const page = await this.repository.run(
      context, patientId, 'read_records',
      { action: 'ehr.prescription.list', resourceType: 'prescription', resourceId: encounterId },
      async (client) => {
        const result = await client.query<PrescriptionRow & { cursorAt: string }>(
          `select ${this.columns()}, ${timelineCursorSql('created_at')} as "cursorAt" from ehr.prescriptions
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
        // 0133: whether a send to this hospital's own pharmacy can reach somebody here (no field without 0133).
        const staffed = withStaffed(await this.ownPharmacy.staffed(client, context.correlationId));
        const items = page.items.map((item) => ({ ...withOrderRoute(this.project(item), routes),
          allergyAcknowledgements: acknowledgements.get(item.id) ?? [], ...staffed }));
        return { value: { ...page, items },
          details: { resultCount: page.items.length, allergyAcknowledgementCount: countValues(acknowledgements) } };
      },
      (client) => this.repository.encounterExists(client, encounterId, patientId, context.facilityId),
    );
    return { ...page, crossFacilityOrders: await this.orderRoutes.crossFacilityOrdersEnabled(), wrongPatientReports: true,
      lateCorrection: true, ...this.details.flag(), ...this.refills.flag() };
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
        // 0133: whether a send to this hospital's own pharmacy can reach somebody here (no field without 0133).
        const staffed = withStaffed(await this.ownPharmacy.staffed(client, context.correlationId));
        return { value: { ...withOrderRoute(this.project(row), routes), allergyAcknowledgements: acknowledgements,
          ...staffed },
          details: { allergyAcknowledgementCount: acknowledgements.length } };
      },
      (client) => this.repository.exists(client, 'prescriptions', prescriptionId, patientId, context.facilityId, encounterId),
    );
  }

  /**
   * A new prescription. While PRESCRIPTION_DISPENSING_DETAILS_ENABLED is on
   * (0125) it may carry the dispensing details (CreatePrescriptionBodyPipe),
   * each pair together, stored with it and echoed when set; a body without
   * them keeps today's Idempotency-Key digest. Off, exactly as before.
   * While PRESCRIPTION_REFILLS_ENABLED is on (ORD-12) it may carry
   * `refillsAllowed` (0-11), stored with it (left out: null, none) and
   * answered as `refillsAllowed`; a body without it keeps today's digest.
   *
   * Written as active, it goes to this hospital's own pharmacy (0133) and the
   * answer carries `pharmacyHandoff`. A replay of the same request (the same
   * Idempotency-Key) answers the prescription as it is now and asks the send
   * again, which sends once: the hand-off as it stands now (a pending send is
   * tried again), recorded in the replay's audit row as on the first run.
   *
   * It runs READ COMMITTED, as "Send to pharmacy" does (see there): 0117's
   * allergy check must read after its lock, never from an earlier snapshot.
   */
  create(context: DataAccessContext, patientId: string, encounterId: string, input: CreatePrescriptionInput, key: string) {
    if ((input.doseQuantity === undefined) !== (input.doseUnit === undefined)) {
      throw new DomainProblem(400, 'DOSE_INCOMPLETE', 'Dose quantity and unit must be supplied together');
    }
    this.details.requirePairs(input);
    this.refills.requireDuration(input);
    const operation = 'prescription.create';
    const digest = requestDigest(operation, { patientId, encounterId,
      input: this.refills.digestInput(this.details.digestInput(input)) });
    return this.repository.run(
      context, patientId, 'write_records',
      { action: 'ehr.prescription.create', resourceType: 'prescription' },
      (client) => this.createOrReplay(client, context, patientId, encounterId, input, key, operation, digest),
      (client) => this.repository.encounterExists(client, encounterId, patientId, context.facilityId),
    );
  }

  private async createOrReplay(client: PoolClient, context: DataAccessContext, patientId: string, encounterId: string,
    input: CreatePrescriptionInput, key: string, operation: string, digest: string) {
    // The replay's hand-off, for its audit row (executeCreate records only that it was a replay).
    let replayHandoff: PharmacyHandoff | undefined;
    const created = await this.repository.executeCreate(
      client, context, patientId, key, operation, digest, 'prescription',
      async () => {
        // EHR-C8a: nothing new on a visit entered in error (409 VISIT_ENTERED_IN_ERROR).
        await requireVisitOpenForWork(client, patientId, context.facilityId, encounterId);
        // 0117: the allergy check. A match needs the prescriber's acknowledgement with a reason, for
        // the warning they were shown (its warningToken); without it nothing is written (the whole
        // transaction, idempotency key included, rolls back).
        const matches = await checkPrescriptionAllergies(client, context, patientId,
          { display: input.medicationDisplay, code: input.medicationCode ?? null }, input.allergyAcknowledgement);
        const result = await client.query<PrescriptionRow>(
          `insert into ehr.prescriptions (
             encounter_id, patient_id, facility_id, created_by, created_by_membership_id,
             medication_code_system, medication_code, medication_display, dose_quantity, dose_unit,
             route_code, frequency, instructions, starts_on, ends_on, status${this.details.insertColumns()}${
  this.refills.insertColumns()}
           ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16${this.details.insertPlaceholders()}${
  this.refills.insertPlaceholders(17 + this.details.insertValues(input).length)})
           returning ${this.columns()}`,
          [
            encounterId, patientId, context.facilityId, context.actor.accountId, context.membershipId,
            input.medicationCodeSystem ?? null, input.medicationCode ?? null, input.medicationDisplay,
            input.doseQuantity ?? null, input.doseUnit ?? null, input.routeCode ?? null,
            input.frequency, input.instructions, input.startsOn ?? null, input.endsOn ?? null, input.status,
            ...this.details.insertValues(input), ...this.refills.insertValues(input),
          ],
        );
        const row = this.single(result.rows[0]);
        // 0133: a prescription written as active goes to this hospital's own pharmacy at once.
        const handoff = row.status === OrderStatus.Active
          ? await this.ownPharmacy.send(client, row.id, Number(row.rowVersion), context.correlationId) : undefined;
        const value = withHandoff(this.project(row), handoff);
        if (matches.length > 0 && input.allergyAcknowledgement) {
          // The audit says the prescriber went ahead after a warning: flags and counts only,
          // never the substance or the reason text.
          const details = await recordAllergyAcknowledgement(client, context, patientId, row.id, 'create', matches,
            input.allergyAcknowledgement);
          return { value, id: row.id, details: { ...details, ...handoffDetails(handoff) } };
        }
        return { value, id: row.id, details: handoffDetails(handoff) };
      },
      async (id) => {
        const row = await this.findById(client, context, patientId, id);
        if (!row) return undefined;
        // 0133: a request written as active answers its hand-off on a replay too.
        replayHandoff = input.status === OrderStatus.Active
          ? await this.ownPharmacy.send(client, row.id, Number(row.rowVersion), context.correlationId) : undefined;
        return withHandoff(this.project(row), replayHandoff);
      },
    );
    return replayHandoff ? { ...created, details: { ...created.details, ...handoffDetails(replayHandoff) } } : created;
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
        // EHR-C8a: on a visit entered in error a prescription can only be put
        // on hold, cancelled or entered in error; anything else (activate,
        // resume, complete, edit) is 409 VISIT_ENTERED_IN_ERROR. The visit is
        // locked before the prescription, as in every order path.
        if (!STOPPING.includes(input.status as OrderStatus)) {
          await requireVisitOpenForWork(client, patientId, context.facilityId, encounterId);
        }
        const current = await this.lock(client, context, patientId, encounterId, prescriptionId);
        if (input.status && input.status !== current.status && !TRANSITIONS[current.status].includes(input.status)) {
          throw new DomainProblem(409, 'INVALID_PRESCRIPTION_TRANSITION', 'Prescription status transition is not allowed');
        }
        // FR-1 and Q105: a draft that was never active may be activated (first
        // activation) or edited (draft edit), or both, with no typed reason;
        // the fixed one is recorded. "Never active" is checked against the
        // version history (a resume after a hold is not first) and fails
        // closed. Cancelling or entering a draft in error, and any change to
        // an active, held or ended prescription, needs a typed reason.
        // Decided before the allergy check, whose 409 is unchanged.
        const draftWork = current.status === OrderStatus.Draft
          && (input.status === undefined || input.status === OrderStatus.Draft || input.status === OrderStatus.Active);
        const free = draftWork && !hasTypedReason(input.changeReason)
          && await neverReachedBefore(client, 'prescriptions', prescriptionId,
            [OrderStatus.Active, OrderStatus.OnHold, OrderStatus.Completed]);
        const { reason, details: reasonDetails } = resolveChangeReason(input.changeReason,
          free ? (input.status === OrderStatus.Active ? 'first_activation' : 'draft_edit') : undefined);
        // 0117: Activate (draft) and Resume (on hold) check the allergies again: one may have been
        // recorded since the prescription was saved. A match already covered by a stored reason for
        // this prescription needs none.
        const activating = input.status === OrderStatus.Active && current.status !== OrderStatus.Active;
        const matches = activating
          ? await checkPrescriptionAllergies(client, context, patientId,
            { display: current.medicationDisplay, code: current.medicationCode }, input.allergyAcknowledgement, current.id)
          : [];
        await this.repository.setChangeReason(client, reason);
        const result = await client.query<PrescriptionRow>(
          `update ehr.prescriptions set
             status = coalesce($1, status), frequency = coalesce($2, frequency),
             instructions = coalesce($3, instructions), ends_on = coalesce($4::date, ends_on)
           where id = $5 and encounter_id = $6 and patient_id = $7 and facility_id = $8 and row_version = $9
           returning ${this.columns()}`,
          [
            input.status ?? null, input.frequency ?? null, input.instructions ?? null, input.endsOn ?? null,
            prescriptionId, encounterId, patientId, context.facilityId, input.expectedRowVersion,
          ],
        );
        const row = result.rows[0];
        if (!row) throw new DomainProblem(412, 'VERSION_CONFLICT', 'Prescription changed since it was loaded');
        // 0133: activating a draft sends it to this hospital's own pharmacy in this transaction
        // (a failure never undoes the activation). Any other change of a prescription that left
        // draft (it may have been sent) asks the database whether its send now stands withdrawn:
        // holding, cancelling or entering it in error, and editing or resuming it (the pharmacy
        // item keeps the version sent), and Pharmacy can no longer dispense it (0101); the database
        // answers false once the item was dispensed (nothing is left to dispense), and once it was
        // sent to another facility's pharmacy (0133 D14: this pharmacy no longer holds it). An edit or
        // a resume that leaves it active answers the contract's "earlier version" row (reason
        // `superseded`), so the prescriber is told the pharmacy cannot dispense what they now see.
        const sent = current.status === OrderStatus.Draft && row.status === OrderStatus.Active
          ? await this.ownPharmacy.send(client, row.id, Number(row.rowVersion), context.correlationId) : undefined;
        const withdrawn = current.status !== OrderStatus.Draft
          ? await this.ownPharmacy.withdraw(client, row.id, context.correlationId) : undefined;
        const handoff = sent ?? (withdrawn && row.status === OrderStatus.Active ? pharmacyHandoff('superseded') : undefined);
        const sendDetails = { ...handoffDetails(handoff), ...(withdrawn ? { pharmacySendWithdrawn: true } : {}) };
        if (matches.length > 0 && input.allergyAcknowledgement) {
          const override = await recordAllergyAcknowledgement(client, context, patientId, row.id,
            current.status === OrderStatus.Draft ? 'activate' : 'resume', matches, input.allergyAcknowledgement);
          return { value: withHandoff(this.project(row), handoff), resourceId: prescriptionId,
            details: { rowVersion: row.rowVersion, ...reasonDetails, ...override, ...sendDetails } };
        }
        return { value: withHandoff(this.project(row), handoff), resourceId: prescriptionId,
          details: { rowVersion: row.rowVersion, ...reasonDetails, ...sendDetails } };
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
        // EHR-C8a: never sent to the pharmacy from a visit entered in error.
        await requireVisitOpenForWork(client, patientId, context.facilityId, encounterId);
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

  /**
   * "Send to pharmacy" for the prescriber (0133): sends their active
   * prescription to this hospital's own pharmacy, or tries a pending send
   * again. The prescription is locked and must be at the version the client
   * read (412) and active (409); a route to another facility in force is 409
   * PRESCRIPTION_ROUTED; an allergy recorded since activation is checked as
   * the pharmacy hand-off checks it (0117), its acknowledgement stored for the
   * hand-off stage. The database decides the rest and the answer is the
   * prescription's `pharmacyHandoff`. On a schema without 0133 it is 503
   * OWN_PHARMACY_SEND_UNAVAILABLE. Sending twice sends once. A prescription
   * whose item here was sent to another facility's pharmacy (0133 D14) never
   * comes back: once that route ends, the send answers the `routed` row.
   *
   * READ COMMITTED, on purpose (as a create as active): 0117's allergy
   * check takes the patient's allergy lock and then reads the allergies, and
   * only READ COMMITTED reads them after the lock. A SERIALIZABLE transaction
   * reads from the snapshot of its first statement, taken before the lock,
   * so an allergy recorded after that first statement (the wait included)
   * would not be seen. The cost (0133 D14): this send locks the prescription
   * but does not change it, so a send to an outside pharmacy (SERIALIZABLE)
   * whose snapshot predates this commit (for example while it waits for the
   * patient's allergy lock) may not see the item it creates and may leave its
   * route sent next to that item. The database's live-claim index then ends
   * the outside pharmacy's acceptance in R10 (the route is withdrawn,
   * order_in_work): the prescription is never dispensed twice and stays with
   * this hospital's pharmacy. The two also take the prescription's lock and
   * the allergy lock in opposite orders, so they can deadlock (40P01):
   * PostgreSQL cancels one, and the prescription then goes to the outside
   * pharmacy (a cancelled outside send is run again and releases the item; a
   * cancelled "Send to pharmacy" leaves no item). D7 passes a 40001 or 40P01
   * on (OwnPharmacySend).
   */
  sendToOwnPharmacy(context: DataAccessContext, patientId: string, encounterId: string, prescriptionId: string,
    input: SendPrescriptionToOwnPharmacyDto) {
    return this.repository.run(
      context, patientId, 'write_records',
      { action: 'ehr.prescription.own-pharmacy-send', resourceType: 'prescription', resourceId: prescriptionId,
        details: { expectedPrescriptionVersion: input.expectedRowVersion } },
      async (client) => {
        await requireVisitOpenForWork(client, patientId, context.facilityId, encounterId);
        const current = await this.lock(client, context, patientId, encounterId, prescriptionId);
        if (Number(current.rowVersion) !== input.expectedRowVersion) {
          throw new DomainProblem(412, 'PRESCRIPTION_VERSION_CONFLICT',
            'This prescription changed since it was read; reload it and send it again');
        }
        if (current.status !== OrderStatus.Active) {
          throw new DomainProblem(409, 'PRESCRIPTION_NOT_ELIGIBLE', 'Only an active prescription can go to the pharmacy');
        }
        if (routeInForce(await this.orderRoutes.summary(client, context, 'prescription', patientId, prescriptionId))) {
          throw new DomainProblem(409, 'PRESCRIPTION_ROUTED',
            'This prescription has been sent to another pharmacy; withdraw it there first');
        }
        const matches = await checkPrescriptionAllergies(client, context, patientId,
          { display: current.medicationDisplay, code: current.medicationCode }, input.allergyAcknowledgement, current.id);
        const allergyOverride = matches.length > 0 && input.allergyAcknowledgement
          ? await recordAllergyAcknowledgement(client, context, patientId, current.id, 'handoff', matches,
            input.allergyAcknowledgement)
          : {};
        const handoff = await this.ownPharmacy.send(client, current.id, Number(current.rowVersion), context.correlationId);
        if (!handoff) {
          throw new DomainProblem(503, 'OWN_PHARMACY_SEND_UNAVAILABLE',
            'Sending to this hospital\'s pharmacy is not available yet');
        }
        return { value: { pharmacyHandoff: handoff }, resourceId: prescriptionId,
          details: { prescriptionVersion: Number(current.rowVersion), ...allergyOverride, ...handoffDetails(handoff) } };
      },
      (client) => this.repository.exists(client, 'prescriptions', prescriptionId, patientId, context.facilityId, encounterId),
    );
  }

  private async find(client: PoolClient, context: DataAccessContext, patientId: string, encounterId: string, id: string) {
    const result = await client.query<PrescriptionRow>(
      `select ${this.columns()} from ehr.prescriptions
       where id = $1 and encounter_id = $2 and patient_id = $3 and facility_id = $4`,
      [id, encounterId, patientId, context.facilityId],
    );
    return result.rows[0];
  }

  private async findById(client: PoolClient, context: DataAccessContext, patientId: string, id: string) {
    const result = await client.query<PrescriptionRow>(
      `select ${this.columns()} from ehr.prescriptions where id = $1 and patient_id = $2 and facility_id = $3`,
      [id, patientId, context.facilityId],
    );
    return result.rows[0];
  }

  private async lock(client: PoolClient, context: DataAccessContext, patientId: string, encounterId: string, id: string) {
    const result = await client.query<PrescriptionRow>(
      `select ${this.columns()} from ehr.prescriptions
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

/** The prescription with its hand-off to this hospital's pharmacy (0133), when there was one. */
function withHandoff<T extends object>(value: T, handoff: PharmacyHandoff | undefined): T | (T & { pharmacyHandoff: PharmacyHandoff }) {
  return handoff ? { ...value, pharmacyHandoff: handoff } : value;
}

/**
 * `ownPharmacyStaffed` (0133): whether somebody at this facility works on
 * pharmacy items, so the list and page offer "Send to pharmacy" only where a
 * send can reach somebody (ORD-2's screen rule). Absent when the database
 * gives no answer (a schema without 0133, or any failure).
 */
function withStaffed(staffed: boolean | undefined): { ownPharmacyStaffed?: boolean } {
  return staffed === undefined ? {} : { ownPharmacyStaffed: staffed };
}

/** The audit details of a hand-off: its status and reason code, never the message. */
function handoffDetails(handoff: PharmacyHandoff | undefined): Record<string, string> {
  if (!handoff) return {};
  return handoff.reason ? { pharmacyHandoff: handoff.status, pharmacyHandoffReason: handoff.reason }
    : { pharmacyHandoff: handoff.status };
}

function countValues(map: ReadonlyMap<string, readonly unknown[]>): number {
  let count = 0;
  for (const list of map.values()) count += list.length;
  return count;
}
