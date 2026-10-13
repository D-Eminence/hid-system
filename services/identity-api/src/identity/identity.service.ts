import { ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { DomainProblem } from '../common/problem';
import type { DataAccessContext, PurposeOfUse } from '../common/request-context';
import type {
  AuthorizationDecision,
  IdentityPatient,
  IdentityProvider,
  RecordAccessScope,
  ConsentStatus,
} from './identity.types';
import { IDENTITY_PROVIDER } from './identity.types';
import { StaffSearchBudget } from './staff-search-budget';

/**
 * The one answer to every refused patient lookup (PSEARCH-1): an unknown HID,
 * a patient without a grant for this membership, facility and purpose, and a
 * grant held at another facility are indistinguishable to the caller. The
 * audit event keeps the true outcome.
 */
export function patientNotAvailable(): DomainProblem {
  return new DomainProblem(404, 'PATIENT_NOT_AVAILABLE', 'The patient is not available');
}

@Injectable()
export class IdentityService {
  constructor(
    @Inject(IDENTITY_PROVIDER) private readonly provider: IdentityProvider,
    private readonly audit: AuditService,
    private readonly budget: StaffSearchBudget,
  ) {}

  /**
   * Exact-HID lookup for staff. Counted against the actor's and facility's
   * lookup budgets first; searching never grants access by itself.
   */
  async lookupPatient(hid: string, purpose: PurposeOfUse, context: DataAccessContext) {
    await this.budget.consume('patient_lookup', context);
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
      // Row-level security hides a patient this membership may not read, so
      // the audit subject (if any) comes from a separate audit-only command.
      let subject: string | null;
      try {
        subject = await this.provider.lookupAuditSubject(hid, context);
      } catch (error) {
        await this.record(context, 'identity.patient.lookup', 'failure', undefined, purpose,
          { dependency: 'identity-provider' });
        throw error;
      }
      await this.record(context, 'identity.patient.lookup', 'denied', subject ?? undefined, purpose,
        { reason: subject ? 'not_authorized' : 'not_found' });
      throw patientNotAvailable();
    }
    const decision = await this.provider.authorize({
      patientId: patient.id,
      scope: 'read_records',
      purpose,
      context,
    });
    if (!decision.allowed) {
      await this.record(context, 'identity.patient.lookup', 'denied', patient.id, purpose,
        { reason: 'not_authorized' });
      throw patientNotAvailable();
    }
    await this.record(context, 'identity.patient.lookup', 'success', patient.id, purpose, {
      consentGrantId: decision.consentGrantId,
      breakGlass: decision.breakGlass,
    });
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
