import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsNumber, IsOptional, IsString, MaxLength, MinLength,
  ValidateNested } from 'class-validator';

/**
 * Trimmed, inner whitespace collapsed, NUL characters (which Postgres text
 * cannot hold) removed; an empty text is treated as not given.
 */
export const trimmedText = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.replace(/\u0000/g, '').trim().replace(/\s+/g, ' ') || undefined : value;

export const GLUCOSE_UNITS = ['mmol/L', 'mg/dL'] as const;
export const GLUCOSE_TIMINGS = ['fasting', 'random'] as const;
export const MALARIA_RDT_RESULTS = ['positive', 'negative', 'not_done'] as const;
export const HEARING_RESULTS = ['pass', 'refer', 'not_done'] as const;
/** The most medicines one screening lists (0118). */
export const SCREENING_MEDICINES_LIMIT = 10;

/** One medicine given at the outreach: its name and, optionally, the dose. */
export class ScreeningMedicineDto {
  @Transform(trimmedText)
  @IsString({ message: 'Enter the medicine name' }) @MinLength(1) @MaxLength(100)
  name!: string;

  @IsOptional() @Transform(trimmedText) @IsString() @MaxLength(200)
  dose?: string | null;
}

/**
 * The whole screening of an outreach registration (0118), replaced on each
 * save. Every field is optional; an omitted field is saved as empty (null).
 * Shapes and lengths are checked here (400); plausible ranges and pairs are
 * checked by the service (422) and again by the database.
 */
export class SaveRegistrationScreeningDto {
  @IsOptional() @IsInt() bpSystolic?: number | null;
  @IsOptional() @IsInt() bpDiastolic?: number | null;
  @IsOptional() @IsInt() pulseBpm?: number | null;
  @IsOptional() @IsNumber({ allowNaN: false, allowInfinity: false, maxDecimalPlaces: 1 }) temperatureC?: number | null;
  @IsOptional() @IsNumber({ allowNaN: false, allowInfinity: false, maxDecimalPlaces: 1 }) weightKg?: number | null;
  @IsOptional() @IsInt({ message: 'Enter height in whole centimetres.' }) heightCm?: number | null;
  @IsOptional() @IsNumber({ allowNaN: false, allowInfinity: false, maxDecimalPlaces: 1 }) glucoseValue?: number | null;
  @IsOptional() @IsIn(GLUCOSE_UNITS) glucoseUnit?: typeof GLUCOSE_UNITS[number] | null;
  @IsOptional() @IsIn(GLUCOSE_TIMINGS) glucoseTiming?: typeof GLUCOSE_TIMINGS[number] | null;
  @IsOptional() @IsIn(MALARIA_RDT_RESULTS) malariaRdt?: typeof MALARIA_RDT_RESULTS[number] | null;
  @IsOptional() @IsIn(HEARING_RESULTS) hearingLeft?: typeof HEARING_RESULTS[number] | null;
  @IsOptional() @IsIn(HEARING_RESULTS) hearingRight?: typeof HEARING_RESULTS[number] | null;
  @IsOptional() @Transform(trimmedText) @IsString() @MaxLength(200) mainComplaint?: string | null;
  @IsOptional() @IsBoolean() seenByClinician?: boolean | null;
  @IsOptional() @Transform(trimmedText) @IsString() @MaxLength(100) clinicianName?: string | null;
  @IsOptional() @Transform(trimmedText) @IsString() @MaxLength(500) outcome?: string | null;

  @IsOptional() @IsArray() @ArrayMaxSize(SCREENING_MEDICINES_LIMIT, { message: 'List up to 10 medicines' })
  @ValidateNested({ each: true }) @Type(() => ScreeningMedicineDto)
  medicinesGiven?: ScreeningMedicineDto[] | null;

  @IsOptional() @IsBoolean() referred?: boolean | null;
  @IsOptional() @Transform(trimmedText) @IsString() @MaxLength(200) referredTo?: string | null;
}
