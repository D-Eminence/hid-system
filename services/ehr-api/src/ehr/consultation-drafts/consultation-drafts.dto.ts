import { IsInt, IsObject, IsUUID, Max, Min } from 'class-validator';
import { IsOptionalButNotNull } from '../../common/validation';

/**
 * EHR-C6: a draft's body. Exactly these fields; `null` is refused for each.
 * The content is a JSON object the server stores as given and never reads;
 * its size (262,144 bytes as UTF-8 JSON) and depth (20 levels) are checked by
 * the service.
 */
export class CreateConsultationDraftDto {
  @IsOptionalButNotNull()
  @IsUUID()
  encounterId?: string;

  @IsInt()
  @Min(1)
  @Max(1000)
  formVersion!: number;

  @IsObject()
  content!: Record<string, unknown>;
}

export class SaveConsultationDraftDto {
  @IsInt()
  @Min(1)
  expectedRowVersion!: number;

  @IsInt()
  @Min(1)
  @Max(1000)
  formVersion!: number;

  @IsObject()
  content!: Record<string, unknown>;
}
