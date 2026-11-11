import { Type } from 'class-transformer';
import { Equals, IsIn, IsInt, IsObject, IsString, IsUUID, Matches, MaxLength, Min, ValidateNested } from 'class-validator';
import { IsOptionalButNotNull } from '../../../common/validation';
import { AllergyAcknowledgementDto } from '../../allergies/allergies.dto';

/** A stored attestation text version (T4): `order-route-{lab|prescription}-attestation-v<n>`. */
export const ATTESTATION_TEXT_VERSION = /^order-route-(lab|prescription)-attestation-v[0-9]+$/;

/**
 * Send a lab request or prescription to a laboratory or pharmacy at another
 * facility (SPEC-FINAL §10.1, §3.5). `patientAgreed` must be exactly true: the
 * clinician ticked the attestation that names the receiving facility, and
 * `attestationTextVersion` is the text they confirmed (C24).
 */
export class SendOrderRouteDto {
  @IsInt() @Min(1)
  expectedRowVersion!: number;

  @IsUUID('4')
  receivingFacilityId!: string;

  @Equals(true)
  patientAgreed!: true;

  @IsString() @MaxLength(64) @Matches(ATTESTATION_TEXT_VERSION)
  attestationTextVersion!: string;

  /**
   * 0124: sending a draft prescription makes it active, so it is checked
   * against the allergies; sent only after an allergy warning, with the
   * prescriber's reason and the warning's token. Ignored for a lab request.
   */
  @IsOptionalButNotNull()
  @IsObject()
  @ValidateNested()
  @Type(() => AllergyAcknowledgementDto)
  allergyAcknowledgement?: AllergyAcknowledgementDto;
}

export const ORDERER_WITHDRAW_REASONS = ['sent_in_error', 'patient_request', 'other'] as const;

/** The ordering facility withdraws a route before acceptance (C2). */
export class WithdrawOrderRouteDto {
  @IsInt() @Min(1)
  expectedVersion!: number;

  @IsIn(ORDERER_WITHDRAW_REASONS)
  reason!: (typeof ORDERER_WITHDRAW_REASONS)[number];
}

/** The patient's Stop of a route before acceptance (C6), their only write. */
export class PatientStopOrderRouteDto {
  @IsInt() @Min(1)
  expectedVersion!: number;
}
