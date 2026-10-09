import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';
import { IsOptionalButNotNull } from '../../common/validation';

const trim = ({ value }: { value: unknown }) => typeof value === 'string' ? value.trim() : value;

export class ApprovalRequestDto {
  @Transform(trim) @IsString() @MinLength(8) @MaxLength(500)
  reason!: string;
}

export class ApprovalDecisionDto {
  @Transform(trim) @IsString() @MinLength(8) @MaxLength(500)
  reason!: string;
}

export class RevokeAccountSessionDto {
  @Transform(trim) @IsString() @MinLength(8) @MaxLength(500)
  reason!: string;

  @IsOptional() @IsBoolean()
  compromised?: boolean;
}

export class ListApprovalsDto {
  @IsOptional() @IsIn(['pending', 'approved', 'rejected', 'cancelled', 'expired'])
  status?: 'pending' | 'approved' | 'rejected' | 'cancelled' | 'expired';

  /** Rows per page (1 to 100, default 50). */
  @IsOptionalButNotNull() @Type(() => Number) @IsInt() @Min(1) @Max(100)
  limit = 50;

  /** The opaque `nextCursor` of the previous page. */
  @IsOptionalButNotNull() @IsString() @MinLength(1) @MaxLength(512)
  cursor?: string;
}
