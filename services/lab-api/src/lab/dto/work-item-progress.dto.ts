import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsObject, IsUUID, ValidateBy, ValidateNested }
  from 'class-validator';

/** At most this many lab requests in one progress read (ORD-3). */
export const WORK_ITEM_PROGRESS_MAX_IDS = 100;

/** At most this many patients in one batch progress read (decision 4; a MY-1 page). */
export const WORK_ITEM_PROGRESS_BATCH_MAX_PATIENTS = 50;

/**
 * The body of POST lab/work-items/progress (ORD-3): one patient and the EHR
 * lab requests whose progress the clinician's list shows. Ids only, in the
 * body, never a Health ID and never in the URL.
 */
export class LabWorkItemProgressDto {
  @IsUUID() patientId!: string;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(WORK_ITEM_PROGRESS_MAX_IDS) @ArrayUnique() @IsUUID(undefined, { each: true })
  sourceEhrOrderIds!: string[];
}

/**
 * The rules across the batch body, in this order; [] when it holds (non-arrays
 * and malformed entries are left to the other rules). Letter case is ignored
 * because Postgres reads a uuid in either case, so two spellings of one id
 * would be one patient, or one lab request, asked twice.
 */
export function progressBatchProblems(patients: unknown, idField: string): string[] {
  if (!Array.isArray(patients)) return [];
  const entries = patients.filter((entry): entry is Record<string, unknown> =>
    typeof entry === 'object' && entry !== null && !Array.isArray(entry));
  const idLists = entries.map((entry) => entry[idField]).filter((ids): ids is unknown[] => Array.isArray(ids));
  const patientIds = entries.map((entry) => entry.patientId).filter((id): id is string => typeof id === 'string');
  const ids = idLists.flat().filter((id): id is string => typeof id === 'string');
  const repeats = (values: string[]) => new Set(values.map((value) => value.toLowerCase())).size !== values.length;
  const problems: string[] = [];
  if (idLists.reduce((total, list) => total + list.length, 0) > WORK_ITEM_PROGRESS_MAX_IDS) {
    problems.push(`patients must hold at most ${WORK_ITEM_PROGRESS_MAX_IDS} ids in all`);
  }
  if (repeats(patientIds)) problems.push('patients must name each patient once');
  if (repeats(ids)) problems.push('patients must name each id once');
  return problems;
}

/** One constraint for every rule across the batch body, so the problem names each rule that fails. */
function ProgressBatch(idField: string): PropertyDecorator {
  return ValidateBy({ name: 'workItemProgressBatch', validator: {
    validate: (value: unknown) => progressBatchProblems(value, idField).length === 0,
    defaultMessage: (args) => progressBatchProblems(args?.value, idField).join('; '),
  } });
}

/**
 * The body of POST lab/work-items/progress/batch (decision 4): each entry is
 * exactly the one-patient body, so every patient is held to the same rules.
 */
export class LabWorkItemProgressBatchDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(WORK_ITEM_PROGRESS_BATCH_MAX_PATIENTS)
  // ValidateNested checks each element of an entry that is itself an array,
  // so an array of valid bodies would pass as one entry, past the rules
  // across the body (and with no patientId of its own): each entry must be
  // one object. Any entry that is not one (an array, a string) is refused
  // with this rule's message.
  @IsObject({ each: true })
  @ValidateNested({ each: true }) @Type(() => LabWorkItemProgressDto)
  @ProgressBatch('sourceEhrOrderIds')
  patients!: LabWorkItemProgressDto[];
}
