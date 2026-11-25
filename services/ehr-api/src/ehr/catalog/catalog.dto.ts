import { Transform, Type, type TransformFnParams } from 'class-transformer';
import { IsIn, IsInt, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
import { IsOptionalButNotNull } from '../../common/validation';

/** ORD-7 (0149): section 46's dose forms, the medicine search's doseForm filter. */
export const CATALOG_DOSE_FORMS = ['tablet', 'capsule', 'liquid', 'injection', 'cream', 'inhaler', 'drops', 'other'] as const;
export type CatalogDoseForm = (typeof CATALOG_DOSE_FORMS)[number];

/**
 * ORD-7: the lab-test categories: the planned contract's nine ("Lab test
 * search") and blood-bank, immunology and histopathology, which the
 * combined list (#312) uses.
 */
export const CATALOG_LAB_CATEGORIES = ['haematology', 'chemistry', 'microbiology', 'serology', 'parasitology',
  'urine-and-stool', 'hormones', 'molecular', 'blood-bank', 'immunology', 'histopathology', 'other'] as const;

export const CATALOG_SEARCH_DEFAULT_LIMIT = 10;
export const CATALOG_SEARCH_MAX_LIMIT = 25;
/** q is 2-100 characters after trimming; the service refuses a shorter one with its own code. */
export const CATALOG_SEARCH_MAX_LENGTH = 100;

const trim = ({ value }: TransformFnParams): unknown => typeof value === 'string' ? value.trim() : value;

/**
 * GET ehr/catalog/lab-tests?q=&limit=. q is required (the service answers a
 * missing or short one with CATALOG_SEARCH_TEXT_TOO_SHORT, and a Health ID or
 * NIN shape with CATALOG_SEARCH_TEXT_NOT_ALLOWED); limit 1-25, default 10.
 * Any other parameter, or one given twice, is VALIDATION_FAILED.
 */
export class SearchCatalogLabTestsQueryDto {
  @IsOptionalButNotNull()
  @Transform(trim)
  @IsString()
  @MaxLength(CATALOG_SEARCH_MAX_LENGTH)
  q?: string;

  @IsOptionalButNotNull()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(CATALOG_SEARCH_MAX_LIMIT)
  limit: number = CATALOG_SEARCH_DEFAULT_LIMIT;
}

/**
 * GET ehr/catalog/medicines?q=&limit=&doseForm=&route=. As the lab-test
 * search, plus doseForm (one of section 46's values) and route (a plain word
 * or words, letters, spaces and hyphens, up to 100 characters; compared
 * without letter case to the list's routes).
 */
export class SearchCatalogMedicinesQueryDto extends SearchCatalogLabTestsQueryDto {
  @IsOptionalButNotNull()
  @IsIn(CATALOG_DOSE_FORMS)
  doseForm?: CatalogDoseForm;

  @IsOptionalButNotNull()
  @Transform(trim)
  @IsString()
  @MaxLength(100)
  @Matches(/^[A-Za-z][A-Za-z -]{0,99}$/, { message: 'route must be a plain word' })
  route?: string;
}

/** GET ehr/terminology/diagnoses?q=&limit= (ORD-9): q and limit as the lab-test search. */
export class SearchDiagnosesQueryDto extends SearchCatalogLabTestsQueryDto {}

/** GET ehr/terminology/diagnoses/recent?limit= (ORD-9, 0153): limit 1-50, default 20. */
export const RECENT_DIAGNOSES_DEFAULT_LIMIT = 20;
export const RECENT_DIAGNOSES_MAX_LIMIT = 50;

export class RecentDiagnosesQueryDto {
  @IsOptionalButNotNull()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(RECENT_DIAGNOSES_MAX_LIMIT)
  limit: number = RECENT_DIAGNOSES_DEFAULT_LIMIT;
}
