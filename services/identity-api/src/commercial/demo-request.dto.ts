import { Transform } from 'class-transformer';
import { IsEmail, IsIn, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';

const trim = ({ value }: { value: unknown }) => typeof value === 'string' ? value.trim() : value;
export const DEMO_PRODUCTS = ['ehr', 'migrate', 'laboratory', 'pharmacy', 'outreach', 'api', 'general'] as const;
export const DEMO_STATUSES = ['new', 'contacted', 'qualified', 'closed'] as const;

export class CreateDemoRequestDto {
  @Transform(trim) @IsString() @MinLength(2) @MaxLength(160)
  contactName!: string;

  @Transform(trim) @IsEmail() @MaxLength(254)
  contactEmail!: string;

  @IsOptional() @Transform(trim) @Matches(/^\+?[0-9 ()-]{7,32}$/)
  contactPhone?: string;

  @IsOptional() @Transform(trim) @IsString() @MinLength(2) @MaxLength(120)
  contactRole?: string;

  @IsOptional() @Transform(trim) @IsString() @MinLength(2) @MaxLength(200)
  organizationName?: string;

  @IsOptional() @IsIn(['clinic', 'hospital', 'laboratory', 'pharmacy', 'other'])
  organizationType?: string;

  @IsIn(DEMO_PRODUCTS)
  productCode!: typeof DEMO_PRODUCTS[number];

  @IsOptional() @Transform(trim) @IsString() @MinLength(8) @MaxLength(2000)
  message?: string;

  @IsOptional() @Transform(trim) @IsString() @MinLength(1) @MaxLength(200)
  sourcePage?: string;

  @IsOptional() @Transform(trim) @IsString() @MinLength(1) @MaxLength(120)
  sourceSection?: string;

  @IsOptional() @Transform(trim) @IsString() @MinLength(1) @MaxLength(120)
  ctaLabel?: string;

  @IsString() @IsIn(['book-demo'])
  turnstileAction!: 'book-demo';

  @IsString() @MaxLength(2048)
  turnstileToken!: string;
}

export class ListDemoRequestsDto {
  @IsOptional() @IsIn(DEMO_STATUSES)
  status?: typeof DEMO_STATUSES[number];

  @IsOptional() @IsIn(DEMO_PRODUCTS)
  productCode?: typeof DEMO_PRODUCTS[number];

  @IsOptional() @Transform(({ value }) => Number(value)) @IsInt() @Min(1) @Max(100)
  limit?: number;

  /** The opaque `nextCursor` of the previous page. */
  @IsOptional() @IsString() @MinLength(1) @MaxLength(512)
  cursor?: string;
}

export class UpdateDemoRequestStatusDto {
  @IsIn(DEMO_STATUSES)
  status!: typeof DEMO_STATUSES[number];

  @Transform(trim) @IsString() @MinLength(8) @MaxLength(500)
  reason!: string;
}
