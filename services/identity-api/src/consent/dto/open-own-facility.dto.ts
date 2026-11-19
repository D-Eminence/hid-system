import { Transform, type TransformFnParams } from 'class-transformer';
import { IsString, IsUUID, Matches, ValidateIf } from 'class-validator';

const normalizedHid = ({ value }: TransformFnParams): unknown =>
  typeof value === 'string' ? value.trim().toUpperCase() : value;

/**
 * 0131 (ID-4, owner Q101 of 18 November 2026): POST
 * identity/own-facility-access. Exactly one of a Health ID (in the body,
 * never in a URL) or a patient id (UUID). Nothing else: the basis, the scope
 * (read and write), the purpose (direct care) and the 24 hours are fixed by
 * the database command.
 */
export class OpenOwnFacilityDto {
  @ValidateIf((body: OpenOwnFacilityDto) => body.patientId === undefined || body.hid !== undefined)
  @Transform(normalizedHid)
  @IsString()
  @Matches(/^HID-[A-HJ-NP-Z2-9]{6,32}$/)
  hid?: string;

  @ValidateIf((body: OpenOwnFacilityDto) => body.hid === undefined || body.patientId !== undefined)
  @IsUUID()
  patientId?: string;
}
