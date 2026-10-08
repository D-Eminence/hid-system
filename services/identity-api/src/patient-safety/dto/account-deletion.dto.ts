import { IsString, IsUUID, Matches, MaxLength } from 'class-validator';

export class ConfirmAccountDeletionDto {
  @IsUUID('4')
  requestId!: string;

  // 32 random bytes encoded as unpadded base64url.
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{43}$/)
  confirmationToken!: string;

  @IsString()
  @MaxLength(64)
  confirmation!: string;
}

export class CancelAccountDeletionDto {
  @IsUUID('4')
  requestId!: string;
}
