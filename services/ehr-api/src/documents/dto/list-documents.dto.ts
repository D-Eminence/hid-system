import { IsUUID } from 'class-validator';

export class ListDocumentsDto {
  @IsUUID('4') patientId!: string;
  @IsUUID('4') encounterId!: string;
}
