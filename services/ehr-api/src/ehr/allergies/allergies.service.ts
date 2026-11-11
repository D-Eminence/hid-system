import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { DomainProblem } from '../../common/problem';
import type { DataAccessContext } from '../../common/request-context';
import { requestDigest } from '../shared/clinical-context';
import { ClinicalRepository } from '../shared/clinical.repository';
import { isNoKnownAllergy } from './allergy-match';
import { checkMedicineAgainstAllergies, patientReportedAllergies, RECORDED_ALLERGY_COLUMNS,
  lockPatientAllergies, type RecordedAllergyRow, warningToken } from './allergy-reader';
import type { AllergyCheckDto, CreateAllergyDto, MarkAllergyEnteredInErrorDto } from './allergies.dto';

/** A recorded allergy as the routes answer it; recordedHere tells the website whether it may mark it entered in error. */
export type RecordedAllergy = RecordedAllergyRow & { recordedHere: boolean };

/**
 * Allergies (0124). Recorded allergies (ehr.recorded_allergies) are what a
 * clinician recorded at a facility; patient-reported allergies are the text
 * the patient entered in their own health information (0094). The list
 * answers both, apart. Every read and write goes through
 * ClinicalRepository.run (the patient's access at this facility, checked by
 * Identity and again by RLS) and is audited by action, resource and counts,
 * never by the substance, reaction or reason text.
 */
@Injectable()
export class AllergiesService {
  constructor(private readonly repository: ClinicalRepository) {}

  list(context: DataAccessContext, patientId: string, includeEnteredInError: boolean) {
    return this.repository.run(
      context, patientId, 'read_records',
      { action: 'ehr.allergy.list', resourceType: 'allergy', resourceId: patientId },
      async (client) => {
        const recorded = await client.query<RecordedAllergyRow>(
          `select ${RECORDED_ALLERGY_COLUMNS} from ehr.recorded_allergies
           where patient_id = $1 and ($2::boolean or status = 'active')
           order by (status = 'active') desc,
             array_position(array['severe', 'unknown', 'moderate', 'mild'], severity), created_at desc, id desc
           limit 200`,
          [patientId, includeEnteredInError],
        );
        const reported = await patientReportedAllergies(client, patientId);
        const items = recorded.rows.map((row) => withPlace(row, context));
        return {
          value: {
            recorded: items,
            patientReported: { allergies: reported.text, updatedAt: reported.updatedAt },
          },
          details: { resultCount: items.length, patientReported: reported.text !== null },
        };
      },
    );
  }

  create(context: DataAccessContext, patientId: string, input: CreateAllergyDto, key: string) {
    if (isNoKnownAllergy(input.substance)) {
      throw new DomainProblem(400, 'ALLERGY_NOT_A_SUBSTANCE',
        'Record the medicine or substance the patient reacts to. "No known allergies" is not recorded as an allergy.');
    }
    const operation = 'allergy.create';
    const digest = requestDigest(operation, { patientId, input });
    return this.repository.run(
      context, patientId, 'write_records', { action: 'ehr.allergy.create', resourceType: 'allergy' },
      (client) => this.repository.executeCreate(
        client, context, patientId, key, operation, digest, 'allergy',
        async () => {
          // Serialized with the allergy check at prescribing for this patient (allergy-reader.ts).
          await lockPatientAllergies(client, patientId);
          const result = await client.query<RecordedAllergyRow>(
            `insert into ehr.recorded_allergies (
               patient_id, facility_id, created_by, created_by_membership_id, substance, reaction, severity
             ) values ($1, $2, $3, $4, $5, $6, $7)
             returning ${RECORDED_ALLERGY_COLUMNS}`,
            [patientId, context.facilityId, context.actor.accountId, context.membershipId,
              input.substance, input.reaction ?? null, input.severity],
          );
          const row = single(result.rows[0]);
          return { value: withPlace(row, context), id: row.id };
        },
        async (id) => {
          const row = await find(client, patientId, id);
          return row ? withPlace(row, context) : undefined;
        },
      ),
    );
  }

  markEnteredInError(
    context: DataAccessContext, patientId: string, allergyId: string, input: MarkAllergyEnteredInErrorDto,
  ) {
    return this.repository.run(
      context, patientId, 'write_records',
      { action: 'ehr.allergy.entered-in-error', resourceType: 'allergy', resourceId: allergyId },
      async (client) => {
        // Read before locking: under forced RLS, FOR UPDATE applies the update policy, which hides
        // another facility's rows, so a locking read alone would answer 404 instead of 409 here.
        const visible = single(await find(client, patientId, allergyId));
        if (visible.facilityId !== context.facilityId) {
          throw new DomainProblem(409, 'ALLERGY_RECORDED_ELSEWHERE',
            'Only the facility that recorded this allergy can mark it as entered in error.');
        }
        const current = single(await find(client, patientId, allergyId, true));
        if (current.status !== 'active') {
          throw new DomainProblem(409, 'ALLERGY_ALREADY_ENTERED_IN_ERROR', 'This allergy is already marked as entered in error.');
        }
        if (Number(current.rowVersion) !== input.expectedRowVersion) {
          throw new DomainProblem(412, 'VERSION_CONFLICT', 'This allergy changed since it was loaded. Reload and try again.');
        }
        await this.repository.setChangeReason(client, input.reason);
        const result = await client.query<RecordedAllergyRow>(
          `update ehr.recorded_allergies
             set status = 'entered_in_error', entered_in_error_by = $1, entered_in_error_reason = $2,
                 entered_in_error_at = clock_timestamp()
           where id = $3 and patient_id = $4 and facility_id = $5 and row_version = $6 and status = 'active'
           returning ${RECORDED_ALLERGY_COLUMNS}`,
          [context.actor.accountId, input.reason, allergyId, patientId, context.facilityId, input.expectedRowVersion],
        );
        const row = result.rows[0];
        if (!row) throw new DomainProblem(412, 'VERSION_CONFLICT', 'This allergy changed since it was loaded. Reload and try again.');
        return { value: withPlace(row, context), resourceId: allergyId, details: { rowVersion: row.rowVersion } };
      },
      async (client) => (await find(client, patientId, allergyId)) !== undefined,
    );
  }

  /**
   * The warning the prescribing form shows before it sends the prescription,
   * with the warningToken the prescriber's acknowledgement must carry.
   */
  check(context: DataAccessContext, patientId: string, input: AllergyCheckDto) {
    return this.repository.run(
      context, patientId, 'read_records',
      { action: 'ehr.allergy.check', resourceType: 'allergy', resourceId: patientId },
      async (client) => {
        const medicine = { display: input.medicationDisplay, code: input.medicationCode ?? null };
        const matches = await checkMedicineAgainstAllergies(client, patientId, context.facilityId, medicine);
        return { value: { matches, acknowledgementRequired: matches.length > 0, warningToken: warningToken(matches, medicine) },
          details: { matchCount: matches.length } };
      },
    );
  }
}

async function find(client: PoolClient, patientId: string, id: string, lock = false): Promise<RecordedAllergyRow | undefined> {
  const result = await client.query<RecordedAllergyRow>(
    `select ${RECORDED_ALLERGY_COLUMNS} from ehr.recorded_allergies where id = $1 and patient_id = $2${lock ? ' for update' : ''}`,
    [id, patientId],
  );
  return result.rows[0];
}

function withPlace(row: RecordedAllergyRow, context: DataAccessContext): RecordedAllergy {
  return { ...row, recordedHere: row.facilityId === context.facilityId };
}

function single(row: RecordedAllergyRow | undefined): RecordedAllergyRow {
  if (!row) throw new DomainProblem(404, 'ALLERGY_NOT_FOUND', 'Allergy was not found');
  return row;
}
