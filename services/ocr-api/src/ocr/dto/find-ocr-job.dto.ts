import { IsUUID } from 'class-validator';

export class FindOcrJobDto {
  @IsUUID('4') documentId!: string;
}

