import { ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsUUID } from 'class-validator';

/** At most this many lab requests in one progress read (ORD-3). */
export const WORK_ITEM_PROGRESS_MAX_IDS = 100;

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
