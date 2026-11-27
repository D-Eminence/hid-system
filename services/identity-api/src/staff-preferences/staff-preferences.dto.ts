import { Type } from 'class-transformer';
import { IsArray, IsInt, IsString, Max, Min, ValidateNested } from 'class-validator';

/**
 * POST /identity/me/preferences: exactly these two fields. `notices` (and
 * `criticalResult` within it) and any other field are refused with 400
 * VALIDATION_FAILED by the global ValidationPipe (forbidNonWhitelisted): the
 * notice choices are not stored until ORD-11 reads them. The language is
 * checked by the service (LANGUAGE_NOT_AVAILABLE for anything but 'en').
 */
export class SaveStaffPreferencesDto {
  @IsString()
  language!: string;

  /** The version read: 0 for the first save. */
  @IsInt()
  @Min(0)
  @Max(Number.MAX_SAFE_INTEGER)
  expectedVersion!: number;
}

/** One shortcut: a module key only, never a patient (any other field is VALIDATION_FAILED). */
export class StaffShortcutItemDto {
  @IsString()
  module!: string;
}

/**
 * POST /identity/me/shortcuts: the facility's shortcuts in order and the
 * version read. How many (SHORTCUTS_TOO_MANY), which keys (SHORTCUT_UNKNOWN,
 * SHORTCUT_NOT_ALLOWED) and repeats (SHORTCUT_DUPLICATE) are the service's
 * checks, so they answer their own codes.
 */
export class SaveStaffShortcutsDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => StaffShortcutItemDto)
  items!: StaffShortcutItemDto[];

  /** The version read: 0 for the first save at this facility. */
  @IsInt()
  @Min(0)
  @Max(Number.MAX_SAFE_INTEGER)
  expectedVersion!: number;
}
