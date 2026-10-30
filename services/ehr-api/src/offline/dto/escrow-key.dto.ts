import { IsInt, IsUUID, Max, Min, ValidateIf } from 'class-validator';

/** C4 request body: `{ "vaultId": "uuid", "keyVersion": null }`; null or absent asks for the current version. */
export class EscrowKeyDto {
  @IsUUID('all')
  vaultId!: string;

  @ValidateIf((_object: object, value: unknown) => value !== null && value !== undefined)
  @IsInt()
  @Min(1)
  @Max(999_999)
  keyVersion?: number | null;
}
