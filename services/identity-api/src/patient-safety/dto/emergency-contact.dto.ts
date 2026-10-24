import { Transform, type TransformFnParams } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, IsUUID, Length, Matches, Max, Min } from 'class-validator';

export const EMERGENCY_CONTACT_RELATIONSHIPS = [
  'spouse', 'partner', 'parent', 'child', 'sibling', 'relative',
  'guardian', 'caregiver', 'friend', 'other',
] as const;
export type EmergencyContactRelationship = typeof EMERGENCY_CONTACT_RELATIONSHIPS[number];

const trim = ({ value }: TransformFnParams): unknown => typeof value === 'string' ? value.trim() : value;
const compact = ({ value }: TransformFnParams): unknown =>
  typeof value === 'string' ? value.replace(/\s+/g, '') : value;

export class AddEmergencyContactDto {
  @Transform(trim) @IsString() @Length(2, 120)
  name!: string;

  @IsIn(EMERGENCY_CONTACT_RELATIONSHIPS)
  relationship!: EmergencyContactRelationship;

  @IsIn(['email', 'sms'])
  channel!: 'email' | 'sms';

  @Transform(trim) @IsString() @Length(5, 254)
  destination!: string;

  @IsOptional() @IsBoolean()
  notifyOnEmergencyAccess?: boolean;
}

export class UpdateEmergencyContactDto {
  @IsInt() @Min(1) @Max(Number.MAX_SAFE_INTEGER)
  expectedVersion!: number;

  @IsOptional() @Transform(trim) @IsString() @Length(2, 120)
  name?: string;

  @IsOptional() @IsIn(EMERGENCY_CONTACT_RELATIONSHIPS)
  relationship?: EmergencyContactRelationship;

  @IsOptional() @IsBoolean()
  notifyOnEmergencyAccess?: boolean;
}

export class ConfirmEmergencyContactVerificationDto {
  @IsUUID('4')
  challengeId!: string;

  @Transform(compact) @IsString() @Matches(/^\d{6}$/)
  code!: string;
}
