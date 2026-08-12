import { Transform } from 'class-transformer';
import { IsDateString, IsIn, IsInt, IsNumber, IsOptional, IsString, IsUUID, Length, MaxLength, Min } from 'class-validator';

const trim = ({ value }: { value: unknown }) => typeof value === 'string' ? value.trim() : value;

export class AcceptEhrPrescriptionDto {
  @IsUUID('4') sourceEhrPrescriptionId!: string;
  @IsInt() @Min(1) sourceEhrPrescriptionVersion!: number;
  @IsUUID('4') sourceEncounterId!: string;
  @IsUUID('4') patientId!: string;
  @IsUUID('4') orderingFacilityId!: string;
  @IsIn(['active']) sourceStatus!: 'active';
  @IsOptional() @Transform(trim) @IsString() @Length(1, 255) medicationCodeSystem?: string;
  @IsOptional() @Transform(trim) @IsString() @Length(1, 100) medicationCode?: string;
  @Transform(trim) @IsString() @Length(1, 500) medicationDisplay!: string;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 4 }) @Min(0.0001) doseQuantity?: number;
  @IsOptional() @Transform(trim) @IsString() @Length(1, 80) doseUnit?: string;
  @IsOptional() @Transform(trim) @IsString() @Length(1, 100) routeCode?: string;
  @Transform(trim) @IsString() @Length(1, 240) frequency!: string;
  @Transform(trim) @IsString() @Length(1, 4000) instructions!: string;
  @IsOptional() @IsDateString({ strict: true }) startsOn?: string;
  @IsOptional() @IsDateString({ strict: true }) endsOn?: string;
  @IsUUID('4') prescribedBy!: string;
  @IsDateString() prescribedAt!: string;
  @Transform(trim) @IsString() @Length(8, 500) acceptanceReason!: string;
}
