import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min,
  MinLength, ValidateIf } from 'class-validator';

export class ProductPricingCommandDto {
  @IsString() @MinLength(2) @MaxLength(120)
  name!: string;

  @IsIn(['active', 'coming_soon', 'draft', 'retired'])
  status!: 'active' | 'coming_soon' | 'draft' | 'retired';

  @IsString() @MinLength(8) @MaxLength(500)
  reason!: string;
}

export class PricePricingCommandDto {
  @IsIn(['fixed', 'starting_from', 'contact_sales', 'custom_quote', 'hidden'])
  visibility!: 'fixed' | 'starting_from' | 'contact_sales' | 'custom_quote' | 'hidden';

  @ValidateIf((_, value: unknown) => value !== null)
  @IsInt() @Min(0) @Max(Number.MAX_SAFE_INTEGER)
  amountMinor!: number | null;

  @Matches(/^[A-Z]{3}$/)
  currency!: string;

  @IsOptional() @Matches(/^[a-z][a-z0-9_]{1,39}$/)
  billingPeriod?: string | null;

  @IsOptional() @IsString() @MinLength(1) @MaxLength(80)
  unit?: string | null;

  @IsBoolean()
  active!: boolean;

  @IsString() @MinLength(8) @MaxLength(500)
  reason!: string;
}
