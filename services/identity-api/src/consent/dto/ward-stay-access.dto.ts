import { IsUUID } from 'class-validator';

/**
 * ADT-1 route 23 (0173; owner decision Q156 A, 25 November 2026, built and
 * switched off): POST identity/ward-stay-access, "Open chart for this stay".
 * The admission by UUID only; no Health ID or NIN.
 */
export class WardStayAccessDto {
  @IsUUID()
  admissionId!: string;
}
