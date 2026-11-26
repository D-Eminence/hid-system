import { Injectable, Optional, type PipeTransform } from '@nestjs/common';
import { DomainProblem } from '../../common/problem';
import { createValidationPipe } from '../../common/validation-pipe';
import { CreatePrescriptionDto, CreatePrescriptionWithDetailsDto } from '../shared/clinical.dto';
import {
  CreatePrescriptionWithDetailsAndScheduleDto, CreatePrescriptionWithScheduleDto, PRESCRIPTION_INPATIENT_SCHEDULE_OFF,
  PrescriptionInpatientSchedule, SCHEDULE_MESSAGES, type InpatientScheduleDto,
} from './inpatient-schedule';

/** The body a prescription create carries: today's, or with the details while they are on. */
export type CreatePrescriptionInput = (CreatePrescriptionDto | CreatePrescriptionWithDetailsDto)
  & { inpatientSchedule?: InpatientScheduleDto };

/** The seven optional, create-only fields (0125), by their request and answer names. */
export const DISPENSING_DETAIL_FIELDS = ['priority', 'strength', 'doseForm', 'durationValue', 'durationUnit',
  'quantityToDispense', 'quantityUnit'] as const;

/** What a prescription answer adds while the details are on: each one that was given, nothing for the others. */
export interface PrescriptionDispensingDetailsAnswer {
  priority?: string;
  strength?: string;
  doseForm?: string;
  durationValue?: number;
  durationUnit?: string;
  quantityToDispense?: number;
  quantityUnit?: string;
}

/** The seven columns as the SELECT list names them while on (null when not given; numeric as text). */
interface DispensingDetailColumns {
  priority?: string | null;
  strength?: string | null;
  doseForm?: string | null;
  durationValue?: number | null;
  durationUnit?: string | null;
  quantityToDispense?: string | null;
  quantityUnit?: string | null;
}

const DETAIL_FIELDS: ReadonlySet<string> = new Set(DISPENSING_DETAIL_FIELDS);

/**
 * Prescription strength, form, duration, quantity to dispense and priority
 * (0125; owner decision 25 of 2026-11-01, D-Eminence: "all recommended except
 * D5", items 3b and 4; D9: the pharmacist still confirms the quantity).
 *
 * Behind PRESCRIPTION_DISPENSING_DETAILS_ENABLED (off by default). Off, the
 * prescriptions routes are exactly as before: a create body is checked against
 * CreatePrescriptionDto, so a detail field is refused 400 VALIDATION_FAILED
 * ("property priority should not exist"), the statements and their columns
 * are today's, the answers carry no new key and the list no flag. On, a create
 * may carry them (CreatePrescriptionWithDetailsDto; each pair together), the
 * INSERT stores them, every prescription answer adds each one that is set
 * under its request name, and the list says `dispensingDetails: true`, so the
 * website sends the fields only to a backend that takes them. The update
 * route never changes them. pharmacy-api reads them from the accepted
 * version's snapshot (pharmacy.work_item_prescription_details).
 */
export class PrescriptionDispensingDetails {
  constructor(readonly enabled: boolean) {}

  /** Appended to the prescription SELECT and RETURNING lists: nothing while off. */
  selectList(): string {
    return this.enabled ? `, priority, medication_strength as "strength", medication_dose_form as "doseForm",
  duration_value as "durationValue", duration_unit as "durationUnit",
  quantity_to_dispense as "quantityToDispense", quantity_unit as "quantityUnit"` : '';
  }

  /**
   * A row as the EHR answers it: today's keys, then each detail that is set,
   * under its request name (the quantity as a number). Off, the row itself.
   */
  project<Row extends object>(row: Row): Row & PrescriptionDispensingDetailsAnswer {
    if (!this.enabled) return row;
    const { priority, strength, doseForm, durationValue, durationUnit, quantityToDispense, quantityUnit, ...rest } =
      row as Row & DispensingDetailColumns;
    return {
      ...rest,
      ...(priority == null ? {} : { priority }),
      ...(strength == null ? {} : { strength }),
      ...(doseForm == null ? {} : { doseForm }),
      ...(durationValue == null ? {} : { durationValue: Number(durationValue) }),
      ...(durationUnit == null ? {} : { durationUnit }),
      ...(quantityToDispense == null ? {} : { quantityToDispense: Number(quantityToDispense) }),
      ...(quantityUnit == null ? {} : { quantityUnit }),
    } as Row & PrescriptionDispensingDetailsAnswer;
  }

  /** The prescriptions list's served flag: present only while on. */
  flag(): { dispensingDetails?: true } {
    return this.enabled ? { dispensingDetails: true } : {};
  }

  /** The pairs: a duration needs its unit and a quantity its unit (400, as the dose pair). */
  requirePairs(input: CreatePrescriptionInput): void {
    if (!this.enabled) return;
    const details = input as CreatePrescriptionWithDetailsDto;
    if ((details.durationValue === undefined) !== (details.durationUnit === undefined)) {
      throw new DomainProblem(400, 'DURATION_INCOMPLETE', 'Duration value and unit must be supplied together');
    }
    if ((details.quantityToDispense === undefined) !== (details.quantityUnit === undefined)) {
      throw new DomainProblem(400, 'QUANTITY_INCOMPLETE', 'Quantity to dispense and its unit must be supplied together');
    }
  }

  /**
   * What the Idempotency-Key digest covers: the body as today, without the
   * detail fields it does not carry. The DTO keeps an absent optional field as
   * an own undefined property, which the digest prints, so a body without
   * details hashes as it did before this release and a retry across the
   * deploy replays instead of answering 409 IDEMPOTENCY_KEY_REUSED.
   */
  digestInput(input: CreatePrescriptionInput): object {
    if (!this.enabled) return input;
    return Object.fromEntries(Object.entries(input).filter(([field, value]) => !(DETAIL_FIELDS.has(field)
      && value === undefined)));
  }

  /** The INSERT's extra columns and values ($17-$23) while on: none while off. */
  insertColumns(): string {
    return this.enabled ? `,
               priority, medication_strength, medication_dose_form, duration_value, duration_unit,
               quantity_to_dispense, quantity_unit` : '';
  }

  insertPlaceholders(): string {
    return this.enabled ? ',$17,$18,$19,$20,$21,$22,$23' : '';
  }

  insertValues(input: CreatePrescriptionInput): unknown[] {
    if (!this.enabled) return [];
    const details = input as CreatePrescriptionWithDetailsDto;
    return [details.priority ?? null, details.strength ?? null, details.doseForm ?? null,
      details.durationValue ?? null, details.durationUnit ?? null, details.quantityToDispense ?? null,
      details.quantityUnit ?? null];
  }
}

/** Off: exactly today (the tests' and every direct caller's default). */
export const PRESCRIPTION_DISPENSING_DETAILS_OFF = new PrescriptionDispensingDetails(false);

/**
 * Validates a prescription create body with the class the setting picks:
 * CreatePrescriptionDto while off (today's checks and refusals, word for
 * word), CreatePrescriptionWithDetailsDto while on, through the same
 * validation the app installs globally. The controller's body type is a
 * union, so the global pipe leaves the body to this one.
 */
@Injectable()
export class CreatePrescriptionBodyPipe implements PipeTransform<unknown, Promise<CreatePrescriptionInput>> {
  private readonly validation = createValidationPipe();

  constructor(private readonly details: PrescriptionDispensingDetails,
    @Optional() private readonly schedule: PrescriptionInpatientSchedule = PRESCRIPTION_INPATIENT_SCHEDULE_OFF) {}

  /**
   * NUR-1 (0175): while NURSING_ENABLED is on the body may also carry
   * `inpatientSchedule`; off, a body carrying it is refused with 400
   * NURSING_FIELDS_NOT_AVAILABLE before any other check, and every other body
   * is checked exactly as before.
   */
  transform(value: unknown): Promise<CreatePrescriptionInput> {
    if (!this.schedule.enabled && typeof value === 'object' && value !== null && 'inpatientSchedule' in value) {
      throw new DomainProblem(400, 'NURSING_FIELDS_NOT_AVAILABLE', SCHEDULE_MESSAGES.notAvailable);
    }
    const metatype = this.schedule.enabled
      ? (this.details.enabled ? CreatePrescriptionWithDetailsAndScheduleDto : CreatePrescriptionWithScheduleDto)
      : (this.details.enabled ? CreatePrescriptionWithDetailsDto : CreatePrescriptionDto);
    return this.validation.transform(value, { type: 'body', data: undefined, metatype });
  }
}
