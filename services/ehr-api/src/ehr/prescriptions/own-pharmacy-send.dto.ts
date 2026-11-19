import { Type } from 'class-transformer';
import { IsInt, IsObject, Min, ValidateNested } from 'class-validator';
import { AllergyAcknowledgementDto } from '../allergies/allergies.dto';
import { IsOptionalButNotNull } from '../../common/validation';

/**
 * "Send to pharmacy" for the prescriber (0133): the version of the active
 * prescription the client last read, and the allergy acknowledgement only
 * after the allergy warning (0117), as on the pharmacy hand-off.
 */
export class SendPrescriptionToOwnPharmacyDto {
  @IsInt()
  @Min(1)
  expectedRowVersion!: number;

  @IsOptionalButNotNull()
  @IsObject()
  @ValidateNested()
  @Type(() => AllergyAcknowledgementDto)
  allergyAcknowledgement?: AllergyAcknowledgementDto;
}
