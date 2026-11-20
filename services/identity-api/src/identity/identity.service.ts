import { ForbiddenException, Inject, Injectable, NotFoundException, Optional, ServiceUnavailableException } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import type { DataAccessContext, PurposeOfUse } from '../common/request-context';
import type {
  AuthorizationDecision,
  AuthorizationPrecheck,
  IdentityPatient,
  IdentityProvider,
  RecordAccessScope,
  ConsentStatus,
} from './identity.types';
import { IDENTITY_PROVIDER } from './identity.types';
import { RecordAccessNoticeService } from './record-access-notice.service';
import { ninStatusOf } from './nin-status';
import { PatientLookupMissService, patientNotFound } from './patient-lookup-miss.service';

/**
 * How a staff Health ID lookup that opened no patient ended, as its audit row
 * says it (never the Health ID): no patient record has the Health ID (Q100 B),
 * the patient is not available here, the lookup was not authorized (today's
 * 403, never counted), or the account was limited (then the answer is today's
 * 404, never "No such patient" and never a 429: every client closes a record
 * on 403 or 404).
 */
type LookupMissResult = 'no_such_patient' | 'not_available' | 'not_authorized' | 'limited';

@Injectable()
export class IdentityService {
  constructor(
    @Inject(IDENTITY_PROVIDER) private readonly provider: IdentityProvider,
    private readonly audit: AuditService,
    @Optional() private readonly notices?: RecordAccessNoticeService,
    @Optional() private readonly misses?: PatientLookupMissService,
  ) {}

  async staffPatientProfile(patientId:string,context:DataAccessContext) {
    if(context.actor.kind==='patient'||context.purposeOfUse!=='direct-care'||!context.actor.permissions.includes('identity.patient.read'))
      throw new ForbiddenException('Staff direct-care profile access is required');
    const decision=await this.authorize(patientId,'read_records','direct-care',context);
    if(!decision.allowed||decision.breakGlass)throw new ForbiddenException('Patient access is not authorized');
    if(!this.provider.lookupPatientId)throw new ServiceUnavailableException('Staff patient profile is unavailable');
    const patient=await this.provider.lookupPatientId(patientId,context);
    if(!patient||patient.id!==patientId)throw new NotFoundException('Patient was not found or is not available');
    await this.record(context,'identity.staff.chat.profile.read','success',patientId,'direct-care');
    // recordKind (0146, ID-7): while it is 'unknown', the names are placeholders, never shown as a name.
    return {patientId:patient.id,version:patient.rowVersion,firstName:patient.firstName,lastName:patient.lastName,
      fullName:patient.fullName,dateOfBirth:patient.dateOfBirth,gender:patient.gender,
      recordKind:patient.recordKind??'standard'};
  }

  async lookupPatient(hid: string, purpose: PurposeOfUse, context: DataAccessContext) {
    let patient: IdentityPatient | null;
    try {
      patient = await this.provider.lookupExactHid(hid, context);
    } catch (error) {
      await this.record(
        context,
        'identity.patient.lookup',
        error instanceof ForbiddenException ? 'denied' : 'failure',
        undefined,
        purpose,
        { dependency: 'identity-provider' },
      );
      throw error;
    }
    if (!patient) {
      // Q100 B: counted first, so a limited member learns nothing about the
      // Health ID; then "No such patient" only when no record has it at all.
      // A limited member gets today's 404, never a 429: the website closes an
      // open record on 403 or 404 (its verify() before every save), so a new
      // status would leave a record open after access has ended.
      const limited = await this.misses?.countMiss(context);
      const issued = limited === false ? await this.misses?.issued(hid, context) : undefined;
      const result: LookupMissResult = limited === true ? 'limited' : issued === false ? 'no_such_patient' : 'not_available';
      await this.record(context, 'identity.patient.lookup', 'denied', undefined, purpose, { lookupResult: result });
      if (result === 'no_such_patient') throw patientNotFound();
      throw new NotFoundException('Patient was not found or is not available');
    }
    const decision = await this.provider.authorize({
      patientId: patient.id,
      scope: 'read_records',
      purpose,
      context,
    });
    if (!decision.allowed) {
      // The patient exists and this lookup may see them but not open them:
      // today's 403, not counted. The 403 says nothing Q100 B added (the
      // issued check is never asked here, and a limited account would get the
      // same 403), so counting it would only limit a desk working through
      // patients who have not yet given consent.
      const result: LookupMissResult = 'not_authorized';
      await this.record(context, 'identity.patient.lookup', 'denied', patient.id, purpose, { lookupResult: result });
      throw new ForbiddenException('Patient access is not authorized');
    }
    await this.record(context, 'identity.patient.lookup', 'success', patient.id, purpose, {
      consentGrantId: decision.consentGrantId,
      breakGlass: decision.breakGlass,
    });
    // "Your records were opened" (0095, D9): after the answer, never failing it.
    this.notices?.afterAuthorization(context, patient.id, decision);
    return {
      patient: {
        patientId: patient.id,
        hid: patient.hidCode,
        firstName: patient.firstName,
        lastName: patient.lastName,
        fullName: patient.fullName,
        dateOfBirth: patient.dateOfBirth,
        gender: patient.gender,
        version: patient.rowVersion,
        // ID-0: "NIN Verified" or "NIN Not Verified" on screen.
        ninStatus: ninStatusOf(patient.ninVerified),
        // ID-7 (0146): an unknown record's first and last names are placeholders.
        recordKind: patient.recordKind ?? 'standard',
      },
      authorization: {
        decision: 'allow' as const,
        facilityId: decision.facilityId,
        membershipId: decision.membershipId,
        scope: decision.scope,
        purpose: decision.purpose,
        consentGrantId: decision.consentGrantId,
        expiresAt: decision.expiresAt,
        breakGlass: decision.breakGlass,
      },
    };
  }

  async authorize(
    patientId: string,
    scope: RecordAccessScope,
    purpose: PurposeOfUse,
    context: DataAccessContext,
  ): Promise<AuthorizationDecision> {
    let decision: AuthorizationDecision;
    try {
      decision = await this.provider.authorize({ patientId, scope, purpose, context });
    } catch (error) {
      await this.record(context, 'identity.authorization.check', 'failure', patientId, purpose, {
        scope,
        dependency: 'identity-provider',
      });
      throw error;
    }
    await this.record(
      context,
      'identity.authorization.check',
      decision.allowed ? 'success' : 'denied',
      patientId,
      purpose,
      { scope, consentGrantId: decision.consentGrantId, breakGlass: decision.breakGlass },
    );
    // "Your records were opened" (0095, D9): every staff read path (EHR,
    // documents, imported records, staff chat, Lab, Pharmacy) authorizes here;
    // after the answer, never failing it. consentStatus does not note.
    this.notices?.afterAuthorization(context, patientId, decision);
    return decision;
  }

  /**
   * The same decision as authorize, for a caller that must refuse early and
   * then authorize for real (OCR create asks about the named patient before
   * it reads the document). It opens nothing, so it notes nothing: no
   * "Your records were opened" notice and no identity.authorization.check
   * row, only a neutral identity.authorization.precheck audit row that the
   * patient's access history does not list. It answers whether access would
   * be allowed, never the grant behind it.
   */
  async precheck(
    patientId: string,
    scope: RecordAccessScope,
    purpose: PurposeOfUse,
    context: DataAccessContext,
  ): Promise<AuthorizationPrecheck> {
    let decision: AuthorizationDecision;
    try {
      decision = await this.provider.authorize({ patientId, scope, purpose, context });
    } catch (error) {
      await this.record(context, 'identity.authorization.precheck', 'failure', patientId, purpose, {
        scope,
        dependency: 'identity-provider',
      });
      throw error;
    }
    await this.record(context, 'identity.authorization.precheck', 'success', patientId, purpose, {
      scope,
      allowed: decision.allowed,
    });
    return {
      allowed: decision.allowed,
      patientId: decision.patientId,
      facilityId: decision.facilityId,
      membershipId: decision.membershipId,
      scope: decision.scope,
      purpose: decision.purpose,
      breakGlass: decision.breakGlass,
    };
  }

  async consentStatus(
    patientId: string,
    purpose: PurposeOfUse,
    context: DataAccessContext,
  ): Promise<ConsentStatus> {
    let status: ConsentStatus;
    try {
      status = await this.provider.consentStatus(patientId, purpose, context);
    } catch (error) {
      await this.record(context, 'identity.consent.status.read', 'failure', patientId, purpose, {
        dependency: 'identity-provider',
      });
      throw error;
    }
    await this.record(context, 'identity.consent.status.read', 'success', patientId, purpose, {
      readAllowed: status.readAllowed,
      writeAllowed: status.writeAllowed,
    });
    return status;
  }

  private record(
    context: DataAccessContext,
    action: string,
    outcome: 'success' | 'denied' | 'failure',
    patientId: string | undefined,
    purpose: PurposeOfUse,
    details: Readonly<Record<string, unknown>> = {},
  ): Promise<void> {
    return this.audit.record({
      correlationId: context.correlationId,
      actorType: 'staff',
      actorSubject: context.actor.subject,
      actorAccountId: context.actor.accountId,
      actorMembershipId: context.membershipId,
      organizationId: context.actor.facility?.organizationId,
      facilityId: context.facilityId,
      patientId,
      action,
      resourceType: 'patient',
      resourceId: patientId,
      outcome,
      purposeOfUse: purpose,
      details,
    });
  }
}
