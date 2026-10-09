import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsDateString, IsInt, IsOptional, IsString, MaxLength,
  Min, ValidateNested } from 'class-validator';

export class SpecimenRequirementDto {
  @IsString() @MaxLength(240) specimenType!: string;
  @IsOptional() @IsString() @MaxLength(240) containerType?: string;
  @IsOptional() @IsString() @MaxLength(1000) notes?: string;
}

export class CreateAccessionDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(50)
  @ValidateNested({ each: true }) @Type(() => SpecimenRequirementDto)
  requirements!: SpecimenRequirementDto[];
  @IsString() @MaxLength(500) reason!: string;
}

export class CollectSpecimenDto {
  @IsInt() @Min(1) expectedVersion!: number;
  @IsDateString() collectedAt!: string;
  @IsOptional() @IsString() @MaxLength(1000) notes?: string;
}

export class ReceiveSpecimenDto {
  @IsInt() @Min(1) expectedVersion!: number;
  @IsDateString() receivedAt!: string;
  @IsOptional() @IsString() @MaxLength(500) condition?: string;
}

export class RejectSpecimenDto {
  @IsInt() @Min(1) expectedVersion!: number;
  @IsString() @MaxLength(500) reason!: string;
}
