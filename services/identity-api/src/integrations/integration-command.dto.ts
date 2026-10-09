import { IsIn, IsObject, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';

export class IntegrationReasonDto {
  @IsString() @MinLength(8) @MaxLength(500) reason!: string;
}

export class IntegrationConfigurationDto extends IntegrationReasonDto {
  @IsObject() configuration!: Record<string, unknown>;
}

export class IntegrationRouteDto extends IntegrationReasonDto {
  @IsOptional() @Matches(/^[a-z][a-z0-9-]{1,63}$/) provider!: string | null;
}

export class IntegrationCredentialReferenceDto extends IntegrationReasonDto {
  @IsString() @MinLength(1) @MaxLength(300) reference!: string;
}
