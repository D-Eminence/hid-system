import { ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsUUID } from 'class-validator';

/** At most this many prescriptions in one progress read (ORD-3). */
export const WORK_ITEM_PROGRESS_MAX_IDS = 100;

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
