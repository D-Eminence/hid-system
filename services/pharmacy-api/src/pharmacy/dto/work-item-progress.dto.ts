import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsObject, IsUUID, ValidateBy, ValidateNested }
  from 'class-validator';

/** At most this many prescriptions in one progress read (ORD-3). */
export const WORK_ITEM_PROGRESS_MAX_IDS = 100;

/** At most this many patients in one batch progress read (decision 4; a MY-1 page). */
export const WORK_ITEM_PROGRESS_BATCH_MAX_PATIENTS = 50;

/**
 * The body of POST pharmacy/work-items/progress (ORD-3): one patient and the
 * EHR prescriptions whose pharmacy progress the clinician's list shows. Ids
 * only, in the body, never a Health ID and never in the URL.
 */
export class WorkItemProgressDto {
  @IsUUID() patientId!: string;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(WORK_ITEM_PROGRESS_MAX_IDS) @ArrayUnique() @IsUUID(undefined, { each: true })
  sourceEhrPrescriptionIds!: string[];
}

/**
 * The rules across the batch body, in this order; [] when it holds (non-arrays and malformed entries are left to the
 * other rules). Letter case is ignored, as the database compares uuids, so one patient or one id cannot be asked
 * twice under two spellings: the call holds what one patient's call each would hold, and no more.
 */
export function progressBatchProblems(patients: unknown, idField: string): string[] {
  if (!Array.isArray(patients)) return [];
  const entries = patients.filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null);
  const lists = entries.map((entry) => entry[idField]).filter((ids): ids is unknown[] => Array.isArray(ids));
  const repeated = (values: unknown[]) => {
    const spellings = values.filter((value): value is string => typeof value === 'string')
      .map((value) => value.toLowerCase());
    return new Set(spellings).size !== spellings.length;
  };
  const problems: string[] = [];
  if (lists.reduce((total, ids) => total + ids.length, 0) > WORK_ITEM_PROGRESS_MAX_IDS) {
    problems.push(`patients must hold at most ${WORK_ITEM_PROGRESS_MAX_IDS} ids in all`);
  }
  if (repeated(entries.map((entry) => entry.patientId))) problems.push('patients must name each patient once');
  if (repeated(lists.flat())) problems.push('patients must name each id once');
  return problems;
}

/** One constraint for the rules across the body, so a body that breaks several gets all of them in one message. */
function ProgressBatchRules(idField: string): PropertyDecorator {
  return ValidateBy({ name: 'workItemProgressBatch', validator: {
    validate: (value: unknown) => progressBatchProblems(value, idField).length === 0,
    defaultMessage: (args) => progressBatchProblems(args?.value, idField).join('; '),
  } });
}

/**
 * The body of POST pharmacy/work-items/progress/batch (ORD-3, decision 4):
 * several patients, each entry exactly the one-patient body, so each patient
 * is held to the same rules as a call of its own; 1 to 50 patients and at
 * most 100 ids in all, as one call of ehr-api asks.
 */
export class WorkItemProgressBatchDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(WORK_ITEM_PROGRESS_BATCH_MAX_PATIENTS)
  // ValidateNested checks each element of an entry that is itself an array,
  // so an array of valid bodies would pass as one entry, past the rules
  // across the body (and with no patientId of its own): each entry must be
  // one object. Any entry that is not one (an array, a string) is refused
  // with this rule's message.
  @IsObject({ each: true })
  @ValidateNested({ each: true }) @Type(() => WorkItemProgressDto)
  @ProgressBatchRules('sourceEhrPrescriptionIds')
  patients!: WorkItemProgressDto[];
}
