import { Transform, Type, type TransformFnParams } from 'class-transformer';
import {
  ArrayMaxSize, ArrayUnique, IsArray, IsBoolean, IsIn, IsInt, IsString, Matches, Max, MaxLength, Min, Validate, ValidateIf,
  ValidatorConstraint, type ValidationArguments, type ValidatorConstraintInterface,
} from 'class-validator';
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

/** ORD-7 (0155): what a facility item is, as ehr.catalog_facility_items stores it. */
export const FACILITY_ITEM_KINDS = ['medicine', 'lab_test'] as const;
export type FacilityItemKind = (typeof FACILITY_ITEM_KINDS)[number];
/** The admin list answers at most this many items, active and withdrawn (planned contract). */
export const FACILITY_ITEM_LIST_LIMIT = 1000;
/** A route as the medicine search's route filter takes it: a plain word or words (letters, spaces, hyphens). */
export const FACILITY_ITEM_ROUTE = /^[a-z][a-z -]{0,99}$/;
/**
 * No C0 control character and no U+007F: U+0000 is a character PostgreSQL's
 * text cannot hold (22021, answered as 503), and none belongs in a name.
 */
const NO_CONTROL_CHARACTER = /^[^\u0000-\u001F\u007F]*$/;
const controlMessage = { message: '$property must not contain control characters' };

/** Only for a medicine, or only for a lab test: refused on the other kind (the database's own check, 23514, said early). */
@ValidatorConstraint({ name: 'facilityItemKindField' })
export class FacilityItemKindField implements ValidatorConstraintInterface {
  validate(_value: unknown, args: ValidationArguments): boolean {
    return (args.object as { kind?: unknown }).kind === args.constraints[0];
  }

  defaultMessage(args: ValidationArguments): string {
    return `${args.property} is only for a ${args.constraints[0] === 'lab_test' ? 'lab test' : 'medicine'}`;
  }
}

/**
 * A length counted in characters as the database counts them (code points):
 * the validator's own count leaves out emoji presentation selectors, so a
 * name it lets through could still break the table's check.
 */
@ValidatorConstraint({ name: 'characterLength' })
export class CharacterLength implements ValidatorConstraintInterface {
  validate(value: unknown, args: ValidationArguments): boolean {
    const [min, max] = args.constraints as [number, number];
    if (typeof value !== 'string') return false;
    const characters = [...value].length;
    return characters >= min && characters <= max;
  }

  defaultMessage(args: ValidationArguments): string {
    const [min, max] = args.constraints as [number, number];
    return `${args.property} must be ${min} to ${max} characters`;
  }
}

const lowerWords = ({ value }: TransformFnParams): unknown => Array.isArray(value)
  ? value.map((word: unknown) => typeof word === 'string' ? word.trim().toLowerCase() : word)
  : value;

/**
 * POST ehr/catalog/facility-items (0155): one of this facility's own items.
 * kind and display are required. A medicine needs genericName and may have
 * strength, doseForm and routes (at most 5 plain words, kept in lower case as
 * the national list keeps them); a lab test may have specimen and category.
 * A field of the other kind, null, or any other field is VALIDATION_FAILED.
 * Text is trimmed and holds no control character.
 */
export class CreateFacilityItemDto {
  @IsIn(FACILITY_ITEM_KINDS)
  kind!: FacilityItemKind;

  @Transform(trim)
  @IsString()
  @Matches(NO_CONTROL_CHARACTER, controlMessage)
  @Validate(CharacterLength, [1, 500])
  display!: string;

  @ValidateIf((item: { kind?: unknown }, value: unknown) => value !== undefined || item.kind === 'medicine')
  @Validate(FacilityItemKindField, ['medicine'])
  @Transform(trim)
  @IsString()
  @Matches(NO_CONTROL_CHARACTER, controlMessage)
  @Validate(CharacterLength, [1, 200])
  genericName?: string;

  @IsOptionalButNotNull()
  @Validate(FacilityItemKindField, ['medicine'])
  @Transform(trim)
  @IsString()
  @Matches(NO_CONTROL_CHARACTER, controlMessage)
  @Validate(CharacterLength, [1, 80])
  strength?: string;

  @IsOptionalButNotNull()
  @Validate(FacilityItemKindField, ['medicine'])
  @IsIn(CATALOG_DOSE_FORMS)
  doseForm?: CatalogDoseForm;

  @IsOptionalButNotNull()
  @Validate(FacilityItemKindField, ['medicine'])
  @Transform(lowerWords)
  @IsArray()
  @ArrayMaxSize(5)
  @ArrayUnique()
  @IsString({ each: true })
  @Matches(FACILITY_ITEM_ROUTE, { each: true, message: 'each route must be a plain word of 1 to 100 letters' })
  routes?: string[];

  @IsOptionalButNotNull()
  @Validate(FacilityItemKindField, ['lab_test'])
  @Transform(trim)
  @IsString()
  @Matches(NO_CONTROL_CHARACTER, controlMessage)
  @Validate(CharacterLength, [1, 100])
  specimen?: string;

  @IsOptionalButNotNull()
  @Validate(FacilityItemKindField, ['lab_test'])
  @IsIn(CATALOG_LAB_CATEGORIES)
  category?: (typeof CATALOG_LAB_CATEGORIES)[number];
}

/**
 * PATCH ehr/catalog/facility-items/:itemId (0155): withdraw an item
 * (active false) or bring it back (active true), at the row version the
 * screen loaded. Nothing else changes: to correct an item, withdraw it and
 * add a new one.
 */
export class UpdateFacilityItemDto {
  @IsInt()
  @Min(1)
  @Max(Number.MAX_SAFE_INTEGER)
  expectedRowVersion!: number;

  @IsBoolean()
  active!: boolean;
}

/** GET ehr/catalog/facility-items?kind= (0155): this facility's items of a kind, or of both kinds. */
export class ListFacilityItemsQueryDto {
  @IsOptionalButNotNull()
  @IsIn(FACILITY_ITEM_KINDS)
  kind?: FacilityItemKind;
}
