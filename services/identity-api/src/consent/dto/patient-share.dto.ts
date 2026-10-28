import { Allow, IsIn, IsOptional, IsString, IsUUID, Matches, MaxLength } from 'class-validator';

/** The share levels (hid-1.0's tiers) and durations of migration 0095 (D1, D2). */
export const SHARE_LEVELS = ['view_only', 'clinical_review', 'clinical_collaboration'] as const;
export type ShareLevel = (typeof SHARE_LEVELS)[number];
export const SHARE_DURATIONS = ['24h', '7d', '30d', 'until_revoked'] as const;
export type ShareDuration = (typeof SHARE_DURATIONS)[number];

/** A person's name as the patient types it (never emailed). */
export const PERSON_NAME = /^[\p{L}\p{M}][\p{L}\p{M}' .-]{0,119}$/u;

/**
 * P1: the search text. Taken as it is (any type) so that a missing, short,
 * long or non-string query answers SHARE_SEARCH_QUERY_INVALID rather than the
 * pipe's VALIDATION_FAILED; the service checks it.
 */
export class SearchShareProvidersDto {
  @Allow() query!: unknown;
}

/** P2: share with a clinician found by search. No free text. */
export class CreateShareDto {
  @IsUUID() membershipId!: string;
  @IsIn(SHARE_LEVELS) level!: ShareLevel;
  @IsIn(SHARE_DURATIONS) duration!: ShareDuration;
}

/** P5: invite a provider by email. The address is checked by the service (SHARE_INVITATION_EMAIL_INVALID). */
export class CreateShareInvitationDto {
  @IsString() @MaxLength(320) email!: string;
  @IsOptional() @IsString() @MaxLength(120) @Matches(PERSON_NAME) name?: string;
  @IsIn(SHARE_LEVELS) level!: ShareLevel;
  @IsIn(SHARE_DURATIONS) duration!: ShareDuration;
}
