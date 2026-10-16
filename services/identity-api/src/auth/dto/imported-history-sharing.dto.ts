import { IsBoolean } from 'class-validator';

/** The patient's choice to share their imported legacy history (ADR-066): exactly true or false. */
export class ImportedHistorySharingDto {
  @IsBoolean()
  shared!: boolean;
}
