import { IsInt, Min } from 'class-validator';

/**
 * The body of POST pharmacy/work-items/:workItemId/accept (ORD-4): exactly
 * the work item version the pharmacist saw, a whole number of 1 or more. No
 * typed reason, as for other first steps (FR-1, Q105). The global
 * ValidationPipe refuses any other field (400 VALIDATION_FAILED), and does no
 * implicit conversion, so "1" is refused as well.
 */
export class AcceptWorkItemDto {
  @IsInt() @Min(1) expectedWorkItemVersion!: number;
}
