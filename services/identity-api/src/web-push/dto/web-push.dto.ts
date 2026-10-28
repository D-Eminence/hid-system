import { Type } from 'class-transformer';
import { IsDefined, IsNumber, IsObject, IsString, Matches, MaxLength, ValidateIf, ValidateNested } from 'class-validator';
import { WEB_PUSH_ENDPOINT_MAX_LENGTH } from '../web-push-endpoint';

/**
 * The browser's PushSubscription keys (B6, R2). Checked for shape here and
 * for length in the service (65 bytes beginning 0x04, and 16 bytes), then
 * discarded: an empty push needs neither (D4).
 */
export class WebPushKeysDto {
  @IsString() @MaxLength(100) @Matches(/^[A-Za-z0-9_-]+={0,2}$/)
  p256dh!: string;

  @IsString() @MaxLength(32) @Matches(/^[A-Za-z0-9_-]+={0,2}$/)
  auth!: string;
}

/**
 * PUT identity/me/web-push/subscription (B6, R2): the browser subscription's
 * toJSON() and the key id it was made with. At most about 2.3 KB, inside the
 * edge's 8 KB body limit. expirationTime is null or a number and is ignored.
 */
export class SubscribeWebPushDto {
  @IsString() @MaxLength(WEB_PUSH_ENDPOINT_MAX_LENGTH)
  endpoint!: string;

  @ValidateIf((input: { expirationTime?: unknown }) => input.expirationTime !== null && input.expirationTime !== undefined)
  @IsNumber({ allowNaN: false, allowInfinity: false })
  expirationTime?: number | null;

  @IsDefined() @IsObject() @ValidateNested() @Type(() => WebPushKeysDto)
  keys!: WebPushKeysDto;

  @IsString() @Matches(/^[0-9a-f]{16}$/)
  keyId!: string;
}

/** POST identity/me/web-push/subscription/remove (B6, R3): the endpoint to stop pushing to. */
export class RemoveWebPushSubscriptionDto {
  @IsString() @MaxLength(WEB_PUSH_ENDPOINT_MAX_LENGTH)
  endpoint!: string;
}
