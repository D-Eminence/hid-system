import { Transform, type TransformFnParams } from 'class-transformer';
import { IsInt, IsString, Length, Matches, Max, Min, Validate, ValidateIf, type ValidationArguments,
  ValidatorConstraint, type ValidatorConstraintInterface } from 'class-validator';
import { MATCH_REF_PATTERN } from '../../patient-search/match-ref';

const trim = ({ value }: TransformFnParams): unknown => typeof value === 'string' ? value.trim() : value;
const normalizedHid = ({ value }: TransformFnParams): unknown =>
  typeof value === 'string' ? value.trim().toUpperCase() : value;

/** A matchRef names the patient on its own: never together with a Health ID. */
@ValidatorConstraint({ name: 'matchRefWithoutHealthId' })
class MatchRefWithoutHealthId implements ValidatorConstraintInterface {
  validate(_value: unknown, args: ValidationArguments): boolean {
    return (args.object as { hid?: unknown }).hid === undefined;
  }

  defaultMessage(): string {
    return 'Give a Health ID or a matchRef, not both';
  }
}

/**
 * POST identity/break-glass: the patient is named by exactly one of a Health
 * ID or (ID-5, 0132) the matchRef of a card from this member's own emergency
 * search in the last 10 minutes, which carries no Health ID.
 */
export class CreateBreakGlassDto {
  @ValidateIf((body: CreateBreakGlassDto) => body.matchRef === undefined || body.hid !== undefined)
  @Transform(normalizedHid)
  @IsString()
  @Matches(/^HID-[A-HJ-NP-Z2-9]{6,32}$/)
  hid?: string;

  @ValidateIf((body: CreateBreakGlassDto) => body.hid === undefined || body.matchRef !== undefined)
  @IsString()
  @Matches(MATCH_REF_PATTERN)
  @Validate(MatchRefWithoutHealthId)
  matchRef?: string;

  @Transform(trim)
  @IsString()
  @Length(8, 500)
  reason!: string;

  @IsInt()
  @Min(5)
  @Max(240)
  durationMinutes!: number;
}
