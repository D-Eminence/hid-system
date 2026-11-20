import { IsInt, IsObject, IsUUID, Max, Min } from 'class-validator';
import { IsOptionalButNotNull } from '../../common/validation';

/**
 * EHR-C6: a draft's body. Exactly these fields; `null` is refused for each.
 * The content is a JSON object the server never reads, stored as jsonb (key
 * order is not kept): at most 262,144 bytes measured as stored (the service
 * refuses early anything whose JSON.stringify size is already over the
 * limit; the database's guard decides) and 20 levels deep.
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
