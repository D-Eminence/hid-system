import { IsIn, IsUUID } from 'class-validator';
import type { PurposeOfUse } from '../../common/request-context';
import type { RecordAccessScope } from '../identity.types';

export class AuthorizationCheckDto {
  @IsUUID('4')
  patientId!: string;

  @IsIn(['read_records', 'write_records'])
  scope!: RecordAccessScope;

  @IsIn(['direct-care', 'emergency', 'healthcare-operations'])
  purpose!: PurposeOfUse;
}
