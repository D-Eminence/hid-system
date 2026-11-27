import { Transform, Type, type TransformFnParams } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsIn,
  IsString,
  IsUUID,
  Length,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { IsOptionalButNotNull } from '../../common/validation';
import { LabPriority, OrderStatus, TimelineQueryDto } from '../shared/clinical.dto';

const trim = ({ value }: TransformFnParams): unknown => typeof value === 'string' ? value.trim() : value;

/** ORD-6: at most this many tests in one lab request group. */
export const LAB_REQUEST_GROUP_MAX_TESTS = 20;

/** ORD-6: a group is saved as drafts or sent; every test takes the group's status. */
export const LAB_REQUEST_GROUP_STATUSES = [OrderStatus.Draft, OrderStatus.Active] as const;

/**
 * One test of a group, with the single create's test fields and limits
 * (R-2) other than its code pair: its name, its own priority (the group's
 * when left out) and its specimen type. Each subclass declares its pair, so
 * its checks run first, as LabRequestDetailsDto's do. Any other field (a
 * status, clinical information, an external reference or a requestGroupId) is
 * refused, 400 VALIDATION_FAILED.
 */
export abstract class LabRequestGroupTestDetailsDto {
  @Transform(trim)
  @IsString()
  @Length(1, 500)
  testDisplay!: string;

  @IsOptionalButNotNull()
  @IsEnum(LabPriority)
  priority?: LabPriority;

  @IsOptionalButNotNull()
  @Transform(trim)
  @IsString()
  @MaxLength(100)
  specimenTypeCode?: string;
}

/** A group's test with its code pair, both required, as CreateLabRequestDto (LAB_REQUEST_NAME_ONLY_ENABLED off). */
export class LabRequestGroupTestDto extends LabRequestGroupTestDetailsDto {
  @Transform(trim)
  @IsString()
  @Length(1, 255)
  testCodeSystem!: string;

  @Transform(trim)
  @IsString()
  @Length(1, 100)
  testCode!: string;
}

/**
 * A group's test whose code pair may be left out (0156), as
 * CreateLabRequestNameOnlyDto: used only while LAB_REQUEST_NAME_ONLY_ENABLED
 * is on; both or neither (LAB_TEST_CODE_INCOMPLETE, CreateLabRequestGroupBodyPipe).
 */
export class LabRequestGroupTestNameOnlyDto extends LabRequestGroupTestDetailsDto {
  @IsOptionalButNotNull()
  @Transform(trim)
  @IsString()
  @Length(1, 255)
  testCodeSystem?: string;

  @IsOptionalButNotNull()
  @Transform(trim)
  @IsString()
  @Length(1, 100)
  testCode?: string;
}

/**
 * ORD-6 (0158): several tests in one lab request, one POST. `status` (draft
 * or active), `priority` (routine by default; a test may override it) and
 * `clinicalInformation` (up to 4000 characters) apply to every test. Each
 * subclass declares its `tests`. A requestGroupId is never taken from a
 * client (Rahman's answer 2): ehr-api makes it.
 */
export abstract class LabRequestGroupDetailsDto {
  @IsIn(LAB_REQUEST_GROUP_STATUSES)
  status!: (typeof LAB_REQUEST_GROUP_STATUSES)[number];

  @IsOptionalButNotNull()
  @IsEnum(LabPriority)
  priority: LabPriority = LabPriority.Routine;

  @IsOptionalButNotNull()
  @Transform(trim)
  @IsString()
  @MaxLength(4000)
  clinicalInformation?: string;
}

/** The group body while LAB_REQUEST_NAME_ONLY_ENABLED is off: every test with its code pair. */
export class CreateLabRequestGroupDto extends LabRequestGroupDetailsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(LAB_REQUEST_GROUP_MAX_TESTS)
  @ValidateNested({ each: true })
  @Type(() => LabRequestGroupTestDto)
  tests!: LabRequestGroupTestDto[];
}

/** The group body while LAB_REQUEST_NAME_ONLY_ENABLED is on (0156): coded and name-only tests may be mixed. */
export class CreateLabRequestGroupNameOnlyDto extends LabRequestGroupDetailsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(LAB_REQUEST_GROUP_MAX_TESTS)
  @ValidateNested({ each: true })
  @Type(() => LabRequestGroupTestNameOnlyDto)
  tests!: LabRequestGroupTestNameOnlyDto[];
}

/** The body a group create carries: today's tests, or (0156, while on) tests by name only too. */
export type CreateLabRequestGroupInput = CreateLabRequestGroupDto | CreateLabRequestGroupNameOnlyDto;

/** A test of a group, in either body. */
export type LabRequestGroupTestInput = LabRequestGroupTestDto | LabRequestGroupTestNameOnlyDto;

/**
 * The lab request list's query: today's page and cursor, and (ORD-6) an
 * optional requestGroupId, which keeps the page to that group's requests.
 * The filter is answered whatever LAB_REQUEST_GROUPS_ENABLED says: stored
 * groups are always answered.
 */
export class LabRequestListQueryDto extends TimelineQueryDto {
  @IsOptionalButNotNull()
  @IsUUID()
  requestGroupId?: string;
}
