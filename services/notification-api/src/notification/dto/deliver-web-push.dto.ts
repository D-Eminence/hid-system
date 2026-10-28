import { IsString, Matches, MaxLength } from 'class-validator';

/**
 * N1 (B6, 0097): one empty web push. The endpoint (rule E, checked in the
 * route after workload authentication) and the VAPID key id Identity
 * subscribed it with; the global pipe refuses any other field, so no payload
 * can be sent.
 */
export class DeliverWebPushDto {
  @IsString() @MaxLength(2048) endpoint!: string;
  @IsString() @Matches(/^[0-9a-f]{16}$/) vapidKeyId!: string;
}
