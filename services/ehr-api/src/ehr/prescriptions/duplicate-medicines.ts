import { Body, Controller, Header, HttpCode, Injectable, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import { Transform, type TransformFnParams } from 'class-transformer';
import { IsString, IsUUID, Length, MaxLength } from 'class-validator';
import type { PoolClient, QueryResultRow } from 'pg';
import { RequirePermissions } from '../../common/decorators';
import { DomainProblem } from '../../common/problem';
import type { DataAccessContext, HidRequest } from '../../common/request-context';
import { IsOptionalButNotNull } from '../../common/validation';
import { calendarDate } from '../shared/calendar-date';
import { clinicalContext } from '../shared/clinical-context';
import { ClinicalRepository } from '../shared/clinical.repository';

/*
 * ORD-10 phase 1: a duplicate-medicine warning. It never blocks: the
 * prescribing form asks before it saves (POST .../duplicate-medicine-check),
 * and a new prescription's answer carries the same warning
 * (`duplicateMedicines`). The new medicine is compared only with this
 * patient's prescriptions at this facility that the clinician may read under
 * consent, and only with current ones: draft, active or on hold, and not
 * ended before today (Lagos). Phase 1 matches the same medicine (the same
 * code, or the same medicine name once strength and form are set aside);
 * phase 2 (with Release B) adds medicines of the same class.
 */

const trim = ({ value }: TransformFnParams): unknown => typeof value === 'string' ? value.trim() : value;

export class DuplicateMedicineCheckDto {
  @Transform(trim) @IsString() @Length(1, 500)
  medicationDisplay!: string;

  @IsOptionalButNotNull() @Transform(trim) @IsString() @MaxLength(255)
  medicationCodeSystem?: string;

  @IsOptionalButNotNull() @Transform(trim) @IsString() @MaxLength(100)
  medicationCode?: string;

  /** The prescription being edited or activated, left out of the comparison. */
  @IsOptionalButNotNull() @IsUUID()
  excludePrescriptionId?: string;
}

export interface DuplicateMedicineMatch {
  prescriptionId: string;
  encounterId: string;
  medicationDisplay: string;
  status: 'draft' | 'active' | 'on_hold';
  startsOn: string | null;
  endsOn: string | null;
  createdAt: string;
  /** How it matched: the same code, or the same medicine name. */
  matchedBy: 'code' | 'name';
}

export interface DuplicateMedicineAnswer {
  /** False only when the check could not run; then there is no warning to show, and no promise of none. */
  checked: boolean;
  matches: DuplicateMedicineMatch[];
  /** Plain words for the form, or null when there is nothing to say. */
  message: string | null;
}

export const DUPLICATE_CHECK_NOT_RUN: DuplicateMedicineAnswer = Object.freeze({ checked: false, matches: [],
  message: null }) as DuplicateMedicineAnswer;

/** At most this many current prescriptions are compared (newest first); more is not a real medicine list. */
export const DUPLICATE_COMPARE_LIMIT = 500;

interface CurrentPrescriptionRow extends QueryResultRow {
  id: string; encounterId: string; medicationDisplay: string; medicationCodeSystem: string | null;
  medicationCode: string | null; status: DuplicateMedicineMatch['status']; startsOn: Date | string | null;
  endsOn: Date | string | null; createdAt: Date;
}

/**
 * This patient's current prescriptions at this facility, newest first: $1
 * patient, $2 facility, $3 a prescription to leave out (or null), $4 limit.
 * Row-level security applies as well. Exported for the tests.
 */
export const CURRENT_PRESCRIPTIONS_QUERY = `select id, encounter_id as "encounterId",
  medication_display as "medicationDisplay", medication_code_system as "medicationCodeSystem",
  medication_code as "medicationCode", status, starts_on as "startsOn", ends_on as "endsOn", created_at as "createdAt"
  from ehr.prescriptions
  where patient_id = $1 and facility_id = $2 and ($3::uuid is null or id <> $3::uuid)
    and status in ('draft', 'active', 'on_hold')
    and (ends_on is null or ends_on >= (now() at time zone 'Africa/Lagos')::date)
  order by created_at desc, id desc limit $4`;

/** Words that say how much or in what form, not which medicine. */
const FORM_WORDS = new Set(['mg', 'g', 'mcg', 'ug', 'µg', 'microgram', 'micrograms', 'milligram', 'milligrams', 'gram',
  'grams', 'ml', 'l', 'iu', 'unit', 'units', 'percent', 'tab', 'tabs', 'tablet', 'tablets', 'cap', 'caps', 'capsule',
  'capsules', 'syrup', 'suspension', 'injection', 'inj', 'solution', 'cream', 'ointment', 'gel', 'drops', 'drop',
  'eye', 'ear', 'nasal', 'oral', 'iv', 'im', 'sc', 'suppository', 'suppositories', 'sachet', 'sachets', 'inhaler',
  'spray', 'patch', 'vial', 'vials', 'ampoule', 'ampoules', 'amp', 'dose', 'doses', 'film', 'coated', 'chewable',
  'dispersible', 'extended', 'release', 'modified', 'sr', 'er', 'xr', 'mr', 'cr', 'dt', 'ds', 'forte', 'per',
  'in', 'of', 'and', 'x', 'by', 'w', 'v']);

/**
 * The medicine name of a free-text display: lower case, without anything in
 * brackets, numbers, strengths, units and dose forms, so "Amoxicillin 500 mg
 * capsules" and "amoxicillin 250mg" are the same medicine. Answers '' when
 * nothing is left (then the name cannot match). Exported for the tests.
 */
export function medicineName(display: string): string {
  return display.toLowerCase()
    .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')
    .replace(/[0-9]+(?:[.,][0-9]+)?\s*(?:%|[a-zµ]+)?/g, ' ')
    .split(/[^a-zÀ-ɏ]+/)
    .filter((word) => word.length > 0 && !FORM_WORDS.has(word))
    .join(' ');
}

const key = (value: string | null | undefined) => (value ?? '').trim().toLowerCase();

/** How a current prescription matches the new medicine, or undefined. Exported for the tests. */
export function matchKind(candidate: { medicationDisplay: string; medicationCodeSystem?: string | null;
  medicationCode?: string | null }, row: { medicationDisplay: string; medicationCodeSystem: string | null;
  medicationCode: string | null }): DuplicateMedicineMatch['matchedBy'] | undefined {
  const code = key(candidate.medicationCode);
  if (code && code === key(row.medicationCode)) {
    const system = key(candidate.medicationCodeSystem);
    const rowSystem = key(row.medicationCodeSystem);
    if (!system || !rowSystem || system === rowSystem) return 'code';
  }
  const name = medicineName(candidate.medicationDisplay);
  return name && name === medicineName(row.medicationDisplay) ? 'name' : undefined;
}

/** The plain words the form shows. Exported for the tests. */
export function duplicateMessage(count: number): string | null {
  if (count === 0) return null;
  return count === 1
    ? 'This patient already has a current prescription for this medicine. Check it before you continue.'
    : `This patient already has ${count} current prescriptions for this medicine. Check them before you continue.`;
}

@Injectable()
export class DuplicateMedicineChecker {
  constructor(private readonly repository: ClinicalRepository) {}

  /**
   * The warning for one medicine. Identity decides the read first (a refusal
   * is 403 CONSENT_REQUIRED and is audited); inside the transaction the
   * database must also allow the read of this patient's records here, so "no
   * match" never stands for "could not read". Audited with the patient: the
   * counts only, never the medicine.
   */
  check(context: DataAccessContext, patientId: string, input: DuplicateMedicineCheckDto): Promise<DuplicateMedicineAnswer> {
    return this.repository.run(
      context, patientId, 'read_records',
      { action: 'ehr.prescription.duplicate-check', resourceType: 'prescription', resourceId: patientId },
      async (client) => {
        await requireRecordRead(client, context, patientId);
        const rows = (await client.query<CurrentPrescriptionRow>(CURRENT_PRESCRIPTIONS_QUERY,
          [patientId, context.facilityId, input.excludePrescriptionId ?? null, DUPLICATE_COMPARE_LIMIT])).rows;
        const matches = rows.flatMap((row): DuplicateMedicineMatch[] => {
          const matchedBy = matchKind(input, row);
          return matchedBy ? [{ prescriptionId: row.id, encounterId: row.encounterId,
            medicationDisplay: row.medicationDisplay, status: row.status, startsOn: calendarDate(row.startsOn) ?? null,
            endsOn: calendarDate(row.endsOn) ?? null, createdAt: new Date(row.createdAt).toISOString(), matchedBy }] : [];
        });
        return { value: { checked: true, matches, message: duplicateMessage(matches.length) },
          details: { comparedCount: rows.length, matchCount: matches.length } };
      },
    );
  }

  /**
   * The warning for a prescription just written (its answer's
   * `duplicateMedicines`). It never fails the create: when the check cannot
   * run, the answer says so (`checked: false`).
   */
  async afterCreate<Created extends { id: string; medicationDisplay: string; medicationCodeSystem?: string | null;
    medicationCode?: string | null; status?: unknown }>(context: DataAccessContext, patientId: string,
    created: Created): Promise<Created & { duplicateMedicines: DuplicateMedicineAnswer }> {
    if (created.status === 'cancelled' || created.status === 'entered_in_error' || created.status === 'completed') {
      return { ...created, duplicateMedicines: { checked: true, matches: [], message: null } };
    }
    const duplicateMedicines = await this.check(context, patientId, {
      medicationDisplay: created.medicationDisplay,
      ...(created.medicationCodeSystem ? { medicationCodeSystem: created.medicationCodeSystem } : {}),
      ...(created.medicationCode ? { medicationCode: created.medicationCode } : {}),
      excludePrescriptionId: created.id,
    }).catch(() => DUPLICATE_CHECK_NOT_RUN);
    return { ...created, duplicateMedicines };
  }
}

async function requireRecordRead(client: PoolClient, context: DataAccessContext, patientId: string): Promise<void> {
  const result = await client.query<{ allowed: boolean | null }>(
    `select ehr.context_allows($1::uuid, $2::uuid, 'read_records') as allowed`, [patientId, context.facilityId]);
  if (result.rows[0]?.allowed !== true) {
    throw new DomainProblem(403, 'CONSENT_REQUIRED',
      'Active consent to read the patient\'s records is required to check for the same medicine');
  }
}

/**
 * The check the prescribing form runs before it saves. Direct care only, for
 * those who may write prescriptions (as the allergy check). A POST so the
 * medicine stays out of the URL; it changes nothing.
 */
@Controller('ehr/patients/:patientId')
export class DuplicateMedicinesController {
  constructor(private readonly checker: DuplicateMedicineChecker) {}

  @Post('duplicate-medicine-check')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @RequirePermissions('ehr.prescription.write')
  check(@Req() request: HidRequest, @Param('patientId', new ParseUUIDPipe()) patientId: string,
    @Body() input: DuplicateMedicineCheckDto) {
    return this.checker.check(clinicalContext(request), patientId, input);
  }
}
