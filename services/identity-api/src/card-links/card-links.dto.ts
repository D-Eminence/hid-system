import { IsIn, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { PERSON_NAME } from '../consent/dto/patient-share.dto';

/** "Card only" (the card face, blood group, genotype, allergies) or "Card and records". */
export const CARD_SHARE_SCOPES = ['card', 'card_and_records'] as const;
export type CardShareScope = (typeof CARD_SHARE_SCOPES)[number];
/** 24 hours (the default the website shows) or 7 days; 30 days is not offered in v1. */
export const CARD_SHARE_DURATIONS = ['24h', '7d'] as const;
export type CardShareDuration = (typeof CARD_SHARE_DURATIONS)[number];

/** The patient sends their card. The address is checked by the service (CARD_SHARE_EMAIL_INVALID). */
export class CreateCardShareDto {
  @IsString() @MaxLength(254) email!: string;
  /** "Who is this? (only you see this)": encrypted with the address, never emailed. */
  @IsOptional() @IsString() @MaxLength(80) @Matches(PERSON_NAME) label?: string;
  @IsIn(CARD_SHARE_SCOPES) scope!: CardShareScope;
  @IsIn(CARD_SHARE_DURATIONS) duration!: CardShareDuration;
}

/** "Email me a code". The token's shape is checked by the service (CARD_SHARE_LINK_INVALID), never echoed. */
export class RequestCardCodeDto {
  @IsString() @MaxLength(64) token!: string;
  @IsString() @MaxLength(2048) turnstileToken!: string;
}

/** "Open the card". The code's shape is checked by the service (CARD_SHARE_CODE_FORMAT). */
export class VerifyCardCodeDto {
  @IsString() @MaxLength(64) token!: string;
  @IsString() @MaxLength(12) code!: string;
}

/** "Stop these emails". */
export class StopCardEmailsDto {
  @IsString() @MaxLength(100) stopToken!: string;
}
