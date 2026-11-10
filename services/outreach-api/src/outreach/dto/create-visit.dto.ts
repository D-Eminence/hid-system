import { Transform } from 'class-transformer';
import {
  IsIn, IsOptional, IsString, Matches, MaxLength, MinLength, Validate,
  ValidatorConstraint, type ValidationArguments, type ValidatorConstraintInterface,
} from 'class-validator';
import { isCalendarDate, lagosToday } from '../lagos-date';

export const VISIT_KINDS = ['visit', 'referral', 'follow_up'] as const;
export type VisitKind = typeof VISIT_KINDS[number];

// Trimmed; a blank value means none (null), as for a registration's phone.
const trimmed = ({ value }: { value: unknown }) => typeof value === 'string' ? value.trim() || null : value;
// Notes keep their line breaks (CRLF and CR become LF); the ends are trimmed.
const trimmedNotes = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.replace(/\r\n?/g, '\n').trim() || null : value;

@ValidatorConstraint({ name: 'calendarDateNotFuture' })
class CalendarDateNotFuture implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return typeof value === 'string' && isCalendarDate(value) && value <= lagosToday();
  }

  defaultMessage(): string {
    return 'occurredOn must be a date (YYYY-MM-DD) that is not after today in Lagos';
  }
}

@ValidatorConstraint({ name: 'followUpAfterVisit' })
class FollowUpAfterVisit implements ValidatorConstraintInterface {
  validate(value: unknown, args: ValidationArguments): boolean {
    const occurredOn = (args.object as CreateVisitDto).occurredOn;
    return typeof value === 'string' && isCalendarDate(value)
      && typeof occurredOn === 'string' && value > occurredOn;
  }

  defaultMessage(): string {
    return 'followUpOn must be a date (YYYY-MM-DD) after occurredOn';
  }
}

export class CreateVisitDto {
  @IsIn(VISIT_KINDS)
  kind!: VisitKind;

  @IsString()
  @Validate(CalendarDateNotFuture)
  occurredOn!: string;

  @IsOptional()
  @IsString()
  @Validate(FollowUpAfterVisit)
  followUpOn?: string | null;

  @IsOptional()
  @Transform(trimmed)
  @IsString()
  @MinLength(2)
  @MaxLength(160)
  @Matches(/^[^\p{Cc}]*$/u, { message: 'referredTo must not contain control characters' })
  referredTo?: string | null;

  @IsOptional()
  @Transform(trimmedNotes)
  @IsString()
  @MaxLength(1000)
  @Matches(/^[^\u0000-\u0009\u000b-\u001f\u007f]*$/, { message: 'notes may contain line breaks but no other control characters' })
  notes?: string | null;
}
