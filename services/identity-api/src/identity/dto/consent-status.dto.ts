import { IsIn, IsUUID } from 'class-validator';
import type { PurposeOfUse } from '../../common/request-context';

export class ConsentStatusDto {
  @IsUUID('4')
  patientId!: string;

  @IsIn(['direct-care', 'emergency', 'healthcare-operations'])
  purpose!: PurposeOfUse;
}
