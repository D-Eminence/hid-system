import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsObject, IsString, IsUUID, Length, Matches, Max, Min,
  registerDecorator, ValidateNested, type ValidationOptions } from 'class-validator';
import { IsOptionalButNotNull } from '../../common/validation';
import type { PurposeOfUse } from '../../common/request-context';
import { ITEM_ID } from '../reading/paper-reading.contract';
import { LEARNING_FIELDS, type LearningField } from '../learning/learning';
import { CHANGE_REASONS, FIELD_CLASSES, REJECTION_REASON_CODES, REMOVAL_REASONS,
  type RejectionReasonCode, type RemovalReason } from '../quality/review-outcome';

/**
 * An item of the reading the reviewer left out, and optionally why (owner decision Q43: nothing is ever required from
 * staff). Counted only; the id never leaves the request.
 */
export class RemovedItemDto {
  @IsString()
  @Matches(ITEM_ID)
  itemId!: string;

  @IsOptionalButNotNull()
  @IsIn(REMOVAL_REASONS)
  removalReason?: RemovalReason;
}

/**
 * A learning suggestion (0119) the website displayed beside an item's field while the reviewer worked: "Possibly X?
 * Check the paper". Only these are recorded as shown (taken when the saved value is the suggestion), and only their
 * fields are kept out of the evidence; a rule switched on or off between opening and saving changes nothing.
 */
export class ShownSuggestionDto {
  @IsString()
  @Matches(ITEM_ID)
  itemId!: string;

  @IsUUID()
  ruleId!: string;

  @IsIn(LEARNING_FIELDS)
  field!: LearningField;

  @IsString()
  @Length(1, 120)
  value!: string;
}

/**
 * corrections stays a free list of objects (existing clients send { field, originalValue, correctedValue }).
 * Three optional keys are checked when present: itemId (a reading item id), fields (1 to 9 distinct field classes)
 * and changeReason ('misread' or 'clinical_update').
 */
function IsReviewCorrections(options?: ValidationOptions): PropertyDecorator {
  return (target, propertyName) => registerDecorator({
    name: 'isReviewCorrections', target: target.constructor, propertyName: String(propertyName),
    options: { message: 'corrections[].itemId, fields or changeReason is invalid', ...options },
    validator: {
      validate(value: unknown) {
        if (!Array.isArray(value)) return false;
        return value.every((entry) => {
          if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return false;
          const correction = entry as Record<string, unknown>;
          if (correction.itemId !== undefined
            && (typeof correction.itemId !== 'string' || !ITEM_ID.test(correction.itemId))) return false;
          if (correction.fields !== undefined) {
            const fields = correction.fields;
            if (!Array.isArray(fields) || fields.length < 1 || fields.length > FIELD_CLASSES.length
              || new Set(fields).size !== fields.length
              || fields.some((field) => !(FIELD_CLASSES as readonly unknown[]).includes(field))) return false;
          }
          return correction.changeReason === undefined
            || (CHANGE_REASONS as readonly unknown[]).includes(correction.changeReason);
        });
      },
    },
  });
}

export class ValidateOcrJobDto {
  @IsUUID('4')
  extractionId!: string;

  @IsInt()
  @Min(1)
  expectedVersion!: number;

  @IsObject()
  validatedPayload!: Record<string, unknown>;

  @IsIn(['validated', 'rejected'])
  disposition!: 'validated' | 'rejected';

  @IsIn(['EHR', 'LAB', 'PHARMACY', 'DOCUMENT_ONLY', 'UNCLASSIFIED'])
  targetDomain!: 'EHR' | 'LAB' | 'PHARMACY' | 'DOCUMENT_ONLY' | 'UNCLASSIFIED';

  @IsIn(['clinical_note', 'document_only', 'lab_document', 'historical_medication_evidence', 'unclassified'])
  candidateType!: 'clinical_note' | 'document_only' | 'lab_document' | 'historical_medication_evidence' | 'unclassified';

  @IsObject()
  acceptedFields!: Record<string, unknown>;

  @IsArray()
  rejectedFields!: readonly Record<string, unknown>[];

  @IsArray()
  @IsReviewCorrections()
  corrections!: readonly Record<string, unknown>[];

  @IsString()
  @Length(8, 500)
  reason!: string;

  @IsIn(['healthcare-operations'])
  purpose!: PurposeOfUse;

  // Optional review signals (review outcome, counts only). Absent fields leave the request digest unchanged.

  /** The reviewer confirms they checked every item of the reading against the paper. */
  @IsOptionalButNotNull()
  @IsBoolean()
  reviewConfirmed?: boolean;

  /** Items on the paper the reading did not find, as the reviewer counted them. */
  @IsOptionalButNotNull()
  @IsInt()
  @Min(0)
  @Max(200)
  missedItems?: number;

  /** Reading items the reviewer left out, each with a reason. */
  @IsOptionalButNotNull()
  @IsArray()
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => RemovedItemDto)
  removedItems?: RemovedItemDto[];

  /** The learning suggestions displayed on this reading (0119); absent: none was displayed. */
  @IsOptionalButNotNull()
  @IsArray()
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => ShownSuggestionDto)
  shownSuggestions?: ShownSuggestionDto[];

  /** Why a document was rejected; only with disposition 'rejected'. */
  @IsOptionalButNotNull()
  @IsIn(REJECTION_REASON_CODES)
  rejectionReasonCode?: RejectionReasonCode;
}
