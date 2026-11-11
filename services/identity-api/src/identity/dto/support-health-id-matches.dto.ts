import { ArrayMaxSize, ArrayMinSize, IsArray, IsString, Matches } from 'class-validator';

/** The most candidates one support message may ask about (0109's function refuses more). */
export const SUPPORT_HEALTH_ID_CANDIDATE_LIMIT = 200;

/**
 * The strings in one support chat message that could be a Health ID, as support-api reads them: HID- and 6 to 32
 * Health ID characters, upper case. Nothing else of the message is sent.
 */
export class SupportHealthIdMatchesDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(SUPPORT_HEALTH_ID_CANDIDATE_LIMIT)
  @IsString({ each: true })
  @Matches(/^HID-[A-HJ-NP-Z2-9]{6,32}$/, { each: true })
  candidates!: string[];
}
