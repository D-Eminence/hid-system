import { IsDateString, IsIn, IsObject, IsOptional, IsString, Matches, MaxLength } from 'class-validator';

/**
 * The card-link emails (0118): fixed fields only, email only. Unknown fields
 * are refused by the global pipe, so no name, label, Health ID or free text
 * can reach an email, and E5 cannot carry a code nor E6 the link's token.
 */

/** A link's 256-bit token, base64url without padding. */
export const CARD_LINK_TOKEN = /^[A-Za-z0-9_-]{43}$/;
/** A link's reference, XXXX-XXXX without I, O, 0 or 1. */
export const CARD_LINK_REFERENCE = /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/;
/** "Stop these emails": the link id and its keyed tag. */
export const CARD_LINK_STOP_TOKEN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[A-Za-z0-9_-]{43}$/;
/** A masked address: the first character, a mask, and the (possibly masked) domain. */
export const CARD_LINK_HINT = /^[^@\s]•••@[^@\s]{1,100}$/u;

/** E5: the link, to the address the patient typed. */
export class DeliverCardLinkDto {
  @IsIn(['email']) channel!: 'email';
  @IsString() @MaxLength(320) recipient!: string;
  @IsString() @Matches(CARD_LINK_TOKEN) token!: string;
  @IsString() @Matches(CARD_LINK_REFERENCE) reference!: string;
  @IsDateString({ strict: true }) expiresAt!: string;
  @IsString() @Matches(CARD_LINK_STOP_TOKEN) stopToken!: string;
  @IsOptional() @IsObject() plan?: Record<string, unknown>;
}

/** E6: the one-time code, to the same address. */
export class DeliverCardCodeDto {
  @IsIn(['email']) channel!: 'email';
  @IsString() @MaxLength(320) recipient!: string;
  @IsString() @Matches(/^[0-9]{6}$/) code!: string;
  @IsString() @Matches(CARD_LINK_REFERENCE) reference!: string;
  @IsString() @Matches(CARD_LINK_STOP_TOKEN) stopToken!: string;
  @IsOptional() @IsObject() plan?: Record<string, unknown>;
}

/** E7: to the patient, on the first open of a link each Lagos day. */
export class DeliverCardOpenedDto {
  @IsIn(['email']) channel!: 'email';
  @IsString() @MaxLength(320) recipient!: string;
  @IsString() @Matches(CARD_LINK_REFERENCE) reference!: string;
  @IsDateString({ strict: true }) openedAt!: string;
  @IsOptional() @IsObject() plan?: Record<string, unknown>;
}

/** E8: to the patient, on every new link. */
export class DeliverCardCreatedDto {
  @IsIn(['email']) channel!: 'email';
  @IsString() @MaxLength(320) recipient!: string;
  @IsString() @Matches(CARD_LINK_REFERENCE) reference!: string;
  @IsString() @MaxLength(120) @Matches(CARD_LINK_HINT) recipientHint!: string;
  @IsDateString({ strict: true }) expiresAt!: string;
  @IsOptional() @IsObject() plan?: Record<string, unknown>;
}
