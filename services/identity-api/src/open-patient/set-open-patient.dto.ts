import { IsOptional, IsString, IsUUID } from 'class-validator';

/**
 * POST /auth/open-patient's body: exactly these two fields. Any other field
 * (`hid`, `healthId`, `matchRef`, `nin` among them) is refused with 400
 * VALIDATION_FAILED by the global ValidationPipe (forbidNonWhitelisted): the
 * open patient is kept only after access is granted, and by then the screen
 * holds the patient's id. `purpose` is checked by the controller, so a
 * missing or unknown one answers PURPOSE_OF_USE_REQUIRED.
 */
export class SetOpenPatientDto {
  @IsUUID()
  patientId!: string;

  @IsOptional()
  @IsString()
  purpose?: string;
}
