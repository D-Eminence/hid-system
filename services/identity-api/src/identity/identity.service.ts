import { ForbiddenException, Inject, Injectable, NotFoundException, Optional, ServiceUnavailableException } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import type { DataAccessContext, PurposeOfUse } from '../common/request-context';
import type {
  AuthorizationDecision,
  IdentityPatient,
  IdentityProvider,
  RecordAccessScope,
  ConsentStatus,
} from './identity.types';
import { IDENTITY_PROVIDER } from './identity.types';
import { RecordAccessNoticeService } from './record-access-notice.service';

@Injectable()
export class IdentityService {
  constructor(
    @Inject(IDENTITY_PROVIDER) private readonly provider: IdentityProvider,
    private readonly audit: AuditService,
    @Optional() private readonly notices?: RecordAccessNoticeService,
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
    return {patientId:patient.id,version:patient.rowVersion,firstName:patient.firstName,lastName:patient.lastName,
      fullName:patient.fullName,dateOfBirth:patient.dateOfBirth,gender:patient.gender};
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
      await this.record(context, 'identity.patient.lookup', 'denied', undefined, purpose);
      throw new NotFoundException('Patient was not found or is not available');
    }
    const decision = await this.provider.authorize({
      patientId: patient.id,
      scope: 'read_records',
      purpose,
      context,
    });
    if (!decision.allowed) {
      await this.record(context, 'identity.patient.lookup', 'denied', patient.id, purpose);
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
