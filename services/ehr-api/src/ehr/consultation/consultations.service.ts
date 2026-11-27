import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { DomainProblem } from '../../common/problem';
import type { DataAccessContext } from '../../common/request-context';
import { ClinicalNotesService, type ClinicalNoteRow } from '../clinical-notes/clinical-notes.service';
import { DiagnosesService, type DiagnosisCreated } from '../diagnoses/diagnoses.service';
import { EncountersService, type EncounterCreated, type EncounterCreatePlan } from '../encounters/encounters.service';
import { requestDigest } from '../shared/clinical-context';
import type { CreateEncounterDto } from '../shared/clinical.dto';
import { ClinicalRepository, type AuditedPart, type SemanticEvent } from '../shared/clinical.repository';
import { VitalsService, type VitalRow } from '../vitals/vitals.service';
import type { CreateConsultationInput } from './consultation.dto';

/** EHR-C5: the answer of a one-call consultation (and of its replay). */
export interface ConsultationCreated {
  /** The visit, with `reusedOpenVisit` (EHR-C1). */
  encounter: EncounterCreated;
  note: ClinicalNoteRow | null;
  vitals: VitalRow | null;
  /** Each with codeStatus while DIAGNOSIS_NAME_ONLY_ENABLED is on (0156). */
  diagnoses: DiagnosisCreated[];
}

/** The Idempotency-Key operation of the whole call. */
export const CONSULTATION_OPERATION = 'consultation.create';

/**
 * The Idempotency-Key operation of each part. Each part keeps its own key
 * row under the same Idempotency-Key, so a replay answers each part as its
 * own route would; the names differ from the routes' own operations, so a
 * key used on a single route never collides with a consultation.
 */
export const CONSULTATION_PART_OPERATIONS = {
  encounter: 'consultation.encounter',
  note: 'consultation.clinical-note',
  vitals: 'consultation.vital',
  diagnosis: (index: number) => `consultation.diagnosis.${index + 1}`,
} as const;

/** The audit events of each part: exactly those of the part's own route. */
const EVENTS = {
  encounter: { action: 'ehr.encounter.create', resourceType: 'encounter' },
  note: { action: 'ehr.note.create', resourceType: 'clinical-note' },
  vitals: { action: 'ehr.vital.create', resourceType: 'vital' },
  diagnosis: { action: 'ehr.diagnosis.create', resourceType: 'diagnosis' },
} as const satisfies Record<string, SemanticEvent>;

@Injectable()
export class ConsultationsService {
  constructor(
    private readonly repository: ClinicalRepository,
    private readonly encounters: EncountersService,
    private readonly notes: ClinicalNotesService,
    private readonly vitals: VitalsService,
    private readonly diagnoses: DiagnosesService,
  ) {}

  /**
   * EHR-C5: the visit (today's open visit, or a new one), the note, the
   * vitals and the diagnoses in ONE transaction: all saved, or none. The
   * checks each part's own route runs before the database are run first;
   * then one consent check (`write_records`) and one transaction, in which
   * each part runs its own route's code and is audited as that route audits
   * it. The same Idempotency-Key with the same body answers the saved
   * consultation again; with another body, 409 IDEMPOTENCY_KEY_REUSED.
   * A retry after Lagos midnight (startedAt no longer today) is answered
   * from its key the same way; only a request not yet saved under its key
   * gets 400 REUSE_OPEN_VISIT_STARTED_AT_NOT_TODAY, and nothing is saved.
   */
  create(
    context: DataAccessContext,
    patientId: string,
    input: CreateConsultationInput,
    idempotencyKey: string,
  ): Promise<ConsultationCreated> {
    if (input.visit.reuseOpenVisit === false) {
      throw new DomainProblem(400, 'CONSULTATION_USES_OPEN_VISIT',
        'A consultation is saved on the open visit today. Leave out reuseOpenVisit or set it to true.');
    }
    const visit: CreateEncounterDto = { ...input.visit, reuseOpenVisit: true };
    let plan: EncounterCreatePlan;
    let notToday: DomainProblem | undefined;
    try {
      plan = this.encounters.planCreate(patientId, visit, CONSULTATION_PART_OPERATIONS.encounter);
    } catch (error) {
      if (!(error instanceof DomainProblem) || error.code !== 'REUSE_OPEN_VISIT_STARTED_AT_NOT_TODAY') throw error;
      // Possibly a retry after Lagos midnight of a consultation already
      // saved: its key replays it below; a new request is refused there.
      notToday = error;
      plan = this.encounters.replayPlan(patientId, visit, CONSULTATION_PART_OPERATIONS.encounter);
    }
    if (input.vitals) this.vitals.checkCreate(input.vitals);
    const body = { ...input, visit };
    const digest = requestDigest(CONSULTATION_OPERATION, { patientId, input: body });
    const events: SemanticEvent[] = [
      EVENTS.encounter,
      ...(body.note ? [EVENTS.note] : []),
      ...(body.vitals ? [EVENTS.vitals] : []),
      ...(body.diagnoses ?? []).map(() => EVENTS.diagnosis),
    ];
    return this.repository.runParts(context, patientId, 'write_records', events, async (client) => {
      let parts: readonly AuditedPart[] = [];
      const saved = async () => {
        const result = await this.createParts(client, context, patientId, body, idempotencyKey, plan);
        parts = result.parts;
        return result.value;
      };
      const created = await this.repository.executeCreate(
        client, context, patientId, idempotencyKey, CONSULTATION_OPERATION, digest, 'consultation',
        async () => {
          // Nothing is saved under this key yet: a visit that does not start
          // today is refused, as planCreate refuses it (the key row rolls back).
          if (notToday) throw notToday;
          // VIT-1's order rule, also for a new consultation only: a retry of
          // one an older image saved (diastolic equal to systolic was allowed
          // then) replays below instead of being refused.
          if (body.vitals) this.vitals.checkBloodPressureOrder(body.vitals);
          const value = await saved();
          return { value, id: value.encounter.id };
        },
        // A replay of the same request: each part answers its own saved
        // result again (each part's key row replays), audited as a replay.
        () => saved(),
      );
      return { value: created.value, parts };
    });
  }

  private async createParts(
    client: PoolClient,
    context: DataAccessContext,
    patientId: string,
    input: CreateConsultationInput,
    idempotencyKey: string,
    plan: EncounterCreatePlan,
  ): Promise<{ value: ConsultationCreated; parts: AuditedPart[] }> {
    const parts: AuditedPart[] = [];
    const encounter = await this.encounters.createInTransaction(client, context, patientId, input.visit,
      idempotencyKey, plan);
    parts.push({ event: EVENTS.encounter, resourceId: encounter.resourceId, details: encounter.details });
    const encounterId = encounter.value.id;

    let note: ClinicalNoteRow | null = null;
    if (input.note) {
      const created = await this.notes.createInTransaction(client, context, patientId, encounterId, input.note,
        idempotencyKey, CONSULTATION_PART_OPERATIONS.note);
      parts.push({ event: EVENTS.note, resourceId: created.resourceId, details: created.details });
      note = created.value;
    }

    let vitals: VitalRow | null = null;
    if (input.vitals) {
      const created = await this.vitals.createInTransaction(client, context, patientId, encounterId, input.vitals,
        idempotencyKey, CONSULTATION_PART_OPERATIONS.vitals);
      parts.push({ event: EVENTS.vitals, resourceId: created.resourceId, details: created.details });
      vitals = created.value;
    }

    const diagnoses: DiagnosisCreated[] = [];
    for (const [index, diagnosis] of (input.diagnoses ?? []).entries()) {
      const created = await this.diagnoses.createInTransaction(client, context, patientId, encounterId, diagnosis,
        idempotencyKey, CONSULTATION_PART_OPERATIONS.diagnosis(index));
      parts.push({ event: EVENTS.diagnosis, resourceId: created.resourceId, details: created.details });
      diagnoses.push(created.value);
    }

    return { value: { encounter: encounter.value, note, vitals, diagnoses }, parts };
  }
}
