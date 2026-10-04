import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

export class ListReleasedResultsDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100)
  limit = 50;

  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(10_000)
  offset = 0;
}
