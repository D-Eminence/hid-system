import { Transform } from 'class-transformer';
import { IsBoolean, IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

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
}
